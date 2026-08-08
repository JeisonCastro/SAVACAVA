const { supabase } = require('./supabase-admin');

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const agenteId = body.agente_id;
    const externalUserId = body.external_user_id;

    if (!agenteId || !externalUserId) {
      return jsonResponse(400, {
        error: 'Falta agente_id o external_user_id.'
      });
    }

    const auth = event.headers.authorization || event.headers.Authorization || "";
    if (auth) {
      const token = String(auth).replace(/^Bearer\s+/i, "").trim();
      const { data: userData, error: authError } = await supabase.auth.getUser(token);

      if (authError || !userData?.user) {
        return jsonResponse(401, { error: 'Sesión inválida o expirada. Inicia sesión de nuevo.' });
      }

      if (externalUserId !== userData.user.id) {
        return jsonResponse(403, { error: 'No tienes acceso a esta conversación.' });
      }
    }

    // Query a prueba de duplicados: si existen varias conversaciones para el
    // mismo agente+canal+external_user_id, tomamos la más reciente (mismo fix de chat.js).
    const { data: convs, error: convError } = await supabase
      .from('conversaciones')
      .select('*')
      .eq('agente_id', agenteId)
      .eq('canal', 'web')
      .eq('external_user_id', externalUserId)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false, nullsFirst: false })
      .limit(1);

    const conversation = Array.isArray(convs) ? convs[0] : null;

    if (convError) {
      return jsonResponse(500, {
        error: convError.message
      });
    }

    if (!conversation) {
      return jsonResponse(200, {
        ok: true,
        conversation: null,
        messages: []
      });
    }

    const { data: messages, error: msgError } = await supabase
      .from('mensajes_conversacion')
      .select('id, conversacion_id, role, content, origen, metadata, created_at')
      .eq('conversacion_id', conversation.id)
      .order('created_at', { ascending: true })
      .limit(100);

    if (msgError) {
      return jsonResponse(500, {
        error: msgError.message
      });
    }

    return jsonResponse(200, {
      ok: true,
      conversation,
      messages: messages || []
    });

  } catch (error) {
    console.error('web-chat-messages error:', error);

    return jsonResponse(500, {
      error: error.message || 'Error consultando mensajes web.'
    });
  }
};
