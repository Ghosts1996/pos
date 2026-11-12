"use strict";
/**
 * Свободный курьер в браузере (Playwright), как на телефоне: стенд = модуль
 * курьера + своя база (local-db) + файлы courier-web. Не входит в npm test:
 *   NODE_PATH=<где playwright> node e2e-courier-free.js [--shots папка]
 * Путь: ссылка заведения → «Стать курьером» → ошибки формы → регистрация →
 * карточка заведения → «Хочу возить» → заведение одобряет → линия → заказ →
 * «Беру» → «Забрал» → «Вручил» → доход и долг заведения → выплата → выход →
 * вход по паролю → забыли пароль → удаление учётной записи.
 */
const http = require("http");
const path = require("path");
const assert = require("assert/strict");
const { chromium } = require("playwright");
const { createLocalDb } = require("./local-db");
const { createCourier } = require("./courier");
const { createCourierWeb } = require("./courier-web");

class Timestamp {
  constructor(ms) { this._ms = ms; }
  toMillis() { return this._ms; }
  toDate() { return new Date(this._ms); }
  static now() { return new Timestamp(Date.now()); }
  static fromMillis(ms) { return new Timestamp(ms); }
}
class FieldValue {
  constructor(methodName, operand) { this.methodName = methodName; this.operand = operand; }
  static delete() { return new FieldValue("FieldValue.delete"); }
  static increment(n) { return new FieldValue("FieldValue.increment", n); }
}
const admin = { firestore: { Timestamp, FieldValue } };
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const shotsDir = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? process.argv[i + 1] : ""; })();
const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `free-${name}.png`), fullPage: false }); };

function inn12(first10) {
  const d = String(first10).split("").map(Number);
  const k = (w) => w.reduce((a, x, i) => a + x * d[i], 0) % 11 % 10;
  d.push(k([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]));
  d.push(k([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]));
  return d.join("");
}

async function main() {
  const db = createLocalDb({ admin });
  const mails = [];
  const acts = [];
  const api = createCourier({
    db: () => db, admin, HttpError, publicUrl: "http://127.0.0.1:0/saas",
    verifyAuth: async () => ({ uid: "owner" }),
    parseJsonBody: (req) => new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => { b += c; });
      req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch (_) { resolve({}); } });
    }),
    sendJson: (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); },
    requireTenantRole: async () => {},
    requireChainRole: async () => { throw new HttpError(403, "нет"); },
    npd: { check: async () => ({ ok: true, message: "является плательщиком НПД", at: Date.now() }) },
  });
  api.setHooks({
    mailer: () => ({ send: async (m) => { mails.push(m); } }),
    papers: { destruction: async (items, opts) => { acts.push({ items, opts }); } },
  });
  const F = api.free;
  const web = createCourierWeb();
  const routes = {
    login: api.handleLogin, consent: api.handleConsent, state: api.handleState, shift: api.handleShift, act: api.handleAct,
    ping: api.handlePing, pay: api.handlePay, logout: api.handleLogout, history: api.handleHistory, route: api.handleRoute,
    register: F.handleRegister, signin: F.handleSignin, reset: F.handleReset, "reset-confirm": F.handleResetConfirm,
    "free/profile": F.handleProfile, "free/update": F.handleUpdate, "free/recheck": F.handleRecheck, "free/nearby": F.handleNearby,
    "free/venue": F.handleVenue, "free/apply": F.handleApply, "free/leave": F.handleLeave, "free/delete": F.handleDelete,
  };
  const server = http.createServer((req, res) => {
    const p = req.url.split("?")[0].replace(/^\/saas/, "");
    if (req.method === "POST" && p.startsWith("/courier/api/")) {
      const h = routes[p.slice(13)];
      if (!h) { res.writeHead(404); return res.end("{}"); }
      return h(req, res).catch((e) => { res.writeHead(e.status || 500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    }
    if (p.startsWith("/courier/")) return web.serve(req, res, p.slice(9));
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/saas/courier/`;

  const T = (ms) => Timestamp.fromMillis(ms);
  await db.doc("tenants/A").set({ name: "Кафе «Лето»", timezone: "Europe/Moscow", status: "active", createdAt: T(1) });
  await db.doc("tenants/A/meta/venueProfile").set({ address: "Москва, Тверская, 1" });
  await db.doc("tenants/A/settings/delivery").set({ payAtDoor: { cash: true, card: true, qr: true } });
  const call = (fn, body) => new Promise((resolve, reject) => {
    const res = { writeHead(s) { this.s = s; }, end(b) { const j = JSON.parse(b); this.s >= 400 ? reject(new Error(j.error)) : resolve(j); } };
    const req = new (require("stream").Readable)({ read() {} });
    req.push(JSON.stringify(body)); req.push(null); req.headers = {};
    fn(req, res).catch(reject);
  });
  // Заведение включает свободных курьеров: место на карте, ставка, «по заявке».
  await call(F.handleAdminPos, { tenantId: "A", lat: 55.7605, lng: 37.6110 });
  await call(F.handleAdminSave, { tenantId: "A", on: true, mode: "approved", ratePerTrip: 250, ratePerKm: 0, radiusKm: 5, delayMin: 0, agree: true });
  const link = (await call(F.handleAdminGet, { tenantId: "A" })).link;
  assert.match(link, /#v=t_A$/);

  const order = (no, over = {}) => ({
    tableId: "takeaway", status: "active", orderType: "delivery", orderNo: no, source: "app",
    deliveryStatus: "cooking", startTime: T(Date.now() - 7 * 60000),
    deliveryAddress: "ул. Ленина, 5, кв./офис 12, подъезд 2", customerPhone: "79001234567", customerName: "Анна",
    orderItems: [
      { menuItemId: "soup", name: "Том ям", price: 640, qty: 1, ready: 1 },
      { menuItemId: "zalpos_delivery", name: "Доставка", price: 150, qty: 1, noPromo: true, kind: "kitchen", ready: 1 },
    ],
    delivery: { fee: 150, etaMin: 60 }, guestPaidTotal: 790,
    ...over,
  });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ru-RU",
    geolocation: { latitude: 55.7600, longitude: 37.6100, accuracy: 12 }, permissions: ["geolocation"],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  const text = () => page.evaluate(() => document.body.innerText);
  const see = async (re, ms = 8000) => {
    await page.waitForFunction((src) => new RegExp(src, "i").test(document.body.innerText), re.source, { timeout: ms })
      .catch(async () => { throw new Error(`на экране нет «${re.source}»:\n${(await text()).slice(0, 700)}`); });
  };
  const tap = (sel) => page.locator(sel).first().click();

  // 1. По ссылке заведения — экран входа с двумя путями.
  await page.goto(`${base}${link.slice(link.indexOf("#"))}`);
  await see(/Стать курьером/);
  await see(/откроется заведение, которое дало вам ссылку/);
  await shot(page, "01-вход");

  // 2. Регистрация: ошибки не стирают введённое.
  await tap('[data-a="auth"][data-mode="register"]');
  await see(/Регистрация курьера/);
  await page.fill("#r-name", "Иванов Пётр Сергеевич");
  await page.fill("#r-phone", "8 911 000 00 01");
  await page.fill("#r-email", "petr@example.ru");
  await page.fill("#r-pass", "123");
  await page.fill("#r-inn", "123456789012");
  await tap('[data-a="register"]');
  await see(/Пароль — не короче 8 символов/);
  assert.equal(await page.inputValue("#r-name"), "Иванов Пётр Сергеевич", "форма не сбросилась");
  await page.fill("#r-pass", "Kurier-2026");
  await tap('[data-a="register"]');
  await see(/Проверьте ИНН/);
  await page.fill("#r-inn", inn12("7707123456"));
  await tap('[data-a="register"]');
  await see(/на чём возите/i);
  await page.check('input[name="r-tr"][value="bike"]');
  await tap('[data-a="register"]');
  await see(/18 лет/);
  await page.check("#r-adult");
  await page.check("#r-med");
  await page.check("#r-rules");
  await tap('[data-a="register"]');
  await see(/согласие на обработку/i);
  await shot(page, "02-регистрация");
  // Условия открываются поверх формы — введённое не теряется.
  await tap('.tick [data-a="rules"]');
  await see(/Нажав «Беру», вы заключаете с заведением договор/);
  await shot(page, "02b-условия");
  await tap('[data-m="close"]');
  assert.equal(await page.inputValue("#r-name"), "Иванов Пётр Сергеевич", "форма на месте после условий");
  assert.ok(await page.isChecked("#r-adult"));
  await page.check("#r-pd");
  await tap('[data-a="register"]');

  // 3. Сразу — карточка заведения по ссылке.
  await see(/По ссылке заведения/);
  await see(/Кафе «Лето»/);
  await see(/250.₽ за доставку/);
  await shot(page, "03-заведение");
  await tap('[data-a="apply"]');
  await see(/Заявка ждёт ответа/);
  const cab = await call(F.handleAdminGet, { tenantId: "A" });
  assert.equal(cab.couriers.length, 1);
  assert.deepEqual([cab.couriers[0].name, cab.couriers[0].st, cab.couriers[0].tax.ok], ["Иванов Пётр Сергеевич", "pending", true]);
  const courierId = cab.couriers[0].id;

  // 4. Заказы: пока заявку не приняли — подсказка.
  await tap('.bnav [data-view="orders"]');
  await see(/Заявка отправлена/);
  await shot(page, "04-ждём");
  await call(F.handleAdminDecide, { tenantId: "A", courierId, decision: "approve" });
  await db.doc("tenants/A/sessions/s1").set(order(31));
  await db.doc("tenants/A/sessions/cash").set(order(32, { guestPaidTotal: 0 })); // не оплачен, QR нет — не покажем
  api.forgetCache();
  await tap('.bnav [data-view="profile"]');
  await see(/Самозанятый/);
  await see(/Подтверждён/);
  await see(/Работаю/);
  await shot(page, "05-профиль");

  // 5. На линию → заказ → весь путь.
  await tap('.bnav [data-view="orders"]');
  await see(/Вы не на линии/);
  await tap('.online-card [data-a="shift"]');
  await see(/На линии/);
  await see(/Беру заказ/, 30000);
  await shot(page, "06-заказ");
  const body1 = await text();
  assert.match(body1, /250.₽/, "цена доставки видна до «Беру»");
  assert.match(body1, /Оплачен/);
  assert.ok(!/№32/.test(body1), "неоплаченный заказ без QR свободному не показан");
  assert.ok(!/кв\.\/офис 12/.test(body1), "квартира — только после «Беру»");
  await tap('[data-a="take"]');
  await see(/Забрал заказ/);
  await shot(page, "07-взял");
  const s1 = (await db.doc("tenants/A/sessions/s1").get()).data();
  assert.deepEqual([s1.courierFree, s1.courierNo, s1.courierStage], [true, 1001, "toVenue"]);
  await tap('[data-a="pickup"]');
  await see(/На месте/);
  const onWay = await text();
  assert.match(onWay, /кв\.\/офис 12/, "полный адрес — после «Забрал»");
  await shot(page, "07b-в-пути");
  await tap('[data-a="arrive"]');
  await see(/Вручил/);
  await tap('.main-act [data-a="deliver"]');
  await page.waitForTimeout(500);
  await shot(page, "07c-вручение");
  if (await page.locator('[data-m="deliver"]').count()) await tap('[data-m="deliver"]');
  await page.waitForFunction(() => !/Забрал|Вручил заказ/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
  for (let i = 0; i < 40; i++) {
    if (((await db.doc("tenants/A/sessions/s1").get()).data() || {}).courierStage === "done") break;
    await page.waitForTimeout(250);
  }
  const done = (await db.doc("tenants/A/sessions/s1").get()).data();
  assert.deepEqual([done.deliveryStatus, done.courierStage, done.courierPayment.method], ["done", "done", "online"]);
  assert.equal((await db.doc(`couriers/${courierId}`).get()).data().owed.t_A, 250);

  // 6. Доход: долг заведения, потом выплата.
  await tap('.bnav [data-view="income"]');
  await see(/К выплате от заведений/);
  await see(/Кафе «Лето»/);
  await see(/выдайте заведению чек/);
  await shot(page, "08-доход");
  await call(F.handleAdminPaid, { tenantId: "A", courierId, amount: 250 });
  await tap('.bnav [data-view="orders"]');
  await tap('.bnav [data-view="income"]');
  await see(/Выплаты/);
  await see(/заведение отметило выплату/);
  await see(/ничего не должны/);
  await shot(page, "09-выплата");

  // 7. Смена, выход, вход по паролю.
  await tap('.bnav [data-view="profile"]');
  await tap('[data-a="shift-end"]');
  await tap('[data-m="shift-off"]');
  await see(/Не на линии/);
  await tap('[data-a="logout"]');
  await see(/понадобятся телефон и пароль/);
  await tap('[data-m="logout"]');
  await see(/Стать курьером/);
  await tap('[data-a="auth"][data-mode="signin"]');
  await page.fill("#s-phone", "+7 911 000-00-01");
  await page.fill("#s-pass", "не тот пароль");
  await tap('[data-a="signin"]');
  await see(/Неверный телефон или пароль/);
  await shot(page, "10-вход-ошибка");

  // 8. Забыли пароль: код из письма.
  await tap('[data-a="auth"][data-mode="reset"]');
  await page.fill("#p-phone", "+7 911 000-00-01");
  await tap('[data-a="reset"]');
  await see(/Код отправлен на почту/);
  assert.equal(mails.length, 1);
  const code = /Код: (\d{6})/.exec(mails[0].text)[1];
  await page.fill("#p-code", code);
  await page.fill("#p-pass", "Novyi-parol-77");
  await tap('[data-a="reset-confirm"]');
  await see(/Свободных заказов нет|Вы не на линии/);
  await shot(page, "11-после-сброса");

  // 9. Заведения: рядом, уйти и вернуться.
  await tap('.bnav [data-view="venues"]');
  await see(/Рядом со мной/);
  await see(/Кафе «Лето»/, 20000);
  await see(/от вас/);
  await shot(page, "12-рядом");

  // 10. Страница условий открывается.
  const rules = await ctx.newPage();
  await rules.goto(`${base}rules.html`);
  assert.match(await rules.evaluate(() => document.body.innerText), /Нажав «Беру», вы заключаете с заведением договор/);
  if (shotsDir) await rules.screenshot({ path: path.join(shotsDir, "free-13-условия.png") });
  await rules.close();

  // 11. Удаление учётной записи.
  await tap('.bnav [data-view="profile"]');
  await tap('[data-a="delete"]');
  await see(/Удалить учётную запись\?/);
  await page.fill("#m-del", "мимо");
  await tap('[data-m="delete-yes"]');
  await see(/Пароль неверный/);
  await page.fill("#m-del", "Novyi-parol-77");
  await shot(page, "14-удаление");
  await tap('[data-m="delete-yes"]');
  await see(/Учётная запись удалена/);
  const gone = (await db.doc(`couriers/${courierId}`).get()).data();
  assert.deepEqual([gone.name, gone.phone, gone.inn, gone.enabled], ["Курьер №1001", "", "", false]);
  assert.equal(acts.length, 1, "владельцу платформы — акт об уничтожении");

  assert.deepEqual(errors, [], "ошибок в консоли браузера нет");
  await browser.close();
  server.close();
  console.log("e2e-courier-free: путь свободного курьера в браузере пройден");
}

main().catch((e) => { console.error(e); process.exit(1); });
