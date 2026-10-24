"use strict";
/**
 * Свой вход ZalPOS на сервере в РФ вместо Firebase Authentication (Google).
 *
 * Зачем: п. 4 ч. 10 ст. 8 Федерального закона № 149-ФЗ — пользователей из
 * России нельзя авторизовать через иностранный сервис; ч. 5 ст. 18 152-ФЗ —
 * почта и пароль при сборе пишутся в базу в РФ. Здесь — учётные записи,
 * хеши паролей (scrypt), токены доступа (подписаны ключом сервера) и
 * одноразовые коды для писем (подтверждение почты, сброс пароля, вход по
 * ссылке, вход по готовому токену — «custom token»).
 *
 * Совместимость: verifyIdToken возвращает то же, что Firebase Admin SDK
 * (uid, email, email_verified, auth_time, firebase.sign_in_provider, свои
 * claims), а фасад adminAuth() повторяет используемые методы Admin Auth —
 * остальной сервер не знает, чей это вход.
 *
 * Переход: пока переключатель выключен, всё как раньше (Firebase). После
 * включения пользователи Firebase переносятся сюда (uid, почта, статус;
 * пароль — при первом входе: проверяем его у Firebase один раз и сохраняем
 * свой хеш), а приложения меняют прежний вход на свой с тем же uid
 * (/auth/exchange) — устройства, гости и владельцы ничего не теряют.
 */
const crypto = require("crypto");

const ACCESS_TTL_S = 60 * 60; // токен доступа — час, как у Firebase
const REFRESH_TTL_MS = 180 * 24 * 3600 * 1000; // вход на устройстве — полгода без входа
const CODE_TTL_MS = { verifyEmail: 3 * 24 * 3600 * 1000, passwordReset: 3600 * 1000, signIn: 3600 * 1000, custom: 5 * 60 * 1000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const KID = "zalpos-1";

const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const normEmail = (e) => String(e || "").trim().toLowerCase();

function authError(code, message) {
  const e = new Error(message || code);
  e.code = `auth/${code}`;
  return e;
}

/** scrypt$N$r$p$salt$hash — параметры в строке, чтобы потом можно было усилить. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = crypto.scryptSync(String(password), salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${b64u(salt)}$${b64u(hash)}`;
}
function checkPassword(password, stored) {
  const m = String(stored || "").match(/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/);
  if (!m) return false;
  const want = fromB64u(m[5]);
  const got = crypto.scryptSync(String(password), fromB64u(m[4]), want.length, { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]), maxmem: 64 * 1024 * 1024 });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function passwordProblem(password) {
  const p = String(password || "");
  if (p.length < 8) return "Пароль — не короче 8 символов";
  if (p.length > 128) return "Пароль слишком длинный";
  return "";
}

function createOwnAuth({
  store, // createLocalDb: authUsers, authEmails, authRefresh, authCodes
  secretKey, // () => Buffer — ключ сервера в РФ
  now = () => Date.now(),
  // Перенос из Firebase: Admin Auth (getUser/listUsers/verifyIdToken) и проверка пароля через REST.
  firebaseAuth = () => null,
  firebasePasswordCheck = async () => null, // (email, password) => uid | null
  randomUid = () => b64u(crypto.randomBytes(21)).replace(/[-_]/g, "x").slice(0, 28),
} = {}) {
  const users = () => store.collection("authUsers");
  const emails = () => store.collection("authEmails");
  const refreshCol = () => store.collection("authRefresh");
  const codes = () => store.collection("authCodes");
  const jwtKey = () => crypto.createHmac("sha256", secretKey()).update("zalpos-own-auth-jwt").digest();
  const sec = () => Math.floor(now() / 1000);

  // ------------------------------------------------------------ записи пользователей

  async function userDoc(uid) {
    if (!uid || !/^[\w-]{1,128}$/.test(String(uid))) return null;
    const d = (await users().doc(String(uid)).get()).data();
    return d ? { uid: String(uid), ...d } : null;
  }
  async function uidByEmail(email) {
    const e = normEmail(email);
    if (!e) return null;
    const d = (await emails().doc(sha(e)).get()).data();
    return d ? d.uid : null;
  }

  /** Вид записи, как у Admin SDK (UserRecord) — для остального сервера. */
  function record(u) {
    return {
      uid: u.uid, email: u.email || undefined, emailVerified: !!u.emailVerified, disabled: !!u.disabled,
      displayName: u.displayName || undefined,
      metadata: { creationTime: new Date(u.createdAt || now()).toUTCString(), lastSignInTime: u.lastSignInAt ? new Date(u.lastSignInAt).toUTCString() : null },
      providerData: u.email ? [{ providerId: "password", uid: u.email, email: u.email }] : [],
      tokensValidAfterTime: u.validAfter ? new Date(u.validAfter * 1000).toUTCString() : null,
      customClaims: u.claims || undefined,
    };
  }

  async function putUser(uid, patch) {
    const cur = (await userDoc(uid)) || {};
    const next = { ...cur, ...patch };
    delete next.uid;
    if (patch.email !== undefined && normEmail(patch.email) !== normEmail(cur.email)) {
      const e = normEmail(patch.email);
      if (e) {
        const other = await uidByEmail(e);
        if (other && other !== uid) throw authError("email-already-exists", "Аккаунт с этой почтой уже есть");
        await emails().doc(sha(e)).set({ uid, email: e });
      }
      if (cur.email) await emails().doc(sha(normEmail(cur.email))).delete();
      next.email = e || null;
    }
    await users().doc(uid).set(next);
    return { uid, ...next };
  }

  // ------------------------------------------------------------ токены

  function signJwt(payload) {
    const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT", kid: KID }));
    const body = b64u(JSON.stringify(payload));
    const sig = b64u(crypto.createHmac("sha256", jwtKey()).update(`${head}.${body}`).digest());
    return `${head}.${body}.${sig}`;
  }
  /** Наш ли это токен (а не Firebase) — по заголовку, без проверки подписи. */
  function isOwnToken(token) {
    try {
      const head = JSON.parse(fromB64u(String(token).split(".")[0]).toString());
      return head && head.kid === KID;
    } catch (_) {
      return false;
    }
  }

  async function issue(u, { provider, authTime = sec(), claims = {}, device = "" } = {}) {
    const iat = sec();
    const payload = {
      iss: "zalpos", aud: "zalpos", sub: u.uid, uid: u.uid, iat, exp: iat + ACCESS_TTL_S, auth_time: authTime,
      ...(u.email ? { email: u.email, email_verified: !!u.emailVerified } : {}),
      firebase: { sign_in_provider: provider || u.provider || (u.email ? "password" : "anonymous") },
      ...(u.claims || {}), ...claims,
    };
    const refresh = b64u(crypto.randomBytes(32));
    await refreshCol().doc(sha(refresh)).set({
      uid: u.uid, authTime, provider: payload.firebase.sign_in_provider, claims: { ...(u.claims || {}), ...claims },
      createdAt: now(), expiresAt: now() + REFRESH_TTL_MS, device: String(device || "").slice(0, 120),
    });
    await users().doc(u.uid).set({ lastSignInAt: now() }, { merge: true });
    return { idToken: signJwt(payload), refreshToken: refresh, expiresIn: ACCESS_TTL_S, uid: u.uid };
  }

  async function verifyIdToken(token, { checkRevoked = true } = {}) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) throw authError("argument-error", "неверный токен");
    const want = b64u(crypto.createHmac("sha256", jwtKey()).update(`${parts[0]}.${parts[1]}`).digest());
    const a = Buffer.from(want);
    const b = Buffer.from(parts[2]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw authError("argument-error", "подпись не сошлась");
    let p;
    try { p = JSON.parse(fromB64u(parts[1]).toString()); } catch (_) { throw authError("argument-error", "неверный токен"); }
    if (p.iss !== "zalpos" || p.aud !== "zalpos" || !p.uid) throw authError("argument-error", "чужой токен");
    if (!(p.exp > sec())) throw authError("id-token-expired", "токен истёк");
    if (checkRevoked) {
      const u = await userDoc(p.uid);
      if (!u) throw authError("user-not-found", "пользователя нет");
      if (u.disabled) throw authError("user-disabled", "вход отключён");
      if (u.validAfter && p.auth_time < u.validAfter) throw authError("id-token-revoked", "сеанс завершён");
    }
    return p;
  }

  async function refresh(refreshToken) {
    const ref = refreshCol().doc(sha(refreshToken));
    const r = (await ref.get()).data();
    if (!r || r.expiresAt < now()) throw authError("user-token-expired", "Вход устарел — войдите заново");
    const u = await userDoc(r.uid);
    if (!u) throw authError("user-not-found", "Аккаунт удалён");
    if (u.disabled) throw authError("user-disabled", "Вход отключён");
    if (u.validAfter && r.authTime < u.validAfter) throw authError("user-token-expired", "Сеанс завершён — войдите заново");
    await ref.delete(); // одноразовый: новый выдаётся взамен
    return issue(u, { provider: r.provider, authTime: r.authTime, claims: r.claims || {} });
  }

  async function logout(refreshToken) {
    if (refreshToken) await refreshCol().doc(sha(refreshToken)).delete();
  }

  // ------------------------------------------------------------ вход

  async function signUp(email, password) {
    const e = normEmail(email);
    if (!EMAIL_RE.test(e) || e.length > 254) throw authError("invalid-email", "Проверьте адрес почты");
    const bad = passwordProblem(password);
    if (bad) throw authError("weak-password", bad);
    if (await uidByEmail(e)) throw authError("email-already-in-use", "Аккаунт с этой почтой уже есть — войдите");
    // Почта могла остаться только в Firebase (ещё не перенесена) — тогда это вход, а не регистрация.
    const fb = firebaseAuth();
    let inFirebase = false;
    if (fb) { try { await fb.getUserByEmail(e); inFirebase = true; } catch (_) { inFirebase = false; } }
    if (inFirebase) throw authError("email-already-in-use", "Аккаунт с этой почтой уже есть — войдите");
    const u = await putUser(randomUid(), { email: e, emailVerified: false, pwHash: hashPassword(password), provider: "password", createdAt: now() });
    return issue(u, { provider: "password" });
  }

  async function signIn(email, password) {
    const e = normEmail(email);
    if (!e || !password) throw authError("invalid-credential", "Неверная почта или пароль");
    let uid = await uidByEmail(e);
    let u = uid ? await userDoc(uid) : null;
    if (u && u.pwHash) {
      if (!checkPassword(password, u.pwHash)) throw authError("invalid-credential", "Неверная почта или пароль");
    } else {
      // Пароль ещё у Firebase (аккаунт перенесён без пароля или не перенесён):
      // проверяем один раз и сохраняем свой хеш — дальше Google не нужен.
      const fbUid = await firebasePasswordCheck(e, password).catch(() => null);
      if (!fbUid || (uid && fbUid !== uid)) throw authError("invalid-credential", "Неверная почта или пароль");
      if (!u) u = await importFirebaseUser(fbUid);
      if (!u) throw authError("invalid-credential", "Неверная почта или пароль");
      u = await putUser(u.uid, { pwHash: hashPassword(password), pwMigratedAt: now() });
    }
    if (u.disabled) throw authError("user-disabled", "Вход отключён — напишите в поддержку");
    return issue(u, { provider: "password" });
  }

  async function anonymous({ device = "" } = {}) {
    const u = await putUser(randomUid(), { provider: "anonymous", anonymous: true, createdAt: now() });
    return issue(u, { provider: "anonymous", device });
  }

  /** Перенос записи Firebase (uid, почта, статус) — без пароля. */
  async function importFirebaseUser(uid, fbRecord = null) {
    const have = await userDoc(uid);
    if (have) return have;
    const fb = firebaseAuth();
    let r = fbRecord;
    if (!r && fb) { try { r = await fb.getUser(uid); } catch (_) { r = null; } }
    if (!r) return null;
    const email = r.email ? normEmail(r.email) : "";
    const provider = email ? "password" : (r.providerData && r.providerData.length ? "custom" : "anonymous");
    return putUser(uid, {
      ...(email ? { email } : {}), emailVerified: !!r.emailVerified, disabled: !!r.disabled, provider,
      anonymous: !email, createdAt: Date.parse(r.metadata && r.metadata.creationTime) || now(), importedAt: now(),
      ...(r.customClaims ? { claims: r.customClaims } : {}),
    });
  }

  /** Приложение меняет прежний вход Firebase на свой — с тем же uid. */
  async function exchange(firebaseIdToken, { device = "" } = {}) {
    const fb = firebaseAuth();
    if (!fb) throw authError("operation-not-allowed", "Перенос входа недоступен");
    let d;
    try { d = await fb.verifyIdToken(String(firebaseIdToken || "")); } catch (_) { throw authError("invalid-credential", "Прежний вход недействителен — войдите заново"); }
    const u = (await userDoc(d.uid)) || (await importFirebaseUser(d.uid));
    if (!u) throw authError("user-not-found", "Аккаунт не найден");
    if (u.disabled) throw authError("user-disabled", "Вход отключён");
    const provider = (d.firebase && d.firebase.sign_in_provider) || u.provider;
    // Вход по паролю переносим с прежним временем входа — иначе «свежий вход» для смены пароля.
    return issue(u, { provider, authTime: Number(d.auth_time) || sec(), device });
  }

  // ------------------------------------------------------------ одноразовые коды

  async function makeCode(type, data) {
    const code = b64u(crypto.randomBytes(24));
    await codes().doc(sha(code)).set({ type, ...data, createdAt: now(), expiresAt: now() + CODE_TTL_MS[type] });
    return code;
  }
  async function takeCode(type, code) {
    const ref = codes().doc(sha(code));
    const c = (await ref.get()).data();
    if (!c || c.type !== type) throw authError("invalid-action-code", "Ссылка недействительна — запросите новую");
    if (c.expiresAt < now()) { await ref.delete(); throw authError("expired-action-code", "Ссылка устарела — запросите новую"); }
    await ref.delete();
    return c;
  }

  async function createCustomToken(uid, claims = {}) {
    const u = (await userDoc(uid)) || (await importFirebaseUser(uid)) || (await putUser(String(uid), { provider: "custom", createdAt: now() }));
    return `zct.${await makeCode("custom", { uid: u.uid, claims })}`;
  }
  async function signInWithCustomToken(token) {
    const raw = String(token || "").replace(/^zct\./, "");
    const c = await takeCode("custom", raw);
    const u = await userDoc(c.uid);
    if (!u || u.disabled) throw authError("user-disabled", "Вход отключён");
    return issue(u, { provider: "custom", claims: c.claims || {} });
  }

  async function applyCode(mode, code, { password } = {}) {
    if (mode === "verifyEmail") {
      const c = await takeCode("verifyEmail", code);
      const u = await userDoc(c.uid);
      if (!u || normEmail(u.email) !== normEmail(c.email)) throw authError("invalid-action-code", "Ссылка недействительна");
      await putUser(u.uid, { emailVerified: true });
      return { ok: true, email: u.email };
    }
    if (mode === "resetPassword") {
      const bad = passwordProblem(password);
      if (bad) throw authError("weak-password", bad);
      const c = await takeCode("passwordReset", code);
      const u = await userDoc(c.uid);
      if (!u) throw authError("user-not-found", "Аккаунт не найден");
      // Новый пароль завершает все прежние входы, почта подтверждается (письмо дошло).
      await putUser(u.uid, { pwHash: hashPassword(password), emailVerified: true, validAfter: sec() });
      return { ok: true, email: u.email };
    }
    if (mode === "signIn") {
      const c = await takeCode("signIn", code);
      const e = normEmail(c.email);
      let uid = await uidByEmail(e);
      let u = uid ? await userDoc(uid) : null;
      if (!u) {
        const fb = firebaseAuth();
        let fbr = null;
        if (fb) { try { fbr = await fb.getUserByEmail(e); } catch (_) { fbr = null; } }
        u = fbr ? await importFirebaseUser(fbr.uid, fbr) : await putUser(randomUid(), { email: e, provider: "password", createdAt: now() });
      }
      u = await putUser(u.uid, { emailVerified: true });
      return issue(u, { provider: "emailLink" });
    }
    throw authError("invalid-action-code", "Неизвестная ссылка");
  }

  async function changePassword(uid, password) {
    const bad = passwordProblem(password);
    if (bad) throw authError("weak-password", bad);
    const u = await userDoc(uid);
    if (!u) throw authError("user-not-found", "Аккаунт не найден");
    await putUser(uid, { pwHash: hashPassword(password) });
  }

  async function reauth(uid, password) {
    const u = await userDoc(uid);
    if (!u || !u.pwHash || !checkPassword(password, u.pwHash)) throw authError("invalid-credential", "Неверный пароль");
    return issue(u, { provider: "password" });
  }

  // ------------------------------------------------------------ фасад Admin Auth

  function adminAuth() {
    const need = async (uid) => {
      const u = (await userDoc(uid)) || (await importFirebaseUser(uid));
      if (!u) throw authError("user-not-found", "Пользователь не найден");
      return u;
    };
    return {
      verifyIdToken: (t) => verifyIdToken(t),
      getUser: async (uid) => record(await need(uid)),
      getUserByEmail: async (email) => {
        let uid = await uidByEmail(email);
        if (!uid) {
          const fb = firebaseAuth();
          if (fb) { try { const r = await fb.getUserByEmail(normEmail(email)); uid = (await importFirebaseUser(r.uid, r)).uid; } catch (_) { uid = null; } }
        }
        if (!uid) throw authError("user-not-found", "Пользователь не найден");
        return record(await need(uid));
      },
      getUsers: async (ids) => {
        const out = [];
        const notFound = [];
        for (const id of ids || []) {
          const u = id.uid ? await userDoc(id.uid) : id.email ? await userDoc(await uidByEmail(id.email)) : null;
          if (u) out.push(record(u)); else notFound.push(id);
        }
        return { users: out, notFound };
      },
      createUser: async ({ uid, email, password, displayName, emailVerified = false } = {}) => {
        const e = normEmail(email);
        if (e && (await uidByEmail(e))) throw authError("email-already-exists", "Аккаунт с этой почтой уже есть");
        const id = uid || randomUid();
        const u = await putUser(id, {
          ...(e ? { email: e } : {}), emailVerified: !!emailVerified, provider: e ? "password" : "custom", createdAt: now(),
          ...(displayName ? { displayName: String(displayName).slice(0, 120) } : {}),
          ...(password ? { pwHash: hashPassword(password) } : {}),
        });
        return record(u);
      },
      updateUser: async (uid, patch = {}) => {
        await need(uid);
        const upd = {};
        if (patch.email !== undefined) upd.email = patch.email;
        if (patch.emailVerified !== undefined) upd.emailVerified = !!patch.emailVerified;
        if (patch.disabled !== undefined) upd.disabled = !!patch.disabled;
        if (patch.displayName !== undefined) upd.displayName = patch.displayName || null;
        if (patch.password !== undefined) {
          const bad = passwordProblem(patch.password);
          if (bad) throw authError("invalid-password", bad);
          upd.pwHash = hashPassword(patch.password);
        }
        return record(await putUser(uid, upd));
      },
      deleteUser: async (uid) => {
        const u = await userDoc(uid);
        if (!u) throw authError("user-not-found", "Пользователь не найден");
        if (u.email) await emails().doc(sha(normEmail(u.email))).delete();
        await users().doc(uid).delete();
      },
      revokeRefreshTokens: async (uid) => {
        await need(uid);
        await putUser(uid, { validAfter: sec() });
        for (const d of (await refreshCol().where("uid", "==", uid).get()).docs) await d.ref.delete();
      },
      setCustomUserClaims: async (uid, claims) => { await need(uid); await putUser(uid, { claims: claims || null }); },
      createCustomToken: (uid, claims) => createCustomToken(uid, claims),
      generatePasswordResetLink: async (email, settings) => linkFor("passwordReset", email, settings),
      generateEmailVerificationLink: async (email, settings) => linkFor("verifyEmail", email, settings),
      generateSignInWithEmailLink: async (email, settings) => linkFor("signIn", email, settings),
    };
  }

  /** Ссылка из письма: на сайт (#/auth?mode=…&code=…), код — одноразовый. */
  let siteUrl = "https://zalpos.ru/";
  function setSiteUrl(u) { siteUrl = String(u || siteUrl).replace(/\/?$/, "/"); }
  async function linkFor(type, email, settings = {}) {
    const e = normEmail(email);
    let uid = await uidByEmail(e);
    if (!uid && type !== "signIn") {
      const fb = firebaseAuth();
      if (fb) { try { const r = await fb.getUserByEmail(e); uid = (await importFirebaseUser(r.uid, r)).uid; } catch (_) { uid = null; } }
      if (!uid) throw authError("user-not-found", "Пользователь не найден");
    }
    const code = await makeCode(type, { uid: uid || null, email: e });
    const mode = type === "passwordReset" ? "resetPassword" : type;
    const cont = settings && settings.url ? `&continueUrl=${encodeURIComponent(settings.url)}` : "";
    return `${siteUrl}#/auth?mode=${mode}&code=${encodeURIComponent(code)}${cont}`;
  }

  /** Перенести все записи Firebase (без паролей) — при включении своего входа. */
  async function importAllFromFirebase() {
    const fb = firebaseAuth();
    if (!fb || typeof fb.listUsers !== "function") return { imported: 0, total: 0 };
    let token;
    let imported = 0;
    let total = 0;
    do {
      const page = await fb.listUsers(1000, token);
      for (const r of page.users) {
        total++;
        if (!(await userDoc(r.uid))) { await importFirebaseUser(r.uid, r); imported++; }
      }
      token = page.pageToken;
    } while (token);
    return { imported, total };
  }

  /** Сколько ещё зависит от Firebase: кто не перенёс пароль, не сменил сеанс. */
  async function migrationStats() {
    const all = (await users().get()).docs.map((d) => d.data());
    return {
      users: all.length,
      withPassword: all.filter((u) => u.pwHash).length,
      passwordPending: all.filter((u) => u.email && !u.pwHash).length,
      imported: all.filter((u) => u.importedAt).length,
    };
  }

  /** Удалить из Firebase тех, кто уже полностью здесь (пароль у нас или без почты и сеанс сменён). */
  async function purgeFirebase({ includePending = false } = {}) {
    const fb = firebaseAuth();
    if (!fb) return { deleted: 0 };
    let deleted = 0;
    for (const d of (await users().get()).docs) {
      const u = d.data();
      const ready = u.pwHash || !u.email || includePending;
      if (!ready || u.firebaseDeletedAt) continue;
      try { await fb.deleteUser(d.id); } catch (e) { if (!e || e.code !== "auth/user-not-found") continue; }
      await users().doc(d.id).set({ firebaseDeletedAt: now() }, { merge: true });
      deleted++;
    }
    return { deleted };
  }

  return {
    isOwnToken, verifyIdToken, refresh, logout, signUp, signIn, anonymous, exchange, signInWithCustomToken,
    applyCode, changePassword, reauth, adminAuth, setSiteUrl, importAllFromFirebase, migrationStats, purgeFirebase,
    _hashPassword: hashPassword, _checkPassword: checkPassword, _userDoc: userDoc,
  };
}

module.exports = { createOwnAuth, hashPassword, checkPassword };
