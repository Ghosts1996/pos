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
  disableNetwork, enableNetwork,
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
  return resp.json().catch(() => ({}));
}

// ---------- СПРАВОЧНИК В РФ ----------
//
// Заведение, переведённое на хранение в РФ (venueProfile.piiMode = 'rf'),
// не держит в Firestore ни имён, ни телефонов: там только uid гостя и id
// сотрудника. Имена берём из справочника на сервере в РФ — гостю он отдаёт
// только его собственный профиль, его заказы и имена тех, кто сейчас на
// смене (для чаевых).

/// Заведение хранит персональные данные только в РФ.
const rfMode = () => ((state.venue || {}).piiMode || '') === 'rf';

/// Имена сотрудников, которых уже спрашивали: id → имя ('' — не нашли).
const staffNames = new Map();
let staffAsk = null;

/// Имя сотрудника из справочника. Пока ответа нет — пусто; когда придёт,
/// вызывается redraw (один раз на пачку).
function staffNameOf(id, redraw) {
  if (!id) return '';
  if (staffNames.has(id)) return staffNames.get(id);
  if (!state.tenantId || !state.auth || !state.auth.currentUser) return '';
  if (!staffAsk) {
    staffAsk = { ids: new Set(), redraws: new Set() };
    setTimeout(async () => {
      const ask = staffAsk;
      staffAsk = null;
      const ids = [...ask.ids].slice(0, 40);
      try {
        const res = await piiPost({ tenantId: state.tenantId, kind: 'pii_lookup', refs: ids.map((x) => ({ k: 'staff', id: x })) });
        ids.forEach((x) => staffNames.set(x, ''));
        (res.staff || []).forEach((r) => staffNames.set(String(r.id), String(r.name || '').trim()));
      } catch (_) {
        return; // нет связи — спросим при следующей отрисовке
      }
      ask.redraws.forEach((f) => { try { f(); } catch (_) {} });
    }, 120);
  }
  staffAsk.ids.add(id);
  if (redraw) staffAsk.redraws.add(redraw);
  return '';
}

/// Свой профиль из справочника: в режиме rf в Firestore имени и номера нет.
/// Один запрос на всех: кто вызвал во время загрузки, ждёт тот же ответ.
function loadOwnPd() {
  if (state.ownPd || !state.uid) return Promise.resolve();
  if (!state.ownPdLoading) {
    state.ownPdLoading = fetchOwnPd().finally(() => { state.ownPdLoading = null; });
  }
  return state.ownPdLoading;
}

async function fetchOwnPd() {
  const uid = state.uid;
  try {
    const res = await piiPost({ tenantId: state.tenantId, kind: 'pii_lookup', refs: [{ k: 'guest', id: uid }] });
    if (state.uid !== uid) return;
    const g = (res.guests || [])[0] || {};
    state.ownPd = { name: String(g.name || ''), phone: String(g.phone || '') };
  } catch (_) {
    return; // попробуем при следующем обновлении профиля
  }
  if (!state.profile) return;
  state.profile = withOwnPd(state.profile);
  if (location.hash === '#/profile' && state.profileDirty) return;
  if (['#/', '#/table', '#/profile', ''].includes(location.hash)) route();
  else if (location.hash === '#/booking') fillBookingContacts();
}

/// Бронь открыли раньше, чем пришли свои имя и номер из РФ: перерисовать
/// форму с ними, пока гость ничего не вписал, — иначе его ввод не трогаем.
function fillBookingContacts() {
  const typed = ['bName', 'bPhone', 'bComment'].some((id) => ($(id)?.value || '').trim());
  if ($('bName') && !typed) route();
}

/// Перед действием, которому нужны свои имя и номер (бронь, очередь, стол):
/// дождаться справочника, если профиль хранится в РФ. Нет связи — как есть.
async function ensureOwnPd() {
  if (state.ownPd || !needOwnPd(state.profile)) return;
  await loadOwnPd();
}

/// Есть ли у гостя номер: в документе или отметка «номер записан в РФ».
const hasPhoneOnFile = (p) => !!(p && (p.phone || p.phoneOnFile === true));

/// Профиль Firestore + имя и номер из справочника. В режиме rf главный —
/// справочник (в документе могли остаться прежние значения до переноса),
/// иначе — документ, а справочник подставляет то, чего в нём нет.
function withOwnPd(p) {
  const pd = state.ownPd || {};
  if (rfMode() && state.ownPd) {
    return { ...p, name: pd.name || p.name || '', phone: pd.phone || p.phone || '' };
  }
  return { ...p, name: p.name || pd.name || '', phone: p.phone || pd.phone || '' };
}

/// Нужно ли спрашивать справочник о своём профиле.
function needOwnPd(p) {
  return !!p && (rfMode() || ((!p.name || !p.phone) && p.phoneOnFile === true));
}

/// Сохранённое на сервере в РФ — сразу в профиль на экране: в режиме rf
/// Firestore имени и номера не пришлёт.
function rememberOwnPd(patch) {
  const v = {};
  if (typeof patch.name === 'string') v.name = patch.name;
  if (patch.phone) v.phone = patch.phone;
  state.ownPd = { name: '', phone: '', ...(state.ownPd || {}), ...v };
  if (state.profile) state.profile = { ...state.profile, ...v };
}

/// Курьер заказа: в режиме mirror — из документа заказа, в режиме rf — из
/// справочника (гостю он отдаёт только его собственные заказы). Пока ответа
/// нет — пусто, потом redraw.
const courierCache = new Map(); // `${id}:${статус}` → { name, phone } | null
function courierOf(s, redraw) {
  if (s.courierName || s.courierPhone) {
    return { name: String(s.courierName || ''), phone: String(s.courierPhone || '') };
  }
  if (!rfMode() || deliveryStatusOf(s) !== 'courier') return { name: '', phone: '' };
  // Курьера могли сменить — спрашиваем заново на каждом шаге заказа.
  const at = toDate(s.deliveryStatusAt);
  const key = `${s.id}:${s.deliveryStatus || ''}:${at ? at.getTime() : ''}`;
  if (courierCache.has(key)) return courierCache.get(key) || { name: '', phone: '' };
  courierCache.set(key, null);
  piiPost({ tenantId: state.tenantId, kind: 'pii_lookup', refs: [{ k: 'delivery', id: s.id }] })
    .then((res) => {
      const rec = (res.contacts || []).find((c) => c.id === s.id) || {};
      const extra = rec.extra || {};
      courierCache.set(key, { name: String(extra.courierName || ''), phone: String(extra.courierPhone || '') });
      redraw();
    })
    .catch(() => courierCache.delete(key));
  return { name: '', phone: '' };
}

// ---------- СОСТОЯНИЕ ----------

/// Служебный стол кассы для заказов с собой и доставки — гостю его не показываем.
const TAKEAWAY_ID = 'takeaway';

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
  /// Профиль из Firestore; имя и номер в режиме rf — из ownPd.
  profile: null,
  /// Своё имя и номер из справочника в РФ (см. loadOwnPd).
  ownPd: null,
  /// Идущий запрос к справочнику (см. loadOwnPd) или null.
  ownPdLoading: null,
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
  tips: { sid: null, watching: false, session: null, team: [], teamDoc: null, mine: [], to: null, preset: 10, custom: '' },
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
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.3a10 10 0 0 0 5.2 5.2l1.3-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2Z"/>',
  bag: '<path d="M5.5 8h13l-1 12.5h-11Z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  truck: '<path d="M3 6.5h11v9H3Z"/><path d="M14 9.5h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
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
/// Кто поможет гостю — для пояснений («попросите сотрудника открыть стол»):
/// роль там не важна, а «кальянщик» в кафе только путает. Роль называет
/// roleWord — на кнопках вызова и в подсказке, кому уйдёт заказ.
function staffWord(form) {
  return ['сотрудник', 'сотрудника', 'сотруднику'][{ nom: 0, acc: 1, dat: 2 }[form] || 0];
}
/// Кто обслуживает стол: form — 'nom' («кальянщик подтвердит»), 'acc'
/// («позовите кальянщика») или 'dat' («скажите кальянщику»).
function roleWord(form) {
  const t = venueType();
  const w = t === 'hookah' && isHookah() ? ['кальянщик', 'кальянщика', 'кальянщику']
    : t === 'bar' ? ['бармен', 'бармена', 'бармену']
      : ['официант', 'официанта', 'официанту'];
  return w[{ nom: 0, acc: 1, dat: 2 }[form] || 0];
}
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
/// Кто принимает заказ — подсказка у кнопки заказа.
function orderHint() {
  const food = TARGET_NOM[orderTarget(false)];
  return isHookah()
    ? `Блюда и напитки примет ${food}, кальян — кальянщик. После подтверждения заказ появится в счёте.`
    : `Блюда и напитки — прямо к столу: ${food} подтвердит заказ, и он появится в счёте.`;
}

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
          buttonColor: b.buttonColor, backgroundColor: b.backgroundColor,
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
  watchResume();
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
    state.ownPd = null;
    staffNames.clear();
    courierCache.clear();
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
    state.profile = d.exists() ? withOwnPd({ id: d.id, ...d.data() }) : null;
    if (needOwnPd(d.exists() ? d.data() : null)) loadOwnPd();
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
    // Заведение хранит данные в РФ — своё имя и номер берём из справочника.
    if (state.profile && needOwnPd(state.profile)) {
      if (state.ownPd) state.profile = withOwnPd(state.profile);
      else loadOwnPd();
    }
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
  const activeTab = tab === 'extras' ? 'profile'
    : tab === 'checkout' ? 'menu'
      : tab.startsWith('order/') ? 'table'
        : (tab === '' ? 'home' : tab);
  document.querySelectorAll('.tabbar a').forEach((a) => {
    a.classList.toggle('on', a.dataset.tab === activeTab);
  });
  window.scrollTo(0, 0);

  if (bind) return bindToTable(decodeURIComponent(bind[1]), bind[2] ? decodeURIComponent(bind[2]) : '');
  const hall = hash.match(/^#\/hall(\/pick)?$/);
  if (hall) return screenHall(!!hall[1]);
  // Доставка и с собой: оформление и экран заказа.
  if (hash === '#/checkout') return screenCheckout();
  const ord = hash.match(/^#\/order\/([A-Za-z0-9_-]{1,64})$/);
  if (ord) return screenOrder(ord[1]);

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

/** Ссылка на политику обработки данных под формами с именем и телефоном
 *  (ст. 18.1 152-ФЗ): кто, зачем и где обрабатывает данные, описано в ней. */
function privacyNotice() {
  return `<p class="small" style="margin:12px 0 0;text-align:center">
    <a class="policy-link" href="https://zalpos.ru/#/legal/privacy" target="_blank" rel="noopener">Политика обработки данных</a></p>`;
}

// ---------- СОГЛАСИЯ ГОСТЯ ----------
// Оператор данных гостей — сервис ZalPOS (оферта, раздел 7); заведение
// обрабатывает их по его поручению. Перед первой отправкой имени, телефона
// или адреса — согласие на обработку (ст. 9 152-ФЗ), а пока заведение не
// переведено на хранение в РФ (venueProfile.piiMode !== 'rf') — и на
// трансграничную передачу (ст. 12): копии синхронизируются через Google
// Firebase. С 1 сентября 2025 года согласие оформляется отдельно от других
// документов. Отметка пишется на сервер в РФ (доказательство), её
// редакция — в профиль и в localStorage. Тексты — как в приложении
// (lib/client/services/guest_consent.dart).
const CONSENT_EDITION = '2026-10-10';
const CONSENT_EDITION_LABEL = 'Редакция от 10 октября 2026 г.';

/** Нужна галочка о трансграничной передаче: заведение ещё не в режиме РФ. */
const needsCrossBorder = () => !rfMode();

// Реквизиты ZalPOS — оператора (platformConfig/legal, открыты для чтения).
let platformLegal = null;
let platformLegalLoad = null;
function loadPlatformLegal() {
  if (!platformLegalLoad) {
    platformLegalLoad = getDoc(doc(state.db, 'platformConfig', 'legal'))
      .then((d) => { platformLegal = d.exists() ? d.data() : {}; })
      .catch(() => { platformLegalLoad = null; });
  }
  return platformLegalLoad;
}
const consentKey = () => `guest_consent:${state.tenantId}:${state.uid}`;

function consentGiven() {
  if ((state.profile || {}).consentEdition === CONSENT_EDITION) return true;
  try { return localStorage.getItem(consentKey()) === CONSENT_EDITION; } catch (_) { return false; }
}

/** Галочки над кнопкой отправки; согласия уже даны — ссылка на политику. */
function consentHtml() {
  if (consentGiven()) return '';
  loadPlatformLegal();
  return `<div class="consent" data-consent-box>
    <label class="consent-row"><input type="checkbox" data-consent="pd">
      <span>Даю <a href="#" data-consent-text="pd">согласие на обработку персональных данных</a>
      и принимаю <a href="https://zalpos.ru/#/legal/privacy" target="_blank" rel="noopener">политику конфиденциальности</a></span></label>
    ${needsCrossBorder() ? `<label class="consent-row"><input type="checkbox" data-consent="xb">
      <span>Даю <a href="#" data-consent-text="xb">согласие на трансграничную передачу</a>
      данных (сервис Google Firebase)</span></label>` : ''}
    <p class="small muted consent-hint">${needsCrossBorder() ? 'Отметьте оба пункта, чтобы продолжить' : 'Отметьте пункт, чтобы продолжить'}</p>
  </div>`;
}

/** Оживляет галочки над кнопкой [btn]: кнопка неактивна, пока обе не
 *  отмечены. [extraOk] — остальные условия кнопки (корзина не пуста). */
/** Подсказка, если галочки не отмечены: в режиме РФ она одна. */
const consentToast = () => (needsCrossBorder() ? 'Отметьте оба согласия' : 'Отметьте согласие на обработку данных');

function consentBoxOf(btn) {
  return btn && btn.parentElement && btn.parentElement.querySelector('[data-consent-box]');
}

/** Обе галочки у кнопки [btn] отмечены (или согласия уже даны). */
function consentReady(btn) {
  const box = consentBoxOf(btn);
  return consentGiven() || (!!box && [...box.querySelectorAll('[data-consent]')].every((c) => c.checked));
}

function bindConsent(btn, extraOk = () => true) {
  const box = consentBoxOf(btn);
  const ready = () => consentReady(btn);
  const sync = () => {
    if (btn) btn.disabled = !(ready() && extraOk());
    const hint = box && box.querySelector('.consent-hint');
    if (hint) hint.style.display = ready() ? 'none' : '';
  };
  if (box) {
    box.querySelectorAll('[data-consent]').forEach((c) => c.addEventListener('change', sync));
    box.querySelectorAll('[data-consent-text]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      showConsentText(a.dataset.consentText === 'xb');
    }));
  }
  sync();
  return { ready, sync };
}

/** Записать согласие на сервер в РФ до отправки данных. */
async function commitConsent() {
  if (consentGiven()) return;
  try {
    await piiPost({ tenantId: state.tenantId, kind: 'guest_consent', edition: CONSENT_EDITION, pd: true, crossBorder: needsCrossBorder() });
  } catch (_) {
    throw new Error('Согласие не сохранилось — проверьте интернет и попробуйте снова');
  }
  try { localStorage.setItem(consentKey(), CONSENT_EDITION); } catch (_) {}
}

/** Оператор — правообладатель платформы ZalPOS с реквизитами. */
function consentOperator() {
  const l = platformLegal || {};
  const raw = String(l.fullName || '').trim();
  const ogrn = String(l.ogrnip || '').trim();
  const inn = String(l.inn || '').trim();
  const address = String(l.address || '').trim();
  if (!raw || !inn) {
    return 'сервис ZalPOS — индивидуальный предприниматель, правообладатель платформы ZalPOS (реквизиты — в политике конфиденциальности на zalpos.ru)';
  }
  const isOrg = !/^ИП\s|индивидуальн/i.test(raw) && ogrn.length === 13;
  let who = raw;
  if (!isOrg) {
    let name = raw.replace(/^(ИП|индивидуальный\s+предприниматель)\s+/i, '').trim();
    if (name === name.toUpperCase()) {
      name = name.toLowerCase().replace(/(^|[\s\-.])([a-zа-яё])/g, (m, p, c) => p + c.toUpperCase());
    }
    who = `индивидуальный предприниматель ${name}`;
  }
  const parts = [`ИНН ${inn}`, ogrn ? `${isOrg ? 'ОГРН' : 'ОГРНИП'} ${ogrn}` : '', address ? `адрес: ${address}` : ''].filter(Boolean);
  return `сервис ZalPOS — ${who} (${parts.join(', ')})`;
}

function consentVenue() {
  const name = String((state.venue || {}).name || '').trim();
  return name ? `заведения «${name}»` : 'заведения';
}

function consentTexts(crossBorder) {
  const op = consentOperator();
  return crossBorder ? {
    title: 'Согласие на трансграничную передачу персональных данных',
    body: [
      `Отмечая этот пункт, я даю согласие оператору — ${op} — на трансграничную передачу моих персональных данных компании Google LLC (сервис Firebase): хранение и синхронизация — в центрах обработки данных в Бельгии и Нидерландах, вход в приложение и push-уведомления — на серверах в США.`,
      'Передаются: имя, номер телефона, день и месяц рождения, адрес доставки, сведения о бронированиях, заказах, посещениях и бонусах, идентификатор устройства. Первично данные записываются на сервер в России.',
      'Зачем: чтобы приложение работало вместе с кассой заведения — персонал видел бронь и заказ, начислял бонусы, а приложение присылало уведомления. Получатель защищает данные: шифрование при хранении и передаче, сертификаты ISO/IEC 27001, 27017, 27018.',
      'Передача прекращается, когда заведение переводится на хранение данных только в России. Срок и порядок отзыва — как в согласии на обработку персональных данных.',
    ],
  } : {
    title: 'Согласие на обработку персональных данных',
    body: [
      `Отмечая этот пункт, я свободно, своей волей и в своём интересе даю согласие оператору — ${op} — на обработку моих персональных данных на условиях ниже.`,
      'Какие данные: имя; номер телефона; день и месяц рождения, если я их укажу; адрес доставки, если я оформлю доставку; сведения о бронированиях, заказах, посещениях, бонусах и отзывах; идентификатор устройства.',
      'Зачем: бронирование столов и лист ожидания; приём, оплата и доставка заказов; программа лояльности (бонусы, уровни, скидки) в заведениях, работающих на ZalPOS; связь со мной по брони и заказу; уведомления в приложении.',
      'Что с ними делают: сбор, запись, систематизация, накопление, хранение, уточнение, извлечение, использование, передача (предоставление, доступ), блокирование, удаление и уничтожение — с использованием средств автоматизации.',
      `По поручению оператора мои данные обрабатывают работники ${consentVenue()}, в котором я бронирую или делаю заказ, — только в программе ZalPOS и только чтобы меня обслужить.`,
      needsCrossBorder() ? 'Имя, телефон и адрес сначала записываются на сервер в России.' : 'Имя, телефон и адрес хранятся на сервере в России и за её пределы не передаются.',
      'Согласие действует до его отзыва, но не дольше 3 лет с последнего посещения. Отозвать согласие и удалить данные можно кнопкой «Удалить мои данные» в профиле, письмом оператору или через заведение; накопленные бонусы при этом аннулируются.',
    ],
  };
}

/** Согласий ещё нет, а действие отправит данные из профиля (лист
 *  ожидания): спрашиваем отдельным окном. true — согласия записаны. */
function askConsent() {
  if (consentGiven()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'sheet-backdrop';
    el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Нужно ваше согласие">
      <div class="sheet-grip"></div>
      <h2 style="margin:0 0 12px">Нужно ваше согласие</h2>
      <div>${consentHtml()}<button class="btn-primary" data-ok>Продолжить</button></div>
      <button class="btn-ghost" data-cancel style="margin-top:10px">Отмена</button>
    </div>`;
    document.body.appendChild(el);
    const ok = el.querySelector('[data-ok]');
    bindConsent(ok);
    const done = (v) => { el.remove(); resolve(v); };
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-cancel]')) done(false); });
    ok.onclick = async () => {
      ok.disabled = true;
      try {
        await commitConsent();
        done(true);
      } catch (e) {
        toast(e.message);
        ok.disabled = false;
      }
    };
  });
}

async function showConsentText(crossBorder) {
  await loadPlatformLegal();
  const t = consentTexts(crossBorder);
  const el = document.createElement('div');
  el.className = 'sheet-backdrop';
  el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(t.title)}">
    <div class="sheet-grip"></div>
    <h2 style="margin:0 0 4px">${esc(t.title)}</h2>
    <p class="small muted" style="margin:0 0 14px">${CONSENT_EDITION_LABEL}</p>
    ${t.body.map((p) => `<p style="margin:0 0 12px;line-height:1.5">${esc(p)}</p>`).join('')}
    <button class="btn-primary" data-close style="margin-top:8px">Понятно</button>
  </div>`;
  const close = () => el.remove();
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(el);
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
    // Не за столом — заказ с доставкой или с собой: алкоголь и табак так
    // не продаются (законы № 171-ФЗ и № 15-ФЗ), кнопок у них нет.
    const canTakeAway = (i) => deliveryOn() && !remoteSaleBanned(i, catName(i.categoryId));

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
                ${cartQty(i.id) ? `
                  <button data-minus="${esc(i.id)}">−</button>
                  <span>${cartQty(i.id)}</span>` : ''}
                <button data-plus="${esc(i.id)}">+</button>
              </div>`;
    const itemCard = (i) => `
      <div class="mcard${cartQty(i.id) ? ' on' : ''}">
        <div class="mphoto">${i.imageUrl ? `<img src="${esc(i.imageUrl)}" alt="" loading="lazy">` : ''}
          ${isHit(i) ? '<span class="hit">Хит</span>' : ''}</div>
        <div class="mbody">
          <div class="mname">${esc(i.name)}</div>
          ${i.description ? `<div class="small muted mdesc">${esc(i.description)}</div>` : ''}
          ${hasMods(i) ? '<div class="small muted">Можно выбрать добавки</div>' : ''}
          <div class="mfoot"><b class="mprice">${money(i.price)}</b>${atTable || canTakeAway(i) ? qtyControls(i)
    : deliveryOn() ? '<span class="small muted">Только в заведении</span>' : ''}</div>
        </div>
      </div>`;
    // Перечень табака (ст. 19 закона № 15-ФЗ): как строка бумажного меню —
    // название, отточие, цена; заказ словом, без иконок.
    const tobaccoControls = (i) => (state.cart[i.id]
      ? `<div class="tstep">
           <button data-minus="${esc(i.id)}" aria-label="Убрать одну">−</button>
           <span>${state.cart[i.id]}</span>
           <button data-plus="${esc(i.id)}" aria-label="Добавить ещё">+</button>
         </div>`
      : `<button class="tadd" data-plus="${esc(i.id)}" aria-label="Добавить: ${esc(i.name)}">+</button>`);
    const tobaccoBlock = (list) => `
      <div class="tobacco-list">
        <p>Табачная и никотинсодержащая продукция, кальяны. Продажа лицам младше 18 лет запрещена.</p>
        ${[...list].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru')).map((i) => `
          <div class="tobacco-row">
            <div class="tline">
              <span class="tname">${esc(i.name)}</span>
              <span class="tdots" aria-hidden="true"></span>
              <span class="tprice">${money(i.price)}</span>
            </div>
            ${tobaccoControls(i)}
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
        ${tobaccoItems.length ? `<button class="tobacco-tile" data-cat="__tobacco">
          <span class="tt-text"><b>Табак и кальяны</b>
            Перечень с ценами, ${tobaccoItems.length} ${plural(tobaccoItems.length, 'позиция', 'позиции', 'позиций')}.
            Продажа лицам младше 18 лет запрещена.</span>
          <span class="tt-go" aria-hidden="true">→</span></button>` : ''}
        ${hidden ? `<p class="small muted">Часть позиций (18+) видна только в заведении,
          когда вы за столом.</p>` : ''}`;
    }

    box.innerHTML = `
      <input id="menuSearch" class="msearch" type="search" placeholder="Поиск по меню" value="${esc(search)}">
      ${body}
      ${atTable ? cartBlock(items) : deliveryOn() ? cartBlock(items, true) : `
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
      el.onclick = () => addToCart(el.dataset.plus, items, draw);
    });
    box.querySelectorAll('[data-minus]').forEach((el) => {
      el.onclick = () => { removeFromCart(el.dataset.minus); draw(); };
    });
    const send = $('sendOrder');
    if (send) send.onclick = () => placeOrder(items, draw, tobacco);
    const go = $('goCheckout');
    if (go) go.onclick = () => { location.hash = '#/checkout'; };
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

function cartBlock(items = [], delivery = false) {
  const ids = Object.keys(state.cart);
  if (!ids.length) {
    return delivery ? `<p class="small muted">Соберите заказ — его можно забрать самому или заказать доставку.</p>` : '';
  }
  // Итог видно из любой категории: гость ходит по плиткам и не должен
  // вспоминать, что уже выбрал.
  const count = ids.reduce((n, id) => n + state.cart[id], 0);
  const total = ids.reduce((sum, key) => {
    const { id, mods } = parseLine(key);
    const it = items.find((i) => i.id === id);
    return sum + (it ? priceWith(it, mods) : 0) * state.cart[key];
  }, 0);
  return `
    <div class="card">
      <div style="font-weight:600;margin-bottom:8px">Ваш заказ: ${count} ${plural(count, 'позиция', 'позиции', 'позиций')} · ${money(total)}</div>
      <div class="small muted" style="margin-bottom:12px">
        ${delivery ? 'Доставка или самовывоз: заведение позвонит и подтвердит заказ.' : orderHint()}
      </div>
      ${delivery
    ? `<button class="btn-primary" id="goCheckout">${ic('bag')}Доставка или с собой</button>`
    : '<button class="btn-primary" id="sendOrder">Отправить заказ</button>'}
    </div>`;
}

// Строка корзины: id позиции и выбранные модификаторы — как lineId в кассе.
const lineKey = (id, mods) => (mods.length ? `${id}|${mods.join('|')}` : id);
function parseLine(key) {
  const [id, ...mods] = String(key).split('|');
  return { id, mods };
}
const modGroups = (i) => (Array.isArray(i.modifierGroups) ? i.modifierGroups : [])
  .filter((g) => g && Array.isArray(g.options) && g.options.length);
const hasMods = (i) => modGroups(i).length > 0;
function priceWith(item, mods) {
  const set = new Set(mods);
  let p = Number(item.price) || 0;
  modGroups(item).forEach((g) => g.options.forEach((o) => { if (set.has(o.name)) p += Number(o.price) || 0; }));
  return p;
}
function cartQty(id) {
  return Object.keys(state.cart).reduce((n, k) => n + (parseLine(k).id === id ? state.cart[k] : 0), 0);
}

function addToCart(id, items, redraw) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  if (!hasMods(item)) {
    state.cart[id] = (state.cart[id] || 0) + 1;
    state.cartOrder = [...(state.cartOrder || []).filter((k) => k !== id), id];
    return redraw();
  }
  pickModifiers(item, (mods) => {
    const key = lineKey(id, mods);
    state.cart[key] = (state.cart[key] || 0) + 1;
    state.cartOrder = [...(state.cartOrder || []).filter((k) => k !== key), key];
    redraw();
  });
}
/// «−» у позиции убирает последнюю добавленную её строку.
function removeFromCart(id) {
  const keys = (state.cartOrder || []).filter((k) => parseLine(k).id === id && state.cart[k]);
  const key = keys.length ? keys[keys.length - 1] : (state.cart[id] ? id : null);
  if (!key) return;
  state.cart[key] -= 1;
  if (state.cart[key] <= 0) {
    delete state.cart[key];
    state.cartOrder = (state.cartOrder || []).filter((k) => k !== key);
  }
}

/// Выбор модификаторов: группы с ограничениями «от … до …», как в кассе.
function pickModifiers(item, done) {
  const groups = modGroups(item);
  const chosen = groups.map(() => new Set());
  const wrap = document.createElement('div');
  wrap.className = 'modsheet';
  const check = () => {
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const n = chosen[gi].size;
      const min = Number(g.min) || 0;
      const max = g.max == null ? 1 : Number(g.max);
      if (n < min) return min === 1 ? `Выберите: ${g.name}` : `${g.name}: выберите не меньше ${min}`;
      if (max > 0 && n > max) return `${g.name}: не больше ${max}`;
    }
    return '';
  };
  const paint = () => {
    const mods = groups.flatMap((g, gi) => g.options.filter((o) => chosen[gi].has(o.name)).map((o) => o.name));
    const problem = check();
    wrap.innerHTML = `
      <div class="modsheet-body" role="dialog" aria-label="${esc(item.name)}">
        <div style="font-size:20px;font-weight:700;margin-bottom:4px">${esc(item.name)}</div>
        ${groups.map((g, gi) => {
          const max = g.max == null ? 1 : Number(g.max);
          const hint = (Number(g.min) || 0) > 0 ? 'обязательно' : max === 1 ? 'по желанию, одно' : 'по желанию';
          return `<div class="small muted" style="margin:14px 0 8px">${esc(g.name)} · ${hint}</div>
            <div class="chips">${g.options.map((o) => `<button class="chip${chosen[gi].has(o.name) ? ' on' : ''}"
              data-g="${gi}" data-o="${esc(o.name)}">${esc(o.name)}${Number(o.price) ? ` +${money(o.price)}` : ''}</button>`).join('')}</div>`;
        }).join('')}
        <button class="btn-primary" id="modsOk" style="margin-top:18px" ${problem ? 'disabled' : ''}>
          ${problem ? esc(problem) : `Добавить · ${money(priceWith(item, mods))}`}</button>
        <button class="btn-ghost" id="modsCancel" style="margin-top:10px">Отмена</button>
      </div>`;
    wrap.querySelectorAll('[data-g]').forEach((el) => {
      el.onclick = () => {
        const gi = Number(el.dataset.g);
        const set = chosen[gi];
        const max = groups[gi].max == null ? 1 : Number(groups[gi].max);
        if (set.has(el.dataset.o)) set.delete(el.dataset.o);
        else {
          if (max === 1) set.clear();
          set.add(el.dataset.o);
        }
        paint();
      };
    });
    wrap.querySelector('#modsOk').onclick = () => {
      if (check()) return;
      wrap.remove();
      done(groups.flatMap((g, gi) => g.options.filter((o) => chosen[gi].has(o.name)).map((o) => o.name)));
    };
    wrap.querySelector('#modsCancel').onclick = () => wrap.remove();
  };
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  paint();
  document.body.appendChild(wrap);
}

/// Кому уходит часть заказа (как AppConstants.guestOrderTarget в
/// приложении): кальян — кальянщику, блюда и напитки — официанту, в баре —
/// бармену. Каждый подтверждает свою часть сам.
function orderTarget(hookahItem) {
  if (hookahItem && isHookah()) return 'hookah_master';
  return venueType() === 'bar' ? 'bartender' : 'waiter';
}
const TARGET_DAT = { hookah_master: 'кальянщику', bartender: 'бармену', waiter: 'официанту' };
const TARGET_NOM = { hookah_master: 'кальянщик', bartender: 'бармен', waiter: 'официант' };

/// Подпись после отправки: кому что ушло.
function orderSentText(targets) {
  if (targets.length > 1 && targets.includes('hookah_master')) {
    const other = targets.find((t) => t !== 'hookah_master');
    return `Заказ передан: блюда и напитки — ${TARGET_DAT[other]}, кальян — кальянщику`;
  }
  return `Заказ передан ${TARGET_DAT[targets[0] || 'waiter']} — он подтвердит его`;
}

async function placeOrder(items, redraw, isTobacco = (i) => TOBACCO_RE.test(i.name || '')) {
  const p = state.profile;
  if (!p || !p.activeSessionId) return toast('Сначала откройте свой стол');
  const chosen = Object.entries(state.cart).map(([key, qty]) => {
    const { id, mods } = parseLine(key);
    const it = items.find((i) => i.id === id);
    return it ? { item: { menuItemId: it.id, name: it.name, price: priceWith(it, mods), qty, ...(mods.length ? { mods } : {}) },
      target: orderTarget(isTobacco(it)) } : null;
  }).filter(Boolean);
  if (!chosen.length) return;
  // Части заказа по адресатам, в порядке позиций.
  const groups = new Map();
  chosen.forEach(({ item, target }) => {
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(item);
  });

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
    for (const [target, list] of groups) {
      await addDoc(collection(state.root, 'guestOrders'), {
        sessionId: p.activeSessionId,
        tableId,
        tableName,
        clientUid: state.uid,
        // Режим rf: касса узнает гостя по clientUid из справочника в РФ.
        guestName: rfMode() ? '' : (p.name || ''),
        items: list,
        comment: '',
        targetPosition: target,
        status: 'new',
        rejectReason: '',
        createdAt: Timestamp.fromDate(new Date()),
      });
    }
    state.cart = {};
    toast(orderSentText([...groups.keys()]));
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
    // Режим rf: номера в документе нет, есть отметка phoneOnFile.
    if (!(own.exists() && hasPhoneOnFile(own.data()))) {
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
    <div id="myOrders"></div>
    <h1>Мой стол</h1>
    <p class="muted">Отсканируйте QR-код на своём столе — откроется ваш счёт и кнопки вызова персонала.</p>
    <a class="btn btn-primary" href="#/scan">${ic('scan')}Сканировать QR стола</a>
    <div style="height:10px"></div>
    <a class="btn btn-ghost" href="#/hall">${ic('plan')}Карта зала</a>
    <div style="height:14px"></div>
    <p class="small muted">Стол открывается только по коду с самого стола —
    так вы наверняка попадёте на свой счёт, а не на соседний. Если код не
    сканируется, попросите ${staffWord('acc')} — он откроет стол сам.</p>
    ${rules.length ? `
      <div class="card" style="margin-top:22px">
        <div class="row" style="font-weight:600;margin-bottom:12px">${ic('info', 'gold')}Правила заведения</div>
        ${rules.map((r) => `<div class="rule"><i></i><div class="small muted">${esc(r)}</div></div>`).join('')}
      </div>` : ''}`;
  renderMyOrders('myOrders');
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
  const sbpOn = onlinePayReady();
  const guestPaid = Number(s.guestPaidTotal) || 0;

  screenEl().innerHTML = `
    <div class="row">
      <h1 class="t-title grow ellipsis">${esc(tableTitle(s.tableName))}</h1>
      <button class="btn-link" id="unbind">Это не мой стол</button>
    </div>

    ${showTimer ? `<div class="card timer" id="timer"><div class="value">—</div></div>` : ''}

    <button class="btn-primary" id="orderFromTable">${ic('cloche')}Сделать заказ</button>
    <p class="small muted" style="margin:8px 0 0">${orderHint()}</p>

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
        ${guestPaid > 0 ? `<div class="bill-line" style="color:var(--gold)">
          <span class="grow">Оплачено онлайн</span><span>−${money(guestPaid)}</span></div>` : ''}
        ${bonus >= 1 ? `<div class="small" style="color:var(--gold);margin-top:10px">
          Доступно бонусов: ${money(bonus)} — скажите ${staffWord('dat')}, чтобы списать при оплате</div>` : ''}
      ` : `<p class="muted small" style="margin:0">Пока пусто — нажмите «Сделать заказ»</p>`}
    </div>

    ${tipsOn ? `<h2>Чаевые</h2><div class="card"><div id="tipsPanel"></div></div>` : ''}

    ${sbpOn && items.length ? `<h2>Оплата</h2><div class="card"><div id="sbpPanel"></div></div>` : ''}

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
  if (sbpOn) paintSbp(s);
}

// ---------- ВОЗВРАТ НА ЭКРАН ----------
// iOS усыпляет вкладку и PWA «на экране Домой»: соединение с базой
// замирает, и после возврата бонусы и статусы приходили с задержкой в
// десятки секунд. Вернулись после паузы — сразу переподключаемся, подписки
// получают свежие данные за доли секунды. Держать соединение открытым в
// фоне iOS не даёт никому — ни сайту, ни Service Worker'у.
function watchResume() {
  let hiddenAt = 0;
  let busy = false;
  const resume = async () => {
    if (!state.db || busy || !hiddenAt || Date.now() - hiddenAt < 5000) { hiddenAt = 0; return; }
    hiddenAt = 0;
    busy = true;
    try {
      await disableNetwork(state.db);
      await enableNetwork(state.db);
    } catch (_) { /* SDK переподключится сам */ } finally { busy = false; }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else resume();
  });
  // Страница вернулась из кэша «назад/вперёд» (bfcache) — то же самое.
  window.addEventListener('pageshow', (e) => { if (e.persisted) { hiddenAt = hiddenAt || Date.now() - 6000; resume(); } });
  window.addEventListener('online', () => { hiddenAt = hiddenAt || Date.now() - 6000; resume(); });
}

// ---------- ОПЛАТА ПО СБП СО СТОЛА ----------
// Сумму считает сервер по счёту; гость только подтверждает в своём банке.

/// Онлайн-оплата из приложения — счёт за столом или заказ доставки
/// (takeaway). Банк заведения — в venueProfile.onlinePay; реквизиты на
/// сервере, платёж заводит шлюз (guest-pay.js).
function paintSbp(s, boxId = 'sbpPanel', takeaway = false) {
  const box = $(boxId);
  if (!box) return;
  const sbpOnly = SBP_ONLY.includes((state.venue || {}).onlinePay);
  const p = state.sbp && state.sbp.sid === s.id ? state.sbp : null;
  if (p && p.status === 'paid') {
    box.innerHTML = `<p style="margin:0">${ic('check')} Оплата прошла — спасибо! ${takeaway ? 'Чек — от заведения.' : `${cap(staffWord('nom'))} уже знает.`}</p>`;
    return;
  }
  if (p && p.link) {
    box.innerHTML = `
      <p class="small muted" style="margin:0 0 10px">К оплате ${money(p.amount)}. ${sbpOnly
    ? 'Выберите свой банк и подтвердите перевод'
    : 'Оплатите на странице банка — СБП или картой'} — мы сами увидим оплату.</p>
      <a class="btn btn-primary" href="${esc(p.link)}" target="_blank" rel="noopener">${sbpOnly ? 'Открыть приложение банка' : 'Открыть страницу оплаты'}</a>
      <p class="small muted" style="margin:10px 0 0">${p.status === 'failed' ? 'Платёж не прошёл — попробуйте ещё раз.' : 'Ждём подтверждения банка…'}</p>
      ${p.status === 'failed' ? '<button class="btn-ghost" id="sbpPay" style="margin-top:10px">Оплатить заново</button>' : ''}`;
  } else {
    box.innerHTML = `
      <p class="small muted" style="margin:0 0 10px">${takeaway
    ? `Оплатите заказ сейчас — ${sbpOnly ? 'через СБП' : 'СБП или картой'}. Чек — от заведения.`
    : `Оплатите счёт сами ${sbpOnly ? 'через СБП' : 'онлайн — СБП или картой'}, без ожидания официанта и терминала.
        Чаевые, добавленные к счёту, войдут в сумму.`}</p>
      <button class="btn-primary" id="sbpPay">${sbpOnly ? 'Оплатить по СБП' : 'Оплатить онлайн'}</button>`;
  }
  box.insertAdjacentHTML('beforeend', sellerHtml());
  const btn = $('sbpPay');
  if (btn) btn.onclick = () => startSbp(s, btn, boxId, takeaway);
}

async function gatewayPost(path, body) {
  const token = await state.auth.currentUser.getIdToken();
  const res = await fetch(`${GATEWAY}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tenantId: state.tenantId, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Сервис оплаты недоступен');
  return json;
}

async function startSbp(s, btn, boxId = 'sbpPanel', takeaway = false) {
  btn.disabled = true;
  try {
    const r = await gatewayPost('/guestPayStart', { sessionId: s.id });
    const link = r.url || r.payload;
    state.sbp = { sid: s.id, paymentId: r.paymentId, link, amount: r.amount, status: 'pending', boxId, takeaway };
    paintSbp(s, boxId, takeaway);
    if (link) window.open(link, '_blank', 'noopener');
    pollSbp(s);
  } catch (e) {
    toast(e.message || 'Не удалось начать оплату');
    btn.disabled = false;
  }
}

function pollSbp(s) {
  const p = state.sbp;
  if (!p || p.polling) return;
  p.polling = true;
  const started = Date.now();
  const tick = async () => {
    if (state.sbp !== p || p.status !== 'pending' || Date.now() - started > 16 * 60 * 1000) {
      p.polling = false;
      return;
    }
    try {
      const r = await gatewayPost('/guestPayStatus', { paymentId: p.paymentId });
      if (r.status !== p.status) {
        p.status = r.status;
        paintSbp(s, p.boxId, p.takeaway);
        if (r.status === 'paid') toast('Оплата прошла');
      }
    } catch (_) { /* сеть моргнула — следующий опрос */ }
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

// ---------- ДОСТАВКА И С СОБОЙ ----------
// Как в приложении на Android (kolibri_checkout_screen.dart): заказ уходит
// на шлюз (/guestDeliveryOrder), тот сверяет цены с меню, сначала пишет
// контакт в базу в РФ и передаёт заказ кассе. Заведение звонит гостю и
// подтверждает — только тогда готовят и, если гость выбрал «онлайн»,
// открывается оплата. За отклонённый заказ деньги не списываются.

/// Банки, у которых гость платит только по СБП; у остальных — страница
/// оплаты банка, где можно и по СБП, и картой (как sbpOnly в online_pay.dart).
const SBP_ONLY = ['tinkoff', 'raiffeisen'];
/// Банки, которые сейчас поддерживает шлюз (guest-pay.js, PROVIDERS).
const PAY_PROVIDERS = ['tinkoff', 'tinkoff_form', 'sber', 'alfa', 'vtb', 'mts', 'raiffeisen', 'robokassa', 'rbs_custom'];

/// Реквизиты продавца — гость видит их до заказа и оплаты (закон «О защите
/// прав потребителей»). Без них заказ и оплата из приложения недоступны.
/// Как sellerReady в lib/models/venue_models.dart и guest-pay.js.
function sellerReady() {
  const v = state.venue || {};
  return String(v.sellerName || '').trim().length >= 3
    && /^(\d{10}|\d{12})$/.test(String(v.sellerInn || ''))
    && /^(\d{13}|\d{15})$/.test(String(v.sellerOgrn || ''))
    && requisitesValid(String(v.sellerInn), String(v.sellerOgrn))
    && String(v.sellerAddress || '').trim().length >= 5;
}

/// Контрольные цифры ИНН и ОГРН и их тип (организация 10+13, ИП 12+15) —
/// как saas-gateway/requisites.js и lib/utils/ru_requisites.dart.
function requisitesValid(inn, ogrn) {
  const sum = (d, w) => (w.reduce((a, k, i) => a + Number(d[i]) * k, 0) % 11) % 10;
  const mod = (d, m) => [...d].reduce((r, c) => (r * 10 + Number(c)) % m, 0);
  const innOk = inn.length === 10
    ? sum(inn, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[9])
    : inn.length === 12
      && sum(inn, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[10])
      && sum(inn, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[11]);
  const ogrnOk = ogrn.length === 13
    ? /^[15]/.test(ogrn) && mod(ogrn.slice(0, 12), 11) % 10 === Number(ogrn[12])
    : ogrn.length === 15 && ogrn[0] === '3' && mod(ogrn.slice(0, 14), 13) % 10 === Number(ogrn[14]);
  return innOk && ogrnOk && (inn.length === 10) === (ogrn.length === 13);
}
function sellerLine() {
  if (!sellerReady()) return '';
  const v = state.venue;
  return `Продавец: ${v.sellerName.trim()}, ИНН ${v.sellerInn}, ${v.sellerOgrn.length === 15 ? 'ОГРНИП' : 'ОГРН'} ${v.sellerOgrn}, ${v.sellerAddress.trim()}`;
}
const sellerHtml = () => (sellerReady()
  ? `<p class="small muted center" style="margin:10px 0 0;font-size:11.5px">${esc(sellerLine())}</p>` : '');

const deliveryOn = () => (state.venue || {}).deliveryEnabled === true && sellerReady();
/// Владелец включил оплату из приложения, банк подтвердил реквизиты
/// (шлюз ставит onlinePay после проверки) и указан продавец.
const onlinePayReady = () => (state.venue || {}).guestSbpPay === true
  && PAY_PROVIDERS.includes((state.venue || {}).onlinePay) && sellerReady();

// Дистанционно нельзя продавать табак и кальяны (ст. 19 закона № 15-ФЗ) и
// алкоголь, включая пиво (ст. 16 закона № 171-ФЗ). Те же правила — на
// шлюзе (guest-delivery.js): он и решает, здесь — чтобы гость видел заранее.
const REMOTE_TOBACCO_RE = /кальян|табак|никотин|hookah|shisha|снюс|вейп|сигар|чаш[аи]|забивк/i;
const ALCOHOL_RE = /(^|[^а-яё])(пив[оа]|пивн|вин[оа]($|[^а-яё])|винн|игрист|шампанск|просекко|виски|коньяк|водк|ром($|[^а-яё])|джин($|[^а-яё])|текил|ликёр|ликер|настойк|наливк|сидр|абсент|бренди|вермут|мартини|портвейн|херес|саке|бурбон|кальвадос|граппа|самбук|аперол|медовух|алко)/i;
function remoteSaleBanned(item, catName = '') {
  const name = String(item.name || '');
  if (item.tobacco === true || REMOTE_TOBACCO_RE.test(name) || REMOTE_TOBACCO_RE.test(catName)) return true;
  if (item.fiscalSubject === 'excise' || item.alcohol === true) return true;
  if (/безалк/i.test(name)) return false;
  return ALCOHOL_RE.test(name) || ALCOHOL_RE.test(catName);
}

/// Короткий номер заказа — тот же, что видит персонал на кассе и в Telegram.
/// Номер заказа: порядковый (orderNo — шлюз и касса ведут общий счётчик),
/// у старых заказов — последние 4 знака id. Как orderNumberLabel в кассе.
const orderNo = (id, no = 0) => (Number(no) > 0 ? String(Math.trunc(no)) : String(id).slice(-4).toUpperCase());

/// Шаги заказа — как DeliveryFlow (lib/models/delivery_status.dart).
const deliveryPath = (type) => (type === 'delivery'
  ? ['new', 'accepted', 'cooking', 'courier', 'done']
  : ['new', 'accepted', 'cooking', 'ready', 'done']);
function deliveryStatusOf(s) {
  const st = s.deliveryStatus;
  return st === 'cancelled' || deliveryPath(s.orderType).includes(st) ? st : 'new';
}
function deliveryLabel(type, st) {
  return {
    new: 'Ждёт подтверждения',
    accepted: 'Принят',
    cooking: 'Готовится',
    courier: 'У курьера',
    ready: 'Готов к выдаче',
    done: type === 'delivery' ? 'Доставлен' : 'Выдан',
    cancelled: 'Отменён',
  }[st] || '';
}

// Адрес и имя прошлого заказа — только в этом браузере, никуда не уходят.
const contactKey = () => 'deliveryContact:' + state.tenantId;
function loadContact() {
  try { return JSON.parse(localStorage.getItem(contactKey()) || '{}') || {}; } catch (_) { return {}; }
}
function saveContact(c) {
  try { localStorage.setItem(contactKey(), JSON.stringify(c)); } catch (_) {}
}

async function screenCheckout() {
  if (!deliveryOn()) {
    screenEl().innerHTML = `
      <h1>Доставка</h1>
      <p class="muted">Заведение сейчас не принимает заказы с доставкой и с собой из приложения.</p>
      <a class="btn btn-ghost" href="#/menu">${ic('menu')}В меню</a>`;
    return;
  }
  if (!Object.keys(state.cart).length) { location.hash = '#/menu'; return; }
  screenEl().innerHTML = `<h1>Оформление заказа</h1><div class="spinner"></div>`;

  let items = [];
  let cats = [];
  try {
    const [mi, mc] = await Promise.all([
      getDocs(collection(state.root, 'menuItems')),
      getDocs(collection(state.root, 'menuCategories')),
    ]);
    items = mi.docs.map((d) => ({ id: d.id, ...d.data() })).filter((i) => i.available !== false);
    cats = mc.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (_) {
    screenEl().innerHTML = `<h1>Оформление заказа</h1>
      <p class="muted">Не удалось загрузить меню — проверьте интернет и попробуйте ещё раз.</p>
      <a class="btn btn-ghost" href="#/menu">${ic('back')}В меню</a>`;
    return;
  }
  // Пока грузили, гость мог уйти на другой экран.
  if (location.hash !== '#/checkout') return;

  const catName = (id) => (cats.find((c) => c.id === id) || {}).name || '';
  const lines = Object.entries(state.cart).map(([key, qty]) => {
    const { id, mods } = parseLine(key);
    const it = items.find((i) => i.id === id);
    if (!it) return null;
    return {
      key, qty, mods, name: it.name, menuItemId: it.id,
      price: priceWith(it, mods),
      banned: remoteSaleBanned(it, catName(it.categoryId)),
    };
  }).filter(Boolean);
  const allowed = lines.filter((l) => !l.banned);
  const skipped = lines.filter((l) => l.banned);
  const total = allowed.reduce((a, l) => a + l.price * l.qty, 0);

  const v = state.venue || {};
  const p = state.profile || {};
  const saved = loadContact();
  const online = onlinePayReady();
  const sbpOnly = SBP_ONLY.includes(v.onlinePay);
  let delivery = saved.type !== 'takeaway';
  let payOnline = false;

  screenEl().innerHTML = `
    <div class="backbar"><button data-back aria-label="В меню">${ic('back')}</button><h1 style="margin:0">Оформление заказа</h1></div>

    <div class="chips" style="margin-top:14px">
      <button class="chip" data-type="delivery">Доставка</button>
      <button class="chip" data-type="takeaway">Заберу сам</button>
    </div>
    <p class="small muted" id="pickupHint" style="margin:0 0 12px">${v.address ? 'Забрать: ' + esc(v.address) : ''}</p>

    <div class="card">
      <label class="field"><span>Как к вам обращаться</span>
        <input id="dName" autocomplete="name" maxlength="60" value="${esc(saved.name || p.name || '')}"></label>
      <label class="field"><span>Телефон</span>
        <input id="dPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 9XX XXX-XX-XX"
          value="${esc(saved.phone || (p.phone ? prettyPhone(p.phone) : ''))}"></label>
      <p class="small muted" id="dPhoneHint" style="margin:-4px 0 12px">Заведение позвонит, чтобы подтвердить заказ.</p>

      <div id="addrBox">
        <label class="field"><span>Улица и дом</span>
          <input id="dStreet" autocomplete="street-address" maxlength="120" value="${esc(saved.street || '')}"></label>
        <div class="btn-row">
          <label class="field"><span>Кв./офис</span><input id="dFlat" maxlength="12" value="${esc(saved.flat || '')}"></label>
          <label class="field"><span>Подъезд</span><input id="dEntrance" inputmode="numeric" maxlength="6" value="${esc(saved.entrance || '')}"></label>
        </div>
        <div class="btn-row">
          <label class="field"><span>Этаж</span><input id="dFloor" inputmode="numeric" maxlength="4" value="${esc(saved.floor || '')}"></label>
          <label class="field"><span>Домофон</span><input id="dIntercom" maxlength="12" value="${esc(saved.intercom || '')}"></label>
        </div>
      </div>

      <label class="field"><span id="dCommentLabel">Комментарий</span>
        <textarea id="dComment" rows="2" maxlength="300" placeholder="Например: без лука, позвонить за 10 минут"></textarea></label>
    </div>

    <h2>Оплата</h2>
    <div class="chips">
      <button class="chip" data-pay="receipt" id="payReceipt">При получении</button>
      ${online ? `<button class="chip" data-pay="online">${sbpOnly ? 'Онлайн по СБП' : 'Онлайн — СБП или картой'}</button>` : ''}
    </div>
    <p class="small muted" id="payHint" style="margin:0 0 12px"></p>

    <div class="card">
      ${allowed.map((l) => `
        <div class="bill-line">
          <span class="grow">${esc(l.name)}${l.mods.length ? ` <span class="muted small">(${esc(l.mods.join(', '))})</span>` : ''} ×${l.qty}</span>
          <span class="muted">${money(l.price * l.qty)}</span>
        </div>`).join('')}
      <div class="bill-total"><span>Итого</span><span>${money(total)}</span></div>
    </div>
    ${skipped.length ? `<div class="card warn small">
      Не продаются с собой и с доставкой: ${esc(skipped.map((l) => l.name).join(', '))}.
      Табак, кальяны и алкоголь — только в заведении (законы № 15-ФЗ и № 171-ФЗ).</div>` : ''}

    <div>
      ${consentHtml()}
      <button class="btn-primary" id="dSend" ${allowed.length ? '' : 'disabled'}>Оформить заказ · ${money(total)}</button>
    </div>
    ${sellerHtml()}
    <p class="small muted center" style="margin:12px 0 0">Имя, телефон и адрес нужны заведению, чтобы подтвердить
      и передать заказ. Сначала они записываются на сервер в России, через 30 дней после выполнения заказа обезличиваются.</p>
    ${privacyNotice()}`;

  const paint = () => {
    screenEl().querySelectorAll('[data-type]').forEach((b) => b.classList.toggle('on', (b.dataset.type === 'delivery') === delivery));
    screenEl().querySelectorAll('[data-pay]').forEach((b) => b.classList.toggle('on', (b.dataset.pay === 'online') === payOnline));
    $('addrBox').style.display = delivery ? '' : 'none';
    $('pickupHint').style.display = !delivery && v.address ? '' : 'none';
    $('dCommentLabel').textContent = delivery ? 'Комментарий курьеру и кухне' : 'Комментарий к заказу';
    $('payHint').textContent = payOnline
      ? 'Кнопка оплаты появится после того, как заведение подтвердит заказ.'
      : delivery ? 'Наличными или картой курьеру.' : 'На кассе заведения.';
  };
  paint();
  screenEl().querySelectorAll('[data-type]').forEach((b) => {
    b.onclick = () => { delivery = b.dataset.type === 'delivery'; paint(); };
  });
  screenEl().querySelectorAll('[data-pay]').forEach((b) => {
    b.onclick = () => { payOnline = b.dataset.pay === 'online'; paint(); };
  });
  screenEl().querySelector('[data-back]').onclick = () => { location.hash = '#/menu'; };

  const send = $('dSend');
  const consent = bindConsent(send, () => allowed.length > 0);
  send.onclick = async () => {
    if (!consent.ready()) return toast(consentToast());
    const val = (id) => $(id).value.trim();
    const name = val('dName');
    const phoneRaw = val('dPhone');
    const problem = phoneProblem(phoneRaw);
    $('dPhoneHint').textContent = problem || 'Заведение позвонит, чтобы подтвердить заказ.';
    $('dPhoneHint').style.color = problem ? 'var(--danger)' : '';
    if (name.length < 2) { $('dName').focus(); return toast('Как к вам обращаться? Укажите имя'); }
    if (problem) { $('dPhone').focus(); return toast(problem); }
    if (delivery && val('dStreet').length < 5) { $('dStreet').focus(); return toast('Укажите улицу и дом'); }
    const address = {
      street: val('dStreet'), flat: val('dFlat'), entrance: val('dEntrance'),
      floor: val('dFloor'), intercom: val('dIntercom'),
    };
    send.disabled = true;
    try {
      await commitConsent();
      const r = await gatewayPost('/guestDeliveryOrder', {
        orderType: delivery ? 'delivery' : 'takeaway',
        name,
        phone: normalizePhone(phoneRaw),
        ...(delivery ? { address } : {}),
        comment: val('dComment'),
        payMethod: payOnline && online ? 'online' : 'on_receipt',
        items: allowed.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty, ...(l.mods.length ? { mods: l.mods } : {}) })),
      });
      saveContact({ type: delivery ? 'delivery' : 'takeaway', name, phone: phoneRaw, ...address });
      // В корзине остаются только позиции, которые с собой не продаются, —
      // их можно заказать, когда гость придёт в заведение.
      allowed.forEach((l) => { delete state.cart[l.key]; });
      state.cartOrder = (state.cartOrder || []).filter((k) => state.cart[k]);
      toast(`Заказ №${r.orderNo || orderNo(r.sessionId)} оформлен — ждите звонка`);
      location.hash = '#/order/' + r.sessionId;
    } catch (e) {
      toast(e.message || 'Не удалось оформить заказ');
      send.disabled = false;
    }
  };
}

/// Заказ глазами гостя: шаги, состав, оплата после подтверждения, отмена,
/// пока заказ не подтвердили.
function screenOrder(id) {
  screenEl().innerHTML = `<h1>Заказ</h1><div class="spinner"></div>`;
  let s = null;
  let pending = [];

  const draw = () => {
    if (!s) return;
    const type = s.orderType === 'delivery' ? 'delivery' : 'takeaway';
    const st = deliveryStatusOf(s);
    const path = deliveryPath(type);
    const cur = path.indexOf(st);
    const cancelled = st === 'cancelled';
    const paid = Number(s.guestPaidTotal) || 0;
    const v = state.venue || {};
    const lines = (s.orderItems || []).length ? s.orderItems
      : pending.filter((o) => o.status !== 'rejected').flatMap((o) => o.items || []);
    const sum = (s.orderItems || []).length && Number(s.totalWithDiscount) > 0
      ? Number(s.totalWithDiscount)
      : lines.reduce((a, i) => a + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
    const courier = courierOf(s, draw);
    const hint = {
      new: `Заказ получен. Заведение позвонит вам, чтобы подтвердить состав${type === 'delivery' ? ' и адрес' : ''} — держите телефон рядом.`,
      accepted: 'Заказ подтверждён и скоро начнут готовить.',
      cooking: 'Готовим ваш заказ.',
      courier: `Курьер ${courier.name ? esc(courier.name) + ' ' : ''}в пути.`,
      ready: `Заказ готов — можно забирать${v.address ? ': ' + esc(v.address) : ''}.`,
      done: type === 'delivery' ? 'Заказ доставлен. Приятного аппетита!' : 'Заказ выдан. Приятного аппетита!',
      cancelled: `Заказ отменён${s.cancelReason ? ': ' + esc(s.cancelReason) : ''}.`,
    }[st];
    const fullyPaid = paid > 0 && sum > 0 && paid + 0.01 >= sum;
    let payBlock = '';
    if (!cancelled && st !== 'done') {
      if (s.payMethod === 'online') {
        payBlock = st === 'new'
          ? '<p class="small muted" style="margin:0">Оплата онлайн станет доступна сразу после подтверждения заказа.</p>'
          : fullyPaid ? `<p style="margin:0">${ic('check')} Оплачено онлайн: ${money(paid)}. Чек — от заведения.</p>`
            : onlinePayReady() ? '<div id="payPanel"></div>'
              : '<p class="small muted" style="margin:0">Онлайн-оплата сейчас недоступна — оплатите при получении.</p>';
      } else {
        payBlock = `<p class="small muted" style="margin:0">${type === 'delivery'
          ? 'Оплата при получении — наличными или картой курьеру.'
          : 'Оплата при получении — на кассе заведения.'}</p>`;
      }
    }

    screenEl().innerHTML = `
      <div class="overline">Заказ №${esc(orderNo(s.id, s.orderNo))}</div>
      <h1 style="margin-top:4px">${type === 'delivery' ? 'Доставка' : 'С собой'}</h1>
      <p class="${cancelled ? '' : 'muted'}" style="${cancelled ? 'color:var(--danger)' : ''}">${hint}</p>
      ${st === 'courier' && /^\d{11}$/.test(courier.phone) ? `<a class="btn btn-ghost" href="tel:+${esc(courier.phone)}"
        style="margin:0 0 14px">${ic('phone')}Позвонить курьеру${courier.name ? ' · ' + esc(courier.name) : ''}</a>` : ''}
      ${cancelled ? '' : `<div class="card dsteps">${path.map((x, i) => {
        const done = i < cur || st === 'done';
        const active = i === cur && st !== 'done';
        return `<div class="dstep${done ? ' done' : ''}${active ? ' active' : ''}"><i>${done ? ic('check') : ''}</i><span>${deliveryLabel(type, x)}</span></div>`;
      }).join('')}</div>`}
      <div class="card">
        ${lines.map((i) => `<div class="bill-line">
          <span class="grow">${esc(i.name)}${(i.mods || []).length ? ` <span class="muted small">(${esc(i.mods.join(', '))})</span>` : ''} ×${Number(i.qty) || 0}</span>
          <span class="muted">${money((Number(i.price) || 0) * (Number(i.qty) || 0))}</span></div>`).join('')}
        <div class="bill-total"><span>Итого</span><span>${money(sum)}</span></div>
        ${paid > 0 ? `<div class="bill-line" style="color:var(--gold)"><span class="grow">Оплачено онлайн</span><span>${money(paid)}</span></div>` : ''}
      </div>
      ${payBlock ? `<h2>Оплата</h2><div class="card">${payBlock}</div>` : ''}
      ${st === 'new' && paid <= 0 ? '<button class="btn-ghost" id="oCancel">Отменить заказ</button>' : ''}
      ${v.phone ? `<div style="height:10px"></div>
        <a class="btn btn-ghost" href="tel:${esc(String(v.phone).replace(/[^\d+]/g, ''))}">${ic('phone')}Позвонить в заведение</a>
        <p class="small muted center" style="margin:6px 0 0">${esc(v.phone)}</p>` : ''}
      <div style="height:10px"></div>
      <a class="btn btn-ghost" href="#/menu">${ic('menu')}В меню</a>
      ${sellerHtml()}`;

    if ($('payPanel')) paintSbp(s, 'payPanel', true);
    const cancel = $('oCancel');
    if (cancel) {
      cancel.onclick = async () => {
        if (!confirm('Отменить заказ? Заведение его ещё не подтвердило.')) return;
        cancel.disabled = true;
        try {
          await gatewayPost('/guestDeliveryCancel', { sessionId: s.id });
          toast('Заказ отменён');
        } catch (e) {
          toast(e.message || 'Не удалось отменить');
          cancel.disabled = false;
        }
      };
    }
  };

  sub(onSnapshot(doc(state.root, 'sessions', id), (d) => {
    if (!d.exists()) {
      screenEl().innerHTML = `<h1>Заказ</h1><p class="muted">Заказ не найден.</p>
        <a class="btn btn-ghost" href="#/menu">${ic('menu')}В меню</a>`;
      return;
    }
    s = { id: d.id, ...d.data() };
    draw();
  }, () => {
    screenEl().innerHTML = `<h1>Заказ</h1><p class="muted">Этот заказ недоступен.</p>`;
  }));
  // До подтверждения позиции лежат в заявке, а не в чеке.
  sub(onSnapshot(query(collection(state.root, 'guestOrders'),
    where('clientUid', '==', state.uid), where('sessionId', '==', id)), (q) => {
    pending = q.docs.map((d) => d.data());
    draw();
  }, () => {}));
}

/// Свои заказы с доставкой и с собой за последние сутки — карточками над
/// «Моим столом»: в работе и только что завершённые.
function renderMyOrders(boxId) {
  if (!state.uid) return;
  sub(onSnapshot(query(collection(state.root, 'sessions'),
    where('clientUid', '==', state.uid), where('source', '==', 'app')), (snap) => {
    const box = $(boxId);
    if (!box) return;
    const recent = Date.now() - 3 * 3600 * 1000;
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((o) => {
        const st = deliveryStatusOf(o);
        const at = toDate(o.startTime);
        return (st !== 'done' && st !== 'cancelled' && at && at.getTime() > Date.now() - 2 * 86400 * 1000)
          || (at && at.getTime() > recent);
      })
      .sort((a, b) => (toDate(b.startTime) || 0) - (toDate(a.startTime) || 0))
      .slice(0, 3);
    box.innerHTML = list.length ? `<h2 style="margin-top:0">Мои заказы</h2>` + list.map((o) => `
      <a class="card order-link" href="#/order/${esc(o.id)}">
        <span class="ic-wrap">${ic(o.orderType === 'delivery' ? 'truck' : 'bag', 'gold')}</span>
        <span class="grow"><b>${o.orderType === 'delivery' ? 'Доставка' : 'С собой'} №${esc(orderNo(o.id, o.orderNo))}</b>
          <span class="small muted" style="display:block">${deliveryLabel(o.orderType, deliveryStatusOf(o))}</span></span>
        ${ic('chevron')}
      </a>`).join('') : '';
  }, () => {}));
}

const CALL_LABELS = {
  coal: 'Поменять угли',
  refill: 'Перезабивка',
  waiter: 'Позвать кальянщика',
  bill: 'Счёт, пожалуйста',
  callWaiter: 'Позвать официанта',
  paid: 'Оплачено онлайн',
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
    guestName: rfMode() ? '' : ((state.profile || {}).name || ''),
    type,
    comment: '',
    status: 'new',
    createdAt: Timestamp.fromDate(new Date()),
  }).catch(() => toast('Не удалось передать вызов'));

  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = 'Передано';
  // Счёт и официанта получает официант, остальное — кальянщик.
  const toWhom = type === 'bill' || type === 'callWaiter' ? 'официанту' : roleWord('dat');
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
          <div class="small muted">${o.status === 'new' && TARGET_DAT[o.targetPosition]
            ? `Передан ${TARGET_DAT[o.targetPosition]} · ждёт подтверждения`
            : esc(label(o.status))}${o.rejectReason ? ' · ' + esc(o.rejectReason) : ''}</div>
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
        guestName: rfMode() ? '' : ((state.profile || {}).name || ''),
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
      <label class="field"><span>Телефон (обязательно)</span>
        <input id="bPhone" type="tel" inputmode="tel" required
          value="${esc(p.phone ? prettyPhone(p.phone) : '')}"
          placeholder="+7 999 123-45-67" ${p.phone ? 'readonly' : ''}></label>
      <p class="small muted" style="margin:-4px 0 12px">
        ${p.phone
          ? ic('lock', 'inline') + 'Номер привязан — сменить его можно только через администратора'
          : 'По нему подтвердим бронь. Можно +7, 8 или просто 9…'}</p>

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
      <div>
        ${consentHtml()}
        <button class="btn-primary" id="bSend">Отправить заявку</button>
      </div>
      ${privacyNotice()}
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

  bindConsent($('bSend'));
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
    tables = tSnap.docs.filter((d) => d.id !== TAKEAWAY_ID).map((d) => ({ id: d.id, ...d.data() }));
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
  const tables = tSnap.docs.filter((d) => d.id !== TAKEAWAY_ID).map((d) => ({ id: d.id, ...d.data() }));
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
  await ensureOwnPd();
  const name = $('bName').value.trim();
  const locked = !!((state.profile || {}).phone);
  const phone = locked
    ? (state.profile.phone || '')
    : normalizePhone($('bPhone').value.trim());
  const guests = bookingGuests();
  const comment = $('bComment').value.trim();
  const duration = bookingDraft.duration || 90;

  if (!name) return toast('Укажите имя');
  if (!isValidRuPhone(phone)) {
    // Без номера бронь не принимаем — подсвечиваем поле и ведём к нему.
    const field = $('bPhone');
    if (field) { field.focus(); field.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    return toast(phone ? (phoneProblem(phone) || 'Проверьте номер телефона') : 'Укажите номер телефона — без него бронь не принимаем');
  }
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

  if (!consentReady($('bSend'))) return toast(consentToast());
  $('bSend').disabled = true;
  try {
    try {
      await commitConsent();
    } catch (e) {
      return toast(e.message);
    }
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

    // Имя и телефон — сначала на сервер в РФ, потом документ брони. В
    // режиме rf в документ они не попадают: правила базы проверяют
    // квитанцию сервера о том, что номер записан.
    const ref = doc(collection(state.root, 'reservations'));
    await piiPost({ tenantId: state.tenantId, kind: 'reservation', id: ref.id, name, phone });
    const rf = rfMode();
    await setDoc(ref, {
      clientUid: state.uid,
      guestName: rf ? '' : name,
      phone: rf ? '' : phone,
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
        // Режим rf: номер не кладём в Firestore даже ключом указателя.
        if (!rfMode()) {
          try {
            await setDoc(doc(state.loyaltyRoot, 'phoneIndex', phone), { uid: state.uid });
          } catch (_) {}
        }
      }
    }
    // Профиль гостя (имя/телефон) пишет сервер в РФ и сам зеркалит в
    // Firestore — напрямую в базу за рубежом эти поля не пишем.
    try {
      await piiPost({ tenantId: state.tenantId, uid: state.uid, ...patch });
      rememberOwnPd(patch);
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

/// Приводит любой российский номер к единому виду без «+»: 79001234567.
/// Правила те же, что в приложении (lib/utils/phone_utils.dart):
///   +7 900 123-45-67 · 7(900)123-45-67 · 8 900 123 45 67 · 9001234567
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

/// Что не так с номером — подсказка простыми словами; null — номер в
/// порядке. Как phoneProblem в lib/utils/phone_utils.dart.
function phoneProblem(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return 'Введите номер телефона';
  if (isValidRuPhone(normalizePhone(raw))) return null;
  const hasCode = String(raw).trim().startsWith('+7') ||
    ((d[0] === '7' || d[0] === '8') && (d.length > 10 || d[1] === '9'));
  const national = hasCode ? d.slice(1) : d;
  const sample = 'например, +7 9XX XXX-XX-XX';
  if (national.length < 10) {
    const miss = 10 - national.length;
    const word = miss % 10 === 1 && miss % 100 !== 11 ? 'цифры' : 'цифр';
    return `Не хватает ${miss} ${word}: после +7 нужно 10 цифр (${sample})`;
  }
  if (national.length > 10) return `Лишние цифры: после +7 нужно ровно 10 цифр (${sample})`;
  return `Нужен российский номер: +7 и 10 цифр (${sample})`;
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
      <div>
        ${consentHtml()}
        <button class="btn-primary" id="pSave">Сохранить</button>
      </div>
      ${privacyNotice()}
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

  bindConsent($('pSave'));
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
    // Режим rf: номеров в Firestore нет — отвечает справочник в РФ, и
    // гостю только «занят ли другим», без чужого uid.
    if (rfMode()) {
      const r = await piiPost({ tenantId: state.tenantId, kind: 'pii_phone', phone });
      return r.taken === true;
    }
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
      const problem = phoneProblem(raw);
      if (problem) {
        toast(problem);
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

    await commitConsent();
    const patch = { name: $('pName').value.trim() };
    if (!locked && phone) patch.phone = phone;
    // Имя и телефон — сначала в базу в РФ, сервер сам копирует их в профиль
    // Firestore. Напрямую в облако эти поля не пишем.
    await piiPost({ tenantId: state.tenantId, uid: state.uid, ...patch });
    rememberOwnPd(patch);
    // Введённое сохранено — профиль можно перерисовать (номер станет
    // «только для чтения»). Обновление профиля могло прийти, пока шло
    // сохранение, и тогда было пропущено — перерисовываем сами.
    state.profileDirty = false;
    if (location.hash === '#/profile' && patch.phone && (state.profile || {}).phone) route();
    if (patch.phone && !rfMode()) {
      // Указатель «номер → гость» вторичен: его осечка профилю не мешает.
      try { await setDoc(doc(state.loyaltyRoot, 'phoneIndex', phone), { uid: state.uid }); } catch (_) {}
    }
    toast('Сохранено');
  } catch (e) {
    toast(String((e && e.message) || '').startsWith('Согласие')
      ? e.message : 'Не удалось сохранить: проверьте интернет и попробуйте снова');
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
/// вчерашний сотрудник гостю не нужен. В режиме rf имён в документе нет —
/// они приходят из справочника в РФ (staffNameOf), до ответа сотрудника
/// не показываем.
function parseTipsTeam(data) {
  const members = (data && data.members) || {};
  const cutoff = Date.now() - 18 * 3600 * 1000;
  return Object.entries(members)
    .filter(([, m]) => m && typeof m === 'object')
    .filter(([, m]) => { const t = toDate(m.since); return !t || t.getTime() >= cutoff; })
    .map(([id, m]) => ({
      id,
      name: String(m.name || '').trim() || (rfMode() ? staffNameOf(id, paintTips) : ''),
      position: m.position || '',
      tipsLink: m.tipsLink || '',
    }))
    .filter((m) => m.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function watchTips(sessionId) {
  const t = state.tips;
  if (t.watching && t.sid === sessionId) return;
  if (t.sid !== sessionId) Object.assign(t, { to: null, preset: 10, custom: '', mine: [] });
  t.sid = sessionId;
  t.watching = true;
  sub(onSnapshot(doc(state.root, 'meta', 'tipsTeam'), (d) => {
    t.teamDoc = d.exists() ? d.data() : null;
    t.team = parseTipsTeam(t.teamDoc);
    paintTips();
  }, () => { t.teamDoc = null; t.team = []; paintTips(); }));
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
  // Имена из справочника могли прийти после снимка — пересобираем.
  if (rfMode() && t.teamDoc) t.team = parseTipsTeam(t.teamDoc);
  if (t.team.length) return t.team;
  const name = String(s.employeeName || '').trim()
    || (rfMode() && s.employeeId ? staffNameOf(s.employeeId, paintTips) : '');
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
          ${money(x.amount)} — ${esc(x.target === 'team' ? 'Всей смене'
            : (x.employeeName || (rfMode() ? staffNameOf(x.employeeId, paintTips) : '') || 'Смене'))} · ${status(x)}</span>
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
      // Режим rf: имён сотрудников в Firestore нет — касса берёт их по id.
      employeeName: to ? (rfMode() ? '' : to.name) : 'Всей смене',
      position: to ? to.position : '',
      teamMembers: to ? [] : team.filter((m) => m.id).map((m) => (rfMode() ? { id: m.id } : { id: m.id, name: m.name })),
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
      if (d.id === TAKEAWAY_ID) return;
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
  await ensureOwnPd();
  const p = state.profile || {};
  // Как с бронью и столом: без номера в очередь не ставим — по нему зовут,
  // когда стол освободится. Правила базы проверяют то же самое.
  if (!p.phone) {
    toast('Укажите номер телефона в профиле, чтобы встать в очередь');
    location.hash = '#/profile';
    return;
  }
  if (!(await askConsent())) return;
  btn.disabled = true;
  try {
    const minutes = await estimateWait(guests);
    // Имя и телефон — сначала на сервер в РФ (152-ФЗ), потом очередь.
    const ref = doc(collection(state.root, 'waitlist'));
    await piiPost({ tenantId: state.tenantId, kind: 'waitlist', id: ref.id, name: (p.name || '').trim(), phone: p.phone || '' });
    const rf = rfMode();
    await setDoc(ref, {
      guestName: rf ? '' : ((p.name || '').trim() || 'Гость'),
      phone: rf ? '' : (p.phone || ''),
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
    tables = snap.docs.filter((d) => d.id !== TAKEAWAY_ID).map((d) => ({ id: d.id, ...d.data() }))
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
