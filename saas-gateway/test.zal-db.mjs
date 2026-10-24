// Клиент кабинета и веб-приложения гостя (saas/console/zal-db.js) против
// настоящего сервера данных (data-server.js + saas/firestore.rules).
// Запуск: node --experimental-eventsource test.zal-db.mjs

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { startHarness } = require("./test-data-harness.js");

const consoleSrc = fs.readFileSync(path.join(here, "..", "saas", "console", "zal-db.js"), "utf8");
const guestSrc = fs.readFileSync(path.join(here, "..", "saas", "guest-web", "app", "zal-db.js"), "utf8");
assert.strictEqual(guestSrc, consoleSrc, "saas/guest-web/app/zal-db.js должен совпадать с saas/console/zal-db.js");

// Firebase с CDN в Node не загрузить — подставляем то, что нужно клиенту.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zaldb-"));
fs.writeFileSync(path.join(dir, "firestore-stub.mjs"), `
export class Timestamp {
  constructor(ms) { this.ms = ms; }
  static fromMillis(ms) { return new Timestamp(ms); }
  static fromDate(d) { return new Timestamp(d.getTime()); }
  toMillis() { return this.ms; }
  toDate() { return new Date(this.ms); }
}
export const getFirestore = () => ({ firestore: true });
`);
fs.writeFileSync(path.join(dir, "zal-db.mjs"), consoleSrc.replace(
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js", "./firestore-stub.mjs"));
const Z = await import(pathToFileURL(path.join(dir, "zal-db.mjs")).href);

if (typeof EventSource === "undefined") {
  console.error("zal-db: нужен node --experimental-eventsource");
  process.exit(1);
}

const { server, port } = await startHarness(0);
const gateway = `http://127.0.0.1:${port}`;
const authAs = (uid) => ({ currentUser: { uid, getIdToken: async () => `test:${uid}` }, onAuthStateChanged() {} });
const waitFor = (fn, ms = 5000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    let v;
    try { v = fn(); } catch (_) {}
    if (v) return resolve(v);
    if (Date.now() - t0 > ms) return reject(new Error("не дождались"));
    setTimeout(tick, 10);
  };
  tick();
});

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  }
};

const db = await Z.openDb({}, { gateway, auth: authAs("ownerA") });
const other = await Z.openDb({}, { gateway, auth: authAs("ownerA") });

await test("выбор хранилища по серверу", async () => {
  assert.ok(Z.isOwnServer(db));
  const fsDb = await Z.openDb({}, { gateway: "http://127.0.0.1:1", auth: authAs("x") });
  assert.deepStrictEqual(fsDb, { firestore: true }, "сервер недоступен — Firestore, как раньше");
});

await test("чтение, запрос, отказ в чужих данных", async () => {
  const s = await Z.getDoc(Z.doc(db, "tenants", "tenantA", "tables", "t1"));
  assert.ok(s.exists());
  assert.strictEqual(s.data().name, "Стол 1");
  assert.strictEqual(s.get("name"), "Стол 1");
  const q = await Z.getDocs(Z.query(Z.collection(db, "tenants/tenantA/tables"), Z.where("x", ">", 0.2), Z.orderBy("x"), Z.limit(5)));
  assert.deepStrictEqual(q.docs.map((d) => d.id), ["t2"]);
  await assert.rejects(Z.getDoc(Z.doc(db, "tenants/tenantB/tables/t1")), (e) => e.code === "permission-denied");
});

await test("запись, служебные значения, пачка", async () => {
  const ref = Z.doc(Z.collection(db, "tenants/tenantA/tables"));
  await Z.setDoc(ref, { name: "Новый", at: Z.Timestamp.fromMillis(1000), tmp: 1 });
  await Z.updateDoc(ref, { tmp: Z.deleteField(), "meta.a": 2 });
  const d = (await Z.getDoc(ref)).data();
  assert.strictEqual(d.at.toMillis(), 1000);
  assert.ok(!("tmp" in d));
  assert.deepStrictEqual(d.meta, { a: 2 });
  const b = Z.writeBatch(db);
  b.set(Z.doc(db, "tenants/tenantA/tables/b1"), { name: "П1" });
  b.update(ref, { name: "Изменён" });
  await b.commit();
  assert.strictEqual((await Z.getDoc(ref)).data().name, "Изменён");
  const added = await Z.addDoc(Z.collection(db, "tenants/tenantA/tables"), { name: "add" });
  assert.strictEqual((await Z.getDoc(added)).data().name, "add");
  await Z.deleteDoc(added);
  assert.strictEqual((await Z.getDoc(added)).exists(), false);
});

await test("живые подписки: документ и запрос, изменения с другого устройства", async () => {
  const docSeen = [];
  const qSeen = [];
  const u1 = Z.onSnapshot(Z.doc(db, "tenants/tenantA/tables/live"), (s) => docSeen.push(s.exists() ? s.data().n : null));
  const u2 = Z.onSnapshot(Z.query(Z.collection(db, "tenants/tenantA/tables"), Z.orderBy("name")), {
    next: (s) => qSeen.push(s.docChanges().map((c) => `${c.type}:${c.doc.id}`).join(",")),
  });
  await waitFor(() => docSeen.length >= 1 && qSeen.length >= 1);
  assert.deepStrictEqual(docSeen, [null]);
  await Z.setDoc(Z.doc(other, "tenants/tenantA/tables/live"), { name: "Ж", n: 1 });
  await waitFor(() => docSeen.includes(1) && qSeen.some((x) => x.includes("added:live")));
  await Z.updateDoc(Z.doc(other, "tenants/tenantA/tables/live"), { n: 2 });
  await waitFor(() => docSeen.includes(2) && qSeen.some((x) => x.includes("modified:live")));
  await Z.deleteDoc(Z.doc(other, "tenants/tenantA/tables/live"));
  await waitFor(() => docSeen[docSeen.length - 1] === null && qSeen.some((x) => x.includes("removed:live")));
  u1();
  u2();
  let errored = null;
  Z.onSnapshot(Z.doc(db, "tenants/tenantB/tables/t1"), () => {}, (e) => { errored = e; });
  await waitFor(() => errored);
  assert.strictEqual(errored.code, "permission-denied");
});

await test("связь пропала и вернулась — подписка продолжает работать", async () => {
  const seen = [];
  const u = Z.onSnapshot(Z.doc(db, "tenants/tenantA/tables/net"), (s) => seen.push(s.exists() ? s.data().v : null));
  await waitFor(() => seen.length >= 1);
  await fetch(`${gateway}/__offline`, { method: "POST", body: JSON.stringify({ on: true }) });
  await new Promise((r) => setTimeout(r, 300));
  await fetch(`${gateway}/__offline`, { method: "POST", body: JSON.stringify({ on: false }) });
  await Z.setDoc(Z.doc(other, "tenants/tenantA/tables/net"), { name: "Сеть", v: 7 });
  await waitFor(() => seen.includes(7), 20000);
  u();
});

await test("защита сервера: __proto__, «..», документ больше 1 МБ, чужой путь", async () => {
  const post = (body) => fetch(`${gateway}/db/commit`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test:ownerA" }, body: JSON.stringify(body) });
  const bad = async (w, re) => {
    const r = await post({ writes: [w] });
    assert.ok(r.status >= 400 && r.status < 500, `ожидали отказ, а ${r.status}`);
    const j = await r.json();
    assert.ok(re.test(j.error || ""), j.error);
  };
  await bad({ op: "set", path: "tenants/tenantA/tables/p1", data: JSON.parse('{"__proto__":{"role":"owner"}}') }, /имя поля/);
  await bad({ op: "update", path: "tenants/tenantA/tables/t1", data: { "a.__proto__.b": 1 } }, /имя поля/);
  await bad({ op: "set", path: "tenants/tenantA/tables/..", data: { a: 1 } }, /путь/);
  await bad({ op: "set", path: "tenants/tenantA/tables/__x__", data: { a: 1 } }, /путь/);
  await bad({ op: "set", path: "tenants/tenantA/tables/big", data: { s: "x".repeat(1100000) } }, /1 МБ/);
  await bad({ op: "set", path: "tenants/tenantB/tables/x", data: { a: 1 } }, /доступа/);
  const r = await fetch(`${gateway}/db/get`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: ["tenants/tenantA/tables/t1"] }) });
  assert.strictEqual(r.status, 403, "без входа данные заведения закрыты");
});

server.closeAllConnections();
server.close();
console.log(`zal-db: ${passed} проверок`);
process.exit(process.exitCode || 0);
