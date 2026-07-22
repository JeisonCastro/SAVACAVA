const { supabase } = require('./supabase-admin');
const chatHandler = require('./chat.js').handler;

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'jeison_digital_verify_token';
const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v19.0';

async function getMetaMediaUrl(mediaId, accessToken) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.url) throw new Error(data?.error?.message || 'No se pudo obtener la URL del media.');
  return data;
}

async function downloadMetaMedia(url, accessToken) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error('No se pudo descargar el media desde Meta.');
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer, contentType };
}

async function enviarWhatsapp({ to, text, accessToken, phoneNumberId }) {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text.slice(0, 4000) }
      })
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.error('Error enviando WhatsApp:', data);
  return data;
}

async function guardarMensajeSaliente({ conversacion, agenteId, text, origen = 'ia' }) {
  await supabase.from('mensajes_conversacion').insert({
    conversacion_id: conversacion.id,
    agente_id: agenteId,
    role: 'assistant',
    content: text,
    origen,
    metadata: { canal: 'whatsapp' }
  });
}

// ── PUSH NOTIFICATIONS ──────────────────────────────────────────────────────
async function dispararPush({ userId, title, body, conversationId }) {
  try {
    if (!userId) return;

    const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://auvro.netlify.app';

    const res = await fetch(`${baseUrl}/.netlify/functions/send-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        title: title || 'Nuevo mensaje en AUVRO',
        body: String(body || 'Tienes un nuevo mensaje.').slice(0, 140),
        url: '/dashboard.html#bandeja',
        conversationId: conversationId || null,
        canal: 'whatsapp'
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      console.warn('[Push] No se pudo enviar:', data);
    } else {
      console.log('[Push] Enviado:', data);
    }
  } catch (err) {
    console.warn('[Push] Error enviando:', err.message);
  }
}


function extraerContenidoMensaje(message) {
  const type = message?.type || 'text';

  if (type === 'text') {
    return {
      type,
      content: message.text?.body || '',
      media_id: null,
      mime_type: null,
      filename: null,
      caption: null
    };
  }

  if (type === 'image') {
    return {
      type,
      content: message.image?.caption || '📷 Imagen recibida',
      media_id: message.image?.id || null,
      mime_type: message.image?.mime_type || null,
      filename: 'imagen-whatsapp.jpg',
      caption: message.image?.caption || null
    };
  }

  if (type === 'document') {
    return {
      type,
      content: message.document?.caption || `📎 Documento recibido${message.document?.filename ? ': ' + message.document.filename : ''}`,
      media_id: message.document?.id || null,
      mime_type: message.document?.mime_type || null,
      filename: message.document?.filename || 'documento-whatsapp',
      caption: message.document?.caption || null
    };
  }

  if (type === 'audio') {
    return {
      type,
      content: '🎧 Audio recibido',
      media_id: message.audio?.id || null,
      mime_type: message.audio?.mime_type || null,
      filename: 'audio-whatsapp.ogg',
      caption: null
    };
  }

  if (type === 'video') {
    return {
      type,
      content: message.video?.caption || '🎥 Video recibido',
      media_id: message.video?.id || null,
      mime_type: message.video?.mime_type || null,
      filename: 'video-whatsapp.mp4',
      caption: message.video?.caption || null
    };
  }

  if (type === 'sticker') {
    return {
      type,
      content: '🏷️ Sticker recibido',
      media_id: message.sticker?.id || null,
      mime_type: message.sticker?.mime_type || null,
      filename: 'sticker-whatsapp.webp',
      caption: null
    };
  }

  return {
    type,
    content: `Mensaje ${type} recibido`,
    media_id: null,
    mime_type: null,
    filename: null,
    caption: null
  };
}

async function obtenerOCrearConversacion({ agenteId, userId, canal, externalUserId }) {
  /*
    FIX IMPORTANTE:
    Si ya había conversaciones duplicadas del mismo número, maybeSingle()
    fallaba por múltiples filas y el webhook creaba otra conversación nueva.
    Ahora se toma la conversación más reciente para agente + canal + número.
  */
  const externalIdFinal = String(externalUserId || '').trim();

  const { data: existentes, error } = await supabase
    .from('conversaciones')
    .select('*')
    .eq('agente_id', agenteId)
    .eq('canal', canal)
    .eq('external_user_id', externalIdFinal)
    .order('updated_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false, nullsFirst: false })
    .limit(1);

  if (error) {
    console.error('Error buscando conversación:', error);
  }

  const existente = Array.isArray(existentes) ? existentes[0] : null;
  if (existente) return existente;

  const { data: nueva, error: insertError } = await supabase
    .from('conversaciones')
    .insert([{
      agente_id: agenteId,
      user_id: userId,
      canal,
      external_user_id: externalIdFinal,
      titulo: `WhatsApp ${externalIdFinal}`,
      estado: 'ia_activa',
      modo_humano: false,
      requiere_atencion: false,
      ultimo_mensaje: '',
      ultimo_role: 'user',
      updated_at: new Date().toISOString()
    }])
    .select('*')
    .single();

  if (insertError) {
    throw new Error('No se pudo crear conversación: ' + insertError.message);
  }

  return nueva;
}

async function guardarMensajeMediaEntrante({ conversacion, agenteId, contenido, rawMessage }) {
  await supabase
    .from('mensajes_conversacion')
    .insert([{
      conversacion_id: conversacion.id,
      agente_id: agenteId,
      role: 'user',
      content: contenido.content || 'Adjunto recibido',
      origen: 'cliente',
      metadata: {
        origen: 'cliente',
        tipo: contenido.type,
        media_id: contenido.media_id,
        mime_type: contenido.mime_type,
        filename: contenido.filename,
        caption: contenido.caption,
        whatsapp_message_id: rawMessage.id || null,
        from: rawMessage.from || null,
        timestamp: rawMessage.timestamp || null
      }
    }]);

  await supabase
    .from('conversaciones')
    .update({
      ultimo_mensaje: contenido.content || 'Adjunto recibido',
      ultimo_role: 'user',
      requiere_atencion: true,
      updated_at: new Date().toISOString()
    })
    .eq('id', conversacion.id);
}

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
    const contenido = extraerContenidoMensaje(message);
    const text = contenido.type === 'text' ? contenido.content : '';

    if (!from) {
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

    // 4. Obtener agente para conocer user_id
    const { data: agente, error: agenteError } = await supabase
      .from('agentes_ia')
      .select('id, user_id, nombre_agente')
      .eq('id', agenteId)
      .maybeSingle();

    if (agenteError || !agente) {
      console.error('Agente no encontrado:', agenteError);
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: false, error: 'Agente no encontrado' })
      };
    }

    // 5. Si es media, procesar según tipo
    if (contenido.type !== 'text') {
      const conversacion = await obtenerOCrearConversacion({
        agenteId,
        userId: agente.user_id,
        canal: 'whatsapp',
        externalUserId: from
      });

      await guardarMensajeMediaEntrante({
        conversacion,
        agenteId,
        contenido,
        rawMessage: message
      });

      // 🔔 Push automático para adjuntos entrantes de WhatsApp.
      await dispararPush({
        userId: agente.user_id,
        title: `📱 WhatsApp +${from}`,
        body: contenido.content || 'Adjunto recibido',
        conversationId: conversacion.id
      });

      // Si es imagen, descargar y enviar a la IA para análisis
      if (contenido.type === 'image' && contenido.media_id && waConnection.access_token) {
        try {
          const metaUrl = await getMetaMediaUrl(contenido.media_id, waConnection.access_token);
          const downloaded = await downloadMetaMedia(metaUrl.url, waConnection.access_token);
          const imageDataUrl = `data:${downloaded.contentType};base64,${downloaded.buffer.toString('base64')}`;

          const imagePrompt = contenido.caption || 'Describe esta imagen en detalle';
          const chatEvent = {
            httpMethod: 'POST',
            headers: { 'Content-Type': 'application/json', 'origin': '' },
            body: JSON.stringify({
              prompt: imagePrompt,
              agente_id: agenteId,
              canal: 'whatsapp',
              external_user_id: from,
              image_url: imageDataUrl
            })
          };

          const chatResponse = await chatHandler(chatEvent);
          const chatData = JSON.parse(chatResponse.body || '{}');

          if (chatData.respuesta) {
            await enviarWhatsapp({
              to: from,
              text: chatData.respuesta,
              accessToken: waConnection.access_token,
              phoneNumberId: waConnection.phone_number_id
            });

            await guardarMensajeSaliente({
              conversacion,
              agenteId,
              text: chatData.respuesta,
              origen: 'ia'
            });
          }
        } catch (imgErr) {
          console.error('Error procesando imagen con IA:', imgErr.message);
        }
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          received_media: true,
          type: contenido.type,
          media_id: contenido.media_id,
          conversation_id: conversacion.id
        })
      };
    }

    if (!text.trim()) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, ignored: true })
      };
    }

    // Conversation estable por agente + número del usuario
    const conversationId = `wa_${agenteId}_${from}`;

    // 6. Llamar a chat.js directamente (sin HTTP)
    const chatEvent = {
      httpMethod: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'origin': ''
      },
      body: JSON.stringify({
        prompt: text,
        agente_id: agenteId,
        conversation_id: conversationId,
        historial: [],
        canal: "whatsapp",
        external_user_id: from
      })
    };

    let chatResult;
    try {
      chatResult = await chatHandler(chatEvent);
    } catch (chatErr) {
      console.error('Error ejecutando chat handler:', chatErr);
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: false,
          error: 'Error procesando mensaje: ' + chatErr.message
        })
      };
    }

    let chatData;
    try {
      chatData = JSON.parse(chatResult.body || '{}');
    } catch (parseErr) {
      console.error('Error parseando respuesta de chat:', parseErr);
      chatData = {};
    }

    if (chatData.skipped === true) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          skipped: true,
          motivo: chatData.motivo,
          conversation_id: chatData.conversation_id
        })
      };
    }

    const respuesta =
      chatData.respuesta ||
      chatData.error ||
      'Lo siento, no pude procesar tu mensaje en este momento.';

    // 7. Responder por WhatsApp Cloud API
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
