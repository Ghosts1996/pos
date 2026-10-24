// Клиент входа кабинета и веб-приложения гостя (saas/console/zal-auth.js)
// против настоящего saas-gateway со своим входом (AUTH_BACKEND=own).
// Запуск: node test.zal-auth.mjs

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const consoleSrc = fs.readFileSync(path.join(here, "..", "saas", "console", "zal-auth.js"), "utf8");
const guestSrc = fs.readFileSync(path.join(here, "..", "saas", "guest-web", "app", "zal-auth.js"), "utf8");
assert.strictEqual(guestSrc, consoleSrc, "saas/guest-web/app/zal-auth.js должен совпадать с saas/console/zal-auth.js");
assert.ok(!/^import .*gstatic/m.test(consoleSrc), "zal-auth.js не должен загружать Firebase при импорте");
for (const f of ["console/zal-db.js", "console/console.js", "console/index.html", "guest-web/app/app.js", "guest-web/app/index.html"]) {
  const src = fs.readFileSync(path.join(here, "..", "saas", f), "utf8");
  assert.ok(!/^import [^;]*gstatic/m.test(src) && !/modulepreload" href="https:\/\/www\.gstatic/.test(src), `${f}: Firebase — только по требованию`);
}

// Хранилище браузера для Node.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalauth-"));
const port = 8099; // как smoke: без ботов и фоновых задач
const srv = spawn(process.execPath, [path.join(here, "server.js")], {
  env: { ...process.env, PORT: String(port), AUTH_BACKEND: "own", AUTH_DB_FILE: path.join(dir, "auth-db.json"),
    TELEGRAM_SECRET_KEY: "test-secret-key-for-zal-auth-0123456789", DATA_AUTO_MIGRATE: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (c) => (log += c));
srv.stderr.on("data", (c) => (log += c));
const gateway = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${gateway}/auth/status`)).ok) break; } catch (_) {}
  await new Promise((r) => setTimeout(r, 100));
}

fs.writeFileSync(path.join(dir, "zal-auth.mjs"), consoleSrc);
const A = await import(pathToFileURL(path.join(dir, "zal-auth.mjs")).href);

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n`, e);
    console.error(log.slice(-2000));
    srv.kill();
    process.exit(1);
  }
};

const auth = await A.initAuth({ gateway, backend: "own", firebaseApp: null });
const seen = [];
A.onAuthStateChanged(auth, (u) => seen.push(u ? u.uid : null));

await test("свой вход: без сессии", async () => {
  assert.ok(A.isOwnAuth(auth));
  assert.strictEqual(auth.currentUser, null);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(seen, [null]);
});

let uid;
await test("регистрация и подписка на вход", async () => {
  const cred = await A.createUserWithEmailAndPassword(auth, "Owner@Test.ru", "secret123");
  uid = cred.user.uid;
  assert.ok(uid);
  assert.strictEqual(auth.currentUser.email, "owner@test.ru");
  assert.strictEqual(auth.currentUser.emailVerified, false);
  assert.deepStrictEqual(seen, [null, uid]);
});

await test("токен: тот же до срока, новый по force", async () => {
  const t1 = await auth.currentUser.getIdToken();
  assert.strictEqual(await auth.currentUser.getIdToken(), t1);
  const r = await auth.currentUser.getIdTokenResult();
  assert.strictEqual(r.claims.uid, uid);
  assert.ok(Date.parse(r.authTime) > Date.now() - 60000);
  await new Promise((res) => setTimeout(res, 1100)); // iat в секундах
  const t2 = await auth.currentUser.getIdToken(true);
  assert.notStrictEqual(t2, t1);
  const me = await fetch(`${gateway}/auth/me`, { method: "POST", headers: { Authorization: `Bearer ${t2}` } }).then((x) => x.json());
  assert.strictEqual(me.uid, uid);
  assert.ok(me.createdAt > 0);
});

await test("вторая вкладка видит вход и обновляет токен без конфликта", async () => {
  const tab2 = await A.initAuth({ gateway, backend: "own", firebaseApp: null });
  assert.strictEqual(tab2.currentUser.uid, uid);
  await tab2.currentUser.getIdToken(true);
  // Первая вкладка с устаревшим refresh: берёт свежий из хранилища, а не выходит.
  auth._session.exp = 0;
  const t = await auth.currentUser.getIdToken();
  assert.ok(t);
  assert.strictEqual(auth.currentUser.uid, uid);
});

await test("неверный пароль — код как у Firebase", async () => {
  await assert.rejects(A.signInWithEmailAndPassword(auth, "owner@test.ru", "wrong-pass"), (e) => e.code === "auth/invalid-credential");
});

await test("смена пароля после повторного ввода", async () => {
  await A.reauthenticateWithCredential(auth.currentUser, A.EmailAuthProvider.credential("owner@test.ru", "secret123"));
  await A.updatePassword(auth.currentUser, "newsecret456");
  await A.signOut(auth);
  assert.strictEqual(auth.currentUser, null);
  const cred = await A.signInWithEmailAndPassword(auth, "owner@test.ru", "newsecret456");
  assert.strictEqual(cred.user.uid, uid);
  await auth.currentUser.reload();
  assert.strictEqual(auth.currentUser.email, "owner@test.ru");
});

await test("анонимный вход гостя", async () => {
  await A.signOut(auth);
  const cred = await A.signInAnonymously(auth);
  assert.ok(cred.user.uid && cred.user.uid !== uid);
  assert.strictEqual(cred.user.email, null);
});

await test("ссылки из писем своего входа", async () => {
  const a = A.actionFromUrl("https://zalpos.ru/#/auth?mode=resetPassword&code=abc&continueUrl=https%3A%2F%2Fzalpos.ru%2F%23%2Fpartner");
  assert.deepStrictEqual(a, { mode: "resetPassword", code: "abc", continueUrl: "https://zalpos.ru/#/partner" });
  assert.ok(A.isSignInWithEmailLink(auth, "https://zalpos.ru/#/auth?mode=signIn&code=x"));
  assert.ok(!A.isSignInWithEmailLink(auth, "https://zalpos.ru/#/"));
  await assert.rejects(A.signInWithEmailLink(auth, "", "https://zalpos.ru/#/auth?mode=signIn&code=bad"), (e) => e.code === "auth/invalid-action-code");
});

await test("отозванный вход — выход, как у Firebase", async () => {
  await A.signOut(auth);
  await A.signInWithEmailAndPassword(auth, "owner@test.ru", "newsecret456");
  auth._save({ ...auth._session, refreshToken: "revoked", exp: 0 });
  await assert.rejects(auth.currentUser.getIdToken());
  assert.strictEqual(auth.currentUser, null);
});

srv.kill();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`zal-auth: ${passed} проверок`);
