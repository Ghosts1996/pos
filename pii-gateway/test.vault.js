"use strict";

// Справочник в РФ (vault.js) на настоящем Postgres: схема накатывается
// поверх старой (как на сервере при обновлении), права — как у сервиса.
// Firestore и проверка токена — подделки. Нужен Postgres:
//   PII_TEST_PG=postgres://postgres@127.0.0.1:5499/postgres npm run test:vault
// Без PII_TEST_PG тест пропускается (в CI базы нет).

const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { createVault } = require("./vault");

const ADMIN_URL = process.env.PII_TEST_PG;
if (!ADMIN_URL) {
  console.log("vault: пропущено — нет PII_TEST_PG");
  process.exit(0);
}

const DB = `pii_vault_test_${process.pid}`;
const u = new URL(ADMIN_URL);
const psql = (db, args, input) =>
  execFileSync("psql", ["-h", u.hostname, "-p", u.port || "5432", "-U", u.username || "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-d", db, ...args], { input, stdio: ["pipe", "pipe", "pipe"] }).toString();

function fakeFirestore(docs) {
  return () => ({
    doc: (p) => ({
      get: async () => ({ exists: p in docs, data: () => docs[p] }),
    }),
  });
}

const OLD_SCHEMA = `
CREATE TABLE guest_profiles (tenant_id TEXT NOT NULL DEFAULT '', uid TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, uid));
CREATE TABLE contact_records (tenant_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, kind, record_id));
INSERT INTO guest_profiles (tenant_id, uid, name, phone) VALUES ('t1', 'g-old', 'Старый гость', '79001112233');
INSERT INTO contact_records (tenant_id, kind, record_id, name, phone, created_by) VALUES ('t1', 'reservation', 'r-old', 'Бронь', '79005556677', 'g-old');
`;

let n = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

(async () => {
  psql("postgres", ["-c", `CREATE DATABASE ${DB}`]);
  try {
    psql("postgres", ["-c", "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pii_gateway') THEN CREATE ROLE pii_gateway LOGIN; END IF; END $$;"]);
  } catch (_) { /* роль уже есть */ }
  psql(DB, [], OLD_SCHEMA);
  // Новая схема поверх старой — дважды: на сервере она применяется при каждом обновлении.
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  psql(DB, [], schema);
  psql(DB, [], schema);

  const pool = new Pool({ host: u.hostname, port: Number(u.port || 5432), user: "pii_gateway", database: DB });
  const docs = {
    "tenants/t1": { chainId: "" },
    "tenants/t2": { chainId: "c1" },
    "tenants/t3": { chainId: "c1" },
    "tenantMembers/t1_staff1": { status: "active", role: "employee" },
    "tenantMembers/t1_gone": { status: "removed", role: "admin" },
    "tenantMembers/t2_staff2": { status: "active", role: "admin" },
    "tenants/t1/meta/tipsTeam": { members: { e1: { position: "waiter" } } },
    "tenants/t1/sessions/s-kassa": { clientUid: "g1" },
  };
  const vault = createVault({
    query: (sql, params) => pool.query(sql, params),
    firestore: fakeFirestore(docs),
    verifyToken: async (t) => {
      if (!t.startsWith("tok:")) throw new Error("bad");
      return { uid: t.slice(4) };
    },
    internalToken: "s3cret-internal-token",
    cacheMs: 0,
  });
  const as = (uid) => (body) => vault.handle({ token: `tok:${uid}`, internal: "" }, body);
  const staff = as("staff1");
  const guest = as("g1");
  const other = as("g2");
  const internal = (body) => vault.handle({ token: "", internal: "s3cret-internal-token" }, body);

  test("старые записи после обновления схемы на месте, extra пустой", async () => {
    const r = await staff({ tenantId: "t1", kind: "pii_lookup", refs: [{ k: "guest", id: "g-old" }, { k: "reservation", id: "r-old" }] });
    assert.equal(r.status, 200);
    assert.equal(r.json.guests[0].name, "Старый гость");
    assert.deepEqual(r.json.contacts[0].extra, {});
  });

  test("без токена, с чужим токеном и с бывшим сотрудником — отказ", async () => {
    assert.equal((await vault.handle({ token: "", internal: "" }, { tenantId: "t1", kind: "pii_sync" })).status, 401);
    assert.equal((await vault.handle({ token: "", internal: "wrong" }, { tenantId: "t1", kind: "pii_sync" })).status, 401);
    assert.equal((await as("gone")({ tenantId: "t1", kind: "pii_sync" })).status, 403);
    assert.equal((await guest({ tenantId: "t1", kind: "pii_sync" })).status, 403);
    assert.equal((await staff({ tenantId: "t1/x", kind: "pii_sync" })).status, 400);
    assert.equal((await staff({ tenantId: "nope", kind: "pii_sync" })).status, 404);
  });

  test("сотрудник: запись, правка частично (null — не трогать), синхронизация", async () => {
    let r = await staff({ tenantId: "t1", kind: "pii_put", k: "staff", id: "e1", fields: { name: "Анна", phone: "8 (900) 123-45-67" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await staff({ tenantId: "t1", kind: "pii_put", k: "staff", id: "e1", fields: { name: "Анна К." } });
    assert.equal(r.status, 200);
    r = await staff({ tenantId: "t1", kind: "pii_lookup", refs: [{ k: "staff", id: "e1" }] });
    assert.deepEqual([r.json.staff[0].name, r.json.staff[0].phone], ["Анна К.", "79001234567"]);
  });

  test("гость: свой профиль — да, чужой — нет; телефон нормализуется", async () => {
    assert.equal((await guest({ tenantId: "t1", kind: "pii_put", k: "guest", id: "g1", fields: { name: "Иван", phone: "+7 911 222-33-44" } })).status, 200);
    assert.equal((await guest({ tenantId: "t1", kind: "pii_put", k: "guest", id: "g2", fields: { name: "Чужой" } })).status, 403);
    const own = await guest({ tenantId: "t1", kind: "pii_lookup", refs: [{ k: "guest", id: "g1" }, { k: "guest", id: "g-old" }] });
    assert.deepEqual(own.json.guests.map((x) => x.id), ["g1"]);
    assert.equal(own.json.guests[0].phone, "79112223344");
  });

  test("гость видит имена только тех сотрудников, кто на смене, и без телефона", async () => {
    await staff({ tenantId: "t1", kind: "pii_put", k: "staff", id: "e2", fields: { name: "Борис" } });
    const r = await guest({ tenantId: "t1", kind: "pii_lookup", refs: [{ k: "staff", id: "e1" }, { k: "staff", id: "e2" }] });
    assert.deepEqual(r.json.staff.map((x) => [x.id, x.name, x.phone]), [["e1", "Анна К.", ""]]);
  });

  test("контакты: гость пишет свой, чужой не перезаписать; персонал правит любой", async () => {
    assert.equal((await guest({ tenantId: "t1", kind: "pii_put", k: "reservation", id: "r1", fields: { name: "Иван", phone: "79112223344" } })).status, 200);
    assert.equal((await other({ tenantId: "t1", kind: "pii_put", k: "reservation", id: "r1", fields: { name: "Взлом" } })).status, 403);
    assert.equal((await staff({ tenantId: "t1", kind: "pii_put", k: "reservation", id: "r1", fields: { name: "Иван Петров" } })).status, 200);
    const mine = await guest({ tenantId: "t1", kind: "pii_lookup", refs: [{ k: "reservation", id: "r1" }, { k: "reservation", id: "r-old" }] });
    assert.deepEqual(mine.json.contacts.map((x) => [x.id, x.name]), [["r1", "Иван Петров"]]);
  });

  test("доставка: доп. поля сливаются, null удаляет ключ; гость не ставит курьера", async () => {
    let r = await staff({ tenantId: "t1", kind: "pii_put", k: "delivery", id: "s-kassa", fields: { name: "Иван", address: "Ленина, 1", extra: { comment: "домофон 5", courierName: "Пётр", courierPhone: "79990001122" } } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await staff({ tenantId: "t1", kind: "pii_put", k: "delivery", id: "s-kassa", fields: { extra: { courierPhone: null } } });
    assert.equal(r.status, 200);
    // Заказ записал кассир, но он гостя g1 (sessions.clientUid) — гость его видит.
    r = await guest({ tenantId: "t1", kind: "pii_lookup", refs: [{ k: "delivery", id: "s-kassa" }] });
    assert.deepEqual(r.json.contacts[0].extra, { comment: "домофон 5", courierName: "Пётр" });
    assert.equal((await other({ tenantId: "t1", kind: "pii_lookup", refs: [{ k: "delivery", id: "s-kassa" }] })).json.contacts.length, 0);
    assert.equal((await guest({ tenantId: "t1", kind: "pii_put", k: "delivery", id: "s-g", fields: { extra: { courierName: "x" } } })).status, 400);
    assert.equal((await guest({ tenantId: "t1", kind: "pii_put", k: "delivery", id: "s-g", fields: { address: "Мира, 2", extra: { comment: "к 19:00" } } })).status, 200);
    assert.equal((await guest({ tenantId: "t1", kind: "pii_put", k: "card", id: "c1", fields: { name: "x" } })).status, 403);
    assert.equal((await staff({ tenantId: "t1", kind: "pii_put", k: "card", id: "c1", fields: { name: "Постоянный", extra: { notes: "скидка" } } })).status, 200);
  });

  test("синхронизация страницами без потерь и повторов по курсору", async () => {
    const items = [];
    for (let i = 0; i < 1500; i++) items.push({ k: "session", id: `bulk${String(i).padStart(4, "0")}`, fields: { extra: { guestTag: `Стол ${i}` } } });
    for (let i = 0; i < items.length; i += 200) {
      const r = await internal({ tenantId: "t1", kind: "pii_put", items: items.slice(i, i + 200) });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    const seen = new Map();
    let since = {};
    for (let page = 0; page < 10; page++) {
      const r = await staff({ tenantId: "t1", kind: "pii_sync", since });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      for (const c of r.json.contacts) seen.set(`${c.k}:${c.id}`, (seen.get(`${c.k}:${c.id}`) || 0) + 1);
      since = r.json.cursor;
      if (!r.json.more) break;
    }
    const bulk = [...seen.keys()].filter((k) => k.startsWith("session:bulk"));
    assert.equal(bulk.length, 1500);
    assert.ok([...seen.values()].every((v) => v === 1), "без повторов");
    // Ничего нового — пустой ответ, курсор на месте.
    const again = await staff({ tenantId: "t1", kind: "pii_sync", since });
    assert.equal(again.json.contacts.length + again.json.staff.length + again.json.guests.length, 0);
    assert.deepEqual(again.json.cursor, since);
    // Правка — приходит при следующей синхронизации.
    await staff({ tenantId: "t1", kind: "pii_put", k: "staff", id: "e2", fields: { name: "Борис Н." } });
    const delta = await staff({ tenantId: "t1", kind: "pii_sync", since });
    assert.deepEqual(delta.json.staff.map((x) => x.name), ["Борис Н."]);
  });

  test("стирание: значения пустые, строка приходит в синхронизации", async () => {
    const before = (await staff({ tenantId: "t1", kind: "pii_sync", since: {} })).json;
    let since = before.cursor;
    while ((await staff({ tenantId: "t1", kind: "pii_sync", since })).json.more) {
      since = (await staff({ tenantId: "t1", kind: "pii_sync", since })).json.cursor;
    }
    const tail = await staff({ tenantId: "t1", kind: "pii_sync", since });
    since = tail.json.cursor;
    assert.equal((await staff({ tenantId: "t1", kind: "pii_erase", k: "delivery", id: "s-kassa" })).status, 200);
    const r = await staff({ tenantId: "t1", kind: "pii_sync", since });
    const row = r.json.contacts.find((c) => c.id === "s-kassa");
    assert.deepEqual([row.name, row.address, row.extra], ["", "", {}]);
  });

  test("сеть: профиль гостя общий на все точки, персонал другой точки его видит", async () => {
    const g = as("g7");
    assert.equal((await g({ tenantId: "t2", kind: "pii_put", k: "guest", id: "g7", fields: { name: "Мария", phone: "79005554433" } })).status, 200);
    // Сотрудник точки t2 ищет по телефону и по имени.
    const s2 = as("staff2");
    let r = await s2({ tenantId: "t2", kind: "pii_search", q: "554433" });
    assert.deepEqual(r.json.guests.map((x) => x.id), ["g7"]);
    r = await s2({ tenantId: "t2", kind: "pii_search", q: "мари" });
    assert.deepEqual(r.json.guests.map((x) => x.id), ["g7"]);
    // Поиск не выходит за сеть.
    r = await staff({ tenantId: "t1", kind: "pii_search", q: "Мария" });
    assert.equal(r.json.guests.length, 0);
    // Спецсимволы в поиске — как текст.
    r = await s2({ tenantId: "t2", kind: "pii_search", q: "%%" });
    assert.equal(r.json.guests.length, 0);
  });

  test("чей номер: персоналу uid, гостю — только занят ли другим", async () => {
    const s2 = as("staff2");
    assert.equal((await s2({ tenantId: "t2", kind: "pii_phone", phone: "8 900 555-44-33" })).json.uid, "g7");
    // Сотрудник точки t2 — не персонал соседней точки t3 той же сети.
    assert.equal((await s2({ tenantId: "t3", kind: "pii_phone", phone: "79005554433" })).json.taken, true);
    assert.deepEqual((await as("g7")({ tenantId: "t2", kind: "pii_phone", phone: "79005554433" })).json, { taken: false, mine: true });
    assert.deepEqual((await as("g8")({ tenantId: "t2", kind: "pii_phone", phone: "79005554433" })).json, { taken: true, mine: false });
    assert.equal((await staff({ tenantId: "t1", kind: "pii_phone", phone: "12" })).status, 400);
  });

  test("ограничения: лишние поля, плохие id, слишком много записей", async () => {
    assert.equal((await staff({ tenantId: "t1", kind: "pii_put", k: "reservation", id: "r9", fields: { extra: { comment: "x" } } })).status, 400);
    assert.equal((await staff({ tenantId: "t1", kind: "pii_put", k: "staff", id: "../x", fields: { name: "x" } })).status, 400);
    assert.equal((await staff({ tenantId: "t1", kind: "pii_put", k: "evil", id: "x", fields: {} })).status, 400);
    const refs = Array.from({ length: 41 }, (_, i) => ({ k: "guest", id: `x${i}` }));
    assert.equal((await guest({ tenantId: "t1", kind: "pii_lookup", refs })).status, 400);
    assert.equal((await staff({ tenantId: "t1", kind: "pii_lookup", refs })).status, 200);
  });

  for (const [name, fn] of tests) {
    try {
      await fn();
      n++;
    } catch (e) {
      console.error("FAIL", name, e);
      process.exitCode = 1;
    }
  }
  await pool.end();
  psql("postgres", ["-c", `DROP DATABASE ${DB}`]);
  console.log(`vault: ${n} из ${tests.length} проверок`);
})().catch((e) => {
  console.error(e);
  try { psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DB}`]); } catch (_) {}
  process.exit(1);
});
