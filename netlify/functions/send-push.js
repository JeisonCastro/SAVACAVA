const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

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
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { user_id, title, body, url, conversationId } = JSON.parse(event.body || '{}');

    if (!user_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Falta user_id' })
      };
    }

    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, subscription')
      .eq('user_id', user_id);

    if (error) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: error.message })
      };
    }

    if (!subs || subs.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, sent: 0, reason: 'Sin suscripciones' })
      };
    }

    const payload = JSON.stringify({
      title: title || 'Nuevo mensaje en AUVRO',
      body: body || 'Tienes un nuevo mensaje.',
      url: url || '/dashboard.html#bandeja',
      conversationId: conversationId || null
    });

    const results = await Promise.allSettled(
      subs.map(async (row) => {
        try {
          const subscription =
            typeof row.subscription === 'string'
              ? JSON.parse(row.subscription)
              : row.subscription;

          await webpush.sendNotification(subscription, payload);

          return {
            id: row.id,
            ok: true
          };
        } catch (err) {
          const statusCode = err.statusCode || err.status;

          if (statusCode === 404 || statusCode === 410) {
            await supabase
              .from('push_subscriptions')
              .delete()
              .eq('id', row.id);
          }

          return {
            id: row.id,
            ok: false,
            statusCode,
            error: err.message
          };
        }
      })
    );

    const detail = results.map(r => r.value || r.reason);
    const sent = detail.filter(r => r?.ok).length;
    const failed = detail.length - sent;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        total: subs.length,
        sent,
        failed,
        detail
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
