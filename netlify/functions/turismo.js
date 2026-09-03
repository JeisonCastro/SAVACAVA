// turismo.js — API del módulo de Productos Turísticos (FASE 1: modelo + lectura)
// Admin (Bearer + permiso de proyecto): listar productos tour y leer su configuración
// estructurada (tur_*) migrando el JSON legado de forma perezosa.
// El guardado del wizard, disponibilidad y reservas se agregan en fases siguientes.

const { createClient } = require('@supabase/supabase-js');
const motor = require('./motor-tur');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

const ROLES_ADMIN = ['admin_tienda', 'editor_tienda', 'admin_sitio', 'editor_sitio'];

function ok(body, status = 200) {
    return {
        statusCode: status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' },
        body: JSON.stringify(body)
    };
}

function pagerror(msg, status = 400) {
    return ok({ ok: false, error: msg }, status);
}

function s(v) { return String(v ?? '').trim(); }

// Valida Bearer + acceso admin/owner/permiso sobre el proyecto. Devuelve userId.
async function autenticarAdmin(event, proyectoId) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) throw new Error('Token no enviado');
    const token = authHeader.replace('Bearer ', '');
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: userData, error: authError } = await supabaseUser.auth.getUser();
    if (authError || !userData?.user) throw new Error('Sesión inválida o expirada.');
    const userId = userData.user.id;

    const db = (require('./supabase-admin')).supabase;
    const { data: perfil } = await db.from('perfiles').select('is_admin').eq('id', userId).maybeSingle();
    if (perfil?.is_admin) return userId;

    const { data: permiso } = await db
        .from('tienda_permisos')
        .select('rol')
        .eq('proyecto_id', proyectoId)
        .eq('user_id', userId)
        .maybeSingle();
    if (permiso && ROLES_ADMIN.includes(permiso.rol)) return userId;

    const { data: proyecto } = await db
        .from('web_projects')
        .select('created_by')
        .eq('id', proyectoId)
        .maybeSingle();
    if (proyecto && proyecto.created_by === userId) return userId;

    throw new Error('No tienes permiso para administrar este proyecto');
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return ok({ ok: true });
    if (event.httpMethod !== 'POST') return pagerror('Method Not Allowed', 405);

    try {
        const body = JSON.parse(event.body || '{}');
        const action = s(body.action);

        // Acciones de admin (requieren proyecto)
        const proyectoId = body.proyecto_id || null;
        if (!proyectoId) return pagerror('Falta proyecto_id');
        const userId = await autenticarAdmin(event, proyectoId);

        const db = (require('./supabase-admin')).supabase;

        if (action === 'listar_productos_tur') {
            const { data, error } = await db
                .from('tienda_productos')
                .select('id, nombre, descripcion, precio_cents, imagen, activo, created_at, atributos')
                .eq('proyecto_id', proyectoId)
                .eq('tipo', 'tour')
                .order('created_at', { ascending: false });
            if (error) return pagerror(error.message, 500);

            const ids = (data || []).map(p => p.id);
            let migrados = {};
            if (ids.length) {
                const { data: turRows } = await db
                    .from('tur_productos')
                    .select('producto_id, migrado, tipo_experiencia')
                    .in('producto_id', ids);
                for (const r of turRows || []) migrados[r.producto_id] = r;
            }

            const lista = (data || []).map(p => {
                const t = migrados[p.id] || {};
                const legado = motor.parseTourLegacy(p.atributos);
                return {
                    id: p.id,
                    nombre: p.nombre,
                    descripcion: p.descripcion,
                    precio_desde_cents: p.precio_cents || 0,
                    imagen: p.imagen || null,
                    activo: p.activo !== false,
                    tipo_experiencia: t.tipo_experiencia || null,
                    migrado: t.migrado === true,
                    tiene_legado: !!legado
                };
            });

            return ok({ ok: true, productos: lista });
        }

        if (action === 'get_config_tur') {
            const productoId = s(body.producto_id);
            if (!productoId) return pagerror('Falta producto_id');

            const { data: prod, error } = await db
                .from('tienda_productos')
                .select('id, tipo')
                .eq('id', productoId)
                .eq('proyecto_id', proyectoId)
                .maybeSingle();
            if (error) return pagerror(error.message, 500);
            if (!prod) return pagerror('Producto no encontrado en este proyecto', 404);
            if (String(prod.tipo || '').trim() !== 'tour') {
                return pagerror('El producto no es de tipo turístico (tour)', 400);
            }

            const config = await motor.leerConfigTur(proyectoId, productoId);
            if (!config) return pagerror('No se pudo leer la configuración del producto', 500);
            return ok(config);
        }

        return pagerror('Acción desconocida: ' + action, 404);
    } catch (err) {
        console.error('turismo.js error:', err.message);
        if (/does not exist/i.test(err.message || '')) {
            return pagerror('Faltan tablas del módulo Turismo. Aplica la migración supabase/migrations/20260903_turismo.sql en el SQL Editor de Supabase.', 500);
        }
        return pagerror(err.message || 'Error interno', err.statusCode || 400);
    }
};
