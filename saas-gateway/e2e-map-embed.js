/*
 * Проверка встроенной своей карты (map/zal-embed.js) в браузере:
 *  1) чужой адрес (как кабинет на zalpos.ru и веб-версия гостя): скрипт,
 *     стили и поток карты — с сервера карты, метки на месте, без Яндекса;
 *  2) тот же адрес со строгой политикой (как страница «Адрес и карта» из бота):
 *     метка подхватывается из data-zalmap;
 *  3) перерисовка блока — карта переезжает в новый элемент без новой загрузки.
 *
 *   MAP_DIR=/var/tmp/zmap NODE_PATH=<playwright> node e2e-map-embed.js [--shots папка]
 */
"use strict";
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { createMap } = require("./map");

const shotsDir = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? process.argv[i + 1] : ""; })();
const listen = (srv) => new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv.address().port)));

(async () => {
  const dir = process.env.MAP_DIR;
  assert.ok(dir, "укажите MAP_DIR — папку своей карты");
  const zalMap = createMap({ dir });
  const info = zalMap.info();
  assert.ok(info.tiles, "в MAP_DIR нет tiles.pmtiles");
  const reg = (info.areas || info.regions || [])[0] || {};
  const c = reg.center ? { lat: reg.center[0], lng: reg.center[1] } : { lat: 59.935, lng: 30.326 };
  const marks = [
    { id: "courier", kind: "courier", lat: c.lat + 0.004, lng: c.lng + 0.006, label: "Курьер" },
    { id: "guest", kind: "guest", lat: c.lat - 0.003, lng: c.lng - 0.004, label: "Гость" },
  ];

  // Сервер карты (как pii.zalpos.ru/saas)
  const gw = http.createServer((req, res) => {
    const u = req.url.split("?");
    if (u[0].startsWith("/saas/map/")) return zalMap.serve(req, res, u[0].slice("/saas/map/".length), u[1] || "");
    if (u[0] === "/saas/deliveryAddress") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; "
          + "img-src 'self' data: blob:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      const attr = JSON.stringify({ marks, key: "addr" }).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      return res.end(`<!doctype html><meta charset="utf-8"><body style="margin:16px"><p>Курьер на карте</p>
<div id="m" data-zalmap="${attr}" style="height:300px;border-radius:8px;overflow:hidden;background:#eee"></div>
<script src="map/zal-embed.js"></script>`);
    }
    res.writeHead(404); res.end();
  });
  const gwPort = await listen(gw);
  const BASE = `http://127.0.0.1:${gwPort}/saas`;

  // «Сайт» на другом адресе (как zalpos.ru)
  const site = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'self'; script-src 'self' 'unsafe-inline' http://127.0.0.1:${gwPort}; style-src 'self' 'unsafe-inline' http://127.0.0.1:${gwPort}; `
        + `img-src 'self' data: blob: http:; connect-src 'self' http://127.0.0.1:${gwPort}; worker-src 'self' blob:; frame-src 'self' blob:`,
    });
    res.end(`<!doctype html><meta charset="utf-8"><body style="margin:16px"><div id="wrap"><div id="slot" style="height:320px"></div></div>
<script src="${BASE}/map/zal-embed.js"></script>
<script>window.marks = ${JSON.stringify(marks)};
window.go = () => ZalEmbed.mount(document.getElementById("slot"), window.marks, { key: "dlv" });</script>`);
  });
  const sitePort = await listen(site);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 720 } });
  const errors = [];
  const external = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("request", (r) => { if (!/^(http:\/\/127\.0\.0\.1|blob:|data:|zalmap:)/.test(r.url())) external.push(r.url()); });

  // 1) чужой адрес
  if (process.env.DEBUG) console.log("сайт", sitePort, "карта", gwPort);
  await page.goto(`http://127.0.0.1:${sitePort}/`, { timeout: 20000 });
  await page.evaluate(() => window.go());
  await page.waitForSelector("#slot canvas", { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("#slot .maplibregl-marker").length >= 2, null, { timeout: 15000 });
  await page.waitForTimeout(2500);
  if (shotsDir) { fs.mkdirSync(shotsDir, { recursive: true }); await page.screenshot({ path: path.join(shotsDir, "embed-cross.png") }); }
  const painted = await page.evaluate(() => {
    const cv = document.querySelector("#slot canvas");
    const gl = cv.getContext("webgl2") || cv.getContext("webgl");
    return !!cv && cv.width > 100 && !!gl;
  });
  assert.ok(painted, "карта нарисована на чужом адресе");
  console.log("  ✓ чужой адрес: карта и 2 метки");

  // 3) перерисовка блока — карта та же (без новой загрузки)
  const moved = await page.evaluate(async () => {
    const before = document.querySelector("#slot .zal-embed");
    document.getElementById("wrap").innerHTML = '<div id="slot" style="height:320px"></div>';
    window.marks[0].lat += 0.001;
    await window.go();
    return document.querySelector("#slot .zal-embed") === before;
  });
  assert.ok(moved, "карта переехала в новый блок без перезагрузки");
  console.log("  ✓ перерисовка: та же карта, метка сдвинулась");

  // 2) тот же адрес, строгая политика страницы бота
  await page.goto(`${BASE}/deliveryAddress`);
  await page.waitForSelector("#m canvas", { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("#m .maplibregl-marker").length >= 2, null, { timeout: 15000 });
  await page.waitForTimeout(2500);
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "embed-bot.png") });
  console.log("  ✓ страница из бота: карта из data-zalmap");

  const bad = errors.filter((e) => !/favicon/.test(e));
  assert.deepStrictEqual(bad, [], "без ошибок в консоли");
  assert.deepStrictEqual(external, [], "никаких сторонних адресов (Яндекс, реклама)");
  console.log("map-embed: 3 проверки пройдены");
  await browser.close();
  gw.close(); site.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
