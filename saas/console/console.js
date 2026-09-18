// Консоль владельца заведения — веб-приложение SaaS-платформы Hoocah POS.
//
// Отдельный сайт от гостевого public/app: тот открывает гость по ссылке на
// столе, этот — владелец заведения, чтобы завести заведение, посмотреть код
// приглашения устройств и подписку. Тот же стиль (без сборки, ES-модули
// прямо из CDN, конфиг Firebase подтягивается с хостинга), см.
// public/app/app.js — но вход по email/паролю, а не анонимный.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signOut, sendEmailVerification,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot,
  collection, query, where, orderBy, limit, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getFunctions, httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';
import {
  getStorage, ref, uploadBytes, getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';

// Тот же регион, что у Cloud Functions платформы (см. saas/functions/index.js).
const FUNCTIONS_REGION = 'europe-west1';

// Метка версии консоли — меняется при каждой заметной правке этого файла.
// Показывается мелко внизу экрана входа и панели платформы: единственный
// способ на глаз отличить "деплой прошёл, но браузер показывает старый
// кэш" от "деплой ещё не запускали" — без нужды листать `firebase deploy`
// в терминале заново.
const CONSOLE_BUILD = '2026-09-18.2';
function versionFooterHtml() {
  return `<p class="small muted center" style="margin-top:24px;opacity:.5">build ${esc(CONSOLE_BUILD)}</p>`;
}

const state = {
  auth: null,
  db: null,
  functions: null,
  storage: null,
  uid: null,
  tenants: [],        // [{ id, role, name, slug }] — заведения этого владельца
  tenantsLoaded: false,
  activeTenantId: null,
  isSuperAdmin: false,
  accountSubs: [],     // подписки уровня аккаунта (список заведений)
  screenSubs: [],       // подписки текущего экрана (данные одного заведения)
};

const $ = (id) => document.getElementById(id);
const screenEl = () => $('screen');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 1×1 прозрачный GIF — заглушка для <img src> логотипа, пока своего нет:
// пустой src сам по себе триггерит повторный запрос текущей страницы.
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7';

function colorFieldHtml(id, label, value, editable) {
  return `
    <div class="row" style="margin-bottom:10px">
      <div style="width:84px" class="small muted">${esc(label)}</div>
      <input type="color" id="${id}" value="${esc(value)}"
        style="width:44px;height:36px;padding:2px;flex:none" ${editable ? '' : 'disabled'}>
      <div class="grow small muted" id="${id}-hex">${esc(value)}</div>
    </div>
  `;
}

// Контраст по формуле WCAG 2 — тот же расчёт, что и на стороне приложения
// (lib/theme/app_theme.dart, _contrastRatio) — предупреждаем владельца
// здесь, ДО сохранения, а на устройстве нечитаемая пара фон/текст всё равно
// откатится на цвета темы по умолчанию (двойная защита, не только совет).
function hexToRgb01(hex) {
  let h = String(hex ?? '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const num = parseInt(h, 16) || 0;
  return { r: ((num >> 16) & 255) / 255, g: ((num >> 8) & 255) / 255, b: (num & 255) / 255 };
}
function srgbChannel(c) {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb01(hex);
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}
function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA) + 0.05;
  const lb = relativeLuminance(hexB) + 0.05;
  return la > lb ? la / lb : lb / la;
}

// Готовые премиальные цветовые гаммы для брендинга клиентского приложения —
// подобраны так, чтобы подходить любому типу заведения (не только
// кальянным), с запасом по контрасту фон/текст (см. contrastRatio выше) и
// с достаточно тёмной/насыщенной кнопкой, чтобы текст на ней (тот же
// textColor, что и везде — см. updateBrandPreview) оставался читаемым.
// Первая гамма — байт-в-байт дефолт createTenant (saas/functions/index.js)
// и BrandingConfig (lib/models/tenant_models.dart) — выбор её эквивалентен
// "ничего не менять".
const PREMIUM_PALETTES = [
  { id: 'midnight', name: 'Полночный синий', primaryColor: '#0B5ED7', secondaryColor: '#162A4A', buttonColor: '#0B5ED7', backgroundColor: '#02050B', textColor: '#F8FAFC' },
  { id: 'emerald', name: 'Изумрудная ночь', primaryColor: '#9C7A22', secondaryColor: '#0E2A20', buttonColor: '#9C7A22', backgroundColor: '#071510', textColor: '#F4EFDD' },
  { id: 'bordeaux', name: 'Бордовый бархат', primaryColor: '#9C4A57', secondaryColor: '#3B0D14', buttonColor: '#9C4A57', backgroundColor: '#170406', textColor: '#F7E9E9' },
  { id: 'onyxgold', name: 'Оникс и золото', primaryColor: '#8C6B18', secondaryColor: '#1C1C1C', buttonColor: '#8C6B18', backgroundColor: '#0A0A0A', textColor: '#F5EFD6' },
  { id: 'amethyst', name: 'Аметистовые сумерки', primaryColor: '#7A4FB0', secondaryColor: '#2A1B3D', buttonColor: '#7A4FB0', backgroundColor: '#0D0714', textColor: '#F3EAFB' },
  { id: 'copper', name: 'Тлеющая медь', primaryColor: '#B25C29', secondaryColor: '#2B1B14', buttonColor: '#B25C29', backgroundColor: '#120B08', textColor: '#FBEDE1' },
  { id: 'graphite', name: 'Графит и серебро', primaryColor: '#5B6472', secondaryColor: '#1D2024', buttonColor: '#5B6472', backgroundColor: '#0E0F11', textColor: '#F2F3F5' },
  { id: 'sandstone', name: 'Песочный светлый', primaryColor: '#B5652E', secondaryColor: '#E4D8C4', buttonColor: '#B5652E', backgroundColor: '#F3ECE1', textColor: '#2B1D12' },
];

function paletteSwatchesHtml(selectedId) {
  return `
    <div class="palette-grid">
      ${PREMIUM_PALETTES.map((p) => `
        <button type="button" class="palette-swatch${p.id === selectedId ? ' selected' : ''}" data-palette="${esc(p.id)}">
          <span class="palette-swatch-colors">
            <span style="background:${esc(p.backgroundColor)}"></span>
            <span style="background:${esc(p.buttonColor)}"></span>
            <span style="background:${esc(p.textColor)}"></span>
          </span>
          <span class="palette-swatch-name">${esc(p.name)}</span>
        </button>
      `).join('')}
    </div>
  `;
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function clearScreen() {
  state.screenSubs.forEach((off) => { try { off(); } catch (_) {} });
  state.screenSubs = [];
}
function sub(off) { state.screenSubs.push(off); }

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(ts) {
  const d = ts && typeof ts.toDate === 'function' ? ts.toDate() : null;
  if (!d) return '—';
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// Timestamp -> "YYYY-MM-DD" для value инпута <input type="date"> — ручное
// управление подпиской в панели платформы (см. saveSubscriptionOverride).
function tsToDateInputValue(ts) {
  const d = ts && typeof ts.toDate === 'function' ? ts.toDate() : null;
  if (!d) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateTime(ts) {
  const d = ts && typeof ts.toDate === 'function' ? ts.toDate() : null;
  if (!d) return '—';
  return `${fmtDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Тот же льготный период, что и на сервере (saas/functions/index.js,
// GRACE_PERIOD_DAYS) и в приложении (lib/models/tenant_models.dart,
// gracePeriodDays) — три рантайма, синхронизировать вручную при изменении.
const GRACE_PERIOD_DAYS = 10;

/// «1 день», «2 дня», «5 дней» — тот же приём, что и в public/app/app.js.
function pluralDays(n) {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return 'день';
  if (!teen && last >= 2 && last <= 4) return 'дня';
  return 'дней';
}

function daysUntilDataPurge(subscription) {
  if (subscription?.status !== 'past_due') return null;
  const since = subscription.pastDueSince?.toDate?.();
  if (!since) return null;
  const deadline = since.getTime() + GRACE_PERIOD_DAYS * 86400000;
  const remainingDays = Math.ceil((deadline - Date.now()) / 86400000);
  return Math.max(0, remainingDays);
}

// Сколько дней осталось до конца пробного периода — null, если подписка не
// в статусе "trial" или дата не задана. Используется в "Требует внимания"
// панели платформы, чтобы владелец не пропустил заведение, у которого вот-
// вот кончится триал и понадобится напоминание об оплате.
function daysUntilTrialEnd(subscription) {
  if (subscription?.status !== 'trial') return null;
  const end = subscription.trialEndsAt?.toDate?.();
  if (!end) return null;
  return Math.ceil((end.getTime() - Date.now()) / 86400000);
}

function planName(plans, planId) {
  if (!plans || !planId) return null;
  const plan = plans.find((p) => p.id === planId);
  return plan ? plan.name || plan.id : null;
}

async function copyToClipboard(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано');
  } catch (_) {
    toast('Не удалось скопировать — выделите код вручную');
  }
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// BOM в начале — иначе Excel на Windows показывает кириллицу в CSV
// абракадаброй, считая файл однобайтовой кодировкой без явного маркера.
function downloadCsv(filename, rows) {
  const csv = '﻿' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Тот же алфавит, что в Cloud Function randomInviteCode() и в коротком ID
// устройства гостевого приложения — без символов, которые путают на слух и
// на вид (0/O, 1/I).
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomInviteCode() {
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  }
  return out;
}

function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

const TENANT_STATUS_LABELS = {
  trial: 'пробный период', active: 'активно', pastDue: 'просрочена оплата',
  suspended: 'приостановлено', cancelled: 'отменено', deleted: 'удалено',
};
const ROLE_LABELS = { owner: 'владелец', admin: 'администратор', manager: 'менеджер', employee: 'сотрудник' };
const ROLE_ORDER = { owner: 0, admin: 1, manager: 2, employee: 3 };
const SUB_STATUS_LABELS = {
  trial: 'пробный период', active: 'активна', past_due: 'просрочена',
  cancelled: 'отменена', incomplete: 'не оформлена',
};
const BUILD_STATUS_LABELS = {
  queued: 'в очереди', success: 'готова', failed: 'ошибка',
};
const AUDIT_ACTION_LABELS = {
  tenantCreated: 'Заведение создано',
  tenantSuspended: 'Заведение заблокировано',
  tenantEnabled: 'Заведение разблокировано',
  memberInvited: 'Приглашён участник',
  subscriptionPaid: 'Подписка оплачена',
  subscriptionPaymentCanceled: 'Платёж отменён',
  subscriptionRenewalFailed: 'Продление не прошло',
  buildJobRequested: 'Запрошена сборка APK',
  planChangedBySuperAdmin: 'Тариф изменён супер-админом',
};

function authErrorMessage(e) {
  const map = {
    'auth/email-already-in-use': 'Этот email уже зарегистрирован — попробуйте войти',
    'auth/invalid-email': 'Некорректный email',
    'auth/weak-password': 'Пароль слишком простой — минимум 6 символов',
    'auth/missing-password': 'Введите пароль',
    'auth/user-not-found': 'Неверный email или пароль',
    'auth/wrong-password': 'Неверный email или пароль',
    'auth/invalid-credential': 'Неверный email или пароль',
    'auth/too-many-requests': 'Слишком много попыток — попробуйте позже',
    'auth/network-request-failed': 'Нет связи с сервером — проверьте интернет',
  };
  return map[e?.code] || `Не удалось выполнить: ${e?.message || e}`;
}

// ---------- ЗАПУСК ----------

async function boot() {
  let config;
  try {
    // Firebase Hosting сам отдаёт настройки проекта по этому адресу —
    // ключи не приходится вшивать в код (см. тот же приём в public/app/app.js).
    const res = await fetch('/__/firebase/init.json');
    config = await res.json();
    if (!config || !config.projectId) throw new Error('пусто');
  } catch (_) {
    screenEl().innerHTML = `
      <div class="brand">Hoocah POS</div>
      <h1>Почти готово</h1>
      <p class="muted">Осталось один раз зарегистрировать веб-приложение в
      Firebase: консоль → Project settings → Your apps → значок
      &lt;/&gt; (Web) → любое имя → Register app. Больше ничего делать не нужно,
      настройки подставятся сюда сами.</p>`;
    return;
  }

  const app = initializeApp(config);
  state.auth = getAuth(app);
  state.db = getFirestore(app);
  state.functions = getFunctions(app, FUNCTIONS_REGION);
  state.storage = getStorage(app);

  // Возврат по ссылке из письма (см. sendLoginLink на лендинге) — сама
  // ссылка не требует пароля вообще: клик по ней уже доказывает владение
  // почтой, поэтому именно так закрывается регистрация "любой email без
  // подтверждения" на самом первом шаге, ещё до онбординга.
  if (isSignInWithEmailLink(state.auth, window.location.href)) {
    let email = window.localStorage.getItem('emailForSignIn');
    if (!email) {
      email = window.prompt('Введите email, на который приходило письмо со ссылкой для входа:');
    }
    if (email) {
      try {
        const cred = await signInWithEmailLink(state.auth, email, window.location.href);
        window.localStorage.removeItem('emailForSignIn');
        const userRef = doc(state.db, 'users', cred.user.uid);
        const existing = await getDoc(userRef);
        if (!existing.exists()) {
          await setDoc(userRef, { email, createdAt: Timestamp.fromDate(new Date()) });
        }
      } catch (_) {
        // Ссылка одноразовая/просрочена — ниже просто покажется лендинг
        // или обычный вход, ошибку тут показывать некому (мы могли даже не
        // понять, какой email вводили).
      }
    }
    // Убираем oobCode/apiKey и т.п. из адресной строки — иначе повторное
    // обновление страницы попробует использовать уже потраченную ссылку.
    history.replaceState(null, '', location.pathname + '#/');
  }

  onAuthStateChanged(state.auth, handleAuthChange);
}

function handleAuthChange(user) {
  state.accountSubs.forEach((off) => { try { off(); } catch (_) {} });
  state.accountSubs = [];

  if (!user) {
    state.uid = null;
    state.tenants = [];
    state.tenantsLoaded = false;
    state.activeTenantId = null;
    state.isSuperAdmin = false;
    route();
    return;
  }

  state.uid = user.uid;
  state.tenantsLoaded = false;
  route();
  watchMemberships();

  // Флаг платформы, не заведения — не блокирует обычный экран владельца,
  // поэтому отдельная лёгкая подписка, а не часть watchMemberships().
  state.accountSubs.push(onSnapshot(doc(state.db, 'superAdmins', state.uid), (d) => {
    state.isSuperAdmin = d.exists();
    route();
  }, () => { state.isSuperAdmin = false; }));
}

function watchMemberships() {
  const q = query(
    collection(state.db, 'tenantMembers'),
    where('userId', '==', state.uid),
    where('status', '==', 'active'),
  );
  state.accountSubs.push(onSnapshot(q, async (snap) => {
    const list = snap.docs.map((d) => ({ id: d.data().tenantId, role: d.data().role }));
    // Название и код заведения тянем сразу для всех членств — обычно
    // владелец состоит в одном-двух заведениях, а не в сотне, так что
    // это пара лишних чтений, а не N+1 проблема.
    await Promise.all(list.map(async (t) => {
      try {
        const tSnap = await getDoc(doc(state.db, 'tenants', t.id));
        t.name = tSnap.exists() ? tSnap.data().name : t.id;
        t.slug = tSnap.exists() ? tSnap.data().slug : '';
      } catch (_) {
        t.name = t.id;
        t.slug = '';
      }
    }));
    state.tenants = list;
    state.tenantsLoaded = true;
    if (!list.length) {
      state.activeTenantId = null;
    } else if (!state.activeTenantId || !list.some((t) => t.id === state.activeTenantId)) {
      state.activeTenantId = list[0].id;
    }
    route();
  }, () => {
    state.tenants = [];
    state.tenantsLoaded = true;
    route();
  }));
}

function route() {
  clearScreen();
  if (!state.uid) {
    // Лендинг — дефолтная дверь для того, кто ещё не вошёл: что это за
    // система, какие тарифы, кнопка "Попробовать бесплатно". #/login —
    // прежний вход по email+паролю, для тех, кто уже регистрировался так
    // раньше (ссылка снизу лендинга ведёт туда же).
    if (location.hash === '#/login' || location.hash === '#/signup') {
      authMode = location.hash === '#/signup' ? 'signup' : 'login';
      return screenAuth();
    }
    return screenLanding();
  }
  if (location.hash === '#/admin') {
    // Панель платформы не зависит от того, есть ли у супер-админа
    // собственное заведение — поэтому проверяется до tenantsLoaded/tenants.
    return state.isSuperAdmin ? screenSuperAdmin() : screenDashboardOrOnboarding();
  }
  // #/onboarding — явный выход на форму "Новое заведение" даже для
  // супер-админа без своего заведения (ссылка "Своё заведение" на панели
  // платформы). Без этого хэша супер-админ без заведения не смог бы туда
  // попасть вообще — экран ниже подставляется по умолчанию.
  if (location.hash === '#/onboarding') {
    return screenDashboardOrOnboarding();
  }
  // Супер-админ БЕЗ собственного заведения по умолчанию попадает на панель
  // платформы — это его рабочий экран, а не приглашение завести бизнес
  // самому. Пока список заведений не загружен, ничего не решаем — обычный
  // screenLoading() внутри screenDashboardOrOnboarding() покажется сам.
  if (state.isSuperAdmin && state.tenantsLoaded && !state.tenants.length) {
    return screenSuperAdmin();
  }
  return screenDashboardOrOnboarding();
}

function screenDashboardOrOnboarding() {
  if (!state.tenantsLoaded) return screenLoading();
  if (!state.tenants.length) return screenOnboarding();
  return screenDashboard();
}

window.addEventListener('hashchange', route);
boot();

// ---------- ЛЕНДИНГ ----------

// Реальные возможности приложения (см. корневой README.md, разделы
// "Hoocah POS — возможности сотрудника/администратора") — сокращённо, для
// человека, который видит систему первый раз, а не для того, кто уже читал
// техническую документацию.
const LANDING_FEATURES = [
  { icon: '🗺️', title: 'Карта зала', desc: 'таймер на каждом столе, несколько чеков на одном столе, перенос между столами без потери заказа' },
  { icon: '💳', title: 'Оплата и чек', desc: 'наличные / карта / терминал, скидочные карты, бонусы, сплит-оплата' },
  { icon: '📦', title: 'Склад', desc: 'остатки по категориям, инвентаризация с историей расхождений' },
  { icon: '📅', title: 'Брони и лист ожидания', desc: 'с гостевого приложения и вручную, автоподбор стола' },
  { icon: '🎁', title: 'Программа лояльности', desc: 'бонусы, сертификаты, реферальные бонусы за приглашённых гостей' },
  { icon: '🤖', title: 'ИИ-помощники', desc: 'для зала, кухни/бара, разбора броней и склада' },
  { icon: '📱', title: 'Гостевое приложение', desc: 'меню, вызов официанта, свой счёт, бронь — прямо с телефона гостя, без установки' },
  { icon: '📊', title: 'Отчёты', desc: 'выручка, средний чек, топ позиций меню, X-отчёты по сменам' },
];

function landingPlanCardHtml(p, selected) {
  const priceText = Number(p.priceRub) > 0
    ? `${Number(p.priceRub).toLocaleString('ru-RU')} ₽/мес`
    : 'По запросу';
  const yearlyText = Number(p.priceRubYearly) > 0
    ? `${Number(p.priceRubYearly).toLocaleString('ru-RU')} ₽/год`
    : null;
  const limits = [
    p.maxEmployees ? `до ${p.maxEmployees} сотрудников` : 'сотрудников без лимита',
    p.maxTables ? `до ${p.maxTables} столов` : 'столов без лимита',
    p.maxDevices ? `до ${p.maxDevices} устройств` : 'устройств без лимита',
  ];
  const perks = [];
  if (p.aiEnabled) perks.push('ИИ-помощники');
  if (p.customBranding) perks.push('свой брендинг');
  if (p.customDomain) perks.push('свой домен');
  if (p.features?.advancedReports) perks.push('расширенные отчёты');
  return `
    <div class="card" style="${selected ? 'border-color:var(--primary)' : ''}">
      <div style="font-weight:700;font-size:17px">${esc(p.name || p.id)}</div>
      <div style="font-size:22px;font-weight:700;margin:6px 0">${priceText}${yearlyText ? ` <span class="small muted" style="font-weight:400">или ${esc(yearlyText)}</span>` : ''}</div>
      <div class="small muted">${limits.join(' · ')}</div>
      ${perks.length ? `<div class="small muted" style="margin-top:4px">${esc(perks.join(' · '))}</div>` : ''}
      <button class="btn ${selected ? 'btn-primary' : 'btn-ghost'} f-landing-plan-pick" data-id="${esc(p.id)}" style="margin-top:12px">
        ${selected ? 'Тариф выбран ✓' : 'Выбрать и попробовать'}
      </button>
    </div>
  `;
}

function screenLanding() {
  let selectedPlanId = window.localStorage.getItem('selectedPlanId') || null;

  screenEl().innerHTML = `
    <div class="brand">Hoocah POS</div>
    <h1>Облачная касса для кальянных и лаунжей</h1>
    <p class="muted">Карта зала, чеки и оплата, склад, брони и лист ожидания,
    программа лояльности, гостевое приложение и ИИ-помощники персоналу —
    всё в одной системе. Работает на обычном Android-планшете, разворачивается
    за 10–15 минут.</p>

    <div class="card" style="margin-top:6px">
      <label class="field"><span>Email</span>
        <input id="f-landing-email" type="email" autocomplete="email" placeholder="you@example.com">
      </label>
      <div id="f-landing-error" class="small" style="color:var(--danger);margin-bottom:10px"></div>
      <button class="btn btn-primary" id="f-landing-start">Попробовать бесплатно 14 дней</button>
      <p class="small muted" style="margin-top:8px">Пришлём ссылку для входа на почту — без пароля, ничего запоминать не нужно.</p>
    </div>

    <h2 style="margin-top:26px">Что умеет система</h2>
    <div class="card">
      ${LANDING_FEATURES.map((f) => `
        <div class="small" style="padding:7px 0;border-bottom:1px solid var(--border)">
          ${f.icon} <b>${esc(f.title)}</b> — ${esc(f.desc)}
        </div>
      `).join('')}
    </div>

    <h2>Тарифы</h2>
    <div id="landing-plans"><div class="spinner"></div></div>

    <p class="small center muted" style="margin-top:20px">
      Уже есть аккаунт? <a href="#/login">Войти по паролю</a>
    </p>
    ${versionFooterHtml()}
  `;

  const submit = async () => {
    const email = $('f-landing-email').value.trim();
    const errEl = $('f-landing-error');
    errEl.textContent = '';
    if (!email) { errEl.textContent = 'Введите email'; return; }
    $('f-landing-start').disabled = true;
    try {
      await sendSignInLinkToEmail(state.auth, email, {
        url: `${location.origin}${location.pathname}#/`,
        handleCodeInApp: true,
      });
      window.localStorage.setItem('emailForSignIn', email);
      if (selectedPlanId) window.localStorage.setItem('selectedPlanId', selectedPlanId);
      screenEl().innerHTML = `
        <div class="brand">Hoocah POS</div>
        <h1>Проверьте почту</h1>
        <p class="muted">Отправили ссылку для входа на <b>${esc(email)}</b>.
        Откройте письмо на этом же телефоне и перейдите по ссылке — она
        сразу откроет личный кабинет, без пароля.</p>
        <p class="small center muted" style="margin-top:20px">
          Уже есть аккаунт? <a href="#/login">Войти по паролю</a>
        </p>
        ${versionFooterHtml()}
      `;
    } catch (e) {
      errEl.textContent = authErrorMessage(e);
      $('f-landing-start').disabled = false;
    }
  };
  $('f-landing-start').onclick = submit;
  $('f-landing-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  sub(onSnapshot(collection(state.db, 'plans'), (snap) => {
    const plans = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (Number(a.priceRub) || 0) - (Number(b.priceRub) || 0));
    const body = $('landing-plans');
    if (!body) return;
    body.innerHTML = plans.length
      ? plans.map((p) => landingPlanCardHtml(p, p.id === selectedPlanId)).join('')
      : '<p class="small muted">Тарифы скоро появятся.</p>';
    document.querySelectorAll('.f-landing-plan-pick').forEach((el) => {
      el.onclick = () => {
        selectedPlanId = el.dataset.id;
        window.localStorage.setItem('selectedPlanId', selectedPlanId);
        document.querySelectorAll('.f-landing-plan-pick').forEach((btn) => {
          const isSel = btn.dataset.id === selectedPlanId;
          btn.textContent = isSel ? 'Тариф выбран ✓' : 'Выбрать и попробовать';
          btn.className = `btn ${isSel ? 'btn-primary' : 'btn-ghost'} f-landing-plan-pick`;
          btn.closest('.card').style.borderColor = isSel ? 'var(--primary)' : '';
        });
        $('f-landing-email')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
    });
  }, () => {
    const body = $('landing-plans');
    if (body) body.innerHTML = '<p class="small muted">Тарифы недоступны.</p>';
  }));
}

// ---------- ВХОД / РЕГИСТРАЦИЯ ----------

let authMode = 'login'; // 'login' | 'signup' — держим отдельно от state: это выбор экрана, а не данные аккаунта.

function screenAuth() {
  screenEl().innerHTML = `
    <div class="brand">Hoocah POS</div>
    <h1>${authMode === 'login' ? 'Вход в консоль' : 'Регистрация владельца'}</h1>
    <p class="muted">Личный кабинет владельца заведения: подписка, код
    приглашения устройств, фирменный цвет приложения кассы.</p>
    <div class="card">
      <label class="field"><span>Email</span>
        <input id="f-email" type="email" autocomplete="email" placeholder="you@example.com">
      </label>
      <label class="field"><span>Пароль</span>
        <input id="f-pass" type="password"
          autocomplete="${authMode === 'login' ? 'current-password' : 'new-password'}"
          placeholder="Минимум 6 символов">
      </label>
      <div id="f-error" class="small" style="color:var(--danger);margin-bottom:10px"></div>
      <button class="btn btn-primary" id="f-submit">${authMode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
    </div>
    <p class="small center muted">
      ${authMode === 'login' ? 'Ещё нет аккаунта?' : 'Уже есть аккаунт?'}
      <a href="#" id="f-switch">${authMode === 'login' ? 'Зарегистрироваться' : 'Войти'}</a>
    </p>
    <p class="small center muted"><a href="#/">← На главную</a></p>
    ${versionFooterHtml()}
  `;

  $('f-switch').onclick = (e) => {
    e.preventDefault();
    authMode = authMode === 'login' ? 'signup' : 'login';
    screenAuth();
  };

  const submit = async () => {
    const email = $('f-email').value.trim();
    const pass = $('f-pass').value;
    const errEl = $('f-error');
    errEl.textContent = '';
    if (!email || !pass) {
      errEl.textContent = 'Заполните email и пароль';
      return;
    }
    $('f-submit').disabled = true;
    try {
      if (authMode === 'login') {
        await signInWithEmailAndPassword(state.auth, email, pass);
      } else {
        const cred = await createUserWithEmailAndPassword(state.auth, email, pass);
        await setDoc(doc(state.db, 'users', cred.user.uid), {
          email, createdAt: Timestamp.fromDate(new Date()),
        }, { merge: true });
        // Письмо с подтверждением — до него владелец не может создать
        // заведение (см. screenOnboarding и createTenant на сервере), это
        // и есть защита от регистрации на случайный/чужой email.
        try { await sendEmailVerification(cred.user); } catch (_) {}
      }
      // Дальше подхватит onAuthStateChanged — свой экран он покажет сам.
    } catch (e) {
      errEl.textContent = authErrorMessage(e);
      $('f-submit').disabled = false;
    }
  };
  $('f-submit').onclick = submit;
  $('f-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function screenLoading() {
  screenEl().innerHTML = `<div class="brand">Hoocah POS</div><div class="spinner"></div>`;
}

// ---------- ПОДТВЕРЖДЕНИЕ ПОЧТЫ ----------

function screenVerifyEmail() {
  const email = state.auth.currentUser?.email || '';
  screenEl().innerHTML = `
    <div class="brand">Hoocah POS</div>
    <h1>Подтвердите почту</h1>
    <p class="muted">Мы отправили письмо со ссылкой на <b>${esc(email)}</b>.
    Перейдите по ней, потом вернитесь сюда и нажмите «Проверить» —
    создание заведения открывается только после этого.</p>
    <div class="card">
      <button class="btn btn-primary" id="f-verify-check">Проверить</button>
      <button class="btn btn-ghost" id="f-verify-resend" style="margin-top:10px">Отправить письмо ещё раз</button>
      <div id="f-verify-msg" class="small muted" style="margin-top:8px"></div>
    </div>
    <button class="btn btn-ghost" id="f-signout">Выйти</button>
  `;

  $('f-verify-check').onclick = async () => {
    const msgEl = $('f-verify-msg');
    $('f-verify-check').disabled = true;
    try {
      await state.auth.currentUser.reload();
      if (state.auth.currentUser.emailVerified) {
        route();
      } else {
        msgEl.textContent = 'Пока не подтверждено — проверьте почту (и папку "Спам").';
      }
    } catch (e) {
      msgEl.textContent = `Не удалось проверить: ${e?.message || e}`;
    } finally {
      $('f-verify-check').disabled = false;
    }
  };

  $('f-verify-resend').onclick = async () => {
    const msgEl = $('f-verify-msg');
    $('f-verify-resend').disabled = true;
    try {
      await sendEmailVerification(state.auth.currentUser);
      msgEl.textContent = 'Письмо отправлено ещё раз.';
    } catch (e) {
      msgEl.textContent = `Не удалось отправить: ${e?.message || e}`;
    } finally {
      $('f-verify-resend').disabled = false;
    }
  };

  $('f-signout').onclick = () => signOut(state.auth);
}

// ---------- СОЗДАНИЕ ЗАВЕДЕНИЯ ----------

function screenOnboarding() {
  // Пока владелец не подтвердил почту — никакого создания заведения. Это и
  // есть защита от "любой вписал любой email и тут же завёл себе бизнес":
  // без клика по ссылке в реальном письме сюда не попасть, а createTenant
  // на сервере проверяет то же самое ещё раз (request.auth.token.email_verified),
  // так что этот экран — не единственная защита, а просто первая.
  if (!state.auth.currentUser?.emailVerified) {
    return screenVerifyEmail();
  }

  let selectedPaletteId = 'midnight';

  screenEl().innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:8px">
      <div class="brand">Hoocah POS</div>
      ${state.isSuperAdmin ? '<a href="#/admin" class="btn-link">Платформа</a>' : ''}
    </div>
    <h1>Новое заведение</h1>
    <p class="muted">Код заведения используется в ссылках и как основа
    имени Android-приложения — только латиница, цифры и дефис.</p>
    <div class="card">
      <label class="field"><span>Название заведения</span>
        <input id="f-name" placeholder="Hookah Lounge Riga">
      </label>
      <label class="field"><span>Код заведения</span>
        <input id="f-slug" placeholder="hookah-lounge-riga">
      </label>
      <label class="field"><span>Лейбл в приложении (короткое имя под иконкой)</span>
        <input id="f-brand-name" placeholder="Оставьте пустым — возьмём из названия" maxlength="12">
      </label>
      <div class="small muted" style="margin-bottom:8px">Цветовая гамма клиентского приложения — выберите готовую или настройте свою ниже, сменить можно и позже в разделе «Брендинг»</div>
      ${paletteSwatchesHtml(selectedPaletteId)}

      <div class="small muted" style="margin:14px 0 8px">Свои цвета</div>
      ${colorFieldHtml('f-color-primary', 'Основной', PREMIUM_PALETTES[0].primaryColor, true)}
      ${colorFieldHtml('f-color-secondary', 'Вторичный', PREMIUM_PALETTES[0].secondaryColor, true)}
      ${colorFieldHtml('f-color-button', 'Кнопки', PREMIUM_PALETTES[0].buttonColor, true)}
      ${colorFieldHtml('f-color-bg', 'Фон', PREMIUM_PALETTES[0].backgroundColor, true)}
      ${colorFieldHtml('f-color-text', 'Текст', PREMIUM_PALETTES[0].textColor, true)}
      <div id="f-contrast-warning" class="small" style="color:var(--warning);margin:4px 0 12px"></div>

      <div class="small muted" style="margin-bottom:8px">Предпросмотр</div>
      <div id="f-brand-preview" style="border-radius:14px;padding:16px;border:1px solid var(--border);margin-bottom:16px">
        <div id="f-preview-title" style="font-weight:700;margin-bottom:12px"></div>
        <button id="f-preview-btn" type="button" style="width:auto;padding:10px 20px;border-radius:12px;border:none;font-weight:600">Оплатить</button>
      </div>

      <div id="f-error" class="small" style="color:var(--danger);margin-bottom:10px"></div>
      <button class="btn btn-primary" id="f-submit">Создать заведение</button>
    </div>
    <button class="btn btn-ghost" id="f-signout">Выйти</button>
  `;

  const nameEl = $('f-name');
  const slugEl = $('f-slug');
  let slugTouched = false;
  slugEl.addEventListener('input', () => { slugTouched = true; });
  nameEl.addEventListener('input', () => {
    // Код подставляем из названия сам, пока владелец не начал править его
    // руками — после первой правки больше не перезаписываем.
    if (!slugTouched) slugEl.value = slugify(nameEl.value);
  });

  document.querySelectorAll('.palette-swatch').forEach((el) => {
    el.onclick = () => {
      selectedPaletteId = el.dataset.palette;
      document.querySelectorAll('.palette-swatch').forEach((s) => {
        s.classList.toggle('selected', s.dataset.palette === selectedPaletteId);
      });
      const palette = PREMIUM_PALETTES.find((p) => p.id === selectedPaletteId);
      if (palette) applyPaletteToColorInputs(palette);
    };
  });
  BRANDING_COLOR_FIELD_IDS.forEach((id) => {
    $(id)?.addEventListener('input', () => {
      $(`${id}-hex`).textContent = $(id).value;
      updateBrandPreview();
    });
  });
  $('f-brand-name')?.addEventListener('input', updateBrandPreview);
  updateBrandPreview();

  $('f-submit').onclick = async () => {
    const name = nameEl.value.trim();
    const slug = slugEl.value.trim();
    const label = $('f-brand-name').value.trim();
    const errEl = $('f-error');
    errEl.textContent = '';
    if (name.length < 2) {
      errEl.textContent = 'Введите название заведения';
      return;
    }
    if (!slug) {
      errEl.textContent = 'Код заведения не получился из названия автоматически (например, из-за кириллицы) — впишите его латиницей вручную';
      return;
    }
    $('f-submit').disabled = true;
    try {
      const createTenant = httpsCallable(state.functions, 'createTenant');
      // Если владелец пришёл с лендинга, выбрав конкретный тариф — заводим
      // заведение сразу на нём (пробный период всё равно бесплатный 14
      // дней, planId лишь определяет, какие лимиты/тариф ждут ПОСЛЕ триала).
      const chosenPlanId = window.localStorage.getItem('selectedPlanId');
      const res = await createTenant(chosenPlanId ? { name, slug, planId: chosenPlanId } : { name, slug });
      window.localStorage.removeItem('selectedPlanId');
      const tenantId = res.data.tenantId;
      state.activeTenantId = tenantId;
      // createTenant уже завёл дефолтный брендинг ("Полночный синий") —
      // если владелец выбрал другую гамму или свой лейбл, дописываем это
      // отдельным клиентским merge-запросом сразу после: к этому моменту
      // членство владельца в заведении уже закоммичено на сервере (тем же
      // батчем, что и сам tenant), поэтому правила (hasRole owner/admin)
      // это разрешают без гонки.
      // Цвета берём прямо из полей, а не из объекта пресета — так учитываются
      // и ручные правки владельца поверх выбранной гаммы (см. BRANDING_COLOR_FIELD_IDS).
      const appName = label || name;
      try {
        await writeBrandingConfig(tenantId, {
          appName,
          shortName: appName.slice(0, 12),
          primaryColor: $('f-color-primary').value,
          secondaryColor: $('f-color-secondary').value,
          buttonColor: $('f-color-button').value,
          backgroundColor: $('f-color-bg').value,
          textColor: $('f-color-text').value,
        });
      } catch (_) {
        // Заведение всё равно создано с рабочим брендингом по умолчанию —
        // не блокируем онбординг, если этот необязательный шаг не прошёл.
      }
      // Новый tenantMembers придёт сам через watchMemberships — она уже
      // слушает эту коллекцию и перерисует экран в screenDashboard.
    } catch (e) {
      errEl.textContent = `Не удалось создать заведение: ${e?.message || e}`;
      $('f-submit').disabled = false;
    }
  };

  $('f-signout').onclick = () => signOut(state.auth);
}

// ---------- ЛИЧНЫЙ КАБИНЕТ ----------

function screenDashboard() {
  screenEl().innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:8px">
      <div class="brand">Hoocah POS</div>
      <div class="row" style="width:auto;gap:14px">
        ${state.isSuperAdmin ? '<a href="#/admin" class="btn-link">Платформа</a>' : ''}
        <button class="btn-link" id="f-signout">Выйти</button>
      </div>
    </div>
    ${state.tenants.length > 1 ? `
      <label class="field"><span>Заведение</span>
        <select id="f-tenant-pick">
          ${state.tenants.map((t) => `
            <option value="${esc(t.id)}" ${t.id === state.activeTenantId ? 'selected' : ''}>${esc(t.name || t.id)}</option>
          `).join('')}
        </select>
      </label>` : ''}
    <div id="dash-body"><div class="spinner"></div></div>
  `;

  $('f-signout').onclick = () => signOut(state.auth);
  if (state.tenants.length > 1) {
    $('f-tenant-pick').onchange = (e) => {
      state.activeTenantId = e.target.value;
      route();
    };
  }

  watchDashboardData(state.activeTenantId);
}

function watchDashboardData(tenantId) {
  const body = $('dash-body');
  let tenant = null;
  let invite = null;
  let branding = null;
  let subscription = null;
  let members = null;
  let plans = null;
  let buildJobs = null;
  // Загруженный, но ещё не сохранённый логотип — переживает промежуточные
  // перерисовки (см. ниже), сбрасывается после успешного сохранения.
  let pendingLogoUrl = null;

  const draw = () => {
    // Пока не пришёл хотя бы сам документ заведения — рано рисовать: без
    // него неизвестны ни название, ни роль в подписи блока устройств.
    if (!tenant) return;
    const role = (state.tenants.find((t) => t.id === tenantId) || {}).role || '';
    const canManage = role === 'owner' || role === 'admin';
    const sortedMembers = (members || []).slice().sort((a, b) =>
      (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));

    // Форма брендинга не сбрасывается на середине правки: любое ДРУГОЕ
    // обновление на этом экране (статус сборки APK, состав команды и т.п.)
    // тоже вызывает draw() — без этого перерисовка стирала бы не
    // сохранённые правки цветов/имени. Поэтому если поля уже отрисованы,
    // берём их ТЕКУЩИЕ значения из DOM, а не то, что лежит в Firestore;
    // после успешного сохранения (saveBranding) эти же значения и есть
    // сохранённые, так что рассинхронизации не возникает.
    const existingName = $('f-brand-name')?.value;
    const existingColor = (id) => $(id)?.value;

    // Значения по умолчанию — ровно палитра AppColors ("Midnight Blue") из
    // lib/theme/app_colors.dart, та же, что и в saas/functions/index.js
    // (createTenant) и lib/models/tenant_models.dart (BrandingConfig) —
    // заведение без кастомного брендинга выглядит как проверенный продукт,
    // а не какой-то другой палитрой по умолчанию.
    const brandName = existingName ?? (branding?.appName || tenant.name || 'Hoocah POS');
    const logoUrl = pendingLogoUrl ?? (branding?.logoUrl || '');
    const primaryColor = existingColor('f-color-primary') ?? (branding?.primaryColor || '#0B5ED7');
    const secondaryColor = existingColor('f-color-secondary') ?? (branding?.secondaryColor || '#162A4A');
    const buttonColor = existingColor('f-color-button') ?? (branding?.buttonColor || '#0B5ED7');
    const backgroundColor = existingColor('f-color-bg') ?? (branding?.backgroundColor || '#02050B');
    const textColor = existingColor('f-color-text') ?? (branding?.textColor || '#F8FAFC');

    body.innerHTML = `
      <div class="card">
        <div class="muted small">Заведение</div>
        <div style="font-size:18px;font-weight:700;margin:4px 0">${esc(tenant.name || '')}</div>
        <div class="small muted">
          Код: <code>${esc(tenant.slug || '')}</code> ·
          статус: ${esc(TENANT_STATUS_LABELS[tenant.status] || tenant.status || '—')} ·
          роль: ${esc(ROLE_LABELS[role] || role)}
        </div>
      </div>

      <h2>Устройства</h2>
      <div class="card">
        <p class="small muted">Код приглашения — введите его на планшете
        вместе с кодом заведения (<code>${esc(tenant.slug || '')}</code>),
        чтобы привязать устройство к этому заведению.</p>
        <div class="row" style="justify-content:space-between;align-items:center">
          <div style="font-size:26px;font-weight:700;letter-spacing:.08em">${esc(invite?.code || '—')}</div>
          <button class="btn-link" id="f-copy-code">Скопировать</button>
        </div>
        ${canManage ? `<button class="btn btn-ghost" id="f-rotate-code" style="margin-top:12px">Обновить код</button>` : ''}
      </div>

      <h2>Команда</h2>
      <div class="card">
        ${members === null ? '<div class="small muted">Загрузка…</div>' : sortedMembers.map((m) => `
          <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
            <div class="grow" style="min-width:0">
              <div class="ellipsis">${esc(m.email || `Устройство · ${(m.userId || '').slice(-4).toUpperCase()}`)}${m.userId === state.uid ? ' <span class="muted small">(вы)</span>' : ''}</div>
              <div class="small muted">${esc(ROLE_LABELS[m.role] || m.role)}${m.status !== 'active' ? ' · отключён' : ''}</div>
            </div>
            ${canManage && m.userId !== state.uid && ['manager', 'employee'].includes(m.role) ? `
              <select class="f-member-role" data-uid="${esc(m.userId)}" style="width:auto;margin:0">
                <option value="manager" ${m.role === 'manager' ? 'selected' : ''}>Менеджер</option>
                <option value="employee" ${m.role === 'employee' ? 'selected' : ''}>Сотрудник</option>
              </select>
              <button class="btn-link f-member-toggle" data-uid="${esc(m.userId)}" data-active="${m.status === 'active' ? '1' : '0'}">
                ${m.status === 'active' ? 'Отключить' : 'Включить'}
              </button>
            ` : ''}
          </div>
        `).join('') || '<div class="small muted">Пока только вы</div>'}

        ${canManage ? `
          <div style="margin-top:14px">
            <label class="field"><span>Пригласить по email</span>
              <input id="f-invite-email" type="email" placeholder="coworker@example.com">
            </label>
            <div class="row">
              <select id="f-invite-role" class="grow">
                <option value="manager">Менеджер</option>
                <option value="employee" selected>Сотрудник</option>
              </select>
              <button class="btn btn-ghost" id="f-invite-submit" style="width:auto">Пригласить</button>
            </div>
            <p class="small muted" style="margin-top:6px">Приглашаемый должен
            сначала сам зарегистрироваться в этой консоли (email + пароль) —
            тогда его можно будет найти по email.</p>
            <div id="f-invite-error" class="small" style="color:var(--danger)"></div>
          </div>
        ` : ''}
      </div>

      <h2>Брендинг</h2>
      <div class="card">
        <label class="field"><span>Имя приложения</span>
          <input id="f-brand-name" value="${esc(brandName)}" ${canManage ? '' : 'disabled'}>
        </label>

        <div class="row" style="align-items:center;margin-bottom:16px">
          <img id="f-logo-preview" src="${esc(logoUrl || TRANSPARENT_PIXEL)}" alt=""
            style="width:56px;height:56px;border-radius:12px;object-fit:cover;background:var(--surface-2);flex:none">
          ${canManage ? `
            <div class="grow">
              <input type="file" id="f-logo-file" accept="image/png,image/jpeg,image/webp">
              <div id="f-logo-error" class="small" style="color:var(--danger)"></div>
            </div>
          ` : '<div class="grow small muted">Логотип не задан</div>'}
        </div>

        ${canManage ? `
          <div class="small muted" style="margin-bottom:8px">Готовая гамма (применяет цвета ниже — сохранить нужно отдельно)</div>
          ${paletteSwatchesHtml(null)}
        ` : ''}

        <div class="small muted" style="margin-bottom:8px">Цвета</div>
        ${colorFieldHtml('f-color-primary', 'Основной', primaryColor, canManage)}
        ${colorFieldHtml('f-color-secondary', 'Вторичный', secondaryColor, canManage)}
        ${colorFieldHtml('f-color-button', 'Кнопки', buttonColor, canManage)}
        ${colorFieldHtml('f-color-bg', 'Фон', backgroundColor, canManage)}
        ${colorFieldHtml('f-color-text', 'Текст', textColor, canManage)}
        <div id="f-contrast-warning" class="small" style="color:var(--warning);margin:4px 0 12px"></div>

        <div class="small muted" style="margin-bottom:8px">Предпросмотр</div>
        <div id="f-brand-preview" style="border-radius:14px;padding:16px;border:1px solid var(--border)">
          <div id="f-preview-title" style="font-weight:700;margin-bottom:12px"></div>
          <button id="f-preview-btn" type="button" style="width:auto;padding:10px 20px;border-radius:12px;border:none;font-weight:600">Оплатить</button>
        </div>

        ${canManage ? `<button class="btn btn-primary" id="f-save-branding" style="margin-top:16px">Сохранить брендинг</button>` : ''}
        <div id="f-branding-error" class="small" style="color:var(--danger);margin-top:8px"></div>
      </div>

      <h2>Подписка</h2>
      ${(() => {
        const daysLeft = daysUntilDataPurge(subscription);
        if (daysLeft === null) return '';
        return `
          <div class="card danger">
            <div style="font-weight:700;margin-bottom:6px">⚠ Подписка не продлена</div>
            <div class="small">
              Касса и приложение на всех устройствах заведения уже заблокированы.
              ${daysLeft > 0
                ? `Данные заведения будут БЕЗВОЗВРАТНО удалены через ${daysLeft} ${pluralDays(daysLeft)}, если подписку не продлить.`
                : 'Срок продления истёк — данные заведения будут удалены при ближайшей проверке.'}
              После удаления заведение придётся настраивать заново — меню, столы, сотрудников и всё остальное.
            </div>
          </div>
        `;
      })()}
      <div class="card">
        <div class="small muted">Тариф: ${esc(planName(plans, subscription?.planId) || subscription?.planId || '—')}</div>
        <div class="small muted">Статус: ${esc(SUB_STATUS_LABELS[subscription?.status] || subscription?.status || '—')}</div>
        ${subscription?.trialEndsAt ? `<div class="small muted">Пробный период до: ${fmtDate(subscription.trialEndsAt)}</div>` : ''}
        ${subscription?.currentPeriodEnd && subscription?.status === 'active' ? `<div class="small muted">Оплачено до: ${fmtDate(subscription.currentPeriodEnd)}</div>` : ''}
        ${canManage && plans ? `
          <div style="margin-top:14px">
            ${plans.filter((p) => Number(p.priceRub) > 0).map((p) => `
              <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
                <div class="grow">
                  <div>${esc(p.name || p.id)}</div>
                  <div class="small muted">${Number(p.priceRub).toLocaleString('ru-RU')} ₽/мес${Number(p.priceRubYearly) > 0 ? ` · ${Number(p.priceRubYearly).toLocaleString('ru-RU')} ₽/год` : ''}</div>
                  ${Number(p.priceRubYearly) > 0 ? `
                    <select class="f-plan-period" data-plan="${esc(p.id)}" style="margin-top:6px;width:auto">
                      <option value="monthly">Помесячно</option>
                      <option value="yearly">На год (выгоднее)</option>
                    </select>
                  ` : ''}
                </div>
                <button class="btn ${subscription?.status === 'past_due' ? 'btn-primary' : 'btn-ghost'} f-plan-checkout" data-plan="${esc(p.id)}" style="width:auto"
                  ${subscription?.planId === p.id && subscription?.status === 'active' ? 'disabled' : ''}>
                  ${subscription?.planId === p.id && subscription?.status === 'active' ? 'Текущий' : 'Продлить'}
                </button>
              </div>
            `).join('')}
            <div id="f-checkout-error" class="small" style="color:var(--danger);margin-top:6px"></div>
          </div>
        ` : ''}
      </div>

      <h2>Сборка APK</h2>
      <div class="card">
        <p class="small muted">Универсальный APK кассы для этой платформы —
        после установки на планшет он сам предложит присоединиться по коду
        заведения и коду приглашения устройства выше.</p>
        ${canManage ? `<button class="btn btn-ghost" id="f-request-build">Собрать APK</button>` : ''}
        <div id="f-build-error" class="small" style="color:var(--danger);margin-top:6px"></div>
        ${(buildJobs || []).length ? buildJobs.map((j) => `
          <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--border)">
            <div class="grow small muted">
              ${fmtDateTime(j.createdAt)} · ${esc(BUILD_STATUS_LABELS[j.status] || j.status)}
              ${j.status === 'failed' && j.errorMessage ? `<div>${esc(j.errorMessage)}</div>` : ''}
            </div>
            ${j.status === 'success' && j.downloadPath ? `
              <button class="btn-link f-build-download" data-path="${esc(j.downloadPath)}" style="width:auto">Скачать</button>
            ` : ''}
          </div>
        `).join('') : '<p class="small muted" style="margin-top:10px">Сборок пока не было.</p>'}
      </div>
    `;

    if ($('f-copy-code')) $('f-copy-code').onclick = () => copyToClipboard(invite?.code || '');
    if ($('f-rotate-code')) $('f-rotate-code').onclick = () => rotateInviteCode(tenantId);

    updateBrandPreview();
    if (canManage) {
      BRANDING_COLOR_FIELD_IDS.forEach((id) => {
        $(id)?.addEventListener('input', () => {
          $(`${id}-hex`).textContent = $(id).value;
          updateBrandPreview();
        });
      });
      $('f-brand-name')?.addEventListener('input', updateBrandPreview);
      document.querySelectorAll('.palette-swatch').forEach((el) => {
        el.onclick = () => {
          const palette = PREMIUM_PALETTES.find((p) => p.id === el.dataset.palette);
          if (!palette) return;
          document.querySelectorAll('.palette-swatch').forEach((s) => s.classList.toggle('selected', s === el));
          applyPaletteToColorInputs(palette);
        };
      });
      if ($('f-logo-file')) {
        $('f-logo-file').onchange = async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const errEl = $('f-logo-error');
          errEl.textContent = '';
          if (file.size > 5 * 1024 * 1024) {
            errEl.textContent = 'Файл больше 5 МБ — выберите изображение поменьше';
            return;
          }
          try {
            const fileName = `logo.${(file.type.split('/')[1] || 'png')}`;
            const fileRef = ref(state.storage, `tenants/${tenantId}/branding/${fileName}`);
            await uploadBytes(fileRef, file, { contentType: file.type });
            pendingLogoUrl = await getDownloadURL(fileRef);
            $('f-logo-preview').src = pendingLogoUrl;
          } catch (err) {
            errEl.textContent = `Не удалось загрузить: ${err?.message || err}`;
          }
        };
      }
      if ($('f-save-branding')) {
        $('f-save-branding').onclick = async () => {
          const errEl = $('f-branding-error');
          errEl.textContent = '';
          const btn = $('f-save-branding');
          btn.disabled = true;
          try {
            await writeBrandingConfig(tenantId, {
              appName: $('f-brand-name').value.trim() || tenant.name,
              primaryColor: $('f-color-primary').value,
              secondaryColor: $('f-color-secondary').value,
              buttonColor: $('f-color-button').value,
              backgroundColor: $('f-color-bg').value,
              textColor: $('f-color-text').value,
              ...(pendingLogoUrl ? { logoUrl: pendingLogoUrl } : {}),
            });
            pendingLogoUrl = null;
            toast('Брендинг сохранён');
          } catch (e) {
            errEl.textContent = `Не удалось сохранить: ${e?.message || e}`;
          } finally {
            btn.disabled = false;
          }
        };
      }
    }

    document.querySelectorAll('.f-member-role').forEach((el) => {
      el.onchange = () => changeMemberRole(tenantId, el.dataset.uid, el.value);
    });
    document.querySelectorAll('.f-member-toggle').forEach((el) => {
      el.onclick = () => toggleMemberStatus(tenantId, el.dataset.uid, el.dataset.active === '1');
    });
    if ($('f-invite-submit')) {
      $('f-invite-submit').onclick = async () => {
        const email = $('f-invite-email').value.trim();
        const inviteRole = $('f-invite-role').value;
        const errEl = $('f-invite-error');
        errEl.textContent = '';
        if (!email) { errEl.textContent = 'Введите email'; return; }
        $('f-invite-submit').disabled = true;
        try {
          const inviteTenantMember = httpsCallable(state.functions, 'inviteTenantMember');
          await inviteTenantMember({ tenantId, email, role: inviteRole });
          $('f-invite-email').value = '';
          toast('Приглашение добавлено');
        } catch (e) {
          errEl.textContent = e?.message || 'Не удалось пригласить';
        } finally {
          $('f-invite-submit').disabled = false;
        }
      };
    }
    document.querySelectorAll('.f-plan-checkout').forEach((el) => {
      el.onclick = () => {
        const periodSelect = document.querySelector(`.f-plan-period[data-plan="${el.dataset.plan}"]`);
        startCheckout(tenantId, el.dataset.plan, periodSelect?.value || 'monthly');
      };
    });
    if ($('f-request-build')) {
      $('f-request-build').onclick = () => requestBuild(tenantId);
    }
    document.querySelectorAll('.f-build-download').forEach((el) => {
      el.onclick = () => downloadBuild(el.dataset.path);
    });
  };

  getDocs(collection(state.db, 'plans')).then((snap) => {
    plans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  }).catch(() => { plans = []; draw(); });

  sub(onSnapshot(doc(state.db, 'tenants', tenantId), (d) => {
    tenant = d.exists() ? d.data() : null;
    draw();
  }, () => {}));
  sub(onSnapshot(doc(state.db, 'tenants', tenantId, 'settings', 'deviceInvite'), (d) => {
    invite = d.exists() ? d.data() : null;
    draw();
  }, () => {}));
  sub(onSnapshot(doc(state.db, 'tenants', tenantId, 'branding', 'config'), (d) => {
    branding = d.exists() ? d.data() : null;
    draw();
  }, () => {}));
  sub(onSnapshot(doc(state.db, 'subscriptions', tenantId), (d) => {
    subscription = d.exists() ? d.data() : null;
    draw();
  }, () => {}));
  sub(onSnapshot(query(collection(state.db, 'tenantMembers'), where('tenantId', '==', tenantId)), (snap) => {
    members = snap.docs.map((d) => d.data());
    draw();
  }, () => {
    members = [];
    draw();
  }));
  sub(onSnapshot(
    query(collection(state.db, 'buildJobs'), where('tenantId', '==', tenantId), orderBy('createdAt', 'desc'), limit(10)),
    (snap) => {
      buildJobs = snap.docs.map((d) => d.data());
      draw();
    },
    () => { buildJobs = []; draw(); },
  ));
}

async function rotateInviteCode(tenantId) {
  if (!confirm('Обновить код приглашения? Прежний код перестанет работать на новых устройствах.')) return;
  try {
    await setDoc(doc(state.db, 'tenants', tenantId, 'settings', 'deviceInvite'), {
      code: randomInviteCode(),
      rotatedAt: Timestamp.fromDate(new Date()),
    }, { merge: true });
    toast('Код обновлён');
  } catch (e) {
    toast(`Не удалось обновить код: ${e?.message || e}`);
  }
}

async function changeMemberRole(tenantId, memberUid, role) {
  try {
    // Правила разрешают эту запись только когда И текущая, И новая роль —
    // manager/employee (см. saas/firestore.rules, tenantMembers.update) —
    // повышение до admin/owner отсюда невозможно даже случайно.
    await updateDoc(doc(state.db, 'tenantMembers', `${tenantId}_${memberUid}`), { role });
    toast('Роль изменена');
  } catch (e) {
    toast(`Не удалось изменить роль: ${e?.message || e}`);
  }
}

async function toggleMemberStatus(tenantId, memberUid, isActive) {
  try {
    await updateDoc(doc(state.db, 'tenantMembers', `${tenantId}_${memberUid}`), {
      status: isActive ? 'inactive' : 'active',
    });
    toast(isActive ? 'Доступ отключён' : 'Доступ включён');
  } catch (e) {
    toast(`Не удалось изменить доступ: ${e?.message || e}`);
  }
}

async function writeBrandingConfig(tenantId, payload) {
  await setDoc(doc(state.db, 'tenants', tenantId, 'branding', 'config'), payload, { merge: true });
}

// Обновляет мини-предпросмотр карточки (фон/текст/кнопка) вживую, по мере
// того как владелец крутит цветовые пикеры — без этого пришлось бы сначала
// сохранить брендинг, чтобы увидеть, не получилось ли нечитаемо.
// Общий список id цветовых инпутов брендинга — используется и на онбординге,
// и в разделе "Брендинг" личного кабинета: одинаковая разметка (colorFieldHtml
// с этими же id) в обоих местах, поэтому применение пресета/обновление
// подписи-хекс тоже общее, без дублирования.
const BRANDING_COLOR_FIELD_IDS = ['f-color-primary', 'f-color-secondary', 'f-color-button', 'f-color-bg', 'f-color-text'];

function applyPaletteToColorInputs(palette) {
  const fields = {
    'f-color-primary': palette.primaryColor,
    'f-color-secondary': palette.secondaryColor,
    'f-color-button': palette.buttonColor,
    'f-color-bg': palette.backgroundColor,
    'f-color-text': palette.textColor,
  };
  Object.entries(fields).forEach(([id, value]) => {
    const input = $(id);
    if (!input) return;
    input.value = value;
    const hexEl = $(`${id}-hex`);
    if (hexEl) hexEl.textContent = value;
  });
  updateBrandPreview();
}

function updateBrandPreview() {
  const preview = $('f-brand-preview');
  const title = $('f-preview-title');
  const btn = $('f-preview-btn');
  const warning = $('f-contrast-warning');
  if (!preview || !title || !btn) return;

  const bg = $('f-color-bg')?.value || '#02050B';
  const text = $('f-color-text')?.value || '#F8FAFC';
  const button = $('f-color-button')?.value || '#0B5ED7';
  const name = $('f-brand-name')?.value || 'Hoocah POS';

  preview.style.background = bg;
  title.style.color = text;
  title.textContent = name;
  btn.style.background = button;
  btn.style.color = text;

  // Тот же порог 3:1, что и в lib/theme/app_theme.dart (_contrastRatio) —
  // само приложение всё равно откатится на цвета темы по умолчанию при
  // недостаточном контрасте, это предупреждение не единственная защита,
  // а просто способ сказать владельцу заранее, ДО сохранения.
  if (warning) {
    warning.textContent = contrastRatio(bg, text) < 3.0
      ? 'Фон и текст слишком похожи — на планшете в зале приложение применит цвета темы по умолчанию вместо этой пары.'
      : '';
  }
}

// ---------- ПАНЕЛЬ ПЛАТФОРМЫ (СУПЕР-АДМИН) ----------

function screenSuperAdmin() {
  // Супер-админ без своего заведения по умолчанию и так уже здесь (см.
  // route()) — "← В консоль" вёл бы его в никуда (обратно на эту же
  // панель). Ему нужна не ссылка назад, а явный путь завести СВОЁ
  // заведение, если он вообще этого хочет.
  const backLink = state.tenants.length
    ? '<a href="#/" class="btn-link">← В консоль</a>'
    : '<a href="#/onboarding" class="btn-link">Своё заведение</a>';
  screenEl().innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:8px">
      <div class="brand">Hoocah POS · платформа</div>
      ${backLink}
    </div>
    <h1>Панель платформы</h1>

    <h2>Требует внимания</h2>
    <div id="admin-attention"><div class="spinner"></div></div>

    <h2>Аналитика</h2>
    <div id="admin-analytics"><div class="spinner"></div></div>
    <button class="btn btn-ghost" id="f-export-payments-csv" style="margin:10px 0 14px">Экспорт последних платежей в CSV</button>

    <h2>Тарифы</h2>
    <div id="admin-plans"><div class="spinner"></div></div>
    <button class="btn btn-ghost" id="f-new-plan" style="margin-bottom:14px">Добавить тариф</button>

    <h2>Все заведения</h2>
    <div class="row" style="margin-bottom:14px">
      <input id="f-tenant-search" class="grow" placeholder="Название, код или email владельца">
      <select id="f-tenant-status-filter" style="width:auto">
        <option value="">Все статусы</option>
        <option value="trial">Пробный период</option>
        <option value="active">Активно</option>
        <option value="pastDue">Просрочена оплата</option>
        <option value="suspended">Приостановлено</option>
        <option value="cancelled">Отменено</option>
      </select>
    </div>
    <button class="btn btn-ghost" id="f-export-tenants-csv" style="margin-bottom:14px">Экспорт заведений в CSV</button>
    <div id="admin-body"><div class="spinner"></div></div>

    <h2>Сотрудники платформы</h2>
    <p class="small muted">Есть полный доступ к панели платформы — назначайте
    только тем, кому лично доверяете. Кандидат должен СНАЧАЛА сам
    зарегистрироваться в этой консоли (email + пароль) и подтвердить почту —
    только тогда его можно найти по email и назначить.</p>
    <div id="admin-super-admins"><div class="spinner"></div></div>
    <div class="card">
      <label class="field"><span>Назначить супер-админом по email</span>
        <input id="f-super-admin-email" type="email" placeholder="coworker@example.com">
      </label>
      <button class="btn btn-ghost" id="f-super-admin-grant">Назначить</button>
      <div id="f-super-admin-error" class="small" style="color:var(--danger);margin-top:8px"></div>
    </div>

    <h2>Журнал платформы</h2>
    <div id="admin-audit"><div class="spinner"></div></div>
    ${versionFooterHtml()}
  `;
  watchAllTenants();
  watchAuditLog();
  watchPlans();
  watchAnalytics();
  watchSuperAdmins();
}

function watchAllTenants() {
  const body = $('admin-body');
  const attentionBody = $('admin-attention');
  // limit(200) без постраничности — заведомо достаточно на старте
  // платформы; поиск ниже фильтрует уже загруженный список на клиенте, а
  // не делает отдельный запрос — простое и рабочее решение, пока
  // заведений меньше пары сотен (настоящая курсорная пагинация — отдельная
  // задача, когда/если платформа вырастет за этот предел).
  const q = query(collection(state.db, 'tenants'), orderBy('createdAt', 'desc'), limit(200));
  let allTenants = [];
  let plans = [];
  // "Подробнее" на карточке заведения — раскрытые id и подгруженные для них
  // данные (команда/код приглашения/заметки), которые НЕ идут в основной
  // снапшот заведений: дорого тянуть это для всех 200 заведений сразу, а
  // нужно обычно для одного-двух за раз, когда реально требуется помочь
  // клиенту или свериться по оплате.
  const expandedIds = new Set();
  const detailsCache = new Map();

  const ensureDetailsLoaded = async (tenantId) => {
    try {
      const [membersSnap, inviteSnap, notesSnap] = await Promise.all([
        getDocs(query(collection(state.db, 'tenantMembers'), where('tenantId', '==', tenantId))),
        getDoc(doc(state.db, 'tenants', tenantId, 'settings', 'deviceInvite')),
        getDoc(doc(state.db, 'tenants', tenantId, 'internal', 'adminNotes')),
      ]);
      detailsCache.set(tenantId, {
        members: membersSnap.docs.map((d) => d.data()),
        invite: inviteSnap.exists() ? inviteSnap.data() : null,
        notes: notesSnap.exists() ? (notesSnap.data().text || '') : '',
      });
    } catch (_) {
      detailsCache.set(tenantId, { members: [], invite: null, notes: '' });
    }
    draw();
  };

  const toggleTenantDetail = (tenantId) => {
    if (expandedIds.has(tenantId)) {
      expandedIds.delete(tenantId);
      draw();
    } else {
      expandedIds.add(tenantId);
      draw();
      if (!detailsCache.has(tenantId)) ensureDetailsLoaded(tenantId);
    }
  };

  const saveTenantNotes = async (tenantId) => {
    const el = document.querySelector(`.f-tenant-notes[data-id="${tenantId}"]`);
    const btn = document.querySelector(`.f-tenant-notes-save[data-id="${tenantId}"]`);
    if (!el) return;
    if (btn) btn.disabled = true;
    try {
      await setDoc(doc(state.db, 'tenants', tenantId, 'internal', 'adminNotes'), {
        text: el.value, updatedAt: Timestamp.fromDate(new Date()), updatedBy: state.uid,
      }, { merge: true });
      const cached = detailsCache.get(tenantId) || { members: [], invite: null };
      cached.notes = el.value;
      detailsCache.set(tenantId, cached);
      toast('Заметка сохранена');
    } catch (e) {
      toast(`Не удалось сохранить заметку: ${e?.message || e}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  const saveSubscriptionOverride = async (tenantId) => {
    const statusEl = document.querySelector(`.f-sub-status[data-id="${tenantId}"]`);
    const periodEl = document.querySelector(`.f-sub-period-end[data-id="${tenantId}"]`);
    const trialEl = document.querySelector(`.f-sub-trial-end[data-id="${tenantId}"]`);
    const btn = document.querySelector(`.f-sub-save[data-id="${tenantId}"]`);
    if (!statusEl) return;
    if (btn) btn.disabled = true;
    try {
      const payload = { status: statusEl.value };
      if (periodEl.value) payload.currentPeriodEnd = Timestamp.fromDate(new Date(`${periodEl.value}T12:00:00`));
      if (trialEl.value) payload.trialEndsAt = Timestamp.fromDate(new Date(`${trialEl.value}T12:00:00`));
      // Ручной override всегда означает "разобрались вручную" — сбрасываем
      // pastDueSince, иначе отсчёт до удаления данных продолжит тикать по
      // старой дате даже после того, как деньги на самом деле пришли.
      if (statusEl.value !== 'past_due') payload.pastDueSince = null;
      await setDoc(doc(state.db, 'subscriptions', tenantId), payload, { merge: true });
      toast('Подписка обновлена');
    } catch (e) {
      toast(`Не удалось обновить подписку: ${e?.message || e}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  const renderTenantDetail = (t) => {
    const d = detailsCache.get(t.id);
    if (!d) return '<div class="small muted" style="margin-top:10px">Загрузка…</div>';
    const sortedMembers = (d.members || []).slice().sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
    return `
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
        <div class="small muted" style="margin-bottom:8px">Владелец: ${esc(t.ownerEmail || t.ownerUserId || '—')}</div>

        <div class="small muted" style="margin-bottom:4px">Команда</div>
        ${sortedMembers.length ? sortedMembers.map((m) => `
          <div class="small" style="padding:2px 0">${esc(m.email || `Устройство · ${(m.userId || '').slice(-4).toUpperCase()}`)} — ${esc(ROLE_LABELS[m.role] || m.role)}${m.status !== 'active' ? ' · отключён' : ''}</div>
        `).join('') : '<div class="small muted">Пусто</div>'}

        <div class="row" style="justify-content:space-between;align-items:center;margin-top:12px">
          <div class="small muted">Код приглашения устройства: <code>${esc(d.invite?.code || '—')}</code></div>
          <button class="btn-link f-tenant-rotate-invite" data-id="${esc(t.id)}" style="width:auto">Обновить</button>
        </div>

        <div style="margin-top:12px">
          <div class="small muted" style="margin-bottom:6px">Заметки (видны только супер-админам)</div>
          <textarea class="f-tenant-notes" data-id="${esc(t.id)}" rows="3" placeholder="Например: платит переводом, звонил по поводу..." style="width:100%;resize:vertical">${esc(d.notes || '')}</textarea>
          <button class="btn btn-ghost f-tenant-notes-save" data-id="${esc(t.id)}" style="margin-top:6px">Сохранить заметку</button>
        </div>

        <div style="margin-top:14px">
          <div class="small muted" style="margin-bottom:6px">Ручное управление подпиской (оплата вне ЮKassa — перевод, наличные)</div>
          <select class="f-sub-status" data-id="${esc(t.id)}">
            ${Object.keys(SUB_STATUS_LABELS).map((s) => `<option value="${s}" ${t.subscription?.status === s ? 'selected' : ''}>${esc(SUB_STATUS_LABELS[s])}</option>`).join('')}
          </select>
          <label class="field"><span>Оплачено до</span>
            <input type="date" class="f-sub-period-end" data-id="${esc(t.id)}" value="${tsToDateInputValue(t.subscription?.currentPeriodEnd)}">
          </label>
          <label class="field"><span>Триал до</span>
            <input type="date" class="f-sub-trial-end" data-id="${esc(t.id)}" value="${tsToDateInputValue(t.subscription?.trialEndsAt)}">
          </label>
          <button class="btn btn-ghost f-sub-save" data-id="${esc(t.id)}">Сохранить подписку</button>
        </div>
      </div>
    `;
  };

  const drawAttention = () => {
    if (!attentionBody) return;
    const items = [];
    allTenants.forEach((t) => {
      if (t.daysLeft !== null && t.daysLeft !== undefined) {
        items.push({
          danger: true,
          text: `«${t.name || t.id}» — просрочена оплата, данные удалятся ${t.daysLeft > 0 ? `через ${t.daysLeft} ${pluralDays(t.daysLeft)}` : 'при ближайшей проверке'}`,
        });
      } else if (t.trialEndingSoonDays !== null && t.trialEndingSoonDays !== undefined) {
        items.push({
          danger: false,
          text: `«${t.name || t.id}» — пробный период заканчивается ${t.trialEndingSoonDays > 0 ? `через ${t.trialEndingSoonDays} ${pluralDays(t.trialEndingSoonDays)}` : 'сегодня'}`,
        });
      }
    });
    attentionBody.innerHTML = items.length ? items.map((it) => `
      <div class="card${it.danger ? ' danger' : ''}" style="padding:12px 16px">
        <div class="small">${it.danger ? '⚠' : '⏳'} ${esc(it.text)}</div>
      </div>
    `).join('') : '<p class="small muted">Заведений, требующих внимания, сейчас нет.</p>';
  };

  const draw = () => {
    const term = ($('f-tenant-search')?.value || '').trim().toLowerCase();
    const statusFilter = $('f-tenant-status-filter')?.value || '';
    let filtered = allTenants.filter((t) =>
      (!term || (t.name || '').toLowerCase().includes(term) || (t.slug || '').toLowerCase().includes(term) ||
        (t.ownerEmail || '').toLowerCase().includes(term)) &&
      (!statusFilter || t.status === statusFilter));
    // Проблемные заведения — наверх списка, чтобы не листать сотню
    // здоровых ради тех, что горят.
    filtered = filtered.slice().sort((a, b) => {
      const rank = (t) => (t.daysLeft !== null && t.daysLeft !== undefined ? 0 : (t.trialEndingSoonDays !== null && t.trialEndingSoonDays !== undefined ? 1 : 2));
      return rank(a) - rank(b);
    });

    body.innerHTML = filtered.length ? filtered.map((t) => `
      <div class="card${t.daysLeft !== null && t.daysLeft !== undefined ? ' danger' : ''}">
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div class="grow" style="min-width:0">
            <div style="font-weight:700">${esc(t.name || t.id)}</div>
            <div class="small muted">
              <code>${esc(t.slug || '')}</code> ·
              ${esc(TENANT_STATUS_LABELS[t.status] || t.status || '—')} ·
              создано ${fmtDate(t.createdAt)}
            </div>
            <div class="small muted">
              тариф: ${esc(planName(plans, t.subscription?.planId) || t.subscription?.planId || '—')} ·
              подписка: ${esc(SUB_STATUS_LABELS[t.subscription?.status] || t.subscription?.status || '—')}
              ${t.subscription?.status === 'trial' && t.subscription?.trialEndsAt ? ` · триал до ${fmtDate(t.subscription.trialEndsAt)}` : ''}
              ${t.subscription?.status === 'active' && t.subscription?.currentPeriodEnd ? ` · оплачено до ${fmtDate(t.subscription.currentPeriodEnd)}` : ''}
            </div>
            ${t.daysLeft !== null && t.daysLeft !== undefined ? `
              <div class="small" style="color:var(--danger);margin-top:4px">
                ⚠ Данные будут удалены ${t.daysLeft > 0 ? `через ${t.daysLeft} ${pluralDays(t.daysLeft)}` : 'при ближайшей проверке'}
              </div>
            ` : ''}
            ${t.usage ? `
              <div class="small muted">
                сотрудников: ${t.usage.employees ?? '—'} · устройств: ${t.usage.devices ?? '—'} ·
                столов: ${t.usage.tables ?? '—'} · гостей: ${t.usage.guests ?? '—'}
              </div>
            ` : ''}
          </div>
          <button class="btn-ghost f-tenant-toggle" data-id="${esc(t.id)}"
            data-suspended="${t.status === 'suspended' ? '1' : '0'}" style="width:auto">
            ${t.status === 'suspended' ? 'Разблокировать' : 'Заблокировать'}
          </button>
        </div>
        ${plans.length ? `
          <div class="row" style="margin-top:10px;align-items:center">
            <div class="small muted">Тариф:</div>
            <select class="f-tenant-plan grow" data-id="${esc(t.id)}">
              ${plans.map((p) => `<option value="${esc(p.id)}" ${p.id === t.planId ? 'selected' : ''}>${esc(p.name || p.id)}</option>`).join('')}
            </select>
          </div>
        ` : ''}
        <button class="btn-link f-tenant-detail-toggle" data-id="${esc(t.id)}" style="margin-top:8px">
          ${expandedIds.has(t.id) ? 'Свернуть ▲' : 'Подробнее ▾'}
        </button>
        ${expandedIds.has(t.id) ? renderTenantDetail(t) : ''}
      </div>
    `).join('') : `<p class="small muted">${term || statusFilter ? 'Ничего не найдено.' : 'Заведений пока нет.'}</p>`;

    document.querySelectorAll('.f-tenant-toggle').forEach((el) => {
      el.onclick = () => toggleTenantSuspension(el.dataset.id, el.dataset.suspended === '1');
    });
    document.querySelectorAll('.f-tenant-plan').forEach((el) => {
      el.onchange = () => changeTenantPlan(el.dataset.id, el.value);
    });
    document.querySelectorAll('.f-tenant-detail-toggle').forEach((el) => {
      el.onclick = () => toggleTenantDetail(el.dataset.id);
    });
    document.querySelectorAll('.f-tenant-rotate-invite').forEach((el) => {
      el.onclick = async () => {
        await rotateInviteCode(el.dataset.id);
        ensureDetailsLoaded(el.dataset.id);
      };
    });
    document.querySelectorAll('.f-tenant-notes-save').forEach((el) => {
      el.onclick = () => saveTenantNotes(el.dataset.id);
    });
    document.querySelectorAll('.f-sub-save').forEach((el) => {
      el.onclick = () => saveSubscriptionOverride(el.dataset.id);
    });
  };

  $('f-tenant-search').addEventListener('input', draw);
  $('f-tenant-status-filter').addEventListener('change', draw);

  getDocs(collection(state.db, 'plans')).then((snap) => {
    plans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  }).catch(() => {});

  sub(onSnapshot(q, async (snap) => {
    const tenants = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Usage читаем отдельно от списка заведений — это соседняя коллекция
    // (tenants/{id}/usage/current), не realtime: пересчитывается раз в
    // сутки Cloud Function calculateUsage, обновлять её на каждый снапшот
    // списка заведений незачем. Подписку читаем туда же — она и даёт
    // "требует внимания" (грейс-период / скорый конец триала), и тариф с
    // датами на карточке заведения ниже.
    await Promise.all(tenants.map(async (t) => {
      try {
        const uSnap = await getDoc(doc(state.db, 'tenants', t.id, 'usage', 'current'));
        t.usage = uSnap.exists() ? uSnap.data() : null;
      } catch (_) {
        t.usage = null;
      }
      try {
        const sSnap = await getDoc(doc(state.db, 'subscriptions', t.id));
        const subscription = sSnap.exists() ? sSnap.data() : null;
        t.subscription = subscription;
        t.daysLeft = daysUntilDataPurge(subscription);
        t.trialEndingSoonDays = null;
        if (t.daysLeft === null) {
          const trialDays = daysUntilTrialEnd(subscription);
          if (trialDays !== null && trialDays <= 3) t.trialEndingSoonDays = Math.max(0, trialDays);
        }
      } catch (_) {
        t.subscription = null;
        t.daysLeft = null;
        t.trialEndingSoonDays = null;
      }
      // Для поиска по email владельца и отображения в "Подробнее" — не
      // критично, если недоступно (например у совсем старой записи нет
      // ownerUserId), тогда просто не участвует в поиске по email.
      try {
        if (t.ownerUserId) {
          const uSnap = await getDoc(doc(state.db, 'users', t.ownerUserId));
          t.ownerEmail = uSnap.exists() ? uSnap.data().email || null : null;
        } else {
          t.ownerEmail = null;
        }
      } catch (_) {
        t.ownerEmail = null;
      }
    }));
    allTenants = tenants;
    draw();
    drawAttention();
  }, () => {
    body.innerHTML = '<p class="small" style="color:var(--danger)">Нет доступа к списку заведений.</p>';
  }));

  if ($('f-export-tenants-csv')) {
    $('f-export-tenants-csv').onclick = () => {
      const rows = [[
        'Название', 'Код', 'Статус', 'Тариф', 'Статус подписки', 'Оплачено до', 'Триал до',
        'Владелец (email)', 'Сотрудников', 'Устройств', 'Столов', 'Гостей', 'Создано',
      ]];
      allTenants.forEach((t) => {
        rows.push([
          t.name || t.id, t.slug || '', TENANT_STATUS_LABELS[t.status] || t.status || '',
          planName(plans, t.subscription?.planId) || t.subscription?.planId || '',
          SUB_STATUS_LABELS[t.subscription?.status] || t.subscription?.status || '',
          t.subscription?.currentPeriodEnd ? fmtDate(t.subscription.currentPeriodEnd) : '',
          t.subscription?.trialEndsAt ? fmtDate(t.subscription.trialEndsAt) : '',
          t.ownerEmail || '', t.usage?.employees ?? '', t.usage?.devices ?? '', t.usage?.tables ?? '', t.usage?.guests ?? '',
          fmtDate(t.createdAt),
        ]);
      });
      downloadCsv(`hoocah-pos-заведения-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    };
  }
}

function watchAuditLog() {
  const body = $('admin-audit');
  const q = query(collection(state.db, 'auditLogs'), orderBy('createdAt', 'desc'), limit(50));
  sub(onSnapshot(q, (snap) => {
    const entries = snap.docs.map((d) => d.data());
    body.innerHTML = entries.length ? `<div class="card">${entries.map((e) => `
      <div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <div class="small">${esc(AUDIT_ACTION_LABELS[e.action] || e.action)}
          ${e.tenantId ? `· <code>${esc(e.tenantId)}</code>` : ''}
        </div>
        <div class="small muted">${fmtDateTime(e.createdAt)}</div>
      </div>
    `).join('')}</div>` : '<p class="small muted">Событий пока нет.</p>';
  }, () => {
    body.innerHTML = '<p class="small muted">Журнал недоступен.</p>';
  }));
}

function watchPlans() {
  const body = $('admin-plans');
  sub(onSnapshot(collection(state.db, 'plans'), (snap) => {
    const plans = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.priceRub || 0) - (b.priceRub || 0));
    body.innerHTML = plans.length ? plans.map((p) => `
      <div class="card">
        <div style="font-weight:700;margin-bottom:10px">${esc(p.id)}</div>
        <label class="field"><span>Название</span>
          <input class="f-plan-field" data-plan="${esc(p.id)}" data-field="name" value="${esc(p.name || '')}">
        </label>
        <label class="field"><span>Цена, ₽/мес (0 — не продаётся напрямую, только вручную через смену тарифа заведению)</span>
          <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="priceRub" value="${Number(p.priceRub) || 0}">
        </label>
        <label class="field"><span>Цена, ₽/год (0 — годовая оплата для этого тарифа недоступна)</span>
          <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="priceRubYearly" value="${Number(p.priceRubYearly) || 0}">
        </label>
        <div class="row">
          <label class="field grow"><span>Сотрудников (0 = без лимита)</span>
            <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="maxEmployees" value="${Number(p.maxEmployees) || 0}">
          </label>
          <label class="field grow"><span>Устройств (0 = без лимита)</span>
            <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="maxDevices" value="${Number(p.maxDevices) || 0}">
          </label>
        </div>
        <div class="row">
          <label class="field grow"><span>Столов (0 = без лимита)</span>
            <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="maxTables" value="${Number(p.maxTables) || 0}">
          </label>
          <label class="field grow"><span>Хранилище, МБ (0 = без лимита)</span>
            <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="maxStorageMb" value="${Number(p.maxStorageMb) || 0}">
          </label>
        </div>
        <div class="row" style="flex-wrap:wrap;gap:14px;margin:10px 0 16px">
          <label class="row" style="width:auto;gap:6px">
            <input type="checkbox" class="f-plan-checkbox" data-plan="${esc(p.id)}" data-field="aiEnabled" ${p.aiEnabled ? 'checked' : ''}> ИИ
          </label>
          <label class="row" style="width:auto;gap:6px">
            <input type="checkbox" class="f-plan-checkbox" data-plan="${esc(p.id)}" data-field="customBranding" ${p.customBranding ? 'checked' : ''}> Свой брендинг
          </label>
          <label class="row" style="width:auto;gap:6px">
            <input type="checkbox" class="f-plan-checkbox" data-plan="${esc(p.id)}" data-field="customDomain" ${p.customDomain ? 'checked' : ''}> Свой домен
          </label>
        </div>
        <div class="row">
          <button class="btn btn-primary f-plan-save" data-plan="${esc(p.id)}">Сохранить тариф</button>
          <button class="btn-link f-plan-delete" data-plan="${esc(p.id)}" style="width:auto;color:var(--danger)">Удалить</button>
        </div>
      </div>
    `).join('') : '<p class="small muted">Тарифов пока нет.</p>';

    document.querySelectorAll('.f-plan-save').forEach((el) => {
      el.onclick = () => savePlan(el.dataset.plan);
    });
    document.querySelectorAll('.f-plan-delete').forEach((el) => {
      el.onclick = () => deletePlan(el.dataset.plan);
    });
  }, () => {
    body.innerHTML = '<p class="small muted">Тарифы недоступны.</p>';
  }));

  $('f-new-plan').onclick = async () => {
    const id = prompt('Код нового тарифа (латиница, цифры, дефис — например custom-vip):');
    if (!id || !/^[a-z0-9-]+$/.test(id)) {
      if (id !== null) toast('Код тарифа: только латиница, цифры и дефис');
      return;
    }
    try {
      await setDoc(doc(state.db, 'plans', id), {
        name: id, priceRub: 0, priceRubYearly: 0, maxEmployees: 0, maxDevices: 0, maxTables: 0, maxStorageMb: 0,
        aiEnabled: false, customBranding: false, customDomain: false,
        features: { reservations: true, loyalty: true, guestApp: true, advancedReports: false },
      });
      toast('Тариф создан — заполните цену и лимиты ниже');
    } catch (e) {
      toast(`Не удалось создать тариф: ${e?.message || e}`);
    }
  };
}

async function savePlan(planId) {
  const btn = document.querySelector(`.f-plan-save[data-plan="${planId}"]`);
  if (btn) btn.disabled = true;
  try {
    const payload = {};
    document.querySelectorAll(`.f-plan-field[data-plan="${planId}"]`).forEach((el) => {
      payload[el.dataset.field] = el.type === 'number' ? Number(el.value) || 0 : el.value;
    });
    document.querySelectorAll(`.f-plan-checkbox[data-plan="${planId}"]`).forEach((el) => {
      payload[el.dataset.field] = el.checked;
    });
    await setDoc(doc(state.db, 'plans', planId), payload, { merge: true });
    toast('Тариф сохранён');
  } catch (e) {
    toast(`Не удалось сохранить тариф: ${e?.message || e}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deletePlan(planId) {
  const btn = document.querySelector(`.f-plan-delete[data-plan="${planId}"]`);
  if (btn) btn.disabled = true;
  try {
    // Предупреждаем, если тариф ещё кому-то назначен — само удаление их не
    // трогает (у заведения просто останется planId, ссылающийся в никуда;
    // "Тариф: —" в его карточке подскажет, что надо назначить другой), но
    // молча удалять тариф, которым кто-то пользуется, не стоит.
    const inUse = await getDocs(query(collection(state.db, 'tenants'), where('planId', '==', planId), limit(1)));
    const warning = inUse.empty
      ? `Удалить тариф «${planId}»? Отменить нельзя.`
      : `Тариф «${planId}» сейчас назначен как минимум одному заведению — после удаления у него останется тариф без описания, назначьте другой вручную. Удалить всё равно?`;
    if (!confirm(warning)) return;
    await deleteDoc(doc(state.db, 'plans', planId));
    toast('Тариф удалён');
  } catch (e) {
    toast(`Не удалось удалить тариф: ${e?.message || e}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function watchAnalytics() {
  const body = $('admin-analytics');

  const draw = (tenants, revenueEvents) => {
    const now = Date.now();
    const day = 86400000;
    const byStatus = {};
    tenants.forEach((t) => { byStatus[t.status] = (byStatus[t.status] || 0) + 1; });
    const activeCount = byStatus.active || 0;
    const mrr = tenants.reduce((sum, t) => {
      if (t.status !== 'active') return sum;
      const plan = state.plansById?.[t.planId];
      return sum + (Number(plan?.priceRub) || 0);
    }, 0);
    const signups7d = tenants.filter((t) => t.createdAt?.toMillis && now - t.createdAt.toMillis() <= 7 * day).length;
    const signups30d = tenants.filter((t) => t.createdAt?.toMillis && now - t.createdAt.toMillis() <= 30 * day).length;
    const succeeded = revenueEvents.filter((e) => e.status === 'succeeded');
    const totalRevenue = succeeded.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

    const tile = (label, value) => `
      <div class="card" style="text-align:center;padding:14px 8px">
        <div style="font-size:22px;font-weight:700">${value}</div>
        <div class="small muted">${esc(label)}</div>
      </div>
    `;
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${tile('Всего заведений', tenants.length)}
        ${tile('Активных подписок', activeCount)}
        ${tile('MRR (оценка)', `${mrr.toLocaleString('ru-RU')} ₽`)}
        ${tile('Выручка (последние платежи)', `${totalRevenue.toLocaleString('ru-RU')} ₽`)}
        ${tile('Регистраций за 7 дней', signups7d)}
        ${tile('Регистраций за 30 дней', signups30d)}
      </div>
      <p class="small muted" style="margin-top:10px">
        Разбивка по статусам: ${Object.entries(byStatus).map(([s, n]) => `${esc(TENANT_STATUS_LABELS[s] || s)} — ${n}`).join(', ') || '—'}.
        Выручка — сумма последних ${revenueEvents.length} обработанных платежей ЮKassa, не весь исторический архив.
      </p>
    `;
  };

  let tenants = null;
  let revenueEvents = null;
  const maybeDraw = () => { if (tenants && revenueEvents) draw(tenants, revenueEvents); };

  getDocs(collection(state.db, 'plans')).then((snap) => {
    state.plansById = {};
    snap.docs.forEach((d) => { state.plansById[d.id] = d.data(); });
  }).catch(() => { state.plansById = {}; });

  sub(onSnapshot(query(collection(state.db, 'tenants'), orderBy('createdAt', 'desc'), limit(500)), (snap) => {
    tenants = snap.docs.map((d) => d.data());
    maybeDraw();
  }, () => { tenants = []; maybeDraw(); }));

  // Статус фильтруем на клиенте, а не в запросе — экономит один составной
  // индекс ради аналитики, которая и так читает не весь архив, а только
  // последние 500 платежей (см. текст под плитками).
  sub(onSnapshot(query(collection(state.db, 'billingEvents'), orderBy('receivedAt', 'desc'), limit(500)), (snap) => {
    revenueEvents = snap.docs.map((d) => d.data());
    maybeDraw();
  }, () => { revenueEvents = []; maybeDraw(); }));

  if ($('f-export-payments-csv')) {
    $('f-export-payments-csv').onclick = () => exportPaymentsCsv();
  }
}

async function exportPaymentsCsv() {
  const btn = $('f-export-payments-csv');
  if (btn) btn.disabled = true;
  try {
    // Свежий запрос, а не данные из watchAnalytics() — экспорт может
    // понадобиться раньше, чем отрисуется первая аналитика.
    const snap = await getDocs(query(collection(state.db, 'billingEvents'), orderBy('receivedAt', 'desc'), limit(500)));
    const rows = [['Дата', 'Заведение (id)', 'Статус', 'Назначение', 'Сумма, ₽']];
    snap.docs.forEach((d) => {
      const e = d.data();
      rows.push([fmtDateTime(e.receivedAt), e.tenantId || '—', SUB_STATUS_LABELS[e.status] || e.status || '—', e.purpose || '—', Number(e.amount) || 0]);
    });
    downloadCsv(`hoocah-pos-платежи-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  } catch (e) {
    toast(`Не удалось выгрузить платежи: ${e?.message || e}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function toggleTenantSuspension(tenantId, isSuspended) {
  try {
    const fn = httpsCallable(state.functions, isSuspended ? 'enableTenant' : 'disableTenant');
    await fn(isSuspended ? { tenantId } : { tenantId, reason: 'Заблокировано вручную из консоли платформы' });
    toast(isSuspended ? 'Заведение разблокировано' : 'Заведение заблокировано');
  } catch (e) {
    toast(`Не удалось изменить статус: ${e?.message || e}`);
  }
}

async function changeTenantPlan(tenantId, planId) {
  try {
    const fn = httpsCallable(state.functions, 'changeTenantPlan');
    await fn({ tenantId, planId });
    toast('Тариф изменён');
  } catch (e) {
    toast(`Не удалось изменить тариф: ${e?.message || e}`);
  }
}

// ---------- СОТРУДНИКИ ПЛАТФОРМЫ (СУПЕР-АДМИНЫ) ----------

function watchSuperAdmins() {
  const body = $('admin-super-admins');
  sub(onSnapshot(collection(state.db, 'superAdmins'), (snap) => {
    const admins = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    body.innerHTML = admins.length ? admins.map((a) => `
      <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
        <div class="grow" style="min-width:0">
          <div class="ellipsis">${esc(a.email || `без email · ${a.id.slice(-6).toUpperCase()}`)}${a.id === state.uid ? ' <span class="muted small">(вы)</span>' : ''}</div>
          <div class="small muted">с ${a.grantedAt ? fmtDate(a.grantedAt) : (a.since || '—')}</div>
        </div>
        ${a.id !== state.uid ? `<button class="btn-link f-super-admin-revoke" data-id="${esc(a.id)}" style="width:auto;color:var(--danger)">Снять доступ</button>` : ''}
      </div>
    `).join('') : '<p class="small muted">Список пуст.</p>';

    document.querySelectorAll('.f-super-admin-revoke').forEach((el) => {
      el.onclick = () => revokeSuperAdmin(el.dataset.id);
    });
  }, () => {
    body.innerHTML = '<p class="small muted">Список недоступен.</p>';
  }));

  $('f-super-admin-grant').onclick = async () => {
    const email = $('f-super-admin-email').value.trim();
    const errEl = $('f-super-admin-error');
    errEl.textContent = '';
    if (!email) { errEl.textContent = 'Введите email'; return; }
    $('f-super-admin-grant').disabled = true;
    try {
      await promoteSuperAdmin(email);
      $('f-super-admin-email').value = '';
      toast('Назначен супер-админом');
    } catch (e) {
      errEl.textContent = e?.message || 'Не удалось назначить';
    } finally {
      $('f-super-admin-grant').disabled = false;
    }
  };
}

async function promoteSuperAdmin(email) {
  // Найти можно только того, кто уже сам зарегистрировался в консоли —
  // ровно тот же приём, что и приглашение сотрудника заведения
  // (inviteTenantMember): нельзя выдать роль тому, у кого ещё даже нет
  // аккаунта, потому что не к чему привязать документ (нужен его uid).
  const q = query(collection(state.db, 'users'), where('email', '==', email), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) {
    throw new Error('Этот email ещё не зарегистрирован в консоли — попросите сотрудника сначала зарегистрироваться (кнопка «Зарегистрироваться» на экране входа), затем попробуйте снова');
  }
  const uid = snap.docs[0].id;
  await setDoc(doc(state.db, 'superAdmins', uid), {
    email,
    grantedAt: Timestamp.fromDate(new Date()),
    grantedBy: state.uid,
  });
}

async function revokeSuperAdmin(uid) {
  if (uid === state.uid) {
    toast('Нельзя снять доступ у самого себя — попросите другого супер-админа');
    return;
  }
  if (!confirm('Снять права супер-админа платформы у этого пользователя?')) return;
  try {
    await deleteDoc(doc(state.db, 'superAdmins', uid));
    toast('Доступ снят');
  } catch (e) {
    toast(`Не удалось снять доступ: ${e?.message || e}`);
  }
}

// ---------- ПОДПИСКА (ЮKASSA) И СБОРКА APK ----------

async function startCheckout(tenantId, planId, billingPeriod) {
  const errEl = $('f-checkout-error');
  if (errEl) errEl.textContent = '';
  try {
    const createCheckoutSession = httpsCallable(state.functions, 'createCheckoutSession');
    const res = await createCheckoutSession({
      tenantId, planId, billingPeriod: billingPeriod === 'yearly' ? 'yearly' : 'monthly',
      // После оплаты ЮKassa вернёт сюда же — на этот дашборд, где статус
      // подписки обновится сам по snapshot-подписке, как только придёт
      // webhook (обычно за секунды, но платёжная форма может быть и
      // быстрее самого webhook'а — поэтому это просто "куда вернуться",
      // а не сигнал об оплате).
      returnUrl: `${location.origin}${location.pathname}#/`,
    });
    if (res.data?.confirmationUrl) {
      location.href = res.data.confirmationUrl;
    } else {
      throw new Error('ЮKassa не вернула ссылку на оплату');
    }
  } catch (e) {
    if (errEl) errEl.textContent = `Не удалось начать оплату: ${e?.message || e}`;
  }
}

async function requestBuild(tenantId) {
  const errEl = $('f-build-error');
  if (errEl) errEl.textContent = '';
  const btn = $('f-request-build');
  if (btn) btn.disabled = true;
  try {
    const createBuildJob = httpsCallable(state.functions, 'createBuildJob');
    await createBuildJob({ tenantId });
    toast('Сборка запущена — обычно занимает 5–10 минут');
  } catch (e) {
    if (errEl) errEl.textContent = `Не удалось запустить сборку: ${e?.message || e}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function downloadBuild(storagePath) {
  try {
    const url = await getDownloadURL(ref(state.storage, storagePath));
    window.open(url, '_blank', 'noopener');
  } catch (e) {
    toast(`Не удалось получить файл: ${e?.message || e}`);
  }
}
