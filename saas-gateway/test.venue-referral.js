"use strict";
// «Приведи коллегу» (venue-referral.js): код приглашения, запись «кто
// пригласил» при регистрации, +30 бесплатных дней пригласившему после первой
// настоящей оплаты приглашённого — один раз, не себе, не больше 12 месяцев.
const fs = require("fs");
const os = require("os");
const path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vref-"));
Object.assign(process.env, {
  PORT: "8098", DATA_BACKEND: "local", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"), AUTH_DB_FILE: path.join(dir, "auth.json"),
  BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0",
});
const assert = require("assert/strict");
const server = require("./server.js");
const admin = require("firebase-admin");
const { bonusUpdate, cleanCode, MAX_MONTHS } = require("./venue-referral");
const { applySubscriptionPayment, venueReferral, periodCarry } = server;
const store = server.localDataStore();
const T = (ms) => admin.firestore.Timestamp.fromMillis(ms);
const DAY = 86400000;
const now = Date.now();
const tests = [];
const test = (n, f) => tests.push([n, f]);
const doc = (p) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop());
const set = (p, d) => doc(p).set(d);
const get = async (p) => (await doc(p).get()).data() || {};
const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);
let payNo = 0;
const pay = (tenantId, extra = {}) => applySubscriptionPayment({
  eventId: `vref-${++payNo}`, provider: "robokassa", status: "succeeded", tenantId, chainId: null, planId: "start",
  billingPeriod: "monthly", amount: 1490, purpose: "subscription", ...extra,
});

test("код: только 8 знаков без похожих букв", () => {
  assert.equal(cleanCode("ab cd-ef23"), "ABCDEF23");
  assert.equal(cleanCode("ABCDEF2"), "");
  assert.equal(cleanCode("<script>"), "");
});

test("бонус: пробный +30 дней, оплаченный +30 бесплатных дней, не действует — в запас", () => {
  const t = bonusUpdate({ status: "trial", trialEndsAt: T(now + 3 * DAY) }, now, admin);
  assert.equal(ms(t.trialEndsAt), now + 33 * DAY);
  const a = bonusUpdate({ status: "active", currentPeriodEnd: T(now + 10 * DAY) }, now, admin);
  assert.equal(ms(a.currentPeriodEnd), now + 40 * DAY);
  assert.equal(ms(a.freeUntil), now + 30 * DAY);
  // Бесплатные дни не превращаются в оплаченные: при смене тарифа и возврате
  // их считают отдельно (periodCarry).
  const c = periodCarry({ now, cur: { status: "active", currentPeriodEnd: a.currentPeriodEnd, freeUntil: a.freeUntil }, planId: "start" });
  assert.equal(c.freeMs, 30 * DAY);
  assert.equal(c.carryMs, 40 * DAY);
  const p = bonusUpdate({ status: "past_due", referralCreditDays: 30, currentPeriodEnd: T(now - DAY) }, now, admin);
  assert.deepEqual(p, { referralCreditDays: 60 });
});

test("приглашение → первая оплата → +30 дней пригласившему; повторная оплата — ничего", async () => {
  await set("tenants/A", { status: "active", ownerUserId: "uA", name: "Кафе А" });
  await set("tenantMembers/A_uA", { tenantId: "A", userId: "uA", role: "owner", status: "active" });
  await set("subscriptions/A", { tenantId: "A", status: "active", planId: "start", currentPeriodEnd: T(now + 10 * DAY) });
  const code = await venueReferral.ensureCode(false, "A", "uA");
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.equal(await venueReferral.ensureCode(false, "A", "uA"), code, "код не меняется");

  assert.equal(await venueReferral.referredByFrom({ uid: "uA" }, { venueRef: code }), null, "себя пригласить нельзя");
  assert.equal(await venueReferral.referredByFrom({ uid: "uB" }, { venueRef: "ZZZZZZZZ" }), null, "чужой код");
  const rb = await venueReferral.referredByFrom({ uid: "uB" }, { venueRef: code.toLowerCase() });
  assert.equal(rb.billingId, "A");
  await set("tenants/B", { status: "trial", ownerUserId: "uB", referredBy: { ...rb, at: T(now) } });
  await set("subscriptions/B", { tenantId: "B", status: "trial", trialEndsAt: T(now + 5 * DAY) });

  await pay("B", { test: true });
  assert.equal(ms((await get("subscriptions/A")).currentPeriodEnd), now + 10 * DAY, "тестовый платёж бонус не даёт");
  await pay("B");
  const a = await get("subscriptions/A");
  assert.equal(ms(a.currentPeriodEnd), now + 40 * DAY);
  assert.equal((await get("tenants/A")).referralMonths, 1);
  assert.ok((await get("tenants/B")).referralRewardedAt);
  await pay("B");
  assert.equal(ms((await get("subscriptions/A")).currentPeriodEnd), now + 40 * DAY, "вторая оплата бонус не повторяет");
});

test("пригласивший без действующей подписки — дни ждут его следующей оплаты", async () => {
  await set("tenants/C", { status: "past_due", ownerUserId: "uC" });
  await set("subscriptions/C", { tenantId: "C", status: "past_due", currentPeriodEnd: T(now - DAY) });
  const code = await venueReferral.ensureCode(false, "C", "uC");
  const rb = await venueReferral.referredByFrom({ uid: "uD" }, { venueRef: code });
  await set("tenants/D", { status: "trial", ownerUserId: "uD", referredBy: rb });
  await set("subscriptions/D", { tenantId: "D", status: "trial", trialEndsAt: T(now + DAY) });
  await pay("D");
  assert.equal((await get("subscriptions/C")).referralCreditDays, 30);
  const before = Date.now();
  await pay("C");
  const c = await get("subscriptions/C");
  assert.equal(c.referralCreditDays, 0, "запас израсходован");
  const end = ms(c.currentPeriodEnd);
  assert.ok(end >= before + 59 * DAY && end <= Date.now() + 61 * DAY, `месяц оплаты + 30 бесплатных дней: ${(end - before) / DAY}`);
  assert.ok(ms(c.freeUntil) >= before + 29 * DAY, "30 дней — бесплатные");
});

test(`не больше ${MAX_MONTHS} месяцев одному пригласившему`, async () => {
  await set("tenants/E", { status: "active", ownerUserId: "uE", referralMonths: MAX_MONTHS });
  await set("subscriptions/E", { tenantId: "E", status: "active", currentPeriodEnd: T(now + 10 * DAY) });
  const code = await venueReferral.ensureCode(false, "E", "uE");
  const rb = await venueReferral.referredByFrom({ uid: "uF" }, { venueRef: code });
  await set("tenants/F", { status: "trial", ownerUserId: "uF", referredBy: rb });
  await set("subscriptions/F", { tenantId: "F", status: "trial", trialEndsAt: T(now + DAY) });
  await pay("F");
  assert.equal(ms((await get("subscriptions/E")).currentPeriodEnd), now + 10 * DAY);
  assert.equal((await get("tenants/F")).referralRewardSkipped, "limit");
});

(async () => {
  let ok = 0;
  for (const [name, fn] of tests) {
    try { await fn(); ok++; } catch (e) { console.error("FAIL", name, e); process.exitCode = 1; }
  }
  console.log(`venue-referral: ${ok} из ${tests.length} проверок`);
  process.exit(process.exitCode || 0);
})();
