// motor-tur.js — Motor base del módulo de Productos Turísticos (FASE 1)
// Responsabilidades (Fase 1): parser del JSON legado, acceso a las tablas tur_*
// con fallback al legado y migración lazy de un producto tour existente.
// El cálculo de precios se incorpora en fases siguientes sobre estas lecturas.
// IMPORTANTE: las funciones puras viven arriba sin requerir Supabase para poder
// probarlas en aislamiento; el cliente DB se requiere de forma perezosa.
'use strict';

// ── Utilidades puras ─────────────────────────────────────────────────────────
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function int(v) {
    return Math.round(num(v));
}

function bool(v) {
    return v === true || v === 1 || String(v).toLowerCase() === 'true';
}

function list(v) {
    return Array.isArray(v) ? v : [];
}

// Normaliza categorías legadas ({nombre, edad_min, edad_max, precio_cents, permitido})
function normCategorias(arr) {
    return list(arr)
        .map((c, i) => c && typeof c === 'object' ? {
            id: c.id || c._id || (c.nombre ? 'cat-' + String(c.nombre).toLowerCase().replace(/[^a-z0-9]+/g, '') : 'cat-' + i),
            nombre: String(c.nombre || 'Tarifa ' + (i + 1)).slice(0, 60),
            edad_min: c.edad_min != null && c.edad_min !== '' ? int(c.edad_min) : null,
            edad_max: c.edad_max != null && c.edad_max !== '' ? int(c.edad_max) : null,
            precio_cents: int(c.precio_cents),
            permitido: c.permitido !== false
        } : null)
        .filter(Boolean);
}

// Normaliza escalas legadas ({desde, hasta, descuento_pct})
function normEscalas(arr) {
    return list(arr)
        .map(e => e && typeof e === 'object' ? {
            desde: int(e.desde),
            hasta: e.hasta != null && e.hasta !== '' ? int(e.hasta) : null,
            tipo: (e.tipo === 'fijo' ? 'fijo' : 'pct'),
            aplica_a: e.aplica_a || 'total',
            valor: e.tipo === 'fijo' ? int(e.valor != null ? e.valor : (e.descuento_fijo_cents || 0)) : num(e.descuento_pct != null ? e.descuento_pct : (e.valor || 0)),
            combina_con_promo: bool(e.combina_con_promo),
            antes_de_extras: e.antes_de_extras !== false
        } : null)
        .filter(Boolean);
}

// Normaliza extras legados ({nombre, descripcion?, precio_cents, ...})
function normExtras(arr) {
    return list(arr)
        .map((x, i) => x && typeof x === 'object' ? {
            id: x.id || 'extra-' + i,
            nombre: String(x.nombre || 'Extra ' + (i + 1)).slice(0, 80),
            descripcion: String(x.descripcion || ''),
            tipo_precio: x.tipo_precio || 'por_persona',
            precio_cents: int(x.precio_cents),
            obligatorio: bool(x.obligatorio),
            min_qty: x.min_qty != null ? int(x.min_qty) : 1,
            max_qty: x.max_qty != null ? int(x.max_qty) : null,
            activo: x.activo !== false
        } : null)
        .filter(Boolean);
}

// Parsea el JSON legado guardado en tienda_productos.atributos (tipo tour).
// Devuelve null si el objeto no contiene claves turísticas.
function parseTourLegacy(atributos) {
    if (!atributos || typeof atributos !== 'object') return null;
    const tieneClavesTur =
        list(atributos.categorias_pasajero).length > 0 ||
        list(atributos.escalas_cantidad).length > 0 ||
        list(atributos.extras).length > 0 ||
        atributos.min_participantes != null ||
        atributos.max_participantes != null ||
        atributos.requiere_adulto != null;
    if (!tieneClavesTur) return null;
    return {
        categorias_pasajero: normCategorias(atributos.categorias_pasajero),
        escalas_cantidad: normEscalas(atributos.escalas_cantidad),
        extras: normExtras(atributos.extras),
        min_participantes: Math.max(1, int(atributos.min_participantes) || 1),
        max_participantes: atributos.max_participantes ? Math.max(1, int(atributos.max_participantes)) : null,
        requiere_adulto: bool(atributos.requiere_adulto)
    };
}

function esProductoTour(p) {
    return !!(p && (String(p.tipo || '').trim() === 'tour'));
}

// ── MOTOR DE PRECIOS (puro, testable) ────────────────────────────────────────
// Entrada: config { tarifas, escalas, extras, requiere_adulto, min_pax, max_pax }
//          y selección { pasajeros:[{id,nombre?,cantidad}], extras:[{id,cantidad}] }.
// Sigue el orden canónico del LOOP 4 (descuento de grupo antes de extras).
function esCategoriaAdulto(nombre) {
    return /adulto|senior|mayor/i.test(String(nombre || ''));
}

function calcularPrecioTour(config, seleccion) {
    const errores = [];
    const desglose = [];
    const reglas = (config && config.reglas) || {};
    const tarifas = normCategorias(config && config.tarifas);
    const escalas = normEscalas(config && config.escalas);
    const extrasCfg = normExtras(config && config.extras);
    const pasajeros = Array.isArray(seleccion && seleccion.pasajeros) ? seleccion.pasajeros : [];
    const extrasSel = Array.isArray(seleccion && seleccion.extras) ? seleccion.extras : [];

    if (!tarifas.length) {
        errores.push('El producto no tiene tarifas de pasajero configuradas.');
        return { ok: false, errores, total_cents: 0, total_pasajeros: 0, subtotal_base_cents: 0, desglose };
    }

    let total = 0;
    let totalPasajeros = 0;
    let adultos = 0;
    let menores = 0;
    const adultNameMap = {};

    for (const pj of pasajeros) {
        const qty = Math.floor(Number(pj.cantidad)) || 0;
        if (qty <= 0) continue;
        let cat = tarifas.find(c => String(c.id) === String(pj.id || pj.categoriaId));
        if (!cat) cat = tarifas.find(c => String(c.nombre || '').toLowerCase() === String(pj.nombre || pj.categoriaId || '').toLowerCase());
        if (!cat) {
            errores.push('La tarifa de pasajero "' + (pj.nombre || pj.id || pj.categoriaId || '?') + '" no existe en este producto.');
            continue;
        }
        if (cat.permitido === false) {
            errores.push('La categoría "' + cat.nombre + '" no está permitida en este producto.');
            continue;
        }
        totalPasajeros += qty;
        if (esCategoriaAdulto(cat.nombre)) { adultos += qty; adultNameMap[cat.id] = true; }
        else menores += qty;
        const sub = cat.precio_cents * qty;
        total += sub;
        desglose.push({ tipo: 'pasajero', nombre: cat.nombre, cantidad: qty, precio_unit_cents: cat.precio_cents, subtotal_cents: sub });
    }

    if (!totalPasajeros) {
        errores.push('Indica al menos un pasajero.');
        return { ok: false, errores, total_cents: 0, total_pasajeros: 0, subtotal_base_cents: 0, desglose };
    }
    if (reglas.requiere_adulto && adultos === 0) errores.push('Este producto requiere al menos 1 adulto en el grupo.');
    if (Number(reglas.min_pax) > 1 && totalPasajeros < Number(reglas.min_pax)) {
        errores.push('Mínimo ' + reglas.min_pax + ' participantes (el grupo tiene ' + totalPasajeros + ').');
    }
    if (reglas.max_pax && totalPasajeros > Number(reglas.max_pax)) {
        errores.push('Máximo ' + reglas.max_pax + ' participantes (el grupo tiene ' + totalPasajeros + ').');
    }

    // Descuento por grupo (mejor tramo; antes de extras)
    let descuento = 0;
    if (escalas.length && totalPasajeros > 0) {
        const escala = escalas
            .filter(e => totalPasajeros >= (Number(e.desde) || 0) && (!e.hasta || totalPasajeros <= Number(e.hasta)))
            .sort((a, b) => {
                const va = a.tipo === 'fijo' ? a.valor : (Number(a.valor) / 100) * total;
                const vb = b.tipo === 'fijo' ? b.valor : (Number(b.valor) / 100) * total;
                return vb - va;
            })[0];
        if (escala && Number(escala.valor) > 0) {
            let baseDesc = total;
            if (escala.aplica_a === 'adultos') {
                baseDesc = 0;
                for (const d of desglose) {
                    if (d.tipo === 'pasajero' && esCategoriaAdulto(d.nombre)) baseDesc += d.subtotal_cents;
                }
            }
            descuento = escala.tipo === 'fijo'
                ? Math.min(baseDesc, Math.round(Number(escala.valor)))
                : Math.round(baseDesc * (Number(escala.valor) / 100));
            if (descuento > 0) {
                total -= descuento;
                desglose.push({
                    tipo: 'descuento',
                    nombre: 'Descuento por grupo (' + (escala.tipo === 'pct' ? '-' + escala.valor + '%' : '-$' + Math.round(Number(escala.valor) / 100)) + ' · ' + escala.desde + (escala.hasta ? '-' + escala.hasta : '+') + ' pasajeros)',
                    cantidad: 1,
                    precio_unit_cents: -descuento,
                    subtotal_cents: -descuento
                });
            }
        }
    }

    // Extras (después del descuento)
    for (const ex of extrasSel) {
        const qty = Math.max(1, Math.floor(Number(ex.cantidad)) || 1);
        const extra = extrasCfg.find(e => String(e.id) === String(ex.id));
        if (!extra) {
            errores.push('El extra "' + (ex.id || ex.nombre || '?') + '" no existe en este producto.');
            continue;
        }
        let multiplicador = qty;
        if (extra.tipo_precio === 'por_persona') multiplicador = qty * totalPasajeros;
        else if (extra.tipo_precio === 'por_adulto') multiplicador = qty * adultos;
        else if (extra.tipo_precio === 'por_nino') multiplicador = qty * menores;
        const sub = extra.precio_cents * multiplicador;
        total += sub;
        desglose.push({
            tipo: 'extra',
            nombre: extra.nombre,
            cantidad: multiplicador,
            precio_unit_cents: extra.precio_cents,
            subtotal_cents: sub
        });
    }

    const totalCents = Math.max(0, Math.round(total));
    const subtotalBase = desglose.filter(d => d.tipo === 'pasajero').reduce((a, d) => a + d.subtotal_cents, 0);
    return {
        ok: errores.length === 0,
        errores,
        total_cents: totalCents,
        total_pesos: Math.round(totalCents / 100),
        total_pasajeros: totalPasajeros,
        adultos,
        menores,
        subtotal_base_cents: Math.round(subtotalBase),
        desglose
    };
}

// ── Motor de disponibilidad (puro): genera las fechas candidatas de un rango ──
function diasSemanaMatch(dias, fecha) {
    const mapa = { sun: 0, dom: 0, lun: 1, mon: 1, mar: 2, mie: 3, mié: 3, wed: 3, jue: 4, thu: 4, vie: 5, fri: 5, sab: 6, sat: 6 };
    const arr = Array.isArray(dias) ? dias : [];
    if (!arr.length) return true;
    const d = fecha.getDay();
    return arr.some(x => mapa[String(x).toLowerCase().substring(0, 3)] === d);
}

function listarFechasCandidatas(desdeISO, hastaISO, dias) {
    const out = [];
    const desde = new Date(desdeISO + 'T00:00:00');
    const hasta = new Date(hastaISO + 'T00:00:00');
    if (isNaN(desde.getTime()) || isNaN(hasta.getTime())) return out;
    const cur = new Date(desde);
    while (cur <= hasta) {
        if (diasSemanaMatch(dias, cur)) {
            out.push(cur.toISOString().slice(0, 10));
        }
        cur.setDate(cur.getDate() + 1);
    }
    return out;
}

// ── Acceso a datos (Supabase perezoso) ───────────────────────────────────────
async function sup() {
    return (require('./supabase-admin')).supabase;
}

const TABLAS = {
    prod: 'tur_productos',
    tarifas: 'tur_producto_tarifas',
    escalas: 'tur_producto_escalas',
    extras: 'tur_producto_extras'
};

// Lee una fila tienda_productos validando pertenencia al proyecto.
async function obtenerProducto(proyectoId, productoId) {
    const db = await sup();
    const { data, error } = await db
        .from('tienda_productos')
        .select('id, proyecto_id, nombre, descripcion, precio_cents, tipo, atributos')
        .eq('id', productoId)
        .eq('proyecto_id', proyectoId)
        .maybeSingle();
    if (error) {
        if (/does not exist/i.test(error.message || '')) {
            throw new Error('Tabla de tienda no disponible en la base de datos. Verifica las migraciones de tienda.');
        }
        throw new Error(error.message || 'Error leyendo el producto');
    }
    return data || null;
}

// Inserta la fila 1:1 tur_productos si no existe (a partir del producto tienda).
async function asegurarProductoTur(proyectoId, productoId) {
    const db = await sup();
    const producto = await obtenerProducto(proyectoId, productoId);
    if (!producto) return null;
    const { data: existente } = await db
        .from(TABLAS.prod)
        .select('producto_id, migrado')
        .eq('producto_id', productoId)
        .maybeSingle();
    if (!existente) {
        await db.from(TABLAS.prod).upsert({
            producto_id: productoId,
            proyecto_id: proyectoId
        }, { onConflict: 'producto_id' });
    }
    return producto;
}

// Migración lazy: si el producto tour tiene config legada en atributos y aún no
// se migró, la escribe en tur_* y marca migrado=true. Devuelve { migrado, tarifas, escalas, extras }.
async function migrarTourLegado(proyectoId, productoId) {
    const db = await sup();
    const producto = await obtenerProducto(proyectoId, productoId);
    if (!producto || !esProductoTour(producto)) return null;

    const { data: fila } = await db
        .from(TABLAS.prod)
        .select('*')
        .eq('producto_id', productoId)
        .maybeSingle();

    // Si ya hay tarifas o ya migrado → no repetir.
    if (fila && (fila.migrado === true)) {
        return { yaMigrado: true, tarifas: [], escalas: [], extras: [] };
    }

    const legado = parseTourLegacy(producto.atributos);

    const { data: yaTarifas } = await db
        .from(TABLAS.tarifas)
        .select('id')
        .eq('producto_id', productoId)
        .limit(1);
    const sinTarifas = !yaTarifas || yaTarifas.length === 0;

    if (legado && sinTarifas) {
        const tarifas = (legado.categorias_pasajero || []).map((c, i) => ({
            proyecto_id: proyectoId,
            producto_id: productoId,
            nombre: c.nombre,
            edad_min: c.edad_min,
            edad_max: c.edad_max,
            precio_cents: c.precio_cents,
            permitido: c.permitido,
            orden: i
        }));
        const escalas = (legado.escalas_cantidad || []).map(e => ({
            proyecto_id: proyectoId,
            producto_id: productoId,
            desde: e.desde,
            hasta: e.hasta,
            tipo: e.tipo,
            aplica_a: e.aplica_a,
            valor: e.valor,
            combina_con_promo: e.combina_con_promo,
            antes_de_extras: e.antes_de_extras
        }));
        const extras = (legado.extras || []).map(x => ({
            proyecto_id: proyectoId,
            producto_id: productoId,
            nombre: x.nombre,
            descripcion: x.descripcion,
            tipo_precio: x.tipo_precio,
            precio_cents: x.precio_cents,
            obligatorio: x.obligatorio,
            min_qty: x.min_qty,
            max_qty: x.max_qty,
            activo: x.activo
        }));
        if (tarifas.length) {
            const { error: e1 } = await db.from(TABLAS.tarifas).insert(tarifas);
            if (e1) throw new Error('Error migrando tarifas: ' + e1.message);
        }
        if (escalas.length) {
            const { error: e2 } = await db.from(TABLAS.escalas).insert(escalas);
            if (e2) throw new Error('Error migrando escalas: ' + e2.message);
        }
        if (extras.length) {
            const { error: e3 } = await db.from(TABLAS.extras).insert(extras);
            if (e3) throw new Error('Error migrando extras: ' + e3.message);
        }
    }

    // Actualizar tur_productos con reglas generales legadas + marcar migrado.
    const reglas = legado || {};
    const upsert = {
        producto_id: productoId,
        proyecto_id: proyectoId,
        pricing_modelo: 'por_persona',
        requiere_adulto: !!reglas.requiere_adulto,
        min_pax: reglas.min_participantes || 1,
        max_pax: reglas.max_participantes || null,
        migrado: true,
        updated_at: new Date().toISOString()
    };
    const { error: eUp } = await db.from(TABLAS.prod).upsert(upsert, { onConflict: 'producto_id' });
    if (eUp) throw new Error('Error guardando tur_productos: ' + eUp.message);

    return { yaMigrado: false, tarifas: legado ? legado.categorias_pasajero : [], escalas: legado ? legado.escalas_cantidad : [], extras: legado ? legado.extras : [] };
}

// Lee la configuración turística completa de un producto tour.
// Si aún no se migró y hay JSON legado, lo migra al vuelo (migración lazy).
async function leerConfigTur(proyectoId, productoId) {
    const db = await sup();
    const producto = await asegurarProductoTur(proyectoId, productoId);
    if (!producto) return null;

    const resultadoMigracion = await migrarTourLegado(proyectoId, productoId);

    const base = await db
        .from(TABLAS.prod)
        .select('*')
        .eq('producto_id', productoId)
        .maybeSingle();

    const [tarifas, escalas, extras, plantillas, fechasBloqueadas, recogidas, traslados, itinerario] = await Promise.all([
        db.from(TABLAS.tarifas).select('*').eq('producto_id', productoId).order('orden'),
        db.from(TABLAS.escalas).select('*').eq('producto_id', productoId).order('desde'),
        db.from(TABLAS.extras).select('*').eq('producto_id', productoId).order('created_at'),
        db.from('tur_salida_plantillas').select('*').eq('producto_id', productoId).order('hora_salida'),
        db.from('tur_producto_fechas_bloqueadas').select('*').eq('producto_id', productoId).order('fecha'),
        db.from('tur_recogidas').select('*').eq('producto_id', productoId).order('nombre'),
        db.from('tur_traslados').select('*').eq('producto_id', productoId).order('tipo_vehiculo'),
        db.from('tur_itinerario').select('*').eq('producto_id', productoId).order('orden')
    ]);

    return {
        ok: true,
        producto_id: productoId,
        proyecto_id: proyectoId,
        nombre: producto.nombre,
        descripcion: producto.descripcion,
        precio_desde_cents: producto.precio_cents || 0,
        editorial: (base && base.data) ? base.data : base,
        migrado: (base && base.data) ? base.data.migrado === true : (!!resultadoMigracion),
        tarifas: (tarifas.data || []),
        escalas: (escalas.data || []),
        extras: (extras.data || []),
        calendario: {
            plantillas: (plantillas.data || []),
            fechas_bloqueadas: (fechasBloqueadas.data || [])
        },
        logistica: {
            recogidas: (recogidas.data || []),
            traslados: (traslados.data || []),
            itinerario: (itinerario.data || [])
        }
    };
}

module.exports = {
    parseTourLegacy,
    normCategorias,
    normEscalas,
    normExtras,
    esProductoTour,
    esCategoriaAdulto,
    calcularPrecioTour,
    diasSemanaMatch,
    listarFechasCandidatas,
    obtenerProducto,
    asegurarProductoTur,
    migrarTourLegado,
    leerConfigTur
};
