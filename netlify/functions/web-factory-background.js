// web-factory-background.js — Acciones largas de Web Factory (background function real)
// Netlify ejecuta como background toda función cuyo archivo termine en "-background"
// (hasta 15 min, sin el timeout síncrono de 10s). Aquí viven:
//   - create:     pipeline completo (GitHub repo + Netlify site + build + dominio).
//   - set_activo: apagar (file deploy con página de suspensión) o reactivar (build).
// Reutiliza los helpers de web-factory.js (validaciones, pipelineCrear, publicarSuspension...).
// El dashboard recibe 202 al instante y hace polling de refresh_status/get.

const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');
const wf = require('./web-factory.js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

exports.handler = async (event) => {
    try {
        // ── Auth: mismo patrón que web-factory.js (token del usuario + perfiles.is_admin) ──
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

            const resultado = await wf.pipelineCrear(body, adminId);
            return { statusCode: 200, body: JSON.stringify(resultado) };
        }

        // ── SET_ACTIVO: apagar (suspender) o reactivar un sitio ──
        // Apagar: publica un deploy directo con la pagina de "suspendido" (instantáneo).
        // Reactivar: dispara un build desde el repo (el sitio real sigue en GitHub).
        if (action === 'set_activo') {
            const { id, activo } = body;
            if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta id' }) };
            if (typeof activo !== 'boolean') return { statusCode: 400, body: JSON.stringify({ error: 'activo debe ser true o false' }) };

            const { data: proyecto, error: getErr } = await supabase.from('web_projects').select('*').eq('id', id).single();
            if (getErr) return { statusCode: 404, body: JSON.stringify({ error: getErr.message }) };
            if (!proyecto.netlify_site_id) return { statusCode: 400, body: JSON.stringify({ error: 'El sitio aún no tiene un sitio de Netlify asociado' }) };

            const errMigracion = 'Supabase: la tabla web_projects no tiene la columna "activo". Ejecuta la migración 20260816_web_factory_activo en el SQL Editor de Supabase.';

            if (activo === false) {
                // Apagar: primero marcar en DB, luego publicar la página de suspensión.
                await wf.actualizarProyecto(id, { activo: false, estado: 'suspending', error: null })
                    .catch(e => {
                        if (String(e.message).includes('42703') || String(e.message).includes('"activo"')) throw new Error(errMigracion);
                        throw e;
                    });
                try {
                    await wf.publicarSuspension(proyecto.netlify_site_id, wf.paginaSuspension(proyecto.nombre));
                    await wf.actualizarProyecto(id, { estado: 'inactivo', estado_deploy: 'ready' });
                } catch (err) {
                    // Revertir y dejar constancia del motivo para el panel.
                    await wf.actualizarProyecto(id, { activo: true, estado: 'publicado', error: 'No se pudo apagar: ' + err.message }).catch(() => {});
                    throw err;
                }
                return { statusCode: 200, body: JSON.stringify({ ok: true, activo: false }) };
            }

            // Reactivar: dispara el build desde GitHub y marca como desplegando.
            await wf.actualizarProyecto(id, { activo: true, estado: 'deploying', error: null })
                .catch(e => {
                    if (String(e.message).includes('42703') || String(e.message).includes('"activo"')) throw new Error(errMigracion);
                    throw e;
                });
            await wf.dispararBuild(proyecto.netlify_site_id);
            return { statusCode: 200, body: JSON.stringify({ ok: true, activo: true }) };
        }

        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida' }) };

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Error interno' }) };
    }
};

module.exports.handler = exports.handler;
