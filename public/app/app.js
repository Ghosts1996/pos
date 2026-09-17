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
// С годом — для истории бонусов: операции копятся годами, и «14.09»
// без года в списке за несколько лет ничего не говорит.
const dmyy = (d) => `${dmy(d)}.${d.getFullYear()}`;

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
  // Путь ровно тот же, что у приложения: meta/venueProfile. Раньше здесь
  // стоял выдуманный 'venue/profile' — документа по нему нет, поэтому
  // веб-версия считала, что часы работы не заданы, и объявляла закрытым
  // любой день, а правила заведения не показывались вовсе.
  state.accountSubs.push(onSnapshot(doc(state.db, 'meta', 'venueProfile'), (d) => {
    const had = !!state.venue;
    state.venue = d.exists() ? d.data() : null;
    // Профиль заведения приезжает асинхронно и почти всегда ПОЗЖЕ первой
    // отрисовки. Экраны, которые от него зависят — часы работы в брони и
    // правила на «Моём столе», — нужно перерисовать, иначе гость видит
    // «часы не заданы», даже когда они давно пришли.
    if (!had && state.venue) {
      const h = location.hash;
      if (h === '#/booking' || h === '#/table' || h === '#/' || h === '') route();
    }
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

  // «Ещё» — подраздел профиля, отдельной вкладки у него нет: пусть в
  // нижнем меню остаётся подсвеченным «Профиль», а не гаснет всё сразу.
  const activeTab = tab === 'extras' ? 'profile' : (tab === '' ? 'home' : tab);
  document.querySelectorAll('.tabbar a').forEach((a) => {
    a.classList.toggle('on', a.dataset.tab === activeTab);
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
    case 'extras': return screenExtras();
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
    // Без номера в профиле садиться за стол нельзя: кассир не сможет найти
    // гостя для брони, начисления бонусов на новом устройстве или связи по
    // проблеме с чеком — то же правило, что и в приложении на Android.
    //
    // Читаем документ напрямую, а не через state.profile: сразу после
    // запуска по ссылке со стола подписка watchProfile() ещё не успела
    // получить первый снапшот, и state.profile какое-то время пуст даже у
    // гостя с уже сохранённым номером — свежий getDoc от этой гонки не
    // зависит.
    const own = await getDoc(doc(state.db, 'clients', state.uid));
    if (!(own.exists() && own.data().phone)) {
      screenEl().innerHTML = `
        <h1>Сначала укажите номер</h1>
        <p class="muted small">Чтобы сесть за стол, добавьте номер телефона в профиле —
          это нужно, чтобы кассир мог найти вас при брони и переносе бонусов.</p>
        <a class="btn btn-primary" href="#/profile">Открыть профиль</a>`;
      return;
    }

    const t = await getDoc(doc(state.db, 'tables', tableId));
    if (!t.exists()) return failBind('Такого стола нет. Отсканируйте код ещё раз.');
    const data = t.data();
    const checks = (data.openChecks || []).filter((c) => c && c.id);
    const ids = data.activeSessionIds || [];

    if (!ids.length) {
      return failBind('За этим столом сейчас нет открытого счёта — '
        + 'попросите кальянщика начать сеанс.');
    }

    // Несколько счетов за столом — гость выбирает свой. Чужие показываем,
    // но выбрать не даём: так же, как в приложении на Android.
    if (checks.length > 1) {
      const marked = await markTakenChecks(checks);
      return chooseCheck(tableId, data.name || '', marked);
    }

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

/// Кто занял чек: sessionClaims/{sessionId} → {uid}. Читать эту коллекцию
/// гостю можно, а чужие профили — нет, поэтому занятость лежит здесь.
async function markTakenChecks(checks) {
  return Promise.all(checks.map(async (c) => {
    try {
      const d = await getDoc(doc(state.db, 'sessionClaims', c.id));
      const owner = d.exists() ? (d.data().uid || '') : '';
      return { ...c, taken: !!owner && owner !== state.uid };
    } catch (_) {
      return { ...c, taken: false }; // не проверили — не мешаем сесть
    }
  }));
}

function chooseCheck(tableId, tableName, checks) {
  screenEl().innerHTML = `
    <h1>${tableName ? 'Стол ' + esc(tableName) : 'Ваш стол'}</h1>
    <p class="muted small">За этим столом открыто несколько счетов.
    Выберите свой — если ошибётесь, можно будет отвязаться.</p>
    ${checks.map((c, i) => {
      const opened = toDate(c.openedAt);
      return `
        <div class="card" ${c.taken ? '' : `data-check="${esc(c.id)}"`}
             style="${c.taken ? 'opacity:.5' : 'cursor:pointer'}">
          <div class="row">
            <div class="grow">
              <div style="font-weight:600">${esc(c.label || 'Счёт ' + (i + 1))}</div>
              <div class="small muted">${c.taken
                ? 'Уже открыт у другого гостя'
                : (opened ? 'Открыт в ' + hhmm(opened) : 'Время открытия неизвестно')}</div>
            </div>
            <div class="muted">${c.taken ? '🔒' : '›'}</div>
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
    // Отказ правил — счёт действительно чужой. Любая другая ошибка это
    // просто нет связи, и говорить гостю «стол занят» неправда: он пойдёт
    // разбираться к кальянщику вместо того, чтобы повторить попытку.
    if (e && e.code === 'permission-denied') {
      return failBind('Этот счёт уже открыт у другого гостя. '
        + 'Если это ваш стол — попросите кальянщика открыть вам свой счёт.');
    }
    return failBind('Не удалось открыть стол. Проверьте интернет и попробуйте ещё раз.');
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

  // Подписываем чек именем гостя, если подпись ещё пуста — кассир сразу
  // видит на плитке зала, кто сел за стол, без ручного ввода. По
  // возможности: правила базы разрешают это только владельцу claim'а
  // (see firestore.rules), а если имени в профиле ещё нет — просто
  // нечем подписать, и это не повод срывать посадку за стол.
  try {
    // Читаем профиль напрямую, а не через state.profile: сразу после
    // перехода по ссылке со стола подписка на профиль ещё может быть не
    // готова, и state.profile — пуст даже у гостя с уже заполненным именем.
    const own = await getDoc(doc(state.db, 'clients', state.uid));
    const name = (own.exists() ? (own.data().name || '') : '').trim();
    if (name) {
      const sessionRef = doc(state.db, 'sessions', sessionId);
      const s = await getDoc(sessionRef);
      if (s.exists() && !(s.data().guestTag || '')) {
        await updateDoc(sessionRef, { guestTag: name });
      }
    }
  } catch (_) {}

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
    <div id="slotSummary"></div>

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
    lastHall = { tables: [], slots: [] };
    renderSlotSummary();
    box.innerHTML = `<p class="muted small">Не удалось загрузить свободное время.</p>`;
    return;
  }

  // Сводка и карта зала считаются по этим же столам и броням — второй раз
  // в базу не ходим. Запоминаем сразу: ниже есть ранние выходы, и на них
  // сводка показывала бы данные прошлого дня.
  lastHall = { tables, slots };

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
      const freeAt = tableFreeAt(t);
      if (freeAt && cur < freeAt) return false;
      return true;
    });
    if (ok) free.push(new Date(cur));
  }

  if (!free.length) {
    box.innerHTML = `<p class="muted small">На выбранные день и условия
      свободного времени нет. Попробуйте другую дату, другую длительность
      или меньшую компанию.</p>`;
    renderSlotSummary();
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

  renderSlotSummary();
}

/// Столы и брони, загруженные для сетки времени. Сводка считается по ним
/// же — второй раз ходить в базу незачем.
let lastHall = { tables: [], slots: [] };

/// Насколько близко к брони может кончиться чужой сеанс, чтобы стол
/// считался «впритык». Час — типичная перезабивка плюс уборка. То же
/// значение, что в приложении.
const EXTENSION_RISK_MS = 60 * 60 * 1000;

/// Момент, когда стол реально освободится, или null, если он свободен.
///
/// Один в один расчёт приложения (ReservationService._loadHall): плановый
/// конец сеанса плюс двадцать минут на уборку, а просроченный сеанс держит
/// стол ещё час от текущего момента — гости, засидевшиеся сверх времени,
/// со стола сами не встают.
function tableFreeAt(t) {
  const end = toDate(t.busyUntil);
  if (!end) return null;
  const now = Date.now();
  const base = end.getTime() < now ? now + 60 * 60 * 1000 : end.getTime();
  return new Date(base + 20 * 60 * 1000);
}

/// Свободен ли стол на интервал брони и не «впритык» ли он.
///
/// Возвращает 'free' — точно свободен, 'risky' — освободится незадолго до
/// брони (гости могут взять перезабивку и остаться), 'busy' — занят,
/// 'small' — мало мест.
function tableStateFor(t, start, end, bookedIds, guests) {
  if ((Number(t.seats) || 0) < guests) return 'small';
  if (bookedIds.has(t.id)) return 'busy';
  const freeAt = tableFreeAt(t);
  if (!freeAt) return 'free';
  if (start < freeAt) return 'busy';
  return (start - freeAt) < EXTENSION_RISK_MS ? 'risky' : 'free';
}

/// Свободные столы на интервал — так же, как считает приложение.
///
/// Сначала те, что точно будут свободны, потом «впритык» (их часто
/// продлевают), внутри группы — по возрастанию мест, чтобы двоим не
/// доставался стол на восьмерых.
async function freeTablesFor(start, end, guests) {
  const from = new Date(start.getTime() - 14 * 60 * 60 * 1000);
  const to = new Date(start.getTime() + 26 * 60 * 60 * 1000);
  const [tSnap, sSnap] = await Promise.all([
    getDocs(collection(state.db, 'tables')),
    getDocs(query(collection(state.db, 'reservationSlots'),
      where('startTime', '>=', Timestamp.fromDate(from)),
      where('startTime', '<', Timestamp.fromDate(to)))),
  ]);
  const tables = tSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const slots = sSnap.docs.map((d) => d.data()).filter((v) => v.active !== false);
  const booked = bookedTableIds(slots, start, end);

  return tables
    .map((t) => ({ t, st: tableStateFor(t, start, end, booked, guests) }))
    .filter((v) => v.st === 'free' || v.st === 'risky')
    .sort((a, b) => (a.st === b.st
      ? (Number(a.t.seats) || 0) - (Number(b.t.seats) || 0)
      : (a.st === 'free' ? -1 : 1)))
    .map((v) => v.t);
}

/// Какие столы заняты бронями на интервал.
function bookedTableIds(slots, start, end) {
  const out = new Set();
  slots.forEach((v) => {
    const s = toDate(v.startTime);
    const e = toDate(v.endTime);
    if (s && e && v.tableId && s < end && e > start) out.add(v.tableId);
  });
  return out;
}

/// Плашка «что на это время». Только числа: имён и телефонов других
/// гостей здесь нет и быть не должно.
function renderSlotSummary() {
  const box = $('slotSummary');
  if (!box) return;
  const start = bookingStart();
  if (!start) { box.innerHTML = ''; return; }

  const duration = bookingDraft.duration || 90;
  const end = new Date(start.getTime() + duration * 60 * 1000);
  const guests = bookingGuests();
  const booked = bookedTableIds(lastHall.slots, start, end);
  // Броней на это время — штуками, включая те, которым стол ещё не
  // назначен: место в зале они всё равно занимают.
  const bookings = lastHall.slots.filter((v) => {
    const s0 = toDate(v.startTime);
    const e0 = toDate(v.endTime);
    return s0 && e0 && s0 < end && e0 > start;
  }).length;

  let free = 0;
  let risky = 0;
  let occupiedNow = 0;
  lastHall.tables.forEach((t) => {
    // «Сидят сейчас» — по открытым чекам стола: у просроченного сеанса
    // busyUntil уже в прошлом, а гости за столом остались.
    if ((t.activeSessionIds || []).length > 0) occupiedNow++;
    const st = tableStateFor(t, start, end, booked, guests);
    if (st === 'free') free++;
    else if (st === 'risky') risky++;
  });

  const lines = [
    free > 0
      ? `Свободных подходящих столов: ${free}`
      : 'Подходящих свободных столов нет — попробуйте другое время',
    bookings > 0
      ? `На это время уже ${bookings} ${plural(bookings, 'бронь', 'брони', 'броней')}`
      : null,
    occupiedNow > 0
      ? `Сейчас в зале занято ${occupiedNow} из ${lastHall.tables.length}`
      : null,
    risky > 0
      ? `Ещё ${risky} ${plural(risky, 'стол освободится', 'стола освободятся', 'столов освободятся')}`
        + ' незадолго до брони — гости могут взять перезабивку и остаться'
      : null,
  ].filter(Boolean);

  box.innerHTML = `
    <div class="card" style="${free > 0 ? '' : 'border-color:var(--warning)'}">
      ${lines.map((l) => `<div class="small muted" style="margin-bottom:4px">· ${esc(l)}</div>`).join('')}
    </div>`;
}

/// «1 бронь», «2 брони», «5 броней».
function plural(n, one, few, many) {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return one;
  if (!teen && last >= 2 && last <= 4) return few;
  return many;
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
    // Стол назначается всегда — ровно как в приложении на Android. Если
    // гость его не выбирал, подбираем сами; если выбирал, перепроверяем
    // прямо сейчас: карту он мог листать долго, и стол могли занять.
    // Без этого бронь уходила без стола и никого не занимала — второй
    // гость спокойно бронировал то же место на то же время.
    let table = pickedTable;
    const free = await freeTablesFor(start, end, guests);
    if (table && table.id) {
      if (!free.some((t) => t.id === table.id)) {
        toast('Этот стол только что заняли — выберите другой');
        pickedTable = null;
        return;
      }
    } else {
      if (!free.length) {
        toast('На это время свободных столов не осталось');
        return;
      }
      table = { id: free[0].id, name: free[0].name || '' };
    }

    const ref = await addDoc(collection(state.db, 'reservations'), {
      clientUid: state.uid,
      guestName: name,
      phone,
      guestsCount: guests,
      tableId: table.id,
      tableName: table.name || '',
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
    try {
      await setDoc(doc(state.db, 'reservationSlots', ref.id), {
        tableId: table.id,
        clientUid: state.uid,
        startTime: Timestamp.fromDate(start),
        endTime: Timestamp.fromDate(end),
        active: true,
      }, { merge: true });
    } catch (_) {
      // Зеркало вторично: сама бронь создана и видна кассе.
    }

    // Имя и телефон пригодятся в следующий раз — сохраняем в профиль.
    // Телефон меняется только если его ещё не задавали: к нему привязаны
    // бонусы, и правила базы менять его гостю не дают.
    const patch = { name };
    if (!(state.profile || {}).phone) {
      // Указатель «номер → гость» занимаем так же, как это делает
      // приложение: иначе касса по этому номеру нашла бы чужой профиль,
      // а бонусы уехали бы не туда.
      if (await phoneTakenByOther(phone)) {
        alert('Номер уже зарегистрирован\n\n'
          + 'На этот номер уже есть профиль. Назовите кальянщику номер и '
          + '«ID устройства» из профиля — он объединит их на кассе. '
          + 'Бронь при этом уже отправлена.');
      } else {
        patch.phone = phone;
        try {
          await setDoc(doc(state.db, 'phoneIndex', phone), { uid: state.uid });
        } catch (_) {}
      }
    }
    await setDoc(doc(state.db, 'clients', state.uid), patch, { merge: true });
    pickedTable = null;
    bookingDraft.time = '';
    toast('Заявка отправлена — скоро подтвердим');
  } catch (e) {
    toast('Не удалось отправить заявку');
  } finally {
    // Именно finally: выше есть выходы по «стол заняли» и «столов не
    // осталось», и без него кнопка навсегда оставалась бы серой.
    const btn = $('bSend');
    if (btn) btn.disabled = false;
  }
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
                ${(r.status === 'new' || r.status === 'confirmed') && !r.guestConfirmed
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
  // Плашка зависит не только от данных, но и от текущего времени: гость
  // может открыть страницу за час до брони и не закрывать её. Без этого
  // таймера перерисовка случалась бы только при изменении брони в базе —
  // то есть плашка не появлялась бы вовсе, а «через N минут» показывало
  // бы время открытия страницы.
  let draw = () => {};
  const tick = setInterval(() => draw(), 30 * 1000);
  sub(() => clearInterval(tick));

  sub(onSnapshot(
    query(collection(state.db, 'reservations'), where('clientUid', '==', state.uid)),
    (snap) => {
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      draw = () => renderSoonCard(boxId, docs);
      draw();
    }, () => {}));
}

function renderSoonCard(boxId, docs) {
  const box = $(boxId);
  if (!box) return;
  const now = Date.now();
  const soon = docs.filter((r) => {
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

    <a class="btn btn-ghost" href="#/extras"
       style="display:flex;align-items:center;gap:12px;text-align:left">
      <span class="muted">•••</span>
      <span class="grow">Чаевые, сертификат, очередь, пригласить друга</span>
    </a>

    <h2>История визитов</h2>
    <div id="visits"><div class="spinner"></div></div>

    <h2>История бонусов</h2>
    <div id="bonusOps"><div class="spinner"></div></div>

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
  watchBonusOps();
}

/// История бонусов — начисления и списания.
///
/// orderBy обязателен: limit(50) без сортировки отдаёт первые пятьдесят
/// документов в порядке id, то есть случайные. У постоянного гостя свежие
/// начисления в такую выборку просто не попадали. Составной индекс для
/// этого запроса уже есть — его использует приложение на Android.
function watchBonusOps() {
  sub(onSnapshot(
    query(collection(state.db, 'bonusOperations'),
      where('clientUid', '==', state.uid),
      orderBy('createdAt', 'desc'),
      limit(50)),
    (snap) => {
      const box = $('bonusOps');
      if (!box) return;
      if (snap.empty) {
        box.innerHTML = '<p class="muted small">Операций пока нет</p>';
        return;
      }
      box.innerHTML = snap.docs.map((d) => {
        const v = d.data();
        const accrual = v.type === 'accrual';
        const amount = Number(v.amount) || 0;
        const when = toDate(v.createdAt);
        return `
          <div class="row" style="padding:10px 0;border-bottom:1px solid var(--border)">
            <span style="color:${accrual ? 'var(--primary)' : 'var(--warning)'}">
              ${accrual ? '⊕' : '⊖'}</span>
            <div class="grow">
              <div>${esc(bonusReason(v.reason, accrual))}</div>
              <div class="small muted">${when ? dmyy(when) : ''}</div>
            </div>
            <div style="font-weight:700;color:${accrual ? 'var(--primary)' : 'var(--warning)'}">
              ${accrual ? '+' : '−'}${Math.round(Math.abs(amount))}</div>
          </div>`;
      }).join('');
    },
    () => {
      const box = $('bonusOps');
      if (box) box.innerHTML = '<p class="muted small">Не удалось загрузить историю</p>';
    }));
}

/// Человеческая подпись к бонусной операции — те же слова, что в приложении.
function bonusReason(reason, accrual) {
  switch (reason) {
    case 'referral_invitee': return 'Бонус за код друга';
    case 'referral_inviter': return 'Друг дошёл до нас';
    case 'giftCard': return 'Сертификат активирован';
    case 'visit': return 'Начисление за визит';
    default: return accrual ? 'Начисление за визит' : 'Списание бонусов';
  }
}

/// Занят ли номер ДРУГИМ профилем. Чтение одного документа по id —
/// запрос по коллекции гостю правила базы не разрешают.
async function phoneTakenByOther(phone) {
  if (!phone) return false;
  try {
    const idx = await getDoc(doc(state.db, 'phoneIndex', phone));
    const owner = idx.exists() ? (idx.data().uid || '') : '';
    return !!owner && owner !== state.uid;
  } catch (_) {
    return false; // не проверили — не мешаем гостю
  }
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
      if (await phoneTakenByOther(phone)) {
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


// ---------- ЕЩЁ: ЧАЕВЫЕ, СЕРТИФИКАТ, ОЧЕРЕДЬ, ДРУГ ----------
//
// Четыре редких действия на одном экране — как в приложении на Android.
// Отдельная вкладка под каждое только запутывала бы нижнее меню.

/// Сколько бонусов получает каждая сторона — те же числа, что в
/// ReferralService на Android.
const INVITER_BONUS = 300;
const INVITEE_BONUS = 200;

function screenExtras() {
  screenEl().innerHTML = `
    <div class="row" style="margin-bottom:6px">
      <a class="btn-ghost" href="#/profile" style="padding:6px 10px">←</a>
      <h1 style="margin:0">Ещё</h1>
    </div>

    <div class="card">
      <div class="row"><span style="color:var(--primary)">🫶</span>
        <b class="grow">Чаевые кальянщику</b></div>
      <div id="xTips" style="margin-top:12px"></div>
    </div>

    <div class="card">
      <div class="row"><span style="color:var(--primary)">🎁</span>
        <b class="grow">Подарочный сертификат</b></div>
      <p class="small muted" style="margin:12px 0 0">Код из нашего канала.
        Активируйте — бонусы сразу появятся на счёте.</p>
      <div class="row" style="margin-top:12px;gap:10px">
        <input id="xCard" class="grow" placeholder="KLB-XXXX-XXXX"
          autocapitalize="characters" spellcheck="false">
        <button class="btn-ghost" id="xCardBtn">Активировать</button>
      </div>
      <div id="xCardMsg" class="small" style="margin-top:10px"></div>
      <div id="xCardClaim" class="small muted" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="row"><span style="color:var(--primary)">⏳</span>
        <b class="grow">Занять очередь</b></div>
      <div id="xQueue" style="margin-top:12px"><div class="spinner"></div></div>
    </div>

    <div class="card">
      <div class="row"><span style="color:var(--primary)">👥</span>
        <b class="grow">Пригласить друга</b></div>
      <div style="margin-top:12px">
        <div id="xMyCode" style="font-size:18px;font-weight:700">Ваш код: …</div>
        <p class="small muted" style="margin:6px 0 14px">Друг называет его в
          первый визит: ему ${INVITEE_BONUS} бонусов, вам — ${INVITER_BONUS}.</p>
        <div class="row" style="gap:10px">
          <input id="xRef" class="grow" placeholder="Код друга"
            autocapitalize="characters" spellcheck="false">
          <button class="btn-ghost" id="xRefBtn">Применить</button>
        </div>
        <div id="xRefMsg" class="small" style="margin-top:10px;color:var(--gold)"></div>
      </div>
    </div>`;

  renderTips();
  renderQueue();
  ensureReferralCode();
  $('xCardBtn').onclick = activateGiftCard;
  watchGiftClaims();
  $('xRefBtn').onclick = applyReferralCode;
}

// ---------- ЧАЕВЫЕ ----------

function renderTips() {
  const box = $('xTips');
  if (!box) return;
  const sessionId = (state.profile || {}).activeSessionId || '';
  if (!sessionId) {
    box.innerHTML = `<p class="small muted">Чаевые можно оставить во время
      визита — откройте свой стол.</p>`;
    return;
  }

  // Имя кальянщика лежит в чеке. Свой чек гостю читать можно — чужие нет.
  sub(onSnapshot(doc(state.db, 'sessions', sessionId), (d) => {
    const who = d.exists() ? (d.data().employeeName || '') : '';
    box.innerHTML = `
      <p class="small muted">${who ? 'Ваш кальянщик: ' + esc(who) : 'Ваш кальянщик'}</p>
      <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
        ${[200, 500, 1000].map((a) =>
          `<button class="btn-ghost" data-tip="${a}">${a} ₽</button>`).join('')}
      </div>`;
    box.querySelectorAll('[data-tip]').forEach((el) => {
      el.onclick = () => leaveTip(Number(el.dataset.tip), who, sessionId, el);
    });
  }, () => {
    box.innerHTML = `<p class="small muted">Чаевые можно оставить во время
      визита — откройте свой стол.</p>`;
  }));
}

async function leaveTip(amount, employeeName, sessionId, btn) {
  btn.disabled = true;
  try {
    await addDoc(collection(state.db, 'tips'), {
      amount,
      employeeId: '',
      employeeName: employeeName || 'Смена',
      sessionId,
      clientUid: state.uid,
      comment: '',
      method: 'app',
      // Правила базы разрешают гостю создавать чаевые только в этом
      // статусе: подтверждает оплату касса.
      status: 'pending',
      createdAt: Timestamp.fromDate(new Date()),
    });
    // Деньги списывает платёжный провайдер на следующем шаге; здесь мы
    // зафиксировали намерение и сообщили смене.
    toast(`Спасибо! ${amount} ₽ передадим кальянщику`);
  } catch (_) {
    toast('Не удалось отправить — проверьте связь');
  } finally {
    btn.disabled = false;
  }
}

// ---------- СЕРТИФИКАТ ----------

/// Гость вводит код сертификата.
///
/// Сам себе бонусы гость начислить не может — правила базы этого не
/// разрешают, и правильно делают. Поэтому отсюда уходит заявка, а
/// начисляет её касса. Пока заведение работает, это занимает секунды.
async function activateGiftCard() {
  const msg = $('xCardMsg');
  const btn = $('xCardBtn');
  const code = ($('xCard').value || '').trim().toUpperCase();

  const say = (text, ok) => {
    msg.textContent = text;
    msg.style.color = ok ? 'var(--primary)' : 'var(--warning)';
  };

  if (!code) return say('Введите код сертификата.', false);

  btn.disabled = true;
  msg.textContent = 'Отправляем…';
  msg.style.color = 'var(--muted)';
  try {
    const d = await getDoc(doc(state.db, 'giftCards', code));
    if (!d.exists()) return say('Такого сертификата нет. Проверьте код.', false);

    const problem = giftCardProblem(d.data());
    if (problem) return say(problem, false);

    // Один гость — одна активация. Свои заявки читать можно, чужие нет.
    const mine = await getDocs(query(collection(state.db, 'giftCardClaims'),
      where('clientUid', '==', state.uid), where('code', '==', code)));
    if (!mine.empty) {
      const v = mine.docs[0].data();
      if (v.status === 'granted') return say('Вы уже активировали этот сертификат.', false);
      if (v.status === 'new') return say('Заявка уже отправлена — ждём начисления.', false);
      return say(v.reason || 'Сертификат уже использован.', false);
    }

    await addDoc(collection(state.db, 'giftCardClaims'), {
      code,
      clientUid: state.uid,
      // Правила базы разрешают гостю создавать заявку только такой:
      // сумму проставляет касса при начислении.
      status: 'new',
      reason: '',
      amount: 0,
      createdAt: Timestamp.fromDate(new Date()),
      processedAt: null,
    });
    $('xCard').value = '';
    say('Заявка принята — бонусы начислим в ближайшие минуты.', true);
  } catch (_) {
    say('Не удалось отправить — проверьте связь.', false);
  } finally {
    btn.disabled = false;
  }
}

/// Почему код не сработает — те же проверки, что в приложении.
function giftCardProblem(v) {
  const expires = toDate(v.expiresAt);
  const maxUses = Number(v.maxUses) || 0;
  const used = Number(v.usedCount) || 0;
  // bonusAmount — новое имя поля; faceValue осталось от версии, где
  // сертификат был кошельком, и читается ради старых кодов.
  const amount = Number(v.bonusAmount ?? v.faceValue) || 0;

  if (v.active === false) return 'Этот сертификат больше не действует.';
  if (expires && expires <= new Date()) return 'Срок действия сертификата истёк.';
  if (maxUses > 0 && used >= maxUses) return 'Сертификат разобрали — активации закончились.';
  if (amount <= 0) return 'Этот сертификат ничего не начисляет.';
  return null;
}

/// Что стало с отправленными заявками. Начисляет касса, поэтому показать
/// «ждём» честнее, чем оставить экран молчать.
function watchGiftClaims() {
  sub(onSnapshot(
    query(collection(state.db, 'giftCardClaims'), where('clientUid', '==', state.uid)),
    (snap) => {
      const box = $('xCardClaim');
      if (!box) return;
      if (snap.empty) { box.textContent = ''; return; }

      const last = snap.docs
        .map((d) => d.data())
        .sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0))[0];

      if (last.status === 'granted') {
        box.textContent = `Сертификат ${last.code}: начислено `
          + `${Math.round(Number(last.amount) || 0)} бонусов`;
        box.style.color = 'var(--primary)';
      } else if (last.status === 'rejected') {
        box.textContent = `Сертификат ${last.code}: `
          + (last.reason || 'активировать не вышло');
        box.style.color = 'var(--warning)';
      } else {
        box.textContent = `Сертификат ${last.code}: ждём начисления…`;
        box.style.color = 'var(--muted)';
      }
    }, () => {}));
}

// ---------- ОЧЕРЕДЬ ----------

function renderQueue() {
  sub(onSnapshot(
    query(collection(state.db, 'waitlist'), where('clientUid', '==', state.uid)),
    (snap) => {
      const box = $('xQueue');
      if (!box) return;
      const open = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((e) => e.status === 'waiting' || e.status === 'invited')
        .sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0));

      if (open.length) {
        const e = open[0];
        box.innerHTML = `
          <p style="color:${e.status === 'invited' ? 'var(--primary)' : 'inherit'}">
            ${e.status === 'invited'
              ? 'Ваш стол готов — ждём вас!'
              : `Вы в очереди, ждать примерно ${Number(e.promisedMinutes) || 0} мин`}</p>
          <button class="btn-ghost" id="xLeave"
            style="margin-top:10px;color:var(--danger)">Выйти из очереди</button>`;
        $('xLeave').onclick = async () => {
          $('xLeave').disabled = true;
          try {
            await updateDoc(doc(state.db, 'waitlist', e.id), { status: 'left' });
            toast('Вы вышли из очереди');
          } catch (_) {
            toast('Не удалось — проверьте связь');
            $('xLeave').disabled = false;
          }
        };
        return;
      }

      box.innerHTML = `
        <p class="small muted">Если все столы заняты — встаньте в очередь,
          мы напишем, как только стол освободится.</p>
        <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
          ${[2, 4, 6].map((n) =>
            `<button class="btn-ghost" data-queue="${n}">${n} чел.</button>`).join('')}
        </div>`;
      box.querySelectorAll('[data-queue]').forEach((el) => {
        el.onclick = () => joinQueue(Number(el.dataset.queue), el);
      });
    },
    () => {
      const box = $('xQueue');
      if (box) box.innerHTML = '<p class="small muted">Не удалось загрузить очередь.</p>';
    }));
}

/// Оценка ожидания — тот же расчёт, что в приложении: по таймерам открытых
/// чеков, а не «минут двадцать». Занятость берётся из tables.busyUntil:
/// чужие чеки гостю читать нельзя.
async function estimateWait(guests) {
  try {
    const snap = await getDocs(collection(state.db, 'tables'));
    const waits = [];
    snap.docs.forEach((d) => {
      const v = d.data();
      if ((Number(v.seats) || 4) < guests) return;
      const end = toDate(v.busyUntil);
      // Свободный стол — гость сядет сразу, но 5 минут на уборку
      // закладываем всё равно.
      if (!end) { waits.push(5); return; }
      const mins = Math.round((end.getTime() - Date.now()) / 60000);
      waits.push(Math.min(240, Math.max(5, mins)));
    });
    if (!waits.length) return 60;
    waits.sort((a, b) => a - b);
    return waits[0] + 10; // запас на уборку и посадку
  } catch (_) {
    return 30;
  }
}

async function joinQueue(guests, btn) {
  btn.disabled = true;
  try {
    const minutes = await estimateWait(guests);
    const p = state.profile || {};
    await addDoc(collection(state.db, 'waitlist'), {
      guestName: (p.name || '').trim() || 'Гость',
      phone: p.phone || '',
      clientUid: state.uid,
      guestsCount: guests,
      comment: '',
      // Правила базы разрешают гостю вставать в очередь только так.
      status: 'waiting',
      promisedMinutes: minutes,
      source: 'kolibri',
      createdAt: Timestamp.fromDate(new Date()),
    });
    // Позицию в очереди не показываем: чужие записи гостю читать нельзя,
    // а придумывать номер честнее не пытаться.
    toast(`Вы в очереди, ждать ~${minutes} мин`);
  } catch (_) {
    toast('Не удалось встать в очередь — проверьте связь');
  } finally {
    btn.disabled = false;
  }
}

// ---------- ПРИГЛАСИТЬ ДРУГА ----------

/// Код гостя. Генерируется один раз и живёт в профиле — тот же алгоритм,
/// что в ReferralService на Android, чтобы код в вебе и в приложении у
/// одного гостя совпадал.
async function ensureReferralCode() {
  const box = $('xMyCode');
  try {
    const existing = ((state.profile || {}).referralCode || '').trim();
    if (existing) { if (box) box.textContent = `Ваш код: ${existing}`; return; }

    const tail = state.uid.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const base = 'KLB-' + tail.slice(0, 4).padEnd(4, '0');

    // Столкновения редки, но код всё же проверяем: занять чужой указатель
    // правила базы не дадут, и код молча не сохранился бы.
    let code = base;
    for (let i = 0; i < 5; i++) {
      const d = await getDoc(doc(state.db, 'referralCodes', code));
      const owner = d.exists() ? (d.data().uid || '') : '';
      if (!owner || owner === state.uid) break;
      code = base + (i + 1);
    }

    // Сначала закрепляем код в указателе, потом пишем в профиль: если
    // закрепить не вышло, профиль не получит код, на который нельзя сослаться.
    await setDoc(doc(state.db, 'referralCodes', code), { uid: state.uid });
    await setDoc(doc(state.db, 'clients', state.uid), { referralCode: code }, { merge: true });
    if (box) box.textContent = `Ваш код: ${code}`;
  } catch (_) {
    if (box) box.textContent = 'Ваш код появится позже';
  }
}

/// Гость вводит код пригласившего. Бонусы начисляются не сразу, а после
/// первого оплаченного визита — иначе код можно было бы фармить, не
/// приходя в заведение. Проверки те же, что в приложении.
async function applyReferralCode() {
  const msg = $('xRefMsg');
  const code = ($('xRef').value || '').trim().toUpperCase();
  const p = state.profile || {};

  const say = (text) => { msg.textContent = text; };

  if (!code) return say('Введите код.');
  if ((p.referredBy || '').length > 0) return say('Код уже применён раньше.');
  if ((p.referralCode || '') === code) return say('Это ваш собственный код.');
  if ((Number(p.visits) || 0) > 0) return say('Код можно применить только до первого визита.');

  say('Проверяем…');
  try {
    const d = await getDoc(doc(state.db, 'referralCodes', code));
    const inviter = d.exists() ? (d.data().uid || '') : '';
    if (!inviter) return say('Такого кода нет.');
    if (inviter === state.uid) return say('Это ваш собственный код.');

    await setDoc(doc(state.db, 'clients', state.uid),
      { referredBy: inviter, referralCodeUsed: code }, { merge: true });
    say(`Код принят: после первого визита вам начислим ${INVITEE_BONUS} бонусов, `
      + `другу — ${INVITER_BONUS}.`);
  } catch (_) {
    say('Не удалось применить код — проверьте связь.');
  }
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
  if (!video || !hint) return;

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
  let lastLook = 0;

  const tick = async () => {
    if (done || !scanStream) return;

    // Разбирать каждый кадр незачем: на разбор уходит больше времени, чем
    // телефон успевает между кадрами, и на iPhone экран начинает дёргаться,
    // а батарея — греться. Десять раз в секунду код ловится так же.
    const nowMs = Date.now();
    // readyState сравниваем «не меньше», а не «равно»: Safari на iPhone
    // часто держит поток на HAVE_CURRENT_DATA и до HAVE_ENOUGH_DATA не
    // доходит вовсе — с проверкой на равенство сканер там просто никогда
    // не начинал смотреть в кадр. А ради iPhone этот экран и сделан.
    const ready = video.readyState >= 2 && video.videoWidth > 0;

    if (ready && nowMs - lastLook >= 100) {
      lastLook = nowMs;
      let raw = null;
      try {
        if (detector) {
          const found = await detector.detect(video);
          if (found && found.length) raw = found[0].rawValue;
        } else {
          // Кадр меньше исходного: для кода этого хватает, а работы
          // телефону заметно меньше.
          const w = Math.min(420, video.videoWidth);
          const scale = w / video.videoWidth;
          canvas.width = w;
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
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
        if (hint) hint.textContent = 'Это не код стола — наведите на код на столе.';
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
      <span><i style="background:#D9A441"></i> впритык</span>
      <span><i style="background:#C24A4A"></i> занят</span>
    </div>
    <div style="height:16px"></div>
    <a class="btn btn-ghost" href="${pickMode ? '#/booking' : '#/table'}">${pickMode ? 'Отмена' : 'Назад'}</a>`;

  // Занятость по броням на выбранное время — только в режиме выбора.
  let busyByBooking = new Set();
  const when = pickMode ? bookingStart() : null;
  const durMs = (bookingDraft.duration || 90) * 60 * 1000;

  let tablesLoaded = false;

  const draw = (tables) => {
    const box = $('hall');
    if (!box) return;
    // Зеркало броней иногда приходит раньше самих столов: без этой
    // проверки карта на мгновение писала «не настроена» и мигала.
    if (!tablesLoaded) return;
    if (!tables.length) {
      box.innerHTML = `<p class="muted small" style="padding:20px">Карта зала пока не настроена.</p>`;
      return;
    }
    box.innerHTML = tables.map((t) => {
      // ВАЖНО: занятость считается по-разному для двух режимов.
      //
      // Карта зала показывает, что происходит СЕЙЧАС: занят тот стол, за
      // которым сидят.
      //
      // Выбор стола для брони — про БУДУЩЕЕ. Здесь «за столом сейчас
      // сидят» ничего не значит: гости уйдут задолго до вечера. Важно
      // только, дотянется ли текущий сеанс до времени брони (busyUntil) и
      // нет ли на это время чужой брони. Раньше тут стояла проверка «за
      // столом кто-то есть», и половина зала выглядела занятой на завтра
      // только потому, что была занята в эту минуту.
      // Имя намеренно НЕ state: глобальный state хранит соединение с базой
      // и профиль гостя, и локальная переменная с тем же именем перекрыла
      // бы его внутри всего этого блока.
      const st = pickMode && when
          ? tableStateFor(t, when, new Date(when.getTime() + durMs),
              busyByBooking, bookingGuests())
          : ((t.activeSessionIds || []).length > 0 || t.status === 'occupied')
              ? 'busy' : 'free';
      const tooSmall = st === 'small';
      const bookedNow = busyByBooking.has(t.id);
      const cls = st === 'small' ? 'small'
          : st === 'busy' ? 'busy'
          : st === 'risky' ? 'risky' : 'free';
      // «Впритык» выбрать можно — это решение гостя, но он должен знать.
      const canPick = pickMode && (cls === 'free' || cls === 'risky');
      // Координаты 0..1 — те же, что расставил администратор на кассе.
      // Раскладываем их в «от края до края минус ширина плитки»: иначе
      // стол с координатой 0 или 1 наполовину уезжал за границу карты, и
      // на узких экранах подписи обрезались.
      const x = Math.max(0, Math.min(1, Number(t.x) || 0.1));
      const y = Math.max(0, Math.min(1, Number(t.y) || 0.1));
      // Нажатие по недоступному столу объясняет, почему он недоступен:
      // молчащая плитка выглядит как сломанная кнопка.
      const why = tooSmall
        ? `Стол на ${Number(t.seats) || 0} мест — для ${bookingGuests()} гостей мало`
        : bookedNow
          ? 'Этот стол уже забронирован на выбранное время'
          : 'Стол занят до этого времени — выберите другое время или стол';
      return `
        <div class="table-dot ${cls} ${canPick ? 'pick' : ''}
             ${pickedTable && pickedTable.id === t.id ? 'chosen' : ''}"
             ${canPick
               ? `data-pick="${esc(t.id)}" data-name="${esc(t.name || '')}"
                  ${cls === 'risky' ? 'data-risky="1"' : ''}`
               : (pickMode ? `data-why="${esc(why)}"` : '')}
             style="left:calc(${x} * (100% - var(--tile-w)));
                    top:calc(${y} * (100% - var(--tile-h)))">
          ${esc(t.name || '')}
          <small>${Number(t.seats) || 0} мест${tooSmall ? ' · мало' : ''}</small>
        </div>`;
    }).join('');

    box.querySelectorAll('[data-pick]').forEach((el) => {
      el.onclick = () => {
        pickedTable = { id: el.dataset.pick, name: el.dataset.name };
        toast(el.dataset.risky
          ? `${el.dataset.name}: освободится незадолго до брони — гости могут остаться`
          : `Выбран ${el.dataset.name}`);
        location.hash = '#/booking';
      };
    });
    box.querySelectorAll('[data-why]').forEach((el) => {
      el.onclick = () => toast(el.dataset.why);
    });
  };

  let tables = [];
  sub(onSnapshot(collection(state.db, 'tables'), (snap) => {
    tablesLoaded = true;
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
