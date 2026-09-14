// Веб-версия приложения гостя «Colibri Lounge».
//
// Зачем она есть. Основное приложение — только для Android: собрать сборку
// для iPhone нельзя без платного аккаунта разработчика Apple и проверки в
// App Store. А гость с айфоном за столом такой же гость. Эта версия
// открывается прямо в Safari по той же ссылке, что зашита в QR на столе,
// и работает с той же базой и по тем же правилам: отличается способ
// доставки, а не возможности.
//
// Чего здесь намеренно нет: сканера QR (он не нужен — номер стола уже в
// ссылке, по которой гость сюда попал) и ИИ-сомелье (он ходит во внешний
// сервис по ключу, а ключ нельзя отдавать в браузер).

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, onSnapshot,
  collection, query, where, orderBy, limit, addDoc, deleteDoc, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// ---------- СОСТОЯНИЕ ----------

const state = {
  db: null,
  auth: null,
  uid: '',
  profile: null,
  venue: null,
  /// Отписки от «живых» запросов текущего экрана. При каждом переходе
  /// снимаются все: иначе экраны копят подписки, телефон греется, а
  /// трафик уходит впустую.
  screenSubs: [],
  /// Подписки уровня аккаунта (профиль, заведение). Снимаются при смене
  /// аккаунта — иначе после входа по телефону приложение продолжало бы
  /// слушать профиль прежнего, анонимного гостя.
  accountSubs: [],
  ticker: null,
  cart: {},
};

const $ = (id) => document.getElementById(id);
const screenEl = () => $('screen');

// ---------- МЕЛОЧИ ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const money = (v) => `${Math.round(Number(v) || 0).toLocaleString('ru-RU')} ₽`;

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dmy = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;

/// Firestore отдаёт время объектом Timestamp; при чтении из кэша поле
/// может быть ещё пустым — поэтому всегда через проверку.
function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (v instanceof Date) return v;
  return null;
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function clearScreen() {
  state.screenSubs.forEach((off) => { try { off(); } catch (_) {} });
  state.screenSubs = [];
  if (state.ticker) { clearInterval(state.ticker); state.ticker = null; }
}

function sub(off) { state.screenSubs.push(off); }

// ---------- ЗАПУСК ----------

async function boot() {
  let config;
  try {
    // Firebase Hosting сам отдаёт настройки проекта по этому адресу —
    // ключи не приходится вшивать в код и обновлять руками.
    const res = await fetch('/__/firebase/init.json');
    config = await res.json();
    if (!config || !config.projectId) throw new Error('пусто');
  } catch (_) {
    screenEl().innerHTML = `
      <h1>Почти готово</h1>
      <p class="muted">Осталось один раз зарегистрировать веб-приложение в
      Firebase: консоль → Project settings → Your apps → значок
      &lt;/&gt; (Web) → любое имя → Register app. Больше ничего делать не нужно,
      настройки подставятся сюда сами.</p>`;
    return;
  }

  const app = initializeApp(config);
  state.db = getFirestore(app);
  const auth = getAuth(app);

  state.auth = auth;
  let routerReady = false;

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      try {
        await signInAnonymously(auth);
      } catch (e) {
        screenEl().innerHTML = `<h1>Нет связи</h1>
          <p class="muted">Не удалось подключиться к серверу. Проверьте
          интернет и обновите страницу.</p>`;
      }
      return;
    }
    if (state.uid === user.uid) return;

    // Смена аккаунта (вход по телефону или выход): снимаем всё, что
    // слушало прежнего гостя, иначе на экране смешались бы два профиля.
    state.accountSubs.forEach((off) => { try { off(); } catch (_) {} });
    state.accountSubs = [];
    clearScreen();

    state.uid = user.uid;
    state.profile = null;
    state.cart = {};

    await ensureProfile();
    watchProfile();
    watchVenue();
    $('tabbar').hidden = false;
    if (!routerReady) {
      routerReady = true;
      window.addEventListener('hashchange', route);
    }
    route();
  });
}

/// Короткий ID этого устройства — шесть символов, которые легко
/// продиктовать кальянщику.
///
/// Ровно то же, что в приложении на Android: алфавит без похожих друг на
/// друга знаков (нет 0/O и 1/I — их путают на слух и на вид), и он
/// сохраняется навсегда на этом устройстве. По нему касса находит гостя,
/// если тот сменил телефон и не помнит, на какой номер копил бонусы.
function shortDeviceId() {
  const KEY = 'colibri_short_device_id';
  let id = '';
  try { id = localStorage.getItem(KEY) || ''; } catch (_) {}
  if (!id) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const rnd = new Uint32Array(6);
    (window.crypto || window.msCrypto).getRandomValues(rnd);
    id = Array.from(rnd, (n) => chars[n % chars.length]).join('');
    try { localStorage.setItem(KEY, id); } catch (_) {}
  }
  return id;
}

/// Профиль гостя заводится один раз и дальше живёт сам: уровень, бонусы и
/// историю визитов пишет касса при закрытии чека.
async function ensureProfile() {
  const ref = doc(state.db, 'clients', state.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      name: '', phone: '',
      bonusBalance: 0, totalSpent: 0, visits: 0,
      activeSessionId: '', activeTableId: '',
      createdAt: Timestamp.fromDate(new Date()),
    }, { merge: true });
  }
  // ID устройства пишем всегда: значение не меняется, а кассир должен
  // найти гостя по нему сразу, не дожидаясь, пока тот откроет профиль.
  try {
    await setDoc(ref, { shortDeviceId: shortDeviceId() }, { merge: true });
  } catch (_) {}
}

function watchProfile() {
  state.accountSubs.push(onSnapshot(doc(state.db, 'clients', state.uid), (d) => {
    state.profile = d.exists() ? { id: d.id, ...d.data() } : null;
    // Экран «Мой стол» и «Главная» зависят от профиля — перерисуем.
    if (['#/', '#/table', '#/profile', ''].includes(location.hash)) route();
  }, () => {}));
}

function watchVenue() {
  state.accountSubs.push(onSnapshot(doc(state.db, 'venue', 'profile'), (d) => {
    state.venue = d.exists() ? d.data() : null;
  }, () => {}));
}

// ---------- УРОВНИ ЛОЯЛЬНОСТИ ----------
// Те же пороги, что в приложении на Android (ClientProfile.tiers).

const TIERS = [
  { name: 'Бронза', from: 0, cashback: 3 },
  { name: 'Серебро', from: 10000, cashback: 5 },
  { name: 'Золото', from: 25000, cashback: 7 },
  { name: 'Платина', from: 50000, cashback: 10 },
  { name: 'Алмаз', from: 100000, cashback: 15 },
];

function tierOf(spent) {
  let t = TIERS[0];
  for (const x of TIERS) if (spent >= x.from) t = x;
  return t;
}
function nextTier(spent) {
  return TIERS.find((x) => x.from > spent) || null;
}

// ---------- МАРШРУТЫ ----------

function route() {
  clearScreen();
  const hash = location.hash || '#/';
  const bind = hash.match(/^#\/t\/(.+)$/);
  const tab = bind ? 'table' : (hash.replace('#/', '') || 'home');

  document.querySelectorAll('.tabbar a').forEach((a) => {
    a.classList.toggle('on', a.dataset.tab === (tab === '' ? 'home' : tab));
  });
  window.scrollTo(0, 0);

  if (bind) return bindToTable(decodeURIComponent(bind[1]));
  const hall = hash.match(/^#\/hall(\/pick)?$/);
  if (hall) return screenHall(!!hall[1]);

  switch (tab) {
    case 'scan': return screenScan();
    case 'menu': return screenMenu();
    case 'booking': return screenBooking();
    case 'table': return screenTable();
    case 'profile': return screenProfile();
    default: return screenHome();
  }
}

boot();

// ---------- ГЛАВНАЯ ----------

function screenHome() {
  const p = state.profile || {};
  const spent = Number(p.totalSpent) || 0;
  const tier = tierOf(spent);
  const next = nextTier(spent);
  const name = (p.name || '').trim();
  const hour = new Date().getHours();
  const hello = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро'
    : hour < 18 ? 'Добрый день' : 'Добрый вечер';

  screenEl().innerHTML = `
    <div class="small" style="color:var(--primary);letter-spacing:.14em;text-transform:uppercase;font-weight:600">
      Colibri Lounge
    </div>
    <h1>${esc(hello)}${name ? ', ' + esc(name) : ''}</h1>

    <div class="card tier">
      <div class="muted small">Бонусный счёт</div>
      <div class="bonus">${money(p.bonusBalance)}</div>
      <div class="small muted">Уровень «${esc(tier.name)}» · кешбэк ${tier.cashback}%</div>
      ${next ? `
        <div class="bar"><i style="width:${progressPercent(spent)}%"></i></div>
        <div class="small muted">До уровня «${esc(next.name)}» осталось
          ${money(next.from - spent)} — кешбэк вырастет до ${next.cashback}%</div>
      ` : `<div class="small muted" style="margin-top:8px">Максимальный уровень — спасибо, что вы с нами</div>`}
    </div>

    <div id="soon"></div>
    <div id="stories"></div>

    <h2>Быстрые действия</h2>
    <div class="btn-row">
      <a class="btn btn-ghost" href="#/booking">📅 Забронировать</a>
      <a class="btn btn-ghost" href="#/menu">🍽 Меню</a>
    </div>
    <div style="height:10px"></div>
    <a class="btn btn-primary" href="#/scan">📷 Я за столом — сканировать QR</a>
  `;

  renderStories();
  renderBookingSoon('soon');
}

function progressPercent(spent) {
  const tier = tierOf(spent);
  const next = nextTier(spent);
  if (!next) return 100;
  const span = next.from - tier.from;
  return Math.max(0, Math.min(100, ((spent - tier.from) / span) * 100));
}

function renderStories() {
  const box = $('stories');
  if (!box) return;
  sub(onSnapshot(collection(state.db, 'stories'), (snap) => {
    const now = new Date();
    const list = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((s) => s.published === true)
      .filter((s) => {
        const until = toDate(s.publishUntil);
        return !until || until > now;
      })
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    if (!list.length) { box.innerHTML = ''; return; }

    box.innerHTML = `<h2>Афиша</h2>` + list.map((s) => `
      <div class="card" ${s.action === 'menu' ? 'onclick="location.hash=\'#/menu\'"'
        : s.action === 'booking' ? 'onclick="location.hash=\'#/booking\'"' : ''}
        style="${s.action && s.action !== 'none' ? 'cursor:pointer' : ''}">
        <div style="font-weight:600;margin-bottom:6px">${esc(s.title)}</div>
        <div class="small muted">${esc(s.text)}</div>
        ${s.actionLabel ? `<div class="small" style="color:var(--primary);margin-top:10px;font-weight:600">${esc(s.actionLabel)} →</div>` : ''}
      </div>
    `).join('');
  }, () => { box.innerHTML = ''; }));
}

// ---------- МЕНЮ ----------

function screenMenu() {
  screenEl().innerHTML = `<h1>Меню</h1><div id="menu"><div class="spinner"></div></div>`;

  let cats = [];
  let items = [];
  let activeCat = null;

  const draw = () => {
    const box = $('menu');
    if (!box) return;
    if (!items.length) {
      box.innerHTML = `<p class="muted">Меню пока пустое.</p>`;
      return;
    }
    // Отдельный чип «Всё меню»: гость чаще хочет посмотреть всё сразу,
    // чем перебирать категории — особенно когда их много.
    const known = cats.map((c) => c.id);
    if (activeCat !== 'all' && (!activeCat || !known.includes(activeCat))) activeCat = 'all';

    const shown = activeCat === 'all'
      ? items
      : items.filter((i) => i.categoryId === activeCat);
    const atTable = !!(state.profile && state.profile.activeSessionId);

    box.innerHTML = `
      <div>
        <span class="chip ${activeCat === 'all' ? 'on' : ''}" data-cat="all">Всё меню</span>
        ${cats.map((c) => `
          <span class="chip ${c.id === activeCat ? 'on' : ''}" data-cat="${esc(c.id)}">${esc(c.name)}</span>
        `).join('')}</div>

      <div class="card">
        ${shown.length ? shown.map((i) => `
          <div class="item">
            ${i.imageUrl ? `<img src="${esc(i.imageUrl)}" alt="" loading="lazy">` : ''}
            <div class="grow">
              <div style="font-weight:600">${esc(i.name)}</div>
              <div class="small muted">${money(i.price)}${activeCat === 'all'
                ? ' · ' + esc((cats.find((c) => c.id === i.categoryId) || {}).name || '')
                : ''}</div>
            </div>
            ${atTable ? `
              <div class="qty">
                ${state.cart[i.id] ? `
                  <button data-minus="${esc(i.id)}">−</button>
                  <span>${state.cart[i.id]}</span>` : ''}
                <button data-plus="${esc(i.id)}">+</button>
              </div>` : ''}
          </div>
        `).join('') : `<p class="muted small">В этой категории пока пусто.</p>`}
      </div>

      ${atTable ? cartBlock() : `
        <p class="small muted">Чтобы заказать из приложения, откройте свой
        стол — отсканируйте QR-код на столе камерой телефона.</p>`}
    `;

    box.querySelectorAll('[data-cat]').forEach((el) => {
      el.onclick = () => { activeCat = el.dataset.cat; draw(); };
    });
    box.querySelectorAll('[data-plus]').forEach((el) => {
      el.onclick = () => { addToCart(el.dataset.plus, items); draw(); };
    });
    box.querySelectorAll('[data-minus]').forEach((el) => {
      el.onclick = () => { removeFromCart(el.dataset.minus); draw(); };
    });
    const send = $('sendOrder');
    if (send) send.onclick = () => placeOrder(items, draw);
  };

  sub(onSnapshot(query(collection(state.db, 'menuCategories'), orderBy('order')), (s) => {
    cats = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  }, () => {}));

  sub(onSnapshot(collection(state.db, 'menuItems'), (s) => {
    items = s.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((i) => i.available !== false)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
    draw();
  }, () => {}));
}

function cartBlock() {
  const ids = Object.keys(state.cart);
  if (!ids.length) return '';
  return `
    <div class="card">
      <div style="font-weight:600;margin-bottom:8px">Ваш заказ</div>
      <div class="small muted" style="margin-bottom:12px">
        Кальянщик подтвердит заказ, и позиции появятся в счёте.
      </div>
      <button class="btn-primary" id="sendOrder">Отправить заказ</button>
    </div>`;
}

function addToCart(id, items) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  state.cart[id] = (state.cart[id] || 0) + 1;
}
function removeFromCart(id) {
  if (!state.cart[id]) return;
  state.cart[id] -= 1;
  if (state.cart[id] <= 0) delete state.cart[id];
}

async function placeOrder(items, redraw) {
  const p = state.profile;
  if (!p || !p.activeSessionId) return toast('Сначала откройте свой стол');
  const chosen = Object.entries(state.cart).map(([id, qty]) => {
    const it = items.find((i) => i.id === id);
    return it ? { menuItemId: it.id, name: it.name, price: Number(it.price) || 0, qty } : null;
  }).filter(Boolean);
  if (!chosen.length) return;

  try {
    await addDoc(collection(state.db, 'guestOrders'), {
      sessionId: p.activeSessionId,
      tableId: p.activeTableId || '',
      tableName: '',
      clientUid: state.uid,
      guestName: p.name || '',
      items: chosen,
      comment: '',
      status: 'new',
      rejectReason: '',
      createdAt: Timestamp.fromDate(new Date()),
    });
    state.cart = {};
    redraw();
    toast('Заказ передан кальянщику');
  } catch (e) {
    toast('Не удалось отправить заказ');
  }
}

// ---------- МОЙ СТОЛ ----------

/// Привязка к столу по ссылке из QR: /app/#/t/{tableId}
///
/// Логика та же, что в приложении на Android, и та же защита: чек
/// закрепляется за первым, кто его занял (документ sessionClaims), и
/// второму телефону база просто откажет в записи.
async function bindToTable(tableId) {
  screenEl().innerHTML = `<h1>Открываем стол…</h1><div class="spinner"></div>`;
  try {
    const t = await getDoc(doc(state.db, 'tables', tableId));
    if (!t.exists()) return failBind('Такого стола нет. Отсканируйте код ещё раз.');
    const data = t.data();
    const checks = (data.openChecks || []).filter((c) => c && c.id);
    const ids = data.activeSessionIds || [];

    if (!ids.length) {
      return failBind('За этим столом сейчас нет открытого счёта — '
        + 'попросите кальянщика начать сеанс.');
    }

    // Несколько счетов за столом — гость выбирает свой.
    if (checks.length > 1) return chooseCheck(tableId, data.name || '', checks);

    const sessionId = checks.length === 1 ? checks[0].id : ids[ids.length - 1];
    await claimSession(tableId, sessionId);
  } catch (e) {
    failBind('Не удалось открыть стол. Проверьте интернет и попробуйте ещё раз.');
  }
}

function failBind(message) {
  screenEl().innerHTML = `
    <h1>Мой стол</h1>
    <div class="card warn"><p class="small">${esc(message)}</p></div>
    <a class="btn btn-ghost" href="#/">На главную</a>`;
}

function chooseCheck(tableId, tableName, checks) {
  screenEl().innerHTML = `
    <h1>${tableName ? 'Стол ' + esc(tableName) : 'Ваш стол'}</h1>
    <p class="muted small">За этим столом открыто несколько счетов.
    Выберите свой — если ошибётесь, можно будет отвязаться.</p>
    ${checks.map((c, i) => {
      const opened = toDate(c.openedAt);
      return `
        <div class="card" data-check="${esc(c.id)}" style="cursor:pointer">
          <div class="row">
            <div class="grow">
              <div style="font-weight:600">${esc(c.label || 'Счёт ' + (i + 1))}</div>
              <div class="small muted">${opened ? 'Открыт в ' + hhmm(opened) : 'Время открытия неизвестно'}</div>
            </div>
            <div class="muted">›</div>
          </div>
        </div>`;
    }).join('')}`;

  screenEl().querySelectorAll('[data-check]').forEach((el) => {
    el.onclick = () => claimSession(tableId, el.dataset.check);
  });
}

async function claimSession(tableId, sessionId) {
  try {
    // Документ создаётся, только если его ещё нет: правила базы не дадут
    // переписать чужой. Поэтому при одновременном сканировании с двух
    // телефонов выигрывает ровно один.
    await setDoc(doc(state.db, 'sessionClaims', sessionId), { uid: state.uid });
  } catch (e) {
    return failBind('Этот счёт уже открыт у другого гостя. '
      + 'Если это ваш стол — попросите кальянщика открыть вам свой счёт.');
  }
  try {
    await setDoc(doc(state.db, 'clients', state.uid), {
      activeSessionId: sessionId,
      activeTableId: tableId,
      lastVisitAt: Timestamp.fromDate(new Date()),
    }, { merge: true });
  } catch (e) {
    return failBind('Не удалось закрепить стол за вами. Попробуйте ещё раз.');
  }
  location.hash = '#/table';
  toast('Готово! Ваш счёт открыт');
}

function screenTable() {
  const p = state.profile;
  const sessionId = (p && p.activeSessionId) || '';
  if (!sessionId) return tableEmpty();

  screenEl().innerHTML = `<div class="spinner"></div>`;

  sub(onSnapshot(doc(state.db, 'sessions', sessionId), (d) => {
    if (!d.exists()) return tableEmpty();
    const s = { id: d.id, ...d.data() };
    if (s.status !== 'active') return tableFinished(s);
    drawTable(s);
  }, () => tableEmpty()));
}

function tableEmpty() {
  clearScreen();
  const rules = ((state.venue && state.venue.rules) || '')
    .split('\n').map((l) => l.trim().replace(/^[-•*]\s*/, '')).filter(Boolean);

  screenEl().innerHTML = `
    <h1>Мой стол</h1>
    <p class="muted">Отсканируйте QR-код на своём столе — откроются счёт,
    таймер сеанса и кнопки вызова кальянщика.</p>
    <a class="btn btn-primary" href="#/scan">📷 Сканировать QR стола</a>
    <div style="height:10px"></div>
    <a class="btn btn-ghost" href="#/hall">🗺 Карта зала</a>
    <div style="height:14px"></div>
    <p class="small muted">Стол открывается только по коду с самого стола —
    так вы наверняка попадёте на свой счёт, а не на соседний. Если код не
    сканируется, позовите кальянщика: он откроет стол сам.</p>
    ${rules.length ? `
      <div class="card" style="margin-top:22px">
        <div style="font-weight:600;margin-bottom:12px">ⓘ Правила заведения</div>
        ${rules.map((r) => `<div class="rule"><i></i><div class="small muted">${esc(r)}</div></div>`).join('')}
      </div>` : ''}`;
}

function drawTable(s) {
  const items = s.orderItems || [];
  const total = items.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
  const bonus = Number((state.profile || {}).bonusBalance) || 0;

  screenEl().innerHTML = `
    <div class="row">
      <h1 class="grow ellipsis">Стол ${esc(s.tableName || '')}</h1>
      <button class="btn-link" id="unbind">Это не мой стол</button>
    </div>

    <div class="card timer" id="timer"><div class="value">—</div></div>

    <h2>Позвать</h2>
    <div class="btn-row">
      <button class="btn-ghost" data-call="coal">🔥 Поменять угли</button>
      <button class="btn-ghost" data-call="refill">🔄 Перезабивка</button>
    </div>
    <div style="height:10px"></div>
    <div class="btn-row">
      <button class="btn-ghost" data-call="waiter">🙋 Позвать кальянщика</button>
      <button class="btn-ghost" data-call="bill">💸 Счёт, пожалуйста</button>
    </div>
    <div id="calls"></div>

    <h2>Ваш счёт</h2>
    <div class="card">
      ${items.length ? items.map((i) => `
        <div class="bill-line">
          <span class="grow">${esc(i.name)} ×${Number(i.qty) || 0}</span>
          <span class="muted">${money((Number(i.price) || 0) * (Number(i.qty) || 0))}</span>
        </div>`).join('') + `
        <div class="bill-total"><span>Итого</span><span>${money(total)}</span></div>
        ${bonus >= 1 ? `<div class="small" style="color:var(--gold);margin-top:10px">
          Доступно бонусов: ${money(bonus)} — скажите кальянщику, чтобы списать при оплате</div>` : ''}
      ` : `<p class="muted small" style="margin:0">Пока пусто — закажите в разделе «Меню»</p>`}
    </div>

    <div id="orders"></div>
  `;

  const plannedEnd = toDate(s.plannedEnd);
  const tick = () => {
    const box = $('timer');
    if (!box || !plannedEnd) return;
    const left = plannedEnd - new Date();
    const over = left < 0;
    const abs = Math.abs(left);
    const mins = Math.floor(abs / 60000);
    const secs = Math.floor((abs % 60000) / 1000);
    box.className = 'card timer ' + (over ? 'over' : mins <= 15 ? 'soon' : 'ok');
    box.innerHTML = `
      <div class="muted small">${over ? 'Сеанс завершён' : 'До конца сеанса'}</div>
      <div class="value">${mins}:${pad(secs)}</div>
      ${Number(s.refillCount) > 0 ? `<div class="small muted">Перезабивок: ${s.refillCount}</div>` : ''}`;
  };
  tick();
  state.ticker = setInterval(tick, 1000);

  $('unbind').onclick = unbind;
  screenEl().querySelectorAll('[data-call]').forEach((el) => {
    el.onclick = () => callStaff(el.dataset.call, s, el);
  });

  watchCalls();
  watchOrders(s.id);
}

const CALL_LABELS = {
  coal: 'Поменять угли',
  refill: 'Перезабивка',
  waiter: 'Позвать кальянщика',
  bill: 'Счёт, пожалуйста',
};

async function callStaff(type, s, btn) {
  const label = CALL_LABELS[type] || 'Вызов';
  // Не ждём ответа сервера: запись уходит сразу, а гость видит отклик
  // мгновенно. Иначе на слабой связи кнопка «висит», и её жмут повторно.
  addDoc(collection(state.db, 'waiterCalls'), {
    tableId: s.tableId || '',
    tableName: s.tableName || '',
    sessionId: s.id,
    clientUid: state.uid,
    guestName: (state.profile || {}).name || '',
    type,
    comment: '',
    status: 'new',
    createdAt: Timestamp.fromDate(new Date()),
  }).catch(() => toast('Не удалось передать вызов'));

  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = 'Передано';
  toast(`${label} — передали кальянщику`);
  // Через минуту разрешаем позвать снова: кальянщик мог не услышать.
  setTimeout(() => { btn.disabled = false; btn.innerHTML = original; }, 60000);
}

function watchCalls() {
  sub(onSnapshot(
    query(collection(state.db, 'waiterCalls'), where('clientUid', '==', state.uid)),
    (snap) => {
      const box = $('calls');
      if (!box) return;
      const fresh = Date.now() - 30 * 60 * 1000;
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((c) => c.status === 'new')
        .filter((c) => { const t = toDate(c.createdAt); return t && t.getTime() > fresh; })
        .sort((a, b) => toDate(b.createdAt) - toDate(a.createdAt))
        .slice(0, 4);
      box.innerHTML = list.map((c) => {
        const t = toDate(c.createdAt);
        return `<div class="row small muted" style="margin-top:8px">
          <span style="color:var(--primary)">✓</span>
          <span>${esc(CALL_LABELS[c.type] || 'Вызов')} — передали в ${t ? hhmm(t) : ''}</span>
        </div>`;
      }).join('');
    }, () => {}));
}

function watchOrders(sessionId) {
  sub(onSnapshot(
    query(collection(state.db, 'guestOrders'), where('clientUid', '==', state.uid)),
    (snap) => {
      const box = $('orders');
      if (!box) return;
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((o) => o.sessionId === sessionId)
        .sort((a, b) => toDate(b.createdAt) - toDate(a.createdAt));
      if (!list.length) { box.innerHTML = ''; return; }

      const label = (st) => ({
        new: 'Ждёт подтверждения',
        preparing: 'Готовится',
        ready: 'Готов',
        rejected: 'Отклонён',
      }[st] || st);

      box.innerHTML = `<h2>Заказы из приложения</h2>` + list.map((o) => `
        <div class="card">
          <div class="row">
            <div class="grow">
              <div>${(o.items || []).map((i) => esc(i.name) + '×' + (i.qty || 1)).join(', ')}</div>
              <div class="small muted">${esc(label(o.status))}${o.rejectReason ? ' · ' + esc(o.rejectReason) : ''}</div>
            </div>
          </div>
        </div>`).join('');
    }, () => {}));
}

async function unbind() {
  const p = state.profile || {};
  const sid = p.activeSessionId;
  // Именно удаление, а не «обнулить uid»: правила разрешают владельцу
  // удалить свою метку, но не переписать её на чужой (иначе чек можно
  // было бы увести). Пустой uid — тоже чужой.
  try { if (sid) await deleteDoc(doc(state.db, 'sessionClaims', sid)); } catch (_) {}
  try {
    await setDoc(doc(state.db, 'clients', state.uid), {
      activeSessionId: '', activeTableId: '',
    }, { merge: true });
  } catch (_) {}
  toast('Стол отвязан');
  route();
}

function tableFinished(s) {
  clearScreen();
  const items = s.orderItems || [];
  const total = items.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
  screenEl().innerHTML = `
    <h1>Спасибо за визит!</h1>
    <p class="muted">Счёт за столом ${esc(s.tableName || '')} закрыт на ${money(total)}.</p>
    <h2>Как всё прошло?</h2>
    <div class="card">
      <div class="center" id="stars" style="font-size:30px;letter-spacing:6px">
        ${[1, 2, 3, 4, 5].map((i) => `<span data-star="${i}" style="cursor:pointer">☆</span>`).join('')}
      </div>
      <textarea id="reviewText" rows="3" placeholder="Что понравилось, что нет (необязательно)" style="margin-top:14px"></textarea>
      <button class="btn-primary" id="sendReview" disabled>Отправить отзыв</button>
    </div>`;

  let rating = 0;
  const paint = () => {
    screenEl().querySelectorAll('[data-star]').forEach((el) => {
      el.textContent = Number(el.dataset.star) <= rating ? '★' : '☆';
      el.style.color = Number(el.dataset.star) <= rating ? 'var(--gold)' : 'var(--muted)';
    });
    $('sendReview').disabled = rating === 0;
  };
  screenEl().querySelectorAll('[data-star]').forEach((el) => {
    el.onclick = () => { rating = Number(el.dataset.star); paint(); };
  });
  paint();

  $('sendReview').onclick = async () => {
    $('sendReview').disabled = true;
    try {
      await addDoc(collection(state.db, 'reviews'), {
        sessionId: s.id,
        clientUid: state.uid,
        guestName: (state.profile || {}).name || '',
        rating,
        text: $('reviewText').value.trim(),
        aiSummary: '',
        createdAt: Timestamp.fromDate(new Date()),
      });
      await unbind();
      toast('Спасибо! Ваш отзыв важен для нас');
    } catch (_) {
      toast('Не удалось отправить отзыв');
      $('sendReview').disabled = false;
    }
  };
}

// ---------- БРОНЬ ----------
//
// Экран повторяет тот, что в приложении: день, число гостей,
// продолжительность и — главное — СЕТКА СВОБОДНОГО ВРЕМЕНИ. Свободное
// время считается из часов работы заведения и занятости столов, поэтому
// забронировать в нерабочий час нельзя в принципе: такого времени просто
// нет в списке. Раньше здесь стояло обычное поле «Время», и гость мог
// выбрать хоть 4 утра.

const DURATIONS = [60, 90, 180, 270];
const GUEST_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10];

function durationLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} ч` : `${h} ч ${m} м`;
}

const WEEKDAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

/// Часы работы на день недели. В базе они лежат под номером дня так же,
/// как их понимает приложение: 1 — понедельник, 7 — воскресенье.
function workingWindow(day) {
  const hours = (state.venue && state.venue.workingHours) || {};
  const dartWeekday = day.getDay() === 0 ? 7 : day.getDay();
  const raw = String(hours[dartWeekday] || hours[String(dartWeekday)] || '').trim();
  if (!raw) return null;

  const m = raw.match(/(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/);
  if (!m) return null;

  const open = new Date(day.getFullYear(), day.getMonth(), day.getDate(),
    Number(m[1]), Number(m[2]), 0, 0);
  let close = new Date(day.getFullYear(), day.getMonth(), day.getDate(),
    Number(m[3]), Number(m[4]), 0, 0);
  // Закрытие «раньше» открытия означает следующие сутки: 16:00–02:00.
  if (close <= open) close = new Date(close.getTime() + 24 * 60 * 60 * 1000);
  return { open, close, raw };
}

function screenBooking() {
  const p = state.profile || {};

  if (!bookingDraft.date) {
    const today = new Date();
    bookingDraft.date = localDate(today);
  }
  if (!bookingDraft.duration) bookingDraft.duration = 90;

  const day = dayFromDraft();
  const window = workingWindow(day);
  const todayHours = workingWindow(new Date());

  screenEl().innerHTML = `
    <h1>Бронь стола</h1>
    ${todayHours
      ? `<p class="small" style="color:var(--gold);margin-bottom:16px">Работаем ${esc(todayHours.raw)}</p>`
      : `<p class="small muted">Часы работы не заданы — уточните у кальянщика.</p>`}

    <h2 style="margin-top:0">Дата</h2>
    <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;-webkit-overflow-scrolling:touch">
      ${dateOptions().map((d) => {
        const key = localDate(d);
        const on = key === bookingDraft.date;
        return `<button class="daychip ${on ? 'on' : ''}" data-day="${key}">
          <small>${WEEKDAYS_SHORT[d.getDay()]}</small>${d.getDate()}</button>`;
      }).join('')}
    </div>

    <h2>Гостей</h2>
    <div>${GUEST_OPTIONS.map((n) => `
      <span class="chip ${n === bookingGuests() ? 'on' : ''}" data-guests="${n}">${n}</span>
    `).join('')}</div>

    <h2>Продолжительность</h2>
    <div>${DURATIONS.map((mn) => `
      <span class="chip ${mn === bookingDraft.duration ? 'on' : ''}" data-dur="${mn}">${durationLabel(mn)}</span>
    `).join('')}</div>

    <h2>Свободное время</h2>
    <div id="slots">${window ? '<div class="spinner"></div>'
      : '<p class="muted small">В этот день мы закрыты — выберите другую дату.</p>'}</div>

    <h2>Контакты</h2>
    <div class="card">
      <label class="field"><span>Ваше имя</span>
        <input id="bName" value="${esc(p.name || '')}" placeholder="Как к вам обращаться"></label>
      <label class="field"><span>Телефон</span>
        <input id="bPhone" type="tel" inputmode="tel"
          value="${esc(p.phone ? prettyPhone(p.phone) : '')}"
          placeholder="+7 999 123-45-67" ${p.phone ? 'readonly' : ''}></label>
      <p class="small muted" style="margin:-4px 0 12px">
        ${p.phone
          ? '🔒 Номер привязан — сменить его можно только через администратора'
          : 'Укажите номер в любом формате: +7, 8 или просто 9…'}</p>

      <label class="field"><span>Стол</span></label>
      <div class="row" style="margin:-6px 0 12px">
        <div class="grow small ${pickedTable ? '' : 'muted'}">
          ${pickedTable ? '🪑 ' + esc(pickedTable.name) : 'Любой свободный — подберём сами'}
        </div>
        <a class="btn-link" href="#/hall/pick" style="width:auto">
          ${pickedTable ? 'Изменить' : 'Выбрать на карте'}</a>
      </div>
      ${pickedTable ? `<button class="btn-ghost" id="bClearTable"
        style="margin-bottom:12px">Убрать выбор стола</button>` : ''}

      <label class="field"><span>Пожелания (необязательно)</span>
        <input id="bComment" placeholder="Диван у окна, день рождения, без музыки…"></label>
      <button class="btn-primary" id="bSend">Отправить заявку</button>
      <p class="small muted center" style="margin:12px 0 0">
        Мы подтвердим бронь и закрепим стол. За 20 минут до начала напомним.</p>
    </div>

    <div id="soon"></div>

    <h2>Мои брони</h2>
    <div id="myBookings"><div class="spinner"></div></div>`;

  screenEl().querySelectorAll('[data-day]').forEach((el) => {
    el.onclick = () => { bookingDraft.date = el.dataset.day; resetSlot(); route(); };
  });
  screenEl().querySelectorAll('[data-guests]').forEach((el) => {
    el.onclick = () => { bookingDraft.guests = Number(el.dataset.guests); resetSlot(); route(); };
  });
  screenEl().querySelectorAll('[data-dur]').forEach((el) => {
    el.onclick = () => { bookingDraft.duration = Number(el.dataset.dur); resetSlot(); route(); };
  });
  const clear = $('bClearTable');
  if (clear) clear.onclick = () => { pickedTable = null; route(); };

  $('bSend').onclick = sendBooking;
  if (window) loadSlots(day, window);
  renderBookingSoon('soon');
  watchMyBookings();
}

/// Смена дня, компании или длительности обнуляет выбор: прежние время и
/// стол к новым условиям уже не относятся.
function resetSlot() {
  bookingDraft.time = '';
  pickedTable = null;
}

/// Дата в местном виде ГГГГ-ММ-ДД. Через toISOString нельзя: он переводит
/// в UTC, и поздним вечером выбранный день «уезжал» на следующий.
function localDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateOptions() {
  const out = [];
  const base = new Date();
  for (let i = 0; i < 14; i++) {
    out.push(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i));
  }
  return out;
}

function dayFromDraft() {
  const [y, m, d] = String(bookingDraft.date).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/// Считает свободное время так же, как приложение.
///
/// Слот годится, если: заведение в это время работает, бронь успевает
/// закончиться до закрытия, до начала осталось хотя бы 15 минут и есть
/// хотя бы один подходящий свободный стол.
async function loadSlots(day, window) {
  const box = $('slots');
  if (!box) return;

  let tables = [];
  let slots = [];
  try {
    const from = new Date(window.open.getTime() - 14 * 60 * 60 * 1000);
    const to = new Date(window.open.getTime() + 26 * 60 * 60 * 1000);
    const [tSnap, sSnap] = await Promise.all([
      getDocs(collection(state.db, 'tables')),
      getDocs(query(collection(state.db, 'reservationSlots'),
        where('startTime', '>=', Timestamp.fromDate(from)),
        where('startTime', '<', Timestamp.fromDate(to)))),
    ]);
    tables = tSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    slots = sSnap.docs.map((d) => d.data()).filter((v) => v.active !== false);
  } catch (_) {
    box.innerHTML = `<p class="muted small">Не удалось загрузить свободное время.</p>`;
    return;
  }

  const duration = bookingDraft.duration || 90;
  const guests = bookingGuests();
  // Запас на подготовку стола: 15 минут, как в приложении.
  const earliest = new Date(Date.now() + 15 * 60 * 1000);
  const lastStart = new Date(window.close.getTime() - duration * 60 * 1000);

  const free = [];
  for (let cur = new Date(window.open); cur <= lastStart;
       cur = new Date(cur.getTime() + 30 * 60 * 1000)) {
    if (cur <= earliest) continue;
    const end = new Date(cur.getTime() + duration * 60 * 1000);

    const busy = new Set();
    slots.forEach((v) => {
      const s = toDate(v.startTime);
      const e = toDate(v.endTime);
      if (s && e && v.tableId && s < end && e > cur) busy.add(v.tableId);
    });

    const ok = tables.some((t) => {
      if ((Number(t.seats) || 0) < guests) return false;
      if (busy.has(t.id)) return false;
      const until = toDate(t.busyUntil);
      if (until && cur < until) return false;
      return true;
    });
    if (ok) free.push(new Date(cur));
  }

  if (!free.length) {
    box.innerHTML = `<p class="muted small">На выбранные день и условия
      свободного времени нет. Попробуйте другую дату, другую длительность
      или меньшую компанию.</p>`;
    return;
  }

  box.innerHTML = `<div>${free.map((t) => {
    const key = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    return `<span class="chip ${key === bookingDraft.time ? 'on' : ''}"
      data-slot="${key}">${key}</span>`;
  }).join('')}</div>`;

  box.querySelectorAll('[data-slot]').forEach((el) => {
    el.onclick = () => {
      bookingDraft.time = el.dataset.slot;
      pickedTable = null; // стол выбирается уже под конкретное время
      route();
    };
  });
}

const STATUS_LABEL = {
  new: 'Ждёт подтверждения',
  confirmed: 'Подтверждена',
  seated: 'Вы за столом',
  cancelled: 'Отменена',
  no_show: 'Снята — вас не дождались',
};

async function sendBooking() {
  const name = $('bName').value.trim();
  const locked = !!((state.profile || {}).phone);
  const phone = locked
    ? (state.profile.phone || '')
    : normalizePhone($('bPhone').value.trim());
  const guests = bookingGuests();
  const comment = $('bComment').value.trim();
  const duration = bookingDraft.duration || 90;

  if (!name) return toast('Укажите имя');
  if (!isValidRuPhone(phone)) return toast('Проверьте номер телефона');
  if (!bookingDraft.time) return toast('Выберите время из списка свободного');

  const start = bookingStart();
  if (!start) return toast('Выберите дату и время');
  if (start < new Date()) return toast('Это время уже прошло');

  // Страховка на случай, если гость выбрал время, а потом сменил день:
  // бронировать в нерабочий час нельзя, даже если слот остался на экране.
  const win = workingWindow(dayFromDraft());
  const end = new Date(start.getTime() + duration * 60 * 1000);
  if (!win || start < win.open || end > win.close) {
    return toast('В это время мы закрыты — выберите время из списка');
  }

  $('bSend').disabled = true;
  try {
    const ref = await addDoc(collection(state.db, 'reservations'), {
      clientUid: state.uid,
      guestName: name,
      phone,
      guestsCount: guests,
      tableId: (pickedTable && pickedTable.id) || '',
      tableName: (pickedTable && pickedTable.name) || '',
      startTime: Timestamp.fromDate(start),
      durationMinutes: duration,
      status: 'new',
      comment,
      source: 'kolibri',
      preOrder: [],
      aiNote: '',
      sessionId: '',
      guestConfirmed: false,
      createdAt: Timestamp.fromDate(new Date()),
    });
    // Обезличенное зеркало занятости стола. Нужно, чтобы следующий гость
    // сразу увидел стол занятым на это время: сами брони ему читать
    // нельзя — там чужие имена и телефоны. Приложение на Android пишет
    // его так же, тем же id, что у брони.
    if (pickedTable && pickedTable.id) {
      try {
        await setDoc(doc(state.db, 'reservationSlots', ref.id), {
          tableId: pickedTable.id,
          clientUid: state.uid,
          startTime: Timestamp.fromDate(start),
          endTime: Timestamp.fromDate(end),
          active: true,
        }, { merge: true });
      } catch (_) {
        // Зеркало вторично: сама бронь создана и видна кассе.
      }
    }

    // Имя и телефон пригодятся в следующий раз — сохраняем в профиль.
    // Телефон меняется только если его ещё не задавали: к нему привязаны
    // бонусы, и правила базы менять его гостю не дают.
    const patch = { name };
    if (!(state.profile || {}).phone) patch.phone = phone;
    await setDoc(doc(state.db, 'clients', state.uid), patch, { merge: true });
    pickedTable = null;
    bookingDraft.time = '';
    toast('Заявка отправлена — скоро подтвердим');
  } catch (e) {
    toast('Не удалось отправить заявку');
  }
  const btn = $('bSend');
  if (btn) btn.disabled = false;
}

function watchMyBookings() {
  sub(onSnapshot(
    query(collection(state.db, 'reservations'), where('clientUid', '==', state.uid)),
    (snap) => {
      const box = $('myBookings');
      if (!box) return;
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => toDate(b.startTime) - toDate(a.startTime))
        .slice(0, 10);
      if (!list.length) {
        box.innerHTML = `<p class="muted small">Броней пока нет.</p>`;
        return;
      }
      box.innerHTML = list.map((r) => {
        const t = toDate(r.startTime);
        const active = r.status === 'new' || r.status === 'confirmed';
        return `
          <div class="card">
            <div class="row">
              <div class="grow">
                <div style="font-weight:600">${t ? dmy(t) + ' в ' + hhmm(t) : ''}
                  ${r.tableName ? '· стол ' + esc(r.tableName) : ''}</div>
                <div class="small muted">${r.guestsCount || 2} чел. ·
                  ${esc(STATUS_LABEL[r.status] || r.status)}${r.guestConfirmed ? ' · вы подтвердили' : ''}</div>
              </div>
            </div>
            ${active ? `
              <div class="btn-row" style="margin-top:12px">
                ${r.status === 'confirmed' && !r.guestConfirmed
                  ? `<button class="btn-ghost" data-come="${esc(r.id)}">Приду</button>` : '<span></span>'}
                <button class="btn-danger" data-cancel="${esc(r.id)}">Отменить</button>
              </div>` : ''}
          </div>`;
      }).join('');

      box.querySelectorAll('[data-cancel]').forEach((el) => {
        el.onclick = async () => {
          el.disabled = true;
          try {
            await updateDoc(doc(state.db, 'reservations', el.dataset.cancel), { status: 'cancelled' });
            // Снимаем занятость стола: иначе отменённая бронь продолжала
            // бы держать его в карте зала у других гостей.
            try {
              await setDoc(doc(state.db, 'reservationSlots', el.dataset.cancel),
                { active: false, clientUid: state.uid }, { merge: true });
            } catch (_) {}
            toast('Бронь отменена');
          } catch (_) { toast('Не удалось отменить'); el.disabled = false; }
        };
      });
      box.querySelectorAll('[data-come]').forEach((el) => {
        el.onclick = async () => {
          el.disabled = true;
          try {
            await updateDoc(doc(state.db, 'reservations', el.dataset.come), { guestConfirmed: true });
            toast('Спасибо, ждём вас');
          } catch (_) { toast('Не удалось отметить'); el.disabled = false; }
        };
      });
    }, () => {}));
}

/// Приводит любой российский номер к единому виду без «+»: 79995061580.
/// Правила те же, что в приложении (lib/utils/phone_utils.dart):
///   +7 999 506-15-80 · 7(999)506-15-80 · 8 999 506 15 80 · 9995061580
function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return String(raw || '').trim();
  if (d.length === 11) return d[0] === '8' ? '7' + d.slice(1) : d;
  if (d.length === 10 && d[0] === '9') return '7' + d;
  return d;
}

/// Похоже ли на российский номер: 11 цифр, начиная с 7.
function isValidRuPhone(normalized) {
  return normalized.length === 11 && normalized[0] === '7';
}
function prettyPhone(d) {
  if (!d || d.length !== 11) return d || '';
  return `+${d[0]} (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
}

/// Плашка «Бронь скоро — придёте?».
///
/// В вебе она особенно важна: браузер не умеет показывать уведомления по
/// расписанию, как приложение, поэтому спросить гостя можно только когда
/// он сам открыл страницу. Ответ «Не приду» сразу отменяет бронь —
/// заведение узнаёт о неявке заранее и успевает отдать стол.
function renderBookingSoon(boxId) {
  sub(onSnapshot(
    query(collection(state.db, 'reservations'), where('clientUid', '==', state.uid)),
    (snap) => {
      const box = $(boxId);
      if (!box) return;
      const now = Date.now();
      const soon = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => {
        if (r.guestConfirmed) return false;
        if (r.status !== 'new' && r.status !== 'confirmed') return false;
        const t = toDate(r.startTime);
        if (!t) return false;
        const left = (t.getTime() - now) / 60000;
        // Полчаса до начала и не больше десяти минут после: опоздавшего
        // тоже стоит спросить, ждать ли его.
        return left <= 30 && left >= -10;
      }).sort((a, b) => toDate(a.startTime) - toDate(b.startTime));

      if (!soon.length) { box.innerHTML = ''; return; }
      const r = soon[0];
      const t = toDate(r.startTime);
      const left = Math.round((t.getTime() - now) / 60000);

      box.innerHTML = `
        <div class="card" style="border-color:var(--gold)">
          <div class="row">
            <span style="color:var(--gold)">📅</span>
            <div class="grow" style="font-weight:700">
              ${left > 0 ? `Бронь через ${left} ${minutesWord(left)}` : 'Ваша бронь уже началась'}
            </div>
          </div>
          <div class="small muted" style="margin-top:6px">
            ${hhmm(t)}${r.tableName ? ', стол ' + esc(r.tableName) : ''} ·
            ${r.guestsCount || 2} чел. Подтвердите, что придёте, — или освободите
            стол для других.
          </div>
          <div class="btn-row" style="margin-top:14px">
            <button class="btn-primary" data-come="${esc(r.id)}">Приду</button>
            <button class="btn-ghost" data-nocome="${esc(r.id)}">Не приду</button>
          </div>
        </div>`;

      box.querySelector('[data-come]').onclick = async (e) => {
        e.target.disabled = true;
        try {
          await updateDoc(doc(state.db, 'reservations', r.id), { guestConfirmed: true });
          toast('Спасибо, ждём вас');
        } catch (_) { toast('Не удалось отметить'); e.target.disabled = false; }
      };
      box.querySelector('[data-nocome]').onclick = async (e) => {
        e.target.disabled = true;
        try {
          await updateDoc(doc(state.db, 'reservations', r.id), { status: 'cancelled' });
          try {
            await setDoc(doc(state.db, 'reservationSlots', r.id),
              { active: false, clientUid: state.uid }, { merge: true });
          } catch (_) {}
          toast('Бронь отменена. Спасибо, что предупредили');
        } catch (_) { toast('Не удалось отменить'); e.target.disabled = false; }
      };
    }, () => {}));
}

/// «через 1 минуту», «через 2 минуты», «через 25 минут».
function minutesWord(n) {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return 'минуту';
  if (!teen && last >= 2 && last <= 4) return 'минуты';
  return 'минут';
}

// ---------- ПРОФИЛЬ ----------

function screenProfile() {
  const p = state.profile || {};
  const spent = Number(p.totalSpent) || 0;
  const tier = tierOf(spent);
  const next = nextTier(spent);

  screenEl().innerHTML = `
    <h1>Профиль</h1>

    <div class="card tier">
      <div class="muted small">Уровень «${esc(tier.name)}»</div>
      <div class="bonus">${money(p.bonusBalance)}</div>
      <div class="small muted">кешбэк ${tier.cashback}% · визитов: ${Number(p.visits) || 0}</div>
      ${next ? `
        <div class="bar"><i style="width:${progressPercent(spent)}%"></i></div>
        <div class="small muted">До «${esc(next.name)}» — ${money(next.from - spent)}</div>
      ` : ''}
    </div>

    <div class="card">
      <label class="field"><span>Имя</span>
        <input id="pName" value="${esc(p.name || '')}" placeholder="Как к вам обращаться"></label>
      <label class="field"><span>Телефон</span>
        <input id="pPhone" type="tel" inputmode="tel"
          value="${esc(p.phone ? prettyPhone(p.phone) : '')}"
          placeholder="+7 999 123-45-67" ${p.phone ? 'readonly' : ''}></label>
      <p class="small muted" style="margin:-4px 0 12px">
        ${p.phone
          ? '🔒 Сменить номер можно только через администратора'
          : 'Укажите номер в любом формате: +7, 8 или просто 9…'}</p>
      <button class="btn-primary" id="pSave">Сохранить</button>
    </div>

    <div class="card" style="border-color:rgba(217,180,91,.45)">
      <div class="row" style="align-items:flex-start">
        <span style="color:var(--gold)">ⓘ</span>
        <div class="grow small muted">
          Бонусы копятся на этом устройстве и находятся по вашему номеру на
          кассе. Сменили телефон — назовите номер и покажите ID устройства
          ниже кальянщику, и мы перенесём историю визитов.
        </div>
      </div>
      <div id="deviceId" style="margin-top:12px;background:rgba(0,0,0,.25);
        border-radius:10px;padding:11px 12px;display:flex;align-items:center;
        gap:8px;cursor:pointer">
        <span class="muted">🪪</span>
        <span class="grow" style="font-weight:700;letter-spacing:2px;color:var(--muted)">
          ID устройства: ${esc(shortDeviceId())}</span>
        <span class="muted small">копировать</span>
      </div>
    </div>

    <h2>История визитов</h2>
    <div id="visits"><div class="spinner"></div></div>

    <p class="small muted center" style="margin-top:28px">
      Colibri Lounge · веб-версия</p>`;

  $('pSave').onclick = saveProfile;
  if ((state.profile || {}).phone) {
    $('pPhone').onclick = () => toast('Номер уже привязан. Попросите '
      + 'администратора изменить его на кассе.');
  }
  const idBox = $('deviceId');
  if (idBox) {
    idBox.onclick = async () => {
      try {
        await navigator.clipboard.writeText(shortDeviceId());
        toast('ID устройства скопирован');
      } catch (_) {
        toast('ID устройства: ' + shortDeviceId());
      }
    };
  }
  watchVisits();
}

async function saveProfile() {
  const btn = $('pSave');
  const locked = !!((state.profile || {}).phone);
  const raw = $('pPhone').value.trim();
  const phone = raw ? normalizePhone(raw) : '';

  btn.disabled = true;
  btn.textContent = 'Сохраняем…';

  // Как и в приложении: что бы ни случилось внутри, кнопка обязана
  // вернуться в рабочее состояние. Иначе она навсегда застревает на
  // «Сохраняем…», не показывая причины.
  try {
    // Номер новый — сначала проверяем, не занят ли он другим гостем.
    if (!locked && phone) {
      if (!isValidRuPhone(phone)) {
        toast('Введите корректный номер (например, 79995061580)');
        return;
      }
      let takenByOther = false;
      try {
        const idx = await getDoc(doc(state.db, 'phoneIndex', phone));
        const owner = idx.exists() ? (idx.data().uid || '') : '';
        takenByOther = !!owner && owner !== state.uid;
      } catch (_) {}

      if (takenByOther) {
        // Про чужой профиль не рассказываем ничего — ни имени, ни
        // баланса: иначе бонусный счёт любого человека мог бы увидеть
        // тот, кто угадал его номер телефона.
        alert('Номер уже зарегистрирован\n\n'
          + 'На этот номер уже есть профиль. Чтобы его бонусы и история '
          + 'появились на этом устройстве, назовите кальянщику номер и '
          + '«ID устройства» ниже — он объединит профили на кассе за пару '
          + 'секунд.');
        return;
      }
    }

    const patch = { name: $('pName').value.trim() };
    if (!locked && phone) {
      patch.phone = phone;
      // Указатель «номер → гость»: вторичен, поэтому его осечка не должна
      // мешать сохранению самого профиля.
      try { await setDoc(doc(state.db, 'phoneIndex', phone), { uid: state.uid }); } catch (_) {}
    }
    await setDoc(doc(state.db, 'clients', state.uid), patch, { merge: true });
    toast('Сохранено');
  } catch (_) {
    toast('Не удалось сохранить: проверьте интернет и попробуйте снова');
  } finally {
    const b = $('pSave');
    if (b) { b.disabled = false; b.textContent = 'Сохранить'; }
  }
}

function watchVisits() {
  sub(onSnapshot(
    query(collection(state.db, 'clients', state.uid, 'visits'), orderBy('date', 'desc'), limit(50)),
    (snap) => {
      const box = $('visits');
      if (!box) return;
      if (snap.empty) {
        box.innerHTML = `<p class="muted small">Визитов пока нет. После первого
          посещения здесь появится история — она хранится всегда.</p>`;
        return;
      }
      box.innerHTML = snap.docs.map((d) => {
        const v = d.data();
        const date = toDate(v.date);
        const items = (v.items || []).map((i) => `${i.name} ×${i.qty}`).join(', ');
        return `
          <div class="card">
            <div class="row">
              <div class="grow">
                <div style="font-weight:600">${date ? dmy(date) + ' в ' + hhmm(date) : ''}
                  ${v.tableName ? '· стол ' + esc(v.tableName) : ''}</div>
                ${items ? `<div class="small muted ellipsis">${esc(items)}</div>` : ''}
              </div>
              <div style="text-align:right">
                <div style="font-weight:600">${money(v.total)}</div>
                ${Number(v.bonusEarned) > 0
                  ? `<div class="small" style="color:var(--gold)">+${money(v.bonusEarned)}</div>` : ''}
              </div>
            </div>
          </div>`;
      }).join('');
    }, () => {
      const box = $('visits');
      if (box) box.innerHTML = `<p class="muted small">Не удалось загрузить историю.</p>`;
    }));
}

// ---------- СКАНЕР QR ----------
//
// Камера телефона и так открывает ссылку со стола сама — но гость,
// который уже сидит в приложении, ждёт кнопку внутри него, а не «выйдите
// и наведите камеру». Здесь она и есть.
//
// Safari на iPhone не умеет встроенный разбор кодов (BarcodeDetector),
// поэтому там подключается разбор на JavaScript. На Android и в Chrome
// используется встроенный — он быстрее и не тянет ничего лишнего.

let scanStream = null;
let scanRaf = null;

function screenScan() {
  screenEl().innerHTML = `
    <h1>Сканировать QR стола</h1>
    <p class="muted small">Наведите камеру на код, наклеенный на вашем столе.</p>
    <div class="card" style="padding:0;overflow:hidden">
      <video id="cam" playsinline muted autoplay
        style="width:100%;display:block;background:#000;aspect-ratio:1/1;object-fit:cover"></video>
    </div>
    <div id="scanHint" class="small muted center">Запрашиваем доступ к камере…</div>
    <div style="height:14px"></div>
    <a class="btn btn-ghost" href="#/table">Отмена</a>`;

  startScanner();
  // Экран уходит — камеру обязательно гасим, иначе индикатор горит и
  // батарея тает, даже когда гость давно на другой вкладке.
  sub(stopScanner);
}

async function startScanner() {
  const video = $('cam');
  const hint = $('scanHint');
  if (!video) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    hint.textContent = 'Этот браузер не умеет работать с камерой. '
      + 'Отсканируйте код обычной камерой телефона — она откроет стол сама.';
    return;
  }

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (e) {
    hint.innerHTML = 'Нет доступа к камере. Разрешите его в настройках '
      + 'браузера — или просто отсканируйте код обычной камерой телефона, '
      + 'она откроет стол сама.';
    return;
  }

  // Пока браузер спрашивал разрешение, гость мог уйти с экрана. Если так
  // — камеру сразу гасим: иначе индикатор горит, а поток живёт впустую.
  if (!location.hash.startsWith('#/scan')) return stopScanner();

  video.srcObject = scanStream;
  try { await video.play(); } catch (_) {}
  hint.textContent = 'Наведите на код…';

  const detector = ('BarcodeDetector' in window)
    ? new window.BarcodeDetector({ formats: ['qr_code'] })
    : null;

  let jsQR = null;
  if (!detector) {
    try {
      // Safari своего разбора не имеет — подключаем библиотеку.
      await loadScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js');
      jsQR = window.jsQR;
    } catch (_) {
      hint.textContent = 'Не удалось загрузить распознавание кода. '
        + 'Отсканируйте код обычной камерой телефона.';
      return;
    }
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let done = false;

  const tick = async () => {
    if (done || !scanStream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      let raw = null;
      try {
        if (detector) {
          const found = await detector.detect(video);
          if (found && found.length) raw = found[0].rawValue;
        } else {
          // Кадр меньше исходного: для кода этого хватает, а работы
          // телефону заметно меньше.
          const w = 420;
          const scale = w / video.videoWidth;
          canvas.width = w;
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (res) raw = res.data;
        }
      } catch (_) {}

      if (raw) {
        const tableId = tableIdFrom(raw);
        if (tableId) {
          done = true;
          stopScanner();
          location.hash = '#/t/' + encodeURIComponent(tableId);
          return;
        }
        hint.textContent = 'Это не код стола — наведите на код на столе.';
      }
    }
    scanRaf = requestAnimationFrame(tick);
  };
  scanRaf = requestAnimationFrame(tick);
}

function stopScanner() {
  if (scanRaf) { cancelAnimationFrame(scanRaf); scanRaf = null; }
  if (scanStream) {
    scanStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    scanStream = null;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('не загрузилось'));
    document.head.appendChild(el);
  });
}

/// Достаёт номер стола из чего угодно, что может оказаться в коде.
///
/// Коды печатались в разное время и в разных форматах: сначала
/// kolibri://table/5, потом https://colibri-lounge.web.app/table/5.
/// Понимаем оба, адрес веб-версии и просто номер — перепечатывать
/// наклейки из-за формата не придётся никогда.
function tableIdFrom(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;

  const m = v.match(/[#/]t\/([^/?#\s]+)/) || v.match(/\/table\/([^/?#\s]+)/);
  if (m) return decodeURIComponent(m[1]);

  const scheme = v.match(/^kolibri:\/\/table\/([^/?#\s]+)/i);
  if (scheme) return decodeURIComponent(scheme[1]);

  const param = v.match(/[?&]table=([^&\s]+)/);
  if (param) return decodeURIComponent(param[1]);

  // «Голый» номер стола — тоже допустим.
  if (/^[A-Za-z0-9_-]{1,40}$/.test(v)) return v;
  return null;
}

// ---------- КАРТА ЗАЛА ----------
//
// Та же схема столов, что видит кальянщик на кассе, в реальном времени.
//
// Открыть чужой счёт отсюда нельзя намеренно: сесть за стол можно только
// отсканировав код, физически наклеенный на этом столе. Иначе счёт можно
// было бы «занять» удалённо, не приходя в заведение.

/// Стол, выбранный для брони. Живёт между экранами: гость уходит на карту
/// и возвращается в форму брони, где выбор должен сохраниться.
let pickedTable = null;

function screenHall(pickMode) {
  screenEl().innerHTML = `
    <h1>${pickMode ? 'Выберите стол' : 'Карта зала'}</h1>
    <p class="muted small">${pickMode
      ? 'Серым отмечены столы, которых не хватит на вашу компанию, красным — занятые на выбранное время.'
      : 'Занятость столов обновляется в реальном времени.'}</p>
    <div class="hall" id="hall"><div class="spinner"></div></div>
    <div class="legend">
      <span><i style="background:#3F9D5B"></i> свободен</span>
      <span><i style="background:#C24A4A"></i> занят</span>
    </div>
    <div style="height:16px"></div>
    <a class="btn btn-ghost" href="${pickMode ? '#/booking' : '#/table'}">${pickMode ? 'Отмена' : 'Назад'}</a>`;

  // Занятость по броням на выбранное время — только в режиме выбора.
  let busyByBooking = new Set();
  const when = pickMode ? bookingStart() : null;
  const durMs = (bookingDraft.duration || 90) * 60 * 1000;

  const draw = (tables) => {
    const box = $('hall');
    if (!box) return;
    if (!tables.length) {
      box.innerHTML = `<p class="muted small" style="padding:20px">Карта зала пока не настроена.</p>`;
      return;
    }
    box.innerHTML = tables.map((t) => {
      const occupied = (t.activeSessionIds || []).length > 0 || t.status === 'occupied';
      const bookedNow = busyByBooking.has(t.id);
      const tooSmall = pickMode && bookingGuests() > (Number(t.seats) || 0);
      const cls = tooSmall ? 'small' : (occupied || bookedNow) ? 'busy' : 'free';
      const canPick = pickMode && cls === 'free';
      // Координаты 0..1 — те же, что расставил администратор на кассе.
      // Раскладываем их в «от края до края минус ширина плитки»: иначе
      // стол с координатой 0 или 1 наполовину уезжал за границу карты, и
      // на узких экранах подписи обрезались.
      const x = Math.max(0, Math.min(1, Number(t.x) || 0.1));
      const y = Math.max(0, Math.min(1, Number(t.y) || 0.1));
      return `
        <div class="table-dot ${cls} ${canPick ? 'pick' : ''}
             ${pickedTable && pickedTable.id === t.id ? 'chosen' : ''}"
             ${canPick ? `data-pick="${esc(t.id)}" data-name="${esc(t.name || '')}"` : ''}
             style="left:calc(${x} * (100% - var(--tile-w)));
                    top:calc(${y} * (100% - var(--tile-h)))">
          ${esc(t.name || '')}
          <small>${Number(t.seats) || 0} мест${tooSmall ? ' · мало' : ''}</small>
        </div>`;
    }).join('');

    box.querySelectorAll('[data-pick]').forEach((el) => {
      el.onclick = () => {
        pickedTable = { id: el.dataset.pick, name: el.dataset.name };
        toast(`Выбран стол ${el.dataset.name}`);
        location.hash = '#/booking';
      };
    });
  };

  let tables = [];
  sub(onSnapshot(collection(state.db, 'tables'), (snap) => {
    tables = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
    draw(tables);
  }, () => {
    const box = $('hall');
    if (box) box.innerHTML = `<p class="muted small" style="padding:20px">Не удалось загрузить карту зала.</p>`;
  }));

  // Обезличенное зеркало броней: стол и интервал, без имён и телефонов.
  // Самих броней гостю читать нельзя — там чужие контакты.
  if (pickMode && when) {
    const from = new Date(when.getTime() - 6 * 60 * 60 * 1000);
    const to = new Date(when.getTime() + 6 * 60 * 60 * 1000);
    const end = new Date(when.getTime() + durMs);
    sub(onSnapshot(
      query(collection(state.db, 'reservationSlots'),
        where('startTime', '>=', Timestamp.fromDate(from)),
        where('startTime', '<', Timestamp.fromDate(to))),
      (snap) => {
        busyByBooking = new Set();
        snap.docs.forEach((d) => {
          const v = d.data();
          if (v.active === false) return;
          const s = toDate(v.startTime);
          const e = toDate(v.endTime);
          if (!s || !e) return;
          // Пересекается с нашим интервалом — стол занят.
          if (s < end && e > when && v.tableId) busyByBooking.add(v.tableId);
        });
        draw(tables);
      }, () => {}));
  }
}

/// Что гость выбрал в форме брони — время и число гостей. Форма живёт на
/// другом экране, поэтому значения запоминаются при уходе на карту.
let bookingDraft = { date: '', time: '', guests: 2, duration: 90 };

function bookingStart() {
  if (!bookingDraft.date || !bookingDraft.time) return null;
  const d = new Date(`${bookingDraft.date}T${bookingDraft.time}:00`);
  return isNaN(d) ? null : d;
}
function bookingGuests() { return Number(bookingDraft.guests) || 2; }
