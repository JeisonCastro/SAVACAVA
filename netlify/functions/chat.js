const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const { prompt, agente_id } = JSON.parse(event.body);
        const targetID = agente_id || process.env.AGENTE_MAESTRO_ID;

        // 1. Obtener datos del agente y el ID del dueño
        const { data: agente, error: errAgente } = await supabase
            .from('agentes_ia')
            .select('*, perfiles(token_balance)')
            .eq('id', targetID)
            .single();

        if (errAgente || !agente) return { statusCode: 404, body: JSON.stringify({ respuesta: "Agente no encontrado." }) };

        const saldoActual = agente.perfiles.token_balance;

        // 2. Verificar si tiene saldo (Mínimo 100 tokens para seguridad)
        if (saldoActual < 100) {
            return { 
                statusCode: 402, 
                body: JSON.stringify({ respuesta: "Saldo de tokens insuficiente. Por favor, recarga tu cuenta." }) 
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
        const respuestaIA = aiData.choices[0].message.content;

        // 4. CÁLCULO DE TOKENS (Aprox: caracteres totales / 4)
        // Sumamos prompt del sistema + pregunta del usuario + respuesta de la IA
        const totalCaracteres = agente.prompt_sistema.length + prompt.length + respuestaIA.length;
        const tokensUsados = Math.ceil(totalCaracteres / 4) + 10; // +10 de base por overhead

        // 5. ACTUALIZAR SALDOS (Restar en Perfil y Sumar en Agente como gasto)
        // Restar de la billetera global
        await supabase
            .from('perfiles')
            .update({ token_balance: saldoActual - tokensUsados })
            .eq('id', agente.user_id);

        // Opcional: Registrar consumo en el agente
        await supabase.rpc('increment_agent_consumption', { 
            agent_id: targetID, 
            tokens: tokensUsados 
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                respuesta: respuestaIA,
                tokens_consumidos: tokensUsados 
            })
        };

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: "Error procesando el consumo." }) };
    }
};
