"use strict";
// Заказ доставки/с собой из приложения гостя (guest-delivery.js): что
// можно продавать навынос, часы работы, цены из меню, лимиты, ПДн — в РФ
// раньше заказа, отмена гостем.
const assert = require("assert/strict");
const gd = require("./guest-delivery");
const { fakeDb, admin, HttpError } = require("./test-helpers");

let n = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function setup({ now = new Date("2026-10-09T15:00:00Z"), online = false } = {}) {
  const { db, store } = fakeDb();
  const recorded = [];
  const api = gd.createGuestDelivery({
    db: () => db, admin, HttpError,
    verifyAuth: async (req) => ({ uid: req.uid || "g1" }),
    parseJsonBody: async (req) => req.body,
    sendJson: (res, status, body) => { res.status = status; res.body = body; },
    recordContact: async (req, payload) => {
      if (req.piiDown) throw new HttpError(503, "РФ недоступен");
      recorded.push(payload);
    },
    onlinePayReady: async () => online,
    now: () => now,
  });
  store.set("tenants/t1", { status: "active", timezone: "Europe/Moscow" });
  store.set("tenants/t1/clients/g1", { name: "Аня" });
  store.set("tenants/t1/meta/venueProfile", { deliveryEnabled: true, workingHours: { 1: "14:00-06:00", 2: "14:00-06:00", 3: "14:00-06:00", 4: "14:00-06:00", 5: "14:00-06:00", 6: "12:00-06:00", 7: "12:00-02:00" } });
  store.set("tenants/t1/menuCategories/food", { name: "Горячее" });
  store.set("tenants/t1/menuCategories/bar", { name: "Пиво и сидр" });
  store.set("tenants/t1/menuCategories/hookah", { name: "Кальяны" });
  store.set("tenants/t1/menuItems/soup", { name: "Том ям", price: 590, categoryId: "food",
    modifierGroups: [{ name: "Острота", min: 1, max: 1, options: [{ name: "Средне", price: 0 }, { name: "Огонь", price: 50 }] }] });
  store.set("tenants/t1/menuItems/tea", { name: "Чай улун", price: 300, categoryId: "food" });
  store.set("tenants/t1/menuItems/beer", { name: "Пиво светлое", price: 350, categoryId: "bar" });
  store.set("tenants/t1/menuItems/hookah", { name: "Классика", price: 1500, categoryId: "hookah" });
  store.set("tenants/t1/menuItems/off", { name: "Сезонный суп", price: 400, categoryId: "food", available: false });
  return { api, store, recorded };
}

const order = (over = {}) => ({
  tenantId: "t1",
  orderType: "delivery",
  name: "Аня",
  phone: "8 (900) 123-45-67",
  address: { street: "ул. Ленина, 5", flat: "12", entrance: "2", floor: "3", intercom: "12К" },
  comment: "Позвоните за 10 минут",
  payMethod: "on_receipt",
  items: [{ menuItemId: "soup", qty: 2, mods: ["Огонь"] }, { menuItemId: "tea", qty: 1 }],
  ...over,
});

const call = async (fn, body, extra = {}) => {
  const res = {};
  await fn({ body, ...extra }, res);
  return res;
};

test("навынос нельзя: табак и кальяны, алкоголь и подакцизное; можно безалкогольное", () => {
  assert.equal(gd.remoteSaleBanned({ name: "Классика" }, "Кальяны"), true);
  assert.equal(gd.remoteSaleBanned({ name: "Табак Darkside 25 г" }), true);
  assert.equal(gd.remoteSaleBanned({ name: "Пиво светлое" }), true);
  assert.equal(gd.remoteSaleBanned({ name: "Глинтвейн" }), false, "без явного алкоголя — по флагу");
  assert.equal(gd.remoteSaleBanned({ name: "Коктейль", fiscalSubject: "excise" }), true);
  assert.equal(gd.remoteSaleBanned({ name: "Пиво безалкогольное" }), false);
  assert.equal(gd.remoteSaleBanned({ name: "Говядина с вином" }, "Горячее"), false, "блюдо с вином — еда, не алкоголь");
  assert.equal(gd.remoteSaleBanned({ name: "Вино красное, бокал" }), true);
  assert.equal(gd.remoteSaleBanned({ name: "Винегрет" }, "Салаты"), false);
  assert.equal(gd.remoteSaleBanned({ name: "Ромашковый чай" }), false);
});

test("часы работы: ночь до 06:00 — ещё вчерашняя смена; выходной; часы не заданы", () => {
  const hours = { 1: "14:00-06:00", 2: "", 3: "10:00-22:00" };
  assert.equal(gd.openNow(hours, { wd: 1, h: 15, min: 0 }).open, true);
  assert.equal(gd.openNow(hours, { wd: 2, h: 3, min: 30 }).open, true, "вторник 03:30 — понедельничная ночь");
  assert.equal(gd.openNow(hours, { wd: 2, h: 7, min: 0 }).open, false, "вторник — выходной");
  assert.equal(gd.openNow(hours, { wd: 3, h: 9, min: 59 }).open, false);
  assert.equal(gd.openNow(hours, { wd: 3, h: 9, min: 59 }).today, "10:00–22:00");
  assert.equal(gd.openNow({}, { wd: 2, h: 4, min: 0 }).open, true);
});

test("телефон: любые записи → 7XXXXXXXXXX, мусор — пусто", () => {
  assert.equal(gd.normalizePhone("8 (900) 123-45-67"), "79001234567");
  assert.equal(gd.normalizePhone("+7 900 1234567"), "79001234567");
  assert.equal(gd.normalizePhone("9001234567"), "79001234567");
  assert.equal(gd.normalizePhone("999999998"), "");
  assert.equal(gd.normalizePhone("12345"), "");
});

test("заказ: цены из меню с добавками, ПДн сначала в РФ, чек/заказ/закрепление/стол", async () => {
  const { api, store, recorded } = setup();
  const res = await call(api.handleCreate, order());
  assert.equal(res.status, 200);
  const sid = res.body.sessionId;
  assert.equal(res.body.total, 2 * 640 + 300);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    tenantId: "t1", kind: "delivery", id: sid, name: "Аня", phone: "79001234567",
    address: "ул. Ленина, 5, кв./офис 12, подъезд 2, этаж 3, домофон 12К",
  });
  const s = store.get(`tenants/t1/sessions/${sid}`);
  assert.equal(s.source, "app");
  assert.equal(s.clientUid, "g1");
  assert.equal(s.deliveryStatus, "new");
  assert.equal(s.tableId, "takeaway");
  assert.deepEqual(s.orderItems, [], "позиции встанут в чек после подтверждения на кассе");
  assert.equal(s.customerPhone, "79001234567");
  const go = [...store.entries()].find(([k]) => k.startsWith("tenants/t1/guestOrders/"))[1];
  assert.equal(go.sessionId, sid);
  assert.equal(go.status, "new");
  assert.deepEqual(go.items[0], { menuItemId: "soup", name: "Том ям", price: 640, qty: 2, mods: ["Огонь"] });
  assert.equal(store.get(`tenants/t1/sessionClaims/${sid}`).uid, "g1");
  assert.deepEqual(store.get("tenants/t1/tables/takeaway").activeSessionIds, [sid]);
});

test("табак и пиво из корзины не проходят; только они — отказ", async () => {
  const { api } = setup();
  const res = await call(api.handleCreate, order({ items: [{ menuItemId: "tea", qty: 1 }, { menuItemId: "beer", qty: 1 }, { menuItemId: "hookah", qty: 1 }] }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.skipped.sort(), ["Классика", "Пиво светлое"].sort());
  assert.equal(res.body.total, 300);
  await assert.rejects(call(api.handleCreate, order({ items: [{ menuItemId: "hookah", qty: 1 }] })), (e) => e.status === 409 && /Табак/.test(e.message));
});

test("проверки: доставка выключена, ночь вне часов, нет адреса, плохой телефон, нет добавки, снято с продажи", async () => {
  let { api, store } = setup();
  store.set("tenants/t1/meta/venueProfile", { deliveryEnabled: false });
  await assert.rejects(call(api.handleCreate, order()), (e) => e.status === 409);
  ({ api } = setup({ now: new Date("2026-10-09T04:30:00Z") })); // пятница 07:30 по Москве
  await assert.rejects(call(api.handleCreate, order()), (e) => e.status === 409 && /закрыто/.test(e.message));
  ({ api } = setup());
  await assert.rejects(call(api.handleCreate, order({ address: { street: "" } })), (e) => e.status === 400);
  await assert.rejects(call(api.handleCreate, order({ phone: "999999998" })), (e) => e.status === 400);
  await assert.rejects(call(api.handleCreate, order({ items: [{ menuItemId: "soup", qty: 1 }] })), (e) => e.status === 409 && /Острота|острота/.test(e.message));
  await assert.rejects(call(api.handleCreate, order({ items: [{ menuItemId: "off", qty: 1 }] })), (e) => e.status === 409);
  const ok = await call(api.handleCreate, order({ orderType: "takeaway", address: {} }));
  assert.equal(ok.status, 200, "самовывоз без адреса — можно");
});

test("онлайн-оплата — только если банк подключён; ПДн не записались — заказа нет", async () => {
  let { api, store } = setup({ online: false });
  await assert.rejects(call(api.handleCreate, order({ payMethod: "online" })), (e) => e.status === 409);
  ({ api, store } = setup({ online: true }));
  assert.equal((await call(api.handleCreate, order({ payMethod: "online" }))).status, 200);
  ({ api, store } = setup());
  await assert.rejects(call(api.handleCreate, order(), { piiDown: true }), (e) => e.status === 503);
  assert.equal([...store.keys()].some((k) => k.startsWith("tenants/t1/sessions/")), false);
});

test("не гость заведения — нельзя; больше двух заказов в работе — нельзя", async () => {
  const { api } = setup();
  await assert.rejects(call(api.handleCreate, order(), { uid: "stranger" }), (e) => e.status === 403);
  await call(api.handleCreate, order());
  await call(api.handleCreate, order());
  await assert.rejects(call(api.handleCreate, order()), (e) => e.status === 429);
});

test("отмена гостем: пока «новый» и не оплачен; потом — только звонком", async () => {
  const { api, store } = setup();
  const sid = (await call(api.handleCreate, order())).body.sessionId;
  const res = await call(api.handleCancel, { tenantId: "t1", sessionId: sid });
  assert.equal(res.status, 200);
  const s = store.get(`tenants/t1/sessions/${sid}`);
  assert.equal(s.status, "cancelled");
  assert.equal(s.deliveryStatus, "cancelled");
  assert.deepEqual(store.get("tenants/t1/tables/takeaway").activeSessionIds, []);
  const go = [...store.entries()].find(([k]) => k.startsWith("tenants/t1/guestOrders/"))[1];
  assert.equal(go.status, "rejected");
  const sid2 = (await call(api.handleCreate, order())).body.sessionId;
  store.set(`tenants/t1/sessions/${sid2}`, { ...store.get(`tenants/t1/sessions/${sid2}`), deliveryStatus: "cooking" });
  await assert.rejects(call(api.handleCancel, { tenantId: "t1", sessionId: sid2 }), (e) => e.status === 409);
  await assert.rejects(call(api.handleCancel, { tenantId: "t1", sessionId: sid2 }, { uid: "other" }), (e) => e.status === 404);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      n++;
    } catch (e) {
      console.error("FAIL", name, e);
      process.exitCode = 1;
    }
  }
  console.log(`delivery: ${n} из ${tests.length} проверок`);
})();
