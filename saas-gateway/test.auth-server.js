"use strict";

// Свой вход через HTTP: /auth/* при AUTH_BACKEND=own, отказ новых входов при firebase.

const fs = require("fs");
const os = require("os");
const path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zal-auth-"));
process.env.PORT = "8099"; // как smoke: без бота и фоновых задач
process.env.AUTH_DB_FILE = path.join(dir, "auth-db.json");
process.env.AUTH_BACKEND = "firebase";
process.env.TELEGRAM_SECRET_KEY = process.env.TELEGRAM_SECRET_KEY || "test-secret-key-for-own-auth-0123456789";
require("./server.js");
const http = require("http");

let passed = 0;
let failed = 0;
const check = (name, cond) => (cond ? passed++ : (failed++, console.error(`FAIL: ${name}`)));

function request(method, p, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ hostname: "127.0.0.1", port: 8099, path: p, method, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, json });
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

  console.log(`auth-server: ${passed} passed, ${failed} failed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
