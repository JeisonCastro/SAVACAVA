require('./supabase-admin');
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

    // Si no existe auth config habilitado, crear uno automáticamente (para Shopify API_KEY)
    if (!authConfig?.id) {
      console.log(`No auth config found for ${toolkit}, creating one with API_KEY scheme...`);

      const createConfigRes = await fetch('https://backend.composio.dev/api/v3/auth_configs', {
        method: 'POST',
        headers: {
          'x-api-key': composioApiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          toolkit: { slug: toolkit },
          auth_config: {
            type: 'use_custom_auth',
            auth_scheme: 'API_KEY',
            credentials: {}
          }
        })
      });

      const createConfigRaw = await createConfigRes.text();
      let createConfigData;
      try {
        createConfigData = JSON.parse(createConfigRaw);
      } catch (e) {
        return {
          statusCode: 500,
          body: JSON.stringify({
            error: 'Error parseando respuesta de creación de auth config',
            debug: createConfigRaw
          })
        };
      }

      if (!createConfigRes.ok) {
        return {
          statusCode: createConfigRes.status,
          body: JSON.stringify({
            error: createConfigData?.error || createConfigData?.message || 'No se pudo crear auth config para ' + toolkit,
            debug: createConfigData
          })
        };
      }

      // Usar el auth config recién creado
      const newAuthConfig = createConfigData?.auth_config || createConfigData;
      if (newAuthConfig?.id) {
        console.log(`Auth config created for ${toolkit}:`, newAuthConfig.id);

        // Crear link de conexión con el nuevo auth config
        const linkRes = await fetch('https://backend.composio.dev/api/v3/connected_accounts/link', {
          method: 'POST',
          headers: {
            'x-api-key': composioApiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            auth_config_id: newAuthConfig.id,
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
              error: 'Error parseando respuesta de link OAuth',
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
            authConfigId: newAuthConfig.id,
            connectedAccountId: linkData.connected_account_id || null,
            redirectUrl: linkData.redirect_url || null
          })
        };
      }
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
