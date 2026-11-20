"use strict";
// Смена тарифа без оплаты (/changePlan) и перевод «сеть ↔ одно заведение»:
// оплаченные дни пересчитываются по месячной цене нового тарифа (дороже —
// дней меньше, дешевле — больше), бесплатные дни переходят как есть,
// туда-обратно срок не растёт; автопродление и период оплаты переезжают
// вместе с подпиской; свой старый код сети можно взять снова.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planswitch-"));
const PORT = 8094;
Object.assign(process.env, {
  PORT: String(PORT), DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0", GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "planswitch-secret-key-0123456789ab",
});
const assert = require("assert/strict");
const server = require("./server.js");
const admin = require("firebase-admin");
const { switchedPeriod } = server;
const store = server.localDataStore();
const T = (ms) => admin.firestore.Timestamp.fromMillis(ms);
const DAY = 86400000;
const doc = (p) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop());
const set = (p, d) => doc(p).set(d);
const get = async (p) => (await doc(p).get()).data() || {};
const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);
const days = (endMs) => (endMs - Date.now()) / DAY;

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
    req.write(data);
    req.end();
  });
}

const tests = [];
const test = (n, f) => tests.push([n, f]);
let me;

test("пересчёт: дороже — дней меньше, дешевле — больше, бесплатные — как есть", () => {
  const now = Date.now();
  const cur = { status: "active", planId: "a", currentPeriodEnd: T(now + 100 * DAY), freeUntil: T(now + 10 * DAY) };
  const up = switchedPeriod({ now, cur, toPlanId: "b", wasMonthly: 1000, nextMonthly: 2000 });
  assert.equal(Math.round((up.endMs - now) / DAY), 10 + 45);
  const down = switchedPeriod({ now, cur, toPlanId: "b", wasMonthly: 2000, nextMonthly: 1000 });
  assert.equal(Math.round((down.endMs - now) / DAY), 10 + 180);
  assert.equal(switchedPeriod({ now, cur: { ...cur, status: "past_due" }, toPlanId: "b", wasMonthly: 1, nextMonthly: 2 }), null);
});

test("тариф заведения: Старт → Про без оплаты, срок пересчитан; туда-обратно не растёт", async () => {
  await set("tenants/t1", { name: "Кафе", slug: "kafe-one", status: "active", ownerUserId: me.uid, planId: "start" });
  await set(`tenantMembers/t1_${me.uid}`, { tenantId: "t1", userId: me.uid, role: "owner", status: "active" });
  await set("subscriptions/t1", { tenantId: "t1", status: "active", planId: "start", billingPeriod: "yearly", robokassaParentInvId: "77",
    currentPeriodEnd: T(Date.now() + 100 * DAY) });
  const q = await call("/planSwitchQuote", me.idToken, { tenantId: "t1", planId: "pro" });
  assert.equal(q.status, 200, JSON.stringify(q.json));
  assert.ok(q.json.canSwitch && q.json.nextMonthly > q.json.wasMonthly);
  const r = await call("/changePlan", me.idToken, { tenantId: "t1", planId: "pro" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const sub = await get("subscriptions/t1");
  assert.equal(sub.planId, "pro");
  const expect = 100 * q.json.wasMonthly / q.json.nextMonthly;
  assert.ok(Math.abs(days(ms(sub.currentPeriodEnd)) - expect) < 0.05, `${days(ms(sub.currentPeriodEnd))} ≈ ${expect}`);
  assert.equal(sub.robokassaParentInvId, "77", "автопродление на месте");
  assert.equal((await get("tenants/t1")).planId, "pro");
  await call("/changePlan", me.idToken, { tenantId: "t1", planId: "start" });
  const back = await get("subscriptions/t1");
  assert.ok(days(ms(back.currentPeriodEnd)) <= 100.001, "туда-обратно — не больше исходного срока");
  assert.ok(days(ms(back.currentPeriodEnd)) > 99.9);
});

test("нельзя: тариф сети для заведения, просроченная подписка, чужое заведение", async () => {
  assert.equal((await call("/changePlan", me.idToken, { tenantId: "t1", planId: "chain" })).status, 412);
  await doc("subscriptions/t1").set({ status: "past_due" }, { merge: true });
  assert.equal((await call("/changePlan", me.idToken, { tenantId: "t1", planId: "pro" })).status, 412);
  const other = (await call("/auth/signup", null, { email: "other@test.ru", password: "secret-123456" })).json;
  assert.equal((await call("/changePlan", other.idToken, { tenantId: "t1", planId: "pro" })).status, 403);
  assert.equal((await call("/planSwitchQuote", other.idToken, { tenantId: "t1", planId: "pro" })).status, 403);
});

test("сеть ↔ заведение: срок пересчитан, автопродление и период переезжают, свой код сети снова свободен", async () => {
  await set("tenants/t2", { name: "Бар", slug: "bar-two", status: "active", ownerUserId: me.uid, planId: "standard" });
  await set(`tenantMembers/t2_${me.uid}`, { tenantId: "t2", userId: me.uid, role: "owner", status: "active" });
  await set("subscriptions/t2", { tenantId: "t2", status: "active", planId: "standard", billingPeriod: "semiannual", robokassaParentInvId: "88",
    currentPeriodEnd: T(Date.now() + 161 * DAY) });
  const q1 = (await call("/planSwitchQuote", me.idToken, { tenantId: "t2", planId: "chain" })).json;
  let r = await call("/convertTenantToChain", me.idToken, { tenantId: "t2", name: "Бар сеть", slug: "bar-set", planId: "chain" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const chainId = r.json.chainId;
  const cs = await get(`subscriptions/${chainId}`);
  assert.equal(cs.planId, "chain");
  assert.equal(cs.robokassaParentInvId, "88");
  assert.equal(cs.billingPeriod, "semiannual");
  assert.ok(Math.abs(days(ms(cs.currentPeriodEnd)) - 161 * q1.wasMonthly / q1.nextMonthly) < 0.05);

  // Внутри сети — Сеть → Сеть Про без оплаты.
  r = await call("/changePlan", me.idToken, { tenantId: "t2", planId: "chain-pro" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const pro = await get(`subscriptions/${chainId}`);
  assert.equal(pro.planId, "chain-pro");
  assert.ok(ms(pro.currentPeriodEnd) < ms(cs.currentPeriodEnd), "дороже — дней меньше");

  r = await call("/convertChainToSingle", me.idToken, { tenantId: "t2", planId: "standard" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const single = await get("subscriptions/t2");
  assert.equal(single.status, "active");
  assert.equal(single.robokassaParentInvId, "88");
  assert.ok(Math.abs(days(ms(single.currentPeriodEnd)) - 161) < 0.1, `деньги не пропали: ${days(ms(single.currentPeriodEnd))}`);
  assert.ok(days(ms(single.currentPeriodEnd)) <= 161.001, "и не выросли");

  // Тот же код сети — снова свободен для своего владельца, для чужого — нет.
  const other = (await call("/auth/signup", null, { email: "other2@test.ru", password: "secret-123456" })).json;
  assert.equal((await call("/slugAvailable", other.idToken, { slug: "bar-set" })).json.free, false);
  const mine = (await call("/slugAvailable", me.idToken, { slug: "bar-set" })).json;
  assert.equal(mine.free, true);
  assert.equal((await call("/slugAvailable", me.idToken, { slug: "bar-two" })).json.suggestion, "bar-two-set");
  r = await call("/convertTenantToChain", me.idToken, { tenantId: "t2", name: "Бар сеть", slug: "bar-set", planId: "chain" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  for (const [id, p] of Object.entries(server.PLAN_CATALOG)) await set(`plans/${id}`, p);
  const made = (await call("/auth/signup", null, { email: "owner@test.ru", password: "secret-123456" })).json;
  await server.ownAuth().adminAuth().updateUser(made.uid, { emailVerified: true });
  me = (await call("/auth/login", null, { email: "owner@test.ru", password: "secret-123456" })).json;
  let ok = 0;
  for (const [name, fn] of tests) {
    try { await fn(); ok++; } catch (e) { console.error("FAIL", name, e); process.exitCode = 1; }
  }
  console.log(`plan-switch: ${ok} из ${tests.length} проверок`);
  process.exit(process.exitCode || 0);
})();
