const { supabase } = require('./supabase-admin');

function normalizarListaCorreos(valor) {
  if (Array.isArray(valor)) return valor.filter(v => typeof v === 'string' && v.trim());
  if (typeof valor === 'string' && valor.trim()) {
    return valor.split(',').map(v => v.trim()).filter(Boolean);
  }
  return [];
}

async function ejecutarToolComposio(toolSlug, connectedAccountId, userId, args) {
  if (!process.env.COMPOSIO_API_KEY) {
    return { ok: false, error: 'composio_api_key_not_configured' };
  }

  const res = await fetch(`https://backend.composio.dev/api/v3.1/tools/execute/${toolSlug}`, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.COMPOSIO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      connected_account_id: connectedAccountId,
      user_id: userId,
      arguments: args
    })
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    return { ok: false, error: `Respuesta inválida de Composio: ${raw}` };
  }

  if (!res.ok || data?.successful === false) {
    const error = data?.error?.message || data?.error || data?.message || 'Error ejecutando Gmail en Composio';
    return { ok: false, error, data };
  }

  return { ok: true, data };
}

async function registrarNotificacion({ userId, agenteId, leadId, conversationId, eventType, channel, recipient, subject, status, externalId, error }) {
  try {
    await supabase.from('notifications').insert({
      user_id: userId,
      agente_id: agenteId,
      lead_id: leadId,
      conversation_id: conversationId,
      event_type: eventType,
      channel: channel || 'email',
      recipient,
      subject,
      status: status || 'pending',
      external_id: externalId,
      error: error ? String(error).slice(0, 2000) : null,
      created_at: new Date().toISOString()
    });
  } catch (err) {
    console.warn('No se pudo registrar en notifications (¿migración aplicada?):', err.message);
  }
}

async function sendEmail({ to, subject, text, html, cc, bcc, agente = null, userId = null, agenteId = null, leadId = null, conversationId = null, eventType = 'email' }) {
  try {
    const ownerUserId = userId || agente?.user_id;
    if (!ownerUserId) {
      return { ok: false, error: 'missing_user_id' };
    }

    const { data: gmailConn, error } = await supabase
      .from('composio_connections')
      .select('toolkit, composio_entity_id')
      .eq('user_id', ownerUserId)
      .eq('toolkit', 'gmail')
      .limit(1)
      .maybeSingle();

    if (error) {
      return { ok: false, error: error.message };
    }

    if (!gmailConn?.composio_entity_id) {
      console.warn('Gmail not connected for user', ownerUserId);
      await registrarNotificacion({
        userId: ownerUserId, agenteId, leadId, conversationId,
        eventType, channel: 'email', recipient: to, subject,
        status: 'failed', error: 'gmail_not_connected'
      });
      return { ok: false, error: 'gmail_not_connected' };
    }

    const resultado = await ejecutarToolComposio(
      'GMAIL_SEND_EMAIL',
      gmailConn.composio_entity_id,
      ownerUserId,
      {
        to,
        subject,
        body: html || text || '',
        cc: normalizarListaCorreos(cc),
        bcc: normalizarListaCorreos(bcc)
      }
    );

    await registrarNotificacion({
      userId: ownerUserId, agenteId, leadId, conversationId,
      eventType, channel: 'email', recipient: to, subject,
      status: resultado.ok ? 'sent' : 'failed',
      externalId: resultado.ok ? (resultado.data?.id || resultado.data?.response_data?.id || null) : null,
      error: resultado.ok ? null : (typeof resultado.error === 'string' ? resultado.error : JSON.stringify(resultado.error))
    });

    return resultado;
  } catch (err) {
    console.error('Error sending email via Gmail Composio:', err.message);
    return { ok: false, error: err.message };
  }
}

async function sendWhatsAppText({ agentId, toPhone, text }) {
  try {
    const { data: conn } = await supabase
      .from('whatsapp_connections')
      .select('*')
      .eq('agente_id', agentId)
      .eq('activo', true)
      .limit(1)
      .maybeSingle();

    if (!conn || !conn.access_token || !conn.phone_number_id) {
      console.warn('No whatsapp connection for agent', agentId);
      return { ok: false, error: 'no_whatsapp_connection' };
    }

    const res = await fetch(`https://graph.facebook.com/v19.0/${conn.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conn.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: toPhone.replace(/[^0-9]/g, ''), type: 'text', text: { body: text.slice(0, 4096) } })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body };
    return { ok: true, body };
  } catch (err) {
    console.error('Error sending WhatsApp:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendEmail, sendWhatsAppText, registrarNotificacion };
