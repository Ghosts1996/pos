"use strict";
// Курьеры и приложение курьера (courier.js): вход по ссылке, смена,
// свободные и свои заказы, шаги, оплата у двери, геолокация, сети,
// кабинет, сторож. База — настоящая local-db (транзакции, вложенные поля).
const assert = require("assert/strict");
const { createLocalDb } = require("./local-db");
const cm = require("./courier");

let clock = Date.parse("2026-11-11T12:00:00Z"); // 15:00 по Москве
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

/** Мир: точка A (одиночная), сеть N из точек N1 и N2. */
function world({ rf = false } = {}) {
  clock = Date.parse("2026-11-11T12:00:00Z");
  const db = createLocalDb({ admin, now });
  const events = [];
  const moved = [];
  const fails = [];
  const mails = [];
  const limits = {}; // root → лимит тарифа (нет — без ограничений)
  let mailOn = true;
  const members = { "A_owner": "owner", "N1_pointadmin": "admin" };
  const chainMembers = { "N_chainowner": "owner" };
  const piiStore = new Map();
  const pii = rf ? {
    mode: async () => "rf",
    lookup: async (t, refs) => new Map(refs.map((r) => [`delivery:${r.id}`, piiStore.get(`${t}:${r.id}`) || {}])),
    put: async (t, items) => {
      for (const it of items) {
        const cur = piiStore.get(`${t}:${it.id}`) || {};
        piiStore.set(`${t}:${it.id}`, { ...cur, ...it.fields, extra: { ...(cur.extra || {}), ...((it.fields || {}).extra || {}) } });
      }
    },
  } : null;
  const paid = { status: "pending" };
  const guestPay = {
    courierPayStart: async () => ({ paymentId: "pay1", url: "https://qr.nspk.ru/AS1", amount: 1000, status: "pending" }),
    courierPayStatus: async () => ({ ...paid }),
  };
  const api = cm.createCourier({
    db: () => db, admin, HttpError, now, pii, guestPay,
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
    getMailer: () => (mailOn ? { send: async (m) => { mails.push(m); } } : null),
    courierLimit: async (root) => (root in limits ? limits[root] : -1),
    appUrl: "https://pii.zalpos.ru/saas/courier/",
  });
  api.setHooks({ event: async (t, s, text) => events.push({ t, s, text }), moved: async (t, s, lat, lng) => moved.push({ t, s, lat, lng }) });
  const set = (p, d) => db.doc(p).set(d);
  return { db, api, events, moved, fails, set, piiStore, paid, mails, limits, mail: (v) => { mailOn = v; } };
}

async function seed(w) {
  await w.set("tenants/A", { name: "Лето", timezone: "Europe/Moscow", status: "active", createdAt: Timestamp.fromMillis(1) });
  await w.set("tenants/A/meta/venueProfile", { address: "Москва, Тверская, 1" });
  await w.set("tenants/N1", { name: "Сеть · Центр", chainId: "N", timezone: "Europe/Moscow", status: "active", createdAt: Timestamp.fromMillis(1) });
  await w.set("tenants/N2", { name: "Сеть · Север", chainId: "N", timezone: "Europe/Moscow", status: "active", createdAt: Timestamp.fromMillis(2) });
}

const order = (over = {}) => ({
  tableId: "takeaway", status: "active", orderType: "delivery", orderNo: 12, source: "app",
  deliveryStatus: "cooking", startTime: Timestamp.fromMillis(clock - 10 * 60000),
  deliveryAddress: "ул. Ленина, 5, кв./офис 12, подъезд 2, этаж 3, домофон 12К",
  customerPhone: "79001234567", customerName: "Аня", deliveryComment: "Позвоните",
  orderItems: [{ menuItemId: "soup", name: "Том ям", price: 600, qty: 1, ready: 1 }, { menuItemId: "zalpos_delivery", name: "Доставка", price: 150, qty: 1, noPromo: true, kind: "kitchen", ready: 1 }],
  delivery: { fee: 150, etaMin: 60 },
  ...over,
});

const call = async (fn, body, extra = {}) => { const res = {}; await fn({ body, headers: {}, ...extra }, res); return res; };
const asCourier = (token) => ({ headers: { authorization: `Bearer ${token}` } });

let hired = 0;
/** Код из последнего письма на эту почту. */
const codeFor = (w, email) => {
  const m = [...w.mails].reverse().find((x) => x.to === email && /код входа/.test(x.subject));
  return m ? /(\d{6}) —/.exec(m.subject)[1] : "";
};

/** Вход по почте: галочка → код в письме → ключ (одно заведение) или выбор заведения. */
async function signIn(w, email, { pick } = {}) {
  clock += 61 * 1000; // код не чаще раза в минуту
  const rq = await call(w.api.handleRequestCode, { email, consent_accepted: true });
  assert.equal(rq.status, 200);
  const v = await call(w.api.handleVerifyCode, { email, code: codeFor(w, email), consent_accepted: true, device: "Android" }, { headers: { "x-real-ip": "203.0.113.7" } });
  if (!v.body.choose) return v.body;
  const venue = v.body.venues.find((x) => (pick ? pick(x) : true));
  return (await call(w.api.handleSelect, { email, ticket: v.body.ticket, courierId: venue.id, device: "Android" }, { headers: { "x-real-ip": "203.0.113.7" } })).body;
}

/** Курьер через кабинет: создать (имя, почта, телефон, транспорт), войти по почте, смена. */
async function hire(w, { tenantId = "A", uid = "owner", name = "Николай Петров", phone = "8 900 000-00-01", email, points, shift = true } = {}) {
  const mail = email || `courier${++hired}@example.ru`;
  const made = await call(w.api.handleAdminSave, { tenantId, courier: { name, email: mail, phone, transport: "bike", ...(points ? { points } : {}) } }, { uid });
  assert.equal(made.status, 200);
  const r = await signIn(w, mail);
  const token = r.token;
  if (shift) await call(w.api.handleShift, { on: true }, asCourier(token));
  return { id: made.body.id, no: made.body.no, token, email: mail };
}

const state = async (w, token) => (await call(w.api.handleState, {}, asCourier(token))).body;
const act = (w, token, op, t, s, extra = {}) => call(w.api.handleAct, { op, t, s, ...extra }, asCourier(token));

// ---------------------------------------------------------------- чистые функции

test("рабочие сутки с 06:00 по поясу точки; улица без квартиры; путь без дрожи и прыжков", () => {
  const msk = cm.dayStartMs(Date.parse("2026-11-11T01:00:00Z"), "Europe/Moscow"); // 04:00 МСК — ещё вчера
  assert.equal(msk.day, "2026-11-10");
  assert.equal(new Date(msk.start).toISOString(), "2026-11-10T03:00:00.000Z");
  const nsk = cm.dayStartMs(Date.parse("2026-11-11T00:30:00Z"), "Asia/Novosibirsk"); // 07:30 НСК
  assert.equal(nsk.day, "2026-11-11");
  assert.equal(new Date(nsk.start).toISOString(), "2026-11-10T23:00:00.000Z");
  assert.equal(cm.streetOf("ул. Ленина, 5, кв./офис 12, подъезд 2, этаж 3, домофон 12К"), "ул. Ленина, 5");
  assert.equal(cm.streetOf("пр. Мира 10"), "пр. Мира 10");
  const p = (lat, lng, at, acc = 10) => ({ lat, lng, at, acc });
  const step = cm.odometerStep(null, [
    p(55.75, 37.6, 0), p(55.75001, 37.6, 5000), // 1 м — дрожь
    p(55.751, 37.6, 30000), // ~111 м
    p(55.9, 37.6, 31000), // прыжок 16 км за секунду — мимо
    p(55.752, 37.6, 60000, 300), // неточная — мимо
    p(55.752, 37.6, 90000), // ещё ~111 м
  ]);
  assert.ok(step.meters > 215 && step.meters < 230, `путь ${step.meters} м`);
  assert.equal(cm.normalizePhone("8 (900) 000-00-01"), "79000000001");
});

// ---------------------------------------------------------------- вход

test("вход по почте: без галочки код не уходит; код — 6 цифр, 10 минут, раз в минуту; ПЭП в учётке; ключ — только хэш", async () => {
  const w = world();
  await seed(w);
  await call(w.api.handleAdminSave, { tenantId: "A", courier: { name: "Оля Смирнова", email: "  Olya@Example.RU ", phone: "+7 900 000-00-09", transport: "foot" } }, { uid: "owner" });
  const doc0 = (await w.db.collection("couriers").where("email", "==", "olya@example.ru").get()).docs[0];
  assert.ok(doc0, "почта хранится в нижнем регистре");
  assert.equal(w.mails.length, 1, "приветственное письмо");
  assert.match(w.mails[0].subject, /курьером в «Лето»/);
  assert.match(w.mails[0].text, /Администратор заведения «Лето» добавил вас как курьера/);
  await assert.rejects(call(w.api.handleRequestCode, { email: "olya@example.ru" }), (e) => e.status === 400 && e.code === "CONSENT_REQUIRED");
  await assert.rejects(call(w.api.handleRequestCode, { email: "kto-to@example.ru", consent_accepted: true }), (e) => e.status === 404 && e.code === "COURIER_NOT_FOUND" && /Обратитесь к администратору вашего заведения/.test(e.message));
  await assert.rejects(call(w.api.handleRequestCode, { email: "не почта", consent_accepted: true }), (e) => e.status === 400);
  assert.equal((await call(w.api.handleRequestCode, { email: "OLYA@example.ru", consent_accepted: true })).status, 200);
  await assert.rejects(call(w.api.handleRequestCode, { email: "olya@example.ru", consent_accepted: true }), (e) => e.status === 429 && e.code === "CODE_TOO_OFTEN" && e.retryIn > 0);
  const code = codeFor(w, "olya@example.ru");
  assert.match(code, /^\d{6}$/);
  const codes = (await w.db.collection("courierCodes").get()).docs.map((d) => JSON.stringify(d.data()));
  assert.ok(codes.length === 1 && !codes[0].includes(code) && !codes[0].includes("olya"), "в базе — только хэши кода и почты");
  // Неверный код — попытки считаются; без галочки — нельзя.
  await assert.rejects(call(w.api.handleVerifyCode, { email: "olya@example.ru", code, consent_accepted: false }), (e) => e.status === 400);
  await assert.rejects(call(w.api.handleVerifyCode, { email: "olya@example.ru", code: code === "000000" ? "111111" : "000000", consent_accepted: true }), (e) => e.status === 403 && /осталось попыток: 4/.test(e.message));
  const ok = await call(w.api.handleVerifyCode, { email: "olya@example.ru", code: `${code.slice(0, 3)} ${code.slice(3)}`, consent_accepted: true, device: "Android" }, { headers: { "x-real-ip": "203.0.113.7" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.courier, { no: 1, name: "Оля Смирнова", venue: "Лето" });
  const doc = (await w.db.doc(`couriers/${doc0.id}`).get()).data();
  assert.deepEqual([doc.consentIp, doc.consentEmail, doc.policyVersion, !!doc.consentAt], ["203.0.113.7", "olya@example.ru", cm.POLICY_VERSION, true], "доказательство согласия");
  assert.ok(doc.tokenHash && !JSON.stringify(doc).includes(ok.body.token), "ключа в базе нет");
  await assert.rejects(call(w.api.handleVerifyCode, { email: "olya@example.ru", code, consent_accepted: true }), (e) => e.status === 403, "код одноразовый");
  // Сразу можно на смену: согласие уже дано при входе.
  assert.equal((await call(w.api.handleState, {}, asCourier(ok.body.token))).body.me.consent, true);
  assert.equal((await call(w.api.handleShift, { on: true }, asCourier(ok.body.token))).status, 200);
  await assert.rejects(call(w.api.handleState, {}, asCourier("x".repeat(40))), (e) => e.status === 401);
  // Код живёт 10 минут; 5 ошибок — код сгорает.
  clock += 61 * 1000;
  await call(w.api.handleRequestCode, { email: "olya@example.ru", consent_accepted: true });
  const code2 = codeFor(w, "olya@example.ru");
  clock += cm.CODE_TTL_MS + 1000;
  await assert.rejects(call(w.api.handleVerifyCode, { email: "olya@example.ru", code: code2, consent_accepted: true }), (e) => e.status === 403 && /устарел/.test(e.message));
  await call(w.api.handleRequestCode, { email: "olya@example.ru", consent_accepted: true });
  const code3 = codeFor(w, "olya@example.ru");
  for (let i = 0; i < 5; i++) await assert.rejects(call(w.api.handleVerifyCode, { email: "olya@example.ru", code: code3 === "999999" ? "888888" : "999999", consent_accepted: true }), (e) => e.status === 403);
  await assert.rejects(call(w.api.handleVerifyCode, { email: "olya@example.ru", code: code3, consent_accepted: true }), (e) => e.status === 403, "после 5 ошибок верный код уже не подходит");
  assert.ok(w.fails.length >= 7, "ошибки входа — щиту");
  // Почта не работает — понятная ошибка, а не «успех».
  w.mail(false);
  clock += 61 * 1000;
  await assert.rejects(call(w.api.handleRequestCode, { email: "olya@example.ru", consent_accepted: true }), (e) => e.status === 503 && e.code === "MAIL_UNAVAILABLE");
});

test("одна почта в двух заведениях: после кода — выбор заведения; ключ — только своего заведения", async () => {
  const w = world();
  await seed(w);
  await w.set("tenants/B", { name: "Зима", timezone: "Europe/Moscow", status: "active", createdAt: Timestamp.fromMillis(1) });
  const owners = { A: "owner", B: "ownerB" };
  await call(w.api.handleAdminSave, { tenantId: "A", courier: { name: "Пётр", email: "petr@example.ru", transport: "car" } }, { uid: owners.A });
  // Владелец B — свой участник; в тесте права проверяются по таблице members.
  w.api.forgetCache();
  const membersFix = await call(w.api.handleAdminSave, { tenantId: "B", courier: { name: "Пётр", email: "petr@example.ru", transport: "car" } }, { uid: "ownerB" }).catch((e) => e);
  assert.ok(membersFix instanceof Error, "чужой владелец без прав — отказ");
  // В заведении B курьера заводит его владелец (подменяем права через данные).
  await w.set("couriers/b1", { root: "t_B", no: 1, name: "Пётр", email: "petr@example.ru", transport: "car", phone: "", points: [], enabled: true, onShift: false, cashOnHand: 0, odometerM: 0 });
  await w.set("tenants/A/sessions/a1", order());
  await w.set("tenants/B/sessions/b1", order({ orderNo: 77 }));
  clock += 61 * 1000;
  await call(w.api.handleRequestCode, { email: "petr@example.ru", consent_accepted: true });
  const v = await call(w.api.handleVerifyCode, { email: "petr@example.ru", code: codeFor(w, "petr@example.ru"), consent_accepted: true });
  assert.equal(v.body.choose, true);
  assert.deepEqual(v.body.venues.map((x) => x.name), ["Зима", "Лето"]);
  await assert.rejects(call(w.api.handleSelect, { email: "petr@example.ru", ticket: "чужой", courierId: "b1" }), (e) => e.status === 403);
  const r = await call(w.api.handleSelect, { email: "petr@example.ru", ticket: v.body.ticket, courierId: "b1" });
  assert.equal(r.body.courier.venue, "Зима");
  await call(w.api.handleShift, { on: true }, asCourier(r.body.token));
  const st = await state(w, r.body.token);
  assert.deepEqual([st.me.venue, st.free.map((f) => f.t)], ["Зима", ["B"]], "видит заказы только своего заведения");
  await assert.rejects(act(w, r.body.token, "take", "A", "a1"), (e) => e.status === 403, "чужое заведение — нельзя");
  await assert.rejects(call(w.api.handleSelect, { email: "petr@example.ru", ticket: v.body.ticket, courierId: "b1" }), (e) => e.status === 403, "билет одноразовый");
});

test("лимит тарифа: сверх лимита — 403 COURIER_LIMIT_EXCEEDED; блокировка освобождает место и гасит вход; почта уникальна в заведении", async () => {
  const w = world();
  await seed(w);
  w.limits.t_A = 1;
  const a = await hire(w, { name: "Аня" });
  await assert.rejects(call(w.api.handleAdminSave, { tenantId: "A", courier: { name: "Боря", email: "borya@example.ru", transport: "foot" } }, { uid: "owner" }),
    (e) => e.status === 403 && e.code === "COURIER_LIMIT_EXCEEDED" && /Лимит тарифа — 1 активный курьер/.test(e.message));
  await assert.rejects(call(w.api.handleAdminSave, { tenantId: "A", courier: { name: "Аня 2", email: a.email.toUpperCase(), transport: "foot" } }, { uid: "owner" }), (e) => e.status === 409 && e.code === "EMAIL_TAKEN");
  await assert.rejects(call(w.api.handleAdminSave, { tenantId: "A", courier: { name: "Без почты", transport: "foot" } }, { uid: "owner" }), (e) => e.status === 400);
  await assert.rejects(call(w.api.handleAdminSave, { tenantId: "A", courier: { name: "Без транспорта", email: "x@example.ru" } }, { uid: "owner" }), (e) => e.status === 400);
  let list = (await call(w.api.handleAdminList, { tenantId: "A" }, { uid: "owner" })).body;
  assert.deepEqual(list.slots, { active: 1, max: 1 });
  assert.equal(list.couriers[0].consent.current, true);
  // Блокировка: вход гаснет сразу, место свободно.
  await call(w.api.handleShift, { on: false }, asCourier(a.token));
  await call(w.api.handleAdminEnable, { tenantId: "A", courierId: a.id, enabled: false }, { uid: "owner" });
  await assert.rejects(call(w.api.handleState, {}, asCourier(a.token)), (e) => e.status === 401);
  clock += 61 * 1000;
  await assert.rejects(call(w.api.handleRequestCode, { email: a.email, consent_accepted: true }), (e) => e.status === 404, "заблокированному код не отправляем");
  const b = await call(w.api.handleAdminSave, { tenantId: "A", courier: { name: "Боря", email: "borya@example.ru", transport: "foot" } }, { uid: "owner" });
  assert.equal(b.status, 200);
  // Вернуть Аню — места нет.
  await assert.rejects(call(w.api.handleAdminEnable, { tenantId: "A", courierId: a.id, enabled: true }, { uid: "owner" }), (e) => e.status === 403 && e.code === "COURIER_LIMIT_EXCEEDED");
  w.limits.t_A = -1;
  assert.equal((await call(w.api.handleAdminEnable, { tenantId: "A", courierId: a.id, enabled: true }, { uid: "owner" })).status, 200);
  list = (await call(w.api.handleAdminList, { tenantId: "A" }, { uid: "owner" })).body;
  assert.deepEqual(list.slots, { active: 2, max: -1 });
  // Письмо ещё раз — не чаще раза в минуту.
  await assert.rejects(call(w.api.handleAdminWelcome, { tenantId: "A", courierId: b.body.id }, { uid: "owner" }), (e) => e.status === 429);
  clock += 61 * 1000;
  assert.equal((await call(w.api.handleAdminWelcome, { tenantId: "A", courierId: b.body.id }, { uid: "owner" })).status, 200);
  // Смена почты в карточке — старый вход гаснет, новое приветствие.
  const before = w.mails.length;
  const bt = await signIn(w, "borya@example.ru");
  await call(w.api.handleAdminSave, { tenantId: "A", courier: { id: b.body.id, name: "Боря", email: "boris@example.ru", transport: "foot" } }, { uid: "owner" });
  await assert.rejects(call(w.api.handleState, {}, asCourier(bt.token)), (e) => e.status === 401);
  assert.ok(w.mails.slice(before).some((m) => m.to === "boris@example.ru" && /курьером/.test(m.subject)));
});

test("ручное назначение: курьер не видит свободные и не берёт сам; касса назначает — заказ у него", async () => {
  const w = world();
  await seed(w);
  const c = await hire(w);
  await w.set("tenants/A/sessions/s1", order());
  assert.equal((await state(w, c.token)).free.length, 1);
  await assert.rejects(call(w.api.handleAdminRates, { tenantId: "A", ratePerTrip: 0, ratePerKm: 0, dispatch: "что-то" }, { uid: "owner" }), (e) => e.status === 400);
  await call(w.api.handleAdminRates, { tenantId: "A", ratePerTrip: 150, ratePerKm: 0, dispatch: "manual" }, { uid: "owner" });
  w.api.forgetCache();
  let st = await state(w, c.token);
  assert.deepEqual([st.me.dispatch, st.free.length], ["manual", 0]);
  await assert.rejects(act(w, c.token, "take", "A", "s1"), (e) => e.status === 409 && /назначает заведение/.test(e.message));
  await call(w.api.handleAdminAssign, { tenantId: "A", s: "s1", courierId: c.id }, { uid: "owner" });
  st = await state(w, c.token);
  assert.deepEqual(st.mine.map((m) => m.s), ["s1"]);
  assert.equal((await call(w.api.handleAdminList, { tenantId: "A" }, { uid: "owner" })).body.dispatch, "manual");
});

test("демо: вход по коду демо — согласие в приложении с галочкой; новая редакция правил — согласие заново", async () => {
  const w = world();
  await seed(w);
  const c = await hire(w, { shift: false });
  await w.db.doc(`couriers/${c.id}`).update({ policyVersion: "1.0" });
  assert.equal((await state(w, c.token)).me.consent, false, "правила изменились — спросить ещё раз");
  await assert.rejects(call(w.api.handleShift, { on: true }, asCourier(c.token)), (e) => e.status === 409);
  await assert.rejects(call(w.api.handleConsent, {}, asCourier(c.token)), (e) => e.status === 400);
  await call(w.api.handleConsent, { consent_accepted: true }, asCourier(c.token));
  assert.equal((await state(w, c.token)).me.consent, true);
  assert.equal((await w.db.doc(`couriers/${c.id}`).get()).data().policyVersion, cm.POLICY_VERSION);
});

test("учётки прежних «свободных курьеров» стираются при запуске", async () => {
  const w = world();
  await w.set("couriers/f1", { root: "free", no: 1001, name: "Иванов Пётр", inn: "770000000000", phone: "79110000001" });
  await w.set("couriers/f1/payouts/p1", { amount: 100 });
  await w.set("couriers/k1", { root: "t_A", no: 1, name: "Свой" });
  assert.equal(await w.api.purgeLegacyFree(), 1);
  assert.equal((await w.db.doc("couriers/f1").get()).exists, false);
  assert.equal((await w.db.doc("couriers/f1/payouts/p1").get()).exists, false);
  assert.equal((await w.db.doc("couriers/k1").get()).exists, true);
});

test("смена: без согласия не начать; с заказами не закончить; конец смены стирает геолокацию", async () => {
  const w = world();
  await seed(w);
  const c0 = await hire(w, { name: "Оля", shift: false });
  const made = { body: { id: c0.id } };
  const token = c0.token;
  await w.db.doc(`couriers/${c0.id}`).update({ policyVersion: "0" });
  await assert.rejects(call(w.api.handleShift, { on: true }, asCourier(token)), (e) => e.status === 409 && /согласие/.test(e.message));
  await call(w.api.handleConsent, { consent_accepted: true }, asCourier(token));
  await call(w.api.handleShift, { on: true }, asCourier(token));
  await w.set("tenants/A/sessions/s1", order());
  await act(w, token, "take", "A", "s1");
  await call(w.api.handlePing, { points: [{ lat: 55.75, lng: 37.6, acc: 10, at: clock }] }, asCourier(token));
  await assert.rejects(call(w.api.handleShift, { on: false }, asCourier(token)), (e) => e.status === 409 && /завершите заказы: 1/.test(e.message));
  await act(w, token, "release", "A", "s1");
  await call(w.api.handleShift, { on: false }, asCourier(token));
  const doc = (await w.db.doc(`couriers/${made.body.id}`).get()).data();
  assert.equal(doc.onShift, false);
  assert.equal("pos" in doc, false, "вне смены геолокации нет");
});

// ---------------------------------------------------------------- путь заказа

test("заказ целиком: свободный без данных гостя → взял → забрал → у двери → вручил наличными", async () => {
  const w = world();
  await seed(w);
  const c = await hire(w);
  await w.set("tenants/A/sessions/s1", order());
  await w.set("tenants/A/sessions/new", order({ deliveryStatus: "new" }));
  await w.set("tenants/A/sessions/pick", order({ orderType: "takeaway" }));
  let st = await state(w, c.token);
  assert.equal(st.free.length, 1, "новый (не подтверждённый) и самовывоз — не для курьера");
  const f = st.free[0];
  assert.equal(f.street, "ул. Ленина, 5");
  assert.equal(f.toCollect, 750);
  assert.equal(f.ready, true);
  assert.ok(!JSON.stringify(f).match(/кв\.|79001234567|Аня|Позвоните/), "в свободных — ни квартиры, ни телефона, ни имени");
  assert.equal(st.me.no, 1);

  await act(w, c.token, "take", "A", "s1");
  let s = (await w.db.doc("tenants/A/sessions/s1").get()).data();
  assert.deepEqual([s.courierId, s.courierNo, s.courierStage, s.courierSet, s.courierName, s.courierPhone], [c.id, 1, "toVenue", true, "Николай", "79000000001"]);
  st = await state(w, c.token);
  assert.equal(st.free.length, 0);
  assert.equal(st.mine.length, 1);
  assert.equal(st.mine[0].address, "ул. Ленина, 5, кв./офис 12, подъезд 2, этаж 3, домофон 12К");
  assert.equal(st.mine[0].phone, "79001234567");
  assert.deepEqual(st.mine[0].lines, [{ name: "Том ям", qty: 1, mods: [] }], "строка «Доставка» — не блюдо");

  await act(w, c.token, "pickup", "A", "s1");
  s = (await w.db.doc("tenants/A/sessions/s1").get()).data();
  assert.deepEqual([s.deliveryStatus, s.courierStage], ["courier", "onWay"]);
  assert.equal((await act(w, c.token, "pickup", "A", "s1")).body.result, "same", "повтор из очереди без связи — не ошибка");
  await act(w, c.token, "arrive", "A", "s1");
  await assert.rejects(act(w, c.token, "deliver", "A", "s1", { method: "cash", received: 700 }), (e) => e.status === 409 && /нужно 750/.test(e.message));
  await assert.rejects(act(w, c.token, "deliver", "A", "s1", { method: "card" }), (e) => e.status === 409 && /не принимает оплату картой/.test(e.message));
  clock += 20 * 60000;
  await act(w, c.token, "deliver", "A", "s1", { method: "cash", received: 1000 });
  s = (await w.db.doc("tenants/A/sessions/s1").get()).data();
  assert.deepEqual([s.deliveryStatus, s.courierStage, s.deliveryOpen], ["done", "done", false]);
  assert.deepEqual({ ...s.courierPayment, at: 0 }, { method: "cash", amount: 750, received: 1000, change: 250, courierId: c.id, courierNo: 1, at: 0 });
  assert.equal((await act(w, c.token, "deliver", "A", "s1", { method: "cash" })).body.result, "same", "повтор вручения — без второго учёта денег");
  const me = (await w.db.doc(`couriers/${c.id}`).get()).data();
  assert.equal(me.cashOnHand, 750);
  assert.deepEqual(me.active, {});
  const calls = (await w.db.collection("tenants/A/waiterCalls").get()).docs.map((d) => d.data());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "bill");
  assert.match(calls[0].comment, /Курьер №1 получил 750.₽ наличными — пробейте чек сейчас/);
  assert.equal(calls[0].tableName, "Доставка №12");
  const trip = (await w.db.doc(`couriers/${c.id}/trips/A__s1`).get()).data();
  assert.equal(trip.result, "done");
  assert.ok(!JSON.stringify(trip).match(/Ленина|79001234567|Аня/), "в истории поездок — ни адреса, ни телефона гостя");
  st = await state(w, c.token);
  assert.deepEqual([st.stats.trips, st.stats.cashOnHand, st.stats.avgMin], [1, 750, 20]);
  assert.deepEqual(w.events.map((e) => e.text), [
    "🛵 Курьер №1 взял заказ", "📦 Курьер №1 забрал заказ — в пути", "✅ Курьер №1 вручил заказ · наличными 750 ₽",
  ].map((t) => t.replace(/ ₽/g, " ₽")));
});

test("двое жмут «Беру» одновременно — заказ достаётся одному", async () => {
  const w = world();
  await seed(w);
  const a = await hire(w, { name: "Аня" });
  const b = await hire(w, { name: "Боря" });
  await w.set("tenants/A/sessions/s1", order());
  const results = await Promise.allSettled([act(w, a.token, "take", "A", "s1"), act(w, b.token, "take", "A", "s1")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const lost = results.find((r) => r.status === "rejected");
  assert.equal(lost.reason.status, 409);
  assert.match(lost.reason.message, /другой курьер/);
  assert.equal(b.no, 2);
});

test("оплачено онлайн — денег не берут; закрыт на кассе — тоже; QR — через банк заведения", async () => {
  const w = world();
  await seed(w);
  await w.set("tenants/A/settings/delivery", { payAtDoor: { cash: false, card: true, qr: true } });
  await w.set("tenants/A/settings/integrations", { onlinePayVerified: "tinkoff|1" });
  const c = await hire(w);
  await w.set("tenants/A/sessions/paid", order({ guestPaidTotal: 750 }));
  await w.set("tenants/A/sessions/kassa", order({ status: "closed", deliveryOpen: true }));
  await w.set("tenants/A/sessions/qr", order());
  for (const s of ["paid", "kassa", "qr"]) { await act(w, c.token, "take", "A", s); await act(w, c.token, "pickup", "A", s); }
  const st = await state(w, c.token);
  assert.deepEqual(st.mine.map((m) => [m.s, m.toCollect]).sort(), [["kassa", 0], ["paid", 0], ["qr", 750]]);
  await act(w, c.token, "deliver", "A", "paid");
  assert.equal((await w.db.doc("tenants/A/sessions/paid").get()).data().courierPayment.method, "online");
  await act(w, c.token, "deliver", "A", "kassa");
  assert.equal((await w.db.doc("tenants/A/sessions/kassa").get()).data().courierPayment.method, "prepaid");
  await assert.rejects(act(w, c.token, "deliver", "A", "qr", { method: "cash" }), (e) => e.status === 409 && /наличными/.test(e.message));
  const pay = await call(w.api.handlePay, { t: "A", s: "qr" }, asCourier(c.token));
  assert.equal(pay.body.url, "https://qr.nspk.ru/AS1");
  assert.equal((await call(w.api.handlePay, { t: "A", s: "qr", paymentId: "pay1" }, asCourier(c.token))).body.status, "pending");
  await assert.rejects(act(w, c.token, "deliver", "A", "qr", { method: "qr" }), (e) => e.status === 409 && /не подтвердил/.test(e.message));
  // Банк подтвердил — оплата в счёте заказа, к получению 0.
  await w.db.doc("tenants/A/sessions/qr").update({ guestPaidTotal: 750 });
  await act(w, c.token, "deliver", "A", "qr", { method: "qr" });
  assert.equal((await w.db.doc(`couriers/${c.id}`).get()).data().cashOnHand, 0);
  assert.equal((await w.db.collection("tenants/A/waiterCalls").get()).docs.length, 0, "денег курьер не брал — сигнала «пробейте чек» от него нет");
});

test("QR у двери — только с подтверждённым банком заведения", async () => {
  const w = world();
  await seed(w);
  const c = await hire(w);
  await w.set("tenants/A/sessions/s1", order());
  await act(w, c.token, "take", "A", "s1");
  let st = await state(w, c.token);
  assert.equal(st.mine[0].payAtDoor.qr, false, "банка нет — QR не предлагаем");
  await w.set("tenants/A/settings/integrations", { onlinePayVerified: "tinkoff|1" });
  w.api.forgetCache();
  st = await state(w, c.token);
  assert.equal(st.mine[0].payAtDoor.qr, true);
});

test("не удалось вручить → ещё раз → вернул в заведение → заказ свободен для другого", async () => {
  const w = world();
  await seed(w);
  const a = await hire(w, { name: "Аня" });
  const b = await hire(w, { name: "Боря" });
  await w.set("tenants/A/sessions/s1", order());
  await act(w, a.token, "take", "A", "s1");
  await assert.rejects(act(w, a.token, "fail", "A", "s1", { reason: "no_answer" }), (e) => e.status === 409);
  await act(w, a.token, "pickup", "A", "s1");
  await assert.rejects(act(w, a.token, "fail", "A", "s1", { reason: "other" }), (e) => e.status === 400 && /двух словах/.test(e.message));
  await act(w, a.token, "fail", "A", "s1", { reason: "no_answer", note: "звонил дважды" });
  let calls = (await w.db.collection("tenants/A/waiterCalls").get()).docs.map((d) => d.data());
  assert.match(calls[0].comment, /Курьер №1: не удалось вручить — не открывают и не отвечают \(«звонил дважды»\)/);
  await act(w, a.token, "retry", "A", "s1");
  assert.equal((await w.db.doc("tenants/A/sessions/s1").get()).data().courierStage, "arrived");
  await act(w, a.token, "fail", "A", "s1", { reason: "refused" });
  await act(w, a.token, "returned", "A", "s1");
  const s = (await w.db.doc("tenants/A/sessions/s1").get()).data();
  assert.deepEqual([s.courierStage, "courierId" in s, s.courierSet, s.deliveryStatus], ["returned", false, false, "courier"]);
  assert.equal((await w.db.doc(`couriers/${a.id}/trips/A__s1`).get()).data().result, "returned");
  const st = await state(w, b.token);
  assert.equal(st.free[0].returned, true, "вернувшийся заказ — первым в списке");
  await act(w, b.token, "take", "A", "s1");
  assert.equal((await w.db.doc("tenants/A/sessions/s1").get()).data().courierStage, "toVenue", "новый курьер сначала забирает его в заведении");
  calls = (await w.db.collection("tenants/A/waiterCalls").get()).docs.map((d) => d.data());
  assert.equal(calls.length, 2);
});

test("заведение отменило заказ: до забора — пропадает у курьера; в пути — «верните в заведение»", async () => {
  const w = world();
  await seed(w);
  const c = await hire(w);
  await w.set("tenants/A/sessions/s1", order());
  await w.set("tenants/A/sessions/s2", order());
  await act(w, c.token, "take", "A", "s1");
  await act(w, c.token, "take", "A", "s2");
  await act(w, c.token, "pickup", "A", "s2");
  await w.db.doc("tenants/A/sessions/s1").update({ deliveryStatus: "cancelled", status: "cancelled" });
  await w.db.doc("tenants/A/sessions/s2").update({ deliveryStatus: "cancelled", status: "cancelled" });
  c.cache = w.api.forgetCache();
  const st = await state(w, c.token);
  assert.deepEqual(st.mine.map((m) => [m.s, m.cancelled]), [["s2", true]]);
  assert.equal((await w.db.doc("tenants/A/sessions/s1").get()).data().courierId, undefined);
  await assert.rejects(act(w, c.token, "deliver", "A", "s2", { method: "cash" }), (e) => e.status === 409 && /отменён/.test(e.message));
  await act(w, c.token, "returned", "A", "s2");
  const me = (await w.db.doc(`couriers/${c.id}`).get()).data();
  assert.deepEqual(me.active, {});
  assert.equal((await w.db.doc(`couriers/${c.id}/trips/A__s2`).get()).data().result, "cancelled");
});

// ---------------------------------------------------------------- геолокация

test("геолокация: путь копится, в заказе в пути — точка для гостя; до забора — нет; Telegram — через крючок", async () => {
  const w = world();
  await seed(w);
  const c = await hire(w);
  await w.set("tenants/A/sessions/s1", order());
  await act(w, c.token, "take", "A", "s1");
  const ping = (pts) => call(w.api.handlePing, { points: pts.map(([lat, lng, dt]) => ({ lat, lng, acc: 10, at: clock + dt })) }, asCourier(c.token));
  await ping([[55.75, 37.6, 0]]);
  assert.equal("courierPos" in (await w.db.doc("tenants/A/sessions/s1").get()).data(), false, "едет в заведение — гостю не показываем");
  await act(w, c.token, "pickup", "A", "s1");
  clock += 60000;
  await ping([[55.751, 37.6, -30000], [55.752, 37.6, 0]]);
  const s = (await w.db.doc("tenants/A/sessions/s1").get()).data();
  assert.equal(s.courierPos.lat, 55.752);
  const me = (await w.db.doc(`couriers/${c.id}`).get()).data();
  assert.ok(me.odometerM > 200 && me.odometerM < 240, `путь ${me.odometerM}`);
  assert.equal(w.moved.length, 1);
  clock += 60000;
  await act(w, c.token, "deliver", "A", "s1", { method: "cash", received: 750 });
  const trip = (await w.db.doc(`couriers/${c.id}/trips/A__s1`).get()).data();
  assert.ok(trip.distanceM > 200 && trip.distanceM < 240);
  assert.equal("courierPos" in (await w.db.doc("tenants/A/sessions/s1").get()).data(), false, "вручён — точку стёрли");
});

test("координаты точки — по тому, где курьеры забирают заказы (медиана)", async () => {
  const w = world();
  await seed(w);
  const c = await hire(w);
  const spots = [[55.7601, 37.6101], [55.7602, 37.6102], [55.7999, 37.6999], [55.7603, 37.6103]];
  for (const [i, [lat, lng]] of spots.entries()) {
    await w.set(`tenants/A/sessions/p${i}`, order());
    await act(w, c.token, "take", "A", `p${i}`);
    await call(w.api.handlePing, { points: [{ lat, lng, acc: 15, at: clock }] }, asCourier(c.token));
    await act(w, c.token, "pickup", "A", `p${i}`);
    clock += 1000;
  }
  const d = (await w.db.doc("tenants/A/settings/delivery").get()).data();
  assert.deepEqual(d.venuePos, { lat: 55.7603, lng: 37.6103 });
  assert.equal(d.pickupPoints.length, 4);
});

// ---------------------------------------------------------------- сети

test("сеть: курьер точки видит и берёт только её заказы; права администратора точки и владельца сети", async () => {
  const w = world();
  await seed(w);
  // Администратор точки N1 заводит курьера — только на свою точку.
  const own = await hire(w, { tenantId: "N1", uid: "pointadmin", name: "Свой", points: ["N1", "N2"] });
  const ownDoc = (await w.db.doc(`couriers/${own.id}`).get()).data();
  assert.deepEqual([ownDoc.root, ownDoc.points], ["c_N", ["N1"]]);
  // Владелец сети — курьера на все точки.
  const all = await hire(w, { tenantId: "N2", uid: "chainowner", name: "Общий" });
  assert.deepEqual((await w.db.doc(`couriers/${all.id}`).get()).data().points, []);
  assert.equal(all.no, 2, "номера — общие на сеть");
  await w.set("tenants/N1/sessions/a", order({ orderNo: 1 }));
  await w.set("tenants/N2/sessions/b", order({ orderNo: 2 }));
  assert.deepEqual((await state(w, own.token)).free.map((f) => f.point.name), ["Сеть · Центр"]);
  assert.deepEqual((await state(w, all.token)).free.map((f) => f.point.name).sort(), ["Сеть · Север", "Сеть · Центр"]);
  await assert.rejects(act(w, own.token, "take", "N2", "b"), (e) => e.status === 403);
  // Общий курьер везёт заказы двух точек за одну поездку.
  await act(w, all.token, "take", "N1", "a");
  await act(w, all.token, "take", "N2", "b");
  assert.equal((await state(w, all.token)).mine.length, 2);
  // Администратор точки не меняет общего курьера сети и не видит его на чужой точке.
  await assert.rejects(call(w.api.handleAdminSave, { tenantId: "N1", courier: { id: all.id, name: "Хак", email: "hack@example.ru", transport: "car" } }, { uid: "pointadmin" }), (e) => e.status === 403);
  const listPoint = (await call(w.api.handleAdminList, { tenantId: "N1" }, { uid: "pointadmin" })).body;
  assert.deepEqual(listPoint.couriers.map((c) => [c.no, c.editable]), [[1, true], [2, false]]);
  assert.deepEqual(listPoint.orders.map((o) => o.point), ["Сеть · Центр"], "администратор точки видит заказы своей точки");
  const listChain = (await call(w.api.handleAdminList, { tenantId: "N1" }, { uid: "chainowner" })).body;
  assert.equal(listChain.full, true);
  assert.equal(listChain.orders.length, 2);
  // Ставки — только владелец сети.
  await assert.rejects(call(w.api.handleAdminRates, { tenantId: "N1", ratePerTrip: 100, ratePerKm: 10 }, { uid: "pointadmin" }), (e) => e.status === 403);
  await call(w.api.handleAdminRates, { tenantId: "N1", ratePerTrip: 100, ratePerKm: 10 }, { uid: "chainowner" });
  await assert.rejects(call(w.api.handleAdminList, { tenantId: "A" }, { uid: "chainowner" }), (e) => e.status === 403, "чужое заведение");
});

test("заработок: ставка за доставку + за километр; отчёт за сутки без данных гостей", async () => {
  const w = world();
  await seed(w);
  const c = await hire(w);
  await call(w.api.handleAdminRates, { tenantId: "A", ratePerTrip: 150, ratePerKm: 20 }, { uid: "owner" });
  await w.set("tenants/A/sessions/s1", order());
  await act(w, c.token, "take", "A", "s1");
  await act(w, c.token, "pickup", "A", "s1");
  const ping = (lat, dt) => call(w.api.handlePing, { points: [{ lat, lng: 37.6, acc: 10, at: clock + dt }] }, asCourier(c.token));
  await ping(55.75, 0);
  clock += 5 * 60000;
  await ping(55.77, 0); // ~2,2 км
  await act(w, c.token, "deliver", "A", "s1", { method: "cash", received: 750 });
  const trip = (await w.db.doc(`couriers/${c.id}/trips/A__s1`).get()).data();
  assert.equal(trip.earned, Math.round(150 + (20 * trip.distanceM) / 1000));
  const rep = (await call(w.api.handleAdminReport, { tenantId: "A", day: trip.day }, { uid: "owner" })).body;
  assert.equal(rep.rows.length, 1);
  assert.equal(rep.rows[0].trips, 1);
  assert.equal(rep.rows[0].cash, 750);
  assert.ok(!JSON.stringify(rep).match(/Ленина|79001234567|Аня/));
});

// ---------------------------------------------------------------- кабинет и бот

test("назначение: только курьер на смене и своей точки; можно передать другому до забора; снять", async () => {
  const w = world();
  await seed(w);
  const a = await hire(w, { name: "Аня" });
  const b = await hire(w, { name: "Боря", shift: false });
  await w.set("tenants/A/sessions/s1", order());
  await assert.rejects(call(w.api.handleAdminAssign, { tenantId: "A", s: "s1", courierId: b.id }, { uid: "owner" }), (e) => e.status === 409 && /не на смене/.test(e.message));
  await call(w.api.handleShift, { on: true }, asCourier(b.token));
  await call(w.api.handleAdminAssign, { tenantId: "A", s: "s1", courierId: a.id }, { uid: "owner" });
  assert.equal((await w.db.doc("tenants/A/sessions/s1").get()).data().courierAssignedBy, "owner");
  await call(w.api.handleAdminAssign, { tenantId: "A", s: "s1", courierId: b.id }, { uid: "owner" });
  assert.equal((await w.db.doc("tenants/A/sessions/s1").get()).data().courierId, b.id);
  assert.equal((await w.db.doc(`couriers/${a.id}/trips/A__s1`).get()).exists, false, "у первого поездки больше нет");
  assert.deepEqual((await w.db.doc(`couriers/${a.id}`).get()).data().active, {});
  // Через бота — то же.
  assert.deepEqual((await w.api.onShiftFor("A")).map((x) => [x.no, x.busy]), [[1, 0], [2, 1]]);
  await w.set("tenants/A/sessions/s2", order());
  await w.api.assignFromBot("A", "s2", a.id);
  assert.equal((await w.db.doc("tenants/A/sessions/s2").get()).data().courierAssignedBy, "telegram");
  // Снять, пока не забрал.
  await call(w.api.handleAdminAssign, { tenantId: "A", s: "s2", courierId: null }, { uid: "owner" });
  assert.equal((await w.db.doc("tenants/A/sessions/s2").get()).data().courierId, undefined);
  await act(w, b.token, "pickup", "A", "s1");
  await assert.rejects(call(w.api.handleAdminAssign, { tenantId: "A", s: "s1", courierId: null }, { uid: "owner" }), (e) => e.status === 409);
});

test("отключение курьера: вход закрыт, незабранные заказы свободны; в пути — сначала вручить", async () => {
  const w = world();
  await seed(w);
  const c = await hire(w);
  await w.set("tenants/A/sessions/s1", order());
  await w.set("tenants/A/sessions/s2", order());
  await act(w, c.token, "take", "A", "s1");
  await act(w, c.token, "take", "A", "s2");
  await act(w, c.token, "pickup", "A", "s2");
  await assert.rejects(call(w.api.handleAdminEnable, { tenantId: "A", courierId: c.id, enabled: false }, { uid: "owner" }), (e) => e.status === 409 && /в пути: 1/.test(e.message));
  await act(w, c.token, "deliver", "A", "s2", { method: "cash", received: 750 });
  await assert.rejects(call(w.api.handleAdminForget, { tenantId: "A", courierId: c.id }, { uid: "owner" }), (e) => e.status === 409 && /отключите/.test(e.message));
  await call(w.api.handleAdminEnable, { tenantId: "A", courierId: c.id, enabled: false }, { uid: "owner" });
  assert.equal((await w.db.doc("tenants/A/sessions/s1").get()).data().courierId, undefined, "незабранный — свободен");
  await assert.rejects(call(w.api.handleState, {}, asCourier(c.token)), (e) => e.status === 401);
  await assert.rejects(call(w.api.handleAdminWelcome, { tenantId: "A", courierId: c.id }, { uid: "owner" }), (e) => e.status === 409);
  // Наличные сдал — долг закрыт; больше, чем на руках, — нельзя.
  await assert.rejects(call(w.api.handleAdminForget, { tenantId: "A", courierId: c.id }, { uid: "owner" }), (e) => e.status === 409 && /наличные/.test(e.message));
  await assert.rejects(call(w.api.handleAdminCash, { tenantId: "A", courierId: c.id, amount: 800 }, { uid: "owner" }), (e) => e.status === 409);
  const r = await call(w.api.handleAdminCash, { tenantId: "A", courierId: c.id, amount: 750 }, { uid: "owner" });
  assert.equal(r.body.cashOnHand, 0);
  const ledger = (await w.db.collection(`couriers/${c.id}/cash`).get()).docs.map((d) => d.data().type).sort();
  assert.deepEqual(ledger, ["collect", "handover"]);
  // Ушёл совсем — имя и телефон стираются, поездки остаются за номером.
  await call(w.api.handleAdminForget, { tenantId: "A", courierId: c.id }, { uid: "owner" });
  const gone = (await w.db.doc(`couriers/${c.id}`).get()).data();
  assert.deepEqual([gone.name, gone.phone, "consentAt" in gone], ["Курьер №1", "", false]);
  assert.equal((await w.db.doc(`couriers/${c.id}/trips/A__s2`).get()).data().result, "done");
});

test("сторож: курьер пропал на 15 минут — незабранные заказы свободны; забранные остаются", async () => {
  const w = world();
  await seed(w);
  const c = await hire(w);
  await w.set("tenants/A/sessions/s1", order());
  await w.set("tenants/A/sessions/s2", order());
  await act(w, c.token, "take", "A", "s1");
  await act(w, c.token, "take", "A", "s2");
  await act(w, c.token, "pickup", "A", "s2");
  clock += 16 * 60000;
  await w.api.sweep();
  assert.equal((await w.db.doc("tenants/A/sessions/s1").get()).data().courierId, undefined);
  assert.equal((await w.db.doc("tenants/A/sessions/s2").get()).data().courierId, c.id);
  assert.match(w.events.at(-1).text, /Курьер №1 не на связи 16 мин — заказ снова свободен/);
});

test("режим РФ: адрес и телефон — из справочника; имя курьера — туда же, не в заказ", async () => {
  const w = world({ rf: true });
  await seed(w);
  const c = await hire(w);
  w.piiStore.set("A:s1", { address: "ул. Мира, 7, кв./офис 3", phone: "79005556677", name: "Гость", extra: { comment: "Код 12" } });
  await w.set("tenants/A/sessions/s1", order({ deliveryAddress: undefined, customerPhone: undefined, customerName: undefined, deliveryComment: undefined }));
  let st = await state(w, c.token);
  assert.equal(st.free[0].street, "ул. Мира, 7");
  await act(w, c.token, "take", "A", "s1");
  const s = (await w.db.doc("tenants/A/sessions/s1").get()).data();
  assert.equal("courierName" in s, false);
  assert.deepEqual(w.piiStore.get("A:s1").extra, { comment: "Код 12", courierName: "Николай", courierPhone: "79000000001" });
  st = await state(w, c.token);
  assert.deepEqual([st.mine[0].phone, st.mine[0].comment], ["79005556677", "Код 12"]);
});

test("состояние: тот же ответ — коротко «без изменений»; кабинет видит курьеров и заказы", async () => {
  const w = world();
  await seed(w);
  const c = await hire(w);
  await w.set("tenants/A/sessions/s1", order());
  const first = await state(w, c.token);
  const again = (await call(w.api.handleState, { v: first.v }, asCourier(c.token))).body;
  assert.deepEqual(Object.keys(again).sort(), ["same", "serverTime", "v"]);
  const list = (await call(w.api.handleAdminList, { tenantId: "A" }, { uid: "owner" })).body;
  assert.deepEqual(list.couriers.map((x) => [x.no, x.name, x.onShift, x.linked]), [[1, "Николай Петров", true, true]]);
  assert.deepEqual(list.orders.map((o) => [o.no, o.free, o.toCollect]), [["12", true, 750]]);
  await assert.rejects(call(w.api.handleAdminList, { tenantId: "A" }, { uid: "stranger" }), (e) => e.status === 403);
});

test("демо: вход по коду демо-сети, заказы обеих точек, сброс демо стирает курьеров", async () => {
  const w = world();
  await seed(w);
  const exp = Timestamp.fromMillis(clock + 3 * 86400000);
  await w.set("tenants/N1", { name: "Демо · Центр", chainId: "N", timezone: "Europe/Moscow", status: "active", demo: true, demoCode: "demo-ab12cd34", demoExpiresAt: exp, createdAt: Timestamp.fromMillis(1) });
  await w.set("tenants/N2", { name: "Демо · Набережная", chainId: "N", timezone: "Europe/Moscow", status: "active", demo: true, demoCode: "demo-ab12cd34", demoExpiresAt: exp, createdAt: Timestamp.fromMillis(2) });
  await w.set("tenants/N2/sessions/s9", order());
  // неверный и чужой (не демо) код — отказ и учёт в щите
  await assert.rejects(call(w.api.handleDemoLogin, { code: "demo-zzzz0000" }), (e) => e.status === 404);
  await assert.rejects(call(w.api.handleDemoLogin, { code: "../x" }), (e) => e.status === 404);
  assert.equal(w.fails.length, 2);
  const r = await call(w.api.handleDemoLogin, { code: " DEMO-ab12cd34 ", device: "Android" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.courier, { no: 1, name: "Демо" });
  const two = (await call(w.api.handleDemoLogin, { code: "demo-ab12cd34" })).body;
  assert.equal(two.courier.no, 2);
  await call(w.api.handleConsent, { consent_accepted: true }, asCourier(r.body.token));
  await call(w.api.handleShift, { on: true }, asCourier(r.body.token));
  const st = (await call(w.api.handleState, {}, asCourier(r.body.token))).body;
  assert.equal(st.me.points.length, 2);
  assert.deepEqual(st.free.map((f) => f.key), ["N2__s9"]);
  // демо истекло — новый вход закрыт
  clock += 4 * 86400000;
  await assert.rejects(call(w.api.handleDemoLogin, { code: "demo-ab12cd34" }), (e) => e.status === 404);
  assert.equal(await w.api.purgeRoot("c_N"), 2);
  assert.equal((await w.db.collection("couriers").where("root", "==", "c_N").get()).docs.length, 0);
  assert.equal((await w.db.doc("courierSettings/c_N").get()).exists, false);
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
  console.log(`courier: ${n} из ${tests.length} проверок`);
  process.exit();
})();
