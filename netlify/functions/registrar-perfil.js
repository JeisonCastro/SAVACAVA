// registrar-perfil.js — Guarda los datos de perfil (nombre, apellido, teléfono)
// justo después de crear la cuenta, aunque el correo aún no esté confirmado.
// El `user_id` viene del resultado de `signUp` en el cliente (data.user.id),
// así no hay que buscarlo ni depender de triggers en la base de datos.
// Usa el cliente con service role para hacer upsert en `perfiles`
// (perfiles.id = id del usuario en auth.users).

const { supabase } = require('./supabase-admin');

exports.handler = async (event) => {
    try {
        if (event.httpMethod !== 'POST') {
            return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido' }) };
        }

        const body = JSON.parse(event.body || '{}');
        const user_id = String(body.user_id || '');
        const nombre = String(body.nombre || '').trim();
        const apellido = String(body.apellido || '').trim();
        const telefono = String(body.telefono || '').trim();

        if (!user_id || !nombre || !apellido || !telefono) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Datos incompletos' }) };
        }

        // `perfiles.email` es NOT NULL: lo toma del body, o lo busca en auth.users.
        let email = String(body.email || '').trim();
        if (!email) {
            const { data: userData, error: userError } = await supabase.auth.admin.getUserById(user_id);
            if (!userError && userData?.user?.email) {
                email = userData.user.email;
            }
        }
        if (!email) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Falta email' }) };
        }

        const plan_inicio = new Date().toISOString();
        const plan_vencimiento = new Date(Date.now() + 30 * 86400000).toISOString();

        // 1) Crea la fila completa (con trial del plan gratis) solo si no existe.
        //    Si la fila ya existe (p. ej. la creó un trigger al firmar), la ignora
        //    para no pisar un plan pagado ya asignado.
        const { error: insertError } = await supabase
            .from('perfiles')
            .upsert(
                {
                    id: user_id,
                    email,
                    nombre,
                    apellido,
                    telefono,
                    plan_id: 1,
                    token_balance: 5000,
                    is_admin: false,
                    plan_inicio,
                    plan_vencimiento
                },
                { onConflict: 'id', ignoreDuplicates: true }
            );

        if (insertError) {
            return { statusCode: 500, body: JSON.stringify({ error: insertError.message }) };
        }

        // 2) Rellena los datos de perfil en la fila existente.
        const { error: updateError } = await supabase
            .from('perfiles')
            .update({ nombre, apellido, telefono })
            .eq('id', user_id);

        if (updateError) {
            return { statusCode: 500, body: JSON.stringify({ error: updateError.message }) };
        }

        // 3) Asigna las fechas del período de prueba (1 mes) solo a usuarios del
        //    plan gratis sin vencimiento aún. Nunca toca planes pagados activos.
        const { error: trialError } = await supabase
            .from('perfiles')
            .update({ plan_inicio, plan_vencimiento })
            .eq('id', user_id)
            .eq('plan_id', 1)
            .is('plan_vencimiento', null);

        if (trialError) {
            return { statusCode: 500, body: JSON.stringify({ error: trialError.message }) };
        }

        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};
