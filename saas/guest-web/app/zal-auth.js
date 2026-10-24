// Вход кабинета и веб-приложения гостя: Firebase Authentication или свой
// вход платформы (saas-gateway, /auth/*, сервер в РФ). Какой сейчас, говорит
// сервер (GET /db/status → auth). Функции — те же, что у firebase/auth
// (onAuthStateChanged, signInWithEmailAndPassword…), поэтому код страниц не
// меняется: он импортирует их отсюда, а не с CDN Firebase.
//
// Со своим входом библиотека Firebase не загружается. Исключение — один раз
// на браузер, если в нём остался прежний вход Firebase: его меняем на свой
// с тем же uid (данные пользователя те же), и больше к Google не обращаемся.
//
// Файл одинаковый в saas/console/ и saas/guest-web/app/ (тест следит).

const FB_AUTH_URL = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
let FA = null;

const OWN = Symbol('zalOwnAuth');
const STORE_KEY = 'zalAuth:v1';
const EXCHANGED_KEY = 'zalAuthExchanged';

const authErr = (code, message) => Object.assign(new Error(message || code), { code, name: 'FirebaseError' });
const isOwn = (x) => !!(x && x[OWN]);
const store = {
  get() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) { return null; } },
  set(v) { try { if (v) localStorage.setItem(STORE_KEY, JSON.stringify(v)); else localStorage.removeItem(STORE_KEY); } catch (_) {} },
};
const flag = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};

function jwtPayload(token) {
  try {
    const s = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(s + '==='.slice((s.length + 3) % 4)))));
  } catch (_) {
    return {};
  }
}

// ------------------------------------------------------------ свой вход

class OwnUser {
  constructor(auth, s) {
    this._auth = auth;
    this._s = s;
  }
  get uid() { return this._s.uid; }
  get email() { return this._s.email || null; }
  get emailVerified() { return !!this._s.emailVerified; }
  get isAnonymous() { return !this._s.email && this._s.provider === 'anonymous'; }
  get providerId() { return 'zalpos'; }
  get metadata() {
    return {
      creationTime: this._s.createdAt ? new Date(this._s.createdAt).toUTCString() : undefined,
      lastSignInTime: this._s.signedInAt ? new Date(this._s.signedInAt).toUTCString() : undefined,
    };
  }
  async getIdToken(force = false) { return this._auth._token(force); }
  async getIdTokenResult(force = false) {
    const token = await this.getIdToken(force);
    const p = jwtPayload(token);
    const t = (x) => (x ? new Date(x * 1000).toUTCString() : null);
    return {
      token, claims: p, authTime: t(p.auth_time), issuedAtTime: t(p.iat), expirationTime: t(p.exp),
      signInProvider: (p.firebase && p.firebase.sign_in_provider) || null,
    };
  }
  async reload() {
    const me = await this._auth._post('/auth/me', {}, true);
    const changed = me.emailVerified !== this._s.emailVerified;
    this._auth._save({ ...this._auth._session, email: me.email, emailVerified: me.emailVerified, createdAt: me.createdAt || this._auth._session.createdAt });
    // Токен несёт email_verified — после подтверждения почты берём новый.
    if (changed) await this._auth._token(true);
  }
  toJSON() { return { uid: this.uid, email: this.email, emailVerified: this.emailVerified }; }
}

class OwnAuth {
  constructor(gateway) {
    this[OWN] = true;
    this.gateway = gateway.replace(/\/+$/, '');
    this.name = 'zalpos';
    this._listeners = new Set();
    this._session = store.get();
    this._user = this._session ? new OwnUser(this, this._session) : null;
    this._ready = Promise.resolve();
    if (typeof window !== 'undefined') {
      // Вход и выход в другой вкладке — и здесь.
      window.addEventListener('storage', (e) => {
        if (e.key !== STORE_KEY) return;
        const s = store.get();
        const before = this._session ? this._session.uid : null;
        this._session = s;
        if ((s ? s.uid : null) !== before) {
          this._user = s ? new OwnUser(this, s) : null;
          this._emit();
        } else if (this._user && s) {
          this._user._s = s;
        }
      });
    }
  }

  get currentUser() { return this._user; }

  _emit() {
    for (const cb of [...this._listeners]) {
      try { cb(this._user); } catch (e) { console.error(e); }
    }
  }

  _save(s) {
    this._session = s;
    store.set(s);
    if (this._user && s && this._user.uid === s.uid) this._user._s = s;
  }

  /** Новый вход: токены от сервера → сессия, слушатели узнают. */
  async _signedIn(r, extra = {}) {
    const p = jwtPayload(r.idToken);
    const s = {
      uid: r.uid, idToken: r.idToken, refreshToken: r.refreshToken, exp: (p.exp || 0) * 1000,
      email: p.email || extra.email || null, emailVerified: !!p.email_verified,
      provider: (p.firebase && p.firebase.sign_in_provider) || null, signedInAt: Date.now(),
      createdAt: extra.createdAt || null,
    };
    const prev = this._user ? this._user.uid : null;
    this._save(s);
    this._user = new OwnUser(this, s);
    if (prev !== s.uid || !extra.quiet) this._emit();
    // Дата создания — для экрана «Профиль»; не критично.
    if (!s.createdAt && s.email) this._post('/auth/me', {}, true).then((me) => {
      if (this._session && this._session.uid === s.uid) this._save({ ...this._session, createdAt: me.createdAt || null });
    }).catch(() => {});
    return { user: this._user, providerId: null, operationType: 'signIn' };
  }

  async _post(route, body, withToken = false) {
    const headers = { 'Content-Type': 'application/json' };
    if (withToken) headers.Authorization = `Bearer ${await this._token(false)}`;
    let res;
    try {
      res = await fetch(`${this.gateway}${route}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    } catch (_) {
      throw authErr('auth/network-request-failed', 'Нет связи с сервером — проверьте интернет');
    }
    let j = {};
    try { j = await res.json(); } catch (_) {}
    if (res.ok) return j;
    if (res.status === 429) throw authErr('auth/too-many-requests', j.error || 'Слишком много попыток — подождите несколько минут');
    throw authErr(j.code || (res.status === 401 ? 'auth/user-token-expired' : 'auth/internal-error'), j.error || `Сервер ответил ошибкой ${res.status}`);
  }

  /** Действующий токен; обновление — одно на все вкладки (refresh одноразовый). */
  async _token(force) {
    const s = this._session;
    if (!s) throw authErr('auth/no-current-user', 'Нужен вход');
    if (!force && s.exp - 60000 > Date.now()) return s.idToken;
    const run = async () => {
      // Другая вкладка могла уже обновить — берём её результат.
      const fresh = store.get();
      if (fresh && fresh.uid === s.uid && fresh.refreshToken !== s.refreshToken && fresh.exp - 60000 > Date.now()) {
        this._save(fresh);
        return fresh.idToken;
      }
      const cur = fresh && fresh.uid === s.uid ? fresh : s;
      let r;
      try {
        r = await this._post('/auth/refresh', { refreshToken: cur.refreshToken });
      } catch (e) {
        if (e.code !== 'auth/network-request-failed' && e.code !== 'auth/too-many-requests' && e.code !== 'auth/internal-error') {
          // Вход отозван или устарел — выходим, как Firebase.
          this._save(null);
          this._user = null;
          this._emit();
        }
        throw e;
      }
      const p = jwtPayload(r.idToken);
      this._save({ ...cur, idToken: r.idToken, refreshToken: r.refreshToken, exp: (p.exp || 0) * 1000,
        email: p.email || cur.email, emailVerified: !!p.email_verified });
      return r.idToken;
    };
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return navigator.locks.request('zalAuthRefresh', run);
    }
    if (!this._refreshing) this._refreshing = run().finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  async _signOut() {
    const s = this._session;
    this._save(null);
    this._user = null;
    this._emit();
    if (s && s.refreshToken) this._post('/auth/logout', { refreshToken: s.refreshToken }).catch(() => {});
  }

  async _mail(type, email, continueUrl) {
    await this._post('/sendAuthEmail', { type, email, ...(continueUrl ? { continueUrl } : {}) }, type === 'verifyEmail');
  }
}

/** Был ли в этом браузере вход Firebase (без загрузки самой библиотеки). */
async function hadFirebaseSession() {
  try {
    if (indexedDB.databases) {
      const list = await indexedDB.databases();
      return list.some((d) => d.name === 'firebaseLocalStorageDb');
    }
  } catch (_) {}
  return true; // не узнать — проверим самой библиотекой (один раз)
}

/** Прежний вход Firebase → свой, с тем же uid. Один раз на браузер. */
async function exchangeFirebaseSession(auth, firebaseApp) {
  if (flag.get(EXCHANGED_KEY) || !firebaseApp || !(await hadFirebaseSession())) return;
  try {
    const app = await firebaseApp();
    if (!FA) FA = await import(FB_AUTH_URL);
    const fa = FA.getAuth(app);
    const user = await new Promise((resolve) => {
      const off = FA.onAuthStateChanged(fa, (u) => { off(); resolve(u); });
      setTimeout(() => resolve(null), 8000);
    });
    if (user) {
      const r = await auth._post('/auth/exchange', { idToken: await user.getIdToken() });
      await auth._signedIn(r, { email: user.email, createdAt: user.metadata && user.metadata.creationTime ? Date.parse(user.metadata.creationTime) : null });
      await FA.signOut(fa).catch(() => {});
    }
    flag.set(EXCHANGED_KEY, String(Date.now()));
  } catch (e) {
    // Нет связи — попробуем при следующем открытии; вход Firebase просрочен — забываем.
    if (e && e.code !== 'auth/network-request-failed') flag.set(EXCHANGED_KEY, String(Date.now()));
  }
}

/**
 * Вход страницы. backend — 'own' или 'firebase' (из /db/status),
 * firebaseApp — async () => приложение Firebase (создаётся только при нужде).
 */
export async function initAuth({ gateway, backend, firebaseApp }) {
  if (backend === 'own') {
    const auth = new OwnAuth(gateway);
    if (!auth.currentUser) await exchangeFirebaseSession(auth, firebaseApp);
    return auth;
  }
  if (!FA) FA = await import(FB_AUTH_URL);
  return FA.getAuth(await firebaseApp());
}

export const isOwnAuth = (auth) => isOwn(auth);

// ------------------------------------------------------------ функции как у firebase/auth

export function onAuthStateChanged(auth, next, error) {
  if (!isOwn(auth)) return FA.onAuthStateChanged(auth, next, error);
  const cb = typeof next === 'function' ? next : (next && next.next ? (u) => next.next(u) : () => {});
  auth._listeners.add(cb);
  // Как у Firebase: первый вызов — сразу с текущим состоянием (асинхронно).
  Promise.resolve().then(() => { if (auth._listeners.has(cb)) cb(auth.currentUser); });
  return () => auth._listeners.delete(cb);
}

export function onIdTokenChanged(auth, next, error) {
  if (!isOwn(auth)) return FA.onIdTokenChanged(auth, next, error);
  return onAuthStateChanged(auth, next, error);
}

export async function signOut(auth) {
  if (!isOwn(auth)) return FA.signOut(auth);
  return auth._signOut();
}

export async function signInWithEmailAndPassword(auth, email, password) {
  if (!isOwn(auth)) return FA.signInWithEmailAndPassword(auth, email, password);
  return auth._signedIn(await auth._post('/auth/login', { email, password }), { email });
}

export async function createUserWithEmailAndPassword(auth, email, password) {
  if (!isOwn(auth)) return FA.createUserWithEmailAndPassword(auth, email, password);
  return auth._signedIn(await auth._post('/auth/signup', { email, password }), { email, createdAt: Date.now() });
}

export async function signInAnonymously(auth) {
  if (!isOwn(auth)) return FA.signInAnonymously(auth);
  return auth._signedIn(await auth._post('/auth/anonymous', {}));
}

export async function signInWithCustomToken(auth, token) {
  if (!isOwn(auth)) return FA.signInWithCustomToken(auth, token);
  return auth._signedIn(await auth._post('/auth/custom', { token }));
}

export async function sendSignInLinkToEmail(auth, email, settings) {
  if (!isOwn(auth)) return FA.sendSignInLinkToEmail(auth, email, settings);
  return auth._mail('signIn', email, settings && settings.url);
}

export async function sendPasswordResetEmail(auth, email, settings) {
  if (!isOwn(auth)) return FA.sendPasswordResetEmail(auth, email, settings);
  return auth._mail('passwordReset', email, settings && settings.url);
}

export async function sendEmailVerification(user, settings) {
  if (!user || !isOwn(user._auth)) return FA.sendEmailVerification(user, settings);
  return user._auth._mail('verifyEmail', user.email, settings && settings.url);
}

/** Ссылка из письма своего входа: …#/auth?mode=…&code=… */
export function actionFromUrl(href) {
  const h = String(href || '').split('#')[1] || '';
  if (!h.startsWith('/auth?')) return null;
  const q = new URLSearchParams(h.slice('/auth?'.length));
  const mode = q.get('mode');
  const code = q.get('code');
  if (!mode || !code) return null;
  return { mode, code, continueUrl: q.get('continueUrl') || '' };
}

export function isSignInWithEmailLink(auth, href) {
  if (!isOwn(auth)) return FA.isSignInWithEmailLink(auth, href);
  const a = actionFromUrl(href);
  return !!a && a.mode === 'signIn';
}

export async function signInWithEmailLink(auth, email, href) {
  if (!isOwn(auth)) return FA.signInWithEmailLink(auth, email, href);
  const a = actionFromUrl(href);
  if (!a || a.mode !== 'signIn') throw authErr('auth/invalid-action-code', 'Ссылка недействительна');
  return auth._signedIn(await auth._post('/auth/apply', { mode: 'signIn', code: a.code }), { email });
}

/** Подтверждение почты по коду из ссылки. */
export async function applyActionCode(auth, code) {
  if (!isOwn(auth)) {
    await FA.applyActionCode(auth, code);
    if (auth.currentUser) await auth.currentUser.reload().catch(() => {});
    return;
  }
  await auth._post('/auth/apply', { mode: 'verifyEmail', code });
  if (auth.currentUser) await auth.currentUser.reload().catch(() => {});
}

/** Новый пароль по коду из письма. Возвращает почту аккаунта. */
export async function confirmPasswordReset(auth, code, newPassword) {
  if (!isOwn(auth)) {
    const email = await FA.verifyPasswordResetCode(auth, code).catch(() => null);
    await FA.confirmPasswordReset(auth, code, newPassword);
    return email;
  }
  const r = await auth._post('/auth/apply', { mode: 'resetPassword', code, password: newPassword });
  return r.email || null;
}

export const EmailAuthProvider = {
  PROVIDER_ID: 'password',
  credential: (email, password) => ({ providerId: 'password', email, password }),
};

export async function reauthenticateWithCredential(user, cred) {
  if (!user || !isOwn(user._auth)) return FA.reauthenticateWithCredential(user, FA.EmailAuthProvider.credential(cred.email, cred.password));
  const auth = user._auth;
  const r = await auth._post('/auth/reauth', { password: cred.password }, true);
  return auth._signedIn(r, { email: user.email, createdAt: auth._session && auth._session.createdAt, quiet: true });
}

/** notify: false — без письма «Пароль изменён» (пароль и так уходит письмом). */
export async function updatePassword(user, password, { notify = true } = {}) {
  if (!user || !isOwn(user._auth)) return FA.updatePassword(user, password);
  await user._auth._post('/auth/password', { password, notify }, true);
}
