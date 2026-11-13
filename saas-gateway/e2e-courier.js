"use strict";
/**
 * Проверка приложения курьера в браузере (Playwright), как на телефоне:
 * стенд = модуль курьера + своя база (local-db) + файлы courier-web, адреса
 * как снаружи (/saas/courier/…). Не входит в npm test (нужен браузер):
 *   NODE_PATH=<где playwright> node e2e-courier.js [--shots папка]
 * Проходит весь путь: ссылка → согласие → смена → новый заказ со звуком →
 * «Беру» → «Забрал» → «На месте» → «Вручил» наличными со сдачей; без сети —
 * нажатие копится и уходит, когда сеть вернулась; оплата по QR.
 */
const http = require("http");
const path = require("path");
const fs = require("fs");
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
const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: false }); };

async function main() {
  const db = createLocalDb({ admin });
  let qrPaid = false;
  const mails = [];
  const api = createCourier({
    getMailer: () => ({ send: async (m) => { mails.push(m); } }),
    appUrl: "http://127.0.0.1/saas/courier/",
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
    guestPay: {
      courierPayStart: async () => ({ paymentId: "p1", url: "https://qr.nspk.ru/AS1000TEST?sum=99000", amount: 990, bank: "Т-Банк", status: "pending" }),
      courierPayStatus: async () => ({ status: qrPaid ? "paid" : "pending" }),
    },
  });
  const web = createCourierWeb();
  const routes = { "auth/request-code": api.handleRequestCode, "auth/verify-code": api.handleVerifyCode, "auth/select": api.handleSelect, consent: api.handleConsent, state: api.handleState, shift: api.handleShift, act: api.handleAct, ping: api.handlePing, pay: api.handlePay, logout: api.handleLogout, history: api.handleHistory };
  const server = http.createServer((req, res) => {
    const p = req.url.split("?")[0].replace(/^\/saas/, "");
    if (req.method === "POST" && p.startsWith("/courier/api/")) {
      const h = routes[p.slice(13)];
      return h(req, res).catch((e) => { res.writeHead(e.status || 500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message, code: e.code, retryIn: e.retryIn })); });
    }
    if (p.startsWith("/courier/")) return web.serve(req, res, p.slice(9));
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/saas/courier/`;

  // Заведение, курьер, ссылка.
  const T = (ms) => Timestamp.fromMillis(ms);
  await db.doc("tenants/A").set({ name: "Кафе «Лето»", timezone: "Europe/Moscow", status: "active", createdAt: T(1) });
  await db.doc("tenants/A/meta/venueProfile").set({ address: "Москва, Тверская, 1" });
  await db.doc("tenants/A/settings/delivery").set({ payAtDoor: { cash: true, card: true, qr: true } });
  await db.doc("tenants/A/settings/integrations").set({ onlinePayVerified: "tinkoff|1" });
  const call = (fn, body) => new Promise((resolve, reject) => {
    const res = { writeHead(s) { this.s = s; }, end(b) { const j = JSON.parse(b); this.s >= 400 ? reject(new Error(j.error)) : resolve(j); } };
    const req = new (require("stream").Readable)({ read() {} });
    req.push(JSON.stringify(body)); req.push(null); req.headers = {};
    fn(req, res).catch(reject);
  });
  await call(api.handleAdminSave, { tenantId: "A", courier: { name: "Николай Петров", email: "nikolay@example.ru", phone: "+7 900 000-00-01", transport: "bike" } });
  const order = (no, over = {}) => ({
    tableId: "takeaway", status: "active", orderType: "delivery", orderNo: no, source: "app",
    deliveryStatus: "cooking", startTime: T(Date.now() - 7 * 60000),
    deliveryAddress: "ул. Ленина, 5, кв./офис 12, подъезд 2, этаж 3, домофон 12К",
    customerPhone: "79001234567", customerName: "Анна", deliveryComment: "Позвоните за 5 минут",
    orderItems: [
      { menuItemId: "soup", name: "Том ям", price: 640, qty: 1, ready: 1, mods: ["Огонь"] },
      { menuItemId: "tea", name: "Чай улун", price: 300, qty: 1, ready: 1 },
      { menuItemId: "zalpos_delivery", name: "Доставка", price: 150, qty: 1, noPromo: true, kind: "kitchen", ready: 1 },
    ],
    delivery: { fee: 150, etaMin: 60, zoneName: "Центр" },
    ...over,
  });
  await db.doc("tenants/A/sessions/s1").set(order(12));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ru-RU",
    geolocation: { latitude: 55.7600, longitude: 37.6100, accuracy: 12 }, permissions: ["geolocation"],
  });
  const page = await ctx.newPage();
  // PERF=1: процессор медленнее в 4 раза (как недорогой Android) и учёт долгих задач (> 50 мс).
  if (process.env.PERF) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.addInitScript(() => {
      window.__long = [];
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { const a = (e.attribution || [])[0]; window.__long.push(`${Math.round(e.duration)}${a && a.containerType !== "window" ? `(${a.containerSrc ? "iframe" : a.containerType})` : ""}${e.name !== "self" ? `[${e.name}]` : ""}`); } }).observe({ type: "longtask", buffered: true }); } catch (_) { /* нет поддержки */ }
    });
    // Чужая карта во фрейме меряется отдельно — здесь только наше приложение.
    if (process.env.PERF === "app") await page.route(/yandex\.(ru|net)/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" }));
  }
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on("dialog", (d) => d.accept());

  // 1. Вход по почте: кнопка недоступна без почты и без галочки согласия.
  await page.goto(base);
  await page.waitForSelector("text=Вход для курьера");
  await page.waitForSelector("text=Доступ предоставляется администратором вашего заведения");
  assert.equal(await page.isChecked("#auth-consent"), false, "галочка не стоит по умолчанию");
  assert.equal(await page.isDisabled("#auth-send"), true);
  await page.fill("#auth-email", "nikolay@example");
  await page.click(".check");
  assert.equal(await page.isDisabled("#auth-send"), true, "почта неполная — нельзя");
  await page.fill("#auth-email", "kto-to@example.ru");
  assert.equal(await page.isDisabled("#auth-send"), false);
  await shot(page, "0-login");
  await page.click("#auth-send");
  await page.waitForSelector("text=Аккаунт не найден. Обратитесь к администратору вашего заведения");
  assert.equal(await page.getAttribute('.check-t a[href="rules.html"]', "target"), "_blank", "условия — ссылкой");
  // 2. Своя почта → письмо с кодом → экран кода с таймером.
  await page.fill("#auth-email", "Nikolay@Example.ru");
  await page.click("#auth-send");
  await page.waitForSelector("text=Код из письма");
  await page.waitForSelector("text=Проверьте папку «Спам»");
  await page.waitForSelector("text=/Отправить код ещё раз через 0[01]:\\d\\d/");
  await shot(page, "0b-code");
  const letter = mails.find((m) => m.to === "nikolay@example.ru" && /код входа/.test(m.subject));
  assert.ok(letter, "письмо с кодом ушло");
  const code = /(\d{6}) —/.exec(letter.subject)[1];
  // Перезагрузка (ушли в почту, телефон выгрузил страницу) — снова экран кода, а не начало.
  await page.reload();
  await page.waitForSelector("text=Код из письма");
  await page.fill("#auth-code", code === "000000" ? "111111" : "000000");
  await page.waitForSelector("text=/Код неверный/");
  await page.fill("#auth-code", code); // 6 цифр — вход сам, без кнопки
  await page.waitForSelector(".venue-line >> text=Кафе «Лето»");
  const me = (await db.collection("couriers").where("email", "==", "nikolay@example.ru").get()).docs[0].data();
  assert.deepEqual([me.policyVersion, !!me.consentAt, me.consentEmail], ["2.0", true, "nikolay@example.ru"], "согласие ПЭП записано");
  await page.waitForSelector("text=Не на линии");
  await page.waitForSelector("text=Вы не на линии");
  // Свободный заказ виден, но без смены не взять.
  assert.equal(await page.isDisabled('[data-a="take"]'), true);
  // 3. Смена.
  await page.click('.online-card [data-a="shift"]');
  await page.waitForSelector("text=На линии");
  await page.waitForSelector('[data-a="take"]:not([disabled])');
  const free = await page.textContent("#sheetbody");
  assert.ok(free.includes("ул. Ленина, 5") && !/кв\.|79001234567|Анна/.test(free), "в свободных — улица без квартиры, телефона и имени");
  assert.ok(free.includes("1 090 ₽"), "к получению — с доставкой");
  await shot(page, "2-free");
  // 4. Новый заказ приходит сам — с подсветкой.
  await db.doc("tenants/A/sessions/s2").set(order(13, { deliveryStatus: "accepted", guestPaidTotal: 1090 }));
  await page.waitForSelector("article.offer.new", { timeout: 15000 });
  // 5. «Беру» → вкладка «Мои» с полным адресом.
  await page.click('[data-key="A__s1"][data-a="take"]');
  await page.waitForSelector("text=Кафе «Лето»");
  await page.waitForSelector("text=подъезд 2");
  const mine = await page.textContent("#sheetbody");
  assert.ok(/Дальше: ул\. Ленина, 5, кв\.\/офис 12/.test(mine), "у своего заказа — полный адрес");
  await shot(page, "3-mine-pickup");
  // 6. Без сети: «Забрал» сразу на экране, уходит потом.
  await ctx.setOffline(true);
  await page.click('[data-a="pickup"]');
  await page.waitForSelector("text=Я на месте");
  await page.waitForSelector("text=Нет связи");
  const onWay = await page.textContent("#sheetbody");
  assert.ok(onWay.includes("Позвоните за 5 минут") && onWay.includes("Анна"), "в пути — имя и комментарий гостя");
  let s = (await db.doc("tenants/A/sessions/s1").get()).data();
  assert.equal(s.courierStage, "toVenue", "без сети на сервер не ушло");
  await shot(page, "4-offline");
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  for (let i = 0; i < 40 && s.courierStage !== "onWay"; i++) { await page.waitForTimeout(250); s = (await db.doc("tenants/A/sessions/s1").get()).data(); }
  assert.equal(s.courierStage, "onWay", "сеть вернулась — нажатие дошло");
  assert.equal(s.deliveryStatus, "courier");
  // 7. Геолокация дошла, гость видит курьера.
  await page.evaluate(() => {});
  for (let i = 0; i < 60 && !(await db.doc("tenants/A/sessions/s1").get()).data().courierPos; i++) {
    await ctx.setGeolocation({ latitude: 55.76 + i * 0.0004, longitude: 37.61, accuracy: 10 });
    await page.waitForTimeout(400);
  }
  assert.ok((await db.doc("tenants/A/sessions/s1").get()).data().courierPos, "точка курьера — в заказе в пути");
  // 8. На месте → таймер; «Вручил» наличными со сдачей.
  await page.click('[data-a="arrive"]');
  await page.waitForSelector(".main-act >> text=У двери");
  await page.click('.main-act [data-a="deliver"]');
  await page.waitForSelector("text=Вручить заказ №12");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "страница не шире экрана");
  await shot(page, "5a-deliver");
  await page.click('[data-m="method"][data-v="cash"]');
  await page.click('[data-m="received"][data-v="2000"]');
  await page.waitForSelector("text=Сдача: 910");
  await shot(page, "5-cash");
  await page.click('[data-m="deliver"][data-method="cash"]');
  await page.waitForSelector("text=Заказ вручён");
  s = (await db.doc("tenants/A/sessions/s1").get()).data();
  for (let i = 0; i < 20 && s.deliveryStatus !== "done"; i++) { await page.waitForTimeout(250); s = (await db.doc("tenants/A/sessions/s1").get()).data(); }
  assert.equal(s.deliveryStatus, "done");
  assert.deepEqual([s.courierPayment.method, s.courierPayment.amount, s.courierPayment.change], ["cash", 1090, 910]);
  // 9. Оплата по QR: QR на экране, банк подтвердил → «Вручил».
  await page.click('[data-a="list"][data-list="free"]');
  await db.doc("tenants/A/sessions/s3").set(order(14));
  await page.waitForSelector('[data-key="A__s3"][data-a="take"]', { timeout: 15000 });
  await page.click('[data-key="A__s3"][data-a="take"]');
  await page.waitForSelector('[data-key="A__s3"][data-a="pickup"]');
  await page.click('[data-key="A__s3"][data-a="pickup"]');
  await page.waitForSelector('[data-key="A__s3"][data-a="arrive"]');
  await page.click('[data-key="A__s3"][data-a="arrive"]');
  await page.waitForSelector('[data-key="A__s3"][data-a="deliver"]');
  await page.click('.main-act [data-key="A__s3"][data-a="deliver"]');
  await page.click('[data-m="method"][data-v="qr"]');
  await page.waitForSelector(".qr svg");
  await page.waitForSelector("text=Ждём оплату");
  await shot(page, "6-qr");
  qrPaid = true;
  await db.doc("tenants/A/sessions/s3").update({ guestPaidTotal: 1090 });
  await page.waitForSelector("text=Оплата по QR пришла", { timeout: 10000 });
  await page.click('[data-m="deliver"]');
  await page.waitForSelector("text=Заказ вручён");
  // 10. Итоги: 2 доставки, наличные на руках.
  await page.click('[data-a="view"][data-view="income"]');
  await page.waitForSelector("h1 >> text=Мои поездки");
  await page.waitForSelector("text=Доставки сегодня");
  await page.waitForSelector(".trip >> nth=1");
  const day = (await page.textContent("#page")).replace(/\s+/g, " ");
  assert.ok(/1 090 ₽ ?на руках/.test(day), "наличные на руках — 1 090 ₽");
  await shot(page, "7-day");
  // 11. Тёмная тема — без ошибок.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.click('[data-a="view"][data-view="profile"]');
  await page.waitForSelector("text=Как езжу");
  await page.waitForSelector("text=nikolay@example.ru");
  await page.waitForSelector("text=/Согласие дано .* редакция 2\\.0/");
  await shot(page, "8-dark-profile");
  await page.click('[data-a="view"][data-view="orders"]');
  await shot(page, "9-dark");
  // 12. Ручное назначение: свободных не видно, «Свободные» скрыты.
  await call(api.handleAdminRates, { tenantId: "A", ratePerTrip: 0, ratePerKm: 0, dispatch: "manual" });
  api.forgetCache();
  await db.doc("tenants/A/sessions/s4").set(order(15));
  await page.click('[data-a="map-refresh"]');
  await page.waitForSelector("text=назначает заведение");
  assert.equal(await page.$('[data-a="list"][data-list="free"]'), null, "вкладки «Свободные» нет");
  // 13. Условия открываются; блокировка в кабинете — курьер выходит.
  const rules = await ctx.newPage();
  await rules.goto(`${base}rules.html`);
  await rules.waitForSelector("text=Условия использования приложения");
  assert.ok((await rules.textContent("body")).includes("63-ФЗ"), "условия про ПЭП");
  await rules.close();
  const id = (await db.collection("couriers").where("email", "==", "nikolay@example.ru").get()).docs[0].id;
  await db.doc(`couriers/${id}`).update({ cashOnHand: 0 });
  await call(api.handleAdminEnable, { tenantId: "A", courierId: id, enabled: false });
  await page.click('[data-a="map-refresh"]');
  await page.waitForSelector("text=Вход для курьера", { timeout: 15000 });
  await shot(page, "10-blocked");

  if (process.env.PERF) {
    const long = await page.evaluate(() => window.__long || []);
    const sorted = long.slice().sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
    console.log(`долгих задач: ${long.length}, самые долгие, мс: ${sorted.slice(0, 12).join(", ")}`);
  }
  assert.deepEqual(errors, [], "в консоли браузера нет ошибок");
  await browser.close();
  server.close();
  console.log("e2e-courier: путь курьера в браузере пройден");
}

main().catch((e) => { console.error("e2e-courier FAIL:", e); process.exit(1); });
