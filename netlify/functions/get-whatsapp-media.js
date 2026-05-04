const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v19.0';

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

function getBearerToken(event) {
  const header = event.headers.authorization || event.headers.Authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

function sanitizeFilename(name = 'archivo') {
  return String(name || 'archivo')
    .replace(/[^\w.\- áéíóúÁÉÍÓÚñÑ()]/g, '')
    .slice(0, 140) || 'archivo';
}

function extensionFromMime(mime = '') {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'application/pdf': 'pdf'
  };
  return map[String(mime).toLowerCase()] || 'bin';
}

async function verifyUser(event) {
  const token = getBearerToken(event);

  if (!token) {
    throw new Error('No se recibió token de sesión.');
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    throw new Error('Sesión inválida o expirada.');
  }

  return data.user;
}

async function getConversationForUser(conversationId, userId) {
  const { data, error } = await supabase
    .from('conversaciones')
    .select('*')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error('Error consultando conversación: ' + error.message);
  if (!data) throw new Error('Conversación no encontrada o no pertenece al usuario.');

  return data;
}

async function getMessageForConversation(messageId, conversationId, mediaId) {
  let query = supabase
    .from('mensajes_conversacion')
    .select('*')
    .eq('conversacion_id', conversationId);

  if (messageId) {
    query = query.eq('id', messageId);
  }

  const { data, error } = await query.limit(20);

  if (error) throw new Error('Error consultando mensaje: ' + error.message);

  const msg = (data || []).find(m => {
    const meta = m.metadata || {};
    return String(m.id) === String(messageId) ||
      String(meta.media_id || meta.mediaId || meta.id || '') === String(mediaId);
  });

  if (!msg) throw new Error('Mensaje con adjunto no encontrado.');

  const meta = msg.metadata || {};
  const savedMediaId = meta.media_id || meta.mediaId || meta.id;

  if (!savedMediaId || String(savedMediaId) !== String(mediaId)) {
    throw new Error('El media_id no coincide con el mensaje solicitado.');
  }

  return msg;
}

async function getWhatsappConnection(agenteId, userId) {
  const { data, error } = await supabase
    .from('whatsapp_connections')
    .select('*')
    .eq('agente_id', agenteId)
    .eq('user_id', userId)
    .eq('activo', true)
    .maybeSingle();

  if (error) throw new Error('Error consultando conexión WhatsApp: ' + error.message);
  if (!data) throw new Error('No hay conexión activa de WhatsApp para este agente.');

  return data;
}

async function getMetaMediaUrl(mediaId, accessToken) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || !data?.url) {
    const msg = data?.error?.message || 'No se pudo obtener la URL del adjunto en Meta.';
    throw new Error(msg);
  }

  return data;
}

async function downloadMetaMedia(url, accessToken) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!res.ok) {
    throw new Error('No se pudo descargar el archivo desde Meta.');
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = res.headers.get('content-type') || 'application/octet-stream';

  return { buffer, contentType };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  try {
    const user = await verifyUser(event);
    const body = JSON.parse(event.body || '{}');

    const conversationId = body.conversation_id;
    const messageId = body.message_id;
    const mediaId = body.media_id;

    if (!conversationId || !mediaId) {
      return jsonResponse(400, { error: 'Falta conversation_id o media_id.' });
    }

    const conversation = await getConversationForUser(conversationId, user.id);
    const message = await getMessageForConversation(messageId, conversation.id, mediaId);
    const connection = await getWhatsappConnection(conversation.agente_id, user.id);

    const meta = message.metadata || {};
    const mediaMeta = await getMetaMediaUrl(mediaId, connection.access_token);
    const downloaded = await downloadMetaMedia(mediaMeta.url, connection.access_token);

    const mimeType = meta.mime_type || mediaMeta.mime_type || downloaded.contentType || 'application/octet-stream';
    const filename = sanitizeFilename(
      meta.filename ||
      mediaMeta.filename ||
      `whatsapp-media-${mediaId}.${extensionFromMime(mimeType)}`
    );

    const base64 = downloaded.buffer.toString('base64');

    return jsonResponse(200, {
      ok: true,
      media_id: mediaId,
      mime_type: mimeType,
      filename,
      size: downloaded.buffer.length,
      data_url: `data:${mimeType};base64,${base64}`
    });

  } catch (error) {
    console.error('get-whatsapp-media error:', error);
    return jsonResponse(500, {
      ok: false,
      error: error.message || 'No se pudo cargar el adjunto.'
    });
  }
};
