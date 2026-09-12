/* Service Worker for GlobalFX Pro
 *
 * Provides offline support, static asset caching, and PWA installability.
 * Static shell: cache-first. Market data: network-first with a real-data
 * cache fallback, so going offline serves previously retrieved observations
 * rather than nothing (and never anything fabricated).
 */

const CACHE_VERSION = 'v2';
const SHELL_CACHE = `globalfx-shell-${CACHE_VERSION}`;
const DATA_CACHE = `globalfx-data-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './css/style.css',
  './css/animations.css',
  './css/responsive.css',
  './js/storage.js',
  './js/portfolio.js',
  './js/api.js',
  './js/export.js',
  './js/analytics.js',
  './js/charts.js',
  './js/converter.js',
  './js/alerts.js',
  './js/ui.js',
  './js/app.js',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

/** Hosts serving market data, which must never be served stale-first. */
const DATA_HOSTS = ['api.frankfurter.dev', 'open.er-api.com'];

const isDataRequest = (url) => DATA_HOSTS.includes(url.hostname) || url.pathname.startsWith('/api/');

// ---- Install: pre-cache static shell ---------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => {
      // Cache entries individually: a single unreachable CDN asset must not
      // fail the whole installation the way cache.addAll would.
      return Promise.all(
        STATIC_ASSETS.map((asset) =>
          cache.add(asset).catch((err) => console.warn('[SW] Skipped caching', asset, err))
        )
      );
    })
  );
  self.skipWaiting();
});

// ---- Activate: clean old caches --------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

// ---- Fetch -----------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET requests are cacheable
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  // Market data: network-first, falling back to the last real response
  if (isDataRequest(url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(DATA_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || Response.error()))
    );
    return;
  }

  // Navigation requests: serve the app shell so deep links work offline
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        if (response && response.ok && url.protocol.startsWith('http')) {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});

// ---- Notification interaction ----------------------------------------------
// Focus an existing window when a rate alert is tapped, rather than opening a
// duplicate instance of the app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
