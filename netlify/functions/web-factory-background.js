// web-factory-background.js — Acciones largas de Web Factory (background function real)
// Netlify ejecuta como background toda función cuyo archivo termine en "-background"
// (hasta 15 min, sin el timeout síncrono de 10s). Aquí vive SOLO el create
// (pipeline GitHub repo + Netlify site + build + dominio), que es lo único largo.
// El set_activo (apagar/reactivar) es rápido (~2s) y corre SÍNCRONO en web-factory.js
// para que el cliente reciba el ok/error real con el overlay de espera.
// Reutiliza los helpers de web-factory.js (validaciones, pipelineCrear...).
// El dashboard recibe 202 al instante y hace polling de refresh_status/get.

const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');
const wf = require('./web-factory.js').helpers;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

exports.handler = async (event) => {
    try {
        // ── Auth: mismo patrón que web-factory.js (token del usuario + perfiles.is_admin) ──
        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.error('web-factory-background: token no enviado');
            return { statusCode: 401, body: JSON.stringify({ error: 'Token no enviado' }) };
        }

        const token = authHeader.replace('Bearer ', '');
        const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        const { data: userData, error: userError } = await supabaseUser.auth.getUser();
        if (userError || !userData?.user) {
            console.error('web-factory-background: sesión inválida', userError?.message || 'sin usuario');
            return { statusCode: 401, body: JSON.stringify({ error: 'No autenticado' }) };
        }

        const { data: miPerfil } = await supabase
            .from('perfiles')
            .select('is_admin')
            .eq('id', userData.user.id)
            .single();
        if (!miPerfil?.is_admin) {
            console.error('web-factory-background: usuario sin permisos de admin', userData.user.id);
            return { statusCode: 403, body: JSON.stringify({ error: 'No eres admin' }) };
        }

        const body = JSON.parse(event.body || '{}');
        const { action } = body;
        const adminId = userData.user.id;

        // ── CREATE: pipeline completo ──
        if (action === 'create') {
            const { cliente, nombre, slug, plantilla, dominio, descripcion, accent_color } = body;
            if (!cliente || !String(cliente).trim()) return { statusCode: 400, body: JSON.stringify({ error: 'Falta el cliente' }) };
            if (!nombre || !String(nombre).trim()) return { statusCode: 400, body: JSON.stringify({ error: 'Falta el nombre' }) };
            if (!wf.validarSlug(slug)) return { statusCode: 400, body: JSON.stringify({ error: 'Slug inválido (solo minusculas, numeros y guiones)' }) };
            if (!wf.validarDominio(dominio)) return { statusCode: 400, body: JSON.stringify({ error: 'Dominio inválido' }) };
            if (accent_color !== undefined && accent_color !== null && accent_color !== '' && wf.validarAccent(accent_color) === null) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Color principal inválido (usa #RRGGBB)' }) };
            }
            if (!process.env.GITHUB_TOKEN) return { statusCode: 500, body: JSON.stringify({ error: 'Falta GITHUB_TOKEN en las variables de entorno' }) };
            if (!process.env.NETLIFY_AUTH_TOKEN) return { statusCode: 500, body: JSON.stringify({ error: 'Falta NETLIFY_AUTH_TOKEN en las variables de entorno' }) };

            console.log('web-factory-background: create inicio', JSON.stringify({ adminId, slug, plantilla }));
            const resultado = await wf.pipelineCrear(body, adminId);
            console.log('web-factory-background: create ok', JSON.stringify(resultado));
            return { statusCode: 200, body: JSON.stringify(resultado) };
        }

        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida' }) };

    } catch (err) {
        console.error('web-factory-background: error', err && err.stack ? err.stack : err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Error interno' }) };
    }
};

module.exports.handler = exports.handler;
