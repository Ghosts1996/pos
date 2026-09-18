// Консоль владельца заведения — веб-приложение SaaS-платформы Colibri POS.
//
// Отдельный сайт от гостевого public/app: тот открывает гость по ссылке на
// столе, этот — владелец заведения, чтобы завести заведение, посмотреть код
// приглашения устройств и подписку. Тот же стиль (без сборки, ES-модули
// прямо из CDN, конфиг Firebase подтягивается с хостинга), см.
// public/app/app.js — но вход по email/паролю, а не анонимный.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot,
  collection, query, where, orderBy, limit, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getFunctions, httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';

// Тот же регион, что у Cloud Functions платформы (см. saas/functions/index.js).
const FUNCTIONS_REGION = 'europe-west1';

const state = {
  auth: null,
  db: null,
  functions: null,
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

async function copyToClipboard(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано');
  } catch (_) {
    toast('Не удалось скопировать — выделите код вручную');
  }
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
      <div class="brand">Colibri POS</div>
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
  if (!state.uid) return screenAuth();
  if (location.hash === '#/admin') {
    // Панель платформы не зависит от того, есть ли у супер-админа
    // собственное заведение — поэтому проверяется до tenantsLoaded/tenants.
    return state.isSuperAdmin ? screenSuperAdmin() : screenDashboardOrOnboarding();
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

// ---------- ВХОД / РЕГИСТРАЦИЯ ----------

let authMode = 'login'; // 'login' | 'signup' — держим отдельно от state: это выбор экрана, а не данные аккаунта.

function screenAuth() {
  screenEl().innerHTML = `
    <div class="brand">Colibri POS</div>
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
  screenEl().innerHTML = `<div class="brand">Colibri POS</div><div class="spinner"></div>`;
}

// ---------- СОЗДАНИЕ ЗАВЕДЕНИЯ ----------

function screenOnboarding() {
  screenEl().innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:8px">
      <div class="brand">Colibri POS</div>
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

  $('f-submit').onclick = async () => {
    const name = nameEl.value.trim();
    const slug = slugEl.value.trim();
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
      const res = await createTenant({ name, slug });
      state.activeTenantId = res.data.tenantId;
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
      <div class="brand">Colibri POS</div>
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

  const draw = () => {
    // Пока не пришёл хотя бы сам документ заведения — рано рисовать: без
    // него неизвестны ни название, ни роль в подписи блока устройств.
    if (!tenant) return;
    const role = (state.tenants.find((t) => t.id === tenantId) || {}).role || '';
    const canManage = role === 'owner' || role === 'admin';
    const color = branding?.primaryColor || '#12B886';
    const sortedMembers = (members || []).slice().sort((a, b) =>
      (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));

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

      <h2>Фирменный цвет</h2>
      <div class="card">
        <p class="small muted">Основной цвет приложения кассы на устройствах
        этого заведения (кнопки, акценты).</p>
        <div class="row">
          <input type="color" id="f-color" value="${esc(color)}"
            style="width:52px;height:44px;padding:2px;flex:none" ${canManage ? '' : 'disabled'}>
          <div class="grow small muted" id="f-color-hex">${esc(color)}</div>
          ${canManage ? `<button class="btn btn-primary" id="f-save-color" style="width:auto">Сохранить</button>` : ''}
        </div>
      </div>

      <h2>Подписка</h2>
      <div class="card">
        <div class="small muted">Тариф: ${esc(subscription?.planId || '—')}</div>
        <div class="small muted">Статус: ${esc(SUB_STATUS_LABELS[subscription?.status] || subscription?.status || '—')}</div>
        ${subscription?.trialEndsAt ? `<div class="small muted">Пробный период до: ${fmtDate(subscription.trialEndsAt)}</div>` : ''}
      </div>
    `;

    if ($('f-copy-code')) $('f-copy-code').onclick = () => copyToClipboard(invite?.code || '');
    if ($('f-rotate-code')) $('f-rotate-code').onclick = () => rotateInviteCode(tenantId);
    if ($('f-color') && canManage) {
      $('f-color').addEventListener('input', () => {
        $('f-color-hex').textContent = $('f-color').value;
      });
    }
    if ($('f-save-color')) {
      $('f-save-color').onclick = () => saveBrandingColor(tenantId, $('f-color').value);
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
  };

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

async function saveBrandingColor(tenantId, hex) {
  try {
    await setDoc(doc(state.db, 'tenants', tenantId, 'branding', 'config'), {
      primaryColor: hex,
    }, { merge: true });
    toast('Цвет сохранён');
  } catch (e) {
    toast(`Не удалось сохранить: ${e?.message || e}`);
  }
}

// ---------- ПАНЕЛЬ ПЛАТФОРМЫ (СУПЕР-АДМИН) ----------

function screenSuperAdmin() {
  screenEl().innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:8px">
      <div class="brand">Colibri POS · платформа</div>
      <a href="#/" class="btn-link">← В консоль</a>
    </div>
    <h1>Все заведения</h1>
    <div id="admin-body"><div class="spinner"></div></div>
  `;
  watchAllTenants();
}

function watchAllTenants() {
  const body = $('admin-body');
  const q = query(collection(state.db, 'tenants'), orderBy('createdAt', 'desc'), limit(200));
  sub(onSnapshot(q, async (snap) => {
    const tenants = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Usage читаем отдельно от списка заведений — это соседняя коллекция
    // (tenants/{id}/usage/current), не realtime: пересчитывается раз в
    // сутки Cloud Function calculateUsage, обновлять её на каждый снапшот
    // списка заведений незачем.
    await Promise.all(tenants.map(async (t) => {
      try {
        const uSnap = await getDoc(doc(state.db, 'tenants', t.id, 'usage', 'current'));
        t.usage = uSnap.exists() ? uSnap.data() : null;
      } catch (_) {
        t.usage = null;
      }
    }));

    body.innerHTML = tenants.length ? tenants.map((t) => `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div class="grow" style="min-width:0">
            <div style="font-weight:700">${esc(t.name || t.id)}</div>
            <div class="small muted">
              <code>${esc(t.slug || '')}</code> ·
              ${esc(TENANT_STATUS_LABELS[t.status] || t.status || '—')} ·
              тариф ${esc(t.planId || '—')} ·
              создано ${fmtDate(t.createdAt)}
            </div>
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
      </div>
    `).join('') : '<p class="small muted">Заведений пока нет.</p>';

    document.querySelectorAll('.f-tenant-toggle').forEach((el) => {
      el.onclick = () => toggleTenantSuspension(el.dataset.id, el.dataset.suspended === '1');
    });
  }, () => {
    body.innerHTML = '<p class="small" style="color:var(--danger)">Нет доступа к списку заведений.</p>';
  }));
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
