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

// Texto del catálogo para inyectar en el prompt del agente
function construirTextoCatalogo(config) {
    const catalogo = config?.catalogo || [];
    if (!catalogo.length) return '';
    return catalogo
        .map(p => `- ${p.nombre}: $${Math.round((p.precio_cents || 0) / 100).toLocaleString('es-CO')} COP (id: ${p.id})`)
        .join('\n');
}

// Llama a DeepSeek pidiendo SOLO JSON (extracción / clasificación)
async function deepseekJSON(systemPrompt, userText, maxTokens = 400) {
    if (!process.env.DEEPSEEK_API_KEY) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
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
            })
        });
        const data = await res.json();
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
    }
}

// ── CAPTURA POST-CHAT ──
// Toma los últimos mensajes de la conversación y extrae los datos del lead.
async function extraerDatosLead({ agente, canal, externalUserId, conversacionId }) {
    try {
        const { data: mensajesRaw } = await supabase
            .from('mensajes_conversacion')
            .select('role, content, created_at')
            .eq('conversacion_id', conversacionId)
            .order('created_at', { ascending: false })
            .limit(14);

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
        const extraido = await deepseekJSON(systemPrompt, `Transcripción:\n${transcripcion}`);

        if (!extraido || typeof extraido !== 'object') return;

        const config = await obtenerConfigCRM(agente.user_id, agente.id);
        if (!config || config.crm_activo !== true) return;

        // Buscar lead existente para esta conversación / contacto
        const { data: leadExistente } = await supabase
            .from('crm_leads')
            .select('id, estado_id, etapa_generica, external_user_id')
            .eq('user_id', agente.user_id)
            .eq('agente_id', agente.id)
            .eq('external_user_id', externalUserId || '')
            .limit(1)
            .maybeSingle();

        const estadoInicial = await obtenerEstadoInicial(agente.user_id);

        const leadData = {
            user_id: agente.user_id,
            agente_id: agente.id,
            conversacion_id: conversacionId,
            external_user_id: externalUserId || null,
            origen: canal || 'web',
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
            await avanzarEstadoAutomatico({
                leadId: leadExistente.id,
                userId: agente.user_id,
                estadoActualId: leadExistente.estado_id,
                etapa: extraido.etapa
            });
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
                await avanzarEstadoAutomatico({
                    leadId: nuevoLead.id,
                    userId: agente.user_id,
                    estadoActualId: estadoInicial,
                    etapa: extraido.etapa
                });
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

// ── PAGO EN CHAT (venta) ──
// Crea el payment link de Wompi con la pasarela DEL VENDEDOR y registra el pago.
async function crearPaymentLinkVenta({ config, agente, leadId, conversacionId, producto, canal, externalUserId }) {
    const SITE_URL = process.env.URL || 'https://auvro.netlify.app';
    const WOMPI_BASE = config.wompi_sandbox
        ? 'https://sandbox.wompi.co/v1'
        : 'https://production.wompi.co/v1';

    if (!config.wompi_private_key) {
        return { ok: false, error: 'El vendedor no tiene configurada su pasarela de pago (Wompi) en CRM > Configuración.' };
    }

    const montoCents = Number(producto.precio_cents);
    if (!montoCents || montoCents <= 0) {
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
            amount_in_cents: montoCents,
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
            monto_cents: montoCents,
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
        .select('nombre, external_user_id')
        .eq('id', leadId)
        .maybeSingle();

    return {
        ok: true,
        url: `https://checkout.wompi.co/l/${paymentLinkId}`,
        payment_link_id: paymentLinkId,
        concepto,
        monto_cents: montoCents,
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

    const estadoInicial = await obtenerEstadoInicial(agente.user_id);
    const { data: nuevo } = await supabase
        .from('crm_leads')
        .insert({
            user_id: agente.user_id,
            agente_id: agente.id,
            conversacion_id: conversacionId || null,
            external_user_id: externalUserId || null,
            origen: canal || 'web',
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
    obtenerConfigCRM,
    sembrarEstadosDefault,
    obtenerEstadoInicial,
    obtenerEstadoCerrada,
    construirTextoCatalogo,
    deepseekJSON,
    extraerDatosLead,
    avanzarEstadoAutomatico,
    crearPaymentLinkVenta,
    obtenerOCrearLead
};
