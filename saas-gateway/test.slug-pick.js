"use strict";
// Код заведения → заведение, если с кодом их несколько (старая копия,
// перенос): веб-версия гостя по QR стола попадает туда, где стол; без QR —
// в живое (устройства, столы), а не в первое попавшееся; Android — в своё
// (prefer). /findTableVenue находит заведение стола только с верным секретом.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slugpick-"));
const PORT = 8093;
Object.assign(process.env, {
  PORT: String(PORT), DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0", GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "slug-secret-key-0123456789abcdef",
});
const assert = require("assert/strict");
const server = require("./server.js");
const admin = require("firebase-admin");
const store = server.localDataStore();
const T = (ms) => admin.firestore.Timestamp.fromMillis(ms);
const set = (p, d) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop()).set(d);

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method, headers: { "Content-Type": "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const now = Date.now();
  // Настоящее заведение: касса, столы, стол с секретом.
  await set("tenants/real1", { name: "Колибри", slug: "kolibri-x", status: "active", createdAt: T(now - 90 * 864e5) });
  await set("tenants/real1/devices/d1", { name: "Касса" });
  await set("tenants/real1/tables/tbl-uuid-1", { name: "Стол 4" });
  await set("tenants/real1/tableKeys/tbl-uuid-1", { key: "SECRETKEY123" });
  // Пустая копия с тем же кодом — новее.
  await set("tenants/copy1", { name: "Колибри", slug: "kolibri-x", status: "active", createdAt: T(now - 864e5), updatedAt: T(now) });
  // Удалённая — не в счёт.
  await set("tenants/del1", { name: "Колибри", slug: "kolibri-x", status: "deleted", createdAt: T(now) });
  // Другое заведение со своим кодом и столом.
  await set("tenants/other1", { name: "Другое", slug: "other-x", status: "active" });
  await set("tenants/other1/tables/tbl-other", { name: "Стол 1" });

  let r = await req("POST", "/resolveTenantBySlug", { slug: "kolibri-x" });
  assert.equal(r.json.tenantId, "real1", "без QR — живое заведение (касса, столы), а не новая пустая копия");
  r = await req("POST", "/resolveTenantBySlug", { slug: "kolibri-x", tableId: "tbl-uuid-1", key: "SECRETKEY123" });
  assert.equal(r.json.tenantId, "real1", "по QR — где стол");
  r = await req("POST", "/resolveTenantBySlug", { slug: "kolibri-x", prefer: "copy1" });
  assert.equal(r.json.tenantId, "copy1", "устройство уже в своём заведении — туда же");
  r = await req("POST", "/resolveTenantBySlug", { slug: "other-x" });
  assert.equal(r.json.tenantId, "other1", "один — как раньше");
  r = await req("POST", "/resolveTenantBySlug", { slug: "nobody-x" });
  assert.equal(r.status, 404);

  r = await req("POST", "/findTableVenue", { tableId: "tbl-uuid-1", key: "SECRETKEY123", slug: "kolibri-x" });
  assert.deepEqual([r.status, r.json.tenantId, r.json.slug], [200, "real1", "kolibri-x"]);
  r = await req("POST", "/findTableVenue", { tableId: "tbl-uuid-1", key: "wrong", slug: "kolibri-x" });
  assert.equal(r.status, 404, "без верного секрета — не раскрываем заведение");
  r = await req("POST", "/findTableVenue", { tableId: "tbl-other", slug: "kolibri-x" });
  assert.deepEqual([r.status, r.json.slug], [200, "other-x"], "стол другого заведения — его код");
  r = await req("POST", "/findTableVenue", { tableId: "../x", slug: "kolibri-x" });
  assert.equal(r.status, 400);
  console.log("slug-pick: ok");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
