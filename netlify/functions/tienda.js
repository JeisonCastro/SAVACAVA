// tienda.js — E-commerce de Web Factory (plantilla "tienda") — multi-tenant
//
// Modelo WooCommerce simplificado, particionado por `proyecto_id` (cada tienda es
// independiente y WebFactory reutiliza esta misma lógica para crear otras tiendas).
//
// Tipos de producto:
//   simple   -> físico con stock (legacy 'fisico' se normaliza a 'simple')
//   variable -> producto con variaciones (combinaciones de atributos, estilo WooCommerce)
//   digital  -> descarga/archivo/licencia/código (preparado: `archivos` jsonb)
//   servicio -> cotización/agendamiento por WhatsApp
//
// Datos por tienda (tenant): web_projects (branding), tienda_categorias,
// tienda_atributos (reutilizables), tienda_productos, tienda_variaciones,
// tienda_ordenes (+ items), tienda_clientes, tienda_pasarela (pagos + notificaciones).
//
// Acciones públicas (CORS abierto):
//   catalogo (GET) -> categorías + productos (+ atributos/variaciones para variables)
//   checkout (POST)-> valida items/variación, recalcula total en servidor, crea orden+
//                     líneas+cliente, link de pago Wompi (pasarela DEL CLIENTE) y `pagos`
//   get_orden(GET) -> estado de la orden (+ descargas digitales si está pagada)
//
// Acciones de admin (Bearer + perfiles.is_admin + dueño del proyecto):
//   guardar_producto, eliminar_producto, listar_productos, guardar_variaciones,
//   listar_categorias, guardar_categoria, eliminar_categoria,
//   listar_atributos, guardar_atributo, eliminar_atributo,
//   listar_ordenes, cambiar_estado_orden, listar_clientes,
//   configurar_pasarela, estado_pasarela, estado_notificaciones,
//   configurar_notificaciones, desconectar_gmail.

const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

const SITE_URL = process.env.URL || 'https://auvro.netlify.app';

const BUCKET_IMG = 'productos';
const BUCKET_DIGITAL = 'tienda-digital';
const TAMANO_MAX = 8 * 1024 * 1024;

const TIPOS_VALIDOS = ['simple', 'variable', 'digital', 'servicio'];

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

// ── Modelo ──
function normalizarTipo(t) {
    if (t === 'fisico') return 'simple';
    return TIPOS_VALIDOS.includes(t) ? t : 'simple';
}

function claveVariacion(combinacion) {
    return (Array.isArray(combinacion) ? combinacion : [])
        .map(c => String(c.atributo_id) + ':' + String(c.valor))
        .sort()
        .join('|');
}

function nombreVariacion(combinacion) {
    return (Array.isArray(combinacion) ? combinacion : []).map(c => c.valor).join(' / ');
}

// Producto cartesiano de los valores seleccionados por atributo.
function generarVariaciones(atributosSelector) {
    const listas = (atributosSelector || []).filter(a =>
        a && a.atributo_id && Array.isArray(a.valores) && a.valores.length
    );
    if (!listas.length) return [];
    let combos = [[]];
    for (const attr of listas) {
        const next = [];
        for (const c of combos) {
            for (const valor of attr.valores) {
                next.push([...c, { atributo_id: attr.atributo_id, valor: String(valor) }]);
            }
        }
        combos = next;
    }
    return combos.map(c => ({
        clave: claveVariacion(c),
        combinacion: c,
        nombre: nombreVariacion(c)
    }));
}

// Precio efectivo de una variación (promo > precio > base del producto).
function precioVariacion(v, baseCents) {
    if (v == null) return baseCents;
    if (v.precio_promo_cents != null && Number(v.precio_promo_cents) > 0) return Number(v.precio_promo_cents);
    if (v.precio_cents != null && Number(v.precio_cents) > 0) return Number(v.precio_cents);
    return baseCents;
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

    const { data: categorias } = await supabase
        .from('tienda_categorias')
        .select('id, nombre')
        .eq('proyecto_id', proyecto.id)
        .order('orden', { ascending: true });

    const { data: productos, error } = await supabase
        .from('tienda_productos')
        .select('id, nombre, descripcion, precio_cents, tipo, imagen, imagenes, stock, activo, categoria, categoria_id, atributos, atributos_selector, variantes, sku')
        .eq('proyecto_id', proyecto.id)
        .eq('activo', true)
        .order('created_at', { ascending: true });
    if (error) return ok({ ok: false, error: error.message }, 500);

    const catMap = {};
    for (const c of categorias || []) catMap[c.id] = c.nombre;

    // Variaciones de los productos variables
    const varProductos = (productos || []).filter(p => normalizarTipo(p.tipo) === 'variable');
    const varById = {};
    if (varProductos.length) {
        const { data: variaciones } = await supabase
            .from('tienda_variaciones')
            .select('*')
            .in('producto_id', varProductos.map(p => p.id));
        for (const v of variaciones || []) {
            (varById[v.producto_id] = varById[v.producto_id] || []).push(v);
        }
    }

    const visibles = (productos || []).map(p => {
        const tipo = normalizarTipo(p.tipo);
        const catNombre = (p.categoria_id && catMap[p.categoria_id]) || p.categoria || '';
        const variaciones = (varById[p.id] || []).filter(v => v.activo !== false);
        const variacionesPub = variaciones.map(v => ({
            id: v.id,
            clave: v.clave,
            nombre: v.nombre,
            sku: v.sku || null,
            precio_cents: v.precio_cents != null ? v.precio_cents : null,
            precio_promo_cents: v.precio_promo_cents != null ? v.precio_promo_cents : null,
            stock: v.stock,
            imagen: v.imagen || null,
            agotado: v.stock !== null && v.stock <= 0
        }));
        let agotado = false;
        if (tipo === 'variable') {
            agotado = variacionesPub.length === 0 || variacionesPub.every(v => v.agotado);
        } else if (tipo === 'simple') {
            agotado = p.stock !== null && p.stock <= 0;
        }
        const precios = tipo === 'variable'
            ? variacionesPub.map(v => precioVariacion(v, p.precio_cents)).filter(n => n != null)
            : [p.precio_cents];
        const precio_desde = precios.length ? Math.min(...precios) : p.precio_cents;
        return {
            ...p,
            tipo,
            categoria: catNombre,
            categoria_id: p.categoria_id || null,
            precio_desde,
            atributos_selector: tipo === 'variable' ? (p.atributos_selector || []) : null,
            variaciones: tipo === 'variable' ? variacionesPub : null,
            agotado
        };
    });

    const catsList = (categorias && categorias.length)
        ? categorias.map(c => c.nombre)
        : [...new Set((productos || []).map(p => (p.categoria || '').trim()).filter(Boolean))];

    return ok({ ok: true, productos: visibles, categorias: catsList });
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

    // Variaciones (para productos variables)
    const varIds = items.map(i => i.variacion_id).filter(Boolean);
    const varPorId = {};
    if (varIds.length) {
        const { data: variaciones } = await supabase
            .from('tienda_variaciones')
            .select('*')
            .in('id', varIds);
        for (const v of variaciones || []) varPorId[v.id] = v;
    }

    let total = 0;
    const lineas = [];
    let hayFisico = false;
    for (const it of items) {
        const prod = porId[it.producto_id];
        if (!prod || !prod.activo) return ok({ ok: false, error: 'Un producto del carrito ya no está disponible' }, 400);
        const tipo = normalizarTipo(prod.tipo);
        const cant = Math.min(Math.max(1, Math.floor(Number(it.cantidad) || 1)), 99);

        let precioUnit = prod.precio_cents;
        let nombreLinea = prod.nombre;
        let variacionNombre = null;
        let skuLinea = null;
        let variacion = null;

        if (tipo === 'variable') {
            const variacionId = String(it.variacion_id || '');
            if (!variacionId) return ok({ ok: false, error: `Elige las opciones de: ${prod.nombre}` }, 400);
            variacion = varPorId[variacionId];
            if (!variacion || variacion.producto_id !== prod.id) return ok({ ok: false, error: `Variación no válida para: ${prod.nombre}` }, 400);
            if (variacion.activo === false) return ok({ ok: false, error: `Opción no disponible para: ${prod.nombre}` }, 400);
            if (variacion.stock !== null && variacion.stock < cant) {
                return ok({ ok: false, error: `Stock insuficiente para: ${prod.nombre} / ${variacion.nombre}` }, 400);
            }
            precioUnit = precioVariacion(variacion, prod.precio_cents);
            nombreLinea = variacion.nombre ? `${prod.nombre} / ${variacion.nombre}` : prod.nombre;
            variacionNombre = variacion.nombre || null;
            skuLinea = variacion.sku || null;
            hayFisico = true;
        } else {
            if (tipo === 'simple' && prod.stock !== null && prod.stock < cant) {
                return ok({ ok: false, error: `Stock insuficiente para: ${prod.nombre}` }, 400);
            }
            if (tipo === 'simple') hayFisico = true;
        }

        total += precioUnit * cant;
        lineas.push({
            producto_id: prod.id,
            variacion_id: variacion ? variacion.id : null,
            nombre: nombreLinea,
            precio_cents: precioUnit,
            cantidad: cant,
            variacion_nombre: variacionNombre,
            sku: skuLinea
        });
    }
    if (total <= 0) return ok({ ok: false, error: 'Total inválido' }, 400);
    if (hayFisico && !String(direccion || '').trim()) return ok({ ok: false, error: 'La dirección de envío es obligatoria' }, 400);

    // 0) Pasarela Wompi DEL CLIENTE (antes de crear la orden)
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

    // 0b) Cliente (buscar por email; insertar si no existe — el índice único es sobre lower(email))
    const emailLower = email.toLowerCase();
    const { data: clienteRow } = await supabase
        .from('tienda_clientes')
        .select('id')
        .eq('proyecto_id', proyecto.id)
        .ilike('email', emailLower)
        .maybeSingle();
    let clienteId = clienteRow?.id || null;
    if (!clienteId) {
        const { data: ins } = await supabase
            .from('tienda_clientes')
            .insert({ proyecto_id: proyecto.id, email: emailLower, nombre, telefono: telefono || null })
            .select('id')
            .maybeSingle();
        clienteId = ins?.id || null;
    }

    // 1) Orden + líneas
    const { data: orden, error: ordenErr } = await supabase
        .from('tienda_ordenes')
        .insert({
            proyecto_id: proyecto.id,
            cliente_id: clienteRow?.id || null,
            cliente_nombre: nombre,
            cliente_email: email,
            cliente_telefono: telefono,
            direccion: hayFisico ? String(direccion).trim() : null,
            total_cents: total,
            estado: 'pendiente',
            estado_pago: 'pendiente',
            metodo_pago: 'wompi'
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
        await supabase.from('tienda_ordenes').delete().eq('id', orden.id).catch(() => {});
        return ok({ ok: false, error: wompi?.error?.message || 'Error creando el pago en Wompi.' }, 502);
    }
    const paymentLinkId = wompi.data.id;

    // 2b) Guardar el link de pago en la orden
    try {
        await supabase.from('tienda_ordenes').update({ payment_link_id: paymentLinkId }).eq('id', orden.id);
    } catch (_) {}

    // 3) Registrar el intento de pago (tipo 'tienda')
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
        try { await supabase.from('tienda_ordenes').delete().eq('id', orden.id); } catch (_) {}
        await fetch(`${WOMPI_BASE}/payment_links/${paymentLinkId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${pasarela.wompi_private_key}` }
        }).catch(() => {});
        return ok({ ok: false, error: 'No se pudo registrar el pago.' }, 500);
    }

    // 4) Aviso al dueño: nuevo pedido (correo/WhatsApp según config, best-effort)
    try {
        const { data: cfg } = await supabase
            .from('tienda_pasarela')
            .select('*')
            .eq('proyecto_id', proyecto.id)
            .maybeSingle();
        if (cfg?.notify_on_new_order) {
            const { notificarTienda } = require('./notifications');
            const detalle = lineas.map(l => `• ${l.nombre}${l.variacion_nombre ? ' / ' + l.variacion_nombre : ''} x${l.cantidad} — $${((l.precio_cents * l.cantidad) / 100).toLocaleString('es-CO')}`).join('\n');
            const totalStr = '$' + (total / 100).toLocaleString('es-CO');
            await notificarTienda({
                proyectoId: proyecto.id,
                createdBy: proyecto.created_by,
                config: cfg,
                subject: `Nuevo pedido en ${proyecto.nombre}: ${totalStr}`,
                text: `Nuevo pedido #${orden.id.slice(0, 8)}\nTienda: ${proyecto.nombre}\n\n${detalle}\n\nTotal: ${totalStr}\nCliente: ${nombre}${email ? ' · ' + email : ''}\nEstado: pendiente de pago`
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
        if (normalizarTipo(p.tipo) !== 'digital') continue;
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
            numero: orden.id.slice(0, 8),
            estado: orden.estado,
            estado_pago: orden.estado_pago || orden.estado,
            metodo_pago: orden.metodo_pago || null,
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
async function validarAcceso(proyectoId, adminId) {
    if (!proyectoId) return ok({ ok: false, error: 'Falta proyecto_id' }, 400);
    const { data: proyecto } = await supabase.from('web_projects').select('id, created_by').eq('id', proyectoId).maybeSingle();
    if (!proyecto) return ok({ ok: false, error: 'Sitio no encontrado' }, 404);
    if (proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);
    return null;
}

async function accionGuardarProducto(adminId, body) {
    const { proyecto_id, id, nombre, descripcion, precio_cents, tipo, activo, stock, imagen, imagenes, archivo_data_url, filename, categoria_id, categoria, atributos, atributos_selector, sku, variantes } = body;
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    if (!nombre || !String(nombre).trim()) return ok({ ok: false, error: 'Falta el nombre del producto' }, 400);

    const tipoNorm = normalizarTipo(tipo);
    const precio = Math.max(0, Math.round(Number(precio_cents) || 0));
    if (tipoNorm !== 'variable' && precio <= 0) return ok({ ok: false, error: 'El precio debe ser mayor a 0' }, 400);

    // Categoría (si viene id, denormalizamos el nombre para el filtro de la tienda)
    let categoriaNombre = String(categoria || '').trim();
    let categoriaIdFinal = categoria_id || null;
    if (categoriaIdFinal) {
        const { data: cat } = await supabase.from('tienda_categorias').select('nombre').eq('id', categoriaIdFinal).maybeSingle();
        if (cat?.nombre) categoriaNombre = cat.nombre;
        else categoriaIdFinal = null;
    }

    // Imágenes (varias, ej. colores)
    const fuentesImagen = [];
    if (imagen) fuentesImagen.push(imagen);
    if (Array.isArray(imagenes)) fuentesImagen.push(...imagenes);
    const imagenesFinal = [];
    for (const src of fuentesImagen) {
        const s = String(src || '').trim();
        if (!s) continue;
        if (s.startsWith('data:')) {
            try { imagenesFinal.push(await subirImagen(proyecto_id, s, filename)); } catch (e) { console.error('imagen no subida:', e.message); }
        } else {
            imagenesFinal.push(s.replace(/["'<>]/g, ''));
        }
    }
    const imagenFinal = imagenesFinal[0] || null;

    let archivoFinal = null;
    if (tipoNorm === 'digital' && String(archivo_data_url || '').startsWith('data:')) {
        archivoFinal = await subirArchivoDigital(proyecto_id, archivo_data_url, filename || 'archivo');
    }

    const selector = tipoNorm === 'variable'
        ? (Array.isArray(atributos_selector) ? atributos_selector : [])
            .filter(a => a && a.atributo_id && Array.isArray(a.valores) && a.valores.length)
            .map(a => ({
                atributo_id: String(a.atributo_id),
                nombre: String(a.nombre || '').trim() || 'Atributo',
                valores: a.valores.map(v => String(v))
            }))
        : null;

    const datos = {
        nombre: String(nombre).trim(),
        descripcion: descripcion ? String(descripcion).trim() : null,
        precio_cents: precio,
        tipo: tipoNorm,
        activo: activo === false ? false : true,
        stock: tipoNorm === 'simple' ? (stock === null || stock === undefined || stock === '' ? null : Math.max(0, Math.floor(Number(stock)))) : null,
        imagen: imagenFinal,
        imagenes: imagenesFinal.length ? imagenesFinal : null,
        categoria: categoriaNombre || null,
        categoria_id: categoriaIdFinal,
        atributos: (atributos && typeof atributos === 'object' && !Array.isArray(atributos)) ? atributos : null,
        atributos_selector: selector,
        sku: sku ? String(sku).trim() : null,
        archivo_url: tipoNorm === 'digital' ? (archivoFinal || null) : null,
        variantes: Array.isArray(variantes) && variantes.length ? variantes : null,
        updated_at: new Date().toISOString()
    };

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

    // Generar/sincronizar variaciones (productos variables)
    let variaciones = [];
    if (tipoNorm === 'variable') {
        const { data: existentes } = await supabase
            .from('tienda_variaciones')
            .select('*')
            .eq('producto_id', producto.id);
        const porClave = {};
        for (const v of existentes || []) porClave[v.clave] = v;

        const generadas = generarVariaciones(selector);
        const nuevasClaves = new Set(generadas.map(g => g.clave));
        const upserts = generadas.map(g => {
            const prev = porClave[g.clave];
            return {
                producto_id: producto.id,
                clave: g.clave,
                combinacion: g.combinacion,
                nombre: g.nombre,
                sku: prev?.sku ?? null,
                precio_cents: prev?.precio_cents ?? null,
                precio_promo_cents: prev?.precio_promo_cents ?? null,
                stock: prev?.stock ?? null,
                imagen: prev?.imagen ?? null,
                activo: prev ? prev.activo : true
            };
        });
        if (upserts.length) {
            const { error: upErr } = await supabase
                .from('tienda_variaciones')
                .upsert(upserts, { onConflict: 'producto_id,clave' });
            if (upErr) console.error('error sincronizando variaciones:', upErr.message);
        }
        const claves = [...nuevasClaves];
        if (claves.length) {
            await supabase.from('tienda_variaciones')
                .delete()
                .eq('producto_id', producto.id)
                .not('clave', 'in', claves);
        } else {
            await supabase.from('tienda_variaciones').delete().eq('producto_id', producto.id);
        }
        const { data: list } = await supabase.from('tienda_variaciones').select('*').eq('producto_id', producto.id).order('nombre', { ascending: true });
        variaciones = list || [];
    } else {
        await supabase.from('tienda_variaciones').delete().eq('producto_id', producto.id);
    }

    return ok({ ok: true, producto: { ...producto, variaciones } });
}

async function accionGuardarVariaciones(adminId, body) {
    const { producto_id, variaciones } = body;
    if (!producto_id || !Array.isArray(variaciones)) return ok({ ok: false, error: 'Falta producto_id o variaciones' }, 400);
    const { data: producto } = await supabase.from('tienda_productos').select('id, proyecto_id').eq('id', producto_id).maybeSingle();
    if (!producto) return ok({ ok: false, error: 'Producto no encontrado' }, 404);
    const { data: proyecto } = await supabase.from('web_projects').select('created_by').eq('id', producto.proyecto_id).maybeSingle();
    if (!proyecto || proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);

    for (const v of variaciones) {
        if (!v.id) continue;
        const datos = {
            sku: v.sku != null && String(v.sku).trim() ? String(v.sku).trim() : null,
            precio_cents: (v.precio_cents == null || v.precio_cents === '') ? null : Math.max(0, Math.round(Number(v.precio_cents) || 0)),
            precio_promo_cents: (v.precio_promo_cents == null || v.precio_promo_cents === '') ? null : Math.max(0, Math.round(Number(v.precio_promo_cents) || 0)),
            stock: (v.stock == null || v.stock === '') ? null : Math.max(0, Math.floor(Number(v.stock) || 0)),
            imagen: v.imagen ? String(v.imagen).trim().replace(/["'<>]/g, '') : null,
            activo: v.activo !== false
        };
        const { error } = await supabase.from('tienda_variaciones').update(datos).eq('id', v.id).eq('producto_id', producto_id);
        if (error) return ok({ ok: false, error: error.message }, 500);
    }
    return ok({ ok: true });
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
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    const { data: productos, error } = await supabase
        .from('tienda_productos')
        .select('*')
        .eq('proyecto_id', proyecto_id)
        .order('created_at', { ascending: true });
    if (error) return ok({ ok: false, error: error.message }, 500);

    const ids = (productos || []).map(p => p.id);
    const { data: variaciones } = ids.length
        ? await supabase.from('tienda_variaciones').select('producto_id, id, nombre, sku, precio_cents, precio_promo_cents, stock, activo').in('producto_id', ids)
        : { data: [] };
    const porProd = {};
    for (const v of variaciones || []) (porProd[v.producto_id] = porProd[v.producto_id] || []).push(v);

    return ok({ ok: true, productos: (productos || []).map(p => ({
        ...p,
        tipo: normalizarTipo(p.tipo),
        variaciones: porProd[p.id] || []
    })) });
}

// ── Categorías (admin) ──
async function accionListarCategorias(adminId, params) {
    const { proyecto_id } = params;
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    const { data: categorias, error } = await supabase
        .from('tienda_categorias')
        .select('*')
        .eq('proyecto_id', proyecto_id)
        .order('orden', { ascending: true });
    if (error) return ok({ ok: false, error: error.message }, 500);
    return ok({ ok: true, categorias: categorias || [] });
}

const CATEGORIAS_PRESET = [
    'Tecnología y Electrónica', 'Moda y Accesorios', 'Hogar y Decoración',
    'Electrodomésticos', 'Belleza y Cuidado Personal', 'Salud y Bienestar',
    'Deportes y Aire Libre', 'Bebés y Juguetería', 'Mascotas',
    'Papelería y Oficina', 'Otros'
];

async function accionGuardarCategoria(adminId, body) {
    const { proyecto_id, id, nombre, orden } = body;
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    const nombreLimpio = String(nombre || '').trim();
    if (!nombreLimpio) return ok({ ok: false, error: 'Falta el nombre de la categoría' }, 400);
    const datos = { nombre: nombreLimpio, orden: Number(orden) || 0 };
    let error;
    if (id) {
        ({ error } = await supabase.from('tienda_categorias').update(datos).eq('id', id).eq('proyecto_id', proyecto_id));
    } else {
        ({ error } = await supabase.from('tienda_categorias').insert({ proyecto_id, ...datos }));
    }
    if (error) return ok({ ok: false, error: error.message }, 500);
    return ok({ ok: true });
}

async function accionEliminarCategoria(adminId, body) {
    const { id } = body;
    if (!id) return ok({ ok: false, error: 'Falta id' }, 400);
    const { data: cat } = await supabase.from('tienda_categorias').select('proyecto_id').eq('id', id).maybeSingle();
    if (!cat) return ok({ ok: false, error: 'Categoría no encontrada' }, 404);
    const { data: proyecto } = await supabase.from('web_projects').select('created_by').eq('id', cat.proyecto_id).maybeSingle();
    if (!proyecto || proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);
    await supabase.from('tienda_productos').update({ categoria_id: null, categoria: null }).eq('categoria_id', id).catch(() => {});
    const { error } = await supabase.from('tienda_categorias').delete().eq('id', id);
    if (error) return ok({ ok: false, error: error.message }, 500);
    return ok({ ok: true });
}

// ── Atributos (admin, reutilizables entre productos) ──
async function accionListarAtributos(adminId, params) {
    const { proyecto_id } = params;
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    const { data: atributos, error } = await supabase
        .from('tienda_atributos')
        .select('*')
        .eq('proyecto_id', proyecto_id)
        .order('created_at', { ascending: true });
    if (error) return ok({ ok: false, error: error.message }, 500);
    return ok({ ok: true, atributos: atributos || [] });
}

async function accionGuardarAtributo(adminId, body) {
    const { proyecto_id, id, nombre, valores } = body;
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    const nombreLimpio = String(nombre || '').trim();
    if (!nombreLimpio) return ok({ ok: false, error: 'Falta el nombre del atributo' }, 400);
    const valoresLimpios = Array.isArray(valores)
        ? valores.map(v => String(v).trim()).filter(Boolean)
        : String(valores || '').split(',').map(v => v.trim()).filter(Boolean);
    const unicos = [...new Set(valoresLimpios)];
    const datos = { nombre: nombreLimpio, valores: unicos };
    let error;
    if (id) {
        ({ error } = await supabase.from('tienda_atributos').update(datos).eq('id', id).eq('proyecto_id', proyecto_id));
    } else {
        ({ error } = await supabase.from('tienda_atributos').insert({ proyecto_id, ...datos }));
    }
    if (error) return ok({ ok: false, error: error.message }, 500);
    return ok({ ok: true });
}

async function accionEliminarAtributo(adminId, body) {
    const { id } = body;
    if (!id) return ok({ ok: false, error: 'Falta id' }, 400);
    const { data: attr } = await supabase.from('tienda_atributos').select('proyecto_id').eq('id', id).maybeSingle();
    if (!attr) return ok({ ok: false, error: 'Atributo no encontrado' }, 404);
    const { data: proyecto } = await supabase.from('web_projects').select('created_by').eq('id', attr.proyecto_id).maybeSingle();
    if (!proyecto || proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);
    // Quitar el atributo de los productos que lo usan y regenerar sus variaciones
    const { data: productos } = await supabase
        .from('tienda_productos')
        .select('id, atributos_selector')
        .eq('proyecto_id', attr.proyecto_id)
        .contains('atributos_selector', [{ atributo_id: id }]);
    for (const p of productos || []) {
        const restante = (p.atributos_selector || []).filter(a => String(a.atributo_id) !== String(id));
        await supabase.from('tienda_productos').update({ atributos_selector: restante.length ? restante : null }).eq('id', p.id).catch(() => {});
        if (restante.length) {
            const { data: existentes } = await supabase.from('tienda_variaciones').select('*').eq('producto_id', p.id);
            const porClave = {};
            for (const v of existentes || []) porClave[v.clave] = v;
            const generadas = generarVariaciones(restante);
            const nuevasClaves = new Set(generadas.map(g => g.clave));
            const upserts = generadas.map(g => {
                const prev = porClave[g.clave];
                return { producto_id: p.id, clave: g.clave, combinacion: g.combinacion, nombre: g.nombre, sku: prev?.sku ?? null, precio_cents: prev?.precio_cents ?? null, precio_promo_cents: prev?.precio_promo_cents ?? null, stock: prev?.stock ?? null, imagen: prev?.imagen ?? null, activo: prev ? prev.activo : true };
            });
            if (upserts.length) {
                await supabase.from('tienda_variaciones').upsert(upserts, { onConflict: 'producto_id,clave' }).catch(() => {});
                await supabase.from('tienda_variaciones').delete().eq('producto_id', p.id).not('clave', 'in', [...nuevasClaves]).catch(() => {});
            } else {
                await supabase.from('tienda_variaciones').delete().eq('producto_id', p.id).catch(() => {});
            }
        } else {
            await supabase.from('tienda_variaciones').delete().eq('producto_id', p.id).catch(() => {});
        }
    }
    const { error } = await supabase.from('tienda_atributos').delete().eq('id', id);
    if (error) return ok({ ok: false, error: error.message }, 500);
    return ok({ ok: true });
}

// ── Órdenes y clientes (admin) ──
async function accionListarOrdenes(adminId, params) {
    const { proyecto_id } = params;
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    const { data: ordenes, error } = await supabase
        .from('tienda_ordenes')
        .select('*')
        .eq('proyecto_id', proyecto_id)
        .order('created_at', { ascending: false });
    if (error) return ok({ ok: false, error: error.message }, 500);
    const lista = ordenes || [];
    const ids = lista.map(o => o.id);
    const { data: items } = ids.length
        ? await supabase.from('tienda_orden_items').select('orden_id, nombre, variacion_nombre, cantidad, precio_cents, sku').in('orden_id', ids)
        : { data: [] };
    const porOrden = {};
    for (const it of items || []) {
        (porOrden[it.orden_id] = porOrden[it.orden_id] || []).push(it);
    }
    return ok({ ok: true, ordenes: lista.map(o => ({
        ...o,
        numero: o.id.slice(0, 8),
        items: porOrden[o.id] || []
    })) });
}

async function accionCambiarEstadoOrden(adminId, body) {
    const { id, estado } = body;
    if (!id) return ok({ ok: false, error: 'Falta id' }, 400);
    if (!['pendiente', 'pagada', 'cancelada'].includes(estado)) return ok({ ok: false, error: 'Estado inválido' }, 400);
    const { data: orden } = await supabase.from('tienda_ordenes').select('proyecto_id').eq('id', id).maybeSingle();
    if (!orden) return ok({ ok: false, error: 'Orden no encontrada' }, 404);
    const { data: proyecto } = await supabase.from('web_projects').select('created_by').eq('id', orden.proyecto_id).maybeSingle();
    if (!proyecto || proyecto.created_by !== adminId) return ok({ ok: false, error: 'No tienes acceso a este sitio' }, 403);
    const estadoPago = estado === 'pagada' ? 'pagado' : (estado === 'cancelada' ? 'cancelado' : 'pendiente');
    const { error } = await supabase.from('tienda_ordenes').update({ estado, estado_pago: estadoPago, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return ok({ ok: false, error: error.message }, 500);
    return ok({ ok: true });
}

async function accionListarClientes(adminId, params) {
    const { proyecto_id } = params;
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    const { data: clientes, error } = await supabase
        .from('tienda_clientes')
        .select('*')
        .eq('proyecto_id', proyecto_id)
        .order('updated_at', { ascending: false });
    if (error) return ok({ ok: false, error: error.message }, 500);
    return ok({ ok: true, clientes: clientes || [] });
}

// ── Pasarela Wompi del cliente (por proyecto) ──
async function accionEstadoPasarela(adminId, params) {
    const { proyecto_id } = params;
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    const { data: pasarela } = await supabase
        .from('tienda_pasarela')
        .select('wompi_private_key, wompi_events_secret, wompi_sandbox')
        .eq('proyecto_id', proyecto_id)
        .maybeSingle();
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
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    const { data: existente } = await supabase.from('tienda_pasarela').select('*').eq('proyecto_id', proyecto_id).maybeSingle();
    const actualizado = {
        wompi_sandbox: typeof wompi_sandbox === 'boolean' ? wompi_sandbox : (existente?.wompi_sandbox ?? false)
    };
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

// ── Notificaciones de la tienda ──
async function accionInfoTienda(adminId, params) {
    const { proyecto_id } = params;
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    const { data: proyecto } = await supabase
        .from('web_projects')
        .select('id, slug, nombre, descripcion, slogan, logo, accent_color, fuente, netlify_url')
        .eq('id', proyecto_id)
        .maybeSingle();
    if (!proyecto) return ok({ ok: false, error: 'Sitio no encontrado' }, 404);
    return ok({ ok: true, tienda: proyecto });
}

async function accionEstadoNotificaciones(adminId, params) {
    const { proyecto_id } = params;
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    const { data: cfg } = await supabase
        .from('tienda_pasarela')
        .select('composio_gmail_entity_id, gmail_conectado_email, notify_on_new_order, notify_on_payment, notify_emails, notify_whatsapp_agente_id, notify_whatsapp_numero')
        .eq('proyecto_id', proyecto_id)
        .maybeSingle();
    const { data: agentes } = await supabase.from('agentes_ia').select('id, nombre_agente').eq('user_id', adminId).order('id', { ascending: true });
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
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    const emails = (Array.isArray(notify_emails) ? notify_emails : String(notify_emails || '').split(','))
        .map(v => String(v).trim())
        .filter(v => v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
    const uniqueEmails = [...new Set(emails)];
    const { data: existente } = await supabase.from('tienda_pasarela').select('proyecto_id').eq('proyecto_id', proyecto_id).maybeSingle();
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
    const acceso = await validarAcceso(proyecto_id, adminId);
    if (acceso) return acceso;
    const { error } = await supabase.from('tienda_pasarela')
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
        if (action === 'guardar_variaciones') return await accionGuardarVariaciones(adminId, body);
        if (action === 'eliminar_producto') return await accionEliminarProducto(adminId, body);
        if (action === 'listar_productos') return await accionListarProductos(adminId, params);
        if (action === 'listar_categorias') return await accionListarCategorias(adminId, params);
        if (action === 'guardar_categoria') return await accionGuardarCategoria(adminId, body);
        if (action === 'eliminar_categoria') return await accionEliminarCategoria(adminId, body);
        if (action === 'listar_atributos') return await accionListarAtributos(adminId, params);
        if (action === 'guardar_atributo') return await accionGuardarAtributo(adminId, body);
        if (action === 'eliminar_atributo') return await accionEliminarAtributo(adminId, body);
        if (action === 'listar_ordenes') return await accionListarOrdenes(adminId, params);
        if (action === 'cambiar_estado_orden') return await accionCambiarEstadoOrden(adminId, body);
        if (action === 'listar_clientes') return await accionListarClientes(adminId, params);
        if (action === 'info') return await accionInfoTienda(adminId, params);
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
