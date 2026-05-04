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

function inferWhatsappMediaType(mimeType = '') {
  const mime = String(mimeType || '').toLowerCase();

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';

  return 'document';
}

function sanitizeFilename(name = 'archivo') {
  return String(name || 'archivo')
    .replace(/[^\w.\- áéíóúÁÉÍÓÚñÑ()]/g, '')
    .slice(0, 120) || 'archivo';
}

function base64ToBuffer(base64 = '') {
  const clean = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(clean, 'base64');
}

function buildMultipartBody({ buffer, filename, mimeType }) {
  const boundary = '----AUVROFormBoundary' + Math.random().toString(16).slice(2);
  const safeFilename = sanitizeFilename(filename);

  const parts = [];

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="messaging_product"\r\n\r\n` +
    `whatsapp\r\n`
  ));

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
    `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`
  ));

  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
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

  if (error) {
    throw new Error('Error consultando conversación: ' + error.message);
  }

  if (!data) {
    throw new Error('Conversación no encontrada o no pertenece al usuario.');
  }

  if (data.canal !== 'whatsapp') {
    throw new Error('El envío de adjuntos por ahora solo está habilitado para conversaciones de WhatsApp.');
  }

  return data;
}

async function getWhatsappConnection(agenteId, userId) {
  const { data, error } = await supabase
    .from('whatsapp_connections')
    .select('*')
    .eq('agente_id', agenteId)
    .eq('user_id', userId)
    .eq('activo', true)
    .maybeSingle();

  if (error) {
    throw new Error('Error consultando conexión de WhatsApp: ' + error.message);
  }

  if (!data) {
    throw new Error('No hay una conexión activa de WhatsApp para este agente.');
  }

  if (!data.phone_number_id || !data.access_token) {
    throw new Error('La conexión de WhatsApp no tiene phone_number_id o access_token.');
  }

  return data;
}

async function uploadMediaToMeta({ phoneNumberId, accessToken, file }) {
  const buffer = base64ToBuffer(file.base64);

  if (!buffer.length) {
    throw new Error('El archivo está vacío o no se pudo leer.');
  }

  const maxBytes = 15 * 1024 * 1024;
  if (buffer.length > maxBytes) {
    throw new Error('El archivo supera el límite permitido por esta función (15 MB).');
  }

  const { body, contentType } = buildMultipartBody({
    buffer,
    filename: file.name || 'archivo',
    mimeType: file.type || 'application/octet-stream'
  });

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': contentType,
      'Content-Length': String(body.length)
    },
    body
  });

  const raw = await res.text();

  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error('Meta devolvió una respuesta inválida al subir media: ' + raw);
  }

  if (!res.ok || !data.id) {
    const msg = data?.error?.message || data?.error || 'No se pudo subir el archivo a Meta.';
    throw new Error(msg);
  }

  return data.id;
}

async function sendMediaMessage({ phoneNumberId, accessToken, to, mediaId, mediaType, filename, caption }) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: mediaType
  };

  if (mediaType === 'image') {
    payload.image = {
      id: mediaId,
      caption: caption || undefined
    };
  } else if (mediaType === 'video') {
    payload.video = {
      id: mediaId,
      caption: caption || undefined
    };
  } else if (mediaType === 'audio') {
    payload.audio = {
      id: mediaId
    };
  } else {
    payload.document = {
      id: mediaId,
      filename: sanitizeFilename(filename || 'archivo'),
      caption: caption || undefined
    };
  }

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.error?.message || 'No se pudo enviar el adjunto por WhatsApp.';
    throw new Error(msg);
  }

  return data;
}

async function sendTextMessage({ phoneNumberId, accessToken, to, text }) {
  if (!text || !String(text).trim()) return null;

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        body: String(text).slice(0, 4000)
      }
    })
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.error?.message || 'No se pudo enviar el mensaje de texto por WhatsApp.';
    throw new Error(msg);
  }

  return data;
}

async function saveManualMediaMessage({ conversation, filesSent, mensaje, userId }) {
  const lines = [];

  if (mensaje && String(mensaje).trim()) {
    lines.push(String(mensaje).trim());
  }

  for (const file of filesSent) {
    lines.push(`📎 ${file.name}`);
  }

  const content = lines.join('\n') || '📎 Archivo enviado';

  await supabase
    .from('mensajes_conversacion')
    .insert([{
      conversacion_id: conversation.id,
      agente_id: conversation.agente_id,
      role: 'assistant',
      content,
      origen: 'humano',
      metadata: {
        origen: 'humano',
        tipo: 'media',
        enviado_por: userId,
        files: filesSent
      }
    }]);

  await supabase
    .from('conversaciones')
    .update({
      ultimo_mensaje: content,
      ultimo_role: 'assistant',
      requiere_atencion: false,
      updated_at: new Date().toISOString()
    })
    .eq('id', conversation.id);
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
    const mensaje = body.mensaje || '';
    const files = Array.isArray(body.files) ? body.files : [];

    if (!conversationId) {
      return jsonResponse(400, { error: 'Falta conversation_id.' });
    }

    if (!files.length) {
      return jsonResponse(400, { error: 'No se recibió ningún archivo.' });
    }

    const conversation = await getConversationForUser(conversationId, user.id);
    const waConnection = await getWhatsappConnection(conversation.agente_id, user.id);

    const to = conversation.external_user_id;

    if (!to) {
      return jsonResponse(400, { error: 'La conversación no tiene external_user_id destino.' });
    }

    const filesSent = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (!file?.base64 || !file?.name) {
        throw new Error('Uno de los archivos no tiene nombre o contenido base64.');
      }

      const mediaType = inferWhatsappMediaType(file.type);
      const caption = i === 0 ? mensaje : '';

      const mediaId = await uploadMediaToMeta({
        phoneNumberId: waConnection.phone_number_id,
        accessToken: waConnection.access_token,
        file
      });

      const sendResult = await sendMediaMessage({
        phoneNumberId: waConnection.phone_number_id,
        accessToken: waConnection.access_token,
        to,
        mediaId,
        mediaType,
        filename: file.name,
        caption
      });

      filesSent.push({
        name: sanitizeFilename(file.name),
        type: file.type || 'application/octet-stream',
        size: file.size || null,
        media_type: mediaType,
        media_id: mediaId,
        whatsapp_response: sendResult
      });
    }

    await saveManualMediaMessage({
      conversation,
      filesSent,
      mensaje,
      userId: user.id
    });

    return jsonResponse(200, {
      ok: true,
      conversation_id: conversation.id,
      files_sent: filesSent.length,
      files: filesSent
    });

  } catch (error) {
    console.error('enviar-whatsapp-media error:', error);
    return jsonResponse(500, {
      ok: false,
      error: error.message || 'Error enviando adjunto por WhatsApp.'
    });
  }
};
