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

        const { error } = await supabase
            .from('perfiles')
            .upsert(
                { id: user_id, nombre, apellido, telefono },
                { onConflict: 'id' }
            );

        if (error) {
            return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
        }

        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};
