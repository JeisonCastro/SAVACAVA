const { createClient } = require('@supabase/supabase-js');

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
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Token no enviado' })
      };
    }

    const token = authHeader.replace('Bearer ', '');

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
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

    if (!callbackUrl) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Falta callbackUrl' })
      };
    }

    // 1) Crear o recuperar sesión de usuario en Composio
    const sessionRes = await fetch('https://backend.composio.dev/api/v3/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': composioApiKey
      },
      body: JSON.stringify({
        userId: user.id
      })
    });

    const sessionData = await sessionRes.json();

    if (!sessionRes.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: sessionData?.message || sessionData?.error || 'No se pudo crear la sesión en Composio',
          debug: sessionData
        })
      };
    }

    const sessionId = sessionData?.id || sessionData?.sessionId || sessionData?.data?.id;

    if (!sessionId) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Composio no devolvió sessionId',
          debug: sessionData
        })
      };
    }

    // 2) Iniciar autenticación del toolkit
    const authRes = await fetch(`https://backend.composio.dev/api/v3/sessions/${sessionId}/connections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': composioApiKey
      },
      body: JSON.stringify({
        toolkit,
        callbackUrl
      })
    });

    const authData = await authRes.json();

    if (!authRes.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: authData?.message || authData?.error || 'No se pudo iniciar la autenticación en Composio',
          debug: authData
        })
      };
    }

    const redirectUrl =
      authData?.redirectUrl ||
      authData?.url ||
      authData?.data?.redirectUrl ||
      authData?.data?.url;

    if (!redirectUrl) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Composio no devolvió URL de autenticación',
          debug: authData
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        toolkit,
        sessionId,
        redirectUrl
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
