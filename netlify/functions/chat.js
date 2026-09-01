const { supabase } = require('./supabase-admin');
const {
    TOOL_DEFINITIONS,
    esConfirmacion,
    esCancelacion,
    construirToolsDescription,
    getMissingFields,
    buildMissingFieldsQuestion,
    enrichCalendarPayloadFromText,
    seemsContactInfo,
    classifyMessageRoute,
    enrichEmailPayloadFromText,
    enrichDrivePayloadFromText
} = require('./tool-workflows');
const {
    obtenerConfigCRM,
    construirTextoCatalogo,
    construirTextoCatalogoTienda,
    construirTextoDeportesTienda,
    obtenerCatalogoTienda,
    productosParaCliente,
    calcularPrecioProducto,
    obtenerOCrearLead,
    crearPaymentLinkVenta,
    extraerDatosLead
} = require('./crm-helper');
const { pipelineCrear, validarSlug } = require('./web-factory.js').helpers;

// Toolkits nativos (no requieren conexión Composio): la disponibilidad depende
// solo de que la herramienta esté habilitada en agente_tools.
const TOOLKITS_NATIVOS = new Set(['webfactory']);

// ── HELPERS DE OPTIMIZACIÓN ─────────────────────────────────────────────────

function truncarMensaje(texto, maxChars = 2000) {
    if (!texto || texto.length <= maxChars) return texto;
    const inicio = texto.slice(0, Math.floor(maxChars * 0.6));
    const fin = texto.slice(-Math.floor(maxChars * 0.3));
    return `${inicio}\n\n[...mensaje truncado por longitud...]\n\n${fin}`;
}

function calcularTimeout(inputChars) {
    const base = 5000;
    const extra = Math.min(inputChars / 500, 4) * 1000;
    return Math.min(base + extra, 9000);
}

// ── LLAMADA AL MODELO DE IA (compartida por proveedor principal y respaldo) ──
// IMPORTANTE: en undici (fetch de Node), abortar durante la lectura del cuerpo NO
// garantiza que res.json() rechace: si el socket queda colgado, la promesa puede
// no resolverse nunca y Netlify mata la función a los 30s sin responder. Por eso
// se envuelve TODO (fetch + cuerpo) en un Promise.race con plazo duro: la función
// SIEMPRE termina, aunque el abort falle.
async function llamarModelo({ endpoint, apiKey, model, mensajes, timeoutMs, thinkingDisabled = false }) {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    let deadlineTimer = null;
    const deadline = new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => reject(new Error(`Timeout: ${model} no respondió dentro de ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    });
    try {
        const data = await Promise.race([
            (async () => {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model,
                        messages: mensajes,
                        temperature: 0.2,
                        max_tokens: 1024,
                        ...(thinkingDisabled ? { thinking: { type: 'disabled' } } : {})
                    }),
                    signal: controller.signal
                });
                console.log(`${model} respondió con status:`, res.status);

                // El cuerpo llega de forma progresiva y puede tardar mucho; el
                // deadline DEBE cubrir también su lectura: si una generación lenta
                // o un socket colgado no deja terminar json(), el race corta aquí
                // (el abort por sí solo a veces no rechaza en undici).
                return await res.json();
            })(),
            deadline
        ]);
        if (!data || !data.choices) {
            console.error(`Error ${model}:`, data);
            throw new Error(data?.error?.message || `Error en la respuesta de la IA`);
        }

        let contenido = limpiarTextoIA(data.choices[0].message.content);
        // Los modelos de razonamiento pueden agotar el presupuesto de salida solo en
        // reasoning_content y devolver content vacío con finish_reason="length".
        // Evitamos guardar/responder un mensaje en blanco.
        if ((!contenido || !contenido.trim()) && data.choices?.[0]?.finish_reason === 'length') {
            console.warn(`${model} devolvió content vacío (finish_reason=length). Respuesta de respaldo activada.`);
            contenido = "Lo siento, tu solicitud resultó demasiado extensa y no alcancé a completar la respuesta. Intenta dividirla en partes más cortas o reformularla.";
        }

        const apiTokensUsados = data.usage
            ? (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0)
            : null;
        console.log(`Tokens reales de ${model}:`, apiTokensUsados);

        return { respuesta: contenido, apiTokensUsados };
    } finally {
        clearTimeout(abortTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
    }
}

// ── PUSH NOTIFICATIONS ──────────────────────────────────────────────────────
async function dispararPush({ userId, title, body, conversationId, canal = 'web' }) {
    try {
        if (!userId) return;

        const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://auvro.netlify.app';

        const res = await fetch(`${baseUrl}/.netlify/functions/send-push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: userId,
                title: title || 'Nuevo mensaje en AUVRO',
                body: String(body || 'Tienes un nuevo mensaje.').slice(0, 140),
                url: '/dashboard.html#bandeja',
                conversationId: conversationId || null,
                canal
            })
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok || data?.ok === false) {
            console.warn('[Push] No se pudo enviar:', data);
        } else {
            console.log('[Push] Enviado:', data);
        }
    } catch (err) {
        console.warn('[Push] Error enviando:', err.message);
    }
}


// ── HELPERS ──────────────────────────────────────────────────────────────────

function resolverFecha(texto) {
    if (!texto) return null;

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(texto)) {
        return texto.includes('+') || texto.includes('Z') || /-\d{2}:\d{2}$/.test(texto)
            ? texto
            : texto + '-05:00';
    }

    const textoLower = String(texto || "").toLowerCase();

    let hora = null;
    let min = 0;

    const matchHoraCompleta = textoLower.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
    const matchHoraSimple = textoLower.match(/\b(\d{1,2})\s*(am|pm)\b/i);
    const matchHoraSolo = textoLower.match(/\ba las\s+(\d{1,2})\b/i);

    if (matchHoraCompleta) {
        hora = parseInt(matchHoraCompleta[1], 10);
        min = parseInt(matchHoraCompleta[2], 10);

        const periodo = matchHoraCompleta[3]?.toLowerCase();
        if (periodo === 'pm' && hora < 12) hora += 12;
        if (periodo === 'am' && hora === 12) hora = 0;
    } else if (matchHoraSimple) {
        hora = parseInt(matchHoraSimple[1], 10);
        min = 0;

        const periodo = matchHoraSimple[2]?.toLowerCase();
        if (periodo === 'pm' && hora < 12) hora += 12;
        if (periodo === 'am' && hora === 12) hora = 0;
    } else if (matchHoraSolo) {
        hora = parseInt(matchHoraSolo[1], 10);
        min = 0;
    }

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    let fecha = new Date(hoy);

    if (/pasado ma[ñn]ana/i.test(textoLower)) fecha.setDate(fecha.getDate() + 2);
    else if (/ma[ñn]ana/i.test(textoLower)) fecha.setDate(fecha.getDate() + 1);
    else if (/lunes/i.test(textoLower)) while (fecha.getDay() !== 1) fecha.setDate(fecha.getDate() + 1);
    else if (/martes/i.test(textoLower)) while (fecha.getDay() !== 2) fecha.setDate(fecha.getDate() + 1);
    else if (/mi[eé]rcoles/i.test(textoLower)) while (fecha.getDay() !== 3) fecha.setDate(fecha.getDate() + 1);
    else if (/jueves/i.test(textoLower)) while (fecha.getDay() !== 4) fecha.setDate(fecha.getDate() + 1);
    else if (/viernes/i.test(textoLower)) while (fecha.getDay() !== 5) fecha.setDate(fecha.getDate() + 1);

    if (hora === null) {
        return null;
    }

    fecha.setHours(hora, min, 0, 0);

    const pad = n => String(n).padStart(2, '0');
    return `${fecha.getFullYear()}-${pad(fecha.getMonth() + 1)}-${pad(fecha.getDate())}T${pad(fecha.getHours())}:${pad(fecha.getMinutes())}:00-05:00`;
}

function sumarMinutos(fechaIso, minutos = 30) {
    if (!fechaIso) return "";

    const match = String(fechaIso).match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2})$/
    );

    if (!match) return "";

    let [, year, month, day, hour, minute, second, offset] = match;

    let totalMinutos = parseInt(hour, 10) * 60 + parseInt(minute, 10) + minutos;

    let diasExtra = Math.floor(totalMinutos / 1440);
    let minutosDelDia = totalMinutos % 1440;

    if (minutosDelDia < 0) {
        minutosDelDia += 1440;
        diasExtra -= 1;
    }

    const nuevaHora = Math.floor(minutosDelDia / 60);
    const nuevoMinuto = minutosDelDia % 60;

    const baseDate = new Date(Number(year), Number(month) - 1, Number(day));
    baseDate.setDate(baseDate.getDate() + diasExtra);

    const pad = n => String(n).padStart(2, '0');

    return `${baseDate.getFullYear()}-${pad(baseDate.getMonth() + 1)}-${pad(baseDate.getDate())}T${pad(nuevaHora)}:${pad(nuevoMinuto)}:${second}${offset}`;
}

function parseActionPayload(text = "") {
    const raw = String(text || "").trim();

    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch (_) { }

    const sinFence = raw
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```$/i, "")
        .trim();

    try {
        return JSON.parse(sinFence);
    } catch (_) { }

    const match = sinFence.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
        return JSON.parse(match[0]);
    } catch (_) {
        return null;
    }
}

function limpiarTextoIA(text = "") {
    return String(text || "")
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```$/i, "")
        .trim();
}

function normalizarListaCorreos(valor) {
    if (Array.isArray(valor)) {
        return valor.filter(v => typeof v === 'string' && v.trim());
    }

    if (typeof valor === 'string' && valor.trim()) {
        return valor
            .split(',')
            .map(v => v.trim())
            .filter(Boolean);
    }

    return [];
}

function normalizarToolkit(toolkit = "") {
    return String(toolkit || "").toLowerCase();
}

function obtenerConexion(userConnections = [], toolkit = "") {
    const tk = normalizarToolkit(toolkit);
    return (userConnections || []).find(c => normalizarToolkit(c.toolkit) === tk);
}

function toolDisponible(toolsDisponibles = [], toolKey = "") {
    return (toolsDisponibles || []).some(t => t.tool_key === toolKey);
}

function slugificar(nombre = "") {
    return String(nombre || "").toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

function construirPayloadCalendarDesdeAction(actionData = {}, prompt = "") {
    let payload = {
        summary: actionData.summary || actionData.title || "Evento agendado desde el chat",
        description: actionData.description || "",
        start: actionData.start || "",
        end: actionData.end || "",
        attendees: Array.isArray(actionData.attendees) ? actionData.attendees : [],
        contact_name: actionData.contact_name || "",
        contact_email: actionData.contact_email || "",
        contact_phone: actionData.contact_phone || "",
        meeting_reason: actionData.meeting_reason || "",
        location: actionData.location || ""
    };

    payload = enrichCalendarPayloadFromText(payload, prompt);

    const fechaInicio = resolverFecha(payload.start || prompt);
    if (fechaInicio && !payload.start) {
        payload.start = fechaInicio;
    } else if (fechaInicio && payload.start && !/^\d{4}-\d{2}-\d{2}T/.test(payload.start)) {
        payload.start = fechaInicio;
    }

    if (payload.start && !payload.end) {
        payload.end = sumarMinutos(payload.start, 45);
    }

    return payload;
}

function construirPayloadEmailDesdeAction(actionData = {}, prompt = "") {
    return enrichEmailPayloadFromText({
        to: actionData.to || "",
        subject: actionData.subject || "",
        body: actionData.body || "",
        cc: actionData.cc || "",
        bcc: actionData.bcc || ""
    }, prompt);
}

function construirPayloadDriveDesdeAction(actionData = {}, prompt = "") {
    return enrichDrivePayloadFromText({
        query: actionData.query || "",
        folder: actionData.folder || "",
        file_type: actionData.file_type || ""
    }, prompt);
}

async function ejecutarToolComposio(toolSlug, connectedAccountId, userId, args) {
    const res = await fetch(`https://backend.composio.dev/api/v3.1/tools/execute/${toolSlug}`, {
        method: 'POST',
        headers: {
            'x-api-key': process.env.COMPOSIO_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            connected_account_id: connectedAccountId,
            user_id: userId,
            arguments: args
        })
    });

    const raw = await res.text();

    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        throw new Error(`Respuesta inválida de Composio: ${raw}`);
    }

    if (!res.ok) {
        const msg =
            typeof data.error === 'string'
                ? data.error
                : data.error?.message || 'Error ejecutando tool en Composio';
        throw new Error(msg);
    }

    return data;
}

async function registrarConsumo({ agente, targetID, saldoActual, prompt, respuestaIA, apiTokens = null, premiumTokens = 0 }) {
    const tokensBase = apiTokens || Math.ceil(((agente.prompt_sistema || "").length + (prompt || "").length + (respuestaIA || "").length) / 4) + 10;
    const tokensUsados = tokensBase + premiumTokens;

    await supabase
        .from('perfiles')
        .update({ token_balance: saldoActual - tokensUsados })
        .eq('id', agente.user_id);

    await supabase.rpc('increment_agent_consumption', {
        agent_id: targetID,
        tokens: tokensUsados
    });

    await supabase
        .from('logs_consumo')
        .insert([{
            user_id: agente.user_id,
            agente_id: targetID,
            nombre_agente: agente.nombre_agente,
            tokens_usados: tokensUsados
        }]);

    return tokensUsados;
}

async function crearOActualizarPending({
    existingPending,
    userId,
    agenteId,
    conversationId,
    action,
    payload
}) {
    if (existingPending) {
        await supabase
            .from('pending_tool_actions')
            .update({
                action,
                payload,
                status: 'pending',
                expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
            })
            .eq('id', existingPending.id);

        return existingPending.id;
    }

    const { data, error } = await supabase
        .from('pending_tool_actions')
        .insert([{
            user_id: userId,
            agente_id: agenteId,
            conversation_id: conversationId,
            action,
            payload,
            status: 'pending',
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
        }])
        .select('id')
        .single();

    if (error) {
        throw new Error(`No se pudo crear acción pendiente: ${error.message}`);
    }

    return data?.id;
}

async function cancelarPending(pendingId) {
    if (!pendingId) return;

    await supabase
        .from('pending_tool_actions')
        .update({ status: 'cancelled' })
        .eq('id', pendingId);
}

async function marcarPendingEjecutado(pendingId) {
    if (!pendingId) return;

    await supabase
        .from('pending_tool_actions')
        .update({ status: 'executed' })
        .eq('id', pendingId);
}

async function ejecutarCalendar({ pendingAction, agente, targetID, userConnections, saldoActual, prompt }) {
    const calConn = obtenerConexion(userConnections, 'googlecalendar');

    if (!calConn?.composio_entity_id) {
        return {
            statusCode: 400,
            respuesta: "Google Calendar no está conectado."
        };
    }

    const payload = pendingAction.payload || {};
    const attendeesBase = Array.isArray(payload.attendees) ? payload.attendees : [];
    const contactEmail = payload.contact_email || "";

    const attendeesFinal = [...new Set([
        ...attendeesBase,
        ...(contactEmail ? [contactEmail] : [])
    ])].filter(e => e && e.includes('@'));

    const startDatetime = resolverFecha(payload.start);
    const endDatetime = resolverFecha(payload.end) || sumarMinutos(startDatetime, 45);

    const argumentos = {
        summary: payload.summary || "Evento agendado desde el chat",
        description: payload.description || "",
        start_datetime: startDatetime,
        end_datetime: endDatetime,
        attendees: attendeesFinal
    };

    if (payload.location) {
        argumentos.location = payload.location;
    }

    console.log("Ejecutando Calendar con argumentos:", JSON.stringify(argumentos));

    const resultado = await ejecutarToolComposio(
        'GOOGLECALENDAR_CREATE_EVENT',
        calConn.composio_entity_id,
        agente.user_id,
        argumentos
    );

    console.log("Resultado Calendar Composio:", JSON.stringify(resultado));

    await marcarPendingEjecutado(pendingAction.id);

    const meetLink =
        resultado?.data?.response_data?.hangoutLink ||
        resultado?.data?.response_data?.conferenceData?.entryPoints?.[0]?.uri ||
        "";

    const respuestaIA =
        `✅ Listo, agendé "${argumentos.summary}" para el ${argumentos.start_datetime?.split('T')[0]} a las ${argumentos.start_datetime?.split('T')[1]?.substring(0, 5)}.` +
        `${meetLink ? `\n\n🎥 Link de Meet: ${meetLink}` : ""}` +
        `${contactEmail ? `\n\nSe envió invitación a ${contactEmail}.` : ""}`;

    const tokensUsados = await registrarConsumo({
        agente,
        targetID,
        saldoActual,
        prompt,
        respuestaIA
    });

    return {
        statusCode: 200,
        respuesta: respuestaIA,
        tokens_consumidos: tokensUsados
    };
}

async function ejecutarGmail({ pendingAction, agente, targetID, userConnections, saldoActual, prompt }) {
    const gmailConn = obtenerConexion(userConnections, 'gmail');

    if (!gmailConn?.composio_entity_id) {
        return {
            statusCode: 400,
            respuesta: "Gmail no está conectado."
        };
    }

    const payload = pendingAction.payload || {};

    const argumentos = {
        to: payload.to,
        subject: payload.subject,
        body: payload.body,
        cc: normalizarListaCorreos(payload.cc),
        bcc: normalizarListaCorreos(payload.bcc)
    };

    console.log("Ejecutando Gmail con argumentos:", JSON.stringify(argumentos));

    const resultado = await ejecutarToolComposio(
        'GMAIL_SEND_EMAIL',
        gmailConn.composio_entity_id,
        agente.user_id,
        argumentos
    );

    console.log("Resultado Gmail Composio:", JSON.stringify(resultado));

    await marcarPendingEjecutado(pendingAction.id);

    const respuestaIA = resultado?.successful !== false
        ? `✅ Correo enviado a ${payload.to} con asunto "${payload.subject}".`
        : `❌ No pude enviar el correo: ${resultado?.error || 'error desconocido'}`;

    const tokensUsados = await registrarConsumo({
        agente,
        targetID,
        saldoActual,
        prompt,
        respuestaIA
    });

    return {
        statusCode: 200,
        respuesta: respuestaIA,
        tokens_consumidos: tokensUsados
    };
}

async function ejecutarDriveDirecto({ payload, agente, targetID, userConnections, saldoActual, prompt }) {
    const driveConn = obtenerConexion(userConnections, 'googledrive');

    if (!driveConn?.composio_entity_id) {
        return {
            statusCode: 400,
            respuesta: "Google Drive no está conectado."
        };
    }

    const resultado = await ejecutarToolComposio(
        'GOOGLEDRIVE_FIND_FILE',
        driveConn.composio_entity_id,
        agente.user_id,
        {
            query: payload.query,
            folder: payload.folder || "",
            file_type: payload.file_type || ""
        }
    );

    console.log("Resultado Drive Composio:", JSON.stringify(resultado));

    const archivos =
        resultado?.data?.response_data?.files ||
        resultado?.data?.response_data?.items ||
        resultado?.data?.response_data?.results ||
        resultado?.data?.files ||
        resultado?.data?.items ||
        resultado?.data?.results ||
        resultado?.files ||
        resultado?.items ||
        resultado?.results ||
        [];

    const respuestaIA = archivos.length > 0
        ? `Encontré ${archivos.length} archivo(s):\n` +
        archivos.slice(0, 5).map(f => {
            const nombre = f.name || f.title || f.file_name || 'Archivo sin nombre';
            const link = f.webViewLink || f.url || f.link || '';
            return `📄 ${nombre}${link ? ` — ${link}` : ''}`;
        }).join('\n')
        : "No encontré archivos que coincidan con tu búsqueda.";

    const tokensUsados = await registrarConsumo({
        agente,
        targetID,
        saldoActual,
        prompt,
        respuestaIA
    });

    return {
        statusCode: 200,
        respuesta: respuestaIA,
        tokens_consumidos: tokensUsados
    };
}

async function manejarPendingAction({
    pendingAction,
    prompt,
    messageRoute,
    agente,
    targetID,
    userConnections,
    saldoActual
}) {
    if (!pendingAction) return null;

    if (messageRoute === 'workflow_confirm' && esCancelacion(prompt)) {
        await cancelarPending(pendingAction.id);

        return {
            statusCode: 200,
            respuesta: "Entendido, cancelé la acción pendiente."
        };
    }

    if (messageRoute === 'workflow_confirm' && esConfirmacion(prompt)) {
        if (pendingAction.action === 'GOOGLECALENDAR_CREATE_EVENT') {
            return await ejecutarCalendar({
                pendingAction,
                agente,
                targetID,
                userConnections,
                saldoActual,
                prompt
            });
        }

        if (pendingAction.action === 'GMAIL_SEND_EMAIL') {
            return await ejecutarGmail({
                pendingAction,
                agente,
                targetID,
                userConnections,
                saldoActual,
                prompt
            });
        }

        return {
            statusCode: 400,
            respuesta: "No reconozco la acción pendiente para confirmarla."
        };
    }

    if (messageRoute !== 'workflow_collect') {
        return null;
    }

    if (pendingAction.action === 'GMAIL_SEND_EMAIL') {
        const payloadActual = pendingAction.payload || {};
        const payloadEnriquecido = enrichEmailPayloadFromText(payloadActual, prompt);
        const missingFields = getMissingFields('GMAIL_SEND_EMAIL', payloadEnriquecido);

        await supabase
            .from('pending_tool_actions')
            .update({ payload: payloadEnriquecido })
            .eq('id', pendingAction.id);

        console.log("Pending Gmail actualizado:", JSON.stringify(payloadEnriquecido));

        if (missingFields.length > 0) {
            return {
                statusCode: 200,
                respuesta: buildMissingFieldsQuestion('GMAIL_SEND_EMAIL', missingFields)
            };
        }

        return {
            statusCode: 200,
            respuesta: `Voy a enviar un correo a ${payloadEnriquecido.to} con asunto "${payloadEnriquecido.subject}". Responde "sí" para confirmar o "no" para cancelar.`
        };
    }

    if (pendingAction.action === 'GOOGLECALENDAR_CREATE_EVENT') {
        const payloadActual = pendingAction.payload || {};
        let payloadEnriquecido = { ...payloadActual };

        if (seemsContactInfo(prompt)) {
            payloadEnriquecido = enrichCalendarPayloadFromText(payloadEnriquecido, prompt);
        } else {
            payloadEnriquecido = enrichCalendarPayloadFromText(payloadEnriquecido, prompt);
        }

        const fechaResuelta = resolverFecha(prompt);
        if (fechaResuelta && !payloadEnriquecido.start) {
            payloadEnriquecido.start = fechaResuelta;
        }

        if (payloadEnriquecido.start && !payloadEnriquecido.end) {
            payloadEnriquecido.end = sumarMinutos(payloadEnriquecido.start, 45);
        }

        const missingFields = getMissingFields('GOOGLECALENDAR_CREATE_EVENT', payloadEnriquecido);

        await supabase
            .from('pending_tool_actions')
            .update({ payload: payloadEnriquecido })
            .eq('id', pendingAction.id);

        console.log("Pending Calendar actualizado:", JSON.stringify(payloadEnriquecido));

        if (missingFields.length > 0) {
            return {
                statusCode: 200,
                respuesta: buildMissingFieldsQuestion('GOOGLECALENDAR_CREATE_EVENT', missingFields)
            };
        }

        return {
            statusCode: 200,
            respuesta: `Voy a agendar "${payloadEnriquecido.summary}" el ${payloadEnriquecido.start?.split('T')[0]} a las ${payloadEnriquecido.start?.split('T')[1]?.substring(0, 5)} para ${payloadEnriquecido.contact_name} (${payloadEnriquecido.contact_email}). Responde "sí" para confirmar o "no" para cancelar.`
        };
    }

    if (pendingAction.action === 'GOOGLEDRIVE_FIND_FILE') {
        const payloadActual = pendingAction.payload || {};
        const payloadEnriquecido = enrichDrivePayloadFromText(payloadActual, prompt);
        const missingFields = getMissingFields('GOOGLEDRIVE_FIND_FILE', payloadEnriquecido);

        await supabase
            .from('pending_tool_actions')
            .update({ payload: payloadEnriquecido })
            .eq('id', pendingAction.id);

        if (missingFields.length > 0) {
            return {
                statusCode: 200,
                respuesta: buildMissingFieldsQuestion('GOOGLEDRIVE_FIND_FILE', missingFields)
            };
        }

        await marcarPendingEjecutado(pendingAction.id);

        return await ejecutarDriveDirecto({
            payload: payloadEnriquecido,
            agente,
            targetID,
            userConnections,
            saldoActual,
            prompt
        });
    }

    return null;
}

// ── HANDLER ──────────────────────────────────────────────────────────────────

async function obtenerOCrearConversacion({ agente, targetID, canal, externalUserId, conversationId }) {
    /*
      FIX IMPORTANTE:
      Antes se usaba maybeSingle(). Si ya existían duplicados para el mismo
      agente + canal + external_user_id, Supabase devolvía error por múltiples filas.
      El código ignoraba el error y creaba otra conversación nueva en cada mensaje.

      Ahora siempre buscamos con .limit(1) y tomamos la conversación más reciente.
      Así el mismo número de WhatsApp sigue entrando al mismo chat.
    */
    const baseQuery = supabase
        .from('conversaciones')
        .select('*')
        .eq('agente_id', targetID)
        .eq('canal', canal);

    let query;

    if (conversationId && /^[0-9a-f-]{36}$/i.test(String(conversationId))) {
        query = baseQuery.eq('id', conversationId);
    } else {
        query = baseQuery.eq('external_user_id', String(externalUserId || '').trim());
    }

    const { data: conversaciones, error } = await query
        .order('updated_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false, nullsFirst: false })
        .limit(1);

    if (error) {
        console.error("Error buscando conversación:", error);
    }

    const conversacion = Array.isArray(conversaciones) ? conversaciones[0] : null;
    if (conversacion) return conversacion;

    const externalIdFinal = String(externalUserId || conversationId || `${canal}_${targetID}_anon`).trim();

    const { data: nueva, error: insertError } = await supabase
        .from('conversaciones')
        .insert([{
            agente_id: targetID,
            user_id: agente.user_id,
            canal,
            external_user_id: externalIdFinal,
            titulo: canal === 'whatsapp' ? `WhatsApp ${externalIdFinal}` : `Conversación ${canal}`,
            estado: 'ia_activa',
            modo_humano: false,
            requiere_atencion: false,
            ultimo_mensaje: '',
            ultimo_role: 'user',
            updated_at: new Date().toISOString()
        }])
        .select('*')
        .single();

    if (insertError) {
        throw new Error("No se pudo crear conversación: " + insertError.message);
    }

    return nueva;
}

async function cargarHistorialConversacion(conversacionId, limite = 12) {
    const { data, error } = await supabase
        .from('mensajes_conversacion')
        .select('role, content')
        .eq('conversacion_id', conversacionId)
        .order('created_at', { ascending: false })
        .limit(limite);

    if (error) {
        console.error("Error cargando historial:", error);
        return [];
    }

    return (data || []).reverse();
}


async function actualizarResumenConversacion({ conversacionId, ultimoMensaje, ultimoRole, requiereAtencion = null }) {
    const patch = {
        ultimo_mensaje: String(ultimoMensaje || '').slice(0, 1000),
        ultimo_role: ultimoRole,
        updated_at: new Date().toISOString()
    };

    if (requiereAtencion !== null) {
        patch.requiere_atencion = requiereAtencion;
    }

    const { error } = await supabase
        .from('conversaciones')
        .update(patch)
        .eq('id', conversacionId);

    if (error) {
        console.error('Error actualizando resumen de conversación:', error);
    }
}

function debeEscalarAHumano(texto = '') {
    const t = String(texto || '').toLowerCase();
    return /\b(humano|asesor|persona real|agente real|quiero hablar con alguien|representante|no me entiendes|no entiendes|queja|reclamo|molesto|enojado|cancelar servicio|soporte humano)\b/i.test(t);
}

async function guardarMensajeConversacion({ conversacionId, agenteId, role, content, metadata = {} }) {
    if (!content) return;

    const { error } = await supabase
        .from('mensajes_conversacion')
        .insert([{
            conversacion_id: conversacionId,
            agente_id: agenteId,
            role,
            content,
            metadata
        }]);

    if (error) {
        console.error("Error guardando mensaje:", error);
    }
}

// Guarda la respuesta IA evitando duplicados: si la última respuesta de la
// conversación tiene contenido IDÉNTICO y se guardó hace menos de 10s (doble
// envío concurrente del mismo prompt), no insertamos otra copia.
async function guardarRespuestaDeducup({ conversacionId, agenteId, contenido, metadata = {} }) {
    if (!contenido) return;

    try {
        const { data: ultimaResp } = await supabase
            .from('mensajes_conversacion')
            .select('role, content, created_at')
            .eq('conversacion_id', conversacionId)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        const esDuplicado = ultimaResp &&
            (ultimaResp.role === 'assistant' || ultimaResp.role === 'bot') &&
            String(ultimaResp.content || '').trim() === String(contenido || '').trim() &&
            Date.now() - new Date(ultimaResp.created_at).getTime() < 10000;

        if (esDuplicado) {
            console.log('Guard anti-duplicado IA: respuesta idéntica ya guardada, se omite.');
            return;
        }
    } catch (dedupErr) {
        console.warn('Error verificando duplicado IA (se guarda igual):', dedupErr.message);
    }

    await guardarMensajeConversacion({
        conversacionId,
        agenteId,
        role: 'assistant',
        content: contenido,
        metadata
    });
}

// Verifica el token de sesion de Supabase enviado en el header Authorization.
// Devuelve null si NO se envio token (comportamiento widget/anónimo).
// Lanza error con status 401 si el token es inválido o expiró.
async function verificarSesionUsuario(event) {
    const auth = event.headers.authorization || event.headers.Authorization || "";
    if (!auth) return null;

    const token = String(auth).replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
        const err = new Error("Sesión inválida o expirada. Inicia sesión de nuevo.");
        err.status = 401;
        throw err;
    }
    return data.user;
}

exports.handler = async (event) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const {
            prompt,
            agente_id,
            historial = [],
            conversation_id = null,
            canal = "web",
            external_user_id = null,
            image_url = null,
            skip_user_save = false
        } = body;
        const targetID = agente_id || process.env.AGENTE_MAESTRO_ID;
        const usuarioSesion = await verificarSesionUsuario(event);

        if (!prompt || !String(prompt).trim()) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Falta prompt." })
            };
        }



        const { data: agente, error: errAgente } = await supabase
            .from('agentes_ia')
            .select('*')
            .eq('id', targetID)
            .single();

        console.log("ID buscado:", targetID);
        console.log("Agente encontrado:", agente?.nombre_agente);

        if (errAgente || !agente) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ respuesta: "Agente no encontrado." })
            };
        }

        const origin = event.headers.origin || "";

        const esDashboard = origin.includes("auvro.netlify.app");
        const esWhatsapp = canal === "whatsapp";
        const esLocal =
            origin.includes("localhost") ||
            origin.includes("127.0.0.1");

        let dominioActual = "";

        try {
            dominioActual = new URL(origin).hostname;
        } catch (e) {
            dominioActual = "";
        }

        if (!esDashboard && !esWhatsapp && !esLocal) {

            const dominios = agente.dominios_permitidos || [];

            if (dominios.length === 0) {
                return {
                    statusCode: 403,
                    headers,
                    body: JSON.stringify({
                        respuesta: "Seguridad: Este agente no tiene dominios configurados."
                    })
                };
            }


            const dominioAutorizado = dominios.includes(dominioActual);


            if (!dominioAutorizado) {
                return {
                    statusCode: 403,
                    headers,
                    body: JSON.stringify({
                        respuesta: "Seguridad: Este dominio no está autorizado para este agente."
                    })
                };
            }
        }


        const externalUserIdFinal =
            usuarioSesion?.id ||
            external_user_id ||
            conversation_id ||
            `${canal}_${targetID}_anon`;

        let conversationIdSanitizado =
            conversation_id && /^[0-9a-f-]{36}$/i.test(conversation_id) ? conversation_id : null;

        // Si hay sesion autenticada, validamos que la conversacion sea del usuario.
        if (usuarioSesion && conversationIdSanitizado) {
            const { data: convVerif } = await supabase
                .from('conversaciones')
                .select('id, external_user_id, agente_id')
                .eq('id', conversationIdSanitizado)
                .maybeSingle();

            if (convVerif) {
                if (convVerif.external_user_id !== usuarioSesion.id || String(convVerif.agente_id) !== String(targetID)) {
                    return {
                        statusCode: 403,
                        headers,
                        body: JSON.stringify({ error: "No tienes acceso a esta conversación." })
                    };
                }
            } else {
                conversationIdSanitizado = null;
            }
        }

        const conversacion = await obtenerOCrearConversacion({
            agente,
            targetID,
            canal,
            externalUserId: externalUserIdFinal,
            conversationId: conversationIdSanitizado
        });

        const conversationIdFinal = conversacion.id;

        // ── Guard anti-duplicado (canal web) ──
        // Evita que un mismo mensaje del visitante se procese dos veces (doble clic,
        // reintento rápido tras timeout, dos pestañas con el mismo external_user_id).
        // Si el último mensaje de la conversación es un user IGUAL al prompt y se
        // envió hace menos de 20s, no guardamos duplicado ni relanzamos la IA.
        if (canal === 'web' && !skip_user_save && prompt) {
            const { data: ultimosMsgs, error: errUltimos } = await supabase
                .from('mensajes_conversacion')
                .select('role, content, created_at')
                .eq('conversacion_id', conversationIdFinal)
                .order('created_at', { ascending: false })
                .limit(3);

            if (!errUltimos && Array.isArray(ultimosMsgs) && ultimosMsgs.length) {
                const ultimo = ultimosMsgs[0];
                const mismoContenido = ultimo.role === 'user' &&
                    String(ultimo.content || '').trim() === String(prompt || '').trim();
                const hacePoco = Date.now() - new Date(ultimo.created_at).getTime() < 20000;
                if (mismoContenido && hacePoco) {
                    const respuestaYaExiste = ultimosMsgs.find(m =>
                        (m.role === 'assistant' || m.role === 'bot') &&
                        new Date(m.created_at) >= new Date(ultimo.created_at)
                    );
                    console.log('Guard anti-duplicado web activado para', prompt);
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({
                            respuesta: respuestaYaExiste
                                ? respuestaYaExiste.content
                                : "Ya estoy procesando tu mensaje, en un momento te respondo. 👍",
                            skipped: true,
                            motivo: 'duplicado'
                        })
                    };
                }
            }
        }

        // En el flujo de media por WhatsApp, el mensaje del usuario ya fue guardado
        // por whatsapp-webhook.js (con su metadata de adjunto). Con skip_user_save=true
        // evitamos guardarlo dos veces y no re-disparamos el push.
        if (!skip_user_save) {
            await guardarMensajeConversacion({
                conversacionId: conversationIdFinal,
                agenteId: targetID,
                role: 'user',
                content: prompt,
                metadata: { canal, origen: 'cliente', ...(image_url ? { image_url } : {}) }
            });

            await actualizarResumenConversacion({
                conversacionId: conversationIdFinal,
                ultimoMensaje: prompt,
                ultimoRole: 'user',
                requiereAtencion: debeEscalarAHumano(prompt) ? true : null
            });

            // 🔔 Push automático para TODO mensaje entrante del cliente (Web y WhatsApp texto).
            // Se dispara aquí porque chat.js es el punto común para widget web y mensajes WhatsApp de texto.
            await dispararPush({
                userId: agente.user_id,
                title: canal === 'whatsapp'
                    ? `💬 WhatsApp ${externalUserIdFinal ? '+' + externalUserIdFinal : ''}`.trim()
                    : `💬 Nuevo mensaje web`,
                body: prompt,
                conversationId: conversationIdFinal,
                canal
            });
        }

        if (conversacion.modo_humano === true || conversacion.estado === 'modo_humano') {
            await actualizarResumenConversacion({
                conversacionId: conversationIdFinal,
                ultimoMensaje: prompt,
                ultimoRole: 'user',
                requiereAtencion: true
            });

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    respuesta: "Tu mensaje fue recibido. Un asesor humano continuará la conversación.",
                    skipped: true,
                    motivo: 'modo_humano',
                    modo_humano: true,
                    conversation_id: conversationIdFinal
                })
            };
        }

        const [
            historialDB,
            perfilResult,
            agentToolsResult,
            userConnectionsResult,
            pendingActionResult,
            crmConfigResult,
            tiendaPasarelaResult
        ] = await Promise.all([
            cargarHistorialConversacion(conversationIdFinal, 6),
            supabase.from('perfiles').select('token_balance').eq('id', agente.user_id).single(),
            supabase.from('agente_tools').select('tool_key, toolkit, enabled').eq('agente_id', targetID).eq('enabled', true),
            supabase.from('composio_connections').select('toolkit, composio_entity_id, connected_at, shopify_store_url, access_token').eq('user_id', agente.user_id),
            supabase.from('pending_tool_actions').select('*').eq('user_id', agente.user_id).eq('agente_id', targetID).eq('conversation_id', conversationIdFinal).eq('status', 'pending').gte('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle(),
            agente.crm_activo ? obtenerConfigCRM(agente.user_id, agente.id) : Promise.resolve(null),
            agente.tienda_id ? supabase.from('tienda_pasarela').select('*').eq('proyecto_id', agente.tienda_id).maybeSingle() : Promise.resolve({ data: null })
        ]);

        const historialSinDuplicado = (historialDB || []).filter(
            (m, i, arr) => !(i === arr.length - 1 && m.role === 'user' && m.content === prompt)
        );

        const { data: perfil, error: errPerfil } = perfilResult;

        if (errPerfil || !perfil) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ respuesta: "Perfil de usuario no encontrado." })
            };
        }

        const saldoActual = perfil.token_balance ?? 0;

        if (saldoActual < 100) {
            return {
                statusCode: 402,
                headers,
                body: JSON.stringify({ respuesta: "Saldo insuficiente en Jeison.Digital. Por favor, recarga tu cuenta." })
            };
        }

        const { data: agentTools } = agentToolsResult;
        const { data: userConnections } = userConnectionsResult;

        const toolkitsConectados = new Set((userConnections || []).map(c => normalizarToolkit(c.toolkit)));

        const toolsDisponibles = (agentTools || []).filter(t =>
            TOOLKITS_NATIVOS.has(normalizarToolkit(t.toolkit)) ||
            toolkitsConectados.has(normalizarToolkit(t.toolkit))
        );

        console.log("Tools disponibles:", toolsDisponibles.map(t => t.tool_key));

        const { data: pendingAction } = pendingActionResult;

        const tiendaPasarela = tiendaPasarelaResult?.data || null;
        const crmConfig = crmConfigResult || null;
        const crmActivo = agente.crm_activo && crmConfig?.crm_activo === true;

        // Si el agente tiene tienda vinculada, la pasarela Wompi de la tienda
        // tiene prioridad sobre la configuración CRM del agente para los pagos.
        const wompiConfig = tiendaPasarela || crmConfig || null;

        // Catálogo dinámico: si el agente tiene tienda vinculada, usar catálogo
        // de la tienda (tienda_productos); si no, usar catálogo CRM (configuración).
        const tiendaId = agente.tienda_id || null;
        let catalogoCRM = crmActivo && Array.isArray(crmConfig.catalogo) ? crmConfig.catalogo : [];
        let catalogoTienda = [];

        if (tiendaId) {
            catalogoTienda = await obtenerCatalogoTienda(tiendaId);
            if (catalogoTienda.length) catalogoCRM = catalogoTienda;
        }

        console.log("Pending action:", pendingAction ? pendingAction.action : 'ninguno');

        const messageRoute = classifyMessageRoute({
            pendingAction,
            text: prompt
        });

        console.log("Message route:", messageRoute);

        const resultadoPending = await manejarPendingAction({
            pendingAction,
            prompt,
            messageRoute,
            agente,
            targetID,
            userConnections,
            saldoActual
        });

        if (resultadoPending) {
            await guardarMensajeConversacion({
                conversacionId: conversationIdFinal,
                agenteId: targetID,
                role: 'assistant',
                content: resultadoPending.respuesta,
                metadata: { canal, origen: 'ia' }
            });
            await actualizarResumenConversacion({ conversacionId: conversationIdFinal, ultimoMensaje: resultadoPending.respuesta, ultimoRole: 'assistant', requiereAtencion: false });
            return {
                statusCode: resultadoPending.statusCode || 200,
                headers,
                body: JSON.stringify({
                    respuesta: resultadoPending.respuesta,
                    tokens_consumidos: resultadoPending.tokens_consumidos,
                    conversation_id: conversationIdFinal,
                    productos: crmActivo && catalogoCRM.length > 0 ? productosParaCliente(catalogoCRM) : [],
                    tienda_id: tiendaId || null
                })
            };
        }

        const toolsDescription = construirToolsDescription(toolsDisponibles);

        const esSaludoSimple = /^(hola|buenas|buenos días|buenos dias|buen día|buen dia|buenas tardes|buenas noches|hey|hi)\s*$/i.test((prompt || "").trim());

        let systemFinal = agente.prompt_sistema + "\n" + toolsDescription + `

REGLAS DE CONVERSACIÓN:
- Responde primero a la intención concreta del usuario.
- Si el usuario pregunta por servicios, precios, ayuda o soluciones, responde esa pregunta directamente.
- NO repitas el saludo base en cada turno.
- Usa el saludo base solo si el mensaje actual es únicamente un saludo simple y no contiene una solicitud concreta.
- Si el usuario ya expresó una necesidad, continúa desde esa necesidad sin reiniciar la conversación.
- Si hay historial conversacional, continúa con naturalidad y no vuelvas a presentarte.
- Evita responder con "¿en qué necesitas apoyo hoy?" si el usuario ya dijo lo que necesita.

CAPACIDADES:
- Puedes recibir y analizar imágenes que el usuario envíe.
- Cuando el usuario envíe una imagen, analízala en el contexto de lo que se está conversando.
- Responde de forma útil y contextual, no solo describas la imagen.
`;

        if (!esSaludoSimple) {
            systemFinal += `
INSTRUCCIÓN ADICIONAL:
- El mensaje actual NO es un saludo simple. No uses el saludo base. Responde directamente a lo que el usuario pidió.
`;
        }

        if (crmActivo) {
            const camposTexto = (crmConfig.campos_captura && crmConfig.campos_captura.length)
                ? crmConfig.campos_captura.join(', ')
                : 'nombre, telefono, email, interes, preferencias';
            systemFinal += `

## CRM (obligatorio): CAPTURA DE DATOS DEL CLIENTE
Eres el primer punto de contacto del negocio y DEBES capturar datos del cliente para el CRM.
- Pide de forma natural (sin interrogatorio) estos campos: ${camposTexto}.
- Al inicio de la conversación preséntate y pide el nombre. Luego, si aplica, el teléfono/correo.
- Toma nota mental de intereses y preferencias y úsalos para recomendar.
- Si el cliente muestra intención de compra, avanza el flujo hacia el cierre (precio, disponibilidad, forma de pago).
- No inventes datos ni presiones; sé natural y breve.
`;
            if (tiendaId) {
                const textoDeportes = await construirTextoDeportesTienda(tiendaId);
                if (textoDeportes) {
                    systemFinal += `
${truncarMensaje(textoDeportes, 4000)}

REGLAS SOBRE INFORMACIÓN DEPORTIVA:
- Usa SOLO los datos reales listados arriba (deportistas, planes, horarios, visorías, torneos, noticias). NO inventes jugadores, precios, fechas ni logros.
- Si te preguntan por un deportista/plan/visoría que no está en la lista, responde que un asesor te ayuda con más detalle.
- Para inscribir o reservar (visoría, plan del club, clase de cortesía), captura el nombre del interesado/responsable, teléfono/email y, si aplica, la edad, y dilo para que un asesor lo confirme.
`;
                }
            }
            if (catalogoCRM.length > 0) {
                const textoCatalogo = tiendaId && catalogoTienda.length
                    ? truncarMensaje(construirTextoCatalogo({ catalogo: catalogoTienda }), 4000)
                    : truncarMensaje(construirTextoCatalogo(crmConfig), 4000);
                const tienePago = crmConfig.wompi_private_key;
                systemFinal += `
CATÁLOGO DE PRODUCTOS DEL VENDEDOR:
${textoCatalogo}

FLUJO DE VENTA:
1. Ofrece SOLO productos del catálogo con su precio exacto. NO inventes precios ni productos.
2. Confirma con el cliente el producto, la cantidad y, si aplica, la composición del grupo (cuántos adultos, niños y bebés) y los extras.
3. Pide confirmación clara de compra ("si", "comprar", "confirmo").
4. Si el cliente confirma la compra${tienePago ? ', usa la herramienta CRM_GENERAR_PAGO con el "id" EXACTO del producto del catálogo para generar el link de pago y envíalo al cliente.' : ', indica que enviarás el link de pago por WhatsApp (el vendedor lo gestiona).'}
5. Recuérdale al cliente completar el pago para confirmar su pedido.
6. IMPORTANTE: genera el link SOLO para el producto exacto del catálogo (su id). Si el cliente pide algo que NO está en el catálogo, NO uses otro producto ni inventes un id: responde que un asesor gestiona ese pedido.
`;
                if (tienePago) {
                    systemFinal += `
### Para CRM_GENERAR_PAGO:
- Úsala SOLO cuando el cliente confirmó claramente que compra (no antes).
- "productoId": el id exacto del producto del catálogo.
- El total lo calcula el servidor: si el producto tiene tarifas por pasajero, variantes, descuento por cantidad o extras, envía esos datos y NO inventes el monto:
  - "pasajeros": [{ "categoriaId": "<id de la tarifa>", "cantidad": N }, ...] (para tours/servicios por pasajero).
  - "extras": [{ "id": "<id del extra>", "cantidad": N }, ...] (opcional).
  - "cantidad": N (unidades, para productos simples).
  - "varianteId": "<id de la variante>" (opcional).
- "monto" (OPCIONAL y SOLO excepcional): total en pesos, entero, sin puntos ni comas. Úsalo únicamente si el servidor no puede calcular el precio (ej. descuento negociado manualmente).
- Ejemplo precio fijo: { "action": "CRM_GENERAR_PAGO", "data": { "productoId": "1" } }
- Ejemplo tour: { "action": "CRM_GENERAR_PAGO", "data": { "productoId": "p404", "pasajeros": [{ "categoriaId": "b3", "cantidad": 2 }, { "categoriaId": "b2", "cantidad": 1 }], "extras": [{ "id": "e1", "cantidad": 3 }] } }
- Después de generarla, envía el link de pago al cliente y pídele completarlo.

### Para CRM_CALCULAR_PRECIO (mostrar desglose ANTES de cobrar):
- Úsala cuando el cliente pregunta "cuánto sería" o antes de pedir confirmación, sobre todo en tours/servicios por pasajero.
- Envía "productoId" y los mismos campos de pasajeros/extras/cantidad/varianteId que en CRM_GENERAR_PAGO. El servidor valida y devuelve el desglose y el total.
- Cuando confirmen la compra, vuelve a enviar esos mismos datos en CRM_GENERAR_PAGO para que el servidor cobre exactamente ese total.
- Ejemplo: { "action": "CRM_CALCULAR_PRECIO", "data": { "productoId": "p404", "pasajeros": [{ "categoriaId": "b3", "cantidad": 2 }, { "categoriaId": "b2", "cantidad": 1 }] } }
`;
                }
            }
        }

        if (pendingAction) {
            systemFinal += `

## ACCIÓN PENDIENTE EN CURSO
Hay una acción pendiente:
Tipo: ${pendingAction.action}
Datos actuales: ${JSON.stringify(pendingAction.payload || {}, null, 2)}

INSTRUCCIONES:
- Si el usuario completa datos faltantes, responde con JSON de la misma acción o con texto natural si aún falta algo.
- Si el usuario cambia claramente de intención, puedes responder con JSON de la nueva herramienta.
- No fuerces la acción anterior si el usuario la corrigió.
`;
        }

        const promptTruncado = truncarMensaje(prompt, 2000);

        const imageInstruction = image_url
            ? `\n\nEl usuario ha enviado una imagen. Analízala en el contexto de la conversación. Si el usuario pregunta algo sobre la imagen, respóndele directamente. Si la imagen es relevante para algo que se discutió antes, úsala. Si no hay contexto previo relacionado, describe lo que ves de forma útil y concisa. No digas "no puedo ver imágenes" — sí puedes verlas.`
            : '';

        const userMessage = image_url
            ? { role: "user", content: [
                { type: "text", text: promptTruncado + imageInstruction },
                { type: "image_url", image_url: { url: image_url } }
            ]}
            : { role: "user", content: promptTruncado };

        const mensajes = [
            { role: "system", content: systemFinal },
            ...historialSinDuplicado.slice(-6).map(m => ({
                ...m,
                content: Array.isArray(m.content) ? m.content : truncarMensaje(m.content, 1200)
            })),
            userMessage
        ];

        const inputChars = mensajes.reduce((sum, m) => {
            if (Array.isArray(m.content)) {
                return sum + m.content.reduce((s, p) => s + (p.text?.length || 0), 0);
            }
            return sum + (m.content?.length || 0);
        }, 0);

        console.log("Turnos de historial enviados a DeepSeek:", historialDB.length);
        console.log("Conversation ID final:", conversationIdFinal);
        console.log("Caracteres input total:", inputChars);
        const useOpenAI = !!image_url;

        // ── LLAMADA AL MODELO con respaldo automático ──
        // DeepSeek es el proveedor principal (rápido y económico). Si tarda más de
        // 16s o falla, respondemos con un modelo de respaldo (OpenAI gpt-4o-mini por
        // defecto) para que el cliente nunca se quede sin respuesta. Presupuesto
        // total de la IA: ~24s — por debajo del límite de ejecución de Netlify (30s)
        // para poder devolver un error elegante si ambos proveedores fallan.
        let respuestaIA = null;
        let apiTokensUsados = null;
        let proveedorIA = null;

        if (useOpenAI) {
            // Visión: solo OpenAI (gpt-4o). No hay proveedor secundario de imágenes.
            if (!process.env.OPENIA_KEY) {
                throw new Error("OPENIA_KEY no configurada en el servidor");
            }
            const resultado = await llamarModelo({
                endpoint: 'https://api.openai.com/v1/chat/completions',
                apiKey: process.env.OPENIA_KEY,
                model: 'gpt-4o',
                mensajes,
                timeoutMs: calcularTimeout(inputChars)
            });
            respuestaIA = resultado.respuesta;
            apiTokensUsados = resultado.apiTokensUsados;
            proveedorIA = 'gpt-4o';
        } else {
            if (!process.env.DEEPSEEK_API_KEY) {
                throw new Error("DEEPSEEK_API_KEY no configurada en el servidor");
            }
            const fallbackKey = process.env.FALLBACK_API_KEY || process.env.OPENIA_KEY;
            const fallbackEndpoint = process.env.FALLBACK_API_URL || 'https://api.openai.com/v1/chat/completions';
            const fallbackModel = process.env.FALLBACK_MODEL || 'gpt-4o-mini';

            let resultado = null;
            let ultimoError = null;
            let proveedor = 'deepseek-v4-flash';
            try {
                console.log("Llamando a DeepSeek...");
                resultado = await llamarModelo({
                    endpoint: 'https://api.deepseek.com/v1/chat/completions',
                    apiKey: process.env.DEEPSEEK_API_KEY,
                    model: 'deepseek-v4-flash',
                    mensajes,
                    timeoutMs: 16000,
                    thinkingDisabled: true
                });
            } catch (err) {
                ultimoError = err;
                console.warn("DeepSeek falló (tiempo o error), probando modelo de respaldo:", err.message);
            }
            if (!resultado && fallbackKey) {
                try {
                    proveedor = fallbackModel;
                    console.log(`Llamando al modelo de respaldo ${fallbackModel}...`);
                    resultado = await llamarModelo({
                        endpoint: fallbackEndpoint,
                        apiKey: fallbackKey,
                        model: fallbackModel,
                        mensajes,
                        timeoutMs: 6000
                    });
                } catch (err2) {
                    ultimoError = err2;
                    console.warn("El modelo de respaldo también falló:", err2.message);
                }
            }
            if (!resultado) {
                throw ultimoError || new Error("No se obtuvo respuesta de la IA");
            }
            respuestaIA = resultado.respuesta;
            apiTokensUsados = resultado.apiTokensUsados;
            proveedorIA = proveedor;
        }
        console.log("Respuesta raw IA:", respuestaIA);

        const actionPayload = parseActionPayload(respuestaIA);
        console.log("Action payload parseado:", actionPayload ? actionPayload.action : 'null');

        // ── CRM: CALCULAR PRECIO (desglose previo al cobro) ──
        // El servidor valida la composición del grupo (adultos/niños/bebés) y
        // calcula el total. La IA solo transporta los datos, no hace aritmética.
        if (actionPayload?.action === 'CRM_CALCULAR_PRECIO') {
            const accData = actionPayload.data || {};
            const productoId = String(accData.productoId || accData.producto || '');
            const producto = catalogoCRM.find(p => String(p.id) === productoId);

            if (!crmActivo) {
                respuestaIA = "El CRM de ventas no está habilitado para este agente.";
            } else if (!producto) {
                respuestaIA = "Ese producto no está en el catálogo. Solo puedo calcular precios de los productos del vendedor.";
            } else {
                const calc = calcularPrecioProducto({
                    producto,
                    pasajeros: Array.isArray(accData.pasajeros) ? accData.pasajeros : [],
                    extras: Array.isArray(accData.extras) ? accData.extras : [],
                    cantidad: Number(accData.cantidad) || 1,
                    varianteId: accData.varianteId || null
                });
                if (!calc.valido) {
                    respuestaIA = "Aún no puedo calcular el total:\n" + calc.errores.map(e => `• ${e}`).join('\n') + "\n\nDime la composición exacta del grupo para recalcular.";
                } else {
                    const lineas = calc.desglose.map(d =>
                        `• ${d.nombre}${d.cantidad > 1 ? ` × ${d.cantidad}` : ''}: $${Math.round(d.subtotal_cents / 100).toLocaleString('es-CO')} COP`
                    );
                    respuestaIA = `📋 Desglose:\n${lineas.join('\n')}\n\n**Total: $${Math.round(calc.total_cents / 100).toLocaleString('es-CO')} COP**\n\n¿Confirmas la compra para generar tu link de pago?`;
                }
            }
            await guardarMensajeConversacion({
                conversacionId: conversationIdFinal,
                agenteId: targetID,
                role: 'assistant',
                content: respuestaIA,
                metadata: { canal, action: 'CRM_CALCULAR_PRECIO', origen: 'ia' }
            });
            await actualizarResumenConversacion({ conversacionId: conversationIdFinal, ultimoMensaje: respuestaIA, ultimoRole: 'assistant', requiereAtencion: false });
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    respuesta: respuestaIA,
                    tokens_consumidos: apiTokensUsados,
                    conversation_id: conversationIdFinal,
                    proveedor: proveedorIA
                })
            };
        }

        // ── CRM: GENERAR PAGO EN CHAT (venta del catálogo del vendedor) ──
        if (actionPayload?.action === 'CRM_GENERAR_PAGO') {
            const accData = actionPayload.data || {};
            const productoId = String(accData.productoId || accData.producto || '');
            const producto = catalogoCRM.find(p => String(p.id) === productoId);

            let montoCents = null;

            if (!crmActivo) {
                respuestaIA = "El CRM de ventas no está habilitado para este agente.";
            } else if (!producto) {
                respuestaIA = "Ese producto no está disponible para pago en línea. Solo puedo generar links de los productos del catálogo. Un asesor puede gestionar tu pedido.";
            } else {
                // Cálculo server-side: cuando hay composición de grupo (tour),
                // variantes, extras o cantidad, el servidor calcula el total.
                const usaCalculo = (producto.tipo === 'tour'
                        && Array.isArray(producto.categorias_pasajero)
                        && producto.categorias_pasajero.length > 0)
                    || Array.isArray(accData.pasajeros)
                    || Array.isArray(accData.extras)
                    || accData.cantidad != null
                    || accData.varianteId != null;

                if (usaCalculo) {
                    const calc = calcularPrecioProducto({
                        producto,
                        pasajeros: Array.isArray(accData.pasajeros) ? accData.pasajeros : [],
                        extras: Array.isArray(accData.extras) ? accData.extras : [],
                        cantidad: Number(accData.cantidad) || 1,
                        varianteId: accData.varianteId || null
                    });
                    if (!calc.valido) {
                        respuestaIA = "No puedo generar el pago todavía:\n" + calc.errores.map(e => `• ${e}`).join('\n') + "\n\nConfirma la composición del grupo para continuar.";
                    } else {
                        montoCents = calc.total_cents;
                    }
                } else {
                    // Monto explícito (excepcional, ej. descuento negociado): el
                    // agente puede enviar "monto_cents" (centavos) o "monto"
                    // (pesos enteros). Se normaliza quitando separadores de miles.
                    if (accData.monto_cents != null) {
                        const n = Number(String(accData.monto_cents).replace(/[^\d]/g, ''));
                        if (n > 0) montoCents = n;
                    } else if (accData.monto != null) {
                        const n = Number(String(accData.monto).replace(/[^\d]/g, ''));
                        if (n > 0) montoCents = Math.round(n * 100);
                    }
                }

                if (montoCents !== null || !usaCalculo) {
                    // montoCents null en producto simple => crearPaymentLinkVenta
                    // usa el precio del catálogo (comportamiento original).
                    const leadId = await obtenerOCrearLead({
                        agente,
                        canal,
                        externalUserId: externalUserIdFinal,
                        conversacionId: conversationIdFinal
                    });
                    const resultado = await crearPaymentLinkVenta({
                        config: wompiConfig,
                        agente,
                        leadId,
                        conversacionId: conversationIdFinal,
                        producto,
                        canal,
                        externalUserId: externalUserIdFinal,
                        montoCents
                    });
                    if (resultado.ok && resultado.url) {
                        const montoPesos = resultado.monto_cents ? Math.round(resultado.monto_cents / 100).toLocaleString('es-CO') : '';
                        respuestaIA = `✅ Listo ${leadId ? '' : ''}, aquí tienes tu link de pago seguro:\n\n${resultado.url}\n\nValor a pagar: $${montoPesos} COP\n\nCompleta el pago para confirmar tu ${producto.nombre}. Cuando esté aprobado, tu pedido queda confirmado automáticamente. ¡Gracias por tu compra!`;
                    } else {
                        respuestaIA = `Lo siento, no pude generar el link de pago en este momento. ${resultado.error || 'Intenta de nuevo más tarde.'} Puedes escribirnos por WhatsApp para coordinar.`;
                    }
                }
            }
            await guardarMensajeConversacion({
                conversacionId: conversationIdFinal,
                agenteId: targetID,
                role: 'assistant',
                content: respuestaIA,
                metadata: { canal, action: 'CRM_GENERAR_PAGO', origen: 'ia' }
            });
            await actualizarResumenConversacion({ conversacionId: conversationIdFinal, ultimoMensaje: respuestaIA, ultimoRole: 'assistant', requiereAtencion: false });
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    respuesta: respuestaIA,
                    tokens_consumidos: apiTokensUsados,
                    conversation_id: conversationIdFinal,
                    proveedor: proveedorIA
                })
            };
        }

        // ── WEB FACTORY: CREAR DEMO EN LA CONVERSACIÓN (solo admin) ──
        // El agente vende la demo: recopila nombre/cliente/plantilla y genera el
        // sitio con el pipeline de Web Factory. Solo el dueño del agente (admin)
        // puede activarlo (integración en "Integraciones del agente").
        if (actionPayload?.action === 'WEBFACTORY_CREAR_DEMO') {
            try {
                if (!toolDisponible(toolsDisponibles, 'WEBFACTORY_CREAR_DEMO')) {
                    respuestaIA = "La integración de Web Factory (crear demos) no está habilitada para este agente. El dueño debe activarla en Integraciones del agente.";
                } else {
                    const { data: perfilAdmin, error: errAdmin } = await supabase
                        .from('perfiles')
                        .select('is_admin')
                        .eq('id', agente.user_id)
                        .maybeSingle();
                    if (errAdmin) {
                        respuestaIA = "No pude verificar los permisos para crear la demo. Intenta de nuevo.";
                    } else if (!perfilAdmin?.is_admin) {
                        respuestaIA = "Crear demos de sitios web solo está disponible para el administrador. Cuéntame qué negocio quieres mostrar y un asesor te guiará.";
                    } else {
                        const accData = actionPayload.data || {};
                        const nombre = String(accData.nombre || accData.negocio || '').trim();
                        const cliente = String(accData.cliente || accData.usuario || '').trim();
                        let slug = String(accData.slug || '').trim().toLowerCase() || slugificar(nombre);
                        const plantilla = String(accData.plantilla || '').trim().toLowerCase() || 'landing';

                        if (!nombre || !cliente) {
                            respuestaIA = "Para crear tu demo necesito el nombre del negocio y el tuyo. ¿Me los compartes?";
                        } else if (!validarSlug(slug)) {
                            respuestaIA = "El subdominio solicitado no es válido. Usa solo minúsculas, números y guiones. ¿Quieres que lo genere automáticamente?";
                        } else {
                            const bodyDemo = {
                                cliente,
                                nombre,
                                slug,
                                plantilla,
                                descripcion: String(accData.descripcion || '').trim() || null,
                                logo: String(accData.logo || '').trim() || null,
                                slogan: String(accData.slogan || '').trim() || null,
                                whatsapp: String(accData.whatsapp || '').trim() || null,
                                dominio: null,
                                agente_id: targetID
                            };
                            const resultado = await pipelineCrear(bodyDemo, agente.user_id);
                            const { data: proyectoCreado } = await supabase
                                .from('web_projects')
                                .select('*')
                                .eq('id', resultado.id)
                                .maybeSingle();
                            if (proyectoCreado?.netlify_url) {
                                respuestaIA = `🎉 ¡Demo creada ${nombre}!\n\nTu sitio está disponible en:\n🔗 ${proyectoCreado.netlify_url}\n\nPuede tardar un par de minutos en terminar de desplegarse. ¿Te gustaría que ajuste algo del diseño o el contenido?`;
                            } else {
                                respuestaIA = `✅ La demo de ${nombre} quedó en proceso de creación. En unos minutos te comparto el enlace.`;
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("web-factory demo error:", err);
                respuestaIA = `Lo siento, no pude crear la demo en este momento: ${err.message || 'error interno'}. Verifica que GITHUB_TOKEN y NETLIFY_AUTH_TOKEN estén configurados en las variables de entorno.`;
            }
            await guardarMensajeConversacion({
                conversacionId: conversationIdFinal,
                agenteId: targetID,
                role: 'assistant',
                content: respuestaIA,
                metadata: { canal, action: 'WEBFACTORY_CREAR_DEMO', origen: 'ia' }
            });
            await actualizarResumenConversacion({ conversacionId: conversationIdFinal, ultimoMensaje: respuestaIA, ultimoRole: 'assistant', requiereAtencion: false });
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    respuesta: respuestaIA,
                    tokens_consumidos: apiTokensUsados,
                    conversation_id: conversationIdFinal,
                    proveedor: proveedorIA
                })
            };
        }

        if (actionPayload?.action === 'GOOGLECALENDAR_CREATE_EVENT') {
            if (!toolDisponible(toolsDisponibles, 'GOOGLECALENDAR_CREATE_EVENT')) {
                respuestaIA = "Google Calendar no está habilitado para este agente.";
            } else {
                if (pendingAction && pendingAction.action !== 'GOOGLECALENDAR_CREATE_EVENT') {
                    await cancelarPending(pendingAction.id);
                }

                const payloadCalendar = construirPayloadCalendarDesdeAction(actionPayload.data || {}, prompt);
                const missingFields = getMissingFields('GOOGLECALENDAR_CREATE_EVENT', payloadCalendar);

                await crearOActualizarPending({
                    existingPending: pendingAction?.action === 'GOOGLECALENDAR_CREATE_EVENT' ? pendingAction : null,
                    userId: agente.user_id,
                    agenteId: targetID,
                    conversationId: conversationIdFinal,
                    action: 'GOOGLECALENDAR_CREATE_EVENT',
                    payload: payloadCalendar
                });

                if (missingFields.length > 0) {
                    respuestaIA = buildMissingFieldsQuestion('GOOGLECALENDAR_CREATE_EVENT', missingFields);
                } else {
                    respuestaIA = `Voy a agendar "${payloadCalendar.summary}" el ${payloadCalendar.start?.split('T')[0]} a las ${payloadCalendar.start?.split('T')[1]?.substring(0, 5)} para ${payloadCalendar.contact_name} (${payloadCalendar.contact_email}). Responde "sí" para confirmar o "no" para cancelar.`;
                }
            }
        }
        if (actionPayload?.action === 'GMAIL_FETCH_EMAILS') {
            if (!toolDisponible(toolsDisponibles, 'GMAIL_FETCH_EMAILS')) {
                respuestaIA = "Gmail lectura no está habilitada para este agente.";
            } else {
                const gmailConn = obtenerConexion(userConnections, 'gmail');

                if (!gmailConn?.composio_entity_id) {
                    await guardarMensajeConversacion({
                        conversacionId: conversationIdFinal,
                        agenteId: targetID,
                        role: 'assistant',
                        content: "Gmail no está conectado para este usuario.",
                        metadata: { canal, action: 'GMAIL_FETCH_EMAILS', origen: 'ia' }
                    });
                    await actualizarResumenConversacion({ conversacionId: conversationIdFinal, ultimoMensaje: 'Gmail no está conectado para este usuario.', ultimoRole: 'assistant', requiereAtencion: true });
                    return {
                        statusCode: 400,
                        headers,
                        body: JSON.stringify({
                            respuesta: "Gmail no está conectado para este usuario.",
                            conversation_id: conversationIdFinal
                        })
                    };
                }

                const payloadGmail = {
                    query: actionPayload.data?.query || 'in:inbox',
                    max_results: actionPayload.data?.max_results || 2
                };

                const resultado = await ejecutarToolComposio(
                    'GMAIL_FETCH_EMAILS',
                    gmailConn.composio_entity_id,
                    agente.user_id,
                    payloadGmail
                );

                console.log("Resultado Gmail Fetch:", JSON.stringify(resultado));

                const correos =
                    resultado?.data?.response_data?.messages ||
                    resultado?.data?.response_data?.emails ||
                    resultado?.data?.messages ||
                    resultado?.data?.emails ||
                    resultado?.messages ||
                    resultado?.emails ||
                    [];

                if (!correos.length) {
                    respuestaIA = "No encontré correos recientes en tu bandeja.";
                } else {
                    respuestaIA = "Encontré estos correos recientes:\n\n" + correos.slice(0, payloadGmail.max_results).map((c, i) => {
                        const from = c.from || c.sender || c.from_email || 'Remitente no disponible';
                        const subject = c.subject || 'Sin asunto';
                        const snippet = c.snippet || c.body_preview || c.text || c.body || '';
                        return `${i + 1}. De: ${from}\nAsunto: ${subject}\nResumen: ${String(snippet).slice(0, 300)}`;
                    }).join("\n\n");
                }
            }
        }
        if (actionPayload?.action === 'GMAIL_SEND_EMAIL') {
            if (!toolDisponible(toolsDisponibles, 'GMAIL_SEND_EMAIL')) {
                respuestaIA = "Gmail no está habilitado para este agente.";
            } else {
                if (pendingAction && pendingAction.action !== 'GMAIL_SEND_EMAIL') {
                    await cancelarPending(pendingAction.id);
                }

                const payloadEmail = construirPayloadEmailDesdeAction(actionPayload.data || {}, prompt);
                const missingEmail = getMissingFields('GMAIL_SEND_EMAIL', payloadEmail);

                await crearOActualizarPending({
                    existingPending: pendingAction?.action === 'GMAIL_SEND_EMAIL' ? pendingAction : null,
                    userId: agente.user_id,
                    agenteId: targetID,
                    conversationId: conversationIdFinal,
                    action: 'GMAIL_SEND_EMAIL',
                    payload: payloadEmail
                });

                if (missingEmail.length > 0) {
                    respuestaIA = buildMissingFieldsQuestion('GMAIL_SEND_EMAIL', missingEmail);
                } else {
                    respuestaIA = `Voy a enviar un correo a ${payloadEmail.to} con asunto "${payloadEmail.subject}". Responde "sí" para confirmar o "no" para cancelar.`;
                }
            }
        }

        if (actionPayload?.action === 'GOOGLEDRIVE_FIND_FILE') {
            if (!toolDisponible(toolsDisponibles, 'GOOGLEDRIVE_FIND_FILE')) {
                respuestaIA = "Google Drive no está habilitado para este agente.";
            } else {
                const payloadDrive = construirPayloadDriveDesdeAction(actionPayload.data || {}, prompt);
                const missingDrive = getMissingFields('GOOGLEDRIVE_FIND_FILE', payloadDrive);

                if (missingDrive.length > 0) {
                    await crearOActualizarPending({
                        existingPending: pendingAction?.action === 'GOOGLEDRIVE_FIND_FILE' ? pendingAction : null,
                        userId: agente.user_id,
                        agenteId: targetID,
                        conversationId: conversationIdFinal,
                        action: 'GOOGLEDRIVE_FIND_FILE',
                        payload: payloadDrive
                    });

                    respuestaIA = buildMissingFieldsQuestion('GOOGLEDRIVE_FIND_FILE', missingDrive);
                } else {
                    const driveResult = await ejecutarDriveDirecto({
                        payload: payloadDrive,
                        agente,
                        targetID,
                        userConnections,
                        saldoActual,
                        prompt
                    });
                    await guardarMensajeConversacion({
                        conversacionId: conversationIdFinal,
                        agenteId: targetID,
                        role: 'assistant',
                        content: driveResult.respuesta,
                        metadata: { canal, action: 'GOOGLEDRIVE_FIND_FILE', origen: 'ia' }
                    });
                    await actualizarResumenConversacion({ conversacionId: conversationIdFinal, ultimoMensaje: driveResult.respuesta, ultimoRole: 'assistant', requiereAtencion: false });
                    return {

                        statusCode: driveResult.statusCode || 200,
                        headers,
                        body: JSON.stringify({
                            respuesta: driveResult.respuesta,
                            tokens_consumidos: driveResult.tokens_consumidos,
                            conversation_id: conversationIdFinal
                        })
                    };
                }
            }
        }

        // ── SITE EDIT: Editor AI conversacional de contenido web ──
        // Flujo: analyze (propuesta) → usuario aprueba → execute (aplicar) → undo (revertir)
        // Lee archivos del repositorio GitHub, llama IA, propone cambios, aplica solo con aprobación.
        if (actionPayload?.action === 'SITE_EDIT_CONTENT') {
            try {
                if (!toolDisponible(toolsDisponibles, 'SITE_EDIT_CONTENT')) {
                    respuestaIA = "La edición de contenido web no está habilitada para este agente.";
                } else {
                    const accData = actionPayload.data || {};
                    const instruction = String(accData.instruction || '').trim();
                    const proyectoId = accData.proyecto_id || null;
                    const mode = accData.mode || 'analyze'; // 'analyze' | 'execute' | 'undo'
                    const prevSha = accData.previous_sha || null;
                    const prevCambios = accData.cambios || null;

                    if (!instruction && mode !== 'undo') {
                        respuestaIA = "¿Qué quieres cambiar en tu sitio web? Describe el cambio específico (ej: cambiar el teléfono, actualizar la dirección, modificar un color).";
                    } else {
                        // ── 1. Buscar el proyecto ──
                        let pid = proyectoId;
                        if (!pid) {
                            const { data: proyectos } = await supabase
                                .from('web_projects').select('id')
                                .eq('created_by', user.id).limit(1);
                            pid = proyectos?.[0]?.id;
                        }
                        if (!pid) {
                            respuestaIA = "No encontré un sitio web asociado a tu cuenta. Primero crea uno con Web Factory.";
                        } else {
                            const { data: proyecto } = await supabase
                                .from('web_projects').select('*').eq('id', pid).maybeSingle();
                            if (!proyecto) {
                                respuestaIA = "No encontré el proyecto solicitado.";
                            } else {
                                const owner = proyecto.github_owner || 'JeisonCastro';
                                const repo = proyecto.github_repo || proyecto.slug;
                                const branch = proyecto.default_branch || 'main';
                                const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
                                const ghBase = `https://api.github.com/repos/${owner}/${repo}`;
                                const ghHeaders = { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };

                                const ghRead = async (path) => {
                                    const r = await fetch(`${ghBase}/contents/${path}?ref=${branch}`, { headers: ghHeaders });
                                    if (!r.ok) return null;
                                    const d = await r.json();
                                    return { content: Buffer.from(d.content, 'base64').toString('utf-8'), sha: d.sha };
                                };

                                const ghGetLastCommit = async () => {
                                    const r = await fetch(`${ghBase}/commits?sha=${branch}&per_page=1`, { headers: ghHeaders });
                                    if (!r.ok) return null;
                                    const d = await r.json();
                                    return d?.[0]?.sha || null;
                                };

                                // ── 2. Leer tokens del usuario ──
                                const { data: perfil } = await supabase.from('perfiles').select('token_balance').eq('id', user.id).maybeSingle();
                                const tokens = perfil?.token_balance || 0;
                                if (tokens <= 0) {
                                    respuestaIA = "No tienes tokens suficientes. Recarga tokens para poder editar tu sitio.";
                                } else {

                                    // ── UNDO ──
                                    if (mode === 'undo' && prevSha) {
                                        try {
                                            const refRes = await fetch(`${ghBase}/git/refs/heads/${branch}`, { headers: ghHeaders });
                                            if (refRes.ok) {
                                                await fetch(`${ghBase}/git/refs/heads/${branch}`, {
                                                    method: 'PATCH', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ sha: prevSha, force: false })
                                                });
                                                respuestaIA = 'Cambios revertidos. Tu sitio se está restaurando.';
                                            } else {
                                                respuestaIA = 'No se pudo revertir los cambios.';
                                            }
                                        } catch (_) {
                                            respuestaIA = 'Error al intentar revertir.';
                                        }
                                    }
                                    // ── EXECUTE (aplicar cambios aprobados) ──
                                    else if (mode === 'execute' && prevCambios && prevCambios.length > 0) {
                                        const indexFile = await ghRead('index.html');
                                        if (!indexFile) {
                                            respuestaIA = "No pude leer index.html del repositorio.";
                                        } else {
                                            // Aplicar SEARCH/REPLACE
                                            let newHtml = indexFile.content;
                                            let applied = 0;
                                            for (const r of prevCambios) {
                                                if (newHtml.includes(r.search)) {
                                                    newHtml = newHtml.split(r.search).join(r.replace);
                                                    applied++;
                                                }
                                            }
                                            if (applied === 0) {
                                                respuestaIA = "Ningún cambio coincide con el HTML actual. Los textos pueden haber cambiado. Pídeme que analice de nuevo.";
                                            } else {
                                                const lower = newHtml.toLowerCase();
                                                if (!(lower.includes('<head') && lower.includes('<body') && lower.includes('</html>'))) {
                                                    respuestaIA = "El resultado no es HTML válido. No apliqué los cambios.";
                                                } else {
                                                    // Obtener SHA previo para undo
                                                    const shaBefore = prevSha || await ghGetLastCommit();
                                                    // Commit
                                                    const commitRes = await fetch(`${ghBase}/contents/index.html`, {
                                                        method: 'PUT', headers: ghHeaders,
                                                        body: JSON.stringify({
                                                            message: `edit: ${instruction.substring(0, 80)}`,
                                                            content: Buffer.from(newHtml, 'utf-8').toString('base64'),
                                                            sha: indexFile.sha, branch
                                                        })
                                                    });
                                                    if (!commitRes.ok) {
                                                        respuestaIA = "No pude guardar los cambios en GitHub.";
                                                    } else {
                                                        const tokensUsed = Math.ceil((applied * 50 + newHtml.length) / 4) + 10;
                                                        const tokensRestantes = Math.max(0, tokens - tokensUsed);
                                                        await supabase.from('perfiles').update({ token_balance: tokensRestantes }).eq('id', user.id);
                                                        await supabase.from('logs_consumo').insert({
                                                            user_id: user.id, agente_id: targetID,
                                                            nombre_agente: 'Editor IA Web',
                                                            tokens_usados: tokensUsed,
                                                            tipo: 'edicion_web'
                                                        });
                                                        respuestaIA = `✅ Cambios aplicados (${applied} búsqueda/reemplazo). ${tokensUsed} tokens consumidos. Sitio actualizándose en ~60s.\n\nPara deshacer, dime "deshacer" y envía este código: \`${shaBefore}\``;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    // ── ANALYZE (conversacional: analiza → propone → espera aprobación) ──
                                    else {
                                        const indexFile = await ghRead('index.html');
                                        if (!indexFile) {
                                            respuestaIA = "No pude leer index.html del repositorio. Verifica que el proyecto tenga archivos.";
                                        } else {
                                            // Leer docs/ para contexto
                                            let docsContenido = '';
                                            try {
                                                const docsRes = await fetch(`${ghBase}/contents/docs?ref=${branch}`, { headers: ghHeaders });
                                                if (docsRes.ok) {
                                                    const docsList = await docsRes.json();
                                                    if (Array.isArray(docsList)) {
                                                        const mdFiles = docsList.filter(f => f.type === 'file' && f.name.endsWith('.md'));
                                                        for (const f of mdFiles) {
                                                            const fData = await ghRead(`docs/${f.name}`);
                                                            if (fData) docsContenido += `--- ${f.name} ---\n${fData.content}\n\n`;
                                                        }
                                                    }
                                                }
                                            } catch (_) {}

                                            // Extraer contexto relevante del HTML
                                            const fullHtml = indexFile.content;
                                            const instrLower = instruction.toLowerCase();
                                            const instructionWords = instrLower.split(/\s+/).filter(w => w.length > 3);
                                            const relevantSections = [];
                                            const htmlLines = fullHtml.split('\n');

                                            for (const word of instructionWords) {
                                                for (let i = 0; i < htmlLines.length; i++) {
                                                    if (htmlLines[i].toLowerCase().includes(word)) {
                                                        const start = Math.max(0, i - 8);
                                                        const end = Math.min(htmlLines.length, i + 9);
                                                        const section = htmlLines.slice(start, end).join('\n');
                                                        if (!relevantSections.some(s => s.includes(section.substring(0, 100)))) {
                                                            relevantSections.push('...línea ' + (i+1) + '...\n' + section);
                                                        }
                                                    }
                                                }
                                            }

                                            const contextHtml = relevantSections.length > 0
                                                ? relevantSections.join('\n\n---\n\n')
                                                : fullHtml.substring(0, 5000);

                                            const docsSection = docsContenido
                                                ? `\n\nDOCUMENTACIÓN DEL PROYECTO:\n${docsContenido}`
                                                : '';

                                            // Evaluar riesgo
                                            const riesgosAlto = ['borrar', 'eliminar', 'quitar', 'reset', 'reiniciar', 'reemplazar todo', 'nuevo html', 'rebuild'];
                                            const riesgosMedio = ['cambiar', 'modificar', 'actualizar', 'mover', 'reordenar', 'agregar sección'];
                                            let riesgo = 'bajo';
                                            if (riesgosAlto.some(r => instrLower.includes(r))) riesgo = 'alto';
                                            else if (riesgosMedio.some(r => instrLower.includes(r))) riesgo = 'medio';

                                            const systemPrompt = `Eres un asistente de desarrollo web conversacional. Analizas lo que el usuario quiere cambiar en su sitio y propones una solución.

REGLAS:
1. Responde como un humano: cálido, claro, directo.
2. Primero analiza qué se pide, luego propone una solución concreta.
3. Si hay riesgo alto (ej: borrar contenido), advierte antes de proponer.
4. Si la instrucción es ambigua, pide clarificación antes de proponer.
5. Siempre incluye SEARCH/REPLACE para los cambios que propones.
6. Para cambios simples (teléfono, texto, color), da SEARCH/REPLACE directo.
7. Para cambios complejos, explica qué harás y da SEARCH/REPLACE.

FORMATO DE RESPUESTA (JSON estricto, sin markdown):
{
  "respuesta": "Tu análisis conversacional. Explica qué encontraste, qué propones, y por qué.",
  "riesgo": "bajo|medio|alto",
  "cambios": [
    {"search": "texto exacto a buscar", "replace": "texto de reemplazo"}
  ],
  "resumen_cambios": "Descripción breve de los cambios propuestos",
  "pregunta_clarificacion": null
}

Si necesitas que el usuario aclare algo, responde con pregunta_clarificacion y cambios vacío.
Siempre responde en español.`;

                                            const userPrompt = `INSTRUCCIÓN DEL USUARIO: ${instruction}\n\nCONTEXTO RELEVANTE DEL HTML:\n${contextHtml}\n\n${docsSection}\nAnaliza y responde con el JSON:`;

                                            let rawResponse;
                                            try {
                                                const deepseekKey = process.env.DEEPSEEK_API_KEY;
                                                const fallbackKey = process.env.FALLBACK_API_KEY || process.env.OPENIA_KEY;
                                                const messages = [
                                                    { role: 'system', content: systemPrompt },
                                                    { role: 'user', content: userPrompt }
                                                ];

                                                if (deepseekKey) {
                                                    try {
                                                        const aiRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
                                                            method: 'POST',
                                                            headers: { Authorization: `Bearer ${deepseekKey}`, 'Content-Type': 'application/json' },
                                                            body: JSON.stringify({ model: 'deepseek-v4-flash', messages, temperature: 0.2, max_tokens: 4000, thinking: { type: 'disabled' } }),
                                                            signal: AbortSignal.timeout(45000)
                                                        });
                                                        const aiData = await aiRes.json();
                                                        if (aiData.choices?.[0]?.message?.content) rawResponse = aiData.choices[0].message.content.trim();
                                                    } catch (_) {}
                                                }
                                                if (!rawResponse && fallbackKey) {
                                                    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
                                                        method: 'POST',
                                                        headers: { Authorization: `Bearer ${fallbackKey}`, 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.3, max_tokens: 4000 }),
                                                        signal: AbortSignal.timeout(60000)
                                                    });
                                                    const aiData = await aiRes.json();
                                                    if (aiData.choices?.[0]?.message?.content) rawResponse = aiData.choices[0].message.content.trim();
                                                }
                                            } catch (_) {}

                                            if (!rawResponse) {
                                                respuestaIA = "No pude procesar la solicitud. El proveedor de IA no respondió. Intenta de nuevo.";
                                            } else {
                                                // Limpiar markdown si la IA lo incluye
                                                rawResponse = rawResponse.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();

                                                let parsed;
                                                try {
                                                    parsed = JSON.parse(rawResponse);
                                                } catch (e) {
                                                    // Si no es JSON, extraer SEARCH/REPLACE del texto libre
                                                    const srPattern = /SEARCH:\s*\n([\s\S]*?)\nREPLACE:\s*\n([\s\S]*?)(?=\n\nSEARCH:|$)/gi;
                                                    const reps = [];
                                                    let m;
                                                    while ((m = srPattern.exec(rawResponse)) !== null) {
                                                        if (m[1].trim().length >= 3) reps.push({ search: m[1].trim(), replace: m[2].trim() });
                                                    }
                                                    parsed = {
                                                        respuesta: rawResponse.replace(/SEARCH:[\s\S]*$/, '').trim() || 'He analizado tu solicitud.',
                                                        riesgo,
                                                        cambios: reps,
                                                        resumen_cambios: reps.length > 0 ? `${reps.length} cambio(s) propuesto(s)` : 'Sin cambios automáticos',
                                                        pregunta_clarificacion: null
                                                    };
                                                }

                                                // Validar SEARCH/REPLACE contra HTML actual
                                                if (parsed.cambios && parsed.cambios.length > 0) {
                                                    let testHtml = indexFile.content;
                                                    let ok = 0;
                                                    for (const r of parsed.cambios) {
                                                        if (testHtml.includes(r.search)) { testHtml = testHtml.split(r.search).join(r.replace); ok++; }
                                                    }
                                                    if (ok === 0) {
                                                        respuestaIA = 'Encontré tu solicitud pero los textos exactos no coinciden con el HTML actual. ¿Podrías copiar el texto tal como aparece en el sitio?';
                                                    }
                                                }

                                                if (!respuestaIA) {
                                                    // Construir respuesta conversacional
                                                    const shaBefore = await ghGetLastCommit();
                                                    let respuesta = parsed.respuesta || 'Analicé tu solicitud.';

                                                    if (parsed.pregunta_clarificacion) {
                                                        respuesta += '\n\n' + parsed.pregunta_clarificacion;
                                                    } else if (parsed.cambios && parsed.cambios.length > 0) {
                                                        respuesta += `\n\n📋 **${parsed.cambios.length} cambio(s) propuesto(s)** — Riesgo: ${parsed.riesgo || riesgo}`;
                                                        respuesta += '\n\nPara aprobar, responde: **"aprobar cambios"';
                                                        respuesta += '\nPara cancelar, responde: **"cancelar"';
                                                        respuesta += `\n\n.shiro:edits:${pid}:${shaBefore}:${Buffer.from(JSON.stringify(parsed.cambios)).toString('base64').substring(0, 200)}`;
                                                    } else {
                                                        respuesta += '\n\n¿Qué te gustaría ajustar?';
                                                    }

                                                    respuestaIA = respuesta;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    await guardarMensajeConversacion({
                        conversacionId: conversationIdFinal,
                        agenteId: targetID,
                        role: 'assistant',
                        content: respuestaIA,
                        metadata: { canal, action: 'SITE_EDIT_CONTENT', origen: 'ia' }
                    });
                    await actualizarResumenConversacion({ conversacionId: conversationIdFinal, ultimoMensaje: respuestaIA, ultimoRole: 'assistant', requiereAtencion: false });
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({ respuesta: respuestaIA, conversation_id: conversationIdFinal })
                    };
                }
            } catch (e) {
                console.error('SITE_EDIT_CONTENT error:', e.message);
                respuestaIA = "Error al procesar la edición. Intenta de nuevo.";
            }
        }

        const esToolShopify = actionPayload?.action?.startsWith('SHOPIFY_');
        let premiumTokens = 0;

        if (esToolShopify) {
            if (!toolDisponible(toolsDisponibles, actionPayload.action)) {
                respuestaIA = "Shopify no está habilitado para este agente o no hay conexión activa.";
            } else {
                const shopifyConn = obtenerConexion(userConnections, 'shopify');

                // Shopify puede usar credenciales directas (shopify_store_url + access_token)
                // o Composio entity ID para OAuth
                const tieneCredencialesDirectas = shopifyConn?.shopify_store_url && shopifyConn?.access_token;
                const tieneComposio = shopifyConn?.composio_entity_id;

                if (!tieneCredencialesDirectas && !tieneComposio) {
                    respuestaIA = "La tienda Shopify no está conectada. Por favor, conecta tu tienda desde la configuración.";
                } else {
                    const toolDef = TOOL_DEFINITIONS[actionPayload.action];
                    premiumTokens = toolDef?.premiumCost || 100000;

                    let payloadShopify = {};
                    if (actionPayload.action === 'SHOPIFY_SEARCH_PRODUCTS') {
                        payloadShopify = {
                            query: actionPayload.data?.query || '',
                            first: Math.min(actionPayload.data?.first || 20, 50)
                        };
                    } else if (actionPayload.action === 'SHOPIFY_GET_PRODUCT') {
                        payloadShopify = {
                            productId: actionPayload.data?.productId || ''
                        };
                    } else if (actionPayload.action === 'SHOPIFY_LIST_PRODUCTS') {
                        payloadShopify = {
                            first: Math.min(actionPayload.data?.first || 20, 50),
                            query: actionPayload.data?.query || '',
                            sortKey: actionPayload.data?.sortKey || 'BEST_SELLING'
                        };
                    } else if (actionPayload.action === 'SHOPIFY_GET_PRODUCT_VARIANTS') {
                        payloadShopify = {
                            productId: actionPayload.data?.productId || '',
                            first: Math.min(actionPayload.data?.first || 20, 50)
                        };
                    } else if (actionPayload.action === 'SHOPIFY_CREATE_DRAFT_ORDER') {
                        payloadShopify = {
                            lineItems: actionPayload.data?.lineItems || [],
                            customerName: actionPayload.data?.customerName || '',
                            customerEmail: actionPayload.data?.customerEmail || '',
                            shippingAddress: actionPayload.data?.shippingAddress || null,
                            note: actionPayload.data?.note || ''
                        };
                    } else if (actionPayload.action === 'SHOPIFY_GET_CHECKOUT_URL') {
                        payloadShopify = {
                            draftOrderId: actionPayload.data?.draftOrderId || ''
                        };
                    }

                    console.log("Ejecutando Shopify:", actionPayload.action, JSON.stringify(payloadShopify));

                    let shopifyResult;

                    // Si tiene credenciales directas, ejecutar via API de Shopify directamente
                    if (tieneCredencialesDirectas) {
                        const shopifyStoreUrl = shopifyConn.shopify_store_url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
                        const accessToken = shopifyConn.access_token;
                        console.log("Shopify directo - store:", shopifyStoreUrl, "token length:", accessToken?.length);

                        // Construir query GraphQL segun la accion
                        let query = '';
                        let variables = {};

                        if (actionPayload.action === 'SHOPIFY_SEARCH_PRODUCTS') {
                            query = `query SearchProducts($query: String!, $first: Int!) {
                                products(first: $first, query: $query) {
                                    nodes {
                                        id title
                                        variants(first: 10) {
                                            nodes { id title price inventoryQuantity sku }
                                        }
                                        totalInventory
                                    }
                                }
                            }`;
                            variables = { query: payloadShopify.query || '', first: payloadShopify.first || 20 };
                        } else if (actionPayload.action === 'SHOPIFY_LIST_PRODUCTS') {
                            query = `query ListProducts($first: Int!) {
                                products(first: $first) {
                                    nodes {
                                        id title
                                        variants(first: 10) {
                                            nodes { id title price inventoryQuantity }
                                        }
                                        totalInventory
                                    }
                                }
                            }`;
                            variables = { first: payloadShopify.first || 20 };
                        } else if (actionPayload.action === 'SHOPIFY_GET_PRODUCT') {
                            query = `query GetProduct($id: ID!) {
                                product(id: $id) {
                                    id title description
                                    variants(first: 25) {
                                        nodes { id title price inventoryQuantity sku }
                                    }
                                }
                            }`;
                            variables = { id: payloadShopify.productId };
                        } else if (actionPayload.action === 'SHOPIFY_GET_PRODUCT_VARIANTS') {
                            query = `query GetVariants($id: ID!) {
                                product(id: $id) {
                                    variants(first: 50) {
                                        nodes { id title price inventoryQuantity sku }
                                    }
                                }
                            }`;
                            variables = { id: payloadShopify.productId };
                        } else if (actionPayload.action === 'SHOPIFY_CREATE_DRAFT_ORDER') {
                            const lineItemsInput = (payloadShopify.lineItems || []).map(item => ({
                                variantId: item.variantId,
                                quantity: item.quantity
                            }));
                            const input = {
                                lineItems: lineItemsInput,
                                customer: {
                                    firstName: (payloadShopify.customerName || '').split(' ')[0],
                                    lastName: (payloadShopify.customerName || '').split(' ').slice(1).join(' '),
                                    email: payloadShopify.customerEmail
                                }
                            };
                            if (payloadShopify.shippingAddress) {
                                input.shippingAddress = payloadShopify.shippingAddress;
                            }
                            if (payloadShopify.note) {
                                input.note = payloadShopify.note;
                            }
                            query = `mutation CreateDraftOrder($input: DraftOrderInput!) {
                                draftOrderCreate(input: $input) {
                                    draftOrder { id name status totalPrice }
                                    userErrors { field message }
                                }
                            }`;
                            variables = { input };
                        } else if (actionPayload.action === 'SHOPIFY_GET_CHECKOUT_URL') {
                            query = `query GetCheckoutUrl($id: ID!) {
                                draftOrder(id: $id) { invoiceUrl }
                            }`;
                            variables = { id: payloadShopify.draftOrderId };
                        }

                        // Ejecutar query GraphQL
                        const shopifyResponse = await fetch(`https://${shopifyStoreUrl}/admin/api/2024-10/graphql.json`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Shopify-Access-Token': accessToken
                            },
                            body: JSON.stringify({ query, variables })
                        });

                        const shopifyData = await shopifyResponse.json();
                        console.log("Shopify API response status:", shopifyResponse.status);
                        console.log("Shopify API response:", JSON.stringify(shopifyData).slice(0, 500));

                        if (shopifyData.errors) {
                            console.error("Shopify API errors:", JSON.stringify(shopifyData.errors));
                            shopifyResult = { data: null, error: shopifyData.errors };
                        } else {
                            shopifyResult = { data: shopifyData.data };
                        }
                    } else {
                        // Usar Composio para ejecutar la herramienta
                        shopifyResult = await ejecutarToolComposio(
                            actionPayload.action,
                            shopifyConn.composio_entity_id,
                            agente.user_id,
                            payloadShopify
                        );
                    }

                    console.log("Resultado Shopify:", JSON.stringify(shopifyResult));

                    // Si hay error de la API de Shopify, mostrarlo
                    if (shopifyResult?.error) {
                        const errMsg = Array.isArray(shopifyResult.error)
                            ? shopifyResult.error.map(e => e.message).join(', ')
                            : typeof shopifyResult.error === 'string'
                                ? shopifyResult.error
                                : 'Error desconocido de Shopify';
                        respuestaIA = `Error de Shopify: ${errMsg}`;
                    } else {
                        const data = shopifyResult?.data?.response_data || shopifyResult?.data || shopifyResult;

                        if (actionPayload.action === 'SHOPIFY_SEARCH_PRODUCTS' || actionPayload.action === 'SHOPIFY_LIST_PRODUCTS') {
                            const products = data?.products?.nodes || data?.products || data?.nodes || data || [];
                            if (!products.length) {
                                respuestaIA = "No encontré productos que coincidan con tu búsqueda.";
                            } else {
                                respuestaIA = `Encontré ${products.length} productos:\n\n` +
                                    products.slice(0, 20).map((p, i) => {
                                        const price = p.variants?.nodes?.[0]?.price || p.variants?.[0]?.price || 'N/A';
                                        const inventory = p.totalInventory ?? p.inventory_quantity ?? 'N/A';
                                        return `${i + 1}. ${p.title}\n   Precio: $${price}\n   Stock: ${inventory} unidades`;
                                    }).join("\n\n");
                            }
                        } else if (actionPayload.action === 'SHOPIFY_GET_PRODUCT') {
                            const product = data?.product || data;
                            if (!product) {
                                respuestaIA = "No encontré el producto solicitado.";
                            } else {
                                const variants = product.variants?.nodes || product.variants || [];
                                respuestaIA = `📦 ${product.title}\n\n` +
                                    `Descripción: ${product.description?.slice(0, 200) || 'Sin descripción'}\n\n` +
                                    `Variantes:\n` +
                                    variants.slice(0, 10).map(v =>
                                        `• ${v.title || 'Principal'} - $${v.price || 'N/A'} - Stock: ${v.inventoryQuantity ?? v.inventory_quantity ?? 'N/A'}`
                                    ).join("\n");
                            }
                        } else if (actionPayload.action === 'SHOPIFY_GET_PRODUCT_VARIANTS') {
                            const variants = data?.product?.variants?.nodes || data?.variants?.nodes || data?.variants || data || [];
                            if (!variants.length) {
                                respuestaIA = "No encontré variantes para este producto.";
                            } else {
                                respuestaIA = `Variantes del producto:\n\n` +
                                    variants.slice(0, 20).map((v, i) =>
                                        `${i + 1}. ${v.title || 'Principal'} - $${v.price || 'N/A'} - SKU: ${v.sku || 'N/A'} - Stock: ${v.inventoryQuantity ?? v.inventory_quantity ?? 'N/A'}`
                                    ).join("\n");
                            }
                        } else if (actionPayload.action === 'SHOPIFY_CREATE_DRAFT_ORDER') {
                            const draftOrder = data?.draftOrderCreate?.draftOrder || data?.draftOrder || data;
                            if (!draftOrder?.id) {
                                respuestaIA = "No pude crear el borrador de orden. Verifica los datos e intenta de nuevo.";
                            } else {
                                respuestaIA = `✅ Borrador de orden creado\n\n` +
                                    `ID: ${draftOrder.id}\n` +
                                    `Estado: ${draftOrder.status || 'DRAFT'}\n` +
                                    `Total: $${draftOrder.totalPrice || 'N/A'}\n\n` +
                                    `Ahora obtengo tu link de pago...`;
                                await guardarMensajeConversacion({
                                    conversacionId: conversationIdFinal,
                                    agenteId: targetID,
                                    role: 'assistant',
                                    content: respuestaIA,
                                    metadata: { canal, action: actionPayload.action, origen: 'ia', draftOrderId: draftOrder.id }
                                });
                                await actualizarResumenConversacion({ conversacionId: conversationIdFinal, ultimoMensaje: respuestaIA, ultimoRole: 'assistant', requiereAtencion: false });
                                return {
                                    statusCode: 200,
                                    headers: { ...headersCORS, 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ respuesta: respuestaIA, conversationId: conversationIdFinal, draftOrderId: draftOrder.id })
                                };
                            }
                        } else if (actionPayload.action === 'SHOPIFY_GET_CHECKOUT_URL') {
                            const checkoutData = data?.draftOrderFetch?.invoiceUrl || data?.invoiceUrl || data?.checkoutUrl || data;
                            if (!checkoutData) {
                                respuestaIA = "No pude obtener el link de pago. Verifica la orden e intenta de nuevo.";
                            } else {
                                respuestaIA = `💳 Link de pago listo\n\n` +
                                    `${checkoutData}\n\n` +
                                    `Haz clic en el link para completar tu pago de forma segura en Shopify.`;
                            }
                        }
                    }

                    await guardarMensajeConversacion({
                        conversacionId: conversationIdFinal,
                        agenteId: targetID,
                        role: 'assistant',
                        content: respuestaIA,
                        metadata: { canal, action: actionPayload.action, origen: 'ia' }
                    });
                    await actualizarResumenConversacion({ conversacionId: conversationIdFinal, ultimoMensaje: respuestaIA, ultimoRole: 'assistant', requiereAtencion: false });
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({
                            respuesta: respuestaIA,
                            tokens_consumidos: premiumTokens,
                            conversation_id: conversationIdFinal,
                            premium: true
                        })
                    };
                }
            }
        }

        const tPost = Date.now();
        const tokensUsados = await registrarConsumo({
            agente,
            targetID,
            saldoActual,
            prompt,
            respuestaIA,
            apiTokens: apiTokensUsados,
            premiumTokens
        });
        console.log(`[timing] registrarConsumo: ${Date.now() - tPost}ms`);

        const tDedup = Date.now();
        await guardarRespuestaDeducup({
            conversacionId: conversationIdFinal,
            agenteId: targetID,
            contenido: respuestaIA,
            metadata: { canal, origen: 'ia' }
        });
        console.log(`[timing] guardarRespuestaDeducup: ${Date.now() - tDedup}ms`);

        const tResumen = Date.now();
        await actualizarResumenConversacion({
            conversacionId: conversationIdFinal,
            ultimoMensaje: respuestaIA,
            ultimoRole: 'assistant',
            requiereAtencion: false
        });
        console.log(`[timing] actualizarResumenConversacion: ${Date.now() - tResumen}ms`);

        // ── CRM: captura post-chat (extracción de datos del lead) ──
        // No bloquea la respuesta; si falla, el chat sigue normal.
        // Si el agente está vinculado a una TIENDA, la captura de leads es por defecto
        // (no requiere activar crm_activo ni configurar catálogo/conecciones).
        if (agente.tienda_id || agente.crm_activo) {
            const tCRM = Date.now();
            try {
                await extraerDatosLead({
                    agente,
                    canal,
                    externalUserId: externalUserIdFinal,
                    conversacionId: conversationIdFinal
                });
            } catch (crmErr) {
                console.error('Error capturando lead:', crmErr.message);
            }
            console.log(`[timing] extraerDatosLead: ${Date.now() - tCRM}ms`);
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                respuesta: respuestaIA,
                tokens_consumidos: tokensUsados,
                conversation_id: conversationIdFinal,
                productos: crmActivo && catalogoCRM.length > 0 ? productosParaCliente(catalogoCRM) : [],
                tienda_id: tiendaId || null,
                proveedor: proveedorIA
            })
        };

    } catch (err) {
        console.error("Error general:", err);

        let mensaje = "Error procesando la solicitud.";

        if (err.name === 'AbortError') {
            mensaje = "La IA tardó demasiado en responder. Intenta de nuevo.";
        } else if (err.message) {
            mensaje = err.message;
        }

        return {
            statusCode: err.status || 500,
            headers,
            body: JSON.stringify({ error: mensaje })
        };
    }
};
