// Яндекс Метрика на публичных страницах zalpos.ru — только с согласия.
//
// Пока ID = 0, файл ничего не делает: ни плашки, ни запросов к Яндексу.
// Чтобы включить: впишите номер счётчика в ID и дату включения в SINCE
// (с неё действует редакция политики с разделом о Метрике — console.js,
// applyLegalMode). Счётчик создаёт владелец в metrika.yandex.ru, Вебвизор
// и карту кликов в его настройках не включать.
//
// Что считаем: просмотры публичных страниц (главная, блог, инструкция,
// документы, вход и регистрация) и цели «signup» (зарегистрировался) и
// «demo» (открыл демо). Кабинет после входа, приложение гостя и курьера не
// считаем никогда: там данные заведений. Вебвизор и карта кликов выключены.
// Согласие — localStorage 'zalpos-cookies' = 'yes' | 'no'; отозвать —
// ссылка «Настройки cookie» внизу страницы (атрибут data-cookie-settings).
(function () {
  var ID = 0;
  var SINCE = '';
  var KEY = 'zalpos-cookies';

  window.ZalMetrika = { id: ID, since: SINCE };
  window.zalGoal = function () {};
  window.zalCookies = function () {};
  if (!ID) return;

  function read() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function write(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  // Публичная страница: всё, кроме кабинета на главной. На главной публичны
  // лендинг, документы, статус, вход и регистрация.
  var PUBLIC_HASH = /^(#?|#\/|#\/(legal\/[a-z]+|status|faq|guide|demo-photos|partner-terms|login|signup|forgot))$/;
  function isPublic() {
    if (location.pathname !== '/' && location.pathname !== '/index.html') return true;
    return PUBLIC_HASH.test(location.hash.split('?')[0]);
  }

  var loaded = false;
  var lastUrl = '';
  function hit() {
    if (!loaded || !isPublic() || read() !== 'yes') return;
    var url = location.href.split('?')[0];
    if (url === lastUrl) return;
    var ref = lastUrl || document.referrer;
    lastUrl = url;
    window.ym(ID, 'hit', url, { title: document.title, referer: ref });
  }
  function load() {
    if (loaded) return;
    loaded = true;
    window['disableYaCounter' + ID] = false;
    window.ym = window.ym || function () { (window.ym.a = window.ym.a || []).push(arguments); };
    window.ym.l = +new Date();
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://mc.yandex.ru/metrika/tag.js';
    document.head.appendChild(s);
    window.ym(ID, 'init', {
      defer: true, clickmap: false, trackLinks: true, accurateTrackBounce: true, webvisor: false,
    });
    hit();
  }
  window.addEventListener('hashchange', function () { setTimeout(hit, 50); });

  window.zalGoal = function (name) {
    if (loaded && read() === 'yes') { try { window.ym(ID, 'reachGoal', name); } catch (e) {} }
  };

  var bar = null;
  function hideBar() { if (bar) { bar.remove(); bar = null; } }
  function choose(v) {
    write(v);
    hideBar();
    if (v === 'yes') load();
    else window['disableYaCounter' + ID] = true;
  }
  function showBar() {
    if (bar || !document.body) return;
    bar = document.createElement('div');
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Файлы cookie');
    bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;max-width:560px;margin:0 auto;'
      + 'background:#1c1b19;color:#f4f1ea;border-radius:14px;padding:14px 16px;box-shadow:0 8px 30px rgba(0,0,0,.35);'
      + 'font:14px/1.45 Onest,system-ui,-apple-system,sans-serif';
    bar.innerHTML = '<p style="margin:0 0 10px">Мы используем cookie и Яндекс Метрику, чтобы понимать, какие страницы сайта полезны. '
      + 'Статистика обезличенная, записи действий нет. <a href="/#/legal/privacy" style="color:#e9c46a">Подробнее</a></p>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
      + '<button type="button" data-v="yes" style="flex:1;min-width:120px;padding:10px 14px;border:0;border-radius:10px;background:#e9c46a;color:#1c1b19;font:inherit;font-weight:600;cursor:pointer">Разрешить</button>'
      + '<button type="button" data-v="no" style="flex:1;min-width:120px;padding:10px 14px;border:1px solid #6b665c;border-radius:10px;background:transparent;color:#f4f1ea;font:inherit;cursor:pointer">Отказаться</button>'
      + '</div>';
    bar.addEventListener('click', function (e) {
      var v = e.target && e.target.getAttribute && e.target.getAttribute('data-v');
      if (v) choose(v);
    });
    document.body.appendChild(bar);
  }
  window.zalCookies = function () { hideBar(); showBar(); };

  function start() {
    // Ссылки «Настройки cookie» в подвале скрыты, пока счётчик не включён.
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('[data-cookie-settings]');
      if (a) { e.preventDefault(); window.zalCookies(); }
    });
    var reveal = function () {
      var links = document.querySelectorAll('[data-cookie-settings][hidden]');
      for (var i = 0; i < links.length; i++) links[i].hidden = false;
    };
    reveal();
    new MutationObserver(reveal).observe(document.body, { childList: true, subtree: true });
    var v = read();
    if (v === 'yes') load();
    else if (!v && isPublic()) showBar();
    window.addEventListener('hashchange', function () { if (!read() && isPublic()) showBar(); else if (!isPublic()) hideBar(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
