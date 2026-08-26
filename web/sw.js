/**
 * Offline shell.
 *
 * The app itself is cached so it opens with no signal; club data never is.
 * Anything under /api goes straight to the network and the app falls back to
 * its own mirror in IndexedDB, which is the copy it can reason about.
 */

const VERSION = 'tagcheck-v2.2.0';

/** Resolved against the worker location so a subpath deployment still works. */
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './api.js',
  './store.js',
  './ocr.js',
  './config.js',
  './backend.js',
  './backend-rest.js',
  './backend-firebase.js',
  './firebase-config.js',
  './vision.js',
  './shared/plate.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
].map((path) => new URL(path, self.location).toString());

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // `cache: 'reload'` bypasses the browser HTTP cache while filling ours.
    // Without it a freshly installed worker can copy a stale file straight out
    // of the HTTP cache and then serve that stale copy for its whole lifetime.
    // One bad entry must not sink the whole install, hence allSettled.
    await Promise.allSettled(
      SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.pathname.includes('/api/')) return;

  // Navigations: serve the shell so the app opens offline.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(VERSION);
        return (await cache.match(new URL('./index.html', self.location).toString()))
          || Response.error();
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(request);
    const network = fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
      .catch(() => cached);
    // Cached first for speed, refreshed in the background for correctness.
    return cached || network;
  })());
});
