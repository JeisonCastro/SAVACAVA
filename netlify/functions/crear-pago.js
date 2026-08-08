const { supabase } = require('./supabase-admin');

const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
};

const WOMPI_BASE = process.env.WOMPI_SANDBOX === 'true'
    ? 'https://sandbox.wompi.co/v1'
    : 'https://production.wompi.co/v1';
const SITE_URL = process.env.URL || 'https://auvro.netlify.app';

const TOKEN_PLANES = {
    '100000':  { tokens: 100000,  montoCents: 500000,  concepto: 'Recarga 100K tokens' },
    '500000':  { tokens: 500000,  montoCents: 2000000, concepto: 'Recarga 500K tokens' },
    '1000000': { tokens: 1000000, montoCents: 3500000, concepto: 'Recarga 1M tokens' }
};

// ── Tarifas Wompi (Plan Avanzado): 2,65% + $700 + IVA por transaccion ──
// Se trasladan al cliente: el monto cobrado deja al comercio el precio base neto.
// Recibe el precio base en CENTAVOS y devuelve el monto bruto en CENTAVOS.
const FEE_RATE = 0.0265;
const FEE_FIJO = 700; // pesos
const FEE_IVA = 0.19;

function calcularMontoBruto(baseCents) {
    const basePesos = baseCents / 100;
    const ivaFactor = 1 + FEE_IVA;
    const denom = 1 - FEE_RATE * ivaFactor;
    const brutoPesos = (basePesos + FEE_FIJO * ivaFactor) / denom;
    const brutoRedondeado = Math.ceil(Math.ceil(brutoPesos) / 100) * 100;
    return brutoRedondeado * 100;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        if (!process.env.WOMPI_PRIVATE_KEY) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Pasarela de pago no configurada.' }) };
        }

        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No autorizado.' }) };

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token inválido.' }) };

        const { tipo, producto } = JSON.parse(event.body || '{}');

        let montoCents = null;
        let concepto = '';
        let tokens = null;
        let planId = null;

        if (tipo === 'tokens') {
            const p = TOKEN_PLANES[String(producto)];
            if (!p) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Paquete de tokens no válido.' }) };
            montoCents = calcularMontoBruto(p.montoCents);
            concepto = `${p.concepto} (incluye tarifa de procesamiento)`;
            tokens = p.tokens;
        } else if (tipo === 'plan') {
            const { data: plan } = await supabase
                .from('planes')
                .select('id, nombre, precio')
                .eq('id', producto)
                .maybeSingle();
            if (!plan) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Plan no válido.' }) };
            montoCents = calcularMontoBruto(Math.round((plan.precio || 0) * 100));
            concepto = `Suscripcion plan ${plan.nombre} (incluye tarifa de procesamiento)`;
            planId = plan.id;
        } else {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Tipo de pago no válido.' }) };
        }

        const wompiRes = await fetch(`${WOMPI_BASE}/payment_links`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.WOMPI_PRIVATE_KEY}`
            },
            body: JSON.stringify({
                name: `AUVRO - ${concepto}`,
                description: concepto,
                single_use: true,
                collect_shipping: false,
                currency: 'COP',
                amount_in_cents: montoCents,
                redirect_url: `${SITE_URL}/dashboard.html?pago=ok`
            })
        });
        const wompi = await wompiRes.json();
        if (!wompiRes.ok || !wompi?.data?.id) {
            console.error('Wompi error al crear link:', JSON.stringify(wompi));
            return {
                statusCode: 502,
                headers,
                body: JSON.stringify({ error: wompi?.error?.message || 'Error creando el pago en Wompi.' })
            };
        }

        const paymentLinkId = wompi.data.id;

        const { error: insertError } = await supabase.from('pagos').insert({
            user_id: user.id,
            tipo,
            concepto,
            monto_cents: montoCents,
            tokens,
            plan_id: planId,
            payment_link_id: paymentLinkId,
            estado: 'pendiente'
        });
        if (insertError) {
            console.error('Error insertando pago:', insertError.message);
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error registrando el pago.' }) };
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                ok: true,
                url: `https://checkout.wompi.co/l/${paymentLinkId}`,
                payment_link_id: paymentLinkId
            })
        };
    } catch (err) {
        console.error('Error en crear-pago:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error interno del servidor.' }) };
    }
};
