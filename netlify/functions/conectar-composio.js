const { createClient } = require('@supabase/supabase-js');
const { Composio } = require('@composio/core');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const composioApiKey = process.env.COMPOSIO_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Token no enviado' })
      };
    }

    const token = authHeader.replace('Bearer ', '');
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Usuario no autenticado' })
      };
    }

    const user = userData.user;
    const body = JSON.parse(event.body || '{}');
    const { toolkit, callbackUrl } = body;

    if (!toolkit) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Falta toolkit' })
      };
    }

    const composio = new Composio({
      apiKey: composioApiKey
    });

    const session = await composio.create(user.id);

    const connectionRequest = await session.authorize(toolkit, {
      callbackUrl
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        toolkit,
        redirectUrl: connectionRequest.redirectUrl || connectionRequest.url || null,
        sessionId: session.id || null
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || 'Error interno al conectar con Composio'
      })
    };
  }
};
