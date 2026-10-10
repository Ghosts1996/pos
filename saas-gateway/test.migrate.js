"use strict";

// Перевод заведения на хранение ПДн только в РФ (pii-migrate.js): память
// вместо Firestore и справочника. Проверяем, что перенос ничего не теряет,
// переключение ждёт обновлённых касс, а очистка убирает из Firestore только
// сверенное со справочником.

const assert = require("assert/strict");
const { fakeDb, admin, HttpError } = require("./test-helpers");
const { createPiiMigrate, legacyStaffId } = require("./pii-migrate");

/** Справочник в РФ: pii_seed дописывает только пустое, как vault.js. */
function fakeVault({ dropKinds = [] } = {}) {
  const rows = new Map(); // 'k:id' → { name, phone, address, extra, by }
  const digits = (v) => String(v || "").replace(/\D/g, "");
  return {
    rows,
    enabled: () => true,
    async call(body) {
      assert.equal(body.kind, "pii_seed");
      let filled = 0;
      for (const it of body.items) {
        if (dropKinds.includes(it.k)) continue;
        const key = `${it.k}:${it.id}`;
        const cur = rows.get(key) || { name: "", phone: "", address: "", extra: {}, by: it.by || "migration" };
        const f = it.fields || {};
        const next = {
          ...cur,
          name: cur.name || f.name || "",
          phone: cur.phone || digits(f.phone),
          address: cur.address || f.address || "",
          extra: { ...(f.extra || {}), ...cur.extra },
        };
        if (JSON.stringify(next) !== JSON.stringify(cur) || !rows.has(key)) filled++;
        rows.set(key, next);
      }
      return { ok: true, filled };
    },
    async lookup(_tenantId, refs) {
      const out = new Map();
      for (const r of refs) {
        const row = rows.get(`${r.k}:${r.id}`);
        if (row) out.set(`${r.k}:${r.id}`, { id: r.id, k: r.k, ...row });
      }
      return out;
    },
  };
}

let n = 0;
async function test(name, fn) {
  await fn();
  n++;
  void name;
}

function seed(store) {
  const T = "tenants/t1";
  store.set(T, { name: "Лаунж", chainId: null });
  store.set(`${T}/meta/venueProfile`, { name: "Лаунж" });
  store.set(`${T}/employees/e1`, {
    name: "Анна", phone: "79001112233", role: "admin",
    payHistory: [{ at: 1, byName: "Анна", byId: "e1" }, { at: 2, byName: "Борис" }],
  });
  store.set(`${T}/employees/e2`, { name: "Виктор", role: "employee" });
  store.set(`${T}/clients/g1`, { name: "Иван", phone: "79005556677", bonusBalance: 10 });
  store.set(`${T}/phoneIndex/79005556677`, { uid: "g1" });
  store.set(`${T}/reservations/r1`, { guestName: "Иван", phone: "79005556677", clientUid: "g1", handledBy: "Анна", guestsCount: 2 });
  store.set(`${T}/waitlist/w1`, { guestName: "Ольга", phone: "79009998877", clientUid: "g2" });
  store.set(`${T}/sessions/s1`, {
    customerName: "Пётр", customerPhone: "79001234567", deliveryAddress: "Ленина, 1", courierName: "Коля",
    employeeName: "Виктор", employeeId: "e2", cancelledBy: "Борис", totalWithDiscount: 900,
  });
  store.set(`${T}/guestOrders/o1`, { guestName: "Иван", clientUid: "g1", doneBy: "auto", items: [] });
  store.set(`${T}/auditLog/a1`, { employeeName: "Анна", details: { approvedBy: "Виктор", qty: 1 } });
  store.set(`${T}/tips/tp1`, { employeeName: "Анна", employeeId: "e1", amount: 100, teamMembers: [] });
  store.set(`${T}/tips/tp2`, { employeeName: "Всей смене", employeeId: "", amount: 300, teamMembers: [{ id: "e1", name: "Анна" }, { id: "e2", name: "Виктор" }] });
  store.set(`${T}/meta/tipsTeam`, { members: { e1: { name: "Анна", position: "waiter" } } });
  store.set(`${T}/devices/d1`, { status: "active", deviceName: "Касса 1", piiReady: 1, appBuild: "500" });
  store.set(`${T}/devices/d2`, { status: "active", deviceName: "Старый планшет" });
  store.set(`${T}/devices/d3`, { status: "disabled", deviceName: "Списан" });
}

(async () => {
  const { db, store } = fakeDb();
  seed(store);
  const vault = fakeVault({ dropKinds: ["waitlist"] });
  let clock = Date.UTC(2026, 9, 10, 12);
  const errors = [];
  const mig = createPiiMigrate({
    db: () => db, admin, pii: vault, HttpError, now: () => clock,
    log: { error: (...a) => errors.push(a.join(" ")) },
  });
  const run = async (action, opts) => {
    const r = await mig.run("t1", action, opts);
    if (r.done) await r.done;
    return r;
  };
  const doc = (p) => store.get(`tenants/t1/${p}`);
  const borisId = legacyStaffId("t1", "Борис");

  await test("статус: обычный режим, старый планшет не готов, списанный не считается", async () => {
    const s = await mig.status("t1");
    assert.equal(s.mode, "mirror");
    assert.equal(s.devices.length, 2);
    assert.equal(s.blocking, 1);
    assert.equal(s.copy, null);
  });

  await test("переключение — только после переноса", async () => {
    await assert.rejects(run("switch", {}), (e) => e.status === 409 && /перенесите/.test(e.message));
  });

  await test("перенос: всё в справочник, Firestore не меняется, гостю — отметка номера", async () => {
    await run("copy", { by: "admin1" });
    assert.deepEqual(errors, []);
    assert.equal(doc("meta/piiMigration").copy.state, "done");
    assert.equal(vault.rows.get("staff:e1").name, "Анна");
    assert.equal(vault.rows.get("staff:e1").phone, "79001112233");
    assert.equal(vault.rows.get("guest:g1").phone, "79005556677");
    assert.equal(vault.rows.get("reservation:r1").by, "g1");
    const d = vault.rows.get("delivery:s1");
    assert.equal(d.address, "Ленина, 1");
    assert.equal(d.extra.courierName, "Коля");
    // Бывший сотрудник из «кто сделал» — своя запись под постоянным id.
    assert.equal(vault.rows.get(`staff:${borisId}`).name, "Борис");
    assert.equal(doc("reservations/r1").guestName, "Иван");
    assert.equal(doc("clients/g1").phoneOnFile, true);
    assert.equal(doc("clients/g1").name, "Иван");
  });

  await test("переключение ждёт обновлённых касс; принудительно — можно", async () => {
    await assert.rejects(run("switch", {}), (e) => e.status === 409 && /Старый планшет/.test(e.message));
    const r = await run("switch", { force: true, by: "admin1" });
    assert.equal(r.forced, true);
    assert.equal(doc("meta/venueProfile").piiMode, "rf");
    await assert.rejects(run("switch", { force: true }), (e) => e.status === 409);
  });

  await test("очистка — не раньше чем через сутки; пробный проход ничего не стирает", async () => {
    await assert.rejects(run("scrub", {}), (e) => e.status === 409 && /сутки/.test(e.message));
    await run("scrub", { dryRun: true });
    const check = doc("meta/piiMigration").scrubCheck;
    assert.equal(check.state, "done");
    assert.equal(check.dryRun, true);
    assert.ok(check.removed.reservations >= 1);
    assert.equal(doc("reservations/r1").guestName, "Иван");
    assert.equal(doc("sessions/s1").customerName, "Пётр");
  });

  await test("очистка: убрано только сверенное, «кто сделал» — ссылки staff:<id>", async () => {
    clock += 25 * 3600 * 1000;
    await run("scrub", { by: "admin1" });
    const res = doc("meta/piiMigration").scrub;
    assert.equal(res.state, "done", res.error);
    const r1 = doc("reservations/r1");
    assert.ok(!("guestName" in r1) && !("phone" in r1));
    assert.equal(r1.handledBy, "staff:e1");
    assert.equal(r1.guestsCount, 2);
    const s1 = doc("sessions/s1");
    for (const f of ["customerName", "customerPhone", "deliveryAddress", "courierName", "employeeName"]) assert.ok(!(f in s1), f);
    assert.equal(s1.cancelledBy, `staff:${borisId}`);
    assert.equal(s1.totalWithDiscount, 900);
    const o1 = doc("guestOrders/o1");
    assert.ok(!("guestName" in o1));
    assert.equal(o1.doneBy, "auto");
    const a1 = doc("auditLog/a1");
    assert.equal(a1.employeeName, "staff:e1");
    assert.deepEqual(a1.details, { approvedBy: "staff:e2", qty: 1 });
    assert.ok(!("employeeName" in doc("tips/tp1")));
    assert.equal(doc("tips/tp2").employeeName, "Всей смене");
    assert.deepEqual(doc("tips/tp2").teamMembers, [{ id: "e1" }, { id: "e2" }]);
    assert.deepEqual(doc("meta/tipsTeam").members.e1, { position: "waiter" });
    const e1 = doc("employees/e1");
    assert.ok(!("name" in e1) && !("phone" in e1));
    assert.deepEqual(e1.payHistory, [{ at: 1, byId: "e1" }, { at: 2, byId: borisId }]);
    const g1 = doc("clients/g1");
    assert.ok(!("name" in g1) && !("phone" in g1));
    assert.equal(g1.phoneOnFile, true);
    assert.equal(g1.bonusBalance, 10);
    assert.ok(!store.has("tenants/t1/phoneIndex/79005556677"));
    // Чего нет в справочнике — остаётся и считается несверенным.
    assert.equal(doc("waitlist/w1").guestName, "Ольга");
    assert.equal(res.unverified.waitlist, 2);
  });

  await test("откат — в обычный режим; два шага разом не идут", async () => {
    const r = await run("rollback", { by: "admin1" });
    assert.equal(r.mode, "mirror");
    assert.equal(doc("meta/venueProfile").piiMode, "mirror");
    const first = await mig.run("t1", "copy", {});
    await assert.rejects(mig.run("t1", "copy", {}), (e) => e.status === 409);
    await first.done;
  });

  await test("без справочника на сервере — понятный отказ", async () => {
    const off = createPiiMigrate({ db: () => db, admin, pii: { enabled: () => false }, HttpError });
    await assert.rejects(off.run("t1", "copy", {}), (e) => e.status === 503);
    await assert.rejects(mig.run("../x", "copy", {}), (e) => e.status === 400);
  });

  console.log(`migrate: ${n} проверок`);
})().catch((e) => {
  console.error("MIGRATE TEST FAILED:", e);
  process.exit(1);
});
