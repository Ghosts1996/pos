"use strict";

/**
 * Хранилище на диске сервера с тем же интерфейсом, что у Firestore
 * (collection / doc / where / limit / get / set / update / delete /
 * onSnapshot / runTransaction) — в нём бот поддержки держит обращения,
 * переписку, темы, шаблоны и знания. Чтения и записи здесь не тратят
 * суточный лимит Firebase: раньше бот перечитывал шаблоны и знания каждые
 * 10 минут и выбирал на этом большую часть бесплатных 50 тысяч чтений.
 *
 * Данные — в памяти, на диск пишутся одним JSON-файлом (через временный
 * файл и rename, чтобы сбой посреди записи не испортил базу), раз в сутки —
 * копия с датой (хранится KEEP_DAYS дней). Процесс у шлюза один, поэтому
 * блокировок между процессами не нужно.
 *
 * Метки времени — admin.firestore.Timestamp, служебные значения —
 * FieldValue из firebase-admin (serverTimestamp, increment, arrayUnion,
 * arrayRemove, delete) и подделки тестов ({ __inc }, { __union }, { __del }).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEEP_DAYS = 14;

function createLocalDb({ file = null, admin, flushMs = 400, keepDays = KEEP_DAYS, now = () => Date.now() } = {}) {
  const Timestamp = admin.firestore.Timestamp;
  const FieldValue = admin.firestore.FieldValue;
  /** path документа → данные. */
  const docs = new Map();
  /** path коллекции → Set path документов в ней (без вложенных). */
  const byCol = new Map();
  const listeners = new Set();
  let version = 0;
  let dirty = false;
  let flushTimer = null;
  let writing = null;

  // ---------------------------------------------------------- значения

  const isTs = (v) => v instanceof Timestamp;
  const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v) && !isTs(v) && !(v instanceof FieldValue)
    && Object.getPrototypeOf(v) === Object.prototype;

  /** Копия значения: данные в памяти не меняются снаружи. Date → Timestamp, как в Firestore. */
  function clone(v) {
    if (v === undefined) return undefined;
    if (v === null || typeof v !== "object") return v;
    if (isTs(v)) return v;
    if (v instanceof Date) return Timestamp.fromMillis(v.getTime());
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v.toMillis === "function" && !isPlain(v)) return Timestamp.fromMillis(v.toMillis());
    const out = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = clone(x);
    return out;
  }

  function transformOf(v) {
    if (v instanceof FieldValue) {
      switch (v.methodName) {
        case "FieldValue.serverTimestamp": return { kind: "ts" };
        case "FieldValue.increment": return { kind: "inc", n: Number(v.operand) || 0 };
        case "FieldValue.arrayUnion": return { kind: "union", items: v.elements || [] };
        case "FieldValue.arrayRemove": return { kind: "remove", items: v.elements || [] };
        case "FieldValue.delete": return { kind: "del" };
        default: throw new Error(`local-db: ${v.methodName} не поддерживается`);
      }
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (v.__del === true) return { kind: "del" };
      if (v.__inc !== undefined) return { kind: "inc", n: Number(v.__inc) || 0 };
      if (Array.isArray(v.__union)) return { kind: "union", items: v.__union };
      if (Array.isArray(v.__remove)) return { kind: "remove", items: v.__remove };
      if (v.__serverTs === true) return { kind: "ts" };
    }
    return null;
  }

  const same = (a, b) => JSON.stringify(wire(a)) === JSON.stringify(wire(b));

  /** Значение поля после записи [v] поверх [cur]; undefined — удалить поле. */
  function applyValue(cur, v, merge) {
    const tr = transformOf(v);
    if (tr) {
      if (tr.kind === "del") return undefined;
      if (tr.kind === "ts") return Timestamp.fromMillis(now());
      if (tr.kind === "inc") return (typeof cur === "number" ? cur : 0) + tr.n;
      const arr = Array.isArray(cur) ? cur.slice() : [];
      if (tr.kind === "union") {
        for (const x of tr.items) if (!arr.some((y) => same(x, y))) arr.push(clone(x));
        return arr;
      }
      return arr.filter((y) => !tr.items.some((x) => same(x, y)));
    }
    if (merge && isPlain(v) && isPlain(cur)) return mergeInto({ ...cur }, v, true);
    if (isPlain(v)) return mergeInto({}, v, false);
    if (Array.isArray(v)) return v.map((x) => (transformOf(x) ? applyValue(undefined, x, false) : clone(x)));
    return clone(v);
  }

  function mergeInto(target, data, merge) {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const next = applyValue(target[k], v, merge);
      if (next === undefined) delete target[k];
      else target[k] = next;
    }
    return target;
  }

  /** update(): «a.b.c» — вложенное поле. */
  function applyUpdate(target, data) {
    for (const [key, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const parts = key.split(".");
      let o = target;
      for (const p of parts.slice(0, -1)) {
        o[p] = isPlain(o[p]) ? { ...o[p] } : {};
        o = o[p];
      }
      const last = parts[parts.length - 1];
      const next = applyValue(o[last], v, false);
      if (next === undefined) delete o[last];
      else o[last] = next;
    }
    return target;
  }

  function fieldOf(data, field) {
    let v = data;
    for (const p of String(field).split(".")) {
      if (v === null || v === undefined || typeof v !== "object") return undefined;
      v = v[p];
    }
    return v;
  }

  /** Сравнимое значение: метки времени — миллисекунды. */
  const cmpVal = (v) => (isTs(v) ? v.toMillis() : v instanceof Date ? v.getTime() : v && typeof v.toMillis === "function" ? v.toMillis() : v);

  function compare(a, b) {
    const x = cmpVal(a);
    const y = cmpVal(b);
    if (x === y) return 0;
    if (x === undefined || x === null) return -1;
    if (y === undefined || y === null) return 1;
    if (typeof x !== typeof y) return String(typeof x) < String(typeof y) ? -1 : 1;
    return x < y ? -1 : 1;
  }

  const eq = (a, b) => {
    const x = cmpVal(a);
    const y = cmpVal(b);
    return x === y || (x && y && typeof x === "object" && same(x, y));
  };

  function matches(data, [field, op, value]) {
    const v = fieldOf(data, field);
    switch (op) {
      case "==": return v !== undefined && eq(v, value);
      case "!=": return v !== undefined && v !== null && !eq(v, value);
      case "<": return v !== undefined && v !== null && compare(v, value) < 0;
      case "<=": return v !== undefined && v !== null && compare(v, value) <= 0;
      case ">": return v !== undefined && v !== null && compare(v, value) > 0;
      case ">=": return v !== undefined && v !== null && compare(v, value) >= 0;
      case "in": return Array.isArray(value) && value.some((x) => eq(v, x));
      case "not-in": return v !== undefined && Array.isArray(value) && !value.some((x) => eq(v, x));
      case "array-contains": return Array.isArray(v) && v.some((x) => eq(x, value));
      case "array-contains-any": return Array.isArray(v) && Array.isArray(value) && v.some((x) => value.some((y) => eq(x, y)));
      default: throw new Error(`local-db: оператор ${op} не поддерживается`);
    }
  }

  // ---------------------------------------------------------- ссылки и снимки

  const newId = () => crypto.randomBytes(15).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 20).padEnd(20, "x");
  const parentOf = (docPath) => docPath.slice(0, docPath.lastIndexOf("/"));

  function docSnap(docPath) {
    const data = docs.get(docPath);
    return {
      id: docPath.split("/").pop(),
      ref: docRef(docPath),
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : clone(data)),
      get: (field) => (data === undefined ? undefined : clone(fieldOf(data, field))),
    };
  }

  function querySnap(list, changes = null) {
    return {
      docs: list,
      size: list.length,
      empty: list.length === 0,
      forEach: (fn) => list.forEach(fn),
      docChanges: () => changes || list.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })),
    };
  }

  function docRef(docPath) {
    const ref = {
      id: docPath.split("/").pop(),
      path: docPath,
      get parent() { return colRef(parentOf(docPath)); },
      collection: (name) => colRef(`${docPath}/${name}`),
      get: async () => docSnap(docPath),
      set: async (data, opts) => { write(docPath, data, { merge: !!(opts && (opts.merge || opts.mergeFields)) }); },
      update: async (data) => {
        if (!docs.has(docPath)) throw Object.assign(new Error(`NOT_FOUND: ${docPath}`), { code: 5 });
        write(docPath, data, { update: true });
      },
      create: async (data) => {
        if (docs.has(docPath)) throw Object.assign(new Error(`ALREADY_EXISTS: ${docPath}`), { code: 6 });
        write(docPath, data, {});
      },
      delete: async () => { remove(docPath); },
      onSnapshot: (next, onErr) => listen({ doc: docPath }, next, onErr),
      isEqual: (other) => !!other && other.path === docPath,
    };
    return ref;
  }

  function colRef(colPath) {
    const q = query(colPath, [], [], Infinity);
    return Object.assign(q, {
      id: colPath.split("/").pop(),
      path: colPath,
      doc: (id) => docRef(`${colPath}/${id || newId()}`),
      add: async (data) => {
        const r = docRef(`${colPath}/${newId()}`);
        write(r.path, data, {});
        return r;
      },
      listDocuments: async () => [...(byCol.get(colPath) || [])].map(docRef),
    });
  }

  function query(colPath, filters, orders, max) {
    return {
      where: (field, op, value) => query(colPath, [...filters, [field, op, value]], orders, max),
      orderBy: (field, dir = "asc") => query(colPath, filters, [...orders, [field, dir]], max),
      limit: (n) => query(colPath, filters, orders, Number(n)),
      get: async () => querySnap(run(colPath, filters, orders, max).map(docSnap)),
      onSnapshot: (next, onErr) => listen({ col: colPath, filters, orders, max }, next, onErr),
    };
  }

  function run(colPath, filters, orders, max) {
    let list = [...(byCol.get(colPath) || [])].filter((p) => {
      const d = docs.get(p);
      return d !== undefined && filters.every((f) => matches(d, f));
    });
    if (orders.length) {
      list.sort((a, b) => {
        for (const [field, dir] of orders) {
          const c = compare(fieldOf(docs.get(a), field), fieldOf(docs.get(b), field));
          if (c) return dir === "desc" ? -c : c;
        }
        return 0;
      });
    }
    // Без orderBy — в порядке создания: сообщения с одинаковой меткой
    // времени (до миллисекунды) не перемешиваются.
    if (Number.isFinite(max)) list = list.slice(0, Math.max(0, max));
    return list;
  }

  // ---------------------------------------------------------- запись

  const versions = new Map(); // path документа → номер изменения

  function write(docPath, data, { merge = false, update = false }) {
    if (!data || typeof data !== "object") throw new Error("local-db: данные документа — объект");
    const cur = docs.get(docPath);
    const next = update ? applyUpdate(clone(cur) || {}, data) : merge ? mergeInto(clone(cur) || {}, data, true) : mergeInto({}, data, false);
    docs.set(docPath, next);
    const col = parentOf(docPath);
    if (!byCol.has(col)) byCol.set(col, new Set());
    byCol.get(col).add(docPath);
    changed(docPath);
  }

  function remove(docPath) {
    if (!docs.has(docPath)) return;
    docs.delete(docPath);
    const col = byCol.get(parentOf(docPath));
    if (col) col.delete(docPath);
    changed(docPath);
  }

  let notifyQueued = false;
  const touched = new Set();
  function changed(docPath) {
    version++;
    versions.set(docPath, version);
    touched.add(docPath);
    dirty = true;
    scheduleFlush();
    if (!notifyQueued && listeners.size) {
      notifyQueued = true;
      setImmediate(notify);
    }
  }

  // ---------------------------------------------------------- слежение

  function resultOf(l) {
    if (l.doc) return docs.has(l.doc) ? [l.doc] : [];
    return run(l.col, l.filters, l.orders, l.max);
  }

  function emit(l, initial) {
    const ids = resultOf(l);
    const prev = l.seen;
    const seen = new Map(ids.map((p) => [p, versions.get(p) || 0]));
    const changes = [];
    ids.forEach((p, i) => {
      if (!prev.has(p)) changes.push({ type: "added", doc: docSnap(p), oldIndex: -1, newIndex: i });
      else if (prev.get(p) !== seen.get(p)) changes.push({ type: "modified", doc: docSnap(p), oldIndex: i, newIndex: i });
    });
    for (const p of prev.keys()) if (!seen.has(p)) changes.push({ type: "removed", doc: docSnap(p), oldIndex: -1, newIndex: -1 });
    l.seen = seen;
    if (!initial && !changes.length) return;
    try {
      if (l.doc) l.next(docSnap(l.doc));
      else l.next(querySnap(ids.map(docSnap), changes));
    } catch (e) {
      console.error(`local-db: обработчик слежения: ${e && e.stack ? e.stack : e}`);
    }
  }

  function listen(spec, next, onErr) {
    const l = { ...spec, next, onErr, seen: new Map(), live: true };
    listeners.add(l);
    setImmediate(() => { if (l.live) emit(l, true); });
    return () => { l.live = false; listeners.delete(l); };
  }

  function notify() {
    notifyQueued = false;
    const paths = [...touched];
    touched.clear();
    const cols = new Set(paths.map(parentOf));
    for (const l of [...listeners]) {
      if (!l.live) continue;
      if (l.doc ? paths.includes(l.doc) : cols.has(l.col)) emit(l, false);
    }
  }

  // ---------------------------------------------------------- транзакции

  let txChain = Promise.resolve();
  function runTransaction(fn) {
    const job = txChain.then(async () => {
      const writes = [];
      const tx = {
        get: async (refOrQuery) => (refOrQuery && typeof refOrQuery.path === "string" && refOrQuery.collection && !refOrQuery.where
          ? docSnap(refOrQuery.path) : refOrQuery.get()),
        set: (ref, data, opts) => { writes.push(() => write(ref.path, data, { merge: !!(opts && opts.merge) })); return tx; },
        update: (ref, data) => { writes.push(() => write(ref.path, data, { update: true })); return tx; },
        create: (ref, data) => { writes.push(() => write(ref.path, data, {})); return tx; },
        delete: (ref) => { writes.push(() => remove(ref.path)); return tx; },
      };
      const result = await fn(tx);
      for (const w of writes) w();
      return result;
    });
    txChain = job.catch(() => {});
    return job;
  }

  function batch() {
    const writes = [];
    const b = {
      set: (ref, data, opts) => { writes.push(() => write(ref.path, data, { merge: !!(opts && opts.merge) })); return b; },
      update: (ref, data) => { writes.push(() => write(ref.path, data, { update: true })); return b; },
      create: (ref, data) => { writes.push(() => write(ref.path, data, {})); return b; },
      delete: (ref) => { writes.push(() => remove(ref.path)); return b; },
      commit: async () => { for (const w of writes) w(); return []; },
    };
    return b;
  }

  // ---------------------------------------------------------- диск

  /** Значение для JSON: метки времени — { __ts: мс }. */
  function wire(v) {
    if (v === null || typeof v !== "object") return v;
    if (isTs(v)) return { __ts: v.toMillis() };
    if (v instanceof Date) return { __ts: v.getTime() };
    if (Array.isArray(v)) return v.map(wire);
    if (typeof v.toMillis === "function" && !isPlain(v)) return { __ts: v.toMillis() };
    const out = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = wire(x);
    return out;
  }

  function unwire(v) {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(unwire);
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "__ts" && typeof v.__ts === "number") return Timestamp.fromMillis(v.__ts);
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = unwire(x);
    return out;
  }

  function serialize() {
    const out = {};
    for (const [p, d] of docs) out[p] = wire(d);
    return JSON.stringify({ format: 1, savedAt: now(), docs: out });
  }

  function load() {
    if (!file || !fs.existsSync(file)) return false;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [p, d] of Object.entries(raw.docs || {})) {
      docs.set(p, unwire(d));
      const col = parentOf(p);
      if (!byCol.has(col)) byCol.set(col, new Set());
      byCol.get(col).add(p);
    }
    return true;
  }

  function scheduleFlush() {
    if (!file || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch((e) => console.error(`local-db: запись на диск: ${e.message || e}`));
    }, flushMs);
    if (flushTimer.unref) flushTimer.unref();
  }

  function dayCopy() {
    const day = new Date(now()).toISOString().slice(0, 10);
    const dir = path.dirname(file);
    const base = path.basename(file, ".json");
    const copy = path.join(dir, `${base}-${day}.json`);
    if (!fs.existsSync(copy) && fs.existsSync(file)) {
      fs.copyFileSync(file, copy);
      fs.chmodSync(copy, 0o600);
      const old = fs.readdirSync(dir)
        .filter((f) => f.startsWith(`${base}-`) && /^\d{4}-\d{2}-\d{2}\.json$/.test(f.slice(base.length + 1)))
        .sort();
      for (const f of old.slice(0, Math.max(0, old.length - keepDays))) fs.unlinkSync(path.join(dir, f));
    }
  }

  /** Записать на диск сейчас (асинхронно; вызовы во время записи склеиваются). */
  async function flush() {
    if (!file) return;
    if (writing) {
      await writing;
      if (!dirty) return;
    }
    if (!dirty) return;
    dirty = false;
    const body = serialize();
    writing = (async () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      dayCopy();
      const tmp = `${file}.tmp`;
      await fs.promises.writeFile(tmp, body, { mode: 0o600 });
      await fs.promises.rename(tmp, file);
    })();
    try {
      await writing;
    } catch (e) {
      dirty = true;
      throw e;
    } finally {
      writing = null;
    }
  }

  /** При остановке сервиса — синхронно, чтобы последние записи не потерялись. */
  function flushSync() {
    if (!file || !dirty) return;
    dirty = false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, serialize(), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const loaded = load();

  /** Для тестов: документы как Map путь → данные (как у подделки базы). */
  const storeView = {
    get: (p) => docs.get(p),
    has: (p) => docs.has(p),
    set: (p, d) => {
      docs.set(p, clone(d));
      const col = parentOf(p);
      if (!byCol.has(col)) byCol.set(col, new Set());
      byCol.get(col).add(p);
      changed(p);
      return storeView;
    },
    delete: (p) => { const had = docs.has(p); remove(p); return had; },
    keys: () => docs.keys(),
    values: () => docs.values(),
    entries: () => docs.entries(),
    [Symbol.iterator]: () => docs.entries(),
    get size() { return docs.size; },
  };

  return {
    collection: (name) => colRef(name),
    doc: (p) => docRef(p),
    runTransaction,
    batch,
    flush,
    flushSync,
    loaded,
    store: storeView,
    /** Сколько документов — для статуса и проверок. */
    count: () => docs.size,
    /** Значения в JSON для ответов кабинету: метки времени — { __ts }. */
    wire,
  };
}

module.exports = { createLocalDb };
