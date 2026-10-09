"use strict";
// Общие подделки для тестов шлюза: память вместо Firestore и admin.firestore.
const crypto = require("crypto");

// ---------- память вместо Firestore (только то, что нужно guest-pay.js)
function fakeDb() {
  const store = new Map();
  const ref = (path) => ({
    path,
    id: path.split("/").pop(),
    collection: (name) => col(`${path}/${name}`),
    get: async () => snap(path),
    set: async (data, opts) => { store.set(path, opts && opts.merge ? { ...(store.get(path) || {}), ...data } : { ...data }); },
    update: async (data) => { applyUpdate(path, data); },
    delete: async () => { store.delete(path); },
  });
  const snap = (path) => ({ exists: store.has(path), id: path.split("/").pop(), ref: ref(path), data: () => (store.has(path) ? { ...store.get(path) } : undefined) });
  function applyUpdate(path, data) {
    const cur = { ...(store.get(path) || {}) };
    for (const [k, v] of Object.entries(data)) {
      if (v && v.__inc !== undefined) cur[k] = (Number(cur[k]) || 0) + v.__inc;
      else if (v && v.__union) cur[k] = [...new Set([...(cur[k] || []), ...v.__union])];
      else cur[k] = v;
    }
    store.set(path, cur);
  }
  function col(path) {
    const filters = [];
    let max = Infinity;
    const q = {
      doc: (id) => ref(`${path}/${id || crypto.randomBytes(6).toString("hex")}`),
      add: async (data) => { const r = ref(`${path}/${crypto.randomBytes(6).toString("hex")}`); await r.set(data); return r; },
      where: (f, op, v) => { filters.push([f, v]); return q; },
      limit: (n) => { max = n; return q; },
      get: async () => {
        const docs = [...store.keys()]
          .filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/"))
          .map(snap)
          .filter((d) => filters.every(([f, v]) => d.data()[f] === v))
          .slice(0, max);
        return { docs, size: docs.length };
      },
    };
    return q;
  }
  const db = {
    collection: (name) => col(name),
    runTransaction: async (fn) => fn({
      get: async (r) => r.get(),
      set: (r, d, o) => r.set(d, o),
      update: (r, d) => applyUpdate(r.path, d),
    }),
  };
  return { db, store };
}

const admin = {
  firestore: {
    Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms) => ({ toMillis: () => ms }) },
    FieldValue: { increment: (n) => ({ __inc: n }), arrayUnion: (...v) => ({ __union: v }) },
  },
};
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

module.exports = { fakeDb, admin, HttpError };

