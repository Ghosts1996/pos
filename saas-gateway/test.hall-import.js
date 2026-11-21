"use strict";
// Схема зала по фото (hall-import.js): ответ ИИ → столы, стены, подписи кассы
// без наложений; «Добавить», «Заменить» (столы с открытыми чеками остаются),
// «Отменить импорт»; права и понятные ошибки на /hallImport.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hallimp-"));
const PORT = 8089;
Object.assign(process.env, {
  PORT: String(PORT), DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0", GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "hallimport-secret-key-0123456789ab",
});
const assert = require("assert/strict");
const server = require("./server.js");
const admin = require("firebase-admin");
const { createHallImport, planFromAi, sanitizePlan, offset, overlaps, CANVAS } = require("./hall-import");
const store = server.localDataStore();
const doc = (p) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop());

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const lib = createHallImport({
  db: () => store, admin, verifyAuth: async () => ({ uid: "u1" }), parseJsonBody: async () => ({}), sendJson: () => {}, HttpError,
  requireTenantRole: async () => {}, aiVendor: async () => ({ id: "fake" }), extractJson: (t) => JSON.parse(t), limiter: new Map(),
  aiComplete: async () => JSON.stringify(AI_ANSWER),
});

// Ответ ИИ: зал 4×2 стола близко друг к другу, барная стойка, контур, вход;
// веранда с одним круглым столом; два стола в одной точке.
const AI_ANSWER = { zones: [
  { name: "", walls: [{ points: [[50, 50], [950, 50], [950, 950], [50, 950]], closed: true }],
    tables: [
      ...[0, 1, 2, 3].flatMap((i) => [{ name: String(i + 1), seats: 4, shape: "rect", x: 150 + i * 100, y: 300 }, { name: String(i + 5), seats: 2, shape: "круглый", x: 150 + i * 100, y: 420 }]),
      { name: "Бар", shape: "bar", x: 700, y: 150, seats: 0 },
      { name: "", shape: "long", vertical: true, x: 850, y: 600 },
      { name: "", shape: "rect", x: 850, y: 600 },
    ],
    labels: [{ text: "Вход", x: 500, y: 940 }, { text: "<b>WC</b>", x: 900, y: 900 }] },
  { name: "Веранда", tables: [{ name: "В1", shape: "circle", x: 500, y: 500, seats: 6 }], walls: [], labels: [] },
] };

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("ответ ИИ → схема кассы: зоны, имена, формы, без наложений, в пределах площадки", () => {
  const plan = planFromAi(AI_ANSWER, 1.4);
  assert.equal(plan.zones.length, 2);
  const [main, ver] = plan.zones;
  assert.equal(main.name, "Зал 1", "без названия при нескольких зонах — по номеру");
  assert.equal(ver.name, "Веранда");
  assert.equal(main.tables.length, 11);
  const names = main.tables.map((t) => t.name);
  assert.ok(names.includes("Стол 1") && names.includes("Стол 8") && names.includes("Бар"), names.join(","));
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, "имена без повторов");
  assert.equal(main.tables.find((t) => t.name === "Стол 5").shape, "circle", "«круглый» → circle");
  const bar = main.tables.find((t) => t.name === "Бар");
  assert.equal(bar.shape, "bar");
  assert.equal(bar.seats, 6, "мест не указано — по форме");
  assert.equal(main.tables.find((t) => t.shape === "long").rotation, 1, "вертикальный длинный стол повёрнут");
  const rects = main.tables.map((t) => offset(t));
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    assert.ok(r.left >= 0 && r.top >= 0 && r.left + r.w <= CANVAS.w && r.top + r.h <= CANVAS.h, "внутри площадки");
    for (let j = i + 1; j < rects.length; j++) assert.ok(!overlaps(r, rects[j]), `столы ${main.tables[i].name} и ${main.tables[j].name} наезжают`);
  }
  assert.ok(main.moved >= 1, "стол в той же точке сдвинут на свободное место");
  assert.equal(main.walls.length, 1);
  assert.ok(main.walls[0].closed && main.walls[0].points.length === 8);
  assert.equal(main.labels.find((l) => l.text.includes("WC")).text, "b WC /b", "теги в подписи не проходят");
  // Одна зона без названия — «Основной зал».
  assert.equal(planFromAi({ zones: [{ tables: [{ x: 10, y: 10 }] }] }).zones[0].name, "Основной зал");
});

test("план от кабинета — снова в рамки (лишние поля, мусор, границы)", () => {
  const p = sanitizePlan({ zones: [
    { name: "Зал", tables: [{ name: "Стол 1", shape: "hexagon", x: 99, y: -5, seats: 900, rotation: 7, evil: 1 }, { name: "Стол 1", x: 0.2, y: 0.2 }],
      walls: [{ points: [0, 0, 99999, 10, "x", 5] }, { points: [0, 0, 100, 0, 100, 100], closed: true }], labels: [{ text: "", x: 1, y: 1 }] },
    { name: "Зал", tables: [{ name: "дубль", x: 0, y: 0 }] },
  ] });
  assert.equal(p.zones.length, 1, "зона с тем же названием не дублируется");
  const [a, b] = p.zones[0].tables;
  assert.equal(a.shape, "rect");
  assert.equal(a.seats, 40);
  assert.equal(a.rotation, 3);
  assert.ok(a.x <= (CANVAS.w - 104) / (1000 - 104) && a.y === 0);
  assert.equal(a.evil, undefined);
  assert.equal(b.name, "Стол 1 (2)");
  assert.equal(p.zones[0].walls.length, 1, "стена с мусором отброшена");
  assert.equal(p.zones[0].labels.length, 0);
});

test("распознать → добавить → заменить (стол с открытым чеком остаётся) → отменить", async () => {
  const t = store.collection("tenants").doc("h1");
  await t.collection("tables").doc("takeaway").set({ name: "С собой", x: 0, y: 0, zone: "" });
  await t.collection("tables").doc("old1").set({ name: "Стол 1", x: 0, y: 0, zone: "Зал 1", activeSessionIds: [] });
  await t.collection("tables").doc("busy").set({ name: "Стол 2", x: 0.5, y: 0, zone: "Зал 1", activeSessionIds: ["s1"] });
  await t.collection("hallWalls").doc("w0").set({ zone: "Зал 1", points: [0, 0, 10, 10], closed: false });
  await t.collection("hallWalls").doc("w1").set({ zone: "Терраса", points: [0, 0, 10, 10], closed: false });

  const plan = await lib.recognize("h1", { page: { mediaType: "image/jpeg", data: "QUJD" }, aspect: 1.4 });
  assert.equal(plan.zones.length, 2);

  // Добавить: занятые названия получают номер, старое не трогается.
  let r = await lib.apply("h1", "u1", { plan, mode: "add" });
  assert.equal(r.tables, 12);
  let tables = (await t.collection("tables").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  assert.ok(tables.some((x) => x.zone === "Зал 1" && x.name === "Стол 1 (2)"), "дубль названия — с номером");
  assert.ok(tables.find((x) => x.id === "old1"), "старый стол на месте");
  const made = tables.find((x) => x.name === "В1");
  assert.equal(made.zone, "Веранда");
  assert.equal(made.status, "free");
  assert.deepEqual(made.activeSessionIds, []);
  assert.equal(made.maxOpenSessions, 2);

  // Заменить: вся схема новая (и терраса — старая зона без столов в плане); стол с чеком и «С собой» остаются.
  r = await lib.apply("h1", "u1", { plan, mode: "replace" });
  tables = (await t.collection("tables").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  assert.ok(tables.find((x) => x.id === "busy"), "стол с открытым чеком не удалён");
  assert.ok(tables.find((x) => x.id === "takeaway"), "«С собой» не тронут");
  assert.ok(!tables.find((x) => x.id === "old1"), "свободный старый стол заменён");
  assert.equal(tables.filter((x) => x.zone === "Зал 1" && x.name === "Стол 2").length, 1, "новый «Стол 2» не дублирует занятый");
  assert.equal(r.keptBusy, 1);
  assert.equal(r.skippedBusy, 1);
  const walls = (await t.collection("hallWalls").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  assert.ok(!walls.find((w) => w.id === "w0") && !walls.find((w) => w.id === "w1"), "прежние стены всех зон убраны");
  assert.ok(!tables.some((x) => x.name === "Стол 1 (2)"), "добавленное раньше тоже заменено");
  assert.equal(walls.filter((w) => w.zone === "Зал 1").length, 1);

  const st = await lib.status("h1");
  assert.equal(st.undo.mode, "replace");

  // Отменить: вернулась схема до замены (после «Добавить»).
  r = await lib.undo("h1");
  tables = (await t.collection("tables").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  assert.ok(tables.find((x) => x.id === "old1"), "старый стол вернулся");
  assert.ok(tables.some((x) => x.name === "Стол 1 (2)"), "добавленное до замены — на месте");
  assert.ok((await t.collection("hallWalls").doc("w0").get()).exists && (await t.collection("hallWalls").doc("w1").get()).exists, "старые стены вернулись");
  assert.equal((await lib.status("h1")).undo, null);
  await assert.rejects(() => lib.undo("h1"), (e) => e.status === 404);
});

test("ИИ не нашёл ни столов, ни стен — понятная ошибка; плохой снимок — 400", async () => {
  const empty = createHallImport({
    db: () => store, admin, verifyAuth: async () => ({}), parseJsonBody: async () => ({}), sendJson: () => {}, HttpError,
    requireTenantRole: async () => {}, aiVendor: async () => ({}), extractJson: (t) => JSON.parse(t), limiter: new Map(),
    aiComplete: async () => '{"zones":[]}',
  });
  await assert.rejects(() => empty.recognize("h2", { page: { mediaType: "image/png", data: "QUJD" } }), (e) => e.status === 422);
  await assert.rejects(() => lib.recognize("h2", { page: { mediaType: "image/gif", data: "QUJD" } }), (e) => e.status === 400);
  await assert.rejects(() => lib.recognize("h2", { page: { mediaType: "image/png", data: "<script>" } }), (e) => e.status === 400);
});

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

test("/hallImport: без входа — 401, чужое заведение — 403, без ключа ИИ — 412", async () => {
  const made = (await call("/auth/signup", null, { email: "owner@hall.test", password: "secret-123456" })).json;
  await server.ownAuth().adminAuth().updateUser(made.uid, { emailVerified: true });
  const me = (await call("/auth/login", null, { email: "owner@hall.test", password: "secret-123456" })).json;
  await doc("tenants/h3").set({ name: "Кафе", status: "active", ownerUserId: me.uid });
  await doc(`tenantMembers/h3_${me.uid}`).set({ tenantId: "h3", userId: me.uid, role: "owner", status: "active" });
  assert.equal((await call("/hallImport", null, { tenantId: "h3", action: "status" })).status, 401);
  const other = (await call("/auth/signup", null, { email: "other@hall.test", password: "secret-123456" })).json;
  assert.equal((await call("/hallImport", other.idToken, { tenantId: "h3", action: "status" })).status, 403);
  const st = await call("/hallImport", me.idToken, { tenantId: "h3", action: "status" });
  assert.equal(st.status, 200);
  assert.equal(st.json.undo, null);
  const ai = await call("/hallImport", me.idToken, { tenantId: "h3", action: "recognize", page: { mediaType: "image/jpeg", data: "QUJD" } });
  assert.equal(ai.status, 412, JSON.stringify(ai.json));
});

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  let ok = 0;
  for (const [name, fn] of tests) {
    try { await fn(); ok++; } catch (e) { console.error("FAIL", name, e); process.exitCode = 1; }
  }
  console.log(`hall-import: ${ok} из ${tests.length} проверок`);
  process.exit(process.exitCode || 0);
})();
