/* A network-first static shell. No record cache, background sync, or write queue. */
'use strict';
const CACHE_PREFIX = 'laobai-notes-shell-';
const CACHE_NAME = CACHE_PREFIX + '2026-11-06-shared-key-calendar-v5';
const BASE = new URL('./', self.location.href);
const SHELL = ['ledger.html', 'ledger-app.css', 'ledger-app.js', 'ledger.webmanifest', 'core.js',
  'icons/laobai.svg', 'icons/laobai-180.png', 'icons/laobai-192.png',
  'icons/laobai-512.png', 'icons/laobai-maskable-512.png'].map(path => new URL(path, BASE).href);
const PAGE = new URL('ledger.html', BASE).href;
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
    .map(key => caches.delete(key)))));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== BASE.origin) return;
  // Never cache URLs with a key or arbitrary query; navigation fallback uses a clean shell.
  const clean = new URL(url.pathname, BASE.origin).href;
  if (!SHELL.includes(clean)) return;
  const key = clean;
  const response = fetch(request).then(async result => {
    if (result.ok && result.type === 'basic' && !url.search) {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(key, result.clone());
      } catch (_) { /* Storage failure must never discard a successful network response. */ }
    }
    return result;
  }).catch(async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(key === PAGE ? PAGE : key);
    return cached || Response.error();
  });
  event.respondWith(response);
});

