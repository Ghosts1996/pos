"use strict";
// ИИ-помощник гостя: не больше 20 вопросов в сутки на гостя, счётчик на
// сервере (переживает перезапуск), гостю коллекция счётчиков не видна.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-quota-"));
Object.assign(process.env, {
  PORT: "8099", DATA_BACKEND: "local", AUTH_BACKEND: "own",
  DATA_DB_FILE: path.join(dir, "data.sqlite"), AUTH_DB_FILE: path.join(dir, "auth.json"),
  SUPPORT_DB_FILE: path.join(dir, "support-db.json"), DATA_AUTO_MIGRATE: "0",
});
const server = require("./server.js");

(async () => {
  let passed = 0;
  const db = server.localDataStore();
  const day = Date.parse("2026-11-14T09:00:00Z");
  for (let i = 0; i < server.AI_GUEST_DAILY_LIMIT; i++) await server.takeGuestAiQuota(db, "guestA", day + i * 60000);
  passed++;
  await assert.rejects(server.takeGuestAiQuota(db, "guestA", day + 3600000), (e) => e.status === 429 && /20 раз в сутки/.test(e.message));
  passed++;
  // Другой гость — свой счётчик.
  await server.takeGuestAiQuota(db, "guestB", day);
  passed++;
  // Следующие сутки по Москве (00:00 МСК = 21:00 UTC) — снова можно.
  await server.takeGuestAiQuota(db, "guestA", Date.parse("2026-11-14T21:00:01Z"));
  passed++;
  // Гонка: 30 одновременных вопросов нового гостя — ровно 20 проходят.
  const res = await Promise.allSettled(Array.from({ length: 30 }, () => server.takeGuestAiQuota(db, "guestC", day)));
  assert.strictEqual(res.filter((r) => r.status === "fulfilled").length, 20);
  passed++;
  // Правила базы: гость не читает и не пишет счётчики (иначе обнулил бы себе лимит).
  const rules = fs.readFileSync(path.join(__dirname, "..", "saas", "firestore.rules"), "utf8");
  assert.ok(!/aiGuestDaily/.test(rules), "коллекции нет в правилах — для клиентов закрыта по умолчанию");
  // Настоящий защищённый слой сервера данных (как у клиентов): гость не
  // читает и не пишет счётчик; контроль — открытое меню он читает.
  const { createSecureDb, createDataStore } = require("./data-server");
  const admin = require("firebase-admin");
  const store = createDataStore({ admin, file: path.join(dir, "rules-check.sqlite") });
  const secure = createSecureDb({ store, rulesSource: rules, admin });
  const auth = { uid: "guestA", token: { sub: "guestA", user_id: "guestA", auth_time: Math.floor(Date.now() / 1000), firebase: { sign_in_provider: "custom" } } };
  const denied = (fn) => { try { fn(); return false; } catch (e) { return /permission|Нет доступа|denied/i.test(String(e.code || e.message)); } };
  assert.ok(!denied(() => secure.get(auth, "plans/start")), "контроль: открытые тарифы гость читает");
  assert.ok(denied(() => secure.get(auth, "aiGuestDaily/guestA_2026-11-14")), "чтение счётчика закрыто");
  assert.ok(denied(() => secure.commit(auth, [{ op: "set", path: "aiGuestDaily/guestA_2026-11-14", data: { count: 0 } }])), "сброс счётчика закрыт");
  passed++;
  // Сервер вызывает счётчик в /aiProxy только для гостей (не для кассы).
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.ok(/await takeGuestAiQuota\(firestore, decoded\.uid\);\n  \}/.test(src));
  passed++;
  console.log(`ai-guest-quota: ${passed} проверок`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
