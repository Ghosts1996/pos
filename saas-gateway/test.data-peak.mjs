// Сервер данных в час пик: 20 000 закрытых чеков в истории, 10 касс по 5
// подписок, поток изменений. Изменение чека не должно пересчитывать
// подписки, которых оно не касается.
// Запуск: node --experimental-eventsource test.data-peak.mjs

import assert from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { startHarness } = require("./test-data-harness.js");

if (typeof EventSource === "undefined") { console.error("нужен node --experimental-eventsource"); process.exit(1); }
const { server, store, port } = await startHarness(0);
const base = `http://127.0.0.1:${port}`;
const post = async (route, body) => {
  const r = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test:ownerA" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${route}: ${j.error}`);
  return j;
};
const col = "tenants/tenantA/sessions";
const batch = [];
for (let i = 0; i < 20000; i++) batch.push(store.doc(`${col}/c${i}`).set({ status: "closed", tableId: `t${i % 30}`, total: i }));
for (let i = 0; i < 40; i++) batch.push(store.doc(`${col}/a${i}`).set({ status: "active", tableId: `t${i % 30}`, total: 0 }));
await Promise.all(batch);

let events = 0;
const streams = [];
// Выдача подписки «открытые чеки» первой кассы — как её собирает касса из событий.
const view = new Map();
let viewOrder = [];
for (let k = 0; k < 10; k++) {
  const { sid } = await post("/db/session", {});
  const es = new EventSource(`${base}/db/listen?sid=${sid}`);
  es.onmessage = (ev) => {
    events++;
    if (k !== 0) return;
    const j = JSON.parse(ev.data);
    if (j.sub !== "1") return;
    if (j.initial) view.clear();
    for (const d of j.docs || []) view.set(d.path, d.data);
    for (const p of j.removes || []) view.delete(p);
    if (j.order) viewOrder = j.order;
  };
  await new Promise((r) => { es.onopen = r; });
  streams.push(es);
  await post("/db/listen", { sid, add: [
    { id: "1", query: { col, where: [["status", "==", "active"]] } },
    { id: "2", query: { col, where: [["tableId", "==", `t${k}`], ["status", "==", "active"]] } },
    { id: "3", query: { col, where: [["status", "==", "active"], ["tableId", "==", "t29"]] } },
    { id: "4", query: { col: "tenants/tenantA/tables" } },
    { id: "5", query: { col, where: [["tableId", "==", `t${k + 10}`], ["status", "==", "active"]] } },
  ] });
}
await new Promise((r) => setTimeout(r, 300));
const before = events;
const t0 = performance.now();
for (let i = 0; i < 100; i++) {
  await post("/db/commit", { writes: [{ op: "set", path: `${col}/a${i % 40}`, data: { status: "active", tableId: `t${(i % 40) % 30}`, total: i }, merge: true }] });
}
await new Promise((r) => setTimeout(r, 200));
const ms = performance.now() - t0;
console.log(`100 изменений при 20 040 чеках и 50 подписках: ${Math.round(ms)} мс, событий ${events - before}`);
assert.ok(events - before >= 100, "кассы получили изменения");
// Порог с запасом для медленных машин CI.
assert.ok(ms < 3000, `слишком медленно: ${Math.round(ms)} мс`);
// Закрыли чек — уходит из выдачи; открыли новый — приходит.
await post("/db/commit", { writes: [{ op: "set", path: `${col}/a1`, data: { status: "closed" }, merge: true }] });
await post("/db/commit", { writes: [{ op: "set", path: `${col}/new1`, data: { status: "active", tableId: "t5", total: 1 } }] });
await new Promise((r) => setTimeout(r, 200));
const fresh = (await post("/db/query", { query: { col, where: [["status", "==", "active"]] } })).docs;
assert.deepStrictEqual([...view.keys()].sort(), fresh.map((d) => d.path).sort(), "выдача из событий = свежий запрос");
assert.deepStrictEqual(viewOrder.filter((p) => view.has(p)).length, fresh.length, "порядок без лишних");
for (const d of fresh) assert.deepStrictEqual(view.get(d.path), d.data, `данные ${d.path}`);
// Связь моргнула: пачка прошла, ответ потерялся, касса шлёт её ещё раз —
// второй раз она не применяется (бонусы и остатки не удваиваются).
const inc = { op: "update", path: `${col}/a2`, data: { total: { __op: "increment", value: 5 } }, exists: true };
const t1 = (await post("/db/query", { query: { col, where: [["status", "==", "active"]] } })).docs.find((d) => d.path.endsWith("/a2")).data.total;
const r1 = await post("/db/commit", { key: "kassa-batch-0001", writes: [inc] });
const r2 = await post("/db/commit", { key: "kassa-batch-0001", writes: [inc] });
assert.deepStrictEqual(r2.results, r1.results, "повтор — прежний ответ");
await post("/db/commit", { key: "kassa-batch-0002", writes: [inc] });
const t2 = (await post("/db/query", { query: { col, where: [["status", "==", "active"]] } })).docs.find((d) => d.path.endsWith("/a2")).data.total;
assert.strictEqual(t2, t1 + 10, "две разные пачки — два раза, повтор — ни разу");
for (const es of streams) es.close();
server.close();
console.log("data-peak: 7 проверок");
process.exit(0);
