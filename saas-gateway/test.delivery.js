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

const SELLER = { sellerName: "ООО «Лето»", sellerInn: "7707083893", sellerOgrn: "1027700132195", sellerAddress: "Москва, ул. Летняя, 1" };

function setup({ now = new Date("2026-10-09T15:00:00Z"), online = false, pii = undefined } = {}) {
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
    pii,
    now: () => now,
  });
  store.set("tenants/t1", { status: "active", timezone: "Europe/Moscow" });
  store.set("tenants/t1/clients/g1", { name: "Аня" });
  store.set("tenants/t1/meta/venueProfile", { deliveryEnabled: true, ...SELLER, workingHours: { 1: "14:00-06:00", 2: "14:00-06:00", 3: "14:00-06:00", 4: "14:00-06:00", 5: "14:00-06:00", 6: "12:00-06:00", 7: "12:00-02:00" } });
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
  // Первый заказ заведения — №1.
  assert.equal(s.orderNo, 1);
  assert.equal(res.body.orderNo, "1");
});

test("режим РФ: в Firestore нет имени, телефона, адреса и комментария — они в справочнике", async () => {
  const puts = [];
  const pii = { mode: async () => "rf", put: async (tenantId, items, asUid) => { puts.push({ tenantId, items, asUid }); } };
  const { api, store, recorded } = setup({ pii });
  const res = await call(api.handleCreate, order());
  assert.equal(res.status, 200);
  const sid = res.body.sessionId;
  assert.equal(recorded.length, 1, "имя, телефон и адрес — в РФ до заказа");
  assert.deepEqual(puts, [{ tenantId: "t1", asUid: "g1", items: [{ k: "delivery", id: sid, fields: { extra: { comment: "Позвоните за 10 минут", guestContact: "79001234567" } } }] }]);
  const s = store.get(`tenants/t1/sessions/${sid}`);
  for (const f of ["customerName", "customerPhone", "deliveryAddress", "deliveryComment", "guestContact"]) {
    assert.equal(f in s, false, `${f} нет в Firestore`);
  }
  const go = [...store.entries()].find(([k]) => k.startsWith("tenants/t1/guestOrders/"))[1];
  assert.equal(go.guestName, "");
  assert.ok(!go.tableName.includes("Аня"));
  // Справочник недоступен — заказа нет.
  const down = setup({ pii: { mode: async () => "rf", put: async () => { throw new Error("нет связи"); } } });
  await assert.rejects(call(down.api.handleCreate, order()), (e) => e.status === 503);
});

test("номера заказов идут подряд от счётчика заведения", async () => {
  const { api, store } = setup();
  store.set("tenants/t1/settings/orderCounter", { last: 41 });
  const res = await call(api.handleCreate, order());
  assert.equal(res.body.orderNo, "42");
  assert.equal(store.get(`tenants/t1/sessions/${res.body.sessionId}`).orderNo, 42);
  assert.equal(store.get("tenants/t1/settings/orderCounter").last, 42);
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
  store.set("tenants/t1/meta/venueProfile", { deliveryEnabled: false, ...SELLER });
  await assert.rejects(call(api.handleCreate, order()), (e) => e.status === 409);
  store.set("tenants/t1/meta/venueProfile", { deliveryEnabled: true });
  await assert.rejects(call(api.handleCreate, order()), (e) => e.status === 409 && /реквизиты продавца/.test(e.message), "без реквизитов продавца заказа нет");
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
  const { api, store } = setup();
  await assert.rejects(call(api.handleCreate, order(), { uid: "stranger" }), (e) => e.status === 403);
  store.set("tenants/t1", { ...store.get("tenants/t1"), guestAppOff: true });
  await assert.rejects(call(api.handleCreate, order()), (e) => e.status === 403, "приложение гостя не в тарифе");
  store.set("tenants/t1", { ...store.get("tenants/t1"), guestAppOff: false });
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

// ================= Цена доставки и «что доставляем» (delivery-pricing.js)
const pricing = require("./delivery-pricing");

test("цена: базовая, бесплатно от суммы, минимальный заказ, сколько до бесплатной", () => {
  const st = { fee: 150, freeFrom: 2000, minOrder: 700, etaMin: 50 };
  let q = pricing.quote(st, 1200);
  assert.equal(q.ok, true);
  assert.equal(q.fee, 150);
  assert.equal(q.toFree, 800);
  assert.equal(q.etaMin, 50);
  q = pricing.quote(st, 2000);
  assert.equal(q.fee, 0, "ровно «бесплатно от» — уже бесплатно");
  assert.equal(q.toFree, 0);
  q = pricing.quote(st, 650.4);
  assert.equal(q.ok, false);
  assert.equal(q.short, 50);
  assert.match(q.error, /Минимальный заказ на доставку — 700.₽: добавьте ещё на 50.₽/);
  q = pricing.quote({}, 100);
  assert.deepEqual([q.ok, q.fee, q.toFree, q.etaMin], [true, 0, 0, 60], "без настроек — бесплатно, 60 минут");
});

test("цена: районы — обязателен выбор, своё значение или базовое; старый клиент — базовая цена", () => {
  const st = { fee: 150, minOrder: 500, freeFrom: 3000, zones: [
    { id: "c", name: "Центр", fee: 100, minOrder: null, freeFrom: 1500 },
    { id: "n", name: "Северный", fee: 300, minOrder: 1000, etaMin: 90 },
  ] };
  assert.equal(pricing.quote(st, 1200).error, "Выберите район доставки");
  assert.match(pricing.quote(st, 1200, "x").error, /больше нет/);
  let q = pricing.quote(st, 1200, "c");
  assert.deepEqual([q.fee, q.minOrder, q.freeFrom, q.zone.name, q.toFree], [100, 500, 1500, "Центр", 300]);
  q = pricing.quote(st, 1600, "c");
  assert.equal(q.fee, 0);
  q = pricing.quote(st, 900, "n");
  assert.equal(q.ok, false, "у Северного минимальный заказ свой — 1000 ₽");
  q = pricing.quote(st, 1200, "n");
  assert.deepEqual([q.fee, q.etaMin, q.freeFrom], [300, 90, 3000]);
  q = pricing.quote(st, 1200, "", { legacy: true });
  assert.deepEqual([q.ok, q.fee, q.zone], [true, 150, null]);
});

test("настройки: мусор отбрасывается, ошибки ввода — понятным текстом", () => {
  const s = pricing.normalizeSettings({ fee: "149.6", freeFrom: -5, etaMin: 3, zones: [{ name: "  Центр<script> " }, { name: "" }, { id: "bad id!", name: "Юг", fee: "" }], payAtDoor: { card: true } });
  assert.equal(s.fee, 150);
  assert.equal(s.freeFrom, 0);
  assert.equal(s.etaMin, 10);
  assert.deepEqual(s.zones.map((z) => [z.id, z.name, z.fee]), [["z1", "Центр script", null], ["z3", "Юг", null]]);
  assert.deepEqual(s.payAtDoor, { cash: true, card: true, qr: true });
  assert.equal(s.liveInTelegram, false, "координаты курьера в Telegram — только по явному выбору");
  assert.equal(pricing.settingsProblem({ fee: -1 }), "Стоимость доставки — от 0 до 100 000 ₽");
  assert.equal(pricing.settingsProblem({ etaMin: 5 }), "Время доставки — от 10 до 600 минут");
  assert.equal(pricing.settingsProblem({ zones: [{ name: "А" }, { name: "а" }] }), "Район «а» указан дважды");
  assert.equal(pricing.settingsProblem({ zones: [{ name: "" }] }), "У каждого района должно быть название");
  assert.equal(pricing.settingsProblem({ fee: 100, zones: [{ name: "Центр", fee: null }] }), "");
});

test("строка «Доставка»: услуга без скидки, не уходит на кухню; бесплатная — без строки", () => {
  assert.deepEqual(pricing.feeLine(150, "Центр"), {
    menuItemId: "zalpos_delivery", name: "Доставка · Центр", price: 150, qty: 1,
    noPromo: true, kind: "kitchen", ready: 1, accepted: 1, served: 1, sent: 1,
  });
  assert.equal(pricing.feeLine(0), null);
  assert.equal(pricing.deliveryBlock({ name: "Суп" }, { deliveryOff: true }, false), "venue");
  assert.equal(pricing.deliveryBlock({ name: "Суп", deliveryOff: true }, {}, false), "venue");
  assert.equal(pricing.deliveryBlock({ name: "Табак" }, {}, true), "law");
  assert.equal(pricing.deliveryBlock({ name: "Суп" }, {}, false), "");
});

const feeSetup = (settings = { fee: 150, freeFrom: 3000, minOrder: 500 }) => {
  const env = setup();
  env.store.set("tenants/t1/settings/delivery", settings);
  return env;
};

test("заказ с ценой доставки: строка в чек — после подтверждения, сумма и время — сразу", async () => {
  const { api, store } = feeSetup();
  const res = await call(api.handleCreate, order({ delivery: { fee: 150 } }));
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.total, res.body.itemsTotal, res.body.deliveryFee, res.body.etaMin], [1730, 1580, 150, 60]);
  const sid = res.body.sessionId;
  let s = store.get(`tenants/t1/sessions/${sid}`);
  assert.deepEqual(s.orderItems, [], "до подтверждения чек пуст — касса и гость видят позиции заявки");
  assert.equal(s.deliveryFeePending, true);
  assert.equal(s.appTotal, 1730);
  assert.deepEqual(s.delivery, { fee: 150, subtotal: 1580, etaMin: 60 });
  assert.equal(await api.ensureFee("t1", sid), false, "«Новый» — строки ещё нет");
  // Касса подтвердила: позиции заявки встали в чек, статус «Принят».
  store.set(`tenants/t1/sessions/${sid}`, { ...s, deliveryStatus: "accepted", orderItems: [{ menuItemId: "tea", name: "Чай улун", price: 300, qty: 1 }] });
  assert.equal(await api.ensureFee("t1", sid), true);
  assert.equal(await api.ensureFee("t1", sid), false, "второй раз строку не добавляем");
  s = store.get(`tenants/t1/sessions/${sid}`);
  assert.deepEqual(s.orderItems.map((i) => [i.menuItemId, i.price]), [["tea", 300], ["zalpos_delivery", 150]]);
  assert.equal("deliveryFeePending" in s, false);
});

test("заказ: отменён до подтверждения — строки доставки нет; бесплатная доставка — без строки", async () => {
  const { api, store } = feeSetup();
  const sid = (await call(api.handleCreate, order({ delivery: { fee: 150 } }))).body.sessionId;
  store.set(`tenants/t1/sessions/${sid}`, { ...store.get(`tenants/t1/sessions/${sid}`), deliveryStatus: "cancelled" });
  assert.equal(await api.ensureFee("t1", sid), false);
  const s = store.get(`tenants/t1/sessions/${sid}`);
  assert.deepEqual(s.orderItems, []);
  assert.equal("deliveryFeePending" in s, false);
  const big = await call(api.handleCreate, order({ items: [{ menuItemId: "tea", qty: 10 }], delivery: { fee: 0 } }));
  assert.equal(big.body.deliveryFee, 0, "3000 ₽ и больше — бесплатно");
  assert.equal("deliveryFeePending" in store.get(`tenants/t1/sessions/${big.body.sessionId}`), false);
});

test("заказ: цена изменилась, пока гость оформлял, — отказ с новой ценой; минимальный заказ; район", async () => {
  const { api, store } = feeSetup();
  await assert.rejects(call(api.handleCreate, order({ delivery: { fee: 100 } })),
    (e) => e.status === 409 && /Цена доставки изменилась: теперь 150.₽/.test(e.message));
  await assert.rejects(call(api.handleCreate, order({ items: [{ menuItemId: "tea", qty: 1 }], delivery: { fee: 150 } })),
    (e) => e.status === 409 && /добавьте ещё на 200.₽/.test(e.message));
  store.set("tenants/t1/settings/delivery", { fee: 150, zones: [{ id: "c", name: "Центр", fee: 90 }] });
  await assert.rejects(call(api.handleCreate, order({ delivery: { fee: 90 } })), (e) => e.status === 409 && e.message === "Выберите район доставки");
  const res = await call(api.handleCreate, order({ delivery: { zoneId: "c", fee: 90 } }));
  assert.equal(res.status, 200);
  assert.deepEqual(store.get(`tenants/t1/sessions/${res.body.sessionId}`).delivery, { fee: 90, subtotal: 1580, etaMin: 60, zoneId: "c", zoneName: "Центр" });
});

test("заказ старой версией приложения: базовая цена и пометка «назовите цену при звонке»", async () => {
  const { api, store } = feeSetup({ fee: 150, zones: [{ id: "c", name: "Центр", fee: 90 }] });
  const res = await call(api.handleCreate, order());
  assert.equal(res.status, 200);
  assert.deepEqual(store.get(`tenants/t1/sessions/${res.body.sessionId}`).delivery, { fee: 150, subtotal: 1580, etaMin: 60, feeUnseen: true });
});

test("что доставляем: выключенные позиция и категория — отказ с названиями; самовывоз можно", async () => {
  const { api, store } = feeSetup({});
  store.set("tenants/t1/menuItems/tea", { ...store.get("tenants/t1/menuItems/tea"), deliveryOff: true });
  await assert.rejects(call(api.handleCreate, order({ delivery: { fee: 0 } })),
    (e) => e.status === 409 && e.message === "Эту позицию заведение не доставляет: «Чай улун» — уберите из корзины или выберите самовывоз");
  const pick = await call(api.handleCreate, order({ orderType: "takeaway" }));
  assert.equal(pick.status, 200, "с собой — можно");
  assert.equal("delivery" in store.get(`tenants/t1/sessions/${pick.body.sessionId}`), false);
  store.set("tenants/t1/menuItems/tea", { ...store.get("tenants/t1/menuItems/tea"), deliveryOff: false });
  store.set("tenants/t1/menuCategories/food", { name: "Горячее", deliveryOff: true });
  await assert.rejects(call(api.handleCreate, order({ delivery: { fee: 0 } }, { uid: "g1" })),
    (e) => e.status === 409 && /Эти позиции заведение не доставляет: «Том ям», «Чай улун»/.test(e.message));
});

test("условия доставки гостю: цены, районы, оплата при получении, что не доставляем (закон и выбор)", async () => {
  const { api, store } = feeSetup({ fee: 150, minOrder: 500, zones: [{ id: "c", name: "Центр", fee: 90 }], payAtDoor: { cash: false } });
  store.set("tenants/t1/menuItems/tea", { ...store.get("tenants/t1/menuItems/tea"), deliveryOff: true });
  const res = await call(api.handleInfo, { tenantId: "t1" });
  assert.deepEqual([res.body.fee, res.body.minOrder, res.body.zones.length, res.body.payAtDoor.cash], [150, 500, 1, false]);
  assert.deepEqual(res.body.off.sort(), ["beer", "hookah", "tea"]);
  await assert.rejects(call(api.handleInfo, { tenantId: "t1" }, { uid: "stranger" }), (e) => e.status === 403);
});

test("цена в веб-версии гостя считается так же, как на сервере (2000 случайных наборов)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "saas", "guest-web", "app", "app.js"), "utf8");
  const m = /function deliveryQuote\(info, subtotal, zoneId\) \{[\s\S]*?\n\}\n/.exec(src);
  assert.ok(m, "deliveryQuote есть в app.js");
  const webQuote = new Function(`${m[0]}; return deliveryQuote;`)();
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const maybe = (v) => (rnd(3) === 0 ? null : v);
  for (let i = 0; i < 2000; i++) {
    const zones = rnd(2) ? [] : Array.from({ length: 1 + rnd(3) }, (_, k) => ({
      id: `z${k}`, name: `Р${k}`, fee: maybe(rnd(400)), minOrder: maybe(rnd(3) * 500), freeFrom: maybe(rnd(4) * 1000), etaMin: maybe(30 + rnd(90)),
    }));
    const raw = { fee: rnd(400), freeFrom: rnd(3) * 1000, minOrder: rnd(3) * 400, etaMin: 30 + rnd(60), zones };
    const info = pricing.normalizeSettings(raw); // то, что гостю отдаёт /guestDeliveryInfo
    const sub = rnd(4000);
    const zid = zones.length ? `z${rnd(zones.length)}` : "";
    const a = pricing.quote(raw, sub, zid);
    const b = webQuote(info, sub, zid);
    assert.deepEqual([b.ok, b.fee, b.toFree, b.short, b.etaMin], [a.ok, a.fee, a.toFree, a.short, a.etaMin], `набор ${i}: ${JSON.stringify(raw)} сумма ${sub}`);
  }
  assert.equal(webQuote({ zones: [{ id: "a", name: "А" }] }, 100, "").needZone, true);
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
