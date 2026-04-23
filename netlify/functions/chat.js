const { createClient } = require('@supabase/supabase-js');
const {
    esConfirmacion,
    esCancelacion,
    construirToolsDescription,
    getMissingFields,
    buildMissingFieldsQuestion,
    enrichCalendarPayloadFromText,
    seemsContactInfo,
    detectWorkflowIntent,
    getWorkflowConfig,
    classifyMessageRoute,
    enrichEmailPayloadFromText
} = require('./tool-workflows');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

// ── HANDLER ──────────────────────────────────────────────────────────────────

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
        const { prompt, agente_id, historial = [], conversation_id = null } = body;
        const targetID = agente_id || process.env.AGENTE_MAESTRO_ID;

        if (!conversation_id) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Falta conversation_id." })
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
        const esDashboard = origin.includes("jeisondigital.netlify.app");

        if (!esDashboard && (!agente.dominios_permitidos || agente.dominios_permitidos.length === 0)) {
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({ respuesta: "Seguridad: No hay dominios configurados para este agente." })
            };
        }

        if (!esDashboard && !agente.dominios_permitidos.includes(origin)) {
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({ respuesta: "Este dominio no tiene permiso." })
            };
        }

        const { data: perfil, error: errPerfil } = await supabase
            .from('perfiles')
            .select('token_balance')
            .eq('id', agente.user_id)
            .single();

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

        const { data: agentTools } = await supabase
            .from('agente_tools')
            .select('tool_key, toolkit, enabled')
            .eq('agente_id', targetID)
            .eq('enabled', true);

        const { data: userConnections } = await supabase
            .from('composio_connections')
            .select('toolkit, composio_entity_id, connected_at')
            .eq('user_id', agente.user_id);

        const toolkitsConectados = new Set((userConnections || []).map(c => String(c.toolkit).toLowerCase()));
        const toolsDisponibles = (agentTools || []).filter(t =>
            toolkitsConectados.has(String(t.toolkit).toLowerCase())
        );

        console.log("Tools disponibles:", toolsDisponibles.map(t => t.tool_key));

        const { data: pendingAction } = await supabase
            .from('pending_tool_actions')
            .select('*')
            .eq('user_id', agente.user_id)
            .eq('agente_id', targetID)
            .eq('conversation_id', conversation_id)
            .eq('status', 'pending')
            .gte('expires_at', new Date().toISOString())
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        console.log("Pending action:", pendingAction ? pendingAction.action : 'ninguno');

        const messageRoute = classifyMessageRoute({
    pendingAction,
    text: prompt
});

console.log("Message route:", messageRoute);

        let workflowDetectado = null;

        if (!pendingAction) {
            workflowDetectado = detectWorkflowIntent(
                prompt,
                toolsDisponibles.map(t => t.tool_key)
            );
        }

        console.log("Workflow detectado:", workflowDetectado ? workflowDetectado.key : 'ninguno');

        if (workflowDetectado?.key === 'schedule_meeting') {
            const scheduleConfig = getWorkflowConfig('schedule_meeting');
            const { data: existingSchedulePending } = await supabase
                .from('pending_tool_actions')
                .select('*')
                .eq('user_id', agente.user_id)
                .eq('agente_id', targetID)
                .eq('conversation_id', conversation_id)
                .eq('status', 'pending')
                .eq('action', 'GOOGLECALENDAR_CREATE_EVENT')
                .gte('expires_at', new Date().toISOString())
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (!existingSchedulePending) {
                await supabase
                    .from('pending_tool_actions')
                    .insert([{
                        user_id: agente.user_id,
                        agente_id: targetID,
                        conversation_id: conversation_id,
                        action: 'GOOGLECALENDAR_CREATE_EVENT',
                        payload: {
    summary: scheduleConfig?.defaults?.summary || "Reunión agendada desde el chat",
    description: scheduleConfig?.defaults?.description || "Reunión generada desde el asistente del agente.",
    start: "",
    end: "",
    attendees: [],
    contact_name: "",
    contact_email: "",
    contact_phone: "",
    meeting_reason: ""
},
                        status: 'pending',
                        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
                    }]);

                console.log("Pending action de schedule_meeting creada desde workflow nativo");
            }

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                   respuesta: scheduleConfig?.prompts?.initial || "Claro. Para agendar la reunión, compárteme la fecha y hora, tu nombre y tu correo."
                })
            };
        }

        if (workflowDetectado?.key === 'send_email') {
    const emailConfig = getWorkflowConfig('send_email');

    const { data: existingEmailPending } = await supabase
        .from('pending_tool_actions')
        .select('*')
        .eq('user_id', agente.user_id)
        .eq('agente_id', targetID)
        .eq('conversation_id', conversation_id)
        .eq('status', 'pending')
        .eq('action', 'GMAIL_SEND_EMAIL')
        .gte('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!existingEmailPending) {
        await supabase
            .from('pending_tool_actions')
            .insert([{
                user_id: agente.user_id,
                agente_id: targetID,
                conversation_id: conversation_id,
                action: 'GMAIL_SEND_EMAIL',
                payload: {
                    to: "",
                    subject: "",
                    body: "",
                    cc: "",
                    bcc: ""
                },
                status: 'pending',
                expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
            }]);

        console.log("Pending action de send_email creada desde workflow nativo");
    }

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            respuesta: emailConfig?.prompts?.initial || "Claro. Para enviar el correo, compárteme el destinatario, el asunto y el mensaje."
        })
    };
}

        // ── COMPLETAR PENDING DE CALENDAR DESDE BACKEND ──────────────────────

        if (
    pendingAction &&
    pendingAction.action === 'GOOGLECALENDAR_CREATE_EVENT' &&
    messageRoute === 'workflow_collect'
) {
            if (
    pendingAction &&
    pendingAction.action === 'GMAIL_SEND_EMAIL' &&
    messageRoute === 'workflow_collect'
) {
    const payloadActual = pendingAction.payload || {};
    const payloadEnriquecido = enrichEmailPayloadFromText(payloadActual, prompt);

    const missingFields = getMissingFields('GMAIL_SEND_EMAIL', payloadEnriquecido);
    const huboCambios = JSON.stringify(payloadActual) !== JSON.stringify(payloadEnriquecido);

    if (huboCambios) {
        await supabase
            .from('pending_tool_actions')
            .update({ payload: payloadEnriquecido })
            .eq('id', pendingAction.id);

        console.log("Pending action Gmail enriquecida desde texto:", JSON.stringify(payloadEnriquecido));
    }

    if (missingFields.length > 0) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                respuesta: buildMissingFieldsQuestion('GMAIL_SEND_EMAIL', missingFields)
            })
        };
    }

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            respuesta: `Voy a enviar un correo a ${payloadEnriquecido.to} con asunto "${payloadEnriquecido.subject}". Responde "sí" para confirmar o "no" para cancelar.`
        })
    };
}
    const payloadActual = pendingAction.payload || {};

    let payloadEnriquecido = { ...payloadActual };

    // 1. Extraer contacto si el mensaje parece traer datos de contacto
    if (seemsContactInfo(prompt)) {
        payloadEnriquecido = enrichCalendarPayloadFromText(payloadEnriquecido, prompt);
    }

    // 2. Extraer fecha/hora desde el texto
    const fechaResuelta = resolverFecha(prompt);
    if (fechaResuelta && !payloadEnriquecido.start) {
        payloadEnriquecido.start = fechaResuelta;
    }

    if (payloadEnriquecido.start && !payloadEnriquecido.end) {
       const scheduleConfig = getWorkflowConfig('schedule_meeting');
const durationMinutes = scheduleConfig?.defaults?.durationMinutes || 30;
payloadEnriquecido.end = sumarMinutos(payloadEnriquecido.start, durationMinutes);
    }

    const missingFields = getMissingFields('GOOGLECALENDAR_CREATE_EVENT', payloadEnriquecido);
    const huboCambios = JSON.stringify(payloadActual) !== JSON.stringify(payloadEnriquecido);

    if (huboCambios) {
        await supabase
            .from('pending_tool_actions')
            .update({ payload: payloadEnriquecido })
            .eq('id', pendingAction.id);

        console.log("Pending action Calendar enriquecida desde texto:", JSON.stringify(payloadEnriquecido));
    }

    if (missingFields.length > 0) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                respuesta: buildMissingFieldsQuestion('GOOGLECALENDAR_CREATE_EVENT', missingFields)
            })
        };
    }

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            respuesta: `Voy a agendar "${payloadEnriquecido.summary}" el ${payloadEnriquecido.start?.split('T')[0]} a las ${payloadEnriquecido.start?.split('T')[1]?.substring(0, 5)} para ${payloadEnriquecido.contact_name} (${payloadEnriquecido.contact_email}). Responde "sí" para confirmar o "no" para cancelar.`
        })
    };
}

        // ── CONFIRMAR ACCIÓN PENDIENTE ───────────────────────────────────────
        if (pendingAction && messageRoute === 'workflow_confirm' && esConfirmacion(prompt)) {
            console.log("Confirmación recibida para:", pendingAction.action);

            if (pendingAction.action === 'GOOGLECALENDAR_CREATE_EVENT') {
                const calConn = (userConnections || []).find(
                    c => String(c.toolkit).toLowerCase() === 'googlecalendar'
                );

                if (!calConn?.composio_entity_id) {
                    return {
                        statusCode: 400,
                        headers,
                        body: JSON.stringify({ respuesta: "Google Calendar no está conectado." })
                    };
                }

                const payload = pendingAction.payload || {};
                const attendeesBase = Array.isArray(payload.attendees) ? payload.attendees : [];
                const contactEmail = payload.contact_email || "";
                const attendeesFinal = [...new Set([
                    ...attendeesBase,
                    ...(contactEmail ? [contactEmail] : [])
                ])].filter(e => e && e.includes('@'));

                const argumentos = {
                    summary: payload.summary || "Evento agendado desde el chat",
                    description: payload.description || "",
                    start_datetime: resolverFecha(payload.start),
                    end_datetime: resolverFecha(payload.end),
                    attendees: attendeesFinal
                };

                console.log("Fechas resueltas:", argumentos.start_datetime, argumentos.end_datetime);
                console.log("Invitados:", attendeesFinal);

                const resultado = await ejecutarToolComposio(
                    'GOOGLECALENDAR_CREATE_EVENT',
                    calConn.composio_entity_id,
                    agente.user_id,
                    argumentos
                );

                console.log("Resultado Composio:", JSON.stringify(resultado));

                await supabase
                    .from('pending_tool_actions')
                    .update({ status: 'executed' })
                    .eq('id', pendingAction.id);

                const meetLink = resultado?.data?.response_data?.hangoutLink || "";
                const respuestaIA = `✅ Listo, agendé "${argumentos.summary}" para el ${argumentos.start_datetime?.split('T')[0]} a las ${argumentos.start_datetime?.split('T')[1]?.substring(0, 5)}.${meetLink ? `\n\n🎥 Link de Meet: ${meetLink}` : ""}${contactEmail ? `\n\nSe envió invitación a ${contactEmail}.` : ""}`;

                const tokensUsados = await registrarConsumo({
                    agente,
                    targetID,
                    saldoActual,
                    prompt,
                    respuestaIA
                });

                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        respuesta: respuestaIA,
                        tokens_consumidos: tokensUsados
                    })
                };
            }

            if (pendingAction.action === 'GMAIL_SEND_EMAIL') {
                const gmailConn = (userConnections || []).find(
                    c => String(c.toolkit).toLowerCase() === 'gmail'
                );

                if (!gmailConn?.composio_entity_id) {
                    return {
                        statusCode: 400,
                        headers,
                        body: JSON.stringify({ respuesta: "Gmail no está conectado." })
                    };
                }

                const payload = pendingAction.payload || {};
                const resultado = await ejecutarToolComposio(
                    'GMAIL_SEND_EMAIL',
                    gmailConn.composio_entity_id,
                    agente.user_id,
                    {
                        to: payload.to,
                        subject: payload.subject,
                        body: payload.body,
                        cc: payload.cc || "",
                        bcc: payload.bcc || ""
                    }
                );

                await supabase
                    .from('pending_tool_actions')
                    .update({ status: 'executed' })
                    .eq('id', pendingAction.id);

                const respuestaIA = resultado?.successful
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
                    headers,
                    body: JSON.stringify({
                        respuesta: respuestaIA,
                        tokens_consumidos: tokensUsados
                    })
                };
            }
        }

       if (pendingAction && messageRoute === 'workflow_confirm' && esCancelacion(prompt)) {
            await supabase
                .from('pending_tool_actions')
                .update({ status: 'cancelled' })
                .eq('id', pendingAction.id);

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ respuesta: "Entendido, cancelé la acción pendiente." })
            };
        }

        // ── PROMPT PARA DEEPSEEK ──────────────────────────────────────────────
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
Hay una acción pendiente que debes continuar completando:
Tipo: ${pendingAction.action}
Datos actuales: ${JSON.stringify(pendingAction.payload || {}, null, 2)}

INSTRUCCIONES:
- NO saludes de nuevo ni reinicies la conversación.
- Si el usuario te da datos faltantes, actualiza el JSON con esos datos.
- Si ya tienes todos los campos requeridos, genera el JSON final y pide confirmación.
- Responde SOLO en JSON si vas a actualizar la acción.`;
}

const mensajes = [
    { role: "system", content: systemFinal },
    ...historial.slice(-12),
    { role: "user", content: prompt }
];

        console.log("Turnos de historial enviados a DeepSeek:", historial.length);
        console.log("Llamando a DeepSeek...");

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);

        let aiResponse;
        let aiData;

        try {
            aiResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: "deepseek-chat",
                    messages: mensajes,
                    temperature: 0.2
                }),
                signal: controller.signal
            });

            console.log("DeepSeek respondió con status:", aiResponse.status);

            aiData = await aiResponse.json();
            console.log("Respuesta JSON DeepSeek:", JSON.stringify(aiData));
        } finally {
            clearTimeout(timeout);
        }

        if (!aiResponse.ok || !aiData?.choices) {
            console.error("Error DeepSeek:", aiData);
            throw new Error(aiData?.error?.message || "Error en la respuesta de la IA");
        }

        let respuestaIA = aiData.choices[0].message.content;
        console.log("Respuesta raw DeepSeek:", respuestaIA);

        let actionPayload = null;
        try {
            actionPayload = JSON.parse(respuestaIA);
        } catch (_) {
            actionPayload = null;
        }

        const mencionaCalendar =
            !actionPayload &&
            !pendingAction &&
            toolsDisponibles.some(t => t.tool_key === 'GOOGLECALENDAR_CREATE_EVENT') &&
            /agend|reuni[oó]n|cita|calendar|evento|invitaci[oó]n/i.test(prompt + " " + respuestaIA);

        if (mencionaCalendar) {
            await supabase
                .from('pending_tool_actions')
                .insert([{
                    user_id: agente.user_id,
                    agente_id: targetID,
                    conversation_id: conversation_id,
                    action: 'GOOGLECALENDAR_CREATE_EVENT',
                    payload: {},
                    status: 'pending',
                    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
                }]);

            console.log("Pending action vacío creado por intención textual");
        }

        console.log("Action payload parseado:", actionPayload ? actionPayload.action : 'null');

        // ── GOOGLECALENDAR_CREATE_EVENT ───────────────────────────────────────
        if (actionPayload?.action === 'GOOGLECALENDAR_CREATE_EVENT') {
            const calConn = (userConnections || []).find(
                c => String(c.toolkit).toLowerCase() === 'googlecalendar'
            );

            if (!calConn?.composio_entity_id) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({
                        respuesta: "Google Calendar no está conectado para este usuario."
                    })
                };
            }

            const eventData = actionPayload.data || {};

            const basePayloadPendiente = {
                summary: eventData.summary || eventData.title || "Evento agendado desde el chat",
                description: eventData.description || "",
                start: eventData.start,
                end: eventData.end,
                attendees: Array.isArray(eventData.attendees) ? eventData.attendees : [],
                contact_name: eventData.contact_name || "",
                contact_email: eventData.contact_email || "",
                contact_phone: eventData.contact_phone || "",
                meeting_reason: eventData.meeting_reason || "",
                location: eventData.location || ""
            };

            const payloadPendiente = enrichCalendarPayloadFromText(basePayloadPendiente, prompt);
            const missingFields = getMissingFields('GOOGLECALENDAR_CREATE_EVENT', payloadPendiente);

            const { data: existingPending } = await supabase
                .from('pending_tool_actions')
                .select('*')
                .eq('user_id', agente.user_id)
                .eq('agente_id', targetID)
                .eq('conversation_id', conversation_id)
                .eq('status', 'pending')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (existingPending) {
                const mergedPayload = enrichCalendarPayloadFromText({
                    ...(existingPending.payload || {}),
                    ...payloadPendiente
                }, prompt);

                const mergedMissing = getMissingFields('GOOGLECALENDAR_CREATE_EVENT', mergedPayload);

                await supabase
                    .from('pending_tool_actions')
                    .update({
                        action: 'GOOGLECALENDAR_CREATE_EVENT',
                        payload: mergedPayload,
                        status: 'pending'
                    })
                    .eq('id', existingPending.id);

                respuestaIA = mergedMissing.length > 0
                    ? buildMissingFieldsQuestion('GOOGLECALENDAR_CREATE_EVENT', mergedMissing)
                    : `Voy a agendar "${mergedPayload.summary}" el ${resolverFecha(mergedPayload.start)?.split('T')[0]} a las ${resolverFecha(mergedPayload.start)?.split('T')[1]?.substring(0, 5)} para ${mergedPayload.contact_name} (${mergedPayload.contact_email}). Responde "sí" para confirmar o "no" para cancelar.`;
            } else {
                await supabase
                    .from('pending_tool_actions')
                    .insert([{
                        user_id: agente.user_id,
                        agente_id: targetID,
                        conversation_id: conversation_id,
                        action: 'GOOGLECALENDAR_CREATE_EVENT',
                        payload: payloadPendiente,
                        status: 'pending',
                        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
                    }]);

                respuestaIA = missingFields.length > 0
                    ? buildMissingFieldsQuestion('GOOGLECALENDAR_CREATE_EVENT', missingFields)
                    : `Voy a agendar "${payloadPendiente.summary}" el ${resolverFecha(payloadPendiente.start)?.split('T')[0]} a las ${resolverFecha(payloadPendiente.start)?.split('T')[1]?.substring(0, 5)} para ${payloadPendiente.contact_name} (${payloadPendiente.contact_email}). Responde "sí" para confirmar o "no" para cancelar.`;
            }
        }

        // ── GMAIL_SEND_EMAIL ──────────────────────────────────────────────────
        if (actionPayload?.action === 'GMAIL_SEND_EMAIL') {
            const gmailConn = (userConnections || []).find(
                c => String(c.toolkit).toLowerCase() === 'gmail'
            );

            if (!gmailConn?.composio_entity_id) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ respuesta: "Gmail no está conectado para este usuario." })
                };
            }

            const emailData = actionPayload.data || {};
            const payloadEmail = {
                to: emailData.to || "",
                subject: emailData.subject || "",
                body: emailData.body || "",
                cc: emailData.cc || "",
                bcc: emailData.bcc || ""
            };

            const missingEmail = getMissingFields('GMAIL_SEND_EMAIL', payloadEmail);

            const { data: existingPendingEmail } = await supabase
                .from('pending_tool_actions')
                .select('*')
                .eq('user_id', agente.user_id)
                .eq('agente_id', targetID)
                .eq('conversation_id', conversation_id)
                .eq('status', 'pending')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (existingPendingEmail) {
                const merged = { ...(existingPendingEmail.payload || {}), ...payloadEmail };
                const mergedMissing = getMissingFields('GMAIL_SEND_EMAIL', merged);

                await supabase
                    .from('pending_tool_actions')
                    .update({
                        action: 'GMAIL_SEND_EMAIL',
                        payload: merged,
                        status: 'pending'
                    })
                    .eq('id', existingPendingEmail.id);

                respuestaIA = mergedMissing.length > 0
                    ? buildMissingFieldsQuestion('GMAIL_SEND_EMAIL', mergedMissing)
                    : `Voy a enviar un correo a ${merged.to} con asunto "${merged.subject}". Responde "sí" para confirmar o "no" para cancelar.`;
            } else {
                await supabase
                    .from('pending_tool_actions')
                    .insert([{
                        user_id: agente.user_id,
                        agente_id: targetID,
                        conversation_id: conversation_id,
                        action: 'GMAIL_SEND_EMAIL',
                        payload: payloadEmail,
                        status: 'pending',
                        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
                    }]);

                respuestaIA = missingEmail.length > 0
                    ? buildMissingFieldsQuestion('GMAIL_SEND_EMAIL', missingEmail)
                    : `Voy a enviar un correo a ${payloadEmail.to} con asunto "${payloadEmail.subject}". Responde "sí" para confirmar o "no" para cancelar.`;
            }
        }

        // ── GOOGLEDRIVE_FIND_FILE ─────────────────────────────────────────────
        if (actionPayload?.action === 'GOOGLEDRIVE_FIND_FILE') {
            const driveConn = (userConnections || []).find(
                c => String(c.toolkit).toLowerCase() === 'googledrive'
            );

            if (!driveConn?.composio_entity_id) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ respuesta: "Google Drive no está conectado." })
                };
            }

            const driveData = actionPayload.data || {};
            const resultado = await ejecutarToolComposio(
                'GOOGLEDRIVE_FIND_FILE',
                driveConn.composio_entity_id,
                agente.user_id,
                {
                    query: driveData.query,
                    folder: driveData.folder || "",
                    file_type: driveData.file_type || ""
                }
            );

            const archivos = resultado?.data?.response_data?.files || [];
            respuestaIA = archivos.length > 0
                ? `Encontré ${archivos.length} archivo(s):\n` +
                  archivos.slice(0, 5).map(f => `📄 ${f.name} — ${f.webViewLink || ''}`).join('\n')
                : "No encontré archivos que coincidan con tu búsqueda.";
        }

        const tokensUsados = await registrarConsumo({
            agente,
            targetID,
            saldoActual,
            prompt,
            respuestaIA
        });

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                respuesta: respuestaIA,
                tokens_consumidos: tokensUsados
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
