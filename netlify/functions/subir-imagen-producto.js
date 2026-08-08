const { supabase } = require('./supabase-admin');

const BUCKET = 'productos';
const TAMANO_MAX = 5 * 1024 * 1024;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

async function crearBucketSiNoExiste() {
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    file_size_limit: TAMANO_MAX
  });
  if (error && !/already exists/i.test(error.message || '')) {
    throw error;
  }
}

function extDesdeMime(mime = '') {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif'
  };
  return map[String(mime).toLowerCase().split(';')[0].trim()] || '.jpg';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, { ok: true });
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method Not Allowed' });

  try {
    const auth = event.headers.authorization || event.headers.Authorization || '';
    const token = String(auth).replace(/^Bearer\s+/i, '').trim();
    if (!token) return jsonResponse(401, { error: 'Token no enviado' });

    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData?.user) {
      return jsonResponse(401, { error: 'Sesión inválida o expirada.' });
    }
    const userId = userData.user.id;

    const body = JSON.parse(event.body || '{}');
    const agenteId = body.agente_id;
    const dataUrl = String(body.data_url || '');
    const nombreOriginal = String(body.filename || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 120);

    if (!agenteId || !dataUrl) {
      return jsonResponse(400, { error: 'Faltan agente_id o data_url.' });
    }

    // El agente debe pertenecer al usuario autenticado.
    const { data: agente, error: agenteError } = await supabase
      .from('agentes_ia')
      .select('id')
      .eq('id', agenteId)
      .eq('user_id', userId)
      .maybeSingle();
    if (agenteError || !agente) {
      return jsonResponse(403, { error: 'No tienes acceso a este agente.' });
    }

    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return jsonResponse(400, { error: 'Formato de imagen inválido. Envía un data URL de imagen.' });
    }

    const mime = match[1];
    const b64 = match[2];
    const buffer = Buffer.from(b64, 'base64');
    if (!buffer.length || buffer.length > TAMANO_MAX) {
      return jsonResponse(400, { error: `La imagen supera ${TAMANO_MAX / 1024 / 1024} MB.` });
    }

    try {
      await crearBucketSiNoExiste();
    } catch (e) {
      return jsonResponse(500, { error: 'No se pudo asegurar el bucket: ' + e.message });
    }

    const ext = extDesdeMime(mime);
    const base = (nombreOriginal || 'producto').replace(/\.[a-z0-9]+$/i, '');
    const ruta = `productos/${userId}/${Date.now()}-${Math.floor(Math.random() * 1e6)}-${base}${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(ruta, new Blob([buffer], { type: mime }), {
        contentType: mime,
        upsert: false
      });

    if (uploadError) {
      return jsonResponse(500, { error: 'Error subiendo la imagen: ' + uploadError.message });
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(ruta);

    return jsonResponse(200, {
      ok: true,
      url: urlData?.publicUrl || '',
      storage_path: ruta
    });
  } catch (err) {
    console.error('subir-imagen-producto error:', err);
    return jsonResponse(500, { error: err.message || 'Error interno' });
  }
};
