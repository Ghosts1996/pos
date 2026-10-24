"use strict";
// Хранилище на диске сервера (local-db.js): то же поведение, что у Firestore,
// в объёме, который нужен боту поддержки.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const admin = require("firebase-admin");
const { createLocalDb } = require("./local-db");

const { Timestamp, FieldValue } = admin.firestore;
let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = () => new Promise((r) => setImmediate(r));

test("документы: set, merge, update по вложенным полям, служебные значения", async () => {
  const db = createLocalDb({ admin });
  const ref = db.collection("supportTickets").doc("t1");
  await ref.set({ status: "open", n: 1, tags: ["a"], meta: { a: 1, b: 2 }, at: Timestamp.fromMillis(1000) });
  await ref.set({ meta: { b: 3 }, n: FieldValue.increment(2) }, { merge: true });
  let d = (await ref.get()).data();
  assert.deepStrictEqual(d.meta, { a: 1, b: 3 });
  assert.strictEqual(d.n, 3);
  assert.ok(d.at instanceof Timestamp && d.at.toMillis() === 1000);
  await ref.update({ "meta.c": 4, tags: FieldValue.arrayUnion("a", "b"), status: FieldValue.delete(), seen: FieldValue.serverTimestamp() });
  d = (await ref.get()).data();
  assert.deepStrictEqual(d.meta, { a: 1, b: 3, c: 4 });
  assert.deepStrictEqual(d.tags, ["a", "b"]);
  assert.ok(!("status" in d));
  assert.ok(d.seen instanceof Timestamp);
  await ref.update({ tags: FieldValue.arrayRemove("a") });
  assert.deepStrictEqual((await ref.get()).data().tags, ["b"]);
  // Снаружи данные в памяти не меняются.
  d.meta.a = 999;
  assert.strictEqual((await ref.get()).data().meta.a, 1);
  await assert.rejects(db.collection("x").doc("нет").update({ a: 1 }), /NOT_FOUND/);
  // Date сохраняется меткой времени, как в Firestore.
  await ref.set({ when: new Date(5000) }, { merge: true });
  assert.ok((await ref.get()).data().when instanceof Timestamp);
  await ref.delete();
  assert.strictEqual((await ref.get()).exists, false);
});

test("запросы: where (==, >, in, array-contains), orderBy, limit, вложенные коллекции", async () => {
  const db = createLocalDb({ admin });
  const col = db.collection("supportTickets");
  await col.doc("a").set({ status: "open", lastAuthorRole: "owner", no: 3, updatedAt: Timestamp.fromMillis(300), tags: ["x"] });
  await col.doc("b").set({ status: "open", lastAuthorRole: "ai", no: 1, updatedAt: Timestamp.fromMillis(100) });
  await col.doc("c").set({ status: "closed", lastAuthorRole: "owner", no: 2, updatedAt: Timestamp.fromMillis(200) });
  const ids = (snap) => snap.docs.map((d) => d.id);
  assert.deepStrictEqual(ids(await col.where("status", "==", "open").get()), ["a", "b"]);
  assert.deepStrictEqual(ids(await col.where("status", "==", "open").where("lastAuthorRole", "==", "owner").get()), ["a"]);
  // Как в Firestore: неравенство без orderBy сортирует по этому полю.
  assert.deepStrictEqual(ids(await col.where("updatedAt", ">", Timestamp.fromMillis(150)).get()), ["c", "a"]);
  // Курсоры, offset, limitToLast, поиск по всем одноимённым коллекциям, подсчёт.
  const ordered = col.orderBy("no");
  assert.deepStrictEqual(ids(await ordered.startAfter(1).get()), ["c", "a"]);
  assert.deepStrictEqual(ids(await ordered.endBefore(3).get()), ["b", "c"]);
  assert.deepStrictEqual(ids(await ordered.startAt((await col.doc("c").get())).get()), ["c", "a"]);
  assert.deepStrictEqual(ids(await ordered.offset(1).limit(1).get()), ["c"]);
  assert.deepStrictEqual(ids(await ordered.limitToLast(2).get()), ["c", "a"]);
  assert.strictEqual((await col.where("status", "==", "open").count().get()).data().count, 2);
  assert.deepStrictEqual(ids(await col.orderBy(admin.firestore.FieldPath.documentId()).startAfter("a").limit(1).get()), ["b"]);
  assert.deepStrictEqual(ids(await col.where("no", "in", [1, 2]).get()), ["b", "c"]);
  assert.deepStrictEqual(ids(await col.where("tags", "array-contains", "x").get()), ["a"]);
  assert.deepStrictEqual(ids(await col.orderBy("updatedAt", "desc").limit(2).get()), ["a", "c"]);
  const snap = await col.limit(1).get();
  assert.strictEqual(snap.size, 1);
  assert.strictEqual(snap.empty, false);
  const m = await col.doc("a").collection("messages").add({ text: "привет", createdAt: Timestamp.fromMillis(1) });
  assert.ok(m.id.length >= 16);
  assert.strictEqual((await col.doc("a").collection("messages").get()).size, 1);
  assert.strictEqual((await col.get()).size, 3, "вложенные документы не в выборке коллекции");
  assert.strictEqual(m.parent.path, "supportTickets/a/messages");
  await col.doc("b").collection("messages").add({ text: "ещё" });
  assert.strictEqual((await db.collectionGroup("messages").get()).size, 2);
  assert.deepStrictEqual((await db.listCollections()).map((c) => c.id), ["supportTickets"]);
  assert.deepStrictEqual((await col.doc("a").listCollections()).map((c) => c.id), ["messages"]);
  await db.recursiveDelete(col.doc("a"));
  assert.strictEqual((await db.collectionGroup("messages").get()).size, 1);
  assert.strictEqual((await col.doc("a").get()).exists, false);
});

test("слежение: первый снимок, добавление, изменение, выход из выборки", async () => {
  const db = createLocalDb({ admin });
  const col = db.collection("supportTickets");
  await col.doc("a").set({ updatedAt: Timestamp.fromMillis(500) });
  const seen = [];
  const unsub = col.where("updatedAt", ">", Timestamp.fromMillis(100)).onSnapshot((snap) => {
    seen.push(snap.docChanges().map((ch) => `${ch.type}:${ch.doc.id}`).join(","));
  });
  await tick();
  await col.doc("b").set({ updatedAt: Timestamp.fromMillis(600) });
  await tick();
  await col.doc("a").set({ x: 1 }, { merge: true });
  await tick();
  await col.doc("a").set({ updatedAt: Timestamp.fromMillis(50) }, { merge: true });
  await tick();
  await col.doc("z").set({ other: true }); // не в выборке — без события
  await tick();
  unsub();
  await col.doc("b").delete();
  await tick();
  assert.deepStrictEqual(seen, ["added:a", "added:b", "modified:a", "removed:a"]);
  const docSeen = [];
  const u2 = col.doc("q").onSnapshot((s) => docSeen.push(s.exists));
  await tick();
  await col.doc("q").set({ a: 1 });
  await tick();
  u2();
  assert.deepStrictEqual(docSeen, [false, true]);
});

test("транзакции по очереди: счётчик не теряет увеличений", async () => {
  const db = createLocalDb({ admin });
  const ref = db.collection("supportBot").doc("counter");
  const next = () => db.runTransaction(async (tx) => {
    const n = (Number(((await tx.get(ref)).data() || {}).n) || 0) + 1;
    await tick();
    tx.set(ref, { n }, { merge: true });
    return n;
  });
  const got = await Promise.all([next(), next(), next()]);
  assert.deepStrictEqual(got.sort(), [1, 2, 3]);
  assert.strictEqual((await ref.get()).data().n, 3);
  await assert.rejects(db.runTransaction(async () => { throw new Error("сбой"); }), /сбой/);
  assert.strictEqual(await next(), 4, "после ошибки транзакции очередь работает");
});

test("диск: запись, чтение после перезапуска, копия за сутки, права 600", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ldb-"));
  const file = path.join(dir, "support-db.json");
  let day = Date.UTC(2026, 9, 1, 12);
  const db = createLocalDb({ admin, file, flushMs: 5, keepDays: 2, now: () => day });
  assert.strictEqual(db.loaded, false);
  await db.collection("supportTickets").doc("a").set({ text: "Привет", at: Timestamp.fromMillis(42), list: [Timestamp.fromMillis(7)] });
  await db.flush();
  assert.ok(fs.existsSync(file));
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  const again = createLocalDb({ admin, file });
  assert.strictEqual(again.loaded, true);
  const d = (await again.collection("supportTickets").doc("a").get()).data();
  assert.strictEqual(d.text, "Привет");
  assert.ok(d.at instanceof Timestamp && d.at.toMillis() === 42);
  assert.strictEqual(d.list[0].toMillis(), 7);
  // Новые сутки — копия вчерашнего файла; старше keepDays — удаляются.
  for (let i = 1; i <= 4; i++) {
    day += 24 * 3600 * 1000;
    await db.collection("supportTickets").doc("a").set({ i }, { merge: true });
    await db.flush();
  }
  const copies = fs.readdirSync(dir).filter((f) => /^support-db-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  assert.strictEqual(copies.length, 2, copies.join(","));
  // Синхронная запись при остановке.
  await db.collection("supportTickets").doc("b").set({ last: true });
  db.flushSync();
  assert.strictEqual((await createLocalDb({ admin, file }).collection("supportTickets").doc("b").get()).data().last, true);
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test("wire: метки времени для JSON-ответов кабинету", async () => {
  const db = createLocalDb({ admin });
  assert.deepStrictEqual(db.wire({ a: Timestamp.fromMillis(9), b: [new Date(3)], c: { d: 1 } }), { a: { __ts: 9 }, b: [{ __ts: 3 }], c: { d: 1 } });
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.error(`✗ ${name}\n  ${e && e.stack ? e.stack : e}`);
    }
  }
  console.log(`local-db: ${passed} из ${passed + failed} проверок`);
  if (failed) process.exit(1);
})();
