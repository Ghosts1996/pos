"use strict";
/**
 * Проверка раздела кабинета «Доставка» в браузере (Playwright): код раздела
 * из console.js и стили кабинета на отдельной странице, ответы — настоящие
 * модули шлюза (courier.js, delivery-admin.js) на своей базе (local-db).
 * Не входит в npm test (нужен браузер):
 *   NODE_PATH=<firebase-admin или заглушка>:<playwright> node e2e-delivery-cabinet.js [--shots папка]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { chromium } = require("playwright");
const { createLocalDb } = require("./local-db");
const { createCourier } = require("./courier");
const { createDeliveryAdmin } = require("./delivery-admin");
const { createDeliveryServices } = require("./delivery-services");
const { encrypt, decrypt } = require("./telegram");

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
const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: true }); };

async function main() {
  const db = createLocalDb({ admin });
  const T = (ms) => Timestamp.fromMillis(ms);
  const common = {
    db: () => db, admin, HttpError,
    verifyAuth: async () => ({ uid: "owner" }),
    parseJsonBody: (req) => Promise.resolve(req.body || {}),
    sendJson: (res, status, body) => { res.status = status; res.body = body; },
    requireTenantRole: async () => {},
    requireChainRole: async () => {},
  };
  // Яндекс Доставка — подставная: цена, заявка, статус.
  const yaCalls = [];
  const fetchImpl = async (u, o) => {
    yaCalls.push(u);
    const body = /claims\/search/.test(u) ? {} : /check-price/.test(u) ? { price: "289.00", eta: 12, distance_meters: 2100 }
      : /claims\/create/.test(u) ? { id: "f".repeat(32), version: 1, status: "new" } : {};
    return { ok: true, status: 200, json: async () => body };
  };
  const services = createDeliveryServices({ ...common, encrypt, decrypt, secretKey: () => require("crypto").createHash("sha256").update("e2e").digest(), fetchImpl, hooks: { changed: (t) => courier.invalidate(t) } });
  const mails = [];
  const limits = { c_C: 2 };
  const courier = createCourier({ ...common, publicUrl: "https://pii.zalpos.ru/saas", getMailer: () => ({ send: async (m) => { mails.push(m); } }), courierLimit: async (root) => (root in limits ? limits[root] : -1), appUrl: "https://pii.zalpos.ru/saas/courier/" });
  courier.setHooks({ services: async (ids) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await services.connected(id)]))) });
  const delivery = createDeliveryAdmin(common);
  const handlers = {
    courierAdminList: courier.handleAdminList, courierAdminSave: courier.handleAdminSave, courierAdminWelcome: courier.handleAdminWelcome, courierAdminForget: courier.handleAdminForget,
    courierAdminEnable: courier.handleAdminEnable, courierAdminCash: courier.handleAdminCash, courierAdminAssign: courier.handleAdminAssign,
    courierAdminRates: courier.handleAdminRates, courierAdminReport: courier.handleAdminReport,
    deliverySettings: delivery.handleGet, deliverySettingsSave: delivery.handleSave, deliveryMenuSave: delivery.handleMenuSave, deliveryVenuePos: delivery.handleVenuePos,
    deliveryServices: services.handleGet, deliveryServicesSave: services.handleSave, deliveryExtQuote: services.handleQuote,
    deliveryExtCall: services.handleCall, deliveryExtApprove: services.handleApprove, deliveryExtCancel: services.handleCancel,
  };

  // Сеть «Лето» из двух точек, меню, заказы, курьер на смене.
  await db.doc("tenants/P1").set({ name: "Лето · Центр", chainId: "C", timezone: "Europe/Moscow", status: "active", createdAt: T(1) });
  await db.doc("tenants/P2").set({ name: "Лето · Север", chainId: "C", timezone: "Europe/Moscow", status: "active", createdAt: T(2) });
  await db.doc("tenants/P1/meta/venueProfile").set({ name: "Лето", address: "Москва, Тверская, 1", phone: "+7 495 000-00-01", deliveryEnabled: true });
  await db.doc("tenants/P1/settings/delivery").set({ fee: 150, freeFrom: 2000, minOrder: 700, venuePos: { lat: 55.7601, lng: 37.6101 } });
  await db.doc("tenants/P1/menuCategories/hot").set({ name: "Горячее", sortOrder: 1 });
  await db.doc("tenants/P1/menuCategories/hookah").set({ name: "Кальяны", sortOrder: 2 });
  await db.doc("tenants/P1/menuItems/soup").set({ name: "Том ям", price: 640, categoryId: "hot" });
  await db.doc("tenants/P1/menuItems/steak").set({ name: "Стейк рибай", price: 1900, categoryId: "hot" });
  await db.doc("tenants/P1/menuItems/classic").set({ name: "Классический кальян", price: 1200, categoryId: "hookah", tobacco: true });
  const order = (no, over) => ({
    tableId: "takeaway", status: "active", orderType: "delivery", orderNo: no, deliveryStatus: "cooking",
    startTime: T(Date.now() - 12 * 60000), orderItems: [{ menuItemId: "soup", name: "Том ям", price: 640, qty: 1 }],
    delivery: { fee: 150, zoneName: "Центр" }, deliveryAddress: "ул. Ленина, 5, кв./офис 1", ...over,
  });
  await db.doc("tenants/P1/sessions/o1").set(order(21));
  await db.doc("tenants/P1/sessions/o2").set(order(22, { deliveryStatus: "accepted", guestPaidTotal: 640, customerName: "Анна", customerPhone: "79001234567" }));

  const call = async (name, body) => { const res = {}; await handlers[name]({ body }, res); return res.body; };
  const made = await call("courierAdminSave", { tenantId: "P1", courier: { name: "Николай Петров", email: "nikolay@example.ru", phone: "+79000000001", transport: "car" } });
  await db.doc(`couriers/${made.id}`).update({ onShift: true, shiftStartedAt: T(Date.now() - 3600e3), lastSeenAt: T(Date.now() - 20e3), pos: { lat: 55.765, lng: 37.62, acc: 10, at: T(Date.now() - 20e3) }, tokenHash: "x", cashOnHand: 1250 });

  // Страница: стили кабинета + код раздела + подставной сервер.
  const consoleJs = fs.readFileSync(path.join(__dirname, "..", "saas", "console", "console.js"), "utf8");
  const start = consoleJs.indexOf("// ---------- Доставка: курьеры, цена и районы");
  const end = consoleJs.indexOf("function bindApiKeysBox(tenantId, redraw) {");
  assert.ok(start > 0 && end > start, "раздел «Доставка» найден в console.js");
  const section = consoleJs.slice(start, end);
  const css = fs.readFileSync(path.join(__dirname, "..", "saas", "console", "console.css"), "utf8");
  const page0 = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style></head><body><div class="dash"><main id="body" style="padding:16px;max-width:980px;margin:0 auto"></main></div>
<script>
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
window.toasts = [];
const SAAS_GATEWAY_URL = 'https://pii.zalpos.ru/saas';
function toast(m) { window.toasts.push(m); }
async function copyToClipboard(t) { window.copied = t; toast('Скопировано'); }
async function callSaasGateway(path, data) {
  const r = await fetch('/gw/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error || 'ошибка'); e.code = j.code; throw e; }
  return { data: j };
}
window.confirm = () => true;
window.prompt = (q, def) => def;
// Окна кабинета (uiDialog в console.js) — здесь сразу «да» / значение по умолчанию.
const uiConfirm = async () => true;
const uiPrompt = async (q, def) => def;
const netFetch = (u, o) => fetch(u, o);
${section}
const tenantId = 'P1';
const draw = () => { $('body').innerHTML = deliveryTabHtml(tenantId); bindDeliveryTab(tenantId, draw); };
draw();
</script></body></html>`;

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url.startsWith("/gw/")) {
      let b = "";
      req.on("data", (c) => { b += c; });
      req.on("end", async () => {
        const h = handlers[req.url.slice(4)];
        const out = {};
        try {
          await h({ body: JSON.parse(b || "{}") }, out);
          res.writeHead(out.status || 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out.body));
        } catch (e) {
          res.writeHead(e.status || 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message, code: e.code }));
        }
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page0);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: "ru-RU" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/yandex|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  // Своя карта (map/zal-embed.js) здесь — заглушка: запоминает метки (сама карта проверяется в e2e-map-embed.js).
  const external = [];
  page.on("request", (r) => { if (/yandex\.ru|map-widget/.test(r.url())) external.push(r.url()); });
  await page.route("**/map/zal-embed.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body:
    "window.ZalEmbed={mount(slot,marks,o){window.__zm={marks,key:o.key};window.__zma=window.__zma||{};window.__zma[o.key]={marks,areas:o.areas,onArea:o.onArea,onClick:o.onClick};slot.innerHTML='<div class=\"zal-embed\" style=\"height:100%;background:#e9e4da\">карта</div>';return Promise.resolve({})}};" }));
  // Районы города с сервера карты — подставные: два квадрата у точки заведения.
  const sq = (lat, lng, d) => [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]];
  const districtsAsked = [];
  await page.route("**/map/districts?**", (r) => {
    districtsAsked.push(r.request().url());
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, area: { id: "1", name: "Москва" }, list: [
      { id: "r101", name: "Тверской район", parent: "Центральный административный округ", km: 0, here: true, areaKm2: 7, center: [55.7601, 37.6101], rings: sq(55.7601, 37.6101, 0.01) },
      { id: "r102", name: "Пресненский район", parent: "Центральный административный округ", km: 2.4, here: false, areaKm2: 12, center: [55.7601, 37.6401], rings: sq(55.7601, 37.6401, 0.01) },
    ] }) });
  });
  await page.goto(url);

  // «Сейчас»: цифры, карта с метками, заказы, назначение.
  await page.waitForSelector("text=курьеров на смене");
  const now = await page.textContent("#f-dl-root");
  assert.ok(/1\s*курьеров на смене/.test(now.replace(/\s+/g, " ")), "1 курьер на смене");
  assert.ok(now.includes("№21") && now.includes("№22"), "заказы в работе");
  await page.waitForFunction(() => window.__zm && document.querySelector("#dlvMap .zal-embed"));
  const zm = await page.evaluate(() => window.__zm);
  const at = (k) => zm.marks.filter((m) => m.kind === k).map((m) => `${m.lat.toFixed(4)},${m.lng.toFixed(4)}`);
  assert.deepEqual(at("venue"), ["55.7601,37.6101"], `заведение на своей карте: ${JSON.stringify(zm.marks)}`);
  assert.deepEqual(at("courier"), ["55.7650,37.6200"], `курьер на своей карте: ${JSON.stringify(zm.marks)}`);
  assert.equal(await page.locator("iframe").count(), 0, "без чужого окна карты");
  assert.deepEqual(external, [], "без запросов к Яндексу");
  await shot(page, "c1-now");
  await page.selectOption('.f-dl-assign[data-s="o1"]', made.id);
  await page.waitForFunction(() => window.toasts.some((t) => /назначен/.test(t)));
  assert.equal((await db.doc("tenants/P1/sessions/o1").get()).data().courierId, made.id, "назначен через кабинет");

  // «Курьеры»: лимит тарифа, добавить (имя, почта, телефон, транспорт) → приглашение на почту; принять наличные.
  await page.click('.f-dl-sub[data-sub="couriers"]');
  await page.waitForSelector("text=+ Добавить курьера");
  assert.ok(/Активных курьеров:\s*1\s*из\s*2/.test(await page.textContent(".dlc-limit")), "лимит тарифа показан");
  await page.click("#f-dl-new");
  await page.fill("#f-dl-name", "Ольга Смирнова");
  await page.fill("#f-dl-phone", "8 (900) 111-22-33");
  await page.check('.f-dl-pt[value="P2"]');
  await page.click("#f-dl-save");
  assert.match(await page.textContent("#f-dl-form-msg"), /email/, "без почты не сохранить");
  await page.fill("#f-dl-email", "Olga@Example.RU");
  await page.click("#f-dl-save");
  assert.match(await page.textContent("#f-dl-form-msg"), /транспорт/i, "без транспорта не сохранить");
  await page.click('.dlc-opt:has(input[value="bike"])');
  await page.click("#f-dl-save");
  await page.waitForFunction(() => window.toasts.some((t) => /приглашение ушло на olga@example\.ru/.test(t)));
  const olga = (await db.collection("couriers").where("no", "==", 2).get()).docs[0].data();
  assert.deepEqual([olga.name, olga.phone, olga.points, olga.email, olga.transport], ["Ольга Смирнова", "79001112233", ["P2"], "olga@example.ru", "bike"]);
  assert.ok(mails.some((m) => m.to === "olga@example.ru" && /добавил вас как курьера/.test(m.text)), "письмо курьеру");
  await page.waitForSelector("text=Активных курьеров: 2 из 2");
  assert.equal(await page.isDisabled("#f-dl-new"), true, "лимит исчерпан — кнопка недоступна");
  await shot(page, "c2-couriers-full");
  // Заблокировать — место освобождается.
  await page.click('.dlc-card:has-text("Ольга Смирнова") .f-dl-enable');
  await page.waitForFunction(() => window.toasts.some((t) => /заблокирован/.test(t)));
  await page.waitForSelector("text=Активных курьеров: 1 из 2");
  assert.equal(await page.isDisabled("#f-dl-new"), false);
  await page.click(".f-dl-cash");
  await page.waitForFunction(() => window.toasts.some((t) => /Принято/.test(t)));
  assert.equal((await db.doc(`couriers/${made.id}`).get()).data().cashOnHand, 0, "наличные приняты");
  await page.check('input[name="f-dl-dispatch"][value="manual"]');
  await page.fill("#f-dl-rate-trip", "150");
  await page.fill("#f-dl-rate-km", "15");
  await page.click("#f-dl-rates");
  await page.waitForFunction(() => window.toasts.some((t) => /назначает администратор/.test(t)));
  assert.equal((await db.doc("courierSettings/c_C").get()).data().dispatch, "manual", "режим ручного назначения сохранён");
  await shot(page, "c2-couriers");

  // «Цена и районы»: районы, оплата, сохранить на все точки.
  await page.click('.f-dl-sub[data-sub="price"]');
  await page.waitForSelector("#f-dl-fee");
  assert.equal(await page.inputValue("#f-dl-fee"), "150");
  await page.fill("#f-dl-fee", "199");
  await page.waitForSelector("text=доставка 199 ₽");
  await page.click("#f-dz-add");
  await page.fill('.dz-card[data-z] input[data-k="name"]', "Центр");
  await page.fill('.dz-card[data-z] input[data-k="fee"]', "99");
  await page.click("#f-dz-add");
  const rows = await page.$$(".dz-card[data-z]");
  await rows[1].$eval('input[data-k="name"]', (el) => { el.value = "Северный"; });
  await rows[1].$eval('input[data-k="etaMin"]', (el) => { el.value = "90"; });
  // Удаляем первый — второй не должен «съехать» в его поля.
  await rows[0].$eval(".f-dz-del", (el) => el.click());
  assert.equal(await page.inputValue('.dz-card[data-z] input[data-k="name"]'), "Северный");
  await page.check("#f-dl-live");
  await page.check("#f-dl-all");
  await shot(page, "c3-price");
  await page.click("#f-dl-price-save");
  await page.waitForFunction(() => window.toasts.some((t) => /Сохранено для 2 точек/.test(t)));
  for (const p of ["P1", "P2"]) {
    const d = (await db.doc(`tenants/${p}/settings/delivery`).get()).data();
    assert.equal(d.fee, 199);
    assert.deepEqual(d.zones.map((z) => [z.name, z.etaMin]), [["Северный", 90]]);
    assert.equal(d.liveInTelegram, true);
  }
  assert.deepEqual((await db.doc("tenants/P1/settings/delivery").get()).data().venuePos, { lat: 55.7601, lng: 37.6101 }, "координаты точки не затёрты");
  // Районы города по месту заведения: список, галочка → район с границей, клик по карте.
  await page.waitForSelector(".dd-row >> text=Тверской район");
  assert.ok(districtsAsked.some((u) => /lat=55\.7601&lng=37\.6101/.test(u)), "районы — вокруг места заведения");
  await page.check('.f-dd[data-id="r102"]');
  await page.waitForSelector('.dz-card >> text=по карте');
  assert.equal((await page.textContent('.dz-card[data-z="dr102"] .dz-title b')).trim(), "Пресненский район", "название района с карты — текстом, целиком");
  await page.fill('.dz-card[data-z="dr102"] input[data-k="fee"]', "249");
  // Нажатие на район на карте — отмечает его (как галочка), повторное — снимает.
  await page.evaluate(() => window.__zma["dlv-area"].onArea("r101"));
  await page.waitForSelector('.dz-card[data-z="dr101"]');
  await page.evaluate(() => window.__zma["dlv-area"].onArea("r101"));
  await page.waitForFunction(() => !document.querySelector('.dz-card[data-z="dr101"]'));
  assert.equal(await page.inputValue('.dz-card[data-z="dr102"] input[data-k="fee"]'), "249", "цена района не потерялась при перерисовке");
  await page.uncheck("#f-dl-all");
  await shot(page, "c3b-districts");
  await page.click("#f-dl-price-save");
  await page.waitForFunction(() => window.toasts.filter((t) => /^Сохранено$/.test(t)).length >= 1);
  const dz = (await db.doc("tenants/P1/settings/delivery").get()).data().zones.find((z) => z.osm === "r102");
  assert.ok(dz && dz.fee === 249 && Array.isArray(dz.poly) && dz.poly[0].length === 5, `район с границей сохранён: ${JSON.stringify(dz)}`);
  // Место заведения: клик по карте → «Новое место» → сохранить; затем ссылка Яндекс Карт.
  await page.evaluate(() => window.__zma["dlv-area"].onClick(55.7612, 37.6123));
  await page.waitForSelector("text=Новое место отмечено на карте");
  await page.click("#f-dl-pos-save");
  await page.waitForFunction(() => window.toasts.some((t) => /Место заведения сохранено/.test(t)));
  let sd = (await db.doc("tenants/P1/settings/delivery").get()).data();
  assert.deepEqual(sd.venuePos, { lat: 55.7612, lng: 37.6123 });
  assert.equal(sd.venuePosFixed, true, "поставленное вручную место курьеры не сдвинут");
  await page.fill("#f-dl-pos", "https://yandex.ru/maps/?ll=37.6101%2C55.7601&z=17");
  await page.click("#f-dl-pos-save");
  await page.waitForFunction(() => window.toasts.filter((t) => /Место заведения сохранено/.test(t)).length >= 2);
  sd = (await db.doc("tenants/P1/settings/delivery").get()).data();
  assert.deepEqual(sd.venuePos, { lat: 55.7601, lng: 37.6101 }, "координаты из ссылки Яндекс Карт");
  await page.fill("#f-dl-pos", "30.3, 59.9");
  await page.click("#f-dl-pos-save");
  await page.waitForSelector("#f-dl-pos-msg >> text=/вне России/");

  // Наценка на доставку.
  await page.fill("#f-dl-markup", "15");
  await page.waitForSelector("text=блюдо за 500 ₽ в доставке — 575 ₽");
  await page.click("#f-dl-price-save");
  await page.waitForFunction(() => window.toasts.filter((t) => /^Сохранено$/.test(t)).length >= 1);
  assert.equal((await db.doc("tenants/P1/settings/delivery").get()).data().markupPct, 15);

  // «Что доставляем»: снять позицию, кальян — нельзя по закону.
  await page.click('.f-dl-sub[data-sub="menu"]');
  await page.waitForSelector("text=Доставляем");
  assert.equal(await page.isDisabled('.f-dm-item[data-id="classic"]'), true, "кальян нельзя включить");
  assert.equal(await page.getAttribute('.f-dm-price[data-id="soup"]', "placeholder"), "736 ₽", "серым — цена зала с наценкой");
  await page.fill('.f-dm-price[data-id="soup"]', "690");
  await page.dispatchEvent('.f-dm-price[data-id="soup"]', "change");
  await page.uncheck('.f-dm-item[data-id="steak"]');
  await page.waitForSelector("text=Сохранить изменения (2)");
  await shot(page, "c4-menu");
  await page.click("#f-dm-save");
  await page.waitForFunction(() => window.toasts.some((t) => /гости увидят/.test(t)));
  assert.equal((await db.doc("tenants/P1/menuItems/steak").get()).data().deliveryOff, true);
  assert.equal((await db.doc("tenants/P1/menuItems/soup").get()).data().deliveryPrice, 690, "своя цена в доставке");

  // «Службы доставки»: подключить Яндекс, вызвать курьера службы к заказу №22.
  await page.click('.f-dl-sub[data-sub="services"]');
  await page.waitForSelector("text=Для этой точки");
  await page.fill("#f-ds-token-point-yandex", "y0_E2ETOKEN_1234567890abc");
  await page.click('.f-ds-save[data-p="yandex"][data-scope="point"]');
  await page.waitForFunction(() => window.toasts.some((t) => /Ключ проверен/.test(t)));
  await page.waitForSelector("text=● подключена");
  await shot(page, "c7-services");
  await page.click('.f-dl-sub[data-sub="now"]');
  await page.waitForSelector('.f-dx-quote[data-s="o2"]');
  await page.click('.f-dx-quote[data-s="o2"]');
  await page.waitForSelector("text=Вызвать за 289 ₽");
  await shot(page, "c8-ext-quote");
  await page.click('.f-dx-call[data-p="yandex"]');
  await page.waitForFunction(() => window.toasts.some((t) => /Курьер вызван/.test(t)));
  // Статус службы меняется сам через несколько секунд (опрос) — годится любой шаг после вызова.
  await page.waitForFunction(() => /Считаем цену|Ищем курьера|Курьер (назначен|едет)/.test(document.body.innerText));
  const o2 = (await db.doc("tenants/P1/sessions/o2").get()).data();
  assert.deepEqual([o2.ext.provider, o2.ext.quoted, o2.extActive], ["yandex", 289, true]);
  assert.ok(yaCalls.some((u) => /claims\/create/.test(u)), "заявка в Яндексе создана");

  // «Отчёт».
  await page.click('.f-dl-sub[data-sub="report"]');
  await page.waitForSelector("text=Рабочие сутки");
  await page.waitForSelector("text=/доставок курьерами приложения не было|Итого/");
  await shot(page, "c5-report");

  // Телефон: ничего не вылезает за экран.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const sub of ["now", "couriers", "price", "menu", "services"]) {
    await page.click(`.f-dl-sub[data-sub="${sub}"]`);
    await page.waitForTimeout(300);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (wide > 1) {
      const who = await page.evaluate(() => [...document.querySelectorAll("#f-dl-root *")].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map((el) => `${el.tagName}.${el.className}`).join(" | "));
      assert.fail(`«${sub}» на телефоне шире экрана на ${wide}px: ${who}`);
    }
    await shot(page, `c6-mobile-${sub}`);
  }

  assert.deepEqual(errors, [], "в консоли браузера нет ошибок");
  await browser.close();
  server.close();
  console.log("e2e-delivery-cabinet: раздел «Доставка» в браузере проверен");
}

main().catch((e) => { console.error("e2e-delivery-cabinet FAIL:", e); process.exit(1); });
