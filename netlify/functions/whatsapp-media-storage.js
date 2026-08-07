const { supabase } = require('./supabase-admin');

const BUCKET = 'whatsapp-media';
const TAMANO_MAX = 25 * 1024 * 1024;

async function crearBucketSiNoExiste() {
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    file_size_limit: TAMANO_MAX
  });

  if (error && !/already exists/i.test(error.message || '')) {
    throw error;
  }
}

function extensionFromMime(mime = '') {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/opus': '.opus',
    'application/pdf': '.pdf'
  };
  return map[String(mime).toLowerCase().split(';')[0].trim()] || '.bin';
}

function sanitizar(name = '') {
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120) || 'media';
}

async function subirMedia({ agenteId, messageId, mediaId, buffer, contentType, filename }) {
  try {
    await crearBucketSiNoExiste();
  } catch (e) {
    return { ok: false, error: 'No se pudo asegurar el bucket: ' + e.message };
  }

  const ext = extensionFromMime(contentType);
  const nombre = `${sanitizar(messageId)}-${sanitizar(mediaId)}${ext}`;
  const path = `whatsapp/${sanitizar(agenteId)}/${nombre}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, new Blob([buffer], { type: contentType }), {
      contentType,
      upsert: true
    });

  if (uploadError) {
    return { ok: false, error: uploadError.message };
  }

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path);

  return {
    ok: true,
    storage_path: path,
    public_url: urlData?.publicUrl || ''
  };
}

async function descargarDesdeStorage(storagePath) {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);

  if (error) {
    throw new Error('No se pudo descargar del storage: ' + error.message);
  }

  const arrayBuffer = await data.arrayBuffer();

  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: data.type || 'application/octet-stream'
  };
}

module.exports = {
  BUCKET,
  crearBucketSiNoExiste,
  subirMedia,
  descargarDesdeStorage
};
