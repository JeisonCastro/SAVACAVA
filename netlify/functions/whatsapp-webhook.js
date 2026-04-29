const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'jeison_digital_verify_token';

exports.handler = async (event) => {
  try {
    // 1. Verificación inicial de Meta
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};

      const mode = params['hub.mode'];
      const token = params['hub.verify_token'];
      const challenge = params['hub.challenge'];

      if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return {
          statusCode: 200,
          body: challenge
        };
      }

      return {
        statusCode: 403,
        body: 'Token de verificación inválido'
      };
    }

    // 2. Recibir mensajes
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: 'Method Not Allowed'
      };
    }

    const body = JSON.parse(event.body || '{}');

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const phoneNumberId = value?.metadata?.phone_number_id;
    const message = value?.messages?.[0];

    console.log('Phone Number ID recibido desde Meta:', phoneNumberId);

    // Meta también envía estados de entrega; esos no se responden
    if (!phoneNumberId || !message) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, ignored: true })
      };
    }

    const from = message.from;
    const text = message.text?.body || '';

    if (!from || !text.trim()) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, ignored: true })
      };
    }

    // 3. Buscar conexión activa por Phone Number ID
    const { data: waConnection, error: waError } = await supabase
      .from('whatsapp_connections')
      .select('*')
      .eq('phone_number_id', phoneNumberId)
      .eq('activo', true)
      .maybeSingle();

    if (waError || !waConnection) {
      console.error('WhatsApp connection not found:', waError);
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: false, error: 'Conexión WhatsApp no encontrada' })
      };
    }

    const agenteId = waConnection.agente_id;

    // Conversation estable por agente + número del usuario
    const conversationId = `wa_${agenteId}_${from}`;

    // 4. Llamar a la función chat
    const chatUrl = `${process.env.URL || 'https://jeisondigital.netlify.app'}/.netlify/functions/chat`;

    const chatRes = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: text,
        agente_id: agenteId,
        conversation_id: conversationId,
        historial: [],
        canal: "whatsapp"
      })
    });

    const chatData = await chatRes.json();

    const respuesta =
      chatData.respuesta ||
      chatData.error ||
      'Lo siento, no pude procesar tu mensaje en este momento.';

    // 5. Responder por WhatsApp Cloud API
    const sendRes = await fetch(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${waConnection.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: from,
          type: 'text',
          text: {
            body: respuesta.slice(0, 4000)
          }
        })
      }
    );

    const sendData = await sendRes.json();

    if (!sendRes.ok) {
      console.error('Error enviando WhatsApp:', sendData);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        received: text,
        response: respuesta,
        whatsapp_send: sendData
      })
    };

  } catch (error) {
    console.error('whatsapp-webhook error:', error);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: false,
        error: error.message
      })
    };
  }
};
