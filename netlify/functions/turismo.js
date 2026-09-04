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

    // Compatibilidad bidireccional (D4): el agente/CRM y el storefront leen
    // tienda_productos.atributos. Mantenemos ese JSON legado sincronizado.
    const legadoAtributos = Object.assign({}, (prod.atributos && typeof prod.atributos === 'object') ? prod.atributos : {});
    delete legadoAtributos.categorias_pasajero;
    delete legadoAtributos.escalas_cantidad;
    delete legadoAtributos.extras;
    delete legadoAtributos.min_participantes;
    delete legadoAtributos.max_participantes;
    delete legadoAtributos.requiere_adulto;
    legadoAtributos.categorias_pasajero = tarifas.map(t => ({
        nombre: t.nombre,
        edad_min: t.edad_min,
        edad_max: t.edad_max,
        precio_cents: t.precio_cents,
        permitido: t.permitido
    }));
    legadoAtributos.escalas_cantidad = escalas.map(e => ({
        desde: e.desde,
        hasta: e.hasta,
        descuento_pct: e.tipo === 'pct' ? e.valor : null,
        tipo: e.tipo,
        valor: e.valor,
        aplica_a: e.aplica_a
    }));
    legadoAtributos.extras = extras.map(x => ({
        nombre: x.nombre,
        descripcion: x.descripcion,
        tipo_precio: x.tipo_precio,
        precio_cents: x.precio_cents,
        obligatorio: x.obligatorio
    }));
    legadoAtributos.min_participantes = base.min_pax;
    legadoAtributos.max_participantes = base.max_pax;
    legadoAtributos.requiere_adulto = base.requiere_adulto;
    const { error: eLeg } = await db.from('tienda_productos')
        .update({ atributos: legadoAtributos, updated_at: new Date().toISOString() })
        .eq('id', productoId)
        .eq('proyecto_id', proyectoId);
    if (eLeg) throw new Error('Error sincronizando legado: ' + eLeg.message);

    // ── Calendario (plantillas + fechas bloqueadas) ──
    const calendario = (body && body.calendario && typeof body.calendario === 'object') ? body.calendario : {};
    const plantillasIn = Array.isArray(calendario.plantillas) ? calendario.plantillas : [];
    const fechasIn = Array.isArray(calendario.fechas_bloqueadas) ? calendario.fechas_bloqueadas : [];

    const plantillas = plantillasIn
        .filter(p => p && s(p.hora_salida))
        .map(p => ({
            proyecto_id: proyectoId,
            producto_id: productoId,
            desde: s(p.desde) || null,
            hasta: s(p.hasta) || null,
            dias: Array.isArray(p.dias) ? p.dias.filter(Boolean).map(s) : [],
            hora_salida: s(p.hora_salida),
            hora_regreso: s(p.hora_regreso) || null,
            capacidad: Math.max(1, Math.floor(Number(p.capacidad) || 40)),
            adelanto_cierre_hs: Math.max(0, Math.floor(Number(p.adelanto_cierre_hs) || 0)),
            activo: p.activo !== false
        }));
    const fechasBloqueadas = fechasIn
        .filter(f => f && s(f.fecha))
        .map(f => ({ proyecto_id: proyectoId, producto_id: productoId, fecha: s(f.fecha), motivo: s(f.motivo) || null }));

    // ── Logística (recogidas / traslados / itinerario) ──
    const logistica = (body && body.logistica && typeof body.logistica === 'object') ? body.logistica : {};
    const recogidas = (Array.isArray(logistica.recogidas) ? logistica.recogidas : [])
        .filter(r => r && s(r.nombre))
        .map(r => ({
            proyecto_id: proyectoId, producto_id: productoId,
            nombre: s(r.nombre), zona: s(r.zona) || null, direccion: s(r.direccion) || null,
            lat: r.lat != null && r.lat !== '' ? Number(r.lat) : null,
            lng: r.lng != null && r.lng !== '' ? Number(r.lng) : null,
            hora: s(r.hora) || null,
            costo_cents: Math.max(0, Math.floor(Number(r.costo_cents) || 0)),
            activo: r.activo !== false
        }));
    const traslados = (Array.isArray(logistica.traslados) ? logistica.traslados : [])
        .filter(t => t && s(t.tipo_vehiculo))
        .map(t => ({
            proyecto_id: proyectoId, producto_id: productoId,
            tipo_vehiculo: s(t.tipo_vehiculo), capacidad: t.capacidad != null ? Math.max(1, Math.floor(Number(t.capacidad))) : null,
            origen: s(t.origen) || null, destino: s(t.destino) || null, horario: s(t.horario) || null,
            precio_cents: Math.max(0, Math.floor(Number(t.precio_cents) || 0)),
            incluido: t.incluido === true
        }));
    const itinerario = (Array.isArray(logistica.itinerario) ? logistica.itinerario : [])
        .filter(it => it && (s(it.titulo) || s(it.hora)))
        .map((it, i) => ({
            proyecto_id: proyectoId, producto_id: productoId,
            orden: Math.floor(Number(it.orden != null ? it.orden : i)),
            hora: s(it.hora) || null, titulo: s(it.titulo) || null, descripcion: s(it.descripcion) || null
        }));

    const reemplazo = async (tabla, filas) => {
        const { error: eDel } = await db.from(tabla).delete().eq('producto_id', productoId).eq('proyecto_id', proyectoId);
        if (eDel) throw new Error('Error limpiando ' + tabla + ': ' + eDel.message);
        if (filas.length) {
            const { error: eIns } = await db.from(tabla).insert(filas);
            if (eIns) throw new Error('Error guardando ' + tabla + ': ' + eIns.message);
        }
    };
    await reemplazo('tur_salida_plantillas', plantillas);
    await reemplazo('tur_producto_fechas_bloqueadas', fechasBloqueadas);
    await reemplazo('tur_recogidas', recogidas);
    await reemplazo('tur_traslados', traslados);
    await reemplazo('tur_itinerario', itinerario);

    return { ok: true, migrado: true };
}

// ── Motor público: salidas, cotización y reserva (con Wompi) ──
async function proyectoPorBody(body) {
    const db = (require('./supabase-admin')).supabase;
    const slug = s(body.slug);
    const pid = s(body.proyecto_id);
    if (slug) {
        const { data } = await db.from('web_projects').select('*').eq('slug', slug).maybeSingle();
        return data || null;
    }
    if (pid) {
        const { data } = await db.from('web_projects').select('*').eq('id', pid).maybeSingle();
        return data || null;
    }
    return null;
}

async function productoPublicoTur(proyecto, productoId) {
    const db = (require('./supabase-admin')).supabase;
    const { data } = await db
        .from('tienda_productos')
        .select('id, nombre, descripcion, precio_cents, activo, tipo, atributos')
        .eq('id', productoId)
        .eq('proyecto_id', proyecto.id)
        .maybeSingle();
    if (!data || !motor.esProductoTour(data)) return null;
    return data;
}

function configMotorDesde(data) {
    const ed = (data && data.editorial) || {};
    return {
        tarifas: (data && data.tarifas) || [],
        escalas: (data && data.escalas) || [],
        extras: (data && data.extras) || [],
        reglas: {
            requiere_adulto: ed.requiere_adulto === true,
            min_pax: Number(ed.min_pax) || 1,
            max_pax: ed.max_pax ? Number(ed.max_pax) : null
        }
    };
}

// Avisa al dueño/tienda según el apartado "Notificaciones" (correos configurados).
async function notificarReservaNueva(proyecto, prod, reserva, resumen, fecha, horaSalida) {
    try {
        const db = (require('./supabase-admin')).supabase;
        const { data: cfg } = await db.from('tienda_pasarela').select('*').eq('proyecto_id', proyecto.id).maybeSingle();
        if (!cfg || cfg.notify_on_new_order === false) return;
        const { notificarTienda } = require('./notifications');
        const monto = '$' + Math.round((Number(resumen.total_cents) || 0) / 100).toLocaleString('es-CO');
        const cliente = (reserva.cliente && typeof reserva.cliente === 'object') ? reserva.cliente : {};
        const pax = Array.isArray(reserva.pasajeros) ? reserva.pasajeros.reduce((a, p) => a + (Number(p.cantidad) || 0), 0) : 0;
        await notificarTienda({
            proyectoId: proyecto.id,
            createdBy: proyecto.created_by,
            config: cfg,
            subject: 'Nueva reserva en ' + (proyecto.nombre || prod.nombre),
            text: 'Nueva reserva ✅\nExperiencia: ' + prod.nombre +
                '\nFecha: ' + (fecha || '') + (horaSalida ? ' · ' + horaSalida : '') +
                '\nCliente: ' + (cliente.nombre || '') + (cliente.email ? ' · ' + cliente.email : '') +
                '\nPasajeros: ' + pax + '\nTotal: ' + monto +
                (reserva.wompi_url ? '\nLink de pago: ' + reserva.wompi_url : '') +
                '\n\n(Reserva ' + reserva.id + ')'
        });
    } catch (e) {
        console.error('notificarReservaNueva error:', e && e.message);
    }
}

// GET salidas disponibles en un rango (fechas candidatas por plantillas).
async function publicSalidasDisponibles(body) {
    const proyecto = await proyectoPorBody(body);
    if (!proyecto) return pagerror('Proyecto no encontrado', 404);
    const productoId = s(body.producto_id);
    const desde = s(body.desde) || new Date().toISOString().slice(0, 10);
    const hasta = s(body.hasta) || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const prod = await productoPublicoTur(proyecto, productoId);
    if (!prod) return pagerror('Producto no disponible', 404);

    const db = (require('./supabase-admin')).supabase;
    const { data: plantillas } = await db
        .from('tur_salida_plantillas')
        .select('*')
        .eq('producto_id', productoId)
        .eq('activo', true);
    if ((plantillas || []).length === 0) return ok({ ok: true, salidas: [], msg: 'El producto aún no define calendario de salidas.' });

    const { data: bloqueadas } = await db
        .from('tur_producto_fechas_bloqueadas')
        .select('fecha')
        .eq('producto_id', productoId)
        .gte('fecha', desde)
        .lte('fecha', hasta);
    const bloqueadasSet = {};
    for (const b of bloqueadas || []) bloqueadasSet[b.fecha] = true;

    const { data: existentes } = await db
        .from('tur_salidas')
        .select('fecha, hora_salida, capacidad, reservas_confirmadas, estado')
        .eq('producto_id', productoId)
        .gte('fecha', desde)
        .lte('fecha', hasta);

    const salidas = [];
    const porClave = {};
    for (const ex of existentes || []) porClave[ex.fecha + '|' + (ex.hora_salida || '')] = ex;

    for (const p of plantillas || []) {
        // Ventana real del periodo: intersección del rango consultado con el
        // rango definido en la disponibilidad (desde/hasta; si no hay rango, aplica
        // a cualquier fecha consultada = disponibilidad recurrente).
        let winDesde = desde;
        let winHasta = hasta;
        if (p.desde && String(p.desde) > winDesde) winDesde = String(p.desde);
        if (p.hasta && String(p.hasta) < winHasta) winHasta = String(p.hasta);
        if (winDesde > winHasta) continue;
        const dias = Array.isArray(p.dias) ? p.dias : [];
        const fechas = motor.listarFechasCandidatas(winDesde, winHasta, dias);
        for (const fecha of fechas) {
            if (bloqueadasSet[fecha]) continue;
            const clave = fecha + '|' + (p.hora_salida || '');
            const ex = porClave[clave];
            const capacidad = ex ? ex.capacidad : (Number(p.capacidad) || 40);
            const reservados = ex ? ex.reservas_confirmadas : 0;
            const restantes = Math.max(0, capacidad - reservados);
            if (ex && ex.estado === 'cancelada') continue;
            if (restantes <= 0) {
                salidas.push({ fecha, hora_salida: p.hora_salida, hora_regreso: p.hora_regreso, capacidad, restantes: 0, agotada: true });
                continue;
            }
            salidas.push({ fecha, hora_salida: p.hora_salida, hora_regreso: p.hora_regreso, capacidad, restantes, agotada: false });
        }
    }
    salidas.sort((a, b) => (a.fecha + a.hora_salida).localeCompare(b.fecha + b.hora_salida));
    return ok({ ok: true, producto_id: productoId, salidas });
}

// Cotización server-side (nunca se confía en el cliente).
async function publicPreviewPrecio(body) {
    const proyecto = await proyectoPorBody(body);
    if (!proyecto) return pagerror('Proyecto no encontrado', 404);
    const prod = await productoPublicoTur(proyecto, s(body.producto_id));
    if (!prod) return pagerror('Producto no disponible', 404);

    const config = await motor.leerConfigTur(proyecto.id, prod.id);
    if (!config) return pagerror('El producto no está configurado como experiencia', 400);

    const resultado = motor.calcularPrecioTour(configMotorDesde(config), {
        pasajeros: body.pasajeros,
        extras: body.extras
    });
    if (!resultado.ok) return pagerror(resultado.errores.join(' · '), 400);
    return ok({ ok: true, ...resultado });
}

// Reserva: valida → calcula precio → descuenta cupo (atómico optimista) → link Wompi.
async function publicReservar(body) {
    const proyecto = await proyectoPorBody(body);
    if (!proyecto) return pagerror('Proyecto no encontrado', 404);
    const prod = await productoPublicoTur(proyecto, s(body.producto_id));
    if (!prod) return pagerror('Producto no disponible', 404);

    const fecha = s(body.fecha);
    const horaSalida = s(body.hora_salida);
    if (!fecha || !horaSalida) return pagerror('Faltan fecha y hora de salida', 400);

    const cliente = (body.cliente && typeof body.cliente === 'object') ? body.cliente : {};
    if (!s(cliente.nombre) || !s(cliente.email)) return pagerror('Nombre y email del comprador son obligatorios', 400);

    const config = await motor.leerConfigTur(proyecto.id, prod.id);
    const resultado = motor.calcularPrecioTour(configMotorDesde(config), { pasajeros: body.pasajeros, extras: body.extras });
    if (!resultado.ok) return pagerror(resultado.errores.join(' · '), 400);

    // Bloqueado por fecha
    const db = (require('./supabase-admin')).supabase;
    const { data: bloqueo } = await db
        .from('tur_producto_fechas_bloqueadas')
        .select('id')
        .eq('producto_id', prod.id)
        .eq('fecha', fecha)
        .maybeSingle();
    if (bloqueo) return pagerror('Esa fecha está bloqueada', 400);

    const n = resultado.total_pasajeros;
    const { data: salida, error: salidaErr } = await db
        .from('tur_salidas')
        .select('*')
        .eq('producto_id', prod.id)
        .eq('fecha', fecha)
        .eq('hora_salida', horaSalida)
        .maybeSingle();

    let salidaId = null;
    if (salidaErr) return pagerror(salidaErr.message, 500);
    if (!salida) {
        const { data: plantilla } = await db
            .from('tur_salida_plantillas')
            .select('capacidad, hora_regreso')
            .eq('producto_id', prod.id)
            .eq('hora_salida', horaSalida)
            .eq('activo', true)
            .maybeSingle();
        const capacidad = plantilla ? Number(plantilla.capacidad) || 40 : 40;
        if (n > capacidad) return pagerror('No hay cupo suficiente para esa salida', 409);
        const { data: nueva, error: eN } = await db.from('tur_salidas').insert({
            proyecto_id: proyecto.id,
            producto_id: prod.id,
            fecha,
            hora_salida: horaSalida,
            hora_regreso: plantilla ? plantilla.hora_regreso : null,
            capacidad,
            reservas_confirmadas: n,
            estado: 'abierta'
        }).select().single();
        if (eN) return pagerror('No se pudo reservar la salida: ' + eN.message, 500);
        salidaId = nueva.id;
    } else {
        if (salida.estado === 'cancelada') return pagerror('Esa salida fue cancelada', 400);
        if (salida.reservas_confirmadas + n > salida.capacidad) return pagerror('No hay cupo suficiente para esa salida', 409);
        const nuevoValor = salida.reservas_confirmadas + n;
        const { error: eU } = await db
            .from('tur_salidas')
            .update({ reservas_confirmadas: nuevoValor, updated_at: new Date().toISOString() })
            .eq('id', salida.id)
            .eq('reservas_confirmadas', salida.reservas_confirmadas);
        if (eU) return pagerror('Error al reservar cupo: ' + eU.message, 500);
        salidaId = salida.id;
    }

    // Registrar reserva
    const { data: reserva, error: eR } = await db.from('tur_reservas').insert({
        proyecto_id: proyecto.id,
        producto_id: prod.id,
        salida_id: salidaId,
        estado: 'pendiente',
        origen: 'online',
        cliente: {
            nombre: s(cliente.nombre),
            documento: s(cliente.documento),
            telefono: s(cliente.telefono),
            email: s(cliente.email)
        },
        pasajeros: Array.isArray(body.pasajeros) ? body.pasajeros : [],
        extras: Array.isArray(body.extras) ? body.extras : [],
        desglose: resultado.desglose,
        total_cents: resultado.total_cents
    }).select().single();
    if (eR) return pagerror('No se pudo registrar la reserva: ' + eR.message, 500);

    // Link de pago Wompi (pasarela del proyecto)
    const { data: pasarela } = await db.from('tienda_pasarela').select('*').eq('proyecto_id', proyecto.id).maybeSingle();
    if (!pasarela || !pasarela.wompi_private_key) {
        await notificarReservaNueva(proyecto, prod, reserva, resultado, fecha, horaSalida);
        return ok({ ok: true, reserva_id: reserva.id, url: null, msg: 'Reserva registrada. El sitio aún no tiene pasarela de pago configurada.' });
    }
    const wompiSandbox = pasarela.wompi_sandbox === true;
    const wompiBase = wompiSandbox ? 'https://sandbox.wompi.co/v1' : 'https://production.wompi.co/v1';
    const redirect = (proyecto.netlify_url || process.env.URL || 'https://auvro.netlify.app').replace(/\/+$/, '') + '/?reserva=' + reserva.id;

    const wompiRes = await fetch(wompiBase + '/payment_links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + pasarela.wompi_private_key },
        body: JSON.stringify({
            name: 'Reserva · ' + prod.nombre,
            description: 'Reserva ' + fecha + ' · ' + horaSalida,
            single_use: true,
            collect_shipping: false,
            currency: 'COP',
            amount_in_cents: resultado.total_cents,
            redirect_url: redirect
        })
    });
    const wompi = await wompiRes.json();
    if (!wompiRes.ok || !wompi || !wompi.data || !wompi.data.id) {
        return pagerror((wompi && wompi.error && wompi.error.message) || 'Error creando el pago en Wompi.', 502);
    }
    const paymentLinkId = String(wompi.data.id);
    await db.from('tur_reservas').update({ wompi_link_id: paymentLinkId, wompi_url: 'https://checkout.wompi.co/l/' + paymentLinkId }).eq('id', reserva.id);
    await db.from('pagos').insert({
        user_id: proyecto.created_by || null,
        tipo: 'turismo',
        concepto: 'Reserva ' + prod.nombre,
        monto_cents: resultado.total_cents,
        payment_link_id: paymentLinkId,
        estado: 'pendiente'
    }).then(() => {}).catch((e) => console.error('pagos insert turismo:', e && e.message));

    await notificarReservaNueva(proyecto, prod, reserva, resultado, fecha, horaSalida);
    return ok({ ok: true, reserva_id: reserva.id, url: 'https://checkout.wompi.co/l/' + paymentLinkId, total_cents: resultado.total_cents, desglose: resultado.desglose });
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return ok({ ok: true });
    if (event.httpMethod !== 'POST') return pagerror('Method Not Allowed', 405);

    try {
        const body = JSON.parse(event.body || '{}');
        const action = s(body.action);

        // ── Acciones públicas (tienda/cliente, sin token) ──
        if (action === 'salidas_disponibles') return await publicSalidasDisponibles(body);
        if (action === 'preview_precio') return await publicPreviewPrecio(body);
        if (action === 'reservar') return await publicReservar(body);

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

        if (action === 'listar_reservas') {
            const { data, error } = await db
                .from('tur_reservas')
                .select('*, tienda_productos(nombre)')
                .eq('proyecto_id', proyectoId)
                .order('created_at', { ascending: false })
                .limit(200);
            if (error) return pagerror(error.message, 500);
            const lista = (data || []).map(r => ({
                id: r.id,
                producto_id: r.producto_id,
                producto_nombre: (r.tienda_productos && r.tienda_productos.nombre) || null,
                salida_id: r.salida_id,
                fecha: null,
                estado: r.estado,
                origen: r.origen,
                cliente: r.cliente || {},
                pasajeros: Array.isArray(r.pasajeros) ? r.pasajeros : [],
                total_cents: r.total_cents,
                desglose: r.desglose || {},
                wompi_url: r.wompi_url,
                created_at: r.created_at
            }));
            return ok({ ok: true, reservas: lista });
        }

        if (action === 'cambiar_estado_reserva') {
            const reservaId = s(body.reserva_id);
            const estado = s(body.estado);
            if (!reservaId || !['pendiente', 'pagada', 'cancelada', 'cotizada'].includes(estado)) {
                return pagerror('Estado inválido', 400);
            }
            const { data, error } = await db
                .from('tur_reservas')
                .update({ estado, updated_at: new Date().toISOString() })
                .eq('id', reservaId)
                .eq('proyecto_id', proyectoId)
                .select()
                .single();
            if (error) return pagerror(error.message, 500);
            return ok({ ok: true, reserva: data });
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
