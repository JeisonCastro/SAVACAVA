// conectar-gmail-tienda.js — Conectar el Gmail DEL CLIENTE de una tienda (Web Factory)
//
// Espejo del flujo "Conectar" de las integraciones del agente (conectar-composio),
// pero anclado a una tienda (proyecto web plantilla "tienda"). Cada tienda usa un
// namespace propio en Composio ("tienda:<proyecto_id>"), así el Gmail de un cliente
// nunca se mezcla con el de otro ni con el del agente.
//
// Acciones (POST, Bearer + perfiles.is_admin + dueño del proyecto):
//   link    { proyecto_id } -> devuelve la URL de OAuth de Google (redirectUrl)
//   guardar { proyecto_id } -> tras el OAuth, guarda el entity en tienda_pasarela
//
// El callback de OAuth vuelve a dashboard.html?tienda_gmail=<proyecto_id> y el
// dashboard llama a `guardar` automáticamente.

const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const composioApiKey = process.env.COMPOSIO_API_KEY;
const SITE_URL = process.env.URL || 'https://auvro.netlify.app';

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function ok(body, status = 200) {
  return { statusCode: status, headers, body: JSON.stringify(body) };
}

async function autenticar(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) throw new Error('Token no enviado');
  const token = authHeader.replace('Bearer ', '');
  const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const { data: userData, error } = await supabaseUser.auth.getUser();
  if (error || !userData?.user) throw new Error('No autenticado');
  const { data: miPerfil } = await supabase
    .from('perfiles')
    .select('is_admin')
    .eq('id', userData.user.id)
    .single();
  if (!miPerfil?.is_admin) throw new Error('No eres admin');
  return userData.user.id;
}

async function validarPropietario(proyectoId, adminId) {
  if (!proyectoId) throw new Error('Falta proyecto_id');
  const { data: proyecto } = await supabase
    .from('web_projects')
    .select('id, plantilla, created_by')
    .eq('id', proyectoId)
    .maybeSingle();
  if (!proyecto) throw new Error('Sitio no encontrado');
  if (proyecto.created_by !== adminId) throw new Error('No tienes acceso a este sitio');
  return proyecto;
}

function namespaceTienda(proyectoId) {
  return 'tienda:' + proyectoId;
}

async function authConfigGmail() {
  const res = await fetch('https://backend.composio.dev/api/v3/auth_configs?toolkit=gmail', {
    headers: { 'x-api-key': composioApiKey, 'Content-Type': 'application/json' }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || data?.message || 'No se pudieron consultar auth configs');
  const items = data?.items || [];
  return items.find(c => c?.toolkit?.slug?.toLowerCase() === 'gmail' && (c?.status === 'ENABLED' || !c?.status));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return ok({ ok: true });
  if (event.httpMethod !== 'POST') return ok({ ok: false, error: 'Method not allowed' }, 405);
  try {
    const adminId = await autenticar(event);
    const body = JSON.parse(event.body || '{}');
    const { action, proyecto_id } = body;
    await validarPropietario(proyecto_id, adminId);

    if (!composioApiKey) return ok({ ok: false, error: 'Falta COMPOSIO_API_KEY en las variables de entorno' }, 500);

    // ── LINK: crear el enlace de OAuth de Google para el Gmail de la tienda ──
    if (action === 'link') {
      const authConfig = await authConfigGmail();
      if (!authConfig?.id) return ok({ ok: false, error: 'No hay config OAuth de Gmail habilitada en Composio' }, 500);

      const linkRes = await fetch('https://backend.composio.dev/api/v3/connected_accounts/link', {
        method: 'POST',
        headers: { 'x-api-key': composioApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_config_id: authConfig.id,
          user_id: namespaceTienda(proyecto_id),
          callback_url: `${SITE_URL}/dashboard.html?tienda_gmail=${encodeURIComponent(proyecto_id)}`
        })
      });
      const linkData = await linkRes.json().catch(() => ({}));
      if (!linkRes.ok) return ok({ ok: false, error: linkData?.error || linkData?.message || 'No se pudo crear el enlace OAuth' }, 502);
      return ok({
        ok: true,
        redirectUrl: linkData?.redirect_url || null,
        connectedAccountId: linkData?.connected_account_id || null
      });
    }

    // ── GUARDAR: tras el OAuth, guardar el entity de la conexión en la tienda ──
    if (action === 'guardar') {
      const listRes = await fetch(
        `https://backend.composio.dev/api/v3/connected_accounts?user_id=${encodeURIComponent(namespaceTienda(proyecto_id))}`,
        { headers: { 'x-api-key': composioApiKey, 'Content-Type': 'application/json' } }
      );
      const listData = await listRes.json().catch(() => ({}));
      if (!listRes.ok) return ok({ ok: false, error: listData?.error || listData?.message || 'No se pudieron consultar las conexiones' }, 502);

      const items = listData?.items || [];
      const cuenta = items.find(item => {
        const slug = item?.toolkit?.slug || item?.appName || item?.toolkit_slug || '';
        const status = item?.status || item?.connection_status || '';
        return slug.toLowerCase() === 'gmail' && ['ACTIVE', 'ENABLED', 'CONNECTED'].includes(String(status).toUpperCase());
      });
      if (!cuenta) return ok({ ok: false, error: 'No se encontró una conexión activa de Gmail' }, 404);

      const entityId = cuenta?.id || cuenta?.connected_account_id || cuenta?.nanoid || cuenta?.connection_id;
      if (!entityId) return ok({ ok: false, error: 'La conexión no trajo un id válido' }, 500);

      const email = cuenta?.meta?.email || cuenta?.user_data?.email || cuenta?.account?.email || cuenta?.email || null;

      const { error } = await supabase
        .from('tienda_pasarela')
        .upsert({
          proyecto_id,
          composio_gmail_entity_id: entityId,
          gmail_conectado_email: email ? String(email) : null,
          updated_at: new Date().toISOString()
        }, { onConflict: 'proyecto_id' });

      if (error) return ok({ ok: false, error: 'No se pudo guardar la conexión: ' + error.message }, 500);
      return ok({ ok: true, email: email || null });
    }

    return ok({ ok: false, error: 'Acción no válida' }, 400);
  } catch (err) {
    if (err.message === 'Token no enviado' || err.message === 'No autenticado') return ok({ ok: false, error: err.message }, 401);
    if (err.message === 'No eres admin' || err.message === 'No tienes acceso a este sitio') return ok({ ok: false, error: err.message }, 403);
    if (err.message === 'Falta proyecto_id' || err.message === 'Sitio no encontrado') return ok({ ok: false, error: err.message }, 400);
    console.error('conectar-gmail-tienda error:', err);
    return ok({ ok: false, error: err.message || 'Error interno' }, 500);
  }
};

module.exports.handler = exports.handler;
