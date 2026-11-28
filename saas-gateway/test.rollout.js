"use strict";
// Экономия минут сборок: автообновление приложений — ночью одной сборкой,
// Windows — только заведениям с Windows-кассой, без живых касс — не собираем.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-"));
Object.assign(process.env, {
  PORT: "8093", DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "s.json"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "b"), DATA_AUTO_MIGRATE: "0", REJECTED_DIR: path.join(dir, "r"), GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "rollout-secret-key-0123456789abcdef",
});
const server = require("./server.js");
const admin = require("firebase-admin");
const store = server.localDataStore();
const set = (p, d) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop()).set(d);
const T = (ms) => admin.firestore.Timestamp.fromMillis(ms);

(async () => {
  let n = 0;
  // 03:20 МСК = 00:20 UTC: днём — следующей ночью, ночью до 03:20 — этой же.
  const day = Date.parse("2026-11-28T10:00:00Z");
  assert.equal(new Date(server.nextRolloutNight(day)).toISOString(), "2026-11-29T00:20:00.000Z");
  const night = Date.parse("2026-11-28T00:05:00Z");
  assert.equal(new Date(server.nextRolloutNight(night)).toISOString(), "2026-11-28T00:20:00.000Z");
  n++;

  const now = Date.now();
  // Заведение без устройств — кассами не пользуются.
  await set("tenants/tIdle", { name: "Idle", status: "active" });
  let u = await server.tenantDeviceUsage("tIdle");
  assert.equal(u.active, false);
  // Касса Android подключена недавно — пользуются, Windows нет.
  await set("tenants/tA", { name: "A", status: "active" });
  await set("tenants/tA/devices/dev1", { platform: "android", status: "active", createdAt: T(now - 86400000) });
  u = await server.tenantDeviceUsage("tA");
  assert.deepEqual([u.active, u.windows], [true, false]);
  // Добавилась Windows-касса — Windows собираем.
  await set("tenants/tA/devices/dev2", { platform: "windows", status: "active", createdAt: T(now - 3600000) });
  u = await server.tenantDeviceUsage("tA");
  assert.deepEqual([u.active, u.windows], [true, true]);
  // Удалённая и давно молчащая кассы не в счёт.
  await set("tenants/tOld", { name: "Old", status: "active" });
  await set("tenants/tOld/devices/d1", { platform: "windows", status: "removed", createdAt: T(now) });
  await set("tenants/tOld/devices/d2", { platform: "android", status: "active", createdAt: T(now - 90 * 86400000) });
  u = await server.tenantDeviceUsage("tOld");
  assert.deepEqual([u.active, u.windows], [false, false]);
  n++;

  // Касса подключена давно, но работает каждый день: продление входа
  // отмечает «был онлайн» — автообновление её не пропустит.
  const oa = server.ownAuth();
  const anon = await oa.anonymous({ device: "t" });
  await set("tenants/tLive", { name: "Live", status: "active" });
  await set(`tenants/tLive/devices/${anon.uid}`, { platform: "android", status: "active", createdAt: T(now - 120 * 86400000) });
  await oa.refresh(anon.refreshToken);
  u = await server.tenantDeviceUsage("tLive");
  assert.equal(u.active, true);
  n++;

  console.log(`rollout: ${n} из 3 проверок`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
