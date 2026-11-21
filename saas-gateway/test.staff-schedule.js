"use strict";
// График смен: кто не вышел через 15 минут после начала — один сигнал
// владельцу, без имени (имя — персональные данные, мессенджер за рубежом).
const assert = require("assert/strict");
const { overdue, startMinOf, createStaffSchedule } = require("./staff-schedule");
const { fakeDb } = require("./test-helpers");

const tz = "Europe/Moscow";
// 22.11.2026 10:20 по Москве = 07:20 UTC.
const now = Date.UTC(2026, 10, 22, 7, 20);
const msk = (h, m = 0) => Date.UTC(2026, 10, 22, h - 3, m);

assert.equal(startMinOf("10:00–22:00"), 600);
assert.equal(startMinOf("10–22"), 600);
assert.equal(startMinOf("9:30–18"), 570);
assert.equal(startMinOf("18:30-02:00"), 1110);
assert.equal(startMinOf("ерунда"), null);

let r = overdue({ shifts: { a: "10:00–22:00", b: "10:00–22:00", c: "10:15–22:00", d: "06:00–15:00" }, startedBy: { b: [msk(9, 55)] }, now, tz });
assert.equal(r.day, "2026-11-22");
assert.deepEqual(r.list.map((x) => x.emp), ["a"], "b пришёл, c ещё в запасе 15 минут, d опоздал больше чем на 3 часа");
r = overdue({ shifts: { a: "10:00–22:00" }, startedBy: {}, now, tz, alerted: { "2026-11-22_a": true } });
assert.equal(r.list.length, 0, "второй раз не пишем");

(async () => {
  const { db, store } = fakeDb();
  const sent = [];
  store.set("tenants/t1", { status: "active", name: "Колибри", timezone: tz });
  store.set("tenants/t1/staffSchedule/2026-11-22", { shifts: { a: "10–22" } });
  store.set("tenants/demo", { status: "active", name: "Демо", demo: true });
  store.set("tenants/demo/staffSchedule/2026-11-22", { shifts: { a: "10:00–22:00" } });
  const s = createStaffSchedule({ db: () => db, telegram: { ownerAlert: async (tid, text) => sent.push([tid, text]) } });
  assert.equal(await s.runAll(now), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "t1");
  assert.match(sent[0][1], /Колибри: сотрудник по графику со смены с 10:00 не отметил/);
  assert.equal(await s.runAll(now + 5 * 60000), 0, "один сигнал на смену");
  console.log("staff-schedule: ok");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
