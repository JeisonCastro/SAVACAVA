// subir-imagen-deporte.js — Subida de imágenes/videos genérica para los
// módulos deportivos de AUVRO (bucket `deportes`). Patrón de
// subir-imagen-producto.js pero autenticado por proyecto (web_projects),
// no por agente.
const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

const BUCKET = 'productos';
const PREFIJO = 'deportes';
const TAMANO_MAX = 8 * 1024 * 1024;

const MIMES_PERMITIDOS = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime'
]);

// Inspecta el encabezado (magic bytes) del buffer y devuelve el MIME real o ''.
function mimeDesdeMagic(buffer) {
  if (!buffer || buffer.length < 4) return '';
  const h = String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3]);
  if (h.startsWith('\xFF\xD8\xFF')) return 'image/jpeg';
  if (h.startsWith('\x89PNG')) return 'image/png';
  if (h.startsWith('GIF8')) return 'image/gif';
  return '';
}

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
    'image/avif': '.avif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov'
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

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: userData, error: authError } = await supabaseUser.auth.getUser();
    if (authError || !userData?.user) {
      return jsonResponse(401, { error: 'Sesión inválida o expirada.' });
    }
    const userId = userData.user.id;

    const body = JSON.parse(event.body || '{}');
    const proyectoId = String(body.proyecto_id || '');
    const dataUrl = String(body.data_url || '');
    const nombreOriginal = String(body.filename || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 120);

    if (!proyectoId || !dataUrl) {
      return jsonResponse(400, { error: 'Faltan proyecto_id o data_url.' });
    }

    // Acceso al proyecto: admin de plataforma, dueño del proyecto o permiso de tienda/sitio.
    const { data: perfil } = await supabase.from('perfiles').select('is_admin').eq('id', userId).maybeSingle();
    if (!perfil?.is_admin) {
        const { data: proyecto } = await supabase
            .from('web_projects').select('created_by').eq('id', proyectoId).maybeSingle();
        if (proyecto?.created_by !== userId) {
            const ROLES = ['admin_tienda', 'editor_tienda', 'admin_sitio', 'editor_sitio'];
            const { data: permiso } = await supabase
                .from('tienda_permisos').select('rol')
                .eq('proyecto_id', proyectoId).eq('user_id', userId)
                .maybeSingle();
            if (!permiso || !ROLES.includes(permiso.rol)) {
                return jsonResponse(403, { error: 'No tienes permiso sobre este proyecto.' });
            }
        }
    }

    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+|video\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return jsonResponse(400, { error: 'Formato inválido. Envía un data URL de imagen o video.' });
    }

    const mimeDeclarado = match[1].toLowerCase();
    const b64 = match[2];
    const buffer = Buffer.from(b64, 'base64');
    if (!buffer.length || buffer.length > TAMANO_MAX) {
      return jsonResponse(400, { error: `El archivo supera ${TAMANO_MAX / 1024 / 1024} MB.` });
    }

    // Gate de tipo: acepta cualquier image/* (excepto image/svg+xml) y cualquier
    // video/*. Los alias reales (image/jpg, image/pjpeg, image/x-png, image/heic,
    // video/x-m4v, etc.) pasan sin fricción: el contenido se valida debajo.
    const esImagen = mimeDeclarado.startsWith('image/');
    const esVideo = mimeDeclarado.startsWith('video/');
    if (!esImagen && !esVideo) {
      return jsonResponse(400, { error: 'Tipo de archivo no permitido. Usa una imagen o un video.' });
    }
    if (esImagen && mimeDeclarado === 'image/svg+xml') {
      return jsonResponse(400, { error: 'El formato SVG no está permitido. Usa JPG, PNG, WebP, GIF o AVIF.' });
    }
    // Seguridad de contenido: rechaza archivos que claramente NO son imagen/video
    // (HTML/SVG/PDF disfrazados con MIME de imagen). NO se exige coincidencia exacta
    // de magic-bytes para evitar falsos rechazos de JPG/PNG mal etiquetados.
    if (esImagen) {
      const b0 = buffer[0];
      const esTextoDisfrazado = b0 === 0x3c || // '<'
        (buffer.length >= 5 && buffer[0] === 0x25 && buffer[1] === 0x50); // '%PDF'
      if (esTextoDisfrazado) {
        return jsonResponse(400, { error: 'El archivo no es una imagen válida (parece texto o SVG). Usa JPG, PNG, WebP, GIF o AVIF.' });
      }
    }

    try {
      await crearBucketSiNoExiste();
    } catch (e) {
      return jsonResponse(500, { error: 'No se pudo asegurar el bucket: ' + e.message });
    }

    const mime = mimeDeclarado;
    const ext = extDesdeMime(mime);
    const base = (nombreOriginal || 'deporte').replace(/\.[a-z0-9]+$/i, '');
    const ruta = `${PREFIJO}/${proyectoId}/${Date.now()}-${Math.floor(Math.random() * 1e6)}-${base}${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(ruta, new Blob([buffer], { type: mime }), {
        contentType: mime,
        upsert: false
      });

    if (uploadError) {
      return jsonResponse(500, { error: 'Error subiendo el archivo: ' + uploadError.message });
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(ruta);

    return jsonResponse(200, {
      ok: true,
      url: urlData?.publicUrl || '',
      storage_path: ruta,
      mime,
      es_video: mime.startsWith('video/')
    });
  } catch (err) {
    console.error('subir-imagen-deporte error:', err);
    return jsonResponse(500, { error: err.message || 'Error interno' });
  }
};
