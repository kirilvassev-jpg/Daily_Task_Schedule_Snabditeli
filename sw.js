var CACHE_NAME = 'zadachi-v1';
var CACHE_URLS = [
  '/Daily_Task_Schedule_Snabditeli/Driver_view.html'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CACHE_URLS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) {
        return k !== CACHE_NAME;
      }).map(function(k) {
        return caches.delete(k);
      }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  e.respondWith(
    fetch(e.request).catch(function() {
      return caches.match(e.request);
    })
  );
});

// ── Push известия ──
self.addEventListener('push', function(e) {
  var data = e.data ? e.data.json() : { title: '📦 Нова задача!', body: '' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'https://cdn-icons-png.flaticon.com/512/2830/2830284.png',
      badge: 'https://cdn-icons-png.flaticon.com/512/2830/2830284.png',
      tag: 'new-task',
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(clients.openWindow('/Daily_Task_Schedule_Snabditeli/Driver_view.html'));
});
