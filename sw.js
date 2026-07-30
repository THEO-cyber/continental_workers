/* Continental Workers — service worker (app shell only; sales always need the network) */
'use strict';

const CACHE = 'continental-workers-v3';
const SHELL = [
  '/',
  '/index.html',
  '/css/worker.css',
  '/js/worker.js',
  '/manifest.webmanifest',
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
  // The API and Socket.IO now live on the backend's own origin (this app is
  // hosted separately) -- cross-origin requests are never intercepted here,
  // so live stock/sales data always goes straight to the network.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone());
      return fresh;
    } catch {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') return caches.match('/index.html');
      throw new Error('offline');
    }
  })());
});
