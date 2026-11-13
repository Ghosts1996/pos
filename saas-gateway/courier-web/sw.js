/* Приложение курьера без сети: оболочка — из кэша, если сеть пропала.
 * Сначала сеть (обновления приходят сразу), кэш — запасной путь.
 * Запросы к серверу (api/) не кэшируются никогда: заказы — только свежие. */
"use strict";
const CACHE = "zalpos-courier-v13";
// Тайлы своей карты — отдельно и «сначала из памяти»: адрес тайла меняется
// с каждой новой сборкой карты (?v=…), старые вытесняются по количеству.
const TILES = "zalpos-map-tiles-v1";
const TILES_MAX = 3000;
// Карта города, скачанная для работы без связи (тайлы, шрифты, движок, сеть
// дорог): не вытесняется и не стирается при обновлении приложения.
const OFFLINE = "zalpos-map-offline";
const SHELL = ["./", "index.html", "app.js", "app.css", "qr.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "rules.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILES && k !== OFFLINE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

let tilesPut = 0;
function trimTiles(cache) {
  return cache.keys().then((keys) => (keys.length > TILES_MAX ? Promise.all(keys.slice(0, keys.length - TILES_MAX + 300).map((k) => cache.delete(k))) : null));
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
  if (url.pathname.includes("/map/tiles/")) {
    // Скачивание карты города (dl=1) — мимо кэша просмотра: приложение кладёт само.
    if (url.searchParams.get("dl") === "1") return;
    // Сначала из телефона (скачанный город, затем просмотренное), потом сеть.
    const key = url.origin + url.pathname;
    e.respondWith(caches.open(OFFLINE).then((off) => off.match(key)).then((saved) => saved || caches.open(TILES).then((cache) => cache.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && (res.status === 200 || res.status === 204)) {
        cache.put(e.request, res.clone()).catch(() => {});
        if (++tilesPut % 200 === 0) trimTiles(cache).catch(() => {});
      }
      return res;
    // Без связи и вне скачанного — пустой участок: карта рисует фон, без ошибок и повторов.
    }).catch(() => new Response(null, { status: 204 }))))));
    return;
  }
  // Сеть дорог города (десятки МБ) приложение кладёт в кэш карты само — второй копии не нужно.
  if (url.pathname.includes("/map/graph/")) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html"))));
});

// Нажали на уведомление «Новый заказ» — открываем приложение.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});
