"use strict";
// Подмена «firebase/firestore» и «@firebase/rules-unit-testing» для тестов
// правил: те же вызовы (setDoc, getDoc, query…) идут в собственный сервер
// данных (data-server.js) — права проверяет rules-engine.js по тому же
// saas/firestore.rules. Так saas/test/firestore.rules.test.js проверяет
// наш сервер без эмулятора Firebase.

const admin = require("firebase-admin");
const { createLocalDb } = require("./local-db");
const { createSecureDb, toWire, DataError } = require("./data-server");

let rulesSource = "";
let store = null;
let secure = null;
const reset = () => {
  store = createLocalDb({ admin });
  secure = createSecureDb({ store, rulesSource, admin });
};

class Timestamp {
  constructor(seconds, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  static now() { return Timestamp.fromMillis(Date.now()); }
  static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); }
  static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
}

const toNet = (v) => {
  if (v === null || v === undefined || typeof v !== "object") return v;
  if (v.__op) return v.__op === "arrayUnion" || v.__op === "arrayRemove" ? { __op: v.__op, value: v.value.map(toNet) } : v;
  if (typeof v.toMillis === "function") return { __ts: v.toMillis() };
  if (v instanceof Date) return { __ts: v.getTime() };
  if (Array.isArray(v)) return v.map(toNet);
  const out = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toNet(x);
  return out;
};
const fromNet = (v) => {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(fromNet);
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === "__ts") return Timestamp.fromMillis(v.__ts);
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = fromNet(x);
  return out;
};

const join = (...parts) => parts.filter(Boolean).join("/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
function doc(base, ...segs) {
  const p = base.type === "col" ? join(base.path, ...(segs.length ? segs : [Math.random().toString(36).slice(2, 12)])) : join(base.type === "doc" ? base.path : "", ...segs);
  return { type: "doc", db: base.db || base, path: p, id: p.split("/").pop() };
}
function collection(base, ...segs) {
  return { type: "col", db: base.db || base, path: join(base.type === "doc" ? base.path : "", ...segs), constraints: [] };
}
const where = (f, op, v) => ({ kind: "where", v: [f, op, v] });
const orderBy = (f, d = "asc") => ({ kind: "orderBy", v: [f, d] });
const limit = (n) => ({ kind: "limit", v: n });
const query = (col, ...cs) => ({ ...col, constraints: [...(col.constraints || []), ...cs] });

const run = async (db, fn) => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DataError) throw Object.assign(new Error(`${e.code}: ${e.message}`), { code: e.code });
    throw e;
  }
};
const docSnap = (ref, d) => ({ id: ref.id, ref, exists: () => d.exists, data: () => (d.exists ? fromNet(d.data) : undefined), get: (f) => (d.exists ? fromNet(d.data)[f] : undefined) });

async function getDoc(ref) {
  return run(ref.db, () => {
    if (ref.db.admin) { const data = store.raw(ref.path); return docSnap(ref, { exists: data !== undefined, data: toWire(data) }); }
    return docSnap(ref, secure.get(ref.db.auth, ref.path));
  });
}
async function getDocs(q) {
  return run(q.db, () => {
    const net = { col: q.path, where: [], orderBy: [] };
    for (const c of q.constraints || []) {
      if (c.kind === "where") net.where.push([c.v[0], c.v[1], toNet(c.v[2])]);
      if (c.kind === "orderBy") net.orderBy.push(c.v);
      if (c.kind === "limit") net.limit = c.v;
    }
    const list = q.db.admin ? store.runSpec(secure.specFrom(net)).map((p) => ({ path: p, exists: true, data: toWire(store.raw(p)) })) : secure.query(q.db.auth, net);
    const docs = list.map((d) => docSnap({ type: "doc", db: q.db, path: d.path, id: d.path.split("/").pop() }, d));
    return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
  });
}
const commit = (db, writes) => run(db, () => {
  if (db.admin) {
    for (const w of writes) {
      if (w.op === "delete") store.remove(w.path);
      else store.write(w.path, require("./data-server").fromWire(w.data, admin), { merge: !!w.merge, update: w.op === "update" });
    }
    return;
  }
  secure.commit(db.auth, writes);
});
const setDoc = (ref, data, opts) => commit(ref.db, [{ op: "set", path: ref.path, data: toNet(data), merge: !!(opts && opts.merge) }]);
const updateDoc = (ref, data) => commit(ref.db, [{ op: "update", path: ref.path, data: toNet(data) }]);
const deleteDoc = (ref) => commit(ref.db, [{ op: "delete", path: ref.path }]);
async function addDoc(col, data) { const r = doc(col); await setDoc(r, data); return r; }
function writeBatch(db) {
  const ws = [];
  return {
    set(ref, data, opts) { ws.push({ op: "set", path: ref.path, data: toNet(data), merge: !!(opts && opts.merge) }); return this; },
    update(ref, data) { ws.push({ op: "update", path: ref.path, data: toNet(data) }); return this; },
    delete(ref) { ws.push({ op: "delete", path: ref.path }); return this; },
    commit: () => commit(db, ws),
  };
}
const serverTimestamp = () => ({ __op: "serverTimestamp" });
const deleteField = () => ({ __op: "delete" });
const increment = (n) => ({ __op: "increment", value: n });
const arrayUnion = (...v) => ({ __op: "arrayUnion", value: v });
const arrayRemove = (...v) => ({ __op: "arrayRemove", value: v });

const firestore = { doc, collection, query, where, orderBy, limit, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, writeBatch, serverTimestamp, deleteField, increment, arrayUnion, arrayRemove, Timestamp };

const isDenied = (e) => e && (e.code === "permission-denied" || /permission-denied|PERMISSION_DENIED/.test(String(e.message)));
const rulesTesting = {
  async initializeTestEnvironment(cfg) {
    rulesSource = cfg.firestore.rules;
    reset();
    const ctx = (auth, isAdmin = false) => ({
      firestore: () => {
        const db = { auth, admin: isAdmin };
        db.doc = (p) => doc(db, p);
        db.collection = (p) => collection(db, p);
        return db;
      },
    });
    return {
      authenticatedContext: (uid, token = {}) => ctx({ uid, token: { sub: uid, user_id: uid, auth_time: Math.floor(Date.now() / 1000), firebase: { sign_in_provider: "custom" }, ...token } }),
      unauthenticatedContext: () => ctx(null),
      withSecurityRulesDisabled: async (fn) => fn(ctx(null, true)),
      clearFirestore: async () => reset(),
      cleanup: async () => {},
    };
  },
  async assertSucceeds(p) { return p; },
  async assertFails(p) {
    try {
      await p;
    } catch (e) {
      if (isDenied(e)) return e;
      throw new Error(`Ожидался отказ в доступе, а пришла другая ошибка: ${e.message}`);
    }
    throw new Error("Ожидался отказ в доступе, а запрос прошёл");
  },
};

module.exports = { firestore, rulesTesting };
