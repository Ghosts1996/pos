// Личный кабинет владельца заведения и панель платформы ZalPOS.
// Без сборки: ES-модули Firebase прямо с CDN, конфиг Firebase берётся с
// хостинга (/__/firebase/init.json).

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
  collection, query, where, orderBy, limit, Timestamp, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// saas-gateway — сервер платформы (saas-gateway/README.md), живёт на том же
// домене, что и pii-gateway, по пути /saas/.
const SAAS_GATEWAY_URL = 'https://pii.zalpos.ru/saas';
// pii-gateway — первичная запись персональных данных в РФ.
const PII_GATEWAY_URL = 'https://pii.zalpos.ru/';

/** Email владельца и отметки о согласиях сначала пишутся в базу в РФ
 *  (ч. 5 ст. 18 152-ФЗ) и только потом в Firebase Auth. Не записалось —
 *  регистрацию не продолжаем. */
async function recordOwnerInRussia(email) {
  let res;
  try {
    res = await fetch(PII_GATEWAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'owner', email, offer: true, pdConsent: true, edition: LEGAL_EDITION }),
    });
  } catch (_) {
    throw new Error('Сервер регистрации недоступен — проверьте интернет и попробуйте ещё раз');
  }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error || ''; } catch (_) {}
    throw new Error(msg || `Сервер регистрации ответил ${res.status} — попробуйте через минуту`);
  }
}

/** После первого входа — привязать запись в РФ к аккаунту (не критично). */
async function linkOwnerInRussia(user) {
  try {
    const token = await user.getIdToken();
    await fetch(PII_GATEWAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: 'owner_link' }),
    });
  } catch (_) { /* привяжется при следующем входе */ }
}

// Прежние названия платформы. Их сохраняла форма «Брендинг» по умолчанию,
// поэтому в базе они означают «название не задано», а не имя заведения.
const LEGACY_PLATFORM_NAMES = ['Hookah POS', 'Hoocah POS', 'HookahPOS'];

// Платформа переехала с hookahpos.su на zalpos.ru. Старый адрес ведёт на
// новый — но только когда новый уже открывается (домен подключён к
// хостингу и выпущен сертификат), иначе консоль осталась бы недоступной.
if (/(^|\.)hookahpos\.su$/.test(location.hostname)) {
  fetch('https://zalpos.ru/', { method: 'HEAD', mode: 'no-cors', cache: 'no-store' })
    .then(() => location.replace(`https://zalpos.ru${location.pathname}${location.search}${location.hash}`))
    .catch(() => {});
}

/** Вызов saas-gateway с ID-токеном пользователя. Бросает Error с текстом,
 *  который можно показать пользователю. */
async function callSaasGateway(path, data, { forceRefresh = false } = {}) {
  if (!SAAS_GATEWAY_URL) {
    throw new Error(
      'SAAS_GATEWAY_URL не задан в console.js — заведите свой сервис (см. saas-gateway/README.md) и пропишите его адрес.'
    );
  }
  // forceRefresh — сразу после reauthenticate(): серверу нужен токен со
  // свежим auth_time (requireRecentAuth).
  const idToken = await state.auth.currentUser?.getIdToken(forceRefresh);
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
    const err = new Error(json?.error || `Сервис ответил ошибкой (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return { data: json };
}

/** Письмо входа, смены пароля или подтверждения почты в оформлении ZalPOS
 *  (handleSendAuthEmail). Сервер не смог — отправляет Firebase своим
 *  шаблоном (fallback). Упор в лимит (429) не обходим. */
async function sendAuthEmail(type, email, fallback) {
  try {
    await callSaasGateway('sendAuthEmail', {
      type, email, continueUrl: `${location.origin}${location.pathname}#/`,
    });
  } catch (e) {
    if (e?.status === 429) throw e;
    await fallback();
  }
}

/** Логотип в saas-gateway. XMLHttpRequest, а не fetch: только у него есть
 *  прогресс отправки. Возвращает { xhr, promise } — xhr для отмены и
 *  проверки зависания, promise отдаёт путь файла без домена. */
function uploadBrandingLogoToGateway(tenantId, file, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', `${SAAS_GATEWAY_URL}/uploadBrandingLogo?tenantId=${encodeURIComponent(tenantId)}`);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      let json = null;
      try { json = JSON.parse(xhr.responseText); } catch (_) { /* пустой ответ — ошибка ниже */ }
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

const state = {
  auth: null,
  db: null,
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

// Контраст по WCAG 2, как _contrastRatio в lib/theme/app_theme.dart:
// предупреждаем до сохранения, а приложение само откатит нечитаемую пару
// фон/текст на цвета по умолчанию.
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

// Готовые гаммы для приложения гостя — подходят любому типу заведения, с
// запасом по контрасту фон/текст и кнопка/текст. Первая совпадает с
// брендингом по умолчанию (createTenant, BrandingConfig).
const PREMIUM_PALETTES = [
  { id: 'graphite-copper', name: 'Графит и медь', primaryColor: '#B35C30', secondaryColor: '#CFA567', buttonColor: '#B35C30', backgroundColor: '#15120F', textColor: '#F2EADF' },
  { id: 'midnight', name: 'Полночный синий', primaryColor: '#0B5ED7', secondaryColor: '#162A4A', buttonColor: '#0B5ED7', backgroundColor: '#02050B', textColor: '#F8FAFC' },
  { id: 'emerald', name: 'Изумрудная ночь', primaryColor: '#9C7A22', secondaryColor: '#0E2A20', buttonColor: '#9C7A22', backgroundColor: '#071510', textColor: '#F4EFDD' },
  { id: 'bordeaux', name: 'Бордовый бархат', primaryColor: '#9C4A57', secondaryColor: '#3B0D14', buttonColor: '#9C4A57', backgroundColor: '#170406', textColor: '#F7E9E9' },
  { id: 'onyxgold', name: 'Оникс и золото', primaryColor: '#8C6B18', secondaryColor: '#1C1C1C', buttonColor: '#8C6B18', backgroundColor: '#0A0A0A', textColor: '#F5EFD6' },
  { id: 'amethyst', name: 'Аметистовые сумерки', primaryColor: '#7A4FB0', secondaryColor: '#2A1B3D', buttonColor: '#7A4FB0', backgroundColor: '#0D0714', textColor: '#F3EAFB' },
  { id: 'copper', name: 'Тлеющая медь', primaryColor: '#B25C29', secondaryColor: '#2B1B14', buttonColor: '#B25C29', backgroundColor: '#120B08', textColor: '#FBEDE1' },
  { id: 'graphite', name: 'Графит и серебро', primaryColor: '#5B6472', secondaryColor: '#1D2024', buttonColor: '#5B6472', backgroundColor: '#0E0F11', textColor: '#F2F3F5' },
  { id: 'sandstone', name: 'Песочный светлый', primaryColor: '#B5652E', secondaryColor: '#E4D8C4', buttonColor: '#B5652E', backgroundColor: '#F3ECE1', textColor: '#2B1D12' },
];

// Основной цвет заведений, созданных с палитрой по умолчанию (нынешней и
// прежней «Полночный синий») — цвета ещё не настраивали.
const DEFAULT_PRIMARY_COLORS = ['#B35C30', '#0B5ED7'];

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

/** Закрытые объявления платформы — в localStorage этого браузера.
 *  Приватный режим и выключенное хранилище не должны ронять «Обзор». */
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
  } catch (_) { /* не запомнится — не страшно */ }
}

/** Повторный ввод пароля перед опасным действием в панели платформы.
 *  Не 2FA (та требует платной Identity Platform), но открытый на чужом
 *  устройстве или украденный сеанс без пароля ничего опасного не сделает.
 *  Пароль есть у каждого аккаунта: при регистрации без пароля он
 *  создаётся случайным. true — пароль подтверждён, false — отменили. */
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
  // Нижнюю навигацию и тему лендинга включают свои экраны, остальные
  // начинают без них.
  screenEl().classList.remove('has-tabbar');
  screenEl().classList.remove('landing');
}
function sub(off) { state.screenSubs.push(off); }

function pad(n) { return String(n).padStart(2, '0'); }
/** Время последнего движения по обращению — для сортировки «новые сверху». */
function ticketTime(t) {
  const ts = t.updatedAt || t.createdAt;
  return ts && typeof ts.toMillis === 'function' ? ts.toMillis() : 0;
}
function fmtDate(ts) {
  const d = ts && typeof ts.toDate === 'function' ? ts.toDate() : null;
  if (!d) return '—';
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// Timestamp → "ГГГГ-ММ-ДД" для <input type="date">.
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

// Как GRACE_PERIOD_DAYS в saas-gateway и gracePeriodDays в
// lib/models/tenant_models.dart — менять вместе.
const GRACE_PERIOD_DAYS = 10;

/// «1 день», «2 дня», «5 дней».
function pluralDays(n) {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return 'день';
  if (!teen && last >= 2 && last <= 4) return 'дня';
  return 'дней';
}

/// Общее склонение по числу: plural(3, 'стол', 'стола', 'столов') → «стола».
function plural(n, one, few, many) {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return one;
  if (!teen && last >= 2 && last <= 4) return few;
  return many;
}

/// «1 человек», «2 человека», «5 человек».
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

// Дней до конца пробного периода, null — не триал или дата не задана.
function daysUntilTrialEnd(subscription) {
  if (subscription?.status !== 'trial') return null;
  const end = subscription.trialEndsAt?.toDate?.();
  if (!end) return null;
  return Math.ceil((end.getTime() - Date.now()) / 86400000);
}

const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

// Приветствие на «Обзоре»: время суток браузера и имя из email
// (отдельного поля с именем при регистрации нет). Имя — фирменным
// градиентом.
function greetingHtml() {
  const h = new Date().getHours();
  const greeting = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  const local = (state.auth.currentUser?.email || '').split('@')[0] || '';
  const name = capitalize(local.split(/[.+_0-9]/)[0]);
  return name ? `${greeting}, <span class="grad-text">${esc(name)}</span>` : greeting;
}

function planName(plans, planId) {
  if (!plans || !planId) return null;
  const plan = plans.find((p) => p.id === planId);
  return plan ? plan.name || plan.id : null;
}

// Превышенные лимиты тарифа («сотрудников: 5 из 3») — повод для
// супер-админа предложить тариф побольше.
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

// Фото с камеры телефона весит мегабайты, а логотип показывается мелко
// (иконке приложения хватает и 1024 px). Уменьшаем перед загрузкой; нет
// canvas — отправляем как есть.
async function resizeImageForUpload(file, maxDim = 1024) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) return file; // уже достаточно маленький — не трогаем
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Всегда PNG: у логотипов часто прозрачный фон.
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

// BOM нужен, иначе Excel на Windows показывает кириллицу в CSV кракозябрами.
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

// Как в saas-gateway: без символов, которые путают на слух и на вид (0/O, 1/I).
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomInviteCode() {
  // Код открывает устройству все данные заведения — только криптослучайный.
  const bytes = new Uint32Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
}

// Подпись участника: email из членства, иначе известный email, иначе это
// планшет, присоединённый по коду.
function memberLabel(m, knownEmail) {
  return m.email || knownEmail || `Устройство · ${(m.userId || '').slice(-4).toUpperCase()}`;
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
  trial: 'пробный период', active: 'активно', past_due: 'просрочена оплата',
  suspended: 'приостановлено', cancelled: 'отменено', deleted: 'удалено',
};
const ROLE_LABELS = { owner: 'владелец', admin: 'администратор', manager: 'менеджер', employee: 'сотрудник' };
const ROLE_ORDER = { owner: 0, admin: 1, manager: 2, employee: 3 };
// Специализация сотрудника (AppConstants.position*): от неё зависит, какие
// вызовы гостей ему приходят. universal получает все.
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
  superseded: 'заменена новой версией',
};
// Одно нажатие «Собрать APK» — три сборки: касса Android, касса Windows и
// приложение гостя.
const BUILD_TYPE_LABELS = {
  pos: 'Касса', guest: 'Гостевое приложение',
};
function buildJobLabel(j) {
  const base = BUILD_TYPE_LABELS[j.type] || j.type || 'Сборка';
  return j.platform === 'windows' ? `${base} (Windows)` : base;
}
const BILLING_PURPOSE_LABELS = {
  subscription: 'оплата тарифа', renewal: 'автопродление', chainLocation: 'новая точка сети',
};
const AUDIT_ACTION_LABELS = {
  tenantCreated: 'Заведение создано',
  tenantSuspended: 'Заведение заблокировано',
  tenantEnabled: 'Заведение разблокировано',
  memberInvited: 'Приглашён участник',
  subscriptionPaid: 'Подписка оплачена',
  billingMarkedTest: 'Оплата отмечена тестовой',
  chainLocationPaid: 'Оплачена и добавлена точка сети',
  chainLocationPaymentUnapplied: 'Оплата точки сети без созданной точки — проверьте',
  billingMarkedReal: 'Оплата снова учитывается в выручке',
  subscriptionPaymentCanceled: 'Платёж отменён',
  subscriptionRenewalFailed: 'Продление не прошло',
  subscriptionCancelRequested: 'Автопродление отключено владельцем',
  subscriptionCancelWithdrawn: 'Автопродление возобновлено владельцем',
  buildJobRequested: 'Запрошена сборка APK',
  planChangedBySuperAdmin: 'Тариф изменён супер-админом',
  bonusPeriodGranted: 'Выдан бонусный период',
  buildJobAutoUpdate: 'Автообновление приложений',
  tenantConvertedToChain: 'Заведение переведено в сеть',
  subscriptionOverridden: 'Подписка изменена вручную',
  trialExpired: 'Пробный период закончился',
  tenantDataPurged: 'Данные удалены после просрочки',
  chainDataPurged: 'Данные сети удалены после просрочки',
  chainCreated: 'Создана сеть',
  billingUnknownInvoice: 'Оплата по неизвестному счёту',
  billingRefundNotified: 'Платёжный сервис сообщил о возврате',
  bankInvoiceCreated: 'Выставлен счёт',
  bankInvoicePaid: 'Счёт оплачен',
  demoTenantDeletedBySuperAdmin: 'Демо удалено супер-админом',
  billingAmountMismatch: 'Сумма оплаты не совпала со счётом',
};

/** Случайный пароль при регистрации по ссылке: владелец его не видит и
 *  задаёт свой. Пока не задал, этот пароль даёт полный доступ, поэтому
 *  crypto.getRandomValues, а не Math.random. */
function genSecurePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = new Uint32Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** Пароль для входа, который удобно переписать: без похожих символов
 *  (0/O, 1/l), группами — «zal-7kq2-m9xp-4tw3», около 60 бит случайности. */
function genReadablePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return `zal-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** Ставит владельцу новый пароль и показывает его; если на сервере настроена
 *  почта — пароль уходит ещё и письмом. Firebase требует недавний вход:
 *  при ошибке auth/requires-recent-login вызывающий просит войти заново. */
async function issueNewPassword(user) {
  const pass = genReadablePassword();
  await updatePassword(user, pass);
  try { await setDoc(doc(state.db, 'users', user.uid), { passwordSet: true }, { merge: true }); } catch (_) {}
  let emailed = false;
  try {
    await callSaasGateway('sendAuthEmail', { type: 'password', email: user.email, password: pass });
    emailed = true;
  } catch (_) { /* почта на сервере не настроена — пароль только на экране */ }
  showPasswordNotice(pass, emailed);
}

function showPasswordNotice(pass, emailed) {
  document.getElementById('password-notice')?.remove();
  const box = document.createElement('div');
  box.id = 'password-notice';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;'
    + 'padding:16px;background:rgba(3,6,12,.72)';
  box.innerHTML = `
    <div class="card" style="max-width:420px;width:100%;margin:0">
      <h2 style="margin-top:0">Пароль для входа</h2>
      <p class="small muted">Сохраните его: с ним можно входить по кнопке «Войти по паролю», без письма на почту.
        ${emailed ? 'Копию отправили вам на почту.' : ''}</p>
      <div style="font:600 20px/1.4 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.5px;padding:14px;
        border-radius:12px;background:var(--surface-2);text-align:center;margin:14px 0;user-select:all">${esc(pass)}</div>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost" id="f-pass-copy">Скопировать</button>
        <button class="btn btn-primary" id="f-pass-ok">Сохранил(а)</button>
      </div>
      <p class="small muted" style="margin-top:12px">Сменить пароль можно в «Настройках».</p>
    </div>`;
  document.body.appendChild(box);
  $('f-pass-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(pass); toast('Пароль скопирован'); } catch (_) { toast('Выделите пароль и скопируйте вручную'); }
  };
  $('f-pass-ok').onclick = () => box.remove();
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
    // Настройки проекта отдаёт Firebase Hosting — ключи не вшиваем в код.
    const res = await fetch('/__/firebase/init.json');
    config = await res.json();
    if (!config || !config.projectId) throw new Error('пусто');
  } catch (_) {
    screenEl().innerHTML = `
      <div class="brand">ZalPOS</div>
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

  // Вход по ссылке из письма: пароль не нужен, клик по ссылке и так
  // доказывает владение почтой.
  if (isSignInWithEmailLink(state.auth, window.location.href)) {
    let email = window.localStorage.getItem('emailForSignIn');
    if (!email) {
      email = window.prompt('Введите email, на который приходило письмо со ссылкой для входа:');
    }
    if (email) {
      try {
        const cred = await signInWithEmailLink(state.auth, email, window.location.href);
        window.localStorage.removeItem('emailForSignIn');
        // Согласие отмечено на лендинге до отправки письма. Флага нет
        // (старая вкладка, очищено хранилище) — не блокируем вход, пишем
        // текущий момент.
        const offerAcceptedAtIso = window.localStorage.getItem('offerAcceptedAt');
        window.localStorage.removeItem('offerAcceptedAt');
        const userRef = doc(state.db, 'users', cred.user.uid);
        const existing = await getDoc(userRef);
        if (!existing.exists()) {
          await setDoc(userRef, {
            email, createdAt: Timestamp.fromDate(new Date()),
            offerAcceptedAt: Timestamp.fromDate(offerAcceptedAtIso ? new Date(offerAcceptedAtIso) : new Date()),
            // Согласие на обработку ПД — отдельной отметкой (с 01.09.2025
            // его нельзя совмещать с другими документами).
            pdConsentAt: Timestamp.fromDate(offerAcceptedAtIso ? new Date(offerAcceptedAtIso) : new Date()),
            pdConsentEdition: LEGAL_EDITION,
          });
          linkOwnerInRussia(cred.user);
          // Вход был только по ссылке — пароля нет, а без него не работают
          // «Войти по паролю» и смена пароля. Создаём и показываем сразу.
          try { await issueNewPassword(cred.user); } catch (_) { /* задаст в «Настройках» */ }
        }
      } catch (_) {
        // Ссылка одноразовая или просрочена — объясним на экране входа.
        state.authLinkError = 'Ссылка для входа устарела или уже была использована — запросите новую.';
      }
    }
    // Убираем oobCode из адреса, иначе обновление страницы снова
    // попробует потраченную ссылку.
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

  // Флаг платформы — отдельной лёгкой подпиской.
  state.accountSubs.push(onSnapshot(doc(state.db, 'superAdmins', state.uid), async (d) => {
    // «Выйти на всех устройствах»: этот вход старше — сервер и правила его
    // уже не пускают, поэтому выходим сразу.
    const validAfter = d.exists() ? d.data().sessionsValidAfter : null;
    if (typeof validAfter === 'number' && state.auth.currentUser) {
      try {
        const token = await state.auth.currentUser.getIdTokenResult();
        const authTime = Math.floor(new Date(token.authTime).getTime() / 1000);
        if (authTime <= validAfter) {
          toast('Сеансы панели завершены на всех устройствах — войдите заново');
          await signOut(state.auth);
          return;
        }
      } catch (_) {}
    }
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
    // Владелец обычно состоит в одном-двух заведениях — пара лишних чтений.
    await Promise.all(list.map(async (t) => {
      try {
        const tSnap = await getDoc(doc(state.db, 'tenants', t.id));
        t.name = tSnap.exists() ? tSnap.data().name : t.id;
        t.slug = tSnap.exists() ? tSnap.data().slug : '';
        // Сеть — чтобы сгруппировать точки в переключателе заведения.
        t.chainId = tSnap.exists() ? (tSnap.data().chainId || null) : null;
      } catch (_) {
        t.name = t.id;
        t.slug = '';
        t.chainId = null;
      }
    }));
    // Название сети — отдельным проходом по УНИКАЛЬНЫМ chainId (обычно
    // 0-1 сеть на владельца, не по одному чтению на каждую точку).
    const chainIds = [...new Set(list.map((t) => t.chainId).filter(Boolean))];
    await Promise.all(chainIds.map(async (chainId) => {
      try {
        const cSnap = await getDoc(doc(state.db, 'chains', chainId));
        const chainName = cSnap.exists() ? cSnap.data().name : chainId;
        list.filter((t) => t.chainId === chainId).forEach((t) => { t.chainName = chainName; });
      } catch (_) {
        list.filter((t) => t.chainId === chainId).forEach((t) => { t.chainName = chainId; });
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
  '#/legal/payment': () => screenLegalPayment(),
  '#/legal/consent': () => screenLegalConsent(),
  '#/status': () => screenStatus(),
  '#/faq': () => screenPublicFaq(),
  '#/demo-photos': () => screenDemoPhotos(),
};

function route() {
  clearScreen();
  if (PUBLIC_ROUTES[location.hash]) {
    return PUBLIC_ROUTES[location.hash]();
  }
  if (!state.uid) {
    // Не вошёл — лендинг; #/login и #/signup — вход и регистрация.
    if (location.hash === '#/login' || location.hash === '#/signup') {
      authMode = location.hash === '#/signup' ? 'signup' : 'login';
      return screenAuth();
    }
    return screenLanding();
  }
  if (location.hash.startsWith('#/invoice/')) {
    return screenBankInvoice(location.hash.slice('#/invoice/'.length));
  }
  if (location.hash === '#/admin') {
    // Панель платформы не зависит от того, есть ли у супер-админа
    // собственное заведение — поэтому проверяется до tenantsLoaded/tenants.
    return state.isSuperAdmin ? screenSuperAdmin() : screenDashboardOrOnboarding();
  }
  // Явный переход к созданию заведения — в том числе для супер-админа без
  // своего заведения (ссылка «Своё заведение» в панели).
  if (location.hash === '#/onboarding') {
    return screenDashboardOrOnboarding();
  }
  // Супер-админ без своего заведения по умолчанию попадает в панель
  // платформы. Пока заведения не загружены, покажется загрузка.
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

// Возможности для лендинга: коротко, для человека, который видит систему впервые.
const LANDING_FEATURES = [
  { title: 'Карта зала', desc: 'Стены и зоны как в вашем помещении, столы любой формы, статусы и таймеры, несколько чеков на одном столе, пересадка гостей без потери заказа.' },
  { title: 'Оплата и чеки', desc: 'Наличные, карта, терминал, раздельный счёт и чаевые. Фискальные чеки через вашу онлайн-кассу АТОЛ.' },
  { title: 'Склад и ЕГАИС', desc: 'Автосписание по техкартам, остатки, инвентаризация с расхождениями, приём накладных ЕГАИС.' },
  { title: 'Брони и лист ожидания', desc: 'Из приложения гостя и по телефону, подбор свободного стола, напоминания персоналу.' },
  { title: 'Программа лояльности', desc: 'Уровни и кешбэк бонусами, скидочные карты, подарочные сертификаты, отзывы гостей.' },
  { title: 'Приложение гостя', desc: 'Меню с фото, заказ со стола, вызов официанта, чаевые и бронь под вашим названием и логотипом.' },
  { title: 'Смены и зарплата', desc: 'Кто сейчас на смене, табель, зарплата по часам, окладу за смену и проценту с продаж.' },
  { title: 'Касса смены', desc: 'X-отчёт, инкассация, внесение и выплата, пересчёт наличных при закрытии, печать отчёта.' },
  { title: 'Отчёты', desc: 'Выручка, средний чек, продажи по сотрудникам и позициям, история чеков и возвраты.' },
  { title: 'ИИ-помощники', desc: 'Подсказки для зала и бара, разбор броней и остатков склада по данным вашего заведения.' },
  { title: 'Сеть заведений', desc: 'Несколько точек в одном кабинете и общая программа лояльности гостей.' },
  { title: 'Работает везде', desc: 'Android-планшет и телефон, компьютер с Windows. При обрыве интернета касса продолжает работать.' },
];

// Форматы заведений на лендинге. Касса умеет тип заведения (venueType):
// от него зависят слова и кнопки у персонала и гостя.
const LANDING_FORMATS = [
  {
    id: 'cafe', title: 'Кафе',
    lead: 'Меньше беготни в час пик: гости заказывают сами, а касса считает всё за персонал.',
    points: [
      'Гости заказывают со стола по QR-коду, и заказ сразу появляется на кассе',
      'Оплата наличными, картой или через терминал, раздельный счёт на компанию',
      'Склад списывается с каждой продажи: видно, чего не хватит к утру',
      'Бонусы и уровни возвращают гостя снова',
    ],
  },
  {
    id: 'restaurant', title: 'Ресторан',
    lead: 'Зал, брони и кухня под контролем от первого гостя до закрытия смены.',
    points: [
      'Карта зала по зонам, несколько чеков на одном столе, пересадка без потери заказа',
      'Брони и лист ожидания в одном календаре с залом, подбор свободного стола',
      'Техкарты, автосписание и инвентаризация с расхождениями',
      'Зарплата официантов с процентом от продаж, чаевые по сменам',
    ],
  },
  {
    id: 'bar', title: 'Бар',
    lead: 'Быстро у стойки и прозрачно по остаткам: каждая продажа на виду.',
    points: [
      'Быстрые продажи у стойки и заказы гостей со столов',
      'ЕГАИС: приём накладных через ваш УТМ',
      'Остатки напитков обновляются с каждой продажей',
      'Касса смены: внесение, инкассация, X-отчёт и пересчёт наличных',
    ],
  },
  {
    id: 'lounge', title: 'Лаунж',
    lead: 'Сеансы по времени и внимание к каждому столу даже в полном зале.',
    points: [
      'Сеансы по времени: таймер на каждом столе, продление в одно нажатие',
      'Гость зовёт персонал из приложения, и стол подсвечивается на кассе',
      'Брони на вечер с подбором свободного стола и напоминаниями',
      'Программа лояльности и подарки ко дню рождения',
    ],
  },
];

// ---- Тарифы: возможности, цены за период, карточки ----

// Что даёт тариф — как planCapabilities в saas-gateway: нет поля —
// возможность есть (старые тарифы до появления этих полей давали всё).
function planCaps(p) {
  return {
    guestApp: !p?.features || p.features.guestApp !== false,
    ai: p?.aiEnabled !== false,
    maxEmployees: Math.max(0, Math.floor(Number(p?.maxEmployees) || 0)),
    // Устройства касса не считает: число на сайте — только то, что записано
    // в тарифе, 0 — без ограничений.
    maxDevices: Math.max(0, Math.floor(Number(p?.maxDevices) || 0)),
    prioritySupport: p?.prioritySupport === true,
  };
}

// Тарифы, которые можно выбрать: не в архиве, с ценой, одного вида
// (сеть или одно заведение), по возрастанию цены.
function sellablePlans(plans, chain) {
  return (plans || [])
    .filter((p) => p.archived !== true && !!p.isChainPlan === !!chain && Number(p.priceRub) > 0)
    .sort((a, b) => (Number(a.priceRub) || 0) - (Number(b.priceRub) || 0));
}

const BILLING_PERIODS = {
  monthly: { months: 1, field: 'priceRub', addField: 'priceRubAdditional', label: 'Помесячно', short: 'мес' },
  semiannual: { months: 6, field: 'priceRubSemiannual', addField: 'priceRubAdditionalSemiannual', label: '6 месяцев', short: '6 мес' },
  yearly: { months: 12, field: 'priceRubYearly', addField: 'priceRubAdditionalYearly', label: 'Год', short: 'год' },
};

// Цена тарифа за период (0 — на этот период не продаётся) и скидка к
// помесячной оплате, %.
function planPeriodPrice(p, period) {
  return Number(p?.[BILLING_PERIODS[period]?.field]) || 0;
}
function planPeriodDiscount(p, period) {
  const months = BILLING_PERIODS[period]?.months || 1;
  const total = planPeriodPrice(p, period);
  const monthly = Number(p?.priceRub) || 0;
  if (!total || !monthly || months === 1) return 0;
  return Math.max(0, Math.round((1 - total / (monthly * months)) * 100));
}
// Цена каждой следующей точки сети за период (как additionalLocationPriceForPeriod).
function planAdditionalPrice(p, period) {
  if (!p?.customAdditionalPrice) return planPeriodPrice(p, period);
  return Number(p?.[BILLING_PERIODS[period]?.addField]) || 0;
}

const rub = (n) => `${Math.round(Number(n) || 0).toLocaleString('ru-RU')} ₽`;

function planTagline(p) {
  const c = planCaps(p);
  if (p.isChainPlan) {
    if (c.maxEmployees) return 'Несколько точек в одном кабинете: общие бонусы гостей и одно приложение на всю сеть';
    return c.prioritySupport
      ? 'Сеть без ограничений по команде, с приоритетной поддержкой'
      : 'Сеть без ограничений по команде на каждой точке';
  }
  if (c.maxEmployees && c.maxEmployees <= 6) return 'Кофейня, бар или небольшой зал';
  if (c.maxEmployees) return 'Кафе и ресторан с полной сменой';
  return 'Большой зал и команда без ограничений';
}

// Строки карточки тарифа — как в меню: название, отточие, значение.
// Всё берётся из тарифа: на сайте не может оказаться того, чего в нём нет.
// [row] — { label, value, on }; value: строка или null (тогда галочка/прочерк).
function planFeatureRows(p, { priorityRow = p.prioritySupport === true } = {}) {
  const c = planCaps(p);
  const perPoint = p.isChainPlan ? ' на точке' : '';
  const rows = [
    { label: 'Касса, зал, брони, склад', on: true },
    { label: 'Смены, зарплата, ЕГАИС', on: true },
    { label: `Сотрудники${perPoint}`, value: c.maxEmployees ? `до ${c.maxEmployees}` : 'без ограничений', on: true },
    { label: `Рабочие места${perPoint}`, value: c.maxDevices ? `до ${c.maxDevices}` : 'без ограничений', on: true },
    { label: 'Приложение гостя', on: c.guestApp },
    { label: 'Меню по QR и заказ со стола', on: c.guestApp },
    { label: 'ИИ-помощник', on: c.ai },
  ];
  if (priorityRow) rows.push({ label: 'Приоритетная поддержка', on: c.prioritySupport });
  return rows;
}

function planFeatsHtml(p, opts = {}) {
  return planFeatureRows(p, opts).map((r) => `
    <li class="${r.on ? 'on' : 'off'}">
      <span class="pf-label">${esc(r.label)}</span><span class="pf-dots" aria-hidden="true"></span>
      <span class="pf-val">${r.value ? esc(r.value) : r.on ? `${LI.check}<span class="sr-only">есть</span>` : '<span class="li-off">—</span><span class="sr-only">нет</span>'}</span>
    </li>`).join('');
}

/**
 * Карточка тарифа на сайте. [period] — выбранный период оплаты: цена
 * показывается за месяц, итог за период — строкой ниже.
 */
function planCardHtml(p, { period = 'monthly', selected = false, recommended = false, priorityRow } = {}) {
  const isChain = !!p.isChainPlan;
  const usePeriod = planPeriodPrice(p, period) > 0 ? period : 'monthly';
  const months = BILLING_PERIODS[usePeriod].months;
  const total = planPeriodPrice(p, usePeriod);
  const perMonth = total / months;
  const discount = planPeriodDiscount(p, usePeriod);
  let note;
  if (usePeriod === 'monthly') {
    const yearly = planPeriodPrice(p, 'yearly');
    note = yearly ? `или ${rub(yearly)} за год: ${rub(yearly / 12)} в месяц` : 'оплата помесячно';
  } else {
    note = `${rub(total)} за ${usePeriod === 'yearly' ? 'год' : '6 месяцев'}${discount ? `, выгода ${discount} %` : ''}`;
  }
  const additional = isChain ? planAdditionalPrice(p, usePeriod) / months : 0;
  const trialDays = Number(p.trialDays) || 14;
  return `
    <div class="plan-card${recommended ? ' recommended' : ''}${selected ? ' selected' : ''}" data-plan-card="${esc(p.id)}">
      ${recommended ? '<div class="plan-ribbon">Рекомендуем</div>' : ''}
      <div class="plan-name">${esc(p.name || p.id)}</div>
      <div class="plan-tagline">${esc(planTagline(p))}</div>
      <div class="plan-price">
        ${isChain ? '<span class="plan-price-from">первая точка</span>' : ''}
        <span class="plan-price-num">${Math.round(perMonth).toLocaleString('ru-RU')}</span>
        <span class="plan-price-unit">₽ в месяц</span>
      </div>
      <div class="plan-price-note">${esc(note)}</div>
      ${isChain && additional > 0 ? `<div class="plan-price-add">+ ${rub(additional)} в месяц за каждую следующую точку</div>
        <div class="plan-price-note">Например, 3 точки: ${rub(perMonth + additional * 2)} в месяц</div>` : ''}
      <ul class="plan-feats">${planFeatsHtml(p, { priorityRow })}</ul>
      <div class="plan-trial">${trialDays} ${pluralDays(trialDays)} бесплатно${isChain ? ' на первую точку' : ''}, без карты</div>
      <button class="btn ${selected || recommended ? 'btn-primary' : 'btn-ghost'} ${isChain ? 'f-landing-chain-plan-pick' : 'f-landing-plan-pick'}" data-id="${esc(p.id)}">
        ${selected ? 'Тариф выбран' : 'Попробовать бесплатно'}
      </button>
      <button class="btn-link ${isChain ? 'f-landing-chain-plan-buy' : 'f-landing-plan-buy'}" data-id="${esc(p.id)}">
        Купить сразу, без пробного периода
      </button>
    </div>
  `;
}

/// Кальяны в заведении — как VenueTerms.isHookah в приложении: переключатель
/// hookahEnabled, а пока его не трогали — по типу (кальянная или нет).
function venueHookahOn(vp) {
  if (typeof vp?.hookahEnabled === 'boolean') return vp.hookahEnabled;
  return !['restaurant', 'cafe', 'bar'].includes(vp?.venueType);
}

// ---- Витрина: живая схема зала ----
//
// Как на кассе (lib/widgets/hall_plan_view.dart): холст в точках, плитка
// стола 104, шаг сетки 26, стены «как на чертеже» (HallWallsPainter).
// Ролик: стены прорисовываются, столы расставляются, дальше смена живёт —
// гость зовёт официанта, садятся новые гости, приходит бронь; потом
// официант переключает зал на список, открывает стол, добавляет в чек
// позиции из меню и возвращается к схеме; и заново.
const HALL_DEMO = {
  w: 624, h: 580,
  tables: [
    { id: 'bar', name: 'Бар', shape: 'bar', x: 52, y: 52, w: 312, st: 'busy', a: '2 чека', b: '1 640 ₽' },
    { id: 'vip', name: 'VIP', shape: 'rect', x: 442, y: 52, st: 'busy', a: '2 ч 05 мин', b: '8 700 ₽' },
    { id: 't1', name: 'Стол 1', shape: 'rect', x: 52, y: 234, st: 'busy', a: '1 ч 12 мин', b: '2 450 ₽' },
    { id: 't2', name: 'Стол 2', shape: 'circle', x: 208, y: 234, st: 'free', a: '4 места', b: '' },
    { id: 't3', name: 'Стол 3', shape: 'long', x: 364, y: 234, w: 208, st: 'busy', a: '47 мин', b: '1 430 ₽' },
    { id: 't4', name: 'Стол 4', shape: 'rect', x: 52, y: 390, st: 'ending', a: 'через 8 мин', b: '3 920 ₽' },
    { id: 't5', name: 'Стол 5', shape: 'rect', x: 208, y: 390, st: 'reserved', a: 'Бронь 19:30', b: '' },
    { id: 't6', name: 'Стол 6', shape: 'oval', x: 364, y: 390, w: 208, st: 'free', a: '6 мест', b: '' },
  ],
  // Меню в чеке — фото из демо-меню (demo-menu/, авторы — #/demo-photos).
  menu: [
    { id: 'lemonade', name: 'Лимонад манго', price: 390, img: 'lemonade' },
    { id: 'pasta', name: 'Паста карбонара', price: 690, img: 'carbonara' },
    { id: 'cake', name: 'Чизкейк', price: 350, img: 'cheesecake' },
    { id: 'tea', name: 'Улун', price: 290, img: 'oolong' },
  ],
};

const HALL_DEMO_ICONS = {
  plan: '<svg viewBox="0 0 24 24"><path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Z"/><path d="M9 4v13M15 6.5v13"/></svg>',
  list: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="7" height="7" rx="1.5"/><rect x="13.5" y="4" width="7" height="7" rx="1.5"/><rect x="3.5" y="13" width="7" height="7" rx="1.5"/><rect x="13.5" y="13" width="7" height="7" rx="1.5"/></svg>',
};

function hallDemoHtml() {
  const { w: W, h: H } = HALL_DEMO;
  const pct = (v, total) => `${(v / total * 100).toFixed(3)}%`;
  // Внешние стены с проёмом входа и перегородка VIP-зала. Тело стены —
  // встык: у свободного конца продлено на полтолщины, у упора в стену — нет.
  const walls = [
    { edge: 'M286 546 L26 546 L26 26 L598 26 L598 546 L390 546', body: 'M290.75 546 L26 546 L26 26 L598 26 L598 546 L385.25 546' },
    { edge: 'M390 26 L390 208 L494 208', body: 'M390 26 L390 208 L498.75 208' },
  ];
  return `
    <div class="hall-demo" id="hall-demo" aria-hidden="true">
      <div class="hd-layer">
        <svg class="hd-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id="hdBody" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="${H}">
              <stop offset="0" stop-color="#6E645A"/><stop offset="1" stop-color="#433C35"/>
            </linearGradient>
            <linearGradient id="hdRoom" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="${H}">
              <stop offset="0" stop-color="#E9DFD0" stop-opacity=".07"/><stop offset="1" stop-color="#E9DFD0" stop-opacity=".02"/>
            </linearGradient>
            <filter id="hdShadow" filterUnits="userSpaceOnUse" x="-40" y="-40" width="${W + 80}" height="${H + 80}">
              <feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#000" flood-opacity=".5"/>
            </filter>
          </defs>
          <path class="hd-room" d="M26 26 H598 V546 H26 Z"/>
          <g filter="url(#hdShadow)">
            ${walls.map((x, i) => `<path class="hd-edge hd-w${i + 1}" pathLength="1" d="${x.edge}"/>`).join('')}
          </g>
          ${walls.map((x, i) => `<path class="hd-body hd-w${i + 1}" pathLength="1" d="${x.body}"/>`).join('')}
          <text class="hd-label" x="338" y="574" text-anchor="middle">вход</text>
          <text class="hd-label" x="404" y="196">VIP-зал</text>
        </svg>
        ${HALL_DEMO.tables.map((t, i) => `
          <div class="hd-slot" style="left:${pct(t.x, W)};top:${pct(t.y, H)};width:${pct(t.w || 104, W)};height:${pct(104, H)};--d:${(i * 0.09).toFixed(2)}s">
            <div class="hd-table ${t.shape} ${t.st}" data-hd="${t.id}">
              <b>${t.name}</b><span class="a">${t.a}</span><span class="b">${t.b}</span>
            </div>
          </div>`).join('')}
      </div>
      <div class="hd-list">
        ${HALL_DEMO.tables.map((t) => `
          <div class="hd-card ${t.st}" data-hd="${t.id}">
            <b>${t.name}</b><span class="a">${t.a}</span><span class="b">${t.b}</span>
          </div>`).join('')}
      </div>
      <div class="hd-check">
        <div class="hdc-head"><b>Стол 2</b><span>Чек № 57 · Алина</span></div>
        <div class="hdc-lines" id="hd-check-lines"><div class="hdc-empty">Добавьте позиции из меню</div></div>
        <div class="hdc-menu">
          ${HALL_DEMO.menu.map((m) => `
            <div class="hdc-item" data-hd-item="${m.id}">
              <img src="/demo-menu/${m.img}.jpg" alt="" loading="lazy">
              <span>${m.name}</span><b>${m.price.toLocaleString('ru-RU')} ₽</b>
            </div>`).join('')}
        </div>
        <div class="hdc-foot">
          <div class="hdc-total"><span>Итого</span><b id="hd-check-total">0 ₽</b></div>
          <div class="hdc-save" id="hd-check-save">Сохранить</div>
        </div>
      </div>
    </div>`;
}

let hallDemoTimers = [];
function startHallDemo() {
  const box = $('hall-demo');
  if (!box) return;
  const showcase = box.closest('.showcase');
  const tablet = box.closest('.mock-tablet');
  // Стол на схеме и его карточка в списке — одно состояние.
  const setTable = (id, st, a, b) => {
    box.querySelectorAll(`[data-hd="${id}"]`).forEach((el) => {
      el.classList.remove('free', 'busy', 'ending', 'reserved', 'call');
      el.classList.add(st);
      el.querySelector('.a').textContent = a;
      el.querySelector('.b').textContent = b;
    });
  };
  // Касание — кружок, как в записи экрана, и лёгкое нажатие самой кнопки.
  const tap = (el) => {
    const dot = tablet?.querySelector('.hd-tap');
    if (!el || !dot) return;
    const r = el.getBoundingClientRect(), p = tablet.getBoundingClientRect();
    dot.style.left = `${r.left - p.left + r.width / 2}px`;
    dot.style.top = `${r.top - p.top + r.height / 2}px`;
    dot.classList.remove('go');
    void dot.offsetWidth;
    dot.classList.add('go');
    el.classList.add('pressed');
    setTimeout(() => el.classList.remove('pressed'), 260);
  };
  const viewBtn = (v) => tablet?.querySelector(`[data-hd-view="${v}"]`);
  const setView = (v) => {
    box.classList.toggle('list-mode', v === 'list');
    ['plan', 'list'].forEach((x) => viewBtn(x)?.classList.toggle('on', x === v));
  };
  let checkSum = 0;
  const lines = () => $('hd-check-lines');
  const addLine = (id) => {
    const m = HALL_DEMO.menu.find((x) => x.id === id);
    const box2 = lines();
    if (!m || !box2) return;
    box2.querySelector('.hdc-empty')?.remove();
    box2.insertAdjacentHTML('beforeend',
      `<div class="hdc-line"><span>${m.name}</span><b>${m.price.toLocaleString('ru-RU')} ₽</b></div>`);
    checkSum += m.price;
    const total = $('hd-check-total');
    if (total) {
      total.textContent = `${checkSum.toLocaleString('ru-RU')} ₽`;
      total.classList.remove('bump');
      void total.offsetWidth;
      total.classList.add('bump');
    }
  };
  const resetCheck = () => {
    checkSum = 0;
    box.classList.remove('check-open');
    if (lines()) lines().innerHTML = '<div class="hdc-empty">Добавьте позиции из меню</div>';
    const total = $('hd-check-total');
    if (total) total.textContent = '0 ₽';
  };
  const setCounts = (free, busy) => {
    showcase.querySelector('[data-hd-count="free"]').textContent = free;
    showcase.querySelector('[data-hd-count="busy"]').textContent = busy;
  };
  const toggle = (id, cls, on) => $(id)?.classList.toggle(cls, on);
  const reset = () => {
    HALL_DEMO.tables.forEach((t) => setTable(t.id, t.st, t.a, t.b));
    setCounts(3, 5);
    setView('plan');
    resetCheck();
    toggle('hd-phone-call', 'on', false);
    toggle('hd-toast-call', 'show', false);
    toggle('hd-toast-booking', 'show', false);
  };
  const stop = () => {
    hallDemoTimers.forEach(clearTimeout);
    hallDemoTimers = [];
  };
  // Без анимаций (так настроено в системе) — сразу готовая схема.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    box.classList.add('static');
    setTable('t3', 'call', 'Зовёт', '1 180 ₽');
    return;
  }
  showcase?.classList.add('live');
  const at = (ms, fn) => hallDemoTimers.push(setTimeout(fn, ms));
  const play = () => {
    stop();
    if (!document.body.contains(box)) return; // ушли с лендинга
    reset();
    box.classList.remove('play', 'out');
    void box.offsetWidth; // перезапуск CSS-анимаций
    box.classList.add('play');
    at(3600, () => { toggle('hd-phone-call', 'on', true); setTable('t3', 'call', 'Зовёт', '1 180 ₽'); toggle('hd-toast-call', 'show', true); });
    at(6600, () => { toggle('hd-phone-call', 'on', false); setTable('t3', 'busy', '48 мин', '1 180 ₽'); toggle('hd-toast-call', 'show', false); });
    at(8200, () => { setTable('t2', 'busy', 'только что', '0 ₽'); setCounts(2, 6); });
    at(10600, () => { setTable('t6', 'reserved', 'Бронь 20:00', ''); toggle('hd-toast-booking', 'show', true); });
    at(13600, () => toggle('hd-toast-booking', 'show', false));
    // Тот же зал списком: открыть стол и добавить в чек позиции из меню.
    at(14300, () => tap(viewBtn('list')));
    at(14600, () => setView('list'));
    at(16000, () => tap(box.querySelector('.hd-card[data-hd="t2"]')));
    at(16300, () => box.classList.add('check-open'));
    at(17500, () => tap(box.querySelector('[data-hd-item="lemonade"]')));
    at(17700, () => addLine('lemonade'));
    at(18700, () => tap(box.querySelector('[data-hd-item="pasta"]')));
    at(18900, () => addLine('pasta'));
    at(19900, () => tap($('hd-check-save')));
    at(20200, () => { box.classList.remove('check-open'); setTable('t2', 'busy', '2 мин', `${checkSum.toLocaleString('ru-RU')} ₽`); });
    at(21600, () => tap(viewBtn('plan')));
    at(21900, () => setView('plan'));
    at(24000, () => box.classList.add('out'));
    at(24700, play);
  };
  // Играет, только пока схему видно: не тратит батарею, а при возврате
  // к ней показывает ролик с начала.
  if (!('IntersectionObserver' in window)) return play();
  const io = new IntersectionObserver((entries) => {
    if (!document.body.contains(box)) { io.disconnect(); stop(); return; }
    if (entries.some((e) => e.isIntersecting)) {
      if (!hallDemoTimers.length) play();
    } else {
      stop();
    }
  }, { threshold: 0.35 });
  io.observe(box);
}

// Тонкие линейные иконки сайта (24×24, обводка 1.5) — один набор вместо
// эмодзи: эмодзи на разных устройствах рисуются по-разному и выглядят
// случайно. Цвет — currentColor.
const LI = (() => {
  const svg = (d) => `<svg class="li" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  return {
    check: svg('<path d="M5 12.5l4.2 4.2L19 7"/>'),
    arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    arrowDown: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
    download: svg('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>'),
    tablet: svg('<rect x="3" y="5" width="18" height="14" rx="2.2"/><path d="M10.5 16.2h3"/>'),
    phone: svg('<rect x="6.8" y="2.8" width="10.4" height="18.4" rx="2.4"/><path d="M10.8 18.2h2.4"/>'),
    monitor: svg('<rect x="3" y="4" width="18" height="12.5" rx="1.8"/><path d="M9 20.5h6M12 16.5v4"/>'),
    chart: svg('<path d="M4 19.5h16"/><path d="M6.5 16V11M11 16V6.5M15.5 16v-3.5M20 16V8.5"/>'),
    lock: svg('<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
    server: svg('<rect x="4" y="4.5" width="16" height="6" rx="1.6"/><rect x="4" y="13.5" width="16" height="6" rx="1.6"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>'),
    receipt: svg('<path d="M6.5 3.5h11v17l-2.75-1.8-2.75 1.8-2.75-1.8-2.75 1.8z"/><path d="M9.5 8h5M9.5 11.5h5"/>'),
    cloud: svg('<path d="M7.5 18.5h9.5a3.75 3.75 0 0 0 .4-7.48A5.6 5.6 0 0 0 6.6 11a3.75 3.75 0 0 0 .9 7.5z"/>'),
  };
})();

// ---- Светлая и тёмная тема ----
// Тему до первой отрисовки ставит скрипт в index.html (выбор посетителя или
// тема устройства). Здесь — кнопка: в шапке сайта, в верхней панели
// кабинета и плавающая на страницах без шапки (.theme-fab в index.html).
const THEME_KEY = 'zalpos-theme';
const THEME_ICONS = `<svg class="li theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 14.6A7.6 7.6 0 0 1 9.4 4.5a7.6 7.6 0 1 0 10.1 10.1z"/></svg>`
  + `<svg class="li theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/>`
  + `<path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5 7 7M17 17l1.5 1.5M5.5 18.5 7 17M17 7l1.5-1.5"/></svg>`;

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function themeToggleHtml() {
  return `<button type="button" class="theme-toggle" aria-label="${currentTheme() === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}">${THEME_ICONS}</button>`;
}

function applyTheme(theme, { save = false } = {}) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0D0C0A' : '#F3EEE6');
  const label = theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
  document.querySelectorAll('.theme-toggle').forEach((b) => b.setAttribute('aria-label', label));
  if (save) { try { localStorage.setItem(THEME_KEY, theme); } catch (_) {} }
}

(function initThemeToggle() {
  const fab = document.querySelector('.theme-fab');
  if (fab) fab.innerHTML = THEME_ICONS;
  applyTheme(currentTheme());
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.theme-toggle');
    if (!btn) return;
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', { save: true });
  });
  // Пока посетитель сам не выбрал — тема следует за устройством.
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      let saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch (_) {}
      if (saved !== 'light' && saved !== 'dark') applyTheme(e.matches ? 'dark' : 'light');
    });
  } catch (_) {}
})();

// Цифры лендинга из настоящих тарифов (renderLandingPlans): «меню» первого
// экрана, счёт «Из чего складывается цена» и список «Во всех тарифах».
// Обещание появляется, только если оно верно для каждого продаваемого
// тарифа: «рабочие места без ограничений» — если ни у одного тарифа нет
// лимита устройств, и так далее.
function renderLandingFacts(plans, recommendedId) {
  const menu = $('landing-hero-menu');
  const cheapest = plans[0];
  const trials = plans.map((p) => Number(p.trialDays) || 14);
  if (menu && cheapest) {
    const minTrial = Math.min(...trials);
    menu.innerHTML = `
      <div><dt>Тариф «${esc(cheapest.name || cheapest.id)}»</dt><dd>${esc(rub(cheapest.priceRub))} в месяц</dd></div>
      <div><dt>Пробный период</dt><dd>${new Set(trials).size > 1
        // «от 3 дней», «от 21 дня» — после «от» родительный падеж.
        ? `от ${minTrial} ${minTrial % 10 === 1 && minTrial % 100 !== 11 ? 'дня' : 'дней'}`
        : `${minTrial} ${pluralDays(minTrial)}`}, без карты</dd></div>
      <div><dt>Процент с ваших продаж</dt><dd>0 %</dd></div>`;
  }

  const all = (fn) => plans.length > 0 && plans.every(fn);
  // «Почему ZalPOS»: обещания — только верные для продаваемых тарифов.
  const whyGuest = $('why-guest-app');
  if (whyGuest && plans.length && !all((p) => planCaps(p).guestApp)) {
    const first = plans.find((p) => planCaps(p).guestApp);
    whyGuest.textContent = first
      ? `Меню, заказ со стола, брони и бонусы под вашим логотипом: в тарифе «${first.name || first.id}» и старше, без отдельного модуля.`
      : 'Меню, заказ со стола, брони и бонусы под вашим логотипом и в ваших цветах.';
  }
  const whyPrice = $('why-price');
  if (whyPrice && plans.length) {
    const minTrial = Math.min(...trials);
    whyPrice.textContent = 'Фиксированная подписка: без процента с выручки и без платы за обновления. '
      + `${new Set(trials).size > 1 ? 'От ' : ''}${minTrial} ${pluralDays(minTrial)} бесплатно, без карты.`;
  }
  const chips = $('landing-pricing-chips');
  if (chips) {
    const items = [
      'Касса на Android и Windows', 'Карта зала и брони', 'Склад и техкарты',
      'Чеки через вашу ККТ АТОЛ', 'ЕГАИС через ваш УТМ', 'Бонусы, скидочные карты, сертификаты',
      'Смены и зарплата', 'Отчёты и кабинет владельца',
      ...(all((p) => planCaps(p).guestApp) ? ['Приложение гостя с вашим логотипом'] : []),
      ...(all((p) => planCaps(p).maxDevices === 0) ? ['Рабочие места без ограничений'] : []),
      'Обновления без доплаты', 'Без процента с продаж',
    ];
    chips.innerHTML = items.map((t) => `<li class="pricing-chip">${LI.check}${esc(t)}</li>`).join('');
  }

  // Счёт — по рекомендуемому тарифу (иначе по самому доступному).
  const bill = $('landing-bill');
  const p = plans.find((x) => x.id === recommendedId) || cheapest;
  if (!bill) return;
  if (!p) { bill.innerHTML = ''; return; }
  const c = planCaps(p);
  const yearly = planPeriodPrice(p, 'yearly');
  const line = (label, value, cls = '') => `<li class="${cls}"><span>${label}</span><i aria-hidden="true"></i><b>${value}</b></li>`;
  const sub = $('landing-value-sub');
  if (sub) sub.textContent = `Модули не докупаются отдельно. Вот счёт за месяц на тарифе «${p.name || p.id}»: всё, что в нём есть, уже в цене.`;
  bill.innerHTML = `
    <div class="bill-head"><span>ZalPOS</span><span>Счёт за месяц</span></div>
    <div class="bill-title">Тариф «${esc(p.name || p.id)}»</div>
    <ul class="bill-lines">
      ${line('Касса, карта зала, брони', 'включено')}
      ${line('Склад, техкарты, ЕГАИС', 'включено')}
      ${line('Смены, зарплата, отчёты', 'включено')}
      ${c.guestApp ? line('Приложение гостя с вашим логотипом', 'включено') : ''}
      ${c.ai ? line('ИИ-помощник', 'включено') : ''}
      ${line('Сотрудники', c.maxEmployees ? `до ${c.maxEmployees}` : 'без ограничений')}
      ${line('Рабочие места', c.maxDevices ? `до ${c.maxDevices}` : 'без доплаты')}
      ${line('Обновления', 'без доплаты')}
      ${line('Процент с выручки', '0 %')}
    </ul>
    <ul class="bill-lines bill-total">
      ${line('Итого в месяц', esc(rub(p.priceRub)), 'total')}
      ${yearly ? line('При оплате за год', `${esc(rub(yearly))}, это ${esc(rub(yearly / 12))} в месяц`, 'yearly') : ''}
    </ul>
    <div class="bill-foot">${Number(p.trialDays) || 14} ${pluralDays(Number(p.trialDays) || 14)} бесплатно, без карты</div>`;
}

function screenLanding() {
  let selectedPlanId = window.localStorage.getItem('selectedPlanId') || null;
  // Тёмно-синяя тема только у лендинга, кабинет остаётся в своей.
  screenEl().classList.add('landing');

  const HOW_IT_WORKS = [
    { title: 'Оставляете email', desc: 'Придёт ссылка для входа, без пароля и банковской карты. Сразу начинается бесплатный пробный период, его срок указан в карточке тарифа.' },
    { title: 'Настраиваете под себя', desc: 'Название, логотип и цвета приложения, меню, склад и сотрудники. В личном кабинете это занимает 10–15 минут.' },
    { title: 'Подключаете планшет', desc: 'Скачиваете кассу из личного кабинета и вводите код заведения. Касса, склад, брони и лояльность сразу работают.' },
  ];
  const LANDING_FAQ_PREVIEW = [FAQ_ITEMS[0], FAQ_ITEMS[4], FAQ_ITEMS[6], FAQ_ITEMS[3]];
  const PAINS = [
    ['Выручка не сходится с кассой', 'Каждый чек, скидка и возврат записаны с именем сотрудника. При закрытии смены есть X-отчёт и пересчёт наличных.'],
    ['Продукты заканчиваются внезапно', 'Склад списывается с каждой продажи по техкартам, остатки видны всегда, инвентаризация показывает расхождения.'],
    ['Гости ждут официанта', 'Гость сам заказывает и зовёт персонал со стола по QR-коду, а стол на кассе сразу подсвечивается.'],
    ['Брони теряются в переписке', 'Все брони в одном календаре с картой зала: свободный стол подбирается сам, персонал получает напоминание.'],
    ['Гости приходят один раз', 'Кешбэк бонусами, уровни, подарки ко дню рождения и сертификаты живут у гостя в приложении с вашим логотипом.'],
    ['Зарплату считаете вечером в Excel', 'Смены отмечаются на кассе. Зарплата по часам, окладу и проценту с продаж считается сама, чаевые тоже.'],
    ['Не знаете, что происходит без вас', 'В кабинете владельца с телефона видно выручку за сегодня, открытые столы, кто на смене и сколько чеков закрыто.'],
    ['Отчёт по смене занимает полчаса', 'Выручка, средний чек, продажи по сотрудникам и позициям собираются в пару нажатий, X-отчёт можно распечатать.'],
  ];

  screenEl().innerHTML = `
    <nav class="landing-nav">
      <div class="landing-inner landing-nav-inner">
        <a class="landing-logo" href="#/" aria-label="ZalPOS, на главную">Zal<span>POS</span></a>
        <div class="landing-nav-links">
          <button type="button" data-scroll="landing-pains">Возможности</button>
          <button type="button" data-scroll="landing-formats">Для кого</button>
          <button type="button" data-scroll="landing-pricing">Тарифы</button>
          <button type="button" data-scroll="landing-faq">Вопросы</button>
        </div>
        <div class="landing-nav-actions">
          ${themeToggleHtml()}
          <a class="landing-nav-login" href="#/login">Войти</a>
          <button class="btn btn-primary" id="f-landing-nav-cta"><span class="landing-nav-cta-full">Попробовать бесплатно</span><span class="landing-nav-cta-short">Попробовать</span></button>
        </div>
      </div>
    </nav>

    <section class="landing-section landing-hero-section">
      <div class="landing-inner landing-hero-grid">
        <div class="landing-hero-copy">
          <h1>Зал, касса и&nbsp;гости <em>в&nbsp;одном планшете</em></h1>
          <p class="landing-hero-lede">Официант принимает заказ за секунды, гость сам заказывает со стола, склад
          списывается по техкартам, зарплата считается по сменам. Выручку и смену вы видите с телефона, даже
          когда вас нет в зале.</p>

          <ul class="landing-hero-points">
            <li>${LI.check}<span>Работает на Android-планшете, телефоне и компьютере с Windows, которые у вас уже есть</span></li>
            <li>${LI.check}<span>Приложение для гостей под вашим названием и логотипом: меню, заказ со стола, бонусы и бронь</span></li>
            <li>${LI.check}<span>Пробный период без банковской карты: нужен только email</span></li>
          </ul>
          <div class="row landing-hero-actions">
            <button class="btn btn-primary" id="f-landing-hero-cta">Попробовать бесплатно</button>
            <button class="btn-link l-arrow-link" id="f-landing-hero-demo">Как выглядит смена ${LI.arrowDown}</button>
          </div>
          <dl class="menu-lines hero-menu" id="landing-hero-menu">
            <div><dt>Тариф</dt><dd>…</dd></div>
            <div><dt>Пробный период</dt><dd>…</dd></div>
            <div><dt>Процент с ваших продаж</dt><dd>0 %</dd></div>
          </dl>
        </div>

        <div class="landing-hero-form-wrap">
          <div class="card landing-hero-card">
            <div class="landing-form-title">Начните бесплатно</div>
            <p class="small muted l-form-sub">Кабинет откроется по ссылке из письма, пароль не нужен.</p>
            <p id="f-landing-skip-trial-note" class="small l-note" style="display:none">
              Выбрана оплата сразу, без пробного периода: после регистрации откроется страница оплаты.
            </p>
            <label class="field"><span>Email</span>
              <input id="f-landing-email" type="email" autocomplete="email" placeholder="you@example.com">
            </label>
            <label class="row l-consent">
              <input type="checkbox" id="f-landing-agree">
              <span class="small muted">Принимаю условия <a href="#/legal/offer" target="_blank" rel="noopener">публичной оферты</a></span>
            </label>
            <label class="row l-consent">
              <input type="checkbox" id="f-landing-pd">
              <span class="small muted">Даю <a href="#/legal/consent" target="_blank" rel="noopener">согласие на обработку персональных данных</a>, в том числе на их трансграничную передачу (<a href="#/legal/privacy" target="_blank" rel="noopener">политика конфиденциальности</a>)</span>
            </label>
            <div id="f-landing-error" class="small l-error"></div>
            <button class="btn btn-primary" id="f-landing-start">Попробовать бесплатно</button>
            <p class="small muted l-form-foot">Пришлём ссылку для входа на почту. Ничего запоминать не нужно.</p>
          </div>

          <div class="owner-mock" aria-hidden="true">
            <div class="owner-mock-head"><span class="live-dot"></span> Кабинет владельца · сегодня</div>
            <div class="owner-mock-grid">
              <div><b>48 320 ₽</b><span>выручка</span></div>
              <div><b>37</b><span>чеков</span></div>
              <div><b>6</b><span>столов открыто</span></div>
            </div>
            <div class="owner-mock-row"><span>На смене</span><span>Анна · Илья · Марат</span></div>
            <div class="owner-mock-note">Пример экрана: так кабинет выглядит с телефона</div>
          </div>
          <p class="small muted l-demo-hint">Хотите сначала потрогать?
            <button class="btn-link" id="f-landing-goto-demo">Демо без регистрации</button></p>
        </div>
      </div>
    </section>

    <section class="landing-section l-dark landing-showcase" id="landing-showcase">
      <div class="landing-inner">
        <div class="l-head">
          <h2 class="landing-h2">Касса у персонала и&nbsp;приложение у&nbsp;гостя работают как одно целое</h2>
          <p class="landing-h2-sub">Схему зала со стенами, подписями и столами любой формы вы рисуете в редакторе
          за пару минут, а списком зал открывается одним нажатием. Гость нажал «Позвать официанта», и стол
          на кассе сразу подсвечивается.</p>
        </div>
        <div class="showcase" aria-hidden="true">
          <div class="mock-tablet">
            <div class="mock-bar">
              <b>Зал · Основной</b>
              <span class="mock-chip free">Свободны <i data-hd-count="free">3</i></span>
              <span class="mock-chip busy">Заняты <i data-hd-count="busy">5</i></span>
              <span class="hd-view">
                <span class="hd-view-btn on" data-hd-view="plan">${HALL_DEMO_ICONS.plan}Схема</span>
                <span class="hd-view-btn" data-hd-view="list">${HALL_DEMO_ICONS.list}Список</span>
              </span>
            </div>
            ${hallDemoHtml()}
            <div class="hd-tap"></div>
          </div>
          <div class="mock-phone">
            <div class="mp-notch"></div>
            <div class="mp-title">Стол 3</div>
            <div class="mp-timer"><span>С вами</span><b>47 мин</b></div>
            <div class="mp-btns">
              <div class="mp-btn on" id="hd-phone-call">Позвать официанта</div>
              <div class="mp-btn">Счёт, пожалуйста</div>
            </div>
            <div class="mp-bill">
              <div><span>Лимонад манго</span><span>390 ₽</span></div>
              <div><span>Паста карбонара</span><span>690 ₽</span></div>
              <div><span>Чизкейк</span><span>350 ₽</span></div>
              <div class="mp-total"><span>Итого</span><span>1 430 ₽</span></div>
            </div>
            <div class="mp-bonus">+ 71 бонус за визит</div>
          </div>
          <div class="mock-toast t1" id="hd-toast-call"><i></i>Стол 3 зовёт официанта</div>
          <div class="mock-toast t2" id="hd-toast-booking"><i></i>Новая бронь: сегодня 20:00, Стол 6</div>
        </div>
      </div>
    </section>

    <section class="landing-section" id="landing-demo">
      <div class="landing-inner">
        <div class="l-head l-head-row">
          <h2 class="landing-h2">Демо за&nbsp;две минуты</h2>
          <p class="landing-h2-sub">Без заявки, звонка и&nbsp;менеджера. Скачайте кассу, нажмите «Демо»
          и&nbsp;работайте в&nbsp;готовой сети из&nbsp;двух заведений: залы, меню, открытая смена, брони и&nbsp;гости.</p>
        </div>
        <div class="demo-board">
          <div class="demo-downloads">
            <p class="demo-route"><span>Скачайте кассу</span>${LI.arrow}<span>нажмите «Демо»</span>${LI.arrow}<span>войдите по&nbsp;PIN-коду</span></p>
            <div class="demo-dl" data-platform="android">
              <div class="demo-dl-icon">${LI.tablet}</div>
              <div class="demo-dl-text"><b>Касса для Android</b><span>Планшет или телефон</span></div>
              <button class="btn btn-primary" id="f-landing-download-apk">${LI.download}<span>Скачать APK</span></button>
            </div>
            <div class="demo-dl" data-platform="windows">
              <div class="demo-dl-icon">${LI.monitor}</div>
              <div class="demo-dl-text"><b>Касса для Windows</b><span>Windows 10 и&nbsp;11, установка без прав администратора</span></div>
              <button class="btn btn-primary" id="f-landing-download-windows">${LI.download}<span>Скачать для Windows</span></button>
            </div>
            <div class="demo-dl demo-dl-guest" data-platform="guest">
              <div class="demo-dl-icon">${LI.phone}</div>
              <div class="demo-dl-text"><b>Приложение гостя</b><span>Android. Введите код демо с&nbsp;экрана входа кассы, вида&nbsp;<code>demo-ab12cd</code></span></div>
              <button class="btn btn-ghost" id="f-landing-download-guest-demo">${LI.download}<span>Скачать APK</span></button>
            </div>
            <p class="demo-hint" id="landing-demo-hint" hidden></p>
          </div>
          <div class="demo-pins-card">
            <div class="bill-head"><span>PIN-коды демо</span><span>Сотрудники</span></div>
            <div class="demo-pins-cols">
              ${[['Демо · Центр', ['1111', '2222', '3333', '111111']], ['Демо · Набережная', ['4444', '5555', '6666', '222222']]].map(([venue, pins]) => `
                <div>
                  <div class="demo-pins-venue">${venue}</div>
                  <ul class="bill-lines">
                    ${['Кальянщик', 'Официант', 'Бармен', 'Администратор'].map((role, i) =>
                      `<li><span>${role}</span><i aria-hidden="true"></i><b>${pins[i]}</b></li>`).join('')}
                  </ul>
                </div>`).join('')}
            </div>
            <p class="demo-pins-note">Касса при входе спросит точку: у каждой свои сотрудники, гости и бонусы общие.</p>
          </div>
        </div>
        <p class="demo-foot">Через 3 дня демо само возвращается в&nbsp;исходный вид. Та же касса подключается и&nbsp;к&nbsp;вашему
        заведению по&nbsp;коду заведения и&nbsp;коду приглашения из&nbsp;личного кабинета.</p>
      </div>
    </section>

    <section class="landing-section landing-section-alt" id="landing-pains">
      <div class="landing-inner">
        <div class="l-head l-head-row">
          <h2 class="landing-h2">Узнаёте своё заведение?</h2>
          <p class="landing-h2-sub">Каждая из этих мелочей забирает деньги и нервы. ZalPOS закрывает их все сразу.</p>
        </div>
        <dl class="pain-ledger">
          ${PAINS.map(([pain, fix]) => `<div class="pain-row"><dt>${pain}</dt><dd>${fix}</dd></div>`).join('')}
        </dl>
      </div>
    </section>

    <section class="landing-section" id="landing-formats">
      <div class="landing-inner l-split">
        <div class="l-head">
          <h2 class="landing-h2">Под ваш формат заведения</h2>
          <p class="landing-h2-sub">Выберите свой: касса и приложение гостя подстраивают слова и кнопки под тип заведения.</p>
        </div>
        <div>
          <div class="format-tabs" role="tablist">
            ${LANDING_FORMATS.map((f, i) => `<button type="button" role="tab" class="format-tab${i === 0 ? ' active' : ''}" data-format="${f.id}">${f.title}</button>`).join('')}
          </div>
          <div class="format-body" id="landing-format-body"></div>
        </div>
      </div>
    </section>

    <section class="landing-section landing-section-alt">
      <div class="landing-inner">
        <div class="l-head">
          <h2 class="landing-h2">Три приложения и&nbsp;одна база</h2>
        </div>
        <div class="apps-grid">
          <div class="app-card">
            <div class="app-title">${LI.tablet}<span>Касса для персонала</span></div>
            <div class="app-desc">Android-планшет, телефон или компьютер с Windows. Вход по PIN-коду, у каждого своя роль: официант, бармен, администратор.</div>
          </div>
          <div class="app-card">
            <div class="app-title">${LI.phone}<span>Приложение для гостей</span></div>
            <div class="app-desc">Меню с фото, заказ со стола, вызов персонала, счёт, чаевые, бонусы и бронь под вашим названием и логотипом. На iPhone открывается в браузере без установки.</div>
          </div>
          <div class="app-card">
            <div class="app-title">${LI.chart}<span>Кабинет владельца</span></div>
            <div class="app-desc">Выручка за сегодня, кто на смене, брендинг, устройства и оплата. С телефона или компьютера, откуда угодно.</div>
          </div>
        </div>
      </div>
    </section>

    <section class="landing-section" id="landing-how">
      <div class="landing-inner">
        <div class="l-head">
          <h2 class="landing-h2">Как это работает</h2>
        </div>
        <ol class="landing-steps">
          ${HOW_IT_WORKS.map((st, i) => `
            <li class="step-item">
              <div class="step-num">${i + 1}</div>
              <div class="step-title">${esc(st.title)}</div>
              <div class="step-desc">${esc(st.desc)}</div>
            </li>
          `).join('')}
        </ol>
      </div>
    </section>

    <section class="landing-section landing-section-alt" id="landing-features">
      <div class="landing-inner">
        <div class="l-head l-head-row">
          <h2 class="landing-h2">Всё, что есть в&nbsp;системе</h2>
          <p class="landing-h2-sub">Касса, зал, склад, брони, лояльность и зарплата входят во все тарифы. Что ещё входит
          в каждый тариф, указано в карточках ниже.</p>
        </div>
        <div class="feature-grid">
          ${LANDING_FEATURES.map((f) => `
            <div class="feature-card">
              <div class="feature-title">${esc(f.title)}</div>
              <div class="feature-desc">${esc(f.desc)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </section>

    <section class="landing-section l-dark" id="landing-value">
      <div class="landing-inner value-layout">
        <div class="l-head">
          <h2 class="landing-h2">Из чего складывается цена</h2>
          <p class="landing-h2-sub" id="landing-value-sub">Модули не докупаются отдельно: всё, что есть в тарифе, уже в его цене.</p>
          <div class="value-extra">
            <div class="value-extra-title">Оплачивается отдельно, не нам</div>
            <ul>
              <li>Онлайн-касса (ККТ) с фискальным накопителем и договор с ОФД, если вы пробиваете фискальные чеки</li>
              <li>Комиссия банка за оплату картой (эквайринг) по вашему договору с банком</li>
              <li>УТМ и электронная подпись для ЕГАИС, если продаёте алкоголь</li>
            </ul>
          </div>
        </div>
        <div class="bill" id="landing-bill" aria-live="polite"></div>
      </div>
    </section>

    <section class="landing-section landing-pricing-section" id="landing-pricing">
      <div class="landing-inner">
        <div class="l-head l-head-center">
          <h2 class="landing-h2">Тарифы без доплат за&nbsp;модули</h2>
          <p class="landing-h2-sub" id="landing-pricing-sub">Бесплатный пробный период на любом тарифе, банковская карта не нужна. Без процента с продаж.</p>
        </div>
        <div class="pricing-switches">
          <div id="landing-pricing-toggle" class="landing-pricing-toggle" style="display:none">
            <button type="button" class="landing-pricing-toggle-btn active" data-mode="single">Одно заведение</button>
            <button type="button" class="landing-pricing-toggle-btn" data-mode="chain">Сеть заведений</button>
          </div>
          <div id="landing-period-toggle" class="landing-pricing-toggle">
            <button type="button" class="landing-pricing-toggle-btn active" data-period="monthly">Помесячно</button>
            <button type="button" class="landing-pricing-toggle-btn" data-period="semiannual">6 месяцев <span class="period-save" data-save="semiannual"></span></button>
            <button type="button" class="landing-pricing-toggle-btn" data-period="yearly">Год <span class="period-save" data-save="yearly"></span></button>
          </div>
        </div>
        <div id="landing-plans" class="landing-plans-grid"><div class="spinner"></div></div>
        <div id="landing-chain-plans" class="landing-plans-grid" style="display:none"></div>
        <div class="pricing-included">
          <div class="pricing-included-title">Во всех тарифах</div>
          <ul class="pricing-chips" id="landing-pricing-chips"></ul>
        </div>
      </div>
    </section>

    <section class="landing-section landing-section-alt">
      <div class="landing-inner l-split">
        <div class="l-head">
          <h2 class="landing-h2">Безопасность и&nbsp;соответствие</h2>
        </div>
        <ul class="l-facts-list">
          <li>${LI.lock}<span>Данные заведений разделены правилами доступа: персонал видит только своё заведение. Это проверяют автотесты.</span></li>
          <li>${LI.server}<span>Имена и телефоны гостей сначала записываются на сервер в России, как требует 152-ФЗ.</span></li>
          <li>${LI.receipt}<span>Фискальные чеки (54-ФЗ) идут через вашу зарегистрированную онлайн-кассу АТОЛ, ЕГАИС работает через ваш УТМ. Система подключается к ним, но не заменяет ККТ, договор с ОФД и эквайринг.</span></li>
          <li>${LI.cloud}<span>Данные заведений хранятся в облаке Google Firebase, раз в сутки мы делаем резервную копию на своём сервере. Работа сервисов видна на <a href="#/status">странице статуса</a>.</span></li>
        </ul>
      </div>
    </section>

    <section class="landing-section">
      <div class="landing-inner">
        <div class="l-head l-head-row">
          <h2 class="landing-h2">Почему ZalPOS</h2>
          <p class="landing-h2-sub">Мы сравнили, как подключают кассы для общепита, и&nbsp;убрали то, что обычно
          мешает начать: заявки на&nbsp;демо, платное внедрение и&nbsp;доплаты за&nbsp;модули.</p>
        </div>
        <div class="risk-grid why-grid">
          <div class="risk-item"><b>Демо без заявки</b><span>Скачали кассу, нажали «Демо» и&nbsp;через две минуты работаете
            в&nbsp;готовом заведении. Без звонка менеджера и&nbsp;выезда специалиста.</span></div>
          <div class="risk-item"><b>Приложение гостя в&nbsp;тарифе</b><span id="why-guest-app">Меню, заказ со&nbsp;стола, брони и&nbsp;бонусы
            под вашим логотипом и&nbsp;в&nbsp;ваших цветах. Входит в&nbsp;тариф, а&nbsp;не&nbsp;продаётся отдельным модулем.</span></div>
          <div class="risk-item"><b>Сделано для зала</b><span>Таймер сеанса за&nbsp;столом, вызовы нужному сотруднику,
            схема зала со&nbsp;стенами и&nbsp;брони по&nbsp;реальной занятости. Всё уже в&nbsp;кассе, без доработок на&nbsp;заказ.</span></div>
          <div class="risk-item"><b>Android и&nbsp;Windows вместе</b><span>Планшет в&nbsp;зале, телефон официанта
            и&nbsp;моноблок на&nbsp;баре работают в&nbsp;одной смене и&nbsp;одной подписке.</span></div>
          <div class="risk-item"><b>Честная цена</b><span id="why-price">Фиксированная подписка: без процента с&nbsp;выручки
            и&nbsp;без платы за&nbsp;обновления. Пробный период&nbsp;— без карты.</span></div>
          <div class="risk-item"><b>Без обязательств</b><span>Подписка помесячно, без долгих договоров. Автопродление
            выключается в&nbsp;личном кабинете в&nbsp;любой момент.</span></div>
        </div>
      </div>
    </section>

    <section class="landing-section landing-section-alt" id="landing-faq">
      <div class="landing-inner l-split">
        <div class="l-head">
          <h2 class="landing-h2">Частые вопросы</h2>
          <p class="small"><a class="l-arrow-link" href="#/faq">Все вопросы ${LI.arrow}</a></p>
        </div>
        <div class="faq-list">
          ${LANDING_FAQ_PREVIEW.map((item, i) => `
            <div class="faq-item" data-faq="preview-${i}">
              <div class="faq-question"><span>${esc(item.q)}</span><span class="faq-toggle" aria-hidden="true"></span></div>
              <div class="faq-answer">${esc(item.a)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </section>

    <section class="landing-section l-dark landing-cta-band">
      <div class="landing-inner landing-cta-inner">
        <h3>Откройте своё заведение в&nbsp;ZalPOS <em>уже сегодня</em></h3>
        <p>Бесплатный доступ по email, без карты. Или скачайте кассу и нажмите «Демо»: готовое заведение
        с залом, меню и гостями откроется за минуту.</p>
        <div class="landing-cta-buttons">
          <button class="btn" id="f-landing-cta-bottom">Попробовать бесплатно</button>
          <button class="btn landing-cta-ghost" id="f-landing-cta-demo">${LI.download} Скачать демо-кассу</button>
        </div>
      </div>
    </section>

    <footer class="landing-section landing-footer">
      <div class="landing-inner">
        <div class="l-footer-top">
          <span class="landing-logo">Zal<span>POS</span></span>
          <p class="small muted">Уже есть аккаунт? <a href="#/login">Войти по паролю</a></p>
        </div>
        ${publicFooterLinksHtml()}
      </div>
    </footer>

    <div class="sticky-cta" id="landing-sticky">
      <button class="btn btn-primary" id="f-landing-sticky-btn">Попробовать бесплатно</button>
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
    if (!$('f-landing-agree')?.checked) { errEl.textContent = 'Нужно принять условия оферты'; return; }
    if (!$('f-landing-pd')?.checked) { errEl.textContent = 'Нужно согласие на обработку персональных данных — без него мы не сможем создать личный кабинет'; return; }
    $('f-landing-start').disabled = true;
    try {
      await recordOwnerInRussia(email);
      await sendAuthEmail('signIn', email, () => sendSignInLinkToEmail(state.auth, email, {
        url: `${location.origin}${location.pathname}#/`,
        handleCodeInApp: true,
      }));
      window.localStorage.setItem('emailForSignIn', email);
      window.localStorage.setItem('offerAcceptedAt', new Date().toISOString());
      if (selectedPlanId) window.localStorage.setItem('selectedPlanId', selectedPlanId);
      screenEl().innerHTML = `
        <div class="brand">ZalPOS</div>
        <h1>Проверьте почту</h1>
        <p class="muted">Отправили ссылку для входа на <b>${esc(email)}</b>.
        Откройте письмо на этом же телефоне и перейдите по ссылке — она
        сразу откроет личный кабинет, без пароля.</p>
        <p class="small center muted" style="margin-top:20px">
          Уже есть аккаунт? <a href="#/login">Войти по паролю</a>
        </p>
      `;
    } catch (e) {
      errEl.textContent = authErrorMessage(e);
      $('f-landing-start').disabled = false;
    }
  };
  $('f-landing-start').onclick = submit;
  $('f-landing-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  if ($('f-landing-download-apk')) $('f-landing-download-apk').onclick = downloadPublicApk;
  if ($('f-landing-download-guest-demo')) $('f-landing-download-guest-demo').onclick = downloadGuestDemoApk;

  const scrollToEmail = () => {
    $('f-landing-email')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('f-landing-email')?.focus();
  };
  if ($('f-landing-cta-bottom')) $('f-landing-cta-bottom').onclick = scrollToEmail;
  if ($('f-landing-hero-cta')) $('f-landing-hero-cta').onclick = scrollToEmail;
  if ($('f-landing-goto-demo')) {
    $('f-landing-goto-demo').onclick = () => $('landing-demo')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if ($('f-landing-hero-demo')) {
    $('f-landing-hero-demo').onclick = () =>
      $('landing-showcase')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if ($('f-landing-cta-demo')) $('f-landing-cta-demo').onclick = downloadDemoForThisDevice;
  if ($('f-landing-download-windows')) $('f-landing-download-windows').onclick = downloadWindowsDemo;
  suggestDemoPlatform();

  // Форматы заведения: вкладки с тем, что даёт система именно такому заведению.
  const renderFormat = (id) => {
    const f = LANDING_FORMATS.find((x) => x.id === id) || LANDING_FORMATS[0];
    const body = $('landing-format-body');
    if (body) {
      body.innerHTML = `
        <div class="format-lead">${esc(f.lead)}</div>
        <ul class="format-list">${f.points.map((p) => `<li>${LI.check}<span>${esc(p)}</span></li>`).join('')}</ul>`;
    }
    document.querySelectorAll('.format-tab').forEach((b) => b.classList.toggle('active', b.dataset.format === f.id));
  };
  document.querySelectorAll('.format-tab').forEach((b) => { b.onclick = () => renderFormat(b.dataset.format); });
  renderFormat(LANDING_FORMATS[0].id);
  startHallDemo();
  if ($('f-landing-sticky-btn')) $('f-landing-sticky-btn').onclick = scrollToEmail;
  if ($('f-landing-nav-cta')) $('f-landing-nav-cta').onclick = scrollToEmail;

  document.querySelectorAll('.faq-item').forEach((el) => {
    el.querySelector('.faq-question')?.addEventListener('click', () => el.classList.toggle('open'));
  });

  // Липкая кнопка появляется, когда форма email ушла за верх экрана.
  const onLandingScroll = () => {
    const heroCard = $('f-landing-email');
    if (!heroCard) return;
    $('landing-sticky')?.classList.toggle('show', heroCard.getBoundingClientRect().bottom < 0);
  };
  window.addEventListener('scroll', onLandingScroll, { passive: true });
  sub(() => window.removeEventListener('scroll', onLandingScroll));

  // Период оплаты и выбранный тариф переживают перезагрузку страницы.
  let landingPeriod = ['monthly', 'semiannual', 'yearly'].includes(window.localStorage.getItem('selectedBillingPeriod'))
    ? window.localStorage.getItem('selectedBillingPeriod') : 'monthly';
  let latestPlans = [];

  const renderLandingPlans = () => {
    const plans = sellablePlans(latestPlans, false);
    const chainPlans = sellablePlans(latestPlans, true);
    const body = $('landing-plans');
    if (!body) return;
    // «Рекомендуем» — средний из трёх и больше, у двух — дорогой.
    const recommendedId = plans.length >= 3 ? plans[Math.floor(plans.length / 2)].id : plans.length === 2 ? plans[1].id : null;
    body.innerHTML = plans.length
      ? plans.map((p) => planCardHtml(p, { period: landingPeriod, selected: p.id === selectedPlanId, recommended: p.id === recommendedId,
        priorityRow: plans.some((x) => x.prioritySupport === true) })).join('')
      : '<p class="small muted">Тарифы скоро появятся.</p>';
    body.classList.toggle('three', plans.length === 3);
    const chainBody = $('landing-chain-plans');
    if (chainBody) {
      chainBody.innerHTML = chainPlans.map((p) => planCardHtml(p, { period: landingPeriod, selected: p.id === selectedPlanId,
        priorityRow: chainPlans.some((x) => x.prioritySupport === true) })).join('');
      chainBody.classList.toggle('one', chainPlans.length === 1);
    }

    // Выгода за период — по лучшему тарифу; периода нет ни у одного — прячем кнопку.
    ['semiannual', 'yearly'].forEach((period) => {
      const all = [...plans, ...chainPlans];
      const best = Math.max(0, ...all.map((p) => planPeriodDiscount(p, period)));
      const label = document.querySelector(`[data-save="${period}"]`);
      if (label) label.textContent = best ? `−${best}%` : '';
      const btn = document.querySelector(`#landing-period-toggle [data-period="${period}"]`);
      if (btn) btn.style.display = all.some((p) => planPeriodPrice(p, period) > 0) ? '' : 'none';
    });
    document.querySelectorAll('#landing-period-toggle [data-period]').forEach((b) => {
      b.classList.toggle('active', b.dataset.period === landingPeriod);
    });

    // Первый экран, «Из чего складывается цена» и «Во всех тарифах» — только
    // из настоящих тарифов: на сайте не должно быть обещаний, которых в
    // тарифах нет.
    renderLandingFacts(plans, recommendedId);
    const trial = [...new Set(plans.map((p) => Number(p.trialDays) || 14))];
    const subEl = $('landing-pricing-sub');
    if (subEl && !subEl.dataset.chain) {
      subEl.textContent = trial.length === 1
        ? `${trial[0]} ${pluralDays(trial[0])} бесплатно на любом тарифе, банковская карта не нужна. Без процента с продаж.`
        : 'Бесплатный пробный период на любом тарифе, банковская карта не нужна. Без процента с продаж.';
    }
    bindPlanButtons();
  };

  const updateSkipTrialNote = () => {
    const note = $('f-landing-skip-trial-note');
    if (note) note.style.display = window.localStorage.getItem('skipTrial') === '1' ? 'block' : 'none';
  };
  // presetIsChain решает, откроется ли онбординг сразу с отметкой «Это сеть».
  const selectLandingPlan = (id, { isChain, buyNow }) => {
    selectedPlanId = id;
    window.localStorage.setItem('selectedPlanId', selectedPlanId);
    window.localStorage.setItem('selectedBillingPeriod', landingPeriod);
    if (isChain) window.localStorage.setItem('presetIsChain', '1');
    else window.localStorage.removeItem('presetIsChain');
    // Выбрали тариф с пробным периодом — сбрасываем «Купить сразу» от
    // другого тарифа, иначе после регистрации неожиданно откроется оплата.
    if (buyNow) window.localStorage.setItem('skipTrial', '1');
    else window.localStorage.removeItem('skipTrial');
    renderLandingPlans();
    updateSkipTrialNote();
    $('f-landing-email')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  function bindPlanButtons() {
    document.querySelectorAll('.f-landing-plan-pick').forEach((el) => {
      el.onclick = () => selectLandingPlan(el.dataset.id, { isChain: false, buyNow: false });
    });
    document.querySelectorAll('.f-landing-plan-buy').forEach((el) => {
      el.onclick = () => selectLandingPlan(el.dataset.id, { isChain: false, buyNow: true });
    });
    document.querySelectorAll('.f-landing-chain-plan-pick').forEach((el) => {
      el.onclick = () => selectLandingPlan(el.dataset.id, { isChain: true, buyNow: false });
    });
    document.querySelectorAll('.f-landing-chain-plan-buy').forEach((el) => {
      el.onclick = () => selectLandingPlan(el.dataset.id, { isChain: true, buyNow: true });
    });
  }

  document.querySelectorAll('#landing-period-toggle [data-period]').forEach((btn) => {
    btn.onclick = () => {
      landingPeriod = btn.dataset.period;
      try { window.localStorage.setItem('selectedBillingPeriod', landingPeriod); } catch (_) {}
      renderLandingPlans();
    };
  });

  // Переключатель «Одно заведение / Сеть» — только если есть тарифы сети.
  const SINGLE_SUB_FALLBACK = 'Бесплатный пробный период на любом тарифе, банковская карта не нужна. Без процента с продаж.';
  const CHAIN_SUB = 'Несколько точек одного владельца: общий кабинет и оплата, общая программа лояльности, гость выбирает точку сети прямо в приложении.';
  const setMode = (mode) => {
    const toggle = $('landing-pricing-toggle');
    toggle?.querySelectorAll('.landing-pricing-toggle-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    if ($('landing-plans')) $('landing-plans').style.display = mode === 'single' ? '' : 'none';
    if ($('landing-chain-plans')) $('landing-chain-plans').style.display = mode === 'chain' ? '' : 'none';
    const subEl = $('landing-pricing-sub');
    if (subEl) {
      if (mode === 'chain') {
        subEl.dataset.chain = '1';
        subEl.textContent = CHAIN_SUB;
      } else {
        delete subEl.dataset.chain;
        subEl.textContent = SINGLE_SUB_FALLBACK;
        renderLandingPlans();
      }
    }
  };
  $('landing-pricing-toggle')?.querySelectorAll('.landing-pricing-toggle-btn').forEach((btn) => {
    btn.onclick = () => setMode(btn.dataset.mode);
  });

  let modeSet = false;
  sub(onSnapshot(collection(state.db, 'plans'), (snap) => {
    latestPlans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const hasChain = sellablePlans(latestPlans, true).length > 0;
    const toggle = $('landing-pricing-toggle');
    if (toggle) toggle.style.display = hasChain ? '' : 'none';
    renderLandingPlans();
    // Выбирал тариф сети раньше — сразу открываем эту вкладку.
    if (!modeSet) {
      modeSet = true;
      setMode(hasChain && window.localStorage.getItem('presetIsChain') === '1' ? 'chain' : 'single');
    }
    updateSkipTrialNote();
  }, () => {
    const body = $('landing-plans');
    if (body) body.innerHTML = '<p class="small muted">Тарифы недоступны.</p>';
  }));
}

// ---------- ПУБЛИЧНЫЕ СТРАНИЦЫ (оферта, конфиденциальность, статус, FAQ) ----------
// Доступны по прямой ссылке и без входа — см. PUBLIC_ROUTES выше.

function publicFooterLinksHtml() {
  // Реквизиты Исполнителя (ИП, ИНН, ОГРНИП, email) — в оферте (раздел 14)
  // и политике конфиденциальности, ссылки на них здесь же; отдельной
  // строкой в подвале их не дублируем.
  return `
    <p class="small center muted" style="margin-top:14px">
      <a href="#/legal/offer">Оферта</a> ·
      <a href="#/legal/payment">Оплата и возврат</a> ·
      <a href="#/legal/privacy">Конфиденциальность</a> ·
      <a href="#/status">Статус</a> ·
      <a href="#/faq">FAQ</a>
    </p>
    <p class="small center muted" style="margin-top:4px">${PAYMENT_METHODS_TEXT}</p>
  `;
}

// Платёжный сервис и способы оплаты — для оферты, подвала и страницы
// «Оплата и возврат» (их проверяет модерация Робокассы). Если сменится
// провайдер (BILLING_PROVIDER на сервере), поправить здесь.
const PAYMENT_SERVICE = 'Robokassa (Робокасса)';
const PAYMENT_METHODS_TEXT = 'Оплата банковскими картами «Мир», Visa, Mastercard и через СБП — платёжный сервис Robokassa';

// Реквизиты владельца платформы (Безопасность → Платформа → «Реквизиты»).
let legalCache = null;
async function loadPlatformLegal() {
  if (legalCache) return legalCache;
  try {
    const d = await getDoc(doc(state.db, 'platformConfig', 'legal'));
    legalCache = d.exists() ? d.data() : {};
  } catch (_) {
    legalCache = {};
  }
  return legalCache;
}

// ФИО из выписки ЕГРИП приходит заглавными и с «ИНДИВИДУАЛЬНЫЙ
// ПРЕДПРИНИМАТЕЛЬ» в начале — приводим к виду для документов (full) и
// подвала (short, «ИП Иванов Иван Иванович»). Организация — как записана.
function legalParty(l) {
  const raw = String(l.fullName || '').trim();
  const isOrg = !/^ИП\s|индивидуальн/i.test(raw) && (l.ogrnip || '').length === 13;
  if (isOrg) return { isOrg, full: raw, short: raw };
  let name = raw.replace(/^(ИП|индивидуальный\s+предприниматель)\s+/i, '').trim();
  if (name === name.toUpperCase()) {
    name = name.toLowerCase().replace(/(^|[\s\-.])([a-zа-яё])/g, (m, p, c) => p + c.toUpperCase());
  }
  return { isOrg, full: `Индивидуальный предприниматель ${name}`, short: `ИП ${name}` };
}

/** Как выдаётся чек: самозанятый — из «Мой налог» (422-ФЗ), иначе —
 *  кассовый чек по 54-ФЗ. */
function receiptRuleText(l) {
  return l && l.taxRegime === 'npd'
    ? 'Исполнитель применяет специальный налоговый режим «Налог на профессиональный доход» (Федеральный закон № 422-ФЗ) и не является плательщиком НДС. Чек формируется в приложении «Мой налог» и направляется в электронной форме на email Заказчика: при оплате картой — сразу, на физическое лицо; при оплате по счёту индивидуальным предпринимателем или организацией — с указанием ИНН покупателя, не позднее 9-го числа месяца, следующего за месяцем оплаты (ст. 14 Федерального закона № 422-ФЗ); ссылка на такой чек появляется и в личном кабинете.'
    : 'При оплате формируется кассовый чек в соответствии с Федеральным законом № 54-ФЗ и направляется в электронной форме на email Заказчика.';
}

async function fillLegalRequisites() {
  const l0 = await loadPlatformLegal();
  document.querySelectorAll('.legal-receipt').forEach((node) => { node.textContent = receiptRuleText(l0); });
  document.querySelectorAll('.legal-contacts').forEach((node) => {
    const c = [l0.email ? `email: ${l0.email}` : '', l0.phone ? `телефон: ${l0.phone}` : ''].filter(Boolean).join(', ');
    if (c) node.textContent = c;
  });
  const el = $('legal-requisites');
  if (!el) return;
  const l = l0;
  if (!l.fullName) return;
  const v = (x) => esc(x || '—');
  const party = legalParty(l);
  const who = esc(party.full)
    + (l.taxRegime === 'npd' ? ', применяющий специальный налоговый режим «Налог на профессиональный доход»' : '');
  // По строке на реквизит — в одном абзаце номера счетов и адрес рвались
  // посреди строки, и нужное было трудно найти глазами.
  const lines = el.dataset.kind === 'privacy'
    ? [
        who,
        `${party.isOrg ? 'ОГРН' : 'ОГРНИП'}: ${v(l.ogrnip)}`,
        `ИНН: ${v(l.inn)}`,
        `Адрес: ${v(l.address)}`,
        `Номер в реестре операторов персональных данных Роскомнадзора: ${v(l.rknNumber)}`,
        `Email для обращений по вопросам персональных данных: ${v(l.email)}`,
      ]
    : [
        who,
        `${party.isOrg ? 'ОГРН' : 'ОГРНИП'}: ${v(l.ogrnip)}`,
        `ИНН: ${v(l.inn)}`,
        `Адрес места жительства и для корреспонденции: ${v(l.address)}`,
        `Расчётный счёт: ${v(l.bankAccount)}`,
        `Банк: ${v(l.bankName)}`,
        `БИК: ${v(l.bik)}`,
        `Корреспондентский счёт: ${v(l.corrAccount)}`,
        `Email для претензий: ${v(l.email)}`,
        ...(l.phone ? [`Телефон: ${v(l.phone)}`] : []),
      ];
  el.innerHTML = lines.join('<br>');
}

function publicPageWrapHtml(title, bodyHtml) {
  return `
    <div class="brand">ZalPOS</div>
    <h1>${esc(title)}</h1>
    ${bodyHtml}
    <p class="small center muted" style="margin-top:24px"><a href="#/">← На главную</a></p>
    ${publicFooterLinksHtml()}
  `;
}

function legalSection(title, paragraphs) {
  return `<h2>${title}</h2>${paragraphs.map((p) => `<p class="small muted">${p}</p>`).join('')}`;
}

const LEGAL_EDITION = 'Редакция от 29 сентября 2026 г.';

function screenLegalOffer() {
  screenEl().innerHTML = publicPageWrapHtml('Публичная оферта', `
    <p class="small muted">${LEGAL_EDITION} Договор-оферта на предоставление права использования программного комплекса ZalPOS (ст. 435, 437 ГК РФ).</p>
    <div class="card">
      ${legalSection('1. Термины', [
        '<b>Исполнитель</b> — индивидуальный предприниматель, правообладатель и оператор Платформы (реквизиты — раздел 14). <b>Платформа</b> — программный комплекс ZalPOS: личный кабинет, кассовое приложение для Android и Windows, гостевое приложение и веб-страницы заведений. <b>Заказчик</b> — физическое лицо, индивидуальный предприниматель или юридическое лицо, акцептовавшее оферту. <b>Заведение</b> — объект общественного питания Заказчика (кафе, ресторан, бар, лаунж и т. п.), созданный в личном кабинете. <b>Тариф</b> — объём функций, лимиты и стоимость, опубликованные в личном кабинете. <b>Гость</b> — посетитель Заведения, пользующийся гостевым приложением или чьи данные вносит персонал Заказчика.',
      ])}
      ${legalSection('2. Акцепт и заключение договора', [
        'Оферта адресована лицам, использующим Платформу для работы заведений общественного питания. Акцептом является регистрация личного кабинета с отметкой о согласии с офертой и Политикой обработки персональных данных, а также оплата Тарифа. Договор заключён с момента акцепта и действует до расторжения (раздел 11).',
        'Сторона договора по каждому оплаченному периоду определяется способом оплаты (раздел 5): при оплате банковской картой или через Систему быстрых платежей Заказчиком выступает физическое лицо, производящее оплату от своего имени; при оплате по счёту — индивидуальный предприниматель или юридическое лицо, указанные в счёте. Лицо, действующее от имени юридического лица или индивидуального предпринимателя, подтверждает свои полномочия.',
      ])}
      ${legalSection('3. Предмет договора', [
        'Исполнитель предоставляет Заказчику простую (неисключительную) лицензию на использование Платформы по модели SaaS (удалённый доступ через сеть Интернет) на территории всего мира на срок оплаченного периода, в объёме выбранного Тарифа. Заказчик не вправе модифицировать, декомпилировать Платформу и создавать производные продукты.',
        'Функции Платформы, включая учёт заказов и оплат, карту зала, склад, бронирование, программу лояльности, учёт смен и зарплаты, гостевое приложение и отчёты, определяются Тарифом. Исполнитель вправе развивать Платформу, не уменьшая объём функций оплаченного периода.',
        'Порядок оказания услуги: доступ к Платформе в объёме оплаченного Тарифа открывается автоматически в личном кабинете на сайте https://zalpos.ru сразу после подтверждения оплаты платёжным сервисом; приложения скачиваются в личном кабинете. Материальные носители не передаются, доставка не осуществляется. Подписание актов не требуется.',
      ])}
    </div>
    <div class="card">
      ${legalSection('4. Пробный период', [
        'При первой регистрации предоставляется бесплатный пробный период, длительность которого указана в карточке Тарифа. Платёжные данные для пробного периода не требуются. По его окончании доступ приостанавливается до оплаты. Исполнитель вправе не предоставлять повторный пробный период тому же лицу или Заведению.',
      ])}
      ${legalSection('5. Стоимость, порядок оплаты и чеки', [
        `Стоимость указана в Тарифе в рублях РФ и опубликована на сайте https://zalpos.ru и в личном кабинете; оплата — авансом за месяц, полгода или год. Оплата принимается через платёжный сервис ${PAYMENT_SERVICE} банковскими картами «Мир», Visa, Mastercard, через Систему быстрых платежей и другими способами, доступными на странице оплаты. Данные карты вводятся на защищённой странице платёжного сервиса; Исполнитель их не получает и не хранит.`,
        'Индивидуальные предприниматели и юридические лица оплачивают по счёту, выставленному в личном кабинете, переводом с расчётного счёта; через платёжный сервис принимаются только платежи физических лиц. Оплата по счёту — авансовая; доступ продлевается после поступления денежных средств на расчётный счёт Исполнителя (обычно 1–3 рабочих дня). Счёт действителен 10 банковских дней.',
        '<span class="legal-receipt">Чек об оплате направляется в электронной форме на email Заказчика в порядке, установленном законодательством РФ.</span> Акты оказанных услуг не составляются; чек подтверждает оплату и предоставление доступа.',
        'Автопродление включается только отдельной отметкой Заказчика перед оплатой. При включённом автопродлении Заказчик поручает списывать оплату очередного периода по действующей цене Тарифа с карты, которой произведена оплата; автопродление отключается в личном кабинете в любой момент. Исполнитель вправе изменять стоимость Тарифов, уведомив Заказчика не менее чем за 30 дней; изменение не распространяется на оплаченный период.',
        'При неоплате очередного периода доступ ко всем приложениям Заведения приостанавливается; данные сохраняются 10 календарных дней, после чего могут быть удалены безвозвратно.',
      ])}
    </div>
    <div class="card">
      ${legalSection('6. Права и обязанности сторон', [
        'Исполнитель обязуется: обеспечивать работоспособность Платформы; заблаговременно сообщать о плановых работах; оказывать техническую поддержку в личном кабинете и по email; обеспечивать конфиденциальность и безопасность данных Заказчика.',
        'Заказчик обязуется: использовать Платформу по назначению и в соответствии с законодательством РФ; обеспечивать сохранность доступа к личному кабинету и кодов приглашения устройств; своевременно вносить оплату; получать согласия Гостей и своих работников на обработку их персональных данных, когда это требуется законом.',
        'Заказчик самостоятельно отвечает за содержание меню, цен, акций, скидок, программы лояльности, публикаций и рассылок Заведения и их соответствие законодательству, в том числе Федеральному закону № 15-ФЗ (ограничения оборота табачной и никотинсодержащей продукции), Федеральному закону «О рекламе» (рассылки — только с предварительного согласия получателя) и Федеральному закону № 54-ФЗ. По умолчанию Платформа не применяет скидки и бонусы к позициям табачной и никотинсодержащей продукции; отключая это ограничение, Заказчик подтверждает, что такие позиции не содержат табака и никотина, и принимает ответственность на себя.',
        'Платформа не является контрольно-кассовой техникой. Для выдачи кассовых чеков Гостям Заказчик использует собственную зарегистрированную ККТ, договор с оператором фискальных данных и, при необходимости, договор эквайринга; Платформа обеспечивает техническое подключение к ним.',
      ])}
    </div>
    <div class="card">
      ${legalSection('7. Персональные данные и поручение на обработку', [
        'В отношении персональных данных Гостей и работников Заказчика оператором является Заказчик. Акцептуя оферту, Заказчик поручает Исполнителю обработку этих данных (ч. 3 ст. 6 Федерального закона № 152-ФЗ) в целях исполнения договора: запись, систематизацию, накопление, хранение, уточнение, извлечение, использование, передачу (в том числе трансграничную — для резервного копирования и синхронизации данных), блокирование, удаление и уничтожение.',
        'Исполнитель обязуется соблюдать конфиденциальность данных, принимать меры защиты по ст. 19 Федерального закона № 152-ФЗ, записывать имена и телефоны Гостей первично в базу данных, расположенную на территории РФ, уведомлять Заказчика об инцидентах с данными не позднее 24 часов с момента их выявления и по окончании договора удалять данные в сроки раздела 5.',
        'ИИ-помощники подключаются Заказчиком по собственному желанию с ключом выбранного им провайдера ИИ; договор с провайдером, в том числе о месте обработки данных, заключает Заказчик. Исполнитель передаёт провайдеру только сведения, нужные для ответа, без телефонов и email Гостей, а имена Гостей — в сокращённом виде.',
        'Обработка персональных данных самого Заказчика и его представителей осуществляется по Политике обработки персональных данных, опубликованной на сайте.',
      ])}
      ${legalSection('8. Интеллектуальная собственность и данные Заказчика', [
        'Исключительные права на Платформу, её программный код, интерфейс и обозначение ZalPOS принадлежат Исполнителю. Данные, внесённые Заказчиком (меню, склад, продажи, гости и т. д.), принадлежат Заказчику; Исполнитель использует их только для исполнения договора. До удаления данных Заказчик вправе запросить их выгрузку через поддержку.',
      ])}
    </div>
    <div class="card">
      ${legalSection('9. Ответственность', [
        'Стороны несут ответственность в соответствии с законодательством РФ. Исполнитель не отвечает за перерывы в работе, вызванные сбоями сетей связи, оборудования Заказчика или инфраструктуры сторонних провайдеров, а также за косвенные убытки и упущенную выгоду Заказчика. Совокупная ответственность Исполнителя ограничена суммой, уплаченной Заказчиком за последние 3 месяца.',
      ])}
      ${legalSection('10. Обстоятельства непреодолимой силы', [
        'Стороны освобождаются от ответственности за неисполнение обязательств вследствие обстоятельств непреодолимой силы, в том числе решений органов власти, массовых сбоев сети Интернет и инфраструктуры облачных провайдеров, не зависящих от воли сторон.',
      ])}
      ${legalSection('11. Срок действия, расторжение и возврат денежных средств', [
        'Договор действует до расторжения. Заказчик вправе расторгнуть его в любой момент, отказавшись от продления; оплаченный период используется до конца, возврат за неиспользованные дни не производится, если иное не согласовано сторонами или не предусмотрено законом. Заказчик — физическое лицо, приобретающее доступ для личных нужд, не связанных с предпринимательской деятельностью, вправе отказаться от договора в любое время с возвратом оплаты за неиспользованную часть периода (ст. 32 Закона РФ «О защите прав потребителей»). Исполнитель вправе приостановить доступ при существенном нарушении Заказчиком условий оферты, уведомив его по email.',
        'Денежные средства возвращаются: при ошибочной или повторной оплате; если услуга не была оказана по вине Исполнителя — пропорционально периоду, в котором Платформа была недоступна; в иных случаях, предусмотренных законодательством РФ. Для возврата Заказчик направляет заявление на email из раздела 14 с указанием даты и суммы платежа и причины возврата. Заявление рассматривается в течение 10 рабочих дней; возврат производится тем же способом, которым была произведена оплата (при оплате по счёту — на расчётный счёт плательщика). Срок зачисления средств зависит от банка Заказчика и обычно составляет от 1 до 30 дней.',
        'Исполнитель вправе изменять оферту, публикуя новую редакцию на сайте не менее чем за 10 дней до её вступления в силу. Продолжение использования Платформы означает согласие с новой редакцией.',
      ])}
    </div>
    <div class="card">
      ${legalSection('12. Порядок разрешения споров', [
        'Претензионный порядок обязателен; срок ответа на претензию — 30 календарных дней. Неурегулированные споры с индивидуальными предпринимателями и юридическими лицами рассматриваются в арбитражном суде по месту нахождения Исполнителя, с физическими лицами — в суде общей юрисдикции по правилам подсудности, установленным законом.',
      ])}
      ${legalSection('13. Уведомления', [
        'Юридически значимые сообщения направляются по email, указанному при регистрации (для Заказчика), и по email из раздела 14 (для Исполнителя), а также через личный кабинет. Сообщения по email признаются сторонами равнозначными документам на бумаге.',
      ])}
      ${legalSection('14. Реквизиты Исполнителя', [
        '<span id="legal-requisites" data-kind="offer">Индивидуальный предприниматель [ФИО полностью]. ОГРНИП: [указать]. ИНН: [указать]. Адрес для корреспонденции: [указать]. Банковские реквизиты: р/с [указать], банк [указать], БИК [указать], к/с [указать]. Email: [указать].</span>',
      ])}
    </div>
  `);
  fillLegalRequisites();
}

/** «Оплата и возврат» — выжимка из оферты для покупателя и модерации
 *  платёжного сервиса: как оплатить, как открывается доступ, чек,
 *  автопродление, возврат, контакты. */
function screenLegalPayment() {
  screenEl().innerHTML = publicPageWrapHtml('Оплата и возврат', `
    <div class="card">
      ${legalSection('Что вы оплачиваете', [
        'Подписку на облачную программу ZalPOS для кафе, ресторанов и баров: личный кабинет, кассовое приложение для Android и Windows, гостевое приложение и веб-страницы заведения. Тарифы и цены в рублях — <a href="#/">на главной странице</a> и в личном кабинете; оплата авансом за месяц, полгода или год. Перед оплатой можно бесплатно пользоваться пробным периодом.',
      ])}
      ${legalSection('Как оплатить', [
        `В личном кабинете выберите тариф и нажмите «Оплатить» — откроется защищённая страница платёжного сервиса ${PAYMENT_SERVICE}. Принимаются банковские карты «Мир», Visa, Mastercard, оплата через Систему быстрых платежей и другие способы, доступные на странице оплаты.`,
        'Данные карты вводятся только на странице платёжного сервиса и передаются по защищённому соединению с подтверждением 3-D Secure. Мы их не получаем и не храним.',
        'Картой и через СБП платят физические лица — от своего имени, чек выдаётся на физическое лицо.',
      ])}
      ${legalSection('Оплата от ИП и организаций — по счёту', [
        'Если нужен чек на ИП или организацию (для учёта расходов), в личном кабинете выберите «ИП или организация», укажите название и ИНН и нажмите «Продлить» — появится счёт, его можно распечатать или сохранить в PDF. Оплатите его переводом с расчётного счёта; подписка продлится, когда деньги поступят, обычно через 1–3 рабочих дня.',
      ])}
      ${legalSection('Когда откроется доступ', [
        'Сразу после подтверждения оплаты — обычно в течение нескольких минут — подписка продлевается автоматически, доступ открывается в личном кабинете на zalpos.ru. Доставки нет: все приложения скачиваются в личном кабинете.',
      ])}
      ${legalSection('Чек', [
        '<span class="legal-receipt">Чек об оплате направляется в электронной форме на email, указанный при оплате.</span>',
      ])}
    </div>
    <div class="card">
      ${legalSection('Автопродление', [
        'Автопродление включается только по вашему желанию — отдельной галочкой «Автопродление» перед оплатой (по умолчанию она снята). Тогда оплата следующего периода по текущей цене тарифа списывается с той же карты автоматически в последний день текущего. Отключить автопродление можно в любой момент в личном кабинете, в разделе «Оплата»; уже оплаченный период продолжает действовать до конца. Без галочки ничего автоматически не списывается — следующий период оплачивается вручную.',
      ])}
      ${legalSection('Возврат денежных средств', [
        'Деньги возвращаются при ошибочной или повторной оплате, если услуга не была оказана по нашей вине (пропорционально времени, когда программа была недоступна), и в других случаях, предусмотренных законодательством РФ. За неиспользованные дни оплаченного периода при добровольном отказе возврат не производится — период можно доиспользовать до конца.',
        'Как вернуть: напишите нам (<span class="legal-contacts">контакты — в реквизитах ниже</span>) и укажите дату и сумму платежа, email личного кабинета и причину. Заявление рассматривается в течение 10 рабочих дней, деньги возвращаются тем же способом, которым была произведена оплата (при оплате по счёту — на расчётный счёт плательщика); срок зачисления зависит от банка и обычно составляет от 1 до 30 дней. Если вы оплачивали как физическое лицо для личных нужд, при отказе от подписки мы вернём оплату за неиспользованную часть периода.',
      ])}
      ${legalSection('Документы', [
        'Полные условия — в <a href="#/legal/offer">публичной оферте</a>, обработка данных — в <a href="#/legal/privacy">политике конфиденциальности</a>.',
      ])}
    </div>
  `);
  fillLegalRequisites();
}

/** Согласие на обработку персональных данных владельца кабинета — отдельный
 *  документ (ч. 1 и 4 ст. 9 152-ФЗ; с 01.09.2025 согласие оформляется
 *  отдельно от оферты и других документов). Даётся отдельной галочкой при
 *  регистрации; момент — users/{uid}.pdConsentAt. */
function screenLegalConsent() {
  screenEl().innerHTML = publicPageWrapHtml('Согласие на обработку персональных данных', `
    <p class="small muted">${LEGAL_EDITION}</p>
    <div class="card">
      ${legalSection('Кому даётся согласие', [
        'Отмечая при регистрации пункт о согласии, я, действуя свободно, своей волей и в своём интересе, даю согласие Оператору — <span id="legal-requisites" data-kind="privacy">индивидуальному предпринимателю, правообладателю платформы ZalPOS (реквизиты — в политике конфиденциальности)</span> — на обработку моих персональных данных на условиях ниже.',
      ])}
      ${legalSection('Какие данные', [
        'Адрес электронной почты; имя и номер телефона, если я их укажу; сведения о созданных мной заведениях, тарифе и оплатах; сообщения в поддержку; IP-адрес, сведения о браузере и устройстве, дата и время входов.',
      ])}
      ${legalSection('Зачем', [
        'Регистрация и вход в личный кабинет ZalPOS; заключение и исполнение договора-оферты, включая приём оплаты; направление писем о входе, оплате и работе сервиса; техническая поддержка; обеспечение безопасности и предотвращение злоупотреблений.',
      ])}
      ${legalSection('Что с ними делают', [
        'Сбор, запись, систематизация, накопление, хранение, уточнение, извлечение, использование, передача (предоставление, доступ), блокирование, удаление и уничтожение — с использованием средств автоматизации.',
        'В том числе трансграничная передача компании Google LLC на серверы в США (авторизация и push-уведомления), в Бельгии и Нидерландах (хранение и синхронизация данных), и передача платёжному сервису Robokassa — для приёма оплаты.',
      ])}
      ${legalSection('Срок и отзыв', [
        'Согласие действует до его отзыва, но не дольше 3 лет после прекращения договора. Отозвать согласие можно письмом на email Оператора, указанный в политике конфиденциальности; после отзыва обработка прекращается в течение 10 рабочих дней, кроме случаев, когда она необходима для исполнения договора или требуется законом.',
      ])}
    </div>
  `);
  fillLegalRequisites();
}

function screenLegalPrivacy() {
  screenEl().innerHTML = publicPageWrapHtml('Политика обработки персональных данных', `
    <p class="small muted">${LEGAL_EDITION} Политика разработана во исполнение ст. 18.1 Федерального закона от 27.07.2006 № 152-ФЗ «О персональных данных» и определяет порядок обработки и меры защиты персональных данных при использовании Платформы ZalPOS.</p>
    <div class="card">
      ${legalSection('1. Оператор', [
        'Оператор — индивидуальный предприниматель, правообладатель Платформы ZalPOS (реквизиты — раздел 12). В отношении данных Гостей и работников заведений оператором является владелец заведения (Заказчик), а Оператор обрабатывает их по его поручению на основании договора-оферты.',
      ])}
      ${legalSection('2. Субъекты и состав данных', [
        '<b>Пользователи личного кабинета</b> (владельцы и представители заведений): email, имя, роль, сведения об оплатах, журнал действий в кабинете; при оплате по счёту — ФИО индивидуального предпринимателя или наименование организации, ИНН и КПП плательщика.',
        '<b>Работники заведений</b>: имя, должность, PIN-код входа в кассу (в защищённом виде), время смен, сведения для расчёта зарплаты.',
        '<b>Гости заведений</b>: имя, номер телефона, сведения о бронированиях, заказах, посещениях, бонусах и отзывах.',
        'Специальные категории и биометрические персональные данные не обрабатываются. Платформа не предназначена для сбора данных лиц младше 14 лет.',
      ])}
      ${legalSection('3. Цели обработки', [
        'Заключение и исполнение договора с Заказчиком; предоставление доступа к Платформе и техническая поддержка; ведение учёта заказов, бронирований, программы лояльности, смен и зарплаты по поручению заведений; направление сервисных уведомлений; исполнение требований законодательства, в том числе о бухгалтерском учёте, применении ККТ и налоге на профессиональный доход (чеки с ИНН покупателя).',
      ])}
      ${legalSection('4. Правовые основания', [
        'Согласие субъекта персональных данных; исполнение договора, стороной или выгодоприобретателем по которому является субъект; поручение оператора (заведения) по ч. 3 ст. 6 Федерального закона № 152-ФЗ; исполнение обязанностей, возложенных законодательством РФ.',
      ])}
    </div>
    <div class="card">
      ${legalSection('5. Порядок и условия обработки', [
        'Обработка ведётся с использованием средств автоматизации и включает сбор, запись, систематизацию, накопление, хранение, уточнение, извлечение, использование, передачу (предоставление, доступ), блокирование, удаление и уничтожение.',
        'Доступ к данным заведения имеют его сотрудники в пределах назначенных ролей. Персонал Оператора получает доступ только для технической поддержки и в необходимом объёме. Данные разных заведений изолированы друг от друга.',
        'Данные не передаются третьим лицам, кроме случаев, предусмотренных законом, и поставщиков инфраструктуры, указанных в разделе 6, действующих на условиях конфиденциальности.',
        `При оплате тарифа email плательщика и сведения о платеже передаются платёжному сервису ${PAYMENT_SERVICE} для приёма оплаты и отправки чека; данные банковской карты вводятся на странице платёжного сервиса и Оператору не передаются. При оплате по счёту реквизиты плательщика используются для выставления счёта и формирования чека с ИНН покупателя в приложении «Мой налог» (сведения о чеке передаются в ФНС России в силу Федерального закона № 422-ФЗ).`,
        'Если заведение подключило ИИ-помощников, запросы к ним обрабатывает провайдер ИИ, выбранный заведением, по договору заведения с этим провайдером. Провайдеру передаются текст вопроса и сведения, нужные для ответа (меню, занятость столов, брони); имена гостей заменяются первой буквой, телефоны и email гостей не передаются. Гостям не следует сообщать в чате ИИ-помощника свои персональные данные.',
      ])}
      ${legalSection('6. Место хранения и трансграничная передача', [
        'Имена и телефоны Гостей (профили, бронирования, лист ожидания), а также email пользователей личного кабинета, сведения об их согласии и реквизиты плательщиков по счёту первично записываются в базу данных на сервере Оператора, расположенном на территории Российской Федерации (ч. 5 ст. 18 Федерального закона № 152-ФЗ).',
        'Для синхронизации данных между устройствами, резервного копирования, авторизации пользователей и push-уведомлений используется облачная инфраструктура Google LLC (США): авторизация и push-уведомления — на серверах в США, хранение и синхронизация данных — в центрах обработки данных Google Cloud в Бельгии и Нидерландах. Трансграничная передача осуществляется с согласия субъекта и после уведомления Роскомнадзора в порядке ст. 12 Федерального закона № 152-ФЗ; получатель обеспечивает защиту данных (шифрование при хранении и передаче, сертификация ISO/IEC 27001, 27017, 27018).',
      ])}
      ${legalSection('7. Сроки обработки и хранения', [
        'Данные обрабатываются в течение срока действия договора с заведением и 10 календарных дней после его прекращения, после чего уничтожаются, если более длительный срок не требуется по закону. Данные, обработка которых прекращена по требованию субъекта, уничтожаются в течение 10 рабочих дней.',
      ])}
    </div>
    <div class="card">
      ${legalSection('8. Права субъекта персональных данных', [
        'Субъект вправе получать сведения об обработке своих данных, требовать их уточнения, блокирования или уничтожения, отозвать согласие, обжаловать действия Оператора в Роскомнадзоре или в суде (ст. 14 Федерального закона № 152-ФЗ).',
        'Гость может сам удалить свои данные кнопкой «Удалить мои данные» в профиле приложения или веб-версии заведения: имя, телефон и день рождения удаляются сразу, в том числе из базы на сервере в РФ, а накопленные бонусы аннулируются.',
        'Запросы направляются на email из раздела 12; ответ даётся в течение 10 рабочих дней. Гости вправе обратиться и непосредственно в заведение как к оператору своих данных.',
      ])}
      ${legalSection('9. Меры защиты', [
        'Назначено лицо, ответственное за организацию обработки персональных данных; утверждена настоящая Политика; доступ к данным разграничен по ролям и защищён авторизацией; данные передаются по защищённым каналам (TLS); ведутся резервное копирование и журналирование действий; обеспечивается антивирусная защита; уровень защищённости информационной системы определён в соответствии с Постановлением Правительства РФ № 1119.',
        'Об инцидентах с персональными данными Оператор уведомляет Роскомнадзор в сроки ч. 3.1 ст. 21 Федерального закона № 152-ФЗ: в течение 24 часов — о самом инциденте, в течение 72 часов — о результатах расследования.',
      ])}
      ${legalSection('10. Файлы cookie и локальное хранилище', [
        'Сайт и приложения используют локальное хранилище браузера и устройства для сохранения входа и настроек. Сторонние рекламные и аналитические счётчики не используются.',
      ])}
    </div>
    <div class="card">
      ${legalSection('11. Заключительные положения', [
        'Оператор вправе изменять Политику; новая редакция действует с момента публикации на этой странице.',
      ])}
      ${legalSection('12. Реквизиты и контакты', [
        '<span id="legal-requisites" data-kind="privacy">Индивидуальный предприниматель [ФИО полностью]. ОГРНИП: [указать]. ИНН: [указать]. Адрес: [указать]. Номер в реестре операторов персональных данных: [указать]. Email для обращений по вопросам персональных данных: [указать].</span>',
      ])}
    </div>
  `);
  fillLegalRequisites();
}

function screenStatus() {
  screenEl().innerHTML = publicPageWrapHtml('Статус системы', `
    <div class="card">
      <div class="row" style="align-items:center;gap:10px">
        <div style="width:10px;height:10px;border-radius:50%;background:#3DD68C;flex:none"></div>
        <div class="small">Платформа работает на надёжной облачной инфраструктуре с резервированием и автомасштабированием</div>
      </div>
      <p class="small muted" style="margin-top:12px">Отдельный мониторинг аптайма поверх инфраструктуры провайдера мы не ведём — актуальный статус смотрите на официальной странице провайдера:</p>
      <a class="btn btn-ghost" href="https://status.firebase.google.com/" target="_blank" rel="noopener">Открыть страницу статуса провайдера ↗</a>
    </div>
    <div class="card">
      <div class="small muted">Если у провайдера всё штатно, а вход в консоль или касса не открывается — это, скорее всего, проблема на нашей стороне. Опишите это в поддержке, указав код заведения и время сбоя.</div>
    </div>
  `);
}

function screenPublicFaq() {
  screenEl().innerHTML = publicPageWrapHtml('Частые вопросы', `
    <div class="card">
      ${FAQ_ITEMS.map((item, i) => `
        <div class="faq-item" data-faq="${i}">
          <div class="faq-question"><span>${esc(item.q)}</span><span class="faq-toggle">+</span></div>
          <div class="faq-answer">${esc(item.a)}${item.link ? ` <a href="${item.link.href}">${esc(item.link.text)}</a>` : ''}</div>
        </div>
      `).join('')}
    </div>
  `);
  document.querySelectorAll('.faq-item').forEach((el) => {
    el.querySelector('.faq-question')?.addEventListener('click', () => el.classList.toggle('open'));
  });
}

// Авторы фото демо-меню (лицензии CC BY/BY-SA требуют указывать авторство).
// Список ведётся в demo-menu/CREDITS.txt рядом с самими фото, здесь — в
// читаемом виде: фото, автор, источник и лицензия.
function screenDemoPhotos() {
  screenEl().innerHTML = publicPageWrapHtml('Фото блюд в демо-заведении', `
    <p class="small muted">Фото в демо-меню — только для примера, со свободных фотостоков. В вашем заведении
    гости увидят ваши фото и ваше меню. Фото обрезаны до квадрата и уменьшены; изменённые фото под
    лицензией CC BY-SA распространяются на тех же условиях.</p>
    <div class="credits-grid" id="credits-grid"><div class="spinner"></div></div>
  `);
  const licenseUrl = {
    'CC0 1.0': 'https://creativecommons.org/publicdomain/zero/1.0/deed.ru',
    'PDM 1.0': 'https://creativecommons.org/publicdomain/mark/1.0/deed.ru',
    'BY 2.0': 'https://creativecommons.org/licenses/by/2.0/deed.ru',
    'BY-SA 2.0': 'https://creativecommons.org/licenses/by-sa/2.0/deed.ru',
  };
  fetch('/demo-menu/CREDITS.txt').then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).then((text) => {
    const box = $('credits-grid');
    if (!box) return;
    const rows = text.split('\n').map((line) => line.match(/^(\S+\.jpg) — (.*), (https?:\/\/\S+), (.+)$/)).filter(Boolean);
    box.innerHTML = rows.map(([, file, author, source, license]) => {
      const lic = license.trim();
      const licHref = licenseUrl[lic];
      return `
        <div class="credit-card">
          <img src="/demo-menu/${esc(file)}" alt="" loading="lazy">
          <div class="credit-text">
            <div class="credit-author">${author === 'автор не указан' ? 'Автор не указан' : esc(author)}</div>
            <div class="small muted">
              <a href="${esc(source)}" target="_blank" rel="noopener nofollow">Источник</a> ·
              ${licHref ? `<a href="${licHref}" target="_blank" rel="noopener nofollow">${esc(lic.startsWith('C') || lic.startsWith('P') ? lic : 'CC ' + lic)}</a>` : esc(lic)}
            </div>
          </div>
        </div>`;
    }).join('');
  }).catch(() => {
    const box = $('credits-grid');
    if (box) box.innerHTML = '<p class="small muted">Не удалось загрузить список — попробуйте обновить страницу.</p>';
  });
}

// ---------- ВХОД / РЕГИСТРАЦИЯ ----------

let authMode = 'login'; // 'login' | 'signup' — держим отдельно от state: это выбор экрана, а не данные аккаунта.

function screenAuth() {
  screenEl().innerHTML = `
    <div class="brand">ZalPOS</div>
    <h1>${authMode === 'login' ? 'Вход в консоль' : 'Регистрация владельца'}</h1>
    <p class="muted">Личный кабинет владельца заведения: подписка, код
    приглашения устройств, брендинг приложения для гостей.</p>
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
        <label class="row" style="align-items:flex-start;gap:8px;margin-bottom:8px">
          <input type="checkbox" id="f-agree" style="width:auto">
          <span class="small muted">Принимаю условия <a href="#/legal/offer" target="_blank" rel="noopener">публичной оферты</a></span>
        </label>
        <label class="row" style="align-items:flex-start;gap:8px;margin-bottom:14px">
          <input type="checkbox" id="f-pd" style="width:auto">
          <span class="small muted">Даю <a href="#/legal/consent" target="_blank" rel="noopener">согласие на обработку персональных данных</a>, в том числе на их трансграничную передачу (<a href="#/legal/privacy" target="_blank" rel="noopener">политика конфиденциальности</a>)</span>
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
        await sendAuthEmail('passwordReset', email, () => sendPasswordResetEmail(state.auth, email));
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
      errEl.textContent = 'Нужно принять условия оферты';
      return;
    }
    if (authMode === 'signup' && !$('f-pd')?.checked) {
      errEl.textContent = 'Нужно согласие на обработку персональных данных — без него мы не сможем создать личный кабинет';
      return;
    }
    $('f-submit').disabled = true;
    try {
      if (authMode === 'login') {
        await signInWithEmailAndPassword(state.auth, email, pass);
      } else {
        await recordOwnerInRussia(email);
        const cred = await createUserWithEmailAndPassword(state.auth, email, pass);
        await setDoc(doc(state.db, 'users', cred.user.uid), {
          email, createdAt: Timestamp.fromDate(new Date()),
          offerAcceptedAt: Timestamp.fromDate(new Date()),
          pdConsentAt: Timestamp.fromDate(new Date()),
          pdConsentEdition: LEGAL_EDITION,
        }, { merge: true });
        linkOwnerInRussia(cred.user);
        // Без подтверждения почты заведение не создать — защита от регистрации на чужой адрес.
        try { await sendAuthEmail('verifyEmail', cred.user.email, () => sendEmailVerification(cred.user)); } catch (_) {}
        // Пароль сгенерирован случайно — по этому письму владелец задаст свой.
        try { await sendAuthEmail('passwordReset', email, () => sendPasswordResetEmail(state.auth, email)); } catch (_) {}
      }
      // Дальше экран сменит onAuthStateChanged.
    } catch (e) {
      errEl.textContent = authErrorMessage(e);
      $('f-submit').disabled = false;
    }
  };
  $('f-submit').onclick = submit;
  if ($('f-pass')) $('f-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function screenLoading() {
  screenEl().innerHTML = `<div class="brand">ZalPOS</div><div class="spinner"></div>`;
}

// ---------- ПОДТВЕРЖДЕНИЕ ПОЧТЫ ----------

function screenVerifyEmail() {
  const email = state.auth.currentUser?.email || '';
  screenEl().innerHTML = `
    <div class="brand">ZalPOS</div>
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
      await sendAuthEmail('verifyEmail', state.auth.currentUser.email,
        () => sendEmailVerification(state.auth.currentUser));
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
  // Без подтверждённой почты заведение не создаём; сервер проверяет то же.
  if (!state.auth.currentUser?.emailVerified) {
    return screenVerifyEmail();
  }

  let selectedPaletteId = PREMIUM_PALETTES[0].id;

  screenEl().innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:8px">
      <div class="brand">ZalPOS</div>
      ${state.isSuperAdmin ? '<a href="#/admin" class="btn-link">Платформа</a>' : ''}
    </div>
    <h1>Новое заведение</h1>
    <p class="muted">Код заведения используется в ссылках и как основа
    имени Android-приложения — только латиница, цифры и дефис.</p>
    <div class="card">
      <label class="field-checkbox" style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
        <input type="checkbox" id="f-is-chain" style="width:auto">
        <span>Это сеть из нескольких заведений одного владельца (общий биллинг и лояльность на все точки)</span>
      </label>
      <div id="f-chain-fields" style="display:none">
        <label class="field"><span>Название сети</span>
          <input id="f-chain-name" placeholder="Сеть «Лето»">
        </label>
        <label class="field"><span>Код сети</span>
          <input id="f-chain-slug" placeholder="leto">
        </label>
        <div class="small muted" style="margin:-6px 0 14px">Ниже — первая точка сети. Ещё точки можно
        добавить позже из личного кабинета кнопкой «Добавить точку сети».</div>
      </div>
      <label class="field"><span id="f-name-label">Название заведения</span>
        <input id="f-name" placeholder="Кафе «Лето»">
      </label>
      <label class="field"><span id="f-slug-label">Код заведения</span>
        <input id="f-slug" placeholder="kafe-leto">
      </label>
      <label class="field"><span>Тип заведения</span>
        <select id="f-venue-type">
          <option value="hookah">Кальянная / лаунж</option>
          <option value="restaurant">Ресторан</option>
          <option value="cafe">Кафе / кофейня</option>
          <option value="bar">Бар</option>
        </select>
      </label>
      <div class="small muted" style="margin:-6px 0 14px">От типа зависят слова в приложении гостя
      («позвать кальянщика» или «позвать официанта») и кнопки вызова за столом. Сменить можно на кассе:
      Настройки → Профиль заведения.</div>
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

  const chainNameEl = $('f-chain-name');
  const chainSlugEl = $('f-chain-slug');
  let chainSlugTouched = false;
  chainSlugEl.addEventListener('input', () => { chainSlugTouched = true; });
  chainNameEl.addEventListener('input', () => {
    if (!chainSlugTouched) chainSlugEl.value = slugify(chainNameEl.value);
  });
  const applyChainToggle = (isChain) => {
    $('f-chain-fields').style.display = isChain ? '' : 'none';
    $('f-name-label').textContent = isChain ? 'Название первой точки' : 'Название заведения';
    $('f-slug-label').textContent = isChain ? 'Код первой точки' : 'Код заведения';
    $('f-submit').textContent = isChain ? 'Создать сеть' : 'Создать заведение';
  };
  $('f-is-chain').addEventListener('change', (e) => applyChainToggle(e.target.checked));
  // Пришёл с лендинга с тарифом сети — сразу отмечаем «Это сеть».
  if (window.localStorage.getItem('presetIsChain') === '1') {
    $('f-is-chain').checked = true;
    applyChainToggle(true);
  }

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

  // Сеть создана, а первая точка нет (например, занят код) — повторное
  // нажатие не должно заводить вторую сеть.
  let createdChainId = null;
  $('f-submit').onclick = async () => {
    const isChain = $('f-is-chain').checked;
    const name = nameEl.value.trim();
    const slug = slugEl.value.trim();
    const chainName = chainNameEl.value.trim();
    const chainSlug = chainSlugEl.value.trim();
    const label = $('f-brand-name').value.trim();
    const errEl = $('f-error');
    errEl.textContent = '';
    if (isChain && chainName.length < 2) {
      errEl.textContent = 'Введите название сети';
      return;
    }
    if (isChain && !chainSlug) {
      errEl.textContent = 'Код сети не получился из названия автоматически (например, из-за кириллицы) — впишите его латиницей вручную';
      return;
    }
    if (name.length < 2) {
      errEl.textContent = isChain ? 'Введите название первой точки' : 'Введите название заведения';
      return;
    }
    if (!slug) {
      errEl.textContent = (isChain ? 'Код точки' : 'Код заведения') + ' не получился из названия автоматически (например, из-за кириллицы) — впишите его латиницей вручную';
      return;
    }
    $('f-submit').disabled = true;
    try {
      // Тариф, выбранный на лендинге: пробный период от него не зависит, он
      // определяет лимиты и цену после триала.
      const chosenPlanId = window.localStorage.getItem('selectedPlanId');
      // «Купить сразу»: заведение создаётся обычным путём, а оплата
      // открывается сразу, до кабинета.
      const skipTrial = window.localStorage.getItem('skipTrial') === '1';
      const chosenPeriod = ['semiannual', 'yearly'].includes(window.localStorage.getItem('selectedBillingPeriod'))
        ? window.localStorage.getItem('selectedBillingPeriod') : 'monthly';

      // Сеть: сначала пустая сеть, потом первая точка с её chainId.
      let chainId = isChain ? createdChainId : null;
      if (isChain && !chainId) {
        const chainRes = await callSaasGateway(
          'createChain',
          chosenPlanId ? { name: chainName, slug: chainSlug, planId: chosenPlanId } : { name: chainName, slug: chainSlug }
        );
        chainId = chainRes.data.chainId;
        createdChainId = chainId;
      }
      const res = await callSaasGateway(
        'createTenant',
        {
          name, slug, venueType: $('f-venue-type').value,
          ...(chosenPlanId && !isChain ? { planId: chosenPlanId } : {}), ...(chainId ? { chainId } : {}),
        }
      );
      window.localStorage.removeItem('selectedPlanId');
      window.localStorage.removeItem('skipTrial');
      window.localStorage.removeItem('presetIsChain');
      window.localStorage.removeItem('selectedBillingPeriod');
      const tenantId = res.data.tenantId;
      state.activeTenantId = tenantId;
      // Сервер завёл брендинг по умолчанию — дописываем выбранные цвета и
      // лейбл (у сети — в брендинг самой сети: его читают приложения гостей).
      // Цвета берём из полей, чтобы учесть ручные правки поверх гаммы.
      const appName = label || (isChain ? chainName : name);
      try {
        await writeBrandingConfig(tenantId, {
          appName,
          shortName: appName.slice(0, 12),
          primaryColor: $('f-color-primary').value,
          secondaryColor: $('f-color-secondary').value,
          buttonColor: $('f-color-button').value,
          backgroundColor: $('f-color-bg').value,
          textColor: $('f-color-text').value,
        }, chainId);
      } catch (_) {
        // Необязательный шаг: заведение уже работает с брендингом по умолчанию.
      }
      // «Купить сразу» — на оплату до отрисовки кабинета. Не открылась —
      // говорим об этом: заведение уже создано, оплатить можно из кабинета.
      if (skipTrial && chosenPlanId) {
        const paid = await startCheckout(tenantId, chosenPlanId, chosenPeriod, chainId);
        if (!paid) {
          toast('Не удалось перейти к оплате — заведение создано, оплатите его во вкладке «Тарифы»');
        }
        return;
      }
      // Новое членство придёт через watchMemberships, экран перерисуется сам.
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

// Вопросы, которые на самом деле задают при выборе и подключении.
const FAQ_ITEMS = [
  { q: 'Что входит в пробный период?', a: 'Все функции выбранного тарифа. Оплата не запрашивается, пока пробный период не закончится, банковская карта не нужна. Срок указан в карточке тарифа. В пробный период тариф можно бесплатно поменять в разделе «Оплата», например чтобы попробовать тариф с ИИ-помощником.' },
  { q: 'Что будет, если не оплатить вовремя?', a: 'Касса и приложение на всех устройствах заведения блокируются сразу после окончания оплаченного периода. Данные при этом не удаляются 10 дней (грейс-период) — если оплатить в течение этого срока, всё восстановится как было. После 10 дней данные удаляются безвозвратно.' },
  { q: 'Как подключить планшет на кассе?', a: 'В разделе «Устройства» — код приглашения и универсальный APK. Устанавливаете APK на планшет, при первом запуске вводите код заведения и код приглашения — планшет сам подключится к вашему заведению.' },
  { q: 'Можно ли сменить тариф позже?', a: 'Да. В пробный период это бесплатно и сразу, в разделе «Оплата». После оплаты выберите другой тариф при следующей оплате: он начнёт действовать с неё, без обращения в поддержку.' },
  { q: 'Есть ли фискализация чеков (54-ФЗ)?', a: 'Да, через вашу онлайн-кассу АТОЛ: система отправляет в неё чек с позициями, ставками НДС и способами оплаты. Саму ККТ с фискальным накопителем, договор с ОФД и регистрацию в ФНС оформляете вы: система к ним подключается, но не заменяет их. Карты принимаются через ваш банковский терминал или эквайринг, подключение настраивается в разделе «Интеграции» на кассе.' },
  { q: 'Где хранятся данные заведения?', a: 'Имена и телефоны гостей сначала записываются на наш сервер в России, остальные данные — в облаке с резервированием. Данные заведений разделены правилами доступа: другие заведения платформы не могут увидеть ваши данные — это проверяется автоматическими тестами защиты.' },
  { q: 'Сколько сотрудников и устройств можно подключить?', a: 'Число сотрудников и рабочих мест (планшетов, телефонов, компьютеров) указано в карточке тарифа. За каждое рабочее место отдельно платить не нужно. Когда лимит сотрудников достигнут, касса предложит удалить уволенного сотрудника или перейти на тариф выше. Онлайн-касса (ККТ) для фискальных чеков покупается отдельно у её поставщика.' },
  { q: 'Что будет с данными, если я перестану пользоваться?', a: 'После отмены подписки данные хранятся 10 дней (грейс-период), затем удаляются безвозвратно. Экспортировать данные до удаления можно, обратившись в поддержку.' },
  { q: 'Откуда фото блюд в демо-заведении?', a: 'Это фото со свободных фотостоков — для примера, в вашем заведении будут ваши фото и ваше меню. Авторы и лицензии указаны на отдельной странице.', link: { href: '#/demo-photos', text: 'Авторы фото →' } },
];

function screenDashboard() {
  screenEl().classList.add('has-tabbar');
  // Переключатель заведения — в боковом меню, доступен с любой вкладки.
  screenEl().innerHTML = `<div id="dash-body"><div class="spinner"></div></div>`;
  watchDashboardData(state.activeTenantId);
}

// Свои SVG-иконки вместо эмодзи: у эмодзи разная палитра и размеры, ряд
// выглядел случайным. Один viewBox 24×24, цвет задаёт фон чипа.
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
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="M12 8.5 13.2 11l2.3 1-2.3 1L12 15.5 10.8 13l-2.3-1 2.3-1Z"/>',
};

function navIconHtml(name, color) {
  // Значок — линейный, цвета текста: цветные плитки под каждым разделом
  // спорили между собой и с содержимым. [color] больше не нужен.
  void color;
  return `<span class="nav-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${NAV_ICON_PATHS[name] || ''}</svg></span>`;
}

// Провайдеры ИИ — те же значения, что AiVendors в
// lib/services/ai/ai_settings.dart и AI_VENDOR_DEFAULTS в saas-gateway.
const AI_VENDORS = [
  { id: 'tooken', title: 'Tooken Club', baseUrl: 'https://tooken.club/v1', model: 'gpt-4o-mini',
    hint: 'Ключ из личного кабинета tooken.club', models: ['gpt-4o-mini', 'gpt-4o', 'claude-sonnet-4-5', 'deepseek-chat'] },
  { id: 'darkapi', title: 'DarkAPI', baseUrl: 'https://darkapi.shop/v1', model: 'deepseek-chat',
    hint: 'Ключ из кабинета darkapi.shop — там же адрес API', models: ['deepseek-chat', 'deepseek-reasoner'],
    note: 'Имена моделей у DarkAPI свои — сверьте с кабинетом darkapi.shop.' },
  { id: 'gemini', title: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest',
    hint: 'Ключ из Google AI Studio (aistudio.google.com → Get API key)', models: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest'],
    note: 'Google не пускает к Gemini API из России — нужен прокси в «Адресе API» или резервный провайдер.' },
  { id: 'custom', title: 'Свой шлюз', baseUrl: '', model: 'gpt-4o-mini',
    hint: 'Ключ из кабинета вашего шлюза', models: [], note: 'Любой OpenAI- или Anthropic-совместимый шлюз — укажите его адрес.' },
];
const aiVendor = (id) => AI_VENDORS.find((v) => v.id === id) || AI_VENDORS[0];

const DASHBOARD_NAV = [
  { id: 'overview', icon: 'home', color: '#2F6FED', label: 'Обзор' },
  { id: 'devices', icon: 'device', color: '#0EA5E9', label: 'Устройства' },
  { id: 'billing', icon: 'card', color: '#F59E0B', label: 'Оплата' },
  { id: 'plans', icon: 'gem', color: '#8B5CF6', label: 'Тарифы' },
  { id: 'branding', icon: 'palette', color: '#EC4899', label: 'Брендинг' },
  { id: 'team', icon: 'users', color: '#10B981', label: 'Команда' },
  { id: 'ai', icon: 'spark', color: '#A855F7', label: 'ИИ' },
  { id: 'profile', icon: 'user', color: '#06B6D4', label: 'Профиль' },
  { id: 'settings', icon: 'gear', color: '#64748B', label: 'Настройки' },
  { id: 'faq', icon: 'question', color: '#EF4444', label: 'FAQ' },
  { id: 'support', icon: 'chat', color: '#22C55E', label: 'Поддержка' },
];

// Точки одной сети — под общим <optgroup>, иначе у владельца сети из пяти
// точек получается плоский список похожих названий.
function tenantSwitcherOptionsHtml() {
  const option = (t) => `<option value="${esc(t.id)}" ${t.id === state.activeTenantId ? 'selected' : ''}>${esc(t.name || t.id)}</option>`;
  const standalone = state.tenants.filter((t) => !t.chainId);
  const chainGroups = new Map();
  state.tenants.forEach((t) => {
    if (!t.chainId) return;
    if (!chainGroups.has(t.chainId)) chainGroups.set(t.chainId, { name: t.chainName || t.chainId, items: [] });
    chainGroups.get(t.chainId).items.push(t);
  });
  let html = standalone.map(option).join('');
  chainGroups.forEach((group) => {
    html += `<optgroup label="Сеть «${esc(group.name)}»">${group.items.map(option).join('')}</optgroup>`;
  });
  return html;
}

function dashboardNavHtml(activeTab, showBillingDot, tenantName, chainId) {
  const activeMeta = DASHBOARD_NAV.find((t) => t.id === activeTab);
  return `
    <div class="dash-topbar">
      <button class="hamburger-btn" id="f-nav-open" aria-label="Меню">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
      </button>
      <div class="dash-topbar-title">
        <div class="dash-topbar-tenant">${esc(tenantName || 'ZalPOS')}</div>
        <div class="dash-topbar-tab">${esc(activeMeta?.label || '')}</div>
      </div>
      ${themeToggleHtml()}
      <span class="brand-gem" aria-hidden="true"></span>
    </div>
    <div class="nav-backdrop" id="nav-backdrop"></div>
    <div class="nav-drawer" id="nav-drawer">
      <div class="nav-drawer-brand"><span class="brand-gem" aria-hidden="true"></span>ZalPOS${themeToggleHtml()}</div>
      ${state.tenants.length > 1 ? `
        <label class="field"><span>Заведение</span>
          <select id="f-nav-tenant-pick">
            ${tenantSwitcherOptionsHtml()}
          </select>
        </label>
      ` : `<div class="nav-drawer-tenant">${esc(tenantName || '')}</div>`}
      ${chainId ? `
        <button class="nav-item" id="f-nav-add-location">
          ${navIconHtml('plus', '#22C55E')}<span>Добавить точку сети</span>
        </button>
      ` : ''}
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
  let venueProfile = null;
  // ИИ: публичные настройки, ключи и несохранённые правки формы. draw()
  // перерисовывает экран целиком, поэтому правки держим в aiDraft.
  let aiPub = null;
  let aiSec = null;
  let aiLegacy = null; // настройки самой точки сети до перехода на общие
  let aiDraft = null;
  let paymentHistory = null;
  // Счета для ИП и организаций и черновик формы плательщика — по той же
  // причине, что aiDraft.
  let bankInvoices = null;
  const payerDraft = { mode: 'individual', type: 'ip', name: '', inn: '', kpp: '' };
  // Объявления платформы. Скрытые запоминаем в localStorage: синхронизировать
  // «прочитано» между устройствами ради баннера незачем.
  let broadcasts = null;
  // Обращения в поддержку; переписку грузим только для открытого тикета.
  let supportTickets = null;
  // Ошибку загрузки показываем как ошибку, а не как «обращений нет».
  let supportTicketsError = '';
  let selectedTicketId = null;
  let ticketMessages = null;
  let unsubTicketMessages = null;
  // Подписка на переписку меняется при выборе тикета (selectTicket), поэтому
  // не через sub(onSnapshot). Здесь только закрываем её при уходе с экрана.
  sub(() => { if (unsubTicketMessages) unsubTicketMessages(); });
  // null — первый снапшот ещё не пришёл, не путать с нулём.
  let liveOpenSessions = null;
  let liveOnShift = null;
  let todayRevenue = null;
  let todayChecksCount = null;
  // Кассовые смены, закрытые за последние 7 дней, — для недостачи
  // наличных в «Требует внимания» (пересчёт при закрытии в кассе).
  let recentClosedShifts = null;
  let devicesCount = null;
  // Сотрудники кассы (имя + PIN). Не путать с members — те входят в эту
  // веб-панель по email.
  let employees = null;
  // Сотрудник в форме редактирования; null — форма добавления.
  let editingEmployeeId = null;
  const revealedEmpPins = new Set();
  // Загруженный, но ещё не сохранённый логотип.
  let pendingLogoUrl = null;
  // Пока логотип грузится, сохранение брендинга ждёт: иначе сохранились бы
  // имя и цвета, а логотип молча потерялся.
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
        },
        (e) => {
          ticketMessages = [];
          toast(`Не удалось загрузить переписку: ${e?.message || e}`);
          draw();
        }
      );
    }
    draw();
  };

  const draw = () => {
    // Без документа заведения нет ни названия, ни роли.
    if (!tenant) return;
    const role = (state.tenants.find((t) => t.id === tenantId) || {}).role || '';
    const canManage = role === 'owner' || role === 'admin';
    const sortedMembers = (members || []).slice().sort((a, b) =>
      (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));

    // draw() срабатывает на любое обновление экрана (сборка APK, команда…).
    // Чтобы не стереть несохранённые правки брендинга, берём значения из уже
    // отрисованных полей, а не из Firestore.
    const existingName = $('f-brand-name')?.value;
    const existingColor = (id) => $(id)?.value;

    // По умолчанию — палитра AppColors (lib/theme/app_colors.dart), как в
    // createTenant. Старое название платформы — не имя заведения.
    const savedName = LEGACY_PLATFORM_NAMES.includes(branding?.appName) ? '' : branding?.appName;
    const brandName = existingName ?? (savedName || tenant.name || 'ZalPOS');
    const logoUrl = pendingLogoUrl ?? (branding?.logoUrl || '');
    const def = PREMIUM_PALETTES[0];
    const primaryColor = existingColor('f-color-primary') ?? (branding?.primaryColor || def.primaryColor);
    const secondaryColor = existingColor('f-color-secondary') ?? (branding?.secondaryColor || def.secondaryColor);
    const buttonColor = existingColor('f-color-button') ?? (branding?.buttonColor || def.buttonColor);
    const backgroundColor = existingColor('f-color-bg') ?? (branding?.backgroundColor || def.backgroundColor);
    const textColor = existingColor('f-color-text') ?? (branding?.textColor || def.textColor);

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
      { done: !!(branding && (branding.logoUrl || (branding.primaryColor && !DEFAULT_PRIMARY_COLORS.includes(branding.primaryColor.toUpperCase())))), label: 'Настроить фирменные цвета и лого', tab: 'branding' },
      { done: sortedMembers.length > 1, label: 'Пригласить первого сотрудника', tab: 'team' },
      { done: (buildJobs || []).some((j) => j.status === 'success'), label: 'Собрать и установить APK на планшет', tab: 'devices' },
    ];
    const allStepsDone = checklistSteps.every((s) => s.done);

    // В отличие от чек-листа, эти пункты появляются и исчезают по ситуации
    // всё время жизни заведения.
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
    // Ответ поддержки — чтобы владелец не пропустил его, не заходя в раздел.
    for (const t of supportTickets || []) {
      if (t.lastAuthorRole === 'super_admin' && t.status !== 'closed') {
        attentionItems.push({ tab: 'support', text: `Поддержка ответила на обращение «${t.subject || 'без темы'}»` });
      }
    }
    // Недостача при пересчёте кассы — владелец узнаёт сразу, а не из
    // X-отчёта, который открывают на кассе. Копейки округления не в счёт.
    for (const sh of recentClosedShifts || []) {
      const expected = Number(sh.closingExpectedCash);
      const counted = Number(sh.closingCountedCash);
      if (!Number.isFinite(expected) || !Number.isFinite(counted)) continue;
      const shortage = Math.round((expected - counted) * 100) / 100;
      if (shortage < 1) continue;
      const when = sh.closedAt ? fmtDateTime(sh.closedAt) : '';
      attentionItems.push({
        tab: null,
        text: `Недостача ${shortage.toLocaleString('ru-RU')} ₽ при закрытии смены${when ? ` ${when}` : ''}${sh.closedBy ? ` — закрыл(а) ${sh.closedBy}` : ''}. Подробности — в X-отчёте кассы, «Прошлые смены»`,
      });
    }

    // Тариф и сколько осталось до конца триала или списания: название —
    // крупно, срок — строкой под ним; tone красит значок тарифа.
    const subscriptionInfo = (() => {
      const plan = planName(plans, subscription?.planId);
      const title = plan ? `Тариф «${plan}»` : 'Тариф не выбран';
      if (!subscription?.status) return { title, detail: 'Выберите тариф в разделе «Тарифы»', tone: 'warn' };
      if (subscription.status === 'trial') {
        return {
          title,
          detail: `Пробный период${trialDaysLeft !== null
            ? (trialDaysLeft > 0 ? ` · осталось ${trialDaysLeft} ${pluralDays(trialDaysLeft)}` : ' · заканчивается сегодня')
            : ''}`,
          tone: trialDaysLeft !== null && trialDaysLeft <= 3 ? 'warn' : 'ok',
        };
      }
      if (subscription.status === 'active' && subscription.currentPeriodEnd) {
        const periodDaysLeft = Math.ceil((subscription.currentPeriodEnd.toMillis() - Date.now()) / 86400000);
        const verb = subscription.cancelAtPeriodEnd ? 'закончится' : 'продлится';
        return {
          title,
          detail: `Активна · ${verb} через ${periodDaysLeft > 0 ? `${periodDaysLeft} ${pluralDays(periodDaysLeft)}` : 'меньше дня'} (${fmtDate(subscription.currentPeriodEnd)})`,
          tone: 'ok',
        };
      }
      if (subscription.status === 'past_due') return { title, detail: 'Оплата просрочена', tone: 'bad' };
      if (subscription.status === 'cancelled') return { title, detail: 'Подписка отменена', tone: 'bad' };
      return { title, detail: SUB_STATUS_LABELS[subscription.status] || subscription.status, tone: 'ok' };
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

    // Точки этой же сети — открыть или добавить прямо с «Обзора».
    const chainLocationsHtml = () => {
      const chainName = (state.tenants.find((t) => t.chainId === tenant.chainId) || {}).chainName || '';
      const locations = state.tenants.filter((t) => t.chainId === tenant.chainId);
      return `
        <div class="card">
          <div class="muted small">Сеть заведений</div>
          <div style="font-size:16px;font-weight:700;margin:4px 0">${esc(chainName)}</div>
          <div class="small muted" style="margin-bottom:8px">Общий биллинг и лояльность на все точки сети.</div>
          ${locations.map((t) => `
            <div class="row" style="justify-content:space-between;padding:5px 0">
              <div class="grow">${esc(t.name || t.id)}${t.id === tenantId ? ' <span class="muted small">(эта)</span>' : ''}</div>
              ${t.id !== tenantId ? `<button class="btn-link f-chain-location-switch" data-id="${esc(t.id)}" style="width:auto">Открыть</button>` : ''}
            </div>
          `).join('')}
          <button class="btn btn-ghost" id="f-add-chain-location" style="margin-top:8px">+ Добавить точку сети</button>
        </div>
      `;
    };

    // Живые цифры: значок, цифра, подпись; «сейчас» — с пульсирующей точкой.
    const liveStat = (icon, color, value, label, live) => `
      <div class="card live-stat" style="--stat:${color}">
        <div class="live-stat-head">
          ${navIconHtml(icon, color)}
          ${live ? '<span class="live-dot" title="Обновляется в реальном времени"></span>' : ''}
        </div>
        <div class="live-stat-value">${value}</div>
        <div class="live-stat-label">${label}</div>
      </div>
    `;
    const quickAction = (tab, icon, color, title, hint) => `
      <button class="quick-action f-dash-tab" data-tab="${tab}">
        ${navIconHtml(icon, color)}
        <span class="quick-action-text"><b>${title}</b><span>${hint}</span></span>
        <svg class="quick-action-arrow" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
      </button>
    `;
    const venueLogo = branding?.logoUrl || '';
    const statusTone = tenant.status === 'active' || tenant.status === 'trial' ? 'ok' : 'bad';

    const overviewHtml = () => `
      ${broadcastsHtml}
      <div class="dash-hero">
        <div class="dash-date">${esc(new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }))}</div>
        <div class="dash-greeting">${greetingHtml()}</div>
      </div>
      <div class="card venue-card">
        <div class="venue-card-top">
          <div class="venue-avatar">${venueLogo
            ? `<img src="${esc(venueLogo)}" alt="">`
            : esc((tenant.name || 'Z').trim().charAt(0).toUpperCase())}</div>
          <div class="grow">
            <div class="venue-kicker">Заведение</div>
            <div class="venue-name-row">
              <div class="venue-name">${esc(tenant.name || '')}</div>
              ${role === 'owner' || role === 'admin' ? `<button type="button" class="venue-rename" id="f-tenant-rename" title="Переименовать" aria-label="Переименовать">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/></svg>
              </button>` : ''}
            </div>
          </div>
        </div>
        <div class="venue-chips">
          <span class="venue-chip ${statusTone}"><i></i>${esc(capitalize(TENANT_STATUS_LABELS[tenant.status] || tenant.status || '—'))}</span>
          <span class="venue-chip">${esc(capitalize(ROLE_LABELS[role] || role || '—'))}</span>
          <button type="button" class="venue-chip code" id="f-copy-slug" title="Код заведения — скопировать">
            ${esc(tenant.slug || '')}
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>
          </button>
        </div>
        <button type="button" class="venue-plan f-dash-tab" data-tab="billing">
          ${navIconHtml('gem', subscriptionInfo.tone === 'bad' ? '#EF4444' : subscriptionInfo.tone === 'warn' ? '#F59E0B' : '#8B5CF6')}
          <span class="grow">
            <span class="venue-plan-title">${esc(subscriptionInfo.title)}</span>
            <span class="venue-plan-detail">${esc(subscriptionInfo.detail)}</span>
          </span>
          <span class="venue-plan-more">Подробнее</span>
        </button>
      </div>
      ${tenant.chainId ? chainLocationsHtml() : ''}
      <div class="live-stats-grid">
        ${liveStat('list', '#2F6FED', liveOpenSessions === null ? '—' : liveOpenSessions, 'Открытых столов сейчас', true)}
        ${liveStat('users', '#10B981', liveOnShift === null ? '—' : liveOnShift, 'Сотрудников на смене', true)}
        ${liveStat('card', '#F59E0B', todayRevenue === null ? '—' : `${Number(todayRevenue).toLocaleString('ru-RU')} ₽`, 'Выручка сегодня', false)}
        ${liveStat('badge', '#A855F7', todayChecksCount === null ? '—' : todayChecksCount, 'Чеков закрыто сегодня', false)}
      </div>
      ${dangerBannerHtml}
      ${attentionItems.length ? `
        <h2>Требует внимания</h2>
        <div class="card">
          ${attentionItems.map((it) => `
            <div class="checklist-item">
              <div class="checklist-check" style="border-color:var(--warning);color:var(--warning)">!</div>
              <div class="checklist-label">${esc(it.text)}</div>
              ${it.tab ? `<button class="btn-link f-dash-tab" data-tab="${it.tab}" style="width:auto">Перейти</button>` : ''}
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
      <h2>Быстрый доступ</h2>
      <div class="quick-actions">
        ${quickAction('devices', 'device', '#0EA5E9', 'Устройства', 'Код приглашения и сборка APK')}
        ${quickAction('billing', 'card', '#F59E0B', 'Оплата', 'Продление и счета')}
        ${quickAction('branding', 'palette', '#EC4899', 'Брендинг', 'Логотип и цвета приложения')}
        ${quickAction('team', 'users', '#10B981', 'Команда', 'Кто управляет заведением')}
        ${quickAction('faq', 'question', '#EF4444', 'FAQ', 'Ответы на частые вопросы')}
        ${quickAction('support', 'chat', '#22C55E', 'Поддержка', 'Напишите нам — ответим')}
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
        ${planCaps((plans || []).find((p) => p.id === subscription?.planId)).guestApp ? `
        <p class="small muted">Одна кнопка — сразу три личных приложения
        этого заведения: касса для Android-планшета, касса для Windows и
        гостевое приложение для телефонов гостей.</p>` : `
        <p class="small muted">Одна кнопка — кассы этого заведения для Android-планшета и для Windows.</p>
        <p class="small" style="color:var(--warning)">Приложение для гостей и меню по QR не входят в ваш тариф —
        их можно подключить, сменив тариф в разделе «Оплата» (в пробный период — бесплатно).</p>`}
        <p class="small muted">Обе кассы сами присоединяются к заведению по
        коду заведения и коду приглашения устройства выше — вводить их
        вручную не нужно. Windows-версия — обычный установщик: скачайте
        и запустите его, касса появится на рабочем столе и в меню «Пуск».
        Если Windows покажет «Система Windows защитила ваш компьютер» —
        нажмите «Подробнее» → «Выполнить в любом случае».</p>
        <p class="small muted">Гостевое приложение — меню, заказ из-за
        стола, вызов персонала, бонусы; название и логотип берутся из
        раздела «Брендинг».</p>
        <p class="small muted">Собрать приложения нужно один раз. Дальше
        они обновляются сами: когда выходит новая версия ZalPOS, сервер
        собирает её для вашего заведения, а приложения на планшетах и
        телефонах гостей скачивают обновление и предлагают его установить.
        Нажимать «Собрать APK» снова стоит только после смены логотипа или
        названия в «Брендинге».</p>
        <p class="small muted">На Windows недоступны сканер через камеру и
        Bluetooth-принтер чека — вместо них работают USB/Bluetooth-сканер
        «пистолет» с ручным вводом кода и сетевой Wi-Fi/LAN-принтер.</p>
        ${canManage ? (() => {
          // Пока сборка в очереди, кнопка неактивна — не плодим дубли.
          const hasQueued = (buildJobs || []).some((j) => j.status === 'queued');
          return `<button class="btn btn-ghost" id="f-request-build" ${hasQueued ? 'disabled' : ''}>${hasQueued ? 'Сборка уже идёт…' : 'Собрать APK'}</button>`;
        })() : ''}
        <div id="f-build-error" class="small" style="color:var(--danger);margin-top:6px"></div>
        ${(buildJobs || []).some((j) => j.status !== 'superseded') ? buildJobs.filter((j) => j.status !== 'superseded').map((j) => `
          <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--border)">
            <div class="grow small muted">
              ${esc(buildJobLabel(j))} · ${fmtDateTime(j.createdAt)} · ${esc(BUILD_STATUS_LABELS[j.status] || j.status)}
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
          <div class="small" style="color:var(--warning);margin-top:6px">Автопродление отключено — доступ работает до конца оплаченного периода, новых списаний не будет.</div>
        ` : ''}
        ${canManage ? `<button class="btn btn-primary f-dash-tab" data-tab="plans" style="margin-top:14px">Перейти к тарифам</button>` : ''}
        ${canManage && subscription?.status === 'active' ? `
          <button class="btn btn-ghost" id="f-toggle-autorenew" style="margin-top:10px">
            ${subscription?.cancelAtPeriodEnd ? 'Возобновить автопродление' : 'Отключить автопродление'}
          </button>
          <div id="f-toggle-autorenew-error" class="small" style="color:var(--danger);margin-top:6px"></div>
        ` : ''}
      </div>

      ${(bankInvoices || []).length ? `
        <h2>Счета на оплату</h2>
        <div class="card">
          ${bankInvoices.map((b) => `
            <div class="row" style="justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--border);flex-wrap:wrap">
              <div class="grow small">
                Счёт № ${esc(String(b.number))} от ${fmtDate(b.createdAt)} · ${Number(b.amount || 0).toLocaleString('ru-RU')} ₽
                <div class="muted">${esc(b.payer?.name || '')} · ${esc(BANK_INVOICE_STATUS_LABELS[b.status] || b.status)}</div>
              </div>
              <a class="btn-link" href="#/invoice/${esc(b.id)}" style="width:auto">Открыть</a>
              ${b.receiptUrl ? `<a class="btn-link" href="${esc(b.receiptUrl)}" target="_blank" rel="noopener" style="width:auto">Чек</a>` : ''}
              ${canManage && b.status === 'pending' ? `<button class="btn-link f-bank-cancel" data-id="${esc(b.id)}" style="width:auto">Отменить</button>` : ''}
            </div>
          `).join('')}
        </div>
      ` : ''}

      <h2>История платежей</h2>
      <div class="card">
        ${(paymentHistory || []).length ? `
          ${paymentHistory.map((e) => `
            <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--border)">
              <div class="grow small muted">
                ${fmtDateTime(e.receivedAt)} · ${esc(BILLING_PURPOSE_LABELS[e.purpose] || e.purpose || 'оплата')}${e.test ? ' · тестовая, без списания денег' : ''}
              </div>
              <div class="small" style="font-weight:600">${Number(e.amount || 0).toLocaleString('ru-RU')} ₽</div>
            </div>
          `).join('')}
        ` : '<p class="small muted">Платежей пока не было.</p>'}
      </div>
    `;

    const plansHtml = () => `
      <h2>Тарифы</h2>
      ${tenant.chainId ? `
        <p class="small muted" style="margin-top:-4px">Цена — за первую точку сети, каждая следующая — по своей
        цене; итог за все точки — в счёте на оплате.</p>
      ` : ''}
      <div class="card">
        ${canManage && plans ? `
          ${(() => {
            // Продаваемые тарифы своего вида; архивный текущий — тоже, его можно продлить.
            const isChain = !!tenant.chainId;
            const list = sellablePlans(plans, isChain);
            const current = plans.find((p) => p.id === subscription?.planId);
            if (current && current.archived === true && !!current.isChainPlan === isChain) list.unshift(current);
            const inTrial = subscription?.status === 'trial';
            return `<div class="cab-plans">${list.map((p) => {
              const isCurrent = subscription?.planId === p.id;
              const paidCurrent = isCurrent && subscription?.status === 'active';
              const yearly = planPeriodPrice(p, 'yearly');
              const semi = planPeriodPrice(p, 'semiannual');
              return `
              <div class="cab-plan${isCurrent ? ' current' : ''}">
                <div class="row" style="justify-content:space-between;align-items:center;gap:8px">
                  <div style="font-weight:800;font-size:16px">${esc(p.name || p.id)}</div>
                  ${isCurrent ? '<span class="cab-plan-badge">Ваш тариф</span>' : ''}
                </div>
                <div class="small muted" style="margin:2px 0 8px">${esc(planTagline(p))}</div>
                <div class="cab-plan-price">${rub(p.priceRub)}<span>/мес${isChain ? ' за первую точку' : ''}</span></div>
                ${isChain && planAdditionalPrice(p, 'monthly') > 0 ? `<div class="small muted">+ ${rub(planAdditionalPrice(p, 'monthly'))}/мес за каждую следующую точку</div>` : ''}
                ${yearly || semi ? `<div class="small muted">${[semi ? `${rub(semi)} за 6 мес` : '', yearly ? `${rub(yearly)} за год${planPeriodDiscount(p, 'yearly') ? ` (−${planPeriodDiscount(p, 'yearly')}%)` : ''}` : ''].filter(Boolean).join(' · ')}</div>` : ''}
                <ul class="plan-feats compact">${planFeatsHtml(p, { priorityRow: list.some((x) => x.prioritySupport === true) })}</ul>
                ${semi || yearly ? `
                  <select class="f-plan-period" id="f-plan-period-${esc(p.id)}" data-plan="${esc(p.id)}" style="margin-bottom:8px">
                    <option value="monthly">Оплатить на месяц</option>
                    ${semi ? '<option value="semiannual">Оплатить на 6 месяцев</option>' : ''}
                    ${yearly ? '<option value="yearly">Оплатить на год (выгоднее)</option>' : ''}
                  </select>
                ` : ''}
                ${inTrial && !isCurrent && p.archived !== true ? `
                  <button class="btn btn-ghost f-plan-trial-switch" data-plan="${esc(p.id)}" style="margin-bottom:8px">Перейти на этот тариф — бесплатно до конца пробного периода</button>
                ` : ''}
                <button class="btn ${subscription?.status === 'past_due' || (inTrial && isCurrent) ? 'btn-primary' : 'btn-ghost'} f-plan-checkout" data-plan="${esc(p.id)}"
                  ${paidCurrent ? 'disabled' : ''}>
                  ${paidCurrent ? 'Оплачен' : isCurrent ? 'Оплатить' : inTrial ? 'Оплатить этот тариф' : 'Перейти и оплатить'}
                </button>
              </div>
            `;
            }).join('')}</div>`;
          })()}
          <div style="margin-top:14px">
            <div class="small" style="font-weight:600;margin-bottom:6px">Кто платит</div>
            <label class="small" style="display:flex;gap:8px;align-items:flex-start">
              <input type="radio" name="f-payer-mode" value="individual" ${payerDraft.mode === 'individual' ? 'checked' : ''} style="width:auto;margin-top:2px">
              <span>Физическое лицо — картой или по СБП. Вы платите от своего имени, чек придёт на email.</span>
            </label>
            <label class="small" style="display:flex;gap:8px;align-items:flex-start;margin-top:6px">
              <input type="radio" name="f-payer-mode" value="business" ${payerDraft.mode === 'business' ? 'checked' : ''} style="width:auto;margin-top:2px">
              <span>ИП или организация — счёт на оплату с расчётного счёта, чек с вашим ИНН (для учёта расходов).</span>
            </label>
            ${payerDraft.mode === 'business' ? `
              <div class="card" style="margin-top:10px">
                <select id="f-payer-type" style="margin-bottom:8px">
                  <option value="ip" ${payerDraft.type === 'ip' ? 'selected' : ''}>Индивидуальный предприниматель</option>
                  <option value="org" ${payerDraft.type === 'org' ? 'selected' : ''}>Организация (ООО, АО и др.)</option>
                </select>
                <input id="f-payer-name" value="${esc(payerDraft.name)}" placeholder="${payerDraft.type === 'ip' ? 'ФИО предпринимателя' : 'Название организации, например ООО «Ромашка»'}" style="margin-bottom:8px">
                <input id="f-payer-inn" value="${esc(payerDraft.inn)}" inputmode="numeric" maxlength="12" placeholder="ИНН — ${payerDraft.type === 'ip' ? '12' : '10'} цифр" style="margin-bottom:8px">
                ${payerDraft.type === 'org' ? `<input id="f-payer-kpp" value="${esc(payerDraft.kpp)}" maxlength="9" placeholder="КПП (если есть)" style="margin-bottom:8px">` : ''}
                <p class="small muted" style="margin:0">Нажмите «Продлить» у нужного тарифа — появится счёт для оплаты
                переводом. Подписка продлится, когда деньги поступят на счёт, обычно через 1–3 рабочих дня.</p>
              </div>
            ` : ''}
          </div>
          <label class="small" style="display:${payerDraft.mode === 'business' ? 'none' : 'flex'};gap:8px;align-items:flex-start;margin-top:12px">
            <input type="checkbox" id="f-autorenew-consent" style="width:auto;margin-top:2px">
            <span>Автопродление: в последний день оплаченного периода списывать оплату
            следующего по текущей цене тарифа с карты, которой я плачу сейчас. Отключить можно
            в любой момент в разделе «Оплата» (<a href="#/legal/payment" target="_blank">условия</a>).</span>
          </label>
          <div id="f-checkout-error" class="small" style="color:var(--danger);margin-top:6px"></div>
        ` : '<p class="small muted">Тарифы пока не заданы платформой.</p>'}
      </div>
      ${role === 'owner' && !tenant.chainId && plans && plans.some((p) => p.isChainPlan) ? `
        <h2 style="margin-top:24px">Перейти на тариф сети</h2>
        <p class="small muted" style="margin-top:-4px">Если планируете открыть ещё точки — можно перевести
        уже работающее заведение в сеть: оно останется первой точкой, гости и бонусы никуда не денутся,
        просто биллинг и лояльность станут общими на все точки сети.</p>
        <div class="card">
          ${plans.filter((p) => p.isChainPlan).map((p) => `
            <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
              <div class="grow">
                <div>${esc(p.name || p.id)}</div>
                <div class="small muted">от ${(Number(p.priceRub) || 0).toLocaleString('ru-RU')} ₽/мес за первую точку</div>
              </div>
              <button class="btn btn-ghost f-convert-to-chain" data-plan="${esc(p.id)}" style="width:auto">Перевести в сеть</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;

    const brandingHtml = () => `
      <h2>Брендинг</h2>
      <p class="small muted">Название, логотип и цвета — для приложения гостей и веб-меню
      по QR. Касса у всех заведений в едином стиле ZalPOS: её видит только персонал.</p>
      ${tenant.chainId ? `
        <div class="card" style="border-color:rgba(139,92,246,.45)">
          <p class="small muted">Это заведение — точка сети. Ниже правится брендинг ВСЕЙ сети
          (гостевое приложение и веб-версия сети общие на все точки) — изменения увидят гости
          в любом заведении этой сети, не только здесь.</p>
        </div>
      ` : ''}
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
        <p class="small muted" style="margin:-4px 0 10px">Касса всегда остаётся в тёмной теме —
        от бренда она берёт акцентные цвета. Светлый фон применяется только в приложении
        и веб-версии для гостей.</p>
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
            <div class="ellipsis">${esc(memberLabel(m, m.userId === state.uid ? state.auth.currentUser?.email : null))}${m.userId === state.uid ? ' <span class="muted small">(вы)</span>' : ''}</div>
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
                <button class="btn-link f-member-delete" data-uid="${esc(m.userId)}" data-device="${m.email ? '0' : '1'}" data-label="${esc(memberLabel(m))}" style="color:var(--danger)">
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
              <input id="f-emp-name" placeholder="Имя для кассы (без фамилии)">
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
        <p class="small muted" style="margin-top:10px">Входили только по ссылке из письма или не помните пароль?
          Создайте новый — он появится на экране.</p>
        <button class="btn btn-ghost" id="f-pass-generate">Создать новый пароль</button>
        <div id="f-pass-generate-msg" class="small" style="margin-top:8px;color:var(--danger)"></div>
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

      <h2>Функции заведения</h2>
      <div class="card">
        <label class="field-checkbox" style="display:flex;align-items:flex-start;gap:10px">
          <input type="checkbox" id="f-hookah-mode" style="width:auto;margin-top:3px"
            ${venueHookahOn(venueProfile) ? 'checked' : ''} ${canManage ? '' : 'disabled'}>
          <span><b>Заведение с кальянами</b><br>
          <span class="small muted">Только с этой функцией гость видит за столом кнопки «Позвать кальянщика»,
          «Поменять угли» и «Перезабивка» и таймер сеанса, а касса — перезабивку и напоминания про угли.
          Без неё у гостя «Позвать официанта» и «Счёт, пожалуйста».</span></span>
        </label>
        <div id="f-hookah-mode-msg" class="small" style="margin-top:8px"></div>
      </div>

      ${role === 'owner' ? `
        <h2>Резервная копия</h2>
        <div class="card">
          <p class="small muted">Все данные ${tenant.chainId ? 'точки' : 'заведения'} одним файлом: меню, залы и столы,
          чеки и смены, гости и бонусы, сотрудники, склад, брони и настройки. Храните его у себя —
          по нему мы восстановим данные, если что-то случится. Скачать можно раз в 3 дня.</p>
          <button class="btn btn-ghost" id="f-backup-tenant">Скачать бэкап ${tenant.chainId ? 'точки' : 'заведения'}</button>
          ${tenant.chainId ? `<button class="btn btn-ghost" id="f-backup-chain" style="margin-top:8px">Скачать бэкап всей сети</button>` : ''}
        </div>
      ` : ''}

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
      <button class="btn-link f-ticket-back" id="f-ticket-back" style="width:auto;margin-bottom:10px">← Все обращения</button>
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
        <button class="btn-link f-ticket-toggle-status" id="f-ticket-toggle-status" data-status="${esc(selectedTicket.status)}" style="width:auto;margin-top:8px">
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
          ${t.lastAuthorRole === 'super_admin' && t.status !== 'closed'
            ? '<div class="small" style="color:var(--success);font-weight:700;white-space:nowrap">Есть ответ</div>'
            : `<div class="small muted">${t.status === 'closed' ? 'Решено' : 'Открыто'}</div>`}
        </div>
      `).join('')}</div>` : (supportTicketsError
        ? `<p class="small" style="color:var(--danger)">Не удалось загрузить обращения: ${esc(supportTicketsError)}</p>`
        : '<p class="small muted">Обращений пока не было.</p>')}
      <p class="small center muted">Что-то не открывается вообще? Сначала проверьте <a href="#/status">статус системы</a>.</p>
    `;

    const supportHtml = () => selectedTicket ? ticketThreadHtml() : ticketListHtml();

    const aiState = () => {
      if (aiDraft) return aiDraft;
      const pub = aiPub || aiLegacy?.pub || {};
      const sec = (aiPub ? aiSec : aiLegacy?.sec) || {};
      const vendors = {};
      AI_VENDORS.forEach((v) => {
        const p = (pub.vendors || {})[v.id] || {};
        const k = (sec.vendors || {})[v.id] || {};
        vendors[v.id] = {
          hasKey: !!(p.hasKey || k.apiKey), apiKey: '', model: p.model || '', baseUrl: k.baseUrl || '',
          format: p.format || '', analyticsModel: p.analyticsModel || '',
          // Ключ прежних настроек точки — при первом сохранении переносится
          // в общие настройки сети (в форме не показывается).
          carryKey: aiPub ? '' : (k.apiKey || ''),
        };
      });
      // Старый формат (один шлюз прямо в aiSettings) — показываем как есть.
      const legacyVendor = pub.vendor || (pub.baseUrl ? (String(pub.baseUrl).includes('darkapi') ? 'darkapi'
        : String(pub.baseUrl).includes('generativelanguage') ? 'gemini'
          : String(pub.baseUrl).includes('tooken') ? 'tooken' : 'custom') : 'tooken');
      return {
        enabled: pub.enabled === true, vendor: legacyVendor, fallbackVendor: pub.fallbackVendor || '',
        vendors, migrated: !aiPub && !!aiLegacy,
      };
    };

    const aiVendorCardHtml = (st, id, slotLabel) => {
      const v = aiVendor(id);
      const c = st.vendors[id];
      return `
        <div class="card">
          <div class="row" style="justify-content:space-between;align-items:center">
            <b>${esc(v.title)}</b>
            <span class="small muted">${esc(slotLabel)}${c.hasKey ? ' · ✓ ключ сохранён' : ''}</span>
          </div>
          <label class="field"><span>API-ключ</span>
            <input type="password" autocomplete="off" class="f-ai-input" id="f-ai-${esc(id)}-key" data-vendor="${esc(id)}" data-field="apiKey"
              value="${esc(c.apiKey)}" placeholder="${esc(c.hasKey ? 'сохранён — оставьте пустым, чтобы не менять' : v.hint)}" ${canManage ? '' : 'disabled'}>
          </label>
          <label class="field"><span>Модель</span>
            <input class="f-ai-input" id="f-ai-${esc(id)}-model" data-vendor="${esc(id)}" data-field="model" list="ai-models-${esc(id)}"
              value="${esc(c.model)}" placeholder="${esc(v.model || 'имя модели')}" ${canManage ? '' : 'disabled'}>
            <datalist id="ai-models-${esc(id)}">${v.models.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
          </label>
          <label class="field"><span>Адрес API${id === 'custom' ? '' : ' (необязательно)'}</span>
            <input class="f-ai-input" id="f-ai-${esc(id)}-url" data-vendor="${esc(id)}" data-field="baseUrl" value="${esc(c.baseUrl)}"
              placeholder="${esc(v.baseUrl || 'https://ваш-шлюз/v1')}" ${canManage ? '' : 'disabled'}>
          </label>
          ${id === 'custom' ? `
            <label class="field"><span>Формат API</span>
              <select class="f-ai-input" data-vendor="custom" data-field="format" ${canManage ? '' : 'disabled'}>
                ${[['', 'Определить автоматически'], ['openai', 'OpenAI-совместимый'], ['anthropic', 'Anthropic (Claude)']]
                  .map(([val, label]) => `<option value="${val}" ${c.format === val ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>` : ''}
          ${v.note ? `<p class="small muted" style="margin-top:6px">${esc(v.note)}</p>` : ''}
        </div>`;
    };

    const aiHtml = () => {
      const st = aiState();
      const chainName = tenant.chainName || (state.tenants.find((t) => t.id === tenantId) || {}).chainName || '';
      return `
        <h2>ИИ-помощники</h2>
        <div class="card">
          <p class="small muted" style="margin-top:0">${tenant.chainId
            ? `Общие настройки для всей сети${chainName ? ` «${esc(chainName)}»` : ''}: ключ провайдера покупается один раз и работает во всех точках сети.`
            : 'Ключ провайдера ИИ этого заведения. Оплата идёт напрямую провайдеру по его тарифам — платформа ключи не выдаёт.'}</p>
          ${st.migrated ? '<p class="small" style="color:var(--warning,#F59E0B)">Сейчас работают прежние настройки этой точки. После сохранения они станут общими для всей сети.</p>' : ''}
          <label class="row" style="gap:8px;align-items:center;margin:8px 0">
            <input type="checkbox" id="f-ai-enabled" ${st.enabled ? 'checked' : ''} ${canManage ? '' : 'disabled'}>
            <span>Включить ИИ-помощников (касса и консьерж в гостевом приложении)</span>
          </label>
          <label class="field"><span>Основной провайдер</span>
            <select id="f-ai-vendor" ${canManage ? '' : 'disabled'}>
              ${AI_VENDORS.map((v) => `<option value="${v.id}" ${st.vendor === v.id ? 'selected' : ''}>${esc(v.title)}</option>`).join('')}
            </select>
          </label>
          <label class="field"><span>Резервный провайдер — если основной не ответил</span>
            <select id="f-ai-fallback" ${canManage ? '' : 'disabled'}>
              <option value="">— нет —</option>
              ${AI_VENDORS.filter((v) => v.id !== st.vendor).map((v) => `<option value="${v.id}" ${st.fallbackVendor === v.id ? 'selected' : ''}>${esc(v.title)}</option>`).join('')}
            </select>
          </label>
        </div>
        ${aiVendorCardHtml(st, st.vendor, 'основной')}
        ${st.fallbackVendor && st.fallbackVendor !== st.vendor ? aiVendorCardHtml(st, st.fallbackVendor, 'резервный') : ''}
        ${canManage ? `
          <div class="row" style="gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" id="f-ai-save" style="width:auto">Сохранить</button>
            <button class="btn btn-ghost" id="f-ai-test" style="width:auto">Проверить связь</button>
          </div>` : '<p class="small muted">Менять настройки ИИ может владелец или администратор.</p>'}
        <div id="f-ai-msg" class="small" style="margin-top:10px"></div>
        <p class="small muted">Тонкая настройка агентов (какие помощники включены, лимит ответа) — в кассе: Админ → Настройки ИИ.</p>
      `;
    };

    const TAB_RENDERERS = {
      overview: overviewHtml, devices: devicesHtml, billing: billingHtml, plans: plansHtml,
      branding: brandingHtml, team: teamHtml, ai: aiHtml, profile: profileHtml, settings: settingsHtml,
      faq: faqHtml, support: supportHtml,
    };
    renderKeepingInputs(body, (TAB_RENDERERS[activeTab] || overviewHtml)() + dashboardNavHtml(activeTab, daysLeft !== null, tenant.name, tenant.chainId));

    document.querySelectorAll('.f-dash-tab').forEach((el) => {
      el.onclick = (e) => {
        e.preventDefault();
        activeTab = el.dataset.tab;
        draw();
      };
    });
    // Название для кабинета и панели платформы; в приложениях — своё, из
    // «Брендинга». Правила дают владельцу менять в документе только name.
    if ($('f-copy-slug')) $('f-copy-slug').onclick = () => copyToClipboard(tenant.slug || '');
    if ($('f-backup-tenant')) $('f-backup-tenant').onclick = () => exportVenueBackup({ tenantId, fileKey: tenant.slug, label: tenant.name });
    if ($('f-backup-chain')) $('f-backup-chain').onclick = () => {
      const chain = state.tenants.find((t) => t.chainId === tenant.chainId) || {};
      exportVenueBackup({ chainId: tenant.chainId, fileKey: chain.chainSlug || chain.chainName, label: chain.chainName || 'сеть' });
    };
    const renameBtn = $('f-tenant-rename');
    if (renameBtn) renameBtn.onclick = async () => {
      const next = (window.prompt('Новое название заведения', tenant.name || '') || '').trim();
      if (!next || next === tenant.name) return;
      if (next.length > 80) { alert('Слишком длинное название — не больше 80 символов'); return; }
      try {
        await updateDoc(doc(state.db, 'tenants', tenantId), { name: next, updatedAt: Timestamp.now() });
        tenant.name = next;
        draw();
      } catch (e) {
        alert('Не удалось переименовать: ' + (e?.message || e));
      }
    };
    document.querySelectorAll('.f-chain-location-switch').forEach((el) => {
      el.onclick = () => { state.activeTenantId = el.dataset.id; route(); };
    });
    if ($('f-add-chain-location')) $('f-add-chain-location').onclick = () => addChainLocation(tenant.chainId);
    if ($('f-nav-add-location')) $('f-nav-add-location').onclick = () => addChainLocation(tenant.chainId);
    document.querySelectorAll('.f-broadcast-dismiss').forEach((el) => {
      el.onclick = () => {
        dismissBroadcast(el.dataset.id);
        draw();
      };
    });
    if (activeTab === 'ai') {
      const aiRoot = () => (tenant.chainId ? ['chains', tenant.chainId] : ['tenants', tenantId]);
      const ensureDraft = () => { if (!aiDraft) aiDraft = JSON.parse(JSON.stringify(aiState())); return aiDraft; };
      const aiMsg = (text, ok = true) => {
        const el = $('f-ai-msg');
        if (el) { el.textContent = text; el.style.color = ok ? 'var(--success,#22C55E)' : 'var(--danger)'; }
      };
      document.querySelectorAll('.f-ai-input').forEach((el) => {
        el.oninput = el.onchange = () => { ensureDraft().vendors[el.dataset.vendor][el.dataset.field] = el.value.trim(); };
      });
      if ($('f-ai-enabled')) $('f-ai-enabled').onchange = (e) => { ensureDraft().enabled = e.target.checked; };
      if ($('f-ai-vendor')) $('f-ai-vendor').onchange = (e) => {
        const d = ensureDraft();
        d.vendor = e.target.value;
        if (d.fallbackVendor === d.vendor) d.fallbackVendor = '';
        draw();
      };
      if ($('f-ai-fallback')) $('f-ai-fallback').onchange = (e) => { ensureDraft().fallbackVendor = e.target.value; draw(); };

      const saveAi = async () => {
        const d = ensureDraft();
        const main = d.vendors[d.vendor];
        if (d.enabled && !main.hasKey && !main.apiKey) throw new Error('Укажите API-ключ основного провайдера');
        if (d.vendor === 'custom' && !main.baseUrl) throw new Error('Для своего шлюза нужен «Адрес API»');
        const secVendors = {};
        const pubVendors = {};
        AI_VENDORS.forEach((v) => {
          const c = d.vendors[v.id];
          const key = c.apiKey || c.carryKey || '';
          secVendors[v.id] = { baseUrl: c.baseUrl || '', ...(key ? { apiKey: key } : {}) };
          pubVendors[v.id] = {
            format: v.id === 'custom' ? (c.format || '') : '', model: c.model || '',
            analyticsModel: c.analyticsModel || '', hasKey: !!(c.hasKey || c.apiKey),
          };
        });
        // Сначала ключи (только персонал), потом публичная часть без ключей.
        await setDoc(doc(state.db, ...aiRoot(), 'meta', 'aiSecrets'), { vendors: secVendors }, { merge: true });
        const del = deleteField();
        await setDoc(doc(state.db, ...aiRoot(), 'meta', 'aiSettings'), {
          enabled: d.enabled, vendor: d.vendor, fallbackVendor: d.fallbackVendor || '', vendors: pubVendors,
          updatedAt: Timestamp.fromDate(new Date()),
          apiKey: del, baseUrl: del, provider: del, model: del, analyticsModel: del, vendorKeys: del,
        }, { merge: true });
        aiDraft = null;
        // Сохранённый ключ в поле не держим — иначе перерисовка вернёт его туда.
        document.querySelectorAll('.f-ai-input[data-field="apiKey"]').forEach((el) => { el.value = ''; });
      };

      if ($('f-ai-save')) $('f-ai-save').onclick = async () => {
        const btn = $('f-ai-save');
        btn.disabled = true;
        try {
          await saveAi();
          draw();
          aiMsg('Сохранено');
        } catch (e) {
          aiMsg(`Не удалось сохранить: ${e?.message || e}`, false);
        } finally {
          if ($('f-ai-save')) $('f-ai-save').disabled = false;
        }
      };
      if ($('f-ai-test')) $('f-ai-test').onclick = async () => {
        const btn = $('f-ai-test');
        btn.disabled = true;
        aiMsg('Проверяю…');
        try {
          if (aiDraft) await saveAi();
          const st = aiState();
          if (!st.enabled) throw new Error('Сначала включите ИИ и сохраните');
          const anthropic = st.vendor === 'custom' && st.vendors.custom.format === 'anthropic';
          const idToken = await state.auth.currentUser?.getIdToken();
          const res = await fetch(`${SAAS_GATEWAY_URL}/aiProxy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
            body: JSON.stringify({
              tenantId, slot: 'primary', format: anthropic ? 'anthropic' : 'openai',
              path: anthropic ? 'v1/messages' : 'chat/completions',
              body: { messages: [{ role: 'user', content: 'Ответь одним словом: OK' }], max_tokens: 256 },
            }),
          });
          const json = await res.json().catch(() => null);
          if (!res.ok) {
            const err = json?.error;
            throw new Error(typeof err === 'string' ? err : (err?.message || `провайдер ответил ${res.status}`));
          }
          const text = json?.choices?.[0]?.message?.content ?? json?.content?.[0]?.text ?? '';
          aiMsg(`Связь есть: ${aiVendor(st.vendor).title} ответил${text ? ` «${String(text).slice(0, 60)}»` : ''}`);
        } catch (e) {
          aiMsg(`Нет связи: ${e?.message || e}`, false);
        } finally {
          if ($('f-ai-test')) $('f-ai-test').disabled = false;
        }
      };
    }

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
            lastAuthorRole: 'owner',
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
            lastAuthorRole: 'owner',
            status: selectedTicket.status === 'closed' ? 'open' : selectedTicket.status,
          }, { merge: true });
          // Новое сообщение уже перерисовало экран — replyEl устарел.
          if ($('f-ticket-reply')) $('f-ticket-reply').value = '';
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

    // На широком экране панель видна всегда, а кнопка и подложка скрыты
    // стилями — обработчики там просто не срабатывают.
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
      $('f-pass-generate').onclick = async () => {
        const btn = $('f-pass-generate');
        const msgEl = $('f-pass-generate-msg');
        msgEl.textContent = '';
        btn.disabled = true;
        try {
          await issueNewPassword(state.auth.currentUser);
        } catch (e) {
          msgEl.textContent = e?.code === 'auth/requires-recent-login'
            ? 'Для безопасности войдите заново по ссылке из письма (выйти → ввести почту на главной) и нажмите ещё раз — в течение 5 минут после входа.'
            : authErrorMessage(e);
        } finally {
          btn.disabled = false;
        }
      };
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
          // Сначала подтверждаем текущий пароль: открытая вкладка ещё не
          // значит, что за компьютером владелец.
          await reauthenticateWithCredential(
            state.auth.currentUser,
            EmailAuthProvider.credential(state.auth.currentUser.email, currentEl.value)
          );
          await updatePassword(state.auth.currentUser, newEl.value);
          // Пока ждали ответа, экран мог перерисоваться — берём поля заново.
          if ($('f-pass-current')) $('f-pass-current').value = '';
          if ($('f-pass-new')) $('f-pass-new').value = '';
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
    if ($('f-hookah-mode')) {
      $('f-hookah-mode').onchange = async (e) => {
        const on = e.target.checked;
        const msg = $('f-hookah-mode-msg');
        e.target.disabled = true;
        try {
          await setDoc(doc(state.db, 'tenants', tenantId, 'meta', 'venueProfile'), { hookahEnabled: on }, { merge: true });
          toast(on ? 'Кальяны включены — кнопки появятся у гостей' : 'Кальяны выключены — кальянных кнопок у гостей нет');
        } catch (err) {
          e.target.checked = !on;
          if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `Не удалось сохранить: ${err?.message || err}`; }
        } finally {
          e.target.disabled = false;
        }
      };
    }
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
    // Размытие — от взгляда через плечо, не более: в DOM код открытым текстом.
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
      $('f-toggle-autorenew').onclick = () => toggleAutorenew(tenantId, !subscription?.cancelAtPeriodEnd, tenant?.chainId || null);
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
          // Локальное превью сразу, серверный URL подменит его после загрузки.
          const localPreviewUrl = URL.createObjectURL(file);
          $('f-logo-preview').src = localPreviewUrl;
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
            // 20 секунд без прогресса — соединение, скорее всего, оборвалось,
            // а XHR сам не отменится и оставит «Сохранить» заблокированной.
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
            }, tenant.chainId);
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
      el.onclick = () => toggleMemberStatus(tenantId, el.dataset.uid, el.dataset.active === '1', tenant.chainId);
    });
    document.querySelectorAll('.f-member-delete').forEach((el) => {
      el.onclick = () => deleteMember(tenantId, el.dataset.uid, el.dataset.device === '1', el.dataset.label, tenant.chainId);
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
          await callSaasGateway('inviteTenantMember', { tenantId, email, role: inviteRole });
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
        // Заполняем текущие поля — draw() перенесёт значения в новую разметку.
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
        // Длина PIN — как в AppConstants.pinLengthForRole, иначе касса его
        // не примет.
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
            // Остальные поля — дефолты Employee() из lib/models/employee.dart.
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
          draw();
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
        const period = periodSelect?.value || 'monthly';
        if (payerDraft.mode === 'business') {
          startBankInvoice(tenantId, el.dataset.plan, period, tenant?.chainId || null, {
            type: payerDraft.type, name: payerDraft.name, inn: payerDraft.inn, kpp: payerDraft.type === 'org' ? payerDraft.kpp : '',
          }, el);
          return;
        }
        startCheckout(tenantId, el.dataset.plan, period, tenant?.chainId || null,
          $('f-autorenew-consent')?.checked === true);
      };
    });
    document.querySelectorAll('.f-plan-trial-switch').forEach((el) => {
      el.onclick = async () => {
        el.disabled = true;
        try {
          await callSaasGateway('changeTrialPlan', tenant?.chainId
            ? { chainId: tenant.chainId, planId: el.dataset.plan }
            : { tenantId, planId: el.dataset.plan });
          toast('Тариф изменён — пробный период продолжается');
        } catch (e) {
          toast(`Не удалось сменить тариф: ${e?.message || e}`);
          el.disabled = false;
        }
      };
    });
    document.querySelectorAll('input[name="f-payer-mode"]').forEach((el) => {
      el.onchange = () => { payerDraft.mode = el.value; draw(); };
    });
    if ($('f-payer-type')) $('f-payer-type').onchange = (e) => { payerDraft.type = e.target.value; draw(); };
    [['f-payer-name', 'name'], ['f-payer-inn', 'inn'], ['f-payer-kpp', 'kpp']].forEach(([id, key]) => {
      if ($(id)) $(id).oninput = (e) => { payerDraft[key] = e.target.value; };
    });
    document.querySelectorAll('.f-bank-cancel').forEach((el) => {
      el.onclick = async () => {
        if (!confirm('Отменить счёт? Если вы уже оплатили его, не отменяйте — напишите в поддержку.')) return;
        el.disabled = true;
        try {
          await callSaasGateway('cancelBankInvoice', { id: el.dataset.id });
        } catch (e) {
          toast(`Не удалось отменить счёт: ${e?.message || e}`);
          el.disabled = false;
        }
      };
    });
    document.querySelectorAll('.f-convert-to-chain').forEach((el) => {
      el.onclick = () => convertTenantToChain(tenantId, tenant, el.dataset.plan);
    });
    if ($('f-request-build')) {
      $('f-request-build').onclick = () => requestBuild(tenantId);
    }
    document.querySelectorAll('.f-build-download').forEach((el) => {
      el.onclick = () => downloadBuild(el.dataset.jobId);
    });
  };

  getDocs(collection(state.db, 'plans')).then((snap) => {
    plans = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (Number(a.priceRub) || 0) - (Number(b.priceRub) || 0));
    draw();
  }).catch(() => { plans = []; draw(); });

  // Подписка точки сети лежит в subscriptions/{chainId}, а chainId известен
  // только из документа заведения — слушатель заводим из его снапшота.
  let unsubSubscription = null;
  const watchSubscriptionFor = (chainId) => {
    if (unsubSubscription) { unsubSubscription(); unsubSubscription = null; }
    unsubSubscription = onSnapshot(doc(state.db, 'subscriptions', chainId || tenantId), (d) => {
      subscription = d.exists() ? d.data() : null;
      draw();
    }, () => {});
  };
  sub(() => { if (unsubSubscription) unsubSubscription(); });

  // У точки сети свой брендинг тоже есть, но гости видят брендинг сети —
  // его и показываем.
  let unsubBranding = null;
  const watchBrandingFor = (chainId) => {
    if (unsubBranding) { unsubBranding(); unsubBranding = null; }
    const ref = chainId
      ? doc(state.db, 'chains', chainId, 'branding', 'config')
      : doc(state.db, 'tenants', tenantId, 'branding', 'config');
    unsubBranding = onSnapshot(ref, (d) => {
      branding = d.exists() ? d.data() : null;
      draw();
    }, () => {});
  };
  sub(() => { if (unsubBranding) unsubBranding(); });

  // ИИ: у сети — общие настройки на все точки (chains/{id}/meta/ai*), у
  // одиночного заведения — свои. Пока у сети общих нет, показываем прежние
  // настройки точки (aiLegacy), при сохранении они станут общими.
  let unsubAi = [];
  const watchAiFor = (chainId) => {
    unsubAi.forEach((u) => u());
    unsubAi = [];
    aiPub = null; aiSec = null; aiLegacy = null; aiDraft = null;
    const root = chainId ? ['chains', chainId] : ['tenants', tenantId];
    unsubAi.push(onSnapshot(doc(state.db, ...root, 'meta', 'aiSettings'), (d) => {
      aiPub = d.exists() ? d.data() : null;
      if (!aiPub && chainId && !aiLegacy) {
        Promise.all([
          getDoc(doc(state.db, 'tenants', tenantId, 'meta', 'aiSettings')),
          getDoc(doc(state.db, 'tenants', tenantId, 'meta', 'aiSecrets')).catch(() => null),
        ]).then(([p, k]) => {
          if (p.exists()) { aiLegacy = { pub: p.data(), sec: k && k.exists() ? k.data() : {} }; draw(); }
        }).catch(() => {});
      }
      draw();
    }, () => {}));
    unsubAi.push(onSnapshot(doc(state.db, ...root, 'meta', 'aiSecrets'), (d) => {
      aiSec = d.exists() ? d.data() : null;
      draw();
    }, () => {}));
  };
  sub(() => unsubAi.forEach((u) => u()));

  sub(onSnapshot(doc(state.db, 'tenants', tenantId), (d) => {
    const prevChainId = tenant?.chainId || null;
    const firstLoad = !tenant;
    tenant = d.exists() ? d.data() : null;
    const nextChainId = tenant?.chainId || null;
    if (nextChainId !== prevChainId || !unsubSubscription) watchSubscriptionFor(nextChainId);
    if (nextChainId !== prevChainId || !unsubBranding) watchBrandingFor(nextChainId);
    if (nextChainId !== prevChainId || firstLoad) watchAiFor(nextChainId);
    draw();
  }, () => {}));
  sub(onSnapshot(doc(state.db, 'tenants', tenantId, 'settings', 'deviceInvite'), (d) => {
    invite = d.exists() ? d.data() : null;
    draw();
  }, () => {}));
  sub(onSnapshot(doc(state.db, 'tenants', tenantId, 'settings', 'general'), (d) => {
    generalSettings = d.exists() ? d.data() : null;
    draw();
  }, () => {}));
  sub(onSnapshot(doc(state.db, 'tenants', tenantId, 'meta', 'venueProfile'), (d) => {
    venueProfile = d.exists() ? d.data() : null;
    draw();
  }, () => {}));
  sub(onSnapshot(query(collection(state.db, 'broadcasts'), where('active', '==', true), orderBy('createdAt', 'desc'), limit(5)), (snap) => {
    broadcasts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  }, () => {
    broadcasts = [];
    draw();
  }));
  // Без orderBy — он требует составного индекса. Обращений у заведения
  // единицы, сортируем на месте.
  sub(onSnapshot(query(collection(state.db, 'supportTickets'), where('tenantId', '==', tenantId), limit(200)), (snap) => {
    supportTickets = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => ticketTime(b) - ticketTime(a));
    supportTicketsError = '';
    draw();
  }, (e) => {
    supportTickets = [];
    supportTicketsError = e?.message || String(e);
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
  // Тост — только на переходе queued → success/failed, а не на каждом
  // снапшоте и не для сборок, готовых до открытия кабинета.
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
  sub(onSnapshot(
    query(collection(state.db, 'billingEvents'), where('tenantId', '==', tenantId), orderBy('receivedAt', 'desc'), limit(50)),
    (snap) => {
      paymentHistory = snap.docs.map((d) => d.data());
      draw();
    },
    () => { paymentHistory = []; draw(); },
  ));
  sub(onSnapshot(
    query(collection(state.db, 'bankInvoices'), where('tenantId', '==', tenantId), limit(50)),
    (snap) => {
      bankInvoices = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.number || 0) - (a.number || 0));
      draw();
    },
    () => { bankInvoices = []; draw(); },
  ));

  // Живые цифры «Обзора». «Сегодня» — по часам браузера: это ориентир, а не
  // бухгалтерия.
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
  {
    // Одно неравенство по closedAt — хватает встроенного индекса; открытые
    // смены (closedAt == null) в выборку не попадают.
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    sub(onSnapshot(
      query(
        collection(state.db, 'tenants', tenantId, 'shifts'),
        where('closedAt', '>=', Timestamp.fromDate(weekAgo)),
        orderBy('closedAt', 'desc'),
        limit(20),
      ),
      (snap) => { recentClosedShifts = snap.docs.map((d) => d.data()); draw(); },
      () => { recentClosedShifts = []; draw(); },
    ));
  }
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
          // Возвращённый чек не выручка — так же считает X-отчёт кассы.
          if (s.refunded === true) return sum;
          return sum + (Number(s.paymentCash) || 0) + (Number(s.paymentCard) || 0) +
            (Number(s.paymentTerminal) || 0) + (Number(s.paymentComp) || 0);
        }, 0);
        draw();
      },
      () => { todayChecksCount = 0; todayRevenue = 0; draw(); },
    ));
  }
}

// draw() кабинета перерисовывает вкладку на любой снапшот, а живые цифры
// «Обзора» меняются весь день. Без переноса введённого и фокуса формы
// (сотрудник, приглашение, согласие на автопродление) стирались бы посреди
// набора.
function renderKeepingInputs(root, html) {
  const saved = new Map();
  root.querySelectorAll('input[id], textarea[id], select[id]').forEach((el) => {
    if (el.type === 'file' || el.type === 'radio') return;
    saved.set(el.id, el.type === 'checkbox' ? el.checked : el.value);
  });
  const active = document.activeElement;
  const focusId = active && active.id && root.contains(active) ? active.id : '';
  let caret = null;
  try { caret = focusId ? [active.selectionStart, active.selectionEnd] : null; } catch (_) { /* select, checkbox */ }

  root.innerHTML = html;

  saved.forEach((value, id) => {
    const el = document.getElementById(id);
    if (!el || !root.contains(el)) return;
    if (el.type === 'checkbox') el.checked = value;
    else if (el.tagName === 'SELECT') {
      if (Array.from(el.options).some((o) => o.value === value)) el.value = value;
    } else el.value = value;
  });
  const focusEl = focusId ? document.getElementById(focusId) : null;
  if (focusEl && root.contains(focusEl)) {
    focusEl.focus();
    if (caret && caret[0] !== null) {
      try { focusEl.setSelectionRange(caret[0], caret[1]); } catch (_) { /* type=email/number */ }
    }
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

async function toggleAutorenew(tenantId, cancel, chainId) {
  // Отмену подтверждаем через prompt() и заодно спрашиваем причину:
  // null — нажали «Отмена», пустая строка — причину не написали.
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
    // В subscriptions клиенту писать нельзя — только через saas-gateway.
    await callSaasGateway(
      cancel ? 'cancelSubscription' : 'resumeSubscription',
      cancel ? { tenantId, chainId, reason } : { tenantId, chainId }
    );
    toast(cancel ? 'Автопродление отключено' : 'Автопродление возобновлено');
  } catch (e) {
    if (errEl) errEl.textContent = `Не удалось изменить автопродление: ${e?.message || e}`;
    if (btn) btn.disabled = false;
  }
}

async function changeMemberRole(tenantId, memberUid, role) {
  try {
    // Правила пускают эту запись, только если и старая, и новая роль —
    // manager/employee: до admin/owner отсюда не повысить.
    await updateDoc(doc(state.db, 'tenantMembers', `${tenantId}_${memberUid}`), { role });
    toast('Роль изменена');
  } catch (e) {
    toast(`Не удалось изменить роль: ${e?.message || e}`);
  }
}

// Зеркало членства в сети (chainMembers): по нему правила пускают к общей
// лояльности сети — гостям и бонусам всех точек. Без синхронизации
// отключённый или удалённый из точки сотрудник (или планшет) продолжал
// видеть гостей сети. Если у человека есть активное членство в другой
// точке этой сети, доступ к сети не трогаем.
async function syncChainMember(chainId, tenantId, memberUid, status) {
  if (!chainId) return;
  const ref = doc(state.db, 'chainMembers', `${chainId}_${memberUid}`);
  try {
    if (status !== 'active') {
      for (const t of state.tenants.filter((x) => x.chainId === chainId && x.id !== tenantId)) {
        try {
          const m = await getDoc(doc(state.db, 'tenantMembers', `${t.id}_${memberUid}`));
          if (m.exists() && m.data().status === 'active') return;
        } catch (_) {
          // Нет записи в этой точке — правила не отдают несуществующий документ.
        }
      }
    }
    if (status === null) await deleteDoc(ref);
    else await updateDoc(ref, { status });
  } catch (e) {
    // Записи в сети нет (планшет заведёт её сам при запуске) — нечего менять.
    console.warn('chainMembers sync:', e?.message || e);
  }
}

async function toggleMemberStatus(tenantId, memberUid, isActive, chainId) {
  try {
    const status = isActive ? 'inactive' : 'active';
    await updateDoc(doc(state.db, 'tenantMembers', `${tenantId}_${memberUid}`), { status });
    await syncChainMember(chainId, tenantId, memberUid, status);
    toast(isActive ? 'Доступ отключён' : 'Доступ включён');
  } catch (e) {
    toast(`Не удалось изменить доступ: ${e?.message || e}`);
  }
}

// «Отключить» оставляет запись в списке, а через заведение проходит много
// планшетов — «Удалить» убирает её совсем.
async function deleteMember(tenantId, memberUid, isDevice, label, chainId) {
  if (!confirm(`Удалить «${label}» из команды безвозвратно? Отменить нельзя — для устройства понадобится заново присоединяться по коду приглашения.`)) return;
  try {
    await deleteDoc(doc(state.db, 'tenantMembers', `${tenantId}_${memberUid}`));
    if (isDevice) {
      // Без удаления devices/{uid} планшет при следующем запуске сам вернёт
      // себе членство: правила пускают самоприсоединение, пока он есть.
      await deleteDoc(doc(state.db, 'tenants', tenantId, 'devices', memberUid));
    }
    await syncChainMember(chainId, tenantId, memberUid, null);
    toast('Удалено');
  } catch (e) {
    toast(`Не удалось удалить: ${e?.message || e}`);
  }
}

// У точки сети брендинг пишется в сеть: гости читают chains/{chainId}/branding.
async function writeBrandingConfig(tenantId, payload, chainId) {
  const ref = chainId
    ? doc(state.db, 'chains', chainId, 'branding', 'config')
    : doc(state.db, 'tenants', tenantId, 'branding', 'config');
  await setDoc(ref, payload, { merge: true });
}

// Поля цветов одинаковые в онбординге и во вкладке «Брендинг».
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

// Предпросмотр меняется вместе с пикерами, чтобы нечитаемое сочетание было
// видно до сохранения.
function updateBrandPreview() {
  const preview = $('f-brand-preview');
  const title = $('f-preview-title');
  const btn = $('f-preview-btn');
  const warning = $('f-contrast-warning');
  if (!preview || !title || !btn) return;

  const bg = $('f-color-bg')?.value || PREMIUM_PALETTES[0].backgroundColor;
  const text = $('f-color-text')?.value || PREMIUM_PALETTES[0].textColor;
  const button = $('f-color-button')?.value || PREMIUM_PALETTES[0].buttonColor;
  const name = $('f-brand-name')?.value || 'ZalPOS';

  preview.style.background = bg;
  title.style.color = text;
  title.textContent = name;
  btn.style.background = button;
  btn.style.color = text;

  // Порог 3:1, как в lib/theme/app_theme.dart: приложение само откатится на
  // цвета по умолчанию, здесь просто предупреждаем до сохранения.
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
  // Без своего заведения «В консоль» вернуло бы сюда же — вместо неё
  // предлагаем завести заведение.
  const consoleLink = state.tenants.length
    ? `<a href="#/" class="nav-item" style="text-decoration:none">${navIconHtml('back', '#64748B')}<span>В консоль</span></a>`
    : `<a href="#/onboarding" class="nav-item" style="text-decoration:none">${navIconHtml('plus', '#22C55E')}<span>Своё заведение</span></a>`;
  return `
    <div class="dash-topbar">
      <button class="hamburger-btn" id="f-admin-nav-open" aria-label="Меню">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
      </button>
      <div class="dash-topbar-title">
        <div class="dash-topbar-tenant">ZalPOS · платформа</div>
        <div class="dash-topbar-tab">${esc(activeMeta?.label || '')}</div>
      </div>
      ${themeToggleHtml()}
      <span class="brand-gem" aria-hidden="true"></span>
    </div>
    <div class="nav-backdrop" id="admin-nav-backdrop"></div>
    <div class="nav-drawer" id="admin-nav-drawer">
      <div class="nav-drawer-brand"><span class="brand-gem" aria-hidden="true"></span>ZalPOS${themeToggleHtml()}</div>
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

        <h2>Счета ИП и организаций</h2>
        <p class="small muted" style="margin-top:-4px">ИП и организации платят переводом по счёту: Робокасса
        для самозанятых принимает только карты физических лиц, а чек при расчётах с ИП и организациями
        должен содержать ИНН покупателя (ст. 14 закона № 422-ФЗ, налог 6 %). Деньги пришли на расчётный
        счёт — нажмите «Оплата получена», подписка продлится. Затем в «Мой налог» сформируйте чек:
        покупатель — ИП или организация, ИНН из счёта, не позднее 9-го числа следующего месяца — и нажмите
        «Чек выдан», вставив ссылку на чек: владелец увидит её в кабинете.</p>
        <div id="admin-bank-invoices"><div class="spinner"></div></div>
      </div>

      <div class="admin-tab-panel" data-panel="tenants">
        <h1>Заведения</h1>
        <div class="row" style="margin-bottom:14px;flex-wrap:wrap">
          <input id="f-tenant-search" class="grow" placeholder="Название, код или email владельца" style="min-width:220px">
          <select id="f-tenant-status-filter" style="width:auto">
            <option value="">Все статусы</option>
            <option value="trial">Пробный период</option>
            <option value="active">Активно</option>
            <option value="past_due">Просрочена оплата</option>
            <option value="suspended">Приостановлено</option>
            <option value="cancelled">Отменено</option>
          </select>
          <button class="btn btn-ghost" id="f-export-tenants-csv" style="width:auto">Экспорт в CSV</button>
        </div>
        <div id="admin-body"><div class="spinner"></div></div>
      </div>

      <div class="admin-tab-panel" data-panel="plans">
        <h1>Тарифы</h1>
        <div class="card" style="margin-bottom:14px">
          <div style="font-weight:700;margin-bottom:4px">Рекомендованная сетка к запуску продаж</div>
          <p class="small muted">Одно заведение: «Старт» 1 790 ₽/мес (до 5 сотрудников, приложение гостя, без ИИ),
          «Бизнес» 2 390 ₽ (до 10 сотрудников, приложение гостя и ИИ), «Про» 2 990 ₽ (сотрудники без ограничений,
          приоритетная поддержка). Сеть: «Сеть» 2 590 ₽ за первую точку + 990 ₽ за каждую следующую (до 10 сотрудников
          на точке), «Сеть Про» 3 990 ₽ + 1 290 ₽ (без ограничений, приоритетная поддержка). Рабочие места везде без
          ограничений. Год — выгода 20%, полгода — около 10%. Пробный период 14 дней. Тарифы вне сетки уходят в архив:
          с сайта пропадают, кто на них — остаётся на прежних условиях. Тем, кто уже платит, подорожание начнёт
          действовать через 30 дней (так в оферте) — разошлите им объявление.</p>
          <button class="btn btn-ghost" id="f-apply-plan-catalog" style="width:auto">Посмотреть изменения и применить</button>
        </div>
        <div id="admin-plans"><div class="spinner"></div></div>
        <button class="btn btn-ghost" id="f-new-plan" style="width:auto;margin-bottom:14px">Добавить тариф</button>
      </div>

      <div class="admin-tab-panel" data-panel="builds">
        <h1>Сборки APK</h1>
        <div id="admin-rollout"></div>
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
        <div class="sec-tabs">
          <button type="button" class="sec-tab active" data-sec="access">Доступ</button>
          <button type="button" class="sec-tab" data-sec="journal">Журнал</button>
          <button type="button" class="sec-tab" data-sec="platform">Платформа</button>
          <button type="button" class="sec-tab" data-sec="activity">Активность</button>
          <button type="button" class="sec-tab" data-sec="data">Данные</button>
        </div>

        <div class="sec-pane active" data-sec-pane="access">
          <p class="small muted">Кто имеет полный доступ к панели платформы и когда в неё
          входил. Назначить или снять супер-админа — в разделе «Сотрудники платформы».</p>
          <div id="sec-access-warnings"></div>
          <div id="sec-access-list"><div class="spinner"></div></div>
        </div>

        <div class="sec-pane" data-sec-pane="journal">
          <h2>Входы в панель</h2>
          <p class="small muted">Последние 30 входов супер-админов: когда, откуда и с какого
          устройства. Незнакомый вход — нажмите «Это был не я»: все сеансы этого
          аккаунта завершатся, а пароль стоит сменить.</p>
          <div id="sec-logins"><div class="spinner"></div></div>
          <h2>Опасные действия</h2>
          <p class="small muted">Действия, которыми можно навредить платформе: доступ
          супер-админов, блокировки и удаление заведений, ручные решения по деньгам
          (тарифы, подписки, бонусные дни). Запись нельзя изменить или удалить.</p>
          <div id="sec-events"><div class="spinner"></div></div>
        </div>

        <div class="sec-pane" data-sec-pane="platform">
          <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
            <p class="small muted grow" style="margin:0">Проверки, которые видны только с сервера.
            Обновляется при открытии раздела.</p>
            <button type="button" class="btn btn-ghost" id="f-sec-platform-refresh" style="width:auto;flex:none">Обновить</button>
          </div>
          <div id="sec-platform"><div class="spinner"></div></div>
        </div>

        <div class="sec-pane" data-sec-pane="activity">
          <h2>Регистрации по IP</h2>
          <p class="small muted">Создание заведений, сетей и демо за 7 дней по IP-адресам. Подсвечены
          адреса с 3 и более регистрациями за сутки, упором в лимит демо или отказом по блокировке.</p>
          <div id="sec-signups"><div class="spinner"></div></div>

          <h2>Блокировки</h2>
          <p class="small muted">С этих IP-адресов и доменов почты нельзя создать заведение, сеть или
          демо. Уже зарегистрированные владельцы по-прежнему входят и работают.</p>
          <div class="card">
            <div class="row" style="flex-wrap:wrap;gap:8px">
              <select id="f-sec-block-type" style="width:auto;margin:0">
                <option value="ip">IP-адрес</option>
                <option value="emailDomain">Домен почты</option>
              </select>
              <input id="f-sec-block-value" class="grow" placeholder="203.0.113.7 или spam-mail.ru" style="margin:0;min-width:160px">
            </div>
            <input id="f-sec-block-reason" placeholder="Причина (необязательно)" style="margin-top:8px">
            <button type="button" class="btn btn-ghost" id="f-sec-block-add" style="width:auto">Заблокировать</button>
            <div id="f-sec-block-error" class="small" style="color:var(--danger);margin-top:6px"></div>
          </div>
          <div id="sec-blocklist"></div>

          <h2>Кассовые устройства</h2>
          <p class="small muted">Устройства, которые 30 дней и дольше не выходили на связь: планшет мог
          потеряться или уйти вместе с доступом к заведению. «Отключить» закрывает устройству доступ к
          данным сразу.</p>
          <label class="row" style="width:auto;gap:6px;margin-bottom:8px">
            <input type="checkbox" id="f-sec-devices-all" style="width:auto;margin:0"> Показать все устройства
          </label>
          <div id="sec-devices"><div class="spinner"></div></div>
        </div>

        <div class="sec-pane" data-sec-pane="data">
          <h2>Запросы о персональных данных</h2>
          <p class="small muted">Удалить, выдать копию или исправить данные. Гости удаляют свои данные
          сами кнопкой в профиле приложения — сразу, здесь такие запросы видны уже выполненными; письма
          и звонки заводите здесь. Срок ответа — 10 рабочих дней с получения запроса, на исправление —
          7 рабочих дней (ст. 20 и 21 152-ФЗ); просроченные подсвечены.</p>
          <div id="sec-requests"><div class="spinner"></div></div>
          <div class="card">
            <div style="font-weight:600;margin-bottom:8px">Новый запрос</div>
            <div class="row" style="flex-wrap:wrap;gap:8px">
              <select id="f-dr-subject" style="width:auto;margin:0">
                <option value="guest">Гость</option>
                <option value="owner">Владелец заведения</option>
                <option value="other">Другое лицо</option>
              </select>
              <select id="f-dr-kind" style="width:auto;margin:0">
                <option value="delete">Удалить данные</option>
                <option value="export">Выдать копию данных</option>
                <option value="correct">Исправить данные</option>
              </select>
            </div>
            <input id="f-dr-contact" placeholder="Телефон или email" style="margin-top:8px">
            <input id="f-dr-note" placeholder="Комментарий: откуда пришёл запрос, что именно просят">
            <button type="button" class="btn btn-ghost" id="f-dr-create" style="width:auto">Завести запрос</button>
            <div id="f-dr-error" class="small" style="color:var(--danger);margin-top:6px"></div>
          </div>

          <h2>Найти гостя по телефону</h2>
          <div class="card">
            <div class="row" style="gap:8px">
              <input id="f-guest-phone" class="grow" type="tel" placeholder="+7 999 123-45-67" style="margin:0">
              <button type="button" class="btn btn-ghost" id="f-guest-find" style="width:auto">Найти</button>
            </div>
            <div id="sec-guest-found" style="margin-top:8px"></div>
          </div>

          <h2>Журнал удалений данных</h2>
          <p class="small muted">Обезличенные гости, удалённые демо-заведения и заведения и сети, стёртые
          после окончания льготного периода неоплаты.</p>
          <div id="sec-deletions"><div class="spinner"></div></div>
        </div>
      </div>
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
  watchBankInvoicesAdmin();
  watchSuperAdmins();
  watchAllBuildJobs();
  watchAdminInfra();
  watchAdminBroadcasts();
  watchAdminSupportTickets();
  watchSecurity();
  // Отметка входа в панель (IP, браузер) — см. handleRecordAdminLogin в
  // saas-gateway. Сбой не мешает работе панели.
  callSaasGateway('recordAdminLogin', {}).catch(() => {});
}

// Обращения всех заведений. Переписку грузим только для раскрытого тикета,
// как selectTicket() в кабинете владельца.
function watchAdminSupportTickets() {
  const body = $('admin-support');
  let tickets = [];
  let tenantNames = new Map();
  // Приоритетная поддержка — по тарифу заведения (у точки сети — тариф сети).
  const tenantPlan = new Map();
  const chainPlan = new Map();
  let planPriority = new Map();
  const isPriority = (t) => planPriority.get(tenantPlan.get(t.tenantId)) === true;
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
        (snap) => { messages = snap.docs.map((d) => d.data()); draw(); },
        (e) => { messages = []; toast(`Не удалось загрузить переписку: ${e?.message || e}`); draw(); }
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
    // Открытые наверх, среди них — с приоритетной поддержкой по тарифу;
    // sort стабильный, так что внутри групп остаётся порядок запроса —
    // новые сверху.
    const sorted = tickets.slice().sort((a, b) => {
      const rank = (t) => (t.status === 'closed' ? 2 : isPriority(t) ? 0 : 1);
      return rank(a) - rank(b);
    });
    renderKeepingInputs(body, `<div class="card">${sorted.map((t) => `
      <div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div class="row f-admin-ticket-open" data-id="${esc(t.id)}" style="justify-content:space-between;align-items:center;cursor:pointer">
          <div class="small grow" style="min-width:0">
            ${isPriority(t) ? '<span class="cab-plan-badge" style="margin-right:6px">Приоритет</span>' : ''}<b>${esc(t.subject || '')}</b> · ${esc(tenantNames.get(t.tenantId) || t.tenantId)}
            <div class="muted">${fmtDateTime(t.updatedAt || t.createdAt)}</div>
          </div>
          ${t.status !== 'closed' && t.lastAuthorRole !== 'super_admin'
            ? '<div class="small" style="color:var(--warning);font-weight:700;white-space:nowrap">Ждёт ответа</div>'
            : `<div class="small muted">${t.status === 'closed' ? 'Решено' : 'Ответили'}</div>`}
        </div>
        ${expandedId === t.id ? `
          <div style="margin-top:10px">
            ${messages === null ? '<div class="spinner"></div>' : (messages.length ? messages.map((m) => `
              <div style="margin:6px 0;padding:8px 10px;border-radius:10px;background:${m.authorRole === 'super_admin' ? 'var(--surface-2)' : 'transparent'};border:1px solid var(--border)">
                <div class="small muted">${esc(m.authorRole === 'super_admin' ? 'Платформа' : 'Владелец')} · ${fmtDateTime(m.createdAt)}</div>
                <div class="small" style="margin-top:2px;white-space:pre-wrap">${esc(m.text || '')}</div>
              </div>
            `).join('') : '<p class="small muted">Сообщений пока нет.</p>')}
            <textarea class="f-admin-ticket-reply" id="f-admin-reply-${esc(t.id)}" data-id="${esc(t.id)}" rows="2" placeholder="Ответ владельцу..." style="width:100%;resize:vertical;margin-top:6px"></textarea>
            <button class="btn btn-primary f-admin-ticket-send" data-id="${esc(t.id)}" style="margin-top:6px">Отправить</button>
            <button class="btn-link f-admin-ticket-toggle" data-id="${esc(t.id)}" data-status="${esc(t.status)}" style="width:auto;margin-top:6px">
              ${t.status === 'closed' ? 'Переоткрыть' : 'Отметить решённым'}
            </button>
          </div>
        ` : ''}
      </div>
    `).join('')}</div>`);

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
          await setDoc(doc(state.db, 'supportTickets', ticketId), { updatedAt: now, lastAuthorRole: 'super_admin' }, { merge: true });
          const fresh = document.getElementById(`f-admin-reply-${ticketId}`);
          if (fresh) fresh.value = '';
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
        const t = tSnap.exists() ? tSnap.data() : {};
        tenantNames.set(id, t.name || id);
        let planId = t.planId || null;
        if (t.chainId) {
          if (!chainPlan.has(t.chainId)) {
            const cSnap = await getDoc(doc(state.db, 'chains', t.chainId)).catch(() => null);
            chainPlan.set(t.chainId, cSnap?.exists() ? cSnap.data().planId || null : null);
          }
          planId = chainPlan.get(t.chainId) || planId;
        }
        tenantPlan.set(id, planId);
      } catch (_) {
        tenantNames.set(id, id);
      }
    }));
    try {
      const plansSnap = await getDocs(collection(state.db, 'plans'));
      planPriority = new Map(plansSnap.docs.map((d) => [d.id, d.data().prioritySupport === true]));
    } catch (_) {}
    draw();
  }, () => {
    body.innerHTML = '<p class="small muted">Обращения недоступны.</p>';
  }));
}

// Объявления пишутся прямо в Firestore: проверять сверх правил
// (isSuperAdmin) нечего.
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

// Воркер забирает сборку за секунды; полчаса в очереди — повод заглянуть.
const STUCK_BUILD_MINUTES = 30;

// Жив ли saas-gateway, сколько сборок зависло и ручной пересчёт лимитов
// (сервер и так пересчитывает их раз в сутки). Зависшие считаем отдельным
// запросом: watchAllBuildJobs видит только последние 50 сборок.
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
  // 200 последних без пагинации, поиск — по загруженному списку. Когда
  // заведений станет больше, понадобится курсор.
  const q = query(collection(state.db, 'tenants'), orderBy('createdAt', 'desc'), limit(200));
  let allTenants = [];
  let plans = [];
  // «Подробнее»: команду, код, заметки и историю грузим только для раскрытых
  // карточек — для всех 200 сразу это дорого.
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
      // Через сервер: это выдача доступа без оплаты, он пишет «было → стало»
      // в журнал безопасности и сам выбирает подписку сети для её точки.
      await callSaasGateway('overrideSubscription', {
        tenantId,
        status: statusEl.value,
        currentPeriodEnd: periodEl.value || null,
        trialEndsAt: trialEl.value || null,
      });
      toast('Подписка обновлена');
    } catch (e) {
      toast(`Не удалось обновить подписку: ${e?.message || e}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  const grantBonusPeriod = async (tenantId) => {
    // У точки сети продлевается общая подписка — бонус получат все точки,
    // об этом говорим прямо в вопросе.
    const t = allTenants.find((it) => it.id === tenantId) || {};
    const promptLabel = t.chainId
      ? `На сколько дней продлить доступ сети «${t.chainName || t.chainId}» (это затронет ВСЕ её точки)? (от 1 до 365)`
      : 'На сколько дней продлить доступ этому заведению? (от 1 до 365)';
    const input = prompt(promptLabel);
    if (input === null) return;
    const days = Number(input);
    if (!Number.isFinite(days) || days <= 0 || days > 365) {
      toast('Введите число дней от 1 до 365');
      return;
    }
    const btn = document.querySelector(`.f-grant-bonus[data-id="${tenantId}"]`);
    if (btn) btn.disabled = true;
    try {
      // Через сервер: кто и сколько дней выдал, пишется в auditLogs, а туда
      // клиенту писать нельзя.
      await callSaasGateway('grantBonusPeriod', { tenantId, days });
      toast(`Выдано ${days} ${pluralDays(days)}${t.chainId ? ' (всей сети)' : ''}`);
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
          <div class="small" style="padding:2px 0">${esc(memberLabel(m, m.userId === t.ownerUserId ? t.ownerEmail : null))} — ${esc(ROLE_LABELS[m.role] || m.role)}${m.status !== 'active' ? ' · отключён' : ''}</div>
        `).join('') : '<div class="small muted">Пусто</div>'}

        <div class="row" style="justify-content:space-between;align-items:center;margin-top:12px">
          <div class="small muted">Код приглашения устройства: <code>${esc(d.invite?.code || '—')}</code></div>
          <button class="btn-link f-tenant-rotate-invite" data-id="${esc(t.id)}" style="width:auto">Обновить</button>
        </div>

        <div style="margin-top:12px">
          <div class="small muted" style="margin-bottom:6px">Заметки (видны только супер-админам)</div>
          <textarea class="f-tenant-notes" id="f-tenant-notes-${esc(t.id)}" data-id="${esc(t.id)}" rows="3" placeholder="Например: платит переводом, звонил по поводу..." style="width:100%;resize:vertical">${esc(d.notes || '')}</textarea>
          <button class="btn btn-ghost f-tenant-notes-save" data-id="${esc(t.id)}" style="margin-top:6px">Сохранить заметку</button>
        </div>

        <div style="margin-top:14px">
          <div class="small muted" style="margin-bottom:6px">Ручное управление подпиской (оплата мимо платёжного сервиса — перевод, наличные)</div>
          <select class="f-sub-status" id="f-sub-status-${esc(t.id)}" data-id="${esc(t.id)}">
            ${Object.keys(SUB_STATUS_LABELS).map((s) => `<option value="${s}" ${t.subscription?.status === s ? 'selected' : ''}>${esc(SUB_STATUS_LABELS[s])}</option>`).join('')}
          </select>
          <label class="field"><span>Оплачено до</span>
            <input type="date" class="f-sub-period-end" id="f-sub-period-end-${esc(t.id)}" data-id="${esc(t.id)}" value="${tsToDateInputValue(t.subscription?.currentPeriodEnd)}">
          </label>
          <label class="field"><span>Пробный период до</span>
            <input type="date" class="f-sub-trial-end" id="f-sub-trial-end-${esc(t.id)}" data-id="${esc(t.id)}" value="${tsToDateInputValue(t.subscription?.trialEndsAt)}">
          </label>
          <button class="btn btn-ghost f-sub-save" data-id="${esc(t.id)}">Сохранить подписку</button>
        </div>

        <div style="margin-top:14px">
          <button class="btn-link f-grant-bonus" data-id="${esc(t.id)}" style="width:auto">🎁 Выдать бонусный период</button>
        </div>

        <div style="margin-top:14px">
          <div class="small muted" style="margin-bottom:6px">Бэкап — все данные одним файлом, без ограничения по объёму
          (восстановление: saas-gateway/restore-backup.js). Каждый документ — одно чтение из дневной квоты базы (50 000).</div>
          <button class="btn btn-ghost f-tenant-backup" data-id="${esc(t.id)}">Скачать бэкап ${t.chainId ? 'точки' : 'заведения'}</button>
          ${t.chainId ? `<button class="btn btn-ghost f-chain-backup" data-chain="${esc(t.chainId)}" data-id="${esc(t.id)}" style="margin-top:8px">Скачать бэкап всей сети</button>` : ''}
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

    // Список перерисовывается на любое изменение любого заведения — не
    // теряем начатую заметку или ручную правку подписки.
    renderKeepingInputs(body, filtered.length ? filtered.map((t) => `
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
              ${t.subscription?.status === 'trial' && t.subscription?.trialEndsAt ? ` · пробный период до ${fmtDate(t.subscription.trialEndsAt)}` : ''}
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
              ${(() => {
                // Тариф точки сети — тариф всей сети (сервер меняет его у сети).
                const curId = t.subscription?.planId || t.planId;
                return plans
                  .filter((p) => !!p.isChainPlan === !!t.chainId && (p.archived !== true || p.id === curId))
                  .map((p) => `<option value="${esc(p.id)}" ${p.id === curId ? 'selected' : ''}>${esc(p.name || p.id)}${t.chainId ? ' (у всей сети)' : ''}${p.archived ? ' — архив' : ''}</option>`).join('');
              })()}
            </select>
          </div>
        ` : ''}
        <button class="btn-link f-tenant-detail-toggle" data-id="${esc(t.id)}" style="margin-top:8px">
          ${expandedIds.has(t.id) ? 'Свернуть ▲' : 'Подробнее ▾'}
        </button>
        ${expandedIds.has(t.id) ? renderTenantDetail(t) : ''}
      </div>
    `).join('') : `<p class="small muted">${term || statusFilter ? 'Ничего не найдено.' : 'Заведений пока нет.'}</p>`);

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
    document.querySelectorAll('.f-tenant-backup, .f-chain-backup').forEach((el) => {
      el.onclick = () => {
        const t = allTenants.find((x) => x.id === el.dataset.id) || {};
        exportVenueBackup(el.dataset.chain
          ? { chainId: el.dataset.chain, fileKey: t.chainSlug || t.chainName || el.dataset.chain, label: t.chainName || 'сеть', asAdmin: true, unlimited: true }
          : { tenantId: t.id, fileKey: t.slug, label: t.name || t.id, asAdmin: true, unlimited: true });
      };
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
    // usage (сервер пересчитывает раз в сутки) и подписку читаем разово —
    // для карточек и «Требует внимания».
    await Promise.all(tenants.map(async (t) => {
      try {
        const uSnap = await getDoc(doc(state.db, 'tenants', t.id, 'usage', 'current'));
        t.usage = uSnap.exists() ? uSnap.data() : null;
      } catch (_) {
        t.usage = null;
      }
      try {
        // У точки сети подписка общая — subscriptions/{chainId}.
        const sSnap = await getDoc(doc(state.db, 'subscriptions', t.chainId || t.id));
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
      // Email владельца — для поиска и «Подробнее»; нет — не беда.
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
        'Название', 'Код', 'Статус', 'Тариф', 'Статус подписки', 'Оплачено до', 'Пробный период до',
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
      downloadCsv(`zalpos-заведения-${new Date().toISOString().slice(0, 10)}.csv`, rows);
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

/** Автообновление приложений всех заведений (runAppRolloutTick в
 *  saas-gateway/server.js): что раскатывается сейчас и кнопка «пересобрать
 *  всем» — она же снимает паузу после упавшей сборки. */
const ROLLOUT_STATE_LABELS = {
  waiting: 'ждёт запуска', running: 'идёт', done: 'все приложения обновлены', paused: 'на паузе',
};
function watchAppRollout() {
  const box = $('admin-rollout');
  if (!box) return;
  sub(onSnapshot(doc(state.db, 'platformStatus', 'appRollout'), (snap) => {
    const r = snap.exists() ? snap.data() : null;
    const version = r?.sha ? (r.sha.startsWith('manual-') ? 'запуск из панели' : `коммит ${r.sha.slice(0, 7)}`) : '';
    box.innerHTML = `
      <div class="card">
        <div class="small"><b>Автообновление приложений</b>${r ? ` · ${esc(ROLLOUT_STATE_LABELS[r.state] || r.state || '')}` : ''}</div>
        <p class="small muted">После каждого обновления кода приложений сервер сам пересобирает
        кассу и гостевое приложение всем заведениям, у которых приложения уже собирались
        (по два заведения одновременно), — приложения на устройствах скачивают новую версию сами.
        На сервере хранится только последняя сборка каждого приложения.</p>
        ${r ? `<div class="small muted">${esc(version)} · запрошено ${fmtDateTime(r.requestedAt)}${r.finishedAt ? ` · завершено ${fmtDateTime(r.finishedAt)}` : ''}</div>` : ''}
        ${r?.pausedReason ? `<div class="small" style="color:var(--danger);margin-top:6px">${esc(r.pausedReason)}</div>` : ''}
        ${r?.lastError && r.state !== 'done' ? `<div class="small" style="color:var(--warning);margin-top:6px">${esc(r.lastError)}</div>` : ''}
        <button class="btn btn-ghost" id="f-rollout-all" style="width:auto;margin-top:10px">Пересобрать приложения всем заведениям</button>
      </div>`;
    $('f-rollout-all').onclick = async (e) => {
      if (!confirm('Пересобрать кассу и гостевое приложение всем заведениям, у которых они уже есть? Сборка идёт по очереди.')) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await callSaasGateway('rolloutApps', {});
        toast('Пересборка запущена');
      } catch (err) {
        toast(err.message || 'Не удалось запустить');
        btn.disabled = false;
      }
    };
  }, () => { box.innerHTML = ''; }));
}

function watchAllBuildJobs() {
  watchAppRollout();
  const body = $('admin-builds');
  const q = query(collection(state.db, 'buildJobs'), orderBy('createdAt', 'desc'), limit(50));
  sub(onSnapshot(q, async (snap) => {
    const jobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // В buildJobs нет названия заведения — дочитываем, это до 50 чтений.
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
          ${esc(buildJobLabel(j))} ·
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
        <label class="row" style="width:auto;gap:6px;margin-bottom:12px">
          <input type="checkbox" class="f-plan-checkbox f-plan-is-chain" data-plan="${esc(p.id)}" data-field="isChainPlan" ${p.isChainPlan ? 'checked' : ''} style="width:auto">
          Тариф для сети заведений (своя цена за первую точку и за каждую следующую)
        </label>
        <label class="field"><span>${p.isChainPlan ? 'Цена за ПЕРВУЮ точку, ₽/мес' : 'Цена, ₽/мес'} (0 — не продаётся напрямую, только вручную через смену тарифа заведению)</span>
          <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="priceRub" value="${Number(p.priceRub) || 0}">
        </label>
        <label class="field"><span>Цена, ₽/6 мес (0 — оплата на полгода для этого тарифа недоступна)</span>
          <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="priceRubSemiannual" value="${Number(p.priceRubSemiannual) || 0}">
        </label>
        <label class="field"><span>Цена, ₽/год (0 — годовая оплата для этого тарифа недоступна)</span>
          <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="priceRubYearly" value="${Number(p.priceRubYearly) || 0}">
        </label>
        <div class="f-plan-chain-fields" data-plan="${esc(p.id)}" style="${p.isChainPlan ? '' : 'display:none'};border-top:1px solid var(--border);padding-top:12px;margin-bottom:4px">
          <label class="row" style="width:auto;gap:6px;margin-bottom:10px">
            <input type="checkbox" class="f-plan-checkbox f-plan-custom-additional" data-plan="${esc(p.id)}" data-field="customAdditionalPrice" ${p.customAdditionalPrice ? 'checked' : ''} style="width:auto">
            Своя цена за КАЖДУЮ ДОПОЛНИТЕЛЬНУЮ точку сети (без галочки — доп. точка стоит как первая)
          </label>
          <div class="f-plan-additional-price-fields" data-plan="${esc(p.id)}" style="${p.customAdditionalPrice ? '' : 'display:none'}">
            <label class="field"><span>Доп. точка, ₽/мес</span>
              <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="priceRubAdditional" value="${Number(p.priceRubAdditional) || 0}">
            </label>
            <label class="field"><span>Доп. точка, ₽/6 мес</span>
              <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="priceRubAdditionalSemiannual" value="${Number(p.priceRubAdditionalSemiannual) || 0}">
            </label>
            <label class="field"><span>Доп. точка, ₽/год</span>
              <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="priceRubAdditionalYearly" value="${Number(p.priceRubAdditionalYearly) || 0}">
            </label>
          </div>
        </div>
        <div class="row">
          <label class="field grow"><span>Сотрудников (0 = без лимита)</span>
            <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="maxEmployees" value="${Number(p.maxEmployees) || 0}">
          </label>
          <label class="field grow"><span>Устройств (0 = без лимита; касса их не считает — число видно на сайте и в предупреждениях панели)</span>
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
          <input type="number" min="1" class="f-plan-field" data-plan="${esc(p.id)}" data-field="trialDays" value="${Number(p.trialDays) || 7}">
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
          <label class="row" style="width:auto;gap:6px">
            <input type="checkbox" class="f-plan-checkbox" data-plan="${esc(p.id)}" data-field="prioritySupport" ${p.prioritySupport ? 'checked' : ''}> Приоритетная поддержка
          </label>
          <label class="row" style="width:auto;gap:6px">
            <input type="checkbox" class="f-plan-checkbox" data-plan="${esc(p.id)}" data-field="features.guestApp" ${planCaps(p).guestApp ? 'checked' : ''}> Приложение гостя и меню по QR
          </label>
          <label class="row" style="width:auto;gap:6px">
            <input type="checkbox" class="f-plan-checkbox" data-plan="${esc(p.id)}" data-field="archived" ${p.archived ? 'checked' : ''}> В архиве (не продаётся, скрыт с сайта)
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
    document.querySelectorAll('.f-plan-is-chain').forEach((el) => {
      el.onchange = () => {
        const fields = document.querySelector(`.f-plan-chain-fields[data-plan="${el.dataset.plan}"]`);
        if (fields) fields.style.display = el.checked ? '' : 'none';
      };
    });
    document.querySelectorAll('.f-plan-custom-additional').forEach((el) => {
      el.onchange = () => {
        const fields = document.querySelector(`.f-plan-additional-price-fields[data-plan="${el.dataset.plan}"]`);
        if (fields) fields.style.display = el.checked ? '' : 'none';
      };
    });
  }, () => {
    body.innerHTML = '<p class="small muted">Тарифы недоступны.</p>';
  }));

  if ($('f-apply-plan-catalog')) $('f-apply-plan-catalog').onclick = () => applyPlanCatalog();
  $('f-new-plan').onclick = async () => {
    const id = prompt('Код нового тарифа (латиница, цифры, дефис — например custom-vip; "chain" — для сети заведений):');
    if (!id || !/^[a-z0-9-]+$/.test(id)) {
      if (id !== null) toast('Код тарифа: только латиница, цифры и дефис');
      return;
    }
    // «chain» — тариф сети по умолчанию в handleCreateChain, но сетевым можно
    // сделать любой.
    const isChainPlan = id === 'chain' || confirm('Это тариф для сети заведений (своя цена за первую и доп. точки)?');
    try {
      // Тарифы пишет только saas-gateway (handleSavePlan) — изменения цен
      // попадают в журнал безопасности.
      await callSaasGateway('savePlan', { planId: id, create: true, fields: {
        name: isChainPlan && id === 'chain' ? 'Сеть заведений' : id,
        priceRub: 0, priceRubSemiannual: 0, priceRubYearly: 0,
        ...(isChainPlan ? {
          isChainPlan: true, customAdditionalPrice: false,
          priceRubAdditional: 0, priceRubAdditionalSemiannual: 0, priceRubAdditionalYearly: 0,
        } : {}),
        maxEmployees: 0, maxDevices: 0, maxTables: 0, maxStorageMb: 0,
        trialDays: 7, aiEnabled: false, customBranding: false, customDomain: false,
        features: { reservations: true, loyalty: true, guestApp: true, advancedReports: false },
      } });
      toast('Тариф создан — заполните цену и лимиты ниже');
    } catch (e) {
      toast(`Не удалось создать тариф: ${e?.message || e}`);
    }
  };
}

// Рекомендованная сетка тарифов: сначала показываем, что изменится, и
// только после подтверждения записываем (handleApplyPlanCatalog).
async function applyPlanCatalog() {
  const btn = $('f-apply-plan-catalog');
  if (btn) btn.disabled = true;
  try {
    const { data } = await callSaasGateway('applyPlanCatalog', {});
    const line = (r) => {
      if (r.action === 'moveOrphans') return `• ${r.count} ${plural(r.count, 'заведение', 'заведения', 'заведений')} без выбранного тарифа (заглушка «start») перейдут на «${(data.diff || []).find((x) => x.planId === r.to)?.after?.name || r.to}» — у них сохранятся приложение гостя и ИИ`;
      if (r.action === 'archive') return `• «${r.before.name}» (${r.planId}) — в архив, цена ${r.before.priceRub} ₽ для тех, кто на нём, не меняется`;
      const from = r.before ? `«${r.before.name}» ${r.before.priceRub} ₽ → ` : 'новый: ';
      const extra = [
        r.after.priceRubAdditional ? `+${r.after.priceRubAdditional} ₽ за доп. точку` : '',
        r.after.maxEmployees ? `до ${r.after.maxEmployees} сотр.` : 'без лимита сотрудников',
        r.after.guestApp ? 'приложение гостя' : 'без приложения гостя',
        r.after.ai ? 'ИИ' : 'без ИИ',
        r.after.prioritySupport ? 'приоритетная поддержка' : '',
      ].filter(Boolean).join(', ');
      return `• ${r.planId}: ${from}«${r.after.name}» ${r.after.priceRub} ₽/мес (${extra})`;
    };
    const ok = confirm(`Применить сетку тарифов?\n\n${(data.diff || []).map(line).join('\n')}\n\nТем, кто уже платит, подорожание начнёт действовать через 30 дней. Отменить можно, поправив тарифы вручную.`);
    if (!ok) return;
    const res = await callSaasGateway('applyPlanCatalog', { confirm: true });
    toast(`Сетка тарифов применена${res.data?.priceLocked ? ` — у ${res.data.priceLocked} подписчиков прежняя цена до ${new Date(res.data.priceLockUntil).toLocaleDateString('ru-RU')}` : ''}`);
  } catch (e) {
    toast(`Не удалось применить сетку тарифов: ${e?.message || e}`);
  } finally {
    if (btn) btn.disabled = false;
  }
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
      // features.* — вложенное поле: сервер сливает его с остальными возможностями.
      if (el.dataset.field.startsWith('features.')) {
        payload.features = { ...(payload.features || {}), [el.dataset.field.slice(9)]: el.checked };
      } else {
        payload[el.dataset.field] = el.checked;
      }
    });
    await callSaasGateway('savePlan', { planId, fields: payload });
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
    // Заведения удаление не трогает, но их planId повиснет — предупреждаем.
    const inUse = await getDocs(query(collection(state.db, 'tenants'), where('planId', '==', planId), limit(1)));
    const warning = inUse.empty
      ? `Удалить тариф «${planId}»? Отменить нельзя.`
      : `Тариф «${planId}» сейчас назначен как минимум одному заведению — после удаления у него останется тариф без описания, назначьте другой вручную. Удалить всё равно?`;
    if (!confirm(warning)) return;
    await callSaasGateway('deletePlan', { planId });
    toast('Тариф удалён');
  } catch (e) {
    toast(`Не удалось удалить тариф: ${e?.message || e}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Столбики на div'ах — библиотека ради двух графиков не нужна.
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

/** Счета ИП и организаций в панели платформы: отметить оплату (продлить
 *  подписку) и выданный чек с ИНН покупателя. */
function watchBankInvoicesAdmin() {
  const body = $('admin-bank-invoices');
  if (!body) return;
  const isoToRu = (iso) => (iso ? iso.split('-').reverse().join('.') : '—');
  sub(onSnapshot(query(collection(state.db, 'bankInvoices'), orderBy('createdAt', 'desc'), limit(100)), (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!list.length) {
      body.innerHTML = '<p class="small muted">Счетов пока не было.</p>';
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    body.innerHTML = `<div class="card">${list.map((b) => {
      const p = b.payer || {};
      const late = b.status === 'paid' && !b.receiptIssuedAt && b.receiptDueDate && b.receiptDueDate < today;
      return `
        <div class="row" style="justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--border);flex-wrap:wrap">
          <div class="grow small">
            <b>№ ${esc(String(b.number))}</b> от ${fmtDate(b.createdAt)} · ${Number(b.amount || 0).toLocaleString('ru-RU')} ₽ · ${esc(BANK_INVOICE_STATUS_LABELS[b.status] || b.status)}
            <div class="muted">${p.type === 'org' ? 'Организация' : 'ИП'} ${esc(p.name || '')} · ИНН ${esc(p.inn || '—')}${p.kpp ? `, КПП ${esc(p.kpp)}` : ''} · ${esc(b.title || '')}${b.email ? ` · ${esc(b.email)}` : ''}</div>
            ${b.status === 'paid' ? (b.receiptIssuedAt
              ? `<div class="muted">Чек выдан ${fmtDate(b.receiptIssuedAt)}${b.receiptUrl ? ` · <a href="${esc(b.receiptUrl)}" target="_blank" rel="noopener">открыть чек</a>` : ''}</div>`
              : `<div style="color:${late ? 'var(--danger)' : 'var(--warning)'}">Нужен чек в «Мой налог» на ${p.type === 'org' ? 'организацию' : 'ИП'} с ИНН ${esc(p.inn || '')} — до ${isoToRu(b.receiptDueDate)}${late ? ' (срок прошёл)' : ''}</div>`) : ''}
          </div>
          ${b.status === 'pending' ? `
            <button class="btn btn-ghost f-bank-paid" data-id="${esc(b.id)}" data-label="№ ${esc(String(b.number))} на ${Number(b.amount || 0).toLocaleString('ru-RU')} ₽" style="width:auto">Оплата получена</button>
            <button class="btn-link f-bank-cancel-admin" data-id="${esc(b.id)}" style="width:auto">Отменить</button>
          ` : ''}
          ${b.status === 'paid' && !b.receiptIssuedAt ? `<button class="btn btn-ghost f-bank-receipt" data-id="${esc(b.id)}" style="width:auto">Чек выдан</button>` : ''}
        </div>
      `;
    }).join('')}</div>`;
    const act = (sel, fn) => body.querySelectorAll(sel).forEach((el) => {
      el.onclick = async () => {
        const payload = await fn(el);
        if (!payload) return;
        el.disabled = true;
        try {
          await callSaasGateway(payload.endpoint, payload.body);
        } catch (e) {
          toast(`Не получилось: ${e?.message || e}`);
          el.disabled = false;
        }
      };
    });
    act('.f-bank-paid', async (el) => (confirm(`Деньги по счёту ${el.dataset.label} поступили на расчётный счёт? Подписка продлится.`)
      ? { endpoint: 'markBankInvoicePaid', body: { id: el.dataset.id } } : null));
    act('.f-bank-cancel-admin', async (el) => (confirm('Отменить неоплаченный счёт?')
      ? { endpoint: 'cancelBankInvoice', body: { id: el.dataset.id } } : null));
    act('.f-bank-receipt', async (el) => {
      const url = prompt('Ссылка на чек из «Мой налог» (Чеки → чек → «Поделиться»). Можно оставить пустой:', '');
      return url === null ? null : { endpoint: 'markBankInvoiceReceipt', body: { id: el.dataset.id, receiptUrl: url.trim() } };
    });
  }, (e) => {
    body.innerHTML = `<p class="small" style="color:var(--danger)">Не удалось загрузить счета: ${esc(e?.message || e)}</p>`;
  }));
}

function watchAnalytics() {
  const body = $('admin-analytics');

  // Последние оплаты с отметкой «тестовая»: проверочные оплаты до запуска
  // (и любые, прошедшие в тестовом режиме Робокассы) супер-админ убирает
  // из выручки одним нажатием.
  const paymentsHtml = (events, tenants) => {
    const paid = events.filter((e) => e.status === 'succeeded').slice(0, 15);
    if (!paid.length) return '';
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    return `
      <div class="card" style="margin-top:14px">
        <div class="small muted">Последние оплаты</div>
        ${paid.map((e) => `
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--border)">
            <div style="flex:1;min-width:160px">
              <b>${Number(e.amount || 0).toLocaleString('ru-RU')} ₽</b>
              ${e.test ? '<span style="margin-left:6px;padding:2px 8px;border-radius:999px;font-size:12px;color:var(--warning);border:1px solid currentColor">тестовая</span>' : ''}
              <div class="small muted">${esc(names.get(e.tenantId) || (e.chainId ? 'Сеть заведений' : e.tenantId || '—'))} · ${e.receivedAt?.toDate ? esc(e.receivedAt.toDate().toLocaleString('ru-RU')) : ''} · ${esc(e.provider || '')}</div>
            </div>
            <button class="btn-link f-pay-test" data-id="${esc(e.id)}" data-test="${e.test ? '0' : '1'}" style="width:auto">${e.test ? 'Это настоящая оплата' : 'Отметить тестовой'}</button>
          </div>
        `).join('')}
      </div>
    `;
  };
  // onclick, а не addEventListener: панель могут открыть повторно.
  body.onclick = async (ev) => {
    const btn = ev.target.closest?.('.f-pay-test');
    if (!btn) return;
    btn.disabled = true;
    try {
      await callSaasGateway('setBillingEventTest', { eventId: btn.dataset.id, test: btn.dataset.test === '1' });
      toast(btn.dataset.test === '1' ? 'Оплата отмечена тестовой — в выручку не идёт' : 'Оплата снова учитывается в выручке');
    } catch (e) {
      toast(`Не получилось: ${e?.message || e}`);
      btn.disabled = false;
    }
  };

  const draw = (allTenants, allEvents, metrics, allChains) => {
    const now = Date.now();
    const day = 86400000;
    // Демо-заведения (кнопка «Демо» на кассе) — не клиенты; подписка,
    // оплаченная тестовым платежом, — не выручка. Так же считает
    // runCalculatePlatformMetrics на сервере.
    const tenants = allTenants.filter((t) => t.demo !== true);
    const chains = (allChains || []).filter((c) => c.demo !== true);
    const revenueEvents = allEvents.filter((e) => e.test !== true);
    const testPaid = allEvents.filter((e) => e.test === true && e.status === 'succeeded');
    const byStatus = {};
    tenants.forEach((t) => { if (t.status !== 'deleted') byStatus[t.status] = (byStatus[t.status] || 0) + 1; });
    // status и planId точки сети биллинг не отражают (точка «active» даже на
    // триале сети), поэтому точки только считаем, а MRR сетей — ниже по
    // chains. Так же считает runCalculatePlatformMetrics на сервере.
    const locationCountByChain = new Map();
    let activeCount = 0;
    let mrr = tenants.reduce((sum, t) => {
      if (t.chainId) {
        // Как countChainLocations: приостановленные точки оплачиваются,
        // удалённые — нет.
        if (t.status !== 'deleted') locationCountByChain.set(t.chainId, (locationCountByChain.get(t.chainId) || 0) + 1);
        return sum;
      }
      if (t.status !== 'active' || t.testPayment === true) return sum;
      activeCount += 1;
      const plan = state.plansById?.[t.planId];
      return sum + (Number(plan?.priceRub) || 0);
    }, 0);
    chains.forEach((c) => {
      if (c.status !== 'active' || c.testPayment === true) return;
      const plan = state.plansById?.[c.planId];
      if (!plan) return;
      const locationCount = Math.max(1, locationCountByChain.get(c.id) || 0);
      activeCount += locationCount;
      const first = Number(plan.priceRub) || 0;
      const additional = plan.customAdditionalPrice ? (Number(plan.priceRubAdditional) || 0) : first;
      mrr += first + additional * Math.max(0, locationCount - 1);
    });
    // Регистрация — новый владелец, а не каждое заведение: точки, которые
    // владелец добавил в свою сеть, и второе заведение того же аккаунта
    // регистрациями не считаем.
    const firstByOwner = new Map();
    tenants.forEach((t) => {
      const at = t.createdAt?.toMillis ? t.createdAt.toMillis() : null;
      if (at == null) return;
      const owner = t.ownerUserId || t.id;
      if (!firstByOwner.has(owner) || at < firstByOwner.get(owner)) firstByOwner.set(owner, at);
    });
    const signupTimes = [...firstByOwner.values()];
    const signups7d = signupTimes.filter((at) => now - at <= 7 * day).length;
    const signups30d = signupTimes.filter((at) => now - at <= 30 * day).length;
    const liveTenants = tenants.filter((t) => t.status !== 'deleted').length;
    const succeeded = revenueEvents.filter((e) => e.status === 'succeeded');
    const totalRevenue = succeeded.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    // Лимит НПД — 2,4 млн ₽ дохода за календарный год (ч. 2 ст. 4 закона
    // № 422-ФЗ): после превышения режим перестаёт действовать.
    const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
    const yearRevenue = succeeded
      .filter((e) => e.receivedAt?.toMillis && e.receivedAt.toMillis() >= yearStart)
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const npd = legalCache?.taxRegime === 'npd';
    const NPD_LIMIT = 2400000;

    const tile = (label, value) => `
      <div class="card" style="text-align:center;padding:14px 8px">
        <div style="font-size:22px;font-weight:700">${value}</div>
        <div class="small muted">${esc(label)}</div>
      </div>
    `;

    // Регистрации восстанавливаются по createdAt, а MRR задним числом не
    // посчитать — только из суточных снимков platformMetrics.
    const REGS_TREND_DAYS = 14;
    const dayKey = (ms) => new Date(ms).toISOString().slice(5, 10);
    const regsByDay = new Map();
    signupTimes.forEach((at) => {
      const ageDays = Math.floor((now - at) / day);
      if (ageDays < 0 || ageDays >= REGS_TREND_DAYS) return;
      const key = dayKey(at);
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
        ${tile('Заведений', liveTenants)}
        ${tile('Активных подписок', activeCount)}
        ${tile('MRR (оценка)', `${mrr.toLocaleString('ru-RU')} ₽`)}
        ${tile('Выручка (последние платежи)', `${totalRevenue.toLocaleString('ru-RU')} ₽`)}
        ${tile(npd ? 'Доход с 1 января (лимит НПД 2,4 млн)' : 'Доход с 1 января', `${yearRevenue.toLocaleString('ru-RU')} ₽`)}
        ${tile('Регистраций за 7 дней', signups7d)}
        ${tile('Регистраций за 30 дней', signups30d)}
      </div>
      <p class="small muted" style="margin-top:10px">
        Разбивка по статусам: ${Object.entries(byStatus).map(([s, n]) => `${esc(TENANT_STATUS_LABELS[s] || s)} — ${n}`).join(', ') || '—'}.
        Выручка — сумма последних ${revenueEvents.length} обработанных платежей, не весь исторический архив.
        Не учитываются демо-заведения${testPaid.length ? ` и тестовые оплаты (${testPaid.length} на ${testPaid.reduce((a, e) => a + (Number(e.amount) || 0), 0).toLocaleString('ru-RU')} ₽)` : ' и тестовые оплаты'};
        регистрации — новые владельцы, а не каждая точка сети.
      </p>
      ${paymentsHtml(allEvents, allTenants)}
      ${npd && yearRevenue >= NPD_LIMIT * 0.8 ? `
        <p class="small" style="color:var(--danger);margin-top:6px">Доход за год — ${Math.round(yearRevenue / NPD_LIMIT * 100)} % лимита
        налога на профессиональный доход (2,4 млн ₽ в год). После превышения НПД не применяется — заранее
        выберите другой режим (например, УСН) и обновите реквизиты и порядок чеков.</p>
      ` : ''}
      <div class="card" style="margin-top:14px">
        <div class="small muted">Регистрации по дням (последние ${REGS_TREND_DAYS} дней)</div>
        ${barChartHtml(regsTrendPoints, (v) => String(v))}
      </div>
      <div class="card" style="margin-top:14px">
        <div class="small muted">MRR по дням</div>
        ${mrrTrendPoints.length ? barChartHtml(mrrTrendPoints, (v) => `${v.toLocaleString('ru-RU')} ₽`) : `
          <p class="small muted" style="margin-top:8px">Снимков пока нет — появятся начиная с сегодняшнего дня (суточный таймер saas-gateway) или сразу после нажатия «Пересчитать лимиты сейчас» в блоке «Инфраструктура».</p>
        `}
      </div>
    `;
  };

  let tenants = null;
  let revenueEvents = null;
  let metrics = null;
  let chains = null;
  const maybeDraw = () => { if (tenants && revenueEvents && metrics && chains) draw(tenants, revenueEvents, metrics, chains); };
  // Режим налога (НПД) — из реквизитов платформы: для подписи и
  // предупреждения о лимите дохода.
  loadPlatformLegal().then(maybeDraw).catch(() => {});

  getDocs(collection(state.db, 'plans')).then((snap) => {
    state.plansById = {};
    snap.docs.forEach((d) => { state.plansById[d.id] = d.data(); });
  }).catch(() => { state.plansById = {}; });

  sub(onSnapshot(query(collection(state.db, 'tenants'), orderBy('createdAt', 'desc'), limit(500)), (snap) => {
    tenants = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    maybeDraw();
  }, () => { tenants = []; maybeDraw(); }));

  sub(onSnapshot(collection(state.db, 'chains'), (snap) => {
    chains = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    maybeDraw();
  }, () => { chains = []; maybeDraw(); }));

  // Статус фильтруем на клиенте — без лишнего составного индекса.
  sub(onSnapshot(query(collection(state.db, 'billingEvents'), orderBy('receivedAt', 'desc'), limit(500)), (snap) => {
    revenueEvents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    maybeDraw();
  }, () => { revenueEvents = []; maybeDraw(); }));

  // desc + reverse: с asc limit(30) взял бы самые старые снимки.
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
    const snap = await getDocs(query(collection(state.db, 'billingEvents'), orderBy('receivedAt', 'desc'), limit(500)));
    const rows = [['Дата', 'Заведение (id)', 'Сеть (id)', 'Статус', 'Назначение', 'Сумма, ₽']];
    snap.docs.forEach((d) => {
      const e = d.data();
      rows.push([
        fmtDateTime(e.receivedAt), e.tenantId || '—', e.chainId || '',
        e.status === 'succeeded' ? 'оплачен' : (e.status || '—'),
        BILLING_PURPOSE_LABELS[e.purpose] || e.purpose || '—', Number(e.amount) || 0,
      ]);
    });
    downloadCsv(`zalpos-платежи-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  } catch (e) {
    toast(`Не удалось выгрузить платежи: ${e?.message || e}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

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

// Только через сервер: он проверяет свежий ввод пароля и подтверждённую
// почту кандидата и пишет журнал. forceRefresh — чтобы токен нёс новый
// auth_time после reauthenticate().
async function promoteSuperAdmin(email) {
  await callSaasGateway('grantSuperAdmin', { email }, { forceRefresh: true });
}

async function revokeSuperAdmin(uid) {
  if (uid === state.uid) {
    toast('Нельзя снять доступ у самого себя — попросите другого супер-админа');
    return;
  }
  if (!confirm('Снять права супер-админа платформы у этого пользователя?')) return;
  if (!(await reauthenticate('снять доступ супер-админа'))) return;
  try {
    await callSaasGateway('revokeSuperAdmin', { uid }, { forceRefresh: true });
    toast('Доступ снят');
  } catch (e) {
    toast(`Не удалось снять доступ: ${e?.message || e}`);
  }
}

// ---------- БЕЗОПАСНОСТЬ ----------

/** «Chrome · Windows» из User-Agent — чтобы в списке входов было видно, с
 *  какого устройства заходили, без простыни строки браузера. */
function describeUserAgent(ua) {
  const s = String(ua || '');
  if (!s) return 'неизвестное устройство';
  const browser = /YaBrowser/.test(s) ? 'Яндекс Браузер'
    : /Edg\//.test(s) ? 'Edge'
      : /OPR\//.test(s) ? 'Opera'
        : /Firefox\//.test(s) ? 'Firefox'
          : /Chrome\//.test(s) ? 'Chrome'
            : /Safari\//.test(s) ? 'Safari' : 'браузер';
  const os = /Windows/.test(s) ? 'Windows'
    : /Android/.test(s) ? 'Android'
      : /iPhone|iPad|iPod/.test(s) ? 'iOS'
        : /Mac OS X|Macintosh/.test(s) ? 'macOS'
          : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

/** Секунды (sessionsValidAfter) → «дд.мм.гггг чч:мм». */
function fmtEpochSec(sec) {
  return typeof sec === 'number' ? fmtDateTime(Timestamp.fromMillis(sec * 1000)) : '—';
}

/** «Выйти на всех устройствах» для себя или другого супер-админа (см.
 *  handleRevokeAdminSessions в saas-gateway). Свои сеансы — без пароля
 *  (это защитное действие), чужие — только после ввода пароля. */
async function revokeAdminSessions(uid, label, reason) {
  const self = uid === state.uid;
  const question = self
    ? 'Завершить ВСЕ ваши сеансы панели на всех устройствах, включая этот? Потребуется войти заново.'
    : `Завершить все сеансы супер-админа ${label} на всех устройствах? Ему придётся войти заново.`;
  if (!confirm(question)) return;
  if (!self && !(await reauthenticate(`завершить сеансы ${label}`))) return;
  try {
    await callSaasGateway('revokeAdminSessions', { uid, reason: reason || null }, { forceRefresh: !self });
    if (self) {
      toast('Все сеансы завершены — войдите заново');
      await signOut(state.auth);
    } else {
      toast('Сеансы завершены');
    }
  } catch (e) {
    toast(`Не удалось завершить сеансы: ${e?.message || e}`);
  }
}

/** Раздел «Безопасность» панели платформы: переключатель подразделов и их
 *  загрузка. */
function watchSecurity() {
  document.querySelectorAll('.sec-tab').forEach((el) => {
    el.onclick = () => {
      document.querySelectorAll('.sec-tab').forEach((b) => b.classList.toggle('active', b === el));
      document.querySelectorAll('.sec-pane').forEach((p) => p.classList.toggle('active', p.dataset.secPane === el.dataset.sec));
    };
  });
  watchSecurityAccess();
  watchSecurityJournal();
  let platformLoaded = false;
  document.querySelector('.sec-tab[data-sec="platform"]')?.addEventListener('click', () => {
    if (!platformLoaded) { platformLoaded = true; loadSecurityPlatform(); }
  });
  if ($('f-sec-platform-refresh')) $('f-sec-platform-refresh').onclick = () => loadSecurityPlatform();
  watchSecurityActivity();
  let devicesLoaded = false;
  document.querySelector('.sec-tab[data-sec="activity"]')?.addEventListener('click', () => {
    if (!devicesLoaded) { devicesLoaded = true; loadSecurityDevices(); }
  });
  if ($('f-sec-devices-all')) $('f-sec-devices-all').onchange = () => loadSecurityDevices();
  watchSecurityData();
}

const DATA_REQUEST_KIND_LABELS = { delete: 'Удалить данные', export: 'Выдать копию данных', correct: 'Исправить данные' };
const DATA_REQUEST_SUBJECT_LABELS = { guest: 'гость', owner: 'владелец заведения', other: 'другое лицо' };
const DATA_REQUEST_STATUS_LABELS = { new: 'новый', done: 'выполнен', rejected: 'отклонён' };

/** Название заведения/сети по id — для строк реестра и журнала удалений
 *  (одно чтение на id, дальше из кэша). */
const securityNameCache = new Map();
async function securityRootName(collectionName, id) {
  if (!id) return '';
  const key = `${collectionName}/${id}`;
  if (!securityNameCache.has(key)) {
    securityNameCache.set(key, getDoc(doc(state.db, collectionName, id))
      .then((d) => (d.exists() ? (d.data().name || d.data().slug || id) : id))
      .catch(() => id));
  }
  return securityNameCache.get(key);
}

/** Обезличить гостя (saas-gateway handleAnonymizeGuest) — только после
 *  ввода пароля. */
async function anonymizeGuest({ scope, id, clientUid, requestId, label }) {
  if (!confirm(`Обезличить гостя ${label || ''}? Имя, телефон и день рождения будут удалены из профиля и из броней, заказов и отзывов, бонусы сгорят, аккаунт гостя удалится. Отменить нельзя.`)) return;
  if (!(await reauthenticate('обезличить гостя'))) return;
  try {
    const r = (await callSaasGateway('anonymizeGuest', { scope, id, clientUid, requestId: requestId || null }, { forceRefresh: true })).data;
    toast(`Гость обезличен · очищено записей: ${r.scrubbedRecords}`);
  } catch (e) {
    toast(`Не удалось: ${e?.message || e}`);
  }
}

/** «Данные»: реестр запросов (dataRequests), поиск гостя по телефону и
 *  журнал удалений. */
function watchSecurityData() {
  const reqBox = $('sec-requests');
  const delBox = $('sec-deletions');

  sub(onSnapshot(query(collection(state.db, 'dataRequests'), orderBy('createdAt', 'desc'), limit(100)), async (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const now = Date.now();
    const html = await Promise.all(rows.map(async (r) => {
      const venue = r.chainId ? await securityRootName('chains', r.chainId) : r.tenantId ? await securityRootName('tenants', r.tenantId) : '';
      const due = r.dueAt?.toMillis ? r.dueAt.toMillis() : null;
      const overdue = r.status === 'new' && due && due < now;
      const canAnonymize = r.status === 'new' && r.kind === 'delete' && r.subjectType === 'guest' && r.clientUid;
      return `
        <div class="card sec-row${overdue ? ' sec-bad' : r.status === 'new' ? ' sec-warn' : ''}">
          <div class="grow" style="min-width:0">
            <div style="font-weight:600">${esc(DATA_REQUEST_KIND_LABELS[r.kind] || r.kind)} · ${esc(DATA_REQUEST_SUBJECT_LABELS[r.subjectType] || r.subjectType)}</div>
            <div class="small">${esc(r.contact || '—')}${r.guestName ? ` · ${esc(r.guestName)}` : ''}${venue ? ` · ${esc(venue)}` : ''}</div>
            <div class="small muted">${r.source === 'guest-web' ? 'из профиля гостя' : `заведён вручную${r.createdByEmail ? ` (${esc(r.createdByEmail)})` : ''}`} · ${fmtDateTime(r.createdAt)}${r.note ? ` · ${esc(r.note)}` : ''}</div>
            <div class="small ${overdue ? '' : 'muted'}">${r.status === 'new'
              ? `${overdue ? '<b style="color:var(--danger)">Просрочен</b> · ' : ''}ответить до ${due ? fmtMs(due) : '—'}`
              : `${esc(DATA_REQUEST_STATUS_LABELS[r.status] || r.status)} ${fmtDateTime(r.resolvedAt)}${r.resolution ? ` · ${esc(r.resolution)}` : ''}`}</div>
          </div>
          ${r.status === 'new' ? `
            <div class="row" style="flex-wrap:wrap;gap:6px;flex:none">
              ${canAnonymize ? `<button type="button" class="btn btn-ghost f-dr-anon" data-id="${esc(r.id)}" data-scope="${r.chainId ? 'chain' : 'tenant'}" data-root="${esc(r.chainId || r.tenantId)}" data-uid="${esc(r.clientUid)}" data-label="${esc(r.contact || '')}" style="width:auto">Обезличить гостя</button>` : ''}
              <button type="button" class="btn-link f-dr-resolve" data-id="${esc(r.id)}" data-status="done" style="width:auto">Выполнен</button>
              <button type="button" class="btn-link f-dr-resolve" data-id="${esc(r.id)}" data-status="rejected" style="width:auto;color:var(--danger)">Отклонить</button>
            </div>` : ''}
        </div>`;
    }));
    reqBox.innerHTML = html.join('') || '<p class="small muted">Запросов пока не было.</p>';
    reqBox.querySelectorAll('.f-dr-anon').forEach((el) => {
      el.onclick = () => anonymizeGuest({ scope: el.dataset.scope, id: el.dataset.root, clientUid: el.dataset.uid, requestId: el.dataset.id, label: el.dataset.label });
    });
    reqBox.querySelectorAll('.f-dr-resolve').forEach((el) => {
      el.onclick = async () => {
        const done = el.dataset.status === 'done';
        const resolution = prompt(done ? 'Что сделано (для истории):' : 'Причина отказа (для истории):', '');
        if (resolution === null) return;
        try {
          await callSaasGateway('resolveDataRequest', { id: el.dataset.id, status: el.dataset.status, resolution });
          toast(done ? 'Запрос отмечен выполненным' : 'Запрос отклонён');
        } catch (e) { toast(`Не удалось: ${e?.message || e}`); }
      };
    });
  }, () => { reqBox.innerHTML = '<p class="small muted">Реестр недоступен.</p>'; }));

  if ($('f-dr-create')) {
    $('f-dr-create').onclick = async () => {
      const errEl = $('f-dr-error');
      errEl.textContent = '';
      const contact = $('f-dr-contact').value.trim();
      if (!contact) { errEl.textContent = 'Укажите телефон или email'; return; }
      $('f-dr-create').disabled = true;
      try {
        await callSaasGateway('createDataRequest', {
          subjectType: $('f-dr-subject').value, kind: $('f-dr-kind').value, contact, note: $('f-dr-note').value.trim(),
        });
        $('f-dr-contact').value = ''; $('f-dr-note').value = '';
        toast('Запрос заведён');
      } catch (e) {
        errEl.textContent = e?.message || 'Не удалось';
      } finally {
        $('f-dr-create').disabled = false;
      }
    };
  }

  if ($('f-guest-find')) {
    $('f-guest-find').onclick = async () => {
      const box = $('sec-guest-found');
      box.innerHTML = '<div class="spinner"></div>';
      try {
        const r = (await callSaasGateway('findGuest', { phone: $('f-guest-phone').value })).data;
        box.innerHTML = r.matches.length ? r.matches.map((m) => `
          <div class="sec-row" style="padding:8px 0;border-top:1px solid var(--border)">
            <div class="grow" style="min-width:0">
              <div style="font-weight:600">${esc(m.guestName || 'Без имени')}${m.anonymized ? ' <span class="muted small">(уже обезличен)</span>' : ''}</div>
              <div class="small muted">${m.scope === 'chain' ? 'Сеть' : 'Заведение'} «${esc(m.name || m.id)}» · визитов: ${Number(m.visits) || 0}</div>
            </div>
            ${m.anonymized ? '' : `<button type="button" class="btn btn-ghost f-guest-anon" data-scope="${m.scope}" data-root="${esc(m.id)}" data-uid="${esc(m.clientUid)}" style="width:auto;flex:none">Обезличить</button>`}
          </div>`).join('') : `<p class="small muted">Гостя с номером ${esc(r.phone)} нет ни в одном заведении.</p>`;
        box.querySelectorAll('.f-guest-anon').forEach((el) => {
          el.onclick = () => anonymizeGuest({ scope: el.dataset.scope, id: el.dataset.root, clientUid: el.dataset.uid, label: r.phone });
        });
      } catch (e) {
        box.innerHTML = `<p class="small" style="color:var(--danger)">${esc(e?.message || String(e))}</p>`;
      }
    };
  }

  // Обезличивания, самоудаления гостей и удаления демо — из securityLog,
  // стирание заведений и сетей после льготного периода — из auditLogs
  // (их пишет ночная задача биллинга).
  let secDeletions = [];
  let auditDeletions = [];
  const drawDeletions = async () => {
    const rows = [
      ...secDeletions.map((e) => ({ at: e.createdAt, kind: e.action, e })),
      ...auditDeletions.map((e) => ({ at: e.createdAt, kind: e.action, e })),
    ].sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0)).slice(0, 100);
    const html = await Promise.all(rows.map(async ({ at, kind, e }) => {
      const m = e.metadata || {};
      let title = '';
      let detail = '';
      if (kind === 'guestAnonymized') {
        title = 'Гость обезличен';
        detail = `${m.phone || ''}${m.guestName ? ` · ${m.guestName}` : ''} · ${m.scope === 'chain' ? 'сеть' : 'заведение'} «${m.rootName || m.rootId || ''}» · очищено записей: ${m.scrubbedRecords ?? 0}`;
      } else if (kind === 'guestSelfDeleted') {
        title = 'Гость удалил свои данные сам';
        detail = `${m.scope === 'chain' ? 'сеть' : 'заведение'} «${m.rootName || m.rootId || ''}» · очищено записей: ${m.scrubbedRecords ?? 0}`;
      } else if (kind === 'demoTenantDeletedBySuperAdmin') {
        title = 'Удалено демо-заведение';
        detail = m.tenantName || e.tenantId || '';
      } else if (kind === 'tenantDataPurged') {
        title = 'Стёрты данные заведения (льготный период истёк)';
        detail = await securityRootName('tenants', e.tenantId);
      } else if (kind === 'chainDataPurged') {
        title = 'Стёрты данные сети (льготный период истёк)';
        detail = await securityRootName('chains', m.chainId);
      }
      return `
        <div class="card">
          <div class="row" style="justify-content:space-between;gap:10px;align-items:flex-start">
            <div class="grow" style="min-width:0">
              <div style="font-weight:600">${esc(title)}</div>
              <div class="small">${esc(detail)}</div>
              <div class="small muted">${esc(e.actorEmail || (e.actorId ? e.actorId : 'автоматически'))}</div>
            </div>
            <div class="small muted" style="flex:none">${fmtDateTime(at)}</div>
          </div>
        </div>`;
    }));
    delBox.innerHTML = html.join('') || '<p class="small muted">Удалений пока не было.</p>';
  };
  sub(onSnapshot(query(collection(state.db, 'securityLog'), where('action', 'in', ['guestAnonymized', 'guestSelfDeleted', 'demoTenantDeletedBySuperAdmin']), limit(100)), (snap) => {
    secDeletions = snap.docs.map((d) => d.data());
    drawDeletions();
  }, () => {}));
  sub(onSnapshot(query(collection(state.db, 'auditLogs'), where('action', 'in', ['tenantDataPurged', 'chainDataPurged']), limit(100)), (snap) => {
    auditDeletions = snap.docs.map((d) => d.data());
    drawDeletions();
  }, () => {}));
}

const SIGNUP_TYPE_LABELS = {
  tenant: 'заведение', chain: 'сеть', demo: 'демо',
  rateLimited: 'упор в лимит демо', blocked: 'отказ по блокировке',
};

/** Заблокировать IP / домен почты (saas-gateway handleBlockEntry). */
async function addBlockEntry(type, value, reason) {
  await callSaasGateway('blockEntry', { type, value, reason: reason || null });
}

/** «Активность»: регистрации по IP (signupEvents) и блок-лист (blocklist). */
function watchSecurityActivity() {
  const signupsBox = $('sec-signups');
  const blockBox = $('sec-blocklist');
  let blocked = [];
  let events = [];

  const drawSignups = () => {
    const now = Date.now();
    const byIp = new Map();
    events.forEach((e) => {
      const at = e.createdAt?.toMillis ? e.createdAt.toMillis() : now;
      const g = byIp.get(e.ip) || { ip: e.ip, day: 0, week: 0, types: new Set(), who: new Set(), last: 0 };
      g.week += 1;
      if (now - at < 86400000) g.day += 1;
      g.types.add(e.type);
      if (e.email) g.who.add(e.email);
      g.last = Math.max(g.last, at);
      byIp.set(e.ip, g);
    });
    const blockedIps = new Set(blocked.filter((b) => b.type === 'ip').map((b) => b.value));
    const rows = [...byIp.values()].map((g) => ({
      ...g, flag: g.day >= 3 || g.types.has('rateLimited') || g.types.has('blocked'),
    })).sort((a, b) => (b.flag - a.flag) || (b.day - a.day) || (b.week - a.week)).slice(0, 30);
    signupsBox.innerHTML = rows.length ? rows.map((g) => `
      <div class="card sec-row${g.flag ? ' sec-warn' : ''}">
        <div class="grow" style="min-width:0">
          <div style="font-weight:600">${esc(g.ip)}${blockedIps.has(g.ip) ? ' <span class="small" style="color:var(--danger)">заблокирован</span>' : ''}</div>
          <div class="small muted">За сутки: ${g.day} · за неделю: ${g.week} · ${[...g.types].map((t) => esc(SIGNUP_TYPE_LABELS[t] || t)).join(', ')}</div>
          ${g.who.size ? `<div class="small muted ellipsis">${[...g.who].slice(0, 3).map(esc).join(', ')}${g.who.size > 3 ? ` и ещё ${g.who.size - 3}` : ''}</div>` : ''}
          <div class="small muted">Последняя: ${fmtMs(g.last)}</div>
        </div>
        ${blockedIps.has(g.ip) ? '' : `<button type="button" class="btn btn-ghost f-sec-block-ip" data-ip="${esc(g.ip)}" style="width:auto;flex:none">Заблокировать IP</button>`}
      </div>`).join('') : '<p class="small muted">За неделю регистраций не было.</p>';
    signupsBox.querySelectorAll('.f-sec-block-ip').forEach((el) => {
      el.onclick = async () => {
        const reason = prompt(`Заблокировать регистрации с ${el.dataset.ip}? Причина (необязательно):`, 'массовые регистрации');
        if (reason === null) return;
        try { await addBlockEntry('ip', el.dataset.ip, reason); toast('IP заблокирован'); } catch (e) { toast(`Не удалось: ${e?.message || e}`); }
      };
    });
  };

  const since = Timestamp.fromMillis(Date.now() - 7 * 86400000);
  sub(onSnapshot(query(collection(state.db, 'signupEvents'), where('createdAt', '>=', since), orderBy('createdAt', 'desc'), limit(500)), (snap) => {
    events = snap.docs.map((d) => d.data());
    drawSignups();
  }, () => { signupsBox.innerHTML = '<p class="small muted">Недоступно.</p>'; }));

  sub(onSnapshot(collection(state.db, 'blocklist'), (snap) => {
    blocked = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    blockBox.innerHTML = blocked.length ? blocked.map((b) => `
      <div class="card sec-row">
        <div class="grow" style="min-width:0">
          <div style="font-weight:600">${b.type === 'ip' ? 'IP' : 'Почта @'}${esc(b.type === 'ip' ? ` ${b.value}` : b.value)}</div>
          <div class="small muted">${fmtDateTime(b.createdAt)} · ${esc(b.createdByEmail || '—')}${b.reason ? ` · ${esc(b.reason)}` : ''}</div>
        </div>
        <button type="button" class="btn-link f-sec-unblock" data-id="${esc(b.id)}" style="width:auto;flex:none">Снять</button>
      </div>`).join('') : '<p class="small muted">Блокировок нет.</p>';
    blockBox.querySelectorAll('.f-sec-unblock').forEach((el) => {
      el.onclick = async () => {
        if (!confirm('Снять блокировку?')) return;
        try { await callSaasGateway('unblockEntry', { id: el.dataset.id }); toast('Блокировка снята'); } catch (e) { toast(`Не удалось: ${e?.message || e}`); }
      };
    });
    drawSignups();
  }, () => { blockBox.innerHTML = ''; }));

  if ($('f-sec-block-add')) {
    $('f-sec-block-add').onclick = async () => {
      const errEl = $('f-sec-block-error');
      errEl.textContent = '';
      const value = $('f-sec-block-value').value.trim();
      if (!value) { errEl.textContent = 'Укажите IP-адрес или домен почты'; return; }
      $('f-sec-block-add').disabled = true;
      try {
        await addBlockEntry($('f-sec-block-type').value, value, $('f-sec-block-reason').value.trim());
        $('f-sec-block-value').value = '';
        $('f-sec-block-reason').value = '';
        toast('Заблокировано');
      } catch (e) {
        errEl.textContent = e?.message || 'Не удалось заблокировать';
      } finally {
        $('f-sec-block-add').disabled = false;
      }
    };
  }
}

/** Кассовые устройства с последней активностью (saas-gateway
 *  handleSecurityDevices). По умолчанию — только те, что 30+ дней не на
 *  связи, и отключённые. */
async function loadSecurityDevices() {
  const box = $('sec-devices');
  if (!box) return;
  box.innerHTML = '<div class="spinner"></div>';
  let devices;
  try {
    devices = (await callSaasGateway('securityDevices', {})).data.devices || [];
  } catch (e) {
    box.innerHTML = `<p class="small muted">Не удалось загрузить: ${esc(e?.message || String(e))}</p>`;
    return;
  }
  const STALE_MS = 30 * 86400000;
  const now = Date.now();
  const showAll = $('f-sec-devices-all')?.checked;
  const withFlags = devices.filter((d) => !d.demo).map((d) => ({
    ...d,
    disabled: d.status === 'disabled' || d.authDisabled,
    stale: !d.lastActiveAt || now - d.lastActiveAt >= STALE_MS,
  }));
  const shown = withFlags
    .filter((d) => showAll || d.disabled || d.stale)
    .sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0));
  const staleCount = withFlags.filter((d) => d.stale && !d.disabled).length;
  box.innerHTML = `<p class="small muted">Всего устройств: ${withFlags.length} · давно не на связи: ${staleCount}.</p>`
    + (shown.length ? shown.map((d) => `
      <div class="card sec-row${d.disabled ? '' : d.stale ? ' sec-warn' : ''}">
        <div class="grow" style="min-width:0">
          <div style="font-weight:600" class="ellipsis">${esc(d.tenantName || d.tenantId)}${d.tenantSlug ? ` <span class="muted small">(${esc(d.tenantSlug)})</span>` : ''}</div>
          <div class="small muted">${esc(d.deviceName || 'Касса')} · ${esc(d.platform || '—')} · подключено ${fmtMs(d.createdAt)}</div>
          <div class="small ${d.stale && !d.disabled ? '' : 'muted'}">Последняя активность: ${d.lastActiveAt ? fmtMs(d.lastActiveAt) : 'нет данных'}${d.disabled ? ' · <span style="color:var(--danger)">отключено</span>' : ''}</div>
        </div>
        <button type="button" class="btn btn-ghost f-sec-device" data-tenant="${esc(d.tenantId)}" data-uid="${esc(d.uid)}" data-enable="${d.disabled ? '1' : '0'}" style="width:auto;flex:none">
          ${d.disabled ? 'Включить' : 'Отключить'}</button>
      </div>`).join('') : '<p class="small muted">Все устройства на связи.</p>');
  box.querySelectorAll('.f-sec-device').forEach((el) => {
    el.onclick = async () => {
      const enable = el.dataset.enable === '1';
      let reason = null;
      if (!enable) {
        reason = prompt('Отключить устройство? Оно сразу потеряет доступ к данным заведения. Причина (необязательно):', 'давно не на связи');
        if (reason === null) return;
      } else if (!confirm('Включить устройство обратно?')) return;
      el.disabled = true;
      try {
        await callSaasGateway(enable ? 'enableDevice' : 'disableDevice', { tenantId: el.dataset.tenant, uid: el.dataset.uid, reason });
        toast(enable ? 'Устройство включено' : 'Устройство отключено');
      } catch (e) { toast(`Не удалось: ${e?.message || e}`); }
      loadSecurityDevices();
    };
  });
}

function fmtMs(ms) {
  return typeof ms === 'number' ? fmtDateTime(Timestamp.fromMillis(ms)) : '—';
}
function fmtBytes(n) {
  if (!(n > 0)) return '0 Б';
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}
/** Строка чек-листа: ok | warn | bad | unknown. */
function checkRowHtml(level, title, detail, actionsHtml = '') {
  const icon = { ok: '✅', warn: '⚠️', bad: '⛔', unknown: '❔' }[level] || '❔';
  const cls = level === 'warn' ? ' sec-warn' : level === 'bad' ? ' sec-bad' : '';
  return `
    <div class="card${cls}">
      <div class="row" style="align-items:flex-start;gap:10px">
        <div style="flex:none">${icon}</div>
        <div class="grow" style="min-width:0">
          <div style="font-weight:600">${esc(title)}</div>
          ${detail ? `<div class="small muted" style="margin-top:4px">${detail}</div>` : ''}
          ${actionsHtml ? `<div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px">${actionsHtml}</div>` : ''}
        </div>
      </div>
    </div>`;
}

/** «Платформа»: чек-лист состояния (см. handleSecurityStatus в
 *  saas-gateway). */
async function loadSecurityPlatform() {
  const box = $('sec-platform');
  if (!box) return;
  box.innerHTML = '<div class="spinner"></div>';
  let st;
  try {
    st = (await callSaasGateway('securityStatus', {})).data;
  } catch (e) {
    box.innerHTML = checkRowHtml('bad', 'Сервер платформы не ответил', esc(e?.message || String(e)));
    return;
  }
  const rows = [];
  const DAY = 86400000;

  // Правила базы
  if (st.rules?.status === 'ok') {
    rows.push(checkRowHtml('ok', 'Правила базы актуальны', `Включая защиту завершённых сеансов супер-админов${st.rules.updatedAt ? ` · опубликованы ${esc(new Date(st.rules.updatedAt).toLocaleString('ru-RU'))}` : ''}.`));
  } else if (st.rules?.status === 'outdated') {
    rows.push(checkRowHtml('bad', 'В базе старые правила доступа', 'Опубликуйте актуальные: <code>firebase deploy --only firestore:rules --project saas-3bdc8</code> — без этого часть защит панели не работает.'));
  } else {
    rows.push(checkRowHtml('unknown', 'Не удалось проверить правила базы',
      `Сервер не смог прочитать опубликованные правила (Firebase Rules API). Проверьте вручную, что выполнено <code>firebase deploy --only firestore:rules</code>.${st.rules?.error ? `<br><span class="muted">${esc(st.rules.error.slice(0, 160))}</span>` : ''}`));
  }

  // Секреты
  const missing = (st.secrets || []).filter((x) => !x.set);
  rows.push(checkRowHtml(missing.length ? 'bad' : 'ok',
    missing.length ? `Не заданы настройки сервера: ${missing.length}` : 'Все ключи и секреты сервера заданы',
    (st.secrets || []).map((x) => `${x.set ? '✓' : '✗'} ${esc(x.label)} <span class="muted">(${esc(x.key)})</span>`).join('<br>')
      + '<br>Значения не показываются — только есть они или нет. Задаются в <code>/etc/saas-gateway.env</code>.'));

  // Настоящий IP
  rows.push(st.realIpHeader
    ? checkRowHtml('ok', 'Сервер видит настоящие IP посетителей', 'nginx передаёт заголовок X-Real-IP — журнал входов и лимиты по IP работают.')
    : checkRowHtml('warn', 'nginx не передаёт настоящий IP', 'В журнале входов будет 127.0.0.1, а лимиты по IP сработают на всех сразу. Добавьте в <code>location /saas/</code>: <code>proxy_set_header X-Real-IP $remote_addr;</code>'));

  // Платёжный сервис: Робокасса (Result URL) или ЮKassa (webhook)
  const wh = st.billingWebhook || {};
  const whAge = wh.lastReceivedAt ? Date.now() - wh.lastReceivedAt : null;
  const rk = st.billingProvider === 'robokassa';
  const payName = rk ? 'Робокассы' : 'ЮKassa';
  const payHint = rk
    ? 'Если оплаты есть, а уведомлений нет — проверьте в «Технических настройках» Робокассы Result URL: <code>https://pii.zalpos.ru/saas/robokassaResult</code> (метод POST) и алгоритм подписи (ROBOKASSA_HASH на сервере).'
    : 'Если оплаты есть, а уведомлений нет — проверьте адрес уведомлений в кабинете ЮKassa: <code>https://pii.zalpos.ru/saas/billingWebhook</code>.';
  rows.push(checkRowHtml(
    !wh.lastReceivedAt ? 'unknown' : whAge > 45 * DAY ? 'warn' : 'ok',
    !wh.lastReceivedAt ? `Уведомлений от ${payName} ещё не было` : whAge > 45 * DAY ? `От ${payName} давно не было уведомлений` : `Уведомления об оплатах от ${payName} доходят`,
    `${wh.lastReceivedAt ? `Последнее: ${fmtMs(wh.lastReceivedAt)}${wh.lastEvent ? ` (${esc(wh.lastEvent)})` : ''}. ` : ''}${wh.lastPaymentAt ? `Последний платёж: ${fmtMs(wh.lastPaymentAt)}. ` : ''}`
      + payHint));
  if (rk && st.robokassaTest) {
    rows.push(checkRowHtml('warn', 'Робокасса в тестовом режиме',
      'Платежи тестовые, деньги не списываются. После активации магазина уберите <code>ROBOKASSA_TEST=1</code> и впишите боевые пароли №1 и №2 в <code>/etc/saas-gateway.env</code>.'));
  }

  // Сертификаты
  const c = st.certificates;
  if (!c) {
    rows.push(checkRowHtml('unknown', 'Сертификаты HTTPS ещё не проверялись', 'Первая проверка идёт через 5 минут после запуска сервера и дальше раз в сутки.',
      '<button type="button" class="btn btn-ghost f-sec-certs" style="width:auto">Проверить сейчас</button>'));
  } else {
    const problems = c.problems || [];
    const soon = c.soonest;
    rows.push(checkRowHtml(problems.length ? (problems.some((p) => p.error || p.daysLeft < 3) ? 'bad' : 'warn') : 'ok',
      problems.length ? `Проблемы с сертификатами HTTPS: ${problems.length} из ${c.total}` : `Сертификаты HTTPS в порядке (${c.total})`,
      `Проверено: ${fmtMs(c.checkedAt)}.${soon ? ` Ближайший срок: ${esc(soon.host)} — через ${soon.daysLeft} ${pluralDays(soon.daysLeft)}.` : ''}`
        + (problems.length ? '<br>' + problems.map((p) => `${esc(p.host)} — ${p.error ? esc(p.error) : `истекает через ${p.daysLeft} ${pluralDays(p.daysLeft)}`}`
          + (!String(p.host).startsWith('pii.') ? ` <button type="button" class="btn-link sec-inline-link f-sec-reprovision" data-host="${esc(p.host)}">выпустить заново</button>` : '')).join('<br>') : '')
        + '<br>certbot продлевает сертификаты сам; предупреждение значит, что продление не сработало.',
      '<button type="button" class="btn btn-ghost f-sec-certs" style="width:auto">Проверить сейчас</button>'));
  }

  // Резервные копии
  const b = st.backup || {};
  const set = st.backupSettings || {};
  const okAge = b.lastOkAt ? Date.now() - b.lastOkAt : null;
  const level = b.status === 'too_large' ? 'warn' : b.status === 'error' ? 'bad' : !b.lastOkAt ? 'warn' : okAge > 3 * DAY ? 'warn' : 'ok';
  const title = b.status === 'too_large' ? 'База слишком большая для бесплатной резервной копии'
    : b.status === 'error' ? 'Последняя резервная копия не удалась'
      : !b.lastOkAt ? 'Резервных копий базы ещё нет'
        : okAge > 3 * DAY ? 'Резервная копия давно не обновлялась' : 'Резервные копии базы делаются';
  const files = st.backups || [];
  rows.push(checkRowHtml(level, title,
    `${b.lastOkAt ? `Последняя удачная: ${fmtMs(b.lastOkAt)} · ${b.docs ?? '—'} документов · ${fmtBytes(b.bytes)}. ` : ''}`
      + `${b.error ? `${esc(b.error)}. ` : ''}`
      + `Автоматически раз в ${set.intervalHours || 24} ч, хранятся последние ${set.keep || 14}, лимит — ${set.maxDocs || 20000} документов (бесплатная квота чтений Firebase).`
      + '<br>Копии лежат на этом же сервере: если сервер пропадёт, пропадут и они — раз в неделю скачивайте свежую к себе. Восстановление — скрипт <code>restore-backup.js</code> (см. README сервера).'
      + (files.length ? '<br>' + files.slice(0, 5).map((f) => `${esc(f.name)} · ${fmtBytes(f.bytes)} <button type="button" class="btn-link sec-inline-link f-sec-backup-dl" data-name="${esc(f.name)}">скачать</button>`).join('<br>') : ''),
    '<button type="button" class="btn btn-ghost" id="f-sec-backup-now" style="width:auto">Сделать копию сейчас</button>'));

  // Супер-админы и сервер
  const n = st.superAdmins || 0;
  rows.push(checkRowHtml(n === 1 || n > 5 ? 'warn' : 'ok', `Супер-админов: ${n}`,
    n === 1 ? 'Назначьте второго доверенного человека, иначе при потере доступа восстановить панель будет некому.' : n > 5 ? 'Снимите тех, кому полный доступ больше не нужен.' : 'Подробности — в подразделе «Доступ».'));
  // Реквизиты для оферты/политики/подвала сайта
  const lg = st.legal || { missing: [], fields: {} };
  const lgMissing = (lg.missing || []).map((k) => (lg.fields || {})[k] || k);
  rows.push(checkRowHtml(lgMissing.length ? 'bad' : 'ok',
    lgMissing.length ? 'Не заполнены реквизиты для оферты и сайта' : 'Реквизиты платформы заполнены',
    lgMissing.length
      ? `Без них нельзя принимать оплату (модерация платёжного сервиса): в оферте и политике сейчас «[указать]». Не хватает: ${esc(lgMissing.join(', '))}.`
      : 'Подставляются в оферту, политику конфиденциальности и подвал сайта.',
    '<button type="button" class="btn btn-ghost" id="f-sec-legal-edit" style="width:auto">Реквизиты</button>'));
  rows.push('<div id="sec-legal-form" style="display:none"></div>');

  const g = st.gateway || {};
  rows.push(checkRowHtml('ok', 'Сервер платформы работает',
    `Без перезапуска: ${Math.floor((g.uptimeSec || 0) / 3600)} ч · Node ${esc(g.node || '—')} · сборки APK из ветки <code>${esc(st.githubRef || '—')}</code>.`));

  box.innerHTML = rows.join('');

  if ($('f-sec-legal-edit')) $('f-sec-legal-edit').onclick = async () => {
    const form = $('sec-legal-form');
    if (form.style.display !== 'none') { form.style.display = 'none'; return; }
    legalCache = null;
    const l = await loadPlatformLegal();
    const fields = lg.fields || {};
    form.innerHTML = `<div class="card">
      ${Object.entries(fields).map(([k, label]) => k === 'taxRegime' ? `
        <label class="field"><span>${esc(label)}</span>
          <select class="f-legal-input" data-key="taxRegime">
            <option value="" ${l.taxRegime !== 'npd' ? 'selected' : ''}>УСН / ОСН — кассовый чек по 54-ФЗ</option>
            <option value="npd" ${l.taxRegime === 'npd' ? 'selected' : ''}>Самозанятый (НПД) — чек из «Мой налог»</option>
          </select>
        </label>` : `
        <label class="field"><span>${esc(label)}${(['fullName', 'ogrnip', 'inn', 'address', 'email']).includes(k) ? ' *' : ''}</span>
          <input class="f-legal-input" data-key="${esc(k)}" value="${esc(l[k] || '')}" autocomplete="off">
        </label>`).join('')}
      <p class="small muted">Для ИП — ФИО полностью и ОГРНИП (15 цифр), для организации — название и ОГРН (13 цифр). Сохранение попросит пароль.</p>
      <button type="button" class="btn btn-primary" id="f-sec-legal-save" style="width:auto">Сохранить реквизиты</button>
    </div>`;
    form.style.display = '';
    $('f-sec-legal-save').onclick = async () => {
      if (!(await reauthenticate('изменить реквизиты платформы'))) return;
      const payload = {};
      form.querySelectorAll('.f-legal-input').forEach((el) => { payload[el.dataset.key] = el.value.trim(); });
      try {
        await callSaasGateway('savePlatformLegal', payload, { forceRefresh: true });
        legalCache = null;
        toast('Реквизиты сохранены');
        loadSecurityPlatform();
      } catch (e) {
        toast(`Не сохранено: ${e?.message || e}`);
      }
    };
  };

  box.querySelectorAll('.f-sec-certs').forEach((el) => {
    el.onclick = async () => {
      el.disabled = true; el.textContent = 'Проверяю…';
      try { await callSaasGateway('runCertificateCheck', {}); } catch (e) { toast(`Проверка не удалась: ${e?.message || e}`); }
      loadSecurityPlatform();
    };
  });
  box.querySelectorAll('.f-sec-reprovision').forEach((el) => {
    el.onclick = async () => {
      if (!confirm(`Выпустить сертификат для ${el.dataset.host} заново?`)) return;
      el.disabled = true;
      try {
        const r = await callSaasGateway('reprovisionDomain', { host: el.dataset.host });
        toast(r.data?.check?.error ? `Не помогло: ${r.data.check.error}` : 'Сертификат выпущен');
      } catch (e) { toast(`Не удалось: ${e?.message || e}`); }
      loadSecurityPlatform();
    };
  });
  if ($('f-sec-backup-now')) {
    $('f-sec-backup-now').onclick = async () => {
      const btn = $('f-sec-backup-now');
      btn.disabled = true; btn.textContent = 'Делаю копию…';
      try {
        const r = (await callSaasGateway('runBackup', {})).data;
        toast(r.status === 'ok' ? `Копия готова: ${r.docs} документов` : 'Копия не сделана — см. причину выше');
      } catch (e) { toast(`Копия не удалась: ${e?.message || e}`); }
      loadSecurityPlatform();
    };
  }
  box.querySelectorAll('.f-sec-backup-dl').forEach((el) => {
    el.onclick = () => downloadBackup(el.dataset.name);
  });
}

/** Скачивание копии базы — только после ввода пароля (на сервере
 *  requireRecentAuth), событие пишется в журнал безопасности. */
async function downloadBackup(name) {
  if (!(await reauthenticate(`скачать резервную копию ${name}`))) return;
  try {
    const idToken = await state.auth.currentUser.getIdToken(true);
    const res = await fetch(`${SAAS_GATEWAY_URL}/downloadBackup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw new Error(json?.error || `Сервис ответил ошибкой (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    toast(`Не удалось скачать: ${e?.message || e}`);
  }
}

/** Бэкап заведения или сети одним .json: все данные (меню, залы, чеки,
 *  гости, сотрудники, склад, настройки) в формате ночной копии базы —
 *  восстанавливается saas-gateway/restore-backup.js. Своё скачивает
 *  владелец; чужое — супер-админ, после ввода пароля. [unlimited] — из
 *  панели платформы, без предела числа документов. */
async function exportVenueBackup({ tenantId, chainId, fileKey, label, asAdmin = false, unlimited = false }) {
  if (asAdmin && !(await reauthenticate(`скачать бэкап «${label}»`))) return;
  toast('Собираем бэкап — это может занять до минуты…');
  try {
    const idToken = await state.auth.currentUser.getIdToken(asAdmin);
    const res = await fetch(`${SAAS_GATEWAY_URL}/exportBackup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ ...(chainId ? { chainId } : { tenantId }), ...(unlimited ? { unlimited: true } : {}) }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw new Error(json?.error || `Сервис ответил ошибкой (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const key = slugify(fileKey) || (chainId || tenantId);
    a.href = url;
    a.download = `zalpos-backup-${chainId ? 'set-' : ''}${key}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Бэкап скачан');
  } catch (e) {
    toast(`Не удалось скачать бэкап: ${e?.message || e}`);
  }
}

/** Поля тарифа по-человечески — для записей «Изменён тариф» в журнале. */
const PLAN_FIELD_LABELS = {
  name: 'название', priceRub: 'цена в месяц', priceRubSemiannual: 'цена за 6 мес',
  priceRubYearly: 'цена за год', priceRubAdditional: 'доп. точка в месяц',
  priceRubAdditionalSemiannual: 'доп. точка за 6 мес', priceRubAdditionalYearly: 'доп. точка за год',
  maxEmployees: 'сотрудников', maxDevices: 'устройств', maxTables: 'столов', maxStorageMb: 'хранилище, МБ',
  trialDays: 'дней пробного периода', isChainPlan: 'тариф сети', customAdditionalPrice: 'своя цена доп. точки',
  aiEnabled: 'ИИ', customBranding: 'свой брендинг', customDomain: 'свой домен',
};

/** Подписи событий журнала безопасности (securityLog, см.
 *  writeSecurityEvent в saas-gateway) и одна строка подробностей. */
const SECURITY_EVENT_LABELS = {
  superAdminGranted: 'Назначен супер-админ',
  superAdminRevoked: 'Снят супер-админ',
  adminSessionsRevoked: 'Завершены все сеансы',
  tenantSuspended: 'Заведение заблокировано',
  tenantEnabled: 'Заведение разблокировано',
  planChangedBySuperAdmin: 'Заведению сменён тариф',
  bonusPeriodGranted: 'Выданы бонусные дни',
  demoTenantDeletedBySuperAdmin: 'Удалено демо-заведение',
  subscriptionOverridden: 'Подписка изменена вручную',
  planCreated: 'Создан тариф',
  planUpdated: 'Изменён тариф',
  planDeleted: 'Удалён тариф',
  backupCreated: 'Сделана резервная копия',
  backupDownloaded: 'Скачана резервная копия базы',
  tenantBackupExported: 'Скачан бэкап заведения',
  chainBackupExported: 'Скачан бэкап сети',
  platformLegalUpdated: 'Изменены реквизиты платформы',
  domainReprovisioned: 'Сертификат поддомена выпущен заново',
  ipBlocked: 'Заблокирован IP',
  ipUnblocked: 'Снята блокировка IP',
  emailDomainBlocked: 'Заблокирован домен почты',
  emailDomainUnblocked: 'Снята блокировка домена почты',
  deviceDisabled: 'Отключено кассовое устройство',
  deviceEnabled: 'Включено кассовое устройство',
  dataRequestCreated: 'Заведён запрос о персональных данных',
  dataRequestDone: 'Запрос о персональных данных выполнен',
  dataRequestRejected: 'Запрос о персональных данных отклонён',
  guestLookup: 'Поиск гостя по телефону',
  guestAnonymized: 'Гость обезличен',
  guestSelfDeleted: 'Гость удалил свои данные',
};
function securityEventDetails(e) {
  const m = e.metadata || {};
  const tenant = m.tenantName ? `«${m.tenantName}»${m.tenantSlug ? ` (${m.tenantSlug})` : ''}` : '';
  const subLine = (x) => (x ? `${SUB_STATUS_LABELS[x.status] || x.status || '—'}${x.currentPeriodEnd ? `, оплачено до ${x.currentPeriodEnd}` : ''}${x.trialEndsAt ? `, пробный период до ${x.trialEndsAt}` : ''}` : '—');
  switch (e.action) {
    case 'superAdminGranted':
    case 'superAdminRevoked':
      return e.targetEmail || e.targetUid || '';
    case 'adminSessionsRevoked':
      return `${e.targetEmail || e.targetUid || ''}${m.reason === 'not-me' ? ' · «Это был не я»' : ''}`;
    case 'tenantSuspended':
      return `${tenant}${m.reason ? ` · причина: ${m.reason}` : ''}`;
    case 'planChangedBySuperAdmin':
      return `${tenant} · ${m.fromPlanId || '—'} → ${m.planId || '—'}`;
    case 'bonusPeriodGranted':
      return `${tenant} · +${m.days} ${pluralDays(Number(m.days) || 0)}${m.chainId ? ' (вся сеть)' : ''}`;
    case 'subscriptionOverridden':
      return `${tenant} · ${subLine(m.from)} → ${subLine(m.to)}`;
    case 'planCreated':
      return `${m.planName || m.planId || ''} (${m.planId || ''})`;
    case 'planUpdated': {
      const val = (v) => (v === true ? 'да' : v === false ? 'нет' : v ?? '—');
      const ch = Object.entries(m.changes || {}).map(([k, [a, b]]) => `${PLAN_FIELD_LABELS[k] || k}: ${val(a)} → ${val(b)}`);
      return `${m.planName || m.planId || ''}${ch.length ? ` · ${ch.slice(0, 6).join(', ')}${ch.length > 6 ? '…' : ''}` : ''}`;
    }
    case 'planDeleted':
      return `${m.planName || m.planId || ''}${m.wasInUse ? ' · был назначен заведениям' : ''}`;
    case 'backupCreated':
      return m.status === 'ok' ? `${m.file || ''} · ${m.docs ?? '—'} документов` : 'не сделана (база больше лимита)';
    case 'backupDownloaded':
      return m.file || '';
    case 'tenantBackupExported':
    case 'chainBackupExported':
      return `${m.name || ''} · ${m.docs ?? '—'} документов${m.bySuperAdmin ? ' · супер-админ' : ''}`;
    case 'domainReprovisioned':
      return m.host || '';
    case 'ipBlocked':
    case 'emailDomainBlocked':
      return `${m.value || ''}${m.reason ? ` · ${m.reason}` : ''}`;
    case 'ipUnblocked':
    case 'emailDomainUnblocked':
      return m.value || '';
    case 'dataRequestCreated':
    case 'dataRequestDone':
    case 'dataRequestRejected':
      return `${DATA_REQUEST_KIND_LABELS[m.kind] || m.kind || ''} · ${m.contact || ''}`;
    case 'guestLookup':
      return `${m.phone || ''} · найдено: ${m.found ?? 0}`;
    case 'guestAnonymized':
      return `${m.phone || ''}${m.guestName ? ` · ${m.guestName}` : ''} · «${m.rootName || m.rootId || ''}»`;
    case 'guestSelfDeleted':
      return `«${m.rootName || m.rootId || ''}» · очищено записей: ${m.scrubbedRecords ?? 0}`;
    case 'deviceDisabled':
    case 'deviceEnabled':
      return `${tenant}${m.deviceName ? ` · ${m.deviceName}` : ''}${m.reason ? ` · ${m.reason}` : ''}`;
    default:
      return tenant;
  }
}

/** «Журнал»: входы в панель (adminLogins) и опасные действия
 *  (securityLog). Оба пишет только saas-gateway, читает только супер-админ. */
function watchSecurityJournal() {
  const loginsBox = $('sec-logins');
  const eventsBox = $('sec-events');
  let myAuthTime = null;
  state.auth.currentUser?.getIdTokenResult().then((t) => {
    myAuthTime = Math.floor(new Date(t.authTime).getTime() / 1000);
  }).catch(() => {});

  sub(onSnapshot(query(collection(state.db, 'adminLogins'), orderBy('firstSeenAt', 'desc'), limit(30)), (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    loginsBox.innerHTML = rows.length ? rows.map((l) => {
      const mine = l.uid === state.uid;
      const current = mine && myAuthTime && l.authTime && Math.floor(l.authTime.toMillis() / 1000) === myAuthTime;
      const ips = (l.ips || [l.ip]).filter(Boolean);
      return `
        <div class="card sec-row${ips.length > 1 ? ' sec-warn' : ''}">
          <div class="grow" style="min-width:0">
            <div class="ellipsis" style="font-weight:600">${esc(l.email || l.uid)}${current ? ' <span class="muted small">(этот сеанс)</span>' : ''}</div>
            <div class="small muted">${fmtDateTime(l.firstSeenAt)} · ${esc(describeUserAgent(l.userAgent))} · ${l.signInProvider === 'password' ? 'по паролю' : l.signInProvider === 'emailLink' ? 'по ссылке из письма' : esc(l.signInProvider || '—')}</div>
            <div class="small muted">IP: ${esc(ips.join(', ') || '—')}${ips.length > 1 ? ' — IP менялся в течение сеанса' : ''} · активность до ${fmtDateTime(l.lastSeenAt)}</div>
          </div>
          ${current ? '' : `<button type="button" class="btn btn-ghost f-sec-not-me" data-uid="${esc(l.uid)}" data-label="${esc(l.email || l.uid)}" style="width:auto;flex:none">
            ${mine ? 'Это был не я' : 'Завершить сеансы'}</button>`}
        </div>`;
    }).join('') : '<p class="small muted">Входов пока не записано.</p>';
    loginsBox.querySelectorAll('.f-sec-not-me').forEach((el) => {
      el.onclick = () => revokeAdminSessions(el.dataset.uid, el.dataset.label, el.dataset.uid === state.uid ? 'not-me' : null);
    });
  }, () => { loginsBox.innerHTML = '<p class="small muted">Журнал входов недоступен.</p>'; }));

  sub(onSnapshot(query(collection(state.db, 'securityLog'), orderBy('createdAt', 'desc'), limit(50)), (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    eventsBox.innerHTML = rows.length ? rows.map((e) => `
      <div class="card">
        <div class="row" style="justify-content:space-between;gap:10px;align-items:flex-start">
          <div class="grow" style="min-width:0">
            <div style="font-weight:600">${esc(SECURITY_EVENT_LABELS[e.action] || e.action)}</div>
            <div class="small">${esc(securityEventDetails(e))}</div>
            <div class="small muted">${esc(e.actorEmail || e.actorId || 'система')} · IP ${esc(e.ip || '—')}</div>
          </div>
          <div class="small muted" style="flex:none">${fmtDateTime(e.createdAt)}</div>
        </div>
      </div>`).join('') : '<p class="small muted">Опасных действий пока не было.</p>';
  }, () => { eventsBox.innerHTML = '<p class="small muted">Журнал недоступен.</p>'; }));
}

// «Доступ»: супер-админы, их последний вход и «Выйти на всех устройствах».
function watchSecurityAccess() {
  const list = $('sec-access-list');
  const warnings = $('sec-access-warnings');
  sub(onSnapshot(collection(state.db, 'superAdmins'), (snap) => {
    const admins = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.id === state.uid ? -1 : b.id === state.uid ? 1 : String(a.email || '').localeCompare(String(b.email || ''))));
    const warn = [];
    if (admins.length === 1) {
      warn.push('Супер-админ один. Если он потеряет доступ к почте или паролю, восстановить панель будет некому — назначьте второго доверенного человека.');
    }
    if (admins.length > 5) {
      warn.push(`Супер-админов ${admins.length}. У каждого полный доступ ко всем заведениям и деньгам платформы — снимите тех, кому он больше не нужен.`);
    }
    warnings.innerHTML = warn.map((w) => `<div class="card sec-warn"><div class="small">⚠️ ${esc(w)}</div></div>`).join('');

    list.innerHTML = admins.map((a) => {
      const label = a.email || `без email · ${a.id.slice(-6).toUpperCase()}`;
      const self = a.id === state.uid;
      return `
        <div class="card sec-row">
          <div class="grow" style="min-width:0">
            <div class="ellipsis" style="font-weight:600">${esc(label)}${self ? ' <span class="muted small">(вы)</span>' : ''}</div>
            <div class="small muted">Назначен: ${a.grantedAt ? fmtDate(a.grantedAt) : esc(a.since || '—')}${a.grantedByEmail ? ` · ${esc(a.grantedByEmail)}` : ''}</div>
            <div class="small muted">Последний вход в панель: ${a.lastLoginAt
              ? `${fmtDateTime(a.lastLoginAt)} · ${esc(a.lastLoginIp || '—')} · ${esc(describeUserAgent(a.lastLoginUserAgent))}`
              : 'не записан'}</div>
            ${typeof a.sessionsValidAfter === 'number' ? `<div class="small muted">Сеансы завершались: ${fmtEpochSec(a.sessionsValidAfter)}</div>` : ''}
          </div>
          <button type="button" class="btn btn-ghost f-sec-revoke-sessions" data-uid="${esc(a.id)}" data-label="${esc(label)}" style="width:auto;flex:none">
            ${self ? 'Выйти на всех устройствах' : 'Завершить сеансы'}
          </button>
        </div>`;
    }).join('') || '<p class="small muted">Список пуст.</p>';

    list.querySelectorAll('.f-sec-revoke-sessions').forEach((el) => {
      el.onclick = () => revokeAdminSessions(el.dataset.uid, el.dataset.label);
    });
  }, () => {
    list.innerHTML = '<p class="small muted">Список недоступен.</p>';
  }));
}

// ---------- ПОДПИСКА И СБОРКА APK ----------

// Возвращает true/false: на онбординге нет f-checkout-error, и вызывающий
// сам говорит, что оплата не открылась. С chainId платит сеть — цену за
// число точек считает сервер.
async function startCheckout(tenantId, planId, billingPeriod, chainId, autoRenew = false) {
  const errEl = $('f-checkout-error');
  if (errEl) errEl.textContent = '';
  try {
    const res = await callSaasGateway('createCheckoutSession', {
      tenantId, chainId, planId,
      billingPeriod: billingPeriod === 'yearly' ? 'yearly' : billingPeriod === 'semiannual' ? 'semiannual' : 'monthly',
      // Согласие на автосписания — только галочкой владельца (по умолчанию снята).
      autoRenew,
      // Просто «куда вернуться»: статус обновит уведомление об оплате, оно
      // может прийти и позже возврата.
      returnUrl: `${location.origin}${location.pathname}#/`,
    });
    if (res.data?.confirmationUrl) {
      location.href = res.data.confirmationUrl;
      return true;
    }
    throw new Error('Платёжный сервис не вернул ссылку на оплату');
  } catch (e) {
    if (errEl) errEl.textContent = `Не удалось начать оплату: ${e?.message || e}`;
    return false;
  }
}

const BANK_INVOICE_STATUS_LABELS = { pending: 'ожидает оплаты', paid: 'оплачен', cancelled: 'отменён' };

/** Счёт на оплату для ИП или организации (оплата переводом): чек с ИНН
 *  плательщика формирует владелец платформы в «Мой налог» — Робокасса для
 *  самозанятых принимает только карты физических лиц и чек без ИНН. */
async function startBankInvoice(tenantId, planId, billingPeriod, chainId, payer, btn) {
  const errEl = $('f-checkout-error');
  if (errEl) errEl.textContent = '';
  if (btn) btn.disabled = true;
  try {
    const res = await callSaasGateway('createBankInvoice', {
      tenantId, chainId, planId,
      billingPeriod: billingPeriod === 'yearly' ? 'yearly' : billingPeriod === 'semiannual' ? 'semiannual' : 'monthly',
      payer,
    });
    if (!res.data?.id) throw new Error('сервер не вернул номер счёта');
    location.hash = `#/invoice/${res.data.id}`;
  } catch (e) {
    if (errEl) errEl.textContent = `Не удалось выставить счёт: ${e?.message || e}`;
    if (btn) btn.disabled = false;
  }
}

/** Счёт на оплату — печатная форма (кнопка «Печать / сохранить в PDF»). */
async function screenBankInvoice(id) {
  const el = screenEl();
  el.innerHTML = '<div class="spinner"></div>';
  let inv;
  let l;
  try {
    const [snap, legal] = await Promise.all([getDoc(doc(state.db, 'bankInvoices', id)), loadPlatformLegal()]);
    if (!snap.exists()) throw new Error('счёт не найден');
    inv = snap.data();
    l = legal || {};
  } catch (e) {
    el.innerHTML = `<p class="small" style="color:var(--danger)">Не удалось открыть счёт: ${esc(e?.message || e)}</p><p class="small"><a href="#/">← В личный кабинет</a></p>`;
    return;
  }
  const party = legalParty(l);
  const created = inv.createdAt?.toDate ? inv.createdAt.toDate() : new Date();
  const longDate = created.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const sum = Number(inv.amount || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const payer = inv.payer || {};
  const v = (x) => esc(x || '—');
  const npd = l.taxRegime === 'npd';
  const missing = !l.fullName || !l.bankAccount || !l.bik;
  el.innerHTML = `
    <div class="no-print row" style="gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <a class="btn btn-ghost" href="#/" style="width:auto">← В личный кабинет</a>
      <button class="btn btn-primary" id="f-invoice-print" style="width:auto" ${inv.status === 'cancelled' ? 'disabled' : ''}>Печать / сохранить в PDF</button>
    </div>
    ${inv.status === 'cancelled' ? '<p class="small no-print" style="color:var(--danger)">Счёт отменён — не оплачивайте его.</p>' : ''}
    ${inv.status === 'paid' ? '<p class="small no-print" style="color:var(--success)">Счёт оплачен, подписка продлена.</p>' : ''}
    ${missing ? '<p class="small no-print" style="color:var(--danger)">Реквизиты получателя ещё не заполнены — напишите в поддержку, прежде чем платить.</p>' : ''}
    <div class="invoice-doc">
      <h1>Счёт на оплату № ${esc(String(inv.number))} от ${esc(longDate)}</h1>
      <table>
        <tr><td>Получатель</td><td>${esc(party.full || '—')}${npd ? ', плательщик налога на профессиональный доход' : ''}<br>ИНН ${v(l.inn)}, ${party.isOrg ? 'ОГРН' : 'ОГРНИП'} ${v(l.ogrnip)}</td></tr>
        <tr><td>Банк получателя</td><td>${v(l.bankName)}<br>БИК ${v(l.bik)}, корр. счёт ${v(l.corrAccount)}</td></tr>
        <tr><td>Расчётный счёт</td><td>${v(l.bankAccount)}</td></tr>
        <tr><td>Плательщик</td><td>${v(payer.name)}<br>ИНН ${v(payer.inn)}${payer.kpp ? `, КПП ${esc(payer.kpp)}` : ''}</td></tr>
      </table>
      <table>
        <thead><tr><th>№</th><th>Наименование</th><th>Кол-во</th><th>Цена, ₽</th><th>Сумма, ₽</th></tr></thead>
        <tbody><tr><td>1</td><td>${esc(inv.title || '')}</td><td>1</td><td>${sum}</td><td>${sum}</td></tr></tbody>
      </table>
      <p class="invoice-total">Итого к оплате: ${sum} ₽. Без НДС${npd ? ' — получатель применяет налог на профессиональный доход и не является плательщиком НДС (ч. 8 ст. 2 Федерального закона № 422-ФЗ)' : ''}.</p>
      <p>Назначение платежа: <b>Оплата по счёту № ${esc(String(inv.number))} от ${esc(created.toLocaleDateString('ru-RU'))} за право использования ZalPOS. Без НДС.</b></p>
      <p class="invoice-note">Оплата по счёту означает согласие с публичной офертой https://zalpos.ru/#/legal/offer.
      Подписка продлевается после поступления денег на расчётный счёт получателя.
      ${npd ? `Чек с ИНН плательщика формируется в приложении «Мой налог» и направляется на email ${esc(inv.email || 'владельца кабинета')}; он же доступен в личном кабинете.` : 'Документы об оплате направляются на email владельца кабинета.'}
      Счёт действителен 10 банковских дней.</p>
    </div>
  `;
  $('f-invoice-print').onclick = () => window.print();
}

// Работающее заведение становится первой точкой новой сети вместе с гостями
// и бонусами. Обратно не разделить — об этом прямо спрашиваем.
async function convertTenantToChain(tenantId, tenant, planId) {
  const name = prompt('Название сети:', tenant?.name || '');
  if (!name || !name.trim()) return;
  const trimmedName = name.trim();
  let slug = prompt('Код сети (латиница, цифры, дефис):', slugify(trimmedName));
  if (slug === null) return;
  slug = slug.trim();
  if (!slug) { toast('Код сети не может быть пустым'); return; }
  if (!confirm(`Перевести «${tenant?.name || tenantId}» в сеть «${trimmedName}»? Заведение останется первой точкой сети со всеми гостями и бонусами — отменить это действие потом будет нельзя.`)) return;
  try {
    const res = await callSaasGateway('convertTenantToChain', { tenantId, name: trimmedName, slug, planId });
    // Членства не менялись, watchMemberships сам state.tenants не обновит.
    const entry = state.tenants.find((t) => t.id === tenantId);
    if (entry) {
      entry.chainId = res.data.chainId;
      entry.chainName = trimmedName;
    }
    toast('Заведение переведено в сеть');
    route();
  } catch (e) {
    toast(`Не удалось перевести в сеть: ${e?.message || e}`);
  }
}

// Новая точка сети. Подписка сети оплачена вперёд за точки на момент
// оплаты — за новую доплачивают цену доп. точки до конца оплаченного
// периода (сервер считает сумму сам: chainLocationQuote). В пробный период
// и для первой точки — бесплатно. Точку создаёт сервер после оплаты.
async function addChainLocation(chainId) {
  const name = prompt('Название новой точки сети:');
  if (!name || !name.trim()) return;
  const trimmedName = name.trim();
  let slug = prompt('Код точки (латиница, цифры, дефис) — используется в ссылках и как основа имени Android-приложения:', slugify(trimmedName));
  if (slug === null) return;
  slug = slug.trim();
  if (!slug) { toast('Код точки не может быть пустым'); return; }
  let quote;
  try {
    quote = (await callSaasGateway('chainLocationQuote', { chainId })).data;
  } catch (e) {
    toast(`Не удалось добавить точку сети: ${e?.message || e}`);
    return;
  }
  const rub = (v) => `${Number(v || 0).toLocaleString('ru-RU')} ₽`;
  const monthly = Number(quote.monthlyAdditional) || 0;
  const next = monthly > 0 ? ` Дальше точка входит в цену тарифа сети: +${rub(monthly)} в месяц.` : '';
  let question;
  if (quote.free) {
    question = {
      trial: `Точка «${trimmedName}» добавится бесплатно — идёт пробный период.${next}`,
      firstLocation: `Точка «${trimmedName}» — первая в сети, она входит в цену тарифа.`,
      periodEnds: `Точка «${trimmedName}» добавится без доплаты — оплаченный период заканчивается.${next}`,
      demo: `Точка «${trimmedName}» добавится в демо-сеть.`,
    }[quote.reason] || `Добавить точку «${trimmedName}»?`;
  } else {
    const until = quote.periodEnd ? new Date(quote.periodEnd).toLocaleDateString('ru-RU') : '';
    question = `Новая точка «${trimmedName}»: доплата ${rub(quote.amount)} — цена доп. точки за ${quote.remainingDays} дн. до конца оплаченного периода${until ? ` (до ${until})` : ''}.${next}\n\nТочка появится сразу после оплаты. Перейти к оплате?`;
  }
  if (!confirm(question)) return;
  try {
    const res = await callSaasGateway('chainLocationCheckout', {
      chainId, name: trimmedName, slug,
      returnUrl: `${location.origin}${location.pathname}#/`,
    });
    if (res.data?.created) {
      toast('Точка сети добавлена');
      state.activeTenantId = res.data.tenantId;
      route();
      return;
    }
    if (res.data?.confirmationUrl) {
      location.href = res.data.confirmationUrl;
      return;
    }
    throw new Error('Платёжный сервис не вернул ссылку на оплату');
  } catch (e) {
    toast(`Не удалось добавить точку сети: ${e?.message || e}`);
  }
}

async function requestBuild(tenantId) {
  const errEl = $('f-build-error');
  if (errEl) errEl.textContent = '';
  const btn = $('f-request-build');
  if (btn) btn.disabled = true;
  try {
    await callSaasGateway('createBuildJob', { tenantId });
    toast('Сборка запущена — обычно занимает 5–10 минут');
  } catch (e) {
    if (errEl) errEl.textContent = `Не удалось запустить сборку: ${e?.message || e}`;
    toast(`Не удалось запустить сборку: ${e?.message || e}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Общая касса для «Скачать» на лендинге — статика nginx на нашем сервере.
// Storage требует Blaze, а с GitHub Releases у части пользователей в России
// скачивание зависало.
const PUBLIC_APK_URL = 'https://pii.zalpos.ru/downloads/zalpos.apk';

function downloadPublicApk() {
  window.open(PUBLIC_APK_URL, '_blank', 'noopener');
}

// Демо приложения гостя — тот же сервер, отдаёт saas-gateway через nginx.
const GUEST_DEMO_APK_URL = 'https://pii.zalpos.ru/saas/guestDemoApk';

function downloadGuestDemoApk() {
  window.open(GUEST_DEMO_APK_URL, '_blank', 'noopener');
}

// Демо-касса для Windows — установщик setup.exe, тот же сервер.
const WINDOWS_DEMO_URL = 'https://pii.zalpos.ru/saas/windowsDemo';

function downloadWindowsDemo() {
  window.open(WINDOWS_DEMO_URL, '_blank', 'noopener');
}

/// Устройство посетителя — чтобы первой показать подходящую кассу.
function visitorPlatform() {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  return 'other';
}

/// Кнопка «Скачать демо-кассу» внизу страницы: сразу файл для этого
/// устройства, а с iPhone или Mac — к выбору платформы в блоке «Демо».
function downloadDemoForThisDevice() {
  const p = visitorPlatform();
  if (p === 'windows') return downloadWindowsDemo();
  if (p === 'android') return downloadPublicApk();
  $('landing-demo')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/// В блоке «Демо» касса для устройства посетителя идёт первой с пометкой,
/// а с iPhone и Mac — честная подсказка, где касса работает.
function suggestDemoPlatform() {
  const p = visitorPlatform();
  const card = document.querySelector(`.demo-dl[data-platform="${p}"]`);
  if (card) card.classList.add('is-suggested');
  const hint = $('landing-demo-hint');
  if (hint && (p === 'ios' || p === 'mac')) {
    hint.textContent = 'Касса работает на Android и Windows. Откройте эту страницу на планшете или компьютере, '
      + 'чтобы скачать её, а с iPhone гость пользуется веб-версией приложения по QR-коду на столе.';
    hint.hidden = false;
  }
}

// Сборку заведения отдаёт сервер по одноразовой ссылке на 60 секунд, её
// выдают только участнику заведения. Скачивание через fetch с заголовком
// Authorization на телефонах молча не срабатывало — поэтому новая вкладка.
// Открываем её сразу по нажатию: window.open после ожидания ссылки
// мобильные браузеры молча блокируют. Не открылась (встроенный браузер
// мессенджера) — скачиваем в этой же вкладке: сервер отдаёт файл как
// вложение, страница кабинета остаётся на месте.
async function downloadBuild(jobId) {
  let tab = null;
  try {
    tab = window.open('', '_blank');
    if (tab) {
      tab.opener = null;
      tab.document.title = 'ZalPOS';
      tab.document.body.textContent = 'Готовим файл…';
    }
  } catch (_) {}
  try {
    const { data } = await callSaasGateway('getDownloadUrl', { jobId });
    const url = `${SAAS_GATEWAY_URL}${data.url}`;
    if (tab && !tab.closed) tab.location.href = url;
    else window.location.href = url;
    toast('Скачивание началось — файл появится в «Загрузках»');
  } catch (e) {
    if (tab && !tab.closed) tab.close();
    toast(`Не удалось получить файл: ${e?.message || e}`);
  }
}
