// crm.js — API del panel CRM (configuración, estados, catálogo y leads)
const { supabase } = require('./supabase-admin');
const { sembrarEstadosDefault, obtenerConfigCRM, CAMPOS_BASE } = require('./crm-helper');

const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json"
};

async function authUser(event) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) return null;
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user;
}

function sanitizarConfig(config) {
    if (!config) return null;
    return {
        ...config,
        wompi_private_key: undefined,
        wompi_events_secret: undefined,
        wompi_privada_guardada: !!config.wompi_private_key,
        wompi_secret_guardado: !!config.wompi_events_secret
    };
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

    try {
        const user = await authUser(event);
        if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No autorizado.' }) };

        const body = event.httpMethod === 'POST' ? JSON.parse(event.body || '{}') : {};
        const accion = body.accion || event.queryStringParameters?.accion;

        // ── GET: toda la data del panel ──
        if (event.httpMethod === 'GET') {
            const { data: agentes } = await supabase
                .from('agentes_ia')
                .select('id, nombre_agente, crm_activo')
                .eq('user_id', user.id)
                .order('id', { ascending: true });

            const { data: configRows } = await supabase
                .from('crm_config_agente')
                .select('*')
                .eq('user_id', user.id);

            const { data: estados } = await supabase
                .from('crm_estados')
                .select('*')
                .eq('user_id', user.id)
                .order('orden', { ascending: true });

            // Filtros por fecha de creación (desde/hasta ISO) y origen
            const qs = event.queryStringParameters || {};
            const desde = qs.desde || null;
            const hasta = qs.hasta || null;
            const origen = qs.origen || null;
            const agenteFiltro = qs.agente_id || null;

            const filtros = (q) => {
                let query = q.eq('user_id', user.id);
                if (desde) query = query.gte('created_at', desde);
                if (hasta) query = query.lte('created_at', hasta);
                if (origen) query = query.eq('origen', origen);
                if (agenteFiltro) query = query.eq('agente_id', agenteFiltro);
                return query;
            };

            const { data: leads } = await filtros(
                supabase
                    .from('crm_leads')
                    .select(`
                        *, 
                        estados:estado_id(id, nombre, color, es_cerrada, es_perdida, orden),
                        agente:agente_id(nombre_agente)
                    `)
            )
                .order('updated_at', { ascending: false })
                .limit(200);

            // Resumen por estado para el embudo de ventas (exacto, sin límite de filas)
            const { data: aggRows } = await filtros(
                supabase.from('crm_leads').select('estado_id, valor_venta_cents')
            );

            const estadoMap = {};
            for (const e of estados || []) {
                estadoMap[e.id] = {
                    estado_id: e.id,
                    nombre: e.nombre,
                    color: e.color || '#0ea5e9',
                    orden: e.orden || 0,
                    es_cerrada: !!e.es_cerrada,
                    es_perdida: !!e.es_perdida,
                    total: 0,
                    valor_cents: 0
                };
            }
            let sinEstado = 0, sinEstadoValor = 0;
            for (const r of aggRows || []) {
                const entry = r.estado_id ? estadoMap[r.estado_id] : null;
                if (entry) {
                    entry.total += 1;
                    entry.valor_cents += Number(r.valor_venta_cents) || 0;
                } else {
                    sinEstado += 1;
                    sinEstadoValor += Number(r.valor_venta_cents) || 0;
                }
            }
            const resumen_estados = Object.values(estadoMap).sort((a, b) => a.orden - b.orden);
            if (sinEstado > 0) {
                resumen_estados.push({
                    estado_id: null,
                    nombre: 'Sin estado',
                    color: '#4a6580',
                    orden: 999,
                    es_cerrada: false,
                    es_perdida: false,
                    total: sinEstado,
                    valor_cents: sinEstadoValor
                });
            }

            const configs = (agentes || []).map(a => {
                const cfg = (configRows || []).find(c => String(c.agente_id) === String(a.id));
                return {
                    agente_id: a.id,
                    agente_nombre: a.nombre_agente,
                    config: cfg ? sanitizarConfig(cfg) : null
                };
            });

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    agentes: (agentes || []).map(a => ({ id: a.id, nombre_agente: a.nombre_agente, crm_activo: a.crm_activo })),
                    configs,
                    estados: estados || [],
                    leads: (leads || []).map(l => ({
                        ...l,
                        estado: l.estados || null,
                        agente_nombre: l.agente?.nombre_agente || null,
                        estados: undefined,
                        agente: undefined
                    })),
                    campos_disponibles: CAMPOS_BASE,
                    resumen_estados
                })
            };
        }

        if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

        // ── Guardar configuración por AGENTE (nunca se devuelven las llaves) ──
        if (accion === 'config') {
            const { agente_id, crm_activo, campos_captura, wompi_private_key, wompi_public_key, wompi_events_secret, wompi_sandbox, catalogo, notify_on_intent, notify_on_payment, notify_on_state_change, notify_channels, notify_recipients, notify_cc_agent, notify_attach_receipt, notify_webhook_url } = body;

            if (!agente_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta el agente.' }) };

            const { data: agente, error: errAgente } = await supabase
                .from('agentes_ia')
                .select('id')
                .eq('id', agente_id)
                .eq('user_id', user.id)
                .maybeSingle();
            if (errAgente || !agente) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Agente no encontrado.' }) };

            const actual = await obtenerConfigCRM(user.id, agente_id);

            const updates = {
                user_id: user.id,
                crm_activo: typeof crm_activo === 'boolean' ? crm_activo : (actual?.crm_activo ?? false),
                campos_captura: Array.isArray(campos_captura) ? campos_captura : (actual?.campos_captura || CAMPOS_BASE),
                wompi_sandbox: typeof wompi_sandbox === 'boolean' ? wompi_sandbox : (actual?.wompi_sandbox ?? false),
                notify_on_intent: typeof notify_on_intent === 'boolean' ? notify_on_intent : (actual?.notify_on_intent ?? false),
                notify_on_payment: typeof notify_on_payment === 'boolean' ? notify_on_payment : (actual?.notify_on_payment ?? false),
                notify_on_state_change: typeof notify_on_state_change === 'boolean' ? notify_on_state_change : (actual?.notify_on_state_change ?? false),
                notify_channels: Array.isArray(notify_channels) ? notify_channels : (actual?.notify_channels || ['email']),
                notify_recipients: Array.isArray(notify_recipients) ? notify_recipients : (actual?.notify_recipients || []),
                notify_cc_agent: typeof notify_cc_agent === 'boolean' ? notify_cc_agent : (actual?.notify_cc_agent ?? true),
                notify_attach_receipt: typeof notify_attach_receipt === 'boolean' ? notify_attach_receipt : (actual?.notify_attach_receipt ?? false),
                updated_at: new Date().toISOString()
            };

            if (wompi_private_key && String(wompi_private_key).length > 5) updates.wompi_private_key = String(wompi_private_key);
            if (wompi_public_key && String(wompi_public_key).length > 5) updates.wompi_public_key = String(wompi_public_key);
            if (wompi_events_secret && String(wompi_events_secret).length > 5) updates.wompi_events_secret = String(wompi_events_secret);
            if (Array.isArray(catalogo)) updates.catalogo = catalogo;
            if (typeof notify_webhook_url === 'string') updates.notify_webhook_url = notify_webhook_url.trim() || null;

            if (actual) {
                const { error } = await supabase.from('crm_config_agente').update(updates).eq('agente_id', agente_id);
                if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
            } else {
                const { error } = await supabase.from('crm_config_agente').insert({ agente_id, ...updates });
                if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
            }

            if (updates.crm_activo) {
                await sembrarEstadosDefault(user.id);
                await supabase.from('agentes_ia').update({ crm_activo: true }).eq('id', agente_id);
            }

            const nueva = await obtenerConfigCRM(user.id, agente_id);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ ok: true, config: sanitizarConfig(nueva) })
            };
        }

        // ── Sembrar pipeline default (al activar CRM en un agente existente) ──
        if (accion === 'sembrar_estados') {
            await sembrarEstadosDefault(user.id);
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
        }

        // ── Estados del pipeline ──
        if (accion === 'estado_crear' || accion === 'estado_editar') {
            const { id, nombre, orden, es_inicial, es_cerrada, es_perdida, avance_automatico, color } = body;
            if (!nombre || !String(nombre).trim()) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'El estado necesita un nombre.' }) };
            }

            // Solo UN estado inicial y UN cerrada/perdida por usuario
            if (es_inicial) {
                await supabase.from('crm_estados').update({ es_inicial: false }).eq('user_id', user.id);
            }
            if (es_cerrada || es_perdida) {
                await supabase.from('crm_estados').update({ es_cerrada: false, es_perdida: false }).eq('user_id', user.id).neq('id', id || '');
            }

            const data = {
                nombre: String(nombre).trim(),
                orden: Number(orden) || 0,
                es_inicial: !!es_inicial,
                es_cerrada: !!es_cerrada,
                es_perdida: !!es_perdida,
                avance_automatico: avance_automatico || null,
                color: color || '#0ea5e9'
            };

            let error;
            if (accion === 'estado_crear') {
                ({ error } = await supabase.from('crm_estados').insert({ user_id: user.id, ...data }));
            } else {
                if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta el id del estado.' }) };
                const { data: existe } = await supabase.from('crm_estados').select('id').eq('id', id).eq('user_id', user.id).maybeSingle();
                if (!existe) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Estado no encontrado.' }) };
                ({ error } = await supabase.from('crm_estados').update(data).eq('id', id));
            }
            if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
        }

        if (accion === 'estado_eliminar') {
            const { id } = body;
            if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta el id.' }) };
            const { data: existe } = await supabase.from('crm_estados').select('id').eq('id', id).eq('user_id', user.id).maybeSingle();
            if (!existe) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Estado no encontrado.' }) };
            const { error } = await supabase.from('crm_estados').delete().eq('id', id);
            if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
        }

        // ── Cambiar estado de un lead (manual, hecho por humano) ──
        if (accion === 'lead_estado') {
            const { lead_id, estado_id } = body;
            if (!lead_id || !estado_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Faltan datos.' }) };
            const { data: existe } = await supabase.from('crm_leads').select('id, nombre, agente_id, conversacion_id, estado_id').eq('id', lead_id).eq('user_id', user.id).maybeSingle();
            if (!existe) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Lead no encontrado.' }) };
            const { data: estado } = await supabase.from('crm_estados').select('id, nombre, es_cerrada, es_perdida').eq('id', estado_id).eq('user_id', user.id).maybeSingle();
            if (!estado) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Estado no válido.' }) };
            const { error } = await supabase
                .from('crm_leads')
                .update({
                    estado_id,
                    cerrado_en: estado.es_cerrada ? new Date().toISOString() : null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', lead_id);
            if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };

            // Notificación opcional por cambio de estado (configurable por agente)
            if (existe.estado_id != null && String(existe.estado_id) !== String(estado_id)) {
                try {
                    const { obtenerConfigCRM } = require('./crm-helper');
                    const cfg = await obtenerConfigCRM(user.id, existe.agente_id);
                    if (cfg?.notify_on_state_change && Array.isArray(cfg.notify_recipients) && cfg.notify_recipients.length) {
                        const { sendEmail } = require('./notifications');
                        const leadNombre = existe.nombre || 'Lead sin nombre';
                        const subject = `Cambio de estado: ${leadNombre}`;
                        const text = `El lead "${leadNombre}" cambió de estado.\n\nNuevo estado: ${estado.nombre || estado_id}\n\nRevísalo en tu panel de CRM.`;
                        for (const to of cfg.notify_recipients.filter(Boolean)) {
                            sendEmail({
                                userId: user.id,
                                agenteId: existe.agente_id,
                                leadId: lead_id,
                                conversationId: existe.conversacion_id,
                                eventType: 'lead_state_change',
                                to, subject, text
                            }).catch(err => console.error('estado-change email err:', err));
                        }
                    }
                } catch (notifErr) {
                    console.error('Error notificando cambio de estado:', notifErr.message);
                }
            }
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
        }

        // ── Crear/editar lead manualmente ──
        if (accion === 'lead_guardar') {
            const { id, agente_id, nombre, telefono, email, interes, notas, preferencias, estado_id } = body;
            const estadoInicial = await require('./crm-helper').obtenerEstadoInicial(user.id);

            if (!id && agente_id) {
                const { data: agenteValido } = await supabase
                    .from('agentes_ia')
                    .select('id')
                    .eq('id', agente_id)
                    .eq('user_id', user.id)
                    .maybeSingle();
                if (!agenteValido) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Agente no encontrado.' }) };
            }

            const data = {
                user_id: user.id,
                agente_id: id ? undefined : (agente_id || null),
                nombre: nombre || null,
                telefono: telefono || null,
                email: email || null,
                interes: interes || null,
                notas: notas || null,
                preferencias: preferencias || {},
                estado_id: estado_id || estadoInicial
            };

            let error;
            if (id) {
                const { data: existe } = await supabase.from('crm_leads').select('id').eq('id', id).eq('user_id', user.id).maybeSingle();
                if (!existe) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Lead no encontrado.' }) };
                delete data.agente_id;
                ({ error } = await supabase.from('crm_leads').update({ ...data, updated_at: new Date().toISOString() }).eq('id', id));
            } else {
                ({ error } = await supabase.from('crm_leads').insert(data));
            }
            if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
        }

        // ── Eliminar lead ──
        if (accion === 'lead_eliminar') {
            const { id } = body;
            if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta el id.' }) };
            const { data: existe } = await supabase.from('crm_leads').select('id').eq('id', id).eq('user_id', user.id).maybeSingle();
            if (!existe) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Lead no encontrado.' }) };
            const { error } = await supabase.from('crm_leads').delete().eq('id', id);
            if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
        }

        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Acción no válida.' }) };
    } catch (err) {
        console.error('Error en crm.js:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error interno del servidor.' }) };
    }
};
