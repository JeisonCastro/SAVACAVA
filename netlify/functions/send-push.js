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
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { user_id, title, body, url, conversationId } = JSON.parse(event.body);

    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('user_id', user_id);

    if (!subs || subs.length === 0) return { statusCode: 200, body: JSON.stringify({ ok: true, sent: 0 }) };

    const payload = JSON.stringify({ title, body, url, conversationId });

    await Promise.allSettled(
      subs.map(row =>
        webpush.sendNotification(JSON.parse(row.subscription), payload)
      )
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, sent: subs.length }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
