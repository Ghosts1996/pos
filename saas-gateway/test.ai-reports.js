"use strict";
// ИИ-разборы в фоне (ai-reports.js): задание принимается сразу, сервер
// доводит его до конца и пишет результат; ошибки провайдера — «не удался»;
// прерванные перезапуском — помечаются; права и лимиты.
const assert = require("assert/strict");
const { createAiReports } = require("./ai-reports");

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
let t = 1_000_000;
const docs = new Map(); // path → data
let seq = 0;
function docRef(path) {
  return {
    id: path.split("/").pop(), path,
    async set(d) { docs.set(path, { ...d }); },
    async update(d) { docs.set(path, { ...(docs.get(path) || {}), ...d }); },
    async get() { return { exists: docs.has(path), data: () => docs.get(path) }; },
  };
}
const fakeDb = () => ({
  collection: (a) => ({ doc: (b) => ({ collection: (c) => ({
    doc: (id) => docRef(`${a}/${b}/${c}/${id || `r${++seq}`}`),
    where: (f, op, v) => ({ get: async () => ({ docs: [...docs.entries()]
      .filter(([p, d]) => p.startsWith(`${a}/${b}/${c}/`) && d[f] === v)
      .map(([p]) => ({ id: p.split("/").pop(), ref: docRef(p), data: () => docs.get(p) })) }) }),
  }) }) }),
});
const admin = { firestore: { Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) } } };
let answer = async () => "Итог: всё хорошо";
const roles = { u1: "employee", g1: null };
const rep = createAiReports({
  db: fakeDb, admin, HttpError, now: () => t,
  verifyAuth: async (req) => ({ uid: req.uid }), parseJsonBody: async (req) => req.body,
  sendJson: (res, code, body) => { res.code = code; res.body = body; },
  requireTenantRole: async (tid, uid) => { if (!roles[uid]) throw new HttpError(403, "нет прав"); },
  aiVendor: async (tid) => (tid === "noai" ? null : { id: "v" }),
  aiComplete: (v, o) => answer(o),
});
const flush = () => new Promise((r) => setTimeout(r, 20));
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`✓ ${name}`); };
const body = (extra = {}) => ({ tenantId: "t1", action: "start", kind: "sales", title: "Разбор выручки", period: { from: "2026-11-20", to: "2026-11-27" },
  system: ["Ты аналитик", "ДАННЫЕ: выручка 100"], user: "Разбери", heavy: true, aliases: { "Сотрудник №1": "Анна", "evil": "x" }, ...extra });

(async () => {
  await ok("задание принято сразу, разбор готов без кассы", async () => {
    let seen;
    answer = async (o) => { seen = o; return "Выручка выросла, Сотрудник №1 молодец"; };
    const res = {};
    await rep.handle({ uid: "u1", body: body() }, res);
    assert.equal(res.code, 200);
    const path = `tenants/t1/aiReports/${res.body.id}`;
    assert.equal(docs.get(path).status, "running");
    await flush();
    const d = docs.get(path);
    assert.equal(d.status, "done");
    assert.match(d.text, /Сотрудник №1/);
    assert.deepEqual(d.aliases, { "Сотрудник №1": "Анна" });
    assert.equal(seen.heavy, true);
    assert.match(seen.system, /ДАННЫЕ: выручка 100/);
  });

  await ok("провайдер упал — «не удался» с причиной, не вечная крутилка", async () => {
    answer = async () => { throw new Error("Провайдер ИИ сейчас перегружен (503)"); };
    const res = {};
    await rep.handle({ uid: "u1", body: body() }, res);
    await flush();
    const d = docs.get(`tenants/t1/aiReports/${res.body.id}`);
    assert.equal(d.status, "failed");
    assert.match(d.error, /503/);
  });

  await ok("без ИИ, без прав, без данных, чужой вид — отказ", async () => {
    await assert.rejects(rep.handle({ uid: "u1", body: body({ tenantId: "noai" }) }, {}), (e) => e.status === 412);
    await assert.rejects(rep.handle({ uid: "g1", body: body() }, {}), (e) => e.status === 403);
    await assert.rejects(rep.handle({ uid: "u1", body: body({ user: "" }) }, {}), (e) => e.status === 400);
    await assert.rejects(rep.handle({ uid: "u1", body: body({ kind: "hack" }) }, {}), (e) => e.status === 400);
  });

  await ok("прерванный перезапуском разбор помечается через 15 минут", async () => {
    const born = t;
    docs.set("tenants/t2/aiReports/old", { status: "running", createdAt: { toMillis: () => born } });
    t += 16 * 60 * 1000;
    assert.equal(await rep.sweep(["t2"]), 1);
    assert.equal(docs.get("tenants/t2/aiReports/old").status, "failed");
  });

  await ok("не больше 30 разборов в час на заведение", async () => {
    answer = async () => "ок";
    for (let i = 0; i < 30; i++) await rep.handle({ uid: "u1", body: body({ tenantId: "t3" }) }, {});
    await assert.rejects(rep.handle({ uid: "u1", body: body({ tenantId: "t3" }) }, {}), (e) => e.status === 429);
    await flush();
  });

  console.log(`ai-reports: ${n} из 5 проверок`);
})().catch((e) => { console.error(e); process.exit(1); });
