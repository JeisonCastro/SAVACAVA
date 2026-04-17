const { createClient } = require('@supabase/supabase-js');

// Conexión con tus variables de Netlify
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { prompt } = JSON.parse(event.body);

    // Buscamos el agente con ID 1 en Supabase
    const { data: agente, error } = await supabase
      .from('agentes_ia')
      .select('*')
      .eq('id', process.env.AGENTE_MAESTRO_ID)
      .single();

    if (error || !agente) {
      return { 
        statusCode: 404, 
        body: JSON.stringify({ respuesta: "No se encontró la configuración del agente en la base de datos." }) 
      };
    }

    // Llamada a DeepSeek usando el prompt de la base de datos
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
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

    const aiData = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify({ respuesta: aiData.choices[0].message.content })
    };

  } catch (err) {
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: "Error en el servidor de la fábrica de agentes." }) 
    };
  }
};
