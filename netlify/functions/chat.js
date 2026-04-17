const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
    // --- AJUSTE 1: Configuración de Headers de CORS ---
    const headers = {
        "Access-Control-Allow-Origin": "*", // Permite peticiones desde cualquier web
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
    };

    // Manejar la petición "preflight" de los navegadores
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: 'Method Not Allowed' };
    }

    try {
        const { prompt, agente_id } = JSON.parse(event.body);
        const targetID = agente_id || process.env.AGENTE_MAESTRO_ID;

        // 1. Obtener datos del agente y el ID del dueño
        const { data: agente, error: errAgente } = await supabase
            .from('agentes_ia')
            .select('*, perfiles(token_balance)')
            .eq('id', targetID)
            .single();

        if (errAgente || !agente) {
            return { statusCode: 404, headers, body: JSON.stringify({ respuesta: "Agente no encontrado." }) };
        }

        const saldoActual = agente.perfiles.token_balance;

        // 2. Verificar si tiene saldo
        if (saldoActual < 100) {
            return { 
                statusCode: 402, 
                headers,
                body: JSON.stringify({ respuesta: "Saldo insuficiente en Jeison.Digital. Por favor, recarga tu cuenta." }) 
            };
        }

        // 3. Llamada a DeepSeek
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
        
        // Manejo de error por si DeepSeek falla
        if (!aiData.choices) {
            throw new Error("Error en la respuesta de la IA");
        }

        const respuestaIA = aiData.choices[0].message.content;

        // 4. CÁLCULO DE TOKENS
        const totalCaracteres = (agente.prompt_sistema || "").length + (prompt || "").length + (respuestaIA || "").length;
        const tokensUsados = Math.ceil(totalCaracteres / 4) + 10;

        // 5. ACTUALIZAR SALDOS
        // Restar de la billetera global
        await supabase
            .from('perfiles')
            .update({ token_balance: saldoActual - tokensUsados })
            .eq('id', agente.user_id);

        // Registrar consumo en el agente
        await supabase.rpc('increment_agent_consumption', { 
            agent_id: targetID, 
            tokens: tokensUsados 
        });

        return {
            statusCode: 200,
            headers, // --- AJUSTE 2: Devolver siempre los headers ---
            body: JSON.stringify({ 
                respuesta: respuestaIA,
                tokens_consumidos: tokensUsados 
            })
        };

    } catch (err) {
        console.error("Error:", err);
        return { 
            statusCode: 500, 
            headers, 
            body: JSON.stringify({ error: "Error procesando el consumo." }) 
        };
    }
};
