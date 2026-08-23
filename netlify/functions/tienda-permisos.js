// tienda-permisos.js — CRUD de permisos de proyecto por usuario
//
// Flujo: Admin asigna permiso a un usuario → el usuario ve Web Factory →
//        solo sus proyectos asignados → "Editar" → tienda-admin.html o editor AI.
//
// Acciones:
//   list     → lista permisos de un proyecto (admin)
//   my       → lista mis permisos (cualquier usuario autenticado)
//   grant    → asigna permiso a un usuario (admin)
//   revoke   → elimina permiso (admin)
//   check    → verifica si tengo permiso en un proyecto (cualquier usuario)
//
// Roles para tiendas:
//   admin_tienda  → acceso completo a la tienda
//   editor_tienda → editar productos y órdenes
//   visor_tienda  → solo lectura
//
// Roles para sitios web:
//   admin_sitio  → acceso completo al sitio (contenido, agente, dominio, tokens)
//   editor_sitio → editar contenido AI y recargar tokens
//   visor_sitio  → solo ver estado y preview

const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');

const ROLES_VALIDOS = [
    'admin_tienda', 'editor_tienda', 'visor_tienda',
    'admin_sitio', 'editor_sitio', 'visor_sitio'
];

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
};

async function getUser(event) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) throw new Error('Token no enviado');
    const token = authHeader.replace('Bearer ', '');
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: userData, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !userData?.user) throw new Error('No autenticado');
    return userData.user;
}

async function esAdmin(userId) {
    const { data } = await supabase.from('perfiles').select('is_admin').eq('id', userId).single();
    return data?.is_admin === true;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };

    try {
        const user = await getUser(event);
        const body = JSON.parse(event.body || '{}');
        const { action, proyecto_id, user_id, email, rol } = body;

        // ── MY: mis permisos de tienda ──
        if (action === 'my') {
            const { data, error } = await supabase
                .from('tienda_permisos')
                .select('id, proyecto_id, rol, created_at')
                .eq('user_id', user.id);
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
            return { statusCode: 200, body: JSON.stringify({ ok: true, permisos: data || [] }) };
        }

        // ── CHECK: ¿tengo permiso en un proyecto? ──
        if (action === 'check') {
            if (!proyecto_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta proyecto_id' }) };
            if (await esAdmin(user.id)) {
                return { statusCode: 200, body: JSON.stringify({ ok: true, tiene: true, rol: 'admin' }) };
            }
            const { data } = await supabase
                .from('tienda_permisos')
                .select('rol')
                .eq('proyecto_id', proyecto_id)
                .eq('user_id', user.id)
                .single();
            return { statusCode: 200, body: JSON.stringify({ ok: true, tiene: !!data, rol: data?.rol || null }) };
        }

        // ── Las siguientes acciones requieren admin ──
        if (!await esAdmin(user.id)) {
            return { statusCode: 403, body: JSON.stringify({ error: 'No tienes permisos de admin' }) };
        }

        // ── LIST: permisos de un proyecto ──
        if (action === 'list') {
            if (!proyecto_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta proyecto_id' }) };
            const { data, error } = await supabase
                .from('tienda_permisos')
                .select('*')
                .eq('proyecto_id', proyecto_id)
                .order('created_at', { ascending: false });
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
            return { statusCode: 200, body: JSON.stringify({ ok: true, permisos: data || [] }) };
        }

        // ── LIST_ALL: todos los permisos (admin dashboard) ──
        if (action === 'list_all') {
            const { data, error } = await supabase
                .from('tienda_permisos')
                .select('*, web_projects!inner(id, nombre, slug, plantilla, netlify_url)')
                .order('created_at', { ascending: false });
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
            return { statusCode: 200, body: JSON.stringify({ ok: true, permisos: data || [] }) };
        }

        // ── GRANT: asignar permiso ──
        if (action === 'grant') {
            if (!proyecto_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta proyecto_id' }) };
            let targetUserId = user_id;
            // Si viene email, buscar el user_id
            if (!targetUserId && email) {
                const { data: perfil } = await supabase
                    .from('perfiles')
                    .select('id')
                    .ilike('email', email.trim())
                    .single();
                if (!perfil) return { statusCode: 404, body: JSON.stringify({ error: 'No se encontro usuario con ese email' }) };
                targetUserId = perfil.id;
            }
            if (!targetUserId) return { statusCode: 400, body: JSON.stringify({ error: 'Falta user_id o email' }) };

            const permisoRol = rol || 'admin_tienda';
            if (!ROLES_VALIDOS.includes(permisoRol)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Rol no válido: ' + permisoRol + '. Roles válidos: ' + ROLES_VALIDOS.join(', ') }) };
            }
            const { data, error } = await supabase
                .from('tienda_permisos')
                .upsert({ proyecto_id, user_id: targetUserId, rol: permisoRol }, { onConflict: 'proyecto_id,user_id' })
                .select()
                .single();
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
            return { statusCode: 200, body: JSON.stringify({ ok: true, permiso: data }) };
        }

        // ── REVOKE: eliminar permiso ──
        if (action === 'revoke') {
            if (!proyecto_id || !user_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta proyecto_id o user_id' }) };
            const { error } = await supabase
                .from('tienda_permisos')
                .delete()
                .eq('proyecto_id', proyecto_id)
                .eq('user_id', user_id);
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
            return { statusCode: 200, body: JSON.stringify({ ok: true }) };
        }

        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida: ' + action }) };

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Error interno' }) };
    }
};
