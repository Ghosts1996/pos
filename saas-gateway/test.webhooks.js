"use strict";
// Вебхуки заведения (webhooks.js): владелец добавляет адрес и события, сервер
// сам шлёт подписанные события без ПДн, повторяет при сбое, выключает после
// 20 неудач; внутренние адреса запрещены; чужое заведение — 403.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webhooks-"));
const PORT = 8093;
Object.assign(process.env, {
  PORT: String(PORT), DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0", GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "webhooks-secret-key-0123456789abc",
  WEBHOOKS_ALLOW_HTTP: "1", WEBHOOKS_ALLOW_PRIVATE: "1", WEBHOOKS_RETRY_MS: "200,200,200",
});
const assert = require("assert/strict");
const server = require("./server.js");
const admin = require("firebase-admin");
const wh = require("./webhooks");
const store = server.localDataStore();
const T = (ms) => admin.firestore.Timestamp.fromMillis(ms);
const doc = (p) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop());
const set = (p, d) => doc(p).set(d);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(50); }
  return null;
}

function call(p, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", reject);
    req.end(data);
  });
}

// Приёмник: запоминает запросы; failNext — сколько следующих ответить 500.
const got = [];
let failNext = 0;
const recv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    got.push({ headers: req.headers, body: raw, json: JSON.parse(raw) });
    if (failNext > 0) { failNext--; res.statusCode = 500; return res.end("fail"); }
    res.end("ok");
  });
});

const tests = [];
const test = (n, f) => tests.push([n, f]);
let me;
let other;
let secret;
const URL_ = () => `http://127.0.0.1:${recv.address().port}/hook`;

test("адреса: только внешние https, внутренние сети запрещены", async () => {
  assert.equal(typeof wh.checkUrl("http://example.ru/x"), "string", "без https — нельзя");
  assert.ok(wh.checkUrl("https://hooks.albato.ru/abc") instanceof URL);
  assert.equal(typeof wh.checkUrl("https://user:pw@example.ru/"), "string");
  assert.equal(typeof wh.checkUrl("https://localhost/"), "string");
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
    assert.ok(wh.privateIp(ip), ip);
  }
  for (const ip of ["45.87.245.63", "77.88.55.88", "2a02:6b8::2:242"]) assert.ok(!wh.privateIp(ip), ip);
  await assert.rejects(wh.resolvePublic("127.0.0.1"), /внутреннюю сеть/);
});

test("подключение: секрет один раз, чек закрыт → подписанное событие без ПДн", async () => {
  await set("tenants/w1", { name: "Кафе", slug: "kafe-w1", status: "active", ownerUserId: me.uid, planId: "pro", timezone: "Europe/Moscow" });
  await set(`tenantMembers/w1_${me.uid}`, { tenantId: "w1", userId: me.uid, role: "owner", status: "active" });
  let r = await call("/webhooks", me.idToken, { tenantId: "w1", action: "create", url: URL_(), events: ["order.closed", "stoplist.changed", "reservation.created"] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  secret = r.json.secret;
  assert.match(secret, wh.SECRET_RE);
  r = await call("/webhooks", me.idToken, { tenantId: "w1", action: "list" });
  assert.equal(r.json.hooks.length, 1);
  assert.ok(!JSON.stringify(r.json).includes(secret), "секрет больше не показывается");
  await wait(400);

  await set("tenants/w1/menuItems/m1", { name: "Борщ", price: 350, available: true });
  await set("tenants/w1/sessions/s1", {
    status: "closed", closedAt: T(Date.now()), startTime: T(Date.now() - 3600e3), tableName: "5", guests: 2,
    orderItems: [{ name: "Борщ", price: 350, qty: 2, comment: "без сметаны" }], paymentCard: 700,
    clientName: "Иван Петров", clientPhone: "+79001234567", deliveryAddress: "ул. Ленина, 1",
  });
  const ev = await until(() => got.find((g) => g.json.type === "order.closed"));
  assert.ok(ev, "событие пришло");
  assert.equal(ev.json.data.paid, 700);
  assert.equal(ev.json.data.items[0].qty, 2);
  for (const pii of ["Иван", "79001234567", "Ленина", "сметаны"]) assert.ok(!ev.body.includes(pii), `без ПДн: ${pii}`);
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(ev.headers["x-zalpos-signature"]);
  assert.ok(m, ev.headers["x-zalpos-signature"]);
  assert.equal(m[2], crypto.createHmac("sha256", secret).update(`${m[1]}.${ev.body}`).digest("hex"), "подпись сходится");
  assert.equal(ev.headers["x-zalpos-event"], "order.closed");

  // Стоп-лист: блюдо снято.
  await doc("tenants/w1/menuItems/m1").set({ available: false }, { merge: true });
  const sl = await until(() => got.find((g) => g.json.type === "stoplist.changed"));
  assert.deepEqual(sl.json.data, { id: "m1", name: "Борщ", available: false });

  // Бронь — без имени и телефона.
  await set("tenants/w1/reservations/b1", { status: "pending", startTime: T(Date.now() + 86400e3), guestsCount: 4, tableName: "7", guestName: "Мария", phone: "+79990000000" });
  const br = await until(() => got.find((g) => g.json.type === "reservation.created"));
  assert.equal(br.json.data.guests, 4);
  assert.ok(!br.body.includes("Мария") && !br.body.includes("79990000000"));
  // Событие, на которое не подписаны, — не приходит.
  await set("tenants/w1/shifts/z1", { status: "closed", closedAt: T(Date.now()) });
  await wait(400);
  assert.ok(!got.some((g) => g.json.type === "shift.closed"));
});

test("сбой приёмника — повтор; проверка кнопкой «Тест»; учебный чек не уходит", async () => {
  const before = got.length;
  failNext = 1;
  await set("tenants/w1/sessions/s2", { status: "closed", closedAt: T(Date.now()), orderItems: [{ name: "Чай", price: 100, qty: 1 }], paymentCash: 100 });
  await set("tenants/w1/sessions/s3", { status: "closed", closedAt: T(Date.now()), training: true, orderItems: [{ name: "Чай", price: 100, qty: 1 }] });
  const twice = await until(() => got.slice(before).filter((g) => g.json.data && g.json.data.id === "s2").length >= 2, 4000);
  assert.ok(twice, "после 500 — повтор");
  const ids = got.slice(before).filter((g) => g.json.data && g.json.data.id === "s2").map((g) => g.json.id);
  assert.equal(ids[0], ids[1], "повтор — то же событие (тот же id)");
  assert.ok(!got.some((g) => g.json.data && g.json.data.id === "s3"), "учебный чек стажёра не отправляется");
  const hookId = (await call("/webhooks", me.idToken, { tenantId: "w1", action: "list" })).json.hooks[0].id;
  const t = await call("/webhooks", me.idToken, { tenantId: "w1", action: "test", hookId });
  assert.equal(t.status, 200);
  assert.equal(t.json.result.status, 200);
  assert.ok(got.some((g) => g.json.type === "ping"));
});

test("чужое заведение — 403; не больше 5 вебхуков; удаление", async () => {
  assert.equal((await call("/webhooks", other.idToken, { tenantId: "w1", action: "list" })).status, 403);
  const hookId = (await call("/webhooks", me.idToken, { tenantId: "w1", action: "list" })).json.hooks[0].id;
  assert.equal((await call("/webhooks", other.idToken, { tenantId: "w1", action: "delete", hookId })).status, 403);
  for (let i = 0; i < 4; i++) {
    const r = await call("/webhooks", me.idToken, { tenantId: "w1", action: "create", url: `${URL_()}?n=${i}`, events: ["shift.closed"] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  assert.equal((await call("/webhooks", me.idToken, { tenantId: "w1", action: "create", url: `${URL_()}?n=9`, events: ["shift.closed"] })).status, 409);
  const r = await call("/webhooks", me.idToken, { tenantId: "w1", action: "delete", hookId });
  assert.equal(r.json.hooks.length, 4);
  // Клиент базы читать вебхуки (и секреты) не может.
  const db = await call("/db/get", me.idToken, { paths: [`webhooks/${r.json.hooks[0].id}`] });
  assert.equal(db.status, 403, "секреты вебхуков закрыты для клиентов");
});

(async () => {
  await new Promise((r) => recv.listen(0, "127.0.0.1", r));
  await wait(300);
  const sign = async (email) => {
    const made = (await call("/auth/signup", null, { email, password: "secret-123456" })).json;
    return made;
  };
  me = await sign("owner-w@test.ru");
  other = await sign("other-w@test.ru");
  let ok = 0;
  for (const [name, fn] of tests) {
    try { await fn(); ok++; } catch (e) { console.error("FAIL", name, e); process.exitCode = 1; }
  }
  console.log(`webhooks: ${ok} из ${tests.length} проверок`);
  process.exit(process.exitCode || 0);
})();
