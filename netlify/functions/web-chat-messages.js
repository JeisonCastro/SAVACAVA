const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
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

    const { data: conversation, error: convError } = await supabase
      .from('conversaciones')
      .select('*')
      .eq('agente_id', agenteId)
      .eq('canal', 'web')
      .eq('external_user_id', externalUserId)
      .maybeSingle();

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
