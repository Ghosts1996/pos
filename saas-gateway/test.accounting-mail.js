"use strict";
// Обмен с 1С без файлов (accounting-mail.js): периоды «вчера / прошлая
// неделя / прошлый месяц» по поясу заведения; письмо бухгалтеру с книгой
// Excel один раз за период и не раньше 7:00; права; адрес для 1С
// /api/v1/accounting по ключу открытого API — те же суммы, что в листах «1С».
const assert = require("assert/strict");
const admin = require("firebase-admin");
const { createLocalDb } = require("./local-db");
const { HttpError } = require("./test-helpers");
const M = require("./accounting-mail");
const api = require("./open-api");

const TID = "t1";
const store = createLocalDb({ admin });
let clock = Date.UTC(2026, 11, 1, 6, 30); // 1 декабря 09:30 по Москве
const sent = [];
const mailer = { send: async (m) => { sent.push(m); } };
const roles = { [`${TID}_owner`]: "owner", [`${TID}_cook`]: "employee" };
const deps = {
  db: () => store, admin, now: () => clock, HttpError,
  verifyAuth: async (req) => ({ uid: req.uid }), parseJsonBody: async (req) => req.body || {},
  sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
  requireTenantRole: async (tid, uid, r) => { if (!r.includes(roles[`${tid}_${uid}`])) throw new HttpError(403, "Недостаточно прав"); },
  getMailer: () => mailer,
};
const lib = M.createAccountingMail(deps);
const call = async (uid, body) => {
  const res = {};
  try { await lib.handle({ uid, body: { tenantId: TID, ...body } }, res); } catch (e) { res.code = e.status; res.body = { error: e.message }; }
  return res;
};
const ts = (ms) => admin.firestore.Timestamp.fromMillis(ms);
const msk = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h - 3);

(async () => {
  // Периоды
  const tz = "Europe/Moscow";
  let p = M.lastPeriod("day", msk(2026, 12, 1, 9), tz);
  assert.equal(p.key, "day:2026-11-30");
  assert.equal(p.from, msk(2026, 11, 30, 0));
  assert.equal(p.to, msk(2026, 12, 1, 0));
  p = M.lastPeriod("week", msk(2026, 12, 2, 9), tz); // среда
  assert.equal(p.key, "week:2026-11-23");
  assert.equal(p.label, "23.11.2026 — 29.11.2026");
  p = M.lastPeriod("month", msk(2026, 12, 1, 9), tz);
  assert.equal(p.key, "month:2026-11-01");
  assert.equal(p.label, "ноябрь 2026");
  assert.equal(M.lastPeriod("month", msk(2027, 1, 3, 9), tz).key, "month:2026-12-01", "январь → декабрь прошлого года");
  assert.equal(M.lastPeriod("day", Date.UTC(2026, 10, 30, 20, 30), "Asia/Novosibirsk").key, "day:2026-11-30", "в Новосибирске уже 1 декабря");

  // Данные: два чека в ноябре, один в декабре, один учебный.
  await store.doc(`tenants/${TID}`).set({ name: "Кафе «Тест»", status: "active" });
  await store.doc(`tenants/${TID}/settings/general`).set({ timezone: tz });
  await store.doc(`tenants/${TID}/menuItems/m1`).set({ name: "Суп", price: 350, vat: "vat22" });
  await store.doc(`tenants/${TID}/menuItems/m2`).set({ name: "Доставка", price: 200, fiscalSubject: "service" });
  const s = (id, ms, extra) => store.doc(`tenants/${TID}/sessions/${id}`).set({ status: "closed", closedAt: ts(ms), tableName: "1", ...extra });
  await s("a", msk(2026, 11, 10), { orderItems: [{ menuItemId: "m1", name: "Суп", price: 350, qty: 2 }], paymentCash: 700, customerPhone: "+79001112233" });
  await s("b", msk(2026, 11, 11), { orderItems: [{ menuItemId: "m1", name: "Суп", price: 350, qty: 1 }, { menuItemId: "m2", name: "Доставка", price: 200, qty: 1 }], discountPercent: 10, paymentCard: 515 });
  await s("c", msk(2026, 12, 1, 1), { orderItems: [{ menuItemId: "m1", name: "Суп", price: 350, qty: 1 }], paymentCash: 350 });
  await s("t", msk(2026, 11, 12), { orderItems: [{ menuItemId: "m1", name: "Суп", price: 350, qty: 5 }], paymentCash: 1750, training: true });

  // Права и проверка почты
  assert.equal((await call("cook", { action: "get" })).code, 403);
  assert.equal((await call("owner", { action: "settings", enabled: true, email: "не почта", period: "month" })).code, 400);
  let r = await call("owner", { action: "settings", enabled: true, email: "Buh@Example.ru", period: "month" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.email, "buh@example.ru");
  assert.equal(r.body.mailReady, true);

  // Раньше 7:00 — не шлём; в 9:30 — шлём за ноябрь, один раз.
  clock = msk(2026, 12, 1, 6);
  assert.equal(await lib.runAll(), 0);
  clock = msk(2026, 12, 1, 9);
  assert.equal(await lib.runAll(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "buh@example.ru");
  assert.match(sent[0].subject, /Кафе «Тест»: выгрузка для бухгалтера и 1С — ноябрь 2026/);
  assert.match(sent[0].text, /чеков 2, выручка 1\s195 ₽/);
  const file = sent[0].attachments[0];
  assert.match(file.filename, /2026-11-01 — для бухгалтера\.xlsx$/);
  assert.equal(file.content.subarray(0, 2).toString(), "PK", "xlsx — это zip");
  assert.ok(file.content.includes(Buffer.from("1С — розничные продажи")), "листы для 1С в книге");
  assert.ok(!file.content.includes(Buffer.from("79001112233")), "телефона гостя в книге нет");
  clock = msk(2026, 12, 1, 15);
  assert.equal(await lib.runAll(), 0, "второй раз за ноябрь не шлём");
  assert.equal((await call("owner", { action: "get" })).body.lastLabel, "ноябрь 2026");

  // «Отправить сейчас» — вручную, за выбранный период.
  r = await call("owner", { action: "send", period: "day" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.label, "30.11.2026");
  assert.equal(sent.length, 2);

  // Нет почты сервера — понятная ошибка, а в журнал задачи — причина.
  const noMail = M.createAccountingMail({ ...deps, getMailer: () => null });
  const res = {};
  await assert.rejects(noMail.handle({ uid: "owner", body: { tenantId: TID, action: "send" } }, res), /Почта сервера не настроена/);

  // 1С по ключу открытого API.
  const oa = api.createOpenApi({ ...deps, writeAuditLog: async () => {}, clientIp: () => "1.1.1.1",
    requireTenantRole: async () => {} });
  const keyRes = {};
  await oa.handleKeys({ uid: "owner", body: { tenantId: TID, action: "create", name: "1С" } }, keyRes);
  const key = keyRes.body.key;
  const out = {};
  await oa.handleApi({ method: "GET", url: "/api/v1/accounting?from=2026-11-01&to=2026-11-30", headers: { authorization: `Bearer ${key}` } }, out, "/api/v1/accounting");
  assert.equal(out.code, 200, JSON.stringify(out.body));
  const d = out.body.data;
  assert.deepEqual(d.retail.map((x) => [x.date, x.name, x.qty, x.sum, x.vat, x.kind]),
    [["10.11.2026", "Суп", 2, 700, "22%", "goods"], ["11.11.2026", "Доставка", 1, 180, null, "service"], ["11.11.2026", "Суп", 1, 315, "22%", "goods"]]);
  assert.deepEqual(d.payments.map((x) => [x.date, x.cash, x.cashless, x.total]), [["10.11.2026", 700, 0, 700], ["11.11.2026", 0, 515, 495]]);
  assert.equal(d.payments.reduce((a, x) => a + x.total, 0), d.retail.reduce((a, x) => a + x.sum, 0), "оплаты по дням = продажи");
  assert.ok(!JSON.stringify(d).includes("79001112233"));
  assert.ok(!JSON.stringify(d).includes("12.11.2026"), "учебный чек не попал");
  console.log("accounting-mail: ok");
})().catch((e) => { console.error(e); process.exit(1); });
