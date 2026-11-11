"use strict";
// Службы доставки (delivery-services.js): ключи, цена, вызов, статусы,
// место курьера, отмена — для Яндекс Доставки и Достависты. Ответы служб
// подменяются (fetch), база — настоящая local-db.
const assert = require("assert/strict");
const crypto = require("crypto");
const { createLocalDb } = require("./local-db");
const { createDeliveryServices, splitAddress } = require("./delivery-services");
const { encrypt, decrypt } = require("./telegram");

let clock = Date.parse("2026-11-11T12:00:00Z");
class Timestamp {
  constructor(ms) { this._ms = ms; }
  toMillis() { return this._ms; }
  toDate() { return new Date(this._ms); }
  static now() { return new Timestamp(clock); }
  static fromMillis(ms) { return new Timestamp(ms); }
}
class FieldValue {
  constructor(methodName, operand) { this.methodName = methodName; this.operand = operand; }
  static delete() { return new FieldValue("FieldValue.delete"); }
  static increment(n) { return new FieldValue("FieldValue.increment", n); }
  static serverTimestamp() { return new FieldValue("FieldValue.serverTimestamp"); }
}
const admin = { firestore: { Timestamp, FieldValue } };
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const KEY = crypto.createHash("sha256").update("test").digest();

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function world() {
  clock = Date.parse("2026-11-11T12:00:00Z");
  const db = createLocalDb({ admin, now: () => clock });
  const calls = [];
  const events = [];
  const replies = []; // [re, status, body] — первое совпадение по адресу
  const fetchImpl = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method, headers: opts.headers, body });
    const r = replies.find(([re]) => re.test(url));
    if (!r) throw new Error(`нет ответа для ${url}`);
    const [, status, json] = r;
    return { ok: status < 400, status, json: async () => (typeof json === "function" ? json(body, url) : json) };
  };
  const roles = { t1_owner: "owner", t2_owner: "owner" };
  const api = createDeliveryServices({
    db: () => db, admin, HttpError,
    verifyAuth: async (req) => ({ uid: req.uid || "owner" }),
    parseJsonBody: async (req) => req.body || {},
    sendJson: (res, status, body) => { res.status = status; res.body = body; },
    requireTenantRole: async (t, uid) => { if (!roles[`${t}_${uid}`]) throw new HttpError(403, "нет прав"); },
    requireChainRole: async (c, uid) => { if (uid !== "owner") throw new HttpError(403, "нет прав в сети"); },
    encrypt, decrypt, secretKey: () => KEY, fetchImpl, now: () => clock,
    hooks: { event: async (t, s, text) => events.push(text) },
  });
  return { db, api, calls, events, replies, set: (p, d) => db.doc(p).set(d) };
}

async function seed(w) {
  await w.set("tenants/t1", { name: "Лето", chainId: "N", status: "active" });
  await w.set("tenants/t2", { name: "Север", chainId: "N", status: "active" });
  await w.set("tenants/t1/meta/venueProfile", { name: "Кафе «Лето»", address: "Москва, ул. Тверская, 7", phone: "8 (495) 123-45-67" });
  await w.set("tenants/t1/settings/delivery", { venuePos: { lat: 55.7579, lng: 37.6108 } });
  await w.set("tenants/t1/sessions/s1", {
    orderType: "delivery", orderNo: 12, status: "active", deliveryStatus: "cooking", deliveryOpen: true,
    customerName: "Анна", customerPhone: "79001234567", deliveryAddress: "Москва, ул. Арбат, 24, кв. 7, подъезд 1, этаж 3, домофон 7К",
    deliveryComment: "Позвоните", deliveryGeo: { lat: 55.7502, lng: 37.5926 },
    orderItems: [{ menuItemId: "soup", name: "Том ям", price: 600, qty: 2 }, { menuItemId: "zalpos_delivery", name: "Доставка", price: 150, qty: 1 }],
    guestPaidTotal: 1350,
  });
}

const call = async (fn, body, extra = {}) => { const res = {}; await fn({ body, headers: {}, ...extra }, res); return res; };
const session = async (w, id = "s1") => (await w.db.doc(`tenants/t1/sessions/${id}`).get()).data();

test("адрес гостя: улица отдельно от квартиры, подъезда, этажа и домофона", () => {
  assert.deepEqual(splitAddress("Москва, ул. Арбат, 24, кв. 7, подъезд 1, этаж 3, домофон 7К"),
    { street: "Москва, ул. Арбат, 24", flat: "7", porch: "1", floor: "3", door: "7К" });
  assert.deepEqual(splitAddress("ул. Ленина, 5, кв./офис 12"), { street: "ул. Ленина, 5", flat: "12", porch: "", floor: "", door: "" });
});

test("ключ: проверяется у службы, хранится зашифрованным; ключ сети — для всех точек, ключ точки важнее", async () => {
  const w = world();
  await seed(w);
  w.replies.push([/claims\/search/, 401, { code: "unauthorized" }]);
  await assert.rejects(call(w.api.handleSave, { tenantId: "t1", provider: "yandex", token: "y0_badbadbadbadbadbad" }), (e) => e.status === 409 && /не приняла ключ/.test(e.message));
  w.replies.length = 0;
  w.replies.push([/claims\/search/, 200, { claims: [] }]);
  const ok = await call(w.api.handleSave, { tenantId: "t1", provider: "yandex", token: "y0_CHAINTOKEN_1234567890", forChain: true, taxiClass: "express" });
  assert.equal(ok.status, 200);
  const raw = (await w.db.doc("deliveryServices/c_N").get()).data();
  assert.ok(!JSON.stringify(raw).includes("CHAINTOKEN"), "ключа в открытом виде нет");
  assert.equal(raw.yandex.mask, "y0_C…7890");
  assert.equal((await w.api.credsOf("t2", "yandex")).token, "y0_CHAINTOKEN_1234567890", "точка сети берёт ключ сети");
  await call(w.api.handleSave, { tenantId: "t1", provider: "yandex", token: "y0_POINTTOKEN_1234567890" });
  assert.equal((await w.api.credsOf("t1", "yandex")).token, "y0_POINTTOKEN_1234567890", "ключ точки важнее");
  const view = (await call(w.api.handleGet, { tenantId: "t1" })).body;
  assert.equal(view.point.yandex.connected, true);
  assert.equal(view.chain.yandex.taxiClass, "express");
  assert.equal(view.point.dostavista.connected, false);
  await assert.rejects(call(w.api.handleGet, { tenantId: "t1" }, { uid: "stranger" }), (e) => e.status === 403);
});

test("Яндекс: цена, вызов (адреса, квартира, точка гостя), сам подтверждает, статусы и курьер на карте, доставлен", async () => {
  const w = world();
  await seed(w);
  w.replies.push([/claims\/search/, 200, {}]);
  await call(w.api.handleSave, { tenantId: "t1", provider: "yandex", token: "y0_POINTTOKEN_1234567890" });
  w.replies.push([/check-price/, 200, { price: "289.00", eta: 14, distance_meters: 2350 }]);
  const q = (await call(w.api.handleQuote, { tenantId: "t1", sessionId: "s1" })).body;
  assert.deepEqual(q.quotes.map((x) => [x.provider, x.price, x.etaMin]), [["yandex", 289, 14]]);
  assert.equal(q.unpaid, false);
  const cp = w.calls.find((c) => /check-price/.test(c.url));
  assert.deepEqual(cp.body.route_points[0].coordinates, [37.6108, 55.7579], "координаты — долгота, широта");
  assert.equal(cp.headers.Authorization, "Bearer y0_POINTTOKEN_1234567890");

  w.replies.push([/claims\/create/, 200, { id: "c".repeat(32), version: 1, status: "new" }]);
  const r = await call(w.api.handleCall, { tenantId: "t1", sessionId: "s1", provider: "yandex", quoted: 289 });
  assert.equal(r.status, 200);
  const create = w.calls.find((c) => /claims\/create/.test(c.url));
  assert.match(create.url, /request_id=[0-9a-f-]{36}/);
  const [src, dst] = create.body.route_points;
  assert.deepEqual([src.type, src.contact.phone, src.address.fullname], ["source", "+74951234567", "Москва, ул. Тверская, 7"]);
  assert.deepEqual([dst.type, dst.contact.name, dst.contact.phone, dst.address.fullname, dst.address.sflat, dst.address.porch, dst.address.sfloor, dst.address.door_code],
    ["destination", "Анна", "+79001234567", "Москва, ул. Арбат, 24", "7", "1", "3", "7К"]);
  assert.deepEqual(dst.address.coordinates, [37.5926, 55.7502]);
  assert.equal(create.body.items[0].cost_value, "1200.00", "стоимость — блюда, без строки доставки");
  let s = await session(w);
  assert.deepEqual([s.ext.provider, s.ext.step, s.extActive, s.courierSet], ["yandex", "estimating", true, true]);
  // Второй вызов не создаёт вторую заявку.
  await assert.rejects(call(w.api.handleCall, { tenantId: "t1", sessionId: "s1", provider: "yandex" }), (e) => e.status === 409);

  // Сторож: оценка готова, цена в пределах +20 % — подтверждаем сами.
  let status = { id: "c".repeat(32), status: "ready_for_approval", version: 2, pricing: { offer: { price: "320.00" } } };
  w.replies.unshift([/claims\/info/, 200, () => status]);
  w.replies.unshift([/claims\/accept/, 200, { id: "c".repeat(32), status: "accepted", version: 3 }]);
  await w.api.sweep();
  const acc = w.calls.find((c) => /claims\/accept/.test(c.url));
  assert.deepEqual(acc.body, { version: 2 });
  s = await session(w);
  assert.equal(s.ext.step, "search");

  // Курьер найден и едет — позиция на карте, событие в чат.
  status = { id: "c".repeat(32), status: "performer_found", version: 3, performer_info: { courier_name: "Иван", car_model: "Kia Rio", car_number: "А100РА77", car_color: "белый" } };
  w.replies.unshift([/performer-position/, 200, { position: { lat: 55.756, lon: 37.605, timestamp: clock / 1000 } }]);
  await w.api.sweep();
  s = await session(w);
  assert.deepEqual([s.courierStage, s.courierPos.lat, s.ext.courier.name, s.ext.courier.car], ["toVenue", 55.756, "Иван", "белый Kia Rio А100РА77"]);
  assert.match(w.events.join("\n"), /курьер Иван, белый Kia Rio А100РА77 — едет в заведение/);

  status = { ...status, status: "pickuped" };
  await w.api.sweep();
  s = await session(w);
  assert.deepEqual([s.deliveryStatus, s.courierStage], ["courier", "onWay"]);

  status = { ...status, status: "delivered_finish", pricing: { final_price: "318.00" } };
  await w.api.sweep();
  s = await session(w);
  assert.deepEqual([s.deliveryStatus, s.deliveryOpen, s.extActive, s.ext.price], ["done", false, false, 318]);
  const before = w.calls.length;
  await w.api.sweep();
  assert.equal(w.calls.length, before, "законченный вызов больше не опрашиваем");
});

test("Яндекс: цена выросла больше 20 % — ждём подтверждения заведения; отмена бесплатная и платная", async () => {
  const w = world();
  await seed(w);
  w.replies.push([/claims\/search/, 200, {}]);
  await call(w.api.handleSave, { tenantId: "t1", provider: "yandex", token: "y0_POINTTOKEN_1234567890" });
  w.replies.push([/claims\/create/, 200, { id: "d".repeat(32), version: 1, status: "new" }]);
  await call(w.api.handleCall, { tenantId: "t1", sessionId: "s1", provider: "yandex", quoted: 200 });
  let status = { status: "ready_for_approval", version: 2, pricing: { offer: { price: "400.00" } } };
  w.replies.unshift([/claims\/info/, 200, () => status]);
  await w.api.sweep();
  assert.equal(w.calls.some((c) => /claims\/accept/.test(c.url)), false, "дорого — сами не подтверждаем");
  let s = await session(w);
  assert.equal(s.ext.approveAsked, true);
  assert.match(w.events.join("\n"), /цена выросла до 400 ₽/);
  w.replies.unshift([/claims\/accept/, 200, {}]);
  await call(w.api.handleApprove, { tenantId: "t1", sessionId: "s1" });
  assert.equal(w.calls.filter((c) => /claims\/accept/.test(c.url)).length, 1);

  // Отмена: платная — сначала вопрос, потом с подтверждением.
  status = { status: "performer_found", version: 3 };
  w.replies.unshift([/performer-position/, 404, {}]);
  await w.api.sweep();
  w.replies.unshift([/cancel-info/, 200, { cancel_state: "paid" }]);
  w.replies.unshift([/claims\/cancel\?/, 200, { status: "cancelled_with_payment" }]);
  const ask = await call(w.api.handleCancel, { tenantId: "t1", sessionId: "s1" });
  assert.deepEqual([ask.body.ok, ask.body.paid], [false, true]);
  assert.equal(w.calls.some((c) => /claims\/cancel\?/.test(c.url)), false);
  await call(w.api.handleCancel, { tenantId: "t1", sessionId: "s1", confirmPaid: true });
  const cancel = w.calls.find((c) => /claims\/cancel\?/.test(c.url));
  assert.deepEqual(cancel.body, { cancel_state: "paid", version: 3 });
  s = await session(w);
  assert.deepEqual([s.ext.step, s.extActive, s.courierSet], ["cancelled", false, false], "заказ снова ждёт курьера");
});

test("вызов: неоплаченный заказ — только с «гость оплатит сам»; нет телефона заведения — понятная ошибка", async () => {
  const w = world();
  await seed(w);
  w.replies.push([/claims\/search/, 200, {}]);
  await call(w.api.handleSave, { tenantId: "t1", provider: "yandex", token: "y0_POINTTOKEN_1234567890" });
  await w.set("tenants/t1/sessions/s1", { ...(await session(w)), guestPaidTotal: 0 });
  await assert.rejects(call(w.api.handleCall, { tenantId: "t1", sessionId: "s1", provider: "yandex" }), (e) => e.status === 409 && /не оплачен/.test(e.message));
  w.replies.push([/claims\/create/, 200, { id: "e".repeat(32), version: 1, status: "new" }]);
  const ok = await call(w.api.handleCall, { tenantId: "t1", sessionId: "s1", provider: "yandex", unpaidOk: true });
  assert.equal(ok.body.ext.unpaidOk, true);
  await w.set("tenants/t1/meta/venueProfile", { name: "Кафе", address: "Москва, ул. Тверская, 7" });
  await assert.rejects(call(w.api.handleQuote, { tenantId: "t1", sessionId: "s1" }), (e) => e.status === 409 && /телефон заведения/.test(e.message));
  // Ошибка службы при создании — отметка «вызываем» снимается.
  await w.set("tenants/t1/meta/venueProfile", { name: "Кафе", address: "Москва, ул. Тверская, 7", phone: "+7 495 123-45-67" });
  await w.set("tenants/t1/sessions/s2", { ...(await session(w)), ext: null, extActive: false, courierSet: false, orderNo: 13, guestPaidTotal: 1350 });
  w.replies.unshift([/claims\/create/, 500, { message: "internal" }]);
  await assert.rejects(call(w.api.handleCall, { tenantId: "t1", sessionId: "s2", provider: "yandex" }), (e) => e.status === 502);
  const s2 = await session(w, "s2");
  assert.equal(s2.courierSet, false);
  assert.equal(s2.ext, undefined);
});

test("Достависта: цена, заказ, курьер забрал и на карте, доставлен", async () => {
  const w = world();
  await seed(w);
  w.replies.push([/orders\?limit=1/, 200, { is_successful: true, orders: [] }]);
  await call(w.api.handleSave, { tenantId: "t1", provider: "dostavista", token: "DVTOKEN0123456789ABCDEF" });
  w.replies.push([/calculate-order/, 200, { is_successful: true, order: { payment_amount: "350.00" } }]);
  const q = (await call(w.api.handleQuote, { tenantId: "t1", sessionId: "s1" })).body;
  assert.deepEqual(q.quotes.map((x) => [x.provider, x.price]), [["dostavista", 350]]);
  const calc = w.calls.find((c) => /calculate-order/.test(c.url));
  assert.equal(calc.headers["X-DV-Auth-Token"], "DVTOKEN0123456789ABCDEF");
  assert.equal(calc.body.points[1].address, "Москва, ул. Арбат, 24");
  assert.match(calc.body.points[1].note, /кв\.\/офис 7, подъезд 1, этаж 3, домофон 7К, Позвоните/);
  w.replies.push([/create-order/, 200, { is_successful: true, order: { order_id: 555, status: "new", payment_amount: "350.00", points: [{}, { tracking_url: "https://dostavista.ru/track/555" }] } }]);
  await call(w.api.handleCall, { tenantId: "t1", sessionId: "s1", provider: "dostavista", quoted: 350 });
  let s = await session(w);
  assert.deepEqual([s.ext.id, s.ext.track, s.ext.step], ["555", "https://dostavista.ru/track/555", "search"]);
  let order = { order_id: 555, status: "active", payment_amount: "350.00", points: [{}, {}] };
  w.replies.unshift([/orders\?order_id=555/, 200, () => ({ is_successful: true, orders: [order] })]);
  w.replies.unshift([/courier\?order_id=555/, 200, { is_successful: true, courier: { name: "Пётр", surname: "С.", latitude: "55.751", longitude: "37.600" } }]);
  await w.api.sweep();
  s = await session(w);
  assert.deepEqual([s.courierStage, s.courierPos.lng, s.ext.courier.name], ["toVenue", 37.6, "Пётр С."]);
  order = { ...order, points: [{ courier_visit_datetime: "2026-11-11T15:10:00+03:00" }, {}] };
  await w.api.sweep();
  s = await session(w);
  assert.deepEqual([s.deliveryStatus, s.courierStage], ["courier", "onWay"]);
  order = { ...order, status: "completed" };
  await w.api.sweep();
  s = await session(w);
  assert.deepEqual([s.deliveryStatus, s.extActive], ["done", false]);
  // Ошибка Достависты в ответе — понятный текст.
  w.replies.unshift([/calculate-order/, 200, { is_successful: false, errors: ["invalid_parameters"], parameter_errors: { points: ["address_not_found"] } }]);
  await w.set("tenants/t1/sessions/s3", { ...(await session(w)), ext: null, extActive: false, deliveryStatus: "cooking", deliveryOpen: true });
  const bad = (await call(w.api.handleQuote, { tenantId: "t1", sessionId: "s3" })).body;
  assert.match(bad.quotes[0].error, /Достависта: invalid_parameters, address_not_found/);
});

(async () => {
  let n = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      n++;
    } catch (e) {
      console.error("FAIL", name, e);
      process.exitCode = 1;
    }
  }
  console.log(`delivery-services: ${n} из ${tests.length} проверок`);
  process.exit();
})();
