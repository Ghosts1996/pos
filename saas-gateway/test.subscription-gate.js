"use strict";
// Блокировка за неоплату и лимит устройств — на сервере, а не только на
// экране кассы: срок вышел → past_due в течение 10 минут; сервер данных не
// принимает записи неоплаченного заведения и кассы сверх тарифа.
const fs = require("fs");
const os = require("os");
const path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subgate-"));
Object.assign(process.env, {
  PORT: "8099", DATA_BACKEND: "local", DATA_DB_FILE: path.join(dir, "data.sqlite"), AUTH_DB_FILE: path.join(dir, "auth.json"),
  BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0",
});
const assert = require("assert/strict");
const server = require("./server.js");
const admin = require("firebase-admin");
const { runExpireSubscriptions, dataWriteGate } = server;
const store = server.localDataStore();
const T = (ms) => admin.firestore.Timestamp.fromMillis(ms);
const H = 3600000;
const now = Date.now();
const tests = [];
const test = (n, f) => tests.push([n, f]);
const set = (p, d) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop()).set(d);
const w = (p) => [{ op: "update", path: p, data: { x: 1 } }];

test("срок вышел — past_due сразу (не через сутки); автопродление ждёт попытки списания", async () => {
  await set("tenants/trialEnded", { status: "trial" });
  await set("subscriptions/trialEnded", { status: "trial", trialEndsAt: T(now - 5 * 60000) });
  await set("tenants/paidEnded", { status: "active" });
  await set("subscriptions/paidEnded", { status: "active", currentPeriodEnd: T(now - 10 * 60000), provider: "robokassa" });
  await set("tenants/autoRenew", { status: "active" });
  await set("subscriptions/autoRenew", { status: "active", currentPeriodEnd: T(now - 10 * 60000), provider: "robokassa", robokassaParentInvId: "1" });
  await set("tenants/stillPaid", { status: "active" });
  await set("subscriptions/stillPaid", { status: "active", currentPeriodEnd: T(now + 48 * H) });
  const n = await runExpireSubscriptions(now);
  assert.equal(n, 2);
  const st = async (id) => (await store.collection("tenants").doc(id).get()).data().status;
  assert.equal(await st("trialEnded"), "past_due");
  assert.equal(await st("paidEnded"), "past_due");
  assert.equal(await st("autoRenew"), "active", "автосписание ещё не пробовали — ждём суточную задачу");
  assert.equal(await st("stillPaid"), "active");
  // Через сутки после конца срока попытки так и не было — тоже past_due.
  assert.equal(await runExpireSubscriptions(now + 25 * H), 1);
  assert.equal(await st("autoRenew"), "past_due");
});

test("неоплаченное заведение и сеть: записи не принимаются; оплаченное, чужие пути, супер-админ — можно", async () => {
  await set("tenants/paid", { status: "active" });
  await set("tenants/unpaid", { status: "past_due" });
  await set("tenants/stopped", { status: "suspended" });
  await set("chains/c1", { status: "past_due" });
  await set("tenants/point", { status: "active", chainId: "c1" });
  await set("superAdmins/boss", { at: 1 });
  const me = { uid: "cashier" };
  assert.equal(await dataWriteGate(store, me, w("tenants/paid/sessions/s1")), null);
  for (const t of ["unpaid", "stopped", "point"]) {
    const deny = await dataWriteGate(store, me, w(`tenants/${t}/sessions/s1`));
    assert.equal(deny && deny.code, "subscription-blocked", t);
    assert.equal(deny.status, 402);
  }
  assert.equal(await dataWriteGate(store, me, w("users/cashier")), null, "вне заведения — правила решают");
  assert.equal(await dataWriteGate(store, { uid: "boss" }, w("tenants/unpaid/sessions/s1")), null);
  assert.equal(await dataWriteGate(store, null, w("tenants/unpaid/sessions/s1")), null, "без входа — правила откажут сами");
});

test("лимит устройств: третья касса при лимите 2 не пишет; удалили старую — пишет (через кэш 30 с)", async () => {
  await set("tenants/lim", { status: "active" });
  await set("tenants/lim/public/features", { maxDevices: 2 });
  await set("tenants/lim/devices/d1", { status: "active", createdAt: T(now - 3 * H) });
  await set("tenants/lim/devices/d2", { status: "active", createdAt: T(now - 2 * H) });
  await set("tenants/lim/devices/d3", { status: "active", createdAt: T(now - H) });
  assert.equal(await dataWriteGate(store, { uid: "d1" }, w("tenants/lim/sessions/s")), null);
  assert.equal(await dataWriteGate(store, { uid: "d2" }, w("tenants/lim/sessions/s")), null);
  const deny = await dataWriteGate(store, { uid: "d3" }, w("tenants/lim/sessions/s"));
  assert.equal(deny && deny.code, "device-limit");
  assert.equal(await dataWriteGate(store, { uid: "owner" }, w("tenants/lim/sessions/s")), null, "кабинет владельца — не устройство");
  await set("tenants/lim/devices/d4", { status: "removed", createdAt: T(now - 4 * H) });
  assert.equal((await dataWriteGate(store, { uid: "d4" }, w("tenants/lim/sessions/s"))).code, "permission-denied");
});

test("смена без интернета: время нажатия принимается до 48 ч, с отметкой доставки; без отметки — нет", async () => {
  const ds = require("./data-server");
  const rulesSource = fs.readFileSync(path.join(__dirname, "..", "saas", "firestore.rules"), "utf8");
  let clock = now;
  const st = ds.createDataStore({ admin, file: path.join(dir, "rules.sqlite"), now: () => clock });
  const secure = ds.createSecureDb({ store: st, rulesSource, admin, now: () => clock });
  const put = (p, d) => st.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop()).set(d);
  await put("tenants/r1", { status: "active" });
  await put("tenantMembers/r1_kassa", { tenantId: "r1", userId: "kassa", role: "employee", status: "active" });
  const auth = { uid: "kassa", token: { uid: "kassa" } };
  const ts = (ms) => ({ __ts: true, ms });
  const wire = (v) => (v && v.__ts ? { __ts: v.ms } : v);
  const SERVER_TS = { __op: "serverTimestamp" };
  const enc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === SERVER_TS ? v : wire(v)]));
  const create = (id, data) => secure.commit(auth, [{ op: "set", path: `tenants/r1/staffShifts/${id}`, data: enc(data) }]);
  const update = (id, data) => secure.commit(auth, [{ op: "update", path: `tenants/r1/staffShifts/${id}`, data: enc(data) }]);
  const tapped = clock - 3 * H; // нажали 3 часа назад, связь вернулась только сейчас
  create("s1", { employeeId: "e1", startedAt: ts(tapped), syncedAt: SERVER_TS, endedAt: null, status: "open", manual: false });
  assert.throws(() => create("s2", { employeeId: "e1", startedAt: ts(tapped), endedAt: null, status: "open", manual: false }), /нет прав|denied|Нет доступа/i, "без отметки доставки — нельзя задним числом");
  assert.throws(() => create("s3", { employeeId: "e1", startedAt: ts(clock - 50 * H), syncedAt: SERVER_TS, endedAt: null, status: "open", manual: false }), /нет прав|denied|Нет доступа/i, "старше 48 ч — нельзя");
  clock += 5 * H;
  update("s1", { status: "closed", endedAt: ts(clock - 2 * H), endSyncedAt: SERVER_TS });
  const doc = st.raw("tenants/r1/staffShifts/s1");
  assert.equal(doc.status, "closed");
  assert.equal(doc.endedAt.toMillis(), clock - 2 * H, "уход — время нажатия, а не время связи");
  assert.equal(doc.endSyncedAt.toMillis(), clock);
  st.close();
});

(async () => {
  let ok = 0;
  for (const [name, fn] of tests) {
    try { await fn(); ok++; } catch (e) { console.error("FAIL", name, e); process.exitCode = 1; }
  }
  console.log(`subscription-gate: ${ok} из ${tests.length} проверок`);
  process.exit(process.exitCode || 0);
})();
