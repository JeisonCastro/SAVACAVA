const { createClient } = require('@supabase/supabase-js');
const {
    esConfirmacion,
    esCancelacion,
    construirToolsDescription
} = require('./lib/tool-workflows');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
        const { prompt, agente_id } = JSON.parse(event.body);
        const targetID = agente_id || process.env.AGENTE_MAESTRO_ID;

        // 1. Obtener el agente (sin JOIN, consulta directa)
        const { data: agente, error: errAgente } = await supabase
            .from('agentes_ia')
            .select('*')
            .eq('id', targetID)
            .single();
        // --- INSERTA ESTO PARA VER LA VERDAD ---
        console.log("ID buscado:", targetID);
        console.log("Datos del agente encontrado:", JSON.stringify(agente));
        // ---------------------------------------

        if (errAgente || !agente) {
            console.error("Error agente:", errAgente);
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ respuesta: "Agente no encontrado." })
            };
        }
// --- 2.5 Validación de Dominio (Corregida) ---
const origin = event.headers.origin || ""; 
const esDashboard = origin.includes("jeisondigital.netlify.app");

console.log("Dominio solicitante:", origin);
console.log("Lista permitida:", agente.dominios_permitidos);

// Si la lista está vacía, bloqueamos (excepto si es el dashboard)
if (!esDashboard && (!agente.dominios_permitidos || agente.dominios_permitidos.length === 0)) {
    return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ respuesta: "Seguridad: No hay dominios configurados para este agente." })
    };
}

// LÓGICA CLAVE: Solo bloqueamos si (NO es el dashboard) Y (el origen NO está en la lista)
if (!esDashboard && !agente.dominios_permitidos.includes(origin)) {
    return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ respuesta: "Este dominio no tiene permiso." })
    };
}
        

        // 2. Obtener saldo desde la tabla perfiles (consulta separada)
        const { data: perfil, error: errPerfil } = await supabase
            .from('perfiles')
            .select('token_balance')
            .eq('id', agente.user_id)
            .single();

        if (errPerfil || !perfil) {
            console.error("Error perfil:", errPerfil);
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ respuesta: "Perfil de usuario no encontrado." })
            };
        }

        const saldoActual = perfil.token_balance ?? 0;

                // 2.5 Obtener herramientas activas del agente
        const { data: agentTools, error: errTools } = await supabase
            .from('agente_tools')
            .select('tool_key, toolkit, enabled')
            .eq('agente_id', targetID)
            .eq('enabled', true);

        if (errTools) {
            console.error("Error agente_tools:", errTools);
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ respuesta: "No se pudieron cargar las herramientas del agente." })
            };
        }

        // 2.6 Obtener conexiones activas del usuario
        const { data: userConnections, error: errConnections } = await supabase
            .from('composio_connections')
            .select('toolkit, composio_entity_id, connected_at')
            .eq('user_id', agente.user_id);

        if (errConnections) {
            console.error("Error composio_connections:", errConnections);
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ respuesta: "No se pudieron cargar las conexiones del usuario." })
            };
        }

        // 2.7 Cruzar tools activas del agente con conexiones del usuario
        const toolkitsConectados = new Set(
            (userConnections || []).map(c => String(c.toolkit).toLowerCase())
        );

        const toolsDisponibles = (agentTools || []).filter(tool =>
            toolkitsConectados.has(String(tool.toolkit).toLowerCase())
        );

        console.log("Herramientas activas del agente:", JSON.stringify(agentTools || []));
        console.log("Conexiones del usuario:", JSON.stringify(userConnections || []));
        console.log("Tools disponibles para ejecutar:", JSON.stringify(toolsDisponibles || []));

        // 3. Verificar si tiene saldo suficiente
        if (saldoActual < 100) {
            return {
                statusCode: 402,
                headers,
                body: JSON.stringify({ respuesta: "Saldo insuficiente en Jeison.Digital. Por favor, recarga tu cuenta." })
            };
        }
                // 3.5 Revisar si hay una acción pendiente de confirmación
        const { data: pendingAction, error: errPending } = await supabase
            .from('pending_tool_actions')
            .select('*')
            .eq('user_id', agente.user_id)
            .eq('agente_id', targetID)
            .eq('status', 'pending')
            .gte('expires_at', new Date().toISOString())
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (errPending) {
            console.error("Error pending_tool_actions:", errPending);
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ respuesta: "No se pudo consultar la acción pendiente." })
            };
        }

        if (pendingAction && esConfirmacion(prompt)) {
            console.log("Confirmación recibida para acción pendiente:", JSON.stringify(pendingAction));

            if (pendingAction.action === 'GOOGLECALENDAR_CREATE_EVENT') {
                const calendarConnection = (userConnections || []).find(
                    c => String(c.toolkit).toLowerCase() === 'googlecalendar'
                );

                if (!calendarConnection?.composio_entity_id) {
                    return {
                        statusCode: 400,
                        headers,
                        body: JSON.stringify({
                            respuesta: "Google Calendar no está conectado para este usuario."
                        })
                    };
                }

                const payload = pendingAction.payload || {};

                const argumentos = {
                    summary: payload.summary || "Evento agendado desde el chat",
                    description: payload.description || "",
                    start_datetime: String(payload.start).includes("-05:00") ? payload.start : payload.start + "-05:00",
                    end_datetime: String(payload.end).includes("-05:00") ? payload.end : payload.end + "-05:00"
                };

                console.log("Ejecutando acción confirmada GOOGLECALENDAR_CREATE_EVENT:", JSON.stringify(argumentos));

                const resultadoComposio = await ejecutarToolComposio(
                    'GOOGLECALENDAR_CREATE_EVENT',
                    calendarConnection.composio_entity_id,
                    agente.user_id,
                    argumentos
                );

                console.log("Resultado Composio Calendar:", JSON.stringify(resultadoComposio));

                await supabase
                    .from('pending_tool_actions')
                    .update({ status: 'executed' })
                    .eq('id', pendingAction.id);

                const respuestaIA = `Listo, agendé el evento "${argumentos.summary}" en tu Google Calendar.`;

                const totalCaracteres =
                    (agente.prompt_sistema || "").length +
                    (prompt || "").length +
                    (respuestaIA || "").length;
                const tokensUsados = Math.ceil(totalCaracteres / 4) + 10;

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
                body: JSON.stringify({
                    respuesta: "Entendido, cancelé la acción pendiente."
                })
            };
        }
// Construir descripción de herramientas disponibles
const toolsDescription = construirToolsDescription(toolsDisponibles);
const systemFinal = agente.prompt_sistema + "\n" + toolsDescription;

        // 4. Llamada a DeepSeek
        const aiResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: systemFinal },
                    { role: "user", content: prompt }
                ]
            })
        });

                const aiData = await aiResponse.json();

        if (!aiData.choices) {
            console.error("Error DeepSeek:", aiData);
            throw new Error("Error en la respuesta de la IA");
        }

        let respuestaIA = aiData.choices[0].message.content;

        // Intentar interpretar respuesta como acción JSON
        let actionPayload = null;
        try {
            actionPayload = JSON.parse(respuestaIA);
        } catch (_) {
            actionPayload = null;
        }

        // Ejecutar Google Calendar si el modelo pidió esa tool
                if (actionPayload && actionPayload.action === 'GOOGLECALENDAR_CREATE_EVENT') {
            const calendarConnection = (userConnections || []).find(
                c => String(c.toolkit).toLowerCase() === 'googlecalendar'
            );

            if (!calendarConnection?.composio_entity_id) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({
                        respuesta: "Google Calendar no está conectado para este usuario."
                    })
                };
            }

            const eventData = actionPayload.data || {};

            const payloadPendiente = {
                summary: eventData.summary || eventData.title || "Evento agendado desde el chat",
                description: eventData.description || "",
                start: eventData.start,
                end: eventData.end
            };

            // Cancelar cualquier pendiente anterior de este agente/usuario
            await supabase
                .from('pending_tool_actions')
                .update({ status: 'cancelled' })
                .eq('user_id', agente.user_id)
                .eq('agente_id', targetID)
                .eq('status', 'pending');

            // Guardar nueva acción pendiente
            const { error: errInsertPending } = await supabase
                .from('pending_tool_actions')
                .insert([{
                    user_id: agente.user_id,
                    agente_id: targetID,
                    action: 'GOOGLECALENDAR_CREATE_EVENT',
                    payload: payloadPendiente,
                    status: 'pending'
                }]);

            if (errInsertPending) {
                console.error("Error guardando pending_tool_actions:", errInsertPending);
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({
                        respuesta: "No pude preparar la confirmación del evento."
                    })
                };
            }

            respuestaIA = `Voy a agendar "${payloadPendiente.summary}" desde ${payloadPendiente.start} hasta ${payloadPendiente.end}. Responde "sí" para confirmar o "no" para cancelar.`;
        }

        // 5. Calcular tokens usados
        const totalCaracteres =
            (agente.prompt_sistema || "").length +
            (prompt || "").length +
            (respuestaIA || "").length;
        const tokensUsados = Math.ceil(totalCaracteres / 4) + 10;

        // 6. Descontar saldo del perfil
        await supabase
            .from('perfiles')
            .update({ token_balance: saldoActual - tokensUsados })
            .eq('id', agente.user_id);

        // 7. Registrar consumo en el agente
        await supabase.rpc('increment_agent_consumption', {
            agent_id: targetID,
            tokens: tokensUsados
        });
        // 8. Registrar en Logs de Consumo (NUEVO)
        await supabase
            .from('logs_consumo')
            .insert([{
                user_id: agente.user_id,
                agente_id: targetID,
                nombre_agente: agente.nombre_agente, // <--- REVISAR NOTA ABAJO
                tokens_usados: tokensUsados
            }]);

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
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Error procesando la solicitud." })
        };
    }
};
