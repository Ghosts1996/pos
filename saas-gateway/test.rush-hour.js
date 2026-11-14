"use strict";
// Режим «Час пик»: окно пт/сб 20:00–02:00 по поясам заведений, отложенные
// задачи и то, что деньги (продление подписок) не откладываются.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createRushHour, inRushWindow } = require("./rush-hour");

let passed = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(() => passed++, (e) => { console.error(`FAIL: ${name}\n${e.stack || e}`); process.exitCode = 1; });

// 2026-11-13 — пятница. Время задаём в UTC; Москва = UTC+3, Новосибирск = UTC+7.
const utc = (s) => Date.parse(`${s}Z`);

(async () => {
  await t("пятница 20:00 по Москве — час пик, 19:59 — нет", () => {
    assert.strictEqual(inRushWindow(utc("2026-11-13T17:00:00"), "Europe/Moscow"), true);
    assert.strictEqual(inRushWindow(utc("2026-11-13T16:59:00"), "Europe/Moscow"), false);
  });
  await t("ночь после пятницы до 02:00 — час пик, 02:00 — уже нет", () => {
    assert.strictEqual(inRushWindow(utc("2026-11-13T22:59:00"), "Europe/Moscow"), true); // сб 01:59
    assert.strictEqual(inRushWindow(utc("2026-11-13T23:00:00"), "Europe/Moscow"), false); // сб 02:00
  });
  await t("суббота вечер и ночь на воскресенье — час пик; воскресенье вечер — нет", () => {
    assert.strictEqual(inRushWindow(utc("2026-11-14T18:30:00"), "Europe/Moscow"), true); // сб 21:30
    assert.strictEqual(inRushWindow(utc("2026-11-14T22:30:00"), "Europe/Moscow"), true); // вс 01:30
    assert.strictEqual(inRushWindow(utc("2026-11-15T18:30:00"), "Europe/Moscow"), false); // вс 21:30
  });
  await t("четверг вечер — не час пик", () => {
    assert.strictEqual(inRushWindow(utc("2026-11-12T19:00:00"), "Europe/Moscow"), false); // чт 22:00
  });
  await t("пояса заведений: в Новосибирске уже пятница 20:00, в Москве 16:00 — час пик", async () => {
    const rh = createRushHour({ listTimezones: async () => ["Asia/Novosibirsk"], env: {}, log: () => {} });
    await rh.refresh(utc("2026-11-13T13:00:00"));
    assert.strictEqual(rh.isRush(utc("2026-11-13T13:00:00")), true);
    const onlyMsk = createRushHour({ listTimezones: async () => [], env: {}, log: () => {} });
    await onlyMsk.refresh(utc("2026-11-13T13:00:00"));
    assert.strictEqual(onlyMsk.isRush(utc("2026-11-13T13:00:00")), false);
  });
  await t("неизвестный пояс из настроек отбрасывается, не ломая расчёт", async () => {
    const rh = createRushHour({ listTimezones: async () => ["Mars/Base", "Europe/Moscow"], env: {}, log: () => {} });
    await rh.refresh(utc("2026-11-13T10:00:00"));
    assert.deepStrictEqual(rh.status(utc("2026-11-13T10:00:00")).timezones, ["Europe/Moscow"]);
  });
  await t("задача откладывается в час пик, запись в журнал — один раз; после окна — сообщение и очистка", async () => {
    const logs = [];
    const rh = createRushHour({ env: {}, log: (m) => logs.push(m) });
    assert.strictEqual(rh.shouldDefer("menuPopularity", utc("2026-11-13T18:00:00")), true);
    assert.strictEqual(rh.shouldDefer("menuPopularity", utc("2026-11-13T19:00:00")), true);
    assert.strictEqual(logs.filter((m) => m.includes("menuPopularity")).length, 1);
    assert.deepStrictEqual(rh.status(utc("2026-11-13T19:00:00")).deferred, ["menuPopularity"]);
    assert.strictEqual(rh.shouldDefer("menuPopularity", utc("2026-11-14T10:00:00")), false);
    assert.ok(logs.some((m) => m.includes("закончился")));
    assert.deepStrictEqual(rh.status(utc("2026-11-14T10:00:00")).deferred, []);
  });
  await t("RUSH_HOUR=off и RUSH_HOUR=on", () => {
    assert.strictEqual(createRushHour({ env: { RUSH_HOUR: "off" } }).isRush(utc("2026-11-13T18:00:00")), false);
    assert.strictEqual(createRushHour({ env: { RUSH_HOUR: "on" } }).isRush(utc("2026-11-11T08:00:00")), true);
  });
  await t("сервер: продление подписок не откладывается, остальные задачи — да; статус в боте", () => {
    const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.ok(/RUSH_ESSENTIAL_JOBS = new Set\(\["billing"\]\)/.test(src), "billing — обязательная");
    assert.ok(/rushHour\.shouldDefer\(name\)/.test(src), "scheduleDailyJob спрашивает час пик");
    assert.ok(/rushHour\.shouldDefer\("backup"\)/.test(src), "резервная копия ждёт");
    assert.ok(/Час пик/.test(src), "строка в «🖥 Сервер»");
  });
  console.log(`rush-hour: ${passed} проверок`);
})();
