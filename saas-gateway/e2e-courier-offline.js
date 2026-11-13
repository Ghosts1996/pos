"use strict";
/**
 * Своя карта города без интернета — в браузере, как на телефоне курьера.
 * Нужна папка карты (MAP_DIR) с tiles.pmtiles, status.json (районы) и
 * roads-<район>.graph(.gz), например Владикавказ (см. docs/delivery.md, раздел 21):
 *   MAP_DIR=/var/tmp/zmap NODE_PATH=<playwright> node e2e-courier-offline.js [--shots папка]
 * Путь: карта района заведения → «Скачать карту города» → заказ с маршрутом
 * по серверу → интернет выключен, приложение открыто заново → карта из
 * телефона, маршрут считается на телефоне по скачанной сети дорог.
 */
const http = require("http");
const path = require("path");
const assert = require("assert/strict");
const { chromium } = require("playwright");
const { createLocalDb } = require("./local-db");
const { createCourier } = require("./courier");
const { createCourierWeb } = require("./courier-web");
const { createMap } = require("./map");

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
const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`) }); };

// Владикавказ: заведение у пр. Мира, гость — на северо-западе города.
const VENUE = { lat: 43.0247, lng: 44.6819 };
const GUEST = { lat: 43.0395, lng: 44.6576 };

async function main() {
  const dir = process.env.MAP_DIR;
  assert.ok(dir, "укажите MAP_DIR — папку своей карты");
  const zalMap = createMap({ dir });
  assert.ok(zalMap.info().tiles, "в MAP_DIR нет tiles.pmtiles");
  const db = createLocalDb({ admin });
  const mails = [];
  const api = createCourier({
    db: () => db, admin, HttpError, publicUrl: "http://127.0.0.1/saas",
    getMailer: () => ({ send: async (m) => { mails.push(m); } }),
    verifyAuth: async () => ({ uid: "owner" }),
    parseJsonBody: (req) => new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => { b += c; });
      req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch (_) { resolve({}); } });
    }),
    sendJson: (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); },
    requireTenantRole: async () => {},
    requireChainRole: async () => { throw new HttpError(403, "нет"); },
  });
  let serverRoutes = 0;
  api.setHooks({ route: (body) => { serverRoutes++; return zalMap.route(body); } });
  const web = createCourierWeb();
  const routes = {
    "auth/request-code": api.handleRequestCode, "auth/verify-code": api.handleVerifyCode, consent: api.handleConsent,
    state: api.handleState, shift: api.handleShift, act: api.handleAct, ping: api.handlePing, history: api.handleHistory, route: api.handleRoute,
  };
  const server = http.createServer((req, res) => {
    const [p0, q = ""] = req.url.split("?");
    const p = p0.replace(/^\/saas/, "");
    if (req.method === "POST" && p.startsWith("/courier/api/")) {
      const h = routes[p.slice(13)];
      if (!h) { res.writeHead(404); return res.end(); }
      return h(req, res).catch((e) => { res.writeHead(e.status || 500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message, code: e.code })); });
    }
    if (p.startsWith("/courier/")) return web.serve(req, res, p.slice(9));
    if (p.startsWith("/map/")) return zalMap.serve(req, res, decodeURIComponent(p.slice(5)), q);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/saas/courier/`;

  const T = (ms) => Timestamp.fromMillis(ms);
  await db.doc("tenants/A").set({ name: "Кафе «Осетия»", timezone: "Europe/Moscow", status: "active", createdAt: T(1) });
  await db.doc("tenants/A/meta/venueProfile").set({ address: "Владикавказ, пр. Мира, 1" });
  await db.doc("tenants/A/settings/delivery").set({ venuePos: VENUE, payAtDoor: { cash: true } });
  const call = (fn, body) => new Promise((resolve, reject) => {
    const res = { writeHead(s) { this.s = s; }, end(b) { const j = JSON.parse(b); this.s >= 400 ? reject(new Error(j.error)) : resolve(j); } };
    const req = new (require("stream").Readable)({ read() {} });
    req.push(JSON.stringify(body)); req.push(null); req.headers = {};
    fn(req, res).catch(reject);
  });
  await call(api.handleAdminSave, { tenantId: "A", courier: { name: "Алан Дзагоев", email: "alan@example.ru", transport: "car" } });
  await call(api.handleRequestCode, { email: "alan@example.ru", consent_accepted: true });
  const code = /(\d{6}) —/.exec(mails.find((m) => /код входа/.test(m.subject)).subject)[1];
  const { token } = await call(api.handleVerifyCode, { email: "alan@example.ru", code, consent_accepted: true });
  await db.doc("tenants/A/sessions/s1").set({
    tableId: "takeaway", status: "active", orderType: "delivery", orderNo: 31, source: "app",
    deliveryStatus: "cooking", startTime: T(Date.now() - 5 * 60000), deliveryAddress: "ул. Владикавказская, 10",
    deliveryGeo: GUEST, customerPhone: "79280000000", customerName: "Залина",
    orderItems: [{ menuItemId: "pie", name: "Осетинский пирог", price: 900, qty: 1, ready: 1 }], guestPaidTotal: 900,
  });

  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ru-RU",
    geolocation: { latitude: VENUE.lat - 0.004, longitude: VENUE.lng + 0.003, accuracy: 10 }, permissions: ["geolocation"],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|yandex/.test(m.text())) errors.push(`console: ${m.text()} @ ${(m.location() || {}).url || ""}`); });
  await page.route(/yandex\.(ru|net)/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" }));
  await page.addInitScript((t) => { try { if (!localStorage.getItem("zc_token")) localStorage.setItem("zc_token", JSON.stringify(t)); } catch (_) {} }, token);

  // 1. Своя карта Владикавказа открывается сама — по точке заведения.
  await page.goto(base);
  await page.waitForSelector(".venue-line >> text=Кафе «Осетия»");
  await page.click('#bnav [data-a="view"][data-view="map"]');
  await page.waitForSelector("#zmap:not([hidden]) canvas", { timeout: 30000 });
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
  // 2. Профиль → «Карта без интернета» → скачать город.
  await page.click('#bnav [data-a="view"][data-view="profile"]');
  await page.waitForSelector(".off-card >> text=Владикавказ");
  await page.click('[data-a="off-get"]');
  await page.waitForSelector(".off-card >> text=/В телефоне: улицы, подписи и дороги/", { timeout: 120000 });
  await shot(page, "off-1-profile");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("zc_offmap")));
  assert.equal(saved.id, "4303-4468");
  assert.ok(saved.tiles > 300 && saved.graphV, `скачано участков: ${saved.tiles}`);
  // 3. Смена и заказ: маршрут — по серверу.
  await page.click('#page [data-a="shift"]');
  await page.waitForSelector(".pill.on", { state: "attached" });
  await page.click('#bnav [data-a="view"][data-view="orders"]');
  await page.waitForSelector('[data-key="A__s1"][data-a="take"]');
  await page.click('[data-key="A__s1"][data-a="take"]');
  await page.click('#bnav [data-a="view"][data-view="map"]');
  await page.waitForSelector("#zmeta:not([hidden])", { timeout: 20000 });
  assert.ok(serverRoutes >= 1, "маршрут посчитал сервер");
  await shot(page, "off-2-online-route");
  // 4. Интернета нет, приложение открыто заново: карта и маршрут — из телефона.
  const before = serverRoutes;
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector(".venue-line >> text=Кафе «Осетия»", { timeout: 30000 }).catch(async () => {
    // Состояние заказов без связи не приходит — приложение показывает загрузку; карта проверяется ниже.
  });
  await page.waitForSelector("#zmap:not([hidden]) canvas", { timeout: 30000 });
  const offRoute = await page.evaluate(async () => {
    // Тот же поток маршрутов, что использует приложение, — проверяем, что считает без сети.
    const cache = await caches.open("zalpos-map-offline");
    const txt = async (f) => (await cache.match(new URL(`../map/${f}`, location.href).href)).text();
    const src = (await txt("route-worker.js")).replace('importScripts("map-graph.js");', `(function () {\n${await txt("map-graph.js")}\n})();`);
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    const res = await cache.match(new URL("../map/graph/4303-4468.graph", location.href).href);
    const buf = await res.arrayBuffer();
    const call = (msg, tr) => new Promise((ok) => { const t = setTimeout(() => ok({ ok: false, reason: "timeout" }), 20000); w.onerror = (e) => { clearTimeout(t); ok({ ok: false, reason: `worker: ${e.message}` }); }; w.onmessage = (e) => { clearTimeout(t); ok(e.data); }; w.postMessage(msg, tr || []); });
    const l = await call({ id: 1, op: "load", buf, area: "4303-4468" }, [buf]);
    const r = await call({ id: 2, op: "route", points: [{ lat: 43.0207, lng: 44.6849 }, { lat: 43.0395, lng: 44.6576 }], mode: "auto" });
    return { loaded: l.ok, lr: l.reason || l.message, ok: r.ok, m: r.m, s: r.s, pts: (r.line || []).length, offline: r.offline };
  });
  assert.ok(offRoute.loaded && offRoute.ok && offRoute.offline, `маршрут без сети: ${JSON.stringify(offRoute)}`);
  assert.ok(offRoute.m > 2000 && offRoute.m < 9000 && offRoute.pts > 5, `разумный маршрут: ${JSON.stringify(offRoute)}`);
  assert.equal(serverRoutes, before, "без сети сервер не спрашивали");
  // Тайлы без сети: участки карты отдаются из телефона.
  const tileOk = await page.evaluate(async () => (await fetch("../map/tiles/14/10226/5957.mvt?v=x")).status);
  assert.ok([200, 204].includes(tileOk), `тайл без сети: ${tileOk}`);
  await page.waitForTimeout(1500);
  await shot(page, "off-3-offline");
  console.log(`маршрут без сети: ${offRoute.m} м, ${Math.round(offRoute.s / 60)} мин, точек линии ${offRoute.pts}`);

  assert.deepEqual(errors, [], "в консоли браузера нет ошибок");
  await browser.close();
  server.close();
  console.log("e2e-courier-offline: карта города без интернета проверена");
  process.exit(0);
}

main().catch((e) => { console.error("e2e-courier-offline FAIL:", e); process.exit(1); });
