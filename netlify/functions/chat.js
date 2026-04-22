const { createClient } = require('@supabase/supabase-js');
const {
    esConfirmacion,
    esCancelacion,
    construirToolsDescription,
    getMissingFields,
    buildMissingFieldsQuestion,
    enrichCalendarPayloadFromText
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

    const horaMatch = texto.match(/(\d{1,2}):(\d{2})/);
    const hora = horaMatch ? parseInt(horaMatch[1], 10) : 10;
    const min = horaMatch ? parseInt(horaMatch[2], 10) : 0;

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    let fecha = new Date(hoy);

    if (/pasado ma[ñn]ana/i.test(texto)) fecha.setDate(fecha.getDate() + 2);
    else if (/ma[ñn]ana/i.test(texto)) fecha.setDate(fecha.getDate() + 1);
    else if (/lunes/i.test(texto)) while (fecha.getDay() !== 1) fecha.setDate(fecha.getDate() + 1);
    else if (/martes/i.test(texto)) while (fecha.getDay() !== 2) fecha.setDate(fecha.getDate() + 1);
    else if (/mi[eé]rcoles/i.test(texto)) while (fecha.getDay() !== 3) fecha.setDate(fecha.getDate() + 1);
    else if (/jueves/i.test(texto)) while (fecha.getDay() !== 4) fecha.setDate(fecha.getDate() + 1);
    else if (/viernes/i.test(texto)) while (fecha.getDay() !== 5) fecha.setDate(fecha.getDate() + 1);

    fecha.setHours(hora, min, 0, 0);

    const pad = n => String(n).padStart(2, '0');
    return `${fecha.getFullYear()}-${pad(fecha.getMonth() + 1)}-${pad(fecha.getDate())}T${pad(fecha.getHours())}:${pad(fecha.getMinutes())}:00-05:00`;
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
        const { prompt, agente_id, historial = [] } = body;
        const targetID = agente_id || process.env.AGENTE_MAESTRO_ID;

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
            .eq('status', 'pending')
            .gte('expires_at', new Date().toISOString())
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        console.log("Pending action:", pendingAction ? pendingAction.action : 'ninguno');

        // ── COMPLETAR PENDING DE CALENDAR DESDE BACKEND ──────────────────────
        if (
            pendingAction &&
            pendingAction.action === 'GOOGLECALENDAR_CREATE_EVENT' &&
            !esConfirmacion(prompt) &&
            !esCancelacion(prompt)
        ) {
            const payloadActual = pendingAction.payload || {};
            const payloadEnriquecido = enrichCalendarPayloadFromText(payloadActual, prompt);
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
                    respuesta: `Voy a agendar "${payloadEnriquecido.summary}" el ${resolverFecha(payloadEnriquecido.start)?.split('T')[0]} a las ${resolverFecha(payloadEnriquecido.start)?.split('T')[1]?.substring(0, 5)} para ${payloadEnriquecido.contact_name} (${payloadEnriquecido.contact_email}). Responde "sí" para confirmar o "no" para cancelar.`
                })
            };
        }

        // ── CONFIRMAR ACCIÓN PENDIENTE ───────────────────────────────────────
        if (pendingAction && esConfirmacion(prompt)) {
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

        if (pendingAction && esCancelacion(prompt)) {
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
        let systemFinal = agente.prompt_sistema + "\n" + toolsDescription;

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
            ...historial.slice(-12)
        ];

        console.log("Turnos de historial enviados a DeepSeek:", historial.length);

        console.log("Llamando a DeepSeek...");

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 12000);

let aiResponse;
try {
    aiResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: "deepseek-chat",
            messages: mensajes
        }),
        signal: controller.signal
    });
} finally {
    clearTimeout(timeout);
}

console.log("DeepSeek respondió con status:", aiResponse.status);

async function leerTextoConTimeout(response, ms = 8000) {
    return await Promise.race([
        response.text(),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout leyendo respuesta de DeepSeek')), ms)
        )
    ]);
}

const aiRaw = await leerTextoConTimeout(aiResponse, 8000);
console.log("Respuesta cruda DeepSeek:", aiRaw);

let aiData;
try {
    aiData = JSON.parse(aiRaw);
} catch (e) {
    throw new Error(`DeepSeek devolvió una respuesta no JSON: ${aiRaw}`);
}

if (!aiResponse.ok || !aiData.choices) {
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
    } else if (String(err.message || "").includes("Timeout leyendo respuesta de DeepSeek")) {
        mensaje = "La IA respondió, pero tardó demasiado en entregar el contenido. Intenta de nuevo.";
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
