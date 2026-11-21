// Табло заказов: раз в 4 с берёт номера с сервера (ключ — после # в адресе).
(function () {
  var key = (location.hash || '').replace(/^#/, '').trim();
  var shown = {};
  var fails = 0;
  function $(id) { return document.getElementById(id); }
  function msg(t) { var m = $('msg'); m.textContent = t || ''; m.hidden = !t; }
  function draw(box, list, fresh) {
    var el = $(box);
    el.textContent = '';
    list.forEach(function (x) {
      var d = document.createElement('div');
      d.className = 'num' + (x.table ? ' table' : '') + (fresh && !shown[x.label] ? ' fresh' : '');
      d.textContent = x.label;
      el.appendChild(d);
    });
  }
  function tick() {
    if (!/^[A-Za-z0-9]{24}$/.test(key)) { msg('Откройте ссылку на табло из кабинета: Настройки → «Табло заказов».'); return; }
    var x = new XMLHttpRequest();
    x.open('GET', 'data');
    x.setRequestHeader('X-Board-Key', key);
    x.timeout = 10000;
    x.onload = function () {
      var j = null;
      try { j = JSON.parse(x.responseText); } catch (e) {}
      if (x.status === 200 && j) {
        fails = 0; msg('');
        if (j.venue) { $('venue').textContent = j.venue; document.title = j.venue + ' — табло заказов'; }
        draw('cooking', j.cooking || [], false);
        draw('ready', j.ready || [], true);
        var next = {};
        (j.ready || []).forEach(function (r) { next[r.label] = 1; });
        shown = next;
      } else {
        msg((j && j.error) || 'Табло не найдено');
      }
    };
    x.onerror = x.ontimeout = function () { if (++fails >= 2) msg('Нет связи с сервером — показываем последние номера'); };
    x.send();
  }
  function clock() { var d = new Date(); $('clock').textContent = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  $('full').onclick = function () { var e = document.documentElement; if (e.requestFullscreen) e.requestFullscreen().catch(function () {}); };
  window.addEventListener('hashchange', function () { key = (location.hash || '').replace(/^#/, '').trim(); tick(); });
  clock(); setInterval(clock, 15000);
  tick(); setInterval(tick, 4000);
})();
