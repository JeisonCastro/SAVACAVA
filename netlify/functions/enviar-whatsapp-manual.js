const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getBearerToken(event) {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const token = getBearerToken(event);
    if (!token) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'No autenticado.' }) };
    }

    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData?.user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Sesión inválida.' }) };
    }

    const user = authData.user;
    const body = JSON.parse(event.body || '{}');
    const conversationId = body.conversation_id;
    const mensaje = String(body.mensaje || '').trim();

    if (!conversationId || !mensaje) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta conversation_id o mensaje.' }) };
    }

    const { data: conversacion, error: convError } = await supabase
      .from('conversaciones')
      .select('*')
      .eq('id', conversationId)
      .eq('user_id', user.id)
      .single();

    if (convError || !conversacion) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Conversación no encontrada.' }) };
    }

    const canal = conversacionSeleccionada.canal || 'web';

if (adjuntosManual.length > 0 && canal !== 'whatsapp') {
    return showToast('Por ahora los adjuntos manuales solo se envían por WhatsApp. Para web usa texto.', 'error');
}

    const { data: waConnection, error: waError } = await supabase
      .from('whatsapp_connections')
      .select('*')
      .eq('agente_id', conversacion.agente_id)
      .eq('user_id', user.id)
      .eq('activo', true)
      .maybeSingle();

    if (waError || !waConnection) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Conexión WhatsApp activa no encontrada para este agente.' }) };
    }

    const sendRes = await fetch(
      `https://graph.facebook.com/v19.0/${waConnection.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${waConnection.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: conversacion.external_user_id,
          type: 'text',
          text: { body: mensaje.slice(0, 4000) }
        })
      }
    );

    const sendData = await sendRes.json();
    if (!sendRes.ok) {
      console.error('Error enviando WhatsApp manual:', sendData);
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Meta no aceptó el mensaje.', meta: sendData }) };
    }

    await supabase
      .from('mensajes_conversacion')
      .insert([{
        conversacion_id: conversationId,
        agente_id: conversacion.agente_id,
        role: 'assistant',
        content: mensaje,
        origen: 'humano',
        metadata: { canal: 'whatsapp', origen: 'humano', enviado_por: user.id, meta: sendData }
      }]);

    await supabase
      .from('conversaciones')
      .update({
        ultimo_mensaje: mensaje.slice(0, 1000),
        ultimo_role: 'assistant',
        requiere_atencion: false,
        modo_humano: true,
        estado: 'modo_humano',
        intervenida_por: user.id,
        intervenida_en: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', conversationId);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, whatsapp_send: sendData })
    };
  } catch (error) {
    console.error('enviar-whatsapp-manual error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message || 'Error interno.' }) };
  }
};
