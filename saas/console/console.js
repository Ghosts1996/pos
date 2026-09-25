// Консоль владельца заведения — веб-приложение SaaS-платформы Hookah POS.
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
  reauthenticateWithCredential, EmailAuthProvider, sendPasswordResetEmail,
  updatePassword,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot,
  collection, query, where, orderBy, limit, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getFunctions, httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';
// Firebase Storage больше не используется — единственное, для чего он был
// нужен (логотип заведения, см. handleUploadBrandingLogo в
// saas-gateway/server.js), требует у saas-3bdc8 платный тариф Blaze, а
// бакета физически не существует (та же история, что и с публичным APK —
// см. saas/README.md, раздел 8b). Загрузка логотипа перенесена на сам
// saas-gateway, см. uploadBrandingLogoToGateway() ниже.

// Тот же регион, что у Cloud Functions платформы (см. saas/functions/index.js).
const FUNCTIONS_REGION = 'europe-west1';

// Адрес saas-gateway (см. saas-gateway/README.md) — берёт на себя
// createTenant/createBuildJob, которые не могут задеплоиться как Cloud
// Functions без тарифа Blaze у этого проекта. Тот же сервер и сертификат,
// что и у pii-gateway (см. saas-gateway/README.md, раздел про nginx) —
// отдельный путь /saas/, а не отдельный домен.
const SAAS_GATEWAY_URL = 'https://pii.hookahpos.su/saas';

/** Вызывает saas-gateway тем же способом, каким httpsCallable вызывал бы
 *  Cloud Function — с ID-токеном текущего пользователя в заголовке и JSON
 *  телом. Бросает Error с понятным сообщением (существующие вызывающие
 *  места уже показывают e.message пользователю). */
async function callSaasGateway(path, data) {
  if (!SAAS_GATEWAY_URL) {
    throw new Error(
      'SAAS_GATEWAY_URL не задан в console.js — заведите свой сервис (см. saas-gateway/README.md) и пропишите его адрес.'
    );
  }
  const idToken = await state.auth.currentUser?.getIdToken();
  const res = await fetch(`${SAAS_GATEWAY_URL}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify(data || {}),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error || `Сервис ответил ошибкой (${res.status})`);
  }
  return { data: json };
}

/** Загружает логотип заведения в saas-gateway (см. handleUploadBrandingLogo
 *  в server.js) — XMLHttpRequest, а не fetch, потому что только у него
 *  есть реальный процент ОТПРАВКИ тела запроса (fetch отслеживает лишь
 *  скачивание ответа). Возвращает { xhr, promise }: xhr — чтобы вызывающий
 *  код мог отменить загрузку (xhr.abort()) или засечь зависание по
 *  отсутствию прогресса, promise разрешается относительным путём файла на
 *  сервере (без домена — см. docstring самого хендлера). */
function uploadBrandingLogoToGateway(tenantId, file, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', `${SAAS_GATEWAY_URL}/uploadBrandingLogo?tenantId=${encodeURIComponent(tenantId)}`);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      let json = null;
      try { json = JSON.parse(xhr.responseText); } catch (_) { /* см. ниже — пустой ответ трактуется как ошибка */ }
      if (xhr.status >= 200 && xhr.status < 300 && json?.path) resolve(json.path);
      else reject(new Error(json?.error || `Сервис ответил ошибкой (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Не удалось связаться с сервером'));
    xhr.onabort = () => reject(Object.assign(new Error('Загрузка отменена'), { code: 'upload/canceled' }));
    state.auth.currentUser.getIdToken().then((idToken) => {
      xhr.setRequestHeader('Authorization', `Bearer ${idToken}`);
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.send(file);
    }, reject);
  });
  return { xhr, promise };
}

// Метка версии консоли — меняется при каждой заметной правке этого файла.
// Показывается мелко внизу экрана входа и панели платформы: единственный
// способ на глаз отличить "деплой прошёл, но браузер показывает старый
// кэш" от "деплой ещё не запускали" — без нужды листать `firebase deploy`
// в терминале заново.
const CONSOLE_BUILD = '2026-09-22.4-colored-svg-icons-aligned';
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
  authLinkError: null,  // см. boot() — ссылка входа устарела/уже использована
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

/** Какие объявления платформы владелец уже закрыл на ЭТОМ браузере — простой
 *  localStorage, без синхронизации между устройствами (см. комментарий у
 *  `let broadcasts` в watchDashboardData). Обёрнуто в try/catch: приватный
 *  режим браузера или отключённое хранилище не должны ронять весь "Обзор". */
function dismissedBroadcastIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem('dismissedBroadcasts') || '[]'));
  } catch (_) {
    return new Set();
  }
}
function dismissBroadcast(id) {
  try {
    const ids = dismissedBroadcastIds();
    ids.add(id);
    localStorage.setItem('dismissedBroadcasts', JSON.stringify([...ids]));
  } catch (_) { /* см. docstring выше — не критично, просто не запомнится */ }
}

/** Повторный пароль перед опасным действием в панели платформы (супер-админ
 *  #10) — не полноценная 2FA (та требует Identity Platform, платный тариф,
 *  привязанный к тому же Blaze, который весь этот сеанс сознательно
 *  обходили ради экономии), а более лёгкая защита: если чужая сессия каким-
 *  то образом оказалась открыта в браузере супер-админа (забытый вход на
 *  чужом устройстве, похищенный токен), у злоумышленника всё равно нет
 *  пароля — назначить/снять супер-админа или необратимо удалить заведение
 *  с наскока не выйдет. Пароль есть у КАЖДОГО супер-админа гарантированно —
 *  сама панель требует регистрации в этой консоли ДО назначения (см. текст
 *  на вкладке "Сотрудники платформы"); регистрация теперь не спрашивает
 *  пароль напрямую (см. screenAuth), но всё равно создаёт для аккаунта
 *  пароль (случайный, задать свой владелец сможет по ссылке из письма) —
 *  reauthenticateWithCredential работает точно так же в обоих случаях.
 *  Возвращает true, если пароль подтверждён, false — если отменили ввод. */
async function reauthenticate(actionLabel) {
  const password = prompt(`Подтвердите действие «${actionLabel}» — введите свой пароль от этой панели:`);
  if (password === null) return false;
  if (!password) {
    toast('Пароль не введён — действие отменено');
    return false;
  }
  try {
    await reauthenticateWithCredential(state.auth.currentUser, EmailAuthProvider.credential(state.auth.currentUser.email, password));
    return true;
  } catch (e) {
    toast(e?.code === 'auth/wrong-password' || e?.code === 'auth/invalid-credential' ? 'Неверный пароль' : `Не удалось подтвердить: ${e?.message || e}`);
    return false;
  }
}

function clearScreen() {
  state.screenSubs.forEach((off) => { try { off(); } catch (_) {} });
  state.screenSubs = [];
  // Нижняя навигация — только у личного кабинета владельца (screenDashboard
  // включает его сама); любой другой экран должен начинать без него.
  screenEl().classList.remove('has-tabbar');
  // Премиальная тёмно-синяя схема лендинга (screenLanding() включает её
  // сама) — без явного снятия здесь она осталась бы висеть на #screen и
  // после ухода на любой другой экран (вход, кабинет и т.д.).
  screenEl().classList.remove('landing');
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

/// «1 человек», «2 человека», «5 человек» — «человек» неправильное
/// существительное, родительный падеж множественного числа совпадает с
/// именительным единственного, поэтому это не то же самое, что pluralDays.
function pluralPeople(n) {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last >= 2 && last <= 4) return 'человека';
  return 'человек';
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

// Персональное приветствие вверху "Обзора" — по времени суток БРАУЗЕРА
// владельца (тот же принцип, что и у "живых" цифр за сегодня) + имя,
// приближённо взятое из локальной части его email (отдельного поля "как
// вас зовут" в форме регистрации нет, а обращаться по email целиком типа
// "Добрый вечер, ivan.petrov1988@!" не звучит по-человечески).
function greetingLine() {
  const h = new Date().getHours();
  const greeting = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  const local = (state.auth.currentUser?.email || '').split('@')[0] || '';
  const name = local.split(/[.+_0-9]/)[0];
  return name ? `${greeting}, ${name.charAt(0).toUpperCase()}${name.slice(1)}` : greeting;
}

function planName(plans, planId) {
  if (!plans || !planId) return null;
  const plan = plans.find((p) => p.id === planId);
  return plan ? plan.name || plan.id : null;
}

// Список превышенных лимитов тарифа заведения ("сотрудников: 5 из 3") —
// апсел-сигнал для супер-админа: заведение переросло свой тариф, стоит
// предложить более дорогой, а не просто молча терпеть перегруз.
const PLAN_LIMIT_CHECKS = [
  ['employees', 'maxEmployees', 'сотрудников'],
  ['devices', 'maxDevices', 'устройств'],
  ['tables', 'maxTables', 'столов'],
];
function planLimitWarnings(t, plans) {
  const plan = plans?.find((p) => p.id === t.subscription?.planId);
  if (!plan || !t.usage) return [];
  const warnings = [];
  PLAN_LIMIT_CHECKS.forEach(([usageKey, limitKey, label]) => {
    const limitValue = Number(plan[limitKey]) || 0;
    const used = Number(t.usage[usageKey]) || 0;
    if (limitValue > 0 && used > limitValue) warnings.push(`${label} ${used} из ${limitValue}`);
  });
  return warnings;
}

// Логотип показывается максимум в паре десятков-сотен пикселей (окошко
// предпросмотра, иконка приложения — см. flutter_launcher_icons в
// saas-on-demand-build.yml, которому и 1024px за глаза) — а телефонная
// камера легко даёт файл на несколько мегабайт и 3000+ px по стороне,
// который на медленном мобильном интернете грузится минуты. Уменьшаем на
// клиенте перед отправкой в Storage; если canvas почему-то недоступен —
// просто шлём файл как есть, не блокируя загрузку логотипа вовсе.
async function resizeImageForUpload(file, maxDim = 1024) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) return file; // уже достаточно маленький — не трогаем
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Всегда PNG, а не формат исходника — у логотипов часто прозрачный фон
    // (JPEG её не умеет), а на таком небольшом размере разница в весе с
    // JPEG уже не критична.
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '.png'), { type: 'image/png' }) : file;
  } catch (_) {
    return file;
  }
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
// Специализация сотрудника кассы (см. AppConstants.position* в
// lib/utils/constants.dart — та же раскладка, тот же смысл значений)
// — определяет, какие вызовы гостя из-за стола ему адресованы.
// 'universal' (значение по умолчанию) получает вообще все вызовы.
const POSITION_LABELS = {
  universal: 'Универсал (видит все вызовы)',
  waiter: 'Официант',
  hookah_master: 'Кальянщик',
  bartender: 'Бармен',
};
const SUB_STATUS_LABELS = {
  trial: 'пробный период', active: 'активна', past_due: 'просрочена',
  cancelled: 'отменена', incomplete: 'не оформлена',
};
const BUILD_STATUS_LABELS = {
  queued: 'в очереди', success: 'готова', failed: 'ошибка',
};
// Одно нажатие «Собрать APK» создаёт сразу 2 buildJobs-документа с разным
// type (см. handleCreateBuildJob в saas-gateway/server.js) — подпись, чтобы
// в списке было видно, какая запись про что, а не только "готова"/"в очереди".
const BUILD_TYPE_LABELS = {
  pos: 'Касса', guest: 'Гостевое приложение',
};
// См. purpose в handleBillingWebhook (saas/functions/index.js) —
// 'subscription' (первая оплата) и 'renewal' (автопродление).
const BILLING_PURPOSE_LABELS = {
  subscription: 'оплата тарифа', renewal: 'автопродление',
};
const AUDIT_ACTION_LABELS = {
  tenantCreated: 'Заведение создано',
  tenantSuspended: 'Заведение заблокировано',
  tenantEnabled: 'Заведение разблокировано',
  memberInvited: 'Приглашён участник',
  subscriptionPaid: 'Подписка оплачена',
  subscriptionPaymentCanceled: 'Платёж отменён',
  subscriptionRenewalFailed: 'Продление не прошло',
  subscriptionCancelRequested: 'Автопродление отключено владельцем',
  subscriptionCancelWithdrawn: 'Автопродление возобновлено владельцем',
  buildJobRequested: 'Запрошена сборка APK',
  planChangedBySuperAdmin: 'Тариф изменён супер-админом',
  bonusPeriodGranted: 'Выдан бонусный период',
};

/** Случайный пароль для аккаунта, который владелец никогда не увидит и не
 *  вводит сам (см. регистрацию в screenAuth) — сразу после создания
 *  аккаунта на почту уходит ссылка sendPasswordResetEmail, ею владелец
 *  задаёт СВОЙ пароль. crypto.getRandomValues, а не Math.random() — этот
 *  пароль хоть и временный, но реально даёт полный доступ к аккаунту до
 *  того, как придёт письмо, поэтому предсказуемым быть не должен.
 */
function genSecurePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = new Uint32Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

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
      <div class="brand">Hookah POS</div>
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
        // Момент акцепта оферты и согласия на обработку ПД фиксируется на
        // лендинге, ДО отправки письма (см. submit() в screenLanding) — сама
        // ссылка приходит уже после этого. Если флага почему-то нет (старая
        // вкладка/localStorage очищен), не блокируем вход — просто пишем
        // текущий момент, чтобы поле не осталось пустым.
        const offerAcceptedAtIso = window.localStorage.getItem('offerAcceptedAt');
        window.localStorage.removeItem('offerAcceptedAt');
        const userRef = doc(state.db, 'users', cred.user.uid);
        const existing = await getDoc(userRef);
        if (!existing.exists()) {
          await setDoc(userRef, {
            email, createdAt: Timestamp.fromDate(new Date()),
            offerAcceptedAt: Timestamp.fromDate(offerAcceptedAtIso ? new Date(offerAcceptedAtIso) : new Date()),
          });
        }
      } catch (_) {
        // Ссылка одноразовая/просрочена (или email введён не тот) —
        // раньше здесь просто молча показывался лендинг без объяснений,
        // почему вход не сработал. state.authLinkError подхватывает и
        // показывает screenLanding()/screenAuth() при первом рендере.
        state.authLinkError = 'Ссылка для входа устарела или уже была использована — запросите новую.';
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
  }, () => {
    state.isSuperAdmin = false;
    route();
  }));
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

// Публичные страницы (оферта, конфиденциальность, статус, FAQ) — доступны
// и без входа, и уже вошедшему пользователю (ссылки в подвале лендинга и
// личного кабинета), поэтому проверяются раньше ветки !state.uid.
const PUBLIC_ROUTES = {
  '#/legal/offer': () => screenLegalOffer(),
  '#/legal/privacy': () => screenLegalPrivacy(),
  '#/status': () => screenStatus(),
  '#/faq': () => screenPublicFaq(),
};

function route() {
  clearScreen();
  if (PUBLIC_ROUTES[location.hash]) {
    return PUBLIC_ROUTES[location.hash]();
  }
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
// "Hookah POS — возможности сотрудника/администратора") — сокращённо, для
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

function landingPlanCardHtml(p, selected, popular) {
  const priceText = Number(p.priceRub) > 0
    ? `${Number(p.priceRub).toLocaleString('ru-RU')} ₽/мес`
    : 'По запросу';
  const yearlyDiscountPercent = Number(p.priceRub) > 0 && Number(p.priceRubYearly) > 0
    ? Math.round((1 - Number(p.priceRubYearly) / (Number(p.priceRub) * 12)) * 100)
    : 0;
  const yearlyText = Number(p.priceRubYearly) > 0
    ? `${Number(p.priceRubYearly).toLocaleString('ru-RU')} ₽/год${yearlyDiscountPercent > 0 ? ` (−${yearlyDiscountPercent}%)` : ''}`
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
      ${popular ? '<div class="plan-badge">Популярный выбор</div>' : ''}
      <div style="font-weight:700;font-size:17px">${esc(p.name || p.id)}</div>
      <div style="font-size:22px;font-weight:700;margin:6px 0">${priceText}${yearlyText ? ` <span class="small muted" style="font-weight:400">или ${esc(yearlyText)}</span>` : ''}</div>
      <div class="small muted">${limits.join(' · ')}</div>
      ${perks.length ? `<div class="small muted" style="margin-top:4px">${esc(perks.join(' · '))}</div>` : ''}
      <div class="small" style="margin-top:6px;color:var(--primary)">${Number(p.trialDays) || 7} дней бесплатно</div>
      <button class="btn ${selected ? 'btn-primary' : 'btn-ghost'} f-landing-plan-pick" data-id="${esc(p.id)}" style="margin-top:12px">
        ${selected ? 'Тариф выбран ✓' : 'Выбрать и попробовать'}
      </button>
      ${Number(p.priceRub) > 0 ? `
        <button class="btn-link f-landing-plan-buy" data-id="${esc(p.id)}" style="margin-top:6px">
          Купить сразу, без пробного периода
        </button>
      ` : ''}
    </div>
  `;
}

function screenLanding() {
  let selectedPlanId = window.localStorage.getItem('selectedPlanId') || null;
  // Премиальная тёмно-синяя схема — только для этого публичного экрана
  // продажи подписки (см. :root в console.css и класс .landing там же).
  // Личный кабинет намеренно остаётся на своей бордовой схеме — это два
  // разных класса задач (продать подписку вообще незнакомому человеку vs
  // рабочий инструмент персонала кальянной), это не забыли поменять.
  screenEl().classList.add('landing');

  const HOW_IT_WORKS = [
    { title: 'Оставляете email', desc: 'Придёт ссылка для входа — без пароля и без банковской карты. Сразу открывается бесплатный тестовый период (срок — в карточке тарифа ниже).' },
    { title: 'Настраиваете под свой бренд', desc: 'Название, логотип и цвета приложения, меню и склад, лимиты сотрудников и устройств — 10–15 минут в личном кабинете.' },
    { title: 'Подключаете планшет и работаете', desc: 'Приложение кассы — прямо из личного кабинета. Вводите код заведения — касса, склад, брони и лояльность уже работают.' },
  ];
  const LANDING_FAQ_PREVIEW = [FAQ_ITEMS[0], FAQ_ITEMS[4], FAQ_ITEMS[5], FAQ_ITEMS[3]];

  screenEl().innerHTML = `
    <nav class="landing-nav">
      <div class="landing-inner landing-nav-inner">
        <div class="landing-logo">🔥 Hookah POS</div>
        <div class="landing-nav-links">
          <button type="button" data-scroll="landing-features">Возможности</button>
          <button type="button" data-scroll="landing-pricing">Тарифы</button>
          <button type="button" data-scroll="landing-faq">Вопросы</button>
        </div>
        <div class="landing-nav-actions">
          <a class="landing-nav-login" href="#/login">Войти</a>
          <button class="btn btn-primary" id="f-landing-nav-cta">Попробовать бесплатно</button>
        </div>
      </div>
    </nav>

    <section class="landing-section landing-hero-section">
      <div class="landing-hero-glow"></div>
      <div class="landing-inner landing-hero-grid">
        <div class="landing-hero-copy">
          <div class="hero-badge">SaaS-платформа для кальянных и лаунжей</div>
          <h1>Полная система управления кальянной — от зала до кассы</h1>
          <p class="muted landing-hero-lede">Карта зала, чеки и оплата, склад, брони и лист ожидания,
          программа лояльности, гостевое приложение и ИИ-помощники персоналу —
          всё в одной системе. Работает на обычном Android-планшете, разворачивается
          за 10–15 минут, без затрат на оборудование или IT-специалиста.</p>

          <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:6px">
            <span class="small landing-pill">⚡ Запуск за 10–15 минут</span>
            <span class="small landing-pill">🔒 Данные каждого заведения изолированы</span>
            <span class="small landing-pill">💳 Без карты — только email для теста</span>
          </div>
        </div>

        <div class="landing-hero-form-wrap">
          <div class="card landing-hero-card">
            <p id="f-landing-skip-trial-note" class="small" style="display:none;color:var(--primary);margin-bottom:10px">
              Выбрана оплата сразу, без пробного периода — после регистрации откроется страница оплаты.
            </p>
            <label class="field"><span>Email</span>
              <input id="f-landing-email" type="email" autocomplete="email" placeholder="you@example.com">
            </label>
            <label class="row" style="align-items:flex-start;gap:8px;margin-bottom:14px">
              <input type="checkbox" id="f-landing-agree">
              <span class="small muted">Принимаю условия <a href="#/legal/offer" target="_blank" rel="noopener">публичной оферты</a> и даю согласие на обработку персональных данных, в том числе на их трансграничную передачу, согласно <a href="#/legal/privacy" target="_blank" rel="noopener">политике конфиденциальности</a></span>
            </label>
            <div id="f-landing-error" class="small" style="color:var(--danger);margin-bottom:10px"></div>
            <button class="btn btn-primary" id="f-landing-start">Попробовать бесплатно</button>
            <p class="small muted" style="margin-top:8px">Пришлём ссылку для входа на почту — без пароля, ничего запоминать не нужно.</p>
          </div>

          <div class="row" style="justify-content:center;margin-top:14px">
            <button class="btn-link" id="f-landing-download-apk">⬇ Скачать приложение кассы (APK)</button>
          </div>
          <p class="small muted" style="text-align:center;margin-top:2px">Универсальная версия — при первом запуске
          попросит код заведения и код приглашения устройства из личного кабинета — или нажмите «Демо» прямо в
          приложении, и оно само создаст тестовое заведение с заполненным меню, столами и уже пробитыми чеками.</p>
          <p class="small muted landing-demo-pins" style="text-align:center;margin-top:8px">
            Вход в демо: сотрудник — PIN <code>1111</code>, администратор — PIN <code>111111</code>
          </p>
        </div>
      </div>
    </section>

    <section class="landing-section" id="landing-how">
      <div class="landing-inner">
        <h2 class="landing-h2">Как это работает</h2>
        <div class="card landing-steps">
          ${HOW_IT_WORKS.map((s, i) => `
            <div class="step-item">
              <div class="step-num">${i + 1}</div>
              <div class="grow">
                <div style="font-weight:600">${esc(s.title)}</div>
                <div class="small muted">${esc(s.desc)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </section>

    <section class="landing-section landing-section-alt" id="landing-features">
      <div class="landing-inner">
        <h2 class="landing-h2">Что умеет система</h2>
        <div class="feature-grid">
          ${LANDING_FEATURES.map((f) => `
            <div class="feature-card">
              <div class="feature-icon">${f.icon}</div>
              <div class="feature-title">${esc(f.title)}</div>
              <div class="feature-desc">${esc(f.desc)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </section>

    <section class="landing-section">
      <div class="landing-inner">
        <h2 class="landing-h2">Почему не тетрадь и Excel</h2>
        <div class="compare-grid">
          <div class="card compare-card bad">
            <div style="font-weight:700;margin-bottom:10px">❌ Как обычно бывает</div>
            <div class="small" style="padding:6px 0;border-bottom:1px solid var(--border)">Чек и скидка считаются на калькуляторе — время и ошибки</div>
            <div class="small" style="padding:6px 0;border-bottom:1px solid var(--border)">Остатки склада — в отдельной таблице, обновляется, когда вспомнят</div>
            <div class="small" style="padding:6px 0;border-bottom:1px solid var(--border)">Брони — в блокноте или переписке, иногда теряются</div>
            <div class="small" style="padding:6px 0">Отчёт по смене — вручную, полчаса и дольше</div>
          </div>
          <div class="card compare-card good">
            <div style="font-weight:700;margin-bottom:10px">✅ С Hookah POS</div>
            <div class="small" style="padding:6px 0;border-bottom:1px solid var(--border)">Касса сама считает чек, скидки и бонусы применяются автоматически</div>
            <div class="small" style="padding:6px 0;border-bottom:1px solid var(--border)">Склад обновляется при каждой продаже, инвентаризация — с историей расхождений</div>
            <div class="small" style="padding:6px 0;border-bottom:1px solid var(--border)">Брони из гостевого приложения сразу попадают в общий календарь зала</div>
            <div class="small" style="padding:6px 0">X-отчёт по смене — один клик, без ручного подсчёта</div>
          </div>
        </div>
      </div>
    </section>

    <section class="landing-section landing-section-alt" id="landing-pricing">
      <div class="landing-inner">
        <h2 class="landing-h2">Тарифы</h2>
        <p class="landing-h2-sub">Бесплатный тестовый период на любом тарифе — банковская карта не нужна, чтобы попробовать.</p>
        <div id="landing-plans" class="landing-plans-grid"><div class="spinner"></div></div>
      </div>
    </section>

    <section class="landing-section" id="landing-calc">
      <div class="landing-inner">
        <h2 class="landing-h2">Калькулятор окупаемости</h2>
        <div class="card">
          <label class="field"><span>Средняя выручка заведения в месяц, ₽</span>
            <input id="f-calc-revenue" type="number" inputmode="numeric" min="0" placeholder="500000">
          </label>
          <label class="field"><span>Тариф</span>
            <select id="f-calc-plan"><option value="">Загрузка тарифов…</option></select>
          </label>
          <label class="field"><span>Ваша оценка потерь от ручного учёта, пересортицы и ошибок на кассе, %</span>
            <input id="f-calc-loss" type="number" value="3" min="0" max="30" step="0.5">
          </label>
          <div class="small muted">Считаем строго по цифрам, которые вы укажете сами, — без наших предположений о «типичной» экономии.</div>
          <div id="f-calc-output" style="margin-top:14px"></div>
        </div>
      </div>
    </section>

    <section class="landing-section landing-section-alt">
      <div class="landing-inner">
        <h2 class="landing-h2">Безопасность и соответствие</h2>
        <div class="card">
          <div class="small" style="padding:7px 0;border-bottom:1px solid var(--border)">🔒 У каждого заведения отдельная изолированная база данных — доступ к чужим данным технически невозможен</div>
          <div class="small" style="padding:7px 0;border-bottom:1px solid var(--border)">🧾 Фискализация чеков (54-ФЗ) — не «из коробки»: нужна своя онлайн-касса с договорами провайдера кассы и ОФД, регистрация ККТ в ФНС; эквайринг — отдельный договор с банком-эквайером. Приложение поддерживает подключение готовых протоколов, но не заменяет эти договоры</div>
          <div class="small" style="padding:7px 0">☁️ Инфраструктура — Google Firebase, статус в реальном времени — на <a href="#/status">странице статуса</a></div>
        </div>
      </div>
    </section>

    <section class="landing-section" id="landing-faq">
      <div class="landing-inner">
        <h2 class="landing-h2">Частые вопросы</h2>
        <div class="card">
          ${LANDING_FAQ_PREVIEW.map((item, i) => `
            <div class="faq-item" data-faq="preview-${i}">
              <div class="faq-question"><span>${esc(item.q)}</span><span class="faq-toggle">+</span></div>
              <div class="faq-answer">${esc(item.a)}</div>
            </div>
          `).join('')}
        </div>
        <p class="small center muted"><a href="#/faq">Смотреть все вопросы →</a></p>
      </div>
    </section>

    <section class="landing-section landing-cta-band">
      <div class="landing-inner landing-cta-inner">
        <h3>Готовы попробовать?</h3>
        <p>Бесплатный доступ по email, без карты — уже сегодня.</p>
        <button class="btn" id="f-landing-cta-bottom">Оставить заявку</button>
      </div>
    </section>

    <footer class="landing-section landing-footer">
      <div class="landing-inner">
        <p class="small center muted">
          Уже есть аккаунт? <a href="#/login">Войти по паролю</a>
        </p>
        ${publicFooterLinksHtml()}
        ${versionFooterHtml()}
      </div>
    </footer>

    <div class="sticky-cta" id="landing-sticky">
      <button class="btn btn-primary" id="f-landing-sticky-btn">Попробовать бесплатно →</button>
    </div>
  `;

  document.querySelectorAll('.landing-nav-links [data-scroll]').forEach((el) => {
    el.onclick = () => document.getElementById(el.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Ссылка входа была просрочена/уже использована (см. boot()) — показываем
  // один раз прямо на лендинге, а не молчим о том, почему вход не сработал.
  if (state.authLinkError) {
    const el = $('f-landing-error');
    if (el) el.textContent = state.authLinkError;
    state.authLinkError = null;
  }

  const submit = async () => {
    const email = $('f-landing-email').value.trim();
    const errEl = $('f-landing-error');
    errEl.textContent = '';
    if (!email) { errEl.textContent = 'Введите email'; return; }
    if (!$('f-landing-agree')?.checked) { errEl.textContent = 'Нужно принять условия оферты и согласие на обработку персональных данных'; return; }
    $('f-landing-start').disabled = true;
    try {
      await sendSignInLinkToEmail(state.auth, email, {
        url: `${location.origin}${location.pathname}#/`,
        handleCodeInApp: true,
      });
      window.localStorage.setItem('emailForSignIn', email);
      window.localStorage.setItem('offerAcceptedAt', new Date().toISOString());
      if (selectedPlanId) window.localStorage.setItem('selectedPlanId', selectedPlanId);
      screenEl().innerHTML = `
        <div class="brand">Hookah POS</div>
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
  if ($('f-landing-download-apk')) $('f-landing-download-apk').onclick = downloadPublicApk;

  const scrollToEmail = () => {
    $('f-landing-email')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('f-landing-email')?.focus();
  };
  if ($('f-landing-cta-bottom')) $('f-landing-cta-bottom').onclick = scrollToEmail;
  if ($('f-landing-sticky-btn')) $('f-landing-sticky-btn').onclick = scrollToEmail;
  if ($('f-landing-nav-cta')) $('f-landing-nav-cta').onclick = scrollToEmail;

  document.querySelectorAll('.faq-item').forEach((el) => {
    el.querySelector('.faq-question')?.addEventListener('click', () => el.classList.toggle('open'));
  });

  // Липкая кнопка снизу появляется, как только форма email вверху уходит
  // за пределы экрана — на длинной странице решение "попробовать" всегда
  // должно быть в одно касание, а не пролистывание обратно наверх.
  const onLandingScroll = () => {
    const heroCard = $('f-landing-email');
    if (!heroCard) return;
    $('landing-sticky')?.classList.toggle('show', heroCard.getBoundingClientRect().bottom < 0);
  };
  window.addEventListener('scroll', onLandingScroll, { passive: true });
  sub(() => window.removeEventListener('scroll', onLandingScroll));

  sub(onSnapshot(collection(state.db, 'plans'), (snap) => {
    const plans = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (Number(a.priceRub) || 0) - (Number(b.priceRub) || 0));
    const body = $('landing-plans');
    if (!body) return;
    // "Популярный" — средний по цене из реально продаваемых тарифов (не
    // "по запросу"), классическая подсказка "бери этот", если есть из чего
    // выбирать — не сама дорогая (звучит навязчиво) и не самая дешёвая
    // (выглядит как самая слабая уценка).
    const sellable = plans.filter((p) => Number(p.priceRub) > 0);
    const popularId = sellable.length >= 3 ? sellable[1].id : null;
    body.innerHTML = plans.length
      ? plans.map((p) => landingPlanCardHtml(p, p.id === selectedPlanId, p.id === popularId)).join('')
      : '<p class="small muted">Тарифы скоро появятся.</p>';
    const updateSkipTrialNote = () => {
      const note = $('f-landing-skip-trial-note');
      if (note) note.style.display = window.localStorage.getItem('skipTrial') === '1' ? 'block' : 'none';
    };
    document.querySelectorAll('.f-landing-plan-pick').forEach((el) => {
      el.onclick = () => {
        selectedPlanId = el.dataset.id;
        window.localStorage.setItem('selectedPlanId', selectedPlanId);
        // Обычный путь — через пробный период, а не сразу оплата: если до
        // этого выбирали "Купить сразу" на другом тарифе, сбрасываем флаг,
        // иначе после регистрации владельца неожиданно перекинуло бы на
        // оплату тарифа, который он уже передумал покупать напрямую.
        window.localStorage.removeItem('skipTrial');
        document.querySelectorAll('.f-landing-plan-pick').forEach((btn) => {
          const isSel = btn.dataset.id === selectedPlanId;
          btn.textContent = isSel ? 'Тариф выбран ✓' : 'Выбрать и попробовать';
          btn.className = `btn ${isSel ? 'btn-primary' : 'btn-ghost'} f-landing-plan-pick`;
          btn.closest('.card').style.borderColor = isSel ? 'var(--primary)' : '';
        });
        updateSkipTrialNote();
        $('f-landing-email')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
    });
    document.querySelectorAll('.f-landing-plan-buy').forEach((el) => {
      el.onclick = () => {
        selectedPlanId = el.dataset.id;
        window.localStorage.setItem('selectedPlanId', selectedPlanId);
        window.localStorage.setItem('skipTrial', '1');
        document.querySelectorAll('.f-landing-plan-pick').forEach((btn) => {
          const isSel = btn.dataset.id === selectedPlanId;
          btn.textContent = isSel ? 'Тариф выбран ✓' : 'Выбрать и попробовать';
          btn.className = `btn ${isSel ? 'btn-primary' : 'btn-ghost'} f-landing-plan-pick`;
          btn.closest('.card').style.borderColor = isSel ? 'var(--primary)' : '';
        });
        updateSkipTrialNote();
        $('f-landing-email')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
    });
    updateSkipTrialNote();

    const calcPlanSelect = $('f-calc-plan');
    if (calcPlanSelect) {
      calcPlanSelect.innerHTML = sellable.length
        ? sellable.map((p) => `<option value="${Number(p.priceRub) || 0}">${esc(p.name || p.id)} — ${(Number(p.priceRub) || 0).toLocaleString('ru-RU')} ₽/мес</option>`).join('')
        : '<option value="">Тарифы скоро появятся</option>';
    }
    const runCalc = () => {
      const out = $('f-calc-output');
      if (!out) return;
      const revenue = Number($('f-calc-revenue')?.value) || 0;
      const lossPercent = Number($('f-calc-loss')?.value) || 0;
      const planPrice = Number($('f-calc-plan')?.value) || 0;
      const monthlySavings = revenue * (lossPercent / 100);
      if (revenue <= 0 || planPrice <= 0) {
        out.innerHTML = '<p class="small muted">Укажите выручку и тариф — покажем расчёт.</p>';
        return;
      }
      const daysToPayback = monthlySavings > 0 ? (planPrice / monthlySavings) * 30 : Infinity;
      const paybackText = !isFinite(daysToPayback)
        ? '—'
        : daysToPayback <= 30
          ? `${Math.max(1, Math.round(daysToPayback))} дн.`
          : `${(daysToPayback / 30).toFixed(1)} мес.`;
      out.innerHTML = `
        <div class="calc-result">${paybackText}</div>
        <div class="small muted">окупаемость тарифа при экономии ${Math.round(monthlySavings).toLocaleString('ru-RU')} ₽/мес</div>
        <div class="small muted" style="margin-top:10px">Это ориентировочный расчёт по введённым вами цифрам, а не гарантия конкретной экономии.</div>
      `;
    };
    ['f-calc-revenue', 'f-calc-loss', 'f-calc-plan'].forEach((id) => {
      $(id)?.addEventListener('input', runCalc);
      $(id)?.addEventListener('change', runCalc);
    });
    runCalc();
  }, () => {
    const body = $('landing-plans');
    if (body) body.innerHTML = '<p class="small muted">Тарифы недоступны.</p>';
  }));
}

// ---------- ПУБЛИЧНЫЕ СТРАНИЦЫ (оферта, конфиденциальность, статус, FAQ) ----------
// Доступны по прямой ссылке и без входа — см. PUBLIC_ROUTES выше.

function publicFooterLinksHtml() {
  return `
    <p class="small center muted" style="margin-top:14px">
      <a href="#/legal/offer">Оферта</a> ·
      <a href="#/legal/privacy">Конфиденциальность</a> ·
      <a href="#/status">Статус</a> ·
      <a href="#/faq">FAQ</a>
    </p>
  `;
}

function publicPageWrapHtml(title, bodyHtml) {
  return `
    <div class="brand">Hookah POS</div>
    <h1>${esc(title)}</h1>
    ${bodyHtml}
    <p class="small center muted" style="margin-top:24px"><a href="#/">← На главную</a></p>
    ${publicFooterLinksHtml()}
    ${versionFooterHtml()}
  `;
}

function screenLegalOffer() {
  screenEl().innerHTML = publicPageWrapHtml('Публичная оферта', `
    <p class="small muted" style="padding:10px 12px;background:var(--surface-2);border-radius:10px;border:1px solid var(--border)">
      Документ подготовлен по структуре, принятой для российских SaaS-сервисов
      (ст. 437 ГК РФ), и рассчитан на Исполнителя в форме индивидуального
      предпринимателя (ИП). Это заготовка, не консультация практикующего
      юриста — перед началом реального приёма платежей документ всё равно
      стоит показать юристу. Чтобы опубликовать прямо сейчас, нужно: (1)
      зарегистрировать ИП в ФНС, если это ещё не сделано, и вписать реквизиты
      в раздел 13; (2) сверить раздел 11 (место разрешения споров) и
      применимость Закона РФ «О защите прав потребителей» к вашей категории
      заказчиков — юрист может уточнить эти формулировки под вашу конкретную
      ситуацию.
    </p>
    <div class="card">
      <h2 style="margin-top:0">1. Термины и определения</h2>
      <p class="small muted"><b>Исполнитель</b> — индивидуальный предприниматель, владелец и оператор Платформы (реквизиты — раздел 13). <b>Платформа</b> — программный комплекс Hookah POS, доступ к которому предоставляется через личный кабинет. <b>Заказчик</b> — лицо, акцептовавшее оферту в порядке раздела 2. <b>Тариф</b> — условия использования Платформы (лимиты, функции, стоимость), опубликованные в разделе «Тарифы» личного кабинета. <b>Заведение</b> — учётная единица Платформы (кальянная/лаунж/бар), созданная Заказчиком.</p>
      <h2>2. Акцепт оферты</h2>
      <p class="small muted">Акцептом является регистрация личного кабинета с проставлением отметки «Принимаю условия публичной оферты и даю согласие на обработку персональных данных» и/или создание Заведения в личном кабинете. Договор считается заключённым с момента акцепта и действует до расторжения в порядке раздела 9. Лицо, не согласное с условиями, обязано прекратить использование Платформы и не проходить регистрацию.</p>
      <h2>3. Предмет договора</h2>
      <p class="small muted">Исполнитель предоставляет Заказчику простую (неисключительную) лицензию на использование Платформы в объёме, предусмотренном выбранным Тарифом, по модели SaaS — без передачи экземпляра программы и без права модификации, декомпиляции или создания производных продуктов. Заказчик обязуется оплачивать доступ в порядке раздела 5. Перечень функций (карта зала, учёт заказов и оплат, склад, брони, программа лояльности, гостевое приложение, аналитика) определяется Тарифом и может расширяться Исполнителем без уменьшения объёма уже оплаченных функций текущего периода.</p>
    </div>
    <div class="card">
      <h2 style="margin-top:0">4. Пробный период</h2>
      <p class="small muted">При первой регистрации Заведения предоставляется бесплатный пробный период; длительность определяется выбранным Тарифом и указана на его карточке на момент регистрации. Банковская карта или иные платёжные реквизиты для начала пробного периода не требуются, оплата не списывается. По окончании пробного периода доступ приостанавливается до внесения оплаты. Исполнитель вправе ограничить предоставление повторного пробного периода одному и тому же лицу или Заведению.</p>
      <h2>5. Стоимость и порядок оплаты</h2>
      <p class="small muted">Стоимость определяется выбранным Тарифом и указывается в рублях РФ. Оплата — помесячно либо годовым платежом вперёд (по ставке, указанной в карточке Тарифа). Оплата проходит через платёжного провайдера, интегрированного в личный кабинет; Исполнитель не хранит полные реквизиты банковских карт Заказчика. При просрочке оплаты доступ (включая кассовое приложение на всех устройствах Заведения) блокируется автоматически; данные Заведения сохраняются 10 календарных дней («грейс-период») — при оплате в этот срок доступ восстанавливается полностью, по истечении срока данные удаляются безвозвратно. Исполнитель вправе изменять Тарифы и их стоимость, уведомив действующих Заказчиков не менее чем за 30 календарных дней; изменение не применяется к уже оплаченному периоду. Заказчик вправе в любой момент сменить Тариф в личном кабинете.</p>
    </div>
    <div class="card">
      <h2 style="margin-top:0">6. Права и обязанности сторон</h2>
      <p class="small muted">Исполнитель обязуется обеспечивать техническую работоспособность Платформы в соответствии с уровнем доступности используемой облачной инфраструктуры, информировать о плановых работах и оказывать техническую поддержку в объёме Тарифа. Заказчик обязуется использовать Платформу по назначению и в соответствии с применимым законодательством РФ (включая законодательство о ККТ и о персональных данных), не передавать доступ к личному кабинету третьим лицам в обход штатного функционала приглашения сотрудников, самостоятельно обеспечивать легальность приёма платежей от гостей (см. п. 8.3).</p>
      <h2>7. Интеллектуальная собственность</h2>
      <p class="small muted">Исключительные права на программное обеспечение Платформы, исходный код, интерфейс и товарный знак Hookah POS принадлежат Исполнителю и не передаются Заказчику ни в каком объёме, кроме права использования по простой лицензии (раздел 3). Все данные, вносимые Заказчиком и его сотрудниками (сведения о заведении, меню, складе, гостях, продажах), принадлежат Заказчику — Исполнитель не приобретает на них прав, кроме права обработки в целях исполнения договора. Логотип и цвета, загруженные в разделе «Брендинг», используются только для формирования персонализированного кассового приложения Заказчика.</p>
    </div>
    <div class="card">
      <h2 style="margin-top:0">8. Ограничение ответственности</h2>
      <p class="small muted">Платформа предоставляется «как есть» (as is). Исполнитель не гарантирует бесперебойную работу, если это обусловлено сбоями инфраструктуры сторонних облачных провайдеров (см. страницу «Статус»). Совокупная ответственность Исполнителя ограничена суммой, фактически уплаченной Заказчиком за 3 последних расчётных периода, предшествующих событию.</p>
      <p class="small muted">Исполнитель не осуществляет фискализацию чеков и эквайринг и не несёт ответственности за соблюдение Заказчиком 54-ФЗ. Для фискализации Заказчику необходимо самостоятельно: подключить сертифицированную ККТ (свою или облачную), заключить договоры с провайдером кассы и с оператором фискальных данных (ОФД), зарегистрировать ККТ в ФНС. Для приёма карт — отдельный договор эквайринга с банком или платёжным агрегатором. Платформа поддерживает техническое подключение готовых протоколов (раздел «Настройки → Интеграции»), но не заменяет эти договоры. Исполнитель не отвечает за косвенные убытки и упущенную выгоду Заказчика.</p>
      <h2>9. Форс-мажор</h2>
      <p class="small muted">Стороны освобождаются от ответственности за неисполнение обязательств, если оно вызвано обстоятельствами непреодолимой силы: стихийными бедствиями, действиями органов власти, военными действиями, глобальными сбоями сети Интернет или инфраструктуры облачных провайдеров, не зависящими от воли сторон.</p>
    </div>
    <div class="card">
      <h2 style="margin-top:0">10. Срок действия, изменение и расторжение</h2>
      <p class="small muted">Договор действует с момента акцепта до расторжения любой из сторон. Заказчик вправе расторгнуть договор в любой момент, прекратив оплату очередного периода; ранее уплаченные суммы за неиспользованный период не возвращаются, если иное не оговорено отдельно. Исполнитель вправе приостановить или прекратить доступ при существенном нарушении Заказчиком условий оферты, уведомив об этом. Исполнитель вправе менять текст оферты в одностороннем порядке — актуальная редакция всегда доступна на этой странице; продолжение использования Платформы после вступления изменений в силу означает согласие с новой редакцией.</p>
      <h2>11. Порядок разрешения споров</h2>
      <p class="small muted">До обращения в суд Заказчик направляет Исполнителю письменную претензию; срок рассмотрения — 30 календарных дней. При недостижении согласия спор разрешается в суде по месту нахождения Исполнителя, если иное не предусмотрено императивными нормами законодательства о защите прав потребителей.</p>
      <h2>12. Прочие условия</h2>
      <p class="small muted">Во всём, что не урегулировано настоящей офертой, стороны руководствуются законодательством РФ. Обработка персональных данных, передаваемых в рамках использования Платформы, осуществляется в соответствии с Политикой конфиденциальности, являющейся неотъемлемой частью договора.</p>
      <h2>13. Реквизиты Исполнителя</h2>
      <p class="small muted">Индивидуальный предприниматель [ФИО полностью]. ОГРНИП: [указать]. ИНН: [указать]. Адрес места жительства/для корреспонденции: [указать]. Банковские реквизиты: р/с [указать], банк [указать], БИК [указать], к/с [указать]. Контактный email для претензий: [указать]. <i>(Поля — на замену перед публикацией; после регистрации ИП в ФНС впишите сюда настоящие данные.)</i></p>
    </div>
  `);
}

function screenLegalPrivacy() {
  screenEl().innerHTML = publicPageWrapHtml('Политика обработки персональных данных', `
    <p class="small muted" style="padding:10px 12px;background:var(--surface-2);border-radius:10px;border:1px solid var(--border)">
      Документ подготовлен по структуре, требуемой ст. 18.1 152-ФЗ «О персональных
      данных», и рассчитан на Оператора в форме индивидуального предпринимателя
      (ИП). Это заготовка, не консультация юриста — перед реальной публикацией
      его должен проверить юрист, включая раздел 7 ниже: явное согласие на
      трансграничную передачу теперь запрашивается при регистрации, но
      требование о локализации первичного хранения данных (ст. 18 ч. 5 152-ФЗ)
      этим НЕ снимается и остаётся открытым архитектурным вопросом. Чтобы
      опубликовать прямо сейчас, нужно: (1) вписать реквизиты ИП в раздел 12;
      (2) подать уведомление об обработке персональных данных в Роскомнадзор
      через <a href="https://pd.rkn.gov.ru" target="_blank" rel="noopener">pd.rkn.gov.ru</a>
      — для операторов, обрабатывающих данные с использованием автоматизации
      не в рамках только трудовых отношений с собственными сотрудниками, это
      обязательно (узкий перечень исключений — ст. 22 ч. 2 152-ФЗ, и Платформа,
      судя по составу обрабатываемых данных, под них не подпадает); присвоенный
      по итогам рассмотрения номер — вписать в раздел 12.
    </p>
    <div class="card">
      <h2 style="margin-top:0">1. Общие положения</h2>
      <p class="small muted">Оператором персональных данных является Исполнитель — индивидуальный предприниматель, владелец Платформы Hookah POS (реквизиты и номер в реестре Роскомнадзора — раздел 12). Использование Платформы означает согласие субъекта персональных данных с условиями настоящей Политики.</p>
      <h2>2. Категории субъектов персональных данных</h2>
      <p class="small muted">Владелец и сотрудники Заведения, зарегистрировавшие личный кабинет; гости Заведения, чьи данные вносятся персоналом (программа лояльности, бронирование) либо предоставляются гостем самостоятельно через гостевое приложение. В отношении данных гостей Заведения оператором персональных данных является непосредственно владелец Заведения как самостоятельный субъект по 152-ФЗ; Исполнитель Платформы в этой части выступает лицом, осуществляющим обработку по поручению оператора (ст. 6 ч. 3 152-ФЗ) на основании договора-оферты.</p>
      <h2>3. Состав обрабатываемых данных</h2>
      <p class="small muted">Владельца и сотрудников: email, ФИО (при указании), роль в Заведении, история действий в личном кабинете. Гостей Заведения: имя, телефон и/или email (при участии в программе лояльности или бронировании), история заказов и посещений — в объёме, который вносит персонал. Специальные категории персональных данных (о здоровье, религиозных и политических взглядах и т.п.) Платформой не собираются.</p>
    </div>
    <div class="card">
      <h2 style="margin-top:0">4. Цели обработки</h2>
      <p class="small muted">Обеспечение доступа к личному кабинету и функциональности Платформы; расчёты по договору; техническая и клиентская поддержка; ведение программы лояльности, бронирования и учёта заказов Заведения — в интересах владельца Заведения как самостоятельного оператора данных своих гостей; уведомления, связанные с работой сервиса (не рекламные рассылки без отдельного согласия).</p>
      <h2>5. Правовые основания обработки</h2>
      <p class="small muted">Согласие субъекта персональных данных (акцепт настоящей Политики при регистрации), необходимость исполнения договора, стороной которого является субъект или в пользу которого он заключён, иные основания по ст. 6 152-ФЗ.</p>
      <h2>6. Порядок и условия обработки</h2>
      <p class="small muted">Обработка включает сбор, запись, систематизацию, накопление, хранение, уточнение, использование, передачу, блокирование, удаление и уничтожение — как автоматизированно, так и без средств автоматизации. Доступ к данным Заведения имеют: сотрудники этого Заведения — в пределах своей роли, настроенной в личном кабинете; администрация Платформы — в объёме, необходимом для техподдержки, как правило по обращению владельца Заведения. Данные разных Заведений технически изолированы — доступ к чужим данным технически невозможен, что проверяется автоматизированными тестами правил доступа к базе данных.</p>
    </div>
    <div class="card" style="border-color:var(--warning)">
      <h2 style="margin-top:0">7. Трансграничная передача и место обработки данных</h2>
      <p class="small muted">Инфраструктура Платформы размещена на облачной платформе Google Firebase / Google Cloud, регионы размещения которой находятся за пределами РФ. Трансграничная передача персональных данных на эту инфраструктуру осуществляется на основании отдельного явного согласия субъекта персональных данных, которое запрашивается при регистрации личного кабинета отдельной формулировкой (ст. 12 152-ФЗ): «даю согласие на обработку персональных данных, в том числе на их трансграничную передачу».</p>
      <p class="small muted"><b>Это согласие закрывает только требование о трансграничной передаче (ст. 12) и не подменяет собой отдельное, более строгое требование о локализации (ст. 18 ч. 5 152-ФЗ):</b> запись, систематизация, накопление, хранение, уточнение и извлечение персональных данных граждан РФ должны первично вестись с использованием баз данных, физически находящихся на территории РФ. Согласие субъекта эту обязанность с Оператора не снимает — она императивна и не может быть заменена договорным условием. Дополнительное резервное копирование или зеркалирование данных (в том числе в зашифрованном виде) на инфраструктуру в РФ при сохранении первичной записи за рубежом это требование также не удовлетворяет — значение имеет место именно первичной записи данных, а не наличие последующей копии.</p>
      <p class="small muted">На момент публикации настоящей редакции первичное хранение данных на инфраструктуре, физически расположенной в РФ, не организовано; согласие на трансграничную передачу применяется как временная мера, снижающая, но не устраняющая юридический риск. Ответственность за нарушение требования локализации (ч. 8 ст. 13.11 КоАП РФ) — для юридического лица от 1 до 6 млн ₽ за первое нарушение и от 6 до 18 млн ₽ за повторное. Перевод основного хранения персональных данных граждан РФ на инфраструктуру, расположенную на территории РФ, остаётся отдельной задачей Оператора и предметом решения совместно с юристом и с учётом технической архитектуры Платформы.</p>
    </div>
    <div class="card">
      <h2 style="margin-top:0">8. Права субъекта персональных данных</h2>
      <p class="small muted">В соответствии со ст. 14 152-ФЗ субъект вправе: получать информацию об обработке своих персональных данных; требовать уточнения, блокирования или уничтожения данных, если они неполны, устарели, неточны, незаконно получены или не нужны для заявленной цели; отозвать согласие на обработку; обжаловать действия или бездействие Оператора в Роскомнадзор или в суд. Для реализации этих прав: в отношении своих данных как пользователя личного кабинета — обращение в поддержку Платформы; в отношении данных гостя Заведения — обращение непосредственно к владельцу соответствующего Заведения.</p>
      <h2>9. Срок обработки и уничтожение данных</h2>
      <p class="small muted">Данные обрабатываются в течение всего срока действия подписки и хранятся дополнительно 10 календарных дней после прекращения оплаты («грейс-период»). По истечении срока данные удаляются безвозвратно средствами автоматизации без возможности восстановления. Субъект вправе потребовать досрочного удаления своих данных, обратившись в поддержку (для данных владельца/сотрудников) либо к владельцу Заведения (для данных гостя).</p>
      <h2>10. Меры по обеспечению безопасности</h2>
      <p class="small muted">Разграничение прав доступа на основе ролей; шифрование соединения (HTTPS/TLS) при передаче данных; автоматизированное тестирование правил изоляции данных между Заведениями; ограничение доступа персонала Платформы к данным Заказчиков.</p>
    </div>
    <div class="card">
      <h2 style="margin-top:0">11. Заключительные положения</h2>
      <p class="small muted">Оператор вправе вносить изменения в настоящую Политику — актуальная редакция всегда доступна на этой странице.</p>
      <h2>12. Реквизиты и контакты</h2>
      <p class="small muted">Индивидуальный предприниматель [ФИО полностью]. ОГРНИП: [указать]. ИНН: [указать]. Адрес: [указать]. Номер в реестре операторов персональных данных Роскомнадзора: [указать после рассмотрения уведомления на pd.rkn.gov.ru]. Email для обращений по вопросам персональных данных: [указать]. <i>(Поля — на замену перед публикацией.)</i></p>
    </div>
  `);
}

function screenStatus() {
  screenEl().innerHTML = publicPageWrapHtml('Статус системы', `
    <div class="card">
      <div class="row" style="align-items:center;gap:10px">
        <div style="width:10px;height:10px;border-radius:50%;background:#3DD68C;flex:none"></div>
        <div class="small">Платформа работает на инфраструктуре Google Firebase (Firestore, Auth, Hosting, Cloud Functions)</div>
      </div>
      <p class="small muted" style="margin-top:12px">Отдельный мониторинг аптайма поверх инфраструктуры провайдера мы не ведём — актуальный статус самого Firebase (по всем используемым сервисам) смотрите на официальной странице:</p>
      <a class="btn btn-ghost" href="https://status.firebase.google.com/" target="_blank" rel="noopener">Открыть status.firebase.google.com ↗</a>
    </div>
    <div class="card">
      <div class="small muted">Если Firebase работает штатно, а вход в консоль или касса не открывается — это, скорее всего, проблема на нашей стороне. Опишите это в поддержке, указав код заведения и время сбоя.</div>
    </div>
  `);
}

function screenPublicFaq() {
  screenEl().innerHTML = publicPageWrapHtml('Частые вопросы', `
    <div class="card">
      ${FAQ_ITEMS.map((item, i) => `
        <div class="faq-item" data-faq="${i}">
          <div class="faq-question"><span>${esc(item.q)}</span><span class="faq-toggle">+</span></div>
          <div class="faq-answer">${esc(item.a)}</div>
        </div>
      `).join('')}
    </div>
  `);
  document.querySelectorAll('.faq-item').forEach((el) => {
    el.querySelector('.faq-question')?.addEventListener('click', () => el.classList.toggle('open'));
  });
}

// ---------- ВХОД / РЕГИСТРАЦИЯ ----------

let authMode = 'login'; // 'login' | 'signup' — держим отдельно от state: это выбор экрана, а не данные аккаунта.

function screenAuth() {
  screenEl().innerHTML = `
    <div class="brand">Hookah POS</div>
    <h1>${authMode === 'login' ? 'Вход в консоль' : 'Регистрация владельца'}</h1>
    <p class="muted">Личный кабинет владельца заведения: подписка, код
    приглашения устройств, фирменный цвет приложения кассы.</p>
    <div class="card">
      <label class="field"><span>Email</span>
        <input id="f-email" type="email" autocomplete="email" placeholder="you@example.com">
      </label>
      ${authMode === 'login' ? `
        <label class="field"><span>Пароль</span>
          <input id="f-pass" type="password" autocomplete="current-password" placeholder="Минимум 6 символов">
        </label>
        <p class="small center muted" style="margin:-6px 0 14px"><a href="#" id="f-forgot">Забыли пароль?</a></p>
      ` : `
        <p class="small muted" style="margin-bottom:14px">Пароль придумывать не
        нужно — сразу после регистрации пришлём на почту ссылку, чтобы задать
        свой (и вторым письмом — ссылку для подтверждения самого email).</p>
      `}
      ${authMode === 'signup' ? `
        <label class="row" style="align-items:flex-start;gap:8px;margin-bottom:14px">
          <input type="checkbox" id="f-agree">
          <span class="small muted">Принимаю условия <a href="#/legal/offer" target="_blank" rel="noopener">публичной оферты</a> и даю согласие на обработку персональных данных, в том числе на их трансграничную передачу, согласно <a href="#/legal/privacy" target="_blank" rel="noopener">политике конфиденциальности</a></span>
        </label>
      ` : ''}
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

  if ($('f-forgot')) {
    $('f-forgot').onclick = async (e) => {
      e.preventDefault();
      const email = $('f-email').value.trim();
      const errEl = $('f-error');
      errEl.style.color = 'var(--danger)';
      errEl.textContent = '';
      if (!email) {
        errEl.textContent = 'Сначала введите свой email выше';
        return;
      }
      try {
        await sendPasswordResetEmail(state.auth, email);
        errEl.style.color = 'var(--primary)';
        errEl.textContent = `Письмо со ссылкой для сброса пароля отправлено на ${email}`;
      } catch (e2) {
        errEl.textContent = authErrorMessage(e2);
      }
    };
  }

  const submit = async () => {
    const email = $('f-email').value.trim();
    const pass = authMode === 'login' ? $('f-pass').value : genSecurePassword();
    const errEl = $('f-error');
    errEl.style.color = 'var(--danger)';
    errEl.textContent = '';
    if (!email || (authMode === 'login' && !pass)) {
      errEl.textContent = authMode === 'login' ? 'Заполните email и пароль' : 'Введите email';
      return;
    }
    if (authMode === 'signup' && !$('f-agree')?.checked) {
      errEl.textContent = 'Нужно принять условия оферты и согласие на обработку персональных данных';
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
          offerAcceptedAt: Timestamp.fromDate(new Date()),
        }, { merge: true });
        // Письмо с подтверждением — до него владелец не может создать
        // заведение (см. screenOnboarding и createTenant на сервере), это
        // и есть защита от регистрации на случайный/чужой email.
        try { await sendEmailVerification(cred.user); } catch (_) {}
        // Пароль сгенерирован выше и нигде не показывается — второе письмо
        // (та же механика, что и "Забыли пароль?" выше) даёт владельцу
        // способ задать СВОЙ пароль, которым он потом сможет входить.
        try { await sendPasswordResetEmail(state.auth, email); } catch (_) {}
      }
      // Дальше подхватит onAuthStateChanged — свой экран он покажет сам
      // (screenVerifyEmail расскажет и про письмо для пароля тоже).
    } catch (e) {
      errEl.textContent = authErrorMessage(e);
      $('f-submit').disabled = false;
    }
  };
  $('f-submit').onclick = submit;
  if ($('f-pass')) $('f-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function screenLoading() {
  screenEl().innerHTML = `<div class="brand">Hookah POS</div><div class="spinner"></div>`;
}

// ---------- ПОДТВЕРЖДЕНИЕ ПОЧТЫ ----------

function screenVerifyEmail() {
  const email = state.auth.currentUser?.email || '';
  screenEl().innerHTML = `
    <div class="brand">Hookah POS</div>
    <h1>Подтвердите почту</h1>
    <p class="muted">Мы отправили письмо со ссылкой на <b>${esc(email)}</b>.
    Перейдите по ней, потом вернитесь сюда и нажмите «Проверить» —
    создание заведения открывается только после этого. Если регистрировались
    только что — придёт и второе письмо, со ссылкой, чтобы задать пароль для
    входа (пароль при регистрации не спрашивали специально).</p>
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
      <div class="brand">Hookah POS</div>
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
      // Если владелец пришёл с лендинга, выбрав конкретный тариф — заводим
      // заведение сразу на нём (пробный период всё равно бесплатный 14
      // дней, planId лишь определяет, какие лимиты/тариф ждут ПОСЛЕ триала).
      const chosenPlanId = window.localStorage.getItem('selectedPlanId');
      // "Купить сразу" на лендинге (см. f-landing-plan-buy) — тенант всё
      // равно заводится обычным путём (createTenant не умеет "сразу
      // платно", да это и не нужно: ниже сразу открываем оплату, до того
      // как владелец увидит личный кабинет, а после реальной оплаты
      // handleBillingWebhook переведёт статус в active — пробный период
      // просто никогда не будет использован).
      const skipTrial = window.localStorage.getItem('skipTrial') === '1';
      // createTenant — не Cloud Function (Blaze для неё сейчас недоступен),
      // а свой сервис, см. callSaasGateway/SAAS_GATEWAY_URL выше.
      const res = await callSaasGateway(
        'createTenant',
        chosenPlanId ? { name, slug, planId: chosenPlanId } : { name, slug }
      );
      window.localStorage.removeItem('selectedPlanId');
      window.localStorage.removeItem('skipTrial');
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
      // "Купить сразу" — уводим на оплату ДО того, как отрисуется дашборд
      // (иначе владелец на долю секунды увидел бы личный кабинет пробного
      // периода, которым не собирался пользоваться). startCheckout теперь
      // возвращает true/false — если оплата не запустилась (сеть, ЮKassa
      // недоступна), явно говорим об этом здесь, а не тихо проваливаемся в
      // обычный дашборд без единого слова: заведение уже создано, просто
      // предлагаем оплатить из личного кабинета как обычно.
      if (skipTrial && chosenPlanId) {
        const paid = await startCheckout(tenantId, chosenPlanId, 'monthly');
        if (!paid) {
          toast('Не удалось перейти к оплате — заведение создано, оплатите его во вкладке «Тарифы»');
        }
        return;
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

const TIMEZONE_OPTIONS = [
  { id: 'Europe/Kaliningrad', label: 'Калининград (UTC+2)' },
  { id: 'Europe/Moscow', label: 'Москва (UTC+3)' },
  { id: 'Europe/Riga', label: 'Рига / Вильнюс / Таллин (UTC+2/+3)' },
  { id: 'Europe/Kyiv', label: 'Киев (UTC+2/+3)' },
  { id: 'Europe/Minsk', label: 'Минск (UTC+3)' },
  { id: 'Asia/Yekaterinburg', label: 'Екатеринбург (UTC+5)' },
  { id: 'Asia/Almaty', label: 'Алма-Ата (UTC+6)' },
  { id: 'Asia/Novosibirsk', label: 'Новосибирск (UTC+7)' },
  { id: 'Asia/Vladivostok', label: 'Владивосток (UTC+10)' },
];

// Реальные, а не "рыбные" вопросы — то, что действительно спрашивают на
// этапе выбора и подключения (честно про фискализацию: её из коробки нет,
// это же написано и в самом приложении, см. корневой README.md).
const FAQ_ITEMS = [
  { q: 'Что входит в пробный период?', a: 'Все функции тарифа, на который вы регистрируетесь, без ограничений — оплата не запрашивается, пока триал не закончится. Длительность зависит от тарифа, обычно 7 дней.' },
  { q: 'Что будет, если не оплатить вовремя?', a: 'Касса и приложение на всех устройствах заведения блокируются сразу после окончания оплаченного периода. Данные при этом не удаляются 10 дней (грейс-период) — если оплатить в течение этого срока, всё восстановится как было. После 10 дней данные удаляются безвозвратно.' },
  { q: 'Как подключить планшет на кассе?', a: 'В разделе «Устройства» — код приглашения и универсальный APK. Устанавливаете APK на планшет, при первом запуске вводите код заведения и код приглашения — планшет сам подключится к вашему заведению.' },
  { q: 'Можно ли сменить тариф позже?', a: 'Да, в любой момент в разделе «Тарифы» — повышение и понижение доступны в один клик, без обращения в поддержку.' },
  { q: 'Есть ли фискализация чеков (54-ФЗ)?', a: 'Из коробки — нет. Для настоящей фискализации нужна отдельная онлайн-касса (ККТ с фискальным накопителем — своя или облачная), заключённые договоры с провайдером кассы и с оператором фискальных данных (ОФД), и регистрация ККТ в ФНС. Эквайринг (приём карт) — отдельный договор с банком-эквайером, к ОФД отношения не имеет. Приложение поддерживает подключение готовых протоколов в разделе «Настройки → Интеграции», но сами договоры оформляете вы напрямую.' },
  { q: 'Где хранятся данные заведения?', a: 'В облаке (Google Firebase) — отдельная, изолированная база на каждое заведение. Другие заведения платформы физически не могут увидеть ваши данные — это проверено автоматическими тестами защиты.' },
  { q: 'Сколько сотрудников и устройств можно подключить?', a: 'Зависит от тарифа — лимиты указаны в разделе «Тарифы». При превышении лимита приложение продолжает работать, но администратора платформы попросят предложить тариф выше.' },
  { q: 'Что будет с данными, если я перестану пользоваться?', a: 'После отмены подписки данные хранятся 10 дней (грейс-период), затем удаляются безвозвратно. Экспортировать данные до удаления можно, обратившись в поддержку.' },
];

function screenDashboard() {
  screenEl().classList.add('has-tabbar');
  // Переключатель заведения (для владельцев с несколькими точками) живёт
  // внутри drawer (см. dashboardNavHtml) — доступен с любой вкладки, а не
  // только пока открыт "Обзор", и не толкает контент вниз на телефоне.
  screenEl().innerHTML = `<div id="dash-body"><div class="spinner"></div></div>`;
  watchDashboardData(state.activeTenantId);
}

// Свой набор SVG вместо голых эмодзи (🏠💳💎🎨 и т.д.) — у каждого эмодзи
// своя "родная" цветовая палитра, из-за чего ряд иконок выглядел случайным
// набором, а не единым стилем (отзыв "иконки в разнобой"). Один viewBox
// 24×24 на все — гарантированно одинаковый размер и центровка; цвет теперь
// свой параметр (background чипа), а не то, что нарисовано внутри самого
// эмодзи-глифа. См. также .nav-item { justify-content: flex-start } в
// console.css — это была вторая, более серьёзная причина того же отзыва
// (браузер по умолчанию центрирует содержимое <button>, из-за чего иконка
// у коротких подписей стояла ближе к центру плашки, чем у длинных).
const NAV_ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  device: '<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
  gem: '<path d="M12 2 21 9l-9 13L3 9Z"/><path d="M3 9h18M8 2l2 7M16 2l-2 7"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="7.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="16" cy="10.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="13.5" cy="15" r="1.3" fill="currentColor" stroke="none"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.5 2.7-6.2 6-6.2s6 2.7 6 6.2"/><circle cx="17.5" cy="9" r="2.4"/><path d="M15.2 13.8c2.4.3 4.3 2.5 4.3 5.2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20c0-4.1 3.4-7.5 7.5-7.5s7.5 3.4 7.5 7.5"/>',
  gear: '<circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><line x1="19" y1="12" x2="16.5" y2="12"/><line x1="5" y1="12" x2="7.5" y2="12"/><line x1="12" y1="5" x2="12" y2="7.5"/><line x1="12" y1="19" x2="12" y2="16.5"/><line x1="16.95" y1="7.05" x2="15.18" y2="8.82"/><line x1="7.05" y1="16.95" x2="8.82" y2="15.18"/><line x1="16.95" y1="16.95" x2="15.18" y2="15.18"/><line x1="7.05" y1="7.05" x2="8.82" y2="8.82"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.3 9.2a2.7 2.7 0 1 1 3.9 2.4c-.9.5-1.2 1-1.2 2"/><line x1="12" y1="17" x2="12" y2="17.01"/>',
  chat: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4.5 3.5V16H5.5A1.5 1.5 0 0 1 4 14.5Z"/>',
  logout: '<path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9"/><path d="M13 12h7m0 0-3-3m3 3-3 3"/>',
  badge: '<circle cx="12" cy="12" r="9"/><path d="M8.3 12.3l2.4 2.4 4.6-5"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><rect x="10" y="14" width="4" height="7" rx="0.5"/>',
  bell: '<path d="M18 8.5a6 6 0 1 0-12 0c0 6.5-2.5 8.5-2.5 8.5h17S18 15 18 8.5Z"/><path d="M13.7 20.5a2 2 0 0 1-3.4 0"/>',
  list: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  back: '<path d="M11 5 4 12l7 7"/><line x1="4" y1="12" x2="20" y2="12"/>',
};

function navIconHtml(name, color) {
  return `<span class="nav-icon" style="--icon-bg:${esc(color)}"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${NAV_ICON_PATHS[name] || ''}</svg></span>`;
}

const DASHBOARD_NAV = [
  { id: 'overview', icon: 'home', color: '#2F6FED', label: 'Обзор' },
  { id: 'devices', icon: 'device', color: '#0EA5E9', label: 'Устройства' },
  { id: 'billing', icon: 'card', color: '#F59E0B', label: 'Оплата' },
  { id: 'plans', icon: 'gem', color: '#8B5CF6', label: 'Тарифы' },
  { id: 'branding', icon: 'palette', color: '#EC4899', label: 'Брендинг' },
  { id: 'team', icon: 'users', color: '#10B981', label: 'Команда' },
  { id: 'profile', icon: 'user', color: '#06B6D4', label: 'Профиль' },
  { id: 'settings', icon: 'gear', color: '#64748B', label: 'Настройки' },
  { id: 'faq', icon: 'question', color: '#EF4444', label: 'FAQ' },
  { id: 'support', icon: 'chat', color: '#22C55E', label: 'Поддержка' },
];

function dashboardNavHtml(activeTab, showBillingDot, tenantName) {
  const activeMeta = DASHBOARD_NAV.find((t) => t.id === activeTab);
  return `
    <div class="dash-topbar">
      <button class="hamburger-btn" id="f-nav-open">☰</button>
      <div class="dash-topbar-title">
        <div class="dash-topbar-tenant">${esc(tenantName || 'Hookah POS')}</div>
        <div class="dash-topbar-tab">${esc(activeMeta?.label || '')}</div>
      </div>
    </div>
    <div class="nav-backdrop" id="nav-backdrop"></div>
    <div class="nav-drawer" id="nav-drawer">
      <div class="nav-drawer-brand">Hookah POS</div>
      ${state.tenants.length > 1 ? `
        <label class="field"><span>Заведение</span>
          <select id="f-nav-tenant-pick">
            ${state.tenants.map((t) => `
              <option value="${esc(t.id)}" ${t.id === state.activeTenantId ? 'selected' : ''}>${esc(t.name || t.id)}</option>
            `).join('')}
          </select>
        </label>
      ` : `<div class="nav-drawer-tenant">${esc(tenantName || '')}</div>`}
      ${DASHBOARD_NAV.map((t) => `
        <button class="nav-item${t.id === activeTab ? ' active' : ''} f-dash-tab" data-tab="${t.id}">
          ${navIconHtml(t.icon, t.color)}
          <span>${esc(t.label)}</span>
          ${t.id === 'billing' && showBillingDot ? '<span class="nav-dot"></span>' : ''}
        </button>
      `).join('')}
      ${state.isSuperAdmin ? `
        <div class="nav-divider"></div>
        <a href="#/admin" class="nav-item" style="text-decoration:none">
          ${navIconHtml('badge', '#F97316')}<span>Платформа</span>
        </a>
      ` : ''}
      <div class="nav-divider"></div>
      <button class="nav-item" id="f-nav-signout">
        ${navIconHtml('logout', '#475569')}<span>Выйти</span>
      </button>
    </div>
  `;
}

function watchDashboardData(tenantId) {
  const body = $('dash-body');
  let activeTab = 'overview';
  let tenant = null;
  let invite = null;
  let branding = null;
  let subscription = null;
  let members = null;
  let plans = null;
  let buildJobs = null;
  let generalSettings = null;
  let paymentHistory = null;
  // Активные объявления платформы (см. watchAdminBroadcasts в панели
  // супер-админа) — баннер на "Обзоре", скрытие конкретного объявления
  // запоминается в localStorage браузера (см. dismissedBroadcastIds ниже):
  // не критично для этой функции хранить "прочитано" синхронно между
  // устройствами одного владельца, а заводить для этого отдельный
  // Firestore-документ на пользователя — лишняя сложность ради баннера.
  let broadcasts = null;
  // Обращения в поддержку (супер-админ #3) — список тикетов ЭТОГО заведения
  // плюс сообщения открытого сейчас тикета. Сообщения грузятся отдельной
  // подпиской (unsubTicketMessages) только для выбранного тикета —
  // тянуть переписку по всем сразу незачем, а список тикетов и так лёгкий
  // (без вложенных сообщений).
  let supportTickets = null;
  let selectedTicketId = null;
  let ticketMessages = null;
  let unsubTicketMessages = null;
  // Не через sub(onSnapshot(...)) как остальные подписки этого экрана —
  // эта включается/выключается по выбору тикета (см. selectTicket ниже),
  // а не живёт одну на весь экран. sub() здесь только чтобы её тоже
  // закрыло при уходе с "Обзора" целиком (иначе слушатель бы утёк).
  sub(() => { if (unsubTicketMessages) unsubTicketMessages(); });
  // "Живые" цифры на "Обзоре" (см. подписки ниже) — null, пока не пришёл
  // первый снапшот, чтобы отличить "ещё грузится" от настоящего нуля.
  let liveOpenSessions = null;
  let liveOnShift = null;
  let todayRevenue = null;
  let todayChecksCount = null;
  let devicesCount = null;
  // Сотрудники с PIN-входом в кассу (tenants/{id}/employees) — отдельно от
  // members выше: то доступ к ЭТОЙ веб-панели (email+пароль), это доступ к
  // самой кассе на планшете (имя+PIN), см. teamHtml().
  let employees = null;
  // id редактируемого сейчас сотрудника, или null — форма добавления
  // нового. Переживает промежуточные перерисовки, как pendingLogoUrl ниже.
  let editingEmployeeId = null;
  const revealedEmpPins = new Set();
  // Загруженный, но ещё не сохранённый логотип — переживает промежуточные
  // перерисовки (см. ниже), сбрасывается после успешного сохранения.
  let pendingLogoUrl = null;
  // Пока идёт uploadBrandingLogoToGateway() (см. обработчик f-logo-file
  // ниже) — раньше «Сохранить брендинг» можно было нажать до того, как
  // pendingLogoUrl вообще появился: имя/цвета сохранялись, тост говорил
  // «Брендинг сохранён», а logoUrl в payload просто не попадал — выглядело
  // как «загрузил лого, а оно не применилось», без единой ошибки на экране.
  let logoUploading = false;

  const selectTicket = (ticketId) => {
    if (unsubTicketMessages) { unsubTicketMessages(); unsubTicketMessages = null; }
    selectedTicketId = ticketId;
    ticketMessages = null;
    if (ticketId) {
      unsubTicketMessages = onSnapshot(
        query(collection(state.db, 'supportTickets', ticketId, 'messages'), orderBy('createdAt', 'asc')),
        (snap) => {
          ticketMessages = snap.docs.map((d) => d.data());
          draw();
        }
      );
    }
    draw();
  };

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
    const brandName = existingName ?? (branding?.appName || tenant.name || 'Hookah POS');
    const logoUrl = pendingLogoUrl ?? (branding?.logoUrl || '');
    const primaryColor = existingColor('f-color-primary') ?? (branding?.primaryColor || '#0B5ED7');
    const secondaryColor = existingColor('f-color-secondary') ?? (branding?.secondaryColor || '#162A4A');
    const buttonColor = existingColor('f-color-button') ?? (branding?.buttonColor || '#0B5ED7');
    const backgroundColor = existingColor('f-color-bg') ?? (branding?.backgroundColor || '#02050B');
    const textColor = existingColor('f-color-text') ?? (branding?.textColor || '#F8FAFC');

    const daysLeft = daysUntilDataPurge(subscription);
    const dangerBannerHtml = daysLeft === null ? '' : `
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

    const checklistSteps = [
      { done: !!(branding && (branding.logoUrl || (branding.primaryColor && branding.primaryColor !== '#0B5ED7'))), label: 'Настроить фирменные цвета и лого', tab: 'branding' },
      { done: sortedMembers.length > 1, label: 'Пригласить первого сотрудника', tab: 'team' },
      { done: (buildJobs || []).some((j) => j.status === 'success'), label: 'Собрать и установить APK на планшет', tab: 'devices' },
    ];
    const allStepsDone = checklistSteps.every((s) => s.done);

    // "Требует внимания" — в отличие от чек-листа выше (разовый онбординг,
    // прячется навсегда после первого прохождения), эти пункты появляются и
    // исчезают по ситуации на протяжении всей жизни заведения.
    const attentionItems = [];
    const trialDaysLeft = daysUntilTrialEnd(subscription);
    if (trialDaysLeft !== null && trialDaysLeft <= 3) {
      attentionItems.push({
        tab: 'plans',
        text: trialDaysLeft > 0
          ? `Пробный период заканчивается через ${trialDaysLeft} ${pluralDays(trialDaysLeft)} — выберите тариф`
          : 'Пробный период заканчивается сегодня — выберите тариф',
      });
    }
    if (subscription?.cancelAtPeriodEnd && subscription?.currentPeriodEnd) {
      const periodDaysLeft = Math.ceil((subscription.currentPeriodEnd.toMillis() - Date.now()) / 86400000);
      if (periodDaysLeft <= 7) {
        attentionItems.push({ tab: 'billing', text: `Автопродление выключено — доступ закончится ${fmtDate(subscription.currentPeriodEnd)}` });
      }
    }
    if (devicesCount === 0 && (buildJobs || []).some((j) => j.status === 'success')) {
      attentionItems.push({ tab: 'devices', text: 'APK собран, но ни одно устройство ещё не присоединилось — установите его на планшет и введите код заведения' });
    }
    if ((buildJobs || [])[0]?.status === 'failed') {
      attentionItems.push({ tab: 'devices', text: 'Последняя сборка APK не удалась — попробуйте собрать снова или напишите в поддержку' });
    }

    // Что видит владелец на "Обзоре" про саму подписку — название тарифа
    // (а не только статус, который и так был виден строкой выше) и сколько
    // дней осталось до следующего события (конец триала/списания/уже
    // просрочено), одной строкой, без похода во вкладку "Оплата".
    const subscriptionLine = (() => {
      const plan = planName(plans, subscription?.planId);
      const planText = plan ? `Тариф «${plan}»` : 'Тариф не выбран';
      if (!subscription?.status) return planText;
      if (subscription.status === 'trial') {
        return `${planText} · пробный период${trialDaysLeft !== null
          ? (trialDaysLeft > 0 ? `, осталось ${trialDaysLeft} ${pluralDays(trialDaysLeft)}` : ', заканчивается сегодня')
          : ''}`;
      }
      if (subscription.status === 'active' && subscription.currentPeriodEnd) {
        const periodDaysLeft = Math.ceil((subscription.currentPeriodEnd.toMillis() - Date.now()) / 86400000);
        const verb = subscription.cancelAtPeriodEnd ? 'закончится' : 'продлится';
        return `${planText} · активна, ${verb} через ${periodDaysLeft > 0 ? `${periodDaysLeft} ${pluralDays(periodDaysLeft)}` : 'меньше дня'} (${fmtDate(subscription.currentPeriodEnd)})`;
      }
      if (subscription.status === 'past_due') return `${planText} · оплата просрочена`;
      if (subscription.status === 'cancelled') return `${planText} · отменена`;
      return `${planText} · ${SUB_STATUS_LABELS[subscription.status] || subscription.status}`;
    })();

    const visibleBroadcasts = (broadcasts || []).filter((b) => !dismissedBroadcastIds().has(b.id));
    const broadcastsHtml = visibleBroadcasts.length ? visibleBroadcasts.map((b) => `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div class="grow" style="min-width:0">
            <div style="font-weight:700">📣 ${esc(b.title || '')}</div>
            <div class="small muted" style="margin-top:4px">${esc(b.body || '')}</div>
          </div>
          <button class="btn-link f-broadcast-dismiss" data-id="${esc(b.id)}" style="width:auto;flex-shrink:0">✕</button>
        </div>
      </div>
    `).join('') : '';

    const overviewHtml = () => `
      ${broadcastsHtml}
      <div class="dash-greeting">${esc(greetingLine())} 👋</div>
      <div class="card">
        <div class="muted small">Заведение</div>
        <div style="font-size:20px;font-weight:700;margin:4px 0">${esc(tenant.name || '')}</div>
        <div class="small muted">
          Код: <code>${esc(tenant.slug || '')}</code> ·
          статус: ${esc(TENANT_STATUS_LABELS[tenant.status] || tenant.status || '—')} ·
          роль: ${esc(ROLE_LABELS[role] || role)}
        </div>
        <div class="small muted" style="margin-top:6px">
          ${esc(subscriptionLine)} ·
          <button class="btn-link f-dash-tab" data-tab="billing" style="width:auto">Подробнее</button>
        </div>
      </div>
      <div class="live-stats-grid">
        <div class="card live-stat">
          <div class="live-stat-value">${liveOpenSessions === null ? '—' : liveOpenSessions}</div>
          <div class="live-stat-label">Открытых столов сейчас</div>
        </div>
        <div class="card live-stat">
          <div class="live-stat-value">${liveOnShift === null ? '—' : liveOnShift}</div>
          <div class="live-stat-label">Сотрудников на смене</div>
        </div>
        <div class="card live-stat">
          <div class="live-stat-value">${todayRevenue === null ? '—' : `${Number(todayRevenue).toLocaleString('ru-RU')} ₽`}</div>
          <div class="live-stat-label">Выручка сегодня</div>
        </div>
        <div class="card live-stat">
          <div class="live-stat-value">${todayChecksCount === null ? '—' : todayChecksCount}</div>
          <div class="live-stat-label">Чеков закрыто сегодня</div>
        </div>
      </div>
      ${dangerBannerHtml}
      ${attentionItems.length ? `
        <h2>Требует внимания</h2>
        <div class="card">
          ${attentionItems.map((it) => `
            <div class="checklist-item">
              <div class="checklist-check" style="border-color:var(--warning);color:var(--warning)">!</div>
              <div class="checklist-label">${esc(it.text)}</div>
              <button class="btn-link f-dash-tab" data-tab="${it.tab}" style="width:auto">Перейти</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
      ${!allStepsDone ? `
        <h2>Настройка заведения</h2>
        <div class="card">
          ${checklistSteps.map((s) => `
            <div class="checklist-item${s.done ? ' done' : ''}">
              <div class="checklist-check">✓</div>
              <div class="checklist-label">${esc(s.label)}</div>
              ${!s.done ? `<button class="btn-link f-dash-tab" data-tab="${s.tab}" style="width:auto">Перейти</button>` : ''}
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="small muted" style="margin-bottom:8px">Быстрый доступ</div>
      <div class="quick-actions">
        <button class="btn btn-ghost f-dash-tab" data-tab="devices"><span class="btn-icon">📲</span> Устройства</button>
        <button class="btn btn-ghost f-dash-tab" data-tab="billing"><span class="btn-icon">💳</span> Оплата</button>
        <button class="btn btn-ghost f-dash-tab" data-tab="branding"><span class="btn-icon">🎨</span> Брендинг</button>
        <button class="btn btn-ghost f-dash-tab" data-tab="team"><span class="btn-icon">👥</span> Команда</button>
        <button class="btn btn-ghost f-dash-tab" data-tab="faq"><span class="btn-icon">❓</span> FAQ</button>
        <button class="btn btn-ghost f-dash-tab" data-tab="support"><span class="btn-icon">💬</span> Поддержка</button>
      </div>
    `;

    const devicesHtml = () => `
      <h2>Код приглашения устройства</h2>
      <div class="card">
        <p class="small muted">Введите его на планшете вместе с кодом заведения
        (<code>${esc(tenant.slug || '')}</code>), чтобы привязать устройство к этому заведению.
        Это секрет — если он попадёт в чужие руки, к вашему заведению сможет
        подключиться посторонний планшет, поэтому по умолчанию код скрыт.</p>
        <div class="row" style="justify-content:space-between;align-items:center">
          <div id="f-invite-code" class="invite-code-hidden" data-code="${esc(invite?.code || '—')}"
            style="font-size:26px;font-weight:700;letter-spacing:.08em;cursor:pointer;filter:blur(7px);user-select:none;transition:filter .15s"
            title="Нажмите, чтобы показать">${esc(invite?.code || '—')}</div>
          <button class="btn-link" id="f-copy-code">Скопировать</button>
        </div>
        <p class="small muted" id="f-invite-code-hint" style="margin-top:4px">Код скрыт — нажмите на него, чтобы показать</p>
        ${canManage ? `<button class="btn btn-ghost" id="f-rotate-code" style="margin-top:12px">Обновить код</button>` : ''}
      </div>

      <h2>Сборка APK</h2>
      <div class="card">
        <p class="small muted">Одна кнопка — два личных приложения этого
        заведения: касса (для планшета, сам присоединится по коду
        заведения и коду приглашения устройства выше, без ручного ввода) и
        гостевое приложение (для телефонов гостей — меню,
        заказ из-за стола, вызов персонала, бонусы; название и логотип —
        из раздела «Брендинг»).</p>
        ${canManage ? (() => {
          // Пока есть незавершённая сборка (см. проверку в handleCreateBuildJob
          // на сервере) — кнопка неактивна, чтобы не плодить дубли повторными
          // нажатиями, а не просто показывать ошибку после нажатия.
          const hasQueued = (buildJobs || []).some((j) => j.status === 'queued');
          return `<button class="btn btn-ghost" id="f-request-build" ${hasQueued ? 'disabled' : ''}>${hasQueued ? 'Сборка уже идёт…' : 'Собрать APK'}</button>`;
        })() : ''}
        <div id="f-build-error" class="small" style="color:var(--danger);margin-top:6px"></div>
        ${(buildJobs || []).length ? buildJobs.map((j) => `
          <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--border)">
            <div class="grow small muted">
              ${esc(BUILD_TYPE_LABELS[j.type] || j.type || 'Сборка')} · ${fmtDateTime(j.createdAt)} · ${esc(BUILD_STATUS_LABELS[j.status] || j.status)}
              ${j.status === 'failed' && j.errorMessage ? `<div>${esc(j.errorMessage)}</div>` : ''}
            </div>
            ${j.status === 'success' ? `
              <button class="btn-link f-build-download" data-job-id="${esc(j.id)}" style="width:auto">Скачать</button>
            ` : ''}
          </div>
        `).join('') : '<p class="small muted" style="margin-top:10px">Сборок пока не было.</p>'}
      </div>
    `;

    const billingHtml = () => `
      ${dangerBannerHtml}
      <h2>Оплата</h2>
      <div class="card">
        <div class="small muted">Тариф: ${esc(planName(plans, subscription?.planId) || subscription?.planId || '—')}</div>
        <div class="small muted">Статус: ${esc(SUB_STATUS_LABELS[subscription?.status] || subscription?.status || '—')}</div>
        ${subscription?.trialEndsAt ? `<div class="small muted">Пробный период до: ${fmtDate(subscription.trialEndsAt)}</div>` : ''}
        ${subscription?.currentPeriodEnd && subscription?.status === 'active' ? `<div class="small muted">Оплачено до: ${fmtDate(subscription.currentPeriodEnd)}</div>` : ''}
        ${subscription?.cancelAtPeriodEnd ? `
          <div class="small" style="color:var(--warning);margin-top:6px">Автопродление отключено — доступ работает до конца оплаченного периода, дальше без действий с вашей стороны спишется не будет.</div>
        ` : ''}
        ${canManage ? `<button class="btn btn-primary f-dash-tab" data-tab="plans" style="margin-top:14px">Перейти к тарифам</button>` : ''}
        ${canManage && subscription?.status === 'active' ? `
          <button class="btn btn-ghost" id="f-toggle-autorenew" style="margin-top:10px">
            ${subscription?.cancelAtPeriodEnd ? 'Возобновить автопродление' : 'Отключить автопродление'}
          </button>
          <div id="f-toggle-autorenew-error" class="small" style="color:var(--danger);margin-top:6px"></div>
        ` : ''}
      </div>

      <h2>История платежей</h2>
      <div class="card">
        ${(paymentHistory || []).length ? `
          ${paymentHistory.map((e) => `
            <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--border)">
              <div class="grow small muted">
                ${fmtDateTime(e.receivedAt)} · ${esc(BILLING_PURPOSE_LABELS[e.purpose] || e.purpose || 'оплата')}
              </div>
              <div class="small" style="font-weight:600">${Number(e.amount || 0).toLocaleString('ru-RU')} ₽</div>
            </div>
          `).join('')}
        ` : '<p class="small muted">Платежей пока не было.</p>'}
      </div>
    `;

    const plansHtml = () => `
      <h2>Тарифы</h2>
      <div class="card">
        ${canManage && plans ? `
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
        ` : '<p class="small muted">Тарифы пока не заданы платформой.</p>'}
      </div>
    `;

    const brandingHtml = () => `
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
              <div id="f-logo-progress-wrap" style="display:none;margin-top:6px">
                <div class="upload-progress"><div class="upload-progress-bar" id="f-logo-progress-bar"></div></div>
                <div class="row" style="margin-top:3px;justify-content:space-between">
                  <div class="small muted" id="f-logo-progress-text">Подготовка…</div>
                  <button class="btn-link" id="f-logo-cancel" type="button" style="width:auto">Отменить</button>
                </div>
              </div>
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
    `;

    const teamHtml = () => `
      <h2>Команда</h2>
      <div class="card">
        ${members === null ? '<div class="small muted">Загрузка…</div>' : sortedMembers.map((m) => `
          <div style="padding:8px 0;border-bottom:1px solid var(--border)">
            <div class="ellipsis">${esc(m.email || `Устройство · ${(m.userId || '').slice(-4).toUpperCase()}`)}${m.userId === state.uid ? ' <span class="muted small">(вы)</span>' : ''}</div>
            <div class="small muted">${esc(ROLE_LABELS[m.role] || m.role)}${m.status !== 'active' ? ' · отключён' : ''}</div>
            ${canManage && m.userId !== state.uid && ['manager', 'employee'].includes(m.role) ? `
              <div class="row" style="flex-wrap:wrap;margin-top:6px">
                <select class="f-member-role" data-uid="${esc(m.userId)}" style="width:auto;margin:0">
                  <option value="manager" ${m.role === 'manager' ? 'selected' : ''}>Менеджер</option>
                  <option value="employee" ${m.role === 'employee' ? 'selected' : ''}>Сотрудник</option>
                </select>
                <button class="btn-link f-member-toggle" data-uid="${esc(m.userId)}" data-active="${m.status === 'active' ? '1' : '0'}">
                  ${m.status === 'active' ? 'Отключить' : 'Включить'}
                </button>
                <button class="btn-link f-member-delete" data-uid="${esc(m.userId)}" data-device="${m.email ? '0' : '1'}" data-label="${esc(m.email || `Устройство · ${(m.userId || '').slice(-4).toUpperCase()}`)}" style="color:var(--danger)">
                  Удалить
                </button>
              </div>
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
            сначала сам зарегистрироваться в этой консоли —
            тогда его можно будет найти по email.</p>
            <div id="f-invite-error" class="small" style="color:var(--danger)"></div>
          </div>
        ` : ''}
      </div>

      <h2>Сотрудники кассы (вход по PIN)</h2>
      <div class="card">
        <p class="small muted">Отдельно от доступа к ЭТОЙ веб-панели выше:
        эти сотрудники входят прямо в кассу на планшете по имени и
        PIN-коду — им не нужен email и эта страница вообще. У «Сотрудника»
        PIN из 4 цифр, у «Администратора» — из 6.</p>
        ${employees === null ? '<div class="small muted">Загрузка…</div>' : (employees.length === 0
          ? '<div class="small muted">Пока нет ни одного сотрудника с PIN-входом</div>'
          : employees.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((e) => {
            const pinLen = e.role === 'admin' ? 6 : 4;
            const revealed = revealedEmpPins.has(e.id);
            return `
          <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
            <div class="grow" style="min-width:0">
              <div class="ellipsis">${esc(e.name || '')}</div>
              <div class="small muted">
                ${e.role === 'admin' ? 'Администратор' : 'Сотрудник'} · PIN
                <span class="f-emp-pin" data-id="${esc(e.id)}" style="cursor:pointer" title="Нажмите, чтобы ${revealed ? 'скрыть' : 'показать'}">${revealed ? esc(e.pinCode || '') : '•'.repeat(pinLen)}</span>
                ${e.position && e.position !== 'universal' ? ` · ${esc(POSITION_LABELS[e.position] || e.position)}` : ''}
              </div>
            </div>
            ${canManage ? `
              <button class="btn-link f-emp-edit" data-id="${esc(e.id)}" style="width:auto">Изменить</button>
              <button class="btn-link f-emp-delete" data-id="${esc(e.id)}" data-name="${esc(e.name || '')}" style="width:auto;color:var(--danger)">Удалить</button>
            ` : ''}
          </div>
        `;
          }).join(''))}

        ${canManage ? `
          <div style="margin-top:14px">
            <div class="small muted" style="margin-bottom:6px">${editingEmployeeId ? 'Редактирование сотрудника' : 'Новый сотрудник'}</div>
            <label class="field"><span>Имя</span>
              <input id="f-emp-name" placeholder="Имя сотрудника">
            </label>
            <div class="row">
              <select id="f-emp-role" class="grow">
                <option value="employee">Сотрудник (PIN — 4 цифры)</option>
                <option value="admin">Администратор (PIN — 6 цифр)</option>
              </select>
            </div>
            <label class="field"><span>PIN-код</span>
              <input id="f-emp-pin" type="text" inputmode="numeric" placeholder="0000" maxlength="6">
            </label>
            <label class="field"><span>Специализация</span>
              <select id="f-emp-position">
                ${Object.entries(POSITION_LABELS).map(([v, label]) =>
                  `<option value="${esc(v)}">${esc(label)}</option>`).join('')}
              </select>
            </label>
            <p class="small muted" style="margin-top:-4px">Определяет, какие вызовы гостя
            из-за стола придут этому сотруднику (см. кнопки «Позвать» в клиентском
            приложении) — например, официант не будет получать вызов кальянщика на угли.</p>
            <div class="row">
              <button class="btn btn-ghost" id="f-emp-submit" style="width:auto">Сохранить</button>
              ${editingEmployeeId ? `<button class="btn-link" id="f-emp-cancel" style="width:auto">Отменить</button>` : ''}
            </div>
            <p class="small muted" style="margin-top:6px">После сохранения сообщите сотруднику
            имя и PIN-код лично — по ним он войдёт в кассу на планшете.</p>
            <div id="f-emp-error" class="small" style="color:var(--danger)"></div>
          </div>
        ` : ''}
      </div>
    `;

    const memberSince = (() => {
      const iso = state.auth.currentUser?.metadata?.creationTime;
      if (!iso) return '—';
      const d = new Date(iso);
      return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
    })();

    const profileHtml = () => `
      <h2>Профиль</h2>
      <div class="card">
        <div class="small muted">Email</div>
        <div style="font-weight:700;margin:4px 0 14px">${esc(state.auth.currentUser?.email || '—')}</div>
        <div class="small muted">Роль в заведении «${esc(tenant.name || '')}»</div>
        <div style="font-weight:700;margin:4px 0 14px">${esc(ROLE_LABELS[role] || role)}</div>
        <div class="small muted">Аккаунт создан</div>
        <div style="font-weight:700;margin:4px 0 14px">${esc(memberSince)}</div>
        <div class="small muted">ID заведения (для обращений в поддержку)</div>
        <div style="margin:4px 0"><code>${esc(tenantId)}</code></div>
      </div>
      <div class="card">
        <div class="small muted">Всего в команде: ${sortedMembers.length} ${pluralPeople(sortedMembers.length)}</div>
      </div>
      <p class="small center muted">Сменить пароль можно на вкладке <a href="#" class="f-dash-tab" data-tab="settings">«Настройки»</a>.</p>
      <button class="btn btn-ghost" id="f-profile-signout">Выйти из аккаунта</button>
    `;

    const settingsHtml = () => `
      <h2>Пароль</h2>
      <div class="card">
        <label class="field"><span>Текущий пароль</span>
          <input id="f-pass-current" type="password" autocomplete="current-password">
        </label>
        <label class="field"><span>Новый пароль</span>
          <input id="f-pass-new" type="password" autocomplete="new-password" placeholder="Минимум 6 символов">
        </label>
        <button class="btn btn-ghost" id="f-pass-change">Сменить пароль</button>
        <div id="f-pass-change-msg" class="small" style="margin-top:8px"></div>
        <p class="small muted" style="margin-top:10px">Не помните текущий пароль? Выйдите из аккаунта и на экране входа нажмите «Забыли пароль?» — придёт ссылка на почту.</p>
      </div>

      <h2>Настройки заведения</h2>
      <div class="card">
        <label class="field"><span>Часовой пояс</span>
          <select id="f-timezone" ${canManage ? '' : 'disabled'}>
            ${TIMEZONE_OPTIONS.map((tz) => `<option value="${esc(tz.id)}" ${generalSettings?.timezone === tz.id ? 'selected' : ''}>${esc(tz.label)}</option>`).join('')}
          </select>
        </label>
        <div class="small muted">Валюта: ${esc(generalSettings?.currency || 'RUB')} · Язык интерфейса: русский</div>
        ${canManage ? `<button class="btn btn-ghost" id="f-save-settings" style="margin-top:12px">Сохранить</button>` : ''}
        <div id="f-settings-error" class="small" style="color:var(--danger);margin-top:8px"></div>
      </div>

      <h2>Системные требования</h2>
      <div class="card">
        <div class="small" style="padding:7px 0;border-bottom:1px solid var(--border)">📶 Интернет нужен постоянно — Wi-Fi или мобильный</div>
        <div class="small" style="padding:7px 0;border-bottom:1px solid var(--border)">📱 Android 8.0 и новее, экран от 8 дюймов рекомендован</div>
        <div class="small" style="padding:7px 0;border-bottom:1px solid var(--border)">🖨️ Принтер чеков — опционально, Bluetooth/USB, настраивается в самом приложении кассы</div>
        <div class="small" style="padding:7px 0">☁️ Все данные хранятся в облаке — ничего не теряется при поломке или замене планшета</div>
      </div>

      <h2>Документы и статус</h2>
      <div class="card">
        <div class="small" style="padding:7px 0;border-bottom:1px solid var(--border)"><a href="#/legal/offer">Публичная оферта</a></div>
        <div class="small" style="padding:7px 0;border-bottom:1px solid var(--border)"><a href="#/legal/privacy">Политика конфиденциальности</a></div>
        <div class="small" style="padding:7px 0"><a href="#/status">Статус системы</a></div>
      </div>
    `;

    const faqHtml = () => `
      <h2>Частые вопросы</h2>
      <div class="card">
        ${FAQ_ITEMS.map((item, i) => `
          <div class="faq-item" data-faq="${i}">
            <div class="faq-question">
              <span>${esc(item.q)}</span>
              <span class="faq-toggle">+</span>
            </div>
            <div class="faq-answer">${esc(item.a)}</div>
          </div>
        `).join('')}
      </div>
      <p class="small center muted">Не нашли ответ? <a href="#" class="f-dash-tab" data-tab="support">Напишите в поддержку</a></p>
    `;

    const selectedTicket = (supportTickets || []).find((t) => t.id === selectedTicketId) || null;

    const ticketThreadHtml = () => `
      <button class="btn-link f-ticket-back" style="width:auto;margin-bottom:10px">← Все обращения</button>
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div style="font-weight:700">${esc(selectedTicket.subject || '')}</div>
          <div class="small muted">${selectedTicket.status === 'closed' ? 'Решено' : 'Открыто'}</div>
        </div>
        <div style="margin-top:10px">
          ${ticketMessages === null ? '<div class="spinner"></div>' : (ticketMessages.length ? ticketMessages.map((m) => `
            <div style="margin:8px 0;padding:8px 10px;border-radius:10px;background:${m.authorRole === 'super_admin' ? 'var(--surface-2)' : 'transparent'};border:1px solid var(--border)">
              <div class="small muted">${esc(m.authorRole === 'super_admin' ? 'Платформа' : 'Вы')} · ${fmtDateTime(m.createdAt)}</div>
              <div class="small" style="margin-top:2px;white-space:pre-wrap">${esc(m.text || '')}</div>
            </div>
          `).join('') : '<p class="small muted">Сообщений пока нет.</p>')}
        </div>
        <textarea id="f-ticket-reply" rows="3" placeholder="Ваш ответ..." style="width:100%;resize:vertical;margin-top:10px"></textarea>
        <button class="btn btn-primary" id="f-ticket-reply-send" style="margin-top:8px">Отправить</button>
        <button class="btn-link f-ticket-toggle-status" data-status="${esc(selectedTicket.status)}" style="width:auto;margin-top:8px">
          ${selectedTicket.status === 'closed' ? 'Переоткрыть обращение' : 'Обращение решено'}
        </button>
      </div>
    `;

    const ticketListHtml = () => `
      <h2>Поддержка</h2>
      <div class="card">
        <label class="field"><span>Тема</span>
          <input id="f-ticket-subject" placeholder="Например: не собирается APK">
        </label>
        <label class="field"><span>Сообщение</span>
          <textarea id="f-ticket-message" rows="3" placeholder="Опишите, что случилось"></textarea>
        </label>
        <button class="btn btn-primary" id="f-ticket-create">Создать обращение</button>
      </div>
      ${(supportTickets || []).length ? `<div class="card">${supportTickets.map((t) => `
        <div class="row f-ticket-open" data-id="${esc(t.id)}" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer">
          <div class="small grow" style="min-width:0">
            <b>${esc(t.subject || '')}</b>
            <div class="muted">${fmtDateTime(t.updatedAt || t.createdAt)}</div>
          </div>
          <div class="small muted">${t.status === 'closed' ? 'Решено' : 'Открыто'}</div>
        </div>
      `).join('')}</div>` : '<p class="small muted">Обращений пока не было.</p>'}
      <p class="small center muted">Что-то не открывается вообще? Сначала проверьте <a href="#/status">статус системы</a>.</p>
    `;

    const supportHtml = () => selectedTicket ? ticketThreadHtml() : ticketListHtml();

    const TAB_RENDERERS = {
      overview: overviewHtml, devices: devicesHtml, billing: billingHtml, plans: plansHtml,
      branding: brandingHtml, team: teamHtml, profile: profileHtml, settings: settingsHtml,
      faq: faqHtml, support: supportHtml,
    };
    body.innerHTML = (TAB_RENDERERS[activeTab] || overviewHtml)() + dashboardNavHtml(activeTab, daysLeft !== null, tenant.name);

    document.querySelectorAll('.f-dash-tab').forEach((el) => {
      el.onclick = (e) => {
        e.preventDefault();
        activeTab = el.dataset.tab;
        draw();
      };
    });
    document.querySelectorAll('.f-broadcast-dismiss').forEach((el) => {
      el.onclick = () => {
        dismissBroadcast(el.dataset.id);
        draw();
      };
    });
    document.querySelectorAll('.f-ticket-open').forEach((el) => {
      el.onclick = () => selectTicket(el.dataset.id);
    });
    if ($('f-ticket-back')) $('f-ticket-back').onclick = () => selectTicket(null);
    if ($('f-ticket-create')) {
      $('f-ticket-create').onclick = async () => {
        const subjectEl = $('f-ticket-subject');
        const messageEl = $('f-ticket-message');
        const subject = subjectEl.value.trim();
        const text = messageEl.value.trim();
        if (!subject || !text) {
          toast('Заполните тему и сообщение');
          return;
        }
        const btn = $('f-ticket-create');
        btn.disabled = true;
        try {
          const now = Timestamp.fromDate(new Date());
          const ticketRef = await addDoc(collection(state.db, 'supportTickets'), {
            tenantId, subject, status: 'open', createdBy: state.uid, createdAt: now, updatedAt: now,
          });
          await addDoc(collection(state.db, 'supportTickets', ticketRef.id, 'messages'), {
            text, authorUid: state.uid, authorRole: 'owner', createdAt: now,
          });
          subjectEl.value = '';
          messageEl.value = '';
          toast('Обращение создано');
          selectTicket(ticketRef.id);
        } catch (e) {
          toast(`Не удалось создать обращение: ${e?.message || e}`);
        } finally {
          btn.disabled = false;
        }
      };
    }
    if ($('f-ticket-reply-send')) {
      $('f-ticket-reply-send').onclick = async () => {
        const replyEl = $('f-ticket-reply');
        const text = replyEl.value.trim();
        if (!text || !selectedTicket) return;
        const btn = $('f-ticket-reply-send');
        btn.disabled = true;
        try {
          const now = Timestamp.fromDate(new Date());
          await addDoc(collection(state.db, 'supportTickets', selectedTicket.id, 'messages'), {
            text, authorUid: state.uid, authorRole: 'owner', createdAt: now,
          });
          await setDoc(doc(state.db, 'supportTickets', selectedTicket.id), {
            updatedAt: now,
            status: selectedTicket.status === 'closed' ? 'open' : selectedTicket.status,
          }, { merge: true });
          replyEl.value = '';
        } catch (e) {
          toast(`Не удалось отправить: ${e?.message || e}`);
        } finally {
          btn.disabled = false;
        }
      };
    }
    if ($('f-ticket-toggle-status')) {
      $('f-ticket-toggle-status').onclick = async () => {
        if (!selectedTicket) return;
        try {
          await setDoc(doc(state.db, 'supportTickets', selectedTicket.id), {
            status: selectedTicket.status === 'closed' ? 'open' : 'closed',
            updatedAt: Timestamp.fromDate(new Date()),
          }, { merge: true });
        } catch (e) {
          toast(`Не удалось изменить статус: ${e?.message || e}`);
        }
      };
    }

    // Гамбургер-меню: на телефоне это выдвижная панель поверх контента, на
    // широком экране (см. media query в console.css) она уже показана
    // постоянно и сама кнопка/подложка скрыты — обработчики безобидны и там,
    // и там.
    const navDrawer = $('nav-drawer');
    const navBackdrop = $('nav-backdrop');
    const closeNav = () => { navDrawer?.classList.remove('open'); navBackdrop?.classList.remove('open'); };
    if ($('f-nav-open')) $('f-nav-open').onclick = () => { navDrawer?.classList.add('open'); navBackdrop?.classList.add('open'); };
    if (navBackdrop) navBackdrop.onclick = closeNav;
    document.querySelectorAll('.f-dash-tab').forEach((el) => { el.addEventListener('click', closeNav); });
    if ($('f-nav-signout')) $('f-nav-signout').onclick = () => signOut(state.auth);
    if ($('f-nav-tenant-pick')) {
      $('f-nav-tenant-pick').onchange = (e) => {
        state.activeTenantId = e.target.value;
        route();
      };
    }
    if ($('f-profile-signout')) $('f-profile-signout').onclick = () => signOut(state.auth);
    if ($('f-pass-change')) {
      $('f-pass-change').onclick = async () => {
        const currentEl = $('f-pass-current');
        const newEl = $('f-pass-new');
        const msgEl = $('f-pass-change-msg');
        msgEl.style.color = 'var(--danger)';
        msgEl.textContent = '';
        if (!currentEl.value || !newEl.value) {
          msgEl.textContent = 'Заполните оба поля';
          return;
        }
        if (newEl.value.length < 6) {
          msgEl.textContent = 'Новый пароль — минимум 6 символов';
          return;
        }
        const btn = $('f-pass-change');
        btn.disabled = true;
        try {
          // updatePassword требует "свежий" вход — на смене пароля это
          // особенно уместно (см. тот же приём в reauthenticate() для
          // опасных действий супер-админа): подтверждаем ТЕКУЩИЙ пароль
          // перед тем, как поставить новый, а не полагаемся на то, что
          // сессия в браузере вообще принадлежит владельцу аккаунта.
          await reauthenticateWithCredential(
            state.auth.currentUser,
            EmailAuthProvider.credential(state.auth.currentUser.email, currentEl.value)
          );
          await updatePassword(state.auth.currentUser, newEl.value);
          currentEl.value = '';
          newEl.value = '';
          msgEl.style.color = 'var(--primary)';
          msgEl.textContent = 'Пароль изменён';
        } catch (e) {
          msgEl.textContent = e?.code === 'auth/wrong-password' || e?.code === 'auth/invalid-credential'
            ? 'Текущий пароль неверен'
            : authErrorMessage(e);
        } finally {
          btn.disabled = false;
        }
      };
    }

    document.querySelectorAll('.faq-item').forEach((el) => {
      el.querySelector('.faq-question')?.addEventListener('click', () => {
        el.classList.toggle('open');
      });
    });
    if ($('f-save-settings')) {
      $('f-save-settings').onclick = async () => {
        const btn = $('f-save-settings');
        btn.disabled = true;
        try {
          await setDoc(doc(state.db, 'tenants', tenantId, 'settings', 'general'), {
            timezone: $('f-timezone').value,
          }, { merge: true });
          toast('Настройки сохранены');
        } catch (e) {
          toast(`Не удалось сохранить: ${e?.message || e}`);
        } finally {
          btn.disabled = false;
        }
      };
    }

    if ($('f-copy-code')) $('f-copy-code').onclick = () => copyToClipboard(invite?.code || '');
    if ($('f-rotate-code')) $('f-rotate-code').onclick = () => rotateInviteCode(tenantId);
    // Код приглашения — секрет устройства (см. подсказку выше), поэтому он
    // замазан blur'ом, пока по нему не кликнут — обычный текст в DOM всё
    // равно доступен через "показать код страницы", но так хотя бы никто
    // не подсмотрит его через плечо на весь экран открытым текстом.
    const inviteCodeEl = $('f-invite-code');
    if (inviteCodeEl) {
      inviteCodeEl.onclick = () => {
        const revealed = inviteCodeEl.style.filter === 'none';
        inviteCodeEl.style.filter = revealed ? 'blur(7px)' : 'none';
        inviteCodeEl.title = revealed ? 'Нажмите, чтобы показать' : 'Нажмите, чтобы скрыть';
        const hint = $('f-invite-code-hint');
        if (hint) hint.textContent = revealed
          ? 'Код скрыт — нажмите на него, чтобы показать'
          : 'Код виден — нажмите на него, чтобы снова скрыть';
      };
    }

    if ($('f-toggle-autorenew')) {
      $('f-toggle-autorenew').onclick = () => toggleAutorenew(tenantId, !subscription?.cancelAtPeriodEnd);
    }

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
          const progressWrap = $('f-logo-progress-wrap');
          const progressBar = $('f-logo-progress-bar');
          const progressText = $('f-logo-progress-text');
          errEl.textContent = '';
          if (file.size > 5 * 1024 * 1024) {
            errEl.textContent = 'Файл больше 5 МБ — выберите изображение поменьше';
            return;
          }
          // Локальный превью сразу же, не дожидаясь загрузки — иначе на
          // медленной сети окошко логотипа несколько секунд стоит пустым/
          // белым, и не отличить "грузится" от "сломалось". Реальный URL
          // подменит его ниже, после ответа сервера.
          const localPreviewUrl = URL.createObjectURL(file);
          $('f-logo-preview').src = localPreviewUrl;
          // Пока файл грузится, «Сохранить брендинг» заблокирована (см.
          // ниже) — иначе клик по ней раньше, чем отработает загрузка,
          // сохранял бы имя/цвета без ещё не готового pendingLogoUrl, и
          // логотип молча не попадал бы в базу.
          logoUploading = true;
          if ($('f-save-branding')) $('f-save-branding').disabled = true;
          if (progressWrap) progressWrap.style.display = 'block';
          if (progressBar) progressBar.style.width = '0%';
          if (progressText) progressText.textContent = 'Подготовка…';
          const cancelBtn = $('f-logo-cancel');
          let stallTimer = null;
          try {
            const uploadFile = await resizeImageForUpload(file);
            let lastProgressAt = Date.now();
            const { xhr, promise } = uploadBrandingLogoToGateway(tenantId, uploadFile, (pct) => {
              lastProgressAt = Date.now();
              if (progressBar) progressBar.style.width = `${pct}%`;
              if (progressText) progressText.textContent = `Загружается… ${pct}%`;
            });
            if (cancelBtn) cancelBtn.onclick = () => xhr.abort();
            // Если за 20 секунд не прилетело ни одного обновления прогресса —
            // соединение, скорее всего, не просто медленное, а разорвано:
            // XHR сам по себе не отменяется по таймауту и молча висит сколько
            // угодно, оставляя кнопку "Сохранить" заблокированной навсегда
            // без единой подсказки, что происходит.
            stallTimer = setInterval(() => {
              if (Date.now() - lastProgressAt > 20000) xhr.abort();
            }, 5000);
            const relPath = await promise;
            pendingLogoUrl = `${new URL(SAAS_GATEWAY_URL).origin}${relPath}?v=${Date.now()}`;
            if ($('f-logo-preview')) $('f-logo-preview').src = pendingLogoUrl;
          } catch (err) {
            const canceled = err?.code === 'upload/canceled';
            errEl.textContent = canceled
              ? 'Загрузка прервана — слишком медленное или нестабильное соединение. Проверьте интернет и попробуйте снова.'
              : `Не удалось загрузить: ${err?.message || err}`;
            if (!canceled) toast(`Логотип не загружен: ${err?.message || err}`);
          } finally {
            if (stallTimer) clearInterval(stallTimer);
            if (cancelBtn) cancelBtn.onclick = null;
            URL.revokeObjectURL(localPreviewUrl);
            logoUploading = false;
            if (progressWrap) progressWrap.style.display = 'none';
            if ($('f-save-branding')) $('f-save-branding').disabled = false;
          }
        };
      }
      if ($('f-save-branding')) {
        $('f-save-branding').onclick = async () => {
          const errEl = $('f-branding-error');
          errEl.textContent = '';
          if (logoUploading) {
            errEl.textContent = 'Подождите, логотип ещё загружается…';
            return;
          }
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
    document.querySelectorAll('.f-member-delete').forEach((el) => {
      el.onclick = () => deleteMember(tenantId, el.dataset.uid, el.dataset.device === '1', el.dataset.label);
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

    document.querySelectorAll('.f-emp-pin').forEach((el) => {
      el.onclick = () => {
        revealedEmpPins.has(el.dataset.id) ? revealedEmpPins.delete(el.dataset.id) : revealedEmpPins.add(el.dataset.id);
        draw();
      };
    });
    document.querySelectorAll('.f-emp-edit').forEach((el) => {
      el.onclick = () => {
        const emp = (employees || []).find((x) => x.id === el.dataset.id);
        if (!emp) return;
        editingEmployeeId = emp.id;
        // Проставляем значения ПРЯМО в ещё-старые (до перерисовки) поля —
        // draw() читает их именно оттуда (см. комментарий про existingName
        // у формы брендинга выше): иначе форма осталась бы пустой, а не
        // заполнилась данными выбранного сотрудника.
        if ($('f-emp-name')) $('f-emp-name').value = emp.name || '';
        if ($('f-emp-role')) $('f-emp-role').value = emp.role || 'employee';
        if ($('f-emp-pin')) $('f-emp-pin').value = emp.pinCode || '';
        if ($('f-emp-position')) $('f-emp-position').value = emp.position || 'universal';
        draw();
      };
    });
    if ($('f-emp-cancel')) {
      $('f-emp-cancel').onclick = () => {
        editingEmployeeId = null;
        if ($('f-emp-name')) $('f-emp-name').value = '';
        if ($('f-emp-role')) $('f-emp-role').value = 'employee';
        if ($('f-emp-pin')) $('f-emp-pin').value = '';
        if ($('f-emp-position')) $('f-emp-position').value = 'universal';
        draw();
      };
    }
    document.querySelectorAll('.f-emp-delete').forEach((el) => {
      el.onclick = async () => {
        if (!confirm(`Удалить сотрудника «${el.dataset.name}»? Он больше не сможет войти по своему PIN-коду.`)) return;
        try {
          await deleteDoc(doc(state.db, 'tenants', tenantId, 'employees', el.dataset.id));
          if (editingEmployeeId === el.dataset.id) editingEmployeeId = null;
          toast('Сотрудник удалён');
        } catch (e) {
          toast(`Не удалось удалить: ${e?.message || e}`);
        }
      };
    });
    if ($('f-emp-submit')) {
      $('f-emp-submit').onclick = async () => {
        const errEl = $('f-emp-error');
        errEl.textContent = '';
        const name = $('f-emp-name').value.trim();
        const role = $('f-emp-role').value === 'admin' ? 'admin' : 'employee';
        const pin = $('f-emp-pin').value.trim();
        const position = $('f-emp-position') ? $('f-emp-position').value : 'universal';
        // Та же длина PIN по роли, что и в кассе (lib/utils/constants.dart,
        // AppConstants.pinLengthForRole) — иначе владелец задал бы PIN,
        // который сама касса потом не примет ни при каком вводе.
        const requiredLen = role === 'admin' ? 6 : 4;
        if (!name) { errEl.textContent = 'Введите имя'; return; }
        if (!/^\d+$/.test(pin) || pin.length !== requiredLen) {
          errEl.textContent = `PIN-код должен состоять ровно из ${requiredLen} цифр`;
          return;
        }
        const taken = (employees || []).some((e) => e.pinCode === pin && e.id !== editingEmployeeId);
        if (taken) { errEl.textContent = 'Этот PIN-код уже занят другим сотрудником'; return; }
        $('f-emp-submit').disabled = true;
        try {
          if (editingEmployeeId) {
            await updateDoc(doc(state.db, 'tenants', tenantId, 'employees', editingEmployeeId), { name, role, pinCode: pin, position });
            toast('Сотрудник обновлён');
          } else {
            // Остальные поля — те же дефолты, что и у Employee() в
            // lib/models/employee.dart, чтобы касса читала запись как
            // сотрудника без настроенной зарплаты, а не падала на
            // отсутствующих полях.
            await addDoc(collection(state.db, 'tenants', tenantId, 'employees'), {
              name, role, pinCode: pin, position,
              hourlyRateEnabled: false, hourlyRate: 0,
              overtimeEnabled: false, overtimeThresholdHours: 8, overtimeMultiplier: 1.5,
              salesPercentEnabled: false, salesPercentRate: 0,
            });
            toast('Сотрудник добавлен — сообщите ему имя и PIN для входа в кассу');
          }
          editingEmployeeId = null;
          $('f-emp-name').value = '';
          $('f-emp-role').value = 'employee';
          $('f-emp-pin').value = '';
          if ($('f-emp-position')) $('f-emp-position').value = 'universal';
        } catch (e) {
          errEl.textContent = `Не удалось сохранить: ${e?.message || e}`;
        } finally {
          if ($('f-emp-submit')) $('f-emp-submit').disabled = false;
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
      el.onclick = () => downloadBuild(el.dataset.jobId);
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
  sub(onSnapshot(doc(state.db, 'tenants', tenantId, 'settings', 'general'), (d) => {
    generalSettings = d.exists() ? d.data() : null;
    draw();
  }, () => {}));
  sub(onSnapshot(doc(state.db, 'subscriptions', tenantId), (d) => {
    subscription = d.exists() ? d.data() : null;
    draw();
  }, () => {}));
  sub(onSnapshot(query(collection(state.db, 'broadcasts'), where('active', '==', true), orderBy('createdAt', 'desc'), limit(5)), (snap) => {
    broadcasts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  }, () => {
    broadcasts = [];
    draw();
  }));
  sub(onSnapshot(query(collection(state.db, 'supportTickets'), where('tenantId', '==', tenantId), orderBy('updatedAt', 'desc'), limit(50)), (snap) => {
    supportTickets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  }, () => {
    supportTickets = [];
    draw();
  }));
  sub(onSnapshot(query(collection(state.db, 'tenantMembers'), where('tenantId', '==', tenantId)), (snap) => {
    members = snap.docs.map((d) => d.data());
    draw();
  }, () => {
    members = [];
    draw();
  }));
  sub(onSnapshot(collection(state.db, 'tenants', tenantId, 'employees'), (snap) => {
    employees = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  }, () => {
    employees = [];
    draw();
  }));
  // id -> последний известный статус сборки — чтобы поймать именно ПЕРЕХОД
  // queued -> success/failed и показать тост один раз, а не при каждом
  // снимке (и не при первой же загрузке экрана, если сборка уже была
  // готова до того, как владелец открыл кабинет).
  const knownBuildStatuses = new Map();
  sub(onSnapshot(
    query(collection(state.db, 'buildJobs'), where('tenantId', '==', tenantId), orderBy('createdAt', 'desc'), limit(10)),
    (snap) => {
      buildJobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      buildJobs.forEach((j) => {
        const prevStatus = knownBuildStatuses.get(j.id);
        if (prevStatus === 'queued' && j.status === 'success') {
          toast('Сборка APK готова — скачайте её во вкладке «Устройства»');
        } else if (prevStatus === 'queued' && j.status === 'failed') {
          toast('Сборка APK не удалась — подробности во вкладке «Устройства»');
        }
        knownBuildStatuses.set(j.id, j.status);
      });
      draw();
    },
    () => { buildJobs = []; draw(); },
  ));
  // Своя история платежей — раньше эти события (billingEvents) видел
  // только супер-админ платформы; владельцу заведения приходилось писать
  // в поддержку за квитанцией. saas/firestore.rules теперь пускает сюда и
  // owner/admin СВОЕГО заведения (см. комментарий там же).
  sub(onSnapshot(
    query(collection(state.db, 'billingEvents'), where('tenantId', '==', tenantId), orderBy('receivedAt', 'desc'), limit(50)),
    (snap) => {
      paymentHistory = snap.docs.map((d) => d.data());
      draw();
    },
    () => { paymentHistory = []; draw(); },
  ));

  // "Живые" цифры на "Обзоре" — открытые столы и сотрудники на смене прямо
  // сейчас, выручка и число чеков за сегодня. Границу "сегодня" берём по
  // времени БРАУЗЕРА владельца (он и смотрит "Обзор" в своём часовом
  // поясе) — не бухгалтерская точность, а ориентир на один взгляд.
  sub(onSnapshot(
    query(collection(state.db, 'tenants', tenantId, 'sessions'), where('status', '==', 'active')),
    (snap) => { liveOpenSessions = snap.size; draw(); },
    () => { liveOpenSessions = 0; draw(); },
  ));
  sub(onSnapshot(
    query(collection(state.db, 'tenants', tenantId, 'staffShifts'), where('status', '==', 'open')),
    (snap) => { liveOnShift = snap.size; draw(); },
    () => { liveOnShift = 0; draw(); },
  ));
  sub(onSnapshot(collection(state.db, 'tenants', tenantId, 'devices'), (snap) => {
    devicesCount = snap.size;
    draw();
  }, () => { devicesCount = 0; draw(); }));
  {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    sub(onSnapshot(
      query(
        collection(state.db, 'tenants', tenantId, 'sessions'),
        where('status', '==', 'closed'),
        where('closedAt', '>=', Timestamp.fromDate(startOfToday)),
      ),
      (snap) => {
        todayChecksCount = snap.size;
        todayRevenue = snap.docs.reduce((sum, d) => {
          const s = d.data();
          return sum + (Number(s.paymentCash) || 0) + (Number(s.paymentCard) || 0) +
            (Number(s.paymentTerminal) || 0) + (Number(s.paymentComp) || 0);
        }, 0);
        draw();
      },
      () => { todayChecksCount = 0; todayRevenue = 0; draw(); },
    ));
  }
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

async function toggleAutorenew(tenantId, cancel) {
  // Отмену подтверждаем через prompt(), а не confirm() (как для возврата
  // ниже) — заодно спрашиваем причину: null означает "нажали Отмена",
  // пустая строка — "нажали ОК, но причину не написали" (оба варианта
  // существующий формат super-админа читает как есть, см. renderTenantDetail).
  let reason = '';
  if (cancel) {
    const input = prompt(
      'Отключить автопродление? Заведение продолжит работать до конца уже оплаченного периода, ' +
      'дальше касса будет заблокирована, если не оплатить вручную.\n\n' +
      'Подскажите, пожалуйста, почему уходите (необязательно) — это поможет нам стать лучше:'
    );
    if (input === null) return;
    reason = input.trim();
  } else if (!confirm('Возобновить автопродление? В конце периода спишется оплата сохранённым способом.')) {
    return;
  }
  const btn = $('f-toggle-autorenew');
  const errEl = $('f-toggle-autorenew-error');
  if (errEl) errEl.textContent = '';
  if (btn) btn.disabled = true;
  try {
    // cancelSubscription/resumeSubscription — свой сервис (см. server.js в
    // saas-gateway), не Cloud Function: Firestore-правила не пускают
    // клиента писать в subscriptions напрямую даже для своего заведения.
    await callSaasGateway(cancel ? 'cancelSubscription' : 'resumeSubscription', cancel ? { tenantId, reason } : { tenantId });
    toast(cancel ? 'Автопродление отключено' : 'Автопродление возобновлено');
  } catch (e) {
    if (errEl) errEl.textContent = `Не удалось изменить автопродление: ${e?.message || e}`;
    if (btn) btn.disabled = false;
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

// «Отключить» выше просто ставит status: 'inactive' — запись остаётся в
// списке навсегда, и он захламляется, если через заведение прошло много
// планшетов (замена сломанных, старые точки продаж и т.д.). «Удалить»
// стирает саму запись насовсем.
async function deleteMember(tenantId, memberUid, isDevice, label) {
  if (!confirm(`Удалить «${label}» из команды безвозвратно? Отменить нельзя — для устройства понадобится заново присоединяться по коду приглашения.`)) return;
  try {
    await deleteDoc(doc(state.db, 'tenantMembers', `${tenantId}_${memberUid}`));
    if (isDevice) {
      // Обязательно удалить и сам devices/{uid} — иначе устройство само
      // восстановит себе tenantMembers с ролью employee при следующем
      // запуске приложения: правила разрешают самоприсоединение, пока
      // существует его собственный devices/{uid} (см. saas/firestore.rules,
      // tenantMembers.create, третья ветка).
      await deleteDoc(doc(state.db, 'tenants', tenantId, 'devices', memberUid));
    }
    toast('Удалено');
  } catch (e) {
    toast(`Не удалось удалить: ${e?.message || e}`);
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
  const name = $('f-brand-name')?.value || 'Hookah POS';

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

const ADMIN_NAV = [
  { id: 'overview', icon: 'home', color: '#2F6FED', label: 'Обзор' },
  { id: 'tenants', icon: 'building', color: '#6366F1', label: 'Заведения' },
  { id: 'plans', icon: 'gem', color: '#8B5CF6', label: 'Тарифы' },
  { id: 'builds', icon: 'device', color: '#0EA5E9', label: 'Сборки APK' },
  { id: 'broadcasts', icon: 'bell', color: '#FB923C', label: 'Объявления' },
  { id: 'support', icon: 'chat', color: '#22C55E', label: 'Поддержка' },
  { id: 'staff', icon: 'badge', color: '#F97316', label: 'Сотрудники платформы' },
  { id: 'audit', icon: 'list', color: '#94A3B8', label: 'Журнал' },
  { id: 'security', icon: 'lock', color: '#DC2626', label: 'Безопасность' },
];

function adminNavHtml(activeTab) {
  const activeMeta = ADMIN_NAV.find((t) => t.id === activeTab);
  // Супер-админ без своего заведения по умолчанию и так уже здесь (см.
  // route()) — "В консоль" вёл бы его в никуда (обратно на эту же панель).
  // Ему нужен не переход назад, а явный путь завести СВОЁ заведение, если
  // он вообще этого хочет.
  const consoleLink = state.tenants.length
    ? `<a href="#/" class="nav-item" style="text-decoration:none">${navIconHtml('back', '#64748B')}<span>В консоль</span></a>`
    : `<a href="#/onboarding" class="nav-item" style="text-decoration:none">${navIconHtml('plus', '#22C55E')}<span>Своё заведение</span></a>`;
  return `
    <div class="dash-topbar">
      <button class="hamburger-btn" id="f-admin-nav-open">☰</button>
      <div class="dash-topbar-title">
        <div class="dash-topbar-tenant">Hookah POS · платформа</div>
        <div class="dash-topbar-tab">${esc(activeMeta?.label || '')}</div>
      </div>
    </div>
    <div class="nav-backdrop" id="admin-nav-backdrop"></div>
    <div class="nav-drawer" id="admin-nav-drawer">
      <div class="nav-drawer-brand">Hookah POS</div>
      <div class="nav-drawer-tenant">Панель платформы</div>
      ${ADMIN_NAV.map((t) => `
        <button class="nav-item${t.id === activeTab ? ' active' : ''} f-admin-tab" data-tab="${t.id}">
          ${navIconHtml(t.icon, t.color)}
          <span>${esc(t.label)}</span>
        </button>
      `).join('')}
      <div class="nav-divider"></div>
      ${consoleLink}
      <div class="nav-divider"></div>
      <button class="nav-item" id="f-admin-signout">
        ${navIconHtml('logout', '#475569')}<span>Выйти</span>
      </button>
    </div>
  `;
}

function screenSuperAdmin() {
  screenEl().classList.add('has-tabbar');
  screenEl().innerHTML = `
    <div id="admin-root">
      ${adminNavHtml('overview')}

      <div class="admin-tab-panel active" data-panel="overview">
        <h1>Обзор</h1>
        <h2>Требует внимания</h2>
        <div id="admin-attention"><div class="spinner"></div></div>

        <h2>Инфраструктура</h2>
        <div class="admin-stat-grid">
          <div class="card" style="text-align:center;padding:14px 8px">
            <div id="admin-infra-gateway-status" style="font-size:16px;font-weight:700">…</div>
            <div class="small muted">saas-gateway</div>
          </div>
          <div class="card" style="text-align:center;padding:14px 8px">
            <div id="admin-infra-stuck-count" style="font-size:22px;font-weight:700">—</div>
            <div class="small muted">Зависших сборок</div>
          </div>
        </div>
        <button class="btn btn-ghost" id="f-recalculate-usage" style="width:auto;margin:6px 0 14px">Пересчитать лимиты сейчас</button>

        <h2>Аналитика</h2>
        <div id="admin-analytics"><div class="spinner"></div></div>
        <button class="btn btn-ghost" id="f-export-payments-csv" style="width:auto;margin:10px 0 14px">Экспорт последних платежей в CSV</button>
      </div>

      <div class="admin-tab-panel" data-panel="tenants">
        <h1>Заведения</h1>
        <div class="row" style="margin-bottom:14px;flex-wrap:wrap">
          <input id="f-tenant-search" class="grow" placeholder="Название, код или email владельца" style="min-width:220px">
          <select id="f-tenant-status-filter" style="width:auto">
            <option value="">Все статусы</option>
            <option value="trial">Пробный период</option>
            <option value="active">Активно</option>
            <option value="pastDue">Просрочена оплата</option>
            <option value="suspended">Приостановлено</option>
            <option value="cancelled">Отменено</option>
          </select>
          <button class="btn btn-ghost" id="f-export-tenants-csv" style="width:auto">Экспорт в CSV</button>
        </div>
        <div id="admin-body"><div class="spinner"></div></div>
      </div>

      <div class="admin-tab-panel" data-panel="plans">
        <h1>Тарифы</h1>
        <div id="admin-plans"><div class="spinner"></div></div>
        <button class="btn btn-ghost" id="f-new-plan" style="width:auto;margin-bottom:14px">Добавить тариф</button>
      </div>

      <div class="admin-tab-panel" data-panel="builds">
        <h1>Сборки APK</h1>
        <div id="admin-builds"><div class="spinner"></div></div>
      </div>

      <div class="admin-tab-panel" data-panel="broadcasts">
        <h1>Объявления</h1>
        <p class="small muted">Показываются баннером на "Обзоре" личного кабинета всем владельцам, пока объявление активно.</p>
        <div class="card">
          <label class="field"><span>Заголовок</span>
            <input id="f-broadcast-title" placeholder="Например: Новая функция — учёт переработки">
          </label>
          <label class="field"><span>Текст</span>
            <textarea id="f-broadcast-body" rows="3" placeholder="Коротко, что изменилось и что нужно сделать"></textarea>
          </label>
          <button class="btn btn-primary" id="f-broadcast-publish">Опубликовать</button>
        </div>
        <div id="admin-broadcasts"><div class="spinner"></div></div>
      </div>

      <div class="admin-tab-panel" data-panel="support">
        <h1>Поддержка</h1>
        <div id="admin-support"><div class="spinner"></div></div>
      </div>

      <div class="admin-tab-panel" data-panel="staff">
        <h1>Сотрудники платформы</h1>
        <p class="small muted">Есть полный доступ к панели платформы — назначайте
        только тем, кому лично доверяете. Кандидат должен СНАЧАЛА сам
        зарегистрироваться в этой консоли и подтвердить почту —
        только тогда его можно найти по email и назначить.</p>
        <div id="admin-super-admins"><div class="spinner"></div></div>
        <div class="card">
          <label class="field"><span>Назначить супер-админом по email</span>
            <input id="f-super-admin-email" type="email" placeholder="coworker@example.com">
          </label>
          <button class="btn btn-ghost" id="f-super-admin-grant">Назначить</button>
          <div id="f-super-admin-error" class="small" style="color:var(--danger);margin-top:8px"></div>
        </div>
      </div>

      <div class="admin-tab-panel" data-panel="audit">
        <h1>Журнал платформы</h1>
        <div id="admin-audit"><div class="spinner"></div></div>
      </div>

      <div class="admin-tab-panel" data-panel="security">
        <h1>Безопасность</h1>
        <p class="small muted">Раздел в разработке.</p>
      </div>

      ${versionFooterHtml()}
    </div>
  `;

  document.querySelectorAll('.f-admin-tab').forEach((el) => {
    el.onclick = () => {
      const tab = el.dataset.tab;
      document.querySelectorAll('.f-admin-tab').forEach((b) => b.classList.toggle('active', b === el));
      document.querySelectorAll('.admin-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
      const topbarTab = document.querySelector('.dash-topbar-tab');
      if (topbarTab) topbarTab.textContent = ADMIN_NAV.find((t) => t.id === tab)?.label || '';
      closeAdminNav();
    };
  });
  const adminNavDrawer = $('admin-nav-drawer');
  const adminNavBackdrop = $('admin-nav-backdrop');
  function closeAdminNav() {
    adminNavDrawer?.classList.remove('open');
    adminNavBackdrop?.classList.remove('open');
  }
  if ($('f-admin-nav-open')) {
    $('f-admin-nav-open').onclick = () => {
      adminNavDrawer?.classList.add('open');
      adminNavBackdrop?.classList.add('open');
    };
  }
  if (adminNavBackdrop) adminNavBackdrop.onclick = closeAdminNav;
  if ($('f-admin-signout')) $('f-admin-signout').onclick = () => signOut(state.auth);

  watchAllTenants();
  watchAuditLog();
  watchPlans();
  watchAnalytics();
  watchSuperAdmins();
  watchAllBuildJobs();
  watchAdminInfra();
  watchAdminBroadcasts();
  watchAdminSupportTickets();
}

/** Обращения в поддержку — вкладка "Поддержка" панели платформы (супер-админ
 *  #3). Тот же приём "раскрыть карточку -> подгрузить сообщения отдельной
 *  подпиской", что и selectTicket() в личном кабинете владельца (см.
 *  watchDashboardData) — только здесь список тикетов один на всю
 *  платформу (без where по tenantId, супер-админ читает всё правилами). */
function watchAdminSupportTickets() {
  const body = $('admin-support');
  let tickets = [];
  let tenantNames = new Map();
  let expandedId = null;
  let messages = null;
  let unsubMessages = null;

  const selectTicket = (ticketId) => {
    if (unsubMessages) { unsubMessages(); unsubMessages = null; }
    expandedId = expandedId === ticketId ? null : ticketId;
    messages = null;
    if (expandedId) {
      unsubMessages = onSnapshot(
        query(collection(state.db, 'supportTickets', expandedId, 'messages'), orderBy('createdAt', 'asc')),
        (snap) => { messages = snap.docs.map((d) => d.data()); draw(); }
      );
    }
    draw();
  };
  sub(() => { if (unsubMessages) unsubMessages(); });

  const draw = () => {
    if (!tickets.length) {
      body.innerHTML = '<p class="small muted">Обращений пока не было.</p>';
      return;
    }
    // Открытые — наверх, внутри групп новые сверху (тот же порядок, что и
    // источник запроса, orderBy('updatedAt','desc') ниже).
    const sorted = tickets.slice().sort((a, b) => {
      const rank = (t) => (t.status === 'closed' ? 1 : 0);
      return rank(a) - rank(b);
    });
    body.innerHTML = `<div class="card">${sorted.map((t) => `
      <div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div class="row f-admin-ticket-open" data-id="${esc(t.id)}" style="justify-content:space-between;align-items:center;cursor:pointer">
          <div class="small grow" style="min-width:0">
            <b>${esc(t.subject || '')}</b> · ${esc(tenantNames.get(t.tenantId) || t.tenantId)}
            <div class="muted">${fmtDateTime(t.updatedAt || t.createdAt)}</div>
          </div>
          <div class="small muted">${t.status === 'closed' ? 'Решено' : 'Открыто'}</div>
        </div>
        ${expandedId === t.id ? `
          <div style="margin-top:10px">
            ${messages === null ? '<div class="spinner"></div>' : (messages.length ? messages.map((m) => `
              <div style="margin:6px 0;padding:8px 10px;border-radius:10px;background:${m.authorRole === 'super_admin' ? 'var(--surface-2)' : 'transparent'};border:1px solid var(--border)">
                <div class="small muted">${esc(m.authorRole === 'super_admin' ? 'Платформа' : 'Владелец')} · ${fmtDateTime(m.createdAt)}</div>
                <div class="small" style="margin-top:2px;white-space:pre-wrap">${esc(m.text || '')}</div>
              </div>
            `).join('') : '<p class="small muted">Сообщений пока нет.</p>')}
            <textarea class="f-admin-ticket-reply" data-id="${esc(t.id)}" rows="2" placeholder="Ответ владельцу..." style="width:100%;resize:vertical;margin-top:6px"></textarea>
            <button class="btn btn-primary f-admin-ticket-send" data-id="${esc(t.id)}" style="margin-top:6px">Отправить</button>
            <button class="btn-link f-admin-ticket-toggle" data-id="${esc(t.id)}" data-status="${esc(t.status)}" style="width:auto;margin-top:6px">
              ${t.status === 'closed' ? 'Переоткрыть' : 'Отметить решённым'}
            </button>
          </div>
        ` : ''}
      </div>
    `).join('')}</div>`;

    document.querySelectorAll('.f-admin-ticket-open').forEach((el) => {
      el.onclick = () => selectTicket(el.dataset.id);
    });
    document.querySelectorAll('.f-admin-ticket-send').forEach((el) => {
      el.onclick = async () => {
        const ticketId = el.dataset.id;
        const textEl = document.querySelector(`.f-admin-ticket-reply[data-id="${ticketId}"]`);
        const text = textEl.value.trim();
        if (!text) return;
        el.disabled = true;
        try {
          const now = Timestamp.fromDate(new Date());
          await addDoc(collection(state.db, 'supportTickets', ticketId, 'messages'), {
            text, authorUid: state.uid, authorRole: 'super_admin', createdAt: now,
          });
          await setDoc(doc(state.db, 'supportTickets', ticketId), { updatedAt: now }, { merge: true });
          textEl.value = '';
        } catch (e) {
          toast(`Не удалось отправить: ${e?.message || e}`);
        } finally {
          el.disabled = false;
        }
      };
    });
    document.querySelectorAll('.f-admin-ticket-toggle').forEach((el) => {
      el.onclick = async () => {
        try {
          await setDoc(doc(state.db, 'supportTickets', el.dataset.id), {
            status: el.dataset.status === 'closed' ? 'open' : 'closed',
            updatedAt: Timestamp.fromDate(new Date()),
          }, { merge: true });
        } catch (e) {
          toast(`Не удалось изменить статус: ${e?.message || e}`);
        }
      };
    });
  };

  sub(onSnapshot(query(collection(state.db, 'supportTickets'), orderBy('updatedAt', 'desc'), limit(100)), async (snap) => {
    tickets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    await Promise.all([...new Set(tickets.map((t) => t.tenantId))].filter((id) => !tenantNames.has(id)).map(async (id) => {
      try {
        const tSnap = await getDoc(doc(state.db, 'tenants', id));
        tenantNames.set(id, tSnap.exists() ? tSnap.data().name : id);
      } catch (_) {
        tenantNames.set(id, id);
      }
    }));
    draw();
  }, () => {
    body.innerHTML = '<p class="small muted">Обращения недоступны.</p>';
  }));
}

/** Объявления платформы (панель супер-админа, вкладка "Объявления") — прямая
 *  запись в Firestore под isSuperAdmin(), тот же приём, что у watchPlans()/
 *  savePlan() (без похода в saas-gateway, там нечего проверять сверх того,
 *  что уже проверяют правила). */
function watchAdminBroadcasts() {
  const body = $('admin-broadcasts');
  sub(onSnapshot(query(collection(state.db, 'broadcasts'), orderBy('createdAt', 'desc'), limit(30)), (snap) => {
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    body.innerHTML = items.length ? `<div class="card">${items.map((b) => `
      <div class="row" style="justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border)">
        <div class="small grow" style="min-width:0">
          <b>${esc(b.title || '')}</b>${b.active ? '' : ' <span class="muted">(снято)</span>'}
          <div class="muted">${esc(b.body || '')}</div>
          <div class="muted">${fmtDateTime(b.createdAt)}</div>
        </div>
        <button class="btn-link f-broadcast-toggle" data-id="${esc(b.id)}" data-active="${b.active ? '1' : '0'}" style="width:auto;flex-shrink:0">
          ${b.active ? 'Снять' : 'Вернуть'}
        </button>
      </div>
    `).join('')}</div>` : '<p class="small muted">Объявлений пока не было.</p>';

    document.querySelectorAll('.f-broadcast-toggle').forEach((el) => {
      el.onclick = async () => {
        el.disabled = true;
        try {
          await setDoc(doc(state.db, 'broadcasts', el.dataset.id), { active: el.dataset.active !== '1' }, { merge: true });
        } catch (e) {
          toast(`Не удалось изменить объявление: ${e?.message || e}`);
          el.disabled = false;
        }
      };
    });
  }, () => {
    body.innerHTML = '<p class="small muted">Объявления недоступны.</p>';
  }));

  if ($('f-broadcast-publish')) {
    $('f-broadcast-publish').onclick = async () => {
      const titleEl = $('f-broadcast-title');
      const bodyEl = $('f-broadcast-body');
      const title = titleEl.value.trim();
      const text = bodyEl.value.trim();
      if (!title || !text) {
        toast('Заполните заголовок и текст');
        return;
      }
      const btn = $('f-broadcast-publish');
      btn.disabled = true;
      try {
        await addDoc(collection(state.db, 'broadcasts'), {
          title, body: text, active: true, createdAt: Timestamp.fromDate(new Date()), createdBy: state.uid,
        });
        titleEl.value = '';
        bodyEl.value = '';
        toast('Объявление опубликовано');
      } catch (e) {
        toast(`Не удалось опубликовать: ${e?.message || e}`);
      } finally {
        btn.disabled = false;
      }
    };
  }
}

// Порог, после которого сборка в очереди считается зависшей (воркер на
// сервере обычно забирает задачу за секунды) — тот же смысл, что и
// GRACE_PERIOD_DAYS для подписок: не точная диагностика, а сигнал
// «сюда стоит заглянуть».
const STUCK_BUILD_MINUTES = 30;

/** Инфраструктура на "Обзоре": жив ли saas-gateway (публичный /health, без
 *  токена) и кнопка ручного пересчёта usage/current — до этой правки
 *  calculateUsage вообще не запускался нигде (Cloud Function, которую
 *  забыли перенести при уходе с Blaze), т.е. лимиты тарифов никогда не
 *  обновлялись сами. Счётчик зависших сборок считается отдельным
 *  снапшотом (не переиспользует watchAllBuildJobs — тому нужен только
 *  последний экран из 50 записей, а здесь важны именно все status=queued
 *  независимо от возраста остальных). */
function watchAdminInfra() {
  const statusEl = $('admin-infra-gateway-status');
  fetch(`${SAAS_GATEWAY_URL}/health`)
    .then((r) => {
      if (!statusEl) return;
      statusEl.innerHTML = r.ok
        ? '<span style="color:var(--primary)">● жив</span>'
        : `<span style="color:var(--danger)">● ошибка ${r.status}</span>`;
    })
    .catch(() => {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">● недоступен</span>';
    });

  const stuckEl = $('admin-infra-stuck-count');
  sub(onSnapshot(query(collection(state.db, 'buildJobs'), where('status', '==', 'queued')), (snap) => {
    if (!stuckEl) return;
    const threshold = Date.now() - STUCK_BUILD_MINUTES * 60 * 1000;
    const stuck = snap.docs.filter((d) => {
      const createdAt = d.data().createdAt;
      const ms = createdAt && typeof createdAt.toDate === 'function' ? createdAt.toDate().getTime() : 0;
      return ms && ms < threshold;
    }).length;
    stuckEl.textContent = String(stuck);
    stuckEl.style.color = stuck > 0 ? 'var(--danger)' : '';
  }, () => {
    if (stuckEl) stuckEl.textContent = '—';
  }));

  if ($('f-recalculate-usage')) {
    $('f-recalculate-usage').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Пересчитываем…';
      try {
        await callSaasGateway('recalculateUsage', {});
        toast('Лимиты пересчитаны');
      } catch (err) {
        toast(err.message || 'Не удалось пересчитать');
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    };
  }
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
      const [membersSnap, inviteSnap, notesSnap, historySnap] = await Promise.all([
        getDocs(query(collection(state.db, 'tenantMembers'), where('tenantId', '==', tenantId))),
        getDoc(doc(state.db, 'tenants', tenantId, 'settings', 'deviceInvite')),
        getDoc(doc(state.db, 'tenants', tenantId, 'internal', 'adminNotes')),
        getDocs(query(collection(state.db, 'auditLogs'), where('tenantId', '==', tenantId), orderBy('createdAt', 'desc'), limit(20))),
      ]);
      detailsCache.set(tenantId, {
        members: membersSnap.docs.map((d) => d.data()),
        invite: inviteSnap.exists() ? inviteSnap.data() : null,
        notes: notesSnap.exists() ? (notesSnap.data().text || '') : '',
        history: historySnap.docs.map((d) => d.data()),
      });
    } catch (_) {
      detailsCache.set(tenantId, { members: [], invite: null, notes: '', history: [] });
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

  const grantBonusPeriod = async (tenantId) => {
    const input = prompt('На сколько дней продлить доступ этому заведению? (от 1 до 365)');
    if (input === null) return;
    const days = Number(input);
    if (!Number.isFinite(days) || days <= 0 || days > 365) {
      toast('Введите число дней от 1 до 365');
      return;
    }
    const btn = document.querySelector(`.f-grant-bonus[data-id="${tenantId}"]`);
    if (btn) btn.disabled = true;
    try {
      // Отдельный эндпоинт saas-gateway, а не прямая запись в subscriptions
      // (как saveSubscriptionOverride выше) — нужен аудит-лог (кто и сколько
      // дней выдал), а писать в auditLogs с клиента правила не дают ни при
      // каких условиях (allow write: if false — только Admin SDK).
      await callSaasGateway('grantBonusPeriod', { tenantId, days });
      toast(`Выдано ${days} ${pluralDays(days)}`);
    } catch (e) {
      toast(`Не удалось выдать бонус: ${e?.message || e}`);
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

        <div style="margin-top:14px">
          <button class="btn-link f-grant-bonus" data-id="${esc(t.id)}" style="width:auto">🎁 Выдать бонусный период</button>
        </div>

        <div style="margin-top:14px">
          <div class="small muted" style="margin-bottom:6px">История тарифа и статуса (последние 20 записей)</div>
          ${(d.history || []).length ? (d.history || []).map((e) => `
            <div class="small" style="padding:2px 0">${fmtDateTime(e.createdAt)} — ${esc(AUDIT_ACTION_LABELS[e.action] || e.action)}</div>
          `).join('') : '<div class="small muted">Событий пока нет</div>'}
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
      const limitWarnings = planLimitWarnings(t, plans);
      if (limitWarnings.length) {
        items.push({
          danger: false,
          text: `«${t.name || t.id}» — превысило лимит тарифа: ${limitWarnings.join(', ')} — повод предложить тариф выше`,
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
      const rank = (t) => {
        if (t.daysLeft !== null && t.daysLeft !== undefined) return 0;
        if (t.trialEndingSoonDays !== null && t.trialEndingSoonDays !== undefined) return 1;
        if (planLimitWarnings(t, plans).length) return 2;
        return 3;
      };
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
              ${t.subscription?.cancelAtPeriodEnd ? ' · автопродление отключено владельцем' : ''}
            </div>
            ${t.subscription?.cancelAtPeriodEnd && t.subscription?.cancelReason ? `
              <div class="small muted">Причина отмены: «${esc(t.subscription.cancelReason)}»</div>
            ` : ''}
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
            ${(() => {
              const limitWarnings = planLimitWarnings(t, plans);
              return limitWarnings.length ? `
                <div class="small" style="color:var(--warning);margin-top:4px">⚠ Превышен лимит тарифа: ${esc(limitWarnings.join(', '))}</div>
              ` : '';
            })()}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
            <button class="btn-ghost f-tenant-toggle" data-id="${esc(t.id)}"
              data-suspended="${t.status === 'suspended' ? '1' : '0'}" style="width:auto">
              ${t.status === 'suspended' ? 'Разблокировать' : 'Заблокировать'}
            </button>
            ${t.demo ? `
              <button class="btn-ghost f-tenant-delete-demo" data-id="${esc(t.id)}"
                style="width:auto;color:var(--danger)">Удалить</button>
            ` : ''}
          </div>
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
    document.querySelectorAll('.f-tenant-delete-demo').forEach((el) => {
      el.onclick = () => deleteDemoTenant(el.dataset.id);
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
    document.querySelectorAll('.f-grant-bonus').forEach((el) => {
      el.onclick = () => grantBonusPeriod(el.dataset.id);
    });
  };

  $('f-tenant-search').addEventListener('input', draw);
  $('f-tenant-status-filter').addEventListener('change', draw);

  getDocs(collection(state.db, 'plans')).then((snap) => {
    plans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
    drawAttention(); // лимиты тарифа в "Требует внимания" зависят от plans, а не только от tenants
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
      downloadCsv(`hookah-pos-заведения-${new Date().toISOString().slice(0, 10)}.csv`, rows);
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

function watchAllBuildJobs() {
  const body = $('admin-builds');
  const q = query(collection(state.db, 'buildJobs'), orderBy('createdAt', 'desc'), limit(50));
  sub(onSnapshot(q, async (snap) => {
    const jobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Имя заведения по tenantId — buildJobs его не хранит. До полусотни
    // лишних чтений на панель, которую открывает не каждый визит, это
    // не проблема (тот же порядок, что уже используется для usage/subscription
    // в watchAllTenants).
    await Promise.all(jobs.map(async (j) => {
      try {
        const tSnap = await getDoc(doc(state.db, 'tenants', j.tenantId));
        j.tenantName = tSnap.exists() ? tSnap.data().name : j.tenantId;
      } catch (_) {
        j.tenantName = j.tenantId;
      }
    }));
    body.innerHTML = jobs.length ? `<div class="card">${jobs.map((j) => `
      <div class="row" style="justify-content:space-between;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border)">
        <div class="small grow" style="min-width:0">
          <b>${esc(j.tenantName || j.tenantId)}</b> ·
          ${esc(BUILD_TYPE_LABELS[j.type] || j.type || '')} ·
          <span style="${j.status === 'failed' ? 'color:var(--danger)' : ''}">${esc(BUILD_STATUS_LABELS[j.status] || j.status)}</span>
          ${j.status === 'failed' && j.errorMessage ? `<div class="muted">${esc(j.errorMessage)}</div>` : ''}
        </div>
        <div class="small" style="text-align:right;flex-shrink:0">
          <div class="muted">${fmtDateTime(j.createdAt)}</div>
          ${j.status === 'failed' ? `<button class="btn-link f-retry-build" data-tenant="${esc(j.tenantId)}" style="width:auto;padding:2px 0">Пересобрать</button>` : ''}
        </div>
      </div>
    `).join('')}</div>` : '<p class="small muted">Сборок пока не было.</p>';

    document.querySelectorAll('.f-retry-build').forEach((el) => {
      el.onclick = async () => {
        el.disabled = true;
        el.textContent = 'Запускаем…';
        try {
          await callSaasGateway('createBuildJob', { tenantId: el.dataset.tenant });
          toast('Пересборка запущена');
        } catch (err) {
          toast(err.message || 'Не удалось запустить пересборку');
          el.disabled = false;
          el.textContent = 'Пересобрать';
        }
      };
    });
  }, () => {
    body.innerHTML = '<p class="small muted">Сборки недоступны.</p>';
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
        <label class="field"><span>Пробный период, дней (при создании заведения на этом тарифе)</span>
          <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="trialDays" value="${Number(p.trialDays) || 7}">
        </label>
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
        trialDays: 7, aiEnabled: false, customBranding: false, customDomain: false,
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

// Простой бар-чарт без библиотек — несколько div'ов с высотой в процентах
// от максимума, как и остальные "плитки" этой панели (admin-stat-grid) не
// тянут отдельную зависимость ради одного графика.
function barChartHtml(points, formatValue) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return `
    <div style="display:flex;align-items:flex-end;gap:3px;height:90px;margin-top:8px">
      ${points.map((p) => `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%" title="${esc(p.label)}: ${esc(formatValue(p.value))}">
          <div style="width:100%;min-height:2px;height:${Math.round((p.value / max) * 100)}%;background:var(--primary);border-radius:3px 3px 0 0"></div>
        </div>
      `).join('')}
    </div>
    <div class="row small muted" style="justify-content:space-between;margin-top:4px">
      <span>${esc(points[0]?.label || '')}</span>
      <span>${esc(points[points.length - 1]?.label || '')}</span>
    </div>
  `;
}

function watchAnalytics() {
  const body = $('admin-analytics');

  const draw = (tenants, revenueEvents, metrics) => {
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

    // Регистрации по дням — считаются на лету из уже загруженных tenants
    // (createdAt есть у каждого заведения с самого начала, снимок для этого
    // не нужен). MRR по дням — наоборот, ТОЛЬКО из снимков platformMetrics:
    // это метрика "на текущий момент" (активные подписки × цена тарифа),
    // её нельзя восстановить задним числом без сохранённой истории.
    const REGS_TREND_DAYS = 14;
    const dayKey = (ms) => new Date(ms).toISOString().slice(5, 10);
    const regsByDay = new Map();
    tenants.forEach((t) => {
      if (!t.createdAt?.toMillis) return;
      const ageDays = Math.floor((now - t.createdAt.toMillis()) / day);
      if (ageDays < 0 || ageDays >= REGS_TREND_DAYS) return;
      const key = dayKey(t.createdAt.toMillis());
      regsByDay.set(key, (regsByDay.get(key) || 0) + 1);
    });
    const regsTrendPoints = Array.from({ length: REGS_TREND_DAYS }, (_, i) => {
      const ms = now - (REGS_TREND_DAYS - 1 - i) * day;
      const key = dayKey(ms);
      return { label: key, value: regsByDay.get(key) || 0 };
    });
    const mrrTrendPoints = (metrics || []).map((m) => ({ label: (m.date || '').slice(5), value: Number(m.mrr) || 0 }));

    body.innerHTML = `
      <div class="admin-stat-grid">
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
      <div class="card" style="margin-top:14px">
        <div class="small muted">Регистрации по дням (последние ${REGS_TREND_DAYS} дней)</div>
        ${barChartHtml(regsTrendPoints, (v) => String(v))}
      </div>
      <div class="card" style="margin-top:14px">
        <div class="small muted">MRR по дням</div>
        ${mrrTrendPoints.length ? barChartHtml(mrrTrendPoints, (v) => `${v.toLocaleString('ru-RU')} ₽`) : `
          <p class="small muted" style="margin-top:8px">Снимков пока нет — появятся начиная с сегодняшнего дня (суточный таймер saas-gateway) или сразу после нажатия «Пересчитать сейчас» в разделе «Инфраструктура».</p>
        `}
      </div>
    `;
  };

  let tenants = null;
  let revenueEvents = null;
  let metrics = null;
  const maybeDraw = () => { if (tenants && revenueEvents && metrics) draw(tenants, revenueEvents, metrics); };

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

  // orderBy('date','desc') + .reverse(), а не сразу 'asc' с limit(30), —
  // иначе limit(30) в порядке "по возрастанию" взял бы САМЫЕ СТАРЫЕ 30
  // снимков, а не последние 30 (нужные для графика).
  sub(onSnapshot(query(collection(state.db, 'platformMetrics'), orderBy('date', 'desc'), limit(30)), (snap) => {
    metrics = snap.docs.map((d) => d.data()).reverse();
    maybeDraw();
  }, () => { metrics = []; maybeDraw(); }));

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
    downloadCsv(`hookah-pos-платежи-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  } catch (e) {
    toast(`Не удалось выгрузить платежи: ${e?.message || e}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// enableTenant/disableTenant/changeTenantPlan/deleteDemoTenant — не Cloud
// Functions (Blaze недоступен, см. docstring в saas-gateway/server.js), а
// свой сервис, см. callSaasGateway/SAAS_GATEWAY_URL выше — раньше эти три
// кнопки звали httpsCallable на функции, которых физически не существует
// (не задеплоены), и молча проваливались.
async function toggleTenantSuspension(tenantId, isSuspended) {
  try {
    await callSaasGateway(isSuspended ? 'enableTenant' : 'disableTenant',
      isSuspended ? { tenantId } : { tenantId, reason: 'Заблокировано вручную из консоли платформы' });
    toast(isSuspended ? 'Заведение разблокировано' : 'Заведение заблокировано');
  } catch (e) {
    toast(`Не удалось изменить статус: ${e?.message || e}`);
  }
}

async function changeTenantPlan(tenantId, planId) {
  try {
    await callSaasGateway('changeTenantPlan', { tenantId, planId });
    toast('Тариф изменён');
  } catch (e) {
    toast(`Не удалось изменить тариф: ${e?.message || e}`);
  }
}

async function deleteDemoTenant(tenantId) {
  if (!confirm('Удалить это демо-заведение безвозвратно вместе со всеми данными?')) return;
  if (!(await reauthenticate('удалить заведение безвозвратно'))) return;
  try {
    await callSaasGateway('deleteDemoTenant', { tenantId });
    toast('Демо-заведение удалено');
  } catch (e) {
    toast(`Не удалось удалить: ${e?.message || e}`);
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
    if (!(await reauthenticate(`назначить супер-админом ${email}`))) return;
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
  if (!(await reauthenticate('снять доступ супер-админа'))) return;
  try {
    await deleteDoc(doc(state.db, 'superAdmins', uid));
    toast('Доступ снят');
  } catch (e) {
    toast(`Не удалось снять доступ: ${e?.message || e}`);
  }
}

// ---------- ПОДПИСКА (ЮKASSA) И СБОРКА APK ----------

// Возвращает true/false — раньше вызывающие места об исходе не узнавали
// вообще (ошибка тихо оседала в f-checkout-error, которого на некоторых
// экранах, например онбординге, попросту нет — там "оплата не началась"
// выглядела бы как ничего не произошло, без единого объяснения).
async function startCheckout(tenantId, planId, billingPeriod) {
  const errEl = $('f-checkout-error');
  if (errEl) errEl.textContent = '';
  try {
    // Раньше — httpsCallable Cloud Function, которая не может задеплоиться
    // без тарифа Blaze (см. docstring в начале saas-gateway/server.js) —
    // теперь тот же самый эндпойнт, но на своём сервере.
    const res = await callSaasGateway('createCheckoutSession', {
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
      return true;
    }
    throw new Error('ЮKassa не вернула ссылку на оплату');
  } catch (e) {
    if (errEl) errEl.textContent = `Не удалось начать оплату: ${e?.message || e}`;
    return false;
  }
}

async function requestBuild(tenantId) {
  const errEl = $('f-build-error');
  if (errEl) errEl.textContent = '';
  const btn = $('f-request-build');
  if (btn) btn.disabled = true;
  try {
    // createBuildJob — не Cloud Function (Blaze для неё сейчас недоступен),
    // а свой сервис, см. callSaasGateway/SAAS_GATEWAY_URL выше.
    await callSaasGateway('createBuildJob', { tenantId });
    toast('Сборка запущена — обычно занимает 5–10 минут');
  } catch (e) {
    if (errEl) errEl.textContent = `Не удалось запустить сборку: ${e?.message || e}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Универсальная сборка кассы для кнопки "Скачать" на лендинге — не привязана
// ни к одному заведению (кто угодно, даже не зарегистрированный, должен
// суметь её скачать). Лежит на собственном сервере владельца платформы
// (том же, что pii-gateway/saas-gateway — pii.hookahpos.su), статикой через
// nginx (location /downloads/, см. saas/README.md, раздел «Публичный APK»).
//
// НЕ Firebase Storage: у saas-3bdc8 Storage требует план Blaze, которого
// нет. НЕ GitHub Release: пробовали — у части пользователей в России
// зависало скачивание независимо от VPN (видимо, сеть до CDN
// objects.githubusercontent.com/Amazon S3 нестабильна), при этом с
// обычного сервера (в том числе с этого же сервера) тот же файл скачивался
// полностью и без проблем — поэтому раздача переехала туда же.
const PUBLIC_APK_URL = 'https://pii.hookahpos.su/downloads/hookah-pos-public.apk';

function downloadPublicApk() {
  window.open(PUBLIC_APK_URL, '_blank', 'noopener');
}

// Личная сборка заведения (в отличие от универсальной PUBLIC_APK_URL выше)
// лежит на том же собственном сервере, но НЕ статикой через nginx — она
// привязана к конкретному заведению (лого/название), поэтому просто так
// её не отдать. Раньше это делалось через fetch()+заголовок Authorization,
// но на реальном телефоне пользователя браузер (по всей видимости) молча
// блокировал такой запрос — кнопка визуально ничего не делала, без единой
// ошибки в интерфейсе. Разбираться в этом дальше без доступа к консоли
// разработчика на его телефоне бессмысленно, поэтому сам механизм
// скачивания упрощён до ТОГО ЖЕ window.open(), что и у публичного APK
// (downloadPublicApk выше) — разница только в том, что ссылка одноразовая
// и живёт 60 секунд (см. handleGetDownloadUrl/DOWNLOAD_TOKEN_TTL_MS в
// saas-gateway/server.js): её ещё нужно СНАЧАЛА получить обычным POST с
// Firebase Auth, так что чужую сборку по угаданному jobId не скачать.
async function downloadBuild(jobId) {
  try {
    const { data } = await callSaasGateway('getDownloadUrl', { jobId });
    window.open(`${SAAS_GATEWAY_URL}${data.url}`, '_blank', 'noopener');
  } catch (e) {
    toast(`Не удалось получить файл: ${e?.message || e}`);
  }
}
