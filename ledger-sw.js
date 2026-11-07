/* A network-first static shell. No record cache, background sync, or write queue. */
'use strict';
const CACHE_PREFIX = 'laobai-notes-shell-';
const CACHE_NAME = CACHE_PREFIX + '2026-11-07-chart-v7-picks-validation1';
const BASE = new URL('./', self.location.href);
const SHELL = ['ledger.html', 'fonts/fonts.css', 'bg/bg-day.webp', 'bg/bg-night.webp', 'bg/bg-dusk.webp', 'bg/bg-dream.webp', 'ledger-app.css', 'ledger-app.js', 'ledger.webmanifest', 'core.js', 'reactions.js', 'reactions.css', 'notifications.js', 'activity.js', 'activity.css',
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
  const fontPath = new URL('fonts/', BASE).pathname;
  if (url.pathname.startsWith(fontPath) && /\.woff2$/.test(url.pathname) && !url.search) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME), cached = await cache.match(clean);
      if (cached) return cached;
      const result = await fetch(request);
      if (result.ok && result.type === 'basic') { try { await cache.put(clean, result.clone()); } catch (_) {} }
      return result;
    })());
    return;
  }
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


// No private ledger key or record snapshot is stored in the service worker.
self.addEventListener('message',event=>{if(event.data?.type==='LAOBAI_PUSH_VERSION')event.ports[0]?.postMessage({pushVersion:1})});
let pushTail=Promise.resolve();
self.addEventListener('push',event=>{
 // Every delivered push displays a notification, as required by WebKit.
 // Serialize so a late older event cannot overwrite a currently displayed newer one.
 pushTail=pushTail.catch(()=>{}).then(async()=>{
  let data={};try{data=event.data?.json()||{}}catch{}
  let title=typeof data.title==='string'?data.title.slice(0,160):'剧单有更新';
  let status=typeof data.body==='string'?data.body.slice(0,500):'打开查看最新记录';
  const pickId=/^[a-f0-9-]{36}$/i.test(data.pickId||'')?data.pickId:'updates';
  const tag='laobai-picks';
  let eventId=/^[0-9]{1,19}$/.test(data.eventId||'')?String(data.eventId):'0';
  try{for(const old of await self.registration.getNotifications({tag})){
   const previous=old.data?.eventId;
   if(/^[0-9]{1,19}$/.test(previous||'')&&BigInt(previous)>=BigInt(eventId)){title=old.title;status=old.body;eventId=String(previous)}
  }}catch{}
  await self.registration.showNotification(title,{body:status,tag,renotify:true,icon:new URL('icons/laobai-192.png',BASE).href,badge:new URL('icons/laobai-192.png',BASE).href,data:{url:PAGE+'#picks',eventId}});
  for(const client of await self.clients.matchAll({type:'window',includeUncontrolled:true})){if(new URL(client.url).origin===BASE.origin)client.postMessage({type:'LAOBAI_PICK_ACTIVITY'})}
 });
 event.waitUntil(pushTail);
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 event.waitUntil((async()=>{
  const target=PAGE+'#picks';const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for(const client of windows){const u=new URL(client.url);if(u.origin===BASE.origin&&u.pathname===new URL(PAGE).pathname){await client.focus();client.postMessage({type:'LAOBAI_OPEN_PICK_UPDATES'});return}}
  if(self.clients.openWindow)await self.clients.openWindow(target);
 })());
});
