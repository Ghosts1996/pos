"use strict";
// Свободные курьеры (courier-free.js): регистрация и вход по паролю,
// проверка самозанятого, заявки в заведения, заказы без чужих наличных,
// заработок и выплаты, закрытие доступа, удаление учётки с актом.
const assert = require("assert/strict");
const { createLocalDb } = require("./local-db");
const cm = require("./courier");
const { innValid, createNpdCheck } = require("./npd-check");
const { freeSettings, hashPass, checkPass } = require("./courier-free");

let clock = Date.parse("2026-11-12T09:00:00Z");
const now = () => clock;
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

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** ИНН физлица с верными контрольными цифрами — из первых десяти. */
function inn12(first10) {
  const d = String(first10).split("").map(Number);
  const k = (w) => w.reduce((a, x, i) => a + x * d[i], 0) % 11 % 10;
  d.push(k([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]));
  d.push(k([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]));
  return d.join("");
}
const INN_A = inn12("7707123456");
const INN_B = inn12("5001987654");
const INN_C = inn12("7812555000");

const VENUE = { lat: 59.9358, lng: 30.3259 }; // Невский, 28
const NEAR = { lat: 59.9372, lng: 30.3301 }; // ~300 м
const FAR = { lat: 60.05, lng: 30.33 }; // ~12 км

function world() {
  clock = Date.parse("2026-11-12T09:00:00Z");
  const db = createLocalDb({ admin, now });
  const events = [];
  const fails = [];
  const mails = [];
  const acts = [];
  const npdAnswers = new Map(); // ИНН → true | false | null
  const members = { "A_owner": "owner", "B_owner": "owner", "N1_pointadmin": "admin" };
  const chainMembers = { "N_chainowner": "owner" };
  const npd = { check: async (inn) => ({ ok: npdAnswers.has(inn) ? npdAnswers.get(inn) : true, message: "ответ ФНС", at: clock }) };
  const guestPay = {
    courierPayStart: async () => ({ paymentId: "pay1", url: "https://qr.nspk.ru/AS1", amount: 750, status: "pending" }),
    courierPayStatus: async () => ({ status: "pending" }),
  };
  const api = cm.createCourier({
    db: () => db, admin, HttpError, now, pii: null, guestPay, npd,
    publicUrl: "https://pii.zalpos.ru/saas",
    verifyAuth: async (req) => ({ uid: req.uid }),
    parseJsonBody: async (req) => req.body || {},
    sendJson: (res, status, body) => { res.status = status; res.body = body; },
    requireTenantRole: async (t, uid, roles) => {
      if (!roles.includes(members[`${t}_${uid}`])) throw new HttpError(403, "Недостаточно прав в этом заведении");
    },
    requireChainRole: async (c, uid, roles) => {
      if (!roles.includes(chainMembers[`${c}_${uid}`])) throw new HttpError(403, "Недостаточно прав в этой сети");
    },
    authFailed: (req) => fails.push(req),
  });
  api.setHooks({
    event: async (t, s, text) => events.push({ t, s, text }),
    moved: async () => {},
    mailer: () => ({ send: async (m) => { mails.push(m); } }),
    papers: { destruction: async (items, opts) => { acts.push({ items, opts }); } },
  });
  const set = (p, d) => db.doc(p).set(d);
  return { db, api, events, fails, mails, acts, npdAnswers, set };
}

async function seed(w) {
  await w.set("tenants/A", { name: "Лето", timezone: "Europe/Moscow", status: "active", createdAt: Timestamp.fromMillis(1) });
  await w.set("tenants/A/meta/venueProfile", { address: "Санкт-Петербург, Невский, 28" });
  await w.set("tenants/B", { name: "Зима", timezone: "Europe/Moscow", status: "active", createdAt: Timestamp.fromMillis(1) });
  await w.set("tenants/N1", { name: "Сеть · Центр", chainId: "N", timezone: "Europe/Moscow", status: "active", createdAt: Timestamp.fromMillis(1) });
  await w.set("tenants/N2", { name: "Сеть · Север", chainId: "N", timezone: "Europe/Moscow", status: "active", createdAt: Timestamp.fromMillis(2) });
}

const order = (over = {}) => ({
  tableId: "takeaway", status: "active", orderType: "delivery", orderNo: 12, source: "app",
  deliveryStatus: "cooking", startTime: Timestamp.fromMillis(clock - 10 * 60000),
  deliveryAddress: "ул. Ленина, 5, кв./офис 12", customerPhone: "79001234567", customerName: "Аня",
  orderItems: [{ menuItemId: "soup", name: "Том ям", price: 600, qty: 1, ready: 1 }, { menuItemId: "zalpos_delivery", name: "Доставка", price: 150, qty: 1, noPromo: true, kind: "kitchen", ready: 1 }],
  delivery: { fee: 150, etaMin: 60 },
  guestPaidTotal: 750, // оплачен онлайн
  ...over,
});

const call = async (fn, body, extra = {}) => { const res = {}; await fn({ body, headers: { "x-real-ip": "203.0.113.5", ...(extra.headers || {}) }, uid: extra.uid }, res); return res; };
const asCourier = (token) => ({ headers: { authorization: `Bearer ${token}` } });
const F = (w) => w.api.free;

const REG = {
  name: "Иванов Пётр Сергеевич", phone: "8 911 000-00-01", email: "petr@example.ru", password: "Kurier-2026",
  taxStatus: "npd", inn: INN_A, transport: "bike", medBook: true, adult: true, rules: true, pd: true, device: "Android",
};

/** Зарегистрировать свободного курьера и дождаться ответа ФНС. */
async function register(w, over = {}) {
  const r = await call(F(w).handleRegister, { ...REG, ...over });
  assert.equal(r.status, 200);
  await new Promise((resolve) => setImmediate(resolve)); // фоновая проверка ФНС
  const doc = (await w.db.collection("couriers").where("phone", "==", cm.normalizePhone(over.phone || REG.phone)).get()).docs[0];
  return { token: r.body.token, no: r.body.courier.no, id: doc.id };
}

/** Заведение A включает свободных курьеров. */
async function openVenue(w, { tenantId = "A", uid = "owner", mode = "approved", ratePerTrip = 200, ratePerKm = 20, radiusKm = 5, delayMin = 0, pos = VENUE } = {}) {
  if (pos) assert.equal((await call(F(w).handleAdminPos, { tenantId, lat: pos.lat, lng: pos.lng }, { uid })).status, 200);
  const r = await call(F(w).handleAdminSave, { tenantId, on: true, mode, ratePerTrip, ratePerKm, radiusKm, delayMin, agree: true }, { uid });
  assert.equal(r.status, 200);
}

const ping = (w, token, pos) => call(w.api.handlePing, { points: [{ lat: pos.lat, lng: pos.lng, acc: 10, at: clock }] }, asCourier(token));
const state = async (w, token) => (await call(w.api.handleState, {}, asCourier(token))).body;
const act = (w, token, op, t, s, extra = {}) => call(w.api.handleAct, { op, t, s, ...extra }, asCourier(token));

/** Курьер принят заведением A, на линии и рядом. */
async function working(w, over = {}) {
  const c = await register(w, over);
  await call(F(w).handleApply, { root: "t_A" }, asCourier(c.token));
  await call(F(w).handleAdminDecide, { tenantId: "A", courierId: c.id, decision: "approve" }, { uid: "owner" });
  await call(w.api.handleShift, { on: true }, asCourier(c.token));
  await ping(w, c.token, NEAR);
  return c;
}

// ---------------------------------------------------------------- мелочи

test("ИНН: контрольные цифры; настройки по умолчанию; пароль хранится хэшем", async () => {
  assert.ok(innValid(INN_A) && innValid(INN_B));
  assert.ok(!innValid("123456789012") && !innValid("7707123456") && !innValid("000000000000") && !innValid(""));
  assert.deepEqual(freeSettings({}), { on: false, mode: "approved", radiusKm: 5, delayMin: 0, ratePerTrip: 0, ratePerKm: 0, agreedAt: null });
  assert.equal(freeSettings({ freeOn: true, free: { mode: "all", radiusKm: 99, delayMin: -5 } }).radiusKm, 30);
  const h = await hashPass("Kurier-2026");
  assert.ok(h.startsWith("s1$") && !h.includes("Kurier"));
  assert.ok(await checkPass("Kurier-2026", h));
  assert.ok(!(await checkPass("kurier-2026", h)) && !(await checkPass("x", "")));
});

test("проверка ФНС: самозанятый / нет / сервис молчит; неверный ИНН в ФНС не уходит; запросы по очереди", async () => {
  const sent = [];
  const answers = { [INN_A]: { status: 200, json: { status: true, message: "является плательщиком" } }, [INN_B]: { status: 200, json: { status: false, message: "не является" } } };
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push({ url, ...body });
    const a = answers[body.inn] || { status: 503, json: {} };
    return { ok: a.status === 200, status: a.status, json: async () => a.json };
  };
  let t = 1000000;
  const waits = [];
  const npd = createNpdCheck({ fetchFn, now: () => t, wait: async (ms) => { waits.push(ms); t += ms; } });
  assert.equal((await npd.check(INN_A)).ok, true);
  assert.equal((await npd.check(INN_B)).ok, false);
  assert.equal((await npd.check(INN_C)).ok, null, "сбой сервиса — не «нет»");
  assert.equal((await npd.check("123456789012")).ok, false);
  assert.equal(sent.length, 3, "неверный ИНН не отправлялся");
  assert.match(sent[0].url, /statusnpd\.nalog\.ru/);
  assert.match(sent[0].requestDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(waits.length === 2 && waits.every((ms) => ms > 30000), "между запросами — пауза: лимит ФНС 2 в минуту");
  await npd.check(INN_A);
  assert.equal(sent.length, 3, "ответ запомнен");
  await npd.check(INN_C);
  assert.equal(sent.length, 4, "сбой не запоминается");
  const [a, b] = await Promise.all([npd.check(INN_C, { fresh: true }), npd.check(INN_C, { fresh: true })]);
  assert.equal(sent.length, 5, "два одновременных запроса по одному ИНН — один поход в ФНС");
  assert.equal(a, b);
});

// ---------------------------------------------------------------- регистрация и вход

test("регистрация: проверки, номер с 1001, согласие с датой и адресом, ФНС в фоне", async () => {
  const w = world();
  await seed(w);
  const bad = async (over, re) => assert.rejects(call(F(w).handleRegister, { ...REG, ...over }), (e) => e.status === 400 && re.test(e.message), JSON.stringify(over));
  await bad({ name: "Пётр" }, /фамилию и имя/);
  await bad({ phone: "12345" }, /телефон/);
  await bad({ email: "нет" }, /почту/);
  await bad({ password: "1234567" }, /8 символов/);
  await bad({ password: "11111111" }, /простой/);
  await bad({ taxStatus: "worker" }, /статус/);
  await bad({ inn: "123456789012" }, /ИНН/);
  await bad({ transport: "rocket" }, /на чём/);
  await bad({ adult: false }, /18 лет/);
  await bad({ rules: false }, /условия/);
  await bad({ pd: false }, /согласие/);
  const c = await register(w);
  assert.equal(c.no, 1001);
  const doc = (await w.db.doc(`couriers/${c.id}`).get()).data();
  assert.equal(doc.root, "free");
  assert.equal(doc.phone, "79110000001");
  assert.ok(doc.passHash.startsWith("s1$") && !JSON.stringify(doc).includes("Kurier-2026"), "пароль — только хэш");
  assert.ok(doc.rulesAt && doc.pdAt && doc.pdIp === "203.0.113.5" && doc.consentAt, "согласие записано");
  assert.equal(doc.npd.ok, true, "ФНС ответила в фоне");
  await assert.rejects(call(F(w).handleRegister, { ...REG, inn: INN_B }), (e) => e.status === 409 && /телефоном/.test(e.message));
  await assert.rejects(call(F(w).handleRegister, { ...REG, phone: "+7 911 000-00-02" }), (e) => e.status === 409 && /ИНН/.test(e.message));
  const two = await register(w, { phone: "+7 911 000-00-02", inn: INN_B, email: "b@example.ru" });
  assert.equal(two.no, 1002);
  // Сразу в приложении: без экрана согласия, без заведений.
  const st = await state(w, c.token);
  assert.equal(st.me.free, true);
  assert.equal(st.me.consent, true);
  assert.deepEqual([st.me.links, st.me.pending, st.free.length], [0, 0, 0]);
});

test("регистраций с одного адреса — не больше 20 в час", async () => {
  const w = world();
  await seed(w);
  for (let i = 0; i < 8; i++) await assert.rejects(call(F(w).handleRegister, { ...REG, name: "x" }), (e) => e.status === 400, "опечатки лимит не тратят");
  assert.equal((await call(F(w).handleRegister, REG)).status, 200);
  for (let i = 0; i < 19; i++) await assert.rejects(call(F(w).handleRegister, REG), (e) => e.status === 409);
  await assert.rejects(call(F(w).handleRegister, { ...REG, phone: "+7 911 000-00-09", inn: INN_B }), (e) => e.status === 429);
  clock += 3601 * 1000;
  assert.equal((await call(F(w).handleRegister, { ...REG, phone: "+7 911 000-00-09", inn: INN_B })).status, 200);
});

test("вход по телефону и паролю: неверный — отказ и отметка щиту, новый вход выключает старый телефон, замок после 10 ошибок", async () => {
  const w = world();
  await seed(w);
  const c = await register(w);
  await assert.rejects(call(F(w).handleSignin, { phone: REG.phone, password: "не тот" }), (e) => e.status === 403 && /Неверный телефон или пароль/.test(e.message));
  await assert.rejects(call(F(w).handleSignin, { phone: "+7 999 999-99-99", password: REG.password }), (e) => e.status === 403 && /Неверный телефон или пароль/.test(e.message));
  assert.equal(w.fails.length, 2);
  const r = await call(F(w).handleSignin, { phone: "+7 (911) 000-00-01", password: REG.password, device: "iPhone" });
  assert.equal(r.body.courier.no, 1001);
  await assert.rejects(call(w.api.handleState, {}, asCourier(c.token)), (e) => e.status === 401, "старый телефон вышел");
  assert.equal((await state(w, r.body.token)).me.no, 1001);
  for (let i = 0; i < 10; i++) await assert.rejects(call(F(w).handleSignin, { phone: REG.phone, password: "мимо" }), (e) => e.status === 403);
  await assert.rejects(call(F(w).handleSignin, { phone: REG.phone, password: REG.password }), (e) => e.status === 429);
  clock += 16 * 60000;
  assert.equal((await call(F(w).handleSignin, { phone: REG.phone, password: REG.password })).status, 200);
});

test("забыли пароль: код на почту из учётки, 15 минут, 5 попыток; чужой телефон — тот же ответ", async () => {
  const w = world();
  await seed(w);
  await register(w);
  const none = await call(F(w).handleReset, { phone: "+7 999 111-22-33" });
  assert.equal(none.status, 200);
  assert.equal(w.mails.length, 0);
  const r = await call(F(w).handleReset, { phone: REG.phone });
  assert.deepEqual(r.body, none.body, "по ответу нельзя узнать, есть ли учётка");
  assert.equal(w.mails.length, 1);
  assert.equal(w.mails[0].to, "petr@example.ru");
  const code = /Код: (\d{6})/.exec(w.mails[0].text)[1];
  await assert.rejects(call(F(w).handleResetConfirm, { phone: REG.phone, code: "000000", password: "Novyi-parol-1" }), (e) => e.status === 403);
  await assert.rejects(call(F(w).handleResetConfirm, { phone: REG.phone, code, password: "123" }), (e) => e.status === 400);
  const ok = await call(F(w).handleResetConfirm, { phone: REG.phone, code, password: "Novyi-parol-1" });
  assert.ok(ok.body.token);
  await assert.rejects(call(F(w).handleSignin, { phone: REG.phone, password: REG.password }), (e) => e.status === 403, "старый пароль не подходит");
  assert.equal((await call(F(w).handleSignin, { phone: REG.phone, password: "Novyi-parol-1" })).status, 200);
  await assert.rejects(call(F(w).handleResetConfirm, { phone: REG.phone, code, password: "Eshe-odin-22" }), (e) => e.status === 403, "код одноразовый");
  // Просроченный и перебор.
  await call(F(w).handleReset, { phone: REG.phone });
  const code2 = /Код: (\d{6})/.exec(w.mails[1].text)[1];
  for (let i = 0; i < 5; i++) await assert.rejects(call(F(w).handleResetConfirm, { phone: REG.phone, code: "111111", password: "Eshe-odin-22" }), (e) => e.status === 403);
  await assert.rejects(call(F(w).handleResetConfirm, { phone: REG.phone, code: code2, password: "Eshe-odin-22" }), (e) => e.status === 403, "после 5 ошибок код сгорает");
  await call(F(w).handleReset, { phone: REG.phone });
  clock += 16 * 60000;
  const code3 = /Код: (\d{6})/.exec(w.mails[2].text)[1];
  await assert.rejects(call(F(w).handleResetConfirm, { phone: REG.phone, code: code3, password: "Eshe-odin-22" }), (e) => e.status === 403, "через 15 минут код не действует");
});

// ---------------------------------------------------------------- заведение

test("заведение включает свободных курьеров: нужны ставка, согласие с условиями и место на карте", async () => {
  const w = world();
  await seed(w);
  const base = { tenantId: "A", on: true, mode: "approved", ratePerTrip: 200, ratePerKm: 20, radiusKm: 5, delayMin: 0 };
  await assert.rejects(call(F(w).handleAdminSave, { ...base, ratePerTrip: 0, ratePerKm: 0, agree: true }, { uid: "owner" }), (e) => e.status === 400 && /сколько платите/.test(e.message));
  await assert.rejects(call(F(w).handleAdminSave, base, { uid: "owner" }), (e) => e.status === 400 && /условия/.test(e.message));
  await assert.rejects(call(F(w).handleAdminSave, { ...base, agree: true }, { uid: "owner" }), (e) => e.status === 409 && /место заведения/.test(e.message));
  await assert.rejects(call(F(w).handleAdminPos, { tenantId: "A", lat: 30.3259, lng: 59.9358 }, { uid: "owner" }), (e) => e.status === 400, "широта и долгота перепутаны");
  await assert.rejects(call(F(w).handleAdminSave, { ...base, agree: true }, { uid: "stranger" }), (e) => e.status === 403);
  await openVenue(w);
  const g = (await call(F(w).handleAdminGet, { tenantId: "A" }, { uid: "owner" })).body;
  assert.deepEqual(g.settings, { on: true, mode: "approved", radiusKm: 5, delayMin: 0, ratePerTrip: 200, ratePerKm: 20, agreed: true });
  assert.equal(g.link, "https://pii.zalpos.ru/saas/courier/#v=t_A");
  assert.deepEqual(g.points[0].pos, VENUE);
  // Второй раз согласие не спрашиваем; выключить можно без ставки.
  assert.equal((await call(F(w).handleAdminSave, { ...base, on: false, ratePerTrip: 0, ratePerKm: 0 }, { uid: "owner" })).status, 200);
  assert.equal((await call(F(w).handleAdminSave, base, { uid: "owner" })).status, 200);
  // Место, отмеченное в кабинете, заборы заказов курьерами не сдвигают.
  assert.equal((await w.db.doc("tenants/A/settings/delivery").get()).data().venuePosManual, true);
  // Сеть: администратор точки не включает, владелец сети — да.
  await assert.rejects(call(F(w).handleAdminSave, { ...base, tenantId: "N1", agree: true }, { uid: "pointadmin" }), (e) => e.status === 403 && /владелец сети/.test(e.message));
  await call(F(w).handleAdminPos, { tenantId: "N1", lat: VENUE.lat, lng: VENUE.lng }, { uid: "pointadmin" });
  assert.equal((await call(F(w).handleAdminSave, { ...base, tenantId: "N1", agree: true }, { uid: "chainowner" })).status, 200);
});

test("заведения рядом → «Хочу возить» → заявка → заведение одобряет; отклонённая — повтор через сутки", async () => {
  const w = world();
  await seed(w);
  await openVenue(w);
  const c = await register(w);
  await assert.rejects(call(F(w).handleNearby, {}, asCourier(c.token)), (e) => e.status === 400 && /геолокацию/.test(e.message));
  const far = (await call(F(w).handleNearby, { lat: 55.75, lng: 37.61 }, asCourier(c.token))).body;
  assert.equal(far.venues.length, 0, "Москва — не рядом с Петербургом");
  const near = (await call(F(w).handleNearby, NEAR, asCourier(c.token))).body.venues;
  assert.equal(near.length, 1);
  assert.deepEqual([near[0].root, near[0].title, near[0].ratePerTrip, near[0].ratePerKm, near[0].inRadius, near[0].st], ["t_A", "Лето", 200, 20, true, ""]);
  assert.ok(near[0].distM > 100 && near[0].distM < 600);
  assert.equal((await call(F(w).handleNearby, FAR, asCourier(c.token))).body.venues[0].inRadius, false);
  await assert.rejects(call(F(w).handleApply, { root: "t_B" }, asCourier(c.token)), (e) => e.status === 409, "B свободных не принимает");
  await assert.rejects(call(F(w).handleApply, { root: "../x" }, asCourier(c.token)), (e) => e.status === 400);
  assert.equal((await call(F(w).handleApply, { root: "t_A" }, asCourier(c.token))).body.st, "pending");
  assert.equal((await call(F(w).handleApply, { root: "t_A" }, asCourier(c.token))).body.st, "pending", "повторное нажатие — не ошибка");
  let g = (await call(F(w).handleAdminGet, { tenantId: "A" }, { uid: "owner" })).body;
  assert.equal(g.couriers.length, 1);
  const row = g.couriers[0];
  assert.deepEqual([row.no, row.name, row.phone, row.inn, row.st, row.tax.ok, row.transport, row.medBook], [1001, "Иванов Пётр Сергеевич", "79110000001", INN_A, "pending", true, "велосипед или самокат", true]);
  // Чужое заведение заявку не видит и решить не может.
  assert.equal((await call(F(w).handleAdminGet, { tenantId: "B" }, { uid: "owner" })).body.couriers.length, 0);
  await assert.rejects(call(F(w).handleAdminDecide, { tenantId: "B", courierId: c.id, decision: "approve" }, { uid: "owner" }), (e) => e.status === 404);
  await call(F(w).handleAdminDecide, { tenantId: "A", courierId: c.id, decision: "decline" }, { uid: "owner" });
  await assert.rejects(call(F(w).handleApply, { root: "t_A" }, asCourier(c.token)), (e) => e.status === 409 && /через сутки/.test(e.message));
  clock += 25 * 3600 * 1000;
  assert.equal((await call(F(w).handleApply, { root: "t_A" }, asCourier(c.token))).body.st, "pending");
  await call(F(w).handleAdminDecide, { tenantId: "A", courierId: c.id, decision: "approve" }, { uid: "owner" });
  await assert.rejects(call(F(w).handleAdminDecide, { tenantId: "A", courierId: c.id, decision: "approve" }, { uid: "owner" }), (e) => e.status === 409);
  const p = (await call(F(w).handleProfile, {}, asCourier(c.token))).body;
  assert.deepEqual(p.venues.map((v) => [v.root, v.st]), [["t_A", "approved"]]);
  assert.equal((await state(w, c.token)).me.links, 1);
  // По ссылке заведения из кабинета.
  const v = (await call(F(w).handleVenue, { root: "t_A" }, asCourier(c.token))).body.venue;
  assert.deepEqual([v.title, v.st], ["Лето", "approved"]);
  await assert.rejects(call(F(w).handleVenue, { root: "t_B" }, asCourier(c.token)), (e) => e.status === 404);
});

test("режим «все проверенные»: самозанятый с ответом ФНС принят сразу; пока ФНС молчит — ждёт и принимается сам; ИП — вручную", async () => {
  const w = world();
  await seed(w);
  await openVenue(w, { mode: "all" });
  const a = await register(w);
  assert.equal((await call(F(w).handleApply, { root: "t_A" }, asCourier(a.token))).body.st, "approved");
  w.npdAnswers.set(INN_B, null); // сервис ФНС не отвечает
  const b = await register(w, { phone: "+7 911 000-00-02", inn: INN_B, email: "b@example.ru" });
  assert.equal((await call(F(w).handleApply, { root: "t_A" }, asCourier(b.token))).body.st, "pending");
  w.npdAnswers.set(INN_B, true);
  await call(F(w).handleProfile, {}, asCourier(b.token)); // профиль перепроверяет
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  w.api.forgetCache();
  assert.equal((await call(F(w).handleProfile, {}, asCourier(b.token))).body.venues[0].st, "approved", "ФНС подтвердила — принят без заведения");
  const ip = await register(w, { phone: "+7 911 000-00-03", inn: INN_C, email: "c@example.ru", taxStatus: "ip" });
  assert.equal((await call(F(w).handleApply, { root: "t_A" }, asCourier(ip.token))).body.st, "pending", "ИП сами не проверяем — решает заведение");
});

test("ФНС ответила «не самозанятый» — на линию и в заведения нельзя; «Проверить ещё раз» снимает", async () => {
  const w = world();
  await seed(w);
  await openVenue(w);
  w.npdAnswers.set(INN_A, false);
  const c = await register(w);
  await assert.rejects(call(w.api.handleShift, { on: true }, asCourier(c.token)), (e) => e.status === 409 && /Мой налог/.test(e.message));
  await assert.rejects(call(F(w).handleApply, { root: "t_A" }, asCourier(c.token)), (e) => e.status === 409);
  assert.match((await state(w, c.token)).me.shiftProblem, /ФНС/);
  w.npdAnswers.set(INN_A, true);
  await call(F(w).handleRecheck, {}, asCourier(c.token));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await call(F(w).handleProfile, {}, asCourier(c.token))).body.tax.ok, true);
  assert.equal((await call(w.api.handleShift, { on: true }, asCourier(c.token))).status, 200);
});

// ---------------------------------------------------------------- заказы

test("заказы свободному курьеру: только на линии, рядом, после задержки, без чужих наличных; курьер заведения видит всё", async () => {
  const w = world();
  await seed(w);
  await openVenue(w, { delayMin: 15 });
  const own = (await call(w.api.handleAdminSave, { tenantId: "A", courier: { name: "Свой Курьер" } }, { uid: "owner" })).body;
  const inv = (await call(w.api.handleAdminInvite, { tenantId: "A", courierId: own.id }, { uid: "owner" })).body.url.split("#i=")[1];
  const ownToken = (await call(w.api.handleLogin, { invite: inv })).body.token;
  await call(w.api.handleConsent, {}, asCourier(ownToken));
  await call(w.api.handleShift, { on: true }, asCourier(ownToken));
  const c = await register(w);
  await call(F(w).handleApply, { root: "t_A" }, asCourier(c.token));
  await w.set("tenants/A/sessions/paid", order()); // 10 минут назад
  await w.set("tenants/A/sessions/cash", order({ guestPaidTotal: 0, orderNo: 13 }));
  await w.set("tenants/B/sessions/other", order());
  assert.equal((await state(w, ownToken)).free.length, 2, "курьер заведения видит оба");
  assert.equal((await state(w, c.token)).free.length, 0, "заявка не одобрена");
  await call(F(w).handleAdminDecide, { tenantId: "A", courierId: c.id, decision: "approve" }, { uid: "owner" });
  w.api.forgetCache();
  assert.equal((await state(w, c.token)).free.length, 0, "не на линии");
  await call(w.api.handleShift, { on: true }, asCourier(c.token));
  let st = await state(w, c.token);
  assert.equal(st.free.length, 0);
  assert.equal(st.me.needPos, true, "нет геолокации — приложение подскажет");
  await ping(w, c.token, FAR);
  assert.equal((await state(w, c.token)).free.length, 0, "дальше радиуса");
  await assert.rejects(act(w, c.token, "take", "A", "paid"), (e) => e.status === 409 && /дальше 5 км/.test(e.message));
  await ping(w, c.token, NEAR);
  assert.equal((await state(w, c.token)).free.length, 0, "15 минут заказ — только курьерам заведения");
  await assert.rejects(act(w, c.token, "take", "A", "paid"), (e) => e.status === 409 && /курьерам заведения/.test(e.message));
  clock += 6 * 60000;
  await ping(w, c.token, NEAR);
  st = await state(w, c.token);
  assert.deepEqual(st.free.map((f) => f.s), ["paid"], "неоплаченный заказ без QR свободному не предлагаем");
  assert.equal(st.free[0].toCollect, 0);
  assert.equal(st.free[0].street, "ул. Ленина, 5", "квартира и телефон — после «Беру»");
  await assert.rejects(act(w, c.token, "take", "A", "cash"), (e) => e.status === 409 && /не оплачен/.test(e.message));
  await assert.rejects(act(w, c.token, "take", "B", "other"), (e) => e.status === 403, "чужое заведение");
  // Банк подключён — неоплаченный заказ можно взять: оплата по QR у двери.
  await w.set("tenants/A/settings/delivery", { ...(await w.db.doc("tenants/A/settings/delivery").get()).data(), payAtDoor: { cash: true, card: true, qr: true } });
  await w.set("tenants/A/settings/integrations", { onlinePayVerified: "tinkoff|1" });
  w.api.forgetCache();
  st = await state(w, c.token);
  assert.deepEqual(st.free.map((f) => f.s).sort(), ["cash", "paid"]);
  await act(w, c.token, "take", "A", "cash");
  await act(w, c.token, "pickup", "A", "cash");
  const mine = (await state(w, c.token)).mine[0];
  assert.deepEqual(mine.payAtDoor, { cash: false, card: false, qr: true }, "наличные и карту свободный курьер не принимает");
  await assert.rejects(act(w, c.token, "deliver", "A", "cash", { method: "cash", received: 1000 }), (e) => e.status === 409 && /не принимает оплату наличными/.test(e.message));
  assert.equal((await call(w.api.handlePay, { t: "A", s: "cash" }, asCourier(c.token))).body.url, "https://qr.nspk.ru/AS1");
  await w.db.doc("tenants/A/sessions/cash").update({ guestPaidTotal: 750 });
  await act(w, c.token, "deliver", "A", "cash", { method: "qr" });
  assert.equal((await w.db.doc(`couriers/${c.id}`).get()).data().cashOnHand, 0);
});

test("заказ целиком: взял → забрал → вручил; заработок по ставке на момент «Беру»; долг заведения; выплата; отчёт", async () => {
  const w = world();
  await seed(w);
  await openVenue(w, { ratePerTrip: 200, ratePerKm: 0 });
  const c = await working(w);
  await w.set("tenants/A/sessions/s1", order());
  const offer = (await state(w, c.token)).free[0];
  assert.equal(offer.payout, 200, "курьер видит, сколько заплатит заведение");
  await act(w, c.token, "take", "A", "s1");
  let s = (await w.db.doc("tenants/A/sessions/s1").get()).data();
  assert.deepEqual([s.courierId, s.courierNo, s.courierFree, s.courierStage, s.courierName, s.courierPhone], [c.id, 1001, true, "toVenue", "Пётр", "79110000001"]);
  assert.match(w.events.at(-1).text, /Свободный курьер №1001 взял заказ/);
  // Заведение подняло ставку после «Беру» — цена этого заказа прежняя.
  await call(F(w).handleAdminSave, { tenantId: "A", on: true, mode: "approved", ratePerTrip: 500, ratePerKm: 0, radiusKm: 5, delayMin: 0 }, { uid: "owner" });
  // Кабинет «Сейчас»: кто везёт — имя и телефон (заведение — сторона договора).
  const list = (await call(w.api.handleAdminList, { tenantId: "A" }, { uid: "owner" })).body;
  const o = list.orders.find((x) => x.s === "s1");
  assert.deepEqual([o.courierFree, o.courierNo, o.courierName, o.courierPhone], [true, 1001, "Иванов Пётр Сергеевич", "79110000001"]);
  assert.equal(list.couriers.length, 0, "в списке своих курьеров свободного нет");
  // Назначить свободного нельзя — он берёт сам; снять до забора — можно.
  await w.set("tenants/A/sessions/s2", order({ orderNo: 14 }));
  await assert.rejects(call(w.api.handleAdminAssign, { tenantId: "A", s: "s2", courierId: c.id }, { uid: "owner" }), (e) => e.status === 404);
  await act(w, c.token, "pickup", "A", "s1");
  await act(w, c.token, "arrive", "A", "s1");
  await act(w, c.token, "deliver", "A", "s1");
  s = (await w.db.doc("tenants/A/sessions/s1").get()).data();
  assert.deepEqual([s.deliveryStatus, s.courierStage, s.courierPayment.method, s.courierPayment.amount], ["done", "done", "online", 0]);
  const doc = (await w.db.doc(`couriers/${c.id}`).get()).data();
  assert.equal(doc.owed.t_A, 200);
  const trip = (await w.db.doc(`couriers/${c.id}/trips/A__s1`).get()).data();
  assert.deepEqual([trip.root, trip.free, trip.earned, trip.result], ["t_A", true, 200, "done"]);
  // Следующий заказ — уже по новой ставке.
  await act(w, c.token, "take", "A", "s2");
  await act(w, c.token, "pickup", "A", "s2");
  await act(w, c.token, "deliver", "A", "s2");
  assert.equal((await w.db.doc(`couriers/${c.id}`).get()).data().owed.t_A, 700);
  const st = await state(w, c.token);
  assert.deepEqual([st.stats.trips, st.stats.earned, st.me.owed], [2, 700, 700]);
  // Кабинет: к выплате, отметка выплаты, отчёт.
  let g = (await call(F(w).handleAdminGet, { tenantId: "A" }, { uid: "owner" })).body;
  assert.deepEqual([g.couriers[0].owed, g.couriers[0].today.trips, g.couriers[0].today.earned], [700, 2, 700]);
  await assert.rejects(call(F(w).handleAdminPaid, { tenantId: "A", courierId: c.id, amount: 800 }, { uid: "owner" }), (e) => e.status === 409);
  await assert.rejects(call(F(w).handleAdminPaid, { tenantId: "B", courierId: c.id, amount: 100 }, { uid: "owner" }), (e) => e.status === 404, "чужое заведение");
  assert.equal((await call(F(w).handleAdminPaid, { tenantId: "A", courierId: c.id, amount: 500 }, { uid: "owner" })).body.owed, 200);
  const h = (await call(w.api.handleHistory, {}, asCourier(c.token))).body;
  assert.deepEqual(h.owed, [{ venue: "Лето", owed: 200 }]);
  assert.deepEqual(h.payouts.map((p) => [p.venue, p.amount]), [["Лето", 500]]);
  assert.equal(h.days.at(-1).earned, 700);
  const rep = (await call(w.api.handleAdminReport, { tenantId: "A", day: h.today }, { uid: "owner" })).body;
  assert.deepEqual(rep.rows.map((r) => [r.no, r.free, r.trips, r.earned]), [[1001, true, 2, 700]]);
  assert.equal((await call(w.api.handleAdminReport, { tenantId: "B", day: h.today }, { uid: "owner" })).body.rows.length, 0);
});

test("ставка за километр: оценка пути по карте в предложении и в заработке", async () => {
  const w = world();
  await seed(w);
  await openVenue(w, { ratePerTrip: 100, ratePerKm: 30 });
  const c = await working(w);
  await w.set("tenants/A/sessions/s1", order({ deliveryGeo: { lat: 59.9458, lng: 30.3259 } })); // ~1,1 км по прямой
  const f = (await state(w, c.token)).free[0];
  assert.ok(f.tripM > 1300 && f.tripM < 1600, `путь с поправкой на дороги: ${f.tripM}`);
  assert.equal(f.payout, Math.round(100 + (30 * f.tripM) / 1000));
  await act(w, c.token, "take", "A", "s1");
  await act(w, c.token, "pickup", "A", "s1");
  await act(w, c.token, "deliver", "A", "s1");
  assert.equal((await w.db.doc(`couriers/${c.id}`).get()).data().owed.t_A, f.payout, "заплатят не меньше обещанного");
});

test("свободный курьер — не больше 4 заказов на руках; смену с заказами закончить нельзя", async () => {
  const w = world();
  await seed(w);
  await openVenue(w);
  const c = await working(w);
  for (let i = 1; i <= 5; i++) await w.set(`tenants/A/sessions/s${i}`, order({ orderNo: 20 + i }));
  for (let i = 1; i <= 4; i++) await act(w, c.token, "take", "A", `s${i}`);
  await assert.rejects(act(w, c.token, "take", "A", "s5"), (e) => e.status === 409 && /уже 4 заказа/.test(e.message));
  await assert.rejects(call(w.api.handleShift, { on: false }, asCourier(c.token)), (e) => e.status === 409);
  await act(w, c.token, "release", "A", "s1");
  assert.match(w.events.at(-1).text, /Свободный курьер №1001 отказался/);
  assert.equal((await act(w, c.token, "take", "A", "s5")).status, 200);
});

test("заведение выключило свободных курьеров — взятый заказ курьер довозит, новые не видит", async () => {
  const w = world();
  await seed(w);
  await openVenue(w);
  const c = await working(w);
  await w.set("tenants/A/sessions/s1", order());
  await w.set("tenants/A/sessions/s2", order({ orderNo: 13 }));
  await act(w, c.token, "take", "A", "s1");
  await call(F(w).handleAdminSave, { tenantId: "A", on: false, mode: "approved", ratePerTrip: 200, ratePerKm: 20, radiusKm: 5, delayMin: 0 }, { uid: "owner" });
  const st = await state(w, c.token);
  assert.deepEqual([st.mine.map((m) => m.s), st.free.length], [["s1"], 0]);
  await assert.rejects(act(w, c.token, "take", "A", "s2"), (e) => e.status === 409 && /не принимает/.test(e.message));
  await act(w, c.token, "pickup", "A", "s1");
  await act(w, c.token, "deliver", "A", "s1");
  assert.equal((await w.db.doc(`couriers/${c.id}`).get()).data().owed.t_A, 200);
  assert.equal((await call(F(w).handleNearby, NEAR, asCourier(c.token))).body.venues.length, 0, "в поиске заведения нет");
});

test("закрыть доступ: незабранный заказ снова свободен, с заказом в пути — нельзя; закрытый не видит заказы и не подаст заявку", async () => {
  const w = world();
  await seed(w);
  await openVenue(w);
  const c = await working(w);
  await w.set("tenants/A/sessions/s1", order());
  await w.set("tenants/A/sessions/s2", order({ orderNo: 13 }));
  await act(w, c.token, "take", "A", "s1");
  await act(w, c.token, "take", "A", "s2");
  await act(w, c.token, "pickup", "A", "s1");
  await assert.rejects(call(F(w).handleAdminDecide, { tenantId: "A", courierId: c.id, decision: "block" }, { uid: "owner" }), (e) => e.status === 409 && /в пути: 1/.test(e.message));
  await act(w, c.token, "deliver", "A", "s1");
  await call(F(w).handleAdminDecide, { tenantId: "A", courierId: c.id, decision: "block" }, { uid: "owner" });
  const s2 = (await w.db.doc("tenants/A/sessions/s2").get()).data();
  assert.ok(!s2.courierId && !s2.courierFree && s2.courierSet === false, "заказ снова свободен");
  assert.match(w.events.at(-1).text, /заведение закрыло доступ/);
  w.api.forgetCache();
  const st = await state(w, c.token);
  assert.deepEqual([st.free.length, st.mine.length, st.me.links], [0, 0, 0]);
  await assert.rejects(call(F(w).handleApply, { root: "t_A" }, asCourier(c.token)), (e) => e.status === 403);
  await assert.rejects(call(F(w).handleLeave, { root: "t_A" }, asCourier(c.token)), (e) => e.status === 409);
  assert.equal((await w.db.doc(`couriers/${c.id}`).get()).data().owed.t_A, 200, "заработанное остаётся к выплате");
  await call(F(w).handleAdminDecide, { tenantId: "A", courierId: c.id, decision: "unblock" }, { uid: "owner" });
  w.api.forgetCache();
  await ping(w, c.token, NEAR);
  assert.equal((await state(w, c.token)).free.length, 1);
});

test("пропал со связи с незабранным заказом — заказ свободен; сеть: курьер возит со всех точек сети", async () => {
  const w = world();
  await seed(w);
  await call(F(w).handleAdminPos, { tenantId: "N1", lat: VENUE.lat, lng: VENUE.lng }, { uid: "chainowner" });
  await call(F(w).handleAdminSave, { tenantId: "N1", on: true, mode: "all", ratePerTrip: 150, ratePerKm: 0, radiusKm: 5, delayMin: 0, agree: true }, { uid: "chainowner" });
  const c = await register(w);
  const near = (await call(F(w).handleNearby, NEAR, asCourier(c.token))).body.venues[0];
  assert.deepEqual([near.root, near.title, near.points.length], ["c_N", "Сеть · Центр и ещё 1", 2]);
  await call(F(w).handleApply, { root: "c_N" }, asCourier(c.token));
  await call(w.api.handleShift, { on: true }, asCourier(c.token));
  await ping(w, c.token, NEAR);
  await w.set("tenants/N1/sessions/a", order());
  await w.set("tenants/N2/sessions/b", order({ orderNo: 13 })); // у N2 места на карте нет — радиус не мешает
  assert.deepEqual((await state(w, c.token)).free.map((f) => f.t).sort(), ["N1", "N2"]);
  await act(w, c.token, "take", "N2", "b");
  clock += cm.LOST_MS + 60000;
  await w.api.sweep();
  assert.ok(!(await w.db.doc("tenants/N2/sessions/b").get()).data().courierId);
  assert.match(w.events.at(-1).text, /Свободный курьер №1001 не на связи/);
  // Администратор точки видит свободных курьеров сети, но решает владелец сети.
  const g = (await call(F(w).handleAdminGet, { tenantId: "N1" }, { uid: "pointadmin" })).body;
  assert.deepEqual([g.full, g.couriers.length], [false, 1]);
  await assert.rejects(call(F(w).handleAdminDecide, { tenantId: "N1", courierId: c.id, decision: "block" }, { uid: "pointadmin" }), (e) => e.status === 403);
});

// ---------------------------------------------------------------- профиль и удаление

test("профиль: транспорт, почта, смена пароля; уйти из заведения", async () => {
  const w = world();
  await seed(w);
  await openVenue(w);
  const c = await working(w);
  await call(F(w).handleUpdate, { transport: "auto", medBook: false, email: "New@Example.ru" }, asCourier(c.token));
  let p = (await call(F(w).handleProfile, {}, asCourier(c.token))).body;
  assert.deepEqual([p.transport, p.medBook, p.email, p.tax.label], ["auto", false, "new@example.ru", "самозанятый"]);
  await assert.rejects(call(F(w).handleUpdate, { password: "Drugoi-parol-9", oldPassword: "мимо" }, asCourier(c.token)), (e) => e.status === 403);
  await call(F(w).handleUpdate, { password: "Drugoi-parol-9", oldPassword: REG.password }, asCourier(c.token));
  assert.equal((await call(F(w).handleSignin, { phone: REG.phone, password: "Drugoi-parol-9" })).status, 200);
  const t2 = (await call(F(w).handleSignin, { phone: REG.phone, password: "Drugoi-parol-9" })).body.token;
  await w.set("tenants/A/sessions/s1", order());
  await ping(w, t2, NEAR);
  await act(w, t2, "take", "A", "s1");
  await assert.rejects(call(F(w).handleLeave, { root: "t_A" }, asCourier(t2)), (e) => e.status === 409 && /завершите заказы/.test(e.message));
  await act(w, t2, "release", "A", "s1");
  await call(F(w).handleLeave, { root: "t_A" }, asCourier(t2));
  p = (await call(F(w).handleProfile, {}, asCourier(t2))).body;
  assert.equal(p.venues.length, 0);
  assert.equal((await call(F(w).handleAdminGet, { tenantId: "A" }, { uid: "owner" })).body.couriers.length, 0);
  assert.equal((await call(F(w).handleApply, { root: "t_A" }, asCourier(t2))).body.st, "pending", "можно вернуться заявкой");
});

test("удаление учётки: данные стёрты, вход закрыт, поездки остаются за номером, владельцу — акт; телефон свободен для новой регистрации", async () => {
  const w = world();
  await seed(w);
  await openVenue(w);
  const c = await working(w);
  await w.set("tenants/A/sessions/s1", order());
  await act(w, c.token, "take", "A", "s1");
  await assert.rejects(call(F(w).handleDelete, { password: "мимо" }, asCourier(c.token)), (e) => e.status === 403);
  await assert.rejects(call(F(w).handleDelete, { password: REG.password }, asCourier(c.token)), (e) => e.status === 409 && /завершите заказы/.test(e.message));
  await act(w, c.token, "pickup", "A", "s1");
  await act(w, c.token, "deliver", "A", "s1");
  assert.equal((await call(F(w).handleDelete, { password: REG.password }, asCourier(c.token))).status, 200);
  const doc = (await w.db.doc(`couriers/${c.id}`).get()).data();
  assert.deepEqual([doc.name, doc.phone, doc.email, doc.inn, doc.enabled, doc.onShift], ["Курьер №1001", "", "", "", false, false]);
  for (const k of ["passHash", "tokenHash", "pos", "pdIp", "pdUa", "npd", "device"]) assert.ok(!(k in doc), `стёрто: ${k}`);
  assert.equal(doc.owed.t_A, 200, "долг заведения виден по номеру");
  await assert.rejects(call(w.api.handleState, {}, asCourier(c.token)), (e) => e.status === 401);
  await assert.rejects(call(F(w).handleSignin, { phone: REG.phone, password: REG.password }), (e) => e.status === 403);
  assert.equal(w.acts.length, 1);
  assert.match(w.acts[0].items[0].subject, /Курьер №1001.*\*\*\*0001/);
  assert.ok(!w.acts[0].items[0].subject.includes("Иванов") && w.acts[0].items[0].categories.includes("ИНН и налоговый статус"));
  assert.equal((await w.db.doc(`couriers/${c.id}/trips/A__s1`).get()).data().result, "done");
  assert.equal((await call(F(w).handleAdminGet, { tenantId: "A" }, { uid: "owner" })).body.couriers.length, 0, "в кабинете заведения его больше нет");
  const again = await register(w);
  assert.equal(again.no, 1002);
});

test("курьер заведения в разделы свободных не попадает; свободный не входит по чужому ключу", async () => {
  const w = world();
  await seed(w);
  const own = (await call(w.api.handleAdminSave, { tenantId: "A", courier: { name: "Свой Курьер", phone: REG.phone } }, { uid: "owner" })).body;
  const inv = (await call(w.api.handleAdminInvite, { tenantId: "A", courierId: own.id }, { uid: "owner" })).body.url.split("#i=")[1];
  const token = (await call(w.api.handleLogin, { invite: inv })).body.token;
  for (const h of ["handleProfile", "handleNearby", "handleApply", "handleDelete"]) {
    await assert.rejects(call(F(w)[h], { root: "t_A", lat: 1, lng: 1 }, asCourier(token)), (e) => e.status === 403, h);
  }
  // Тот же телефон у курьера заведения регистрации не мешает и паролем не входит.
  await assert.rejects(call(F(w).handleSignin, { phone: REG.phone, password: REG.password }), (e) => e.status === 403);
  const c = await register(w);
  assert.equal(c.no, 1001);
  await assert.rejects(call(F(w).handleProfile, {}, asCourier("x".repeat(43))), (e) => e.status === 401);
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
  console.log(`courier-free: ${n} из ${tests.length} проверок`);
})();
