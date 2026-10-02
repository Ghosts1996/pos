// Веб-версия приложения гостя на {slug}.zalpos.ru — для iPhone и всех, кто
// не ставит APK. Открывается по той же ссылке из QR стола и работает с той
// же базой по тем же правилам.
//
// От public/app/app.js (приложение одного заведения) отличается двумя
// вещами: все пути строятся от state.root = tenants/{id} (как AppScope во
// Flutter), а заведение и его брендинг определяются по поддомену.
//
// ИИ-помощника здесь нет: ключ провайдера в браузер не отдать.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, onSnapshot,
  collection, query, where, orderBy, limit, addDoc, deleteDoc, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// Сервер платформы: поиск заведения по поддомену, конфиг Firebase, удаление данных.
const GATEWAY = 'https://pii.zalpos.ru/saas';
// Первичное хранилище персональных данных в РФ (pii-gateway, 152-ФЗ):
// имя и телефон гостя пишутся сюда ДО Firestore.
const PII_URL = 'https://pii.zalpos.ru/';

async function piiPost(body) {
  const token = await state.auth.currentUser.getIdToken();
  const resp = await fetch(PII_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error('pii ' + resp.status);
}

// ---------- СОСТОЯНИЕ ----------

const state = {
  db: null,
  /// tenants/{id} — от него doc()/collection() строят все пути заведения.
  root: null,
  tenantId: '',
  /// Сеть, если поддомен принадлежит сети; у одиночного заведения пусто.
  chainId: '',
  /// Где лежит лояльность (clients, phoneIndex, referralCodes,
  /// bonusOperations): у сети — chains/{chainId}, иначе state.root.
  loyaltyRoot: null,
  auth: null,
  uid: '',
  profile: null,
  venue: null,
  /// Название из «Брендинга»; пусто — показываем имя заведения.
  brandAppName: '',
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
  /// Экран «Мой стол» перерисовывается на каждое изменение чека. Подписки
  /// на вызовы, заказы и чаевые при этом заводятся один раз на экран (id
  /// чека здесь), а их последние данные лежат в tableCache — иначе каждая
  /// перерисовка добавляла бы ещё по подписке.
  tableWatch: null,
  tableCache: { calls: [], orders: [] },
  /// Чаевые: кто на смене, свои чаевые к чеку и выбор гостя в форме.
  tips: { sid: null, watching: false, session: null, team: [], mine: [], to: null, preset: 10, custom: '' },
};

const $ = (id) => document.getElementById(id);
const screenEl = () => $('screen');

// ---------- ИКОНКИ ----------

// Линейные иконки 24×24 одной толщины линии вместо эмодзи: эмодзи на
// каждом телефоне свои и спорят с цветами заведения, а линия берёт цвет
// текста (currentColor). Те же контуры — во вкладках index.html.
const IC = {
  user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5c1-4 4-6 7.5-6s6.5 2 7.5 6"/>',
  home: '<path d="M3.5 10.5 12 4l8.5 6.5"/><path d="M5.5 9v10.5h13V9"/><path d="M10 19.5v-5h4v5"/>',
  menu: '<path d="M7 3v8"/><path d="M4.5 3v5a2.5 2.5 0 0 0 5 0V3"/><path d="M7 11v10"/><path d="M17 21V3c-2.2 1.3-3.5 3.8-3.5 7v3H17"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M4 12h16"/>',
  plan: '<rect x="3.5" y="4" width="17" height="16" rx="1.5"/><path d="M3.5 13h7v7M13.5 4v5.5h7"/>',
  cloche: '<path d="M3 18h18"/><path d="M5 18a7 7 0 0 1 14 0"/><path d="M12 11V9M10.5 9h3"/>',
  flame: '<path d="M12 21c-3.6 0-6-2.4-6-5.6 0-3.2 2.3-5 3.4-7.4.4 1.5 1.3 2.4 2.2 2.8C12 7.6 13 5 15.2 3c-.3 3 1.2 4.8 2 6.4.7 1.3.8 2.6.8 3.8 0 4.3-2.4 7.8-6 7.8Z"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/>',
  hand: '<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 11V6a1.5 1.5 0 0 1 3 0v8c0 4-2.5 7-6 7-2.6 0-4-1.3-5.4-3.3L3.8 15a1.5 1.5 0 0 1 2.5-1.7L8 15.5"/>',
  bell: '<path d="M4.5 17h15"/><path d="M6 17a6 6 0 0 1 12 0"/><path d="M12 11V9.5M10.5 9.5h3"/><path d="M3.5 20h17"/>',
  receipt: '<path d="M6 3.5h12v17l-2.5-1.5-2 1.5-1.5-1.5-1.5 1.5-2-1.5L6 20.5Z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><circle cx="8.5" cy="11" r="2"/><path d="M5.8 15.5c.6-1.3 1.6-2 2.7-2s2.1.7 2.7 2M14 10h4M14 13.5h3"/>',
  heart: '<path d="M12 19.5s-7.5-4.4-7.5-10A4 4 0 0 1 12 7.2a4 4 0 0 1 7.5 2.3c0 5.6-7.5 10-7.5 10Z"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="1.5"/><path d="M3 9h18M12 9v11"/><path d="M12 9c-1.5-3.5-5.5-4-5.5-1.5S10 9 12 9Zm0 0c1.5-3.5 5.5-4 5.5-1.5S14 9 12 9Z"/>',
  hourglass: '<path d="M7 3.5h10M7 20.5h10"/><path d="M8 3.5c0 4 4 5 4 8.5s-4 4.5-4 8.5M16 3.5c0 4-4 5-4 8.5s4 4.5 4 8.5"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.8-3.3 3-5 5.5-5s4.7 1.7 5.5 5"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17 14.7c1.8.6 3 2.2 3.5 4.8"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  out: '<path d="M7 17 17 7M9 7h8v8"/>',
  next: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  star: '<path d="m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.7l-5.1 2.7 1-5.6-4.1-4 5.7-.8Z"/>',
};

function ic(name, cls = '') {
  return `<svg class="i${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${IC[name] || ''}</svg>`;
}

// ---------- МЕЛОЧИ ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Экранирует текст и превращает ссылки внутри него в кликабельные <a>.
// Хвостовая пунктуация («...канал.», «(сайт)») в ссылку не включается.
function linkify(s) {
  const escaped = esc(s);
  return escaped.replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi, (url) => {
    let trail = '';
    const trailMatch = url.match(/[.,!?;:)\]}"'”»]+$/);
    if (trailMatch) {
      trail = trailMatch[0];
      url = url.slice(0, -trail.length);
    }
    if (!url) return trail;
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${url}</a>${trail}`;
  });
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
  state.tableWatch = null;
  state.tableCache = { calls: [], orders: [] };
  state.tips.watching = false;
}

function sub(off) { state.screenSubs.push(off); }

// ---------- ТИП ЗАВЕДЕНИЯ ----------
// Те же правила, что VenueTerms в приложении: кальянная, ресторан, кафе
// или бар. От типа зависят слова про персонал и кнопки вызова за столом.
// Нет поля — кальянная: так работали все заведения до настройки.
function venueType() {
  const t = (state.venue || {}).venueType;
  return ['hookah', 'restaurant', 'cafe', 'bar'].includes(t) ? t : 'hookah';
}
/// Кальяны в заведении — переключатель «Заведение с кальянами» (hookahEnabled,
/// как VenueTerms.isHookah): только с ним у гостя кнопки «Позвать
/// кальянщика», «Поменять угли» и «Перезабивка». Не задан — по типу.
function isHookah() {
  const v = (state.venue || {}).hookahEnabled;
  return typeof v === 'boolean' ? v : venueType() === 'hookah';
}
/// Кто обслуживает стол: form — 'nom' («кальянщик подтвердит»), 'acc'
/// («позовите кальянщика») или 'dat' («скажите кальянщику»).
function staffWord(form) {
  const t = venueType();
  const w = t === 'hookah' && isHookah() ? ['кальянщик', 'кальянщика', 'кальянщику']
    : t === 'bar' ? ['бармен', 'бармена', 'бармену']
      : ['официант', 'официанта', 'официанту'];
  return w[{ nom: 0, acc: 1, dat: 2 }[form] || 0];
}
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

// ---------- ЗАПУСК ----------

/// Заведение — по поддомену {slug}.zalpos.ru: статика одна на всех. Поддомен
/// может принадлежать и сети целиком. Сначала ищем заведение — таких
/// поддоменов большинство, и лишний запрос про сеть им ни к чему.
async function resolveTenant() {
  const slug = (location.hostname.split('.')[0] || '').trim();
  if (!slug) throw new Error('Не удалось определить заведение по адресу');

  const tenantResp = await fetch(`${GATEWAY}/resolveTenantBySlug`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  if (tenantResp.ok) {
    const json = await tenantResp.json();
    return { type: 'tenant', tenantId: json.tenantId };
  }

  const chainResp = await fetch(`${GATEWAY}/resolveChainBySlug`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  const chainJson = await chainResp.json().catch(() => ({}));
  if (!chainResp.ok) throw new Error(chainJson.error || 'Заведение не найдено');
  return {
    type: 'chain',
    chainId: chainJson.chainId,
    name: chainJson.name || '',
    locations: chainJson.locations || [],
  };
}

/// Точки сети, в которые можно зайти.
function openLocations(chain) {
  return (chain.locations || []).filter((l) => l.status !== 'suspended' && l.status !== 'deleted');
}

/// Выбор точки сети. Возвращает tenantId или null, если открытых точек нет.
function renderVenuePicker(chain) {
  return new Promise((resolve) => {
    const locations = openLocations(chain);
    if (!locations.length) {
      screenEl().innerHTML = `
        <h1>${esc(chain.name || 'Сеть заведений')}</h1>
        <p class="muted">В этой сети пока нет доступных заведений.</p>`;
      resolve(null);
      return;
    }
    screenEl().innerHTML = `
      <h1>${esc(chain.name || 'Выберите заведение')}</h1>
      <p class="muted small">В каком заведении сети вы сейчас находитесь?</p>
      ${locations.map((l) => `
        <div class="card" data-venue="${esc(l.tenantId)}" style="cursor:pointer">
          <div class="row">
            <div class="grow" style="font-weight:600">${esc(l.name || l.slug)}</div>
            <div class="muted">${ic('chevron')}</div>
          </div>
        </div>`).join('')}`;
    screenEl().querySelectorAll('[data-venue]').forEach((el) => {
      el.onclick = () => resolve(el.dataset.venue);
    });
  });
}

/// Название из «Брендинга», иначе имя заведения, иначе имя платформы.
function brandDisplayName() {
  return state.brandAppName || (state.venue && state.venue.name) || 'ZalPOS';
}

/// Цвета и название заведения поверх палитры по умолчанию. Расчёт
/// CSS-переменных — в palette.js (общий с table.html и index.html).
async function applyBranding() {
  try {
    // У сети — брендинг сети, иначе тема менялась бы при смене точки.
    const snap = await getDoc(
      state.chainId ? doc(state.db, 'chains', state.chainId, 'branding', 'config')
                    : doc(state.root, 'branding', 'config')
    );
    if (!snap.exists()) return;
    const b = snap.data();
    window.applyBrandPalette(b);
    // «Hookah POS» — прежнее название платформы, сохранённое по умолчанию,
    // а не имя заведения: тогда показываем название самого заведения.
    if (b.appName && !['Hookah POS', 'Hoocah POS', 'HookahPOS'].includes(b.appName)) state.brandAppName = b.appName;

    // Кэш: index.html применит его при следующем заходе ещё до сети, и
    // страница не мелькнёт чужими цветами.
    try {
      const slug = (location.hostname.split('.')[0] || '').trim();
      if (slug) {
        localStorage.setItem('brand:' + slug, JSON.stringify({
          primaryColor: b.primaryColor, secondaryColor: b.secondaryColor,
          accentColor: b.accentColor, backgroundColor: b.backgroundColor,
          textColor: b.textColor, appName: b.appName,
        }));
      }
    } catch (_) {}
  } catch (e) {
    // Гость остаётся на цветах по умолчанию, причина — в консоли браузера.
    console.error('applyBranding() не сработал:', e);
  }
}

async function boot() {
  // Заведение и конфиг Firebase друг от друга не зависят — запрашиваем
  // параллельно.
  const tenantPromise = resolveTenant();
  // Не zalpos.ru/__/firebase/init.json: для поддомена это чужой origin, и
  // Firebase Hosting не отдаёт на него CORS.
  const configPromise = fetch(`${GATEWAY}/firebaseConfig`)
    .then((res) => res.json().then((json) => ({ ok: res.ok, json })));

  let resolved;
  try {
    resolved = await tenantPromise;
  } catch (e) {
    screenEl().innerHTML = `
      <h1>Заведение не найдено</h1>
      <p class="muted">Проверьте адрес — возможно, ссылка или QR-код
      устарели.</p>`;
    return;
  }

  let tenantId;
  let chainId = '';
  if (resolved.type === 'chain') {
    chainId = resolved.chainId;
    // Выбранную точку помним: при следующем заходе не спрашиваем снова. Если
    // её с тех пор закрыли или заблокировали — спрашиваем.
    const slug = (location.hostname.split('.')[0] || '').trim();
    const cacheKey = 'chainLocation:' + slug;
    let cached = null;
    try { cached = localStorage.getItem(cacheKey); } catch (_) {}
    if (cached && openLocations(resolved).some((l) => l.tenantId === cached)) {
      tenantId = cached;
    } else {
      tenantId = await renderVenuePicker(resolved);
      if (!tenantId) return; // renderVenuePicker уже показал экран «нет точек»
      try { localStorage.setItem(cacheKey, tenantId); } catch (_) {}
    }
  } else {
    tenantId = resolved.tenantId;
  }
  state.tenantId = tenantId;
  state.chainId = chainId;

  let config;
  try {
    const configResult = await configPromise;
    if (!configResult.ok || !configResult.json || !configResult.json.projectId) {
      throw new Error('пусто');
    }
    config = configResult.json;
  } catch (_) {
    screenEl().innerHTML = `
      <h1>Нет связи с сервером</h1>
      <p class="muted">Проверьте интернет и обновите страницу.</p>`;
    return;
  }

  const app = initializeApp(config);
  state.db = getFirestore(app);
  state.root = doc(state.db, 'tenants', tenantId);
  state.loyaltyRoot = chainId ? doc(state.db, 'chains', chainId) : state.root;

  // Меню по QR и заказ со стола — в тарифе заведения (пишет сервер,
  // читается без входа). Нет — правила гостя всё равно не пустят:
  // говорим сразу, а не ошибками на каждом экране.
  try {
    const caps = await getDoc(doc(state.root, 'public', 'features'));
    if (caps.exists() && caps.data().guestApp === false) {
      screenEl().innerHTML = `
        <h1>Меню заведения пока не работает</h1>
        <p class="muted">Заведение не подключило меню и заказ для гостей.
        Меню, заказ и бронь — у персонала заведения.</p>`;
      return;
    }
  } catch (_) {
    // Нет связи — дальше скажут экраны входа.
  }
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

    // Профиль — первым: без него правила не пускают гостя к данным заведения.
    await ensureProfile();
    await applyBranding();
    // Уровни лояльности не ждём: до их прихода действуют пороги по умолчанию.
    applyLoyaltyTiers();
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

/// Короткий ID устройства — шесть знаков без 0/O и 1/I, чтобы легко
/// продиктовать. По нему касса находит гостя, сменившего телефон. Как в
/// приложении на Android.
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
  const ref = doc(state.loyaltyRoot, 'clients', state.uid);
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
  state.accountSubs.push(onSnapshot(doc(state.loyaltyRoot, 'clients', state.uid), (d) => {
    state.profile = d.exists() ? { id: d.id, ...d.data() } : null;
    // Пока гость печатает имя или телефон, профиль не перерисовываем:
    // любое обновление профиля (запись ID устройства при первом запуске,
    // начисление бонусов кассой) иначе стирало введённое, и «Сохранить»
    // записывало пустые поля.
    if (location.hash === '#/profile' && state.profileDirty) return;
    // Экран «Мой стол» и «Главная» зависят от профиля — перерисуем.
    if (['#/', '#/table', '#/profile', ''].includes(location.hash)) route();
  }, () => {}));
}

function watchVenue() {
  state.accountSubs.push(onSnapshot(doc(state.root, 'meta', 'venueProfile'), (d) => {
    const had = !!state.venue;
    const prevType = venueType();
    const prevHookah = isHookah();
    state.venue = d.exists() ? d.data() : null;
    // Сменили тип заведения или кальяны — перерисовать экраны со словами и
    // кнопками.
    if (had && (prevType !== venueType() || prevHookah !== isHookah())) route();
    // Профиль заведения обычно приходит после первой отрисовки — экраны с
    // часами работы и правилами перерисовываем.
    if (!had && state.venue) {
      const h = location.hash;
      if (h === '#/booking' || h === '#/table' || h === '#/' || h === '') route();
    }
  }, () => {}));
}

// ---------- УРОВНИ ЛОЯЛЬНОСТИ ----------
// По умолчанию — пороги ClientProfile.tiers (lib/models/client_models.dart);
// applyLoyaltyTiers() подменяет их настройками заведения — касса считает
// по ним же.

let TIERS = [
  { name: 'Бронза', from: 0, cashback: 3 },
  { name: 'Серебро', from: 10000, cashback: 5 },
  { name: 'Золото', from: 25000, cashback: 7 },
  { name: 'Платина', from: 50000, cashback: 10 },
  { name: 'Алмаз', from: 100000, cashback: 15 },
];

/// settings/loyalty поверх порогов по умолчанию; битые данные пропускаем.
async function applyLoyaltyTiers() {
  try {
    const snap = await getDoc(doc(state.root, 'settings', 'loyalty'));
    if (!snap.exists()) return;
    const raw = snap.data().tiers;
    if (!Array.isArray(raw) || raw.length === 0) return;
    const parsed = raw
      .map((t) => ({
        name: String(t.name || '').trim(),
        from: Number(t.from) || 0,
        cashback: Number(t.cashback) || 0,
      }))
      .filter((t) => t.name)
      .sort((a, b) => a.from - b.from);
    if (parsed.length) TIERS = parsed;
  } catch (_) {
    // Нет сети/прав/документа — работаем с дефолтными порогами.
  }
}

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
  // #/t/{стол} или #/t/{стол}/{секрет стола из QR}.
  const bind = hash.match(/^#\/t\/([^/]+)(?:\/([^/]+))?$/);
  const tab = bind ? 'table' : (hash.replace('#/', '') || 'home');

  // «Ещё» — подраздел профиля, отдельной вкладки у него нет: пусть в
  // нижнем меню остаётся подсвеченным «Профиль», а не гаснет всё сразу.
  const activeTab = tab === 'extras' ? 'profile' : (tab === '' ? 'home' : tab);
  document.querySelectorAll('.tabbar a').forEach((a) => {
    a.classList.toggle('on', a.dataset.tab === activeTab);
  });
  window.scrollTo(0, 0);

  if (bind) return bindToTable(decodeURIComponent(bind[1]), bind[2] ? decodeURIComponent(bind[2]) : '');
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
    <div class="overline">${esc(brandDisplayName())}</div>
    <h1 class="display">${esc(hello)}${name ? ',<br><em>' + esc(name) + '</em>' : ''}</h1>

    <div class="card tier">
      <div class="overline">Бонусный счёт</div>
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
      <a class="btn btn-ghost" href="#/booking">${ic('calendar')}Забронировать</a>
      <a class="btn btn-ghost" href="#/menu">${ic('menu')}Меню</a>
    </div>
    <div style="height:10px"></div>
    <a class="btn btn-primary" href="#/scan">${ic('scan')}Я за столом — сканировать QR</a>
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
  sub(onSnapshot(collection(state.root, 'stories'), (snap) => {
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
        <div class="small muted">${linkify(s.text)}</div>
        ${s.actionLabel ? `<div class="small link-more">${esc(s.actionLabel)} ${ic('next')}</div>` : ''}
      </div>
    `).join('');
  }, () => { box.innerHTML = ''; }));
}

// ---------- МЕНЮ ----------

/** Уведомление под формами с именем и телефоном (ст. 18.1 152-ФЗ): кто,
 *  зачем и где обрабатывает данные. Это исполнение договора (бронь,
 *  бонусы) — отдельная галочка согласия не нужна. */
function privacyNotice(action) {
  return `<p class="small muted" style="margin:10px 0 0">Нажимая «${esc(action)}», вы соглашаетесь, что заведение
    обработает ваше имя и телефон для брони и бонусной программы. Данные сначала записываются на сервер
    в России, копия хранится в облаке Google для работы приложения.
    <a href="https://zalpos.ru/#/legal/privacy" target="_blank" rel="noopener">Политика обработки данных</a></p>`;
}

// 15-ФЗ: табак нельзя рекламировать и продавать дистанционно, а в месте
// продажи его показывают списком без изображений. Поэтому вне заведения
// табачных позиций в меню не видно, а за столом они идут без фото.
const TOBACCO_RE = /кальян|табак|никотин|hookah|shisha|снюс|вейп|сигар/i;

function screenMenu() {
  screenEl().innerHTML = `<h1>Меню</h1><div id="menu"><div class="spinner"></div></div>`;

  let cats = [];
  let items = [];
  // Как в кассе: null — плитки категорий, id — открытая категория,
  // '__tobacco' — перечень табака.
  let activeCat = null;
  let search = '';

  const draw = () => {
    const box = $('menu');
    if (!box) return;
    if (!items.length) {
      box.innerHTML = `<p class="muted">Меню пока пустое.</p>`;
      return;
    }
    const atTable = !!(state.profile && state.profile.activeSessionId);
    const catName = (id) => (cats.find((c) => c.id === id) || {}).name || '';
    const tobacco = (i) => i.tobacco === true || TOBACCO_RE.test(i.name || '') || TOBACCO_RE.test(catName(i.categoryId));
    const regular = items.filter((i) => !tobacco(i));
    // Табак — только гостю за столом: продавать его дистанционно нельзя.
    // Показываем отдельным строгим перечнем (ст. 19 закона № 15-ФЗ): чёрные
    // буквы одного размера на белом, по алфавиту, с ценой, без изображений.
    const tobaccoItems = atTable ? items.filter(tobacco) : [];
    const hidden = atTable ? 0 : items.length - regular.length;

    // Категории в порядке справочника; позиции без категории — «Прочее».
    const sections = [];
    const known = new Set();
    cats.forEach((c) => {
      known.add(c.id);
      const list = regular.filter((i) => i.categoryId === c.id);
      if (list.length) sections.push({ id: c.id, name: c.name || '', imageUrl: c.imageUrl || '', items: list });
    });
    const rest = regular.filter((i) => !known.has(i.categoryId));
    if (rest.length) sections.push({ id: '__other', name: 'Прочее', imageUrl: '', items: rest });
    if (activeCat === '__tobacco' ? !tobaccoItems.length : activeCat && !sections.some((s) => s.id === activeCat)) {
      activeCat = null;
    }

    const isHit = (i) => Number(i.popularRank) > 0 && Number(i.popularRank) <= 5;
    const qtyControls = (i) => `
              <div class="qty">
                ${state.cart[i.id] ? `
                  <button data-minus="${esc(i.id)}">−</button>
                  <span>${state.cart[i.id]}</span>` : ''}
                <button data-plus="${esc(i.id)}">+</button>
              </div>`;
    const itemCard = (i) => `
      <div class="mcard${state.cart[i.id] ? ' on' : ''}">
        <div class="mphoto">${i.imageUrl ? `<img src="${esc(i.imageUrl)}" alt="" loading="lazy">` : ''}
          ${isHit(i) ? '<span class="hit">Хит</span>' : ''}</div>
        <div class="mbody">
          <div class="mname">${esc(i.name)}</div>
          ${i.description ? `<div class="small muted mdesc">${esc(i.description)}</div>` : ''}
          <div class="mfoot"><b class="mprice">${money(i.price)}</b>${atTable ? qtyControls(i) : ''}</div>
        </div>
      </div>`;
    const tobaccoBlock = (list) => `
      <div class="tobacco-list">
        <p>Табачная и никотинсодержащая продукция, кальяны. Продажа лицам младше 18 лет запрещена.</p>
        ${[...list].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru')).map((i) => `
          <div class="tobacco-row">
            <span class="name">${esc(i.name)} — <span class="nowrap">${money(i.price)}</span></span>
            ${qtyControls(i)}
          </div>`).join('')}
      </div>`;
    const backBar = (title) => `
      <div class="backbar"><button data-back aria-label="Все категории">${ic('back')}</button><h2>${esc(title)}</h2></div>`;

    const q = search.trim().toLowerCase();
    let body;
    if (q) {
      // Поиск — по всему меню сразу, как в кассе.
      const match = (i) => String(i.name || '').toLowerCase().includes(q)
        || String(i.description || '').toLowerCase().includes(q);
      const found = regular.filter(match);
      const foundTobacco = tobaccoItems.filter(match);
      body = found.length || foundTobacco.length
        ? `<div class="mgrid">${found.map(itemCard).join('')}</div>${foundTobacco.length ? tobaccoBlock(foundTobacco) : ''}`
        : '<p class="muted">Ничего не найдено.</p>';
    } else if (activeCat === '__tobacco') {
      body = backBar('Табак и кальяны') + tobaccoBlock(tobaccoItems);
    } else if (activeCat) {
      const s = sections.find((x) => x.id === activeCat);
      body = `${backBar(s.name)}<div class="mgrid">${s.items.map(itemCard).join('')}</div>`;
    } else {
      const hits = regular.filter(isHit).sort((a, b) => Number(a.popularRank) - Number(b.popularRank));
      body = `
        ${hits.length ? `<h2 class="mh">Популярное</h2><div class="mstrip">${hits.map(itemCard).join('')}</div>` : ''}
        ${sections.length ? '<h2 class="mh">Категории</h2>' : ''}
        <div class="cgrid">${sections.map((s) => {
          const img = s.imageUrl || (s.items.find((i) => i.imageUrl) || {}).imageUrl || '';
          return `<button class="ctile" data-cat="${esc(s.id)}">
            ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : `<span class="cinitial" aria-hidden="true">${esc((s.name || '').trim().charAt(0))}</span>`}
            <span class="cname">${esc(s.name)}<small>${s.items.length} ${plural(s.items.length, 'позиция', 'позиции', 'позиций')}</small></span>
          </button>`;
        }).join('')}</div>
        ${tobaccoItems.length ? `<button class="tobacco-tile" data-cat="__tobacco">Табачная и никотинсодержащая
          продукция, кальяны — перечень. Продажа лицам младше 18 лет запрещена.</button>` : ''}
        ${hidden ? `<p class="small muted">Часть позиций (18+) видна только в заведении,
          когда вы за столом.</p>` : ''}`;
    }

    box.innerHTML = `
      <input id="menuSearch" class="msearch" type="search" placeholder="Поиск по меню" value="${esc(search)}">
      ${body}
      ${atTable ? cartBlock(items) : `
        <p class="small muted">Чтобы заказать из приложения, откройте свой
        стол — отсканируйте QR-код на столе камерой телефона.</p>`}
    `;

    const input = $('menuSearch');
    input.oninput = () => {
      search = input.value;
      draw();
      const again = $('menuSearch');
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    };
    box.querySelectorAll('[data-cat]').forEach((el) => {
      el.onclick = () => { activeCat = el.dataset.cat; draw(); window.scrollTo(0, 0); };
    });
    box.querySelectorAll('[data-back]').forEach((el) => {
      el.onclick = () => { activeCat = null; draw(); };
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

  sub(onSnapshot(query(collection(state.root, 'menuCategories'), orderBy('order')), (s) => {
    cats = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  }, () => {}));

  sub(onSnapshot(collection(state.root, 'menuItems'), (s) => {
    items = s.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((i) => i.available !== false)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
    draw();
  }, () => {}));
}

function cartBlock(items = []) {
  const ids = Object.keys(state.cart);
  if (!ids.length) return '';
  // Итог видно из любой категории: гость ходит по плиткам и не должен
  // вспоминать, что уже выбрал.
  const count = ids.reduce((n, id) => n + state.cart[id], 0);
  const total = ids.reduce((sum, id) => sum + (Number(items.find((i) => i.id === id)?.price) || 0) * state.cart[id], 0);
  return `
    <div class="card">
      <div style="font-weight:600;margin-bottom:8px">Ваш заказ: ${count} ${plural(count, 'позиция', 'позиции', 'позиций')} · ${money(total)}</div>
      <div class="small muted" style="margin-bottom:12px">
        ${cap(staffWord('nom'))} подтвердит заказ, и позиции появятся в счёте.
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
    // Стол — из самого чека: гостя могли пересадить, а стол в профиле ещё
    // прежний. Без имени стола персонал видел заказ как «Стол · …» и не
    // знал, куда нести.
    let tableId = p.activeTableId || '';
    let tableName = '';
    try {
      const ses = await getDoc(doc(state.root, 'sessions', p.activeSessionId));
      if (ses.exists()) {
        tableId = ses.data().tableId || tableId;
        tableName = ses.data().tableName || '';
      }
    } catch (_) { /* не критично — заказ всё равно уйдёт с id стола */ }
    await addDoc(collection(state.root, 'guestOrders'), {
      sessionId: p.activeSessionId,
      tableId,
      tableName,
      clientUid: state.uid,
      guestName: p.name || '',
      items: chosen,
      comment: '',
      status: 'new',
      rejectReason: '',
      createdAt: Timestamp.fromDate(new Date()),
    });
    state.cart = {};
    toast(`Заказ передан ${staffWord('dat')}`);
    if (state.orderFromTable) {
      state.orderFromTable = false;
      location.hash = '#/table';
    } else {
      redraw();
    }
  } catch (e) {
    toast('Не удалось отправить заказ');
  }
}

// ---------- МОЙ СТОЛ ----------

/// Привязка к столу по ссылке из QR: /app/#/t/{tableId}/{секрет стола}
///
/// Логика та же, что в приложении на Android, и та же защита: чек
/// закрепляется за первым, кто его занял (документ sessionClaims), и
/// второму телефону база просто откажет в записи. Секрет стола есть только
/// на наклейке: без него чужой чек удалённо не занять.
async function bindToTable(tableId, tableKey = '') {
  screenEl().innerHTML = `<h1>Открываем стол…</h1><div class="spinner"></div>`;
  try {
    // Без номера за стол не пускаем, как и в приложении: по нему кассир
    // находит гостя. Профиль читаем напрямую — сразу после перехода по
    // ссылке watchProfile() ещё не получил первый снапшот.
    const own = await getDoc(doc(state.loyaltyRoot, 'clients', state.uid));
    if (!(own.exists() && own.data().phone)) {
      screenEl().innerHTML = `
        <h1>Сначала укажите номер</h1>
        <p class="muted small">Чтобы сесть за стол, добавьте номер телефона в профиле —
          это нужно, чтобы кассир мог найти вас при брони и переносе бонусов.</p>
        <a class="btn btn-primary" href="#/profile">Открыть профиль</a>`;
      return;
    }

    const t = await getDoc(doc(state.root, 'tables', tableId));
    if (!t.exists()) return failBind('Такого стола нет. Отсканируйте код ещё раз.');
    const data = t.data();
    const checks = (data.openChecks || []).filter((c) => c && c.id);
    const ids = data.activeSessionIds || [];

    if (!ids.length) {
      return failBind('За этим столом сейчас нет открытого счёта — '
        + `попросите ${staffWord('acc')} открыть стол.`);
    }

    // Несколько счетов за столом — гость выбирает свой. Чужие показываем,
    // но выбрать не даём: так же, как в приложении на Android.
    if (checks.length > 1) {
      const marked = await markTakenChecks(checks);
      return chooseCheck(tableId, data.name || '', marked, tableKey);
    }

    const sessionId = checks.length === 1 ? checks[0].id : ids[ids.length - 1];
    await claimSession(tableId, sessionId, tableKey);
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
      const d = await getDoc(doc(state.root, 'sessionClaims', c.id));
      const owner = d.exists() ? (d.data().uid || '') : '';
      return { ...c, taken: !!owner && owner !== state.uid };
    } catch (_) {
      return { ...c, taken: false }; // не проверили — не мешаем сесть
    }
  }));
}

/** Заголовок стола: имя обычно уже «Стол 2» — не превращаем в «Стол Стол 2». */
function tableTitle(name) {
  const n = String(name || '').trim();
  if (!n) return 'Ваш стол';
  return /^стол/i.test(n) ? n : 'Стол ' + n;
}

function chooseCheck(tableId, tableName, checks, tableKey = '') {
  screenEl().innerHTML = `
    <h1 class="t-title">${esc(tableTitle(tableName))}</h1>
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
            <div class="muted">${ic(c.taken ? 'lock' : 'chevron')}</div>
          </div>
        </div>`;
    }).join('')}`;

  screenEl().querySelectorAll('[data-check]').forEach((el) => {
    el.onclick = () => claimSession(tableId, el.dataset.check, tableKey);
  });
}

async function claimSession(tableId, sessionId, tableKey = '') {
  try {
    // Документ создаётся, только если его ещё нет: правила базы не дадут
    // переписать чужой. Поэтому при одновременном сканировании с двух
    // телефонов выигрывает ровно один. Стол и его секрет сверяют правила.
    await setDoc(doc(state.root, 'sessionClaims', sessionId),
      { uid: state.uid, tableId, ...(tableKey ? { key: tableKey } : {}) });
  } catch (e) {
    // Отказ правил: счёт уже чужой или код со стола устарел. Любая другая
    // ошибка это просто нет связи, и говорить гостю «стол занят» неправда:
    // он пойдёт разбираться к кальянщику вместо того, чтобы повторить попытку.
    if (e && e.code === 'permission-denied') {
      const [taken] = await markTakenChecks([{ id: sessionId }]);
      if (!taken.taken) {
        return failBind('Код на этом столе устарел — отсканируйте QR прямо на столе ещё раз. '
          + `Если не выходит, попросите ${staffWord('acc')} открыть вам счёт.`);
      }
      return failBind('Этот счёт уже открыт у другого гостя. '
        + `Если это ваш стол — попросите ${staffWord('acc')} открыть вам свой счёт.`);
    }
    return failBind('Не удалось открыть стол. Проверьте интернет и попробуйте ещё раз.');
  }
  try {
    await setDoc(doc(state.loyaltyRoot, 'clients', state.uid), {
      activeSessionId: sessionId,
      activeTableId: tableId,
      // Профиль сети общий, а чек — в конкретной точке: по activeTenantId
      // правила проверяют sessionClaims этой точки.
      ...(state.chainId ? { activeTenantId: state.tenantId } : {}),
      lastVisitAt: Timestamp.fromDate(new Date()),
    }, { merge: true });
  } catch (e) {
    return failBind('Не удалось закрепить стол за вами. Попробуйте ещё раз.');
  }

  // Подписываем чек именем гостя, если подписи ещё нет, — кассир видит на
  // плитке зала, кто сел. Не вышло — не страшно.
  try {
    const own = await getDoc(doc(state.loyaltyRoot, 'clients', state.uid));
    const name = (own.exists() ? (own.data().name || '') : '').trim();
    if (name) {
      const sessionRef = doc(state.root, 'sessions', sessionId);
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

  sub(onSnapshot(doc(state.root, 'sessions', sessionId), (d) => {
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
    <p class="muted">Отсканируйте QR-код на своём столе — откроются счёт${isHookah() ? `,
    таймер сеанса` : ''} и кнопки вызова ${staffWord('acc')}.</p>
    <a class="btn btn-primary" href="#/scan">${ic('scan')}Сканировать QR стола</a>
    <div style="height:10px"></div>
    <a class="btn btn-ghost" href="#/hall">${ic('plan')}Карта зала</a>
    <div style="height:14px"></div>
    <p class="small muted">Стол открывается только по коду с самого стола —
    так вы наверняка попадёте на свой счёт, а не на соседний. Если код не
    сканируется, позовите ${staffWord('acc')}: он откроет стол сам.</p>
    ${rules.length ? `
      <div class="card" style="margin-top:22px">
        <div class="row" style="font-weight:600;margin-bottom:12px">${ic('info', 'gold')}Правила заведения</div>
        ${rules.map((r) => `<div class="rule"><i></i><div class="small muted">${esc(r)}</div></div>`).join('')}
      </div>` : ''}`;
}

function drawTable(s) {
  const items = s.orderItems || [];
  const total = items.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
  const discount = Number(s.discountPercent) || 0;
  const bonus = Number((state.profile || {}).bonusBalance) || 0;
  const hookah = isHookah();
  const plannedEnd = toDate(s.plannedEnd);
  // Таймер — только кальянной и только если время сеанса ограничено:
  // у стола «без ограничений» конец через десять лет.
  const showTimer = hookah && plannedEnd && plannedEnd - new Date() < 365 * 24 * 3600 * 1000;
  const tipsOn = (state.venue || {}).tipsEnabled !== false;

  screenEl().innerHTML = `
    <div class="row">
      <h1 class="t-title grow ellipsis">${esc(tableTitle(s.tableName))}</h1>
      <button class="btn-link" id="unbind">Это не мой стол</button>
    </div>

    ${showTimer ? `<div class="card timer" id="timer"><div class="value">—</div></div>` : ''}

    <button class="btn-primary" id="orderFromTable">${ic('cloche')}Сделать заказ</button>
    <p class="small muted" style="margin:8px 0 0">Блюда и напитки — прямо к столу:
    ${staffWord('nom')} подтвердит заказ, и он появится в счёте.</p>

    <h2>Позвать</h2>
    ${hookah ? `
    <div class="btn-row">
      <button class="btn-ghost" data-call="coal">${ic('flame')}Поменять угли</button>
      <button class="btn-ghost" data-call="refill">${ic('refresh')}Перезабивка</button>
    </div>
    <div style="height:10px"></div>
    <div class="btn-row">
      <button class="btn-ghost" data-call="waiter">${ic('hand')}Позвать кальянщика</button>
      <button class="btn-ghost" data-call="bill">${ic('receipt')}Счёт, пожалуйста</button>
    </div>
    <div style="height:10px"></div>
    <button class="btn-ghost" data-call="callWaiter">${ic('bell')}Позвать официанта</button>` : `
    <div class="btn-row">
      <button class="btn-ghost" data-call="callWaiter">${ic('bell')}Позвать официанта</button>
      <button class="btn-ghost" data-call="bill">${ic('receipt')}Счёт, пожалуйста</button>
    </div>`}
    <div id="calls"></div>

    <h2>Ваш счёт</h2>
    <div class="card">
      ${items.length ? items.map((i) => `
        <div class="bill-line">
          <span class="grow">${esc(i.name)} ×${Number(i.qty) || 0}</span>
          <span class="muted">${money((Number(i.price) || 0) * (Number(i.qty) || 0))}</span>
        </div>`).join('') + `
        ${discount > 0 ? `<div class="bill-line" style="color:var(--gold)">
          <span class="grow">Скидка ${Math.round(discount)}%</span>
          <span>−${money(total * discount / 100)}</span></div>` : ''}
        <div class="bill-total"><span>Итого</span><span>${money(total * (1 - discount / 100))}</span></div>
        ${bonus >= 1 ? `<div class="small" style="color:var(--gold);margin-top:10px">
          Доступно бонусов: ${money(bonus)} — скажите ${staffWord('dat')}, чтобы списать при оплате</div>` : ''}
      ` : `<p class="muted small" style="margin:0">Пока пусто — нажмите «Сделать заказ»</p>`}
    </div>

    ${tipsOn ? `<h2>Чаевые</h2><div class="card"><div id="tipsPanel"></div></div>` : ''}

    <div id="orders"></div>
  `;

  if (state.ticker) { clearInterval(state.ticker); state.ticker = null; }
  if (showTimer) {
    const tick = () => {
      const box = $('timer');
      if (!box) return;
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
  }

  $('unbind').onclick = unbind;
  // Заказ со стола — меню с корзиной; после отправки гость вернётся к
  // столу и увидит статус заказа.
  $('orderFromTable').onclick = () => { state.orderFromTable = true; location.hash = '#/menu'; };
  screenEl().querySelectorAll('[data-call]').forEach((el) => {
    el.onclick = () => callStaff(el.dataset.call, s, el);
  });

  state.tips.session = s;
  if (state.tableWatch !== s.id) {
    state.tableWatch = s.id;
    watchCalls();
    watchOrders(s.id);
    if (tipsOn) watchTips(s.id);
  } else {
    paintCalls();
    paintOrders(s.id);
  }
  paintTips();
}

const CALL_LABELS = {
  coal: 'Поменять угли',
  refill: 'Перезабивка',
  waiter: 'Позвать кальянщика',
  bill: 'Счёт, пожалуйста',
  callWaiter: 'Позвать официанта',
};

async function callStaff(type, s, btn) {
  const label = CALL_LABELS[type] || 'Вызов';
  // Не ждём ответа сервера: запись уходит сразу, а гость видит отклик
  // мгновенно. Иначе на слабой связи кнопка «висит», и её жмут повторно.
  addDoc(collection(state.root, 'waiterCalls'), {
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
  // Счёт и официанта получает официант, остальное — кальянщик.
  const toWhom = type === 'bill' || type === 'callWaiter' ? 'официанту' : staffWord('dat');
  toast(`${label} — передали ${toWhom}`);
  // Через минуту разрешаем позвать снова: кальянщик мог не услышать.
  setTimeout(() => { btn.disabled = false; btn.innerHTML = original; }, 60000);
}

function watchCalls() {
  sub(onSnapshot(
    query(collection(state.root, 'waiterCalls'), where('clientUid', '==', state.uid)),
    (snap) => {
      state.tableCache.calls = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      paintCalls();
    }, () => {}));
}

function paintCalls() {
  const box = $('calls');
  if (!box) return;
  const fresh = Date.now() - 30 * 60 * 1000;
  const list = state.tableCache.calls
    .filter((c) => c.status === 'new')
    .filter((c) => { const t = toDate(c.createdAt); return t && t.getTime() > fresh; })
    .sort((a, b) => toDate(b.createdAt) - toDate(a.createdAt))
    .slice(0, 4);
  box.innerHTML = list.map((c) => {
    const t = toDate(c.createdAt);
    return `<div class="row small muted" style="margin-top:8px">
      <span style="color:var(--primary)">${ic('check')}</span>
      <span>${esc(CALL_LABELS[c.type] || 'Вызов')} — передали в ${t ? hhmm(t) : ''}</span>
    </div>`;
  }).join('');
}

function watchOrders(sessionId) {
  sub(onSnapshot(
    query(collection(state.root, 'guestOrders'), where('clientUid', '==', state.uid)),
    (snap) => {
      state.tableCache.orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      paintOrders(sessionId);
    }, () => {}));
}

function paintOrders(sessionId) {
  const box = $('orders');
  if (!box) return;
  const list = state.tableCache.orders
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
}

async function unbind() {
  const p = state.profile || {};
  const sid = p.activeSessionId;
  // Именно удаление, а не «обнулить uid»: правила разрешают владельцу
  // удалить свою метку, но не переписать её на чужой (иначе чек можно
  // было бы увести). Пустой uid — тоже чужой.
  try { if (sid) await deleteDoc(doc(state.root, 'sessionClaims', sid)); } catch (_) {}
  try {
    await setDoc(doc(state.loyaltyRoot, 'clients', state.uid), {
      activeSessionId: '', activeTableId: '',
      ...(state.chainId ? { activeTenantId: '' } : {}),
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
    <p class="muted">Счёт (${esc(tableTitle(s.tableName))}) закрыт на ${money(total)}.</p>
    <h2>Как всё прошло?</h2>
    <div class="card">
      <div class="stars" id="stars">
        ${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-star="${i}" aria-label="${i} из 5">${ic('star')}</button>`).join('')}
      </div>
      <textarea id="reviewText" rows="3" maxlength="2000" placeholder="Что понравилось, что нет (необязательно)" style="margin-top:14px"></textarea>
      <button class="btn-primary" id="sendReview" disabled>Отправить отзыв</button>
    </div>`;

  let rating = 0;
  const paint = () => {
    screenEl().querySelectorAll('[data-star]').forEach((el) => {
      el.classList.toggle('on', Number(el.dataset.star) <= rating);
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
      await addDoc(collection(state.root, 'reviews'), {
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
// Как в приложении: день, число гостей, длительность и сетка свободного
// времени из часов работы и занятости столов — в нерабочий час
// забронировать нельзя.

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
  const win = workingWindow(day);
  const todayHours = workingWindow(new Date());

  screenEl().innerHTML = `
    <h1>Бронь стола</h1>
    ${todayHours
      ? `<p class="small" style="color:var(--gold);margin-bottom:16px">Работаем ${esc(todayHours.raw)}</p>`
      : `<p class="small muted">Часы работы не заданы — уточните у ${staffWord('acc')}.</p>`}

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
    <div id="slots">${win ? '<div class="spinner"></div>'
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
          ? ic('lock', 'inline') + 'Номер привязан — сменить его можно только через администратора'
          : 'Укажите номер в любом формате: +7, 8 или просто 9…'}</p>

      <label class="field"><span>Стол</span></label>
      <div class="row" style="margin:-6px 0 12px">
        <div class="grow small ${pickedTable ? '' : 'muted'}">
          ${pickedTable ? esc(pickedTable.name) : 'Любой свободный — подберём сами'}
        </div>
        <a class="btn-link" href="#/hall/pick" style="width:auto">
          ${pickedTable ? 'Изменить' : 'Выбрать на карте'}</a>
      </div>
      ${pickedTable ? `<button class="btn-ghost" id="bClearTable"
        style="margin-bottom:12px">Убрать выбор стола</button>` : ''}

      <label class="field"><span>Пожелания (необязательно)</span>
        <input id="bComment" placeholder="Диван у окна, день рождения, без музыки…"></label>
      <button class="btn-primary" id="bSend">Отправить заявку</button>
      ${privacyNotice('Отправить заявку')}
      <p class="small muted center" style="margin:12px 0 0">
        Мы подтвердим бронь и закрепим стол.</p>
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
  if (win) loadSlots(day, win);
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
async function loadSlots(day, win) {
  const box = $('slots');
  if (!box) return;

  let tables = [];
  let slots = [];
  try {
    const from = new Date(win.open.getTime() - 14 * 60 * 60 * 1000);
    const to = new Date(win.open.getTime() + 26 * 60 * 60 * 1000);
    const [tSnap, sSnap] = await Promise.all([
      getDocs(collection(state.root, 'tables')),
      getDocs(query(collection(state.root, 'reservationSlots'),
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
  const lastStart = new Date(win.close.getTime() - duration * 60 * 1000);

  const free = [];
  for (let cur = new Date(win.open); cur <= lastStart;
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
    getDocs(collection(state.root, 'tables')),
    getDocs(query(collection(state.root, 'reservationSlots'),
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
    // Стол назначаем всегда, как в приложении: не выбран — подбираем сами,
    // выбран — перепроверяем, пока гость листал карту, его могли занять.
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

    // Имя и телефон — сначала на сервер в РФ, потом документ брони.
    const ref = doc(collection(state.root, 'reservations'));
    await piiPost({ tenantId: state.tenantId, kind: 'reservation', id: ref.id, name, phone });
    await setDoc(ref, {
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
      await setDoc(doc(state.root, 'reservationSlots', ref.id), {
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
          + `На этот номер уже есть профиль. Назовите ${staffWord('dat')} номер и `
          + '«ID устройства» из профиля — он объединит их на кассе. '
          + 'Бронь при этом уже отправлена.');
      } else {
        patch.phone = phone;
        try {
          await setDoc(doc(state.loyaltyRoot, 'phoneIndex', phone), { uid: state.uid });
        } catch (_) {}
      }
    }
    // Профиль гостя (имя/телефон) пишет сервер в РФ и сам зеркалит в
    // Firestore — напрямую в базу за рубежом эти поля не пишем.
    try {
      await piiPost({ tenantId: state.tenantId, uid: state.uid, ...patch });
    } catch (_) {
      // Бронь уже сохранена; профиль обновится при следующем визите.
    }
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
    query(collection(state.root, 'reservations'), where('clientUid', '==', state.uid)),
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
                  ${r.tableName ? '· ' + esc(tableTitle(r.tableName)) : ''}</div>
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
            await updateDoc(doc(state.root, 'reservations', el.dataset.cancel), { status: 'cancelled' });
            // Снимаем занятость стола: иначе отменённая бронь продолжала
            // бы держать его в карте зала у других гостей.
            try {
              await setDoc(doc(state.root, 'reservationSlots', el.dataset.cancel),
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
            await updateDoc(doc(state.root, 'reservations', el.dataset.come), { guestConfirmed: true });
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

/// Плашка «Бронь скоро — придёте?». Напоминаний по расписанию браузер не
/// умеет, так что спрашиваем, когда гость открыл страницу. «Не приду» сразу
/// отменяет бронь, и стол успевают отдать.
function renderBookingSoon(boxId) {
  // Перерисовываем по таймеру: плашка зависит от текущего времени, а
  // страницу могут держать открытой час.
  let draw = () => {};
  const tick = setInterval(() => draw(), 30 * 1000);
  sub(() => clearInterval(tick));

  sub(onSnapshot(
    query(collection(state.root, 'reservations'), where('clientUid', '==', state.uid)),
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
        <span style="color:var(--gold)">${ic('calendar')}</span>
        <div class="grow" style="font-weight:700">
          ${left > 0 ? `Бронь через ${left} ${minutesWord(left)}` : 'Ваша бронь уже началась'}
        </div>
      </div>
      <div class="small muted" style="margin-top:6px">
        ${hhmm(t)}${r.tableName ? ', ' + esc(tableTitle(r.tableName)) : ''} ·
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
      await updateDoc(doc(state.root, 'reservations', r.id), { guestConfirmed: true });
      toast('Спасибо, ждём вас');
    } catch (_) { toast('Не удалось отметить'); e.target.disabled = false; }
  };
  box.querySelector('[data-nocome]').onclick = async (e) => {
    e.target.disabled = true;
    try {
      await updateDoc(doc(state.root, 'reservations', r.id), { status: 'cancelled' });
      try {
        await setDoc(doc(state.root, 'reservationSlots', r.id),
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
          ? ic('lock', 'inline') + 'Сменить номер можно только через администратора'
          : 'Укажите номер в любом формате: +7, 8 или просто 9…'}</p>
      <button class="btn-primary" id="pSave">Сохранить</button>
      ${privacyNotice('Сохранить')}
    </div>

    <div class="card" style="border-color:color-mix(in srgb, var(--gold) 45%, transparent)">
      <div class="row" style="align-items:flex-start">
        <span style="color:var(--gold)">${ic('info')}</span>
        <div class="grow small muted">
          Бонусы копятся на этом устройстве и находятся по вашему номеру на
          кассе. Сменили телефон — назовите номер и покажите ID устройства
          ниже ${staffWord('dat')}, и мы перенесём историю визитов.
        </div>
      </div>
      <div id="deviceId" style="margin-top:12px;background:var(--inset, rgba(0,0,0,.25));
        border-radius:10px;padding:11px 12px;display:flex;align-items:center;
        gap:8px;cursor:pointer">
        <span class="muted">${ic('card')}</span>
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

    ${state.chainId ? `
      <p class="center" style="margin-top:20px">
        <button class="btn-ghost" id="switchVenueBtn">Сменить заведение сети</button>
      </p>` : ''}

    <p class="center" style="margin-top:20px">
      <button class="btn-link" id="deleteDataBtn" style="color:var(--muted);font-weight:500;width:auto;margin:0 auto">Удалить мои данные</button>
    </p>

    <p class="small muted center" style="margin-top:28px">
      ${esc(brandDisplayName())} · веб-версия</p>`;

  $('pSave').onclick = saveProfile;
  $('deleteDataBtn').onclick = deleteMyData;
  state.profileDirty = false;
  ['pName', 'pPhone'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('input', () => { state.profileDirty = true; });
  });
  if (state.chainId) {
    // Забываем выбранную точку и перезагружаем страницу — boot() спросит заново.
    $('switchVenueBtn').onclick = () => {
      // Открытый стол останется в прежней точке, и «Мой стол» его не
      // покажет — предупреждаем.
      if ((state.profile || {}).activeSessionId) {
        const ok = confirm('У вас сейчас открыт стол в этом заведении. После '
          + 'смены заведения приложение перестанет его показывать (сам счёт '
          + `останется открытым, закрыть его сможет ${staffWord('nom')}). Сменить всё равно?`);
        if (!ok) return;
      }
      try {
        const slug = (location.hostname.split('.')[0] || '').trim();
        localStorage.removeItem('chainLocation:' + slug);
      } catch (_) {}
      location.reload();
    };
  }
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

/// История бонусов. orderBy обязателен: без него limit(50) берёт первые
/// документы по id, и свежие начисления постоянного гостя не попадали.
function watchBonusOps() {
  sub(onSnapshot(
    query(collection(state.loyaltyRoot, 'bonusOperations'),
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
        // Возврат ранее списанных бонусов — тоже плюс на счёт.
        const plus = v.type === 'accrual' || v.type === 'redeem_cancelled';
        // У начисления за визит в amount — оплаченная сумма, бонусы — в bonus.
        const amount = Number(v.bonus ?? v.amount) || 0;
        const when = toDate(v.createdAt);
        return `
          <div class="row" style="padding:10px 0;border-bottom:1px solid var(--border)">
            <span style="color:${plus ? 'var(--primary)' : 'var(--warning)'}">
              ${plus ? '⊕' : '⊖'}</span>
            <div class="grow">
              <div>${esc(bonusReason(v.reason, plus, v.type))}</div>
              <div class="small muted">${when ? dmyy(when) : ''}</div>
            </div>
            <div style="font-weight:700;color:${plus ? 'var(--primary)' : 'var(--warning)'}">
              ${plus ? '+' : '−'}${Math.round(Math.abs(amount))}</div>
          </div>`;
      }).join('');
    },
    () => {
      const box = $('bonusOps');
      if (box) box.innerHTML = '<p class="muted small">Не удалось загрузить историю</p>';
    }));
}

/// Человеческая подпись к бонусной операции — те же слова, что в приложении.
function bonusReason(reason, plus, type) {
  switch (reason) {
    case 'referral_invitee': return 'Бонус за код друга';
    case 'referral_inviter': return 'Друг дошёл до нас';
    case 'giftCard': return 'Сертификат активирован';
    case 'birthday': return 'Подарок ко дню рождения';
    case 'refund': return plus ? 'Возврат чека: бонусы вернулись' : 'Возврат чека: бонусы за визит отменены';
    case 'refund_undone': return plus ? 'Возврат отменён: бонусы за визит' : 'Возврат отменён: бонусы списаны снова';
    case 'visit': return 'Начисление за визит';
  }
  if (type === 'redeem_cancelled') return 'Оплата бонусами отменена';
  return plus ? 'Начисление за визит' : 'Списание бонусов';
}

/// Занят ли номер ДРУГИМ профилем. Чтение одного документа по id —
/// запрос по коллекции гостю правила базы не разрешают.
async function phoneTakenByOther(phone) {
  if (!phone) return false;
  try {
    const idx = await getDoc(doc(state.loyaltyRoot, 'phoneIndex', phone));
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

  // Кнопку возвращаем в finally при любом исходе.
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
          + `появились на этом устройстве, назовите ${staffWord('dat')} номер и `
          + '«ID устройства» ниже — он объединит профили на кассе за пару '
          + 'секунд.');
        return;
      }
    }

    const patch = { name: $('pName').value.trim() };
    if (!locked && phone) patch.phone = phone;
    // Имя и телефон — сначала в базу в РФ, сервер сам копирует их в профиль
    // Firestore. Напрямую в облако эти поля не пишем.
    await piiPost({ tenantId: state.tenantId, uid: state.uid, ...patch });
    // Введённое сохранено — профиль можно перерисовать (номер станет
    // «только для чтения»). Обновление профиля могло прийти, пока шло
    // сохранение, и тогда было пропущено — перерисовываем сами.
    state.profileDirty = false;
    if (location.hash === '#/profile' && patch.phone && (state.profile || {}).phone) route();
    if (patch.phone) {
      // Указатель «номер → гость» вторичен: его осечка профилю не мешает.
      try { await setDoc(doc(state.loyaltyRoot, 'phoneIndex', phone), { uid: state.uid }); } catch (_) {}
    }
    toast('Сохранено');
  } catch (_) {
    toast('Не удалось сохранить: проверьте интернет и попробуйте снова');
  } finally {
    const b = $('pSave');
    if (b) { b.disabled = false; b.textContent = 'Сохранить'; }
  }
}

/// Гость удаляет свои данные сам и сразу (152-ФЗ): сначала первичная база
/// в РФ (pii-gateway), потом облако (saas-gateway /deleteGuestData). Сервер
/// удаляет и анонимный аккаунт — выходим, и onAuthStateChanged заводит новый.
async function deleteMyData() {
  const ok = confirm('Удалить мои данные?\n\nВаше имя, номер телефона и день рождения сразу удалятся '
    + 'из профиля, броней и заказов, а бонусы сгорят. Отменить это нельзя.');
  if (!ok) return;
  const btn = $('deleteDataBtn');
  if (btn) btn.disabled = true;
  try {
    // Открытый счёт проверяем до всего: сервер откажет, а данные в базе в РФ
    // к тому моменту уже были бы стёрты — профиль и база разошлись бы.
    const sid = (state.profile || {}).activeSessionId || '';
    if (sid) {
      const ses = await getDoc(doc(state.root, 'sessions', sid)).catch(() => null);
      if (ses && ses.exists() && ses.data().status === 'active') {
        toast('У вас открыт счёт за столом — удалить данные можно после его закрытия');
        if (btn) btn.disabled = false;
        return;
      }
    }
    await piiPost({ tenantId: state.tenantId, kind: 'guest_delete' });
    const token = await state.auth.currentUser.getIdToken();
    const res = await fetch(`${GATEWAY}/deleteGuestData`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tenantId: state.tenantId }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(json.error || 'Не удалось удалить данные — попробуйте ещё раз');
      if (btn) btn.disabled = false;
      return;
    }
    await signOut(state.auth);
    toast('Ваши данные удалены');
  } catch (_) {
    toast('Не удалось удалить данные: проверьте интернет и попробуйте снова');
    if (btn) btn.disabled = false;
  }
}

function watchVisits() {
  sub(onSnapshot(
    query(collection(state.loyaltyRoot, 'clients', state.uid, 'visits'), orderBy('date', 'desc'), limit(50)),
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
                  ${v.tableName ? '· ' + esc(tableTitle(v.tableName)) : ''}</div>
                ${items ? `<div class="small muted ellipsis">${esc(items)}</div>` : ''}
              </div>
              <div style="text-align:right">
                ${v.refunded
                  ? '<div class="muted" style="font-weight:600">возврат</div>'
                  : `<div style="font-weight:600">${money(v.total)}</div>
                ${Number(v.bonusEarned) > 0
                  ? `<div class="small" style="color:var(--gold)">+${money(v.bonusEarned)}</div>` : ''}`}
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
      <a class="btn btn-ghost icon-btn" href="#/profile" aria-label="Назад">${ic('back')}</a>
      <h1 style="margin:0">Ещё</h1>
    </div>

    ${(state.venue || {}).tipsEnabled !== false ? `<div class="card">
      <div class="row"><span style="color:var(--primary)">${ic('heart')}</span>
        <b class="grow">Чаевые</b></div>
      <div id="xTips" style="margin-top:12px"></div>
    </div>` : ''}

    <div class="card">
      <div class="row"><span style="color:var(--primary)">${ic('gift')}</span>
        <b class="grow">Подарочный сертификат</b></div>
      <p class="small muted" style="margin:12px 0 0">Введите код с сертификата —
        бонусы начислим на ваш счёт.</p>
      <div class="row" style="margin-top:12px;gap:10px">
        <input id="xCard" class="grow" placeholder="KLB-XXXX-XXXX"
          autocapitalize="characters" spellcheck="false">
        <button class="btn-ghost" id="xCardBtn">Активировать</button>
      </div>
      <div id="xCardMsg" class="small" style="margin-top:10px"></div>
      <div id="xCardClaim" class="small muted" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="row"><span style="color:var(--primary)">${ic('hourglass')}</span>
        <b class="grow">Занять очередь</b></div>
      <div id="xQueue" style="margin-top:12px"><div class="spinner"></div></div>
    </div>

    <div class="card">
      <div class="row"><span style="color:var(--primary)">${ic('users')}</span>
        <b class="grow">Пригласить друга</b></div>
      <div style="margin-top:12px">
        <div id="xMyCode" style="font-size:18px;font-weight:700">Ваш код: …</div>
        <p class="small muted" style="margin:6px 0 14px">Друг называет его в
          первый визит: ему ${INVITEE_BONUS} ${plural(INVITEE_BONUS, 'бонус', 'бонуса', 'бонусов')}, вам — ${INVITER_BONUS}.</p>
        <div class="row" style="gap:10px">
          <input id="xRef" class="grow" placeholder="Код друга"
            autocapitalize="characters" spellcheck="false">
          <button class="btn-ghost" id="xRefBtn">Применить</button>
        </div>
        <div id="xRefMsg" class="small" style="margin-top:10px;color:var(--gold)"></div>
      </div>
    </div>`;

  renderExtrasTips();
  renderQueue();
  ensureReferralCode();
  $('xCardBtn').onclick = activateGiftCard;
  watchGiftClaims();
  $('xRefBtn').onclick = applyReferralCode;
}

// ---------- ЧАЕВЫЕ ----------
//
// Гость выбирает, КОМУ — любому, кто сейчас на смене (meta/tipsTeam ведёт
// касса), или всей смене сразу, — и СКОЛЬКО: процент от счёта или своя
// сумма. «Добавить к счёту» — касса возьмёт чаевые вместе с оплатой;
// «Перевести напрямую» — по личной ссылке сотрудника, минуя кассу. Та же
// логика, что KolibriTipsPanel в приложении.

const TIP_TEAM = '__team__';
const TIP_PERCENTS = [5, 10, 15];
const TIP_FIXED = [100, 200, 500];
const POSITION_LABELS = {
  waiter: 'Официант', hookah_master: 'Кальянщик', bartender: 'Бармен', cook: 'Повар', host: 'Хостес',
};

/// Процент от счёта, округлённый до 10 ₽, но не меньше 10 ₽.
function tipFromPercent(bill, p) {
  if (bill <= 0 || p <= 0) return 0;
  const r = Math.round(bill * p / 100 / 10) * 10;
  return r < 10 ? 10 : r;
}

function sessionBill(s) {
  const items = (s && s.orderItems) || [];
  const total = items.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
  return total * (1 - (Number((s || {}).discountPercent) || 0) / 100);
}

/// Кто на смене. Отмеченные больше 18 часов назад — забытые смены,
/// вчерашний сотрудник гостю не нужен.
function parseTipsTeam(data) {
  const members = (data && data.members) || {};
  const cutoff = Date.now() - 18 * 3600 * 1000;
  return Object.entries(members)
    .filter(([, m]) => m && String(m.name || '').trim())
    .filter(([, m]) => { const t = toDate(m.since); return !t || t.getTime() >= cutoff; })
    .map(([id, m]) => ({ id, name: String(m.name).trim(), position: m.position || '', tipsLink: m.tipsLink || '' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function watchTips(sessionId) {
  const t = state.tips;
  if (t.watching && t.sid === sessionId) return;
  if (t.sid !== sessionId) Object.assign(t, { to: null, preset: 10, custom: '', mine: [] });
  t.sid = sessionId;
  t.watching = true;
  sub(onSnapshot(doc(state.root, 'meta', 'tipsTeam'), (d) => {
    t.team = parseTipsTeam(d.exists() ? d.data() : null);
    paintTips();
  }, () => { t.team = []; paintTips(); }));
  // Гостю правила дают читать только свои записи — отсюда clientUid.
  sub(onSnapshot(query(collection(state.root, 'tips'),
    where('sessionId', '==', sessionId), where('clientUid', '==', state.uid)), (snap) => {
    t.mine = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (toDate(a.createdAt) || 0) - (toDate(b.createdAt) || 0));
    paintTips();
  }, () => {}));
}

function tipsRecipients() {
  const t = state.tips;
  const s = t.session || {};
  if (t.team.length) return t.team;
  const name = String(s.employeeName || '').trim();
  return name ? [{ id: s.employeeId || '', name, position: '', tipsLink: '' }] : [];
}

function tipsPreset(bill) {
  const p = state.tips.preset;
  if (p === -1) return -1;
  if (bill > 0 && p > 1000) return 10;
  if (bill <= 0 && p < 1000) return 1000 + TIP_FIXED[1];
  return p;
}

function tipsAmount(bill, preset) {
  if (preset === -1) return Number(String(state.tips.custom).replace(/\D/g, '')) || 0;
  if (preset > 1000) return preset - 1000;
  return tipFromPercent(bill, preset);
}

function paintTips() {
  const box = $('tipsPanel');
  if (!box) return;
  const t = state.tips;
  const s = t.session || {};
  const venue = state.venue || {};
  const team = tipsRecipients();
  const teamAllowed = venue.tipsTeamEnabled !== false && team.length !== 1;
  if (t.to == null || (t.to !== TIP_TEAM && !team.some((m) => m.id === t.to))) {
    const opener = team.find((m) => m.id && m.id === s.employeeId);
    t.to = opener ? opener.id : team.length ? team[0].id : (teamAllowed ? TIP_TEAM : null);
  }
  if (t.to === TIP_TEAM && !teamAllowed && team.length) t.to = team[0].id;
  const sel = t.to === TIP_TEAM ? null : (team.find((m) => m.id === t.to) || null);
  const bill = sessionBill(s);
  const preset = tipsPreset(bill);
  const amount = tipsAmount(bill, preset);
  const link = sel && /^https:\/\//.test(sel.tipsLink || '') ? sel.tipsLink : '';
  const chip = (attr, val, label, on) =>
    `<button class="chip${on ? ' on' : ''}" ${attr}="${esc(val)}">${esc(label)}</button>`;

  // Пока гость вводит свою сумму, форму не перерисовываем — иначе поле
  // теряло бы фокус на каждом обновлении списка смены.
  const typing = document.activeElement && document.activeElement.id === 'tipCustom';
  if (!typing) {
    box.innerHTML = `
      <div class="small muted" style="margin-bottom:8px">Кому</div>
      ${team.length || teamAllowed ? `<div class="chips">
        ${team.map((m) => chip('data-tip-to', m.id,
          POSITION_LABELS[m.position] ? `${m.name} · ${POSITION_LABELS[m.position]}` : m.name, t.to === m.id)).join('')}
        ${teamAllowed ? chip('data-tip-to', TIP_TEAM, 'Всей смене', t.to === TIP_TEAM) : ''}
      </div>` : `<p class="small muted">Смена ещё не отмечена — чаевые получит смена целиком.</p>`}
      <div class="small muted" style="margin:14px 0 8px">Сколько</div>
      <div class="chips">
        ${bill > 0
          ? TIP_PERCENTS.map((p) => chip('data-tip-p', p, `${p}% · ${money(tipFromPercent(bill, p))}`, preset === p)).join('')
          : TIP_FIXED.map((v) => chip('data-tip-p', 1000 + v, money(v), preset === 1000 + v)).join('')}
        ${chip('data-tip-p', -1, 'Своя сумма', preset === -1)}
      </div>
      ${preset === -1 ? `<input id="tipCustom" inputmode="numeric" maxlength="6" placeholder="Сумма, ₽"
        value="${esc(t.custom)}" style="margin-top:10px;max-width:180px">` : ''}
      <button class="btn-primary" id="tipAdd" style="margin-top:16px"></button>
      ${link ? `<button class="btn-ghost" id="tipLink" style="margin-top:8px">${ic('out')}Перевести напрямую: ${esc(sel.name)}</button>` : ''}
      <p class="small muted" style="margin:8px 0 0">Чаевые не входят в счёт заведения — их получит
        ${sel ? esc(sel.name) : 'смена, поровну'}.</p>
      <div id="tipsMine"></div>`;
    box.querySelectorAll('[data-tip-to]').forEach((el) => {
      el.onclick = () => { t.to = el.dataset.tipTo; paintTips(); };
    });
    box.querySelectorAll('[data-tip-p]').forEach((el) => {
      el.onclick = () => { t.preset = Number(el.dataset.tipP); paintTips(); };
    });
    const input = $('tipCustom');
    if (input) {
      input.oninput = () => {
        t.custom = input.value.replace(/\D/g, '');
        if (input.value !== t.custom) input.value = t.custom;
        paintTipsButton();
      };
    }
    $('tipAdd').onclick = () => leaveTip('bill', sel, team);
    if ($('tipLink')) $('tipLink').onclick = () => leaveTip('link', sel, team, link);
  }
  paintTipsButton();
  paintMyTips();
}

function paintTipsButton() {
  const btn = $('tipAdd');
  if (!btn) return;
  const bill = sessionBill(state.tips.session);
  const amount = tipsAmount(bill, tipsPreset(bill));
  btn.textContent = amount > 0 ? `Добавить к счёту · ${money(amount)}` : 'Добавить к счёту';
  btn.disabled = amount <= 0;
  if ($('tipLink')) $('tipLink').disabled = amount <= 0;
}

function paintMyTips() {
  const box = $('tipsMine');
  if (!box) return;
  const list = state.tips.mine.filter((x) => x.status !== 'cancelled');
  if (!list.length) { box.innerHTML = ''; return; }
  const status = (x) => x.method === 'link' ? 'переведено напрямую'
    : x.status === 'paid' ? 'оплачено, спасибо!' : 'добавим к счёту';
  box.innerHTML = `<div class="small muted" style="margin:14px 0 6px">Ваши чаевые за этот визит</div>`
    + list.map((x) => `
      <div class="row small" style="margin-top:4px">
        <span class="grow" style="${x.status === 'paid' ? 'color:var(--success, #22c55e)' : ''}">
          ${money(x.amount)} — ${esc(x.target === 'team' ? 'Всей смене' : (x.employeeName || 'Смене'))} · ${status(x)}</span>
        ${x.method !== 'link' && x.status === 'pending'
          ? `<button class="btn-link" data-tip-cancel="${esc(x.id)}">Отменить</button>` : ''}
      </div>`).join('');
  box.querySelectorAll('[data-tip-cancel]').forEach((el) => {
    el.onclick = async () => {
      el.disabled = true;
      try {
        await updateDoc(doc(state.root, 'tips', el.dataset.tipCancel),
          { status: 'cancelled', cancelledAt: Timestamp.fromDate(new Date()) });
      } catch (_) { toast('Не удалось отменить — проверьте связь'); el.disabled = false; }
    };
  });
}

async function leaveTip(method, to, team, link = '') {
  const t = state.tips;
  const s = t.session || {};
  const bill = sessionBill(s);
  const amount = tipsAmount(bill, tipsPreset(bill));
  if (amount <= 0) return;
  if (amount > 100000) { toast('Слишком большая сумма — проверьте, пожалуйста'); return; }
  // Ссылку открываем сразу по нажатию — иначе браузер сочтёт это
  // всплывающим окном и заблокирует.
  if (method === 'link') window.open(link, '_blank', 'noopener');
  const btn = $(method === 'link' ? 'tipLink' : 'tipAdd');
  if (btn) btn.disabled = true;
  try {
    await addDoc(collection(state.root, 'tips'), {
      amount,
      target: to ? 'employee' : 'team',
      employeeId: to ? to.id : '',
      employeeName: to ? to.name : 'Всей смене',
      position: to ? to.position : '',
      teamMembers: to ? [] : team.filter((m) => m.id).map((m) => ({ id: m.id, name: m.name })),
      sessionId: t.sid,
      tableName: s.tableName || '',
      clientUid: state.uid,
      comment: '',
      method,
      source: 'guest',
      // Правила базы разрешают гостю создавать чаевые только в этом
      // статусе: оплаченными их отмечает касса.
      status: 'pending',
      createdAt: Timestamp.fromDate(new Date()),
    });
    t.custom = '';
    toast(method === 'link'
      ? `Спасибо! ${to ? to.name : 'Сотрудник'} увидит, что вы перевели чаевые`
      : `Спасибо! ${money(amount)} добавим к счёту — ${staffWord('nom')} возьмёт их при оплате`);
  } catch (_) {
    toast('Не удалось отправить — проверьте связь');
  } finally {
    paintTips();
  }
}

/// Чаевые на экране «Ещё»: тот же блок, что на «Моём столе».
function renderExtrasTips() {
  const box = $('xTips');
  if (!box) return;
  const sessionId = (state.profile || {}).activeSessionId || '';
  if (!sessionId) {
    box.innerHTML = `<p class="small muted">Чаевые можно оставить во время
      визита — откройте свой стол.</p>`;
    return;
  }
  box.innerHTML = `<div id="tipsPanel"></div>`;
  // Сумма и тот, кто открыл стол, — из чека. Свой чек гостю читать можно.
  sub(onSnapshot(doc(state.root, 'sessions', sessionId), (d) => {
    state.tips.session = d.exists() ? { id: d.id, ...d.data() } : null;
    paintTips();
  }, () => {}));
  watchTips(sessionId);
}

// ---------- СЕРТИФИКАТ ----------

/// Гость не может начислить бонусы сам — отсюда уходит заявка, начисляет
/// касса, пока заведение работает — за секунды.
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
    const d = await getDoc(doc(state.root, 'giftCards', code));
    if (!d.exists()) return say('Такого сертификата нет. Проверьте код.', false);

    const problem = giftCardProblem(d.data());
    if (problem) return say(problem, false);

    // Один гость — одна активация. Свои заявки читать можно, чужие нет.
    const mine = await getDocs(query(collection(state.root, 'giftCardClaims'),
      where('clientUid', '==', state.uid), where('code', '==', code)));
    if (!mine.empty) {
      const v = mine.docs[0].data();
      if (v.status === 'granted') return say('Вы уже активировали этот сертификат.', false);
      if (v.status === 'new') return say('Заявка уже отправлена — ждём начисления.', false);
      return say(v.reason || 'Сертификат уже использован.', false);
    }

    await addDoc(collection(state.root, 'giftCardClaims'), {
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
    query(collection(state.root, 'giftCardClaims'), where('clientUid', '==', state.uid)),
    (snap) => {
      const box = $('xCardClaim');
      if (!box) return;
      if (snap.empty) { box.textContent = ''; return; }

      const last = snap.docs
        .map((d) => d.data())
        .sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0))[0];

      if (last.status === 'granted') {
        box.textContent = `Сертификат ${last.code}: начислено `
          + `${Math.round(Number(last.amount) || 0)} ${plural(Math.round(Number(last.amount) || 0), 'бонус', 'бонуса', 'бонусов')}`;
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
    query(collection(state.root, 'waitlist'), where('clientUid', '==', state.uid)),
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
            await updateDoc(doc(state.root, 'waitlist', e.id), { status: 'left' });
            toast('Вы вышли из очереди');
          } catch (_) {
            toast('Не удалось — проверьте связь');
            $('xLeave').disabled = false;
          }
        };
        return;
      }

      box.innerHTML = `
        <p class="small muted">Если все столы заняты — встаньте в очередь:
          как только стол освободится, здесь появится «Ваш стол готов».</p>
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
    const snap = await getDocs(collection(state.root, 'tables'));
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
    // Имя и телефон — сначала на сервер в РФ (152-ФЗ), потом очередь.
    const ref = doc(collection(state.root, 'waitlist'));
    await piiPost({ tenantId: state.tenantId, kind: 'waitlist', id: ref.id, name: (p.name || '').trim(), phone: p.phone || '' });
    await setDoc(ref, {
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
      const d = await getDoc(doc(state.loyaltyRoot, 'referralCodes', code));
      const owner = d.exists() ? (d.data().uid || '') : '';
      if (!owner || owner === state.uid) break;
      code = base + (i + 1);
    }

    // Сначала закрепляем код в указателе, потом пишем в профиль: если
    // закрепить не вышло, профиль не получит код, на который нельзя сослаться.
    await setDoc(doc(state.loyaltyRoot, 'referralCodes', code), { uid: state.uid });
    await setDoc(doc(state.loyaltyRoot, 'clients', state.uid), { referralCode: code }, { merge: true });
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
    const d = await getDoc(doc(state.loyaltyRoot, 'referralCodes', code));
    const inviter = d.exists() ? (d.data().uid || '') : '';
    if (!inviter) return say('Такого кода нет.');
    if (inviter === state.uid) return say('Это ваш собственный код.');

    await setDoc(doc(state.loyaltyRoot, 'clients', state.uid),
      { referredBy: inviter, referralCodeUsed: code }, { merge: true });
    say(`Код принят: после первого визита вам начислим ${INVITEE_BONUS} ${plural(INVITEE_BONUS, 'бонус', 'бонуса', 'бонусов')}, `
      + `другу — ${INVITER_BONUS}.`);
  } catch (_) {
    say('Не удалось применить код — проверьте связь.');
  }
}

// ---------- СКАНЕР QR ----------
//
// Камера телефона и сама откроет ссылку со стола, но гость в приложении
// ждёт кнопку внутри. В Safari нет BarcodeDetector — там подгружаем jsQR.

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
    // >= 2, а не HAVE_ENOUGH_DATA: Safari часто так и остаётся на
    // HAVE_CURRENT_DATA, и сканер не начал бы смотреть в кадр.
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
          const key = tableKeyFrom(raw);
          location.hash = '#/t/' + encodeURIComponent(tableId) + (key ? '/' + encodeURIComponent(key) : '');
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

/// Номер стола из любого формата наклейки: kolibri://table/5,
/// https://…/table/5, ссылка веб-версии или просто номер.
/// Секрет стола из кода: ?k=… в ссылке с наклейки или /t/{стол}/{секрет}.
function tableKeyFrom(raw) {
  const v = String(raw || '').trim();
  const param = v.match(/[?&]k=([^&#\s]+)/);
  if (param) return decodeURIComponent(param[1]);
  const path = v.match(/[#/]t\/[^/?#\s]+\/([^/?#\s]+)/);
  return path ? decodeURIComponent(path[1]) : '';
}

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
// Геометрия — как на кассе (lib/utils/hall_layout.dart): x/y стола — доли
// «базовый холст 1000×640 минус плитка», а сама площадка больше (1248×1040):
// столы правее и ниже прежней границы получают x/y больше 1.
const HALL = { basisW: 1000, basisH: 640, canvasW: 1248, canvasH: 1040, tile: 104, margin: 36 };

/// Размер и место плитки стола на площадке. Форма как в редакторе зала:
/// длинный и овальный — две клетки, барная стойка — три, вдоль или поперёк
/// (поворот); угловой — буква «Г» на 2×2 клетки, поворот выбирает угол
/// сгиба. 'triangle' — прежнее название углового.
function hallTileGeom(t) {
  const rot = (((Number(t.rotation) || 0) % 4) + 4) % 4;
  const kind = t.shape === 'triangle' ? 'corner' : t.shape;
  const cells = kind === 'bar' ? 3 : (kind === 'long' || kind === 'oval' || kind === 'corner') ? 2 : 1;
  const w = HALL.tile * (kind === 'corner' || rot % 2 === 0 ? cells : 1);
  const h = HALL.tile * (kind === 'corner' || rot % 2 === 1 ? cells : 1);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0.1);
  const left = Math.max(0, Math.min(HALL.canvasW - w, num(t.x) * (HALL.basisW - w)));
  const top = Math.max(0, Math.min(HALL.canvasH - h, num(t.y) * (HALL.basisH - h)));
  return { rot, kind, w, h, left, top };
}

/// Стена зала (коллекция hallWalls) — ломаная по углам на площадке, как её
/// нарисовал администратор в редакторе зала на кассе (lib/models/hall_wall.dart).
/// Точки — плоский список [x0, y0, x1, y1, …].
const HALL_WALL = 14;
function parseHallWall(doc) {
  const v = doc.data() || {};
  const raw = Array.isArray(v.points) ? v.points : [];
  const pts = [];
  for (let i = 0; i + 1 < raw.length && pts.length < 200; i += 2) {
    const x = raw[i], y = raw[i + 1];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push([Math.max(0, Math.min(HALL.canvasW, x)), Math.max(0, Math.min(HALL.canvasH, y))]);
  }
  return { zone: String(v.zone || '').trim(), pts, closed: v.closed === true && pts.length >= 3 };
}

/// Подпись на схеме (коллекция hallLabels): «Вход», «Кухня», заметка —
/// центр подписи на площадке, как рисует касса (lib/models/hall_label.dart).
const HALL_LABEL_SIZE = 18;
function parseHallLabel(doc) {
  const v = doc.data() || {};
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    zone: String(v.zone || '').trim(),
    text: String(v.text || '').trim().replace(/\s+/g, ' ').slice(0, 40),
    x: Math.max(0, Math.min(HALL.canvasW, num(v.x))),
    y: Math.max(0, Math.min(HALL.canvasH, num(v.y))),
  };
}

/// Рамка подписи для hallContentRect: заглавные с разрядкой ~0.86 кегля на знак.
function hallLabelGeom(l) {
  const w = l.text.length * HALL_LABEL_SIZE * 0.86, h = HALL_LABEL_SIZE * 1.2;
  return { left: l.x - w / 2, top: l.y - h / 2, w, h };
}

/// Рамка стены — как плитка стола для hallContentRect: стены тоже в кадре.
function hallWallGeom(w) {
  const xs = w.pts.map((p) => p[0]), ys = w.pts.map((p) => p[1]);
  const l = Math.min(...xs) - HALL_WALL / 2, t = Math.min(...ys) - HALL_WALL / 2;
  return { left: l, top: t, w: Math.max(...xs) + HALL_WALL / 2 - l, h: Math.max(...ys) + HALL_WALL / 2 - t };
}

/// Углы тела стены для рисования встык (как hallWallBodyPoints на кассе):
/// свободный конец продлён на половину толщины тела, конец, упёршийся в
/// другую стену, — нет, иначе на её контуре осталась бы засечка.
function hallWallBodyPts(w, all, extend) {
  const pts = w.pts, n = pts.length;
  if (w.closed || n < 2) return pts;
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
  const segDist = (p, a, b) => {
    const abx = b[0] - a[0], aby = b[1] - a[1], len2 = abx * abx + aby * aby;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2)) : 0;
    return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t);
  };
  const distTo = (o, p) => {
    let best = Infinity;
    for (let i = 0; i + 1 < o.pts.length; i++) best = Math.min(best, segDist(p, o.pts[i], o.pts[i + 1]));
    if (o.closed) best = Math.min(best, segDist(p, o.pts[o.pts.length - 1], o.pts[0]));
    return best;
  };
  const abuts = (end) => all.some((o) => o !== w && o.pts.length >= 2 && distTo(o, end) <= 0.5 &&
    !(!o.closed && (near(o.pts[0], end) || near(o.pts[o.pts.length - 1], end))));
  const ext = (end, nb) => {
    const dx = end[0] - nb[0], dy = end[1] - nb[1], len = Math.hypot(dx, dy);
    return !len || abuts(end) ? end : [end[0] + dx / len * extend, end[1] + dy / len * extend];
  };
  return [ext(pts[0], pts[1]), ...pts.slice(1, n - 1), ext(pts[n - 1], pts[n - 2])];
}

/// Стены «как на чертеже» (SVG под столами): тень, светлый контур и тело
/// стены между двумя линиями; внутри замкнутого (или почти, с проёмом
/// входа) контура — лёгкая подсветка пола. Как HallWallsPainter на кассе.
function hallWallsSvg(walls, area, labels = []) {
  if (!walls.length && !labels.length) return '';
  const r = (v) => Math.round(v * 10) / 10;
  const d = (pts, closed) => 'M' + pts.map(([x, y]) => `${r(x)} ${r(y)}`).join(' L') + (closed ? ' Z' : '');
  const rooms = walls.filter((w) => w.pts.length >= 3 && (w.closed ||
    Math.hypot(w.pts[0][0] - w.pts[w.pts.length - 1][0], w.pts[0][1] - w.pts[w.pts.length - 1][1]) <= HALL.tile * 3));
  // Области фильтра и градиента — в координатах площадки: у прямой
  // горизонтальной стены «рамка» нулевой высоты, и в долях она пропала бы.
  const fx = area.l - 60, fy = area.t - 60, fw = area.w + 120, fh = area.h + 120;
  return `<svg class="hall-walls" viewBox="${r(area.l)} ${r(area.t)} ${r(area.w)} ${r(area.h)}"
      preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <filter id="hwShadow" filterUnits="userSpaceOnUse" x="${fx}" y="${fy}" width="${fw}" height="${fh}">
        <feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#000" flood-opacity=".45"/>
      </filter>
      <linearGradient id="hwBody" gradientUnits="userSpaceOnUse"
          x1="${r(area.l)}" y1="${r(area.t)}" x2="${r(area.l + area.w)}" y2="${r(area.t + area.h)}">
        <stop offset="0" class="hw-s1"/><stop offset="1" class="hw-s2"/>
      </linearGradient>
    </defs>
    ${rooms.map((w) => `<path class="hw-room" d="${d(w.pts, true)}"/>`).join('')}
    <g filter="url(#hwShadow)">${walls.map((w) => `<path class="hw-edge" d="${d(w.pts, w.closed)}"/>`).join('')}</g>
    ${walls.map((w) => `<path class="hw-body" stroke="url(#hwBody)"
        d="${d(hallWallBodyPts(w, walls, (HALL_WALL - 4.5) / 2), w.closed)}"/>`).join('')}
    ${labels.map((l) => `<text class="hw-label" x="${r(l.x)}" y="${r(l.y)}" text-anchor="middle"
        dominant-baseline="central">${esc(l.text.toUpperCase())}</text>`).join('')}
  </svg>`;
}

/// Часть площадки со столами (и стенами) и полями вокруг — не меньше
/// 3.2×2.4 плитки, чтобы два-три стола не раздувались на весь экран.
function hallContentRect(geoms) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  geoms.forEach((g) => {
    l = Math.min(l, g.left); t = Math.min(t, g.top);
    r = Math.max(r, g.left + g.w); b = Math.max(b, g.top + g.h);
  });
  l -= HALL.margin; t -= HALL.margin; r += HALL.margin; b += HALL.margin;
  const gx = Math.max(0, HALL.tile * 3.2 - (r - l)) / 2;
  const gy = Math.max(0, HALL.tile * 2.4 - (b - t)) / 2;
  l -= gx; r += gx; t -= gy; b += gy;
  // Сдвигаем внутрь площадки, сохраняя размер.
  if (l < 0) { r -= l; l = 0; }
  if (t < 0) { b -= t; t = 0; }
  if (r > HALL.canvasW) { l -= r - HALL.canvasW; r = HALL.canvasW; }
  if (b > HALL.canvasH) { t -= b - HALL.canvasH; b = HALL.canvasH; }
  l = Math.max(0, l); t = Math.max(0, t);
  return { l, t, w: r - l, h: b - t };
}
//
// Схема столов с кассы в реальном времени. Сесть за стол отсюда нельзя —
// только по коду на самом столе, чтобы счёт не занимали удалённо.

/// Стол, выбранный для брони. Живёт между экранами: гость уходит на карту
/// и возвращается в форму брони, где выбор должен сохраниться.
let pickedTable = null;

function screenHall(pickMode) {
  screenEl().innerHTML = `
    <h1>${pickMode ? 'Выберите стол' : 'Карта зала'}</h1>
    <p class="muted small">${pickMode
      ? 'Серым отмечены столы, которых не хватит на вашу компанию, красным — занятые на выбранное время.'
      : 'Занятость столов обновляется в реальном времени.'}</p>
    <div class="chips" id="hallZones"></div>
    <div class="hall-scroll"><div class="hall" id="hall"><div class="spinner"></div></div></div>
    <div class="legend">
      <span><i style="background:var(--t-free)"></i> свободен</span>
      <span><i style="background:var(--t-risky)"></i> впритык</span>
      <span><i style="background:var(--t-busy)"></i> занят</span>
    </div>
    <div style="height:16px"></div>
    <a class="btn btn-ghost" href="${pickMode ? '#/booking' : '#/table'}">${pickMode ? 'Отмена' : 'Назад'}</a>`;

  // Занятость по броням на выбранное время — только в режиме выбора.
  let busyByBooking = new Set();
  const when = pickMode ? bookingStart() : null;
  const durMs = (bookingDraft.duration || 90) * 60 * 1000;

  let tablesLoaded = false;
  // Зона зала (терраса, VIP…): у каждой зоны своя схема, как на кассе.
  let hallZone = null;
  // Стены и подписи всех зон (hallWalls, hallLabels).
  let walls = [];
  let labels = [];

  const draw = (allTables) => {
    const box = $('hall');
    if (!box) return;
    // Зеркало броней иногда приходит раньше самих столов: без этой
    // проверки карта на мгновение писала «не настроена» и мигала.
    if (!tablesLoaded) return;
    const zones = [];
    allTables.forEach((t) => {
      const z = String(t.zone || '').trim();
      if (z && !zones.includes(z)) zones.push(z);
    });
    if (zones.length && allTables.some((t) => !String(t.zone || '').trim())) zones.push('');
    if (zones.length && !zones.includes(hallZone)) hallZone = zones[0];
    const zonesEl = $('hallZones');
    if (zonesEl) {
      zonesEl.innerHTML = zones.map((z) => `
        <button class="chip ${z === hallZone ? 'on' : ''}" data-zone="${esc(z)}">${esc(z || 'Без зоны')}</button>`).join('');
      zonesEl.querySelectorAll('[data-zone]').forEach((el) => {
        el.onclick = () => { hallZone = el.dataset.zone; draw(allTables); };
      });
    }
    const tables = zones.length
      ? allTables.filter((t) => String(t.zone || '').trim() === hallZone)
      : allTables;
    if (!tables.length) {
      box.innerHTML = `<p class="muted small" style="padding:20px">Карта зала пока не настроена.</p>`;
      return;
    }
    // Показываем часть площадки со столами, как касса (hallContentRect):
    // площадка больше прежней, и целиком столы на ней были бы мелкими.
    const geoms = new Map(tables.map((t) => [t.id, hallTileGeom(t)]));
    const zoneWalls = walls.filter((w) => w.zone === (zones.length ? hallZone : ''));
    const zoneLabels = labels.filter((l) => l.zone === (zones.length ? hallZone : ''));
    const area = hallContentRect([...geoms.values(), ...zoneWalls.map(hallWallGeom), ...zoneLabels.map(hallLabelGeom)]);
    const pct = (v, total) => `${(v / total * 100).toFixed(3)}%`;
    box.style.aspectRatio = `${area.w} / ${area.h}`;
    // Плитка не мельче прежних ~62 px: узкий экран листает схему вбок.
    box.style.minWidth = `${Math.round(area.w * 0.6)}px`;
    box.style.backgroundSize = `${pct(40, area.w)} ${pct(40, area.h)}`;
    box.innerHTML = hallWallsSvg(zoneWalls, area, zoneLabels) + tables.map((t) => {
      // Карта зала показывает, кто сидит сейчас. Выбор стола для брони —
      // про будущее: важно, дотянется ли текущий сеанс до брони (busyUntil)
      // и нет ли на это время чужой брони.
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
      const g = geoms.get(t.id);
      const { rot, kind } = g;
      const shape = kind === 'circle' || kind === 'oval' ? 'round'
          : kind === 'corner' ? `corner corner-r${rot}`
          : kind === 'bar' ? `bar bar-r${rot}` : '';
      const label = `<span class="tn">${esc(t.name || '')}</span>
          <small>${Number(t.seats) || 0} ${plural(Number(t.seats) || 0, 'место', 'места', 'мест')}${tooSmall ? ' · мало' : ''}</small>`;
      // Нажатие по недоступному столу объясняет, почему он недоступен:
      // молчащая плитка выглядит как сломанная кнопка.
      const why = tooSmall
        ? `Стол на ${Number(t.seats) || 0} ${plural(Number(t.seats) || 0, 'место', 'места', 'мест')} — для ${bookingGuests()} ${plural(bookingGuests(), 'гостя', 'гостей', 'гостей')} мало`
        : bookedNow
          ? 'Этот стол уже забронирован на выбранное время'
          : 'Стол занят до этого времени — выберите другое время или стол';
      return `
        <div class="table-dot ${cls} ${shape} ${canPick ? 'pick' : ''}
             ${pickedTable && pickedTable.id === t.id ? 'chosen' : ''}"
             ${canPick
               ? `data-pick="${esc(t.id)}" data-name="${esc(t.name || '')}"
                  ${cls === 'risky' ? 'data-risky="1"' : ''}`
               : (pickMode ? `data-why="${esc(why)}"` : '')}
             style="width:${pct(g.w, area.w)}; height:${pct(g.h, area.h)};
                    left:${pct(g.left - area.l, area.w)}; top:${pct(g.top - area.t, area.h)}">
          ${kind === 'corner' ? `<span class="cl">${label}</span>` : label}
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
  sub(onSnapshot(collection(state.root, 'tables'), (snap) => {
    tablesLoaded = true;
    tables = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru', { numeric: true }));
    draw(tables);
  }, () => {
    const box = $('hall');
    if (box) box.innerHTML = `<p class="muted small" style="padding:20px">Не удалось загрузить карту зала.</p>`;
  }));

  // Стены зала — как нарисовал администратор. Нет доступа (старые правила)
  // — схема просто без стен.
  sub(onSnapshot(collection(state.root, 'hallWalls'), (snap) => {
    walls = snap.docs.map(parseHallWall).filter((w) => w.pts.length >= 2);
    draw(tables);
  }, () => {}));
  sub(onSnapshot(collection(state.root, 'hallLabels'), (snap) => {
    labels = snap.docs.map(parseHallLabel).filter((l) => l.text);
    draw(tables);
  }, () => {}));

  // Обезличенное зеркало броней: стол и интервал, без имён и телефонов.
  // Самих броней гостю читать нельзя — там чужие контакты.
  if (pickMode && when) {
    const from = new Date(when.getTime() - 6 * 60 * 60 * 1000);
    const to = new Date(when.getTime() + 6 * 60 * 60 * 1000);
    const end = new Date(when.getTime() + durMs);
    sub(onSnapshot(
      query(collection(state.root, 'reservationSlots'),
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
