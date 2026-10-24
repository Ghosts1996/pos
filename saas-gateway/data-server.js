"use strict";

/**
 * Собственный сервер данных ZalPOS вместо Cloud Firestore: те же документы и
 * коллекции, те же правила доступа (saas/firestore.rules через
 * rules-engine.js), мгновенная синхронизация между устройствами. Лимитов
 * Firebase больше нет — данные на сервере в РФ.
 *
 * - Хранилище: local-db.js в памяти + SQLite (node:sqlite) на диске —
 *   каждый изменённый документ отдельной строкой, запись пачками через 50 мс,
 *   журнал WAL. Перезапуск сервиса — данные на месте.
 * - Безопасный слой (createSecureDb): каждое чтение, запрос и запись
 *   проверяются правилами от имени пользователя (токен Firebase Auth).
 *   Пачка записей атомарна: либо все разрешены и применены, либо ни одна.
 *   Транзакции — оптимистичные: клиент присылает версии прочитанных
 *   документов, сервер отклоняет запись, если они изменились (клиент
 *   повторяет, как Firestore).
 * - HTTP API (handle): /db/session, /db/get, /db/query, /db/commit,
 *   /db/listen (SSE — поток изменений по подпискам). SSE идёт через тот же
 *   nginx без настройки: заголовок X-Accel-Buffering: no отключает
 *   буферизацию, раз в 20 с — пустое сообщение, чтобы прокси не рвал поток.
 *
 * Формат значений по сети: метка времени — { __ts: мс }; служебные
 * значения записи — { __op: "serverTimestamp" | "increment" | "arrayUnion" |
 * "arrayRemove" | "delete", value }.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createLocalDb } = require("./local-db");
const { compile } = require("./rules-engine");

// ------------------------------------------------------------ SQLite

function createSqlitePersist(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // node:sqlite — встроен в Node 22; предупреждение «experimental» не мешает.
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
  db.exec("CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, data TEXT NOT NULL, ver INTEGER NOT NULL)");
  try { fs.chmodSync(file, 0o600); } catch (_) { /* права — как получится */ }
  const upsert = db.prepare("INSERT INTO docs (path, data, ver) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data, ver = excluded.ver");
  const del = db.prepare("DELETE FROM docs WHERE path = ?");
  return {
    load() {
      return db.prepare("SELECT path, data, ver FROM docs").all().map((r) => [r.path, r.data, r.ver]);
    },
    save(changes) {
      db.exec("BEGIN");
      try {
        for (const c of changes) {
          if (c.json === null) del.run(c.path);
          else upsert.run(c.path, c.json, c.ver);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    /** Копия базы (для резервных копий) — согласованная, через VACUUM INTO. */
    backupTo(target) {
      db.exec(`VACUUM INTO '${String(target).replace(/'/g, "''")}'`);
    },
    close() { db.close(); },
  };
}

function createDataStore({ admin, file = null, now }) {
  const persist = file ? createSqlitePersist(file) : null;
  const store = createLocalDb({ admin, persist, now, flushMs: 50 });
  store.backupTo = persist ? (t) => { store.flushSync(); persist.backupTo(t); } : null;
  store.close = () => { store.flushSync(); if (persist) persist.close(); };
  return store;
}

// ------------------------------------------------------------ значения по сети

/** Значение из сети → значение хранилища (метки времени, служебные). */
function fromWire(v, admin) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => fromWire(x, admin));
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === "__ts" && typeof v.__ts === "number") return admin.firestore.Timestamp.fromMillis(v.__ts);
  if (typeof v.__op === "string") {
    switch (v.__op) {
      case "serverTimestamp": return { __serverTs: true };
      case "increment": return { __inc: Number(v.value) || 0 };
      case "arrayUnion": return { __union: (v.value || []).map((x) => fromWire(x, admin)) };
      case "arrayRemove": return { __remove: (v.value || []).map((x) => fromWire(x, admin)) };
      case "delete": return { __del: true };
      default: throw new DataError("invalid-argument", `Неизвестная операция ${v.__op}`, 400);
    }
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "__proto__") throw new DataError("invalid-argument", "Недопустимое имя поля", 400);
    out[k] = fromWire(x, admin);
  }
  return out;
}

/** Значение хранилища → сеть. */
function toWire(v) {
  if (v === null || v === undefined || typeof v !== "object") return v;
  if (typeof v.toMillis === "function") return { __ts: v.toMillis() };
  if (v instanceof Date) return { __ts: v.getTime() };
  if (Array.isArray(v)) return v.map(toWire);
  const out = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined && typeof x !== "function") out[k] = toWire(x);
  return out;
}

const PATH_RE = /^[^/]+(\/[^/]+)*$/;
// Как в Firestore: без «.», «..» и служебных __имён__.
const BAD_SEGMENT = /(^|\/)(\.|\.\.|__.*__)(\/|$)/;
const okPath = (p) => typeof p === "string" && p.length <= 1500 && PATH_RE.test(p) && !BAD_SEGMENT.test(p);
const isDocPath = (p) => okPath(p) && p.split("/").length % 2 === 0;
const isColPath = (p) => okPath(p) && p.split("/").length % 2 === 1;
const MAX_DOC_BYTES = 1048576; // предел документа Firestore — 1 МиБ
const MAX_SUBS_PER_SESSION = 500;
const MAX_SESSIONS = 20000;

class DataError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const denied = (what) => new DataError("permission-denied", `Нет доступа: ${what}`, 403);

// ------------------------------------------------------------ безопасный слой

function createSecureDb({ store, rulesSource, admin, now = () => Date.now() }) {
  const rules = compile(rulesSource);

  const ctxBase = (auth) => ({
    auth,
    now: now(),
    get: (p) => store.raw(p) ?? null,
  });

  function canRead(auth, method, p, data) {
    return rules.allowed(method, p, { ...ctxBase(auth), resource: data ?? null, request: null, getAfter: (x) => store.raw(x) ?? null });
  }

  /** Документ: { path, exists, data, ver } или ошибка доступа. */
  function get(auth, p) {
    if (!isDocPath(p)) throw new DataError("invalid-argument", "Неверный путь документа", 400);
    const data = store.raw(p);
    if (!canRead(auth, "get", p, data)) throw denied(p);
    return { path: p, exists: data !== undefined, data: data === undefined ? null : toWire(data), ver: store.versionOf(p) };
  }

  /** Описание запроса из сети → описание хранилища. */
  function specFrom(q) {
    if (!q || typeof q !== "object") throw new DataError("invalid-argument", "Нет запроса", 400);
    const group = q.group === true;
    if (group ? !/^[^/]+$/.test(q.col || "") : !isColPath(q.col)) throw new DataError("invalid-argument", "Неверная коллекция", 400);
    const filters = (Array.isArray(q.where) ? q.where : []).slice(0, 30).map(([f, op, v]) => [String(f), String(op), fromWire(v, admin)]);
    const orders = (Array.isArray(q.orderBy) ? q.orderBy : []).slice(0, 10).map(([f, d]) => [String(f), d === "desc" ? "desc" : "asc"]);
    const cur = (c) => (c && Array.isArray(c.values) ? { values: c.values.map((v) => fromWire(v, admin)), inclusive: !!c.inclusive } : undefined);
    const limit = Number.isFinite(Number(q.limit)) && Number(q.limit) > 0 ? Math.min(Number(q.limit), 10000) : undefined;
    return { col: q.col, group, filters, orders, limit, limitToLast: q.limitToLast === true, offset: Number(q.offset) || 0, start: cur(q.start), end: cur(q.end) };
  }

  /** Запрос: документы, каждый — по правилу list (как «правила не фильтр» в Firestore: чужой документ — отказ всему запросу). */
  function queryDocs(auth, spec) {
    const paths = store.runSpec(spec);
    for (const p of paths) if (!canRead(auth, "list", p, store.raw(p))) throw denied(spec.col);
    return paths.map((p) => ({ path: p, exists: true, data: toWire(store.raw(p)), ver: store.versionOf(p) }));
  }

  function query(auth, q) {
    return queryDocs(auth, specFrom(q));
  }

  /**
   * Пачка записей атомарно. writes: [{ op: "set"|"update"|"delete", path,
   * data, merge, exists (предусловие), ver (предусловие транзакции) }];
   * op "check" — только сверка ver прочитанного в транзакции документа.
   */
  function commit(auth, writes) {
    if (!Array.isArray(writes) || !writes.length) throw new DataError("invalid-argument", "Нет записей", 400);
    if (writes.length > 500) throw new DataError("invalid-argument", "Не больше 500 записей за раз", 400);
    const overlay = new Map(); // path → данные после (undefined — удалён)
    const cur = (p) => (overlay.has(p) ? overlay.get(p) : store.raw(p));
    const plan = [];
    const t = now();
    for (const w of writes) {
      const p = w && w.path;
      if (!isDocPath(p)) throw new DataError("invalid-argument", "Неверный путь документа", 400);
      const before = cur(p);
      if (w.ver !== undefined && w.ver !== null && store.versionOf(p) !== Number(w.ver) && !(Number(w.ver) === 0 && store.raw(p) === undefined)) {
        throw new DataError("aborted", "Данные изменились на другом устройстве — повторите", 409);
      }
      // Транзакция: прочитанный, но не изменённый документ — только сверка версии.
      if (w.op === "check") continue;
      if (w.exists === true && before === undefined) throw new DataError("not-found", `Нет документа ${p}`, 404);
      if (w.exists === false && before !== undefined) throw new DataError("already-exists", `Документ уже есть: ${p}`, 409);
      let after;
      let method;
      if (w.op === "delete") {
        after = undefined;
        method = "delete";
      } else if (w.op === "set" || w.op === "update") {
        if (!w.data || typeof w.data !== "object" || Array.isArray(w.data)) throw new DataError("invalid-argument", "Данные документа — объект", 400);
        if (JSON.stringify(w.data).length > MAX_DOC_BYTES) throw new DataError("invalid-argument", "Документ больше 1 МБ", 400);
        if (w.op === "update" && Object.keys(w.data).some((k) => k.split(".").includes("__proto__"))) {
          throw new DataError("invalid-argument", "Недопустимое имя поля", 400);
        }
        const data = fromWire(w.data, admin);
        if (w.op === "update" && before === undefined) {
          // Как Firestore: сначала правила (не выдаём, есть ли документ), потом «нет документа».
          after = resolveServerTs(store.computeNext({}, data, { update: true }), t, admin);
          method = "update";
          plan.push({ w, p, before, after, method, data, missing: true });
          overlay.set(p, after);
          continue;
        }
        after = resolveServerTs(store.computeNext(before, data, { merge: w.op === "set" && !!w.merge, update: w.op === "update" }), t, admin);
        method = before === undefined ? "create" : "update";
      } else throw new DataError("invalid-argument", `Неизвестная запись ${w.op}`, 400);
      plan.push({ w, p, before, after, method, data: w.op === "delete" ? null : fromWire(w.data, admin) });
      overlay.set(p, after);
    }
    for (const x of plan) {
      const ok = rules.allowed(x.method, x.p, {
        auth, now: t, resource: x.before ?? null, request: x.after ?? null,
        get: (q) => store.raw(q) ?? null,
        getAfter: (q) => (overlay.has(q) ? overlay.get(q) ?? null : store.raw(q) ?? null),
      });
      if (!ok) throw denied(x.p);
    }
    const missing = plan.find((x) => x.missing);
    if (missing) throw new DataError("not-found", `Нет документа для обновления: ${missing.p}`, 404);
    // Все разрешены — применяем подряд (синхронно: никто не вклинится).
    for (const x of plan) {
      if (x.method === "delete") store.remove(x.p);
      else store.write(x.p, x.data, { merge: x.w.op === "set" && !!x.w.merge, update: x.w.op === "update" });
    }
    return plan.map((x) => ({ path: x.p, ver: store.versionOf(x.p) }));
  }

  return { get, query, queryDocs, specFrom, commit, canRead, rules };
}

/** serverTimestamp в вычисленном «после» — сейчас (для проверки правил). */
function resolveServerTs(v, t, admin) {
  if (v === null || typeof v !== "object") return v;
  if (v.__serverTs === true) return admin.firestore.Timestamp.fromMillis(t);
  if (Array.isArray(v)) return v.map((x) => resolveServerTs(x, t, admin));
  if (typeof v.toMillis === "function") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = resolveServerTs(x, t, admin);
  return out;
}

// ------------------------------------------------------------ HTTP и SSE

function createDataApi({ store, secure, verifyAuth, parseJsonBody, sendJson, HttpError, now = () => Date.now() }) {
  const sessions = new Map(); // sid → { auth, subs: Map(id → sub), res, expiresAt, queue }

  // Без входа (экран входа, витрина) — как в Firestore: request.auth == null.
  async function authOf(req) {
    if (!String(req.headers["authorization"] || "").replace(/^Bearer\s*/i, "").trim()) return null;
    const decoded = await verifyAuth(req);
    return { uid: decoded.uid, token: decoded, expiresAt: (Number(decoded.exp) || 0) * 1000 };
  }

  const uidOf = (a) => (a ? a.uid : "");

  const fail = (res, e) => {
    if (e instanceof DataError) return sendJson(res, e.status, { error: e.message, code: e.code });
    throw e;
  };

  async function handleGet(req, res) {
    const auth = await authOf(req);
    const body = await parseJsonBody(req);
    const paths = Array.isArray(body.paths) ? body.paths.slice(0, 500) : [];
    try {
      sendJson(res, 200, { docs: paths.map((p) => secure.get(auth, p)) });
    } catch (e) { fail(res, e); }
  }

  async function handleQuery(req, res) {
    const auth = await authOf(req);
    const body = await parseJsonBody(req);
    try {
      sendJson(res, 200, { docs: secure.query(auth, body.query) });
    } catch (e) { fail(res, e); }
  }

  async function handleCommit(req, res) {
    const auth = await authOf(req);
    const body = await parseJsonBody(req);
    try {
      sendJson(res, 200, { results: secure.commit(auth, body.writes) });
    } catch (e) { fail(res, e); }
  }

  // ---- подписки: POST /db/session — сессия; GET /db/listen?sid= — поток; POST /db/listen — добавить/убрать.

  async function handleSession(req, res) {
    const auth = await authOf(req);
    const body = await parseJsonBody(req);
    let sid = typeof body.sid === "string" ? body.sid : "";
    let s = sid && sessions.get(sid);
    if (s && uidOf(s.auth) !== uidOf(auth)) s = null;
    if (!s) {
      if (sessions.size >= MAX_SESSIONS) throw new DataError("resource-exhausted", "Сервер перегружен — попробуйте через минуту", 503);
      sid = crypto.randomBytes(18).toString("hex");
      s = { sid, auth, subs: new Map(), res: null, lastSeen: now() };
      sessions.set(sid, s);
    } else s.auth = auth; // свежий токен — продление
    sendJson(res, 200, { sid, expiresAt: auth ? auth.expiresAt : null });
  }

  function send(s, event) {
    if (!s.res) return;
    try {
      s.res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (_) { s.res = null; }
  }

  /** Проверить подписку и отправить изменения с прошлого раза. */
  function pump(s, sub, initial = false) {
    let docsNow;
    try {
      if (s.auth && s.auth.expiresAt && s.auth.expiresAt < now()) throw new DataError("unauthenticated", "Сеанс истёк — обновите вход", 401);
      if (sub.doc) docsNow = [secure.get(s.auth, sub.doc)];
      else docsNow = secure.queryDocs(s.auth, sub.spec);
    } catch (e) {
      if (!(e instanceof DataError)) console.error(`data-server: подписка: ${e && e.stack ? e.stack : e}`);
      send(s, { sub: sub.id, error: e.message || String(e), code: e.code || "internal" });
      s.subs.delete(sub.id);
      return;
    }
    const adds = [];
    const seen = new Map();
    for (const d of docsNow) {
      seen.set(d.path, d.ver);
      if (!d.exists) continue;
      if (sub.seen.get(d.path) !== d.ver) adds.push(d);
    }
    const removes = [...sub.seen.keys()].filter((p) => !seen.has(p) || (sub.doc && !docsNow[0].exists && sub.seen.get(p) !== undefined));
    const order = sub.doc ? null : docsNow.map((d) => d.path);
    const orderChanged = order && order.join("\n") !== (sub.order || []).join("\n");
    const existsNow = sub.doc ? docsNow[0].exists : null;
    sub.seen = new Map([...seen].filter(([p]) => !sub.doc || docsNow[0].exists || p !== sub.doc));
    if (!initial && !adds.length && !removes.length && !orderChanged && existsNow === sub.exists) return;
    sub.order = order;
    sub.exists = existsNow;
    send(s, { sub: sub.id, docs: adds, removes, order: orderChanged || initial ? order : undefined, exists: existsNow, initial: initial || undefined });
  }

  async function handleListenOps(req, res) {
    const auth = await authOf(req);
    const body = await parseJsonBody(req);
    const s = sessions.get(String(body.sid || ""));
    if (!s || uidOf(s.auth) !== uidOf(auth)) return sendJson(res, 404, { error: "Сессия не найдена", code: "not-found" });
    s.auth = auth;
    for (const id of Array.isArray(body.remove) ? body.remove : []) s.subs.delete(String(id));
    const errors = [];
    for (const a of (Array.isArray(body.add) ? body.add : []).slice(0, 200)) {
      try {
        if (s.subs.size >= MAX_SUBS_PER_SESSION && !s.subs.has(String(a.id))) throw new DataError("resource-exhausted", "Слишком много подписок", 429);
        const sub = { id: String(a.id), seen: new Map(), order: null, exists: undefined };
        if (a.doc) {
          if (!isDocPath(a.doc)) throw new DataError("invalid-argument", "Неверный путь документа", 400);
          sub.doc = a.doc;
        } else sub.spec = secure.specFrom(a.query);
        s.subs.set(sub.id, sub);
        pump(s, sub, true);
      } catch (e) {
        if (!(e instanceof DataError)) throw e;
        errors.push({ id: a.id, error: e.message, code: e.code });
      }
    }
    sendJson(res, 200, { ok: true, errors });
  }

  async function handleListen(req, res) {
    const q = new URL(`http://x${req.url}`).searchParams;
    const s = sessions.get(String(q.get("sid") || ""));
    if (!s) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      return res.end(JSON.stringify({ error: "Сессия не найдена", code: "not-found" }));
    }
    if (s.res) { try { s.res.end(); } catch (_) {} }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`: ok\n\n`);
    s.res = res;
    s.lastSeen = now();
    // Переподключение: подписки на месте — отправим всё заново (клиент сверит).
    for (const sub of s.subs.values()) { sub.seen = new Map(); sub.order = null; sub.exists = undefined; pump(s, sub, true); }
    const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch (_) {} }, 20000);
    req.on("close", () => {
      clearInterval(ping);
      if (s.res === res) { s.res = null; s.lastSeen = now(); }
    });
  }

  // Изменения хранилища → затронутые подписки всех сессий.
  store.onChange((paths) => {
    const cols = new Set(paths.map((p) => p.slice(0, p.lastIndexOf("/"))));
    const groups = new Set([...cols].map((c) => c.slice(c.lastIndexOf("/") + 1)));
    const pathSet = new Set(paths);
    for (const s of sessions.values()) {
      if (!s.res) continue;
      for (const sub of [...s.subs.values()]) {
        const hit = sub.doc ? pathSet.has(sub.doc) : sub.spec.group ? groups.has(sub.spec.col) : cols.has(sub.spec.col);
        // Права зависят от других документов (участники, смены) — их правка
        // пересчитывает и подписки, где они могли что-то открыть или закрыть.
        const rulesDoc = paths.some((p) => /^(tenantMembers|chainMembers|superAdmins)\//.test(p));
        if (hit || rulesDoc) pump(s, sub);
      }
    }
  });

  // Брошенные сессии (касса выключена) — через 10 минут без потока.
  const sweep = setInterval(() => {
    for (const [sid, s] of sessions) if (!s.res && now() - s.lastSeen > 10 * 60 * 1000) sessions.delete(sid);
  }, 60 * 1000);
  if (sweep.unref) sweep.unref();

  return {
    routes: {
      "/db/get": handleGet,
      "/db/query": handleQuery,
      "/db/commit": handleCommit,
      "/db/session": handleSession,
      "/db/listen": handleListenOps,
    },
    handleListen,
    sessions,
  };
}

module.exports = { createDataStore, createSqlitePersist, createSecureDb, createDataApi, fromWire, toWire, DataError };
