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
        wompi_events_secret: undefined
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
            const config = await obtenerConfigCRM(user.id);
            const { data: estados } = await supabase
                .from('crm_estados')
                .select('*')
                .eq('user_id', user.id)
                .order('orden', { ascending: true });
            const { data: leads } = await supabase
                .from('crm_leads')
                .select(`
                    *, 
                    estados:estado_id(id, nombre, color, es_cerrada, es_perdida, orden),
                    agente:agente_id(nombre_agente)
                `)
                .eq('user_id', user.id)
                .order('updated_at', { ascending: false })
                .limit(200);

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    config: sanitizarConfig(config),
                    estados: estados || [],
                    leads: (leads || []).map(l => ({
                        ...l,
                        estado: l.estados || null,
                        agente_nombre: l.agente?.nombre_agente || null,
                        estados: undefined,
                        agente: undefined
                    })),
                    campos_disponibles: CAMPOS_BASE
                })
            };
        }

        if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

        // ── Guardar configuración (nunca se devuelven las llaves) ──
        if (accion === 'config') {
            const { crm_activo, campos_captura, wompi_private_key, wompi_public_key, wompi_events_secret, wompi_sandbox, catalogo } = body;

            const actual = await obtenerConfigCRM(user.id);

            const updates = {
                crm_activo: typeof crm_activo === 'boolean' ? crm_activo : (actual?.crm_activo ?? false),
                campos_captura: Array.isArray(campos_captura) ? campos_captura : (actual?.campos_captura || CAMPOS_BASE),
                wompi_sandbox: typeof wompi_sandbox === 'boolean' ? wompi_sandbox : (actual?.wompi_sandbox ?? false),
                updated_at: new Date().toISOString()
            };

            if (wompi_private_key && String(wompi_private_key).length > 5) updates.wompi_private_key = String(wompi_private_key);
            if (wompi_public_key && String(wompi_public_key).length > 5) updates.wompi_public_key = String(wompi_public_key);
            if (wompi_events_secret && String(wompi_events_secret).length > 5) updates.wompi_events_secret = String(wompi_events_secret);
            if (Array.isArray(catalogo)) updates.catalogo = catalogo;

            if (actual) {
                const { error } = await supabase.from('crm_config').update(updates).eq('user_id', user.id);
                if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
            } else {
                const { error } = await supabase.from('crm_config').insert({ user_id: user.id, ...updates });
                if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
            }

            if (updates.crm_activo) await sembrarEstadosDefault(user.id);

            const nueva = await obtenerConfigCRM(user.id);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ ok: true, config: sanitizarConfig(nueva) })
            };
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
            const { data: existe } = await supabase.from('crm_leads').select('id').eq('id', lead_id).eq('user_id', user.id).maybeSingle();
            if (!existe) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Lead no encontrado.' }) };
            const { data: estado } = await supabase.from('crm_estados').select('id, es_cerrada, es_perdida').eq('id', estado_id).eq('user_id', user.id).maybeSingle();
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
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
        }

        // ── Crear/editar lead manualmente ──
        if (accion === 'lead_guardar') {
            const { id, nombre, telefono, email, interes, notas, preferencias, estado_id } = body;
            const estadoInicial = await require('./crm-helper').obtenerEstadoInicial(user.id);

            const data = {
                user_id: user.id,
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
