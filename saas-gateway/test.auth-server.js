"use strict";

// Свой вход через HTTP: /auth/* при AUTH_BACKEND=own, отказ новых входов при firebase.

const fs = require("fs");
const os = require("os");
const path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zal-auth-"));
process.env.PORT = "8099"; // как smoke: без бота и фоновых задач
process.env.AUTH_DB_FILE = path.join(dir, "auth-db.json");
process.env.DATA_DB_FILE = path.join(dir, "data.sqlite");
process.env.SUPPORT_DB_FILE = path.join(dir, "support-db.json");
process.env.AUTH_BACKEND = "firebase";
process.env.TELEGRAM_SECRET_KEY = process.env.TELEGRAM_SECRET_KEY || "test-secret-key-for-own-auth-0123456789";
const { shield } = require("./server.js");
const http = require("http");

let passed = 0;
let failed = 0;
const check = (name, cond) => (cond ? passed++ : (failed++, console.error(`FAIL: ${name}`)));

function request(method, p, { token, body, ip, ua } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    // Как nginx: адрес посетителя — в X-Real-IP.
    if (ip) headers["X-Real-IP"] = ip;
    if (ua) headers["User-Agent"] = ua;
    const req = http.request({ hostname: "127.0.0.1", port: 8099, path: p, method, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  await new Promise((r) => setTimeout(r, 200));
  let r = await request("GET", "/auth/status");
  check("статус: по умолчанию firebase", r.status === 200 && r.json.backend === "firebase");
  r = await request("POST", "/auth/signup", { body: { email: "a@test.ru", password: "secret123" } });
  check("firebase-режим: регистрация через сервер закрыта", r.status === 403 && r.json.code === "auth/operation-not-allowed");

  process.env.AUTH_BACKEND = "own";
  r = await request("GET", "/auth/status");
  check("статус: own", r.json.backend === "own");
  r = await request("POST", "/auth/signup", { body: { email: "A@test.ru", password: "secret123" } });
  check("регистрация", r.status === 200 && r.json.idToken && r.json.refreshToken && r.json.uid);
  const s = r.json;
  r = await request("POST", "/auth/signup", { body: { email: "a@test.ru", password: "secret123" } });
  check("повторная регистрация → 409", r.status === 409 && r.json.code === "auth/email-already-in-use");
  r = await request("POST", "/auth/login", { body: { email: "a@test.ru", password: "wrong-pass" } });
  check("неверный пароль → 400", r.status === 400 && r.json.code === "auth/invalid-credential");
  r = await request("POST", "/auth/login", { body: { email: "a@test.ru", password: "secret123" } });
  check("вход", r.status === 200 && r.json.uid === s.uid);
  r = await request("POST", "/auth/me", { token: r.json.idToken });
  check("me по своему токену", r.status === 200 && r.json.email === "a@test.ru" && r.json.emailVerified === false);
  r = await request("GET", "/db/status", { token: s.idToken });
  check("db/status показывает вход", r.json && r.json.auth === "own");
  r = await request("POST", "/auth/refresh", { body: { refreshToken: s.refreshToken } });
  check("обновление токена", r.status === 200 && r.json.idToken && r.json.refreshToken !== s.refreshToken);
  const r2 = await request("POST", "/auth/refresh", { body: { refreshToken: s.refreshToken } });
  check("старый refresh одноразовый", r2.status >= 400);
  r = await request("POST", "/auth/password", { token: s.idToken, body: { password: "newsecret456" } });
  check("смена пароля сразу после входа", r.status === 200);
  r = await request("POST", "/auth/login", { body: { email: "a@test.ru", password: "newsecret456" } });
  check("вход с новым паролем", r.status === 200);
  r = await request("POST", "/auth/anonymous", {});
  check("анонимный вход (устройство)", r.status === 200 && r.json.uid && r.json.uid !== s.uid);
  {
    // Короткий код входа гостя: выдаётся гостю, по нему — вход в тот же
    // аккаунт; новый код отменяет прежний; кривой код — отказ.
    const anon = r.json;
    const tok = anon.idToken;
    const reg = await request("POST", "/registerGuestRecovery", { token: tok, body: { secret: "a".repeat(43) } });
    check("ключ восстановления гостя принят", reg.status === 200);
    const c1 = (await request("POST", "/guestLoginCode", { token: tok, body: {} })).json || {};
    check("код входа вида XXXX-XXXX", /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/.test(c1.code || ""));
    const r1 = await request("POST", "/restoreGuestSession", { body: { code: (c1.code || "").toLowerCase().replace("-", " ") } });
    check("вход по коду (строчными, с пробелом) -> токен", r1.status === 200 && !!(r1.json || {}).token);
    const c2 = (await request("POST", "/guestLoginCode", { token: tok, body: {} })).json || {};
    const r2 = await request("POST", "/restoreGuestSession", { body: { code: c1.code } });
    check("старый код после нового не работает", c2.code && c2.code !== c1.code && r2.status === 403);
    const r3 = await request("POST", "/restoreGuestSession", { body: { code: "12" } });
    check("кривой код -> 400", r3.status === 400);
    const reg2 = await request("POST", "/registerGuestRecovery", { token: tok, body: { secret: "b".repeat(43) } });
    const r4 = await request("POST", "/restoreGuestSession", { body: { uid: anon.uid, secret: "a".repeat(43) } });
    check("ключ первого телефона работает после входа на втором", reg2.status === 200 && r4.status === 200);
    const r5 = await request("POST", "/guestLoginCode", { body: {} });
    check("код без входа -> 401", r5.status === 401);
    const r6 = await request("POST", "/guestLoginCode", { token: s.idToken, body: {} });
    check("код входа — только гостю (не владельцу с почтой)", r6.status === 403);
  }
  r = await request("POST", "/auth/me", { token: "bad.token.value" });
  check("плохой токен → 401", r.status === 401);
  r = await request("POST", "/authBackend", { token: s.idToken, body: { action: "enable" } });
  check("переключатель — только суперадмину", r.status !== 200);
  r = await request("POST", "/auth/nope", {});
  check("неизвестный путь не обрабатывается", r.status === 404);
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    const x = await request("POST", "/auth/login", { body: { email: "brute@test.ru", password: "x" } });
    if (x.status === 429) limited = true;
  }
  check("перебор паролей ограничен", limited);

  // ---- щит (shield.js) на настоящем сервере
  const before = shield.status().day.authFails;
  r = await request("POST", "/auth/login", { ip: "203.0.113.10", body: { email: "a@test.ru", password: "wrong-again" } });
  check("щит: неверный пароль учтён", r.status === 400 && shield.status().day.authFails === before + 1);
  const fake = { headers: { "x-real-ip": "203.0.113.11" }, socket: {} };
  for (let i = 0; i < 20; i++) shield.authFailed(fake, "a@test.ru");
  r = await request("POST", "/auth/login", { ip: "203.0.113.12", body: { email: "a@test.ru", password: "newsecret456" } });
  check("щит: к почте подбирали пароль — вход по паролю закрыт, с подсказкой",
    r.status === 429 && r.json.code === "auth/password-locked" && /Забыли пароль/.test(r.json.error));
  shield.authOk("a@test.ru");
  r = await request("POST", "/auth/login", { ip: "203.0.113.12", body: { email: "a@test.ru", password: "newsecret456" } });
  check("щит: после «Забыли пароль?» вход снова открыт", r.status === 200);
  r = await request("GET", "/.env", { ip: "198.51.100.40" });
  check("щит: проба сканера — 404", r.status === 404);
  await request("GET", "/wp-login.php", { ip: "198.51.100.40" });
  r = await request("GET", "/phpmyadmin/", { ip: "198.51.100.40" });
  check("щит: третья проба — адрес закрыт, Retry-After", r.status === 429 && Number(r.headers["retry-after"]) > 0 && r.json.code === "too-many-requests");
  r = await request("GET", "/auth/status", { ip: "198.51.100.40" });
  check("щит: закрытый адрес не доходит до сервиса", r.status === 429);
  r = await request("GET", "/health", { ip: "198.51.100.40" });
  check("щит: /health работает и для закрытого адреса", r.status === 200);
  r = await request("GET", "/auth/status");
  check("щит: свои запросы (без адреса посетителя) не задеты", r.status === 200);
  r = await request("GET", "/auth/status", { ip: "198.51.100.41", ua: "sqlmap/1.8" });
  check("щит: sqlmap — сразу отказ", r.status === 429);
  r = await request("OPTIONS", "/resolveTenantBySlug", { ip: "198.51.100.40" });
  check("щит: предварительный запрос браузера и у закрытого адреса — 200 (страница увидит причину)", r.status === 200);
  r = await request("GET", "/auth/status", { ip: "198.51.100.42" });
  check("щит: обычный посетитель проходит", r.status === 200);

  console.log(`auth-server: ${passed} passed, ${failed} failed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
