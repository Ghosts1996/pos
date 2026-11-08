"use strict";
// Открытый API заведения (open-api.js): ключи владельца, отказ чужим и без
// ключа, защита от подбора, ответы без персональных данных, периоды по поясу
// заведения, постраничная выдача без потерь и повторов.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { createLocalDb } = require("./local-db");
const { compile } = require("./rules-engine");
const api = require("./open-api");
const { HttpError } = require("./test-helpers");

const { Timestamp } = admin.firestore;
let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const TID = "t1";
const OWNER = "owner1";

function harness() {
  const store = createLocalDb({ admin });
  let clock = Date.UTC(2026, 10, 8, 12);
  const audit = [];
  const members = { [`${TID}_${OWNER}`]: "owner", [`${TID}_mgr`]: "manager", [`t2_other`]: "owner" };
  const deps = {
    db: () => store, admin,
    verifyAuth: async (req) => { if (!req.uid) throw new HttpError(401, "нет входа"); return { uid: req.uid }; },
    parseJsonBody: async (req) => req.body || {},
    sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
    HttpError,
    requireTenantRole: async (tid, uid, roles) => {
      if (!roles.includes(members[`${tid}_${uid}`])) throw new HttpError(403, "Недостаточно прав в этом заведении");
    },
    writeAuditLog: async (e) => { audit.push(e); },
    clientIp: (req) => req.ip || "1.1.1.1",
    now: () => clock,
  };
  const mod = api.createOpenApi(deps);
  const call = async (fn, req) => {
    const res = {};
    try { await fn(req, res); } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      res.code = e.status; res.body = { error: e.message };
    }
    return res;
  };
  const keys = (uid, body) => call(mod.handleKeys, { uid, body: { tenantId: TID, ...body } });
  const get = (url, key, extra = {}) => {
    const headers = key ? { authorization: `Bearer ${key}` } : {};
    return call((rq, rs) => mod.handleApi(rq, rs, url.split("?")[0]), { method: "GET", url, headers, ...extra });
  };
  return { store, mod, keys, get, audit, tick: (ms) => { clock += ms; }, now: () => clock };
}

async function seed(store, { tz = "Europe/Moscow" } = {}) {
  await store.doc(`tenants/${TID}`).set({ name: "Тест кафе", slug: "testkafe", status: "active" });
  await store.doc(`tenants/${TID}/settings/general`).set({ timezone: tz });
  await store.doc(`tenants/${TID}/meta/venueProfile`).set({ venueType: "cafe" });
  await store.doc(`tenants/${TID}/menuCategories/c2`).set({ name: "Напитки", order: 2, kind: "bar" });
  await store.doc(`tenants/${TID}/menuCategories/c1`).set({ name: "Кухня", order: 1, kind: "kitchen" });
  await store.doc(`tenants/${TID}/menuItems/m1`).set({ name: "Суп", price: 350, categoryId: "c1", available: true, weight: 300, weightUnit: "gram" });
  await store.doc(`tenants/${TID}/menuItems/m2`).set({ name: "Лимонад", price: 250, categoryId: "c2", available: false });
  await store.doc(`tenants/${TID}/inventoryItems/i1`).set({ name: "Картофель", unit: "kilogram", quantity: 12.345, minQuantity: 2, costPrice: 40, category: "Овощи" });
  // Данные другого заведения — по ключу t1 их быть не должно.
  await store.doc("tenants/t2").set({ name: "Чужое", status: "active" });
  await store.doc("tenants/t2/menuItems/x").set({ name: "Чужое блюдо", price: 1 });
}

const sessionDoc = (closedAtMs, extra = {}) => ({
  tableName: "Стол 3", employeeId: "e1", employeeName: "Иван Петров", guests: 2,
  customerPhone: "+79001234567", customerName: "Пётр", deliveryAddress: "ул. Ленина, 1", guestContact: "+79001234567",
  clientUid: "guest-uid", status: "closed", startTime: Timestamp.fromMillis(closedAtMs - 3600e3),
  closedAt: Timestamp.fromMillis(closedAtMs),
  orderItems: [{ menuItemId: "m1", name: "Суп", price: 350, qty: 2, note: "без лука, для Маши", by: "e1" }],
  paymentCash: 500, paymentCard: 0, paymentTerminal: 200, paymentComp: 0, discountPercent: 0,
  tipsCash: 50, tipsCard: 0, closedWithoutPayment: false, fiscalReceiptPrinted: true, refunded: false, refundedAt: null,
  ...extra,
});

// ------------------------------------------------------------------ ключи

test("ключ: формат, разбор, хеш; случайные символы без перекоса алфавита", async () => {
  const k = `zp_${api.randomToken(12)}_${api.randomToken(32)}`;
  const p = api.parseKey(k);
  assert.ok(p && p.id.length === 12 && p.secret.length === 32);
  assert.strictEqual(api.parseKey("zp_short_x"), null);
  assert.strictEqual(api.parseKey(""), null);
  assert.strictEqual(api.hashSecret("a").length, 64);
  assert.notStrictEqual(api.randomToken(32), api.randomToken(32));
  assert.ok(/^[A-Za-z0-9]+$/.test(api.randomToken(200)));
});

test("создать, показать, отозвать ключ может только владелец своего заведения", async () => {
  const h = harness();
  await seed(h.store);
  assert.strictEqual((await h.keys(null, { action: "list" })).code, 401);
  assert.strictEqual((await h.keys("mgr", { action: "create", name: "Бухгалтерия" })).code, 403);
  assert.strictEqual((await h.keys("other", { action: "create", name: "x" })).code, 403);
  assert.strictEqual((await h.keys(OWNER, { action: "create", name: "  " })).code, 400);

  const c = await h.keys(OWNER, { action: "create", name: "Бухгалтерия" });
  assert.strictEqual(c.code, 200, JSON.stringify(c.body));
  assert.ok(/^zp_[A-Za-z0-9]{12}_[A-Za-z0-9]{32}$/.test(c.body.key));

  const l = await h.keys(OWNER, { action: "list" });
  assert.strictEqual(l.body.keys.length, 1);
  const shown = JSON.stringify(l.body);
  assert.ok(!shown.includes(c.body.key.split("_")[2]), "секрет ключа не показывается повторно");
  assert.ok(!/hash/.test(shown), "отпечаток ключа не уходит в кабинет");
  assert.strictEqual(l.body.keys[0].name, "Бухгалтерия");
  // В базе — только отпечаток.
  const id = api.parseKey(c.body.key).id;
  const stored = (await h.store.doc(`apiKeys/${id}`).get()).data();
  assert.strictEqual(stored.hash, api.hashSecret(api.parseKey(c.body.key).secret));
  assert.ok(!JSON.stringify(stored).includes(api.parseKey(c.body.key).secret));
  assert.ok(h.audit.some((a) => a.action === "apiKeyCreated"));

  assert.strictEqual((await h.get("/api/v1/menu", c.body.key)).code, 200);
  // Чужой не отзовёт, владелец — да; отозванный перестаёт работать сразу.
  assert.strictEqual((await h.keys("other", { action: "revoke", keyId: id })).code, 403);
  assert.strictEqual((await h.keys(OWNER, { action: "revoke", keyId: id })).code, 200);
  assert.strictEqual((await h.get("/api/v1/menu", c.body.key)).code, 401);
  assert.strictEqual((await h.keys(OWNER, { action: "list" })).body.keys[0].status, "revoked");
});

test(`активных ключей не больше ${api.MAX_KEYS}; отзыв освобождает место`, async () => {
  const h = harness();
  await seed(h.store);
  const made = [];
  for (let i = 0; i < api.MAX_KEYS; i++) {
    const r = await h.keys(OWNER, { action: "create", name: `k${i}` });
    assert.strictEqual(r.code, 200);
    made.push(api.parseKey(r.body.key).id);
  }
  assert.strictEqual((await h.keys(OWNER, { action: "create", name: "лишний" })).code, 409);
  await h.keys(OWNER, { action: "revoke", keyId: made[0] });
  assert.strictEqual((await h.keys(OWNER, { action: "create", name: "новый" })).code, 200);
});

// ------------------------------------------------------------------ доступ

test("без ключа и с чужим секретом — 401; подбор с одного адреса — 429", async () => {
  const h = harness();
  await seed(h.store);
  const good = (await h.keys(OWNER, { action: "create", name: "k" })).body.key;
  assert.strictEqual((await h.get("/api/v1/menu", null)).code, 401);
  const wrong = good.replace(/_[A-Za-z0-9]{32}$/, `_${"A".repeat(32)}`);
  assert.strictEqual((await h.get("/api/v1/menu", wrong, { ip: "6.6.6.6" })).code, 401);
  let last;
  for (let i = 0; i < 40; i++) last = await h.get("/api/v1/menu", wrong, { ip: "6.6.6.6" });
  assert.strictEqual(last.code, 429);
  // С другого адреса верный ключ работает.
  assert.strictEqual((await h.get("/api/v1/menu", good, { ip: "2.2.2.2" })).code, 200);
  // Через минуту адрес снова может пробовать.
  h.tick(61 * 1000);
  assert.strictEqual((await h.get("/api/v1/menu", good, { ip: "6.6.6.6" })).code, 200);
});

test(`не больше ${api.RATE_PER_MIN} запросов в минуту на ключ; только GET`, async () => {
  const h = harness();
  await seed(h.store);
  const key = (await h.keys(OWNER, { action: "create", name: "k" })).body.key;
  let r;
  for (let i = 0; i < api.RATE_PER_MIN; i++) r = await h.get("/api/v1/stoplist", key);
  assert.strictEqual(r.code, 200);
  assert.strictEqual((await h.get("/api/v1/stoplist", key)).code, 429);
  h.tick(61 * 1000);
  assert.strictEqual((await h.get("/api/v1/stoplist", key)).code, 200);
  const post = await (async () => { const res = {}; try { await h.mod.handleApi({ method: "POST", url: "/api/v1/menu", headers: { authorization: `Bearer ${key}` } }, res, "/api/v1/menu"); } catch (e) { res.code = e.status; } return res; })();
  assert.strictEqual(post.code, 405);
  assert.strictEqual((await h.get("/api/v1/nope", key)).code, 404);
  assert.strictEqual((await h.get("/api/v1/__proto__", key)).code, 404);
});

test("удалённое или приостановленное заведение — 403", async () => {
  const h = harness();
  await seed(h.store);
  const key = (await h.keys(OWNER, { action: "create", name: "k" })).body.key;
  await h.store.doc(`tenants/${TID}`).set({ status: "deleted" }, { merge: true });
  h.tick(61 * 1000); // кеш заведения — минута
  assert.strictEqual((await h.get("/api/v1/menu", key)).code, 403);
});

// ------------------------------------------------------------------ данные

test("профиль, меню, стоп-лист, склад — только своё заведение", async () => {
  const h = harness();
  await seed(h.store);
  const key = (await h.keys(OWNER, { action: "create", name: "k" })).body.key;
  const venue = (await h.get("/api/v1/venue", key)).body.data;
  assert.deepStrictEqual({ id: venue.id, name: venue.name, slug: venue.slug, tz: venue.timezone, type: venue.type },
    { id: TID, name: "Тест кафе", slug: "testkafe", tz: "Europe/Moscow", type: "cafe" });
  const menu = (await h.get("/api/v1/menu", key)).body.data;
  assert.deepStrictEqual(menu.categories.map((c) => c.name), ["Кухня", "Напитки"]);
  assert.deepStrictEqual(menu.items.map((i) => i.name).sort(), ["Лимонад", "Суп"]);
  assert.ok(!JSON.stringify(menu).includes("Чужое"));
  const stop = (await h.get("/api/v1/stoplist", key)).body.data;
  assert.deepStrictEqual(stop, [{ id: "m2", name: "Лимонад" }]);
  const stock = (await h.get("/api/v1/stock", key)).body.data;
  assert.deepStrictEqual(stock[0], { id: "i1", name: "Картофель", category: "Овощи", unit: "kilogram", quantity: 12.35, minQuantity: 2, costPrice: 40, active: true });
});

test("чеки: суммы и оплаты есть, имён, телефонов, адресов и пожеланий гостей нет", async () => {
  const h = harness();
  await seed(h.store);
  const key = (await h.keys(OWNER, { action: "create", name: "k" })).body.key;
  await h.store.doc(`tenants/${TID}/sessions/s1`).set(sessionDoc(Date.UTC(2026, 10, 5, 15)));
  await h.store.doc(`tenants/${TID}/sessions/open`).set({ status: "active", closedAt: null, orderItems: [] });
  const r = await h.get("/api/v1/sales?from=2026-11-05&to=2026-11-05", key);
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.data.length, 1);
  const c = r.body.data[0];
  assert.strictEqual(c.subtotal, 700);
  assert.strictEqual(c.paid, 700);
  assert.deepStrictEqual(c.payments, { cash: 500, card: 0, terminal: 200, aggregator: 0, comp: 0 });
  assert.deepStrictEqual(c.tips, { cash: 50, card: 0 });
  assert.strictEqual(c.table, "Стол 3");
  assert.strictEqual(c.employeeId, "e1");
  assert.strictEqual(c.fiscal, true);
  const text = JSON.stringify(r.body);
  for (const leak of ["Иван", "Петров", "+7900", "Пётр", "Ленина", "Маши", "guest-uid"]) {
    assert.ok(!text.includes(leak), `в ответе не должно быть «${leak}»`);
  }
  assert.strictEqual(r.body.next, null);
});

test("период: дата включительно по поясу заведения (Москва и Владивосток), неверные даты — 400", async () => {
  for (const [tz, offH] of [["Europe/Moscow", 3], ["Asia/Vladivostok", 10]]) {
    const h = harness();
    await seed(h.store, { tz });
    const key = (await h.keys(OWNER, { action: "create", name: "k" })).body.key;
    const local = (d, hh, mm = 0) => Date.UTC(2026, 10, d, hh - offH, mm);
    await h.store.doc(`tenants/${TID}/sessions/before`).set(sessionDoc(local(4, 23, 59)));
    await h.store.doc(`tenants/${TID}/sessions/first`).set(sessionDoc(local(5, 0, 0)));
    await h.store.doc(`tenants/${TID}/sessions/last`).set(sessionDoc(local(6, 23, 59)));
    await h.store.doc(`tenants/${TID}/sessions/after`).set(sessionDoc(local(7, 0, 0)));
    const r = await h.get("/api/v1/sales?from=2026-11-05&to=2026-11-06", key);
    assert.deepStrictEqual(r.body.data.map((c) => c.id), ["first", "last"], tz);
    const iso = await h.get(`/api/v1/sales?from=${encodeURIComponent(`2026-11-05T00:00:00+${String(offH).padStart(2, "0")}:00`)}&to=${encodeURIComponent(`2026-11-07T00:00:00+${String(offH).padStart(2, "0")}:00`)}`, key);
    assert.deepStrictEqual(iso.body.data.map((c) => c.id), ["first", "last"], `${tz} ISO`);
  }
  const h = harness();
  await seed(h.store);
  const key = (await h.keys(OWNER, { action: "create", name: "k" })).body.key;
  for (const q of ["", "?from=вчера", "?from=2026-02-30", "?from=2026-11-07&to=2026-11-01", "?from=2026-01-01&to=2026-03-01", "?from=2026-11-01&cursor=мусор"]) {
    assert.strictEqual((await h.get(`/api/v1/sales${q}`, key)).code, 400, q);
  }
  assert.strictEqual(api.midnightIn("Europe/Moscow", "2026-11-05"), Date.UTC(2026, 10, 4, 21));
});

test("постранично: 1 260 чеков с одинаковым временем у многих — каждый ровно один раз и по порядку", async () => {
  const h = harness();
  await seed(h.store);
  const key = (await h.keys(OWNER, { action: "create", name: "k" })).body.key;
  const base = Date.UTC(2026, 10, 5, 10);
  const ids = [];
  for (let i = 0; i < 1260; i++) {
    // По 3 чека на одну миллисекунду, а 700 чеков — в одну и ту же (граница страницы внутри группы).
    const t = i < 700 ? base : base + 1000 + Math.floor(i / 3);
    const id = `s${String(i).padStart(5, "0")}`;
    ids.push(id);
    await h.store.doc(`tenants/${TID}/sessions/${id}`).set(sessionDoc(t));
  }
  const got = [];
  let cursor = null;
  let pages = 0;
  do {
    const r = await h.get(`/api/v1/sales?from=2026-11-05&to=2026-11-05${cursor ? `&cursor=${cursor}` : ""}`, key);
    assert.strictEqual(r.code, 200, JSON.stringify(r.body).slice(0, 200));
    assert.ok(r.body.data.length <= api.PAGE);
    got.push(...r.body.data.map((c) => c.id));
    cursor = r.body.next;
    pages += 1;
    assert.ok(pages < 10, "страницы не кончаются");
  } while (cursor);
  assert.strictEqual(got.length, ids.length);
  assert.strictEqual(new Set(got).size, ids.length, "без повторов");
  const times = got.map((id) => Number(id.slice(1)) < 700 ? base : base + 1000 + Math.floor(Number(id.slice(1)) / 3));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], "по времени");
});

test("Z-отчёты: цифры смены без имён кассиров", async () => {
  const h = harness();
  await seed(h.store);
  const key = (await h.keys(OWNER, { action: "create", name: "k" })).body.key;
  await h.store.doc(`tenants/${TID}/shifts/z1`).set({
    status: "closed", openedAt: Timestamp.fromMillis(Date.UTC(2026, 10, 5, 6)), closedAt: Timestamp.fromMillis(Date.UTC(2026, 10, 5, 20)),
    openedBy: "Анна Смирнова", closedBy: "Анна Смирнова",
    z: { number: 7, openedBy: "Анна Смирнова", closedBy: "Анна Смирнова", salesCount: 41, salesTotal: 52340.5, refundsTotal: 700, discounts: 1200, salesCash: 10000, salesTerminal: 42340.5, staff: { e1: { checks: 41, total: 52340.5 } } },
  });
  const r = await h.get("/api/v1/shifts?from=2026-11-05&to=2026-11-05", key);
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body.data[0].z, { number: 7, salesCount: 41, salesTotal: 52340.5, salesCash: 10000, salesTerminal: 42340.5, discounts: 1200, refundsTotal: 700 });
  assert.ok(!JSON.stringify(r.body).includes("Анна"));
});

test("правила базы: ключи API не читаются и не пишутся из кассы и кабинета", async () => {
  const rules = compile(fs.readFileSync(path.join(__dirname, "..", "saas", "firestore.rules"), "utf8"));
  const ctx = (uid) => ({ auth: uid ? { uid, token: {} } : null, now: Date.now(), get: () => null, getAfter: () => null, resource: { tenantId: TID, hash: "x" }, request: { resource: { data: { tenantId: TID } } } });
  for (const m of ["get", "list", "create", "update", "delete"]) {
    assert.strictEqual(rules.allowed(m, "apiKeys/abc", ctx(OWNER)), false, m);
    assert.strictEqual(rules.allowed(m, "apiKeys/abc", ctx(null)), false, `${m} без входа`);
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
    } catch (e) {
      failed += 1;
      console.error(`✗ ${name}\n  ${e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n  ") : e}`);
    }
  }
  console.log(`open-api: ${passed} из ${passed + failed} проверок`);
  if (failed) process.exit(1);
})();
