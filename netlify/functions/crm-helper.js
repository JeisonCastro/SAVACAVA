// ─────────────────────────────────────────────────────────────────────────────
// crm-helper.js — Lógica compartida del CRM agente-céntrico
// Usado por: crm.js (panel), chat.js (captura + pago en chat),
//            pago-webhook.js (cierre de venta)
// ─────────────────────────────────────────────────────────────────────────────

const { supabase } = require('./supabase-admin');

const ESTADOS_DEFAULT = [
    { nombre: 'Nuevo', orden: 1, es_inicial: true,  avance_automatico: '',          color: '#64748b' },
    { nombre: 'Contactado', orden: 2, es_inicial: false, avance_automatico: 'contactado', color: '#0ea5e9' },
    { nombre: 'Calificado', orden: 3, es_inicial: false, avance_automatico: 'calificado', color: '#f59e0b' },
    { nombre: 'Negociación', orden: 4, es_inicial: false, avance_automatico: 'negociacion', color: '#8b5cf6' },
    { nombre: 'Ganado', orden: 5, es_inicial: false, es_cerrada: true,  avance_automatico: null, color: '#22c55e' },
    { nombre: 'Perdido', orden: 6, es_inicial: false, es_perdida: true, avance_automatico: null, color: '#ef4444' }
];

const CAMPOS_BASE = ['nombre', 'telefono', 'email', 'interes', 'preferencias'];

// Tipos de catálogo soportados (inspirados en WooCommerce/Magento y el modelo
// de tours de GetYourGuide/Viator).
const TIPOS_PRODUCTO = {
    fisico:        { etiqueta: 'Físico',        descripcion: 'Producto físico con envío' },
    digital:       { etiqueta: 'Digital',       descripcion: 'Descarga, cuenta o licencia de entrega inmediata' },
    servicio:      { etiqueta: 'Servicio',      descripcion: 'Consultoría, agendamiento, atención' },
    suscripcion:   { etiqueta: 'Suscripción',   descripcion: 'Planes por duración (1 mes, 3 meses...)' },
    tour:          { etiqueta: 'Tour / Actividad', descripcion: 'Precios por pasajero, edad y tamaño de grupo' }
};

function formatearPesos(cents) {
    return '$' + Math.round((Number(cents) || 0) / 100).toLocaleString('es-CO');
}

// Normaliza un producto del catálogo: rellena los campos nuevos y deja intactos
// los productos viejos ({id, nombre, precio_cents}) para total compatibilidad.
function normalizarProducto(p) {
    if (!p) return null;
    return {
        id: p.id,
        nombre: p.nombre || 'Producto',
        tipo: TIPOS_PRODUCTO[p.tipo] ? p.tipo : 'fisico',
        categoria: p.categoria || '',
        descripcion: p.descripcion || '',
        precio_cents: Number(p.precio_cents) || 0,
        disponible: p.disponible !== false,
        url_imagen: p.url_imagen || null,
        variantes: Array.isArray(p.variantes) ? p.variantes : [],
        categorias_pasajero: Array.isArray(p.categorias_pasajero) ? p.categorias_pasajero : [],
        escalas_cantidad: Array.isArray(p.escalas_cantidad) ? p.escalas_cantidad : [],
        extras: Array.isArray(p.extras) ? p.extras : [],
        requiere_adulto: !!p.requiere_adulto,
        min_participantes: Number(p.min_participantes) || 1,
        max_participantes: Number(p.max_participantes) || 0,
        pricing_basis: p.pricing_basis || 'por_persona',
        atributos: p.atributos || {}
    };
}

async function obtenerConfigCRM(userId, agenteId) {
    if (agenteId) {
        const { data } = await supabase
            .from('crm_config_agente')
            .select('*')
            .eq('agente_id', agenteId)
            .maybeSingle();
        if (data) return data;
    }
    return null;
}

async function sembrarEstadosDefault(userId) {
    const { data: existing } = await supabase
        .from('crm_estados')
        .select('id')
        .eq('user_id', userId)
        .limit(1);
    if (existing && existing.length > 0) return;

    const rows = ESTADOS_DEFAULT.map(e => ({ ...e, user_id: userId }));
    const { error } = await supabase.from('crm_estados').insert(rows);
    if (error) console.error('Error sembrando estados default:', error.message);
}

async function obtenerEstadoInicial(userId) {
    const { data } = await supabase
        .from('crm_estados')
        .select('id')
        .eq('user_id', userId)
        .eq('es_inicial', true)
        .order('orden', { ascending: true })
        .limit(1)
        .maybeSingle();
    if (data?.id) return data.id;

    // Fallback: si el pipeline personalizado no marcó estado inicial, usa el primero.
    const { data: primer } = await supabase
        .from('crm_estados')
        .select('id')
        .eq('user_id', userId)
        .order('orden', { ascending: true })
        .limit(1)
        .maybeSingle();
    return primer?.id || null;
}

async function obtenerEstadoCerrada(userId) {
    const { data } = await supabase
        .from('crm_estados')
        .select('id')
        .eq('user_id', userId)
        .eq('es_cerrada', true)
        .order('orden', { ascending: true })
        .limit(1)
        .maybeSingle();
    return data?.id || null;
}

// ── Pipeline por TIENDA (tienda_pipeline) ──────────────────────────────────
// Los pipelines del CRM se definen sobre la tienda (no por agente). El agente
// asignado a una tienda toma estos estados. Se mantiene el fallback a
// crm_estados (por usuario) para los agentes aún sin tienda (transición).
async function sembrarPipelineTienda(proyectoId) {
    if (!proyectoId) return;
    const { data: existing } = await supabase
        .from('tienda_pipeline')
        .select('id')
        .eq('proyecto_id', proyectoId)
        .limit(1);
    if (existing && existing.length > 0) return;
    const rows = ESTADOS_DEFAULT.map(e => ({ ...e, proyecto_id: proyectoId }));
    const { error } = await supabase.from('tienda_pipeline').insert(rows);
    if (error) console.error('Error sembrando pipeline de tienda:', error.message);
}

async function obtenerEstadoInicialTienda(proyectoId) {
    if (!proyectoId) return null;
    const { data } = await supabase
        .from('tienda_pipeline')
        .select('id')
        .eq('proyecto_id', proyectoId)
        .eq('es_inicial', true)
        .order('orden', { ascending: true })
        .limit(1)
        .maybeSingle();
    if (data?.id) return data.id;
    const { data: primer } = await supabase
        .from('tienda_pipeline')
        .select('id')
        .eq('proyecto_id', proyectoId)
        .order('orden', { ascending: true })
        .limit(1)
        .maybeSingle();
    return primer?.id || null;
}

async function obtenerEstadoCerradaTienda(proyectoId) {
    if (!proyectoId) return null;
    const { data } = await supabase
        .from('tienda_pipeline')
        .select('id')
        .eq('proyecto_id', proyectoId)
        .eq('es_cerrada', true)
        .order('orden', { ascending: true })
        .limit(1)
        .maybeSingle();
    return data?.id || null;
}

// ── Catálogo de tienda (e-commerce) ──────────────────────────────────────────
// Carga productos de tienda_productos + variaciones de tienda_variaciones
// y los adapta al mismo formato que el catálogo CRM para inyectar en el prompt.
async function obtenerCatalogoTienda(tiendaId) {
    if (!tiendaId) return [];
    const { data: productos } = await supabase
        .from('tienda_productos')
        .select('*')
        .eq('proyecto_id', tiendaId)
        .eq('activo', true)
        .order('created_at', { ascending: true });
    if (!productos || !productos.length) return [];

    const ids = productos.map(p => p.id);
    const { data: variaciones } = await supabase
        .from('tienda_variaciones')
        .select('*')
        .in('producto_id', ids)
        .eq('activo', true);

    const varMap = {};
    for (const v of (variaciones || [])) {
        if (!varMap[v.producto_id]) varMap[v.producto_id] = [];
        varMap[v.producto_id].push(v);
    }

    return productos.map(p => {
        const esTour = p.tipo === 'tour';
        const tourConfig = esTour && p.atributos && typeof p.atributos === 'object' ? p.atributos : {};
        return {
        id: p.id,
        nombre: p.nombre,
        tipo: p.tipo || 'fisico',
        categoria: p.categoria || 'General',
        descripcion: p.descripcion || '',
        precio_cents: Number(p.precio_cents) || 0,
        disponible: p.activo !== false,
        url_imagen: p.imagen || p.imagenes?.[0]?.url || null,
        variantes: (varMap[p.id] || []).map(v => {
            let nombreVariante = v.id;
            try {
                const comb = typeof v.combinacion === 'string' ? JSON.parse(v.combinacion) : v.combinacion;
                if (comb && typeof comb === 'object') {
                    nombreVariante = Object.values(comb).filter(Boolean).join(' / ');
                }
            } catch (_) {}
            return {
                id: v.id,
                nombre: nombreVariante || v.id,
                precio_cents: Number(v.precio_cents) || Number(p.precio_cents) || 0,
                stock: Number(v.stock) ?? null
            };
        }),
        // Para tours, el atributo JSON de la tienda se mapea a los campos de tarifas
        // por pasajero que espera el formato CRM (GetYourGuide/Viator).
        atributos: esTour ? {} : (p.atributos || {}),
        categorias_pasajero: esTour ? (tourConfig.categorias_pasajero || []) : [],
        escalas_cantidad: esTour ? (tourConfig.escalas_cantidad || []) : [],
        extras: esTour ? (tourConfig.extras || []) : [],
        requiere_adulto: esTour ? !!tourConfig.requiere_adulto : false,
        min_participantes: esTour ? (Number(tourConfig.min_participantes) || 1) : 1,
        max_participantes: esTour ? (Number(tourConfig.max_participantes) || 0) : 0,
        pricing_basis: esTour ? 'por_persona' : 'por_unidad'
        };
    });
}

// Construye texto del catálogo de tienda para inyectar en el prompt del agente.
async function construirTextoCatalogoTienda(tiendaId) {
    const catalogo = await obtenerCatalogoTienda(tiendaId);
    if (!catalogo.length) return '';
    return construirTextoCatalogo({ catalogo });
}

// Texto del catálogo para inyectar en el prompt del agente.
// Agrupa por categoría y renderiza según el tipo (tarifas por pasajero,
// variantes, escalas por cantidad, extras y atributos).
function construirTextoCatalogo(config) {
    const catalogo = config?.catalogo || [];
    if (!catalogo.length) return '';

    const agrupado = {};
    for (const raw of catalogo) {
        const p = normalizarProducto(raw);
        if (p.disponible === false) continue;
        const cat = p.categoria || 'General';
        if (!agrupado[cat]) agrupado[cat] = [];
        agrupado[cat].push(p);
    }

    const lineas = [];
    for (const cat of Object.keys(agrupado)) {
        lineas.push(`--- ${cat.toUpperCase()} ---`);
        for (const p of agrupado[cat]) {
            const base = p.descripcion
                ? `- ${p.nombre} (${p.descripcion}): ${formatearPesos(p.precio_cents)} COP (id: ${p.id})`
                : `- ${p.nombre}: ${formatearPesos(p.precio_cents)} COP (id: ${p.id})`;
            lineas.push(base);

            if (p.tipo === 'tour' && p.categorias_pasajero.length) {
                const bands = p.categorias_pasajero
                    .filter(b => b.permitido !== false)
                    .map(b => `${b.nombre} (${b.edad_min}-${b.edad_max} años, ${formatearPesos(b.precio_cents)} COP)`)
                    .join('; ');
                lineas.push(`  Tarifas por pasajero: ${bands}.`);
                if (p.escalas_cantidad.length) {
                    const escalas = p.escalas_cantidad
                        .map(e => `${e.desde}${e.hasta ? '-' + e.hasta : '+'} pasajeros${Number(e.descuento_pct) ? ' (-' + e.descuento_pct + '%)' : ''}`)
                        .join('; ');
                    lineas.push(`  Descuentos por tamaño de grupo: ${escalas}.`);
                }
                lineas.push(`  Mínimo ${p.min_participantes || 1} / Máximo ${p.max_participantes ? p.max_participantes : 'sin límite'} participantes.`);
                if (p.requiere_adulto) lineas.push('  Requiere al menos 1 adulto en el grupo.');
            }
            if (p.variantes.length) {
                const vars = p.variantes.map(v => `${v.nombre}: ${formatearPesos(v.precio_cents)} COP (id: ${v.id})`).join(' | ');
                lineas.push(`  Variantes: ${vars}`);
            }
            if (p.extras.length) {
                const extras = p.extras.map(e => `${e.nombre}: ${formatearPesos(e.precio_cents)} COP (id: ${e.id})`).join(' | ');
                lineas.push(`  Extras opcionales: ${extras}`);
            }
            if (p.atributos && Object.keys(p.atributos).length) {
                const attrs = Object.entries(p.atributos).map(([k, v]) => `${k}: ${v}`).join(' · ');
                lineas.push(`  ${attrs}`);
            }
        }
    }
    return lineas.join('\n');
}

// Catálogo sanitizado para enviar a los clientes (chat web / WhatsApp).
// Solo campos útiles para mostrar tarjetas de producto; sin datos internos.
function productosParaCliente(catalogo) {
    const lista = Array.isArray(catalogo) ? catalogo : [];
    return lista
        .map(p => normalizarProducto(p))
        .filter(p => p && p.disponible !== false)
        .map(p => ({
            id: p.id,
            nombre: p.nombre,
            tipo: p.tipo,
            categoria: p.categoria,
            descripcion: p.descripcion,
            precio_cents: p.precio_cents,
            url_imagen: p.url_imagen || null,
            variantes: (p.variantes || []).map(v => ({ nombre: v.nombre, precio_cents: Number(v.precio_cents) || 0 })),
            categorias_pasajero: (p.categorias_pasajero || [])
                .filter(b => b.permitido !== false)
                .map(b => ({ nombre: b.nombre, edad_min: b.edad_min, edad_max: b.edad_max, precio_cents: Number(b.precio_cents) || 0 })),
            escalas_cantidad: (p.escalas_cantidad || []).map(e => ({ desde: e.desde, hasta: e.hasta, descuento_pct: e.descuento_pct })),
            extras: (p.extras || []).map(e => ({ nombre: e.nombre, precio_cents: Number(e.precio_cents) || 0 })),
            requiere_adulto: !!p.requiere_adulto,
            min_participantes: p.min_participantes,
            max_participantes: p.max_participantes
        }));
}

// Llama a DeepSeek pidiendo SOLO JSON (extracción / clasificación)
async function deepseekJSON(systemPrompt, userText, maxTokens = 400) {
    if (!process.env.DEEPSEEK_API_KEY) return null;
    const controller = new AbortController();
    // Extracción de lead es best-effort: no debe robar presupuesto de tiempo de la
    // respuesta del chat (la función de Netlify muere a los 30s). Si DeepSeek está
    // lento, abortamos rápido y simplemente no se actualiza el lead en ese turno.
    // El Promise.race con plazo duro es obligatorio: el abort de undici a veces NO
    // rechaza res.json() y la promesa quedaría colgada para siempre (30s => 502).
    const timer = setTimeout(() => controller.abort(), 5000);
    let deadlineTimer = null;
    const deadline = new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => reject(new Error('Timeout: DeepSeek (deepseekJSON) tardó más de 5s')), 5000);
    });

    try {
        const data = await Promise.race([
            (async () => {
                const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'deepseek-v4-flash',
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userText }
                        ],
                        temperature: 0,
                        max_tokens: maxTokens,
                        thinking: { type: 'disabled' }
                    }),
                    signal: controller.signal
                });
                return await res.json();
            })(),
            deadline
        ]);
        const content = data?.choices?.[0]?.message?.content || '';
        if (!content.trim()) return null;

        const sinFences = content.replace(/```json/gi, '').replace(/```/g, '').trim();
        const inicio = sinFences.indexOf('{');
        const fin = sinFences.lastIndexOf('}');
        if (inicio === -1 || fin === -1) return null;
        try {
            return JSON.parse(sinFences.slice(inicio, fin + 1));
        } catch (_) {
            return null;
        }
    } catch (err) {
        console.error('Error en deepseekJSON:', err.message);
        return null;
    } finally {
        clearTimeout(timer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
    }
}

// ── CAPTURA POST-CHAT ──
// Toma los últimos mensajes de la conversación y extrae los datos del lead.
async function extraerDatosLead({ agente, canal, externalUserId, conversacionId }) {
    try {
        const t0 = Date.now();
        const { data: mensajesRaw } = await supabase
            .from('mensajes_conversacion')
            .select('role, content, created_at')
            .eq('conversacion_id', conversacionId)
            .order('created_at', { ascending: false })
            .limit(14);
        console.log(`[timing] lead select mensajes: ${Date.now() - t0}ms`);

        const mensajes = (mensajesRaw || []).slice().reverse();
        if (!mensajes || mensajes.length === 0) return;

        const transcripcion = mensajes
            .map(m => `${m.role === 'user' ? 'Cliente' : 'Agente'}: ${String(m.content || '').slice(0, 400)}`)
            .join('\n');

        const campos = agente.crm_campos && agente.crm_campos.length
            ? agente.crm_campos.join(', ')
            : CAMPOS_BASE.join(', ');

        const systemPrompt = `Eres el extractor de datos del CRM. Dada una conversación de venta, extrae SOLO los campos disponibles en formato JSON.
Devuelve EXACTAMENTE un JSON (sin texto extra, sin markdown) con esta forma:
{
  "nombre": string o null,
  "telefono": string o null,
  "email": string o null,
  "interes": string o null,
  "preferencias": objeto de datos relevantes del cliente o {},
  "notas": resumen breve de la conversación,
  "etapa": "nuevo" | "contactado" | "calificado" | "negociacion" | "compra"
}
Campos a extraer: ${campos}.
Reglas:
- "etapa": "nuevo" solo saludo; "contactado" si ya hay intercambio real; "calificado" si mostró interés concreto; "negociacion" si habla de compra, precio o condiciones; "compra" si confirmó que va a comprar (NO si solo preguntó).
- Usa null cuando el dato no esté presente en la conversación. No inventes datos.`;
        const t1 = Date.now();
        const extraido = await deepseekJSON(systemPrompt, `Transcripción:\n${transcripcion}`);
        console.log(`[timing] lead deepseekJSON: ${Date.now() - t1}ms extraido=${!!extraido}`);

        if (!extraido || typeof extraido !== 'object') return;

        const config = await obtenerConfigCRM(agente.user_id, agente.id);
        // Captura por defecto si el agente está vinculado a una TIENDA (no requiere
        // activar crm_activo ni configurar catálogo/conecciones); si no, depende de crm_activo.
        const capturaActiva = agente.tienda_id || (config && config.crm_activo === true);
        if (!capturaActiva) return;

        // Buscar lead existente para esta conversación / contacto
        const { data: leadExistente } = await supabase
            .from('crm_leads')
            .select('id, estado_id, etapa_generica, external_user_id')
            .eq('user_id', agente.user_id)
            .eq('agente_id', agente.id)
            .eq('external_user_id', externalUserId || '')
            .limit(1)
            .maybeSingle();

        const tiendaIdLead = agente.tienda_id || null;
        const estadoInicial = tiendaIdLead
            ? await obtenerEstadoInicialTienda(tiendaIdLead)
            : await obtenerEstadoInicial(agente.user_id);

        const leadData = {
            user_id: agente.user_id,
            agente_id: agente.id,
            conversacion_id: conversacionId,
            external_user_id: externalUserId || null,
            origen: canal || 'web',
            proyecto_id: agente.tienda_id || null,
            nombre: extraido.nombre || leadExistente?.nombre || null,
            telefono: extraido.telefono || leadExistente?.telefono || (canal === 'whatsapp' ? externalUserId : null),
            email: extraido.email || leadExistente?.email || null,
            interes: extraido.interes || leadExistente?.interes || null,
            preferencias: Object.keys(extraido.preferencias || {}).length
                ? extraido.preferencias
                : leadExistente?.preferencias || {},
            notas: extraido.notas || leadExistente?.notas || null,
            etapa_generica: extraido.etapa || leadExistente?.etapa_generica || 'nuevo'
        };

        if (leadExistente) {
            await supabase
                .from('crm_leads')
                .update({ ...leadData, updated_at: new Date().toISOString() })
                .eq('id', leadExistente.id);

            // Avance automático de estado (solo hacia adelante y nunca a terminal)
            if (tiendaIdLead) {
                await avanzarEstadoAutomaticoPorTienda({
                    leadId: leadExistente.id,
                    proyectoId: tiendaIdLead,
                    estadoActualId: leadExistente.estado_id,
                    etapa: extraido.etapa
                });
            } else {
                await avanzarEstadoAutomatico({
                    leadId: leadExistente.id,
                    userId: agente.user_id,
                    estadoActualId: leadExistente.estado_id,
                    etapa: extraido.etapa
                });
            }
        } else if (leadExistente !== null || externalUserId || conversacionId) {
            const { data: nuevoLead, error: errIns } = await supabase
                .from('crm_leads')
                .insert({
                    ...leadData,
                    estado_id: estadoInicial,
                    etapa_generica: extraido.etapa || 'nuevo'
                })
                .select('id')
                .single();
            if (errIns) console.error('Error insertando lead:', errIns.message);
            else if (nuevoLead?.id) {
                if (tiendaIdLead) {
                    await avanzarEstadoAutomaticoPorTienda({
                        leadId: nuevoLead.id,
                        proyectoId: tiendaIdLead,
                        estadoActualId: estadoInicial,
                        etapa: extraido.etapa
                    });
                } else {
                    await avanzarEstadoAutomatico({
                        leadId: nuevoLead.id,
                        userId: agente.user_id,
                        estadoActualId: estadoInicial,
                        etapa: extraido.etapa
                    });
                }
            }
        }
    } catch (err) {
        console.error('Error en extraerDatosLead:', err.message);
    }
}

// Avanza el estado si la etapa detectada corresponde a un avance_automatico
async function avanzarEstadoAutomatico({ leadId, userId, estadoActualId, etapa }) {
    if (!etapa || !['contactado', 'calificado', 'negociacion'].includes(etapa)) return;

    const { data: estados } = await supabase
        .from('crm_estados')
        .select('id, orden, es_cerrada, es_perdida')
        .eq('user_id', userId)
        .order('orden', { ascending: true });

    if (!estados || estados.length === 0) return;

    const actual = estados.find(e => e.id === estadoActualId);
    if (!actual || actual.es_cerrada || actual.es_perdida) return;

    const objetivo = estados.find(e => e.avance_automatico === etapa);
    if (!objetivo || objetivo.es_cerrada || objetivo.es_perdida) return;

    if (objetivo.orden > actual.orden) {
        await supabase
            .from('crm_leads')
            .update({ estado_id: objetivo.id, updated_at: new Date().toISOString() })
            .eq('id', leadId);
    }
}

// Igual que avanzarEstadoAutomatico pero usando el pipeline de la TIENDA
// (para leads de tienda: proyecto_id != null).
async function avanzarEstadoAutomaticoPorTienda({ leadId, proyectoId, estadoActualId, etapa }) {
    if (!proyectoId || !etapa || !['contactado', 'calificado', 'negociacion'].includes(etapa)) return;

    const { data: estados } = await supabase
        .from('tienda_pipeline')
        .select('id, orden, es_cerrada, es_perdida')
        .eq('proyecto_id', proyectoId)
        .order('orden', { ascending: true });

    if (!estados || estados.length === 0) return;

    const actual = estados.find(e => e.id === estadoActualId);
    if (!actual || actual.es_cerrada || actual.es_perdida) return;

    const objetivo = estados.find(e => e.avance_automatico === etapa);
    if (!objetivo || objetivo.es_cerrada || objetivo.es_perdida) return;

    if (objetivo.orden > actual.orden) {
        await supabase
            .from('crm_leads')
            .update({ estado_id: objetivo.id, updated_at: new Date().toISOString() })
            .eq('id', leadId);
    }
}

// ── CÁLCULO DE PRECIOS (catálogo enriquecido) ──
// Valida y calcula el total de un producto. Para tours/servicios por pasajero
// aplica el modelo de GetYourGuide/Viator: asignación por rango de edad,
// validación de pax mix (adulto requerido, min/max participantes) y descuento
// por escala de cantidad. Los extras (add-ons) se suman al final.
// Devuelve { valido, errores, total_cents, total_pesos, desglose }.
function calcularPrecioProducto({ producto, pasajeros = [], extras = [], cantidad = 1, varianteId = null }) {
    const prod = normalizarProducto(producto);
    const errores = [];
    const desglose = [];
    let total = 0;

    // Normalizador de texto para mapear nombres de categoría a ids cuando el
    // payload del agente venga con nombres (ej. "adulto", "niño") en vez
    // del id interno (ej. "b123"). Esto hace la validación más tolerante.
    const normalize = (s) => String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-z0-9]/g, '');

    const nameMap = {};
    for (const c of prod.categorias_pasajero || []) {
        try {
            nameMap[normalize(c.nombre)] = c;
        } catch (e) {
            // Fallback por si normalize falla en algún entorno
            nameMap[String(c.nombre || '').toLowerCase()] = c;
        }
    }

    // Si el agente envía edades individuales (ej. [{edad:35},{edad:8},...]) o
    // una lista de números, inferimos las cantidades por categoría usando
    // los rangos edad_min/edad_max configurados en el producto.
    if (Array.isArray(pasajeros) && pasajeros.length) {
        const everyIsAgeLike = pasajeros.every(p => typeof p === 'number' || (p && (p.hasOwnProperty('edad') || p.hasOwnProperty('age'))));
        if (everyIsAgeLike) {
            const inferred = {};
            for (const item of pasajeros) {
                let age = null;
                let qty = 1;
                if (typeof item === 'number') age = Number(item);
                else {
                    age = Number(item.edad ?? item.age ?? NaN);
                    qty = Math.max(1, Math.floor(Number(item.cantidad) || 1));
                }
                if (!Number.isFinite(age) || age < 0) {
                    errores.push(`Edad inválida: ${String(item)}`);
                    continue;
                }
                // buscar categoría por rango de edad y permitida
                const cat = (prod.categorias_pasajero || []).find(c => (c.permitido !== false) && Number(c.edad_min) <= age && age <= Number(c.edad_max));
                if (!cat) {
                    errores.push(`No encontré una categoría para edad ${age}. Revisa las tarifas por pasajero configuradas.`);
                    continue;
                }
                inferred[cat.id] = (inferred[cat.id] || 0) + qty;
            }
            // Reconstruir 'pasajeros' en la forma esperada: [{categoriaId, cantidad}, ...]
            pasajeros = Object.keys(inferred).map(id => ({ categoriaId: id, cantidad: inferred[id] }));
        }
    }

    // Variantes: si se elige una, su precio reemplaza el precio base.
    let precioUnitario = prod.precio_cents;
    if (varianteId && prod.variantes.length) {
        const v = prod.variantes.find(x => String(x.id) === String(varianteId));
        if (v) precioUnitario = Number(v.precio_cents) || precioUnitario;
    }

    if (prod.tipo === 'tour' && prod.categorias_pasajero.length) {
        // Precio por pasajero (edad)
        let totalPasajeros = 0;
        let hayAdulto = false;
        for (const pj of pasajeros || []) {
            const qty = Math.floor(Number(pj.cantidad)) || 0;
            if (qty <= 0) continue;
            // Buscar por id (esperado). Si no hay match, intentar mapear por nombre
            // normalizado (ej. "adulto", "nino"). También intentamos manejar
            // plurales ("adultos"). Si encontramos por nombre, sustituimos
            // pj.categoriaId por el id real para el resto del flujo.
            let cat = prod.categorias_pasajero.find(c => String(c.id) === String(pj.categoriaId));
            if (!cat) {
                const cand = nameMap[normalize(pj.categoriaId)];
                if (cand) {
                    cat = cand;
                    pj.categoriaId = cat.id;
                } else {
                    // intentar singular (ej. adultos -> adulto)
                    const pjNorm = normalize(pj.categoriaId || '');
                    if (pjNorm && pjNorm.endsWith('s')) {
                        const cand2 = nameMap[pjNorm.slice(0, -1)];
                        if (cand2) {
                            cat = cand2;
                            pj.categoriaId = cat.id;
                        }
                    }
                }
            }
            if (!cat) {
                errores.push(`La categoría de pasajero "${pj.categoriaId}" no existe en este tour.`);
                continue;
            }
            if (cat.permitido === false) {
                errores.push(`La categoría "${cat.nombre}" no está permitida para este tour.`);
                continue;
            }
            totalPasajeros += qty;
            if (/adulto|senior|mayor/i.test(cat.nombre)) hayAdulto = true;
            const unit = Number(cat.precio_cents) || 0;
            const subtotal = unit * qty;
            total += subtotal;
            desglose.push({ nombre: cat.nombre, cantidad: qty, precio_unit_cents: unit, subtotal_cents: subtotal });
        }

        if (!totalPasajeros) {
            errores.push('Indica la cantidad de pasajeros por categoría (ej. 2 adultos, 1 niño).');
        } else {
            if (prod.requiere_adulto && !hayAdulto) {
                errores.push('Este tour requiere al menos 1 adulto en el grupo.');
            }
            if (prod.min_participantes > 1 && totalPasajeros < prod.min_participantes) {
                errores.push(`El tour requiere mínimo ${prod.min_participantes} participantes (el grupo tiene ${totalPasajeros}).`);
            }
            if (prod.max_participantes && totalPasajeros > prod.max_participantes) {
                errores.push(`El tour admite máximo ${prod.max_participantes} participantes (el grupo tiene ${totalPasajeros}).`);
            }
        }

        // Descuento por escala de cantidad (precio según tamaño del grupo)
        if (prod.escalas_cantidad.length && totalPasajeros > 0) {
            const escala = prod.escalas_cantidad
                .filter(e => totalPasajeros >= (Number(e.desde) || 0) && (!e.hasta || totalPasajeros <= Number(e.hasta)))
                .sort((a, b) => (Number(b.descuento_pct) || 0) - (Number(a.descuento_pct) || 0))[0];
            if (escala && Number(escala.descuento_pct) > 0) {
                const desc = Math.round(total * (Number(escala.descuento_pct) / 100));
                total -= desc;
                desglose.push({
                    nombre: `Descuento por grupo (-${escala.descuento_pct}% · ${escala.desde}${escala.hasta ? '-' + escala.hasta : '+'} pasajeros)`,
                    cantidad: 1,
                    precio_unit_cents: -desc,
                    subtotal_cents: -desc
                });
            }
        }
    } else {
        // Producto simple / con variantes: precio unitario × cantidad
        const qty = Math.max(1, Math.floor(Number(cantidad)) || 1);
        const subtotal = precioUnitario * qty;
        total = subtotal;
        desglose.push({
            nombre: prod.nombre + (varianteId ? ' (variante)' : ''),
            cantidad: qty,
            precio_unit_cents: precioUnitario,
            subtotal_cents: subtotal
        });
    }

    // Extras / add-ons
    for (const ex of extras || []) {
        const qty = Math.max(1, Math.floor(Number(ex.cantidad)) || 1);
        const extra = (prod.extras || []).find(e => String(e.id) === String(ex.id));
        if (!extra) {
            errores.push(`El extra "${ex.id}" no existe para este producto.`);
            continue;
        }
        const sub = (Number(extra.precio_cents) || 0) * qty;
        total += sub;
        desglose.push({
            nombre: extra.nombre,
            cantidad: qty,
            precio_unit_cents: Number(extra.precio_cents) || 0,
            subtotal_cents: sub
        });
    }

    const totalCents = Math.max(0, Math.round(total));
    return {
        valido: errores.length === 0,
        errores,
        total_cents: totalCents,
        total_pesos: Math.round(totalCents / 100),
        desglose
    };
}

// ── PAGO EN CHAT (venta) ──
// Crea el payment link de Wompi con la pasarela DEL VENDEDOR y registra el pago.
async function crearPaymentLinkVenta({ config, agente, leadId, conversacionId, producto, canal, externalUserId, montoCents }) {
    const SITE_URL = process.env.URL || 'https://auvro.netlify.app';
    const WOMPI_BASE = config.wompi_sandbox
        ? 'https://sandbox.wompi.co/v1'
        : 'https://production.wompi.co/v1';

    if (!config.wompi_private_key) {
        return { ok: false, error: 'El vendedor no tiene configurada su pasarela de pago (Wompi) en CRM > Configuración.' };
    }

    let monto = Number(montoCents);
    if (!monto || monto <= 0) monto = Number(producto.precio_cents);
    if (!monto || monto <= 0) {
        return { ok: false, error: 'El producto seleccionado no tiene un precio válido.' };
    }

    const concepto = `Venta ${producto.nombre}`;

    const wompiRes = await fetch(`${WOMPI_BASE}/payment_links`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.wompi_private_key}`
        },
        body: JSON.stringify({
            name: `AUVRO - ${concepto}`,
            description: concepto,
            single_use: true,
            collect_shipping: false,
            currency: 'COP',
            amount_in_cents: monto,
            redirect_url: `${SITE_URL}/dashboard.html?crm=venta`
        })
    });
    const wompi = await wompiRes.json();

    if (!wompiRes.ok || !wompi?.data?.id) {
        console.error('Wompi error al crear link de venta:', JSON.stringify(wompi));
        return { ok: false, error: wompi?.error?.message || 'Error creando el pago en Wompi.' };
    }

    const paymentLinkId = wompi.data.id;

    const { data: pago, error: insError } = await supabase
        .from('pagos')
        .insert({
            user_id: agente.user_id,
            tipo: 'venta',
            concepto,
            monto_cents: monto,
            payment_link_id: paymentLinkId,
            lead_id: leadId,
            estado: 'pendiente'
        })
        .select('id')
        .single();

    if (insError) {
        console.error('Error registrando pago de venta:', insError.message);
        return { ok: false, error: 'No se pudo registrar el pago.' };
    }

    const { data: lead } = await supabase
        .from('crm_leads')
        .select('nombre, external_user_id, email, telefono')
        .eq('id', leadId)
        .maybeSingle();

    // Enviar notificación pre-pago si el agente lo tiene habilitado
    try {
        const cfg = config || (await obtenerConfigCRM(agente.user_id, agente.id));
        if (cfg?.notify_on_intent) {
            const { sendEmail } = require('./notifications');
            const recipients = (cfg.notify_recipients && cfg.notify_recipients.length) ? cfg.notify_recipients.slice() : [];
            // incluir email del lead si existiera
            if (lead && lead.email) recipients.push(lead.email);
            const subject = `Link de pago: ${concepto}`;
            const url = `https://checkout.wompi.co/l/${paymentLinkId}`;
            const text = `Hola ${lead?.nombre || ''}\n\nSe ha generado un link de pago para ${concepto}: ${url}\n\nMonto: ${Math.round(monto/100).toLocaleString('es-CO')} COP`;
            for (const to of recipients) {
                if (!to) continue;
                sendEmail({
                    agente,
                    agenteId: agente.id,
                    leadId,
                    conversationId: conversacionId || null,
                    eventType: 'pre_pago',
                    to, subject, text
                }).catch(err => console.error('pre-pago email err:', err));
            }
        }
    } catch (e) {
        console.error('Error notifying pre-pago:', e.message);
    }

    return {
        ok: true,
        url: `https://checkout.wompi.co/l/${paymentLinkId}`,
        payment_link_id: paymentLinkId,
        concepto,
        monto_cents: monto,
        pago_id: pago?.id,
        lead: lead || null
    };
}

// Busca o crea el lead y devuelve su id (para ligar el pago en chat)
async function obtenerOCrearLead({ agente, canal, externalUserId, conversacionId }) {
    const { data: existente } = await supabase
        .from('crm_leads')
        .select('id')
        .eq('user_id', agente.user_id)
        .eq('agente_id', agente.id)
        .eq('external_user_id', externalUserId || '')
        .limit(1)
        .maybeSingle();

    if (existente?.id) return existente.id;

    const tiendaIdLead = agente.tienda_id || null;
    const estadoInicial = tiendaIdLead
        ? await obtenerEstadoInicialTienda(tiendaIdLead)
        : await obtenerEstadoInicial(agente.user_id);
    const { data: nuevo } = await supabase
        .from('crm_leads')
        .insert({
            user_id: agente.user_id,
            agente_id: agente.id,
            conversacion_id: conversacionId || null,
            external_user_id: externalUserId || null,
            origen: canal || 'web',
            proyecto_id: tiendaIdLead,
            estado_id: estadoInicial,
            etapa_generica: 'nuevo',
            telefono: canal === 'whatsapp' ? externalUserId : null
        })
        .select('id')
        .single();

    return nuevo?.id || null;
}

module.exports = {
    CAMPOS_BASE,
    ESTADOS_DEFAULT,
    TIPOS_PRODUCTO,
    obtenerConfigCRM,
    sembrarEstadosDefault,
    sembrarPipelineTienda,
    obtenerEstadoInicial,
    obtenerEstadoCerrada,
    obtenerEstadoInicialTienda,
    obtenerEstadoCerradaTienda,
    normalizarProducto,
    calcularPrecioProducto,
    construirTextoCatalogo,
    construirTextoCatalogoTienda,
    obtenerCatalogoTienda,
    productosParaCliente,
    deepseekJSON,
    extraerDatosLead,
    avanzarEstadoAutomatico,
    avanzarEstadoAutomaticoPorTienda,
    crearPaymentLinkVenta,
    obtenerOCrearLead
};
