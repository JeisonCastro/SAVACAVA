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

    // 1) Buscar auth config del toolkit
    const authConfigsRes = await fetch(
      `https://backend.composio.dev/api/v3/auth_configs?toolkit=${encodeURIComponent(toolkit)}`,
      {
        method: 'GET',
        headers: {
          'x-api-key': composioApiKey,
          'Content-Type': 'application/json'
        }
      }
    );

    const authConfigsRaw = await authConfigsRes.text();

    let authConfigsData;
    try {
      authConfigsData = JSON.parse(authConfigsRaw);
    } catch (e) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Composio devolvió una respuesta no JSON al listar auth configs',
          debug: authConfigsRaw
        })
      };
    }

    if (!authConfigsRes.ok) {
      return {
        statusCode: authConfigsRes.status,
        body: JSON.stringify({
          error: authConfigsData?.error || authConfigsData?.message || 'No se pudieron consultar auth configs',
          debug: authConfigsData
        })
      };
    }

    const authConfigs = authConfigsData?.items || [];
    const authConfig = authConfigs.find(
      (cfg) =>
        cfg?.toolkit?.slug?.toLowerCase() === toolkit.toLowerCase() &&
        (cfg?.status === 'ENABLED' || !cfg?.status)
    );

    if (!authConfig?.id) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `No existe un auth config habilitado para ${toolkit} en Composio`,
          debug: authConfigsData
        })
      };
    }

    // 2) Crear link OAuth para el usuario
    const linkRes = await fetch('https://backend.composio.dev/api/v3/connected_accounts/link', {
      method: 'POST',
      headers: {
        'x-api-key': composioApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        auth_config_id: authConfig.id,
        user_id: user.id,
        callback_url: callbackUrl
      })
    });

    const linkRaw = await linkRes.text();

    let linkData;
    try {
      linkData = JSON.parse(linkRaw);
    } catch (e) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Composio devolvió una respuesta no JSON al crear el auth link',
          debug: linkRaw
        })
      };
    }

    if (!linkRes.ok) {
      return {
        statusCode: linkRes.status,
        body: JSON.stringify({
          error: linkData?.error || linkData?.message || 'No se pudo crear el link OAuth',
          debug: linkData
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        toolkit,
        authConfigId: authConfig.id,
        connectedAccountId: linkData.connected_account_id || null,
        redirectUrl: linkData.redirect_url || null
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
