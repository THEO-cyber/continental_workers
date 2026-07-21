/* Continental Workers — service worker (app shell only; sales always need the network) */
'use strict';

const CACHE = 'continental-workers-v2';
const SHELL = [
  '/workers/',
  '/workers/index.html',
  '/workers/css/worker.css',
  '/workers/js/worker.js',
  '/workers/manifest.webmanifest',
  '/assets/icons/favicon.svg',
  '/assets/icons/icon-192.png',
  '/assets/img/part-placeholder.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Live data always from the network — never serve stale stock or record sales offline.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) return;
  if (!url.pathname.startsWith('/workers') && !url.pathname.startsWith('/assets') && !url.pathname.startsWith('/uploads')) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (url.pathname.startsWith('/workers') || url.pathname.startsWith('/assets')) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') return caches.match('/workers/index.html');
      throw new Error('offline');
    }
  })());
});
