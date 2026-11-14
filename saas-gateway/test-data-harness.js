"use strict";
// Сервер данных для проверки клиента приложения (test/local_db_integration_test.dart):
// те же data-server.js и saas/firestore.rules, хранилище в памяти, вход —
// токен «test:<uid>» вместо Firebase Auth.
//
//   node saas-gateway/test-data-harness.js 8787
//   LOCAL_DB_URL=http://127.0.0.1:8787 flutter test test/local_db_integration_test.dart
//
// POST /__offline {"on": true} — «пропал интернет»: запросы обрываются,
// поток подписок закрывается; {"on": false} — связь вернулась.
// POST /__lock {"owner": "<файл теста>"} — занять стенд (ответ приходит, когда
// стенд свободен; flutter test гоняет файлы параллельно, а «выдёрнутый
// интернет» одного файла ломал бы другой); POST /__unlock — освободить.
// Владелец, не освободивший стенд за 10 минут, теряет его сам.
// POST /__gate {"code": "subscription-blocked"} — сервер отказывает в записи,
// как боевой при неоплате/отключённой кассе (402/403 с этим кодом); {} — снять.

const http = require("http");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const ds = require("./data-server");

function startHarness(port = Number(process.argv[2]) || 8787) {
const store = ds.createDataStore({ admin });
const rulesSource = fs.readFileSync(path.join(__dirname, "..", "saas", "firestore.rules"), "utf8");
const secure = ds.createSecureDb({ store, rulesSource, admin });

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const sendJson = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};
const parseJsonBody = (req) => new Promise((resolve, reject) => {
  let s = "";
  req.on("data", (c) => { s += c; });
  req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new HttpError(400, "bad json")); } });
});
async function verifyAuth(req) {
  const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!t.startsWith("test:")) throw new HttpError(401, "нет токена");
  return { uid: t.slice(5), exp: Math.floor(Date.now() / 1000) + 3600 };
}
const api = ds.createDataApi({ store, secure, verifyAuth, parseJsonBody, sendJson, HttpError });

const seeded = (async () => {
  const seed = {
    "tenants/tenantA": { name: "Lounge A", slug: "lounge-a", status: "active" },
    "tenantMembers/tenantA_ownerA": { tenantId: "tenantA", userId: "ownerA", role: "owner", status: "active" },
    "tenants/tenantA/tables/t1": { name: "Стол 1", x: 0.1, y: 0.2 },
    "tenants/tenantA/tables/t2": { name: "Стол 2", x: 0.3, y: 0.4 },
    "tenants/tenantB/tables/t1": { name: "Чужой стол" },
  };
  for (const [p, d] of Object.entries(seed)) await store.doc(p).set(d);
})();

let offline = false;
let gate = null;
let lock = null; // { owner, at }
const lockWaiters = []; // { owner, res }
const LOCK_STALE_MS = 10 * 60 * 1000;
function grantNext() {
  if (lock && Date.now() - lock.at > LOCK_STALE_MS) lock = null;
  while (!lock && lockWaiters.length) {
    const w = lockWaiters.shift();
    if (w.res.writableEnded || w.res.destroyed) continue;
    lock = { owner: w.owner, at: Date.now() };
    // Новый владелец начинает с чистого стенда: связь есть, запись открыта.
    offline = false; gate = null;
    sendJson(w.res, 200, { lock: w.owner });
  }
}
setInterval(grantNext, 5000).unref();
// Сколько следующих /db/commit применить, но ответ «потерять» (обрыв связи
// после записи) — касса повторит пачку, сервер не должен применить её дважды.
let dropReplies = 0;
const sockets = new Set();
const streams = new Set();
const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    if (url === "/__offline") {
      offline = (await parseJsonBody(req)).on === true;
      if (offline) { for (const s of streams) s.destroy(); streams.clear(); }
      return sendJson(res, 200, { offline });
    }
    if (url === "/__lock") {
      const owner = String((await parseJsonBody(req)).owner || "");
      if (lock && lock.owner === owner) { lock.at = Date.now(); return sendJson(res, 200, { lock: owner }); }
      lockWaiters.push({ owner, res });
      return grantNext();
    }
    if (url === "/__unlock") {
      const owner = String((await parseJsonBody(req)).owner || "");
      if (lock && lock.owner === owner) { lock = null; offline = false; gate = null; }
      sendJson(res, 200, { ok: true });
      return grantNext();
    }
    if (url === "/__gate") {
      const code = (await parseJsonBody(req)).code;
      gate = typeof code === "string" && code ? code : null;
      return sendJson(res, 200, { gate });
    }
    if (url === "/__dropReply") {
      dropReplies = Number((await parseJsonBody(req)).count) || 0;
      return sendJson(res, 200, { dropReplies });
    }
    if (offline) return req.socket.destroy();
    if (url === "/db/commit" && gate) return sendJson(res, gate === "device-disabled" ? 403 : 402, { error: "запись закрыта (стенд)", code: gate });
    if (url === "/db/commit" && dropReplies > 0) {
      dropReplies--;
      const lost = { writeHead() {}, end() { req.socket.destroy(); } };
      return await api.routes[url](req, lost);
    }
    if (req.method === "GET" && url === "/db/status") return sendJson(res, 200, { backend: "local" });
    if (req.method === "GET" && url === "/db/listen") { streams.add(req.socket); return api.handleListen(req, res); }
    const h = api.routes[url];
    if (req.method === "POST" && h) return await h(req, res);
    sendJson(res, 404, { error: "нет такого адреса" });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message, code: e.status === 401 ? "unauthenticated" : "internal" });
  }
}).on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); })
  ;
return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, store, port: server.address().port })));
}

module.exports = { startHarness };
if (require.main === module) startHarness().then(({ port }) => console.log(`data harness on ${port}`));
