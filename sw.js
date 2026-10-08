/* Service worker: даёт работу без интернета.
 * Стратегия: сначала сеть (чтобы новые вопросы и пакеты подтягивались), при отсутствии сети: копия из кэша.
 * Меняешь список файлов или хочешь сбросить кэш у всех — увеличь номер в CACHE. */
var CACHE = 'preposizioni-v2-3';
var FILES = ['./', 'index.html', 'engine.js', 'packs/preposizioni.json', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(function (resp) {
      if (resp && resp.ok && new URL(e.request.url).origin === location.origin) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return resp;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) { return hit || caches.match('index.html'); });
    })
  );
});
