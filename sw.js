// Experimental Science Institution: Notes — Service Worker
// Cache-first strategy with versioned cache (v1) and old-version cleanup.
// Place this file at the repository root (served as /ESI/sw.js).

const CACHE_VERSION = 'v1';
const CACHE_NAME = `esi-notes-${CACHE_VERSION}`;

// Precache core assets. Paths are absolute from the origin so they work under /ESI/.
const PRECACHE_URLS = [
  '/ESI/',
  '/ESI/index.html',
  '/ESI/subjects.html',
  '/ESI/cells.html',
  '/ESI/electricity.html',
  '/ESI/light.html',
  '/ESI/sound.html',
  '/ESI/magnetism.html',
  '/ESI/motion.html',
  '/ESI/lab.html',
  '/ESI/quiz.html',
  '/ESI/notes.html',
  '/ESI/progress.html',
  '/ESI/404.html',
  '/ESI/style.css',
  '/ESI/chat-widget.css',
  '/ESI/app.js',
  '/ESI/chat-widget.js',
  '/ESI/supabase-config.js',
  '/ESI/icon-192.png',
  '/ESI/icon-512.png',
  '/ESI/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('esi-notes-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Cache-first with network fallback + runtime caching for other same-origin GET requests.
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only handle GET requests from the same origin.
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Optionally update the cache in the background (stale-while-revalidate style for dynamic content).
        fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
              caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse.clone()));
            }
          })
          .catch(() => {});
        return cachedResponse;
      }

      // Not in cache: go to network and cache successful responses.
      return fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }
          return networkResponse;
        })
        .catch(() => {
          // Offline fallback: return a cached offline page or the 404 if available.
          return caches.match('/ESI/404.html') || caches.match('/ESI/index.html');
        });
    })
  );
});
