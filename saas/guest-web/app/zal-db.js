// Данные кабинета и веб-приложения гостя: Cloud Firestore или собственный
// сервер данных платформы (saas-gateway, /db/*). Где сейчас данные, говорит
// сервер (GET /db/status). Функции — те же, что у firebase/firestore (doc,
// getDoc, onSnapshot, query, where…), поэтому код страниц не меняется: он
// импортирует их отсюда, а не с CDN Firebase.
//
// Файл одинаковый в saas/console/ и saas/guest-web/app/ (тест следит).
//
// Библиотека Firestore загружается, только если данные ещё в Firestore:
// со своим сервером страница не обращается к Google вовсе.

const FIRESTORE_URL = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
let F = null;

/** Метка времени — как у Firestore (seconds, nanoseconds, toDate, toMillis…). */
export class Timestamp {
  constructor(seconds, nanoseconds = 0) {
    this.seconds = Math.floor(seconds);
    this.nanoseconds = Math.floor(nanoseconds);
  }
  static now() { return Timestamp.fromMillis(Date.now()); }
  static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
  static fromMillis(ms) {
    const s = Math.floor(ms / 1000);
    return new Timestamp(s, Math.round((ms - s * 1000) * 1e6));
  }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
  isEqual(o) { return !!o && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; }
  valueOf() { return `${String(this.seconds + 1e12).padStart(13, '0')}.${String(this.nanoseconds).padStart(9, '0')}`; }
  toJSON() { return { seconds: this.seconds, nanoseconds: this.nanoseconds }; }
  toString() { return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`; }
}
/** Метка времени Firestore (из его снимков) или наша. */
const isTs = (v) => v instanceof Timestamp || (!!F && v instanceof F.Timestamp);

const LOCAL = Symbol('zalLocal');
const OP = Symbol('zalOp');

// ------------------------------------------------------------ значения

/** Удалить поле (в обоих хранилищах). */
export function deleteField() {
  return { [OP]: 'delete' };
}

/** Прибавить к числу на сервере (два устройства сразу — оба изменения сложатся). */
export function increment(n) {
  return { [OP]: 'increment', value: Number(n) || 0 };
}

const isOp = (v) => v && typeof v === 'object' && v[OP];

/** Значение страницы → Firestore (наши служебные — в его служебные). */
function toFs(v) {
  if (isOp(v)) return v[OP] === 'increment' ? F.increment(v.value) : F.deleteField();
  if (v instanceof Timestamp) return new F.Timestamp(v.seconds, v.nanoseconds);
  if (Array.isArray(v)) return v.map(toFs);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = toFs(x);
    return out;
  }
  return v;
}

/** Значение страницы → сеть своего сервера. */
function toWire(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== 'object') return v;
  if (isOp(v)) return v[OP] === 'increment' ? { __op: 'increment', value: v.value } : { __op: v[OP] };
  if (isTs(v)) return { __ts: v.toMillis() };
  if (v instanceof Date) return { __ts: v.getTime() };
  if (v instanceof DocRef) return v.path;
  if (Array.isArray(v)) return v.map(toWire);
  const out = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toWire(x);
  return out;
}

/** Сеть → значение страницы (метки времени — Timestamp, как у Firestore). */
function fromWire(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(fromWire);
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === '__ts' && typeof v.__ts === 'number') return Timestamp.fromMillis(v.__ts);
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = fromWire(x);
  return out;
}

const dbError = (code, message) => Object.assign(new Error(message || code), { code, name: 'FirebaseError' });

const lastSeg = (p) => p.slice(p.lastIndexOf('/') + 1);
const parentOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const joinPath = (base, segs) => [base, ...segs.map(String)].filter(Boolean).join('/').split('/').filter(Boolean).join('/');

function autoId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const a = new Uint8Array(20);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => chars[x % chars.length]).join('');
}

// ------------------------------------------------------------ ссылки

class LocalDb {
  constructor(gateway, auth) {
    this[LOCAL] = true;
    this.gateway = gateway.replace(/\/+$/, '');
    this.auth = auth;
    this.type = 'firestore';
    this.subs = new Map();
    this.nextSub = 1;
    this.sid = null;
    this.sidUid = null;
    this.es = null;
    this.retry = 1;
  }

  async headers(force = false) {
    const h = { 'Content-Type': 'application/json' };
    const u = this.auth && this.auth.currentUser;
    if (u) h.Authorization = `Bearer ${await u.getIdToken(force)}`;
    return h;
  }

  async post(route, body) {
    let res;
    try {
      res = await fetch(`${this.gateway}${route}`, { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) });
    } catch (_) {
      throw dbError('unavailable', 'Нет связи с сервером — проверьте интернет');
    }
    let j = {};
    try { j = await res.json(); } catch (_) {}
    if (res.ok) return j;
    const code = res.status === 401 ? 'unauthenticated' : j.code || (res.status === 403 ? 'permission-denied' : res.status >= 500 ? 'unavailable' : 'internal');
    throw dbError(code, j.error || `Сервер ответил ошибкой ${res.status}`);
  }

  // ---- подписки: одна сессия и один поток на страницу

  async openSession() {
    const uid = (this.auth && this.auth.currentUser && this.auth.currentUser.uid) || '';
    const j = await this.post('/db/session', this.sid && this.sidUid === uid ? { sid: this.sid } : {});
    if (j.sid !== this.sid) for (const s of this.subs.values()) s.sent = false;
    this.sid = j.sid;
    this.sidUid = uid;
    clearTimeout(this.refreshTimer);
    if (j.expiresAt) {
      this.refreshTimer = setTimeout(async () => {
        try { await this.headers(true); await this.openSession(); } catch (_) { this.restart(); }
      }, Math.max(60000, j.expiresAt - Date.now() - 4 * 60 * 1000));
    }
  }

  ensureStream() {
    if (this.es || this.connecting || !this.subs.size) return;
    this.connecting = true;
    (async () => {
      try {
        await this.openSession();
        const es = new EventSource(`${this.gateway}/db/listen?sid=${encodeURIComponent(this.sid)}`);
        this.es = es;
        es.onopen = () => {
          this.retry = 1;
          this.sendSubs([...this.subs.values()].filter((s) => !s.sent), []);
        };
        es.onmessage = (ev) => this.onEvent(ev.data);
        es.onerror = () => {
          // Сессия могла истечь (касса спала) — переподключаемся сами, с новой.
          es.close();
          if (this.es === es) this.es = null;
          for (const s of this.subs.values()) s.sent = false;
          this.scheduleReconnect();
        };
      } catch (_) {
        this.scheduleReconnect();
      } finally {
        this.connecting = false;
      }
    })();
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    if (!this.subs.size) return;
    this.reconnectTimer = setTimeout(() => this.ensureStream(), this.retry * 1000);
    this.retry = Math.min(this.retry * 2, 15);
  }

  restart() {
    if (this.es) this.es.close();
    this.es = null;
    for (const s of this.subs.values()) s.sent = false;
    this.ensureStream();
  }

  resumeNow() {
    if (this.es && this.es.readyState !== 2) return;
    this.retry = 1;
    this.restart();
  }

  async sendSubs(add, remove) {
    if (!this.sid || !this.es) return;
    add = add.filter((s) => !s.sent);
    if (!add.length && !remove.length) return;
    for (const s of add) s.sent = true;
    try {
      const j = await this.post('/db/listen', { sid: this.sid, add: add.map((s) => s.wire()), remove });
      for (const e of j.errors || []) {
        const s = this.subs.get(String(e.id));
        if (s) s.fail(dbError(e.code || 'internal', e.error));
      }
    } catch (e) {
      if (e.code === 'not-found') { this.sid = null; this.restart(); return; }
      if (e.code === 'unavailable') { for (const s of add) s.sent = false; return; }
      for (const s of add) s.fail(e);
    }
  }

  onEvent(raw) {
    let j;
    try { j = JSON.parse(raw); } catch (_) { return; }
    const s = this.subs.get(String(j.sub));
    if (!s) return;
    if (j.error) {
      if (j.code === 'unauthenticated') {
        s.sent = false;
        this.headers(true).then(() => this.openSession()).then(() => this.sendSubs([s], [])).catch(() => this.restart());
        return;
      }
      s.fail(dbError(j.code || 'internal', j.error));
      return;
    }
    s.apply(j);
  }

  listen(target, onNext, onError) {
    const s = new Sub(this, String(this.nextSub++), target, onNext, onError);
    this.subs.set(s.id, s);
    if (this.es && this.es.readyState === 1) this.sendSubs([s], []);
    this.ensureStream();
    return () => {
      if (!this.subs.delete(s.id)) return;
      s.closed = true;
      if (s.sent) this.sendSubs([], [s.id]);
    };
  }
}

class DocRef {
  constructor(db, path) {
    this[LOCAL] = true;
    this.db = db;
    this.firestore = db;
    this.path = path;
    this.id = lastSeg(path);
    this.type = 'document';
  }
  get parent() { return new ColRef(this.db, parentOf(this.path)); }
}

class Query {
  constructor(db, spec) {
    this[LOCAL] = true;
    this.db = db;
    this.firestore = db;
    this.spec = spec;
    this.type = 'query';
  }
}

class ColRef extends Query {
  constructor(db, path) {
    super(db, { col: path });
    this.path = path;
    this.id = lastSeg(path);
    this.type = 'collection';
  }
  get parent() { return this.path.includes('/') ? new DocRef(this.db, parentOf(this.path)) : null; }
}

const isLocal = (x) => !!(x && x[LOCAL]);
const dbOf = (x) => (x instanceof LocalDb ? x : x.db);

const BACKEND_KEY = 'zalDbBackend';
const memo = {
  get() { try { return localStorage.getItem(BACKEND_KEY); } catch (_) { return null; } },
  set(v) { try { localStorage.setItem(BACKEND_KEY, v); } catch (_) {} },
};

/** Где данные: спрашиваем сервер (до трёх раз), не ответил — как в прошлый раз. */
export async function dataBackend(gateway) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${gateway.replace(/\/+$/, '')}/db/status`, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const j = await r.json();
        if (j.backend) { memo.set(j.backend); return j; }
      }
    } catch (_) { /* повторим */ }
    await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
  // Данные уже были на своём сервере — к Google не возвращаемся.
  return { backend: memo.get() || 'firestore', offline: true };
}

/** Хранилище страницы: Firestore или свой сервер (по ответу сервера).
 *  app — приложение Firebase или функция, которая его создаёт (только для Firestore). */
export async function openDb(app, { gateway, auth, status }) {
  const backend = (status || (await dataBackend(gateway))).backend;
  if (backend !== 'local') {
    if (!F) F = await import(FIRESTORE_URL);
    return F.getFirestore(typeof app === 'function' ? await app() : app);
  }
  const db = new LocalDb(gateway, auth);
  // Другой вход — новая сессия с его правами.
  if (auth && auth.onAuthStateChanged) {
    auth.onAuthStateChanged((u) => {
      if (db.sidUid !== null && (u ? u.uid : '') !== db.sidUid) { db.sid = null; db.restart(); }
    });
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') db.resumeNow(); });
  }
  return db;
}

export function doc(base, ...segs) {
  if (!isLocal(base)) return F.doc(base, ...segs);
  if (base instanceof ColRef && !segs.length) segs = [autoId()];
  const path = joinPath(base instanceof LocalDb ? '' : base.path, segs);
  if (!path || path.split('/').length % 2) throw dbError('invalid-argument', `Неверный путь документа: ${path}`);
  return new DocRef(dbOf(base), path);
}

export function collection(base, ...segs) {
  if (!isLocal(base)) return F.collection(base, ...segs);
  const path = joinPath(base instanceof LocalDb ? '' : base.path, segs);
  if (!path || path.split('/').length % 2 === 0) throw dbError('invalid-argument', `Неверный путь коллекции: ${path}`);
  return new ColRef(dbOf(base), path);
}

export const where = (field, op, value) => ({ kind: 'where', field, op, value });
export const orderBy = (field, dir = 'asc') => ({ kind: 'orderBy', field, dir });
export const limit = (n) => ({ kind: 'limit', n });

export function query(base, ...cs) {
  if (!isLocal(base)) {
    return F.query(base, ...cs.map((c) => (c.kind === 'where' ? F.where(c.field, c.op, toFs(c.value))
      : c.kind === 'orderBy' ? F.orderBy(c.field, c.dir) : F.limit(c.n))));
  }
  const spec = { ...base.spec, where: [...(base.spec.where || [])], orderBy: [...(base.spec.orderBy || [])] };
  for (const c of cs) {
    if (c.kind === 'where') spec.where.push([String(c.field), c.op, toWire(c.value)]);
    else if (c.kind === 'orderBy') spec.orderBy.push([String(c.field), c.dir === 'desc' ? 'desc' : 'asc']);
    else if (c.kind === 'limit') spec.limit = c.n;
  }
  return new Query(base.db, spec);
}

// ------------------------------------------------------------ снимки

class DocSnap {
  constructor(ref, exists, data) {
    this.ref = ref;
    this.id = ref.id;
    this._exists = exists;
    this._data = data;
    this.metadata = { fromCache: false, hasPendingWrites: false };
  }
  exists() { return this._exists; }
  data() { return this._exists ? fromWire(this._data) : undefined; }
  get(field) {
    let v = this._data;
    for (const p of String(field).split('.')) v = v && typeof v === 'object' ? v[p] : undefined;
    return fromWire(v);
  }
}

class QuerySnap {
  constructor(docs, changes) {
    this.docs = docs;
    this._changes = changes;
    this.size = docs.length;
    this.empty = docs.length === 0;
    this.metadata = { fromCache: false, hasPendingWrites: false };
  }
  forEach(fn, thisArg) { this.docs.forEach(fn, thisArg); }
  docChanges() { return this._changes; }
}

const snapOf = (db, d) => new DocSnap(new DocRef(db, d.path), !!d.exists, d.data);

class Sub {
  constructor(db, id, target, onNext, onError) {
    this.db = db;
    this.id = id;
    this.target = target;
    this.onNext = onNext;
    this.onError = onError;
    this.sent = false;
    this.closed = false;
    this.docs = new Map(); // путь → { data, ver }
    this.order = [];
    this.lastOrder = null;
    this.lastVers = new Map();
  }

  wire() {
    return this.target instanceof DocRef ? { id: this.id, doc: this.target.path } : { id: this.id, query: this.target.spec };
  }

  fail(e) {
    if (this.closed) return;
    this.closed = true;
    this.db.subs.delete(this.id);
    if (this.onError) this.onError(e);
    else console.error('Подписка на данные:', e);
  }

  apply(j) {
    if (this.closed) return;
    if (j.initial) this.docs = new Map();
    for (const d of j.docs || []) this.docs.set(d.path, { data: d.data, ver: d.ver });
    for (const p of j.removes || []) this.docs.delete(p);
    if (this.target instanceof DocRef) {
      const cur = this.docs.get(this.target.path);
      this.onNext(new DocSnap(this.target, j.exists !== false && !!cur, cur ? cur.data : undefined));
      return;
    }
    if (j.order) this.order = j.order;
    else if ((j.removes || []).length) this.order = this.order.filter((p) => this.docs.has(p));
    const docs = this.order.filter((p) => this.docs.has(p)).map((p) => new DocSnap(new DocRef(this.db, p), true, this.docs.get(p).data));
    const changes = [];
    const oldIdx = new Map((this.lastOrder || []).map((p, i) => [p, i]));
    const newIdx = new Map(docs.map((d, i) => [d.ref.path, i]));
    for (const [p, i] of oldIdx) {
      if (!newIdx.has(p)) changes.push({ type: 'removed', oldIndex: i, newIndex: -1, doc: new DocSnap(new DocRef(this.db, p), true, null) });
    }
    docs.forEach((d, i) => {
      const p = d.ref.path;
      if (!oldIdx.has(p)) changes.push({ type: 'added', oldIndex: -1, newIndex: i, doc: d });
      else if (this.lastVers.get(p) !== this.docs.get(p).ver) changes.push({ type: 'modified', oldIndex: oldIdx.get(p), newIndex: i, doc: d });
    });
    this.lastOrder = docs.map((d) => d.ref.path);
    this.lastVers = new Map(this.lastOrder.map((p) => [p, this.docs.get(p).ver]));
    this.onNext(new QuerySnap(docs, changes));
  }
}

// ------------------------------------------------------------ чтение и запись

export async function getDoc(ref) {
  if (!isLocal(ref)) return F.getDoc(ref);
  const j = await ref.db.post('/db/get', { paths: [ref.path] });
  return snapOf(ref.db, j.docs[0]);
}

export async function getDocs(q) {
  if (!isLocal(q)) return F.getDocs(q);
  const j = await q.db.post('/db/query', { query: q.spec });
  const docs = j.docs.map((d) => snapOf(q.db, d));
  return new QuerySnap(docs, docs.map((d, i) => ({ type: 'added', oldIndex: -1, newIndex: i, doc: d })));
}

function updateData(args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object') return args[0];
  const out = {};
  for (let i = 0; i + 1 < args.length; i += 2) out[String(args[i])] = args[i + 1];
  return out;
}

const writeOf = (op, ref, data, opts) => ({
  op, path: ref.path,
  ...(data ? { data: toWire(data) } : {}),
  ...(opts && opts.merge ? { merge: true } : {}),
  ...(op === 'update' ? { exists: true } : {}),
});

export async function setDoc(ref, data, opts) {
  if (!isLocal(ref)) return F.setDoc(ref, toFs(data), ...(opts ? [opts] : []));
  await ref.db.post('/db/commit', { writes: [writeOf('set', ref, data, opts)] });
}

export async function updateDoc(ref, ...args) {
  if (!isLocal(ref)) {
    if (args.length === 1) return F.updateDoc(ref, toFs(args[0]));
    return F.updateDoc(ref, ...args.map((a, i) => (i % 2 ? toFs(a) : a)));
  }
  await ref.db.post('/db/commit', { writes: [writeOf('update', ref, updateData(args))] });
}

export async function deleteDoc(ref) {
  if (!isLocal(ref)) return F.deleteDoc(ref);
  await ref.db.post('/db/commit', { writes: [writeOf('delete', ref)] });
}

export async function addDoc(col, data) {
  if (!isLocal(col)) return F.addDoc(col, toFs(data));
  const ref = doc(col);
  await setDoc(ref, data);
  return ref;
}

export function writeBatch(db) {
  if (!isLocal(db)) {
    const b = F.writeBatch(db);
    const fb = {
      set: (ref, data, opts) => { b.set(ref, toFs(data), ...(opts ? [opts] : [])); return fb; },
      update: (ref, data) => { b.update(ref, toFs(data)); return fb; },
      delete: (ref) => { b.delete(ref); return fb; },
      commit: () => b.commit(),
    };
    return fb;
  }
  const writes = [];
  const batch = {
    set: (ref, data, opts) => { writes.push(writeOf('set', ref, data, opts)); return batch; },
    update: (ref, ...args) => { writes.push(writeOf('update', ref, updateData(args))); return batch; },
    delete: (ref) => { writes.push(writeOf('delete', ref)); return batch; },
    // Большую пачку — частями: сервер принимает тело до ~1 МБ.
    commit: async () => {
      let part = [];
      let size = 0;
      for (const w of writes) {
        const n = JSON.stringify(w).length;
        if (part.length && size + n > 700000) { await db.post('/db/commit', { writes: part }); part = []; size = 0; }
        part.push(w);
        size += n;
      }
      if (part.length) await db.post('/db/commit', { writes: part });
    },
  };
  return batch;
}

export function onSnapshot(target, ...args) {
  if (!isLocal(target)) {
    return F.onSnapshot(target, ...args);
  }
  // (цель, [настройки], наблюдатель | next, error)
  let i = 0;
  const isObserver = (a) => a && typeof a === 'object' && ('next' in a || 'error' in a);
  if (args[0] && typeof args[0] === 'object' && !isObserver(args[0])) i = 1;
  let next = args[i];
  let error = args[i + 1];
  if (isObserver(next)) { error = next.error; next = next.next; }
  if (typeof next !== 'function') next = () => {};
  return target.db.listen(target, next, error);
}

export async function disableNetwork(db) {
  if (!isLocal(db)) return F.disableNetwork(db);
}

export async function enableNetwork(db) {
  if (!isLocal(db)) return F.enableNetwork(db);
  db.resumeNow();
}

/** Где сейчас данные страницы. */
export const isOwnServer = (db) => isLocal(db);
