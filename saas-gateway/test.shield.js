"use strict";

// Щит сервера (shield.js): флуд, сканеры, программы взлома, подбор паролей,
// выкачка данных, сохранение банов, свои адреса без ограничений.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createShield, ipKey, SCAN_RE, TOOL_UA_RE, maskEmail } = require("./shield");

let passed = 0;
let failed = 0;
const check = (name, cond) => (cond ? passed++ : (failed++, console.error(`FAIL: ${name}`)));

let t = Date.UTC(2026, 10, 9, 7, 0, 0);
const now = () => t;
const req = (ip, url = "/db/query", ua = "Mozilla/5.0") => ({ ip, url, headers: { "user-agent": ua } });
const make = (extra = {}) => createShield({ ipOf: (r) => r.ip, now, log: () => {}, ...extra });

// ---- адреса
check("ipKey: внешний IPv4 как есть", ipKey("203.0.113.7") === "203.0.113.7");
check("ipKey: свои и частные адреса не ограничиваются",
  ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.2", "::1", "::ffff:127.0.0.1", "fe80::1", "fd00::5", "unknown", ""].every((x) => ipKey(x) === ""));
check("ipKey: IPv4 внутри IPv6", ipKey("::ffff:203.0.113.7") === "203.0.113.7");
check("ipKey: IPv6 — по сети /64", ipKey("2a00:1fa0:4c3:1:aaaa:bbbb:cccc:dddd") === "2a00:1fa0:4c3:1::/64"
  && ipKey("2a00:1fa0:4c3:1::5") === ipKey("2a00:1fa0:4c3:1:ffff::9"));
check("ipKey: сокращённый IPv6", ipKey("2001:db8::1") === "2001:db8:0:0::/64");
check("maskEmail", maskEmail("owner@mail.ru") === "ow***@mail.ru" && maskEmail("x") === "***");

// ---- ни один адрес ZalPOS не похож на сканер
{
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const routes = new Set();
  for (const m of src.matchAll(/^\s+"(\/[A-Za-z0-9_/.-]*)":/gm)) routes.add(m[1]);
  for (const m of src.matchAll(/urlPath === "(\/[^"]+)"/g)) routes.add(m[1]);
  for (const p of ["/api/v1/venue", "/api/v1/menu", "/api/v1/sales", "/api/v1/stock", "/tgHook/abc_DEF-1", "/db/listen", "/auth/login"]) routes.add(p);
  const bad = [...routes].filter((p) => SCAN_RE.test(p));
  check(`адреса сервера не попадают под сканер (${routes.size})`, routes.size > 100 && bad.length === 0);
  if (bad.length) console.error("  похожи на сканер:", bad);
  check("сканер: типичные пробы узнаются",
    ["/.env", "/.git/config", "/wp-login.php", "/phpmyadmin/index.php", "/index.php", "/cgi-bin/luci", "/../../etc/passwd",
      "/actuator/health", "/backup.sql", "/vendor/phpunit/x", "/.aws/credentials", "/%2e%2e/x"].every((p) => SCAN_RE.test(p)));
  check("программы взлома по User-Agent", TOOL_UA_RE.test("sqlmap/1.7") && TOOL_UA_RE.test("Mozilla/5.0 (compatible; Nuclei)")
    && !TOOL_UA_RE.test("Mozilla/5.0 (Linux; Android 14)") && !TOOL_UA_RE.test("python-requests/2.31") && !TOOL_UA_RE.test("Dart/3.5 (dart:io)"));
}

// ---- флуд
{
  const s = make({ limits: { perMinute: 5, floodPerMinute: 10 } });
  const ip = "198.51.100.1";
  let r;
  for (let i = 0; i < 5; i++) r = s.gate(req(ip), "/db/query");
  check("флуд: в пределах лимита — пропускает", r === null);
  r = s.gate(req(ip), "/db/query");
  check("флуд: сверх лимита — 429 до конца минуты", r && r.status === 429 && r.retryAfter > 0 && r.retryAfter <= 60);
  check("флуд: свой адрес не ограничен", Array.from({ length: 50 }, () => s.gate(req("127.0.0.1"), "/db/query")).every((x) => x === null));
  check("флуд: другой адрес не задет", s.gate(req("198.51.100.2"), "/db/query") === null);
  t += 60 * 1000;
  check("флуд: новая минута — снова можно", s.gate(req(ip), "/db/query") === null);
  for (let i = 0; i < 10; i++) s.gate(req(ip), "/db/query");
  r = s.gate(req(ip), "/db/query");
  check("флуд: втрое больше — адрес закрыт на 10 минут", r && r.status === 429 && s.bannedFor(ip) === 10 * 60 * 1000);
  t += 60 * 1000;
  check("флуд: бан держится и в следующую минуту", s.gate(req(ip), "/db/query").status === 429);
  check("флуд: оплаты, вебхуки и /health не режутся даже у закрытого адреса",
    ["/health", "/tgHook/123", "/robokassaResult", "/guestPayRobokassa"].every((p) => s.gate(req(ip, p), p) === null));
  t += 10 * 60 * 1000;
  check("флуд: бан кончился", s.gate(req(ip), "/db/query") === null);
  for (let i = 0; i < 11; i++) s.gate(req(ip), "/db/query");
  check("флуд: повтор за сутки — вдвое дольше", s.bannedFor(ip) === 20 * 60 * 1000);
  const st = s.status();
  check("сводка: баны и отбитые запросы", st.day.bans === 2 && st.bannedNow === 1 && st.day.blocked + st.day.throttled > 0);
  s.stop();
}

// ---- сканеры и программы взлома
{
  const s = make();
  const ip = "198.51.100.9";
  let r = s.gate(req(ip, "/.env"), "/.env");
  check("сканер: первая проба — просто 404", r && r.status === 404);
  check("сканер: обычные запросы после пробы проходят", s.gate(req(ip), "/db/query") === null);
  s.gate(req(ip, "/wp-login.php"), "/wp-login.php");
  r = s.gate(req(ip, "/.git/config"), "/.git/config");
  check("сканер: третья проба за 10 минут — бан на час", r && r.status === 429 && s.bannedFor(ip) === 60 * 60 * 1000);
  check("сканер: закодированный обход папок", s.gate(req("198.51.100.10", "/a/%2E%2E/%2E%2E/etc/passwd"), "/a/%2E%2E/%2E%2E/etc/passwd").status === 404);
  check("сканер: параметры запроса не проверяются (подписи, курсоры)", s.gate(req("198.51.100.11", "/supportDoc?k=..%2F..&x=.env"), "/supportDoc") === null);
  r = s.gate(req("198.51.100.12", "/db/query", "sqlmap/1.8#stable"), "/db/query");
  check("sqlmap — бан сразу", r && r.status === 429 && s.bannedFor("198.51.100.12") > 0);
  s.stop();
}

// ---- подбор паролей
{
  const alerts = [];
  const lockedMails = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zal-shield-"));
  const file = path.join(dir, "shield.json");
  const s = make({ file, alert: (h) => alerts.push(h), onEmailLocked: (e) => lockedMails.push(e) });
  // С одного адреса — бан адреса.
  for (let i = 0; i < 24; i++) s.authFailed(req("203.0.113.50"), "");
  check("подбор: 24 ошибки с адреса — ещё не бан", s.bannedFor("203.0.113.50") === 0);
  s.authFailed(req("203.0.113.50"), "");
  check("подбор: 25-я — адрес закрыт на 30 минут", s.bannedFor("203.0.113.50") === 30 * 60 * 1000);
  // К одной почте с разных адресов — замок на вход по паролю.
  for (let i = 0; i < 19; i++) s.authFailed(req(`203.0.113.${100 + i}`), "Owner@Mail.ru");
  check("подбор почты: 19 ошибок — вход открыт", s.emailLocked("owner@mail.ru") === 0 && !alerts.some((a) => a.includes("Подбор пароля")));
  s.authFailed(req("203.0.113.200"), "owner@mail.ru");
  check("подбор почты: 20-я — вход по паролю закрыт на 12 часов", s.emailLocked("OWNER@mail.ru") === 12 * 3600 * 1000);
  check("подбор почты: тревога админам — без полного адреса", alerts.filter((a) => a.includes("Подбор пароля")).length === 1
    && alerts.some((a) => a.includes("ow***@mail.ru")) && !alerts.some((a) => a.includes("owner@mail.ru")));
  check("подбор почты: письмо хозяину почты", lockedMails.length === 1 && lockedMails[0] === "owner@mail.ru");
  for (let i = 0; i < 30; i++) s.authFailed(req("203.0.113.201"), "owner@mail.ru");
  check("подбор почты: тревога и письмо — один раз", alerts.filter((a) => a.includes("Подбор пароля")).length === 1 && lockedMails.length === 1);
  // Баны и замки переживают перезапуск; на диске — хеш почты, не адрес.
  s.flush();
  const disk = fs.readFileSync(file, "utf8");
  check("сохранение: файл без почты", !disk.toLowerCase().includes("owner") && !disk.includes("mail.ru"));
  const s2 = make({ file });
  check("сохранение: замок почты после перезапуска", s2.emailLocked("owner@mail.ru") > 0);
  check("сохранение: бан адреса после перезапуска", s2.bannedFor("203.0.113.50") > 0);
  // Вход по ссылке или новый пароль снимает замок.
  s2.authOk("owner@mail.ru");
  check("подбор почты: «Забыли пароль?» снимает замок", s2.emailLocked("owner@mail.ru") === 0);
  t += 13 * 3600 * 1000;
  check("подбор почты: замок кончается сам", s.emailLocked("owner@mail.ru") === 0);
  s.stop();
  s2.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- выкачка данных
{
  const alerts = [];
  const s = make({ alert: (h) => alerts.push(h), limits: { readAlert: 1000, readLimit: 5000 } });
  check("чтение: обычный объём — без тревоги", s.noteReads("u1", 900) === false && alerts.length === 0);
  s.noteReads("u1", 200);
  check("чтение: больше порога за 10 минут — тревога", alerts.length === 1 && alerts[0].includes("u1") && s.status().day.readAlerts === 1);
  s.noteReads("u1", 3000);
  check("чтение: тревога одна", alerts.length === 1);
  check("чтение: сверх предела — притормаживаем", s.noteReads("u1", 2000) === true && s.readThrottled("u1"));
  check("чтение: другого пользователя не трогаем", !s.readThrottled("u2"));
  t += 10 * 60 * 1000;
  check("чтение: через 10 минут — снова можно", !s.readThrottled("u1"));
  check("чтение: без пользователя не считаем", s.noteReads("", 1e9) === false);
  s.stop();
}

// ---- свои лимиты и всплеск атак
{
  const alerts = [];
  const s = make({ alert: (h) => alerts.push(h), limits: { surgeBansPerHour: 3 } });
  const r = req("198.51.100.77");
  check("hit: в пределах", [1, 2, 3].every(() => s.hit("dbSession", r, 3, 60000) === false));
  check("hit: сверх — true", s.hit("dbSession", r, 3, 60000) === true);
  check("hit: свой адрес — никогда", Array.from({ length: 10 }, () => s.hit("dbSession", req("127.0.0.1"), 1, 60000)).every((x) => x === false));
  for (let i = 0; i < 4; i++) s.ban(`198.51.100.${150 + i}`, "scan");
  check("всплеск: тревога «сервер отбивает атаку» — одна", alerts.filter((a) => a.includes("отбивает атаку")).length === 1);
  s.sweep();
  s.stop();
}

// ---- сервер данных: учёт прочитанного, торможение, лимит подключений
async function dataGuard() {
  const admin = require("firebase-admin");
  const ds = require("./data-server");
  const store = ds.createDataStore({ admin });
  const rulesSource = fs.readFileSync(path.join(__dirname, "..", "saas", "firestore.rules"), "utf8");
  const secure = ds.createSecureDb({ store, rulesSource, admin });
  for (const [p, d] of Object.entries({
    "tenants/tenantA": { name: "A", status: "active" },
    "tenantMembers/tenantA_ownerA": { tenantId: "tenantA", userId: "ownerA", role: "owner", status: "active" },
    "tenants/tenantA/tables/t1": { name: "Стол 1" },
    "tenants/tenantA/tables/t2": { name: "Стол 2" },
  })) await store.doc(p).set(d);
  const reads = [];
  let throttle = false;
  let tooMany = false;
  const api = ds.createDataApi({
    store, secure,
    verifyAuth: async (r) => ({ uid: String(r.headers.authorization).slice("Bearer test:".length), exp: Math.floor(Date.now() / 1000) + 3600 }),
    parseJsonBody: async (r) => r.body,
    sendJson: (res, status, obj) => { res.status = status; res.json = obj; },
    HttpError: Error,
    guard: { onRead: (uid, n) => reads.push([uid, n]), readThrottled: () => throttle, newSession: () => tooMany },
  });
  const call = async (route, body) => {
    const res = {};
    await api.routes[route]({ headers: { authorization: "Bearer test:ownerA" }, body }, res);
    return res;
  };
  let r = await call("/db/query", { query: { col: "tenants/tenantA/tables" } });
  check("данные: запрос отдал столы", r.status === 200 && r.json.docs.length === 2);
  check("данные: прочитанное учтено по пользователю", reads.some(([u, n]) => u === "ownerA" && n === 2));
  r = await call("/db/get", { paths: ["tenants/tenantA/tables/t1", "tenants/tenantA/tables/nope"] });
  check("данные: get считает только найденные", r.status === 200 && reads[reads.length - 1][1] === 1);
  throttle = true;
  r = await call("/db/query", { query: { col: "tenants/tenantA/tables" } });
  check("данные: приторможенный пользователь — 429", r.status === 429 && r.json.code === "resource-exhausted");
  throttle = false;
  tooMany = true;
  r = await call("/db/session", {});
  check("данные: слишком много подключений с адреса — 429", r.status === 429);
  tooMany = false;
  r = await call("/db/session", {});
  check("данные: подключение в пределах лимита", r.status === 200 && r.json.sid);
  r = await call("/db/listen", { sid: r.json.sid, inline: true, add: [{ id: "a", query: { col: "tenants/tenantA/tables" } }] });
  check("данные: первая выдача подписки тоже учтена", r.status === 200 && reads[reads.length - 1][1] === 2);
}

dataGuard().catch((e) => { failed++; console.error("FAIL: сервер данных:", e); }).then(() => {
  console.log(`shield: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
