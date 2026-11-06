// Самолечение страницы (кабинет и приложение гостя; копии файла одинаковые).
// Не загрузилась — ошибка в коде, устаревший кэш после обновления, сбой
// связи на старте: вместо вечной крутилки один раз чистим кэш данных и
// перезагружаем страницу; не помогло — внизу плашка с кнопкой «Обновить»,
// а страница продолжает грузиться (вдруг просто медленная сеть). Вход
// (токены) не трогаем. Сбой коротко уходит на сервер — в журнал платформы.
(function () {
  var GUARD = 'zalHealAt';
  var REPORT_URL = 'https://pii.zalpos.ru/saas/clientError';
  var WAIT_MS = 12000;
  var fatal = '';
  var healed = false;
  var reported = false;

  function report(kind, message) {
    try {
      var body = JSON.stringify({
        kind: kind, message: String(message || '').slice(0, 300),
        page: location.hostname + location.pathname + (location.hash || '').split('?')[0].slice(0, 40),
        sinceStartMs: Math.round(performance.now()),
      });
      if (navigator.sendBeacon) navigator.sendBeacon(REPORT_URL, body);
    } catch (e) { /* без отчёта — не страшно */ }
  }

  // Своя ошибка до готовности страницы: упал скрипт или не загрузился модуль.
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
      fatal = 'не загрузился ' + (t.src || t.href || t.tagName);
    } else if (e && e.message && (!e.filename || e.filename.indexOf(location.origin) === 0)) {
      fatal = e.message;
    } else return;
    if (!stillLoading()) {
      // Страница уже на экране — только отчёт (один на страницу).
      if (!reported) { reported = true; report('error', fatal); }
      return;
    }
    setTimeout(check, 2500);
  }, true);

  // Идёт загрузка: на экране только крутилка (и разве что «ZalPOS»). Крутилка
  // внутри открытой страницы (ответ ИИ, отчёт) — это работа, не зависание.
  function stillLoading() {
    var screen = document.getElementById('screen');
    if (!screen || (screen.innerText || '').trim().length > 40) return false;
    var spins = screen.querySelectorAll('.spinner');
    for (var i = 0; i < spins.length; i++) {
      if (spins[i].offsetParent !== null) return true;
    }
    return false;
  }

  function lastHeal() {
    try { return Number(sessionStorage.getItem(GUARD)) || 0; } catch (e) { return Date.now(); }
  }

  function clearDataCache() {
    try {
      localStorage.removeItem('zalStatus');
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (k && k.indexOf('zalTenants:') === 0) localStorage.removeItem(k);
      }
    } catch (e) { /* приватный режим */ }
  }

  function banner() {
    if (document.getElementById('zal-heal')) return;
    var b = document.createElement('div');
    b.id = 'zal-heal';
    b.setAttribute('role', 'alert');
    b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:99999;'
      + 'max-width:520px;margin:0 auto;padding:14px 16px;border-radius:14px;background:#1F1B16;color:#F3EEE6;'
      + 'font:15px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center';
    var t = document.createElement('div');
    t.style.flex = '1';
    t.textContent = 'Страница загружается дольше обычного. Проверьте интернет и обновите. Включён VPN — выберите в нём сервер в России или добавьте этот сайт в исключения VPN.';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Обновить';
    btn.style.cssText = 'flex:none;padding:10px 16px;border:0;border-radius:999px;background:#C8743F;color:#fff;font:600 15px system-ui,sans-serif';
    btn.onclick = function () {
      try { sessionStorage.removeItem(GUARD); } catch (e) {}
      clearDataCache();
      location.reload();
    };
    b.appendChild(t);
    b.appendChild(btn);
    document.body.appendChild(b);
    // Догрузилась сама — плашку убираем.
    var timer = setInterval(function () {
      if (!stillLoading()) { b.remove(); clearInterval(timer); }
    }, 1000);
  }

  function check() {
    if (healed || !stillLoading()) return;
    healed = true;
    reported = true;
    report(fatal ? 'fatal' : 'slow', fatal || 'крутилка дольше ' + WAIT_MS / 1000 + ' с');
    // Перезагрузка — не чаще раза в 2 минуты: иначе страница крутилась бы по кругу.
    if (Date.now() - lastHeal() > 120000) {
      try { sessionStorage.setItem(GUARD, String(Date.now())); } catch (e) {}
      clearDataCache();
      location.reload();
      return;
    }
    banner();
  }

  setTimeout(check, WAIT_MS);
})();
