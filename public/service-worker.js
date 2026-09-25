// Service Worker for OECS MyPD PWA
//
// Caching policy (v2):
//   - /api/*            : network only, never cached (user-specific data).
//   - navigations (HTML): network first, never stored; falls back to the
//                         precached /offline page when the network fails.
//   - /_next/static/*, fonts, images, manifest: cache first (immutable/static).
//   - everything else   : pass through to the network untouched.
const CACHE_VERSION = 'v2';
const STATIC_CACHE = `oecs-mypd-static-${CACHE_VERSION}`;
const OFFLINE_PAGE = '/offline';

// Assets to precache on install
const PRECACHE_ASSETS = [
  OFFLINE_PAGE,
  '/favicon.ico',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  '/apple-touch-icon.png',
  '/site.webmanifest'
];

const STATIC_EXTENSIONS = /\.(css|js|png|jpg|jpeg|gif|svg|ico|webp|avif|woff|woff2|ttf|otf|eot)$/i;

// Install event - precache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return Promise.all(
        PRECACHE_ASSETS.map((asset) =>
          cache.add(asset).catch((err) => {
            console.warn('[Service Worker] Failed to precache', asset, err);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== STATIC_CACHE)
          .map((cacheName) => caches.delete(cacheName))
      );
    }).then(() => self.clients.claim())
  );
});

// Message handler - lets the page clear caches (e.g. on sign-out)
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .then(() => {
          if (event.source && typeof event.source.postMessage === 'function') {
            event.source.postMessage({ type: 'CACHES_CLEARED' });
          }
        })
        .catch((err) => console.warn('[Service Worker] Failed to clear caches:', err))
    );
  } else if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isStaticAsset(url, request) {
  if (url.pathname.startsWith('/_next/static/')) return true;
  if (url.pathname === '/site.webmanifest' || url.pathname === '/manifest.json') return true;
  if (request.destination === 'font' || request.destination === 'image' ||
      request.destination === 'style' || request.destination === 'script') return true;
  return STATIC_EXTENSIONS.test(url.pathname);
}

// Fetch event - implement caching strategies
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Skip cross-origin requests
  if (url.origin !== self.location.origin) return;

  // API calls: network only, never cached
  if (url.pathname.startsWith('/api/')) return;

  // HTML navigations: network first, never stored, offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(navigationStrategy(request));
    return;
  }

  // Static assets: cache first
  if (isStaticAsset(url, request)) {
    event.respondWith(cacheFirstStrategy(request));
    return;
  }

  // Everything else (RSC payloads, data requests, etc.): network only
});

// Cache-first strategy for immutable/static assets
async function cacheFirstStrategy(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) return cachedResponse;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
      cache.put(request, networkResponse.clone()).catch(() => {});
    }
    return networkResponse;
  } catch (error) {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

// Network-first for navigations; the response is never stored.
async function navigationStrategy(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cache = await caches.open(STATIC_CACHE);
    const offlinePage = await cache.match(OFFLINE_PAGE);
    if (offlinePage) return offlinePage;
    return new Response('You are offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// Background sync for form submissions
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-forms') {
    event.waitUntil(syncForms());
  }
});

async function syncForms() {
  // This would sync any pending form submissions
  // Implementation depends on your form submission storage mechanism
}

// Push notification support
self.addEventListener('push', (event) => {
  const options = {
    body: event.data ? event.data.text() : 'New notification',
    icon: '/android-chrome-192x192.png',
    badge: '/android-chrome-192x192.png',
    vibrate: [200, 100, 200],
    tag: 'notification',
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification('OECS MyPD', options)
  );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/')
  );
});
