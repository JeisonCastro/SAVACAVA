const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { subscription, user_id } = JSON.parse(event.body);
    if (!subscription || !user_id) return { statusCode: 400, body: JSON.stringify({ error: 'Faltan datos' }) };

    await supabase.from('push_subscriptions').upsert({
      user_id,
      subscription: JSON.stringify(subscription),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
