// Firebase Messaging Service Worker
// Обработва push известия на фон + cache + periodic sync

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

var CACHE_NAME = 'zadachi-fcm-v1';
// Фоновата проверка минава през Supabase Edge Function flow-proxy с пропуска на шофьора.
// URL адресът на flow-а НЕ е в този файл – пази се като Secret в Supabase.
var PROXY_URL    = 'https://wcsdjfsohqanxcppcvvk.supabase.co/functions/v1/flow-proxy';
var SUPABASE_KEY = 'sb_publishable_aMxRatJ2BJxE5vQIhffing_8_zMpBDO';
var AUTH_CACHE   = 'driver-auth'; // тук Driver_view записва пропуска на шофьора
var KNOWN_IDS_CACHE = 'known-task-ids-v2';

firebase.initializeApp({
  apiKey: "AIzaSyAdpYQcfxgTWVHJzjOS4DHgNV9B0QcOySo",
  authDomain: "snabditeli-daily-tasks.firebaseapp.com",
  projectId: "snabditeli-daily-tasks",
  storageBucket: "snabditeli-daily-tasks.firebasestorage.app",
  messagingSenderId: "331067265730",
  appId: "1:331067265730:web:fcfa5765e4c4bbd90e615b"
});

const messaging = firebase.messaging();

// ── Фонови FCM push известия (при заключен екран / затворен апп) ──
messaging.onBackgroundMessage(function(payload) {
  var title = (payload.notification && payload.notification.title) || '📦 Нова задача!';
  var body  = (payload.notification && payload.notification.body)  || 'Натисни за преглед';
  return self.registration.showNotification(title, {
    body: body,
    icon: 'https://cdn-icons-png.flaticon.com/512/2830/2830284.png',
    badge: 'https://cdn-icons-png.flaticon.com/512/2830/2830284.png',
    tag: 'new-task',
    renotify: true,
    vibrate: [300, 100, 300, 100, 300],
    requireInteraction: true
  });
});

// ── Periodic Background Sync (fallback когато FCM не работи) ──
self.addEventListener('periodicsync', function(e) {
  if (e.tag === 'check-new-tasks') {
    e.waitUntil(checkForNewTasksInBackground());
  }
});

function getDriverToken() {
  return caches.open(AUTH_CACHE)
    .then(function(c) { return c.match('token'); })
    .then(function(r) { return r ? r.text() : null; })
    .catch(function() { return null; });
}

function checkForNewTasksInBackground() {
  return getDriverToken().then(function(tok) {
    if (!tok) return Promise.reject('no_token'); // шофьорът не е влязъл – няма фонова проверка
    return fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'x-driver-token': tok },
      body: JSON.stringify({ app: 'daily-tasks', action: 'get', data: {} })
    });
  })
  .then(function(res) {
    if (!res.ok) return Promise.reject('http_' + res.status);
    return res.json();
  })
  .then(function(data) {
    var items = data.value || [];
    var currentIds = items
      .filter(function(item) {
        if (!item.ID) return false;
        var s = item['OData__x0421__x0442__x0430__x0442__x04'];
        var sv = (s && s.Value) ? s.Value : (typeof s === 'string' ? s : '');
        return sv !== 'Изпълнена';
      })
      .map(function(item) { return item.ID; });

    return caches.open(KNOWN_IDS_CACHE).then(function(cache) {
      return cache.match('ids').then(function(stored) {
        return stored ? stored.json() : [];
      }).then(function(knownIds) {
        var newIds = currentIds.filter(function(id) {
          return knownIds.indexOf(id) === -1;
        });
        cache.put('ids', new Response(JSON.stringify(currentIds)));
        if (newIds.length === 0) return;
        var label = newIds.length === 1 ? 'нова задача' : 'нови задачи';
        return self.registration.showNotification('📦 ' + newIds.length + ' ' + label + '!', {
          body: 'Натисни за преглед',
          icon: 'https://cdn-icons-png.flaticon.com/512/2830/2830284.png',
          badge: 'https://cdn-icons-png.flaticon.com/512/2830/2830284.png',
          tag: 'new-task',
          renotify: true,
          vibrate: [300, 100, 300, 100, 300],
          requireInteraction: true
        }).then(function() {
          return self.clients.matchAll({ type: 'window' }).then(function(clients) {
            clients.forEach(function(client) {
              client.postMessage({ type: 'NEW_TASK', count: newIds.length });
            });
          });
        });
      });
    });
  })
  .catch(function() {});
}

// ── Install / Activate / Fetch ──
self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME && k !== KNOWN_IDS_CACHE && k !== AUTH_CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
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

// ── Клик на известие ──
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var c = clientList[i];
        if (c.url.indexOf('Driver_view') !== -1 && 'focus' in c) {
          return c.focus();
        }
      }
      return clients.openWindow('/Daily_Task_Schedule_Snabditeli/Driver_view.html');
    })
  );
});
