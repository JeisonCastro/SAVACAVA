const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

        // 3. Verificar si tiene saldo suficiente
        if (saldoActual < 100) {
            return {
                statusCode: 402,
                headers,
                body: JSON.stringify({ respuesta: "Saldo insuficiente en Jeison.Digital. Por favor, recarga tu cuenta." })
            };
        }

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
                    { role: "system", content: agente.prompt_sistema },
                    { role: "user", content: prompt }
                ]
            })
        });

        const aiData = await aiResponse.json();

        if (!aiData.choices) {
            console.error("Error DeepSeek:", aiData);
            throw new Error("Error en la respuesta de la IA");
        }

        const respuestaIA = aiData.choices[0].message.content;

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
