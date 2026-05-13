const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
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
    const { subscription, user_id } = JSON.parse(event.body || '{}');

    if (!subscription || !user_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Faltan subscription o user_id' })
      };
    }

    if (!subscription.endpoint) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'La suscripción no tiene endpoint' })
      };
    }

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        {
          user_id,
          endpoint: subscription.endpoint,
          subscription: JSON.stringify(subscription),
          updated_at: new Date().toISOString()
        },
        {
          onConflict: 'user_id,endpoint'
        }
      );

    if (error) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: error.message })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        endpoint: subscription.endpoint
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
