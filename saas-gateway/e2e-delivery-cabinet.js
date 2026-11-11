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
  const courier = createCourier({ ...common, publicUrl: "https://pii.zalpos.ru/saas" });
  const delivery = createDeliveryAdmin(common);
  const handlers = {
    courierAdminList: courier.handleAdminList, courierAdminSave: courier.handleAdminSave, courierAdminInvite: courier.handleAdminInvite,
    courierAdminEnable: courier.handleAdminEnable, courierAdminCash: courier.handleAdminCash, courierAdminAssign: courier.handleAdminAssign,
    courierAdminRates: courier.handleAdminRates, courierAdminReport: courier.handleAdminReport,
    deliverySettings: delivery.handleGet, deliverySettingsSave: delivery.handleSave, deliveryMenuSave: delivery.handleMenuSave,
  };

  // Сеть «Лето» из двух точек, меню, заказы, курьер на смене.
  await db.doc("tenants/P1").set({ name: "Лето · Центр", chainId: "C", timezone: "Europe/Moscow", status: "active", createdAt: T(1) });
  await db.doc("tenants/P2").set({ name: "Лето · Север", chainId: "C", timezone: "Europe/Moscow", status: "active", createdAt: T(2) });
  await db.doc("tenants/P1/meta/venueProfile").set({ address: "Тверская, 1", deliveryEnabled: true });
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
  await db.doc("tenants/P1/sessions/o2").set(order(22, { deliveryStatus: "accepted", guestPaidTotal: 640 }));

  const call = async (name, body) => { const res = {}; await handlers[name]({ body }, res); return res.body; };
  const made = await call("courierAdminSave", { tenantId: "P1", courier: { name: "Николай Петров", phone: "+79000000001" } });
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
function toast(m) { window.toasts.push(m); }
async function copyToClipboard(t) { window.copied = t; toast('Скопировано'); }
async function callSaasGateway(path, data) {
  const r = await fetch('/gw/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'ошибка');
  return { data: j };
}
window.confirm = () => true;
window.prompt = (q, def) => def;
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
          res.end(JSON.stringify({ error: e.message }));
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
  await page.route("https://yandex.ru/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<html><body style='background:#dfe8e3'>карта</body></html>" }));
  await page.goto(url);

  // «Сейчас»: цифры, карта с метками, заказы, назначение.
  await page.waitForSelector("text=курьеров на смене");
  const now = await page.textContent("#f-dl-root");
  assert.ok(/1\s*курьеров на смене/.test(now.replace(/\s+/g, " ")), "1 курьер на смене");
  assert.ok(now.includes("№21") && now.includes("№22"), "заказы в работе");
  const mapSrc = await page.getAttribute("iframe", "src");
  assert.ok(/pt=37\.610100,55\.760100,pm2rdl~37\.620000,55\.765000,pm2gnm1/.test(mapSrc), `метки на карте: ${mapSrc}`);
  await shot(page, "c1-now");
  await page.selectOption('.f-dl-assign[data-s="o1"]', made.id);
  await page.waitForFunction(() => window.toasts.some((t) => /назначен/.test(t)));
  assert.equal((await db.doc("tenants/P1/sessions/o1").get()).data().courierId, made.id, "назначен через кабинет");

  // «Курьеры»: добавить → ссылка; принять наличные.
  await page.click('.f-dl-sub[data-sub="couriers"]');
  await page.waitForSelector("text=+ Добавить курьера");
  await page.click("#f-dl-new");
  await page.fill("#f-dl-name", "Ольга Смирнова");
  await page.fill("#f-dl-phone", "8 (900) 111-22-33");
  await page.check('.f-dl-pt[value="P2"]');
  await page.click("#f-dl-save");
  await page.waitForSelector("text=Ссылка для курьера №2");
  const link = await page.textContent("text=/courier\\/#i=/");
  assert.ok(/https:\/\/pii\.zalpos\.ru\/saas\/courier\/#i=[A-Za-z0-9_-]{20,}/.test(link), "ссылка-приглашение показана");
  const olga = (await db.collection("couriers").where("no", "==", 2).get()).docs[0].data();
  assert.deepEqual([olga.name, olga.phone, olga.points], ["Ольга Смирнова", "79001112233", ["P2"]]);
  await page.click("#f-dl-copy");
  assert.equal(await page.evaluate(() => window.copied), link.trim());
  await page.click(".f-dl-cash");
  await page.waitForFunction(() => window.toasts.some((t) => /Принято/.test(t)));
  assert.equal((await db.doc(`couriers/${made.id}`).get()).data().cashOnHand, 0, "наличные приняты");
  await page.fill("#f-dl-rate-trip", "150");
  await page.fill("#f-dl-rate-km", "15");
  await page.click("#f-dl-rates");
  await page.waitForFunction(() => window.toasts.some((t) => /Ставки сохранены/.test(t)));
  await shot(page, "c2-couriers");

  // «Цена и районы»: районы, оплата, сохранить на все точки.
  await page.click('.f-dl-sub[data-sub="price"]');
  await page.waitForSelector("#f-dl-fee");
  assert.equal(await page.inputValue("#f-dl-fee"), "150");
  await page.fill("#f-dl-fee", "199");
  await page.waitForSelector("text=доставка 199 ₽");
  await page.click("#f-dz-add");
  await page.fill('tr[data-z] input[data-k="name"]', "Центр");
  await page.fill('tr[data-z] input[data-k="fee"]', "99");
  await page.click("#f-dz-add");
  const rows = await page.$$("tr[data-z]");
  await rows[1].$eval('input[data-k="name"]', (el) => { el.value = "Северный"; });
  await rows[1].$eval('input[data-k="etaMin"]', (el) => { el.value = "90"; });
  // Удаляем первый — второй не должен «съехать» в его поля.
  await rows[0].$eval(".f-dz-del", (el) => el.click());
  assert.equal(await page.inputValue('tr[data-z] input[data-k="name"]'), "Северный");
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

  // «Что доставляем»: снять позицию, кальян — нельзя по закону.
  await page.click('.f-dl-sub[data-sub="menu"]');
  await page.waitForSelector("text=Доставляем");
  assert.equal(await page.isDisabled('.f-dm-item[data-id="classic"]'), true, "кальян нельзя включить");
  await page.uncheck('.f-dm-item[data-id="steak"]');
  await page.waitForSelector("text=Сохранить изменения (1)");
  await shot(page, "c4-menu");
  await page.click("#f-dm-save");
  await page.waitForFunction(() => window.toasts.some((t) => /гости увидят/.test(t)));
  assert.equal((await db.doc("tenants/P1/menuItems/steak").get()).data().deliveryOff, true);

  // «Отчёт».
  await page.click('.f-dl-sub[data-sub="report"]');
  await page.waitForSelector("text=Рабочие сутки");
  await page.waitForSelector("text=/доставок курьерами приложения не было|Итого/");
  await shot(page, "c5-report");

  // Телефон: ничего не вылезает за экран.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const sub of ["now", "couriers", "price", "menu"]) {
    await page.click(`.f-dl-sub[data-sub="${sub}"]`);
    await page.waitForTimeout(300);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(wide <= 1, `«${sub}» на телефоне шире экрана на ${wide}px`);
  }
  await shot(page, "c6-mobile-price");

  assert.deepEqual(errors, [], "в консоли браузера нет ошибок");
  await browser.close();
  server.close();
  console.log("e2e-delivery-cabinet: раздел «Доставка» в браузере проверен");
}

main().catch((e) => { console.error("e2e-delivery-cabinet FAIL:", e); process.exit(1); });
