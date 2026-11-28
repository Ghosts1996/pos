"use strict";
// Запуск: NODE_PATH=/opt/node22/lib/node_modules node e2e-guest-xss.js (нужен Playwright).
// Веб-версия гостя против вредоносных данных заведения: XSS в названиях,
// ленте, меню, столах, ссылках на картинки. Стенд: настоящий server.js +
// статика веб-гостя с тем же адресом сервера.
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const GW = __dirname, APP = path.join(__dirname, "..", "saas", "guest-web", "app");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xss-"));
Object.assign(process.env, {
  PORT: "8131", DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "d.sqlite"), SUPPORT_DB_FILE: path.join(dir, "s.json"),
  AUTH_DB_FILE: path.join(dir, "a.json"), BACKUP_DIR: path.join(dir, "b"), DATA_AUTO_MIGRATE: "0", REJECTED_DIR: path.join(dir, "r"), GITHUB_PAT: "",
  TOBACCO_STATE_DIR: dir, TELEGRAM_SECRET_KEY: "xss-secret-key-0123456789abcdef0123", PII_GATEWAY_URL: "http://127.0.0.1:8141/",
});
const server = require(GW + "/server.js");
const admin = require(GW + "/node_modules/firebase-admin");
const { chromium } = require("playwright");
const store = server.localDataStore();
const set = (p, d) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop()).set(d);
const X = (tag) => `"><img src=x onerror="window.__pwn='${tag}'"><script>window.__pwn='${tag}s'</script><svg onload="window.__pwn='${tag}v'">'`;
// Заглушка справочника ПДн.
http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" });
    res.end(JSON.stringify({ ok: true, id: "x", receipt: "r" }));
  });
}).listen(8141);
// Статика веб-гостя + прокси на сервер.
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/saas/") || u.pathname.startsWith("/pii/")) {
    const target = u.pathname.startsWith("/pii/") ? { port: 8141, path: u.pathname.slice(4) + u.search } : { port: 8131, path: u.pathname.slice(5) + u.search };
    const p = http.request({ hostname: "127.0.0.1", port: target.port, path: target.path, method: req.method, headers: { ...req.headers, "x-real-ip": "127.0.0.1" } }, (pr) => {
      res.writeHead(pr.statusCode, pr.headers);
      pr.pipe(res);
    });
    req.pipe(p);
    return;
  }
  let f = path.join(APP, decodeURIComponent(u.pathname.replace(/^\/app\/?/, "/")));
  if (u.pathname === "/app/" || u.pathname === "/app") f = path.join(APP, "index.html");
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  if (/\.(js|html)$/.test(f)) {
    body = String(body)
      .replace(/https:\/\/pii\.zalpos\.ru\/saas/g, `http://${req.headers.host}/saas`)
      .replace(/https:\/\/pii\.zalpos\.ru\//g, `http://${req.headers.host}/pii/`)
      .replace(/connect-src 'self'/, "connect-src 'self' http://*.localhost:8140");
  }
  const type = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" }[path.extname(f)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(body);
}).listen(8140);

(async () => {
  await new Promise((r) => setTimeout(r, 500));
  const now = Date.now();
  const T = (ms) => admin.firestore.Timestamp.fromMillis(ms);
  await set("tenants/tx", { name: X("tname"), slug: "xss", status: "active", ownerUserId: "own1", planId: "pro", timezone: "Europe/Moscow", createdAt: T(now) });
  await set("subscriptions/tx", { status: "active", currentPeriodEnd: T(now + 30 * 86400000), planId: "pro" });
  await set("tenants/tx/public/features", { guestApp: true });
  await set("tenants/tx/meta/venueProfile", {
    name: X("vname"), address: X("addr"), deliveryEnabled: true, bookingEnabled: true, phone: X("phone"),
    workingHours: {}, referralEnabled: true, reviewLinks: { yandex: "javascript:alert(1)", gis: X("gis") }, about: X("about"),
  });
  await set("tenants/tx/meta/branding", { appName: X("app"), primaryColor: "red;background:url(javascript:alert(1))", logoUrl: "javascript:alert(1)" });
  await set("tenants/tx/menuCategories/c1", { name: X("cat"), order: 1, imageUrl: "javascript:alert(1)" });
  await set("tenants/tx/menuItems/m1", {
    name: X("item"), description: X("desc"), price: 100, available: true, categoryId: "c1", imageUrl: `x" onerror="window.__pwn='img'`,
    modifierGroups: [{ name: X("grp"), min: 0, max: 2, options: [{ name: X("opt"), price: 10 }] }],
  });
  await set("tenants/tx/stories/s1", {
    title: X("st"), text: X("stt") + " https://a.ru/\"onmouseover=\"window.__pwn='lnk'", imageUrl: "https://x.ru/a.jpg\" onerror=\"window.__pwn='simg'",
    action: "menu", actionLabel: X("cta"), published: true, order: 0, createdAt: T(now),
  });
  await set("tenants/tx/stories/s2", { title: "Без фото", text: "Подпишитесь на [наш канал](https://t.me/k_l) и [зло](javascript:alert(1)) [x\"onmouseover=\"window.__pwn='md'](https://a.ru/\"onmouseover=\"window.__pwn='md2')\nИтоги — 5 декабря.", imageUrl: "javascript:alert(1)", action: "booking", actionLabel: "Бронь", published: true, order: 1, createdAt: T(now) });
  await set("tenants/tx/tables/t1", { name: X("table"), zone: X("zone"), seats: 4, status: "free", x: 100, y: 100, maxOpenSessions: 2 });
  await set("tenants/tx/settings/serviceCharge", { enabled: true, percent: 10, title: X("svc") });

  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("dialog", (d) => { errors.push("DIALOG " + d.message()); d.dismiss(); });
  page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE " + m.text().slice(0, 160)); });
  await page.goto("http://xss.localhost:8140/app/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  for (const h of ["#/", "#/menu", "#/booking", "#/profile", "#/table", "#/delivery", "#/"]) {
    await page.evaluate((x) => { location.hash = x; }, h);
    await page.waitForTimeout(2500);
    for (const sel of [".story", ".menu-item", ".card", ".chip", "a"]) {
      const els = await page.$$(sel);
      for (const el of els.slice(0, 4)) { try { await el.hover({ timeout: 500 }); } catch (_) {} }
    }
  }
    // Афиша: нажатие на карточку — карточка целиком, слово-ссылка, кнопка.
  await page.evaluate(() => { location.hash = "#/"; });
  await page.waitForTimeout(2500);
  await page.click('.story[data-story="1"] .story-title');
  await page.waitForSelector(".story-sheet", { timeout: 5000 });
  const sheet = await page.evaluate(() => {
    const el = document.querySelector(".story-sheet");
    const a = el.querySelector('a[href="https://t.me/k_l"]');
    return { text: el.innerText, link: a ? a.textContent : null, js: !!el.querySelector('a[href^="javascript"]') };
  });
  for (const a of await page.$$(".story-sheet a")) { try { await a.hover({ timeout: 500 }); } catch (_) {} }
  if (sheet.link !== "наш канал" || !/Итоги.{1,3}5.декабря/.test(sheet.text) || sheet.js) errors.push("АФИША " + JSON.stringify(sheet));
  await page.click(".story-sheet [data-go]");
  await page.waitForTimeout(800);
  if (!/#\/booking/.test(page.url())) errors.push("АФИША: кнопка не ведёт на бронь " + page.url());

  const pwn = await page.evaluate(() => window.__pwn || null);
  const text = (await page.evaluate(() => document.body.innerText)).slice(0, 500);
  const bad = errors.filter((e) => !/favicon/.test(e));
  console.log(pwn || bad.length ? `e2e-guest-xss: ПРОВАЛ — ${pwn ? "выполнился чужой код " + pwn : ""} ${bad.join(" | ")}` : "e2e-guest-xss: чужой код не выполнился, ошибок нет");
  await browser.close();
  process.exit(pwn || bad.length ? 1 : 0);
  console.log("ошибки:", JSON.stringify(errors.slice(0, 15), null, 1));
  console.log("текст:", text.replace(/\s+/g, " "));
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
