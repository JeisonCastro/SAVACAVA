const { supabase } = require('./supabase-admin');
const {
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

async function registrarConsumo({ agente, targetID, saldoActual, prompt, respuestaIA }) {
    const tokensUsados = Math.ceil(((agente.prompt_sistema || "").length + (prompt || "").length + (respuestaIA || "").length) / 4) + 10;

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

exports.handler = async (event) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
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
            external_user_id = null
        } = body;
        const targetID = agente_id || process.env.AGENTE_MAESTRO_ID;

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
            external_user_id ||
            conversation_id ||
            `${canal}_${targetID}_anon`;

        const conversacion = await obtenerOCrearConversacion({
            agente,
            targetID,
            canal,
            externalUserId: externalUserIdFinal,
            conversationId: conversation_id && /^[0-9a-f-]{36}$/i.test(conversation_id) ? conversation_id : null
        });

        const conversationIdFinal = conversacion.id;

        await guardarMensajeConversacion({
            conversacionId: conversationIdFinal,
            agenteId: targetID,
            role: 'user',
            content: prompt,
            metadata: { canal, origen: 'cliente' }
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
            pendingActionResult
        ] = await Promise.all([
            cargarHistorialConversacion(conversationIdFinal, 8),
            supabase.from('perfiles').select('token_balance').eq('id', agente.user_id).single(),
            supabase.from('agente_tools').select('tool_key, toolkit, enabled').eq('agente_id', targetID).eq('enabled', true),
            supabase.from('composio_connections').select('toolkit, composio_entity_id, connected_at').eq('user_id', agente.user_id),
            supabase.from('pending_tool_actions').select('*').eq('user_id', agente.user_id).eq('agente_id', targetID).eq('conversation_id', conversationIdFinal).eq('status', 'pending').gte('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle()
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
            toolkitsConectados.has(normalizarToolkit(t.toolkit))
        );

        console.log("Tools disponibles:", toolsDisponibles.map(t => t.tool_key));

        const { data: pendingAction } = pendingActionResult;

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
                    conversation_id: conversationIdFinal
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

REGLAS DE HERRAMIENTAS:
- DeepSeek decide la intención principal del usuario.
- Si el usuario quiere enviar correo, usa GMAIL_SEND_EMAIL.
- Si el usuario quiere agendar o crear evento, usa GOOGLECALENDAR_CREATE_EVENT.
- Si el usuario quiere buscar archivo, usa GOOGLEDRIVE_FIND_FILE.
- Si faltan campos, responde en lenguaje natural preguntando solo lo que falta.
- Si tienes todos los campos para una herramienta, responde únicamente JSON válido con action y data.
- No confundas correos con reuniones.
- Si el usuario corrige la intención, respeta la corrección inmediatamente.
`;

        if (!esSaludoSimple) {
            systemFinal += `
INSTRUCCIÓN ADICIONAL:
- El mensaje actual NO es un saludo simple. No uses el saludo base. Responde directamente a lo que el usuario pidió.
`;
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

        const mensajes = [
            { role: "system", content: systemFinal },
            ...historialSinDuplicado.slice(-8),
            { role: "user", content: prompt }
        ];



        console.log("Turnos de historial enviados a DeepSeek:", historialDB.length);
        console.log("Conversation ID final:", conversationIdFinal);
        console.log("Llamando a DeepSeek...");

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 9000);

        const aiResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "deepseek-v4-flash",
                messages: mensajes,
                temperature: 0.2
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);

        console.log("DeepSeek respondió con status:", aiResponse.status);

        const aiData = await aiResponse.json();
        console.log("Respuesta JSON DeepSeek:", JSON.stringify(aiData));

        if (!aiResponse.ok || !aiData?.choices) {
            console.error("Error DeepSeek:", aiData);
            throw new Error(aiData?.error?.message || "Error en la respuesta de la IA");
        }

        let respuestaIA = limpiarTextoIA(aiData.choices[0].message.content);
        console.log("Respuesta raw DeepSeek:", respuestaIA);

        const actionPayload = parseActionPayload(respuestaIA);
        console.log("Action payload parseado:", actionPayload ? actionPayload.action : 'null');

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

        const tokensUsados = await registrarConsumo({
            agente,
            targetID,
            saldoActual,
            prompt,
            respuestaIA
        });

        await guardarMensajeConversacion({
            conversacionId: conversationIdFinal,
            agenteId: targetID,
            role: 'assistant',
            content: respuestaIA,
            metadata: { canal, origen: 'ia' }
        });

        await actualizarResumenConversacion({
            conversacionId: conversationIdFinal,
            ultimoMensaje: respuestaIA,
            ultimoRole: 'assistant',
            requiereAtencion: false
        });

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                respuesta: respuestaIA,
                tokens_consumidos: tokensUsados,
                conversation_id: conversationIdFinal
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
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: mensaje })
        };
    }
};
