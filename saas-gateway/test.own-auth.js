"use strict";
// Свой вход (own-auth.js): регистрация, пароль, токены, отзыв, коды из писем,
// перенос из Firebase без потери uid и пароля.

const assert = require("assert");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { createLocalDb } = require("./local-db");
const { createOwnAuth, hashPassword, checkPassword } = require("./own-auth");

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function harness({ firebase = null } = {}) {
  const store = createLocalDb({ admin });
  let clock = Date.UTC(2026, 9, 24, 12);
  const key = crypto.randomBytes(32);
  const fbChecks = [];
  const auth = createOwnAuth({
    store, secretKey: () => key, now: () => clock,
    firebaseAuth: () => firebase,
    firebasePasswordCheck: async (email, password) => {
      fbChecks.push(email);
      const u = firebase && firebase._users.find((x) => x.email === email);
      return u && u._password === password ? u.uid : null;
    },
  });
  auth.setSiteUrl("https://zalpos.ru/");
  return { auth, store, tick: (ms) => { clock += ms; }, fbChecks };
}

function fakeFirebase(list) {
  const users = list.map((u) => ({ metadata: { creationTime: new Date(Date.UTC(2026, 0, 1)).toUTCString() }, providerData: u.email ? [{ providerId: "password" }] : [], ...u }));
  const nf = () => Object.assign(new Error("нет"), { code: "auth/user-not-found" });
  return {
    _users: users,
    getUser: async (uid) => { const u = users.find((x) => x.uid === uid); if (!u) throw nf(); return u; },
    getUserByEmail: async (email) => { const u = users.find((x) => x.email === email); if (!u) throw nf(); return u; },
    verifyIdToken: async (t) => { const m = String(t).match(/^fb:(\w+):(\w+)$/); if (!m) throw new Error("bad"); return { uid: m[1], auth_time: 1760000000, firebase: { sign_in_provider: m[2] } }; },
    listUsers: async (n, token) => ({ users: token ? [] : users, pageToken: token ? undefined : undefined }),
    deleteUser: async (uid) => { const i = users.findIndex((x) => x.uid === uid); if (i < 0) throw nf(); users.splice(i, 1); },
  };
}

test("пароль: scrypt, соль своя у каждого, проверка", () => {
  const a = hashPassword("секрет-123");
  const b = hashPassword("секрет-123");
  assert.notStrictEqual(a, b);
  assert.ok(checkPassword("секрет-123", a) && !checkPassword("секрет-124", a));
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
});

test("регистрация и вход: токен как у Firebase, неверный пароль — отказ, повтор почты — отказ", async () => {
  const h = harness();
  const r = await h.auth.signUp("Owner@Cafe.ru", "pass12345");
  const d = await h.auth.verifyIdToken(r.idToken);
  assert.strictEqual(d.uid, r.uid);
  assert.strictEqual(d.email, "owner@cafe.ru");
  assert.strictEqual(d.email_verified, false);
  assert.strictEqual(d.firebase.sign_in_provider, "password");
  assert.ok(h.auth.isOwnToken(r.idToken));
  await assert.rejects(h.auth.signUp("owner@cafe.ru", "pass12345"), /email-already-in-use|уже есть/);
  await assert.rejects(h.auth.signUp("x@y.ru", "short"), /8 символов/);
  await assert.rejects(h.auth.signIn("owner@cafe.ru", "wrong-pass"), (e) => e.code === "auth/invalid-credential");
  const r2 = await h.auth.signIn("OWNER@cafe.ru", "pass12345");
  assert.strictEqual(r2.uid, r.uid);
  // В хранилище нет пароля открытым текстом.
  const dump = JSON.stringify(await Promise.all(["authUsers", "authEmails", "authRefresh"].map(async (c) => (await h.store.collection(c).get()).docs.map((x) => x.data()))));
  assert.ok(dump.includes("scrypt$") && !dump.includes("pass12345"));
});

test("токены: истекают за час, обновляются по refresh (одноразовому), отзыв всех сеансов", async () => {
  const h = harness();
  const r = await h.auth.signUp("a@b.ru", "pass12345");
  h.tick(61 * 60 * 1000);
  await assert.rejects(h.auth.verifyIdToken(r.idToken), (e) => e.code === "auth/id-token-expired");
  const r2 = await h.auth.refresh(r.refreshToken);
  assert.ok((await h.auth.verifyIdToken(r2.idToken)).uid === r.uid);
  await assert.rejects(h.auth.refresh(r.refreshToken), (e) => e.code === "auth/user-token-expired", "старый refresh не работает");
  h.tick(2000);
  await h.auth.adminAuth().revokeRefreshTokens(r.uid);
  await assert.rejects(h.auth.verifyIdToken(r2.idToken), (e) => e.code === "auth/id-token-revoked");
  await assert.rejects(h.auth.refresh(r2.refreshToken));
  // Поддельная подпись.
  const [a, b] = r2.idToken.split(".");
  await assert.rejects(h.auth.verifyIdToken(`${a}.${b}.AAAA`), /подпись/);
});

test("письма: подтверждение почты, сброс пароля (завершает старые входы), вход по ссылке", async () => {
  const h = harness();
  const r = await h.auth.signUp("a@b.ru", "pass12345");
  const adm = h.auth.adminAuth();
  const vlink = await adm.generateEmailVerificationLink("a@b.ru", { url: "https://zalpos.ru/#/" });
  assert.match(vlink, /^https:\/\/zalpos\.ru\/#\/auth\?mode=verifyEmail&code=[\w%-]+&continueUrl=/);
  const vcode = decodeURIComponent(vlink.match(/code=([^&]+)/)[1]);
  await h.auth.applyCode("verifyEmail", vcode);
  assert.strictEqual((await adm.getUser(r.uid)).emailVerified, true);
  await assert.rejects(h.auth.applyCode("verifyEmail", vcode), /недействительна/, "код одноразовый");
  // Сброс пароля.
  const rlink = await adm.generatePasswordResetLink("a@b.ru");
  const rcode = decodeURIComponent(rlink.match(/code=([^&]+)/)[1]);
  h.tick(1500);
  await h.auth.applyCode("resetPassword", rcode, { password: "new-pass-999" });
  await assert.rejects(h.auth.verifyIdToken(r.idToken), (e) => e.code === "auth/id-token-revoked");
  await assert.rejects(h.auth.signIn("a@b.ru", "pass12345"));
  assert.ok(await h.auth.signIn("a@b.ru", "new-pass-999"));
  // Сброс на чужую почту — нет такого пользователя.
  await assert.rejects(adm.generatePasswordResetLink("none@b.ru"), (e) => e.code === "auth/user-not-found");
  // Ссылка устаревает через час.
  const old = decodeURIComponent((await adm.generatePasswordResetLink("a@b.ru")).match(/code=([^&]+)/)[1]);
  h.tick(61 * 60 * 1000);
  await assert.rejects(h.auth.applyCode("resetPassword", old, { password: "x-pass-1234" }), /устарела/);
  // Вход по ссылке — новый пользователь создаётся с подтверждённой почтой.
  const slink = await adm.generateSignInWithEmailLink("new@b.ru", {});
  const s = await h.auth.applyCode("signIn", decodeURIComponent(slink.match(/code=([^&]+)/)[1]));
  const sd = await h.auth.verifyIdToken(s.idToken);
  assert.strictEqual(sd.email, "new@b.ru");
  assert.strictEqual(sd.email_verified, true);
});

test("custom token (гость, мини-приложение) и анонимный вход", async () => {
  const h = harness();
  const a = await h.auth.anonymous();
  const ad = await h.auth.verifyIdToken(a.idToken);
  assert.strictEqual(ad.firebase.sign_in_provider, "anonymous");
  assert.ok(!ad.email);
  const ct = await h.auth.adminAuth().createCustomToken(a.uid, { tgApp: true });
  assert.match(ct, /^zct\./);
  const r = await h.auth.signInWithCustomToken(ct);
  const d = await h.auth.verifyIdToken(r.idToken);
  assert.strictEqual(d.uid, a.uid);
  assert.strictEqual(d.tgApp, true);
  await assert.rejects(h.auth.signInWithCustomToken(ct), /недействительна/, "одноразовый");
  // Признак tgApp переживает обновление токена.
  const r2 = await h.auth.refresh(r.refreshToken);
  assert.strictEqual((await h.auth.verifyIdToken(r2.idToken)).tgApp, true);
});

test("перенос из Firebase: тот же uid, пароль проверяется у Firebase один раз и дальше свой", async () => {
  const fb = fakeFirebase([
    { uid: "OWNER1abcdefghijklmnopqrstu", email: "owner@cafe.ru", emailVerified: true, _password: "old-pass-123" },
    { uid: "DEVICE1abcdefghijklmnopqrst" },
    { uid: "DEVICE2abcdefghijklmnopqrst" }, // старая версия кассы: вход ещё не сменён
  ]);
  const h = harness({ firebase: fb });
  const imp = await h.auth.importAllFromFirebase();
  assert.deepStrictEqual(imp, { imported: 3, total: 3 });
  // Вход по старому паролю: проверка у Firebase, затем свой хеш.
  const r = await h.auth.signIn("owner@cafe.ru", "old-pass-123");
  assert.strictEqual(r.uid, "OWNER1abcdefghijklmnopqrstu");
  assert.strictEqual((await h.auth.verifyIdToken(r.idToken)).email_verified, true);
  fb._users[0]._password = "changed-in-google";
  assert.ok(await h.auth.signIn("owner@cafe.ru", "old-pass-123"), "второй раз — без Firebase");
  assert.strictEqual(h.fbChecks.length, 1);
  await assert.rejects(h.auth.signIn("owner@cafe.ru", "nope-nope-1"));
  // Устройство меняет прежний вход на свой — тот же uid.
  const ex = await h.auth.exchange("fb:DEVICE1abcdefghijklmnopqrst:anonymous");
  assert.strictEqual(ex.uid, "DEVICE1abcdefghijklmnopqrst");
  assert.strictEqual((await h.auth.verifyIdToken(ex.idToken)).firebase.sign_in_provider, "anonymous");
  await assert.rejects(h.auth.exchange("garbage"), /недействителен/);
  // Регистрация на почту, что есть только в Firebase, — нельзя: это вход.
  fb._users.push({ uid: "OTHERabcdefghijklmnopqrstuv", email: "only@fb.ru", _password: "x-pass-1234", metadata: {}, providerData: [] });
  await assert.rejects(h.auth.signUp("only@fb.ru", "whatever-123"), /уже есть/);
  // Статистика и удаление из Firebase тех, кто уже входил сюда.
  const st = await h.auth.migrationStats();
  assert.strictEqual(st.withPassword, 1);
  assert.strictEqual(st.signedInHere, 2);
  // Владелец ещё входит и с телефона со старой версией — его пока не трогаем.
  await h.auth.noteFirebaseUse("OWNER1abcdefghijklmnopqrstu");
  assert.strictEqual((await h.auth.migrationStats()).firebaseRecent, 1);
  assert.deepStrictEqual(await h.auth.purgeFirebase(), { deleted: 1, kept: 2 }, "сменившее вход устройство; владелец на старой версии и несменившее — остаются");
  h.tick(15 * 24 * 3600 * 1000); // две недели без старой версии
  const p = await h.auth.purgeFirebase();
  assert.deepStrictEqual(p, { deleted: 1, kept: 1 }, "теперь и владелец; несменившее остаётся");
  assert.deepStrictEqual(fb._users.map((u) => u.uid), ["DEVICE2abcdefghijklmnopqrst", "OTHERabcdefghijklmnopqrstuv"]);
});

test("фасад Admin Auth: создать, найти по почте, изменить, отключить, удалить", async () => {
  const h = harness();
  const adm = h.auth.adminAuth();
  const u = await adm.createUser({ email: "M@x.ru", displayName: "Менеджер" });
  assert.strictEqual((await adm.getUserByEmail("m@x.ru")).uid, u.uid);
  await assert.rejects(adm.createUser({ email: "m@x.ru" }), (e) => e.code === "auth/email-already-exists");
  await adm.updateUser(u.uid, { email: "new@x.ru", emailVerified: true });
  await assert.rejects(adm.getUserByEmail("m@x.ru"), (e) => e.code === "auth/user-not-found");
  assert.strictEqual((await adm.getUserByEmail("new@x.ru")).emailVerified, true);
  const link = await adm.generatePasswordResetLink("new@x.ru");
  await h.auth.applyCode("resetPassword", decodeURIComponent(link.match(/code=([^&]+)/)[1]), { password: "first-pass-1" });
  const s = await h.auth.signIn("new@x.ru", "first-pass-1");
  await adm.updateUser(u.uid, { disabled: true });
  await assert.rejects(h.auth.verifyIdToken(s.idToken), (e) => e.code === "auth/user-disabled");
  await assert.rejects(h.auth.signIn("new@x.ru", "first-pass-1"), (e) => e.code === "auth/user-disabled");
  await adm.deleteUser(u.uid);
  await assert.rejects(adm.getUser(u.uid), (e) => e.code === "auth/user-not-found");
  const g = await adm.getUsers([{ uid: u.uid }]);
  assert.strictEqual(g.notFound.length, 1);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.error(`✗ ${name}\n  ${e && e.stack ? e.stack : e}`);
    }
  }
  console.log(`own-auth: ${passed} из ${passed + failed} проверок`);
  if (failed) process.exit(1);
})();
