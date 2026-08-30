/* ─── AUVRO Service Worker v3.1 (dark negro #000000, cache v15) ─────────── */
const CACHE_NAME = 'auvro-v15';
const OFFLINE_URL = '/offline.html';
const CACHE_MAX_ENTRIES = 100;

/* Archivos que siempre se cachean en instalación */
const PRECACHE_URLS = [
  '/',
  '/dashboard.html',
  '/tienda-admin.html',
  '/chat.html',
  '/editor.html',
  '/login.html',
  '/offline.html',
  '/manifest.json',
  '/dashboard.css?v=15',
  '/auvro-design.css?v=15',
  '/icon-192.svg',
  '/icon-512.svg',
  '/favicon.ico',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css'
];

/* Guarda en cache y poda las entradas más antiguas si supera el límite */
function putPruned(cache, request, response) {
  return cache.put(request, response).then(() =>
    cache.keys().then(keys => {
      const extra = keys.length - CACHE_MAX_ENTRIES;
      if (extra <= 0) return;
      return Promise.all(
        keys.slice(0, extra).map(key => cache.delete(key))
      );
    })
  );
}

/* ─── INSTALL ────────────────────────────────────────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err => {
            console.warn('[SW] No se pudo cachear:', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

/* ─── ACTIVATE ───────────────────────────────────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* ─── FETCH — Estrategia Network First con fallback a cache ──────────────── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* Ignorar requests que no son GET */
  if (request.method !== 'GET') return;

  /* Ignorar Supabase, API calls, netlify functions */
  if (
    url.hostname.includes('supabase.co') ||
    url.pathname.startsWith('/.netlify/functions/') ||
    url.hostname.includes('graph.facebook.com') ||
    url.hostname.includes('api.anthropic.com')
  ) return;

  /* Archivos HTML — Network First */
  if (request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => putPruned(cache, request, clone));
          return response;
        })
        .catch(() =>
          caches.match(request).then(cached => cached || caches.match(OFFLINE_URL))
        )
    );
    return;
  }

  /* Fuentes y CDN — Cache First */
  if (
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('cdn.jsdelivr.net')
  ) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => putPruned(cache, request, clone));
          return response;
        });
      })
    );
    return;
  }

  /* widget.js — SIEMPRE red primero (nunca servir una copia vieja cacheada).
     Cualquier fix del widget debe llegar al instante a los visitantes. */
  if (url.pathname.endsWith('/widget.js')) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  /* Todo lo demás — Stale While Revalidate */
  event.respondWith(
    caches.match(request).then(cached => {
      const fetchPromise = fetch(request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => putPruned(cache, request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

/* ─── PUSH NOTIFICATIONS ─────────────────────────────────────────────────── */
self.addEventListener('push', event => {
  let data = { title: 'AUVRO', body: 'Tienes un nuevo mensaje.', icon: '/icon-192.svg', badge: '/icon-96.png', tag: 'auvro-notif' };

  if (event.data) {
    try { data = { ...data, ...event.data.json() }; } catch(e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/icon-192.svg',
    badge: data.badge || '/icon-96.png',
    tag: data.tag || 'auvro-notif',
    renotify: true,
    requireInteraction: false,
    vibrate: [200, 100, 200],
    data: { url: data.url || '/dashboard.html', conversationId: data.conversationId },
    actions: [
      { action: 'open', title: 'Ver conversación', icon: '/icon-96.png' },
      { action: 'dismiss', title: 'Descartar' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

/* ─── NOTIFICATION CLICK ─────────────────────────────────────────────────── */
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/dashboard.html';

  if (event.action === 'dismiss') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('/dashboard') && 'focus' in client) {
          client.focus();
          client.postMessage({ type: 'NOTIFICATION_CLICK', url: targetUrl, conversationId: event.notification.data?.conversationId });
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

/* ─── BACKGROUND SYNC (para mensajes pendientes) ─────────────────────────── */
self.addEventListener('sync', event => {
  if (event.tag === 'sync-messages') {
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'BACKGROUND_SYNC' }));
      })
    );
  }
});

/* ─── MESSAGE desde el cliente ───────────────────────────────────────────── */
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      event.source?.postMessage({ type: 'CACHE_CLEARED' });
    });
  }
});
