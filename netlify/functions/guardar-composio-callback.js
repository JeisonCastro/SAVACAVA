const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    });

    const { data: userData, error: userError } = await supabaseUser.auth.getUser();

    if (userError || !userData?.user) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Usuario no autenticado' })
      };
    }

    const user = userData.user;
    const body = JSON.parse(event.body || '{}');
    const { toolkit } = body;

    if (!toolkit) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Falta toolkit' })
      };
    }

    const composioRes = await fetch(
      `https://backend.composio.dev/api/v3/connected_accounts?user_id=${encodeURIComponent(user.id)}`,
      {
        method: 'GET',
        headers: {
          'x-api-key': composioApiKey,
          'Content-Type': 'application/json'
        }
      }
    );

    const raw = await composioRes.text();

    let composioData;
    try {
      composioData = JSON.parse(raw);
    } catch (e) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Composio devolvió una respuesta no JSON al listar connected accounts',
          debug: raw
        })
      };
    }

    if (!composioRes.ok) {
      return {
        statusCode: composioRes.status,
        body: JSON.stringify({
          error: composioData?.error || composioData?.message || 'No se pudieron consultar las conexiones',
          debug: composioData
        })
      };
    }

    const items = composioData?.items || [];

    const cuenta = items.find(item => {
      const slug = item?.toolkit?.slug || item?.appName || item?.toolkit_slug || '';
      const status = item?.status || item?.connection_status || '';
      return slug.toLowerCase() === toolkit.toLowerCase() &&
        ['ACTIVE', 'ENABLED', 'CONNECTED'].includes(String(status).toUpperCase());
    });

    if (!cuenta) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: `No se encontró una conexión activa para ${toolkit}`,
          debug: composioData
        })
      };
    }

    const connectedId =
      cuenta?.id ||
      cuenta?.connected_account_id ||
      cuenta?.nanoid ||
      cuenta?.connection_id;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data: existente } = await supabaseAdmin
      .from('composio_connections')
      .select('id')
      .eq('user_id', user.id)
      .eq('toolkit', toolkit)
      .maybeSingle();

    let dbError = null;

    if (existente) {
      const { error } = await supabaseAdmin
        .from('composio_connections')
        .update({
          composio_entity_id: connectedId,
          connected_at: new Date().toISOString()
        })
        .eq('id', existente.id);

      dbError = error;
    } else {
      const { error } = await supabaseAdmin
        .from('composio_connections')
        .insert({
          user_id: user.id,
          toolkit,
          composio_entity_id: connectedId,
          connected_at: new Date().toISOString()
        });

      dbError = error;
    }

    if (dbError) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: dbError.message || 'No se pudo guardar la conexión en Supabase'
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        toolkit,
        connected_account_id: connectedId
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || 'Error interno al guardar callback de Composio'
      })
    };
  }
};
