// Служба веб-версии гостя: нужна, чтобы Android позволил «Установить
// приложение», и показывает понятную страницу, если сети нет совсем.
// Ничего не кэширует и не перехватывает запросы к данным (API, поток
// обновлений) — только открытие страниц.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Нет связи</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#141414;color:#F2F2F2;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px">
<div><h1 style="font-size:22px;margin:0 0 8px">Нет связи с интернетом</h1>
<p style="opacity:.75;margin:0 0 20px">Проверьте Wi-Fi или мобильную сеть и попробуйте ещё раз.</p>
<button onclick="location.reload()" style="padding:12px 22px;border:0;border-radius:999px;background:#F2F2F2;color:#141414;font:600 16px system-ui,sans-serif">Обновить</button></div>
</body></html>`;

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
