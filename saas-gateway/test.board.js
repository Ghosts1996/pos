"use strict";
// Табло заказов (board.js): ссылка с ключом из кабинета, «Готовится» /
// «Готов» по строкам чека, выданные пропадают, без имён и состава; смена
// ключа гасит старую ссылку; чужому — 403.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-"));
const PORT = 8091;
Object.assign(process.env, {
  PORT: String(PORT), DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0", GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "board-secret-key-0123456789abcdef",
});
const assert = require("assert/strict");
const server = require("./server.js");
const admin = require("firebase-admin");
const { boardState, orderLabel } = require("./board");
const store = server.localDataStore();
const T = (ms) => admin.firestore.Timestamp.fromMillis(ms);
const set = (p, d) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop()).set(d);

function req(method, p, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, json: j, raw, headers: res.headers }); });
    });
    r.on("error", reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

const tests = [];
const test = (n, f) => tests.push([n, f]);
const item = (o) => ({ name: "Капучино", price: 200, qty: 1, ...o });

test("состояние заказа по строкам", () => {
  const t = Date.now();
  assert.equal(boardState({ orderItems: [item({ sent: 1 })] }, t), "cooking");
  assert.equal(boardState({ orderItems: [item({ sent: 1, ready: 1, readyAt: t })] }, t), "ready");
  assert.equal(boardState({ orderItems: [item({ sent: 1, ready: 1, served: 1, readyAt: t })] }, t), null, "выдан — пропадает");
  assert.equal(boardState({ orderItems: [item({})] }, t), null, "не отправлен на кухню — не показываем");
  assert.equal(boardState({ orderItems: [item({ sent: 1, ready: 1, readyAt: t - 3600e3 })] }, t), null, "готов давно — убираем");
  assert.equal(boardState({ status: "cancelled", orderItems: [item({ sent: 1 })] }, t), null);
  assert.equal(orderLabel("abcdefXYZ1", 47), "47");
  assert.equal(orderLabel("abcdefxyz1", 0), "XYZ1");
});

test("ссылка, номера, без ПДн, смена ключа, 403 чужому", async () => {
  const sign = async (email) => (await req("POST", "/auth/signup", { body: { email, password: "secret-123456" } })).json;
  const me = await sign("owner-b@test.ru");
  const other = await sign("other-b@test.ru");
  await set("tenants/b1", { name: "Кофейня Утро", status: "active", ownerUserId: me.uid });
  await set(`tenantMembers/b1_${me.uid}`, { tenantId: "b1", userId: me.uid, role: "owner", status: "active" });
  const now = Date.now();
  await set("tenants/b1/sessions/s1", { orderType: "takeaway", orderNo: 47, startTime: T(now - 600e3), customerName: "Иван", orderItems: [item({ sent: 1 })] });
  await set("tenants/b1/sessions/s2", { orderType: "takeaway", orderNo: 48, status: "closed", startTime: T(now - 300e3), orderItems: [item({ sent: 1, ready: 1, readyAt: now })] });
  await set("tenants/b1/sessions/s3", { orderType: "takeaway", orderNo: 49, startTime: T(now - 200e3), orderItems: [item({ sent: 1, ready: 1, served: 1, readyAt: now })] });
  await set("tenants/b1/sessions/s4", { orderType: "hall", tableName: "Стол 3", startTime: T(now - 100e3), orderItems: [item({ sent: 1, ready: 1, readyAt: now })] });

  assert.equal((await req("POST", "/boardLink", { token: other.idToken, body: { tenantId: "b1" } })).status, 403);
  let r = await req("POST", "/boardLink", { token: me.idToken, body: { tenantId: "b1" } });
  assert.equal(r.status, 200, r.raw);
  const key = r.json.url.split("#")[1];
  assert.match(key, /^[A-Za-z0-9]{24}$/);

  const page = await req("GET", "/board/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-security-policy"], /script-src 'self'/);
  r = await req("GET", "/board/data", { headers: { "X-Board-Key": key } });
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.json.cooking.map((x) => x.label), ["47"]);
  assert.deepEqual(r.json.ready.map((x) => x.label), ["48"], "оплаченный, но не выданный — на табло");
  assert.equal(r.json.venue, "Кофейня Утро");
  assert.ok(!r.raw.includes("Иван") && !r.raw.includes("Капучино"), "ни имён, ни состава");

  r = await req("POST", "/boardLink", { token: me.idToken, body: { tenantId: "b1", action: "settings", hall: true } });
  r = await req("GET", "/board/data", { headers: { "X-Board-Key": key } });
  assert.ok(r.json.ready.some((x) => x.label === "Стол 3"), "заказы в зале — по настройке");

  assert.equal((await req("GET", "/board/data", { headers: { "X-Board-Key": "x".repeat(24) } })).status, 404);
  assert.equal((await req("GET", "/board/data")).status, 404);
  r = await req("POST", "/boardLink", { token: me.idToken, body: { tenantId: "b1", action: "rotate" } });
  const key2 = r.json.url.split("#")[1];
  assert.notEqual(key2, key);
  assert.equal((await req("GET", "/board/data", { headers: { "X-Board-Key": key } })).status, 404, "старая ссылка не работает");
  assert.equal((await req("GET", "/board/data", { headers: { "X-Board-Key": key2 } })).status, 200);
});

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  let ok = 0;
  for (const [name, fn] of tests) {
    try { await fn(); ok++; } catch (e) { console.error("FAIL", name, e); process.exitCode = 1; }
  }
  console.log(`board: ${ok} из ${tests.length} проверок`);
  process.exit(process.exitCode || 0);
})();
