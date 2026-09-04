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

// ── Guardado estructurado (wizard): editorial + reglas + tarifas/escalas/extras ──
// Reemplaza las colecciones (delete+insert) y upserta tur_productos. Service role
// (server) ejecuta; el front nunca toca la BD. Validaciones básicas de dominio.
async function guardarConfigTur(proyectoId, productoId, body) {
    const db = (require('./supabase-admin')).supabase;

    // Asegurar fila 1:1 y producto tipo tour
    await motor.asegurarProductoTur(proyectoId, productoId);
    const prod = await motor.obtenerProducto(proyectoId, productoId);
    if (!prod) throw Object.assign(new Error('Producto no encontrado en este proyecto'), { statusCode: 404 });
    if (!motor.esProductoTour(prod)) throw new Error('El producto no es de tipo turístico (tour)');

    const editorial = (body && typeof body.editorial === 'object' && body.editorial) || {};
    const reglas = (body && typeof body.reglas === 'object' && body.reglas) || {};

    const base = {
        producto_id: productoId,
        proyecto_id: proyectoId,
        tipo_experiencia: s(editorial.tipo_experiencia) || null,
        destino: s(editorial.destino) || null,
        ubicacion: s(editorial.ubicacion) || null,
        duracion: s(editorial.duracion) || null,
        idiomas: Array.isArray(editorial.idiomas) ? editorial.idiomas.filter(Boolean).map(s) : [],
        incluye: Array.isArray(editorial.incluye) ? editorial.incluye.filter(Boolean).map(s) : [],
        no_incluye: Array.isArray(editorial.no_incluye) ? editorial.no_incluye.filter(Boolean).map(s) : [],
        recomendaciones: s(editorial.recomendaciones) || null,
        restricciones: s(editorial.restricciones) || null,
        punto_encuentro: s(editorial.punto_encuentro) || null,
        politica_cancelacion: s(editorial.politica_cancelacion) || null,
        pricing_modelo: ['por_persona', 'por_reserva', 'por_vehiculo'].includes(reglas.pricing_modelo) ? reglas.pricing_modelo : 'por_persona',
        requiere_adulto: reglas.requiere_adulto === true,
        min_pax: Math.max(1, Math.floor(Number(reglas.min_pax) || 1)),
        max_pax: reglas.max_pax ? Math.max(1, Math.floor(Number(reglas.max_pax))) : null,
        costo_proveedor_cents: Math.max(0, Math.floor(Number(reglas.costo_proveedor_cents) || 0)),
        impuesto_pct: Math.max(0, Number(reglas.impuesto_pct) || 0),
        migrado: true,
        updated_at: new Date().toISOString()
    };
    if (base.max_pax && base.max_pax < base.min_pax) throw new Error('El máximo de participantes no puede ser menor al mínimo');

    // Validación de tarifas (al menos una, precios >= 0, edades coherentes)
    const tarifas = motor.normCategorias(body && body.tarifas)
        .filter(c => c.nombre)
        .map((c, i) => ({
            proyecto_id: proyectoId,
            producto_id: productoId,
            nombre: c.nombre,
            edad_min: c.edad_min,
            edad_max: c.edad_max,
            precio_cents: c.precio_cents,
            permitido: c.permitido,
            orden: i
        }));
    if (!tarifas.length) throw new Error('Agrega al menos una tarifa de pasajero');
    for (const t of tarifas) {
        if (t.precio_cents < 0) throw new Error('El precio de "' + t.nombre + '" no puede ser negativo');
        if (t.edad_min != null && t.edad_max != null && t.edad_min > t.edad_max) {
            throw new Error('El rango de edad de "' + t.nombre + '" es inválido (mínimo mayor que máximo)');
        }
    }

    const escalas = (motor.normEscalas(body && body.escalas) || []).map(e => ({
        proyecto_id: proyectoId,
        producto_id: productoId,
        desde: Math.max(1, e.desde),
        hasta: e.hasta,
        tipo: e.tipo,
        aplica_a: e.aplica_a,
        valor: e.valor,
        combina_con_promo: e.combina_con_promo,
        antes_de_extras: e.antes_de_extras
    }));
    for (const e of escalas) {
        if (e.valor < 0) throw new Error('Un descuento por grupo no puede ser negativo');
        if (e.tipo === 'pct' && e.valor > 100) throw new Error('Un descuento porcentual no puede superar 100%');
        if (e.hasta != null && e.hasta < e.desde) throw new Error('Un tramo de descuento tiene un rango inválido');
    }

    const extras = (motor.normExtras(body && body.extras) || []).map((x, i) => ({
        proyecto_id: proyectoId,
        producto_id: productoId,
        nombre: x.nombre,
        descripcion: x.descripcion,
        tipo_precio: x.tipo_precio,
        precio_cents: x.precio_cents,
        obligatorio: x.obligatorio,
        min_qty: Math.max(1, x.min_qty),
        max_qty: x.max_qty,
        activo: x.activo
    }));
    for (const x of extras) {
        if (x.precio_cents < 0) throw new Error('El extra "' + x.nombre + '" no puede tener precio negativo');
    }

    const { error: eBase } = await db.from('tur_productos').upsert(base, { onConflict: 'producto_id' });
    if (eBase) throw new Error('Error guardando el producto turístico: ' + eBase.message);

    // Reemplazo atómico de colecciones (v1 simple y consistente).
    const del = (tabla) => db.from(tabla).delete().eq('producto_id', productoId).eq('proyecto_id', proyectoId);
    const { error: eDel1 } = await del('tur_producto_tarifas');
    if (eDel1) throw new Error('Error limpiando tarifas: ' + eDel1.message);
    const { error: eDel2 } = await del('tur_producto_escalas');
    if (eDel2) throw new Error('Error limpiando escalas: ' + eDel2.message);
    const { error: eDel3 } = await del('tur_producto_extras');
    if (eDel3) throw new Error('Error limpiando extras: ' + eDel3.message);

    const { error: eIns1 } = tarifas.length ? await db.from('tur_producto_tarifas').insert(tarifas) : {};
    if (eIns1) throw new Error('Error guardando tarifas: ' + eIns1.message);
    const { error: eIns2 } = escalas.length ? await db.from('tur_producto_escalas').insert(escalas) : {};
    if (eIns2) throw new Error('Error guardando escalas: ' + eIns2.message);
    const { error: eIns3 } = extras.length ? await db.from('tur_producto_extras').insert(extras) : {};
    if (eIns3) throw new Error('Error guardando extras: ' + eIns3.message);

    return { ok: true, migrado: true };
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

        if (action === 'guardar_config_tur') {
            const productoId = s(body.producto_id);
            if (!productoId) return pagerror('Falta producto_id');
            const resultado = await guardarConfigTur(proyectoId, productoId, body);
            return ok(resultado);
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
