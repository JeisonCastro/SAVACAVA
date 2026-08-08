// verificar-suscripciones.js — Tarea diaria (cron Netlify)
// Revisa todos los planes con vencimiento y desactiva los que pasaron
// el periodo de gracia sin pago. Configurado en netlify.toml (@daily).

const { supabase } = require('./supabase-admin');
const { calcularEstado, FREE_PLAN_ID } = require('./suscripciones');

exports.handler = async () => {
    try {
        const { data: perfiles, error } = await supabase
            .from('perfiles')
            .select('id, plan_id, plan_vencimiento')
            .not('plan_vencimiento', 'is', null);

        if (error) throw new Error('Error consultando perfiles: ' + error.message);

        let desactivados = 0;
        for (const p of perfiles || []) {
            const { estado } = calcularEstado(p.plan_id, p.plan_vencimiento);
            if (estado === 'desactivado' && p.plan_id !== FREE_PLAN_ID) {
                await supabase
                    .from('perfiles')
                    .update({ plan_id: FREE_PLAN_ID, plan_vencimiento: null })
                    .eq('id', p.id);
                desactivados++;
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ ok: true, revisados: (perfiles || []).length, desactivados })
        };
    } catch (err) {
        console.error('Error en verificar-suscripciones:', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
    }
};
