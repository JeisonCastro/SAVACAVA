// tienda.js — E-commerce de Web Factory (plantilla "tienda")
//
// La tienda generada por Web Factory es un sitio estático que habla con esta
// función (alojada en auvro.netlify.app). Los datos viven en Supabase.
//
// Acciones públicas (CORS abierto para la tienda):
//   catalogo    (GET)  -> lista productos activos del sitio por slug.
//   checkout    (POST) -> valida items, recalcula el total del lado servidor,
//                         crea la orden + líneas, genera el link de pago de
//                         Wompi (pasarela DEL CLIENTE del sitio, tabla tienda_pasarela)
//                         y lo registra en `pagos`.
//   get_orden   (GET)  -> estado de una orden (+ enlaces de descarga digital si está pagada).
//
// Acciones de admin (Bearer token + perfiles.is_admin, mismo patrón que web-factory):
//   guardar_producto, eliminar_producto, listar_productos, listar_ordenes,
//   cambiar_estado_orden, configurar_pasarela, estado_pasarela,
//   estado_notificaciones, configurar_notificaciones, desconectar_gmail.
//
// Seguridad: los precios se recalculan en el servidor (nunca se confía en el front).
// Las claves Wompi del cliente viven en tienda_pasarela y jamás se devuelven al frontend.

const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

const SITE_URL = process.env.URL || 'https://auvro.netlify.app';

const BUCKET_IMG = 'productos';
const BUCKET_DIGITAL = 'tienda-digital';
const TAMANO_MAX = 8 * 1024 * 1024;

const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Content-Type": "application/json"
};

function ok(body, status = 200) {
    return { statusCode: status, headers, body: JSON.stringify(body) };
}

// ── Auth de admin (mismo patrón que web-factory.js) ──
async function autenticarAdmin(event) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) throw new Error('Token no enviado');
    const token = authHeader.replace('Bearer ', '');
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: userData, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !userData?.user) throw new Error('No autenticado');
    const { data: miPerfil } = await supabase
        .from('perfiles')
        .select('is_admin')
        .eq('id', userData.user.id)
        .single();
    if (!miPerfil?.is_admin) throw new Error('No eres admin');
    return userData.user.id;
}

// ── Helpers de archivos (Supabase Storage) ──
async function asegurarBucket(nombre, publico) {
    const { error } = await supabase.storage.createBucket(nombre, {
        public: publico,
        file_size_limit: TAMANO_MAX
    });
    if (error && !/already exists/i.test(error.message || '')) throw error;
}

function extDesdeMime(mime = '') {
    const map = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
        'image/gif': '.gif', 'image/avif': '.avif',
        'application/pdf': '.pdf', 'application/zip': '.zip',
        'application/octet-stream': '.bin', 'text/plain': '.txt',
        'text/markdown': '.md', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/msword': '.doc', 'application/vnd.ms-excel': '.xls'
    };
    return map[String(mime).toLowerCase().split(';')[0].trim()] || '.bin';
}

function parseDataUrl(dataUrl) {
    const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
}

async function subirImagen(proyectoId, dataUrl, filename) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) throw new Error('Imagen inválida: envía un data URL de imagen.');
    if (parsed.buffer.length > TAMANO_MAX) throw new Error(`La imagen supera ${TAMANO_MAX / 1024 / 1024} MB.`);
    await asegurarBucket(BUCKET_IMG, true);
    const base = String(filename || 'producto').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 60) || 'producto';
    const ruta = `${BUCKET_IMG}/${proyectoId}/${Date.now()}-${Math.floor(Math.random() * 1e6)}-${base}${extDesdeMime(parsed.mime)}`;
    const { error } = await supabase.storage.from(BUCKET_IMG).upload(ruta, new Blob([parsed.buffer], { type: parsed.mime }), { contentType: parsed.mime, upsert: false });
    if (error) throw new Error('No se pudo subir la imagen: ' + error.message);
    const { data: urlData } = supabase.storage.from(BUCKET_IMG).getPublicUrl(ruta);
    return urlData?.publicUrl || '';
}

async function subirArchivoDigital(proyectoId, dataUrl, filename) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) throw new Error('Archivo inválido: envía un data URL.');
    if (parsed.buffer.length > TAMANO_MAX) throw new Error(`El archivo supera ${TAMANO_MAX / 1024 / 1024} MB.`);
    await asegurarBucket(BUCKET_DIGITAL, false);
    const base = String(filename || 'producto').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 60) || 'producto';
    const ruta = `${proyectoId}/${Date.now()}-${Math.floor(Math.random() * 1e6)}-${base}${extDesdeMime(parsed.mime)}`;
    const { error } = await supabase.storage.from(BUCKET_DIGITAL).upload(ruta, new Blob([parsed.buffer], { type: parsed.mime }), { contentType: parsed.mime, upsert: false });
    if (error) throw new Error('No se pudo subir el archivo: ' + error.message);
    return ruta;
}

// ── Catálogo público ──
async function accionCatalogo(params) {
    const slug = String(params.slug || '').trim();
    if (!slug) return ok({ ok: false, error: 'Falta el slug del sitio' }, 400);
    const { data: proyecto } = await supabase.from('web_projects').select('id').eq('slug', slug).maybeSingle();
    if (!proyecto) return ok({ ok: false, error: 'Sitio no encontrado' }, 404);
    const { data: productos, error } = await supabase
        .from('tienda_productos')
        .select('id, nombre, descripcion, precio_cents, tipo, imagen, stock')
        .eq('proyecto_id', proyecto.id)
        .eq('activo', true)
        .order('created_at', { ascending: true });
    if (error) return ok({ ok: false, error: error.message }, 500);
    const visibles = (productos || []).map(p => ({
        ...p,
        agotado: p.tipo === 'fisico' && p.stock !== null && p.stock <= 0
    }));
    return ok({ ok: true, productos: visibles });
}

// ── Checkout público ──
async function accionCheckout(body) {
    const { slug, items, cliente, direccion } = body;
    if (!slug || !Array.isArray(items) || !items.length) return ok({ ok: false, error: 'Carrito vacío o slug inválido' }, 400);
    if (items.length > 50) return ok({ ok: false, error: 'Demasiados productos en el carrito' }, 400);

    const nombre = String(cliente?.nombre || '').trim();
    const email = String(cliente?.email || '').trim();
    const telefono = String(cliente?.telefono || '').trim();
    if (!nombre || !email) return ok({ ok: false, error: 'Nombre y email son obligatorios' }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return ok({ ok: false, error: 'Email inválido' }, 400);

    const { data: proyecto } = await supabase.from('web_projects').select('*').eq('slug', slug).maybeSingle();
    if (!proyecto) return ok({ ok: false, error: 'Sitio no encontrado' }, 404);

    const ids = items.map(i => i.producto_id);
    const { data: productos, error: prodErr } = await supabase
        .from('tienda_productos')
        .select('*')
        .in('id', ids)
        .eq('proyecto_id', proyecto.id);
    if (prodErr) return ok({ ok: false, error: prodErr.message }, 500);

    const porId = {};
    for (const p of productos || []) porId[p.id] = p;

    let total = 0;
    const lineas = [];
    let hayFisico = false;
    for (const it of items) {
        const prod = porId[it.producto_id];
        if (!prod || !prod.activo) return ok({ ok: false, error: 'Un producto del carrito ya no está disponible' }, 400);
        const cant = Math.min(Math.max(1, Math.floor(Number(it.cantidad) || 1)), 99);
        if (prod.tipo === 'fisico' && prod.stock !== null && prod.stock < cant) {
            return ok({ ok: false, error: `Stock insuficiente para: ${prod.nombre}` }, 400);
        }
        if (prod.tipo === 'fisico') hayFisico = true;
        total += prod.precio_cents * cant;
        lineas.push({ producto_id: prod.id, nombre: prod.nombre, precio_cents: prod.precio_cents, cantidad: cant });
    }
    if (total <= 0) return ok({ ok: false, error: 'Total inválido' }, 400);
    if (hayFisico && !String(direccion || '').trim()) return ok({ ok: false, error: 'La dirección de envío es obligatoria' }, 400);

    // 0) Validar la pasarela Wompi DEL CLIENTE antes de crear la orden
    const { data: pasarela, error: pasarelaErr } = await supabase
        .from('tienda_pasarela')
        .select('*')
        .eq('proyecto_id', proyecto.id)
        .maybeSingle();
    if (pasarelaErr && !/does not exist/i.test(pasarelaErr.message || '')) {
        return ok({ ok: false, error: 'Error leyendo la pasarela: ' + pasarelaErr.message }, 500);
    }
    if (!pasarela?.wompi_private_key) {
        return ok({ ok: false, error: 'Esta tienda no tiene configurada su pasarela de pago (Wompi). El administrador debe agregar las llaves del cliente desde el panel (Web Factory > Tienda > Pasarela).' }, 402);
    }
    const WOMPI_BASE = pasarela.wompi_sandbox
        ? 'https://sandbox.wompi.co/v1'
        : 'https://production.wompi.co/v1';

    // 1) Orden + líneas
    const { data: orden, error: ordenErr } = await supabase
        .from('tienda_ordenes')
        .insert({
            proyecto_id: proyecto.id,
            cliente_nombre: nombre,
            cliente_email: email,
            cliente_telefono: telefono,
            direccion: hayFisico ? String(direccion).trim() : null,
            total_cents: total,
            estado: 'pendiente'
        })
        .select()
        .single();
    if (ordenErr) return ok({ ok: false, error: 'No se pudo crear la orden: ' + ordenErr.message }, 500);

    const { error: itemsErr } = await supabase.from('tienda_orden_items').insert(
        lineas.map(l => ({ orden_id: orden.id, ...l }))
    );
    if (itemsErr) {
        await supabase.from('tienda_ordenes').delete().eq('id', orden.id).catch(() => {});
        return ok({ ok: false, error: 'No se pudo guardar las líneas de la orden' }, 500);
    }

    // 2) Link de pago en Wompi (pasarela ya validada arriba)
    const concepto = `Compra en ${proyecto.nombre}`;
    const redirect = (proyecto.netlify_url || SITE_URL).replace(/\/+$/, '') + `/?orden=${orden.id}`;
    const wompiRes = await fetch(`${WOMPI_BASE}/payment_links`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${pasarela.wompi_private_key}`
        },
        body: JSON.stringify({
            name: `AUVRO - ${concepto}`,
            description: concepto,
            single_use: true,
            collect_shipping: false,
            currency: 'COP',
            amount_in_cents: total,
            redirect_url: redirect
        })
    });
    const wompi = await wompiRes.json();
    if (!wompiRes.ok || !wompi?.data?.id) {
        console.error('Wompi error al crear link de tienda:', JSON.stringify(wompi));
        return ok({ ok: false, error: wompi?.error?.message || 'Error creando el pago en Wompi.' }, 502);
    }
    const paymentLinkId = wompi.data.id;

    // 2b) Guardar el link de pago en la orden (la columna e índice ya existen)
    try {
        await supabase
            .from('tienda_ordenes')
            .update({ payment_link_id: paymentLinkId })
            .eq('id', orden.id);
    } catch (_) {}

    // 3) Registrar el intento de pago (tipo 'tienda'), ligado a la orden
    const { error: pagosErr } = await supabase.from('pagos').insert({
        user_id: proyecto.created_by || null,
        tipo: 'tienda',
        concepto,
        monto_cents: total,
        payment_link_id: paymentLinkId,
        orden_id: orden.id,
        estado: 'pendiente'
    });
    if (pagosErr) {
        console.error('Error registrando pago de tienda:', pagosErr.message);
        // Limpiar: orden + líneas (cascade) y, best-effort, el link creado en Wompi
        try {
            await supabase.from('tienda_ordenes').delete().eq('id', orden.id);
        } catch (_) {}
        await fetch(`${WOMPI_BASE}/payment_links/${paymentLinkId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${pasarela.wompi_private_key}` }
        }).catch(() => {});
        return ok({ ok: false, error: 'No se pudo registrar el pago.' }, 500);
    }

    // 4) Aviso al dueño: nuevo pedido (correo/WhatsApp según config de la tienda, best-effort)
    try {
        const { data: cfg } = await supabase
            .from('tienda_pasarela')
            .select('*')
            .eq('proyecto_id', proyecto.id)
            .maybeSingle();
        if (cfg?.notify_on_new_order) {
            const { notificarTienda } = require('./notifications');
            const detalle = lineas.map(l => `${l.nombre} x${l.cantidad}`).join(', ');
            const totalStr = '$' + (total / 100).toLocaleString('es-CO');
            await notificarTienda({
                proyectoId: proyecto.id,
                createdBy: proyecto.created_by,
                config: cfg,
                subject: `Nuevo pedido en ${proyecto.nombre}: ${totalStr}`,
                text: `Nuevo pedido #${orden.id.slice(0, 8)}\nTienda: ${proyecto.nombre}\nProductos: ${detalle}\nTotal: ${totalStr}\nCliente: ${nombre}${email ? ' · ' + email : ''}\nEstado: pendiente de pago`
            });
        }
    } catch (notifErr) {
        console.error('Error avisando nuevo pedido de tienda:', notifErr.message);
    }

    return ok({ ok: true, url: `https://checkout.wompi.co/l/${paymentLinkId}`, orden_id: orden.id });
}

// ── Consulta pública de orden + descarga digital ──
async function generarDescargas(orden) {
    if (orden.estado !== 'pagada') return [];
    const { data: items } = await supabase
        .from('tienda_orden_items')
        .select('producto_id, nombre')
        .eq('orden_id', orden.id);
    if (!items?.length) return [];
    const { data: productos } = await supabase
        .from('tienda_productos')
        .select('id, nombre, tipo, archivo_url')
        .in('id', items.map(i => i.producto_id));
    const out = [];
    for (const p of productos || []) {
        if (p.tipo !== 'digital') continue;
        if (!p.archivo_url) continue;
        const { data, error } = await supabase.storage.from(BUCKET_DIGITAL).createSignedUrl(p.archivo_url, 600);
        if (!error && data?.signedUrl) out.push({ nombre: p.nombre, url: data.signedUrl });
    }
    return out;
}

async function accionGetOrden(params) {
    const ordenId = String(params.orden_id || '');
    const email = String(params.email || '').trim();
    if (!ordenId) return ok({ ok: false, error: 'Falta orden_id' }, 400);
    const { data: orden, error } = await supabase.from('tienda_ordenes').select('*').eq('id', ordenId).maybeSingle();
    if (error || !orden) return ok({ ok: false, error: 'Orden no encontrada' }, 404);
    if (email && orden.cliente_email && String(orden.cliente_email).toLowerCase() !== email.toLowerCase()) {
        return ok({ ok: false, error: 'Email no coincide con la orden' }, 403);
    }
    const { data: items } = await supabase.from('tienda_orden_items').select('*').eq('orden_id', orden.id);
    const digitales = await generarDescargas(orden);
    return ok({
        ok: true,
        orden: {
            id: orden.id,
            estado: orden.estado,
            total_cents: orden.total_cents,
            transaction_id: orden.transaction_id,
            cliente_nombre: orden.cliente_nombre,
            created_at: orden.created_at,
            items: items || [],
            digitales
        }
    });
}

// ── Acciones de admin ──
async function accionGuardarProducto(adminId, body) {
    const { proyecto_id, id, nombre, descripcion, precio_cents, tipo, activo, stock, imagen, archivo_data_url, filename } = body;
    if (!proyecto_id) return ok({ ok: false, error: 'Falta proyecto_id' }, 400);
    if (!nombre || !String(nombre).trim()) return ok({ ok: false, error: 'Falta el nombre del producto' }, 400);
    const precio = Math.max(0, Math.round(Number(precio_cents) || 0));
    if (precio <= 0) return ok({ ok: false, error: 'El precio debe ser mayor a 0' }, 400);
    const tipoOk = ['fisico', 'digital', 'servicio'].includes(tipo);
    if (!tipoOk) return ok({ ok: false, error: 'Tipo de producto inválido' }, 400);

    const { data: proyecto } = await supabase.from('web_projects').select('id, created_by').eq('id', proyecto_id).maybeSingle();
    if (!proyecto) return ok({ ok: false, error: 'Sitio no encontrado' }, 404);
    if (proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);

    let imagenFinal = String(imagen || '').trim();
    if (imagenFinal.startsWith('data:')) imagenFinal = await subirImagen(proyecto_id, imagenFinal, filename);
    else imagenFinal = imagenFinal.replace(/["'<>]/g, '');

    let archivoFinal = null;
    if (tipo === 'digital' && String(archivo_data_url || '').startsWith('data:')) {
        archivoFinal = await subirArchivoDigital(proyecto_id, archivo_data_url, filename || 'archivo');
    }

    const datos = {
        nombre: String(nombre).trim(),
        descripcion: descripcion ? String(descripcion).trim() : null,
        precio_cents: precio,
        tipo,
        activo: activo === false ? false : true,
        stock: tipo === 'fisico' ? (stock === null || stock === undefined || stock === '' ? null : Math.max(0, Math.floor(Number(stock)))) : null,
        imagen: imagenFinal || null,
        updated_at: new Date().toISOString()
    };
    if (archivoFinal) datos.archivo_url = archivoFinal;

    let producto;
    if (id) {
        const { data, error } = await supabase.from('tienda_productos').update(datos).eq('id', id).eq('proyecto_id', proyecto_id).select().single();
        if (error) return ok({ ok: false, error: error.message }, 500);
        producto = data;
    } else {
        const { data, error } = await supabase.from('tienda_productos').insert({ ...datos, proyecto_id }).select().single();
        if (error) return ok({ ok: false, error: error.message }, 500);
        producto = data;
    }
    return ok({ ok: true, producto });
}

async function accionEliminarProducto(adminId, body) {
    const { id } = body;
    if (!id) return ok({ ok: false, error: 'Falta id' }, 400);
    const { data: producto } = await supabase.from('tienda_productos').select('proyecto_id').eq('id', id).maybeSingle();
    if (!producto) return ok({ ok: false, error: 'Producto no encontrado' }, 404);
    const { data: proyecto } = await supabase.from('web_projects').select('created_by').eq('id', producto.proyecto_id).maybeSingle();
    if (!proyecto || proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);
    const { error } = await supabase.from('tienda_productos').delete().eq('id', id);
    if (error) return ok({ ok: false, error: error.message }, 500);
    return ok({ ok: true });
}

async function accionListarProductos(adminId, params) {
    const { proyecto_id } = params;
    if (!proyecto_id) return ok({ ok: false, error: 'Falta proyecto_id' }, 400);
    const { data: proyecto } = await supabase.from('web_projects').select('created_by').eq('id', proyecto_id).maybeSingle();
    if (!proyecto) return ok({ ok: false, error: 'Sitio no encontrado' }, 404);
    if (proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);
    const { data: productos, error } = await supabase
        .from('tienda_productos')
        .select('*')
        .eq('proyecto_id', proyecto_id)
        .order('created_at', { ascending: true });
    if (error) return ok({ ok: false, error: error.message }, 500);
    return ok({ ok: true, productos: productos || [] });
}

async function accionListarOrdenes(adminId, params) {
    const { proyecto_id } = params;
    if (!proyecto_id) return ok({ ok: false, error: 'Falta proyecto_id' }, 400);
    const { data: proyecto } = await supabase.from('web_projects').select('created_by').eq('id', proyecto_id).maybeSingle();
    if (!proyecto) return ok({ ok: false, error: 'Sitio no encontrado' }, 404);
    if (proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);
    const { data: ordenes, error } = await supabase
        .from('tienda_ordenes')
        .select('*')
        .eq('proyecto_id', proyecto_id)
        .order('created_at', { ascending: false });
    if (error) return ok({ ok: false, error: error.message }, 500);
    const lista = ordenes || [];
    const ids = lista.map(o => o.id);
    const { data: items } = ids.length
        ? await supabase.from('tienda_orden_items').select('orden_id, nombre, cantidad').in('orden_id', ids)
        : { data: [] };
    const porOrden = {};
    for (const it of items || []) {
        (porOrden[it.orden_id] = porOrden[it.orden_id] || []).push(it);
    }
    return ok({ ok: true, ordenes: lista.map(o => ({ ...o, items: porOrden[o.id] || [] })) });
}

async function accionCambiarEstadoOrden(adminId, body) {
    const { id, estado } = body;
    if (!id) return ok({ ok: false, error: 'Falta id' }, 400);
    if (!['pendiente', 'pagada', 'cancelada'].includes(estado)) return ok({ ok: false, error: 'Estado inválido' }, 400);
    const { data: orden } = await supabase.from('tienda_ordenes').select('proyecto_id').eq('id', id).maybeSingle();
    if (!orden) return ok({ ok: false, error: 'Orden no encontrada' }, 404);
    const { data: proyecto } = await supabase.from('web_projects').select('created_by').eq('id', orden.proyecto_id).maybeSingle();
    if (!proyecto || proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);
    const { error } = await supabase.from('tienda_ordenes').update({ estado, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return ok({ ok: false, error: error.message }, 500);
    return ok({ ok: true });
}

// ── Pasarela Wompi del cliente (por proyecto) ──
async function accionEstadoPasarela(adminId, params) {
    const { proyecto_id } = params;
    if (!proyecto_id) return ok({ ok: false, error: 'Falta proyecto_id' }, 400);
    const { data: proyecto } = await supabase.from('web_projects').select('created_by').eq('id', proyecto_id).maybeSingle();
    if (!proyecto) return ok({ ok: false, error: 'Sitio no encontrado' }, 404);
    if (proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);

    const { data: pasarela } = await supabase
        .from('tienda_pasarela')
        .select('wompi_private_key, wompi_events_secret, wompi_sandbox')
        .eq('proyecto_id', proyecto_id)
        .maybeSingle();

    // Nunca devolver las llaves; solo estado enmascarado (mismo patrón que el CRM).
    return ok({
        ok: true,
        configurada: !!pasarela?.wompi_private_key,
        sandbox: !!pasarela?.wompi_sandbox,
        privada_guardada: !!pasarela?.wompi_private_key,
        secret_guardado: !!pasarela?.wompi_events_secret
    });
}

async function accionConfigurarPasarela(adminId, body) {
    const { proyecto_id, wompi_private_key, wompi_events_secret, wompi_sandbox } = body;
    if (!proyecto_id) return ok({ ok: false, error: 'Falta proyecto_id' }, 400);
    const { data: proyecto } = await supabase.from('web_projects').select('created_by').eq('id', proyecto_id).maybeSingle();
    if (!proyecto) return ok({ ok: false, error: 'Sitio no encontrado' }, 404);
    if (proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);

    const { data: existente } = await supabase
        .from('tienda_pasarela')
        .select('*')
        .eq('proyecto_id', proyecto_id)
        .maybeSingle();

    const actualizado = {
        wompi_sandbox: typeof wompi_sandbox === 'boolean' ? wompi_sandbox : (existente?.wompi_sandbox ?? false)
    };
    // Solo se reemplazan si vienen con contenido (dejar en blanco = no cambiar).
    if (wompi_private_key && String(wompi_private_key).trim().length > 5) {
        actualizado.wompi_private_key = String(wompi_private_key).trim();
    }
    if (wompi_events_secret && String(wompi_events_secret).trim().length > 5) {
        actualizado.wompi_events_secret = String(wompi_events_secret).trim();
    }
    actualizado.updated_at = new Date().toISOString();

    let error;
    if (existente) {
        ({ error } = await supabase.from('tienda_pasarela').update(actualizado).eq('proyecto_id', proyecto_id));
    } else {
        ({ error } = await supabase.from('tienda_pasarela').insert({ proyecto_id, ...actualizado }));
    }
    if (error) return ok({ ok: false, error: 'No se pudo guardar la pasarela: ' + error.message }, 500);

    return ok({ ok: true });
}

// ── Notificaciones de la tienda (Gmail del cliente + avisos) ──
async function accionEstadoNotificaciones(adminId, params) {
    const { proyecto_id } = params;
    if (!proyecto_id) return ok({ ok: false, error: 'Falta proyecto_id' }, 400);
    const { data: proyecto } = await supabase.from('web_projects').select('created_by').eq('id', proyecto_id).maybeSingle();
    if (!proyecto) return ok({ ok: false, error: 'Sitio no encontrado' }, 404);
    if (proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);

    const { data: cfg } = await supabase
        .from('tienda_pasarela')
        .select('composio_gmail_entity_id, gmail_conectado_email, notify_on_new_order, notify_on_payment, notify_emails, notify_whatsapp_agente_id, notify_whatsapp_numero')
        .eq('proyecto_id', proyecto_id)
        .maybeSingle();

    const { data: agentes } = await supabase
        .from('agentes_ia')
        .select('id, nombre_agente')
        .eq('user_id', adminId)
        .order('id', { ascending: true });

    return ok({
        ok: true,
        gmail_conectado: !!cfg?.composio_gmail_entity_id,
        gmail_email: cfg?.gmail_conectado_email || null,
        notify_on_new_order: cfg ? cfg.notify_on_new_order !== false : true,
        notify_on_payment: cfg ? cfg.notify_on_payment !== false : true,
        notify_emails: cfg?.notify_emails || [],
        whatsapp_agente_id: cfg?.notify_whatsapp_agente_id || null,
        whatsapp_numero: cfg?.notify_whatsapp_numero || '',
        agentes: agentes || []
    });
}

async function accionConfigurarNotificaciones(adminId, body) {
    const { proyecto_id, notify_on_new_order, notify_on_payment, notify_emails, notify_whatsapp_agente_id, notify_whatsapp_numero } = body;
    if (!proyecto_id) return ok({ ok: false, error: 'Falta proyecto_id' }, 400);
    const { data: proyecto } = await supabase.from('web_projects').select('created_by').eq('id', proyecto_id).maybeSingle();
    if (!proyecto) return ok({ ok: false, error: 'Sitio no encontrado' }, 404);
    if (proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);

    const emails = (Array.isArray(notify_emails) ? notify_emails : String(notify_emails || '').split(','))
        .map(v => String(v).trim())
        .filter(v => v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
    const uniqueEmails = [...new Set(emails)];

    const { data: existente } = await supabase
        .from('tienda_pasarela')
        .select('proyecto_id')
        .eq('proyecto_id', proyecto_id)
        .maybeSingle();

    const datos = {
        notify_on_new_order: notify_on_new_order !== false,
        notify_on_payment: notify_on_payment !== false,
        notify_emails: uniqueEmails.length ? uniqueEmails : null,
        notify_whatsapp_agente_id: notify_whatsapp_agente_id ? Number(notify_whatsapp_agente_id) : null,
        notify_whatsapp_numero: String(notify_whatsapp_numero || '').replace(/\D/g, '') || null,
        updated_at: new Date().toISOString()
    };

    let error;
    if (existente) {
        ({ error } = await supabase.from('tienda_pasarela').update(datos).eq('proyecto_id', proyecto_id));
    } else {
        ({ error } = await supabase.from('tienda_pasarela').insert({ proyecto_id, ...datos }));
    }
    if (error) return ok({ ok: false, error: 'No se pudo guardar la configuración: ' + error.message }, 500);
    return ok({ ok: true });
}

async function accionDesconectarGmail(adminId, body) {
    const { proyecto_id } = body;
    if (!proyecto_id) return ok({ ok: false, error: 'Falta proyecto_id' }, 400);
    const { data: proyecto } = await supabase.from('web_projects').select('created_by').eq('id', proyecto_id).maybeSingle();
    if (!proyecto) return ok({ ok: false, error: 'Sitio no encontrado' }, 404);
    if (proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);
    const { error } = await supabase
        .from('tienda_pasarela')
        .update({ composio_gmail_entity_id: null, gmail_conectado_email: null, updated_at: new Date().toISOString() })
        .eq('proyecto_id', proyecto_id);
    if (error) return ok({ ok: false, error: error.message }, 500);
    return ok({ ok: true });
}

// ── Handler ──
exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return ok({ ok: true });
    try {
        const method = event.httpMethod;
        const query = event.queryStringParameters || {};
        const body = (method === 'POST' || method === 'PUT' || method === 'PATCH')
            ? JSON.parse(event.body || '{}')
            : {};

        const action = (body.action || query.action || '').trim();

        // Acciones públicas
        if (action === 'catalogo') return await accionCatalogo(query);
        if (action === 'checkout') return await accionCheckout(body);
        if (action === 'get_orden') return await accionGetOrden(query);

        // Acciones de admin
        const adminId = await autenticarAdmin(event);
        const params = { ...query, ...body };
        if (action === 'guardar_producto') return await accionGuardarProducto(adminId, body);
        if (action === 'eliminar_producto') return await accionEliminarProducto(adminId, body);
        if (action === 'listar_productos') return await accionListarProductos(adminId, params);
        if (action === 'listar_ordenes') return await accionListarOrdenes(adminId, params);
        if (action === 'cambiar_estado_orden') return await accionCambiarEstadoOrden(adminId, body);
        if (action === 'configurar_pasarela') return await accionConfigurarPasarela(adminId, body);
        if (action === 'estado_pasarela') return await accionEstadoPasarela(adminId, params);
        if (action === 'estado_notificaciones') return await accionEstadoNotificaciones(adminId, params);
        if (action === 'configurar_notificaciones') return await accionConfigurarNotificaciones(adminId, body);
        if (action === 'desconectar_gmail') return await accionDesconectarGmail(adminId, body);

        return ok({ ok: false, error: 'Acción no válida' }, 400);
    } catch (err) {
        if (err.message === 'Token no enviado' || err.message === 'No autenticado') return ok({ ok: false, error: err.message }, 401);
        if (err.message === 'No eres admin') return ok({ ok: false, error: err.message }, 403);
        console.error('tienda.js error:', err);
        return ok({ ok: false, error: err.message || 'Error interno' }, 500);
    }
};

module.exports.handler = exports.handler;
