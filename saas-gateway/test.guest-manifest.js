"use strict";
// Иконка веб-версии гостя на главном экране: манифест с названием, цветами и
// иконкой заведения (у точки сети — сети), загрузка иконки только PNG и только
// владельцем/админом, чужой адрес — отказ.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gman-"));
const PORT = 8094;
Object.assign(process.env, {
  PORT: String(PORT), DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "backups"), BRANDING_UPLOADS_DIR: path.join(dir, "branding"),
  DATA_AUTO_MIGRATE: "0", GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "gman-secret-key-0123456789abcdef",
});
const assert = require("assert/strict");
const server = require("./server.js");
const store = server.localDataStore();
const set = (p, d) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop()).set(d);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function req(method, p, { token, body, type = "application/json" } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method,
      headers: { "Content-Type": type, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, json: j, raw, headers: res.headers }); });
    });
    r.on("error", reject);
    r.end(Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined);
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const sign = async (email) => (await req("POST", "/auth/signup", { body: { email, password: "secret-123456" } })).json;
  const me = await sign("owner-m@test.ru");
  const other = await sign("other-m@test.ru");
  await set("tenants/k1", { name: "Колибри", slug: "kolibri", status: "active", ownerUserId: me.uid });
  await set(`tenantMembers/k1_${me.uid}`, { tenantId: "k1", userId: me.uid, role: "owner", status: "active" });
  const origin = "https://kolibri.zalpos.ru";
  const man = (t, o = origin) => req("GET", `/guestManifest?tenantId=${t}&origin=${encodeURIComponent(o)}`);

  // Без брендинга — общая иконка, но имя заведения и его адрес.
  let r = await man("k1");
  assert.equal(r.status, 200, r.raw);
  assert.match(r.headers["content-type"], /application\/manifest\+json/);
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.equal(r.json.name, "Колибри");
  assert.equal(r.json.start_url, `${origin}/app/`);
  assert.equal(r.json.id, `${origin}/app/`, "тот же id, что у прежнего манифеста — ярлык не дублируется");
  assert.equal(r.json.icons[0].src, `${origin}/app/icon-192.png`);

  // Логотип без иконки — логотип как есть.
  const logoUrl = "https://pii.zalpos.ru/branding/k1/logo.jpg?v=5";
  await set("tenants/k1/branding/config", { appName: "Kolibri Lounge Bar", logoUrl, backgroundColor: "#101820", primaryColor: "#C08040" });
  r = await man("k1");
  assert.equal(r.json.name, "Kolibri Lounge Bar");
  assert.equal(r.json.short_name, "Kolibri");
  assert.equal(r.json.background_color, "#101820");
  assert.deepEqual(r.json.icons.map((i) => [i.src, i.type]), [[logoUrl, "image/jpeg"]]);

  // Иконку грузит только владелец/админ, только PNG.
  assert.equal((await req("POST", "/uploadBrandingIcon?tenantId=k1&size=512", { token: other.idToken, body: PNG, type: "image/png" })).status, 403);
  assert.equal((await req("POST", "/uploadBrandingIcon?tenantId=k1&size=512", { token: me.idToken, body: Buffer.from("<svg/>"), type: "image/png" })).status, 400);
  assert.equal((await req("POST", "/uploadBrandingIcon?tenantId=k1&size=64", { token: me.idToken, body: PNG, type: "image/png" })).status, 400);
  for (const size of [512, 192]) {
    r = await req("POST", `/uploadBrandingIcon?tenantId=k1&size=${size}`, { token: me.idToken, body: PNG, type: "image/png" });
    assert.equal(r.status, 200, r.raw);
  }
  assert.ok(fs.existsSync(path.join(dir, "branding", "k1", "icon-512.png")));
  r = await man("k1");
  assert.deepEqual(r.json.icons.map((i) => [i.sizes, i.purpose]), [["192x192", "any"], ["512x512", "any"], ["512x512", "maskable"]]);
  assert.match(r.json.icons[1].src, /^https:\/\/pii\.zalpos\.ru\/branding\/k1\/icon-512\.png\?v=\d+$/);

  // Точка сети — название и логотип сети.
  await set("chains/c1", { name: "Сеть Утро", status: "active" });
  await set("chains/c1/branding/config", { logoUrl: "https://pii.zalpos.ru/branding/k1/logo.png" });
  await set("tenants/p1", { name: "Утро · Центр", slug: "utro-center", status: "active", chainId: "c1" });
  r = await man("p1", "https://utro-center.zalpos.ru");
  assert.equal(r.json.name, "Сеть Утро");
  assert.equal(r.json.icons.length, 3, "иконки лежат рядом с логотипом сети");

  // Чужой адрес и удалённое заведение — отказ.
  assert.equal((await man("k1", "https://evil.example.com")).status, 400);
  assert.equal((await man("k1", "https://kolibri.zalpos.ru/x")).status, 400);
  await set("tenants/d1", { name: "Удалено", status: "deleted" });
  assert.equal((await man("d1")).status, 404);
  assert.equal((await man("../x")).status, 400);
  console.log("guest-manifest: ok");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
