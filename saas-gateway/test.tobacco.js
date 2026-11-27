"use strict";
// Табак на полках (tobacco.js): ответ ИИ → аккуратный список банок, лимиты
// снимков, общий каталог вкусов и «новинки», права.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { createTobacco, itemsFromAi } = require("./tobacco");

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tobacco-"));
let t = Date.UTC(2026, 10, 25);
let aiAnswer = "";
const roles = { "u-emp": "employee", "u-guest": "guest" };
const tob = createTobacco({
  verifyAuth: async (req) => ({ uid: req.uid }), parseJsonBody: async (req) => req.body, sendJson: (res, code, body) => { res.code = code; res.body = body; },
  HttpError, requireTenantRole: async (tid, uid, allowed) => { if (!allowed.includes(roles[uid])) throw new HttpError(403, "нет прав"); },
  aiVendor: async (tid) => (tid === "noai" ? null : { id: "x" }), aiComplete: async () => aiAnswer,
  extractJson: (s) => JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)), limiter: new Map(), stateDir: dir, now: () => t,
});
const page = { mediaType: "image/jpeg", data: "QUJD" };
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`✓ ${name}`); };

(async () => {
  await ok("ответ ИИ → банки без повторов, мусор отброшен", async () => {
    const items = itemsFromAi({ items: [
      { brand: "Black Burn", name: "Спелая лесная малина", flavors: ["малина"], strength: "medium" },
      { brand: "Black Burn", name: "спелая лесная малина", flavors: ["малина"] },
      { brand: "Musthave", name: "Пинкман", flavors: "клубника, малина, грейпфрут", strength: "крепкий" },
      { brand: "<script>", name: "" },
      null,
    ] });
    assert.equal(items.length, 2);
    assert.deepEqual(items[1].flavors, ["клубника", "малина", "грейпфрут"]);
    assert.equal(items[1].strength, "");
  });

  await ok("распознавание: ключ ИИ, картинка, лимит 60 снимков в час", async () => {
    aiAnswer = '```json {"items":[{"brand":"Deus","name":"Strawberry","flavors":["клубника"]}]} ```';
    const res = {};
    await tob.handle({ uid: "u-emp", body: { tenantId: "t1", action: "scan", page } }, res);
    assert.equal(res.body.items[0].name, "Strawberry");
    await assert.rejects(tob.scan("noai", { page }), (e) => e.status === 412);
    await assert.rejects(tob.scan("t1", { page: { mediaType: "image/gif", data: "QUJD" } }), (e) => e.status === 400);
    for (let i = 0; i < 60; i++) await tob.scan("t2", { page });
    await assert.rejects(tob.scan("t2", { page }), (e) => e.status === 429);
    aiAnswer = '{"items":[]}';
    await assert.rejects(tob.scan("t3", { page }), (e) => e.status === 422);
  });

  await ok("большая полка — заданием: старт сразу, результат потом", async () => {
    let release;
    const slow = new Promise((r) => { release = r; });
    const tob2 = createTobacco({
      verifyAuth: async (req) => ({ uid: req.uid }), parseJsonBody: async (req) => req.body, sendJson: (res, code, body) => { res.code = code; res.body = body; },
      HttpError, requireTenantRole: async () => {}, aiVendor: async () => ({ id: "x" }),
      aiComplete: async () => { await slow; return '{"items":[{"brand":"Blanch","name":"Мангомания","flavors":["манго"]}]}'; },
      extractJson: (s) => JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)), limiter: new Map(), stateDir: dir, now: () => t,
    });
    const res = {};
    await tob2.handle({ uid: "u-emp", body: { tenantId: "t9", action: "scanStart", page } }, res);
    const job = res.body.job;
    assert.match(job, /^[0-9a-f]{24}$/);
    assert.equal(tob2.scanResult("t9", { job }).status, "running");
    assert.throws(() => tob2.scanResult("чужое", { job }), (e) => e.status === 404);
    release();
    await new Promise((r) => setImmediate(r));
    const done = tob2.scanResult("t9", { job });
    assert.equal(done.status, "done");
    assert.equal(done.items[0].name, "Мангомания");
    assert.throws(() => tob2.scanResult("t9", { job }), (e) => e.status === 404); // выдаётся один раз
    // Ошибка ИИ — честный «failed» с текстом, а не «нет связи».
    const r2 = {};
    await tob2.handle({ uid: "u-emp", body: { tenantId: "t9", action: "scanStart", page: { mediaType: "image/gif", data: "QUJD" } } }, r2);
    await new Promise((r) => setImmediate(r));
    const f = tob2.scanResult("t9", { job: r2.body.job });
    assert.equal(f.status, "failed");
    assert.match(f.error, /JPEG/);
  });

  await ok("гость не может распознавать полку", async () => {
    await assert.rejects(tob.handle({ uid: "u-guest", body: { tenantId: "t1", action: "scan", page } }, {}), (e) => e.status === 403);
  });

  await ok("каталог: пополняется, новинки за 60 дней, переживает перезапуск", async () => {
    const r1 = tob.learn([{ brand: "Banger", name: "Нектарин", flavors: ["нектарин"] }, { brand: "Deus", name: "Cola", flavors: ["кола"] }]);
    assert.equal(r1.added, 2);
    t += 70 * 86400000;
    const r2 = tob.learn([{ brand: "Banger", name: "Нектарин" }, { brand: "Dogma", name: "Китайская груша", flavors: ["груша"] }]);
    assert.equal(r2.added, 1);
    const fresh = tob.fresh();
    assert.deepEqual(fresh.fresh.map((f) => f.name), ["Китайская груша"]);
    assert.equal(fresh.total, 3);
    const again = createTobacco({ verifyAuth: null, parseJsonBody: null, sendJson: null, HttpError, requireTenantRole: null, aiVendor: null, aiComplete: null, extractJson: null, limiter: new Map(), stateDir: dir, now: () => t });
    assert.equal(again.fresh().total, 3);
  });

  console.log(`tobacco: ${n} из 5 проверок`);
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
