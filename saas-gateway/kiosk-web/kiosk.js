// Киоск самообслуживания: меню → корзина → номер заказа (оплата на кассе).
(function () {
  var key = (location.hash || '').replace(/^#/, '').trim();
  var data = null;
  var cat = '';
  var cart = []; // {id, name, price, qty, mods:[]}
  var here = null;
  var idle = null;
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function rub(n) { return Math.round(Number(n) || 0).toLocaleString('ru-RU') + ' ₽'; }
  function toast(t) { var el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { el.hidden = true; }, 3500); }
  function api(method, path, body, cb) {
    var x = new XMLHttpRequest();
    x.open(method, path);
    x.setRequestHeader('X-Kiosk-Key', key);
    if (body) x.setRequestHeader('Content-Type', 'application/json');
    x.timeout = 20000;
    x.onload = function () { var j = null; try { j = JSON.parse(x.responseText); } catch (e) {} cb(x.status === 200 ? null : ((j && j.error) || 'Нет связи — подойдите на кассу'), j); };
    x.onerror = x.ontimeout = function () { cb('Нет связи — подойдите на кассу'); };
    x.send(body ? JSON.stringify(body) : null);
  }
  function reset() { cart = []; here = null; closeAll(); draw(); window.scrollTo(0, 0); }
  function touch() { clearTimeout(idle); if (cart.length) idle = setTimeout(reset, 120000); }
  function closeAll() { $('sheet').hidden = true; $('screen').hidden = true; }
  function count() { return cart.reduce(function (a, l) { return a + l.qty; }, 0); }
  function sum() { return cart.reduce(function (a, l) { return a + l.price * l.qty; }, 0); }
  function qtyOf(id) { return cart.filter(function (l) { return l.id === id; }).reduce(function (a, l) { return a + l.qty; }, 0); }
  function add(it, mods, extra) {
    var sig = it.id + '|' + mods.join('|');
    var line = cart.filter(function (l) { return l.sig === sig; })[0];
    if (line) line.qty++; else cart.push({ sig: sig, id: it.id, name: it.name, price: it.price + extra, qty: 1, mods: mods });
    touch(); draw();
  }
  function draw() {
    if (!data) return;
    $('venue').textContent = data.venue || 'Меню';
    $('cats').innerHTML = (data.categories.length > 1 ? '<button data-c="" class="' + (!cat ? 'on' : '') + '">Все</button>' : '') + data.categories.map(function (c) { return '<button data-c="' + esc(c.id) + '" class="' + (c.id === cat ? 'on' : '') + '">' + esc(c.name) + '</button>'; }).join('');
    var list = data.items.filter(function (i) { return !cat || i.categoryId === cat; });
    $('grid').innerHTML = list.map(function (i) {
      var q = qtyOf(i.id);
      return '<button class="item" data-i="' + esc(i.id) + '"><div class="ph"' + (i.imageUrl ? ' style="background-image:url(\'' + esc(i.imageUrl) + '\')"' : '') + '></div>'
        + '<div class="body"><div class="name">' + esc(i.name) + '</div>'
        + (i.weight ? '<div class="meta">' + esc(i.weight) + ' ' + esc({ g: 'г', ml: 'мл', kg: 'кг', l: 'л', pcs: 'шт' }[i.weightUnit] || '') + '</div>' : '')
        + '<div class="row"><span class="price">' + rub(i.price) + '</span>' + (q ? '<span class="qty">' + q + ' в корзине</span>' : '<span class="plus">+</span>') + '</div></div></button>';
    }).join('') || '<p>Сейчас нечего предложить — подойдите на кассу.</p>';
    $('bar').hidden = !cart.length;
    $('barCount').textContent = count() + ' шт.';
    $('barSum').textContent = rub(sum());
  }
  function itemSheet(it) {
    var chosen = it.groups.map(function () { return []; });
    function paint() {
      var extra = 0; var ok = true;
      it.groups.forEach(function (g, gi) { chosen[gi].forEach(function (n) { var o = g.options.filter(function (x) { return x.name === n; })[0]; if (o) extra += o.price; }); if (chosen[gi].length < g.min) ok = false; });
      $('sheet').innerHTML = '<div><h2>' + esc(it.name) + '</h2>' + (it.description ? '<div class="note" style="margin:0">' + esc(it.description) + '</div>' : '')
        + it.groups.map(function (g, gi) {
          return '<div class="grp">' + esc(g.name) + (g.min ? ' — выберите' : ' — по желанию') + '</div>'
            + g.options.map(function (o) { return '<button class="opt' + (chosen[gi].indexOf(o.name) >= 0 ? ' on' : '') + '" data-g="' + gi + '" data-o="' + esc(o.name) + '"><span>' + esc(o.name) + '</span><span>' + (o.price ? '+' + rub(o.price) : '') + '</span></button>'; }).join('');
        }).join('')
        + '<button class="big dark" id="sAdd"' + (ok ? '' : ' disabled') + '>Добавить · ' + rub(it.price + extra) + '</button><button class="big light" id="sCancel">Назад</button></div>';
      $('sheet').hidden = false;
      Array.prototype.forEach.call($('sheet').querySelectorAll('.opt'), function (b) {
        b.onclick = function () {
          var gi = Number(b.dataset.g); var g = it.groups[gi]; var n = b.dataset.o; var cur = chosen[gi]; var at = cur.indexOf(n);
          if (at >= 0) cur.splice(at, 1); else if (g.max === 1) chosen[gi] = [n]; else if (!g.max || cur.length < g.max) cur.push(n);
          paint();
        };
      });
      $('sAdd').onclick = function () { $('sheet').hidden = true; add(it, [].concat.apply([], chosen), extra); };
      $('sCancel').onclick = function () { $('sheet').hidden = true; };
    }
    paint();
  }
  function cartSheet() {
    if (!cart.length) { $('sheet').hidden = true; return; }
    $('sheet').innerHTML = '<div><h2>Ваш заказ</h2>' + cart.map(function (l, i) {
      return '<div class="line"><div class="n">' + esc(l.name) + (l.mods.length ? '<small>' + esc(l.mods.join(', ')) + '</small>' : '') + '<small>' + rub(l.price) + '</small></div>'
        + '<button class="step" data-m="' + i + '">−</button><b>' + l.qty + '</b><button class="step" data-p="' + i + '">+</button></div>';
    }).join('')
      + '<div class="where"><button data-w="here" class="' + (here === true ? 'on' : '') + '">Здесь</button><button data-w="go" class="' + (here === false ? 'on' : '') + '">С собой</button></div>'
      + '<button class="big dark" id="cSend"' + (here === null ? ' disabled' : '') + '>Оформить · ' + rub(sum()) + '</button>'
      + '<button class="big light" id="cBack">Добавить ещё</button><div class="note">Оплата — на кассе по номеру заказа.</div></div>';
    $('sheet').hidden = false;
    Array.prototype.forEach.call($('sheet').querySelectorAll('[data-m]'), function (b) { b.onclick = function () { var l = cart[b.dataset.m]; if (--l.qty <= 0) cart.splice(b.dataset.m, 1); touch(); draw(); cartSheet(); }; });
    Array.prototype.forEach.call($('sheet').querySelectorAll('[data-p]'), function (b) { b.onclick = function () { cart[b.dataset.p].qty++; touch(); draw(); cartSheet(); }; });
    Array.prototype.forEach.call($('sheet').querySelectorAll('[data-w]'), function (b) { b.onclick = function () { here = b.dataset.w === 'here'; cartSheet(); }; });
    $('cBack').onclick = function () { $('sheet').hidden = true; };
    $('cSend').onclick = function () {
      $('cSend').disabled = true;
      api('POST', 'order', { here: here, items: cart.map(function (l) { return { menuItemId: l.id, qty: l.qty, mods: l.mods }; }) }, function (err, r) {
        if (err) { toast(err); $('cSend').disabled = false; if (/больше нет в меню/.test(err)) load(); return; }
        $('sheet').hidden = true;
        $('screen').innerHTML = '<div><div class="note" style="font-size:22px;color:var(--text)">Ваш заказ</div><div class="no">№ ' + esc(r.orderNo) + '</div>'
          + '<h2>Оплатите на кассе: ' + rub(r.total) + '</h2><div class="note">Назовите номер заказа кассиру. Когда будет готово — номер появится на табло.</div>'
          + '<button class="big dark" id="done" style="max-width:420px">Готово</button></div>';
        $('screen').hidden = false;
        $('done').onclick = reset;
        clearTimeout(idle); idle = setTimeout(reset, 25000);
      });
    };
  }
  function load() {
    if (!/^[A-Za-z0-9]{24}$/.test(key)) { $('grid').innerHTML = '<p>Откройте ссылку на киоск из кабинета: Настройки → «Киоск самообслуживания».</p>'; return; }
    api('GET', 'menu', null, function (err, j) {
      if (err) { $('grid').innerHTML = '<p>' + esc(err) + '</p>'; setTimeout(load, 15000); return; }
      data = j; if (cat && !data.categories.some(function (c) { return c.id === cat; })) cat = '';
      draw();
    });
  }
  document.addEventListener('click', function (e) {
    var c = e.target.closest && e.target.closest('[data-c]');
    if (c) { cat = c.dataset.c; draw(); window.scrollTo(0, 0); return; }
    var it = e.target.closest && e.target.closest('.item');
    if (it && data) { var i = data.items.filter(function (x) { return x.id === it.dataset.i; })[0]; if (i) { if (i.groups.length) itemSheet(i); else add(i, [], 0); } }
  });
  $('openCart').onclick = cartSheet;
  $('full').onclick = function () { var d = document.documentElement; if (d.requestFullscreen) d.requestFullscreen().catch(function () {}); };
  window.addEventListener('hashchange', function () { key = (location.hash || '').replace(/^#/, '').trim(); load(); });
  load(); setInterval(function () { if (!cart.length) load(); }, 5 * 60000);
})();
