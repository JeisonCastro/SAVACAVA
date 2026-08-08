const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');
const { calcularEstado, fechaVencimiento, FREE_PLAN_ID } = require('./suscripciones');

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
            const [perfilesRes, planesRes, agentesRes, logsRes, pagosRes] = await Promise.all([
                supabase.from('perfiles').select('id, nombre, apellido, token_balance, plan_id, is_admin, plan_inicio, plan_vencimiento'),
                supabase.from('planes').select('*').order('precio'),
                supabase.from('agentes_ia').select('id, user_id'),
                supabase.from('logs_consumo').select('user_id, tokens_usados'),
                supabase.from('pagos').select('*').order('created_at', { ascending: false }).limit(50)
            ]);

            const perfiles = perfilesRes.data || [];
            const planes = planesRes.data || [];

            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    perfiles: perfiles.map(p => {
                        const { estado, dias } = calcularEstado(p.plan_id, p.plan_vencimiento);
                        return {
                            ...p,
                            estado_plan: estado,
                            dias_restantes: dias,
                            planes: planes.find(pl => pl.id === p.plan_id) || null
                        };
                    }),
                    planes,
                    pagos: pagosRes.data || [],
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

        // ── SET_PLAN: Cambiar plan de usuario (manual, sin vencimiento) ──
        if (action === 'set_plan') {
            const { user_id, plan_id } = body;
            if (!user_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta user_id' }) };

            const { error } = await supabase
                .from('perfiles')
                .update({ plan_id: plan_id || null, plan_vencimiento: null })
                .eq('id', user_id);
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

            return { statusCode: 200, body: JSON.stringify({ ok: true }) };
        }

        // ── RENOVAR_PLAN: Renueva el plan actual del usuario +30 dias ──
        if (action === 'renovar_plan') {
            const { user_id } = body;
            if (!user_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta user_id' }) };

            const { data: perfil } = await supabase
                .from('perfiles')
                .select('plan_id')
                .eq('id', user_id)
                .single();
            if (!perfil?.plan_id || perfil.plan_id === FREE_PLAN_ID) {
                return { statusCode: 400, body: JSON.stringify({ error: 'El usuario no tiene un plan pagado para renovar' }) };
            }

            const { error } = await supabase
                .from('perfiles')
                .update({
                    plan_inicio: new Date().toISOString(),
                    plan_vencimiento: fechaVencimiento()
                })
                .eq('id', user_id);
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

            return { statusCode: 200, body: JSON.stringify({ ok: true }) };
        }

        // ── DESACTIVAR_PLAN: Devuelve al usuario al plan gratuito ──
        if (action === 'desactivar_plan') {
            const { user_id } = body;
            if (!user_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta user_id' }) };

            const { error } = await supabase
                .from('perfiles')
                .update({ plan_id: FREE_PLAN_ID, plan_vencimiento: null })
                .eq('id', user_id);
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

            return { statusCode: 200, body: JSON.stringify({ ok: true }) };
        }

        // ── APROBAR_PAGO: Acredita un pago pendiente (transferencia manual) ──
        if (action === 'aprobar_pago') {
            const { pago_id } = body;
            if (!pago_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta pago_id' }) };

            const { data: pago } = await supabase
                .from('pagos')
                .select('*')
                .eq('id', pago_id)
                .single();
            if (!pago) return { statusCode: 404, body: JSON.stringify({ error: 'Pago no encontrado' }) };
            if (pago.estado !== 'pendiente') {
                return { statusCode: 400, body: JSON.stringify({ error: 'El pago ya fue procesado' }) };
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
                if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
            } else if (pago.tipo === 'plan') {
                const { error } = await supabase
                    .from('perfiles')
                    .update({
                        plan_id: pago.plan_id,
                        plan_inicio: new Date().toISOString(),
                        plan_vencimiento: fechaVencimiento()
                    })
                    .eq('id', pago.user_id);
                if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
            }

            const { error: upError } = await supabase
                .from('pagos')
                .update({
                    estado: 'aprobado',
                    transaction_id: 'admin:' + Date.now(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', pago_id);
            if (upError) return { statusCode: 500, body: JSON.stringify({ error: upError.message }) };

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
