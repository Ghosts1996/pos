"use strict";

// platform.js против настоящего saas-gateway (свой вход и свой сервер данных):
// проверка входа, чтение и запись документов, запасной путь.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const admin = require("firebase-admin");
const { createPlatform, isOwnToken } = require("./platform");

const gw = path.join(__dirname, "..", "saas-gateway", "server.js");
if (!fs.existsSync(path.join(__dirname, "..", "saas-gateway", "node_modules"))) {
  console.log("platform: пропущено — нет saas-gateway/node_modules");
  process.exit(0);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-platform-"));
const TOKEN = "internal-test-token-0123456789";
const port = 8099; // как smoke saas-gateway: без ботов и фоновых задач
const srv = spawn(process.execPath, [gw], {
  env: { ...process.env, PORT: String(port), AUTH_BACKEND: "own", DATA_BACKEND: "local", PII_INTERNAL_TOKEN: TOKEN,
    AUTH_DB_FILE: path.join(dir, "auth.json"), DATA_DB_FILE: path.join(dir, "data.sqlite"),
    TELEGRAM_SECRET_KEY: "pii-platform-test-key-0123456789", DATA_AUTO_MIGRATE: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (c) => (log += c));
srv.stderr.on("data", (c) => (log += c));
const url = `http://127.0.0.1:${port}`;

async function main() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${url}/auth/status`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  let fallbacks = 0;
  const p = createPlatform({ url, token: TOKEN, admin, firebaseApp: () => { fallbacks++; return null; } });
  assert.ok(p.enabled && p.available());

  const su = await fetch(`${url}/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "pii@test.ru", password: "secret123" }) }).then((r) => r.json());
  assert.ok(isOwnToken(su.idToken), "токен своего входа");
  const decoded = await p.verifyIdToken(su.idToken);
  assert.strictEqual(decoded.uid, su.uid);
  await assert.rejects(p.verifyIdToken("bad.token.x"));

  const db = p.firestore();
  await db.doc("tenants/t1").set({ name: "Кафе", chainId: "c1", createdAt: admin.firestore.FieldValue.serverTimestamp() });
  await db.doc("tenantMembers/t1_u1").set({ status: "active", role: "owner" });
  await db.doc("tenants/t1/reservations/r1").set({ clientUid: "g1", at: admin.firestore.Timestamp.fromMillis(1700000000000) });
  await db.doc("tenants/t1/reservations/r2").set({ clientUid: "g2" });
  const t = await db.doc("tenants/t1").get();
  assert.ok(t.exists && t.data().chainId === "c1");
  assert.ok(t.data().createdAt instanceof admin.firestore.Timestamp, "метка времени сервера");
  assert.strictEqual((await db.collection("tenantMembers").doc("t1_u1").get()).data().role, "owner");
  assert.strictEqual((await db.doc("tenants/none").get()).exists, false);
  const q = await db.collection("tenants/t1/reservations").where("clientUid", "==", "g1").get();
  assert.deepStrictEqual(q.docs.map((d) => d.id), ["r1"]);
  assert.strictEqual(q.docs[0].data().at.toMillis(), 1700000000000);
  const chain = await db.collection("tenants").where("chainId", "==", "c1").get();
  assert.deepStrictEqual(chain.docs.map((d) => d.id), ["t1"]);
  await db.doc("tenants/t1").set({ phoneOnFile: true }, { merge: true });
  assert.strictEqual((await db.doc("tenants/t1").get()).data().name, "Кафе", "merge не стирает поля");
  await assert.rejects(db.doc("superAdmins/x").get(), /путь/, "чужие коллекции закрыты");
  assert.strictEqual(fallbacks, 0);

  // Неверный секрет — запасной путь (Firebase), а свой токен — без запасного пути.
  const bad = createPlatform({ url, token: "wrong-token-000000000000000000", admin, firebaseApp: () => { fallbacks++; return null; } });
  await assert.rejects(bad.verifyIdToken(su.idToken));
  await assert.rejects(bad.firestore().doc("tenants/t1").get(), /не подключён/);
  assert.ok(fallbacks >= 1);
  const down = createPlatform({ url: "http://127.0.0.1:1", token: TOKEN, admin, firebaseApp: () => null });
  await assert.rejects(down.verifyIdToken(su.idToken), /недоступен/);
  console.log("platform: 4 группы проверок прошли");
}

main().then(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); }, (e) => {
  console.error(e);
  console.error(log.slice(-1500));
  srv.kill();
  process.exit(1);
});
