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
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, { ok: true });
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method Not Allowed' });

  try {
    const body = JSON.parse(event.body || '{}');
    const agenteId = body.agente_id || body.agent_id;
    const externalUserId = String(body.external_user_id || '').trim();

    if (!agenteId || !externalUserId) {
      return jsonResponse(400, { error: 'Falta agente_id o external_user_id.' });
    }

    const { data: conversacion, error: convError } = await supabase
      .from('conversaciones')
      .select('id, estado, modo_humano, requiere_atencion, updated_at')
      .eq('agente_id', parseInt(agenteId))
      .eq('canal', 'web')
      .eq('external_user_id', externalUserId)
      .maybeSingle();

    if (convError) return jsonResponse(500, { error: 'Error consultando conversación: ' + convError.message });
    if (!conversacion) return jsonResponse(200, { ok: true, conversation: null, messages: [] });

    const { data: mensajes, error: msgError } = await supabase
      .from('mensajes_conversacion')
      .select('id, role, content, origen, metadata, created_at')
      .eq('conversacion_id', conversacion.id)
      .order('created_at', { ascending: true })
      .limit(300);

    if (msgError) return jsonResponse(500, { error: 'Error consultando mensajes: ' + msgError.message });

    return jsonResponse(200, { ok: true, conversation: conversacion, messages: mensajes || [] });
  } catch (error) {
    console.error('web-chat-messages error:', error);
    return jsonResponse(500, { error: error.message || 'Error interno.' });
  }
};
