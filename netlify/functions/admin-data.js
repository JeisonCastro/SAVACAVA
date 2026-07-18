const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

exports.handler = async (event) => {
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

        const { data: miPerfil } = await supabase
            .from('perfiles')
            .select('is_admin')
            .eq('id', userData.user.id)
            .single();

        if (!miPerfil?.is_admin) {
            return { statusCode: 403, body: JSON.stringify({ error: 'No eres admin' }) };
        }

        const body = JSON.parse(event.body || '{}');
        const { action } = body;

        // ── GET: Cargar datos admin ──
        if (!action || action === 'get') {
            const [perfilesRes, planesRes, agentesRes, logsRes] = await Promise.all([
                supabase.from('perfiles').select('id, nombre, apellido, token_balance, plan_id, is_admin'),
                supabase.from('planes').select('*').order('precio'),
                supabase.from('agentes_ia').select('id, user_id'),
                supabase.from('logs_consumo').select('user_id, tokens_usados')
            ]);

            const perfiles = perfilesRes.data || [];
            const planes = planesRes.data || [];

            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    perfiles: perfiles.map(p => ({
                        ...p,
                        planes: planes.find(pl => pl.id === p.plan_id) || null
                    })),
                    planes,
                    totalAgentes: (agentesRes.data || []).length,
                    totalTokens: (logsRes.data || []).reduce((s, l) => s + (l.tokens_usados || 0), 0),
                    agentes: agentesRes.data || [],
                    logs: logsRes.data || []
                })
            };
        }

        // ── SET_TOKENS: Agregar tokens a usuario ──
        if (action === 'set_tokens') {
            const { user_id, amount } = body;
            if (!user_id || !amount) return { statusCode: 400, body: JSON.stringify({ error: 'Faltan datos' }) };

            const { data: perfil } = await supabase.from('perfiles').select('token_balance').eq('id', user_id).single();
            const nuevo = (perfil?.token_balance || 0) + amount;

            const { error } = await supabase.from('perfiles').update({ token_balance: nuevo }).eq('id', user_id);
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

            return { statusCode: 200, body: JSON.stringify({ ok: true, nuevo_balance: nuevo }) };
        }

        // ── SET_PLAN: Cambiar plan de usuario ──
        if (action === 'set_plan') {
            const { user_id, plan_id } = body;
            if (!user_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta user_id' }) };

            const { error } = await supabase.from('perfiles').update({ plan_id: plan_id || null }).eq('id', user_id);
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

            return { statusCode: 200, body: JSON.stringify({ ok: true }) };
        }

        // ── CREATE_PLAN ──
        if (action === 'create_plan') {
            const { nombre, limite_agentes, precio } = body;
            if (!nombre || !limite_agentes) return { statusCode: 400, body: JSON.stringify({ error: 'Faltan datos' }) };

            const { error } = await supabase.from('planes').insert({ nombre, limite_agentes, precio: precio || 0 });
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

            return { statusCode: 200, body: JSON.stringify({ ok: true }) };
        }

        // ── UPDATE_PLAN ──
        if (action === 'update_plan') {
            const { plan_id, nombre, limite_agentes, precio } = body;
            if (!plan_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta plan_id' }) };

            const { error } = await supabase.from('planes').update({ nombre, limite_agentes, precio }).eq('id', plan_id);
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

            return { statusCode: 200, body: JSON.stringify({ ok: true }) };
        }

        // ── DELETE_PLAN ──
        if (action === 'delete_plan') {
            const { plan_id } = body;
            if (!plan_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta plan_id' }) };

            const { error } = await supabase.from('planes').delete().eq('id', plan_id);
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

            return { statusCode: 200, body: JSON.stringify({ ok: true }) };
        }

        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida' }) };

    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message || 'Error interno' })
        };
    }
};
