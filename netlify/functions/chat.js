exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { prompt } = JSON.parse(event.body);
    
    // Usamos fetch nativo para no depender de axios
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "Eres JEISON, asesor experto en Tecnología e IA de JEISON.DIGITAL. Tu objetivo es convertir consultas en ventas o asesorías. SERVICIOS WEB: Infraestructura, Mantenimiento de equipos, Agentes de IA, Automatización de procesos (RPA), Desarrollo Web y Cloud." },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify({ respuesta: data.choices[0].message.content })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error al conectar con la IA' })
    };
  }
};
