"use strict";
// Фудкост-сторож и заявка на закупку (foodcost.js): себестоимость как в
// кассе (брутто с отходом / порции рецепта × цена за кг/л/шт), сигнал о
// подорожании с причиной — один раз, заявка по расходу и минимуму.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcost-"));
const PORT = 8092;
Object.assign(process.env, {
  PORT: String(PORT), DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0", GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "foodcost-secret-key-0123456789ab",
});
const assert = require("assert/strict");
const server = require("./server.js");
const admin = require("firebase-admin");
const fc = require("./foodcost");
const store = server.localDataStore();
const T = (ms) => admin.firestore.Timestamp.fromMillis(ms);
const doc = (p) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop());
const set = (p, d) => doc(p).set(d);
const DAY = 86400000;

function call(p, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body || {}));
  });
}

const tests = [];
const test = (n, f) => tests.push([n, f]);
const stock = {
  beef: { name: "Говядина", unit: "kg", costPrice: 600, quantity: 2, minQuantity: 0 },
  beet: { name: "Свёкла", unit: "g", costPrice: 50, quantity: 5000, minQuantity: 1000 },
  milk: { name: "Молоко", unit: "l", costPrice: 90, quantity: 0.5, minQuantity: 1 },
  cup: { name: "Стакан", unit: "pcs", costPrice: 4, quantity: 30, minQuantity: 0 },
};
const menu = {
  borsch: { name: "Борщ", price: 400, recipePortions: 10, components: [
    { inventoryItemId: "beef", weight: 2, weightUnit: "kg", lossPercent: 20 }, // брутто 2,5 кг на 10 порций
    { inventoryItemId: "beet", weight: 1500, weightUnit: "g" },
  ] },
  latte: { name: "Латте", price: 200, components: [{ inventoryItemId: "milk", weight: 200, weightUnit: "ml" }, { inventoryItemId: "cup", weight: 1, weightUnit: "pcs" }] },
  cola: { name: "Кола", price: 150, inventoryItemId: "cup", weight: 1, weightUnit: "pcs" },
  tea: { name: "Чай", price: 100 },
};

test("себестоимость порции — как в кассе", () => {
  const b = fc.portionCost(menu.borsch, stock);
  // говядина 2,5 кг × 600 / 10 = 150 ₽; свёкла 1,5 кг × 50 / 10 = 7,5 ₽
  assert.equal(Math.round(b.cost * 100) / 100, 157.5);
  assert.equal(Math.round(fc.portionCost(menu.latte, stock).cost * 100) / 100, 22);
  assert.equal(fc.portionCost(menu.tea, stock), null, "без техкарты — не считаем");
  assert.equal(fc.portionCost(menu.borsch, { ...stock, beet: { ...stock.beet, costPrice: 0 } }), null, "нет цены продукта — не считаем");
  const list = fc.menuCosts(menu, stock);
  assert.equal(list[0].name, "Борщ");
  assert.equal(list[0].pct, 39.4);
});

test("сигнал: подорожало и выше порога — с причиной; не подорожало — тишина", () => {
  const prev = { dishes: { borsch: { cost: 120, pct: 30 }, latte: { cost: 22, pct: 11 } }, prices: { beef: 450, beet: 50 } };
  const a = fc.costAlerts(fc.menuCosts(menu, stock), prev, stock, { threshold: 35 });
  assert.equal(a.length, 1);
  assert.equal(a[0].reason.name, "Говядина");
  const text = fc.alertText(a, { venue: "Кафе" });
  assert.match(text, /Борщ: 30% → 39,4%/);
  assert.match(text, /подорожал продукт «Говядина»: 450 ₽ → 600 ₽ за кг/);
  assert.equal(fc.costAlerts(fc.menuCosts(menu, stock), { dishes: { borsch: { cost: 157.5, pct: 39.4 } }, prices: {} }, stock).length, 0);
});

test("заявка на закупку: расход за 14 дней и минимум", () => {
  const used = { beef: 14, beet: 2800, milk: 7 }; // 1 кг/день, 200 г/день, 0,5 л/день
  const list = fc.purchaseList(stock, used, { coverDays: 3 });
  const by = Object.fromEntries(list.map((x) => [x.id, x]));
  assert.equal(by.beef.order, 1, "нужно 3 кг, есть 2 → 1 кг");
  assert.equal(by.milk.order, 1, "нужно max(1,5; 1) = 1,5 л, есть 0,5 → 1 л");
  assert.ok(!by.beet, "свёклы 5 кг хватает (нужно 1 кг минимум)");
  assert.ok(!by.cup, "стаканы без расхода и минимума — не заказываем");
  assert.match(fc.orderText(list, { venue: "Кафе" }), /Говядина — 1 кг/);
});

test("кабинет: сводка и настройки; сторож шлёт один раз; чужому — 403", async () => {
  const sign = async (email) => (await call("/auth/signup", null, { email, password: "secret-123456" })).json;
  const me = await sign("owner-fc@test.ru");
  const other = await sign("other-fc@test.ru");
  await set("tenants/f1", { name: "Кафе", status: "active", ownerUserId: me.uid, timezone: "Europe/Moscow" });
  await set(`tenantMembers/f1_${me.uid}`, { tenantId: "f1", userId: me.uid, role: "owner", status: "active" });
  for (const [id, x] of Object.entries(stock)) await set(`tenants/f1/inventoryItems/${id}`, { ...x, costPrice: id === "beef" ? 450 : x.costPrice });
  for (const [id, x] of Object.entries(menu)) await set(`tenants/f1/menuItems/${id}`, x);
  await set("tenants/f1/inventoryMovements/m1", { itemId: "beef", type: "writeoff", delta: -14, createdAt: T(Date.now() - 2 * DAY) });
  await set("tenants/f1/inventoryMovements/m2", { itemId: "beef", type: "receipt", delta: 50, createdAt: T(Date.now() - DAY) });

  let r = await call("/foodcost", me.idToken, { tenantId: "f1" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.dishes.length, 3);
  assert.ok(r.json.order.some((x) => x.id === "beef"), "говядина в заявке (приход не считается расходом)");
  r = await call("/foodcost", me.idToken, { tenantId: "f1", action: "settings", settings: { threshold: 35, coverDays: 5, orderDaily: true, orderHour: 16 } });
  assert.equal(r.json.settings.coverDays, 5);
  assert.equal(r.json.settings.orderDaily, true);
  assert.equal((await call("/foodcost", other.idToken, { tenantId: "f1" })).status, 403);

  const sent = [];
  const mod = fc.createFoodcost({ db: () => store, admin, verifyAuth: null, parseJsonBody: null, sendJson: null, HttpError: Error, requireTenantRole: null,
    ownerAlert: async (tid, text) => { sent.push(text); return true; } });
  assert.equal(await mod.checkTenant("f1", { venue: "Кафе" }), 0, "первая проверка только запоминает");
  await doc("tenants/f1/inventoryItems/beef").set({ costPrice: 600 }, { merge: true });
  assert.equal(await mod.checkTenant("f1", { venue: "Кафе" }), 1);
  assert.match(sent[0], /подорожал продукт «Говядина»/);
  assert.equal(await mod.checkTenant("f1", { venue: "Кафе" }), 0, "повторно о том же — нет");
});

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  let ok = 0;
  for (const [name, fn] of tests) {
    try { await fn(); ok++; } catch (e) { console.error("FAIL", name, e); process.exitCode = 1; }
  }
  console.log(`foodcost: ${ok} из ${tests.length} проверок`);
  process.exit(process.exitCode || 0);
})();
