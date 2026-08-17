// web-chat-resolve.js — Resuelve dinámicamente el agente de una tienda
// Endpoint público (sin auth) llamado por widget.js al cargar.
// Recibe el slug o id de la tienda y retorna el agente asignado.

const { supabase } = require('./supabase-admin');

const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    try {
        const qs = event.queryStringParameters || {};
        const slug = qs.slug || null;
        const projectId = qs.project_id || null;

        if (!slug && !projectId) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta slug o project_id' }) };
        }

        // Buscar el proyecto
        let query = supabase.from('web_projects').select('id, agente_id, nombre, slug, activo');
        if (projectId) {
            query = query.eq('id', projectId);
        } else {
            query = query.eq('slug', slug);
        }
        const { data: proyecto, error } = await query.maybeSingle();

        if (error || !proyecto) {
            return { statusCode: 404, headers, body: JSON.stringify({ ok: true, agente_id: null }) };
        }

        if (proyecto.activo === false) {
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, agente_id: null }) };
        }

        if (!proyecto.agente_id) {
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, agente_id: null }) };
        }

        // Obtener datos del agente
        const { data: agente } = await supabase
            .from('agentes_ia')
            .select('id, nombre_agente')
            .eq('id', proyecto.agente_id)
            .maybeSingle();

        if (!agente) {
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, agente_id: null }) };
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                ok: true,
                agente_id: agente.id,
                agente_nombre: agente.nombre_agente,
                tienda_nombre: proyecto.nombre,
                tienda_slug: proyecto.slug
            })
        };
    } catch (err) {
        console.error('Error en web-chat-resolve:', err);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, agente_id: null }) };
    }
};
