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

// El valor que muestra el front es el que se cobra en Wompi, sin recalcular.
// Montos fijos (en centavos) = total exacto que muestra el dashboard.
const TOKEN_PLANES = {
    '100000':  { tokens: 100000,  montoCents: 610000,  concepto: 'Recarga 100K tokens' },
    '500000':  { tokens: 500000,  montoCents: 2160000, concepto: 'Recarga 500K tokens' },
    '1000000': { tokens: 1000000, montoCents: 3700000, concepto: 'Recarga 1M tokens' }
};

const FEE_RATE = 0.0265;
const FEE_FIJO = 700; // pesos
const FEE_IVA = 0.19;

// Total (pesos) que se muestra en el front para planes, idéntico a precioFinal() del dashboard.
function precioTotalPesos(precioBasePesos) {
    const ivaFactor = 1 + FEE_IVA;
    const denom = 1 - FEE_RATE * ivaFactor;
    return Math.ceil(Math.ceil((precioBasePesos + FEE_FIJO * ivaFactor) / denom) / 100) * 100;
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

        const body = JSON.parse(event.body || '{}');
        const { tipo, producto } = body;
        const montoSolicitado = Number(body.montoCents);

        let montoCents = null;
        let concepto = '';
        let tokens = null;
        let planId = null;

        if (tipo === 'tokens') {
            const p = TOKEN_PLANES[String(producto)];
            if (!p) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Paquete de tokens no válido.' }) };
            if (montoSolicitado !== p.montoCents) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'El monto no coincide con el total del paquete.' }) };
            }
            montoCents = p.montoCents;
            concepto = p.concepto;
            tokens = p.tokens;
        } else if (tipo === 'plan') {
            const { data: plan } = await supabase
                .from('planes')
                .select('id, nombre, precio')
                .eq('id', producto)
                .maybeSingle();
            if (!plan) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Plan no válido.' }) };
            const esperado = precioTotalPesos(plan.precio || 0) * 100;
            if (montoSolicitado !== esperado) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'El monto no coincide con el total del plan.' }) };
            }
            montoCents = esperado;
            concepto = `Suscripcion plan ${plan.nombre}`;
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
