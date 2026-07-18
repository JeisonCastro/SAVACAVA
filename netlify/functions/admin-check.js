const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Token no enviado' }) };
        }

        const token = authHeader.replace('Bearer ', '');
        const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        const { data: userData, error: userError } = await supabaseUser.auth.getUser();
        if (userError || !userData?.user) {
            return { statusCode: 401, body: JSON.stringify({ error: 'No autenticado' }) };
        }

        const body = JSON.parse(event.body || '{}');
        const { action, target_user_id } = body;

        // ── CHECK: ¿Soy admin? ──
        if (action === 'check') {
            const { data: perfil } = await supabase
                .from('perfiles')
                .select('is_admin')
                .eq('id', userData.user.id)
                .single();

            const isAdmin = perfil?.is_admin === true;

            // Auto-admin: si es el primer usuario y no hay admins, hacerlo admin
            if (!isAdmin) {
                const { count } = await supabase
                    .from('perfiles')
                    .select('id', { count: 'exact', head: true })
                    .eq('is_admin', true);

                if (count === 0) {
                    await supabase
                        .from('perfiles')
                        .update({ is_admin: true })
                        .eq('id', userData.user.id);

                    return {
                        statusCode: 200,
                        body: JSON.stringify({ ok: true, isAdmin: true, autoAdmin: true })
                    };
                }
            }

            return {
                statusCode: 200,
                body: JSON.stringify({ ok: true, isAdmin })
            };
        }

        // ── SET: Asignar/quitar admin (solo admins pueden hacerlo) ──
        if (action === 'set') {
            const { data: miPerfil } = await supabase
                .from('perfiles')
                .select('is_admin')
                .eq('id', userData.user.id)
                .single();

            if (!miPerfil?.is_admin) {
                return { statusCode: 403, body: JSON.stringify({ error: 'No tienes permisos de admin' }) };
            }

            if (!target_user_id) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Falta target_user_id' }) };
            }

            const { error } = await supabase
                .from('perfiles')
                .update({ is_admin: !!body.is_admin })
                .eq('id', target_user_id);

            if (error) {
                return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
            }

            return {
                statusCode: 200,
                body: JSON.stringify({ ok: true })
            };
        }

        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida' }) };

    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message || 'Error interno' })
        };
    }
};
