// Личный кабинет владельца заведения и панель платформы ZalPOS.
// Без сборки: ES-модули Firebase прямо с CDN, конфиг Firebase берётся с
// хостинга (/__/firebase/init.json).

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signOut, sendEmailVerification,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  reauthenticateWithCredential, EmailAuthProvider, sendPasswordResetEmail,
  updatePassword, signInWithCustomToken,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
// Данные — Firestore или свой сервер платформы (zal-db.js решает по серверу).
import {
  openDb, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot,
  collection, query, where, orderBy, limit, Timestamp, deleteField, writeBatch,
} from './zal-db.js';

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

/** Справочник заведения в РФ (pii-gateway, vault.js) токеном владельца или
 *  администратора. Имён сотрудников в Firestore нет — только id; сами
 *  имена лежат здесь (так у всех заведений платформы). */
async function piiCall(body) {
  const idToken = await state.auth.currentUser?.getIdToken();
  let res;
  try {
    res = await fetch(PII_GATEWAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch (_) {
    throw new Error('Сервер данных в РФ недоступен — проверьте интернет и попробуйте ещё раз');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Сервер данных в РФ ответил ${res.status}`);
  return json;
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

/** Хэш PIN сотрудника — как PinHash в кассе (lib/utils/pin_hash.dart) и
 *  pinHashFor на сервере: PBKDF2-SHA256, 20 000 итераций, соль — заведение.
 *  Открытым текстом PIN в базу не пишем. */
async function hashEmployeePin(pin, tenantId) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`zalpos-pin:${tenantId}`), iterations: 20000 }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Telegram-бот заведения ----------
// Статус бота — один запрос на заведение, а не на каждую перерисовку.
const tgStatusCache = new Map();

function telegramBoxHtml(st) {
  if (!st) return '<div class="small muted">Проверяем…</div>';
  if (st.error) return `<div class="small" style="color:var(--danger)">${esc(st.error)}</div>`;
  const chain = st.chain;
  if (!st.configured) {
    return `
      <p class="small muted">Свой бот заведения: заказы с собой и доставки — в рабочую группу с кнопками статусов,
      владельцу — выручка, касса, средний чек, посадка, смена, брони, склад, неделя и топ продаж по кнопкам,
      начало и конец смен, отмены позиций, закрытие без оплаты и итоги каждое утро. Имена, телефоны и адреса
      гостей в Telegram не уходят. Управлять ботом смогут только те, чей Telegram ID вы впишете после подключения.</p>
      ${chain ? `<p class="small" style="margin:0 0 8px">Сеть «${esc(chain.name)}»: бот один на все точки (${chain.points.length}) —
      подключите его здесь, и он сразу покажет каждую точку и сводку по сети.</p>` : ''}
      <ol class="small muted" style="padding-left:18px;margin:8px 0">
        <li>В Telegram откройте <b>@BotFather</b> → <b>/newbot</b>, придумайте имя и адрес бота.</li>
        <li>Скопируйте токен (вида <code>123456:ABC…</code>) и вставьте сюда.</li>
      </ol>
      <label class="field"><span>Токен бота</span>
        <input id="f-tg-token" type="password" autocomplete="off" placeholder="123456789:AA…"></label>
      <button class="btn btn-primary" id="f-tg-setup">Подключить бота</button>
      <div id="f-tg-msg" class="small" style="margin-top:8px"></div>`;
  }
  const n = st.notify || {};
  const cb = (key, label) => `<label class="field-checkbox" style="display:flex;gap:8px;align-items:center;margin:4px 0">
    <input type="checkbox" class="f-tg-notify" data-key="${key}" style="width:auto" ${n[key] === false ? '' : 'checked'}> <span class="small">${label}</span></label>`;
  const allowed = st.allowed || [];
  const hasOwner = allowed.some((a) => a.role === 'owner');
  const ROLE = { owner: 'владелец или управляющий', staff: 'сотрудник — только кнопки заказов' };
  return `
    <div class="small">Бот: <b>@${esc(st.username)}</b> · токен хранится зашифрованным</div>
    ${chain ? `<div class="small" style="margin-top:8px;padding:8px 10px;border:1px solid var(--border);border-radius:10px">
      Бот сети «${esc(chain.name)}» — показывает все точки: ${esc(chain.points.join(', '))}.
      В Telegram кнопка «📍» сверху переключает точку или «Все точки» (сводка по сети).
      <span class="muted">Подключён в точке «${esc(chain.home)}»; список доступа и уведомления — общие для всей сети.</span>
      ${(chain.separate || []).length ? `<br><span class="muted">Пока со своим ботом: ${esc(chain.separate.join(', '))} — перевести на бот сети
      можно в кабинете этой точки (Настройки → Telegram-бот).</span>` : ''}</div>` : ''}
    ${st.chainBot ? `<div class="small" style="margin-top:8px;padding:8px 10px;border:1px solid var(--primary);background:var(--accent-soft);border-radius:10px">
      У сети «${esc(st.chainBot.name)}» есть общий бот <b>@${esc(st.chainBot.username)}</b> (подключён в точке «${esc(st.chainBot.home)}»):
      все точки в одном боте, переключение кнопкой «📍». Этот бот работает только для этой точки.
      <div style="margin-top:6px"><button class="btn btn-primary" id="f-tg-join" style="width:auto">Перейти на бот сети</button></div></div>` : ''}

    <div style="font-weight:600;margin:14px 0 4px">Кто управляет ботом</div>
    <p class="small muted" style="margin:0 0 8px">Отчёты, уведомления, подключение чатов и кнопки заказов — только для этих
      Telegram ID. Остальным бот ответит «Нет доступа», даже в рабочей группе. Свой ID узнаете, написав боту
      <b>/id</b> в Telegram.</p>
    ${allowed.length ? `<div style="margin-bottom:8px">${allowed.map((a, i) => `
      <div class="row" style="justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
        <span class="small"><b>${esc(a.name || 'Без подписи')}</b> · ID ${esc(String(a.id))}<br><span class="muted">${ROLE[a.role] || ROLE.owner}</span></span>
        <button class="btn-link f-tg-del" data-i="${i}" style="color:var(--danger)">Убрать</button>
      </div>`).join('')}</div>` : '<p class="small" style="color:var(--danger);margin:0 0 8px">Список пуст — сначала впишите свой Telegram ID.</p>'}
    <div class="row" style="flex-wrap:wrap;gap:8px;align-items:flex-end">
      <label class="field" style="flex:1 1 150px;min-width:0;margin:0"><span>Telegram ID</span>
        <input id="f-tg-uid" inputmode="numeric" autocomplete="off" maxlength="15" placeholder="123456789"></label>
      <label class="field" style="flex:2 1 190px;min-width:0;margin:0"><span>Подпись (без ФИО)</span>
        <input id="f-tg-uname" maxlength="40" placeholder="курьер 1"></label>
      <label class="field" style="flex:1 1 230px;min-width:0;margin:0"><span>Права</span>
        <select id="f-tg-urole">
          <option value="owner">Владелец / управляющий</option>
          <option value="staff">Сотрудник</option>
        </select></label>
      <button class="btn btn-ghost" id="f-tg-add" style="width:auto;flex:0 0 auto">Добавить</button>
    </div>
    <p class="small muted" style="margin:6px 0 0">Владелец и управляющий получают отчёты и уведомления: им достаточно открыть
      <b>@${esc(st.username)}</b> в Telegram и нажать «Запустить». Сотрудник — только нажимает кнопки заказов
      в рабочей группе.</p>

    <div class="small" style="margin-top:14px">Владелец: ${st.owners.length ? esc(st.owners.join(', ')) : '<span class="muted">не подключён</span>'}</div>
    <button class="btn btn-ghost" id="f-tg-owner" style="margin-top:6px" ${hasOwner ? '' : 'disabled'}>Подключить мой Telegram</button>
    <div class="small" style="margin-top:10px">${chain ? 'Рабочая группа этой точки' : 'Рабочая группа'}: ${st.staffChat
      ? `${esc(st.staffChat)}${st.staffChatShared ? ` <span class="muted">— общая: группа точки «${esc(chain ? chain.home : '')}»</span>` : ''}`
      : '<span class="muted">не подключена</span>'}</div>
    <button class="btn btn-ghost" id="f-tg-staff" style="margin-top:6px" ${hasOwner ? '' : 'disabled'}>${st.staffChatShared
      ? 'Подключить группу этой точки' : st.staffChat ? 'Сменить группу' : chain ? 'Подключить группу этой точки' : 'Подключить группу сотрудников'}</button>
    ${hasOwner ? '' : '<div class="small muted" style="margin-top:6px">Кнопки подключения заработают, когда в списке будет хотя бы один владелец или управляющий.</div>'}
    <div class="small muted" style="margin:10px 0 4px">Что присылать</div>
    ${cb('delivery', 'Заказы с собой и доставки — в группу, с кнопками')}
    ${cb('shifts', 'Начало и конец смен — владельцу')}
    ${cb('alerts', 'Отмены, закрытие без оплаты, возвраты, скидки от 20% — владельцу')}
    ${cb('summary', chain ? 'Итоги дня в 10:00 — по сети и каждой точке, владельцу' : 'Итоги смены в 10:00 — владельцу')}
    ${cb('stations', 'Группа с темами: новые позиции заказов — в «Кухню», «Бар» и «Кальяны»')}
    ${cb('groupCash', 'Группа с темами: итоги дня — и в «Касса и отчёты»')}
    <p class="small muted" style="margin:4px 0 0">Включите в настройках группы Telegram «Темы» — бот сам создаст разделы: кухня, бар, кальяны, доставки, самовывоз, касса — и разложит сообщения по ним.</p>
    <button class="btn btn-ghost" id="f-tg-unlink" style="margin-top:8px;color:var(--danger)">Отключить бота</button>
    <div id="f-tg-msg" class="small" style="margin-top:8px"></div>`;
}

function bindTelegramBox(tenantId, redraw) {
  const refresh = async () => {
    try {
      const r = await callSaasGateway('telegramStatus', { tenantId });
      tgStatusCache.set(tenantId, r.data);
    } catch (e) {
      tgStatusCache.set(tenantId, { error: e.message || 'Не удалось узнать статус бота' });
    }
    redraw();
  };
  if (!tgStatusCache.has(tenantId)) {
    tgStatusCache.set(tenantId, null);
    refresh();
    return;
  }
  const msg = (t, bad) => { const el = $('f-tg-msg'); if (el) { el.textContent = t; el.style.color = bad ? 'var(--danger)' : ''; } };
  // У сети бот и его настройки общие: другие точки перечитают статус, а не
  // отправят на сервер устаревший список доступа.
  const dropOtherPoints = () => {
    if (!(tgStatusCache.get(tenantId) || {}).chain) return;
    for (const k of [...tgStatusCache.keys()]) if (k !== tenantId) tgStatusCache.delete(k);
  };
  const openLink = async (kind, hint) => {
    // Окно — сразу по клику: после await браузер его заблокирует.
    const win = window.open('', '_blank');
    try {
      const r = await callSaasGateway('telegramLinkCode', { tenantId, kind });
      if (win) win.location = r.data.link; else location.href = r.data.link;
      msg(hint);
    } catch (e) {
      if (win) win.close();
      msg(e.message, true);
    }
  };
  if ($('f-tg-setup')) $('f-tg-setup').onclick = async () => {
    const token = ($('f-tg-token').value || '').trim();
    if (!token) return msg('Вставьте токен из @BotFather', true);
    $('f-tg-setup').disabled = true;
    try {
      await callSaasGateway('telegramSetup', { tenantId, token });
      $('f-tg-token').value = '';
      tgStatusCache.clear();
      redraw();
    } catch (e) {
      msg(e.message, true);
      $('f-tg-setup').disabled = false;
    }
  };
  if ($('f-tg-owner')) $('f-tg-owner').onclick = () => openLink('owner', 'Нажмите «Запустить» в Telegram — и вы подключены, если ваш Telegram ID в списке. Обновите страницу, чтобы увидеть.');
  if ($('f-tg-staff')) $('f-tg-staff').onclick = () => openLink('staff', 'Выберите рабочую группу в Telegram и добавьте бота — группа подключится сама. Добавлять бота должен человек из списка с правами владельца.');
  // Кто управляет ботом: список уходит на сервер целиком.
  const saveAccess = async (allowed, done) => {
    try {
      const r = await callSaasGateway('telegramAccess', { tenantId, allowed });
      dropOtherPoints();
      const st = tgStatusCache.get(tenantId);
      if (st) {
        st.allowed = r.data.allowed;
        st.owners = r.data.owners || [];
      }
      redraw();
      if (done) msg(done);
    } catch (e) {
      msg(e.message, true);
    }
  };
  if ($('f-tg-add')) $('f-tg-add').onclick = () => {
    const id = ($('f-tg-uid').value || '').replace(/\s+/g, '');
    if (!/^[1-9]\d{0,14}$/.test(id)) return msg('Telegram ID — это число. Напишите своему боту /id — он пришлёт его.', true);
    const st = tgStatusCache.get(tenantId) || {};
    const list = (st.allowed || []).filter((a) => String(a.id) !== id);
    list.push({ id, name: ($('f-tg-uname').value || '').trim(), role: $('f-tg-urole').value });
    saveAccess(list, 'Добавлено. Теперь этот человек может управлять ботом.');
  };
  document.querySelectorAll('.f-tg-del').forEach((el) => {
    el.onclick = () => {
      const st = tgStatusCache.get(tenantId) || {};
      const a = (st.allowed || [])[Number(el.dataset.i)];
      if (!a || !confirm(`Убрать ${a.name || 'ID ' + a.id} из списка? Бот перестанет его слушаться, отчёты приходить не будут.`)) return;
      saveAccess((st.allowed || []).filter((_, i) => i !== Number(el.dataset.i)), 'Убрано.');
    };
  });
  document.querySelectorAll('.f-tg-notify').forEach((el) => {
    el.onchange = async () => {
      const notify = {};
      document.querySelectorAll('.f-tg-notify').forEach((x) => { notify[x.dataset.key] = x.checked; });
      try {
        await callSaasGateway('telegramNotify', { tenantId, notify });
        dropOtherPoints();
        const st = tgStatusCache.get(tenantId);
        if (st) st.notify = notify;
      } catch (e) {
        el.checked = !el.checked;
        msg(e.message, true);
      }
    };
  });
  if ($('f-tg-join')) $('f-tg-join').onclick = async () => {
    const st = tgStatusCache.get(tenantId) || {};
    const cb = st.chainBot || {};
    if (!confirm(`Перевести точку на бот сети @${cb.username}? Этот бот (@${st.username}) отключится. `
      + 'Список «Кто управляет ботом» перенесётся в бот сети. Владельцу и управляющим — открыть бота сети и нажать «Запустить», '
      + 'рабочую группу точки — подключить заново кнопкой «Подключить группу этой точки».')) return;
    $('f-tg-join').disabled = true;
    try {
      await callSaasGateway('telegramJoinChain', { tenantId });
      tgStatusCache.clear();
      redraw();
    } catch (e) {
      msg(e.message, true);
      $('f-tg-join').disabled = false;
    }
  };
  if ($('f-tg-unlink')) $('f-tg-unlink').onclick = async () => {
    const st = tgStatusCache.get(tenantId) || {};
    if (!confirm(st.chain
      ? `Отключить бота всей сети «${st.chain.name}»? Уведомления и кнопки перестанут работать во всех точках.`
      : 'Отключить бота заведения? Уведомления и кнопки в Telegram перестанут работать.')) return;
    try {
      await callSaasGateway('telegramUnlink', { tenantId });
      // У сети бот общий — статус других точек тоже устарел.
      tgStatusCache.clear();
      redraw();
    } catch (e) {
      msg(e.message, true);
    }
  };
}

/** Вызов saas-gateway с ID-токеном пользователя. Бросает Error с текстом,
 *  который можно показать пользователю. */
/** Скачать файл (docx, csv), который сервер отдаёт по POST. */
async function downloadFromGateway(path, data, fallbackName) {
  const idToken = await state.auth.currentUser?.getIdToken();
  const res = await fetch(`${SAAS_GATEWAY_URL}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify(data || {}),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new Error(json?.error || `Сервис ответил ошибкой (${res.status})`);
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}

const prevMonthIso = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

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
  // 401 — токен устарел или отозван (например, сразу после того, как задали
  // пароль, или пароль сменили на другом устройстве): один раз повторяем со
  // свежим. Сервер отвечает 401 до любых изменений, так что повтор безопасен.
  // Пауза — отзыв считается по секундам: токен той же секунды тоже отозван.
  if (res.status === 401 && idToken && !forceRefresh) {
    await new Promise((r) => setTimeout(r, 1100));
    return callSaasGateway(path, data, { forceRefresh: true });
  }
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

// ---- Вложения обращений в поддержку: скриншоты и файлы. Лежат на сервере
// платформы (не в открытом доступе) — показываем, скачивая по входу.
const SUPPORT_MAX_FILES = 5;
const SUPPORT_MAX_BYTES = 15 * 1024 * 1024;
const SUPPORT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,video/mp4,application/zip,.zip,.docx,.xlsx,.txt,.pdf';
const SUPPORT_EXT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf',
  txt: 'text/plain', log: 'text/plain', mp4: 'video/mp4', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const supportFileType = (f) => {
  const byExt = SUPPORT_EXT_TYPES[String(f.name || '').split('.').pop().toLowerCase()] || '';
  return Object.values(SUPPORT_EXT_TYPES).includes(f.type) ? f.type : byExt;
};

const dropPreviews = (list) => list.forEach((a) => { if (a.preview) URL.revokeObjectURL(a.preview); });

/** Проверить и добавить выбранные или вставленные файлы в черновик. */
function addSupportFiles(list, files) {
  for (const f of Array.from(files || [])) {
    if (list.length >= SUPPORT_MAX_FILES) { toast(`Не больше ${SUPPORT_MAX_FILES} файлов в сообщении`); break; }
    const type = supportFileType(f);
    if (!type) { toast(`«${f.name}»: такой тип не принимаем — картинка, PDF, текст, Word, Excel, ZIP или MP4`); continue; }
    if (f.size > SUPPORT_MAX_BYTES) { toast(`«${f.name}» больше 15 МБ`); continue; }
    // Скриншот из буфера приходит как «image.png» — дадим понятное имя.
    const name = /^image\.(png|jpe?g)$/i.test(f.name || '') ? `скриншот-${new Date().toLocaleTimeString('ru-RU').replace(/:/g, '-')}.png` : (f.name || 'файл');
    list.push({ file: f, type, name, size: f.size, preview: type.startsWith('image/') ? URL.createObjectURL(f) : '' });
  }
}

function pendingFilesHtml(list, cls) {
  if (!list.length) return '';
  return `<div class="att-list">${list.map((a, i) => `
    <div class="att-pending">
      ${a.preview ? `<img src="${esc(a.preview)}" alt="">` : '<span class="att-ico">📄</span>'}
      <span class="att-name">${esc(a.name)}<small>${fmtBytes(a.size)}</small></span>
      <button type="button" class="att-rm ${cls}" data-i="${i}" aria-label="Убрать">×</button>
    </div>`).join('')}</div>`;
}

async function uploadSupportFiles(ticketId, list) {
  const token = await state.auth.currentUser?.getIdToken();
  const out = [];
  // Частями по 768 КБ: перед сервером стоит nginx, который большие тела режет.
  const CHUNK = 768 * 1024;
  for (const a of list) {
    const parts = Math.max(1, Math.ceil(a.file.size / CHUNK));
    const upload = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    let json = null;
    for (let i = 0; i < parts; i++) {
      const res = await fetch(`${SAAS_GATEWAY_URL}/supportUpload?ticketId=${encodeURIComponent(ticketId)}&name=${encodeURIComponent(a.name)}&upload=${upload}&part=${i}&parts=${parts}`, {
        method: 'POST', headers: { 'Content-Type': a.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: a.file.slice(i * CHUNK, (i + 1) * CHUNK),
      });
      json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`«${a.name}»: ${json?.error || (res.status === 413 ? 'файл слишком большой' : `ошибка ${res.status}`)}`);
    }
    out.push({ id: json.id, name: json.name, type: json.type, size: json.size });
  }
  return out;
}

const supportBlobs = new Map(); // `${ticketId}/${fileId}` -> objectURL
async function supportFileUrl(ticketId, fileId) {
  const key = `${ticketId}/${fileId}`;
  if (supportBlobs.has(key)) return supportBlobs.get(key);
  const token = await state.auth.currentUser?.getIdToken();
  const res = await fetch(`${SAAS_GATEWAY_URL}/supportFile?t=${encodeURIComponent(ticketId)}&f=${encodeURIComponent(fileId)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(res.status === 404 ? 'файл не найден' : `ошибка ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  supportBlobs.set(key, url);
  return url;
}

function attachmentsHtml(ticketId, list) {
  const files = (Array.isArray(list) ? list : []).filter((a) => a && a.id).slice(0, SUPPORT_MAX_FILES);
  if (!files.length) return '';
  return `<div class="att-list">${files.map((a) => (String(a.type || '').startsWith('image/')
    ? `<button type="button" class="att-thumb f-att" data-t="${esc(ticketId)}" data-f="${esc(a.id)}" data-name="${esc(a.name || '')}" title="${esc(a.name || '')}">
         <img data-att="${esc(ticketId)}|${esc(a.id)}" alt="${esc(a.name || 'скриншот')}"></button>`
    : `<button type="button" class="att-file f-att" data-t="${esc(ticketId)}" data-f="${esc(a.id)}" data-name="${esc(a.name || '')}" data-dl="1">
         <span class="att-ico">📄</span><span class="att-name">${esc(a.name || 'файл')}<small>${a.size ? fmtBytes(a.size) : ''}</small></span></button>`)).join('')}</div>`;
}

/** Подгрузить миниатюры и повесить открытие/скачивание. */
function bindAttachments(root) {
  root.querySelectorAll('img[data-att]').forEach((img) => {
    if (img.src) return;
    const [t, f] = img.dataset.att.split('|');
    supportFileUrl(t, f).then((url) => { img.src = url; }).catch(() => { img.alt = 'не загрузилось'; });
  });
  root.querySelectorAll('.f-att').forEach((el) => {
    el.onclick = async () => {
      try {
        const url = await supportFileUrl(el.dataset.t, el.dataset.f);
        if (el.dataset.dl) {
          const a = document.createElement('a');
          a.href = url; a.download = el.dataset.name || 'файл';
          document.body.appendChild(a); a.click(); a.remove();
        } else {
          window.open(url, '_blank', 'noopener');
        }
      } catch (e) {
        toast(`Не удалось открыть файл: ${e?.message || e}`);
      }
    };
  });
}

/** Кнопка «Прикрепить», выбор файлов и вставка скриншота (Ctrl+V) в поле. */
function bindAttachPicker({ button, input, pasteInto, list, redraw }) {
  if (button && input) {
    button.onclick = () => input.click();
    input.onchange = () => { addSupportFiles(list, input.files); input.value = ''; redraw(); };
  }
  if (pasteInto) {
    pasteInto.onpaste = (e) => {
      const files = Array.from(e.clipboardData?.files || []);
      if (!files.length) return;
      e.preventDefault();
      addSupportFiles(list, files);
      redraw();
    };
  }
}

// Текст объявления: ссылки кликабельны, переносы строк сохраняются
// (white-space: pre-line у контейнера). Ссылку ищем в исходном тексте и
// экранируем по частям — иначе «->» сразу за адресом попадал бы в ссылку.
const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'«»]+[^\s<>"'«».,;:!?)\]]/gi;
/** Текст с переносами и ссылками; bold — **жирное** из ответов поддержки. */
function richText(text, { bold = false } = {}) {
  const raw = String(text ?? '');
  const fmt = (part) => (bold ? esc(part).replace(/\*\*([^*\n]{1,200})\*\*/g, '<b>$1</b>') : esc(part));
  // Набрано одной строкой со стрелками «->» между пунктами (переносы
  // потерялись при вставке) — стрелка и есть перенос.
  const src = raw.includes('\n') ? raw : raw.replace(/\s+->\s+/g, '\n');
  let out = '';
  let last = 0;
  for (const m of src.matchAll(LINK_RE)) {
    const url = m[0];
    const href = /^https?:/i.test(url) ? url : `https://${url}`;
    out += fmt(src.slice(last, m.index)) +
      `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" class="rich-link">${esc(url)}</a>`;
    last = m.index + url.length;
  }
  out += fmt(src.slice(last));
  // «**zalpos.ru**» — жирная ссылка; оставшиеся «**» не показываем.
  return bold ? out.replace(/\*\*((?:(?!\*\*)[^\n]){1,200}?)\*\*/g, '<b>$1</b>').replace(/\*\*/g, '') : out;
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
  screenEl().classList.remove('partner-page');
}
function sub(off) { state.screenSubs.push(off); }

function pad(n) { return String(n).padStart(2, '0'); }
/** Ответ сервера → как из Firestore: { __ts: мс } — снова Timestamp
 *  (обращения поддержки хранятся на сервере, см. saas-gateway/local-db.js). */
function fromWire(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(fromWire);
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === '__ts' && typeof v.__ts === 'number') return Timestamp.fromMillis(v.__ts);
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = fromWire(x);
  return out;
}
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

// Кириллица → латиница (как в загранпаспорте, упрощённо): «Колибри» → kolibri.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .trim()
    .replace(/[а-яё]/g, (c) => TRANSLIT[c] ?? '')
    .replace(/[_.]+/g, '-')
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
  state.db = await openDb(app, { gateway: SAAS_GATEWAY_URL, auth: state.auth });

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

  // Открыли из Telegram и ещё не вошли — входим по подписи Telegram.
  if (!user && state.tgInit && !state.tgTried) {
    state.tgTried = true;
    telegramLogin();
  }
  if (!user) {
    state.uid = null;
    state.tenants = [];
    state.tenantsLoaded = false;
    state.activeTenantId = null;
    state.isSuperAdmin = false;
    state.partner = null;
    state.partnerChecked = false;
    route();
    return;
  }

  state.uid = user.uid;
  state.tenantsLoaded = false;
  state.partner = null;
  state.partnerChecked = false;
  route();
  watchMemberships();
  checkPartner().finally(() => {
    if (state.uid !== user.uid) return;
    state.partnerChecked = true;
    if (location.hash === '#/partner' || (state.tenantsLoaded && !state.tenants.length)) route();
  });

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
  '#/guide': () => screenPublicGuide(),
  '#/demo-photos': () => screenDemoPhotos(),
  '#/partner-terms': () => screenPartnerTerms(),
};

// Кнопка «Оплатить подписку» в кассе ведёт на #/billing: после входа кабинет
// откроется на вкладке «Оплата». Запоминаем в localStorage — вход по ссылке
// из письма возвращает на #/ и адрес теряет.
const PENDING_TAB_KEY = 'zalpos-pending-tab';

// ---------- ЧАТ ПОДДЕРЖКИ (круглая кнопка в углу) ----------
// Для посетителей сайта и вошедших без своего заведения (support-chat.js) —
// консультант по продукту и тарифам. В кабинете кнопки нет: там раздел
// «Поддержка». Модуль грузится отдельно и не задерживает первый экран.
let supportChat = null;
let supportChatLoading = null;
let supportChatCtx = { mode: 'hidden' };
function setSupportChat(ctx) {
  supportChatCtx = ctx;
  if (supportChat) { supportChat.setContext(ctx); return; }
  if (ctx.mode === 'hidden' || supportChatLoading) return;
  supportChatLoading = import('./support-chat.js').then((m) => {
    supportChat = m.mountSupportChat({
      gatewayUrl: SAAS_GATEWAY_URL,
      getToken: async () => (state.auth?.currentUser ? state.auth.currentUser.getIdToken() : null),
      consentEdition: LEGAL_EDITION,
    });
    supportChat.setContext(supportChatCtx);
  }).catch(() => { supportChatLoading = null; });
}
const SUPPORT_PAGE_NAMES = {
  '#/guide': 'Инструкция', '#/faq': 'Частые вопросы', '#/status': 'Статус сервиса', '#/demo-photos': 'Демо',
  '#/legal/offer': 'Оферта', '#/legal/privacy': 'Конфиденциальность', '#/legal/payment': 'Оплата и возврат',
  '#/legal/consent': 'Согласие', '#/login': 'Вход', '#/signup': 'Регистрация', '#/onboarding': 'Создание заведения',
};
/** Режим чата для текущей страницы; кабинет уточняет раздел сам (draw). */
function supportChatForRoute() {
  const h = location.hash;
  if (h === '#/admin' || h === '#/partner' || h.startsWith('#/invoice/') || h.startsWith('#/act/')) return setSupportChat({ mode: 'hidden' });
  const page = SUPPORT_PAGE_NAMES[h] || '';
  if (!state.uid) return setSupportChat({ mode: 'site', page: page || 'Главная' });
  if (!state.tenantsLoaded) return;
  // У кого есть заведение — поддержка в кабинете («Поддержка»), кнопка не нужна.
  if ((state.tenants || []).length || state.partner) return setSupportChat({ mode: 'hidden' });
  return setSupportChat({ mode: 'site', role: 'account', page: page || 'Создание заведения' });
}

function route() {
  queueMicrotask(supportChatForRoute);
  // Панель платформы уже открыта для этого входа: route() зовётся снова, пока
  // догружаются заведения, проверка менеджера и флаг платформы. Ничего не
  // пересобираем и не переподписываем — иначе 13 разделов грузятся заново,
  // телефон «замирает» на секунды, а накопленные нажатия срабатывают не там.
  if (keepAdminScreen()) {
    const link = $('admin-console-link');
    if (link) link.outerHTML = adminConsoleLinkHtml();
    return;
  }
  clearScreen();
  if (PUBLIC_ROUTES[location.hash]) {
    return PUBLIC_ROUTES[location.hash]();
  }
  if (location.hash === '#/billing' || location.hash === '#/support' || location.hash === '#/devices') {
    try { window.localStorage.setItem(PENDING_TAB_KEY, location.hash.slice(2)); } catch (_) {}
    if (!state.uid) {
      authMode = 'login';
      return screenAuth();
    }
    history.replaceState(null, '', location.pathname + '#/');
  }
  if (location.hash === '#/partner' && !state.uid && state.tgInit && !state.tgError) return screenLoading();
  if (location.hash === '#/partner' && !state.uid) {
    // Кабинет менеджера — после входа вернёмся сюда же.
    try { sessionStorage.setItem('zalpos-after-login', '#/partner'); } catch (_) {}
    authMode = 'login';
    return screenAuth();
  }
  if (state.uid) {
    let back = null;
    try { back = sessionStorage.getItem('zalpos-after-login'); sessionStorage.removeItem('zalpos-after-login'); } catch (_) {}
    if (back && location.hash !== back) { location.hash = back; return; }
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
  if (location.hash.startsWith('#/act/')) {
    return screenBankAct(location.hash.slice('#/act/'.length));
  }
  if (location.hash === '#/partner') {
    return state.partner ? screenPartner() : (state.partnerChecked ? screenNotPartner() : screenLoading());
  }
  // Менеджер без своего заведения: разделов владельца (создание заведения,
  // устройства, оплата) у него нет — только кабинет менеджера.
  if (state.partner && state.tenantsLoaded && !state.tenants.length && !state.isSuperAdmin) {
    if (location.hash !== '#/partner') history.replaceState(null, '', location.pathname + '#/partner');
    return screenPartner();
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
  // Менеджер без своего заведения — сразу в кабинет менеджера.
  if (state.partner && state.tenantsLoaded && !state.tenants.length) {
    return screenPartner();
  }
  return screenDashboardOrOnboarding();
}

function screenNotPartner() {
  screenEl().innerHTML = `<div class="brand">ZalPOS</div><h1>Кабинет менеджера</h1>
    <div class="card"><p class="small" style="margin:0">Этот аккаунт не подключён к партнёрской программе. Если вы менеджер ZalPOS — войдите под той почтой, на которую пришло письмо, или напишите администратору.</p></div>
    <p class="small center muted"><a href="#/">← На главную</a></p>`;
}

function screenDashboardOrOnboarding() {
  if (!state.tenantsLoaded) return screenLoading();
  // Без заведения — сначала узнаём, не менеджер ли это (иначе мелькнёт «Создайте заведение»).
  if (!state.tenants.length && !state.partnerChecked) return screenLoading();
  if (!state.tenants.length) return screenOnboarding();
  return screenDashboard();
}

window.addEventListener('hashchange', route);
captureTelegramApp();
capturePartnerRef();
boot();

// ---------- ЛЕНДИНГ ----------

// «Что внутри» на лендинге: шесть карточек, по-человечески, без списка из
// двадцати модулей. Подробности — в обзоре (#/guide), там всё с анимацией.
// Только то, что есть в любом тарифе (ИИ и приоритетная поддержка — в
// карточках тарифов).
const LANDING_FEATURES = [
  { icon: 'tablet', title: 'Зал, кухня и касса', desc: 'Схему зала рисуете прямо на планшете: стены, зоны, столы любой формы, у каждого свой таймер. Повар и бармен видят заказ на экране «Кухня и бар» или получают бумажный бегунок с пожеланиями гостя. Новый заказ звенит, пока его не примут, а «готово» вибрирует у официанта на телефоне или часах. Пропал интернет — касса работает дальше. Платить можно наличными, картой, через терминал любого банка, по QR СБП или частями, а в отчёте выручка разложена по банкам.' },
  { icon: 'phone', title: 'Приложение гостя', desc: 'Под вашим названием и логотипом, не под нашим. Гость сканирует QR на столе, смотрит меню с фото, заказывает, зовёт официанта, оставляет чаевые, копит бонусы и бронирует стол. Счёт оплачивает сам, по СБП или картой. На iPhone ничего ставить не нужно, всё открывается в браузере.' },
  { icon: 'box', title: 'Склад', desc: 'Продали пасту или лимонад, и продукты списались по граммовке. Уже в пятницу днём видно, чего не хватит к вечеру. Расхождения инвентаризация считает сама, а накладные ЕГАИС приходят через ваш УТМ.' },
  { icon: 'users', title: 'Смены и зарплата', desc: 'Приход и уход отмечаются на кассе, время берётся с сервера, а не с телефона сотрудника. Ставка за час или за смену, процент по роли и бонус, если заведение выполнило план по выручке. Любая ручная правка видна в отчёте, так что приписать себе пару часов не получится.' },
  { icon: 'gift', title: 'Гости возвращаются', desc: 'Кешбэк бонусами с уровнями, скидочные карты, сертификаты и новости в ленте приложения. После визита гость ставит оценку, а отзывы ниже четырёх звёзд собираются в отдельный список, чтобы вы успели перезвонить.' },
  { icon: 'chart', title: 'Вы в курсе с телефона', desc: 'Выручка за сегодня, кто на смене, недостача в кассе, продажи по сотрудникам и блюдам. Итоги дня и каждую отмену чека присылает Telegram-бот вашего заведения. Если точек несколько, они живут в одном кабинете, а бонусы гостей общие.' },
];

// ---- Тарифы: возможности, цены за период, карточки ----

// Что даёт тариф — как planCapabilities в saas-gateway: нет поля —
// возможность есть (старые тарифы до появления этих полей давали всё).
function planCaps(p) {
  return {
    guestApp: !p?.features || p.features.guestApp !== false,
    ai: p?.aiEnabled !== false,
    // Тариф ограничивает не сотрудников, а устройства с кассой: касса
    // сверх лимита не открывается (DeviceLimitGate), 0 — без ограничений.
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
    if (c.maxDevices) return 'Несколько точек в одном кабинете: общие бонусы гостей и одно приложение на всю сеть';
    return c.prioritySupport
      ? 'Сеть без ограничений по устройствам, с приоритетной поддержкой'
      : 'Сеть без ограничений по устройствам на каждой точке';
  }
  if (c.maxDevices && c.maxDevices <= 2) return 'Кофейня, бар или небольшой зал';
  if (c.maxDevices) return 'Кафе и ресторан с полной сменой';
  return 'Большой зал без ограничений по устройствам';
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
    { label: `Устройства с кассой${perPoint}`, value: c.maxDevices ? `до ${c.maxDevices}` : 'без ограничений', on: true },
    { label: 'Сотрудники', value: 'без ограничений', on: true },
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
  const trialDays = Number(p.trialDays) || 7;
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
    bag: svg('<path d="M5.5 8h13l-1 12.5h-11zM9 8V6.5a3 3 0 0 1 6 0V8"/>'),
    send: svg('<path d="M21 3.5 10.5 14M21 3.5l-6.5 17-4-6.5-6.5-4z"/>'),
    monitor: svg('<rect x="3" y="4" width="18" height="12.5" rx="1.8"/><path d="M9 20.5h6M12 16.5v4"/>'),
    chart: svg('<path d="M4 19.5h16"/><path d="M6.5 16V11M11 16V6.5M15.5 16v-3.5M20 16V8.5"/>'),
    lock: svg('<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
    server: svg('<rect x="4" y="4.5" width="16" height="6" rx="1.6"/><rect x="4" y="13.5" width="16" height="6" rx="1.6"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>'),
    receipt: svg('<path d="M6.5 3.5h11v17l-2.75-1.8-2.75 1.8-2.75-1.8-2.75 1.8z"/><path d="M9.5 8h5M9.5 11.5h5"/>'),
    cloud: svg('<path d="M7.5 18.5h9.5a3.75 3.75 0 0 0 .4-7.48A5.6 5.6 0 0 0 6.6 11a3.75 3.75 0 0 0 .9 7.5z"/>'),
    box: svg('<path d="M4 8 12 4l8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8"/>'),
    users: svg('<circle cx="9" cy="9" r="3.4"/><path d="M3 19c1.1-3 3.5-4.4 6-4.4s4.9 1.4 6 4.4M15.6 5.8a3.4 3.4 0 0 1 0 6.4M18 14.9c1.5.6 2.6 1.9 3.1 4.1"/>'),
    gift: svg('<rect x="4" y="9" width="16" height="11" rx="1.8"/><path d="M3.5 9h17M12 9v11M12 9c-1.6-3.6-5.7-3.6-5.7-1.2C6.3 9 9 9 12 9zm0 0c1.6-3.6 5.7-3.6 5.7-1.2C17.7 9 15 9 12 9z"/>'),
    play: svg('<path d="M8 5.5v13l10.5-6.5z"/>'),
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
// тарифа: «устройства без ограничений» — если ни у одного тарифа нет
// лимита устройств, и так далее.
function renderLandingFacts(plans, recommendedId, chainPlans) {
  const menu = $('landing-hero-menu');
  const cheapest = plans[0];
  const trials = plans.map((p) => Number(p.trialDays) || 7);
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
      ? `Меню, заказ со стола, бронь и бонусы под вашим логотипом. Входит в тариф «${first.name || first.id}» и старше.`
      : 'Меню, заказ со стола, брони и бонусы под вашим логотипом и в ваших цветах.';
  }
  const deliveryNote = $('delivery-plan-note');
  if (deliveryNote && plans.length && !all((p) => planCaps(p).guestApp)) {
    const first = plans.find((p) => planCaps(p).guestApp);
    deliveryNote.textContent = first
      ? `Доступно в тарифах с приложением гостя: «${first.name || first.id}» и старше.`
      : 'Работает в тарифах с приложением гостя.';
  }
  const whyPrice = $('why-price');
  if (whyPrice && plans.length) {
    const minTrial = Math.min(...trials);
    whyPrice.textContent = 'Фиксированная подписка: ни процента с выручки, ни платы за обновления. '
      + `${new Set(trials).size > 1 ? 'От ' : ''}${minTrial} ${pluralDays(minTrial)} бесплатно и без карты. Отключить можно в любой момент.`;
  }
  const chips = $('landing-pricing-chips');
  if (chips) {
    const items = [
      'Касса на Android и Windows', 'Карта зала и брони', 'Склад и техкарты',
      'Чеки через вашу ККТ АТОЛ', 'ЕГАИС через ваш УТМ', 'Бонусы, скидочные карты, сертификаты',
      'Смены и зарплата', 'Отчёты и кабинет владельца',
      ...(all((p) => planCaps(p).guestApp)
        ? ['Приложение гостя с вашим логотипом', 'Доставка и самовывоз из приложения', 'Онлайн-оплата гостей через ваш банк']
        : []),
      'Telegram-бот заведения',
      'Сотрудники без ограничений',
      ...(all((p) => planCaps(p).maxDevices === 0) ? ['Устройства без ограничений'] : []),
      'Обновления без доплаты', 'Без процента с продаж',
    ];
    chips.innerHTML = items.map((t) => `<li class="pricing-chip">${LI.check}${esc(t)}</li>`).join('');
  }

  // «Открываете вторую точку» — цена сети из настоящего тарифа.
  const scale = $('landing-scale-chain');
  const chain = (chainPlans || [])[0];
  if (scale && chain) {
    const first = Number(chain.priceRub) || 0;
    const next = planAdditionalPrice(chain, 'monthly');
    scale.textContent = `Тариф «${chain.name || chain.id}»: у каждой точки свой зал и персонал, а гости, бонусы и кабинет общие. `
      + (next && next !== first
        ? `Первая точка стоит ${rub(first)} в месяц, каждая следующая ${rub(next)}.`
        : `${rub(first)} в месяц за точку.`);
  }
}

// Точки под лентой карточек на телефоне (.m-swipe): сколько карточек и
// какая сейчас посередине. На широком экране точки скрыты стилями.
function bindSwipeDots(box) {
  if (!box) return;
  let dots = box.nextElementSibling;
  if (!dots || !dots.classList.contains('m-dots')) {
    dots = document.createElement('div');
    dots.className = 'm-dots';
    dots.setAttribute('aria-hidden', 'true');
    box.after(dots);
  }
  dots.innerHTML = [...box.children].map(() => '<i></i>').join('');
  // Карточки берём заново при каждом пересчёте: тарифы перерисовываются.
  const mark = () => {
    const cards = [...box.children];
    const mid = box.scrollLeft + box.clientWidth / 2;
    const dist = (c) => Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid);
    let best = 0;
    cards.forEach((c, i) => { if (dist(c) < dist(cards[best])) best = i; });
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === best));
  };
  if (!box.dataset.dots) {
    box.dataset.dots = '1';
    box.addEventListener('scroll', () => requestAnimationFrame(mark), { passive: true });
  }
  mark();
}

// На телефоне лента тарифов открывается на рекомендуемом.
function centerSwipeCard(box, card) {
  if (!box || !card || !window.matchMedia('(max-width: 719px)').matches) return;
  box.scrollLeft = card.offsetLeft - (box.clientWidth - card.offsetWidth) / 2;
}

function screenLanding() {
  let selectedPlanId = window.localStorage.getItem('selectedPlanId') || null;
  // Тёмно-синяя тема только у лендинга, кабинет остаётся в своей.
  screenEl().classList.add('landing');

  const LANDING_FAQ_PREVIEW = [FAQ_ITEMS[0], FAQ_ITEMS[4], FAQ_ITEMS[8], FAQ_ITEMS[6], FAQ_ITEMS[3]];

  screenEl().innerHTML = `
    <nav class="landing-nav">
      <div class="landing-inner landing-nav-inner">
        <a class="landing-logo" href="#/" aria-label="ZalPOS, на главную"><img class="landing-logo-icon" src="/icon-192.png" alt="" width="30" height="30">Zal<span>POS</span></a>
        <div class="landing-nav-links">
          <button type="button" data-scroll="landing-features">Возможности</button>
          <button type="button" data-scroll="landing-delivery">Доставка</button>
          <button type="button" data-scroll="landing-pricing">Тарифы</button>
          <button type="button" data-scroll="landing-demo">Демо</button>
          <a href="#/guide">Обзор</a>
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
          <h1>Касса, в&nbsp;которой персонал <em>разберётся за&nbsp;вечер</em></h1>
          <p class="landing-hero-lede">Зал, заказы, оплата, склад и зарплата на планшете или компьютере, который у вас
          уже есть. Гости заказывают со стола и домой через приложение с вашим логотипом и сами платят
          по СБП. Выручку и смену вы смотрите с телефона, откуда удобно.</p>

          <ul class="landing-hero-points">
            <li>${LI.check}<span>Кафе, бар, ресторан или кальянная: касса сама называет роли и кнопки так, как принято у вас</span></li>
            <li>${LI.check}<span>Приложение гостя входит в тариф: меню, заказ со стола, бонусы и бронь</span></li>
            <li>${LI.check}<span>Демо открывается за пару минут, без регистрации и звонка менеджера</span></li>
          </ul>
          <div class="row landing-hero-actions">
            <button class="btn btn-primary" id="f-landing-hero-cta">Попробовать бесплатно</button>
            <a class="btn-link l-arrow-link" href="#/guide" id="f-landing-hero-guide">${LI.play} Смотреть обзор</a>
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
          <h2 class="landing-h2">Пятница, девять вечера, все столы заняты</h2>
          <p class="landing-h2-sub">Гость за третьим столом нажимает «Позвать официанта», и стол тут же загорается
          на кассе. Бронь на восемь вечера сама встаёт на свободный стол. Никто не бегает по залу с блокнотом.</p>
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

    <section class="landing-section" id="landing-features">
      <div class="landing-inner">
        <div class="l-head l-head-row">
          <h2 class="landing-h2">Что внутри</h2>
          <p class="landing-h2-sub">Касса, зал, склад, смены и лояльность есть в любом тарифе. Модулей за отдельные
          деньги у нас нет и не будет.</p>
        </div>
        <div class="feature-grid m-swipe">
          ${LANDING_FEATURES.map((f) => `
            <div class="feature-card">
              <div class="feature-ico">${LI[f.icon] || ''}</div>
              <div class="feature-title">${esc(f.title)}</div>
              <div class="feature-desc">${esc(f.desc)}</div>
            </div>
          `).join('')}
        </div>
        <a class="l-more" href="#/guide"><span class="l-more-ico">${LI.play}</span><span><b>Посмотрите, как это выглядит в работе</b>
          <span>Обзор с анимацией: куда нажимать официанту, бармену и вам</span></span>${LI.arrow}</a>
      </div>
    </section>

    <section class="landing-section" id="landing-delivery">
      <div class="landing-inner">
        <div class="l-head l-head-row">
          <h2 class="landing-h2">Доставка и самовывоз — из&nbsp;вашего приложения</h2>
          <p class="landing-h2-sub">Гость заказывает домой или навынос, вы перезваниваете и&nbsp;подтверждаете, курьер везёт.
          Процент с&nbsp;заказов мы не&nbsp;берём, за&nbsp;онлайн-оплату платите только комиссию своему банку.
          <span id="delivery-plan-note"></span></p>
        </div>
        <div class="risk-grid m-swipe">
          <div class="risk-item"><b>Гость заказывает</b><span>В меню приложения выбирает доставку или «заберу сам», пишет адрес
            и&nbsp;телефон. Табак и&nbsp;алкоголь в&nbsp;такой заказ не&nbsp;попадут: продавать их дистанционно закон
            запрещает.</span></div>
          <div class="risk-item"><b>Вы подтверждаете</b><span>Заказ появляется на&nbsp;кассе с&nbsp;номером гостя. Перезвонили,
            сверили адрес, нажали «Подтвердить», и&nbsp;позиции уже в&nbsp;чеке и&nbsp;на&nbsp;кухне. Не&nbsp;дозвонились?
            Отклоните и&nbsp;укажите причину.</span></div>
          <div class="risk-item"><b>Гость платит и&nbsp;следит</b><span>После подтверждения он платит онлайн по&nbsp;СБП
            или картой, и&nbsp;деньги сразу приходят на&nbsp;ваш счёт. Статусы «Готовится», «У&nbsp;курьера», «Доставлен»
            видны ему в&nbsp;приложении.</span></div>
          <div class="risk-item"><b>Курьеры в&nbsp;Telegram</b><span>Бот вашего заведения присылает заказы в&nbsp;рабочую
            группу с&nbsp;кнопками статусов. Нажать их могут только люди, чей Telegram ID вы добавили в&nbsp;кабинете.
            Телефонов гостей в&nbsp;переписке нет.</span></div>
        </div>
        <div class="scale-strip">
          <div><b>Онлайн-оплата через ваш банк</b><span>Т-Банк, Сбербанк, Альфа-Банк, ВТБ, МТС Банк, Райффайзенбанк,
            Робокасса или другой банк на&nbsp;шлюзе RBS. Тот&nbsp;же банк показывает QR на&nbsp;экране кассы. Реквизиты
            вписываются в&nbsp;кассе, кнопка «Проверить» сразу скажет, подходят&nbsp;ли они.</span></div>
          <div><b>Тот же счёт за&nbsp;столом</b><span>Гость в&nbsp;зале тоже может заплатить сам, не&nbsp;дожидаясь официанта
            с&nbsp;терминалом. На&nbsp;кассе появится «Оплачено онлайн», сумма подставится сама.</span></div>
          <div><b>По&nbsp;закону</b><span>Чек по&nbsp;54-ФЗ пробивает ваша онлайн-касса. Имена, телефоны и&nbsp;адреса
            гостей хранятся в&nbsp;России, а&nbsp;через 30&nbsp;дней после заказа мы их обезличиваем.</span></div>
        </div>
        <a class="l-more" href="#/guide"><span class="l-more-ico">${LI.bag}</span><span><b>Как это выглядит у&nbsp;кассира и&nbsp;у&nbsp;гостя</b>
          <span>Обзор с&nbsp;анимацией: заказ, звонок, подтверждение, оплата</span></span>${LI.arrow}</a>
      </div>
    </section>

    <section class="landing-section landing-section-alt landing-pricing-section" id="landing-pricing">
      <div class="landing-inner">
        <div class="l-head l-head-center">
          <h2 class="landing-h2">Сколько стоит</h2>
          <p class="landing-h2-sub" id="landing-pricing-sub">Пробный период есть на любом тарифе, карта для него не нужна. Процент с продаж мы не берём.</p>
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
        <div id="landing-plans" class="landing-plans-grid m-swipe"><div class="spinner"></div></div>
        <div id="landing-chain-plans" class="landing-plans-grid m-swipe" style="display:none"></div>
        <div class="scale-strip">
          <div><b>Начните с небольшого</b><span>Когда команда вырастет, смените тариф в кабинете. Меню, зал, гости и история
            останутся на месте.</span></div>
          <div><b>Открываете вторую точку</b><span id="landing-scale-chain">Тариф «Сеть»: у каждой точки свой зал и персонал,
            а гости, бонусы и кабинет общие.</span></div>
          <div><b>Платите как удобно</b><span>Помесячно, за полгода или за год со скидкой. ИП и организации платят
            по счёту и получают чек со своим ИНН.</span></div>
        </div>
        <div class="pricing-included">
          <div class="pricing-included-title">Во всех тарифах</div>
          <ul class="pricing-chips" id="landing-pricing-chips"></ul>
        </div>
        <p class="pricing-note">Оплачивается отдельно и не нам: онлайн-касса и ОФД, если пробиваете фискальные чеки, эквайринг банка,
        а для продажи алкоголя ещё УТМ и электронная подпись.</p>
      </div>
    </section>

    <section class="landing-section" id="landing-demo">
      <div class="landing-inner">
        <div class="l-head l-head-row">
          <h2 class="landing-h2">Посмотрите сами, до&nbsp;регистрации</h2>
          <p class="landing-h2-sub">Скачайте кассу и нажмите «Демо». Откроется сеть из&nbsp;двух заведений с&nbsp;неделей
          истории: залы и&nbsp;брони, доставка на&nbsp;всех этапах, оплата онлайн, Яндекс&nbsp;Еда, экран кухни,
          модификаторы, отчёты и&nbsp;зарплата. Оставлять заявку и&nbsp;ждать звонка не&nbsp;придётся.</p>
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
        заведению — по&nbsp;коду из&nbsp;личного кабинета.</p>
      </div>
    </section>

    <section class="landing-section landing-section-alt" id="landing-why">
      <div class="landing-inner">
        <div class="l-head l-head-row">
          <h2 class="landing-h2">Почему ZalPOS</h2>
          <p class="landing-h2-sub">Мы убрали то, что обычно мешает начать: заявки на&nbsp;демо, платное внедрение
          и&nbsp;доплаты за&nbsp;модули.</p>
        </div>
        <div class="risk-grid why-grid m-swipe">
          <div class="risk-item"><b>Демо без заявки</b><span>Скачали кассу, нажали «Демо», и&nbsp;через пару минут вы
            в&nbsp;работающем заведении. Ни&nbsp;звонка менеджера, ни&nbsp;выезда специалиста.</span></div>
          <div class="risk-item"><b>Приложение гостя в&nbsp;цене</b><span id="why-guest-app">Меню, заказ со&nbsp;стола, бронь и&nbsp;бонусы
            под вашим логотипом. Оно входит в&nbsp;тариф, отдельно мы его не&nbsp;продаём.</span></div>
          <div class="risk-item"><b>Запуск за&nbsp;вечер</b><span>Касса ставится на&nbsp;ваш планшет или компьютер, меню и&nbsp;зал
            настраиваются в&nbsp;ней же. Если не&nbsp;понятно, куда нажать, откройте обзор: каждый шаг там показан анимацией.</span></div>
          <div class="risk-item"><b>Android и&nbsp;Windows вместе</b><span>Планшет в&nbsp;зале, телефон официанта
            и&nbsp;моноблок на&nbsp;баре работают в&nbsp;одной смене по&nbsp;одной подписке.</span></div>
          <div class="risk-item"><b>Данные под защитой</b><span>Каждое заведение видит только свои данные. Телефоны гостей
            хранятся в&nbsp;России, как требует 152-ФЗ. Оператор данных гостей у&nbsp;нас ZalPOS, поэтому вам не&nbsp;нужно
            подавать о&nbsp;них уведомления в&nbsp;Роскомнадзор. Резервную копию мы делаем каждый день.</span></div>
          <div class="risk-item"><b>Честная цена</b><span id="why-price">Фиксированная подписка: ни&nbsp;процента с&nbsp;выручки,
            ни&nbsp;платы за&nbsp;обновления. Отключить можно в&nbsp;кабинете в&nbsp;любой момент.</span></div>
        </div>
      </div>
    </section>

    <section class="landing-section" id="landing-faq">
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
        <h3>Первая смена в&nbsp;ZalPOS <em>уже сегодня</em></h3>
        <p>Регистрация по email, карта не нужна. А&nbsp;можно начать с&nbsp;демо: скачайте кассу, и&nbsp;через пару минут
        вы в&nbsp;работающем заведении.</p>
        <div class="landing-cta-buttons">
          <button class="btn" id="f-landing-cta-bottom">Попробовать бесплатно</button>
          <button class="btn landing-cta-ghost" id="f-landing-cta-demo">${LI.download} Скачать демо-кассу</button>
        </div>
      </div>
    </section>

    <footer class="landing-section landing-footer">
      <div class="landing-inner">
        ${siteFooterHtml()}
      </div>
    </footer>

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
  if ($('f-landing-cta-demo')) $('f-landing-cta-demo').onclick = downloadDemoForThisDevice;
  if ($('f-landing-download-windows')) $('f-landing-download-windows').onclick = downloadWindowsDemo;
  suggestDemoPlatform();

  startHallDemo();
  document.querySelectorAll('.wrap.landing .feature-grid.m-swipe, .wrap.landing .why-grid.m-swipe').forEach(bindSwipeDots);
  if ($('f-landing-nav-cta')) $('f-landing-nav-cta').onclick = scrollToEmail;

  document.querySelectorAll('.faq-item').forEach((el) => {
    el.querySelector('.faq-question')?.addEventListener('click', () => el.classList.toggle('open'));
  });


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
    centerSwipeCard(body, recommendedId ? body.querySelector(`[data-plan-card="${recommendedId}"]`) : null);
    bindSwipeDots(body);
    const chainBody = $('landing-chain-plans');
    if (chainBody) {
      chainBody.innerHTML = chainPlans.map((p) => planCardHtml(p, { period: landingPeriod, selected: p.id === selectedPlanId,
        priorityRow: chainPlans.some((x) => x.prioritySupport === true) })).join('');
      chainBody.classList.toggle('one', chainPlans.length === 1);
      if (chainBody.style.display !== 'none') bindSwipeDots(chainBody);
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
    renderLandingFacts(plans, recommendedId, chainPlans);
    const trial = [...new Set(plans.map((p) => Number(p.trialDays) || 7))];
    const subEl = $('landing-pricing-sub');
    if (subEl && !subEl.dataset.chain) {
      subEl.textContent = trial.length === 1
        ? `${trial[0]} ${pluralDays(trial[0])} бесплатно на любом тарифе, карта для этого не нужна. Процент с продаж мы не берём.`
        : 'Пробный период есть на любом тарифе, карта для него не нужна. Процент с продаж мы не берём.';
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
  const SINGLE_SUB_FALLBACK = 'Пробный период есть на любом тарифе, карта для него не нужна. Процент с продаж мы не берём.';
  const CHAIN_SUB = 'Для нескольких точек одного владельца. Кабинет, оплата и бонусы гостей общие, а точку гость выбирает в приложении.';
  const setMode = (mode) => {
    const toggle = $('landing-pricing-toggle');
    toggle?.querySelectorAll('.landing-pricing-toggle-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    [['landing-plans', 'single'], ['landing-chain-plans', 'chain']].forEach(([id, m]) => {
      const box = $(id);
      if (!box) return;
      box.style.display = mode === m ? '' : 'none';
      // Точки ленты на телефоне — вместе с ней.
      const dots = box.nextElementSibling;
      if (dots?.classList.contains('m-dots')) dots.style.display = mode === m ? '' : 'none';
      if (mode === m && m === 'chain') bindSwipeDots(box);
    });
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

// Подвал сайта — один и тот же на главной, в документах, статусе и FAQ:
// колонки «Продукт / Документы / Доверие» без подчёркнутых ссылок.
// Реквизиты Исполнителя (ИП, ИНН, ОГРНИП, email) — в оферте (раздел 14)
// и политике конфиденциальности; отдельной строкой их не дублируем.
function siteFooterHtml({ home = false, top: topHtml = '', extraDocs = '' } = {}) {
  const loggedIn = !!state.auth?.currentUser;
  const top = topHtml || (home
    ? `<a class="l-footer-back" href="#/">← На главную</a>`
    : loggedIn ? `<a class="l-footer-back" href="#/">В личный кабинет →</a>`
      : `<p class="small muted">Уже есть аккаунт? <a class="l-footer-back" href="#/login">Войти по паролю</a></p>`);
  return `
        <div class="l-footer-top">
          <a class="landing-logo" href="#/"><img class="landing-logo-icon" src="/icon-192.png" alt="" width="30" height="30" loading="lazy">Zal<span>POS</span></a>
          ${top}
        </div>
        <nav class="l-footer-cols" aria-label="Разделы сайта">
          <div><div class="l-footer-h">Продукт</div>
            <a href="/guide/">Инструкция</a><a href="/blog/">Блог</a><a href="/faq/">Частые вопросы</a><a href="#/status">Статус сервиса</a></div>
          <div><div class="l-footer-h">Документы</div>
            <a href="#/legal/offer">Оферта</a><a href="#/legal/payment">Оплата и возврат</a><a href="#/legal/privacy">Конфиденциальность</a>${extraDocs}</div>
          <div><div class="l-footer-h">Доверие</div>
            <span>Персональные данные первично записываются на сервер в России (152-ФЗ)</span><span>Реквизиты исполнителя — в оферте, раздел 14</span></div>
        </nav>
        <p class="small muted l-footer-pay">${PAYMENT_METHODS_TEXT}</p>`;
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
    : 'При оплате картой или через СБП формируется кассовый чек в соответствии с Федеральным законом № 54-ФЗ и направляется в электронной форме на email Заказчика. При оплате по счёту с расчётного счёта индивидуального предпринимателя или организации кассовый чек не применяется (п. 9 ст. 2 Федерального закона № 54-ФЗ): основанием для учёта служат счёт и акт, которые формируются в личном кабинете.';
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
        // Номер в реестре — только когда он есть: строка с прочерком
        // выглядела как недоделанная.
        ...(l.rknNumber ? [`Номер в реестре операторов персональных данных Роскомнадзора: ${v(l.rknNumber)}`] : []),
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
    <footer class="site-footer">${siteFooterHtml({ home: true })}</footer>
  `;
}

function legalSection(title, paragraphs) {
  return `<h2>${title}</h2>${paragraphs.map((p) => `<p class="small muted">${p}</p>`).join('')}`;
}

const LEGAL_EDITION = 'Редакция от 24 октября 2026 г.';

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
        'Порядок оказания услуги: доступ к Платформе в объёме оплаченного Тарифа открывается автоматически в личном кабинете на сайте https://zalpos.ru сразу после подтверждения оплаты платёжным сервисом; приложения скачиваются в личном кабинете. Материальные носители не передаются, доставка не осуществляется. Право использования считается предоставленным в момент открытия доступа.',
      ])}
    </div>
    <div class="card">
      ${legalSection('4. Пробный период', [
        'При первой регистрации предоставляется бесплатный пробный период, длительность которого указана в карточке Тарифа. Платёжные данные для пробного периода не требуются. По его окончании доступ приостанавливается до оплаты. Исполнитель вправе не предоставлять повторный пробный период тому же лицу или Заведению.',
      ])}
      ${legalSection('5. Стоимость, порядок оплаты и чеки', [
        `Стоимость указана в Тарифе в рублях РФ и опубликована на сайте https://zalpos.ru и в личном кабинете; оплата — авансом за месяц, полгода или год. Оплата принимается через платёжный сервис ${PAYMENT_SERVICE} банковскими картами «Мир», Visa, Mastercard, через Систему быстрых платежей и другими способами, доступными на странице оплаты. Данные карты вводятся на защищённой странице платёжного сервиса; Исполнитель их не получает и не хранит.`,
        'Индивидуальные предприниматели и юридические лица оплачивают по счёту, выставленному в личном кабинете, переводом с расчётного счёта; через платёжный сервис принимаются только платежи физических лиц. Оплата по счёту — авансовая; доступ продлевается после поступления денежных средств на расчётный счёт Исполнителя (обычно 1–3 рабочих дня). Счёт действителен 10 банковских дней.',
        '<span class="legal-receipt">Чек об оплате направляется в электронной форме на email Заказчика в порядке, установленном законодательством РФ.</span> При оплате картой или через СБП чек подтверждает оплату и предоставление доступа, акты не составляются. При оплате по счёту после поступления денежных средств Исполнитель формирует в личном кабинете акт о предоставлении права использования за оплаченный период; акт можно распечатать и подписать со стороны Заказчика. Если Заказчик в течение 5 рабочих дней со дня формирования акта не направил мотивированных возражений, право использования считается предоставленным надлежащим образом, а акт — принятым.',
        'Автопродление включается только отдельной отметкой Заказчика перед оплатой. При включённом автопродлении Заказчик поручает списывать оплату очередного периода по действующей цене Тарифа с карты, которой произведена оплата; автопродление отключается в личном кабинете в любой момент. Исполнитель вправе изменять стоимость Тарифов, уведомив Заказчика не менее чем за 30 дней; изменение не распространяется на оплаченный период.',
        'При неоплате очередного периода доступ ко всем приложениям Заведения приостанавливается; данные сохраняются 10 календарных дней, после чего могут быть удалены безвозвратно.',
      ])}
    </div>
    <div class="card">
      ${legalSection('6. Права и обязанности сторон', [
        'Исполнитель обязуется: обеспечивать работоспособность Платформы; заблаговременно сообщать о плановых работах; оказывать техническую поддержку в личном кабинете и по email; обеспечивать конфиденциальность и безопасность данных Заказчика.',
        'Заказчик обязуется: использовать Платформу по назначению и в соответствии с законодательством РФ; обеспечивать сохранность доступа к личному кабинету и кодов приглашения устройств; своевременно вносить оплату; соблюдать раздел 7 при работе с персональными данными Гостей и работников. Согласия Гостей Платформа получает от имени Исполнителя; согласия своих работников, когда они требуются законом, получает Заказчик.',
        'Заказчик самостоятельно отвечает за содержание меню, цен, акций, скидок, программы лояльности, публикаций и рассылок Заведения и их соответствие законодательству, в том числе Федеральному закону № 15-ФЗ (ограничения оборота табачной и никотинсодержащей продукции), Федеральному закону «О рекламе» (рассылки — только с предварительного согласия получателя) и Федеральному закону № 54-ФЗ. По умолчанию Платформа не применяет скидки и бонусы к позициям табачной и никотинсодержащей продукции; отключая это ограничение, Заказчик подтверждает, что такие позиции не содержат табака и никотина, и принимает ответственность на себя.',
        'Платформа не является контрольно-кассовой техникой. Для выдачи кассовых чеков Гостям Заказчик использует собственную зарегистрированную ККТ, договор с оператором фискальных данных и, при необходимости, договор эквайринга; Платформа обеспечивает техническое подключение к ним.',
      ])}
    </div>
    <div class="card">
      ${legalSection('7. Персональные данные', [
        '<b>7.1. Гости.</b> Оператором персональных данных Гостей, обрабатываемых в Платформе (имя, номер телефона, день и месяц рождения, адрес доставки, сведения о бронированиях, заказах, посещениях, бонусах и отзывах), является Исполнитель: он определяет цели обработки — предоставление Гостям бронирования, заказов, доставки и программы лояльности в заведениях, работающих на Платформе, — состав данных и действия с ними. Заказчик в отношении этих данных оператором не является и не обязан уведомлять Роскомнадзор об их обработке.',
        '<b>7.2. Поручение Заказчику.</b> Исполнитель поручает Заказчику (ч. 3 ст. 6 Федерального закона № 152-ФЗ) обработку персональных данных Гостей только в Платформе и только для обслуживания Гостей в Заведении: просмотр, запись, уточнение, использование (связь с Гостем по брони и заказу, выдача и доставка заказа, начисление и списание бонусов), удаление. Заказчик обязуется: допускать к данным только своих работников, которым они нужны для работы, под их личными PIN-кодами; соблюдать конфиденциальность и не передавать данные третьим лицам; не копировать и не выгружать их из Платформы и не использовать в других целях, в том числе для рекламных рассылок; вносить имена, телефоны и адреса Гостей только в Платформу (первичная запись — в базу данных на территории РФ, ч. 5 ст. 18 Федерального закона № 152-ФЗ); принимать меры по ст. 18.1 и 19 этого закона — ознакомить работников с требованиями к обработке персональных данных, не оставлять кассу без присмотра и не сообщать PIN-коды посторонним; не позднее 24 часов сообщать Исполнителю об инцидентах с данными и о запросах Гостей об их данных. Обрабатывая данные Гостей вне Платформы или в собственных целях, Заказчик становится их самостоятельным оператором и отвечает за такую обработку сам.',
        '<b>7.3. Работники.</b> Оператором персональных данных работников Заказчика (имя, должность, время смен, сведения для расчёта зарплаты, PIN-код в защищённом виде) является Заказчик как работодатель. Акцептуя оферту, Заказчик поручает Исполнителю их обработку (ч. 3 ст. 6 Федерального закона № 152-ФЗ) в целях исполнения договора: запись, систематизацию, накопление, хранение, уточнение, извлечение, использование, блокирование, удаление и уничтожение.',
        '<b>7.4. Обязанности Исполнителя.</b> Соблюдать конфиденциальность данных, принимать меры защиты по ст. 19 Федерального закона № 152-ФЗ, записывать имена, телефоны и адреса Гостей и имена работников первично в базу данных на территории РФ, уведомлять Заказчика об инцидентах с данными его работников не позднее 24 часов с момента выявления и по окончании договора удалять данные в сроки раздела 5.',
        '<b>7.5. Хранение только в РФ.</b> Имена, телефоны и адреса Гостей и имена работников всех Заведений хранятся только на сервере в РФ; в зарубежную облачную инфраструктуру, используемую для синхронизации устройств, передаются лишь обезличенные данные (меню, заказы, суммы, идентификаторы). Персональные данные Гостей и работников Заказчика за пределы РФ не передаются. Копии, сохранившиеся в зарубежной инфраструктуре с прежних версий Платформы, Исполнитель сам переносит в РФ и удаляет оттуда.',
        '<b>7.6. Роскомнадзор.</b> Об обработке персональных данных Гостей в Платформе Роскомнадзор уведомляет Исполнитель как их оператор. Использование Платформы не требует от Заказчика уведомления о трансграничной передаче: её нет. Обязанность работодателя уведомить Роскомнадзор об обработке персональных данных своих работников (ст. 22 Федерального закона № 152-ФЗ) существует у Заказчика независимо от использования Платформы; памятка с готовым текстом — в личном кабинете.',
        '<b>7.7. ИИ-помощники</b> подключаются Заказчиком по собственному желанию с ключом выбранного им провайдера ИИ; договор с провайдером заключает Заказчик. Исполнитель передаёт провайдеру только сведения, нужные для ответа, без телефонов и email Гостей; имена Гостей — первой буквой, работников — условными обозначениями.',
        'Обработка персональных данных самого Заказчика и его представителей осуществляется по Политике обработки персональных данных, опубликованной на сайте.',
      ])}
      ${legalSection('8. Интеллектуальная собственность и данные Заказчика', [
        'Исключительные права на Платформу, её программный код, интерфейс и обозначение ZalPOS принадлежат Исполнителю. Данные, внесённые Заказчиком (меню, склад, продажи, смены и т. д.), принадлежат Заказчику; Исполнитель использует их только для исполнения договора. До удаления данных Заказчик вправе запросить их выгрузку через поддержку — без персональных данных Гостей, которые обрабатываются по разделу 7.',
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
        'Если нужен чек на ИП или организацию (для учёта расходов), в личном кабинете выберите «ИП или организация», укажите название и ИНН и нажмите у нужного тарифа кнопку оплаты — появится счёт, его можно распечатать или сохранить в PDF. Оплатите его переводом с расчётного счёта; подписка продлится, когда деньги поступят, обычно через 1–3 рабочих дня. Отдельный договор подписывать не нужно: оплата счёта — согласие с публичной офертой (лицензионным договором), она и есть договор (п. 3 ст. 438 ГК РФ). После оплаты в личном кабинете у счёта появится акт для бухгалтерии.',
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
        'Деньги возвращаются при ошибочной или повторной оплате, если услуга не была оказана по нашей вине (пропорционально времени, когда программа была недоступна), и в других случаях, предусмотренных законодательством РФ. За неиспользованные дни оплаченного периода при добровольном отказе возврат не производится — подпиской можно пользоваться до конца оплаченного периода.',
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
        'Оператор — индивидуальный предприниматель, правообладатель Платформы ZalPOS (реквизиты — раздел 12). Оператор является оператором персональных данных пользователей личного кабинета и Гостей заведений, работающих на Платформе. Заведения обрабатывают данные Гостей по поручению Оператора — только в Платформе и только для обслуживания Гостей (бронь, заказ, доставка, бонусы).',
        'В отношении данных работников заведений оператором является заведение-работодатель (Заказчик), а Оператор обрабатывает их по его поручению на основании договора-оферты.',
      ])}
      ${legalSection('2. Субъекты и состав данных', [
        '<b>Пользователи личного кабинета</b> (владельцы и представители заведений): email, имя, роль, сведения об оплатах, журнал действий в кабинете; при оплате по счёту — ФИО индивидуального предпринимателя или наименование организации, ИНН и КПП плательщика.',
        '<b>Работники заведений</b>: имя, должность, PIN-код входа в кассу (в защищённом виде), время смен, сведения для расчёта зарплаты.',
        '<b>Гости заведений</b>: имя, номер телефона, день и месяц рождения (если Гость их укажет), адрес доставки, сведения о бронированиях, заказах, посещениях, бонусах и отзывах.',
        'Специальные категории и биометрические персональные данные не обрабатываются. Платформа не предназначена для сбора данных лиц младше 14 лет.',
      ])}
      ${legalSection('3. Цели обработки', [
        'Заключение и исполнение договора с Заказчиком; предоставление доступа к Платформе и техническая поддержка; предоставление Гостям бронирования, заказов, доставки и программы лояльности в заведениях на Платформе; ведение учёта смен и зарплаты работников по поручению заведений; направление сервисных уведомлений; исполнение требований законодательства, в том числе о бухгалтерском учёте, применении ККТ и налоге на профессиональный доход (чеки с ИНН покупателя).',
      ])}
      ${legalSection('4. Правовые основания', [
        'Согласие субъекта персональных данных; исполнение договора, стороной или выгодоприобретателем по которому является субъект (в том числе когда Гость сообщает телефон для брони или заказа по телефону); поручение оператора-работодателя по ч. 3 ст. 6 Федерального закона № 152-ФЗ — для данных работников; исполнение обязанностей, возложенных законодательством РФ.',
        'Гости дают Оператору согласие на обработку персональных данных отметкой в приложении или веб-версии заведения перед первой отправкой имени, телефона или адреса. Отметка с датой, редакцией текста, IP-адресом и сведениями о браузере хранится на сервере в РФ; при отзыве согласия IP-адрес и сведения о браузере удаляются.',
      ])}
    </div>
    <div class="card">
      ${legalSection('5. Порядок и условия обработки', [
        'Обработка ведётся с использованием средств автоматизации и включает сбор, запись, систематизацию, накопление, хранение, уточнение, извлечение, использование, передачу (предоставление, доступ), блокирование, удаление и уничтожение.',
        'Доступ к данным Гостей заведения имеют его работники в пределах назначенных ролей и только в Платформе — по поручению Оператора, с обязанностью соблюдать конфиденциальность и не использовать данные в других целях. Персонал Оператора получает доступ только для технической поддержки и в необходимом объёме. Данные разных заведений изолированы друг от друга.',
        'Данные не передаются третьим лицам, кроме случаев, предусмотренных законом, и поставщиков инфраструктуры, указанных в разделе 6, действующих на условиях конфиденциальности.',
        `При оплате тарифа email плательщика и сведения о платеже передаются платёжному сервису ${PAYMENT_SERVICE} для приёма оплаты и отправки чека; данные банковской карты вводятся на странице платёжного сервиса и Оператору не передаются. При оплате по счёту реквизиты плательщика используются для выставления счёта и формирования чека с ИНН покупателя в приложении «Мой налог» (сведения о чеке передаются в ФНС России в силу Федерального закона № 422-ФЗ).`,
        'Если заведение подключило ИИ-помощников, запросы к ним обрабатывает провайдер ИИ, выбранный заведением, по договору заведения с этим провайдером. Провайдеру передаются текст вопроса и сведения, нужные для ответа (меню, занятость столов, брони); имена гостей заменяются первой буквой, телефоны и email гостей не передаются. Гостям не следует сообщать в чате ИИ-помощника свои персональные данные.',
      ])}
      ${legalSection('6. Место хранения и трансграничная передача', [
        'Имена, телефоны и адреса Гостей, имена работников заведений, email пользователей личного кабинета, сведения о согласиях и реквизиты плательщиков по счёту первично записываются в базу данных на сервере Оператора, расположенном на территории Российской Федерации (ч. 5 ст. 18 Федерального закона № 152-ФЗ).',
        'Персональные данные Гостей и работников заведений хранятся только на этом сервере и за пределы РФ не передаются — у всех заведений на Платформе.',
        'Для синхронизации данных между устройствами, резервного копирования, авторизации пользователей и push-уведомлений используется облачная инфраструктура Google LLC: авторизация и push-уведомления — на серверах в США, хранение и синхронизация данных — в центрах обработки данных Google Cloud в Бельгии и Нидерландах. Данные заведений передаются туда только обезличенными — меню, заказы, суммы и идентификаторы без имён, телефонов и адресов.',
        'Обращения в техническую поддержку принимаются в личном кабинете и хранятся на сервере Оператора в РФ: до передачи сотрудникам поддержки (мессенджер Telegram) и ИИ-ассистенту поддержки из темы и текста обращения автоматически удаляются номера телефонов, адреса электронной почты, ИНН и другие номера, номера банковских карт, имена пользователей и фамилии, имена и отчества — дальше обрабатывается только обезличенный текст. Скриншоты и файлы обращений хранятся только на сервере в РФ и за её пределы не передаются; текст со скриншота распознаётся на этом сервере, обезличивается так же, как текст обращения, и только он передаётся ИИ-ассистенту и сотрудникам поддержки. Обращения в Telegram-бот поддержки не принимаются.',
        'Чат поддержки на сайте (кнопка в правом нижнем углу) работает и без входа в кабинет. Сообщения посетителя проходят через сервер Оператора в РФ и обезличиваются так же, как обращения из кабинета, до записи и до передачи ИИ-ассистенту и сотрудникам поддержки; указывать имя, телефон и другие контактные данные не нужно. Чтобы продолжить диалог, в браузере посетителя (localStorage) хранятся случайный ключ диалога и случайный ключ браузера; на сервере — только их хеши. По хешу ключа браузера сотрудники поддержки видят условный номер («Гость 4821»), чтобы не путать диалоги разных посетителей; имя, телефон и другие данные, позволяющие установить личность, для этого не используются. IP-адрес используется только для защиты от спама (ограничения частоты сообщений) и вместе с диалогом не сохраняется. Диалоги посетителей сайта удаляются автоматически через 30 дней. На вопросы отвечает ИИ-ассистент; по просьбе посетителя («оператор») подключается сотрудник поддержки.',
        'Трансграничная передача касается только пользователей личного кабинета: адрес электронной почты используется для входа через сервис авторизации Google LLC. Она осуществляется с согласия пользователя, данного при регистрации, и после уведомления Роскомнадзора в порядке ст. 12 Федерального закона № 152-ФЗ; получатель обеспечивает защиту данных (шифрование при хранении и передаче, сертификация ISO/IEC 27001, 27017, 27018).',
      ])}
      ${legalSection('6.1. Партнёрская программа', [
        'Менеджеры партнёрской программы ZalPOS могут направить владельцу заведения приглашение на почту — только если владелец дал менеджеру согласие на его получение (ст. 18 Федерального закона № 38-ФЗ «О рекламе»). Оператор обрабатывает адрес почты приглашённого, имя менеджера и отметку о согласии (дата, текст отметки) для отправки приглашения и учёта вознаграждения менеджера; эти данные хранятся только на сервере Оператора в РФ. В каждом письме есть ссылка отказа: после неё приглашения на этот адрес больше не направляются, а адрес хранится только в виде хеша для исполнения отказа. Приглашение действует 30 дней; после регистрации, отказа или окончания срока адрес в записи о приглашении заменяется скрытым (например, a***@mail.ru).',
        'Если владелец зарегистрировался по приглашению или по ссылке менеджера, менеджер видит только название заведения, тариф, даты и суммы оплат и своё вознаграждение — без адреса почты, телефона и других данных владельца. Для учёта перехода по ссылке менеджера в браузере (localStorage) на 30 дней сохраняется код ссылки.',
      ])}
      ${legalSection('7. Сроки обработки и хранения', [
        'Данные обрабатываются в течение срока действия договора с заведением и 10 календарных дней после его прекращения, после чего уничтожаются, если более длительный срок не требуется по закону. Данные, обработка которых прекращена по требованию субъекта, уничтожаются в течение 10 рабочих дней.',
      ])}
    </div>
    <div class="card">
      ${legalSection('8. Права субъекта персональных данных', [
        'Субъект вправе получать сведения об обработке своих данных, требовать их уточнения, блокирования или уничтожения, отозвать согласие, обжаловать действия Оператора в Роскомнадзоре или в суде (ст. 14 Федерального закона № 152-ФЗ).',
        'Гость может сам удалить свои данные кнопкой «Удалить мои данные» в профиле приложения или веб-версии заведения: имя, телефон и день рождения удаляются сразу, в том числе из базы на сервере в РФ, а накопленные бонусы аннулируются.',
        'Запросы направляются на email из раздела 12; ответ даётся в течение 10 рабочих дней. Гость может обратиться и в заведение — оно передаёт запрос Оператору не позднее 24 часов. Работники заведений по вопросам своих данных обращаются к работодателю.',
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
        '<span id="legal-requisites" data-kind="privacy">Индивидуальный предприниматель [ФИО полностью]. ОГРНИП: [указать]. ИНН: [указать]. Адрес: [указать]. Email для обращений по вопросам персональных данных: [указать].</span>',
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

// ---------------------------------------------------------------- Инструкция
// Текст — в guide.js, грузится при первом открытии: лендингу он не нужен.
// Одна разметка для вкладки кабинета и публичной страницы #/guide, ссылку
// на которую владелец отправляет сотрудникам.
const GUIDE_PUBLIC_URL = 'https://zalpos.ru/#/guide';
let guideData = null;
let guideScenes = null; // guide-scenes.js: живые иллюстрации «куда нажимать»
let guideLoadFailed = false;
let guidePromise = null;
const guideTexts = new Map(); // id статьи → текст для поиска

// Стили иллюстраций — отдельным файлом, лендинг их не грузит. Не
// загрузились — инструкция всё равно откроется, просто без анимаций.
function loadGuideCss() {
  if (document.getElementById('guide-css')) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.id = 'guide-css';
    link.rel = 'stylesheet';
    link.href = 'guide.css';
    link.onload = link.onerror = () => resolve();
    document.head.appendChild(link);
  });
}

function loadGuide() {
  if (!guidePromise) {
    guidePromise = Promise.all([
      import('./guide.js'),
      import('./guide-scenes.js').catch(() => null),
      loadGuideCss(),
    ]).then(([m, scenes]) => {
      guideData = m.GUIDE;
      guideScenes = scenes;
      guideLoadFailed = false;
      guideData.forEach((sec) => sec.items.forEach((it, i) => {
        guideTexts.set(`${sec.id}-${i}`, guideNorm([sec.title, it.title, it.where, it.intro,
          ...(it.steps || []), ...(it.tips || []), ...(it.faq || []).flat()].join(' ')));
      }));
      return guideData;
    }).catch((e) => { guidePromise = null; throw e; });
  }
  return guidePromise;
}

// Кнопки и разделы в тексте статьи — жирным вместо «ёлочек» (guide-scenes.js).
const guideUi = (s) => (guideScenes && guideScenes.uiText ? guideScenes.uiText(s) : esc(s));
const guideNorm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[ \s]+/g, ' ');

// «Кабинет · Устройства» — в кабинете это ещё и переход на вкладку.
function guideCabinetTab(where) {
  const m = /^Кабинет · ([^·]+?)(?: и | · |$)/.exec(where || '');
  return m ? DASHBOARD_NAV.find((t) => t.label === m[1].trim()) : null;
}

function guideBodyHtml(openSet, inCabinet) {
  const searchIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>';
  return `
    <div class="guide">
      <label class="guide-search">
        ${searchIcon}
        <input id="f-guide-search" type="search" placeholder="Найти: смена, возврат, бронь, QR-код…" autocomplete="off" aria-label="Поиск по инструкции">
      </label>
      <nav class="guide-chips" aria-label="Разделы инструкции">
        ${guideData.map((sec) => `<button type="button" class="guide-chip" data-guide-jump="${esc(sec.id)}">${esc(sec.title)}</button>`).join('')}
      </nav>
      <p class="guide-found small muted" id="guide-found" hidden></p>
      ${guideData.map((sec) => `
        <section class="guide-section" id="guide-${esc(sec.id)}" data-guide-section>
          <h3 class="guide-section-title">${esc(sec.title)}</h3>
          <p class="small muted guide-section-lead">${esc(sec.lead || '')}</p>
          <div class="guide-list">
            ${sec.items.map((it, i) => {
              const id = `${sec.id}-${i}`;
              const tab = inCabinet ? guideCabinetTab(it.where) : null;
              const scene = it.scene && guideScenes && guideScenes.hasScene(it.scene) ? it.scene : '';
              return `
                <details class="guide-item" data-guide-id="${esc(id)}"${openSet.has(id) ? ' open' : ''}>
                  <summary>
                    <span class="guide-item-head">
                      <span class="guide-item-title">${esc(it.title)}</span>
                      ${it.where ? `<span class="guide-where">${esc(it.where)}</span>` : ''}
                    </span>
                    <span class="guide-toggle" aria-hidden="true"></span>
                  </summary>
                  <div class="guide-item-body${scene ? ' has-scene' : ''}${scene && guideScenes.isWideScene(scene) ? ' wide' : ''}">
                    <div class="guide-text">
                      ${it.intro ? `<p class="guide-lede">${guideUi(it.intro)}</p>` : ''}
                      <ol class="guide-steps">${(it.steps || []).map((st) => `<li>${guideUi(st)}</li>`).join('')}</ol>
                      ${(it.tips || []).map((t) => `<p class="guide-tip">${guideUi(t)}</p>`).join('')}
                      ${(it.faq || []).length ? `<div class="guide-faq"><p class="guide-faq-title">Если что-то не так</p>
                        ${it.faq.map(([q, a]) => `<p class="guide-q">${guideUi(q)}</p><p class="guide-a">${guideUi(a)}</p>`).join('')}</div>` : ''}
                      ${tab ? `<button type="button" class="btn-link f-dash-tab guide-go" data-tab="${esc(tab.id)}">Открыть «${esc(tab.label)}» ${LI.arrow}</button>` : ''}
                    </div>
                    ${scene ? `<figure class="gx" data-scene="${esc(scene)}"></figure>` : ''}
                  </div>
                </details>`;
            }).join('')}
          </div>
        </section>
      `).join('')}
    </div>
  `;
}

// Поиск, с которым откроется инструкция (ссылка «Где взять ключ» и т. п.).
let guidePendingQuery = '';

function bindGuide(root, openSet) {
  const input = root.querySelector('#f-guide-search');
  const items = [...root.querySelectorAll('.guide-item')];
  const sections = [...root.querySelectorAll('[data-guide-section]')];
  const found = root.querySelector('#guide-found');
  const chips = root.querySelector('.guide-chips');
  let searching = false;

  // Иллюстрация живёт, только пока статья раскрыта.
  const scene = (el) => {
    const fig = el.querySelector('figure.gx');
    if (!fig || !guideScenes) return;
    if (el.open) guideScenes.mountScene(fig); else guideScenes.unmountScene(fig);
  };
  items.forEach((el) => {
    el.addEventListener('toggle', () => {
      scene(el);
      // Во время поиска статьи раскрывает сам поиск — это не выбор человека.
      if (searching) return;
      if (el.open) openSet.add(el.dataset.guideId); else openSet.delete(el.dataset.guideId);
    });
    if (el.open) scene(el);
  });
  root.querySelectorAll('[data-guide-jump]').forEach((btn) => {
    btn.onclick = () => document.getElementById(`guide-${btn.dataset.guideJump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const apply = () => {
    const words = guideNorm(input.value).trim().split(' ').filter(Boolean);
    searching = words.length > 0;
    let count = 0;
    items.forEach((el) => {
      const text = guideTexts.get(el.dataset.guideId) || '';
      const hit = !searching || words.every((w) => text.includes(w));
      el.hidden = !hit;
      if (hit && searching) count++;
      el.open = searching ? hit : openSet.has(el.dataset.guideId);
    });
    sections.forEach((sec) => { sec.hidden = !sec.querySelector('.guide-item:not([hidden])'); });
    chips.hidden = searching;
    found.hidden = !searching;
    found.textContent = !searching ? '' : count
      ? `Найдено: ${count} ${plural(count, 'статья', 'статьи', 'статей')}`
      : 'Ничего не нашлось — попробуйте другое слово, например «смена», «чек» или «склад».';
  };
  input.addEventListener('input', apply);
  if (guidePendingQuery) {
    input.value = guidePendingQuery;
    guidePendingQuery = '';
  }
  if (input.value) apply();
}

function screenPublicGuide() {
  const fill = () => {
    if (!guideData) return;
    const box = $('guide-public');
    if (!box) return;
    box.innerHTML = guideBodyHtml(new Set(), false);
    bindGuide(box, new Set());
  };
  screenEl().innerHTML = publicPageWrapHtml('Инструкция ZalPOS', `
    <p class="small muted guide-intro">Как настроить заведение и работать в кассе каждый день: касса, зал, меню, смены,
    оплата, брони, склад и кабинет владельца. Найдите нужное через поиск или выберите раздел.</p>
    <div id="guide-public"><div class="card"><div class="spinner"></div></div></div>
  `);
  if (guideData) fill();
  else loadGuide().then(fill).catch(() => {
    const box = $('guide-public');
    if (box) box.innerHTML = '<div class="card"><p class="small">Не удалось загрузить инструкцию — проверьте интернет и обновите страницу.</p></div>';
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
  // Пришли по приглашению менеджера — почта уже известна.
  if (authMode === 'signup' && partnerRefEmail() && $('f-email') && !$('f-email').value) $('f-email').value = partnerRefEmail();

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
        msgEl.textContent = 'Пока не подтверждено — проверьте почту (и папку «Спам»).';
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
    // Код вписали по-русски или с пробелами — приводим к латинице сами.
    const slug = slugify(slugEl.value);
    const chainName = chainNameEl.value.trim();
    const chainSlug = slugify(chainSlugEl.value);
    if (slug) slugEl.value = slug;
    if (chainSlug) chainSlugEl.value = chainSlug;
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
          { name: chainName, slug: chainSlug, ...(chosenPlanId ? { planId: chosenPlanId } : {}), ...partnerRefBody() }
        );
        chainId = chainRes.data.chainId;
        createdChainId = chainId;
      }
      const res = await callSaasGateway(
        'createTenant',
        {
          name, slug, venueType: $('f-venue-type').value,
          ...(chosenPlanId && !isChain ? { planId: chosenPlanId } : {}), ...(chainId ? { chainId } : {}), ...partnerRefBody(),
        }
      );
      forgetPartnerRef();
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
// Галочка согласия в «Поддержке»: отметили один раз — дальше стоит сама
// (каждое обращение всё равно хранит своё согласие с датой и редакцией).
const SUPPORT_CONSENT_KEY = 'zalpos-support-consent';
function supportConsentGiven() {
  try { return window.localStorage.getItem(SUPPORT_CONSENT_KEY) === LEGAL_EDITION; } catch (_) { return false; }
}
function rememberSupportConsent() {
  try { window.localStorage.setItem(SUPPORT_CONSENT_KEY, LEGAL_EDITION); } catch (_) {}
}

const FAQ_ITEMS = [
  { q: 'Что входит в пробный период?', a: 'Все функции выбранного тарифа. Оплата не запрашивается, пока пробный период не закончится, банковская карта не нужна. Срок указан в карточке тарифа. В пробный период тариф можно бесплатно поменять в разделе «Оплата», например чтобы попробовать тариф с ИИ-помощником.' },
  { q: 'Что будет, если не оплатить вовремя?', a: 'Касса и приложение на всех устройствах заведения блокируются сразу после окончания оплаченного периода. Данные при этом хранятся ещё 10 дней: оплатите за это время, и всё вернётся как было. Потом данные удаляются безвозвратно.' },
  { q: 'Как подключить планшет на кассе?', a: 'В кабинете откройте «Устройства» и нажмите «Собрать APK». Через несколько минут появится касса, собранная именно для вашего заведения. Скачайте её на планшет и откройте: она подключится сама, коды вводить не нужно. Если вы ставили общую демо-кассу, нажмите в ней «Присоединить планшет к заведению» и введите код заведения и код приглашения из того же раздела.' },
  { q: 'Можно ли сменить тариф позже?', a: 'Да, в кабинете в разделе «Тарифы», без обращения в поддержку. В пробный период — бесплатно и сразу. После оплаты новый тариф начнёт действовать сразу после его оплаты, а оставшиеся оплаченные дни не сгорят: они пересчитаются по цене нового тарифа и добавятся к сроку.' },
  { q: 'Есть ли фискализация чеков (54-ФЗ)?', a: 'Да. Касса отправляет чек с позициями, ставками НДС и способами оплаты в ваш регистратор АТОЛ в заведении или в облачную кассу (АТОЛ Онлайн, OrangeData). Саму ККТ с фискальным накопителем, договор с ОФД и регистрацию в ФНС оформляете вы: система к ним подключается, но не заменяет их. Карты у стойки принимаются через терминал любого банка: Сбер, ВТБ, Альфа-Банк, Т-Банк, Газпромбанк, ПСБ, Райффайзенбанк, Совкомбанк и ещё два десятка. Если Windows-касса подключена к терминалу кабелем, сумма уходит на него сама через программу банка (UPOS у Сбера, ARCUS 2 и другие). Нет терминала? Касса покажет QR СБП на экране. Онлайн-оплата из приложения идёт через интернет-эквайринг вашего банка. Всё настраивается в разделе «Интеграции» на кассе.' },
  { q: 'Где хранятся данные заведения?', a: 'Имена, телефоны и адреса гостей и имена сотрудников лежат только на нашем сервере в России и за границу не уходят, поэтому из-за ZalPOS подавать что-то в Роскомнадзор вам не нужно. Меню, чеки, смены и склад хранятся без персональных данных в облаке, резервная копия делается каждый день. Другие заведения платформы ваших данных не видят: это закреплено правилами доступа и проверено автотестами.' },
  { q: 'Сколько сотрудников и устройств можно подключить?', a: 'Сотрудников — сколько угодно на любом тарифе. Число устройств с кассой (планшетов, телефонов, компьютеров) указано в карточке тарифа, отдельно за устройство платить не нужно. На устройстве сверх лимита касса не откроется: отключите неиспользуемое в кабинете на вкладке «Устройства» или перейдите на тариф с большим числом устройств. Онлайн-касса (ККТ) для фискальных чеков покупается отдельно у её поставщика.' },
  { q: 'Что будет с данными, если я перестану пользоваться?', a: 'После отмены подписки данные хранятся 10 дней (грейс-период), затем удаляются безвозвратно. Копию заведения можно скачать самостоятельно: Кабинет · Настройки → «Скачать бэкап». В файле будут меню, зал, чеки, смены, склад и бонусы. Очень большое заведение выгрузим по запросу в поддержку.' },
  { q: 'Можно ли принимать доставку через своё приложение?', a: 'Да. Включите «Заказы с собой и доставка», и в меню приложения гостя появится кнопка «Доставка или с собой». Заказ приходит на кассу с именем и телефоном гостя: вы перезваниваете, подтверждаете, и позиции встают в чек. Табак, кальяны и алкоголь в такой заказ не попадают, их нельзя продавать дистанционно. Процент с заказов мы не берём.' },
  { q: 'Куда приходят деньги, когда гость платит из приложения?', a: 'Сразу на расчётный счёт заведения, через ваш интернет-эквайринг: Т-Банк, Сбербанк, Альфа-Банк, ВТБ, МТС Банк, Райффайзенбанк (СБП), Робокассу или другой банк на шлюзе RBS. ZalPOS деньги не принимает и не хранит. Комиссию берёт банк по вашему договору, возвраты делаются в его личном кабинете. Чек по 54-ФЗ пробивает ваша онлайн-касса.' },
  { q: 'Откуда фото блюд в демо-заведении?', a: 'Это фото со свободных фотостоков, просто для примера. В вашем заведении будут ваше меню и ваши фото. Авторы и лицензии указаны на отдельной странице.', link: { href: '#/demo-photos', text: 'Авторы фото →' } },
];

function screenDashboard() {
  screenEl().classList.add('has-tabbar');
  // Переключатель заведения — в боковом меню, доступен с любой вкладки.
  screenEl().innerHTML = `<div id="dash-body"><div class="spinner"></div></div>`;
  watchDashboardData(state.activeTenantId);
}

// Свои SVG-иконки вместо эмодзи: у эмодзи разная палитра и размеры, ряд
// выглядел случайным. Один viewBox 24×24, цвет задаёт фон чипа.
// Иконки разделов — свой набор в стиле ZalPOS: тонкая линия на сетке 24,
// скруглённые концы и одна медная деталь у каждой (как ромб в логотипе):
// .ac — медная линия, .ac-f — медная заливка (цвет — в console.css).
const NAV_ICON_PATHS = {
  home: '<path d="M4 10.4 12 4l8 6.4"/><path d="M6 9.2v10a.8.8 0 0 0 .8.8h10.4a.8.8 0 0 0 .8-.8v-10"/><path class="ac" d="M10 20v-3.6a2 2 0 0 1 4 0V20"/>',
  book: '<path d="M12 7.2C10.2 5.8 7.7 5.2 4.5 5.2v12.6c3.2 0 5.7.6 7.5 2 1.8-1.4 4.3-2 7.5-2V5.2c-3.2 0-5.7.6-7.5 2Z"/><path d="M12 7.2v12.6"/><path class="ac-f" d="M15 5.7v4.6l1.25-.95 1.25.95V5.4Z"/>',
  device: '<rect x="6.5" y="3" width="11" height="18" rx="2.4"/><path d="M10.6 5.8h2.8"/><circle class="ac-f" cx="12" cy="17.7" r="1.05"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.4"/><path d="M3 9.6h18"/><path d="M13.5 14.6h4"/><rect class="ac" x="6" y="12.6" width="4" height="3.2" rx=".9"/>',
  gem: '<path d="M7 4.5h10l3.5 4.8L12 19.8 3.5 9.3Z"/><path d="M3.5 9.3h17"/><path d="M9.6 9.3 12 19.8l2.4-10.5"/><path class="ac-f" d="M9.6 9.3 12 4.8l2.4 4.5Z"/>',
  palette: '<path d="M12 3.6a8.4 8.4 0 1 0 0 16.8c1.15 0 1.8-.8 1.8-1.7 0-1.15-1-1.6-1-2.6 0-.9.7-1.6 1.6-1.6h2.2a3.8 3.8 0 0 0 3.8-3.9c0-4-3.8-7-8.4-7Z"/><circle cx="7.6" cy="11.4" r=".95"/><circle cx="14.6" cy="7.9" r=".95"/><circle class="ac-f" cx="10.1" cy="7.7" r="1.2"/>',
  users: '<circle cx="9" cy="8.6" r="3.2"/><path d="M3.5 19.6c.4-3.2 2.7-5.3 5.5-5.3s5.1 2.1 5.5 5.3"/><path class="ac" d="M15.4 5.6a2.9 2.9 0 0 1 0 5.8M17.3 14.4c1.8.6 2.9 2.4 3.2 5.2"/>',
  spark: '<path d="M10.5 5c.6 3.7 2.4 5.5 6 6.1-3.6.6-5.4 2.4-6 6.1-.6-3.7-2.4-5.5-6-6.1 3.6-.6 5.4-2.4 6-6.1Z"/><path class="ac-f" d="M18 3.4l.65 1.75 1.75.65-1.75.65L18 8.2l-.65-1.75-1.75-.65 1.75-.65Z"/>',
  user: '<rect x="3" y="5" width="18" height="14" rx="2.4"/><circle cx="9" cy="10.9" r="2.2"/><path d="M5.9 16.2c.5-1.6 1.6-2.4 3.1-2.4s2.6.8 3.1 2.4"/><path class="ac" d="M14.6 10.2h3.6M14.6 13.6h2.4"/>',
  gear: '<path d="M4 7h8.6M17.4 7H20M4 12h2.6M11.4 12H20M4 17h10.6"/><circle cx="15" cy="7" r="2.1"/><circle cx="9" cy="12" r="2.1"/><circle class="ac-f" cx="17.2" cy="17" r="2.1"/>',
  question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.7a2.4 2.4 0 1 1 3.5 2.1c-.75.4-1.2.9-1.2 1.7v.3"/><circle class="ac-f" cx="12" cy="16.6" r="1.05"/>',
  chat: '<path d="M20 12.1c0 3.6-3.6 6.4-8 6.4-1.1 0-2.15-.2-3.1-.5l-4.4 1.5 1.25-3.4C4.65 14.9 4 13.6 4 12.1c0-3.6 3.6-6.4 8-6.4s8 2.8 8 6.4Z"/><circle class="ac-f" cx="8.5" cy="12.1" r="1"/><circle class="ac-f" cx="12" cy="12.1" r="1"/><circle class="ac-f" cx="15.5" cy="12.1" r="1"/>',
  logout: '<path d="M13.5 4.5H7.2a2.2 2.2 0 0 0-2.2 2.2v10.6a2.2 2.2 0 0 0 2.2 2.2h6.3"/><path class="ac" d="M10.5 12H20M16.8 8.8 20 12l-3.2 3.2"/>',
  badge: '<path d="M12 3.5 19 6v5.4c0 4.3-2.9 7.8-7 9.1-4.1-1.3-7-4.8-7-9.1V6Z"/><path class="ac" d="M8.8 12.2l2.2 2.2 4.2-4.6"/>',
  building: '<path d="M5 11.4v8.1h14v-8.1"/><path d="M10 19.5v-4.6h4v4.6"/><path class="ac" d="M4 9.6 5.4 4.5h13.2L20 9.6a2 2 0 0 1-4 0 2 2 0 0 1-4 0 2 2 0 0 1-4 0 2 2 0 0 1-4 0Z"/>',
  bell: '<path d="M6.5 16.4V11a5.5 5.5 0 0 1 11 0v5.4l1.6 1.6H4.9Z"/><path d="M12 3.4v2.1"/><path class="ac" d="M10.1 20.4a2.1 2.1 0 0 0 3.8 0"/>',
  list: '<path d="M9.5 7h10M9.5 12h10M9.5 17h6.5"/><circle class="ac-f" cx="5.4" cy="7" r="1.15"/><circle class="ac-f" cx="5.4" cy="12" r="1.15"/><circle class="ac-f" cx="5.4" cy="17" r="1.15"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.4"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/><circle class="ac-f" cx="12" cy="14.6" r="1.25"/><path class="ac" d="M12 15.6v1.8"/>',
  plus: '<path d="M12 20.5s6.5-5.6 6.5-10.7a6.5 6.5 0 0 0-13 0c0 5.1 6.5 10.7 6.5 10.7Z"/><path class="ac" d="M12 7v5.6M9.2 9.8h5.6"/>',
  back: '<path d="M19.5 12h-14"/><path class="ac" d="M10.5 6.5 5 12l5.5 5.5"/>',
  upload: '<path d="M4.5 14.5v3.3a2.2 2.2 0 0 0 2.2 2.2h10.6a2.2 2.2 0 0 0 2.2-2.2v-3.3"/><path d="M7.5 9 12 4.5 16.5 9"/><path class="ac" d="M12 4.8v10"/>',
};

function navIconHtml(name, color) {
  // Значок — линейный, цвета текста: цветные плитки под каждым разделом
  // спорили между собой и с содержимым. [color] больше не нужен.
  void color;
  return `<span class="nav-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICON_PATHS[name] || ''}</svg></span>`;
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
// Шлюзы дополнительных ключей: основные и те, что касса понимает только в
// очереди дополнительных (AiVendors.presets в кассе, AI_EXTRA_VENDOR_DEFAULTS
// на сервере — держать синхронно).
const AI_EXTRA_MAX = 8;
const AI_EXTRA_VENDORS = [
  ...AI_VENDORS.filter((v) => v.id !== 'custom'),
  { id: 'openrouter', title: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini',
    hint: 'Ключ из openrouter.ai/keys', models: ['openai/gpt-4o-mini', 'openai/gpt-4o', 'deepseek/deepseek-chat'] },
  { id: 'deepseek', title: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    hint: 'Ключ из platform.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', title: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
    hint: 'Ключ из platform.openai.com', models: ['gpt-4o-mini', 'gpt-4o'], note: 'Из России без прокси в «Адресе API» может не работать.' },
  { id: 'anthropic', title: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5', anthropic: true,
    hint: 'Ключ из console.anthropic.com', models: ['claude-haiku-5-5', 'claude-sonnet-5-5'], note: 'Из России без прокси в «Адресе API» может не работать.' },
  AI_VENDORS.find((v) => v.id === 'custom'),
];
const aiExtraVendor = (id) => AI_EXTRA_VENDORS.find((v) => v.id === id) || AI_EXTRA_VENDORS[AI_EXTRA_VENDORS.length - 1];
const aiExtraIsAnthropic = (k) => !!aiExtraVendor(k.vendor).anthropic || (k.vendor === 'custom' && k.format === 'anthropic');

const DASHBOARD_NAV = [
  { id: 'overview', icon: 'home', color: '#2F6FED', label: 'Обзор' },
  { id: 'guide', icon: 'book', color: '', label: 'Инструкция' },
  { id: 'devices', icon: 'device', color: '#0EA5E9', label: 'Устройства' },
  { id: 'billing', icon: 'card', color: '#F59E0B', label: 'Оплата' },
  { id: 'plans', icon: 'gem', color: '#8B5CF6', label: 'Тарифы' },
  { id: 'branding', icon: 'palette', color: '#EC4899', label: 'Брендинг' },
  { id: 'team', icon: 'users', color: '#10B981', label: 'Команда' },
  { id: 'ai', icon: 'spark', color: '#A855F7', label: 'ИИ' },
  { id: 'profile', icon: 'user', color: '#06B6D4', label: 'Профиль' },
  { id: 'settings', icon: 'gear', color: '#64748B', label: 'Настройки' },
  { id: 'import', icon: 'upload', color: '#14B8A6', label: 'Перенос данных' },
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
      <button type="button" class="dash-guide-btn f-dash-tab${activeTab === 'guide' ? ' active' : ''}" data-tab="guide" aria-label="Инструкция">
        ${navIconHtml('book')}<span>Инструкция</span>
      </button>
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
      ${state.partner ? `
        <a href="#/partner" class="nav-item" style="text-decoration:none">
          ${navIconHtml('users', '#14B8A6')}<span>Кабинет менеджера</span>
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
  try {
    const pending = window.localStorage.getItem(PENDING_TAB_KEY);
    if (pending) {
      window.localStorage.removeItem(PENDING_TAB_KEY);
      if (DASHBOARD_NAV.some((t) => t.id === pending)) activeTab = pending;
    }
  } catch (_) {}
  // Открытые статьи инструкции: экран перерисовывается целиком при каждом
  // обновлении данных, без этого статьи схлопывались бы сами.
  const guideOpen = new Set();
  let tenant = null;
  let invite = null;
  let devices = null; // кассы заведения: tenants/{id}/devices
  let branding = null;
  let subscription = null;
  let members = null;
  let plans = null;
  let buildJobs = null;
  let generalSettings = null;
  let venueProfile = null;
  // Режим rf: имена сотрудников из справочника в РФ (id → имя).
  const staffNames = new Map();
  let staffNamesAsked = '';
  // Имена сотрудников — в справочнике в РФ у всех заведений; в документе
  // имя может остаться только у старой записи, ещё не перенесённой.
  const rfMode = () => true;
  /** Имя сотрудника: из документа (старая запись) или из справочника. */
  const empName = (e) => String((e && e.name) || '') || staffNames.get(e && e.id) || '';
  /** Поле «кто сделал»: в режиме rf там ссылка staff:<id>. */
  const whoName = (raw) => {
    const v = String(raw || '');
    if (!v.startsWith('staff:')) return v;
    return staffNames.get(v.slice(6)) || 'сотрудник';
  };
  /** Подтянуть имена сотрудников из справочника (один запрос на состав). */
  const loadStaffNames = async () => {
    if (!rfMode() || !employees) return;
    const ids = employees.map((e) => e.id).filter((id) => !staffNames.has(id));
    for (const sh of recentClosedShifts || []) {
      const v = String(sh.closedBy || '');
      if (v.startsWith('staff:') && !staffNames.has(v.slice(6))) ids.push(v.slice(6));
    }
    const key = [...new Set(ids)].sort().join(',');
    if (!key || key === staffNamesAsked) return;
    staffNamesAsked = key;
    try {
      const res = await piiCall({ tenantId, kind: 'pii_lookup', refs: key.split(',').map((id) => ({ k: 'staff', id })) });
      for (const r of res.staff || []) staffNames.set(String(r.id), String(r.name || ''));
      draw();
    } catch (_) {
      staffNamesAsked = ''; // спросим при следующем обновлении
    }
  };
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
  // Перенос данных из другой кассы (import-core.js — разбор выгрузок).
  // Шаги: pick → map → preview → done. Файл живёт только в браузере.
  let imp = { step: 'pick' };
  let importCore = null;
  const IMPORT_LOG_KEY = `zalposImports_${tenantId}`;
  const importLog = () => { try { return JSON.parse(window.localStorage.getItem(IMPORT_LOG_KEY) || '[]'); } catch (_) { return []; } };
  const saveImportLog = (list) => { try { window.localStorage.setItem(IMPORT_LOG_KEY, JSON.stringify(list.slice(0, 20))); } catch (_) {} };
  const loadImportCore = async () => (importCore = importCore || await import('./import-core.js'));
  // Подтверждения перед переносом (коды проверяет /recordImportConsent).
  // text — готовый HTML, без данных пользователя.
  const IMPORT_CONSENTS = [
    { id: 'partial', title: 'Понимаю, что перенос может быть неполным',
      text: 'Проверю меню, цены, остатки, техкарты и сотрудников в кассе до начала работы и при необходимости поправлю вручную. Ошибочный перенос можно отменить целиком.' },
    { id: 'owner_data', title: 'Данные принадлежат моему заведению, и я вправе их переносить',
      text: 'Файл выгружен из учётной записи моего заведения штатной функцией прежней системы. В нём нет данных гостей и чужих заведений.' },
    { id: 'staff_assignment', staff: true, title: 'Поручаю ZalPOS хранить имена сотрудников',
      text: 'Заведение — работодатель и оператор персональных данных сотрудников и вправе поручить их обработку (ч. 3 ст. 6 152-ФЗ): сотрудники согласны, что их имена ведутся в кассе. Переносятся только имя и должность; ZalPOS хранит имена на серверах в России по поручению заведения — по <a href="#/legal/offer" target="_blank" rel="noopener">договору-оферте</a> и <a href="#/legal/privacy" target="_blank" rel="noopener">Политике конфиденциальности</a>.' },
  ];
  // Что точно не переносится — честно, по каждому типу.
  const IMPORT_NOT_MOVED = {
    menu: 'Модификаторы, комбо, фото, налоговые ставки и признаки маркировки не переносятся — их нужно настроить в кассе.',
    stock: 'История приходов и списаний не переносится — только текущий остаток, цена закупки и минимум.',
    recipes: 'Переносятся состав, количество, отход и число порций; варианты и замены ингредиентов, технология приготовления и фото — нет.',
    staff: 'Переносятся имя и должность; PIN-коды, ставки, графики и права доступа — нет.',
    cards: 'Переносятся номер и процент скидки; имена, телефоны и бонусы гостей — нет.',
  };
  const tcol = (name) => collection(state.db, 'tenants', tenantId, name);

  /** Что уже есть в заведении — чтобы не плодить дубли. */
  async function importExisting() {
    const [cats, menu, stock, cards] = await Promise.all(['menuCategories', 'menuItems', 'inventoryItems', 'discountCards'].map((c) => getDocs(tcol(c))));
    const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return {
      categories: rows(cats), menu: rows(menu), stock: rows(stock), cards: rows(cards),
      staffNames: (employees || []).map((e) => empName(e)).filter(Boolean),
    };
  }

  /** Записи пачками: в одной пачке Firestore — до 500 операций. */
  async function commitOps(ops, onProgress) {
    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(state.db);
      for (const op of ops.slice(i, i + 400)) {
        if (op.type === 'set') batch.set(op.ref, op.data);
        else if (op.type === 'update') batch.update(op.ref, op.data);
        else batch.delete(op.ref);
      }
      await batch.commit();
      if (onProgress) onProgress(Math.min(ops.length, i + 400), ops.length);
    }
  }

  /** Выполнить план переноса. Каждая созданная запись помечена importId —
   *  так перенос можно отменить целиком. */
  async function runImport(plan, existing) {
    const I = importCore;
    const importId = `imp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const now = Timestamp.now();
    const ops = [];
    const result = { importId, created: 0, updated: 0, pins: [], warnings: [] };
    const progress = (done, all) => { imp.progress = `Записываю: ${done} из ${all}`; draw(); };
    // Подтверждения — в журнал на сервере до первой записи. Без журнала не
    // переносим; 404 — сервер ещё не обновлён, тогда не держим работу.
    const consents = Object.keys(imp.consent || {}).filter((k) => imp.consent[k]);
    try {
      await callSaasGateway('recordImportConsent', { tenantId, importId, kind: plan.kind, consents, file: imp.fileName || '' });
    } catch (err) {
      if (err?.status !== 404) throw new Error(`не сохранились подтверждения (${err?.message || err}) — проверьте интернет и повторите`);
    }
    if (plan.kind === 'menu') {
      const catId = new Map(existing.categories.map((c) => [I.nameKey(c.name), c.id]));
      let order = Math.max(0, ...existing.categories.map((c) => Number(c.order) || 0));
      for (const name of plan.newCategories) {
        const ref = doc(tcol('menuCategories'));
        catId.set(I.nameKey(name), ref.id);
        ops.push({ type: 'set', ref, data: { name, order: ++order, imageUrl: '', kind: '', importId } });
      }
      for (const it of plan.create) {
        ops.push({ type: 'set', ref: doc(tcol('menuItems')), data: {
          categoryId: catId.get(I.nameKey(it.category)), name: it.name, price: it.price, description: it.description || '',
          available: true, imageUrl: '', weight: 0, weightUnit: 'g', inventoryItemId: '', components: [], recipePortions: 1,
          modifierGroups: [], staffBonus: 0, tobacco: false, vat: '', fiscalSubject: 'commodity', importId,
        } });
        result.created++;
      }
      for (const it of plan.update) {
        ops.push({ type: 'update', ref: doc(tcol('menuItems'), it.id), data: {
          price: it.price, categoryId: catId.get(I.nameKey(it.category)), ...(it.description ? { description: it.description } : {}),
        } });
        result.updated++;
      }
    } else if (plan.kind === 'stock' || plan.kind === 'recipes') {
      const stockId = new Map(existing.stock.map((x) => [I.nameKey(x.name), x.id]));
      const newItem = (it) => {
        const ref = doc(tcol('inventoryItems'));
        stockId.set(I.nameKey(it.name), ref.id);
        ops.push({ type: 'set', ref, data: {
          name: it.name, category: it.category || '', unit: it.unit, quantity: it.quantity || 0, minQuantity: it.min || 0,
          active: true, note: '', updatedAt: now, isMarked: false, gtin: '', costPrice: it.cost || 0, recipe: [], recipeOutput: 0, importId,
        } });
        if (it.quantity > 0) {
          ops.push({ type: 'set', ref: doc(tcol('inventoryMovements')), data: {
            itemId: ref.id, itemName: it.name, unit: it.unit, type: 'receipt', delta: it.quantity, resultingQty: it.quantity,
            reason: 'Начальный остаток — перенос из прежней системы', createdAt: now, importId,
          } });
        }
      };
      if (plan.kind === 'stock') {
        for (const it of plan.create) { newItem(it); result.created++; }
        for (const it of plan.update) {
          const data = { updatedAt: now, ...(it.cost > 0 ? { costPrice: it.cost } : {}), ...(it.min > 0 ? { minQuantity: it.min } : {}) };
          if (it.quantity != null && Math.abs(it.quantity - it.was) > 1e-9) {
            data.quantity = it.quantity;
            ops.push({ type: 'set', ref: doc(tcol('inventoryMovements')), data: {
              itemId: it.id, itemName: it.name, unit: it.unit, type: 'correction', delta: it.quantity - it.was, resultingQty: it.quantity,
              reason: 'Остаток по переносу из прежней системы', createdAt: now, importId,
            } });
          }
          ops.push({ type: 'update', ref: doc(tcol('inventoryItems'), it.id), data });
          result.updated++;
        }
      } else {
        for (const s of plan.newStock) newItem({ name: s.name, unit: s.unit, quantity: 0, category: 'Продукты' });
        for (const d of [...plan.create, ...plan.update]) {
          ops.push({ type: 'update', ref: doc(tcol('menuItems'), d.id), data: {
            components: d.lines.map((l) => ({ inventoryItemId: stockId.get(I.nameKey(l.ingredient)), weight: l.amount, weightUnit: l.unit, ...(l.loss > 0 ? { lossPercent: l.loss } : {}) })),
            recipePortions: d.portions, inventoryItemId: '', weight: 0, recipeImportId: importId,
          } });
          if (d.hadRecipe) result.updated++; else result.created++;
        }
        if (plan.newStock.length) result.warnings.push(`Новые продукты на складе: ${plan.newStock.length} — с нулевым остатком. Перенесите остатки или проведите приход.`);
      }
    } else if (plan.kind === 'staff') {
      // Сотрудников тариф не ограничивает — переносим всех.
      const list = plan.create;
      const takenHashes = new Set((employees || []).map((e) => e.pinHash).filter(Boolean));
      const taken = new Set();
      const people = [];
      for (const it of list) {
        let pin;
        let hash;
        do {
          pin = I.newPin(it.role, taken);
          hash = await hashEmployeePin(pin, tenantId);
        } while (takenHashes.has(hash));
        takenHashes.add(hash);
        people.push({ ...it, ref: doc(tcol('employees')), pin, hash });
      }
      // Имена — сначала в справочник в РФ (как при добавлении в «Команде»).
      for (let i = 0; i < people.length; i += 200) {
        await piiCall({ tenantId, kind: 'pii_put', items: people.slice(i, i + 200).map((x) => ({ k: 'staff', id: x.ref.id, fields: { name: x.name } })) });
      }
      for (const x of people) {
        staffNames.set(x.ref.id, x.name);
        ops.push({ type: 'set', ref: x.ref, data: {
          role: x.role, pinHash: x.hash, position: x.position, hourlyRateEnabled: false, hourlyRate: 0,
          overtimeEnabled: false, overtimeThresholdHours: 8, overtimeMultiplier: 1.5, salesPercentEnabled: false, salesPercentRate: 0, importId,
        } });
        result.pins.push({ name: x.name, role: x.role, pin: x.pin });
        result.created++;
      }
    } else if (plan.kind === 'cards') {
      for (const it of plan.create) {
        ops.push({ type: 'set', ref: doc(tcol('discountCards')), data: { cardNumber: it.number, discountPercent: it.percent, active: true, importId } });
        result.created++;
      }
      for (const it of plan.update) {
        ops.push({ type: 'update', ref: doc(tcol('discountCards'), it.id), data: { discountPercent: it.percent } });
        result.updated++;
      }
    }
    await commitOps(ops, progress);
    // Касса берёт меню из кеша сервера — сбросим его, чтобы перенос был виден сразу.
    callSaasGateway('invalidateTenantCache', { tenantId }).catch(() => {});
    saveImportLog([{ id: importId, at: Date.now(), kind: plan.kind, file: imp.fileName || '', created: result.created, updated: result.updated, consents }, ...importLog()]);
    return result;
  }

  /** Отменить перенос: удалить созданное им, снять перенесённые рецепты. */
  async function undoImport(importId) {
    const ops = [];
    const created = {};
    for (const c of ['menuItems', 'inventoryMovements', 'inventoryItems', 'employees', 'discountCards', 'menuCategories']) {
      const snap = await getDocs(query(tcol(c), where('importId', '==', importId)));
      created[c] = snap.docs;
    }
    // Категорию, в которую потом добавили свои позиции, не удаляем.
    const keepCats = new Set();
    if (created.menuCategories.length) {
      const all = await getDocs(tcol('menuItems'));
      const gone = new Set(created.menuItems.map((d) => d.id));
      for (const d of all.docs) if (!gone.has(d.id)) keepCats.add(d.data().categoryId);
    }
    for (const [c, docs] of Object.entries(created)) {
      for (const d of docs) if (!(c === 'menuCategories' && keepCats.has(d.id))) ops.push({ type: 'delete', ref: d.ref });
    }
    const recipes = await getDocs(query(tcol('menuItems'), where('recipeImportId', '==', importId)));
    for (const d of recipes.docs) {
      if (!created.menuItems.some((x) => x.id === d.id)) ops.push({ type: 'update', ref: d.ref, data: { components: [], recipePortions: 1, recipeImportId: deleteField() } });
    }
    await commitOps(ops);
    for (const d of created.employees) await piiCall({ tenantId, kind: 'pii_erase', k: 'staff', id: d.id }).catch(() => {});
    callSaasGateway('invalidateTenantCache', { tenantId }).catch(() => {});
    saveImportLog(importLog().filter((x) => x.id !== importId));
    return ops.length;
  }
  const payerDraft = { mode: 'individual', type: 'ip', name: '', inn: '', kpp: '' };
  // Объявления платформы. Скрытые запоминаем в localStorage: синхронизировать
  // «прочитано» между устройствами ради баннера незачем.
  let broadcasts = null;
  // Обращения в поддержку; переписку грузим только для открытого тикета.
  let supportTickets = null;
  // Ошибку загрузки показываем как ошибку, а не как «обращений нет».
  let supportTicketsError = '';
  let loadSupportTickets = async () => {};
  let selectedTicketId = null;
  let ticketMessages = null;
  // Файлы, выбранные, но ещё не отправленные: в новое обращение и в ответ.
  const ticketDraftFiles = [];
  const replyDraftFiles = [];
  // Пока сообщение уходит — надпись на кнопке «Отправить» (и защита от повторов).
  let replySending = '';
  sub(() => { clearTimeout(ticketPollTimer); ticketPollTimer = null; });
  // Обращения и переписка — на сервере поддержки, а не в Firestore: читаем
  // их опросом (это не тратит лимит базы). Открытое обращение — раз в 15 с,
  // после своего сообщения — каждые 4 с (ответ ассистента приходит за
  // 5–30 с); перерисовываем, только если что-то изменилось.
  let ticketPollTimer = null;
  let ticketPollFastUntil = 0;
  let ticketSeenAt = 0;
  const loadTicketMessages = async (id) => {
    const r = fromWire((await callSaasGateway('supportTicketMessages', { ticketId: id })).data);
    if (selectedTicketId !== id) return;
    const t = r.ticket || {};
    const at = Math.max(t.updatedAt?.toMillis?.() || 0, t.aiTypingAt?.toMillis?.() || 0);
    const ticket = (supportTickets || []).find((x) => x.id === id);
    if (ticketMessages && at <= ticketSeenAt && (r.messages || []).length === ticketMessages.length) return;
    ticketSeenAt = at;
    if (ticket) Object.assign(ticket, t);
    ticketMessages = r.messages || [];
    draw();
  };
  const ticketPoll = (delay = null) => {
    clearTimeout(ticketPollTimer);
    ticketPollTimer = null;
    if (!selectedTicketId) return;
    const id = selectedTicketId;
    ticketPollTimer = setTimeout(async () => {
      if (selectedTicketId !== id) return;
      if (document.visibilityState === 'visible' || ticketMessages === null) {
        try {
          await loadTicketMessages(id);
        } catch (e) {
          if (ticketMessages === null && selectedTicketId === id) {
            ticketMessages = [];
            toast(`Не удалось загрузить переписку: ${e?.message || e}`);
            draw();
          }
        }
      }
      ticketPoll();
    }, delay ?? (Date.now() < ticketPollFastUntil ? 4000 : 15000));
  };
  // null — первый снапшот ещё не пришёл, не путать с нулём.
  let liveOpenSessions = null;
  let liveOnShift = null;
  let todayRevenue = null;
  // Точки сети: выручка и чеки за сегодня — для сравнения на «Обзоре».
  const chainToday = {};
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
  // Загруженный, но ещё не сохранённый логотип.
  let pendingLogoUrl = null;
  // Пока логотип грузится, сохранение брендинга ждёт: иначе сохранились бы
  // имя и цвета, а логотип молча потерялся.
  let logoUploading = false;

  const selectTicket = (ticketId) => {
    selectedTicketId = ticketId;
    ticketMessages = null;
    ticketSeenAt = 0;
    replyDraftFiles.splice(0);
    // Переписку — сразу, дальше опросом.
    ticketPoll(0);
    draw();
  };

  const draw = () => {
    // Раздел уже закрыт (перешли на другую вкладку), а данные пришли — не рисуем.
    if (!body || !body.isConnected) return;
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
        text: `Недостача ${shortage.toLocaleString('ru-RU')} ₽ при закрытии смены${when ? ` ${when}` : ''}${sh.closedBy ? ` — закрыл(а) ${whoName(sh.closedBy)}` : ''}. Подробности — в X-отчёте кассы, «Прошлые смены»`,
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
            <div class="small muted rich-text" style="margin-top:4px">${richText(b.body || '')}</div>
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
          ${(() => {
            const max = Math.max(1, ...locations.map((t) => (chainToday[t.id] || {}).revenue || 0));
            return locations.map((t) => {
              const st = chainToday[t.id];
              const rev = st ? st.revenue : null;
              const avg = st && st.checks ? Math.round(st.revenue / st.checks) : 0;
              return `
            <div style="padding:7px 0;border-bottom:1px solid var(--border)">
              <div class="row" style="justify-content:space-between">
                <div class="grow">${esc(t.name || t.id)}${t.id === tenantId ? ' <span class="muted small">(эта)</span>' : ''}</div>
                ${t.id !== tenantId ? `<button class="btn-link f-chain-location-switch" data-id="${esc(t.id)}" style="width:auto">Открыть</button>` : ''}
              </div>
              <div class="small muted">Сегодня: ${rev === null ? '—' : `${Number(rev).toLocaleString('ru-RU')} ₽ · чеков ${st.checks}${avg ? ` · средний ${avg.toLocaleString('ru-RU')} ₽` : ''}`}</div>
              ${rev ? `<div style="height:4px;border-radius:2px;background:var(--primary);opacity:.75;margin-top:4px;width:${Math.round((rev / max) * 100)}%"></div>` : ''}
            </div>`;
            }).join('');
          })()}
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
      ${devicesOverHtml()}
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
      <button type="button" class="card guide-promo f-dash-tab" data-tab="guide">
        ${navIconHtml('book')}
        <span class="guide-promo-text"><b>Инструкция по ZalPOS</b><span>Как настроить заведение и работать в кассе: шаги, кнопки, поиск</span></span>
        <span class="guide-promo-cta">Открыть</span>
      </button>
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

    // Устройства с кассой и лимит тарифа. Каждое физическое устройство —
    // планшет на кухне, планшет на баре, телефон официанта, компьютер —
    // считается отдельно. Касса работает на первых подключённых в пределах
    // лимита (lib/services/plan_capabilities.dart, DeviceLimitGate) —
    // порядок здесь тот же.
    const deviceStats = () => {
      const max = planCaps((plans || []).find((p) => p.id === subscription?.planId)).maxDevices;
      const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : Infinity);
      const list = [...(devices || [])].sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.id.localeCompare(b.id));
      const off = (d) => d.status === 'disabled' || d.status === 'removed';
      const active = list.filter((d) => !off(d));
      const working = new Set(active.slice(0, max || active.length).map((d) => d.id));
      return { max, list, active, removed: list.filter(off), working, over: max > 0 && active.length > max };
    };
    const devWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'устройство' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'устройства' : 'устройств');
    // На главной: устройств больше, чем по тарифу, — сразу два выхода.
    const devicesOverHtml = () => {
      if (!devices) return '';
      const st = deviceStats();
      if (!st.over) return '';
      const extra = st.active.length - st.max;
      return `<div class="card" style="border-color:var(--warning);margin-bottom:14px">
        <div style="font-weight:700">Подключено ${st.active.length} ${devWord(st.active.length)}, а по тарифу — ${st.max}</div>
        <p class="small muted" style="margin:6px 0 10px">${extra === 1 ? 'На последнем подключённом устройстве' : `На ${extra} последних подключённых`} касса не работает.
        Удалите устройство, которым больше не пользуетесь, или перейдите на тариф с большим числом устройств.</p>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost f-dash-tab" data-tab="devices">${role === 'owner' ? 'Удалить ненужное устройство' : 'Посмотреть устройства'}</button>
          <button class="btn f-dash-tab" data-tab="plans">Выбрать тариф больше</button>
        </div>
      </div>`;
    };
    const devicesListHtml = () => {
      if (!devices) return '';
      const { max, active, removed, working } = deviceStats();
      // Удалять и восстанавливать устройства может только владелец заведения.
      const isOwner = role === 'owner';
      const PLATFORM = { android: 'Android', windows: 'Windows', ios: 'iOS', web: 'браузер' };
      const title = (d) => d.deviceName || (d.platform === 'windows' ? 'Компьютер с Windows' : d.platform === 'android' ? 'Android-устройство' : 'Устройство');
      const row = (d) => {
        const off = d.status === 'disabled' || d.status === 'removed';
        const over = !off && !working.has(d.id);
        const seen = d.seenAt || d.lastSeenAt;
        return `<div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:6px 12px;padding:10px 0;border-top:1px solid var(--border)">
          <div style="min-width:200px;flex:1 1 220px">
            <div style="font-weight:600">${esc(title(d))}${d.platform ? ` <span class="muted small">· ${esc(PLATFORM[d.platform] || d.platform)}</span>` : ''}</div>
            ${d.usage ? `<div class="small">${esc(d.usage)}</div>` : ''}
            ${!d.deviceName && !off ? '<div class="small" style="color:var(--warning)">Без названия — касса спросит его при следующем входе, или нажмите «Переименовать»</div>' : ''}
            <div class="small muted">Подключено ${fmtDate(d.createdAt)}${seen ? ` · на связи ${fmtDateTime(seen)}` : ''}</div>
            ${off ? `<div class="small" style="color:var(--muted)">${d.removedAt ? `Удалено ${fmtDate(d.removedAt)}` : 'Удалено'} — касса на нём не работает, пока его не восстановить</div>` : ''}
            ${over ? '<div class="small" style="color:var(--warning)">Сверх лимита тарифа — касса на нём не работает</div>' : ''}
          </div>
          ${canManage ? `<div class="row" style="gap:14px;flex:none;margin-left:auto">
            ${off ? '' : `<button class="btn-link" data-device-rename="${esc(d.id)}" data-name="${esc(d.deviceName || '')}">Переименовать</button>`}
            ${isOwner && off ? `<button class="btn-link" data-device-restore="${esc(d.id)}" data-name="${esc(title(d))}">Восстановить</button>` : ''}
            ${isOwner && !off ? `<button class="btn-link" data-device-remove="${esc(d.id)}" data-name="${esc(title(d))}" style="color:var(--danger)">Удалить</button>` : ''}
          </div>` : ''}
        </div>`;
      };
      return `
      <h2>Подключённые устройства</h2>
      <div class="card">
        <p class="small muted" style="margin-top:0">Каждое устройство с кассой считается отдельно: планшет на кухне, планшет на баре,
        телефон официанта, компьютер. ${max
          ? `По тарифу — до ${max} ${max % 10 === 1 && max % 100 !== 11 ? 'устройства' : 'устройств'}${tenant?.chainId ? ' на этой точке' : ''}, сейчас подключено ${active.length}.`
          : `По тарифу число устройств не ограничено, сейчас подключено ${active.length}.`}
        ${role === 'owner'
          ? 'Устройство больше не нужно — удалите его: касса на нём перестанет работать, а место освободится. Передумали — восстановите его ниже.'
          : 'Удалять и восстанавливать устройства может только владелец заведения.'}</p>
        ${active.length ? active.map(row).join('') : '<p class="small muted">Пока ни одного устройства. Скачайте кассу ниже — она подключится сама.</p>'}
        ${removed.length ? `<div style="margin-top:16px;font-weight:600">Удалённые устройства</div>${removed.map(row).join('')}` : ''}
        ${max && active.length >= max ? `<p class="small" style="margin:12px 0 0">Нужно больше устройств — <a href="#" class="f-dash-tab" data-tab="plans">выберите тариф больше</a>, оплаченные дни пересчитаются.</p>` : ''}
      </div>`;
    };

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

      ${devicesListHtml()}

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
        ${canManage && subscription?.status === 'active' && subscription?.cancelAtPeriodEnd && subscription?.provider === 'robokassa' && !subscription?.robokassaParentInvId ? `
          <p class="small muted" style="margin:10px 0 0">Автопродление не подключено: прошлую оплату сделали без него. Чтобы
          продлевалось само, в «Тарифах» отметьте «Автопродление» и оплатите следующий период — он добавится к текущему сроку.</p>
        ` : canManage && subscription?.status === 'active' ? `
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
              ${b.status === 'paid' ? `<a class="btn-link" href="#/act/${esc(b.id)}" style="width:auto">Акт</a>` : ''}
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
                <button class="btn ${subscription?.status === 'past_due' || (inTrial && isCurrent) ? 'btn-primary' : 'btn-ghost'} f-plan-checkout" data-plan="${esc(p.id)}">
                  ${paidCurrent ? 'Продлить' : isCurrent ? 'Оплатить' : inTrial ? 'Оплатить этот тариф' : 'Перейти и оплатить'}
                </button>
                ${paidCurrent && subscription?.currentPeriodEnd ? `<div class="small muted" style="margin-top:6px">Оплачено до ${fmtDate(subscription.currentPeriodEnd)}. Продлите заранее — новый срок добавится к этой дате.</div>` : ''}
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
                <p class="small muted" style="margin:0">Нажмите у нужного тарифа кнопку оплаты — появится счёт для оплаты
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
          <p class="small muted" style="margin:10px 0 0">🛡 Страница оплаты долго грузится или не открывается? Выключите VPN
          на время оплаты: платёжные страницы российских банков и Robokassa через VPN часто открываются медленно или блокируются.</p>
        ` : '<p class="small muted">Тарифы пока не заданы платформой.</p>'}
      </div>
      ${role === 'owner' && tenant.chainId && !tenant.demo && plans && sellablePlans(plans, false).length ? `
        <h2 style="margin-top:24px">Перейти на тариф для одного заведения</h2>
        <p class="small muted" style="margin-top:-4px">${state.tenants.filter((t) => t.chainId === tenant.chainId).length > 1
          ? 'В сети несколько точек — на обычный тариф можно перейти, когда останется одна точка (лишние удаляются в разделе «Заведение» каждой точки).'
          : 'Сеть из одной точки можно сделать обычным заведением: оплаченный срок сохранится, гости, бонусы и брендинг останутся, дальше — по цене выбранного тарифа.'}</p>
        ${state.tenants.filter((t) => t.chainId === tenant.chainId).length > 1 ? '' : `<div class="card">
          ${sellablePlans(plans, false).map((p) => `
            <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
              <div class="grow">
                <div>${esc(p.name || p.id)}</div>
                <div class="small muted">${(Number(p.priceRub) || 0).toLocaleString('ru-RU')} ₽/мес</div>
              </div>
              <button class="btn btn-ghost f-convert-to-single" data-plan="${esc(p.id)}" data-name="${esc(p.name || p.id)}" style="width:auto">Перейти</button>
            </div>
          `).join('')}
        </div>`}
      ` : ''}
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
        <p class="small muted" style="margin:-4px 0 10px">Цвета бренда — для приложения и веб-версии
        для гостей. Касса для персонала — в стиле ZalPOS: тёмная или светлая тема
        переключается в самой кассе (меню ☰ → «Тема»).</p>
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
          : employees.slice().sort((a, b) => empName(a).localeCompare(empName(b))).map((e) => {
            const pinLen = e.role === 'admin' ? 6 : 4;
            return `
          <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
            <div class="grow" style="min-width:0">
              <div class="ellipsis">${esc(empName(e) || (rfMode() ? '…' : ''))}</div>
              <div class="small muted">
                ${e.role === 'admin' ? 'Администратор' : 'Сотрудник'} · PIN
                <span title="PIN хранится зашифрованным — посмотреть его нельзя, только задать новый">${'•'.repeat(pinLen)}</span>
                ${e.position && e.position !== 'universal' ? ` · ${esc(POSITION_LABELS[e.position] || e.position)}` : ''}
              </div>
            </div>
            ${canManage ? `
              <button class="btn-link f-emp-edit" data-id="${esc(e.id)}" style="width:auto">Изменить</button>
              <button class="btn-link f-emp-delete" data-id="${esc(e.id)}" data-name="${esc(empName(e))}" style="width:auto;color:var(--danger)">Удалить</button>
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
            <p class="small muted" style="margin:-6px 0 10px">Можно вписать псевдоним («Аня-бар», «Кальянщик 2») — кассе нужно только различать сотрудников. Чем меньше личных данных, тем проще с 152-ФЗ.</p>
            <div class="row">
              <select id="f-emp-role" class="grow">
                <option value="employee">Сотрудник (PIN — 4 цифры)</option>
                <option value="admin">Администратор (PIN — 6 цифр)</option>
              </select>
            </div>
            <label class="field"><span>PIN-код</span>
              <input id="f-emp-pin" type="text" inputmode="numeric" placeholder="${editingEmployeeId ? 'пусто — оставить прежний' : '0000'}" maxlength="6">
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
        <div class="small" style="margin-top:8px">✓ Имена и телефоны гостей и сотрудников хранятся только в России и за границу не передаются — из-за ZalPOS подавать в Роскомнадзор ничего не нужно.</div>
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

      <div class="card">
        <label class="field-checkbox" style="display:flex;align-items:flex-start;gap:10px">
          <input type="checkbox" id="f-delivery-mode" style="width:auto;margin-top:3px"
            ${venueProfile && venueProfile.deliveryEnabled === true ? 'checked' : ''} ${canManage ? '' : 'disabled'}>
          <span><b>Заказы с собой и доставка</b><br>
          <span class="small muted">Кнопка в шапке зала кассы: заказ без стола, статусы «Принят → Готовится → У курьера →
          Доставлен». Включение и выключение видно на всех кассах сразу, без перезапуска.</span></span>
        </label>
      </div>

      ${canManage ? `
        <h2>Telegram-бот заведения</h2>
        <div class="card" id="f-tg-box">${telegramBoxHtml(tgStatusCache.get(tenantId))}</div>
      ` : ''}

      ${role === 'owner' ? `
        <h2>Резервная копия</h2>
        <div class="card">
          <p class="small muted">Все данные ${tenant.chainId ? 'точки' : 'заведения'} одним файлом: меню, залы и столы,
          чеки и смены, бонусы гостей, сотрудники, склад, брони и настройки. Имён, телефонов и адресов
          гостей в файле нет: их оператор — ZalPOS, и так заведению не нужно ничего подавать о них в
          Роскомнадзор. Храните файл у себя. Скачать можно раз в 3 дня.</p>
          <button class="btn btn-ghost" id="f-backup-tenant">Скачать бэкап ${tenant.chainId ? 'точки' : 'заведения'}</button>
          ${tenant.chainId ? `<button class="btn btn-ghost" id="f-backup-chain" style="margin-top:8px">Скачать бэкап всей сети</button>` : ''}
        </div>
      ` : ''}

      <h2>Системные требования</h2>
      <div class="card">
        <div class="small" style="padding:7px 0;border-bottom:1px solid var(--border)">📶 Интернет — Wi-Fi или мобильный. Пропадёт связь — касса продолжит принимать заказы и оплаты и досинхронизирует их сама</div>
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
      <p class="small muted">Пошаговые действия в кассе и кабинете — в разделе <a href="#" class="f-dash-tab" data-tab="guide">«Инструкция»</a>.</p>
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
            <div style="margin:8px 0;padding:8px 10px;border-radius:10px;background:${m.authorRole === 'super_admin' || m.authorRole === 'ai' ? 'var(--surface-2)' : 'transparent'};border:1px solid var(--border)">
              <div class="small muted">${esc(m.authorRole === 'ai' ? '🤖 Ассистент ZalPOS' : m.authorRole === 'super_admin' ? (m.authorName ? `${m.authorName} · поддержка ZalPOS` : 'Поддержка ZalPOS') : 'Вы')} · ${fmtDateTime(m.createdAt)}</div>
              ${m.text ? `<div class="small rich-text" style="margin-top:2px">${richText(m.text, { bold: m.authorRole !== 'owner' })}</div>` : ''}
              ${attachmentsHtml(selectedTicket.id, m.attachments)}
            </div>
          `).join('') : '<p class="small muted">Сообщений пока нет.</p>')}
          ${(() => {
            // Сервер ставит aiTypingAt, пока ассистент готовит ответ.
            const at = selectedTicket.aiTypingAt && selectedTicket.aiTypingAt.toMillis ? selectedTicket.aiTypingAt.toMillis() : 0;
            return at && Date.now() - at < 3 * 60 * 1000 && selectedTicket.status !== 'closed'
              ? '<div class="typing-bubble small muted">🤖 Ассистент печатает<span class="typing-dots"><i></i><i></i><i></i></span></div>' : '';
          })()}
        </div>
        <textarea id="f-ticket-reply" rows="3" placeholder="Ваш ответ… Скриншот можно вставить сюда (Ctrl+V)" style="width:100%;resize:vertical;margin-top:10px"></textarea>
        ${pendingFilesHtml(replyDraftFiles, 'f-reply-rm')}
        <div class="row att-actions">
          <button class="btn btn-primary" id="f-ticket-reply-send" style="width:auto" ${replySending ? 'disabled' : ''}>${esc(replySending || 'Отправить')}</button>
          <button type="button" class="btn btn-ghost att-add" id="f-reply-attach" style="width:auto">📎 Прикрепить</button>
          <input type="file" id="f-reply-files" accept="${SUPPORT_ACCEPT}" multiple hidden>
        </div>
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
          <textarea id="f-ticket-message" rows="3" placeholder="Опишите, что случилось. Скриншот можно вставить сюда (Ctrl+V)"></textarea>
        </label>
        ${pendingFilesHtml(ticketDraftFiles, 'f-new-rm')}
        <button type="button" class="btn btn-ghost att-add" id="f-ticket-attach" style="width:auto;margin:0 0 14px">📎 Прикрепить скриншот или файл</button>
        <input type="file" id="f-ticket-files" accept="${SUPPORT_ACCEPT}" multiple hidden>
        <label class="consent-row">
          <input type="checkbox" id="f-ticket-consent" ${supportConsentGiven() ? 'checked' : ''}>
          <span class="consent-text">
            <span>Согласен на обработку данных обращения</span>
            <span class="small muted">Обращение проходит через сервер в России: телефоны, почты, ИНН, номера карт и ФИО в тексте скрываются автоматически, скриншоты остаются в России — ассистент получает только распознанный с них текст, тоже без личных данных. Не пишите пароли, коды из СМС и данные гостей.
              <a href="#/legal/privacy" target="_blank" rel="noopener" class="nowrap">Политика конфиденциальности</a></span>
          </span>
        </label>
        <button class="btn btn-primary" id="f-ticket-create">Создать обращение</button>
      </div>
      ${(supportTickets || []).length ? `<div class="card">${supportTickets.map((t) => `
        <div class="row f-ticket-open" data-id="${esc(t.id)}" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer">
          <div class="small grow" style="min-width:0">
            <b>${esc(t.subject || '')}</b>
            <div class="muted">${fmtDateTime(t.updatedAt || t.createdAt)}</div>
          </div>
          ${(t.lastAuthorRole === 'super_admin' || t.lastAuthorRole === 'ai') && t.status !== 'closed'
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
      const secExtra = sec.extraKeys || {};
      const extras = (Array.isArray(pub.extraKeys) ? pub.extraKeys : []).filter((k) => k && k.id).slice(0, AI_EXTRA_MAX).map((k) => ({
        id: String(k.id), vendor: k.vendor || 'custom', model: k.model || '', analyticsModel: k.analyticsModel || '',
        format: k.format || '', enabled: k.enabled !== false, hasKey: !!(k.hasKey || (secExtra[k.id] || {}).apiKey),
        apiKey: '', baseUrl: (secExtra[k.id] || {}).baseUrl || '',
      }));
      return {
        enabled: pub.enabled === true, vendor: legacyVendor, fallbackVendor: pub.fallbackVendor || '',
        vendors, extras, removedExtras: [], migrated: !aiPub && !!aiLegacy,
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

    // Номер в очереди первого дополнительного ключа: после основного и резервного.
    const aiExtraBase = (st) => (st.fallbackVendor && st.fallbackVendor !== st.vendor ? 2 : 1);

    const aiExtrasHtml = (st) => {
      const dis = canManage ? '' : 'disabled';
      const base = aiExtraBase(st);
      const card = (k, i) => {
        const v = aiExtraVendor(k.vendor);
        const fid = `f-ai-x-${esc(k.id)}`;
        const attrs = (field) => `class="f-ai-x" data-i="${i}" data-field="${field}" ${dis}`;
        return `
          <div class="card ai-extra${k.enabled ? '' : ' ai-extra-off'}">
            <div class="row" style="justify-content:space-between;align-items:center;gap:8px">
              <b>Ключ ${base + i + 1} · ${esc(v.title)}</b>
              <span class="small muted">${k.enabled ? '' : 'выключен · '}${k.hasKey ? '✓ ключ сохранён' : 'ключ не указан'}</span>
            </div>
            <label class="field"><span>Шлюз</span>
              <select id="${fid}-vendor" ${attrs('vendor')}>
                ${AI_EXTRA_VENDORS.map((o) => `<option value="${o.id}" ${o.id === v.id ? 'selected' : ''}>${esc(o.title)}</option>`).join('')}
              </select>
            </label>
            <label class="field"><span>API-ключ</span>
              <input type="password" autocomplete="off" id="${fid}-key" ${attrs('apiKey')} value="${esc(k.apiKey)}"
                placeholder="${esc(k.hasKey ? 'сохранён — оставьте пустым, чтобы не менять' : v.hint)}">
            </label>
            <label class="field"><span>Модель</span>
              <input id="${fid}-model" ${attrs('model')} list="${fid}-models" value="${esc(k.model)}" placeholder="${esc(v.model || 'имя модели')}">
              <datalist id="${fid}-models">${v.models.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
            </label>
            <label class="field"><span>Адрес API${v.id === 'custom' ? '' : ' (необязательно)'}</span>
              <input id="${fid}-url" ${attrs('baseUrl')} value="${esc(k.baseUrl)}" placeholder="${esc(v.baseUrl || 'https://ваш-шлюз/v1')}">
            </label>
            ${v.id === 'custom' ? `
              <label class="field"><span>Формат API</span>
                <select id="${fid}-format" ${attrs('format')}>
                  ${[['', 'Определить автоматически'], ['openai', 'OpenAI-совместимый'], ['anthropic', 'Anthropic (Claude)']]
                    .map(([val, label]) => `<option value="${val}" ${k.format === val ? 'selected' : ''}>${label}</option>`).join('')}
                </select>
              </label>` : ''}
            ${v.note ? `<p class="small muted" style="margin-top:6px">${esc(v.note)}</p>` : ''}
            ${canManage ? `
              <div class="row ai-extra-actions">
                <label class="row" style="gap:6px;align-items:center;margin:0;cursor:pointer">
                  <input type="checkbox" class="f-ai-x-on" data-i="${i}" style="width:auto" ${k.enabled ? 'checked' : ''}>
                  <span class="small">Включён</span>
                </label>
                <span class="grow"></span>
                ${i > 0 ? `<button class="btn-link f-ai-x-move" data-i="${i}" data-dir="-1" style="width:auto">↑ Выше</button>` : ''}
                ${i < st.extras.length - 1 ? `<button class="btn-link f-ai-x-move" data-i="${i}" data-dir="1" style="width:auto">↓ Ниже</button>` : ''}
                <button class="btn-link f-ai-x-del" data-i="${i}" style="width:auto;color:var(--danger)">Удалить</button>
              </div>` : ''}
          </div>`;
      };
      return `
        <div class="card">
          <div class="row" style="justify-content:space-between;align-items:center">
            <b>Дополнительные ключи</b>
            <span class="small muted">${st.extras.length} из ${AI_EXTRA_MAX}</span>
          </div>
          <p class="small muted" style="margin:6px 0 0">Закончились деньги, ключ отклонён или провайдер молчит — касса и приложение гостя
            сами берут следующий ключ: основной → резервный → дополнительные по порядку. Отказавший ключ на время уходит в конец
            очереди и не задерживает ответы. Можно добавить несколько ключей одного шлюза и любой свой шлюз.</p>
        </div>
        ${st.extras.map(card).join('')}
        ${canManage && st.extras.length < AI_EXTRA_MAX
          ? '<button class="btn btn-ghost" id="f-ai-x-add" style="width:auto;margin:0 0 14px">＋ Добавить ключ</button>' : ''}`;
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
          <p class="small" style="margin:6px 0 0">Ключа ещё нет? <a href="#" class="f-dash-tab" data-tab="guide" data-guide-q="где взять ключ">Где взять ключ и какую модель выбрать</a> — пошагово, с примером.</p>
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
        ${aiExtrasHtml(st)}
        ${canManage ? `
          <div class="row" style="gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" id="f-ai-save" style="width:auto">Сохранить</button>
            <button class="btn btn-ghost" id="f-ai-test" style="width:auto">Проверить все ключи</button>
          </div>` : '<p class="small muted">Менять настройки ИИ может владелец или администратор.</p>'}
        <div id="f-ai-msg" class="small" style="margin-top:10px;white-space:pre-line"></div>
        <p class="small muted">Тонкая настройка агентов (какие помощники включены, лимит ответа) — в кассе: Админ → Настройки ИИ.</p>
      `;
    };

    const guideTabHtml = () => {
      if (!guideData) {
        loadGuide().then(() => { if (activeTab === 'guide') draw(); })
          .catch(() => { guideLoadFailed = true; if (activeTab === 'guide') draw(); });
        return `<h2>Инструкция</h2>${guideLoadFailed
          ? '<div class="card"><p class="small">Не удалось загрузить инструкцию — проверьте интернет и обновите страницу.</p></div>'
          : '<div class="card"><div class="spinner"></div></div>'}`;
      }
      return `
        <h2>Инструкция</h2>
        <p class="small muted guide-intro">Как настроить заведение и работать в кассе каждый день. Найдите нужное через поиск или выберите раздел.</p>
        ${guideBodyHtml(guideOpen, true)}
        <div class="card guide-share">
          <div class="small"><b>Ссылка для сотрудников</b> — инструкция открывается без входа в кабинет:</div>
          <div class="row" style="justify-content:space-between;align-items:center;gap:10px;margin-top:6px">
            <code class="guide-share-url">${esc(GUIDE_PUBLIC_URL)}</code>
            <button class="btn-link" id="f-guide-copy" style="width:auto">Скопировать</button>
          </div>
        </div>
        <p class="small center muted">Не нашли ответ? <a href="#" class="f-dash-tab" data-tab="support">Напишите в поддержку</a></p>
      `;
    };

    const importHtml = () => {
      const I = importCore;
      const kinds = I ? I.KINDS : null;
      const log = importLog();
      const KIND_ORDER = ['menu', 'stock', 'recipes', 'staff', 'cards'];
      const LABEL = { menu: 'Меню', stock: 'Склад', recipes: 'Техкарты', staff: 'Сотрудники', cards: 'Скидочные карты' };
      const intro = `
        <h2>Перенос данных</h2>
        <div class="card">
          <p class="small" style="margin-top:0">Перенесите данные из прежней кассы — и касса ZalPOS сразу готова к работе:
          меню с ценами и категориями, склад с остатками и ценами закупки, техкарты, сотрудники с новыми PIN-кодами, скидочные карты.</p>
          <ol class="small muted" style="padding-left:18px;margin:8px 0">
            <li>В прежней системе выгрузите данные в Excel или CSV её штатной функцией «Экспорт» / «Выгрузить в Excel»: номенклатуру (меню), остатки склада, техкарты, сотрудников, дисконтные карты.</li>
            <li>Выберите сразу все файлы выгрузки (или одну книгу Excel, где меню, склад и сотрудники — на разных листах). Мы узнаем, что где, и перенесём по очереди: меню → склад → техкарты → сотрудники → карты.</li>
            <li>Проверьте, какие столбцы мы узнали, посмотрите предпросмотр и нажмите «Перенести». Ошибся — «Отменить перенос».</li>
          </ol>
          <p class="small muted" style="margin:0">Формат своей системы не подошёл — скачайте шаблон, вставьте в него столбцы из выгрузки и загрузите:
            ${KIND_ORDER.map((k) => `<a href="#" class="f-imp-template" data-kind="${k}">${LABEL[k]}</a>`).join(' · ')}</p>
        </div>
        <div class="card" style="margin-top:10px">
          <p class="small muted" style="margin:0"><b>Что не переносится и почему.</b> Телефоны, имена и бонусы гостей: согласие на обработку
          данных гости давали вашей прежней системе, а в ZalPOS гость подтверждает его сам, когда входит в приложение (152-ФЗ).
          История чеков остаётся в прежней системе и у вашего ОФД, отчёты ZalPOS начнутся с первого дня работы. PIN-коды не переносятся —
          создадим новые. Файл обрабатывается в вашем браузере; имена сотрудников сохраняются только на сервере в России.</p>
        </div>`;
      // На шагах проверки и итога — без вступления: кнопки ближе.
      const head = '<h2>Перенос данных</h2>';
      const history = log.length ? `
        <h2>Прошлые переносы</h2>
        <div class="card">
          ${log.map((x) => `
            <div class="row" style="justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--border);flex-wrap:wrap">
              <div class="grow small">${esc(LABEL[x.kind] || x.kind)} · ${fmtDateTime(Timestamp.fromMillis(x.at))}${x.file ? ` · ${esc(x.file)}` : ''}
                <div class="muted">создано ${x.created}${x.updated ? `, обновлено ${x.updated}` : ''}</div></div>
              ${canManage ? `<button class="btn-link f-imp-undo" data-id="${esc(x.id)}" style="width:auto">Отменить перенос</button>` : ''}
            </div>`).join('')}
        </div>` : '';
      if (!canManage) return `${intro}<p class="small muted">Переносить данные может владелец или администратор.</p>`;
      if (imp.step === 'pick' || !kinds) {
        return `${intro}
          <div class="card" style="margin-top:10px">
            <label class="field"><span>Файлы выгрузки: Excel (.xlsx, .xls), .ods, .xml или CSV — можно несколько сразу</span>
              <input type="file" id="f-imp-file" multiple accept=".xlsx,.xls,.ods,.xml,.htm,.html,.csv,.txt,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.spreadsheet"></label>
            ${imp.busy ? '<p class="small muted">Читаю файл…</p>' : ''}
            ${imp.error ? `<p class="small" style="color:var(--danger)">${esc(imp.error)}</p>` : ''}
          </div>${history}`;
      }
      if (imp.step === 'queue') {
        // Несколько файлов или листов: что где узнали — проверить и начать по очереди.
        return `${head}
          <div class="card" style="margin-top:10px">
            <div class="small" style="font-weight:600;margin-bottom:6px">Нашли данные для переноса: ${imp.queue.length}</div>
            <p class="small muted" style="margin-top:0">Перенесём по очереди. Каждую часть вы проверите в предпросмотре перед переносом.</p>
            ${imp.queue.map((q, i) => `
              <div class="row" style="gap:8px;align-items:center;padding:8px 0;border-top:1px solid var(--border);flex-wrap:wrap">
                <div class="grow small" style="min-width:160px">${esc(q.fileName)}${q.sheets.length > 1 ? ` · лист «${esc(q.sheets[q.sheetIdx].name)}»` : ''}
                  <div class="muted">${(() => { const n = q.sheets[q.sheetIdx].rows.length; const m10 = n % 10, m100 = n % 100; return `${n} ${m10 === 1 && m100 !== 11 ? 'строка' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'строки' : 'строк'}`; })()}</div></div>
                <select class="f-imp-qkind" data-i="${i}" style="width:auto">
                  <option value="">Пропустить</option>
                  ${KIND_ORDER.map((k) => `<option value="${k}" ${k === q.kind ? 'selected' : ''}>${LABEL[k]}</option>`).join('')}
                </select>
              </div>`).join('')}
            ${imp.error ? `<p class="small" style="color:var(--danger)">${esc(imp.error)}</p>` : ''}
            <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
              <button class="btn btn-ghost" id="f-imp-back" style="width:auto">Другие файлы</button>
              <button class="btn btn-primary" id="f-imp-qstart" style="width:auto">Начать перенос по очереди</button>
            </div>
          </div>${history}`;
      }
      const sheet = imp.sheets[imp.sheetIdx];
      const headers = sheet.rows[imp.headerIdx] || [];
      const def = kinds[imp.kind];
      const colOpts = (sel) => `<option value="">— нет —</option>${headers.map((h, i) => `<option value="${i}" ${String(sel) === String(i) ? 'selected' : ''}>${esc(h || `Столбец ${i + 1}`)}</option>`).join('')}`;
      if (imp.step === 'map') {
        return `${head}
          <div class="card" style="margin-top:10px">
            <div class="small" style="font-weight:600;margin-bottom:8px">${imp.queue ? `Часть ${imp.qi + 1} из ${imp.queue.length} · ` : ''}${esc(imp.fileName)}</div>
            ${imp.sheets.length > 1 ? `<label class="field"><span>Лист</span><select id="f-imp-sheet">${imp.sheets.map((sh, i) => `<option value="${i}" ${i === imp.sheetIdx ? 'selected' : ''}>${esc(sh.name)} (${sh.rows.length} строк)</option>`).join('')}</select></label>` : ''}
            <label class="field"><span>Что в файле</span><select id="f-imp-kind">${KIND_ORDER.map((k) => `<option value="${k}" ${k === imp.kind ? 'selected' : ''}>${LABEL[k]}</option>`).join('')}</select></label>
            <p class="small muted" style="margin-top:-4px">${esc(def.hint)}</p>
            <label class="field"><span>Строка с названиями столбцов</span><input type="number" id="f-imp-header" min="1" max="${sheet.rows.length}" value="${imp.headerIdx + 1}"></label>
            <div class="small" style="font-weight:600;margin:10px 0 6px">Какой столбец что значит</div>
            ${def.fields.map((f) => `<label class="field"><span>${esc(f.label)}${f.required ? ' *' : ''}</span><select class="f-imp-map" data-field="${f.key}">${colOpts(imp.map[f.key])}</select></label>`).join('')}
            ${imp.kind !== 'staff' ? `<label class="small" style="display:flex;gap:8px;align-items:flex-start;margin-top:8px">
              <input type="checkbox" id="f-imp-update" ${imp.update ? 'checked' : ''} style="width:auto;margin-top:2px">
              <span>${{ menu: 'Позиции с тем же названием обновить: цена, категория, описание', stock: 'Продукты с тем же названием обновить: остаток, цена закупки, минимум', recipes: 'Заменить рецепт у блюд, где он уже есть', cards: 'У карт с тем же номером обновить скидку' }[imp.kind]}. Иначе — пропустить.</span></label>` : ''}
            ${imp.error ? `<p class="small" style="color:var(--danger)">${esc(imp.error)}</p>` : ''}
            <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
              <button class="btn btn-ghost" id="f-imp-back" style="width:auto">${imp.queue ? 'Другие файлы' : 'Другой файл'}</button>
              ${imp.queue && imp.qi + 1 < imp.queue.length ? '<button class="btn btn-ghost" id="f-imp-qskip" style="width:auto">Пропустить эту часть</button>' : ''}
              <button class="btn btn-primary" id="f-imp-preview" style="width:auto">Предпросмотр</button>
            </div>
          </div>${history}`;
      }
      const plan = imp.plan;
      if (imp.step === 'preview') {
        const sample = plan.create.slice(0, 8);
        const line = (x) => ({
          menu: () => `${esc(x.name)} — ${rub(x.price)} · ${esc(x.category)}`,
          stock: () => `${esc(x.name)} — ${x.quantity} ${x.unit}${x.cost ? ` · ${rub(x.cost)} за ${{ g: 'кг', ml: 'л' }[x.unit] || x.unit}` : ''}`,
          recipes: () => `${esc(x.dish)}: ${x.lines.map((l) => `${esc(l.ingredient)} ${l.amount} ${l.unit}`).join(', ')}${x.portions > 1 ? ` · на ${x.portions} порц.` : ''}`,
          staff: () => `${esc(x.name)} — ${x.role === 'admin' ? 'администратор' : 'сотрудник'}`,
          cards: () => `Карта ${esc(x.number)} — ${x.percent} %`,
        }[plan.kind])();
        const errs = [...imp.rowErrors.map((e) => `Строка ${e.row}: ${e.msg}`), ...plan.errors.map((e) => e.msg)];
        // Без всех отметок «Перенести» не нажимается; коды — в журнале на сервере.
        const consents = IMPORT_CONSENTS.filter((c) => !c.staff || plan.kind === 'staff');
        const consentOk = consents.every((c) => imp.consent && imp.consent[c.id]);
        return `${head}
          <div class="card" style="margin-top:10px">
            <div class="small" style="font-weight:600">${esc(LABEL[plan.kind])} · ${esc(imp.fileName)}</div>
            <p class="small" style="margin:8px 0">Создадим: <b>${plan.create.length}</b>${plan.newCategories.length ? ` (новых категорий: ${plan.newCategories.length})` : ''}${plan.newStock.length ? ` · новых продуктов на складе: ${plan.newStock.length}` : ''}
              · обновим: <b>${plan.update.length}</b> · пропустим: <b>${plan.skip.length}</b>${errs.length ? ` · с ошибками: <b>${errs.length}</b>` : ''}</p>
            ${sample.length ? `<ul class="small" style="padding-left:18px;margin:6px 0">${sample.map((x) => `<li>${line(x)}</li>`).join('')}${plan.create.length > sample.length ? `<li class="muted">и ещё ${plan.create.length - sample.length}</li>` : ''}</ul>` : ''}
            ${plan.skip.length ? `<details class="small muted"><summary>Что пропустим</summary>${plan.skip.slice(0, 50).map((x) => `<div>${esc(x.name || x.dish || x.number)} — ${esc(x.why)}</div>`).join('')}</details>` : ''}
            ${errs.length ? `<details class="small" style="color:var(--danger)" open><summary>Ошибки — эти строки не перенесём</summary>${errs.slice(0, 50).map((m) => `<div>${esc(m)}</div>`).join('')}${errs.length > 50 ? `<div>и ещё ${errs.length - 50}</div>` : ''}</details>` : ''}
            ${plan.kind === 'staff' ? '<p class="small muted">Каждому создадим новый PIN: сотруднику — 4 цифры, администратору — 6. Список покажем один раз — сохраните его и раздайте лично.</p>' : ''}
            <div class="imp-warn small">
              <b>Перенос может быть неполным.</b> Выгрузки разных систем устроены по-разному: мы переносим только то, что показано
              выше. ${esc(IMPORT_NOT_MOVED[plan.kind])} Перед началом работы проверьте результат в кассе.
            </div>
            ${consents.map((c) => `
              <label class="consent-row">
                <input type="checkbox" class="f-imp-consent" data-id="${c.id}" ${imp.consent && imp.consent[c.id] ? 'checked' : ''} ${imp.busy ? 'disabled' : ''}>
                <span class="consent-text"><span>${esc(c.title)}</span><span class="small muted">${c.text}</span></span>
              </label>`).join('')}
            ${imp.progress ? `<p class="small muted">${esc(imp.progress)}</p>` : ''}
            ${imp.error ? `<p class="small" style="color:var(--danger)">${esc(imp.error)}</p>` : ''}
            <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
              <button class="btn btn-ghost" id="f-imp-edit" style="width:auto" ${imp.busy ? 'disabled' : ''}>Назад</button>
              <button class="btn btn-primary" id="f-imp-run" style="width:auto" ${imp.busy || !consentOk || !(plan.create.length + plan.update.length) ? 'disabled' : ''}>${imp.busy ? 'Переношу…' : 'Перенести'}</button>
            </div>
          </div>${history}`;
      }
      const r = imp.result;
      return `${head}
        <div class="card" style="margin-top:10px">
          <div class="small" style="font-weight:600">Готово: ${esc(LABEL[plan.kind])}</div>
          <p class="small" style="margin:8px 0">Создано: <b>${r.created}</b>${r.updated ? ` · обновлено: <b>${r.updated}</b>` : ''}. Касса подхватит изменения в течение нескольких минут — или перезапустите её.</p>
          ${r.warnings.map((w) => `<p class="small" style="color:var(--warning);margin:4px 0">${esc(w)}</p>`).join('')}
          ${r.pins.length ? `
            <div class="small" style="font-weight:600;margin-top:10px">PIN-коды для входа в кассу — сохраните сейчас, больше не покажем</div>
            <div id="f-imp-pins" class="small" style="margin:6px 0;font-family:ui-monospace,monospace">${r.pins.map((x) => `<div>${esc(x.name)} — ${x.role === 'admin' ? 'администратор' : 'сотрудник'} — ${x.pin}</div>`).join('')}</div>
            <button class="btn btn-ghost" id="f-imp-copy-pins" style="width:auto">Скопировать список</button>` : ''}
          <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
            ${imp.queue && imp.qi + 1 < imp.queue.length
              ? `<button class="btn btn-primary" id="f-imp-qnext" style="width:auto">Дальше: ${esc(LABEL[imp.queue[imp.qi + 1].kind])} (${imp.qi + 2} из ${imp.queue.length})</button>`
              : '<button class="btn btn-primary" id="f-imp-next" style="width:auto">Перенести ещё файл</button>'}
          </div>
        </div>${history}`;
    };

    const TAB_RENDERERS = {
      overview: overviewHtml, guide: guideTabHtml, devices: devicesHtml, billing: billingHtml, plans: plansHtml,
      branding: brandingHtml, team: teamHtml, ai: aiHtml, profile: profileHtml, settings: settingsHtml,
      faq: faqHtml, support: supportHtml, import: importHtml,
    };
    renderKeepingInputs(body, (TAB_RENDERERS[activeTab] || overviewHtml)() + dashboardNavHtml(activeTab, daysLeft !== null, tenant.name, tenant.chainId));
    // В кабинете кнопки чата нет: у него есть раздел «Поддержка».
    setSupportChat({ mode: 'hidden' });

    document.querySelectorAll('.f-dash-tab').forEach((el) => {
      el.onclick = (e) => {
        e.preventDefault();
        if (activeTab !== el.dataset.tab) window.scrollTo(0, 0);
        activeTab = el.dataset.tab;
        // Ссылка на конкретную статью: инструкция откроется с поиском по ней.
        if (el.dataset.guideQ) guidePendingQuery = el.dataset.guideQ;
        draw();
      };
    });
    if (activeTab === 'import') {
      if (!importCore) loadImportCore().then(draw).catch((e) => { imp.error = `Не загрузился модуль переноса: ${e?.message || e}`; draw(); });
      const I = importCore;
      // Модуль мог догрузиться после этой отрисовки — берём актуальный.
      const toMap = (kind = '') => {
        const core = importCore;
        const sheet = imp.sheets[imp.sheetIdx];
        imp.headerIdx = core.findHeader(sheet.rows);
        imp.kind = kind || core.guessKind(sheet.rows[imp.headerIdx]) || imp.kind || 'menu';
        imp.map = core.guessMapping(imp.kind, sheet.rows[imp.headerIdx]);
      };
      // Часть очереди «всё сразу» — обычные шаги: столбцы → предпросмотр → перенос.
      const startPart = (queue, qi) => {
        const q = queue[qi];
        imp = { step: 'map', fileName: q.fileName, sheets: q.sheets, sheetIdx: q.sheetIdx, update: false, queue, qi };
        toMap(q.kind);
        draw();
      };
      document.querySelectorAll('.f-imp-template').forEach((el) => {
        el.onclick = async (e) => {
          e.preventDefault();
          const core = await loadImportCore();
          const blob = new Blob([core.templateCsv(el.dataset.kind)], { type: 'text/csv;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `zalpos-${el.dataset.kind}.csv`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        };
      });
      if ($('f-imp-file')) {
        $('f-imp-file').onchange = async (e) => {
          const files = [...(e.target.files || [])].slice(0, 10);
          if (!files.length) return;
          imp = { step: 'pick', busy: true };
          draw();
          try {
            const core = await loadImportCore();
            const ORDER = ['menu', 'stock', 'recipes', 'staff', 'cards'];
            const parts = [];
            const failed = [];
            for (const file of files) {
              try {
                if (file.size > 15 * 1024 * 1024) throw new Error('больше 15 МБ — выгрузите данные частями');
                const sheets = await core.readTable(new Uint8Array(await file.arrayBuffer()), file.name);
                // Каждый лист со строками — отдельная часть; что в нём, угадываем по заголовкам.
                const found = sheets.map((sh, i) => ({ sh, i })).filter(({ sh }) => sh.rows.length > 1).map(({ sh, i }) => ({
                  fileName: file.name, sheets, sheetIdx: i, kind: core.guessKind(sh.rows[core.findHeader(sh.rows)]) || '',
                }));
                const known = found.filter((x) => x.kind);
                parts.push(...(known.length ? known : found.slice(0, 1)));
              } catch (err) {
                failed.push(`${file.name}: ${err?.message || err}`);
              }
            }
            if (!parts.length) throw new Error(failed.join('; ') || 'в файлах нет строк');
            if (parts.length === 1 && !failed.length) {
              const [q] = parts;
              imp = { step: 'map', fileName: q.fileName, sheets: q.sheets, sheetIdx: q.sheetIdx, update: false };
              toMap(q.kind);
            } else {
              parts.sort((a, b) => (ORDER.indexOf(a.kind) + 1 || 99) - (ORDER.indexOf(b.kind) + 1 || 99));
              imp = { step: 'queue', queue: parts, error: failed.length ? `Не прочитали: ${failed.join('; ')}` : '' };
            }
          } catch (err) {
            imp = { step: 'pick', error: `Не получилось прочитать файл: ${err?.message || err}` };
          }
          draw();
        };
      }
      if ($('f-imp-sheet')) $('f-imp-sheet').onchange = (e) => { imp.sheetIdx = Number(e.target.value) || 0; toMap(); draw(); };
      if ($('f-imp-kind')) $('f-imp-kind').onchange = (e) => { imp.kind = e.target.value; imp.map = I.guessMapping(imp.kind, imp.sheets[imp.sheetIdx].rows[imp.headerIdx] || []); draw(); };
      if ($('f-imp-header')) $('f-imp-header').onchange = (e) => {
        const rows = imp.sheets[imp.sheetIdx].rows;
        imp.headerIdx = Math.min(rows.length - 1, Math.max(0, (Number(e.target.value) || 1) - 1));
        imp.map = I.guessMapping(imp.kind, rows[imp.headerIdx]);
        draw();
      };
      document.querySelectorAll('.f-imp-map').forEach((el) => {
        el.onchange = () => {
          if (el.value === '') delete imp.map[el.dataset.field];
          else imp.map[el.dataset.field] = Number(el.value);
        };
      });
      if ($('f-imp-update')) $('f-imp-update').onchange = (e) => { imp.update = e.target.checked; };
      if ($('f-imp-back')) $('f-imp-back').onclick = () => { imp = { step: 'pick' }; draw(); };
      if ($('f-imp-edit')) $('f-imp-edit').onclick = () => { imp.step = 'map'; imp.error = ''; draw(); };
      if ($('f-imp-next')) $('f-imp-next').onclick = () => { imp = { step: 'pick' }; draw(); };
      document.querySelectorAll('.f-imp-qkind').forEach((el) => {
        el.onchange = () => { imp.queue[Number(el.dataset.i)].kind = el.value; };
      });
      if ($('f-imp-qstart')) $('f-imp-qstart').onclick = () => {
        const ORDER = ['menu', 'stock', 'recipes', 'staff', 'cards'];
        const queue = imp.queue.filter((q) => q.kind).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
        if (!queue.length) { imp.error = 'Выберите, что в файлах, хотя бы для одной части'; draw(); return; }
        startPart(queue, 0);
      };
      if ($('f-imp-qnext')) $('f-imp-qnext').onclick = () => startPart(imp.queue, imp.qi + 1);
      if ($('f-imp-qskip')) $('f-imp-qskip').onclick = () => startPart(imp.queue, imp.qi + 1);
      if ($('f-imp-preview')) {
        $('f-imp-preview').onclick = async () => {
          imp.error = '';
          const missing = I.KINDS[imp.kind].fields.filter((f) => f.required && imp.map[f.key] == null);
          if (missing.length) { imp.error = `Выберите столбец: ${missing.map((f) => f.label).join(', ')}`; draw(); return; }
          const rows = imp.sheets[imp.sheetIdx].rows.slice(imp.headerIdx + 1);
          const { items, errors } = I.buildRows(imp.kind, rows, imp.map, { headerIndex: imp.headerIdx });
          if (!items.length) { imp.error = 'В файле не нашлось строк для переноса — проверьте столбцы и строку заголовков'; draw(); return; }
          try {
            imp.existing = await importExisting();
            imp.plan = I.planImport(imp.kind, items, imp.existing, { update: imp.update });
            imp.rowErrors = errors;
            imp.consent = {};
            imp.step = 'preview';
          } catch (err) {
            imp.error = `Не получилось проверить данные заведения: ${err?.message || err}`;
          }
          draw();
        };
      }
      document.querySelectorAll('.f-imp-consent').forEach((el) => {
        el.onchange = () => { imp.consent = { ...(imp.consent || {}), [el.dataset.id]: el.checked }; draw(); };
      });
      if ($('f-imp-run')) {
        $('f-imp-run').onclick = async () => {
          imp.busy = true;
          imp.error = '';
          draw();
          try {
            imp.result = await runImport(imp.plan, imp.existing);
            imp.step = 'done';
          } catch (err) {
            imp.error = `Перенос прервался: ${err?.message || err}. Уже записанное можно отменить в «Прошлых переносах».`;
          }
          imp.busy = false;
          imp.progress = '';
          draw();
        };
      }
      if ($('f-imp-copy-pins')) $('f-imp-copy-pins').onclick = () => copyToClipboard(imp.result.pins.map((x) => `${x.name} — ${x.role === 'admin' ? 'администратор' : 'сотрудник'} — PIN ${x.pin}`).join('\n'));
      document.querySelectorAll('.f-imp-undo').forEach((el) => {
        el.onclick = async () => {
          if (!confirm('Отменить перенос? Созданные им позиции, продукты, сотрудники и карты удалятся, перенесённые рецепты снимутся. Обновлённые цены и остатки не вернутся.')) return;
          el.disabled = true;
          try {
            const n = await undoImport(el.dataset.id);
            toast(`Перенос отменён: изменений — ${n}`);
          } catch (err) {
            toast(`Не удалось отменить: ${err?.message || err}`);
          }
          draw();
        };
      });
    }
    if (activeTab === 'guide' && guideData) {
      bindGuide(body, guideOpen);
      if ($('f-guide-copy')) $('f-guide-copy').onclick = () => copyToClipboard(GUIDE_PUBLIC_URL);
    }
    // Название для кабинета и панели платформы; в приложениях — своё, из
    // «Брендинга». Правила дают владельцу менять в документе только name.
    if ($('f-copy-slug')) $('f-copy-slug').onclick = () => copyToClipboard(tenant.slug || '');
    if ($('f-tg-box')) bindTelegramBox(tenantId, draw);
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

      // Дополнительные ключи.
      const extraAt = (el) => ensureDraft().extras[Number(el.dataset.i)];
      document.querySelectorAll('.f-ai-x').forEach((el) => {
        el.oninput = el.onchange = (e) => {
          const k = extraAt(el);
          if (!k) return;
          k[el.dataset.field] = el.value.trim();
          // Другой шлюз — другие подсказки и поля (адрес, формат).
          if (el.dataset.field === 'vendor' && e.type === 'change') draw();
        };
      });
      document.querySelectorAll('.f-ai-x-on').forEach((el) => {
        el.onchange = () => { const k = extraAt(el); if (k) { k.enabled = el.checked; draw(); } };
      });
      document.querySelectorAll('.f-ai-x-move').forEach((el) => {
        el.onclick = () => {
          const list = ensureDraft().extras;
          const i = Number(el.dataset.i);
          const j = i + Number(el.dataset.dir);
          if (j < 0 || j >= list.length) return;
          [list[i], list[j]] = [list[j], list[i]];
          draw();
        };
      });
      document.querySelectorAll('.f-ai-x-del').forEach((el) => {
        el.onclick = () => {
          const d = ensureDraft();
          const k = d.extras[Number(el.dataset.i)];
          if (!k || !window.confirm(`Удалить ключ «${aiExtraVendor(k.vendor).title}»? Он перестанет работать после сохранения.`)) return;
          d.extras.splice(Number(el.dataset.i), 1);
          d.removedExtras.push(k.id);
          draw();
        };
      });
      if ($('f-ai-x-add')) $('f-ai-x-add').onclick = () => {
        const d = ensureDraft();
        if (d.extras.length >= AI_EXTRA_MAX) return;
        const id = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        // По умолчанию — тот же шлюз, что основной: чаще всего докупают второй ключ к нему.
        d.extras.push({ id, vendor: d.vendor, model: '', analyticsModel: '', format: '', enabled: true, hasKey: false, apiKey: '', baseUrl: '' });
        draw();
        const input = document.getElementById(`f-ai-x-${id}-key`);
        if (input) { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); input.focus({ preventScroll: true }); }
      };

      const saveAi = async () => {
        const d = ensureDraft();
        const main = d.vendors[d.vendor];
        if (d.enabled && !main.hasKey && !main.apiKey) throw new Error('Укажите API-ключ основного провайдера');
        if (d.vendor === 'custom' && !main.baseUrl) throw new Error('Для своего шлюза нужен «Адрес API»');
        const base = aiExtraBase(d);
        d.extras.forEach((k, i) => {
          if (k.enabled && !k.hasKey && !k.apiKey) throw new Error(`Ключ ${base + i + 1}: укажите API-ключ или выключите его`);
          if (k.vendor === 'custom' && !k.baseUrl) throw new Error(`Ключ ${base + i + 1}: для своего шлюза нужен «Адрес API»`);
        });
        const secExtras = {};
        d.extras.forEach((k) => { secExtras[k.id] = { baseUrl: k.baseUrl || '', ...(k.apiKey ? { apiKey: k.apiKey } : {}) }; });
        (d.removedExtras || []).forEach((id) => { if (!secExtras[id]) secExtras[id] = deleteField(); });
        const pubExtras = d.extras.map((k) => ({
          id: k.id, vendor: k.vendor, format: k.vendor === 'custom' ? (k.format || '') : '', model: k.model || '',
          analyticsModel: k.analyticsModel || '', enabled: k.enabled !== false, hasKey: !!(k.hasKey || k.apiKey),
        }));
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
        await setDoc(doc(state.db, ...aiRoot(), 'meta', 'aiSecrets'), { vendors: secVendors, extraKeys: secExtras }, { merge: true });
        const del = deleteField();
        await setDoc(doc(state.db, ...aiRoot(), 'meta', 'aiSettings'), {
          enabled: d.enabled, vendor: d.vendor, fallbackVendor: d.fallbackVendor || '', vendors: pubVendors,
          extraKeys: pubExtras, updatedAt: Timestamp.fromDate(new Date()),
          apiKey: del, baseUrl: del, provider: del, model: del, analyticsModel: del, vendorKeys: del,
        }, { merge: true });
        aiDraft = null;
        // Сохранённый ключ в поле не держим — иначе перерисовка вернёт его туда.
        document.querySelectorAll('.f-ai-input[data-field="apiKey"], .f-ai-x[data-field="apiKey"]').forEach((el) => { el.value = ''; });
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
        aiMsg('Проверяю ключи…');
        try {
          if (aiDraft) await saveAi();
          const st = aiState();
          if (!st.enabled) throw new Error('Сначала включите ИИ и сохраните');
          // Все ключи очереди: основной, резервный и включённые дополнительные.
          const slots = [{ slot: 'primary', label: `1 · ${aiVendor(st.vendor).title}`,
            anthropic: st.vendor === 'custom' && st.vendors.custom.format === 'anthropic' }];
          const fb = st.fallbackVendor && st.fallbackVendor !== st.vendor ? st.fallbackVendor : '';
          if (fb && st.vendors[fb]?.hasKey) {
            slots.push({ slot: 'fallback', label: `2 · ${aiVendor(fb).title}`, anthropic: fb === 'custom' && st.vendors.custom.format === 'anthropic' });
          }
          const base = aiExtraBase(st);
          st.extras.forEach((k, i) => {
            if (k.enabled && k.hasKey) {
              slots.push({ slot: `extra:${k.id}`, label: `${base + i + 1} · ${aiExtraVendor(k.vendor).title}`, anthropic: aiExtraIsAnthropic(k) });
            }
          });
          const idToken = await state.auth.currentUser?.getIdToken();
          const check = async (s) => {
            try {
              const res = await fetch(`${SAAS_GATEWAY_URL}/aiProxy`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
                body: JSON.stringify({
                  tenantId, slot: s.slot, format: s.anthropic ? 'anthropic' : 'openai',
                  path: s.anthropic ? 'v1/messages' : 'chat/completions',
                  body: { messages: [{ role: 'user', content: 'Ответь одним словом: OK' }], max_tokens: 256 },
                }),
              });
              const json = await res.json().catch(() => null);
              if (!res.ok) {
                const err = json?.error;
                throw new Error(typeof err === 'string' ? err : (err?.message || `провайдер ответил ${res.status}`));
              }
              const text = json?.choices?.[0]?.message?.content ?? json?.content?.[0]?.text ?? '';
              return { ok: true, line: `✓ ${s.label} — отвечает${text ? ` «${String(text).slice(0, 40)}»` : ''}` };
            } catch (e) {
              return { ok: false, line: `✕ ${s.label} — ${e?.message || e}` };
            }
          };
          const results = await Promise.all(slots.map(check));
          const okCount = results.filter((r) => r.ok).length;
          const head = okCount === results.length
            ? (results.length > 1 ? `Все ключи работают (${okCount})` : 'Связь есть')
            : (okCount ? `Работают ${okCount} из ${results.length} — ИИ ответит через рабочие` : 'Ни один ключ не ответил');
          aiMsg(`${head}\n${results.map((r) => r.line).join('\n')}`, okCount === results.length);
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
    if (activeTab === 'support') {
      bindAttachments(body);
      bindAttachPicker({ button: $('f-ticket-attach'), input: $('f-ticket-files'), pasteInto: $('f-ticket-message'), list: ticketDraftFiles, redraw: draw });
      bindAttachPicker({ button: $('f-reply-attach'), input: $('f-reply-files'), pasteInto: $('f-ticket-reply'), list: replyDraftFiles, redraw: draw });
      document.querySelectorAll('.f-new-rm, .f-reply-rm').forEach((el) => {
        el.onclick = () => {
          const list = el.classList.contains('f-new-rm') ? ticketDraftFiles : replyDraftFiles;
          const [gone] = list.splice(Number(el.dataset.i), 1);
          if (gone && gone.preview) URL.revokeObjectURL(gone.preview);
          draw();
        };
      });
    }
    if ($('f-ticket-create')) {
      $('f-ticket-create').onclick = async () => {
        const subjectEl = $('f-ticket-subject');
        const messageEl = $('f-ticket-message');
        const subject = subjectEl.value.trim();
        const text = messageEl.value.trim();
        if (!subject || (!text && !ticketDraftFiles.length)) {
          toast('Заполните тему и сообщение');
          return;
        }
        if (!$('f-ticket-consent').checked) {
          toast('Отметьте согласие на обработку данных обращения — без него поддержка не сможет ответить');
          return;
        }
        rememberSupportConsent();
        const btn = $('f-ticket-create');
        btn.disabled = true;
        try {
          // Через сервер в РФ: тема и текст обезличиваются до записи в базу
          // (согласие по ч. 1 ст. 9 152-ФЗ — с редакцией текста).
          const withFiles = ticketDraftFiles.length > 0;
          const created = await callSaasGateway('supportSend', {
            tenantId, subject, consent: true, consentEdition: LEGAL_EDITION, ...(withFiles ? {} : { text }),
          });
          const ticketId = created.data.ticketId;
          let masked = created.data.masked;
          let uploadError = '';
          if (withFiles) {
            btn.textContent = 'Загружаю файлы…';
            const attachments = await uploadSupportFiles(ticketId, ticketDraftFiles).catch((e) => { uploadError = e?.message || String(e); return []; });
            if (text || attachments.length) {
              const sent = await callSaasGateway('supportSend', { ticketId, text, attachments });
              masked = masked || sent.data.masked;
            }
          }
          if (!uploadError) dropPreviews(ticketDraftFiles);
          ticketDraftFiles.splice(0);
          if ($('f-ticket-subject')) $('f-ticket-subject').value = '';
          if ($('f-ticket-message')) $('f-ticket-message').value = '';
          toast(uploadError ? `Обращение создано, но файл не загрузился: ${uploadError}`
            : masked ? 'Обращение создано. Личные данные в тексте скрыты — они не нужны поддержке' : 'Обращение создано');
          await loadSupportTickets();
          selectTicket(ticketId);
        } catch (e) {
          toast(`Не удалось создать обращение: ${e?.message || e}`);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Создать обращение';
        }
      };
    }
    if ($('f-ticket-reply-send')) {
      $('f-ticket-reply-send').onclick = async () => {
        const replyEl = $('f-ticket-reply');
        const text = replyEl.value.trim();
        if ((!text && !replyDraftFiles.length) || !selectedTicket || replySending) return;
        const ticket = selectedTicket;
        // Форму очищаем сразу — видно, что сообщение ушло; при ошибке вернём.
        const files = replyDraftFiles.splice(0);
        replySending = files.length ? 'Загружаю файлы…' : 'Отправляю…';
        replyEl.value = '';
        draw();
        try {
          const attachments = files.length ? await uploadSupportFiles(ticket.id, files) : [];
          // Через сервер в РФ: текст обезличивается до записи в базу.
          const sent = await callSaasGateway('supportSend', { ticketId: ticket.id, text, attachments });
          if (sent.data.masked) toast('Личные данные в тексте скрыты — они не нужны поддержке');
          // Ответ ассистента обычно приходит за 5–30 с — проверяем чаще.
          ticketPollFastUntil = Date.now() + 3 * 60 * 1000;
          ticketSeenAt = 0;
          ticketPoll();
          dropPreviews(files);
        } catch (e) {
          replyDraftFiles.unshift(...files);
          const el = $('f-ticket-reply');
          if (el && !el.value.trim()) el.value = text;
          toast(`Не удалось отправить: ${e?.message || e}`);
        } finally {
          replySending = '';
          draw();
        }
      };
    }
    if ($('f-ticket-toggle-status')) {
      $('f-ticket-toggle-status').onclick = async () => {
        if (!selectedTicket) return;
        try {
          await callSaasGateway('supportTicketStatus', { ticketId: selectedTicket.id, status: selectedTicket.status === 'closed' ? 'open' : 'closed' });
          await loadSupportTickets();
          ticketSeenAt = 0;
          ticketPoll(0);
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
    if ($('f-delivery-mode')) {
      $('f-delivery-mode').onchange = async (e) => {
        const on = e.target.checked;
        e.target.disabled = true;
        try {
          await setDoc(doc(state.db, 'tenants', tenantId, 'meta', 'venueProfile'), { deliveryEnabled: on }, { merge: true });
          toast(on ? 'С собой и доставка включены на кассах' : 'С собой и доставка выключены');
        } catch (err) {
          e.target.checked = !on;
          toast(`Не удалось сохранить: ${err?.message || err}`);
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
    document.querySelectorAll('[data-device-remove]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(`Удалить «${btn.dataset.name}»? Касса на этом устройстве перестанет работать, место по тарифу освободится. Вернуть его можно кнопкой «Восстановить».`)) return;
        btn.disabled = true;
        try {
          await callSaasGateway('removeDevice', { tenantId, uid: btn.dataset.deviceRemove });
          toast('Устройство удалено');
        } catch (e) {
          toast(e?.message || String(e));
          btn.disabled = false;
        }
      };
    });
    document.querySelectorAll('[data-device-restore]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await callSaasGateway('restoreDevice', { tenantId, uid: btn.dataset.deviceRestore });
          toast(`«${btn.dataset.name}» восстановлено — касса на нём снова работает`);
        } catch (e) {
          toast(e?.message || String(e));
          btn.disabled = false;
        }
      };
    });
    document.querySelectorAll('[data-device-rename]').forEach((btn) => {
      btn.onclick = async () => {
        const name = prompt('Как назвать устройство? Например: «Планшет на кухне», «Касса на баре», «Телефон Ани»', btn.dataset.name || '');
        if (name === null) return;
        try {
          await updateDoc(doc(state.db, 'tenants', tenantId, 'devices', btn.dataset.deviceRename), { deviceName: name.trim().slice(0, 40) });
          toast('Название сохранено');
        } catch (e) {
          toast(`Не удалось сохранить: ${e?.message || e}`);
        }
      };
    });
    document.querySelectorAll('[data-device-toggle]').forEach((btn) => {
      btn.onclick = async () => {
        const enable = btn.dataset.enable === '1';
        if (!enable && !confirm('Отключить кассу на этом устройстве? Она перестанет работать, пока вы не включите её снова.')) return;
        btn.disabled = true;
        try {
          await callSaasGateway(enable ? 'enableDevice' : 'disableDevice', { tenantId, uid: btn.dataset.deviceToggle });
          toast(enable ? 'Касса включена' : 'Касса отключена');
        } catch (e) {
          toast(e?.message || String(e));
          btn.disabled = false;
        }
      };
    });
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

    document.querySelectorAll('.f-emp-edit').forEach((el) => {
      el.onclick = () => {
        const emp = (employees || []).find((x) => x.id === el.dataset.id);
        if (!emp) return;
        editingEmployeeId = emp.id;
        // Заполняем текущие поля — draw() перенесёт значения в новую разметку.
        if ($('f-emp-name')) $('f-emp-name').value = empName(emp);
        if ($('f-emp-role')) $('f-emp-role').value = emp.role || 'employee';
        // PIN хранится хэшем: пустое поле при правке — оставить прежний.
        if ($('f-emp-pin')) $('f-emp-pin').value = '';
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
        const editing = editingEmployeeId ? (employees || []).find((e) => e.id === editingEmployeeId) : null;
        // При правке без смены роли пустой PIN — оставить прежний.
        const keepPin = !pin && editing && (editing.role || 'employee') === role && (editing.pinHash || editing.pinCode);
        if (!keepPin && (!/^\d+$/.test(pin) || pin.length !== requiredLen)) {
          errEl.textContent = `PIN-код должен состоять ровно из ${requiredLen} цифр`;
          return;
        }
        $('f-emp-submit').disabled = true;
        try {
          const pinHash = pin ? await hashEmployeePin(pin, tenantId) : '';
          if (pin && (employees || []).some((e) => e.id !== editingEmployeeId && (e.pinHash === pinHash || e.pinCode === pin))) {
            errEl.textContent = 'Этот PIN-код уже занят другим сотрудником';
            return;
          }
          // Режим rf: имя — только в справочник в РФ и до записи в Firestore
          // (не записалось — сотрудника не сохраняем); в документе — id.
          const rf = rfMode();
          if (editingEmployeeId) {
            if (rf) {
              await piiCall({ tenantId, kind: 'pii_put', items: [{ k: 'staff', id: editingEmployeeId, fields: { name } }] });
              staffNames.set(editingEmployeeId, name);
            }
            const upd = { name: rf ? deleteField() : name, role, position };
            if (pinHash) Object.assign(upd, { pinHash, pinCode: deleteField() });
            await updateDoc(doc(state.db, 'tenants', tenantId, 'employees', editingEmployeeId), upd);
            toast('Сотрудник обновлён');
          } else {
            const ref = doc(collection(state.db, 'tenants', tenantId, 'employees'));
            if (rf) {
              await piiCall({ tenantId, kind: 'pii_put', items: [{ k: 'staff', id: ref.id, fields: { name } }] });
              staffNames.set(ref.id, name);
            }
            // Остальные поля — дефолты Employee() из lib/models/employee.dart.
            await setDoc(ref, {
              ...(rf ? {} : { name }), role, pinHash, position,
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
    document.querySelectorAll('.f-convert-to-single').forEach((el) => {
      el.onclick = async () => {
        if (!confirm(`Перевести сеть на тариф «${el.dataset.name}» для одного заведения? Оплаченный срок сохранится, гости и бонусы останутся в заведении. Добавить точки потом можно, снова перейдя на тариф сети.`)) return;
        el.disabled = true;
        try {
          await callSaasGateway('convertChainToSingle', { tenantId, planId: el.dataset.plan });
          const entry = state.tenants.find((t) => t.id === tenantId);
          if (entry) { entry.chainId = null; entry.chainName = ''; }
          toast('Готово: заведение на обычном тарифе');
          route();
        } catch (e) {
          el.disabled = false;
          toast(`Не удалось перейти: ${e?.message || e}`);
        }
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
  sub(onSnapshot(collection(state.db, 'tenants', tenantId, 'devices'), (snap) => {
    devices = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  }, () => {}));
  sub(onSnapshot(doc(state.db, 'tenants', tenantId, 'settings', 'general'), (d) => {
    generalSettings = d.exists() ? d.data() : null;
    draw();
  }, () => {}));
  sub(onSnapshot(doc(state.db, 'tenants', tenantId, 'meta', 'venueProfile'), (d) => {
    venueProfile = d.exists() ? d.data() : null;
    loadStaffNames();
    draw();
  }, () => {}));
  sub(onSnapshot(query(collection(state.db, 'broadcasts'), where('active', '==', true), orderBy('createdAt', 'desc'), limit(5)), (snap) => {
    broadcasts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  }, () => {
    broadcasts = [];
    draw();
  }));
  // Обращения заведения — с сервера поддержки, опросом раз в 30 с, пока
  // вкладка открыта (лимит Firebase это не тратит).
  let ticketsAlive = true;
  sub(() => { ticketsAlive = false; });
  loadSupportTickets = async () => {
    try {
      const list = fromWire((await callSaasGateway('supportTicketList', { tenantId })).data.tickets || []);
      if (!ticketsAlive) return;
      supportTickets = list.sort((a, b) => ticketTime(b) - ticketTime(a));
      supportTicketsError = '';
    } catch (e) {
      if (supportTickets === null) supportTickets = [];
      supportTicketsError = e?.message || String(e);
    }
    draw();
  };
  loadSupportTickets();
  const ticketsTimer = setInterval(() => { if (document.visibilityState === 'visible') loadSupportTickets(); }, 30000);
  sub(() => clearInterval(ticketsTimer));
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
    loadStaffNames();
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
      (snap) => { recentClosedShifts = snap.docs.map((d) => d.data()); draw(); loadStaffNames(); },
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
            (Number(s.paymentTerminal) || 0) + (Number(s.paymentAggregator) || 0) + (Number(s.paymentComp) || 0);
        }, 0);
        draw();
      },
      () => { todayChecksCount = 0; todayRevenue = 0; draw(); },
    ));
    // Остальные точки сети — те же цифры, чтобы сравнить точки между собой.
    const me = state.tenants.find((t) => t.id === tenantId);
    if (me && me.chainId) {
      state.tenants.filter((t) => t.chainId === me.chainId).forEach((t) => {
        sub(onSnapshot(
          query(
            collection(state.db, 'tenants', t.id, 'sessions'),
            where('status', '==', 'closed'),
            where('closedAt', '>=', Timestamp.fromDate(startOfToday)),
          ),
          (snap) => {
            let revenue = 0;
            let checks = 0;
            snap.docs.forEach((d) => {
              const s = d.data();
              if (s.refunded === true) return;
              checks++;
              revenue += (Number(s.paymentCash) || 0) + (Number(s.paymentCard) || 0) +
                (Number(s.paymentTerminal) || 0) + (Number(s.paymentAggregator) || 0) + (Number(s.paymentComp) || 0);
            });
            chainToday[t.id] = { revenue, checks };
            draw();
          },
          () => {},
        ));
      });
    }
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

// ---------- ПАРТНЁРСКАЯ ПРОГРАММА (кабинет менеджера) ----------
//
// Менеджер приводит заведения: личная ссылка zalpos.ru/?p=КОД или
// приглашение по почте (с согласием получателя — ст. 18 38-ФЗ). Новый
// владелец закрепляется за ним, а с оплат подписки начисляется процент
// после налога и комиссии платёжной системы (saas-gateway/partners.js).

// Код ссылки и приглашение запоминаем на 30 дней: человек может
// зарегистрироваться не сразу после перехода.
const PARTNER_REF_KEY = 'zalpos-partner-ref';
const PARTNER_REF_TTL_MS = 30 * 24 * 3600 * 1000;

function capturePartnerRef() {
  let params;
  try { params = new URLSearchParams(location.search); } catch (_) { return; }
  const code = (params.get('p') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  const invite = /^[a-f0-9]{32}$/.test(params.get('invite') || '') ? params.get('invite') : '';
  if (!code && !invite) return;
  try {
    const prev = JSON.parse(localStorage.getItem(PARTNER_REF_KEY) || 'null') || {};
    localStorage.setItem(PARTNER_REF_KEY, JSON.stringify({ code: code || prev.code || '', invite: invite || prev.invite || '', at: Date.now() }));
  } catch (_) { /* приватный режим — без закрепления */ }
  // Чистый адрес: код не уходит дальше в пересылаемые ссылки и закладки.
  params.delete('p');
  params.delete('invite');
  const rest = params.toString();
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  if (invite) {
    callSaasGateway('partnerInviteInfo', { invite }).then((r) => {
      if (!r.data.ok) return;
      try {
        const ref = JSON.parse(localStorage.getItem(PARTNER_REF_KEY) || 'null') || {};
        localStorage.setItem(PARTNER_REF_KEY, JSON.stringify({ ...ref, code: ref.code || r.data.code || '', email: r.data.email, at: Date.now() }));
      } catch (_) {}
      const el = document.getElementById('f-email');
      if (el && !el.value) el.value = r.data.email;
    }).catch(() => {});
  }
}

// ---------- МИНИ-ПРИЛОЖЕНИЕ TELEGRAM ----------
// Бот менеджеров открывает https://zalpos.ru/?tgapp=1; Telegram кладёт
// подписанные данные в адрес (#tgWebAppData=…). Сервер проверяет подпись и
// выдаёт вход для менеджера, к которому привязан этот Telegram.
const TG_INIT_KEY = 'zalpos-tg-init';

function captureTelegramApp() {
  let init = '';
  try { init = new URLSearchParams(location.hash.slice(1)).get('tgWebAppData') || ''; } catch (_) {}
  if (!init) init = window.Telegram?.WebApp?.initData || '';
  if (init) { try { sessionStorage.setItem(TG_INIT_KEY, init); } catch (_) {} } else {
    try { init = sessionStorage.getItem(TG_INIT_KEY) || ''; } catch (_) {}
  }
  let params;
  try { params = new URLSearchParams(location.search); } catch (_) { params = new URLSearchParams(); }
  const fromBot = params.get('tgapp') === '1';
  if (!init && !fromBot) return;
  state.tgInit = init;
  document.documentElement.classList.add('tg-app');
  params.delete('tgapp');
  const rest = params.toString();
  const hash = location.hash.includes('tgWebApp') || !location.hash || location.hash === '#/' ? '#/partner' : location.hash;
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${hash}`);
}

async function telegramLogin() {
  try {
    const r = await callSaasGateway('partnerTgAuth', { initData: state.tgInit });
    await signInWithCustomToken(state.auth, r.data.token);
  } catch (e) {
    state.tgError = e?.message || String(e);
    toast(`${state.tgError}`);
    route();
  }
}

/** Для createTenant/createChain: кто привёл владельца (если не старше 30 дней). */
function partnerRefBody() {
  try {
    const ref = JSON.parse(localStorage.getItem(PARTNER_REF_KEY) || 'null');
    if (!ref || Date.now() - (ref.at || 0) > PARTNER_REF_TTL_MS) return {};
    return { ...(ref.code ? { partnerCode: ref.code } : {}), ...(ref.invite ? { partnerInvite: ref.invite } : {}) };
  } catch (_) {
    return {};
  }
}

function partnerRefEmail() {
  try {
    const ref = JSON.parse(localStorage.getItem(PARTNER_REF_KEY) || 'null');
    return ref && Date.now() - (ref.at || 0) <= PARTNER_REF_TTL_MS ? ref.email || '' : '';
  } catch (_) {
    return '';
  }
}

function forgetPartnerRef() {
  try { localStorage.removeItem(PARTNER_REF_KEY); } catch (_) {}
}

/** Вошедший — менеджер программы? (фоном после входа) */
async function checkPartner() {
  const uid = state.uid;
  try {
    const r = await callSaasGateway('partnerMe', {});
    if (state.uid !== uid) return;
    const was = !!state.partner;
    state.partner = r.data.partner || null;
    if (!!state.partner !== was && (location.hash === '#/partner' || !state.tenants.length)) route();
  } catch (_) { /* сервер недоступен — кабинет менеджера откроется позже */ }
}

const fmtMoney = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const digits = Number.isInteger(v) ? 0 : 2;
  return `${v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ₽`;
};
const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString('ru-RU') : '—');

const PARTNER_INVITE_STATUS = {
  sent: ['Отправлено', 'var(--muted)'],
  registered: ['Зарегистрировано', 'var(--success)'],
  expired: ['Срок истёк', 'var(--muted)'],
  optedOut: ['Отказ от писем', 'var(--danger)'],
};

function screenPartner() {
  screenEl().innerHTML = `<div class="brand">ZalPOS</div><div class="spinner"></div>`;
  let data = null;
  let error = '';
  let sending = false;

  const load = async () => {
    try {
      data = (await callSaasGateway('partnerDashboard', {})).data;
      const me = (await callSaasGateway('partnerMe', {})).data;
      data.settings = me.settings;
      data.bot = me.bot;
      error = '';
    } catch (e) {
      error = e?.message || String(e);
    }
    draw();
  };

  let tab = 'invite';
  let editDetails = false;
  // Поддержка менеджеров: один диалог со специалистом (saas-gateway/support-bot.js).
  const sup = { loaded: false, started: false, messages: [], waiting: false, closed: false, error: '' };
  let supTimer = null;
  const loadSupport = async () => {
    try {
      const r = (await callSaasGateway('supportPartnerMessages', {})).data;
      Object.assign(sup, { loaded: true, started: !!r.started, messages: r.messages || [], waiting: !!r.waitingHuman, closed: !!r.closed, error: '' });
    } catch (e) {
      Object.assign(sup, { loaded: true, error: e?.message || String(e) });
    }
    if (tab === 'support' && location.hash === '#/partner') draw();
  };
  const openSupport = () => {
    tab = 'support';
    draw();
    loadSupport();
    if (!supTimer) {
      supTimer = setInterval(() => { if (tab === 'support' && document.visibilityState === 'visible') loadSupport(); }, 10000);
      sub(() => { clearInterval(supTimer); supTimer = null; });
    }
    setTimeout(() => document.querySelector('.pt-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const greeting = () => {
    const h = new Date().getHours();
    return h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  };

  const shell = (p, inner) => `
    <header class="pt-top">
      <div class="pt-brand"><span class="pt-mark">◆</span> ZalPOS <span class="pt-brand-sub">для партнёров</span></div>
      <div class="pt-top-right">
        ${state.tenants.length ? '<a href="#/" class="pt-top-link">Кабинет заведения</a>' : ''}
        ${p ? `<button type="button" class="btn btn-ghost pt-out pt-help" id="f-partner-help">${navIconHtml('chat')}<span>Поддержка</span></button>` : ''}
        <button type="button" class="btn btn-ghost pt-out" id="f-partner-signout">${navIconHtml('logout')}<span>Выйти</span></button>
      </div>
    </header>
    ${inner}
    <footer class="site-footer pt-site-foot">${siteFooterHtml({
      top: `<span class="small muted">${p ? esc(p.termsEdition) : ''}</span>`,
      extraDocs: '<a href="#/partner-terms" target="_blank" rel="noopener">Правила партнёрской программы</a>',
    })}</footer>`;

  const draw = () => {
    if (location.hash !== '#/partner' && state.tenants.length) return;
    screenEl().classList.add('partner-page');
    if (error && !data) {
      screenEl().innerHTML = shell(null, `<div class="card pt-empty"><p class="small" style="margin:0">${esc(error)}</p>
        <button class="btn btn-ghost" id="f-partner-retry" style="width:auto;margin-top:12px">Обновить</button></div>`);
      bind();
      return;
    }
    if (!data) return;
    const p = data.partner;
    const s = data.summary;
    const st = data.settings || {};
    const firstName = (p.name || '').trim().split(/\s+/)[0] || '';
    const hello = `
      <div class="dash-hero">
        <div class="dash-date">${esc(new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }))}</div>
        <div class="dash-greeting">${greeting()}${firstName ? `, <em>${esc(firstName)}</em>` : ''}</div>
      </div>`;
    if (!p.termsAcceptedAt) {
      screenEl().innerHTML = shell(p, `${hello}
        <div class="card pt-terms">
          <div class="pt-kicker">Шаг 1 из 1</div>
          <h2 class="pt-h">Правила партнёрской программы</h2>
          <p class="small">Вы приводите в ZalPOS новые заведения и получаете <b>${esc(String(p.percent))}%</b> с их оплат подписки после налога и комиссии платёжной системы${p.months ? ` в течение ${p.months} мес. после регистрации клиента` : ''}.</p>
          <ul class="pt-list small">
            <li>Приглашение по почте — только тем, кто согласился его получить (закон о рекламе). В письме будут ваше имя и ссылка для отказа.</li>
            <li>Не обещайте клиентам условий, которых нет в тарифах ZalPOS.</li>
            <li>Данные клиентов не передавайте третьим лицам: после регистрации вы видите только название заведения, тариф и суммы.</li>
            <li>Клиент закрепляется за тем, кто пригласил первым; уже работающих клиентов закрепить нельзя.</li>
          </ul>
          <p class="small"><a href="#/partner-terms" target="_blank" rel="noopener">Полный текст правил</a> · ${esc(p.termsEdition)}</p>
          <label class="row small pt-check"><input type="checkbox" id="f-partner-terms"> <span>Принимаю правила партнёрской программы ZalPOS</span></label>
          <button class="btn btn-primary" id="f-partner-accept">Начать работу</button>
        </div>`);
      bind();
      return;
    }

    const live = data.accruals.filter((a) => a.status !== 'reversed');
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    const thisMonth = live.filter((a) => a.paidAt >= monthStart).reduce((sum, a) => sum + a.amount, 0);
    const activeInvites = data.invites.filter((x) => x.status === 'sent').length;
    const termText = p.months ? `${p.months} мес. с регистрации клиента` : 'пока клиент платит';
    const stopped = p.status !== 'active';

    const hero = `
      <div class="card venue-card pt-hero">
        <div class="venue-kicker">Доступно к выплате</div>
        <div class="pt-hero-sum">${fmtMoney(s.available || 0)}</div>
        <div class="pt-hero-sub">${[
          s.hold > 0 ? `ждут ${s.holdDays} дн. после оплаты: ${fmtMoney(s.hold)}` : '',
          s.requested > 0 ? `в запросе: ${fmtMoney(s.requested)}` : '',
          `начислено всего ${fmtMoney(s.total)}`, `выплачено ${fmtMoney(s.paid)}`,
        ].filter(Boolean).join(' · ')}</div>
        ${payoutAction()}
        <div class="venue-chips">
          <span class="venue-chip ${stopped ? 'bad' : ''}"><i></i>${stopped ? 'Приостановлено' : 'Активно'}</span>
          <span class="venue-chip">Ставка ${esc(String(p.percent))}%</span>
          <span class="venue-chip">${esc(termText)}</span>
          <span class="venue-chip">${esc(capitalize(p.taxStatusLabel || ''))}</span>
        </div>
        <div class="pt-hero-note">Процент — от каждой оплаты клиента после налога ${esc(String(st.taxPct ?? 6))}% и комиссии платёжной системы. Начисление можно запросить через ${esc(String(s.holdDays ?? 14))} дн. после оплаты (на случай возврата), от ${fmtMoney(s.payoutMin ?? 1000)}.</div>
      </div>`;
    function payoutAction() {
      const r = data.request;
      if (r) {
        return `<div class="pt-pay-req"><span>⏳ Запрос на ${fmtMoney(r.net)} отправлен ${fmtDay(r.requestedAt)} — деньги придут на ${esc(r.details)} до ${fmtDay(r.payBy)}</span>
          <button type="button" class="pt-link-renew" id="f-partner-pay-cancel">Отменить запрос</button></div>`;
      }
      if (stopped) return '';
      if (!p.payoutDetails) return `<button type="button" class="btn pt-pay-btn" data-ptab-go="pay">Указать реквизиты для выплат</button>`;
      if (s.statusOk === false) return '<div class="pt-hero-note" style="margin-top:12px">Выплаты — только самозанятым и ИП. Оформите самозанятость в «Мой налог» (5 минут) или ИП и напишите администратору ZalPOS: он сменит статус, и запросы откроются.</div>';
      if (!s.canRequest) return '';
      return `<button type="button" class="btn pt-pay-btn" id="f-partner-pay">Запросить ${fmtMoney(s.calc.net)}</button>`;
    }
    const stat = (icon, value, label, money = false) => `
      <div class="card live-stat"><div class="live-stat-head">${navIconHtml(icon)}</div>
        <div class="live-stat-value${money ? ' pt-money' : ''}">${value}</div><div class="live-stat-label">${label}</div></div>`;
    const stats = `
      <div class="live-stats-grid">
        ${stat('users', s.clients, 'Клиентов закреплено')}
        ${stat('bell', activeInvites, 'Приглашений ждут ответа')}
        ${stat('card', live.length, 'Оплат от клиентов')}
        ${stat('gem', fmtMoney(thisMonth), 'Доход в этом месяце', true)}
      </div>`;
    const linkCard = `
      <div class="card pt-link">
        <div class="pt-link-head">
          <div><div class="pt-kicker">Ваша ссылка</div><div class="small muted">Кто зарегистрируется по ней в течение 30 дней после перехода — ваш клиент. 30 дней считаются от последнего перехода: перешлите ссылку ещё раз — и отсчёт начнётся заново.</div></div>
        </div>
        <div class="pt-link-row">
          <input id="f-partner-link" readonly value="${esc(p.link)}" aria-label="Ваша ссылка">
          <button class="btn btn-primary" id="f-partner-copy">Скопировать</button>
          ${navigator.share ? '<button class="btn btn-ghost" id="f-partner-share">Поделиться</button>' : ''}
        </div>
        <button type="button" class="pt-link-renew" id="f-partner-renew">↻ Создать новую ссылку</button>
      </div>`;
    const steps = !s.clients ? `
      <div class="pt-steps">
        ${[['1', 'Отправьте ссылку или приглашение', 'Владельцу кафе, бара или кальянной — в мессенджере или по почте.'],
          ['2', 'Клиент регистрируется', 'По вашей ссылке или из письма-приглашения — и сразу закрепляется за вами.'],
          ['3', 'Вы получаете процент', `${esc(String(p.percent))}% с каждой его оплаты подписки — ${esc(termText)}.`]].map(([n, t, d]) => `
          <div class="pt-step"><span class="pt-step-n">${n}</span><div><b>${t}</b><span>${d}</span></div></div>`).join('')}
      </div>` : '';

    const tabs = [
      ['invite', 'Пригласить'],
      ['clients', `Клиенты${data.clients.length ? ` · ${data.clients.length}` : ''}`],
      ['money', 'Начисления'],
      ['pay', `Выплаты${data.payouts.some((x) => x.needReceipt) ? ' · нужен чек' : ''}`],
      ['invites', `Приглашения${data.invites.length ? ` · ${data.invites.length}` : ''}`],
      ['support', `Поддержка${sup.waiting ? ' · ждём ответ' : ''}`],
    ];
    const empty = (t) => `<p class="small muted pt-empty-text">${t}</p>`;
    const accrualBadge = (a) => {
      if (a.status === 'reversed') return '<span class="pt-badge off">снято — возврат</span>';
      if (a.clawback) return '<span class="pt-badge bad">удержание за возврат</span>';
      if (a.paidOut) return '<span class="pt-badge ok">выплачено</span>';
      if (a.requested) return '<span class="pt-badge wait">в запросе</span>';
      if (a.availableAt && a.availableAt > Date.now()) return `<span class="pt-badge off">доступно с ${fmtDay(a.availableAt)}</span>`;
      return '<span class="pt-badge wait">можно запросить</span>';
    };
    const actMonths = () => {
      const set = new Set(data.accruals.map((a) => { const d = new Date(a.paidAt); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }));
      set.add(prevMonthIso());
      return [...set].sort().reverse().slice(0, 12);
    };
    const monthLabel = (m) => { const [y, mm] = m.split('-').map(Number); return new Date(y, mm - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }); };
    const payPanel = () => `
      <div class="card">
        <div class="pt-kicker">Реквизиты для перевода</div>
        ${p.payoutDetails && !editDetails ? `<p class="small" style="margin:8px 0">${esc(p.payoutDetails)}</p><button type="button" class="pt-link-renew" id="f-partner-details-edit">Изменить реквизиты</button>` : `
          <p class="small muted" style="margin:6px 0 12px">Перевод по СБП на ваш номер. ФИО и ИНН — получателя (ваши): ${p.taxStatus === 'ip' ? 'ИНН вашего ИП.' : 'по ИНН проверяется статус самозанятого, на выплату вы оформляете чек в «Мой налог».'}</p>
          <label class="field"><span>Телефон для СБП</span><input id="f-pd-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 900 123-45-67"></label>
          <label class="field"><span>Банк</span><input id="f-pd-bank" maxlength="60" placeholder="Сбербанк"></label>
          <label class="field"><span>ФИО полностью</span><input id="f-pd-name" maxlength="120" autocomplete="name" placeholder="Петрова Анна Сергеевна"></label>
          <label class="field"><span>ИНН (12 цифр)</span><input id="f-pd-inn" inputmode="numeric" maxlength="12" placeholder="500100732259"></label>
          <div class="row" style="gap:12px;flex-wrap:wrap;align-items:center"><button class="btn btn-primary" id="f-partner-details-save" style="width:auto">Сохранить</button>
          ${p.payoutDetails ? '<button type="button" class="pt-link-renew" id="f-partner-details-cancel" style="margin:0">Отмена</button>' : ''}</div>
          <p class="small muted" style="margin:10px 0 0">Реквизиты хранятся в зашифрованном виде на сервере в России и нужны только для перевода.</p>`}
      </div>
      <div class="card">
        <div class="pt-kicker">Акт за месяц</div>
        <p class="small muted" style="margin:6px 0 10px">По договору раз в месяц подписываем акт об оказанных услугах — в нём все оплаты ваших клиентов за месяц и вознаграждение.</p>
        <div class="row" style="gap:8px;flex-wrap:wrap"><select id="f-pa-month" style="width:auto;margin:0">${actMonths().map((m) => `<option value="${m}">${esc(monthLabel(m))}</option>`).join('')}</select>
          <button class="btn btn-ghost" id="f-partner-act" style="width:auto">Скачать акт</button></div>
      </div>
      <h2 class="pt-sub">История выплат</h2>
      <div class="card pt-rows">${data.payouts.length ? data.payouts.map((x) => `
        <div class="pt-pay-item">
          <div class="pt-row"><div class="pt-row-main"><b>${fmtDay(x.paidAt)}</b>
              <span class="small muted">${x.ndfl ? `начислено ${fmtMoney(x.amount)}, НДФЛ ${fmtMoney(x.ndfl)}` : ''}${x.ndfl && x.note ? ' · ' : ''}${x.note ? esc(x.note) : ''}</span></div>
            <div class="pt-row-side"><b>${fmtMoney(x.net)}</b>${x.receiptUrl ? `<span class="small"><a href="${esc(x.receiptUrl)}" target="_blank" rel="noopener">чек</a> ✓</span>` : ''}${x.receivedAt ? '<span class="small muted">получено ✓</span>' : ''}</div></div>
          ${!x.receivedAt ? `<div class="row small" style="gap:14px;padding:0 0 12px;flex-wrap:wrap;align-items:center">${x.notReceivedAt ? '<span style="color:var(--danger)">Вы сообщили, что деньги не пришли — администратор проверяет.</span>' : '<span class="muted">Деньги пришли?</span>'}
            <button type="button" class="pt-link-renew f-pc" data-id="${esc(x.id)}" data-got="1" style="margin:0">✅ Да, пришли</button>
            ${x.notReceivedAt ? '' : `<button type="button" class="pt-link-renew f-pc" data-id="${esc(x.id)}" style="margin:0">❌ Не пришли</button>`}</div>` : ''}
          ${x.needReceipt ? `<div class="pt-receipt"><span class="small" style="color:var(--warning)">Нужен чек в «Мой налог» на ${fmtMoney(x.amount)} — до ${fmtDay(x.receiptDue)}. В приложении: чек → «Поделиться» → скопируйте ссылку.</span>
            <div class="row" style="gap:8px;margin-top:6px"><input class="grow f-pr-url" data-id="${esc(x.id)}" placeholder="https://lknpd.nalog.ru/api/v1/receipt/…" style="margin:0;min-width:0"><button class="btn btn-ghost f-pr-save" data-id="${esc(x.id)}" style="width:auto">Прикрепить</button></div></div>` : ''}
        </div>`).join('') : empty('Выплат пока не было. Когда сумма к выплате достигнет минимальной, нажмите «Запросить» вверху страницы или в Telegram-боте.')}</div>`;
    const supportPanel = () => `
      <div class="card pt-sup">
        <div class="pt-kicker">Поддержка менеджеров</div>
        <p class="small muted" style="margin:6px 0 12px">Выплаты, договор, чеки, клиенты — отвечает специалист ZalPOS, обычно в течение рабочего дня. Ответ придёт сюда и в Telegram-бот.</p>
        ${!sup.loaded ? '<div class="spinner"></div>' : sup.error ? `<p class="small" style="color:var(--danger)">${esc(sup.error)}</p>` : `
          <div class="pt-sup-list" id="pt-sup-list">${sup.messages.length ? sup.messages.map((m) => `
            <div class="pt-sup-msg ${m.role === 'you' ? 'you' : 'staff'}"><div class="pt-sup-who">${m.role === 'you' ? 'Вы' : `Поддержка ZalPOS${m.name ? ` · ${esc(m.name)}` : ''}`} · ${m.at ? new Date(m.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</div><div class="pt-sup-text">${esc(m.text)}</div></div>`).join('')
            : '<p class="small muted" style="margin:0">Сообщений пока нет — задайте вопрос ниже.</p>'}</div>
          ${sup.waiting ? '<p class="small muted" style="margin:8px 0 0">⏳ Вопрос у специалиста — ответ придёт сюда и в Telegram.</p>' : ''}`}
        <label class="field" style="margin-top:12px"><span>Ваш вопрос</span><textarea id="f-pt-sup-text" rows="3" maxlength="4000" placeholder="Например: когда придёт выплата по запросу от 24.10?"></textarea></label>
        ${sup.loaded && !sup.started ? `<label class="consent-row"><input type="checkbox" id="f-pt-sup-consent">
          <span class="consent-text"><span>Согласен на обработку данных обращения</span>
          <span class="small muted">Обращение хранится на сервере в России; в рабочий чат поддержки уходит без вашего имени и почты, телефоны, почты, ИНН и номера карт в тексте скрываются автоматически. Не пишите пароли и коды из СМС. <a href="#/legal/privacy" target="_blank" rel="noopener" class="nowrap">Политика конфиденциальности</a></span></span></label>` : ''}
        <button class="btn btn-primary" id="f-pt-sup-send" style="width:auto">Отправить</button>
      </div>`;
    const panels = {
      invite: `
        <div class="card">
          <label class="field"><span>Почта владельца заведения</span><input id="f-partner-email" type="email" placeholder="owner@cafe.ru" autocomplete="off"${stopped ? ' disabled' : ''}></label>
          <label class="field"><span>Название заведения (необязательно)</span><input id="f-partner-venue" maxlength="80" placeholder="Кафе «Лето»"${stopped ? ' disabled' : ''}></label>
          <label class="row small pt-check"><input type="checkbox" id="f-partner-consent"${stopped ? ' disabled' : ''}> <span>Владелец этой почты согласился получить от ZalPOS письмо-приглашение</span></label>
          <button class="btn btn-primary" id="f-partner-invite"${sending || stopped ? ' disabled' : ''}>${sending ? 'Отправляю…' : 'Отправить приглашение'}</button>
          <p class="small muted" style="margin:12px 0 0">Письмо придёт от ZalPOS с вашим именем и кнопкой регистрации, действует 30 дней. Если заведение уже пригласил другой менеджер или у почты есть аккаунт ZalPOS, письмо не отправится.</p>
        </div>`,
      clients: `<div class="card pt-rows">${data.clients.length ? data.clients.map((c) => `
          <div class="pt-row">
            <div class="pt-row-main"><b>${esc(c.venueName)}</b>
              <span class="small muted">${c.planName ? `${esc(c.planName)} · ` : ''}с ${fmtDay(c.attachedAt)} · ${c.source === 'invite' ? 'по приглашению' : 'по ссылке'}${c.paidUntil ? ` · оплачено до ${fmtDay(c.paidUntil)}` : ''}</span></div>
            <div class="pt-row-side"><b>${fmtMoney(c.income)}</b><span class="small muted">${c.payments ? `${c.payments} ${plural(c.payments, 'оплата', 'оплаты', 'оплат')} · ${fmtMoney(c.paid)}` : 'оплат ещё не было'}</span></div>
          </div>`).join('') : empty('Пока нет закреплённых клиентов. Отправьте ссылку или приглашение — клиент появится здесь сразу после регистрации.')}</div>`,
      money: `<div class="card pt-rows">${data.accruals.length ? data.accruals.slice(0, 100).map((a) => `
          <div class="pt-row${a.status === 'reversed' ? ' pt-row-off' : ''}">
            <div class="pt-row-main"><b>${esc(a.venueName || 'Клиент')}</b>
              <span class="small muted">${fmtDay(a.paidAt)} · оплата ${fmtMoney(a.gross)} − налог ${fmtMoney(a.tax)} − комиссия ${fmtMoney(a.fee)} = ${fmtMoney(a.base)} × ${a.percent}%</span></div>
            <div class="pt-row-side"><b>${fmtMoney(a.amount)}</b>${accrualBadge(a)}</div>
          </div>`).join('') : empty('Начислений пока нет: они появятся после первой оплаты подписки вашим клиентом.')}</div>`,
      pay: payPanel(),
      support: supportPanel(),
      invites: `<div class="card pt-rows">${data.invites.length ? data.invites.slice(0, 50).map((x) => {
          const [label, tone] = { sent: ['ждёт регистрации', 'wait'], registered: ['зарегистрировано', 'ok'], expired: ['срок истёк', 'off'], optedOut: ['отказ от писем', 'bad'] }[x.status] || [x.status, 'off'];
          return `<div class="pt-row"><div class="pt-row-main"><b>${esc(x.venueName || x.email)}</b>
              <span class="small muted">${x.venueName ? `${esc(x.email)} · ` : ''}отправлено ${fmtDay(x.sentAt)}${x.status === 'sent' ? ` · действует до ${fmtDay(x.expiresAt)}` : ''}</span></div>
            <div class="pt-row-side"><span class="pt-badge ${tone}">${label}</span></div></div>`;
        }).join('') : empty('Приглашений ещё не было.')}</div>`,
    };
    const tg = data.bot && data.bot.connected ? `
      <div class="card pt-tg">
        <div class="pt-tg-text"><b>${p.telegram ? 'Telegram подключён' : 'Уведомления в Telegram'}</b>
          <span class="small muted">${p.telegram ? 'Бот пишет о новых клиентах и оплатах; приглашать можно командой /invite.' : `Бот @${esc(data.bot.username)} сообщит о новых клиентах и оплатах, а приглашать можно прямо из чата.`}</span></div>
        <button class="btn btn-ghost" id="f-partner-tg">${p.telegram ? 'Переподключить' : 'Подключить'}</button>
      </div>` : '';

    renderKeepingInputs(screenEl(), shell(p, `
      ${hello}
      ${stopped ? '<div class="card sec-warn pt-warn"><p class="small" style="margin:0">Программа для вас приостановлена: новые клиенты не закрепляются и начисления не идут. Вопросы — администратору ZalPOS.</p></div>' : ''}
      ${hero}
      ${stats}
      ${linkCard}
      ${steps}
      <div class="pt-tabs" role="tablist">${tabs.map(([id, label]) => `<button type="button" role="tab" class="pt-tab${tab === id ? ' active' : ''}" data-ptab="${id}" aria-selected="${tab === id}">${label}</button>`).join('')}</div>
      <div class="pt-panel">${panels[tab]}</div>
      ${tg}
    `));
    bind();
  };

  const bind = () => {
    if ($('f-partner-signout')) $('f-partner-signout').onclick = (e) => { e.preventDefault(); signOut(state.auth); };
    if ($('f-partner-retry')) $('f-partner-retry').onclick = () => { error = ''; load(); };
    screenEl().querySelectorAll('[data-ptab]').forEach((b) => {
      b.onclick = () => { if (b.dataset.ptab === 'support') return openSupport(); tab = b.dataset.ptab; draw(); };
    });
    if ($('f-partner-help')) $('f-partner-help').onclick = openSupport;
    const supList = $('pt-sup-list');
    if (supList) supList.scrollTop = supList.scrollHeight;
    if ($('f-pt-sup-send')) {
      $('f-pt-sup-send').onclick = async () => {
        const text = $('f-pt-sup-text').value.trim();
        if (!text) { toast('Напишите вопрос'); return; }
        const consent = sup.started || !!$('f-pt-sup-consent')?.checked;
        if (!consent) { toast('Отметьте согласие на обработку данных обращения'); return; }
        const btn = $('f-pt-sup-send');
        btn.disabled = true;
        try {
          const r = (await callSaasGateway('supportPartnerSend', { text, consent: true, consentEdition: LEGAL_EDITION })).data;
          $('f-pt-sup-text').value = '';
          toast(r.masked ? 'Отправлено. Личные данные в тексте скрыты' : 'Отправлено специалисту');
          await loadSupport();
        } catch (e) {
          btn.disabled = false;
          toast(`Не отправилось: ${e?.message || e}`);
        }
      };
    }
    if ($('f-partner-accept')) {
      $('f-partner-accept').onclick = async () => {
        if (!$('f-partner-terms').checked) { toast('Отметьте, что принимаете правила'); return; }
        try {
          await callSaasGateway('partnerAcceptTerms', { accept: true });
          await load();
        } catch (e) { toast(`Не получилось: ${e?.message || e}`); }
      };
    }
    if ($('f-partner-copy')) $('f-partner-copy').onclick = () => copyToClipboard($('f-partner-link').value);
    screenEl().querySelectorAll('[data-ptab-go]').forEach((b) => { b.onclick = () => { tab = b.dataset.ptabGo; draw(); }; });
    const payCall = async (btn, fn, ok) => {
      if (btn) btn.disabled = true;
      try { await fn(); if (ok) toast(ok); await load(); } catch (e) { if (btn) btn.disabled = false; toast(`Не получилось: ${e?.message || e}`); }
    };
    if ($('f-partner-pay')) {
      $('f-partner-pay').onclick = () => {
        const sm = data.summary;
        if (!confirm(`Запросить выплату ${fmtMoney(sm.calc.net)} на ${data.partner.payoutDetails}?`)) return;
        payCall($('f-partner-pay'), () => callSaasGateway('partnerPayoutRequest', {}), 'Запрос отправлен — сообщим, когда деньги будут перечислены');
      };
    }
    if ($('f-partner-pay-cancel')) {
      $('f-partner-pay-cancel').onclick = () => {
        if (!confirm('Отменить запрос выплаты? Сумма снова станет доступной.')) return;
        payCall($('f-partner-pay-cancel'), () => callSaasGateway('partnerPayoutRequest', { action: 'cancel' }), 'Запрос отменён');
      };
    }
    if ($('f-partner-details-edit')) $('f-partner-details-edit').onclick = () => { editDetails = true; draw(); };
    if ($('f-partner-details-cancel')) $('f-partner-details-cancel').onclick = () => { editDetails = false; draw(); };
    if ($('f-partner-details-save')) {
      $('f-partner-details-save').onclick = () => payCall($('f-partner-details-save'), async () => {
        await callSaasGateway('partnerPayoutDetails', { phone: $('f-pd-phone').value, bank: $('f-pd-bank').value, fullName: $('f-pd-name').value, inn: $('f-pd-inn').value });
        editDetails = false;
      }, 'Реквизиты сохранены');
    }
    screenEl().querySelectorAll('.f-pc').forEach((b) => {
      b.onclick = () => payCall(b, () => callSaasGateway('partnerPayoutConfirm', { payoutId: b.dataset.id, got: !!b.dataset.got }), b.dataset.got ? 'Спасибо, получение отмечено' : 'Передали администратору — он проверит перевод');
    });
    if ($('f-partner-act')) {
      $('f-partner-act').onclick = async () => {
        try { await downloadFromGateway('partnerAct', { month: $('f-pa-month').value }, 'Акт.docx'); toast('Акт скачан'); } catch (e) { toast(`Не получилось: ${e?.message || e}`); }
      };
    }
    screenEl().querySelectorAll('.f-pr-save').forEach((b) => {
      b.onclick = () => {
        const inp = screenEl().querySelector(`.f-pr-url[data-id="${CSS.escape(b.dataset.id)}"]`);
        payCall(b, () => callSaasGateway('partnerPayoutReceipt', { payoutId: b.dataset.id, url: inp ? inp.value : '' }), 'Чек прикреплён');
      };
    });
    if ($('f-partner-renew')) {
      $('f-partner-renew').onclick = async () => {
        if (!confirm('Создать новую ссылку? Старые ссылки, которые вы уже отправили, продолжат работать — клиенты по ним тоже закрепятся за вами.')) return;
        const btn = $('f-partner-renew');
        btn.disabled = true;
        try {
          const r = await callSaasGateway('partnerNewLink', {});
          data.partner.code = r.data.code;
          data.partner.link = r.data.link;
          draw();
          toast('Новая ссылка готова — отправьте её клиенту, 30 дней пойдут с его перехода');
        } catch (e) {
          btn.disabled = false;
          toast(`Не получилось: ${e?.message || e}`);
        }
      };
    }
    if ($('f-partner-share')) $('f-partner-share').onclick = () => navigator.share({ title: 'ZalPOS', text: 'Касса и управление заведением — попробуйте бесплатно', url: $('f-partner-link').value }).catch(() => {});
    if ($('f-partner-tg')) {
      $('f-partner-tg').onclick = async () => {
        // Окно — сразу по нажатию (иначе браузер считает его всплывающим).
        const w = window.open('', '_blank');
        try {
          const r = await callSaasGateway('partnerTgLink', {});
          if (w) w.location.href = r.data.url; else location.href = r.data.url;
        } catch (e) {
          if (w) w.close();
          toast(`Не получилось: ${e?.message || e}`);
        }
      };
    }
    if ($('f-partner-invite')) {
      $('f-partner-invite').onclick = async () => {
        const email = $('f-partner-email').value.trim();
        if (!email) { toast('Укажите почту владельца заведения'); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { toast('Проверьте адрес почты'); return; }
        if (!$('f-partner-consent').checked) { toast('Отметьте, что владелец почты согласился получить приглашение'); return; }
        sending = true;
        draw();
        try {
          await callSaasGateway('partnerInvite', { email, venueName: $('f-partner-venue').value.trim(), consent: true });
          $('f-partner-email').value = '';
          $('f-partner-venue').value = '';
          $('f-partner-consent').checked = false;
          toast('Приглашение отправлено');
          sending = false;
          tab = 'invites';
          await load();
        } catch (e) {
          sending = false;
          draw();
          toast(`Не отправлено: ${e?.message || e}`);
        }
      };
    }
  };

  load();
}

function screenPartnerTerms() {
  screenEl().innerHTML = publicPageWrapHtml('Правила партнёрской программы ZalPOS', `
    <p class="small muted">Редакция № 2 от 24 октября 2026 г.</p>
    <div class="card">
      ${legalSection('1. Что это', [
        'Партнёрская программа — порядок, по которому менеджер (партнёр) привлекает в ZalPOS новые заведения и получает вознаграждение с их оплат. Правила дополняют договор, заключённый между партнёром и правообладателем платформы ZalPOS (<span id="legal-requisites" data-kind="privacy">реквизиты — в политике конфиденциальности</span>); при расхождении действует договор.',
        'Партнёра добавляет администратор платформы. Принимая правила в кабинете менеджера, партнёр подтверждает, что ознакомился с ними; дата и редакция сохраняются.',
      ])}
      ${legalSection('2. Как закрепляется клиент', [
        'Клиент — владелец, впервые зарегистрировавший в ZalPOS заведение или сеть. Он закрепляется за партнёром, если зарегистрировался по личной ссылке партнёра в течение 30 дней после перехода или по приглашению на свою почту в течение 30 дней после его отправки.',
        'Если заведение пригласили несколько партнёров, клиент закрепляется за тем, кто пригласил первым. Владельцев, у которых уже есть аккаунт или заведение в ZalPOS, закрепить нельзя. Закрепление действует, пока действует участие партнёра в программе; администратор вправе исправить закрепление, если оно произошло по ошибке или в нарушение правил.',
      ])}
      ${legalSection('3. Вознаграждение', [
        'С каждой поступившей оплаты закреплённого клиента — подписки, продления, дополнительной точки сети — начисляется процент, установленный партнёру. База — сумма оплаты за вычетом налога правообладателя (ставка указана в кабинете менеджера) и комиссии платёжной системы. Тестовые оплаты и пробный период не учитываются. Если партнёру установлен срок, начисления идут только в течение этого срока после регистрации клиента.',
        'При возврате денег клиенту начисление по этой оплате снимается; если оно уже выплачено — удерживается из следующей выплаты.',
        'Начисления видны в кабинете менеджера и в Telegram-боте. Начисление по оплате клиента становится доступным к выплате через срок ожидания после оплаты (на случай возврата; срок и минимальная сумма выплаты указаны в кабинете менеджера).',
        'Выплату партнёр запрашивает сам — в кабинете или в Telegram-боте; в запрос входят все доступные начисления. Перевод производится по Системе быстрых платежей по реквизитам, указанным партнёром в кабинете, в течение 10 рабочих дней после запроса; партнёр отвечает за правильность реквизитов. Запрос можно отменить до выплаты; если администратор отклонит запрос (например, из-за неверных реквизитов), сумма снова становится доступной. Получив деньги, партнёр подтверждает это в кабинете или в боте; если деньги не пришли — сообщает там же.',
      ])}
      ${legalSection('4. Налоги партнёра', [
        'Самозанятый партнёр уплачивает налог на профессиональный доход сам, формирует в «Мой налог» чек на каждую выплату (не позднее 9-го числа месяца, следующего за месяцем выплаты) и прикладывает ссылку на чек в кабинете или в боте. Статус самозанятого проверяется по открытому сервису ФНС при запросе и в день выплаты; если статус не подтверждён, выплата как самозанятому не производится. Пока не приложен просроченный чек, новые выплаты не производятся. Партнёр — индивидуальный предприниматель уплачивает налоги сам. Участвовать в программе могут только самозанятые и индивидуальные предприниматели: физическим лицам без этих статусов вознаграждение не выплачивается; при утрате статуса выплаты приостанавливаются до его восстановления или регистрации ИП, начисленное сохраняется.',
      ])}
      ${legalSection('5. Обязанности партнёра', [
        'Направлять приглашения по почте только лицам, которые дали предварительное согласие на их получение (ст. 18 Федерального закона № 38-ФЗ «О рекламе»), и отмечать это согласие при отправке. Отказ получателя от писем исполняется автоматически.',
        'Сообщать клиентам только достоверные сведения о ZalPOS и не обещать условий, которых нет в тарифах и договоре-оферте. Не представляться сотрудником правообладателя, если это не так.',
        'Сохранять конфиденциальность сведений о клиентах, ставших известными в рамках программы, и не передавать их третьим лицам. Адрес почты клиента партнёр передаёт ZalPOS только для отправки приглашения, с согласия его владельца.',
      ])}
      ${legalSection('6. Приостановка и прекращение', [
        'Администратор вправе приостановить участие партнёра при нарушении правил (в том числе рассылке без согласия получателей); на время приостановки новые клиенты не закрепляются и начисления не идут. Начисления по оплатам, поступившим до приостановки, сохраняются и выплачиваются, если нарушение не связано с привлечением этих клиентов.',
      ])}
      ${legalSection('7. Персональные данные', [
        'ZalPOS обрабатывает почту и имя партнёра, сведения о начислениях и выплатах, реквизиты для перевода (телефон, банк, ФИО, ИНН — хранятся в зашифрованном виде), а также почту приглашённых лиц и отметки о согласии — для исполнения договора с партнёром, отправки приглашений и учёта вознаграждения. Данные хранятся на сервере в Российской Федерации. Подробнее — в <a href="#/legal/privacy">политике обработки персональных данных</a>.',
      ])}
    </div>
  `);
  fillLegalRequisites();
}

// ---------- ПАНЕЛЬ ПЛАТФОРМЫ: МЕНЕДЖЕРЫ ----------

/** Письмо менеджеру «задайте пароль и войдите» — его отправляет сам Firebase
 *  (своя почта платформы не нужна): по ссылке менеджер задаёт пароль и
 *  попадает в кабинет менеджера. Возвращает текст для уведомления. */
async function sendPartnerLoginLetter(email) {
  const settings = { url: `${location.origin}/#/partner` };
  try {
    try {
      await sendPasswordResetEmail(state.auth, email, settings);
    } catch (e) {
      // Адрес возврата не в списке разрешённых доменов Firebase — письмо без него.
      if (e?.code !== 'auth/unauthorized-continue-uri' && e?.code !== 'auth/invalid-continue-uri') throw e;
      await sendPasswordResetEmail(state.auth, email);
    }
    return `Письмо для входа отправлено на ${email} — тема «Сброс пароля». По ссылке менеджер задаст пароль и войдёт на zalpos.ru/#/partner. Не пришло за 5 минут — пусть проверит «Спам» и «Промоакции».`;
  } catch (e) {
    return `Письмо не отправилось: ${e?.message || e}. Менеджер может войти сам: zalpos.ru/#/partner → «Забыли пароль?».`;
  }
}

function watchAdminPartners() {
  const body = $('admin-partners');
  if (!body) return;
  let data = null;
  let openId = null;
  let detail = null;
  let editId = null;

  const load = async () => {
    try {
      data = (await callSaasGateway('partnerAdminList', {})).data;
      if (openId) detail = (await callSaasGateway('partnerAdminPartner', { id: openId })).data;
    } catch (e) {
      body.innerHTML = `<p class="small" style="color:var(--danger)">${esc(e?.status === 404 ? 'Сервер ещё не обновлён до версии с партнёрской программой — обновится сам после выкладки.' : e?.message || String(e))}</p>`;
      return;
    }
    draw();
  };

  // У старого «физлица» статус надо выбрать явно — по умолчанию не подставляем.
  const taxOptions = (cur) => `${data.taxStatuses && !data.taxStatuses[cur] ? '<option value="" selected disabled>физлицо — выберите статус</option>' : ''}${Object.entries(data.taxStatuses || {}).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(v)}</option>`).join('')}`;

  const detailHtml = (p) => {
    if (!detail || detail.partner.id !== p.id) return '<div class="spinner"></div>';
    const d = detail;
    return `
      <div style="margin-top:10px">
        <div class="small muted">Клиенты (${d.clients.length})</div>
        ${d.clients.map((c) => `<div class="small" style="padding:4px 0">${esc(c.venueName)} · с ${fmtDay(c.attachedAt)} · ${c.source === 'invite' ? 'приглашение' : 'ссылка'} · оплачено ${fmtMoney(c.paid)} · доход ${fmtMoney(c.income)}</div>`).join('') || '<div class="small muted">—</div>'}
        <div class="small muted" style="margin-top:8px">Начисления</div>
        ${d.accruals.slice(0, 50).map((a) => `<div class="row small" style="justify-content:space-between;gap:8px;padding:4px 0;border-top:1px solid var(--border);flex-wrap:wrap">
          <span>${fmtDay(a.paidAt)} · ${esc(a.venueName)} · ${fmtMoney(a.gross)} → база ${fmtMoney(a.base)} × ${a.percent}%</span>
          <span><b style="${a.status === 'reversed' ? 'text-decoration:line-through' : ''}">${fmtMoney(a.amount)}</b> ${a.clawback ? '<span class="muted">удержание</span>'
            : a.paidOut ? `<span class="muted">выплачено</span> <button class="btn-link f-pa-reverse" data-id="${esc(a.id)}" data-paid="1">удержать (возврат)</button>`
              : a.requested ? '<span class="muted">в запросе</span>'
                : `<button class="btn-link f-pa-reverse" data-id="${esc(a.id)}" data-restore="${a.status === 'reversed' ? '1' : ''}">${a.status === 'reversed' ? 'вернуть' : 'снять (возврат)'}</button>`}</span>
        </div>`).join('') || '<div class="small muted">—</div>'}
        ${d.payouts.length ? `<div class="small muted" style="margin-top:8px">Выплаты</div>${d.payouts.map((x) => `<div class="small">${fmtDay(x.paidAt)} · перечислено ${fmtMoney(x.net)}${x.ndfl ? ` (начислено ${fmtMoney(x.amount)}, НДФЛ ${fmtMoney(x.ndfl)})` : ''}${x.note ? ` · ${esc(x.note)}` : ''}${x.receiptUrl ? ` · <a href="${esc(x.receiptUrl)}" target="_blank" rel="noopener">чек</a>` : x.needReceipt ? ` · <span style="color:var(--warning)">чека нет (до ${fmtDay(x.receiptDue)})</span>` : ''}${x.receivedAt ? ' · получение подтверждено' : x.notReceivedAt ? ' · <span style="color:var(--danger)">менеджер: деньги не пришли</span>' : ''}</div>`).join('')}` : ''}
        <div class="small muted" style="margin-top:8px">Приглашения: ${d.invites.length}</div>
      </div>`;
  };

  const editHtml = (p) => `
    <div class="card" style="margin-top:10px">
      <label class="field"><span>Имя</span><input id="f-pe-name" value="${esc(p.name)}" maxlength="80"></label>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <label class="field grow"><span>Процент</span><input id="f-pe-percent" type="number" min="0" max="100" step="0.1" value="${esc(String(p.percent))}"></label>
        <label class="field grow"><span>Срок, мес. (0 — бессрочно)</span><input id="f-pe-months" type="number" min="0" max="120" value="${esc(String(p.months || 0))}"></label>
      </div>
      <label class="field"><span>Код ссылки</span><input id="f-pe-code" value="${esc(p.code)}" maxlength="20"></label>
      <label class="field"><span>Налоговый статус</span><select id="f-pe-tax">${taxOptions(p.taxStatus)}</select></label>
      <div class="row" style="gap:8px"><button class="btn btn-primary f-pe-save" data-id="${esc(p.id)}" style="width:auto">Сохранить</button><button class="btn btn-ghost" id="f-pe-cancel" style="width:auto">Отмена</button></div>
    </div>`;

  const draw = () => {
    // Раздел уже закрыт (перешли на другую вкладку), а данные пришли — не рисуем.
    if (!body || !body.isConnected) return;
    const s = data.settings || {};
    const bot = data.bot || {};
    renderKeepingInputs(body, `
      <div class="card">
        <b>Расчёт вознаграждения</b>
        <p class="small muted">Процент менеджера считается от оплаты клиента после вашего налога и комиссии платёжной системы. Robokassa обычно присылает комиссию в уведомлении — тогда берётся она, иначе ставка ниже.</p>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
          <label class="field grow" style="margin:0"><span>Ваш налог, %</span><input id="f-pa-tax" type="number" min="0" max="50" step="0.1" value="${esc(String(s.taxPct ?? 6))}"></label>
          <label class="field grow" style="margin:0"><span>Комиссия платёжной системы, %</span><input id="f-pa-fee" type="number" min="0" max="20" step="0.1" value="${esc(String(s.feePct ?? 3.9))}"></label>
        </div>
        <p class="small muted" style="margin:12px 0 8px">Менеджер сам запрашивает выплату в кабинете или в боте. Начисление доступно к запросу через N дней после оплаты клиента — если за это время клиенту вернут деньги, начисление просто снимется. Возврат после выплаты удерживается из следующей.</p>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
          <label class="field grow" style="margin:0"><span>Минимальная выплата, ₽</span><input id="f-pa-min" type="number" min="0" max="100000" step="100" value="${esc(String(s.payoutMin ?? 1000))}"></label>
          <label class="field grow" style="margin:0"><span>Ожидание после оплаты, дней</span><input id="f-pa-hold" type="number" min="0" max="60" step="1" value="${esc(String(s.holdDays ?? 14))}"></label>
          <button class="btn btn-ghost" id="f-pa-settings" style="width:auto">Сохранить</button>
        </div>
        <p class="small muted" style="margin:14px 0 6px">Для бухгалтера: все выплаты за год — суммы, проверка статуса в ФНС, чеки самозанятых, назначение платежа.</p>
        <button class="btn btn-ghost" id="f-pa-csv" style="width:auto">Реестр выплат за ${new Date().getFullYear()} (Excel)</button>
      </div>
      <div class="card">
        <b>Telegram-бот менеджеров</b>
        ${bot.connected ? `<p class="small">✓ Подключён: @${esc(bot.username)}. Менеджеры подключают его кнопкой в своём кабинете.</p><button class="btn btn-ghost" id="f-pa-bot-off" style="width:auto">Отключить</button>`
          : `<p class="small muted">Создайте бота в @BotFather (команда /newbot), вставьте токен. Бот сообщает менеджерам о новых клиентах, оплатах и выплатах; приглашения, доход, выплаты и чеки — кнопками. Описание и меню бот оформит сам; аватарку поставьте в @BotFather → /setuserpic.</p>
            <div class="row" style="gap:8px;flex-wrap:wrap"><input id="f-pa-bot-token" class="grow" placeholder="123456789:AA…" autocomplete="off" style="margin:0;min-width:220px"><button class="btn btn-ghost" id="f-pa-bot-on" style="width:auto">Подключить</button></div>`}
      </div>
      <div class="card">
        <b>Добавить менеджера</b>
        <p class="small muted">Менеджеру придёт письмо «задайте пароль и войдите» — кабинет откроется по адресу zalpos.ru/#/partner.</p>
        <label class="field"><span>Почта</span><input id="f-pa-email" type="email" placeholder="manager@example.com"></label>
        <label class="field"><span>Имя (будет в письмах клиентам)</span><input id="f-pa-name" maxlength="80" placeholder="Анна Петрова"></label>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <label class="field grow"><span>Процент</span><input id="f-pa-percent" type="number" min="0" max="100" step="0.1" value="20"></label>
          <label class="field grow"><span>Срок, мес. (0 — бессрочно)</span><input id="f-pa-months" type="number" min="0" max="120" value="0"></label>
        </div>
        <label class="field"><span>Налоговый статус менеджера</span><select id="f-pa-taxstatus">${taxOptions('npd')}</select></label>
        <button class="btn btn-primary" id="f-pa-add" style="width:auto">Добавить</button>
      </div>
      ${(data.partners || []).length ? data.partners.map((p) => `
        <div class="card">
          <div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:flex-start">
            <div style="min-width:0">
              <b>${esc(p.name || p.email)}</b>${p.status !== 'active' ? ' <span class="small" style="color:var(--warning)">приостановлен</span>' : ''}
              <div class="small muted">${esc(p.email)} · ${esc(String(p.percent))}%${p.months ? ` · ${p.months} мес.` : ' · бессрочно'} · ${esc(p.taxStatusLabel)}${p.telegram ? ' · Telegram ✓' : ''}${p.termsAcceptedAt ? '' : ' · правила ещё не приняты'}</div>
              <div class="small muted" style="word-break:break-all">${esc(p.link)}</div>
            </div>
            <div class="small" style="text-align:right">клиентов: <b>${p.summary.clients}</b><br>начислено: ${fmtMoney(p.summary.total)}<br>к выплате: <b>${fmtMoney(p.summary.unpaid)}</b><br>выплачено: ${fmtMoney(p.summary.paid)}</div>
          </div>
          ${p.request ? `<div class="sec-warn" style="margin-top:10px;padding:12px 14px;border-radius:12px">
            <b>💸 Запрос выплаты от ${fmtDay(p.request.requestedAt)}: перевести ${fmtMoney(p.request.net)}</b>
            ${p.request.fullDetails ? `<div class="small" style="margin-top:4px">СБП <b>${esc(p.request.fullDetails.phone)}</b> · ${esc(p.request.fullDetails.bank)} · ${esc(p.request.fullDetails.fullName)} · ИНН ${esc(p.request.fullDetails.inn)}</div>` : '<div class="small" style="color:var(--danger)">Реквизиты не расшифровались — попросите менеджера указать их заново и отклоните запрос.</div>'}
            ${p.request.taxStatus === 'npd' ? `<div class="small" style="margin-top:4px">${p.request.npdCheck?.ok ? `✅ ФНС подтвердила статус самозанятого на ${esc(p.request.npdCheck.date || '')}; перед отметкой выплаты проверим ещё раз` : '⚠️ ФНС не ответила при запросе — статус проверим при отметке выплаты'}</div>` : ''}
            <div class="small" style="margin-top:4px">Перевести по договору до <b>${fmtDay(p.request.payBy)}</b> · с расчётного счёта ИП, по СБП</div>
            ${p.request.purpose ? `<div class="small" style="margin-top:6px">Назначение платежа: <span class="muted">${esc(p.request.purpose)}</span> <button class="btn-link f-pa-copy" data-text="${esc(p.request.purpose)}">Скопировать</button></div>` : ''}
            <div class="row" style="gap:14px;flex-wrap:wrap;margin-top:8px">
              <button class="btn btn-primary f-pa-reqpay" data-id="${esc(p.id)}" data-req="${esc(p.request.id)}" data-net="${p.request.net}" style="width:auto">Перевёл — отметить выплату</button>
              <button class="btn-link f-pa-reqreject" data-req="${esc(p.request.id)}">Отклонить</button>
            </div>
          </div>` : ''}
          ${p.receiptsMissing ? `<p class="small" style="color:var(--warning)">🧾 Самозанятый ещё не прислал чек по ${p.receiptsMissing} ${plural(p.receiptsMissing, 'выплате', 'выплатам', 'выплатам')}. Чек обязателен (422-ФЗ, ст. 14) — бот напоминает менеджеру.</p>` : ''}
          ${p.taxStatus === 'person' ? '<p class="small" style="color:var(--warning)">Статус «физлицо» больше не поддерживается: выплаты закрыты. Когда менеджер оформит самозанятость или ИП, выберите статус в «Изменить».</p>' : ''}
          <div class="row" style="gap:14px;flex-wrap:wrap;margin-top:8px">
            <button class="btn-link f-pa-open" data-id="${esc(p.id)}">${openId === p.id ? 'Скрыть' : 'Подробнее'}</button>
            <button class="btn-link f-pa-edit" data-id="${esc(p.id)}">Изменить</button>
            <button class="btn-link f-pa-contract" data-id="${esc(p.id)}" data-code="${esc(p.code)}">Договор (Word)</button>
            <button class="btn-link f-pa-act" data-id="${esc(p.id)}">Акт за месяц</button>
            <button class="btn-link f-pa-letter" data-email="${esc(p.email)}">Письмо для входа</button>
            ${!p.request && p.summary.unpaid > 0 ? `<button class="btn-link f-pa-pay" data-id="${esc(p.id)}" data-amount="${p.summary.unpaid}">Выплатить без запроса ${fmtMoney(p.summary.unpaid)}</button>` : ''}
            <button class="btn-link f-pa-status" data-id="${esc(p.id)}" data-status="${p.status === 'active' ? 'stopped' : 'active'}">${p.status === 'active' ? 'Приостановить' : 'Возобновить'}</button>
          </div>
          ${editId === p.id ? editHtml(p) : ''}
          ${openId === p.id ? detailHtml(p) : ''}
        </div>`).join('') : '<p class="small muted">Менеджеров пока нет.</p>'}
    `);
    const partnerOf = (id) => data.partners.find((x) => x.id === id);
    const save = async (p, patch) => {
      await callSaasGateway('partnerAdminSave', { id: p.id, name: p.name, percent: p.percent, months: p.months, taxStatus: p.taxStatus, status: p.status, ...patch });
    };
    const act = (fn) => async (e) => {
      try {
        await fn(e.currentTarget);
        await load();
      } catch (err) {
        if (err?.message !== 'отменено') toast(`Не получилось: ${err?.message || err}`);
      }
    };
    if ($('f-pa-settings')) $('f-pa-settings').onclick = act(async () => {
      await callSaasGateway('partnerAdminSettings', { taxPct: Number($('f-pa-tax').value), feePct: Number($('f-pa-fee').value), payoutMin: Number($('f-pa-min').value), holdDays: Number($('f-pa-hold').value) });
      toast('Сохранено');
    });
    if ($('f-pa-bot-on')) $('f-pa-bot-on').onclick = act(async () => {
      await callSaasGateway('partnerAdminBot', { token: $('f-pa-bot-token').value.trim() });
      toast('Бот подключён');
    });
    if ($('f-pa-bot-off')) $('f-pa-bot-off').onclick = act(async () => {
      if (!confirm('Отключить бота менеджеров?')) throw new Error('отменено');
      await callSaasGateway('partnerAdminBot', { disconnect: true });
    });
    if ($('f-pa-add')) $('f-pa-add').onclick = act(async () => {
      const r = await callSaasGateway('partnerAdminSave', {
        email: $('f-pa-email').value.trim(), name: $('f-pa-name').value.trim(), percent: Number($('f-pa-percent').value),
        months: Number($('f-pa-months').value), taxStatus: $('f-pa-taxstatus').value,
      });
      const email = $('f-pa-email').value.trim();
      if (r.data.mailed) toast(r.data.restored ? 'Менеджер возвращён' : 'Менеджер добавлен, письмо отправлено');
      else toast(`Менеджер ${r.data.restored ? 'возвращён' : 'добавлен'}. ${await sendPartnerLoginLetter(email)}`);
      $('f-pa-email').value = '';
      $('f-pa-name').value = '';
    });
    document.querySelectorAll('.f-pa-letter').forEach((el) => {
      el.onclick = async () => {
        el.disabled = true;
        toast(await sendPartnerLoginLetter(el.dataset.email));
        el.disabled = false;
      };
    });
    document.querySelectorAll('.f-pa-open').forEach((el) => { el.onclick = act(async (b) => { openId = openId === b.dataset.id ? null : b.dataset.id; detail = null; }); });
    document.querySelectorAll('.f-pa-edit').forEach((el) => { el.onclick = () => { editId = editId === el.dataset.id ? null : el.dataset.id; draw(); }; });
    if ($('f-pe-cancel')) $('f-pe-cancel').onclick = () => { editId = null; draw(); };
    document.querySelectorAll('.f-pe-save').forEach((el) => {
      el.onclick = act(async (b) => {
        await save(partnerOf(b.dataset.id), {
          name: $('f-pe-name').value.trim(), percent: Number($('f-pe-percent').value), months: Number($('f-pe-months').value),
          code: $('f-pe-code').value.trim(), taxStatus: $('f-pe-tax').value,
        });
        editId = null;
        toast('Сохранено');
      });
    });
    document.querySelectorAll('.f-pa-contract').forEach((el) => {
      el.onclick = async () => {
        try {
          const idToken = await state.auth.currentUser.getIdToken();
          const res = await fetch(`${SAAS_GATEWAY_URL}/partnerAdminContract`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ id: el.dataset.id }),
          });
          if (!res.ok) {
            const json = await res.json().catch(() => null);
            throw new Error(json?.error || `Сервис ответил ошибкой (${res.status})`);
          }
          const url = URL.createObjectURL(await res.blob());
          const a = document.createElement('a');
          a.href = url;
          a.download = `Договор_${el.dataset.code}-${new Date().getFullYear()}.docx`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          toast('Договор скачан. Ваши реквизиты — из «Безопасность → Платформа → Реквизиты»; паспорт, ИНН и счёт менеджера впишите вручную');
        } catch (e) {
          toast(`Не удалось скачать договор: ${e?.message || e}`);
        }
      };
    });
    document.querySelectorAll('.f-pa-status').forEach((el) => { el.onclick = act(async (b) => { await save(partnerOf(b.dataset.id), { status: b.dataset.status }); }); });
    document.querySelectorAll('.f-pa-pay').forEach((el) => {
      el.onclick = act(async (b) => {
        const note = prompt(`Отметить выплату ${fmtMoney(b.dataset.amount)}? Комментарий (например, «перевод на карту 24.10»):`, '');
        if (note === null) throw new Error('отменено');
        paidToast(await payWithNpd({ partnerId: b.dataset.id, expected: Number(b.dataset.amount), note }));
      });
    });
    // Самозанятому: сервер сверяет статус с ФНС; если ФНС не ответила (428) —
    // только после подтверждения, что статус проверен вручную.
    const payWithNpd = async (payload) => {
      try {
        return (await callSaasGateway('partnerAdminPayout', payload)).data;
      } catch (e) {
        if (e.status !== 428) throw e;
        if (!confirm(`${e.message}\n\nОткройте npd.nalog.ru/check-status, проверьте ИНН на сегодня. Статус действующий — нажмите ОК.`)) throw new Error('отменено');
        return (await callSaasGateway('partnerAdminPayout', { ...payload, npdManual: true })).data;
      }
    };
    const paidToast = () => toast('Выплата отмечена — менеджеру ушло уведомление');
    document.querySelectorAll('.f-pa-reqpay').forEach((el) => {
      el.onclick = act(async (b) => {
        const note = prompt(`Вы перевели ${fmtMoney(b.dataset.net)}? Комментарий для менеджера (например, «СБП 24.10, Сбербанк»):`, '');
        if (note === null) throw new Error('отменено');
        paidToast(await payWithNpd({ partnerId: b.dataset.id, requestId: b.dataset.req, note }));
      });
    });
    document.querySelectorAll('.f-pa-copy').forEach((el) => { el.onclick = () => copyToClipboard(el.dataset.text); });
    document.querySelectorAll('.f-pa-act').forEach((el) => {
      el.onclick = act(async (b) => {
        const month = prompt('Акт за какой месяц? В виде ГГГГ-ММ:', prevMonthIso());
        if (month === null) throw new Error('отменено');
        await downloadFromGateway('partnerAdminAct', { id: b.dataset.id, month: month.trim() }, `Акт_${month}.docx`);
        toast('Акт скачан — подпишите и обменяйтесь сканами с менеджером');
      });
    });
    if ($('f-pa-csv')) $('f-pa-csv').onclick = act(async () => {
      await downloadFromGateway('partnerAdminPayoutsCsv', { year: new Date().getFullYear() }, 'Реестр_выплат.csv');
      toast('Реестр скачан — откройте в Excel');
    });
    document.querySelectorAll('.f-pa-reqreject').forEach((el) => {
      el.onclick = act(async (b) => {
        const reason = prompt('Почему отклоняете? Менеджер увидит это в Telegram (например, «проверьте номер телефона»):', '');
        if (reason === null) throw new Error('отменено');
        await callSaasGateway('partnerAdminPayoutReject', { requestId: b.dataset.req, reason });
        toast('Запрос отклонён');
      });
    });
    document.querySelectorAll('.f-pa-reverse').forEach((el) => {
      el.onclick = act(async (b) => {
        if (b.dataset.paid && !confirm('Начисление уже выплачено. Удержать его из следующей выплаты менеджера (клиенту вернули деньги)?')) throw new Error('отменено');
        if (!b.dataset.paid && !b.dataset.restore && !confirm('Снять начисление (клиенту вернули деньги)?')) throw new Error('отменено');
        await callSaasGateway('partnerAdminReverse', { accrualId: b.dataset.id, restore: !!b.dataset.restore });
      });
    });
  };

  load();
}

// ---------- ПАНЕЛЬ ПЛАТФОРМЫ (СУПЕР-АДМИН) ----------

const ADMIN_NAV = [
  { id: 'overview', icon: 'home', color: '#2F6FED', label: 'Обзор' },
  { id: 'tenants', icon: 'building', color: '#6366F1', label: 'Заведения' },
  { id: 'plans', icon: 'gem', color: '#8B5CF6', label: 'Тарифы' },
  { id: 'builds', icon: 'device', color: '#0EA5E9', label: 'Сборки APK' },
  { id: 'broadcasts', icon: 'bell', color: '#FB923C', label: 'Объявления' },
  { id: 'support', icon: 'chat', color: '#22C55E', label: 'Поддержка' },
  { id: 'partners', icon: 'users', color: '#14B8A6', label: 'Менеджеры' },
  { id: 'staff', icon: 'badge', color: '#F97316', label: 'Сотрудники платформы' },
  { id: 'audit', icon: 'list', color: '#94A3B8', label: 'Журнал' },
  { id: 'security', icon: 'lock', color: '#DC2626', label: 'Безопасность' },
];

function keepAdminScreen() {
  if (!state.uid || !state.isSuperAdmin) return false;
  if ($('admin-root')?.dataset.uid !== String(state.uid)) return false;
  const h = location.hash;
  return h === '#/admin' || ((h === '' || h === '#/' || h === '#') && state.tenantsLoaded && !state.tenants.length);
}

function adminConsoleLinkHtml() {
  return state.tenants.length
    ? `<a href="#/" id="admin-console-link" class="nav-item" style="text-decoration:none">${navIconHtml('back', '#64748B')}<span>В консоль</span></a>`
    : `<a href="#/onboarding" id="admin-console-link" class="nav-item" style="text-decoration:none">${navIconHtml('plus', '#22C55E')}<span>Своё заведение</span></a>`;
}

function adminNavHtml(activeTab) {
  const activeMeta = ADMIN_NAV.find((t) => t.id === activeTab);
  // Без своего заведения «В консоль» вернуло бы сюда же — вместо неё
  // предлагаем завести заведение.
  const consoleLink = adminConsoleLinkHtml();
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
  // Панель уже открыта для этого же входа (route() зовётся несколько раз,
  // пока догружаются заведения и проверка менеджера) — не пересобираем её:
  // иначе само закрывается открытое меню и сбрасывается вкладка. Только
  // обновляем ссылку «В консоль» и заново подписываемся на данные.
  if ($('admin-root')?.dataset.uid === String(state.uid) && state.screenSubs.length) {
    const link = $('admin-console-link');
    if (link) link.outerHTML = adminConsoleLinkHtml();
    return;
  }
  screenEl().innerHTML = `
    <div id="admin-root" data-uid="${esc(String(state.uid))}">
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
          <p class="small muted">Одно заведение: «Старт» 1 790 ₽/мес (касса на 2 устройствах, приложение гостя, без ИИ),
          «Бизнес» 2 390 ₽ (до 5 устройств, приложение гостя и ИИ), «Про» 2 990 ₽ (устройства без ограничений,
          приоритетная поддержка). Сеть: «Сеть» 2 590 ₽ за первую точку + 990 ₽ за каждую следующую (до 5 устройств
          на точке), «Сеть Про» 3 990 ₽ + 1 290 ₽ (без ограничений, приоритетная поддержка). Сотрудники везде без
          ограничений. Год — выгода 20%, полгода — около 10%. Пробный период 7 дней. Тарифы вне сетки уходят в архив:
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
        <p class="small muted">Показываются баннером на «Обзоре» личного кабинета всем владельцам, пока объявление активно. ИИ-бот поддержки сразу видит активные объявления и отвечает по ним на вопросы об акциях и новостях; снятое объявление он забывает. Пишите условия акции полностью — сроки, кому, как получить: бот ничего сверх текста не додумывает.</p>
        <div class="card">
          <label class="field"><span>Заголовок</span>
            <input id="f-broadcast-title" placeholder="Например: Новая функция — учёт переработки">
          </label>
          <label class="field"><span>Текст</span>
            <textarea id="f-broadcast-body" rows="6" placeholder="Коротко, что изменилось и что нужно сделать. Каждая мысль — с новой строки, ссылки станут кликабельными"></textarea>
          </label>
          <button class="btn btn-primary" id="f-broadcast-publish">Опубликовать</button>
        </div>
        <div id="admin-broadcasts"><div class="spinner"></div></div>
      </div>

      <div class="admin-tab-panel" data-panel="support">
        <h1>Поддержка</h1>
        <div id="admin-support-bot"><div class="spinner"></div></div>
        <h2 style="margin-top:18px">Обращения</h2>
        <div id="admin-support"><div class="spinner"></div></div>
      </div>

      <div class="admin-tab-panel" data-panel="partners">
        <h1>Менеджеры</h1>
        <p class="small muted">Партнёрская программа: менеджеры приводят новые заведения по личной ссылке или приглашению на почту и получают процент с их оплат. Правила для менеджеров — <a href="#/partner-terms" target="_blank">zalpos.ru/#/partner-terms</a>.</p>
        <div id="admin-partners"><div class="spinner"></div></div>
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

  watchAdminData();
  // Отметка входа в панель (IP, браузер) — см. handleRecordAdminLogin в
  // saas-gateway. Сбой не мешает работе панели.
  callSaasGateway('recordAdminLogin', {}).catch(() => {});
}

function watchAdminData() {
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
  watchSupportBotAdmin();
  watchAdminPartners();
  watchSecurity();
}

// ИИ-бот поддержки в Telegram (saas-gateway/support-bot.js): токен, рабочая
// группа с «Темами», сотрудники, провайдер ИИ, база знаний. Токен и ключ ИИ
// уходят только на сервер и хранятся там зашифрованными — обратно в панель
// не возвращаются.
function watchSupportBotAdmin() {
  const body = $('admin-support-bot');
  let st = null;
  let loadError = '';
  let groupCode = null;
  let knowledge = null;
  let saving = false;
  let checking = false;
  // Черновик списка ключей ИИ: правки живут здесь до «Сохранить».
  let provDraft = null;
  const SB_VENDORS_FALLBACK = [
    { id: 'tooken', title: 'Tooken Club', baseUrl: 'https://tooken.club/v1', light: 'gpt-4o-mini', heavy: 'gpt-4o', hint: 'Ключ из кабинета tooken.club' },
    { id: 'custom', title: 'Свой шлюз', baseUrl: '', light: '', heavy: '', hint: 'OpenAI-совместимый адрес …/v1' },
  ];
  const sbVendors = () => (st && st.ai && st.ai.vendors) || SB_VENDORS_FALLBACK;
  const sbVendor = (id) => sbVendors().find((v) => v.id === id) || sbVendors()[sbVendors().length - 1];
  const draftFrom = (s) => {
    const list = (s && s.ai && s.ai.providers) || [];
    return list.length ? list.map((p) => ({ ...p, apiKey: '' }))
      : [{ id: '', vendor: 'tooken', baseUrl: '', light: '', heavy: '', apiKey: '', enabled: true, hasKey: false, status: null, usage: null }];
  };
  const provStatus = (p) => {
    if (!p.enabled) return '<span class="muted">⏸ выключен</span>';
    if (!p.hasKey && !p.apiKey) return '<span style="color:var(--danger)">нет ключа</span>';
    const x = p.status;
    const used = p.usage && p.usage.calls ? ` · сегодня ${p.usage.calls} отв.` : '';
    if (!x) return `<span class="muted">ещё не отвечал${used}</span>`;
    if (x.state === 'ok') return `<span style="color:var(--success)">✓ работает${used}</span>`;
    const until = x.until && x.until > Date.now() ? ` до ${new Date(x.until).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : '';
    return `<span style="color:${x.state === 'exhausted' ? 'var(--warning)' : 'var(--danger)'}">${x.state === 'exhausted' ? '🪫' : '⚠️'} ${esc(x.text || x.state)}${until}</span>`;
  };

  const load = async () => {
    try {
      st = (await callSaasGateway('supportBotStatus', {})).data;
      loadError = '';
      if (!provDraft) provDraft = draftFrom(st);
    } catch (e) {
      loadError = e?.status === 404 ? 'Сервер ещё не обновлён до версии с ботом поддержки — обновится сам после выкладки.' : (e?.message || String(e));
    }
    draw();
  };
  const loadKnowledge = async () => {
    try {
      knowledge = fromWire((await callSaasGateway('supportKnowledge', {})).data.knowledge || []);
    } catch (e) {
      knowledge = [];
    }
    draw();
  };

  const draw = () => {
    // Раздел уже закрыт (перешли на другую вкладку), а данные пришли — не рисуем.
    if (!body || !body.isConnected) return;
    if (!st && !loadError) { body.innerHTML = '<div class="spinner"></div>'; return; }
    const s = st || {};
    if (!provDraft) provDraft = draftFrom(s);
    const g = s.group;
    const groupLine = !s.groupChatId ? '<span style="color:var(--warning)">не подключена</span>'
      : g && g.admin && g.canManageTopics ? `✓ ${esc(g.title || String(s.groupChatId))}`
        : `<span style="color:var(--danger)">${esc(g?.title || String(s.groupChatId))}: ${g?.error ? esc(g.error) : 'боту нужны права администратора с «Управлением темами»'}</span>`;
    const usage = s.usage || {};
    renderKeepingInputs(body, `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <b>🤖 ИИ-бот поддержки в Telegram</b>
          <span class="small" style="font-weight:700;color:${s.connected ? 'var(--success)' : 'var(--warning)'}">
            ${s.connected ? `Работает · <a href="https://t.me/${esc(s.username)}" target="_blank" rel="noopener">@${esc(s.username)}</a>` : 'Не подключён'}
          </span>
        </div>
        ${loadError ? `<p class="small" style="color:var(--danger)">${esc(loadError)}</p>` : ''}
        <p class="small muted" style="margin-top:6px">Клиенты пишут боту — ИИ отвечает сразу, видя подписку, кассы, сборки и ошибки заведения.
          Каждое обращение — отдельная тема в вашей группе. Ответили в теме сами — ИИ замолкает. Слова «оператор», «верните деньги», жалобы — сразу к вам.</p>
        <details style="margin:8px 0">
          <summary class="small" style="cursor:pointer;font-weight:600">Как подключить — 6 шагов</summary>
          <ol class="small" style="margin:8px 0 0 18px;line-height:1.6">
            <li>В Telegram откройте <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> → <b>/newbot</b> → придумайте имя (например «ZalPOS Поддержка») → скопируйте токен. Отдельный бот, не бот заведения.</li>
            <li>Создайте группу для сотрудников поддержки → настройки группы → <b>«Темы»</b> → включить.</li>
            <li>Добавьте бота в группу → сделайте <b>администратором</b> с правами <b>«Управление темами»</b>, <b>«Блокировка участников»</b> и <b>«Удаление сообщений»</b>.</li>
            <li>Вставьте токен ниже и нажмите «Сохранить». Затем впишите ID группы или нажмите «Код для группы» и отправьте код в группу.</li>
            <li>Впишите Telegram ID сотрудников (узнать: написать <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a>) — им придёт сигнал «🔴 Нужен человек». Каждый один раз жмёт у бота «Старт».</li>
            <li>Закройте группу: настройки → <b>«Тип группы» → «Частная»</b>, в ссылке-приглашении включите <b>«Заявки на вступление»</b>. Бот сам примет сотрудников из списка, остальным откажет, а вошедших по старой ссылке уберёт.</li>
          </ol>
        </details>
        <label class="field"><span>Токен бота</span>
          <input type="password" autocomplete="off" id="f-sb-token" placeholder="${s.connected ? '✓ сохранён · пусто — не менять' : '123456789:AA…  из @BotFather'}">
        </label>
        <label class="field"><span>ID группы поддержки</span>
          <input id="f-sb-group" inputmode="numeric" value="${esc(s.groupChatId ? String(s.groupChatId) : '')}" placeholder="-1001234567890">
        </label>
        <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin:-4px 0 8px">
          <span class="small muted">Группа: ${groupLine}</span>
          ${s.connected ? '<button class="btn-link" id="f-sb-code" style="width:auto">Код для группы</button>' : ''}
        </div>
        ${groupCode ? `
          <div class="card" style="background:var(--surface-2)">
            <div class="small">Отправьте в группу (действует 30 минут):</div>
            <div class="row" style="gap:8px;align-items:center;margin-top:6px">
              <code style="font-size:16px;font-weight:700">${esc(groupCode)}</code>
              <button class="btn-link" id="f-sb-code-copy" style="width:auto">Скопировать</button>
            </div>
          </div>` : ''}
        <label class="field"><span>Telegram ID сотрудников поддержки</span>
          <textarea id="f-sb-staff" rows="3" placeholder="123456789 Константин&#10;987654321 Мария">${esc(s.staff || '')}</textarea>
        </label>

        <label class="field"><span>Администраторы бота — кнопка «⚙️ Админка» в Telegram</span>
          <textarea id="f-sb-admins" rows="2" placeholder="123456789 Константин">${esc(s.admins || '')}</textarea>
        </label>

        <div style="margin-top:12px;font-weight:700">ИИ</div>
        <label class="row" style="gap:8px;align-items:center;margin:6px 0">
          <input type="checkbox" id="f-sb-ai-on" style="width:auto" ${s.aiEnabled === false ? '' : 'checked'}>
          <span class="small">ИИ отвечает первым (выключите — все обращения сразу к людям)</span>
        </label>
        <label class="row" style="gap:8px;align-items:center;margin:6px 0">
          <input type="checkbox" id="f-sb-autolearn" style="width:auto" ${s.autoLearn === false ? '' : 'checked'}>
          <span class="small">Автообучение: бот сам запоминает решения из диалогов — прежде всего ваши ответы и ответы сотрудников</span>
        </label>
        <label class="row" style="gap:8px;align-items:center;margin:6px 0">
          <input type="checkbox" id="f-sb-ru-only" style="width:auto" ${s.ruOnly === false ? '' : 'checked'}>
          <span class="small"><b>Данные только в России</b>: обращения — в кабинете, текст обезличивается на сервере в РФ до облака, Telegram и ИИ, файлы остаются в РФ, клиентам в личке Telegram бот отвечает ссылкой на кабинет. Уведомлять Роскомнадзор о передаче за рубеж не нужно. Выключайте, только если такое уведомление подано</span>
        </label>
        <label class="row" style="gap:8px;align-items:center;margin:6px 0">
          <input type="checkbox" id="f-sb-ai-ru" style="width:auto" ${s.aiRu ? 'checked' : ''}>
          <span class="small">ИИ-провайдер с серверами в России (например, GigaChat или YandexGPT) — тогда ИИ смотрит и сами скриншоты. Без этого ИИ получает текст скриншота, распознанный на сервере в России и очищенный от личных данных</span>
        </label>
        <label class="row" style="gap:8px;align-items:center;margin:6px 0">
          <input type="checkbox" id="f-sb-web-on" style="width:auto" ${s.web && s.web.enabled === false ? '' : 'checked'}>
          <span class="small">Поиск в интернете: по внешним вопросам (законы, банки, ОФД, оборудование, где купить) бот сам ищет, читает страницы и отвечает со ссылкой на источник</span>
        </label>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin:0 0 6px">
          <label class="field" style="flex:1 1 200px;margin:0"><span>Поисковик</span>
            <select id="f-sb-web-provider">
              ${((s.web && s.web.providers) || [{ id: 'auto', title: 'Без ключа (DuckDuckGo)' }]).map((p) => `<option value="${esc(p.id)}" ${((s.web && s.web.provider) || 'auto') === p.id ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
            </select>
          </label>
          <label class="field" style="flex:1 1 200px;margin:0"><span>Ключ поисковика${s.web && s.web.hasKey ? ' · ✓ сохранён' : ''}</span>
            <input type="password" id="f-sb-web-key" autocomplete="off" placeholder="${s.web && s.web.hasKey ? 'сохранён — оставьте пустым' : 'не нужен для «Без ключа»'}">
          </label>
        </div>
        ${s.web && s.web.lastError ? `<p class="small" style="color:var(--danger);margin:0 0 6px">Поиск: ${esc(s.web.lastError)}</p>` : ''}
        ${s.web ? `<p class="small muted" style="margin:0 0 8px">Сегодня поисков: ${Number(s.web.today) || 0}. Brave, Tavily и Serper надёжнее бесплатного варианта — ключ берётся на их сайтах.</p>` : ''}
        <label class="field"><span>Какой моделью отвечать</span>
          <select id="f-sb-routing">
            ${[['auto', 'Авто — сам выбирает (рекомендуем)'], ['light', 'Всегда лёгкая — дешевле'], ['heavy', 'Всегда сильная — точнее']]
              .map(([k, t]) => `<option value="${k}" ${((s.ai && s.ai.routing) || 'auto') === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}
          </select>
        </label>
        <p class="small muted" style="margin:-4px 0 8px">Авто: простые вопросы — лёгкая модель (в 10–20 раз дешевле), юридические, расчёты и долгие диалоги — сильная. Ключи — по порядку: бот пишет через верхний, а когда у него кончились токены или он не отвечает — сам переходит к следующему и пишет админам. Модели можно не указывать — бот выберет сам.</p>
        ${(provDraft || []).map((p, i) => {
          const v = sbVendor(p.vendor);
          return `
          <div class="card" style="background:var(--surface-2);padding:12px">
            <div class="row" style="justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
              <b class="small">${i + 1}. ${esc(v.title)}</b>
              <span class="small">${provStatus(p)}</span>
            </div>
            <label class="field"><span>Провайдер</span>
              <select class="f-sb-p" data-i="${i}" data-f="vendor">${sbVendors().map((x) => `<option value="${esc(x.id)}" ${x.id === p.vendor ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select>
            </label>
            <label class="field"><span>API-ключ</span>
              <input type="password" autocomplete="off" class="f-sb-p" data-i="${i}" data-f="apiKey" value="${esc(p.apiKey || '')}" placeholder="${esc(p.hasKey ? '✓ сохранён · пусто — не менять' : v.hint || '')}">
            </label>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <label class="field grow"><span>Лёгкая модель</span>
                <input class="f-sb-p" data-i="${i}" data-f="light" value="${esc(p.light || '')}" placeholder="${esc(v.light ? `авто: ${v.light}` : 'авто — выберет бот')}">
              </label>
              <label class="field grow"><span>Сильная модель</span>
                <input class="f-sb-p" data-i="${i}" data-f="heavy" value="${esc(p.heavy || '')}" placeholder="${esc(v.heavy ? `авто: ${v.heavy}` : 'авто — выберет бот')}">
              </label>
            </div>
            ${p.medium || p.max ? `<p class="small muted" style="margin:-4px 0 10px">Бот переключает модели по сложности вопроса: лёгкая — <b>${esc(p.light || '—')}</b>, обычная — <b>${esc(p.medium || '—')}</b>, сильная — <b>${esc(p.heavy || '—')}</b>, если не помогло — <b>${esc(p.max || '—')}</b>${p.vision ? `, скриншоты — <b>${esc(p.vision)}</b>` : ''}. Оставьте поля пустыми — бот подберёт лучшие по цене и качеству.</p>` : ''}
            <label class="field"><span>Адрес API${v.id === 'custom' ? '' : ' (необязательно)'}</span>
              <input class="f-sb-p" data-i="${i}" data-f="baseUrl" value="${esc(p.baseUrl && p.baseUrl !== v.baseUrl ? p.baseUrl : '')}" placeholder="${esc(v.baseUrl || 'https://ваш-шлюз/v1')}">
            </label>
            <div class="row" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
              <label class="row" style="gap:6px;align-items:center"><input type="checkbox" class="f-sb-p" data-i="${i}" data-f="enabled" style="width:auto" ${p.enabled !== false ? 'checked' : ''}><span class="small">Включён</span></label>
              <span class="row" style="gap:10px">
                ${i > 0 ? `<button class="btn-link f-sb-pm" data-i="${i}" data-d="-1" style="width:auto">↑ выше</button>` : ''}
                <button class="btn-link f-sb-pdel" data-i="${i}" style="width:auto;color:var(--danger)">Удалить</button>
              </span>
            </div>
            ${p.status && p.status.detail && p.status.state !== 'ok' ? `<p class="small muted" style="margin:6px 0 0">${esc(p.status.detail)}</p>` : ''}
          </div>`;
        }).join('')}
        <div class="row" style="gap:10px;flex-wrap:wrap;margin:4px 0 10px">
          ${(provDraft || []).length < 8 ? '<button class="btn" id="f-sb-padd" style="width:auto">➕ Добавить ключ</button>' : ''}
          ${s.connected ? `<button class="btn" id="f-sb-check" style="width:auto" ${checking ? 'disabled' : ''}>${checking ? 'Проверяю…' : '🧪 Проверить ключи'}</button>` : ''}
        </div>
        <div class="row" style="gap:10px;flex-wrap:wrap">
          <label class="field grow"><span>Пауза ИИ после ответа человека, ч</span>
            <input id="f-sb-pause" type="number" min="1" max="72" value="${esc(String(s.humanPauseHours || 12))}">
          </label>
          <label class="field grow"><span>Ответов ИИ в сутки, не больше</span>
            <input id="f-sb-limit" type="number" min="10" max="5000" value="${esc(String(s.dailyAiLimit || 300))}">
          </label>
        </div>
        <label class="field"><span>Часы работы людей (видит клиент)</span>
          <input id="f-sb-hours" value="${esc(s.workHours || '')}" placeholder="ежедневно с 10:00 до 22:00 МСК">
        </label>
        <button class="btn btn-primary" id="f-sb-save" ${saving ? 'disabled' : ''}>${saving ? 'Сохраняю…' : (s.connected ? 'Сохранить' : 'Подключить бота')}</button>
        ${s.connected ? `
          <p class="small muted" style="margin-top:10px">
            Сегодня ИИ ответил ${Number(usage.calls) || 0} раз (${(Number(usage.tokens) || 0).toLocaleString('ru-RU')} токенов${usage.balance ? `, с баланса ≈ ${Math.round(Number(usage.balance)).toLocaleString('ru-RU')}` : ''})${usage.byTier ? ` · ${['light', 'medium', 'heavy', 'max'].filter((k) => usage.byTier[k]).map((k) => `${{ light: 'лёгкая', medium: 'обычная', heavy: 'сильная', max: 'максимум' }[k]} ${usage.byTier[k]}`).join(', ')}` : ''} ·
            база решений: ${Number(s.knowledge) || 0} · статей в знаниях: ${Number(s.guideArticles) || 0} · файлов кода: ${Number(s.codeFiles) || 0}
          </p>` : ''}
        ${s.lastError ? `<p class="small" style="color:var(--danger)">Последняя ошибка: ${esc(s.lastError)}</p>` : ''}
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
          <b class="small">Старые данные поддержки</b>
          <p class="small muted" style="margin:4px 0 8px">Удалить обращения, пришедшие в Telegram (с сообщениями, файлами и памятью бота), обезличить обращения из кабинета, записанные до обезличивания, и удалить старые темы в группе сотрудников. Новые темы появятся сами.</p>
          <button type="button" class="btn btn-ghost" id="f-sb-purge" style="width:auto;color:var(--danger)">Удалить и обезличить…</button>
        </div>
        ${s.connected ? `
          <details id="f-sb-kb-details" style="margin-top:8px" ${knowledge ? 'open' : ''}>
            <summary class="small" style="cursor:pointer;font-weight:600">📚 Чему научился бот</summary>
            ${knowledge === null ? '<p class="small muted">Откройте, чтобы загрузить.</p>' : (knowledge.length ? knowledge.map((k) => `
              <div style="padding:8px 0;border-bottom:1px solid var(--border)">
                <div class="row" style="justify-content:space-between;gap:8px;align-items:flex-start">
                  <div class="small grow" style="min-width:0"><b>${esc(k.q || '')}</b>
                    <div class="muted rich-text" style="margin-top:2px">${esc(k.a || '')}</div>
                    <div class="muted" style="margin-top:2px">использован ${Number(k.uses) || 0} · помог ${Number(k.helpful) || 0}${k.createdBy ? ` · ${esc(k.createdBy)}` : ''}</div>
                  </div>
                  <button class="btn-link f-sb-kb-del" data-id="${esc(k.id)}" style="width:auto;color:var(--danger)">Удалить</button>
                </div>
              </div>`).join('') : '<p class="small muted">Пока пусто. Бот сам запоминает решения, когда вы или сотрудник ответили клиенту и вопрос решён, — обобщённо, без персональных данных. Можно и вручную: в теме обращения «📚 Запомнить».</p>')}
          </details>` : ''}
      </div>
    `);

    document.querySelectorAll('.f-sb-p').forEach((el) => {
      const apply = () => {
        const p = provDraft[Number(el.dataset.i)];
        if (!p) return;
        const f = el.dataset.f;
        if (f === 'enabled') p.enabled = el.checked;
        else if (f === 'vendor') {
          p.vendor = el.value;
          p.baseUrl = '';
          p.light = '';
          p.heavy = '';
          draw();
        } else p[f] = el.value;
      };
      el.oninput = apply;
      el.onchange = apply;
    });
    document.querySelectorAll('.f-sb-pm').forEach((el) => {
      el.onclick = () => {
        const i = Number(el.dataset.i);
        [provDraft[i - 1], provDraft[i]] = [provDraft[i], provDraft[i - 1]];
        draw();
      };
    });
    document.querySelectorAll('.f-sb-pdel').forEach((el) => {
      el.onclick = () => {
        const p = provDraft[Number(el.dataset.i)];
        if (p && p.hasKey && !confirm('Удалить этот ключ из бота? Он сотрётся после «Сохранить».')) return;
        provDraft.splice(Number(el.dataset.i), 1);
        draw();
      };
    });
    if ($('f-sb-padd')) {
      $('f-sb-padd').onclick = () => {
        provDraft.push({ id: '', vendor: 'tooken', baseUrl: '', light: '', heavy: '', apiKey: '', enabled: true, hasKey: false, status: null, usage: null });
        draw();
      };
    }
    if ($('f-sb-check')) {
      $('f-sb-check').onclick = async () => {
        checking = true;
        draw();
        try {
          st = (await callSaasGateway('supportBotAiCheck', {})).data;
          const keep = provDraft;
          provDraft = draftFrom(st).map((p, i) => ({ ...p, apiKey: (keep.find((k) => k.id && k.id === p.id) || keep[i] || {}).apiKey || '' }));
          const bad = (st.ai.providers || []).filter((p) => p.enabled && p.status && p.status.state !== 'ok');
          toast(bad.length ? `Не работают: ${bad.map((p) => p.title).join(', ')}` : 'Все ключи работают');
        } catch (e) {
          toast(e?.message || String(e));
        } finally {
          checking = false;
          draw();
        }
      };
    }
    if ($('f-sb-purge')) $('f-sb-purge').onclick = async () => {
      const btn = $('f-sb-purge');
      btn.disabled = true;
      try {
        const n = (await callSaasGateway('supportBotPurgeForeign', { dryRun: true })).data;
        if (!n.telegramTickets && !n.cabinetTickets && !n.topics) { toast('Удалять нечего — старых данных нет'); return; }
        if (!confirm(`Удалить обращений из Telegram: ${n.telegramTickets}, обезличить обращений из кабинета: ${n.cabinetTickets}, удалить тем в группе сотрудников: ${n.topics}?\n\nОтменить это нельзя.`)) return;
        const r = (await callSaasGateway('supportBotPurgeForeign', {})).data;
        toast(`Готово: удалено ${r.telegramTickets}, обезличено ${r.cabinetTickets}, тем удалено ${r.removedTopics}`);
      } catch (e) {
        toast(`Не удалось: ${e?.message || e}`);
      } finally {
        btn.disabled = false;
      }
    };
    $('f-sb-save').onclick = async () => {
      const payload = {
        token: $('f-sb-token').value.trim(),
        groupChatId: $('f-sb-group').value.trim(),
        staff: $('f-sb-staff').value,
        admins: $('f-sb-admins').value,
        aiEnabled: $('f-sb-ai-on').checked,
        autoLearn: $('f-sb-autolearn').checked,
        ruOnly: $('f-sb-ru-only').checked,
        aiRu: $('f-sb-ai-ru').checked,
        web: { enabled: $('f-sb-web-on').checked, provider: $('f-sb-web-provider').value, key: $('f-sb-web-key').value.trim() },
        ai: {
          routing: $('f-sb-routing').value,
          providers: provDraft.map((p) => ({
            id: p.id || undefined, vendor: p.vendor, apiKey: (p.apiKey || '').trim(), enabled: p.enabled !== false,
            light: (p.light || '').trim(), heavy: (p.heavy || '').trim(),
            baseUrl: (p.baseUrl || '').trim() || sbVendor(p.vendor).baseUrl,
          })),
        },
        humanPauseHours: Number($('f-sb-pause').value) || 12,
        dailyAiLimit: Number($('f-sb-limit').value) || 300,
        workHours: $('f-sb-hours').value.trim(),
      };
      if (!payload.token && !(st && st.connected)) { toast('Вставьте токен бота из @BotFather'); return; }
      if (String(payload.groupChatId) === String(st?.groupChatId || '')) delete payload.groupChatId;
      saving = true;
      draw();
      try {
        st = (await callSaasGateway('supportBotSetup', payload)).data;
        loadError = '';
        provDraft = draftFrom(st);
        if ($('f-sb-token')) $('f-sb-token').value = '';
        toast(st.connected ? 'Бот поддержки сохранён' : 'Сохранено');
      } catch (e) {
        toast(e?.message || String(e));
      } finally {
        saving = false;
        draw();
      }
    };
    if ($('f-sb-code')) {
      $('f-sb-code').onclick = async () => {
        try {
          groupCode = (await callSaasGateway('supportBotGroupCode', {})).data.command;
          draw();
        } catch (e) {
          toast(e?.message || String(e));
        }
      };
    }
    if ($('f-sb-code-copy')) $('f-sb-code-copy').onclick = () => copyToClipboard(groupCode);
    const kbDetails = $('f-sb-kb-details');
    if (kbDetails) kbDetails.ontoggle = () => { if (kbDetails.open && knowledge === null) loadKnowledge(); };
    document.querySelectorAll('.f-sb-kb-del').forEach((el) => {
      el.onclick = async () => {
        if (!confirm('Удалить запись из базы знаний бота?')) return;
        try {
          await callSaasGateway('supportKnowledge', { deleteId: el.dataset.id });
          knowledge = (knowledge || []).filter((k) => k.id !== el.dataset.id);
          draw();
        } catch (e) {
          toast(`Не удалось удалить: ${e?.message || e}`);
        }
      };
    });
  };

  draw();
  load();
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
  let messagesTimer = null;
  const adminDraftFiles = [];
  // Папки: вопросы клиентов из кабинета, посетителей лендинга и из Telegram.
  const FOLDERS = [
    ['platform', '🏪 Вопросы с платформы'],
    ['site', '🌐 Вопросы с лендинга'],
    ['partner', '🤝 Менеджеры'],
    ['telegram', '✈️ Telegram'],
  ];
  const folderOf = (t) => (t.channel === 'site' ? 'site' : t.channel === 'partner' ? 'partner' : t.tenantId || t.channel !== 'telegram' ? 'platform' : 'telegram');
  let folder = 'platform';
  // «Гость 4821» — постоянный номер браузера посетителя (не имя).
  const ticketWho = (t) => (t.channel === 'partner' ? `Менеджер ${t.partnerTag || ''}`.trim() : t.channel === 'site'
    ? `Сайт · ${t.visitorTag ? `Гость ${t.visitorTag}` : 'посетитель'}${t.siteUid ? ' · вошёл в аккаунт' : ''}`
    : t.tenantId ? (tenantNames.get(t.tenantId) || t.tenantId)
      : t.channel === 'telegram' ? `Telegram${t.tgName ? ` · ${t.tgName}` : ''}` : 'Заведение не указано');

  // Переписка открытого обращения — с сервера поддержки, раз в 10 с.
  const loadMessages = async (id) => {
    try {
      const r = fromWire((await callSaasGateway('supportTicketMessages', { ticketId: id })).data);
      if (expandedId !== id) return;
      const list = r.messages || [];
      if (messages && list.length === messages.length) return;
      messages = list;
    } catch (e) {
      if (expandedId !== id || messages) return;
      messages = [];
      toast(`Не удалось загрузить переписку: ${e?.message || e}`);
    }
    draw();
  };
  const selectTicket = (ticketId) => {
    clearInterval(messagesTimer);
    messagesTimer = null;
    expandedId = expandedId === ticketId ? null : ticketId;
    messages = null;
    adminDraftFiles.splice(0);
    if (expandedId) {
      const id = expandedId;
      loadMessages(id);
      messagesTimer = setInterval(() => { if (document.visibilityState === 'visible') loadMessages(id); }, 10000);
    }
    draw();
  };
  sub(() => clearInterval(messagesTimer));

  const draw = () => {
    // Раздел уже закрыт (перешли на другую вкладку), а данные пришли — не рисуем.
    if (!body || !body.isConnected) return;
    if (!tickets.length) {
      body.innerHTML = '<p class="small muted">Обращений пока не было.</p>';
      return;
    }
    // Открытые наверх, среди них — с приоритетной поддержкой по тарифу;
    // sort стабильный, так что внутри групп остаётся порядок запроса —
    // новые сверху.
    const sorted = tickets.filter((t) => folderOf(t) === folder).sort((a, b) => {
      const rank = (t) => (t.status === 'closed' ? 2 : isPriority(t) ? 0 : 1);
      return rank(a) - rank(b);
    });
    const openIn = (f) => tickets.filter((t) => folderOf(t) === f && t.status !== 'closed').length;
    const folders = FOLDERS.filter(([f]) => f !== 'telegram' || tickets.some((t) => folderOf(t) === f));
    const foldersHtml = `<div class="sec-tabs" role="tablist" style="margin-bottom:10px">${folders.map(([f, label]) => `
      <button type="button" class="sec-tab f-admin-folder${f === folder ? ' active' : ''}" role="tab" aria-selected="${f === folder}" data-folder="${f}">${label}${openIn(f) ? ` <span class="muted">(${openIn(f)})</span>` : ''}</button>`).join('')}</div>`;
    renderKeepingInputs(body, `${foldersHtml}<div class="card">${sorted.length ? '' : '<p class="small muted" style="margin:0">В этой папке обращений нет.</p>'}${sorted.map((t) => `
      <div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div class="row f-admin-ticket-open" data-id="${esc(t.id)}" style="justify-content:space-between;align-items:center;cursor:pointer">
          <div class="small grow" style="min-width:0">
            ${isPriority(t) ? '<span class="cab-plan-badge" style="margin-right:6px">Приоритет</span>' : ''}${t.no ? `<span class="muted">#${esc(String(t.no))}</span> ` : ''}<b>${esc(t.subject || '')}</b> · ${esc(ticketWho(t))}
            <div class="muted">${fmtDateTime(t.updatedAt || t.createdAt)}${t.channel === 'telegram' && t.tenantId ? ' · через Telegram' : t.channel === 'site' && t.tenantId ? ' · с сайта' : ''}</div>
          </div>
          ${t.status === 'closed' ? '<div class="small muted">Решено</div>'
            : t.escalated ? '<div class="small" style="color:var(--danger);font-weight:700;white-space:nowrap">🔴 Нужен человек</div>'
              : t.lastAuthorRole === 'owner' ? '<div class="small" style="color:var(--warning);font-weight:700;white-space:nowrap">Ждёт ответа</div>'
                : `<div class="small muted">${t.lastAuthorRole === 'ai' ? '🤖 Ответил ИИ' : 'Ответили'}</div>`}
        </div>
        ${expandedId === t.id ? `
          <div style="margin-top:10px">
            ${messages === null ? '<div class="spinner"></div>' : (messages.length ? messages.map((m) => `
              <div style="margin:6px 0;padding:8px 10px;border-radius:10px;background:${m.authorRole === 'super_admin' || m.authorRole === 'ai' ? 'var(--surface-2)' : 'transparent'};border:1px solid var(--border)">
                <div class="small muted">${esc(m.authorRole === 'ai' ? '🤖 ИИ-ассистент' : m.authorRole === 'super_admin' ? (m.authorName ? `${m.authorName} · платформа` : 'Платформа') : (m.authorName ? `${m.authorName} · клиент` : t.channel === 'site' ? 'Посетитель сайта' : t.channel === 'partner' ? 'Менеджер' : 'Владелец'))} · ${fmtDateTime(m.createdAt)}</div>
                ${m.text ? `<div class="small rich-text" style="margin-top:2px">${richText(m.text, { bold: m.authorRole !== 'owner' })}</div>` : ''}
                ${attachmentsHtml(t.id, m.attachments)}
              </div>
            `).join('') : '<p class="small muted">Сообщений пока нет.</p>')}
            <textarea class="f-admin-ticket-reply" id="f-admin-reply-${esc(t.id)}" data-id="${esc(t.id)}" rows="2" placeholder="Ответ владельцу… Скриншот — Ctrl+V" style="width:100%;resize:vertical;margin-top:6px"></textarea>
            ${pendingFilesHtml(adminDraftFiles, 'f-admin-rm')}
            <div class="row att-actions">
              <button class="btn btn-primary f-admin-ticket-send" data-id="${esc(t.id)}" style="width:auto">Отправить</button>
              <button type="button" class="btn btn-ghost att-add" id="f-admin-attach" style="width:auto">📎 Прикрепить</button>
              <input type="file" id="f-admin-files" accept="${SUPPORT_ACCEPT}" multiple hidden>
            </div>
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
    document.querySelectorAll('.f-admin-folder').forEach((el) => {
      el.onclick = () => { folder = el.dataset.folder; if (expandedId) selectTicket(expandedId); else draw(); };
    });
    bindAttachments(body);
    bindAttachPicker({ button: $('f-admin-attach'), input: $('f-admin-files'), pasteInto: expandedId ? $(`f-admin-reply-${expandedId}`) : null, list: adminDraftFiles, redraw: draw });
    document.querySelectorAll('.f-admin-rm').forEach((el) => {
      el.onclick = () => {
        const [gone] = adminDraftFiles.splice(Number(el.dataset.i), 1);
        if (gone && gone.preview) URL.revokeObjectURL(gone.preview);
        draw();
      };
    });
    document.querySelectorAll('.f-admin-ticket-send').forEach((el) => {
      el.onclick = async () => {
        const ticketId = el.dataset.id;
        const textEl = document.querySelector(`.f-admin-ticket-reply[data-id="${ticketId}"]`);
        const text = textEl.value.trim();
        if (!text && !adminDraftFiles.length) return;
        el.disabled = true;
        const files = adminDraftFiles.splice(0);
        textEl.value = '';
        try {
          const attachments = files.length ? await uploadSupportFiles(ticketId, files) : [];
          await callSaasGateway('supportAdminSend', { ticketId, text, attachments });
          dropPreviews(files);
          loadMessages(ticketId);
          loadTickets();
        } catch (e) {
          adminDraftFiles.unshift(...files);
          const back = document.getElementById(`f-admin-reply-${ticketId}`);
          if (back && !back.value.trim()) back.value = text;
          toast(`Не удалось отправить: ${e?.message || e}`);
        } finally {
          el.disabled = false;
          draw();
        }
      };
    });
    document.querySelectorAll('.f-admin-ticket-toggle').forEach((el) => {
      el.onclick = async () => {
        try {
          await callSaasGateway('supportTicketStatus', { ticketId: el.dataset.id, status: el.dataset.status === 'closed' ? 'open' : 'closed' });
          loadTickets();
        } catch (e) {
          toast(`Не удалось изменить статус: ${e?.message || e}`);
        }
      };
    });
  };

  // Обращения — с сервера поддержки (не из Firestore), раз в 20 с.
  let plansLoaded = false;
  let ticketsShown = false;
  let ticketsAlive = true;
  const loadTickets = async () => {
    let list;
    try {
      list = fromWire((await callSaasGateway('supportAdminTickets', {})).data.tickets || []);
    } catch (_) {
      if (!ticketsShown) body.innerHTML = '<p class="small muted">Обращения недоступны.</p>';
      return;
    }
    if (!ticketsAlive) return;
    ticketsShown = true;
    tickets = list;
    await Promise.all([...new Set(tickets.map((t) => t.tenantId))].filter((id) => id && !tenantNames.has(id)).map(async (id) => {
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
    if (!plansLoaded) {
      try {
        const plansSnap = await getDocs(collection(state.db, 'plans'));
        planPriority = new Map(plansSnap.docs.map((d) => [d.id, d.data().prioritySupport === true]));
        plansLoaded = true;
      } catch (_) {}
    }
    // Поле ответа набирают — не перерисовываем под рукой.
    const typing = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('f-admin-ticket-reply');
    if (!typing) draw();
  };
  loadTickets();
  const ticketsTimer = setInterval(() => { if (document.visibilityState === 'visible') loadTickets(); }, 20000);
  sub(() => { ticketsAlive = false; clearInterval(ticketsTimer); });
}

// Объявления пишутся прямо в Firestore: проверять сверх правил
// (isSuperAdmin) нечего.
function watchAdminBroadcasts() {
  const body = $('admin-broadcasts');
  let items = [];
  let editingId = null; // объявление, которое сейчас правят на месте

  const draw = () => {
    // Раздел уже закрыт (перешли на другую вкладку), а данные пришли — не рисуем.
    if (!body || !body.isConnected) return;
    body.innerHTML = items.length ? `<div class="card">${items.map((b) => editingId === b.id ? `
      <div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <label class="field"><span>Заголовок</span>
          <input id="f-bc-edit-title" value="${esc(b.title || '')}">
        </label>
        <label class="field"><span>Текст</span>
          <textarea id="f-bc-edit-body" rows="6">${esc(b.body || '')}</textarea>
        </label>
        <div class="row" style="gap:10px;flex-wrap:wrap">
          <button class="btn btn-primary f-bc-save" data-id="${esc(b.id)}" style="width:auto">Сохранить</button>
          <button class="btn f-bc-cancel" style="width:auto">Отмена</button>
        </div>
      </div>` : `
      <div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <div class="small" style="min-width:0">
          <b>${esc(b.title || '')}</b>${b.active ? '' : ' <span class="muted">(снято)</span>'}
          <div class="muted rich-text">${richText(b.body || '')}</div>
          <div class="muted">${fmtDateTime(b.createdAt)}${b.editedAt ? ` · изменено ${fmtDateTime(b.editedAt)}` : ''}</div>
        </div>
        <div class="row" style="gap:16px;flex-wrap:wrap;margin-top:6px">
          <button class="btn-link f-bc-edit" data-id="${esc(b.id)}" style="width:auto">Изменить</button>
          <button class="btn-link f-broadcast-toggle" data-id="${esc(b.id)}" data-active="${b.active ? '1' : '0'}" style="width:auto">${b.active ? 'Снять' : 'Вернуть'}</button>
          <button class="btn-link f-bc-delete" data-id="${esc(b.id)}" style="width:auto;color:var(--danger)">Удалить</button>
        </div>
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
    document.querySelectorAll('.f-bc-edit').forEach((el) => {
      el.onclick = () => { editingId = el.dataset.id; draw(); };
    });
    document.querySelectorAll('.f-bc-cancel').forEach((el) => {
      el.onclick = () => { editingId = null; draw(); };
    });
    document.querySelectorAll('.f-bc-save').forEach((el) => {
      el.onclick = async () => {
        const title = $('f-bc-edit-title').value.trim();
        const text = $('f-bc-edit-body').value.trim();
        if (!title || !text) {
          toast('Заполните заголовок и текст');
          return;
        }
        el.disabled = true;
        try {
          await setDoc(doc(state.db, 'broadcasts', el.dataset.id), { title, body: text, editedAt: Timestamp.fromDate(new Date()) }, { merge: true });
          editingId = null;
          draw();
          toast('Объявление сохранено');
        } catch (e) {
          toast(`Не удалось сохранить: ${e?.message || e}`);
          el.disabled = false;
        }
      };
    });
    document.querySelectorAll('.f-bc-delete').forEach((el) => {
      el.onclick = async () => {
        if (!confirm('Удалить объявление совсем? Владельцы перестанут его видеть, вернуть нельзя.')) return;
        el.disabled = true;
        try {
          await deleteDoc(doc(state.db, 'broadcasts', el.dataset.id));
          toast('Объявление удалено');
        } catch (e) {
          toast(`Не удалось удалить: ${e?.message || e}`);
          el.disabled = false;
        }
      };
    });
  };

  sub(onSnapshot(query(collection(state.db, 'broadcasts'), orderBy('createdAt', 'desc'), limit(30)), (snap) => {
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Пока правят — не перерисовываем поверх ввода (кроме удаления правимого).
    if (editingId && items.some((b) => b.id === editingId) && document.getElementById('f-bc-edit-title')) return;
    draw();
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

  // Хранение персональных данных (saas-gateway, pii-migrate.js): состояние
  // грузим вместе с деталями, а пока идёт перенос или очистка — опрашиваем.
  const piiState = new Map(); // tenantId → ответ status | { error }
  const piiPolls = new Set();
  const loadPiiState = async (tenantId) => {
    try {
      piiState.set(tenantId, (await callSaasGateway('piiMigration', { tenantId, action: 'status' })).data);
    } catch (e) {
      piiState.set(tenantId, { error: e?.message || String(e) });
    }
    draw();
    const st = piiState.get(tenantId);
    if (st && st.running && expandedIds.has(tenantId) && !piiPolls.has(tenantId)) {
      piiPolls.add(tenantId);
      setTimeout(() => { piiPolls.delete(tenantId); if (expandedIds.has(tenantId)) loadPiiState(tenantId); }, 4000);
    }
  };

  const piiStep = async (tenantId, step) => {
    const st = piiState.get(tenantId) || {};
    const opts = { tenantId, action: step === 'scrubCheck' ? 'scrub' : step, dryRun: step === 'scrubCheck' };
    let fresh = false;
    if (step === 'switch') {
      const notReady = (st.devices || []).filter((d) => !d.ready);
      const text = 'Перевести заведение на хранение данных только в РФ? Кассы, приложение и сервер перестанут '
        + 'писать имена и телефоны в Firestore.';
      if (notReady.length) {
        if (!confirm(`${text}\n\nНе обновлены: ${notReady.map((d) => d.name).join(', ')}. Если эти устройства `
          + 'больше не используются — продолжить. Если используются — сначала обновите их, иначе на них пропадут имена.')) return;
        if (!(await reauthenticate('переключить заведение с необновлёнными кассами'))) return;
        opts.force = true;
        fresh = true;
      } else if (!confirm(text)) {
        return;
      }
    } else if (step === 'scrub') {
      if (!confirm('Очистить Firestore? Имена и телефоны, которые уже есть в справочнике в РФ, будут удалены '
        + 'из базы за рубежом. Сначала сделайте пробный проход. Отменить нельзя (копия остаётся в РФ).')) return;
      if (!(await reauthenticate('очистить персональные данные в Firestore'))) return;
      fresh = true;
    }
    try {
      await callSaasGateway('piiMigration', opts, { forceRefresh: fresh });
      toast(step === 'switch' ? 'Старые записи перенесены — отметка поставлена' : 'Запущено — ход виден в карточке');
    } catch (e) {
      toast(`Не удалось: ${e?.message || e}`);
    }
    loadPiiState(tenantId);
  };

  const piiJobLine = (label, job) => {
    if (!job) return '';
    if (job.state === 'running') return `<div class="small">${label}: идёт…</div>`;
    if (job.state === 'failed') return `<div class="small" style="color:var(--danger)">${label}: ошибка — ${esc(job.error || '')}</div>`;
    const sum = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    const extra = job.removed !== undefined
      ? ` · убрано из записей: ${sum(job.removed)}, не сверено: ${sum(job.unverified)}${job.guests === 'skipped' ? ' · общие профили сети — после перевода всех точек' : ''}`
      : job.filled !== undefined ? ` · дописано в РФ: ${job.filled}` : '';
    return `<div class="small">${label}: ${job.finishedAt ? fmtDateTime(Timestamp.fromMillis(job.finishedAt)) : 'готово'}${extra}</div>`;
  };

  const renderPiiBlock = (t) => {
    const st = piiState.get(t.id);
    if (!st) return '<div class="small muted">Загрузка…</div>';
    if (st.error) return `<div class="small" style="color:var(--danger)">${esc(st.error)}</div>`;
    const rf = st.mode === 'rf';
    const ready = (st.devices || []).filter((d) => d.ready).length;
    const total = (st.devices || []).length;
    const notReady = (st.devices || []).filter((d) => !d.ready);
    const scrubOpen = rf && st.scrubAfter && Date.now() >= st.scrubAfter;
    const btn = (step, label) => `<button class="btn-link f-pii-step" data-id="${esc(t.id)}" data-step="${step}" style="width:auto"${st.running ? ' disabled' : ''}>${label}</button>`;
    return `
      <div class="small" style="font-weight:600">${rf ? '✓ Старые записи перенесены в РФ' : 'Старые записи ещё не перенесены в РФ — перенос идёт сам, по заведению в час'}</div>
      <div class="small muted">Новые имена и телефоны у всех заведений пишутся только в РФ. Очистка Firestore — сама, ночью, через сутки после переноса, когда кассы обновлены (но не позже чем через неделю).</div>
      <div class="small muted">Кассы на новой сборке: ${ready} из ${total}${notReady.length ? ` · не обновлены: ${esc(notReady.map((d) => d.name).join(', '))}` : ''}</div>
      ${piiJobLine('Перенос в РФ', st.copy)}
      ${piiJobLine('Пробная очистка', st.scrubCheck)}
      ${piiJobLine('Очистка Firestore', st.scrub)}
      ${rf && !scrubOpen && st.scrubAfter ? `<div class="small muted">Очистка доступна с ${fmtDateTime(Timestamp.fromMillis(st.scrubAfter))}</div>` : ''}
      <div class="row" style="gap:12px;flex-wrap:wrap;margin-top:6px">
        ${btn('copy', rf ? 'Дописать в РФ ещё раз' : '1. Перенести в РФ')}
        ${rf ? '' : btn('switch', '2. Переключить')}
        ${rf ? btn('scrubCheck', 'Пробная очистка') : ''}
        ${scrubOpen ? btn('scrub', '3. Очистить Firestore') : ''}
        ${btn('refresh', 'Обновить')}
      </div>`;
  };

  const toggleTenantDetail = (tenantId) => {
    if (expandedIds.has(tenantId)) {
      expandedIds.delete(tenantId);
      draw();
    } else {
      expandedIds.add(tenantId);
      draw();
      if (!detailsCache.has(tenantId)) ensureDetailsLoaded(tenantId);
      loadPiiState(tenantId);
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
          <textarea class="f-tenant-notes" id="f-tenant-notes-${esc(t.id)}" data-id="${esc(t.id)}" rows="3" placeholder="Например: платит переводом, звонил по поводу…" style="width:100%;resize:vertical">${esc(d.notes || '')}</textarea>
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
          <div class="small muted" style="margin-bottom:6px">Персональные данные: где хранятся. Порядок: перенести в РФ →
          переключить (когда все кассы обновлены) → через сутки пробная очистка и очистка Firestore. Каждый шаг читает
          все записи заведения, как бэкап, — крупные заведения переводите по одному в день.</div>
          ${renderPiiBlock(t)}
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
    // Раздел уже закрыт (перешли на другую вкладку), а данные пришли — не рисуем.
    if (!body || !body.isConnected) return;
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
    document.querySelectorAll('.f-pii-step').forEach((el) => {
      el.onclick = () => (el.dataset.step === 'refresh' ? loadPiiState(el.dataset.id) : piiStep(el.dataset.id, el.dataset.step));
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

  // oninput, а не addEventListener: при повторной подписке панели старый
  // обработчик заменяется, а не копится.
  $('f-tenant-search').oninput = draw;
  $('f-tenant-status-filter').onchange = draw;

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
          <label class="field grow"><span>Устройств с кассой${p.isChainPlan ? ' на точке' : ''} (0 = без лимита)</span>
            <input type="number" min="0" class="f-plan-field" data-plan="${esc(p.id)}" data-field="maxDevices" value="${Number(p.maxDevices) || 0}">
          </label>
        </div>
        <p class="small muted" style="margin:-4px 0 10px">Касса сверх лимита не откроется, пока владелец не отключит лишнее
        устройство в кабинете («Устройства») или не сменит тариф. Сотрудников тариф не ограничивает.</p>
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
        r.after.maxDevices ? `до ${r.after.maxDevices} устр.` : 'без лимита устройств',
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
  sub(onSnapshot(query(collection(state.db, 'bankInvoices'), orderBy('createdAt', 'desc'), limit(100)), async (snap) => {
    await loadPlatformLegal().catch(() => null);
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!list.length) {
      body.innerHTML = '<p class="small muted">Счетов пока не было.</p>';
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    // Чек с ИНН покупателя нужен самозанятому; на УСН/ОСН безнал от ИП и
    // организаций идёт без кассового чека — документ для них акт.
    const npd = legalCache?.taxRegime === 'npd';
    body.innerHTML = `<div class="card">${list.map((b) => {
      const p = b.payer || {};
      const late = b.status === 'paid' && !b.receiptIssuedAt && b.receiptDueDate && b.receiptDueDate < today;
      return `
        <div class="row" style="justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--border);flex-wrap:wrap">
          <div class="grow small">
            <b>№ ${esc(String(b.number))}</b> от ${fmtDate(b.createdAt)} · ${Number(b.amount || 0).toLocaleString('ru-RU')} ₽ · ${esc(BANK_INVOICE_STATUS_LABELS[b.status] || b.status)}
            <div class="muted">${p.type === 'org' ? 'Организация' : 'ИП'} ${esc(p.name || '')} · ИНН ${esc(p.inn || '—')}${p.kpp ? `, КПП ${esc(p.kpp)}` : ''} · ${esc(b.title || '')}${b.email ? ` · ${esc(b.email)}` : ''}</div>
            ${b.status === 'paid' ? `<div class="muted"><a href="#/act/${esc(b.id)}">Акт № ${esc(String(b.number))}</a></div>` : ''}
            ${b.status === 'paid' && npd ? (b.receiptIssuedAt
              ? `<div class="muted">Чек выдан ${fmtDate(b.receiptIssuedAt)}${b.receiptUrl ? ` · <a href="${esc(b.receiptUrl)}" target="_blank" rel="noopener">открыть чек</a>` : ''}</div>`
              : `<div style="color:${late ? 'var(--danger)' : 'var(--warning)'}">Нужен чек в «Мой налог» на ${p.type === 'org' ? 'организацию' : 'ИП'} с ИНН ${esc(p.inn || '')} — до ${isoToRu(b.receiptDueDate)}${late ? ' (срок прошёл)' : ''}</div>`) : ''}
          </div>
          ${b.status === 'pending' ? `
            <button class="btn btn-ghost f-bank-paid" data-id="${esc(b.id)}" data-label="№ ${esc(String(b.number))} на ${Number(b.amount || 0).toLocaleString('ru-RU')} ₽" style="width:auto">Оплата получена</button>
            <button class="btn-link f-bank-cancel-admin" data-id="${esc(b.id)}" style="width:auto">Отменить</button>
          ` : ''}
          ${b.status === 'paid' && npd && !b.receiptIssuedAt ? `<button class="btn btn-ghost f-bank-receipt" data-id="${esc(b.id)}" style="width:auto">Чек выдан</button>` : ''}
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

  // Платёжный сервис подписок — Робокасса (Result URL).
  const wh = st.billingWebhook || {};
  const whAge = wh.lastReceivedAt ? Date.now() - wh.lastReceivedAt : null;
  const rk = true;
  const payName = 'Робокассы';
  const payHint = 'Если оплаты есть, а уведомлений нет — проверьте в «Технических настройках» Робокассы Result URL: '
    + '<code>https://pii.zalpos.ru/saas/robokassaResult</code> (GET или POST; адрес <code>…/guestPayRobokassa</code> тоже подходит) '
    + 'и алгоритм подписи (ROBOKASSA_HASH на сервере).';
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

  // Где хранятся данные: Firestore или собственный сервер (заполняется ниже).
  rows.push('<div id="sec-data-backend"></div>');

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
  loadDataBackend();
}

/** Хранилище данных: перенос из Firestore на свой сервер и возврат. */
async function loadDataBackend() {
  const box = $('sec-data-backend');
  if (!box) return;
  let st;
  try {
    st = (await callSaasGateway('dataMigrateStatus', {})).data;
  } catch (e) {
    box.innerHTML = checkRowHtml('unknown', 'Хранилище данных: нет ответа сервера', esc(e?.message || String(e)));
    return;
  }
  const m = st.migration;
  const running = m && m.state === 'running';
  if (st.backend === 'local') {
    box.innerHTML = checkRowHtml('ok', 'Данные на собственном сервере',
      `Документов: ${st.docs ?? '—'} · подключено устройств и страниц: ${st.sessions || 0}. Лимиты Firebase на данные больше не тратятся; вход — по-прежнему через Firebase Auth.`
        + '<br>Вернуть данные в Firestore можно кнопкой справа: сервер перезапустится и снова будет работать с Firestore (изменения, сделанные после переноса, в Firestore не попадут).',
      '<button type="button" class="btn btn-ghost" id="f-data-rollback" style="width:auto">Вернуть в Firestore</button>');
  } else {
    const last = st.lastBackup;
    box.innerHTML = checkRowHtml(m && m.state === 'error' ? 'bad' : 'warn',
      running ? `Перенос данных идёт… ${m.docs || ''}` : m && m.state === 'error' ? 'Перенос данных не удался' : 'Данные в Cloud Firestore',
      (m && m.state === 'error' ? `${esc(m.error || '')}<br>` : '')
        + 'Перенос на собственный сервер: все документы копируются в базу на этом сервере, сервер перезапускается (около минуты), кассы, кабинет и приложение гостя переходят на него сами — перезапустите кассы, чтобы они подхватили его сразу.'
        + `<br>Источник: Firestore (читает всю базу один раз) или последняя резервная копия${last ? ` (${esc(last.name)})` : ' (копий пока нет)'} — если лимит чтений Firebase на сегодня исчерпан.`,
      running ? '' : `<button type="button" class="btn btn-primary" id="f-data-migrate" style="width:auto">Перенести из Firestore</button>`
        + (last ? ' <button type="button" class="btn btn-ghost" id="f-data-migrate-backup" style="width:auto">Из резервной копии</button>' : ''));
  }
  const start = async (source) => {
    if (!confirm(source === 'backup'
      ? 'Перенести данные из последней резервной копии на собственный сервер? Изменения после этой копии не перенесутся.'
      : 'Перенести все данные из Firestore на собственный сервер?')) return;
    if (!(await reauthenticate('Перенос данных'))) return;
    try {
      await callSaasGateway('dataMigrate', { source }, { forceRefresh: true });
      toast('Перенос начался — сервер перезапустится сам');
    } catch (e) { toast(`Не удалось: ${e?.message || e}`); }
    pollDataBackend();
  };
  if ($('f-data-migrate')) $('f-data-migrate').onclick = () => start('firestore');
  if ($('f-data-migrate-backup')) $('f-data-migrate-backup').onclick = () => start('backup');
  if ($('f-data-rollback')) $('f-data-rollback').onclick = async () => {
    if (!confirm('Вернуть данные в Firestore? Изменения, сделанные на своём сервере, в Firestore не попадут.')) return;
    if (!(await reauthenticate('Возврат данных в Firestore'))) return;
    try {
      await callSaasGateway('dataMigrate', { action: 'rollback' }, { forceRefresh: true });
      toast('Сервер перезапускается с Firestore');
    } catch (e) { toast(`Не удалось: ${e?.message || e}`); }
    pollDataBackend();
  };
  if (running) setTimeout(loadDataBackend, 3000);
}

/** После переноса сервер перезапускается — ждём его и перезагружаем панель. */
function pollDataBackend() {
  let tries = 0;
  const tick = async () => {
    tries++;
    try {
      const st = (await callSaasGateway('dataMigrateStatus', {})).data;
      if (st.migration && st.migration.state === 'running') { loadDataBackend(); setTimeout(tick, 3000); return; }
      if (st.migration && st.migration.state === 'error') { loadDataBackend(); return; }
      if (tries > 2) { location.reload(); return; }
    } catch (_) { /* сервер перезапускается */ }
    if (tries < 60) setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
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
  piiMigration: 'Хранение персональных данных в РФ',
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
    case 'piiMigration':
      return [tenant || e.tenantId || '',
        ({ copy: 'перенос в РФ', switch: 'переключение', scrub: m.dryRun ? 'пробная очистка' : 'очистка Firestore', rollback: 'откат' })[m.step] || m.step || '',
        m.force ? 'принудительно' : ''].filter(Boolean).join(' · ');
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
    ${inv.status === 'paid' ? `<p class="small no-print" style="color:var(--success)">Счёт оплачен, подписка продлена. <a href="#/act/${esc(id)}">Акт для бухгалтерии →</a></p>` : ''}
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
      <p>Основание: публичная оферта — лицензионный договор на предоставление права использования программного комплекса ZalPOS (${esc(LEGAL_EDITION.replace(/^Редакция/, 'редакция'))}), https://zalpos.ru/#/legal/offer. Оплата счёта — акцепт оферты (п. 3 ст. 438 ГК РФ), отдельный договор не требуется.</p>
      <p>Назначение платежа: <b>Оплата по счёту № ${esc(String(inv.number))} от ${esc(created.toLocaleDateString('ru-RU'))} за право использования ZalPOS. Без НДС.</b></p>
      <p class="invoice-note">Оплата по счёту означает согласие с публичной офертой https://zalpos.ru/#/legal/offer.
      Подписка продлевается после поступления денег на расчётный счёт получателя.
      ${npd ? `Чек с ИНН плательщика формируется в приложении «Мой налог» и направляется на email ${esc(inv.email || 'владельца кабинета')}; он же доступен в личном кабинете.` : 'После поступления оплаты в личном кабинете формируется акт о предоставлении права использования.'}
      Счёт действителен 10 банковских дней.</p>
    </div>
  `;
  $('f-invoice-print').onclick = () => window.print();
}

/** Акт о предоставлении права использования — по оплаченному счёту.
 *  Безнал между ИП и организациями идёт без кассового чека (п. 9 ст. 2
 *  54-ФЗ), и бухгалтерии заказчика нужен первичный документ (ст. 9 402-ФЗ). */
async function screenBankAct(id) {
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
    el.innerHTML = `<p class="small" style="color:var(--danger)">Не удалось открыть акт: ${esc(e?.message || e)}</p><p class="small"><a href="#/">← В личный кабинет</a></p>`;
    return;
  }
  if (inv.status !== 'paid') {
    el.innerHTML = '<p class="small">Акт появится, когда оплата по счёту поступит на расчётный счёт.</p><p class="small"><a href="#/">← В личный кабинет</a></p>';
    return;
  }
  const party = legalParty(l);
  const toDate = (x) => (x?.toDate ? x.toDate() : null);
  const actDate = toDate(inv.paidAt) || new Date();
  const invDate = toDate(inv.createdAt) || actDate;
  const sum = Number(inv.amount || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const payer = inv.payer || {};
  const v = (x) => esc(x || '—');
  const npd = l.taxRegime === 'npd';
  const signer = party.isOrg ? '' : party.short;
  el.innerHTML = `
    <div class="no-print row" style="gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <a class="btn btn-ghost" href="#/" style="width:auto">← В личный кабинет</a>
      <button class="btn btn-primary" id="f-act-print" style="width:auto">Печать / сохранить в PDF</button>
    </div>
    <div class="invoice-doc">
      <h1>Акт № ${esc(String(inv.number))} от ${esc(actDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }))}</h1>
      <p style="margin-top:-6px">о предоставлении права использования программного комплекса ZalPOS</p>
      <table>
        <tr><td>Исполнитель (лицензиар)</td><td>${esc(party.full || '—')}${npd ? ', плательщик налога на профессиональный доход' : ''}<br>ИНН ${v(l.inn)}, ${party.isOrg ? 'ОГРН' : 'ОГРНИП'} ${v(l.ogrnip)}<br>${v(l.address)}</td></tr>
        <tr><td>Заказчик (лицензиат)</td><td>${v(payer.name)}<br>ИНН ${v(payer.inn)}${payer.kpp ? `, КПП ${esc(payer.kpp)}` : ''}</td></tr>
        <tr><td>Основание</td><td>Публичная оферта — лицензионный договор, https://zalpos.ru/#/legal/offer; счёт № ${esc(String(inv.number))} от ${esc(invDate.toLocaleDateString('ru-RU'))}</td></tr>
      </table>
      <table>
        <thead><tr><th>№</th><th>Наименование</th><th>Кол-во</th><th>Цена, ₽</th><th>Сумма, ₽</th></tr></thead>
        <tbody><tr><td>1</td><td>${esc(inv.title || '')}. Простая (неисключительная) лицензия, удалённый доступ через интернет, на срок оплаченного периода с ${esc(actDate.toLocaleDateString('ru-RU'))}</td><td>1</td><td>${sum}</td><td>${sum}</td></tr></tbody>
      </table>
      <p class="invoice-total">Итого: ${sum} ₽. Без НДС${npd ? ' — исполнитель применяет налог на профессиональный доход (ч. 8 ст. 2 Федерального закона № 422-ФЗ)' : ''}.</p>
      <p>Право использования предоставлено в полном объёме: доступ к программному комплексу открыт в личном кабинете ${esc(actDate.toLocaleDateString('ru-RU'))}. Заказчик претензий по объёму и срокам не имеет.</p>
      <table class="act-sign">
        <tr><td>Исполнитель<br><br>_____________________ ${esc(signer)}</td><td>Заказчик<br><br>_____________________ ${v(payer.name)}</td></tr>
      </table>
      <p class="invoice-note">Акт сформирован в личном кабинете ZalPOS. По оферте он считается принятым, если в течение 5 рабочих дней не поступили мотивированные возражения.${npd ? ' Документ об оплате — чек из «Мой налог» с ИНН заказчика (он в личном кабинете у счёта).' : ''}</p>
    </div>
  `;
  $('f-act-print').onclick = () => window.print();
}

// Работающее заведение становится первой точкой новой сети вместе с гостями
// и бонусами. Обратно не разделить — об этом прямо спрашиваем.
async function convertTenantToChain(tenantId, tenant, planId) {
  const name = prompt('Название сети:', tenant?.name || '');
  if (!name || !name.trim()) return;
  const trimmedName = name.trim();
  let slug = prompt('Код сети (латиница, цифры, дефис):', slugify(trimmedName));
  if (slug === null) return;
  slug = slugify(slug);
  if (slug.length < 3) { toast('Код сети — от 3 символов латиницей или цифрами, например «leto»'); return; }
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
  let slug = prompt('Код точки (латиница, цифры, дефис) — используется в ссылках и как основа имени Android-приложения. Можно по-русски — переведу в латиницу:', slugify(trimmedName));
  if (slug === null) return;
  slug = slugify(slug);
  if (slug.length < 3) { toast('Код точки — от 3 символов латиницей или цифрами, например «leto-centr»'); return; }
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
