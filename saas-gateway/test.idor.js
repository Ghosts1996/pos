"use strict";
// Подмена чужого заведения (IDOR): владелец заведения A вызывает КАЖДЫЙ адрес
// сервера и прямой доступ к базе с номерами заведения B (чек, гость, курьер,
// устройство, платёж, сеть). Ни один ответ не должен быть успешным, кроме
// заведомо публичных адресов (витрина по QR и т. п.), и данные B не меняются.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idor-"));
Object.assign(process.env, {
  PORT: "8097", DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0",
  REJECTED_DIR: path.join(dir, "rejected"), GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "idor-secret-key-0123456789abcdef",
});
const server = require("./server.js");
const admin = require("firebase-admin");
const store = server.localDataStore();
const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => (cond ? passed++ : (failed++, console.error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`)));

function request(method, p, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ hostname: "127.0.0.1", port: 8097, path: p, method, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const set = (p, d) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop()).set(d);
const T = (ms) => admin.firestore.Timestamp.fromMillis(ms);

// Адреса, которые по замыслу открыты без прав в заведении: витрина гостя по
// QR/ссылке, вход, уведомления банков (проверяют подпись), служебные
// проверки. Для них проверяем только, что чужие данные не меняются.
const PUBLIC = new Set([
  "/resolveTenantBySlug", "/resolveChainBySlug", "/guestDeliveryInfo", "/guestDeliveryQuote", "/checkSeller",
  "/createDemoTenant", "/appUpdate", "/getDownloadUrl", "/authBackend", "/supportSiteSend", "/supportSiteMessages",
  "/partnerInviteInfo", "/partnerMe", "/supportBotStatus", "/auth/me", "/auth/login", "/auth/signup", "/auth/anonymous",
  "/auth/refresh", "/auth/logout", "/auth/exchange", "/auth/custom", "/auth/apply", "/auth/reauth", "/auth/password",
  "/robokassaSuccess", "/robokassaFail", "/deviceIdentify", "/recordAdminLogin", "/sendAuthEmail", "/telegramStatus",
  "/supportCabinetMessages", "/supportTicketList", "/registerGuestRecovery", "/restoreGuestSession", "/aiKeyProbe",
  "/db/session", "/db/listen", "/db/get", "/db/query", "/db/commit", "/chainLocationQuote", "/partnerDashboard",
]);

async function main() {
  await new Promise((r) => setTimeout(r, 300));
  const sign = async (email) => (await request("POST", "/auth/signup", { body: { email, password: "secret-123456" } })).json;
  const a = await sign("owner-a@test.ru");
  const b = await sign("owner-b@test.ru");
  check("два владельца вошли", a && a.idToken && b && b.idToken);
  const now = Date.now();
  for (const [t, uid, chain] of [["tenA", a.uid, ""], ["tenB", b.uid, "chB"]]) {
    await set(`tenants/${t}`, { name: t, slug: t, status: "active", ownerUserId: uid, planId: "pro", ...(chain ? { chainId: chain } : {}), timezone: "Europe/Moscow" });
    await set(`tenantMembers/${t}_${uid}`, { tenantId: t, userId: uid, role: "owner", status: "active" });
    await set(`subscriptions/${chain || t}`, { status: "active", currentPeriodEnd: T(now + 30 * 86400000), planId: "pro" });
    await set(`tenants/${t}/sessions/s1`, { status: "active", tableId: "t1", orderItems: [{ name: "Чай", price: 100, qty: 1 }], openedAt: T(now) });
    await set(`tenants/${t}/clients/g1`, { name: "Гость", phone: "+79000000001" });
    await set(`tenants/${t}/devices/d1`, { status: "active", name: "Касса", createdAt: T(now) });
    await set(`tenants/${t}/guestPayments/p1`, { status: "pending", amount: 100, sessionId: "s1", clientUid: "g1" });
    await set(`tenants/${t}/settings/integrations`, { robokassaLogin: "secret-login" });
  }
  await set("chains/chB", { name: "Сеть B", status: "active", ownerUserId: b.uid, planId: "chain" });
  await set(`chainMembers/chB_${b.uid}`, { chainId: "chB", userId: b.uid, role: "owner", status: "active" });
  await set("couriers/kB", { root: "t_tenB", name: "Курьер Б", email: "k@b.ru", points: ["tenB"], status: "active", no: 1 });
  const snapshot = async () => JSON.stringify(await Promise.all([
    "tenants/tenB", "tenants/tenB/sessions/s1", "tenants/tenB/clients/g1", "tenants/tenB/devices/d1",
    "tenants/tenB/guestPayments/p1", "chains/chB", "couriers/kB", "subscriptions/chB",
  ].map(async (p) => (await store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop()).get()).data() || null)));
  const before = await snapshot();

  // ---- 1. Все адреса сервера с номерами чужого заведения.
  const routes = [...src.slice(src.indexOf("const ROUTES = {")).matchAll(/^\s+"(\/[A-Za-z0-9_/]+)":/gm)].map((m) => m[1]);
  check("адреса сервера найдены", routes.length > 150, String(routes.length));
  const foreign = {
    tenantId: "tenB", chainId: "chB", sessionId: "s1", paymentId: "p1", courierId: "kB", id: "kB", deviceId: "d1",
    uid: b.uid, userId: b.uid, clientUid: "g1", phone: "+79000000001", email: "owner-b@test.ru", rootId: "tenB",
    pointId: "tenB", targetTenantId: "tenB", eventId: "e1", planId: "pro", root: "t_tenB", jobId: "j1",
    on: true, enabled: true, months: 1, days: 30, status: "active", action: "enable", name: "x", text: "x",
  };
  const leaks = [];
  for (const r of routes) {
    if (PUBLIC.has(r)) continue;
    let res;
    for (const method of ["POST", "GET"]) {
      const q = method === "GET" ? `?${new URLSearchParams({ tenantId: "tenB", chainId: "chB", t: "tenB", sessionId: "s1" })}` : "";
      res = await request(method, r + q, { token: a.idToken, body: method === "POST" ? foreign : undefined });
      if (res.status !== 405) break;
    }
    if (res.status >= 200 && res.status < 300) leaks.push(`${r} → ${res.status} ${res.raw.slice(0, 120)}`);
  }
  check("ни один закрытый адрес не отвечает успехом на чужое заведение", !leaks.length, `\n  ${leaks.join("\n  ")}`);

  // ---- 2. Прямой доступ к базе.
  for (const p of ["tenants/tenB/sessions/s1", "tenants/tenB/clients/g1", "tenants/tenB/settings/integrations", "tenants/tenB/guestPayments/p1", "couriers/kB", "subscriptions/chB"]) {
    const r = await request("POST", "/db/get", { token: a.idToken, body: { paths: [p] } });
    check(`база: чтение ${p} чужим владельцем запрещено`, r.status === 403, `${r.status} ${r.raw.slice(0, 100)}`);
  }
  for (const coll of ["tenants/tenB/sessions", "tenants/tenB/clients", "couriers", "tenantMembers"]) {
    const r = await request("POST", "/db/query", { token: a.idToken, body: { query: { col: coll } } });
    check(`база: список ${coll} чужим владельцем запрещён`, r.status === 403 || (r.json && r.json.code === "permission-denied") || (r.json && Array.isArray(r.json.docs) && !r.json.docs.some((d) => /tenB|kB|chB/.test(JSON.stringify(d)))), `${r.status} ${r.raw.slice(0, 100)}`);
  }
  for (const [p, data] of [["tenants/tenB/sessions/s1", { status: "closed", total: 1 }], ["tenants/tenB/menuItems/x", { name: "Взлом", price: 1 }], [`tenantMembers/tenB_${a.uid}`, { tenantId: "tenB", userId: a.uid, role: "owner", status: "active" }], ["tenants/tenB", { status: "active", ownerUserId: a.uid }]]) {
    const r = await request("POST", "/db/commit", { token: a.idToken, body: { writes: [{ op: "set", path: p, data }] } });
    check(`база: запись ${p} чужим владельцем запрещена`, r.status >= 400, `${r.status} ${r.raw.slice(0, 100)}`);
  }
  // Свои данные при этом доступны — тест не «зелёный» от того, что сломан вход.
  const own = await request("POST", "/db/get", { token: a.idToken, body: { paths: ["tenants/tenA/sessions/s1"] } });
  check("база: своё заведение владелец читает", own.status === 200 && own.json.docs[0] && own.json.docs[0].exists, `${own.status} ${own.raw.slice(0, 100)}`);

  check("данные заведения B не изменились", (await snapshot()) === before);

  // ---- 3. Карантин: отказ правил своему заведению не теряет записи; чужие — не копятся.
  check("карантин: попытки чужого владельца не сохраняются", !fs.existsSync(path.join(dir, "rejected", "tenB.jsonl")));
  let r = await request("POST", "/db/commit", { token: a.idToken, body: { writes: [{ op: "set", path: "tenants/tenA/apiKeys/k1", data: { hash: "x" } }] } });
  check("карантин: правило отказало своему владельцу", r.status === 403, `${r.status} ${r.raw.slice(0, 100)}`);
  const qf = path.join(dir, "rejected", "tenA.jsonl");
  const q = fs.existsSync(qf) ? fs.readFileSync(qf, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  check("карантин: отклонённая пачка своего заведения сохранена на сервере", q.length === 1 && q[0].writes[0].path === "tenants/tenA/apiKeys/k1" && q[0].code === "permission-denied", JSON.stringify(q).slice(0, 200));

  // ---- 4. Гость пишет мегабайтный комментарий — сервер не принимает.
  await set("tenants/tenA/clients/" + b.uid, { name: "Гость" });
  await set("tenants/tenA/public/features", { guestApp: true });
  r = await request("POST", "/db/commit", { token: b.idToken, body: { writes: [{ op: "set", path: "tenants/tenA/waiterCalls/w1", data: { clientUid: b.uid, sessionId: "", comment: "x".repeat(50000), status: "new" } }] } });
  check("гость: 50 000 символов в вызове официанта — отказ", r.status === 400 && /длинн/i.test(r.raw), `${r.status} ${r.raw.slice(0, 120)}`);
  check("гость: мегабайтный вызов не сохранён", !(await store.collection("tenants/tenA/waiterCalls").doc("w1").get()).exists);

  // ---- 5. Два «Собрать APK» в одну секунду — запускается одна сборка.
  const [b1, b2] = await Promise.all([
    request("POST", "/createBuildJob", { token: a.idToken, body: { tenantId: "tenA" } }),
    request("POST", "/createBuildJob", { token: a.idToken, body: { tenantId: "tenA" } }),
  ]);
  const jobs = (await store.collection("buildJobs").where("tenantId", "==", "tenA").get()).docs.map((d) => d.data());
  const queued = jobs.filter((j) => j.status === "queued").length;
  check("сборка: два нажатия разом — в очереди не больше одной сборки (3 приложения)", queued <= 3, `${b1.status} ${b2.status} ${JSON.stringify(jobs.map((j) => j.status))}`);
  console.log(`idor: ${passed} passed, ${failed} failed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
