const { supabase } = require('./supabase-admin');
const { calcularEstado, FREE_PLAN_ID } = require('./suscripciones');

const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No autorizado.' }) };

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token inválido.' }) };

        const { data: perfil } = await supabase
            .from('perfiles')
            .select('plan_id, plan_vencimiento, planes(nombre)')
            .eq('id', user.id)
            .single();

        const planId = perfil?.plan_id ?? null;
        const vencimiento = perfil?.plan_vencimiento ?? null;

        let { estado, dias } = calcularEstado(planId, vencimiento);
        let planNombre = perfil?.planes?.nombre ?? null;

        if (estado === 'desactivado' && planId !== FREE_PLAN_ID) {
            await supabase
                .from('perfiles')
                .update({ plan_id: FREE_PLAN_ID, plan_vencimiento: null })
                .eq('id', user.id);
            planNombre = null;
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                ok: true,
                estado,
                dias,
                vencimiento,
                plan_id: estado === 'desactivado' ? FREE_PLAN_ID : planId,
                plan_nombre: estado === 'desactivado' ? null : planNombre
            })
        };
    } catch (err) {
        console.error('Error en plan-estado:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error interno del servidor.' }) };
    }
};
