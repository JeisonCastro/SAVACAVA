const crypto = require('crypto');
const { supabase } = require('./supabase-admin');
const { fechaVencimiento } = require('./suscripciones');

const headers = { "Content-Type": "application/json" };

function getByPath(obj, path) {
    return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function verificarFirma(payload, headerChecksum) {
    const secret = process.env.WOMPI_EVENTS_SECRET;
    if (!secret) return false;

    const sig = payload.signature;
    if (!sig || !Array.isArray(sig.properties) || sig.properties.length === 0) return false;

    const cadena =
        sig.properties
            .map(p => {
                const v = getByPath(payload.data, p);
                return v === null || v === undefined ? '' : String(v);
            })
            .join('') +
        String(payload.timestamp) +
        secret;

    const checksum = crypto.createHash('sha256').update(cadena).digest('hex');
    const esperada = String(sig.checksum || headerChecksum || '');

    if (!esperada) return false;
    try {
        return crypto.timingSafeEqual(
            Buffer.from(checksum, 'hex'),
            Buffer.from(esperada, 'hex')
        );
    } catch (_) {
        return false;
    }
}

exports.handler = async (event) => {
    try {
        if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

        let payload;
        try {
            payload = JSON.parse(event.body || '{}');
        } catch (_) {
            return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'JSON inválido' }) };
        }

        const headerChecksum = event.headers['x-event-checksum'] || '';

        if (!verificarFirma(payload, headerChecksum)) {
            console.warn('Webhook Wompi con firma inválida');
            return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Firma inválida' }) };
        }

        if (payload.event !== 'transaction.updated') {
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ignorado: true }) };
        }

        const transaction = payload.data?.transaction;
        if (!transaction) {
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ignorado: true }) };
        }

        if (transaction.status !== 'APPROVED') {
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ignorado: true, status: transaction.status }) };
        }

        const { data: pago } = await supabase
            .from('pagos')
            .select('*')
            .eq('payment_link_id', transaction.payment_link_id)
            .single();

        if (!pago) {
            console.warn('Intento de pago no encontrado para link:', transaction.payment_link_id);
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ignorado: 'sin_intento' }) };
        }

        if (pago.estado === 'aprobado') {
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ya: true }) };
        }

        if (Number(pago.monto_cents) !== Number(transaction.amount_in_cents)) {
            console.warn('Monto no coincide:', pago.monto_cents, transaction.amount_in_cents);
            return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Monto no coincide' }) };
        }

        if (pago.tipo === 'tokens') {
            const { data: perfil } = await supabase
                .from('perfiles')
                .select('token_balance')
                .eq('id', pago.user_id)
                .single();
            const nuevo = (perfil?.token_balance || 0) + (pago.tokens || 0);
            const { error } = await supabase
                .from('perfiles')
                .update({ token_balance: nuevo })
                .eq('id', pago.user_id);
            if (error) throw new Error('Error acreditando tokens: ' + error.message);
        } else if (pago.tipo === 'plan') {
            const { error } = await supabase
                .from('perfiles')
                .update({
                    plan_id: pago.plan_id,
                    plan_inicio: new Date().toISOString(),
                    plan_vencimiento: fechaVencimiento()
                })
                .eq('id', pago.user_id);
            if (error) throw new Error('Error asignando plan: ' + error.message);
        }

        const { error: upError } = await supabase
            .from('pagos')
            .update({
                estado: 'aprobado',
                transaction_id: transaction.id,
                updated_at: new Date().toISOString()
            })
            .eq('id', pago.id);
        if (upError) throw new Error('Error actualizando pago: ' + upError.message);

        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, acreditado: true }) };
    } catch (err) {
        console.error('Error en pago-webhook:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Error interno' }) };
    }
};
