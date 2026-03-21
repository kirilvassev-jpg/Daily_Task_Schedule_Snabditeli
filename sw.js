var CACHE_NAME = 'zadachi-v3';
var CACHE_URLS = [
  '/Daily_Task_Schedule_Snabditeli/Driver_view.html'
];

// URL за зареждане на задачи — същият като в Driver_view.html
var GET_FLOW_URL = 'https://default0b822811c53c4f5e9444350c2fb3f9.35.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/537e731e7e054f99a1cb0f170de2bc59/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=eRDW8qfFUo9l8Zyc1WVSSqG4797UCNv46FP0ZO2hp4Y';
var KNOWN_IDS_CACHE = 'known-task-ids-v1';

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
        return k !== CACHE_NAME && k !== KNOWN_IDS_CACHE;
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

// ── Periodic Background Sync — проверява за нови задачи на фон ──
self.addEventListener('periodicsync', function(e) {
  if (e.tag === 'check-new-tasks') {
    e.waitUntil(checkForNewTasksInBackground());
  }
});

function checkForNewTasksInBackground() {
  return fetch(GET_FLOW_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
  .then(function(res) { return res.json(); })
  .then(function(data) {
    var items = data.value || [];
    // Взима активните задачи (без изпълнените)
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
        // Намира новите ID-та
        var newIds = currentIds.filter(function(id) {
          return knownIds.indexOf(id) === -1;
        });

        // Записва актуалния списък
        cache.put('ids', new Response(JSON.stringify(currentIds)));

        if (newIds.length === 0) return;

        // Показва известие
        var label = newIds.length === 1 ? 'нова задача' : 'нови задачи';
        return self.registration.showNotification('📦 ' + newIds.length + ' ' + label + '!', {
          body: 'Натисни за преглед',
          icon: 'https://cdn-icons-png.flaticon.com/512/2830/2830284.png',
          badge: 'https://cdn-icons-png.flaticon.com/512/2830/2830284.png',
          tag: 'new-task',
          renotify: true,
          vibrate: [300, 100, 300, 100, 300],
          requireInteraction: true,
          data: { count: newIds.length }
        }).then(function() {
          // Изпраща съобщение до отворените прозорци да обновят банера
          return self.clients.matchAll({ type: 'window' }).then(function(clients) {
            clients.forEach(function(client) {
              client.postMessage({ type: 'NEW_TASK', count: newIds.length });
            });
          });
        });
      });
    });
  })
  .catch(function() { /* тихо при грешка */ });
}

// ── Push известия (от сървър) ──
self.addEventListener('push', function(e) {
  var data = e.data ? e.data.json() : { title: '📦 Нова задача!', body: '' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'https://cdn-icons-png.flaticon.com/512/2830/2830284.png',
      badge: 'https://cdn-icons-png.flaticon.com/512/2830/2830284.png',
      tag: 'new-task',
      renotify: true,
      vibrate: [300, 100, 300, 100, 300],
      requireInteraction: true
    })
  );
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(function(clientList) {
      // Ако има отворен прозорец — фокусира го
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.indexOf('Driver_view') !== -1 && 'focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      // Иначе отваря нов
      return clients.openWindow('/Daily_Task_Schedule_Snabditeli/Driver_view.html');
    })
  );
});
