"use strict";
/**
 * Маршруты своей карты в отдельном потоке: граф дорог (файлы roads-*.graph.gz
 * в папке карт) живёт в потоке-работнике, поиск не задерживает остальной
 * сервер. Новые файлы графа (после еженедельной сборки) подхватываются сами.
 */
const fs = require("fs");
const path = require("path");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const zlib = require("zlib");

// Сеть дорог района: roads-<id>.graph.gz (так хранит map-build — меньше места)
// или несжатый roads-<id>.graph (старые сборки, тесты). Если есть оба — новее.
const FILE_RE = /^roads-([a-z0-9_-]+)\.graph(\.gz)?$/;

function listGraphs(dir) {
  try {
    const byId = new Map();
    for (const f of fs.readdirSync(dir)) {
      const m = FILE_RE.exec(f);
      if (!m) continue;
      const st = fs.statSync(path.join(dir, f));
      const rec = { file: f, size: st.size, mtime: st.mtimeMs, gz: !!m[2] };
      const was = byId.get(m[1]);
      if (!was || rec.mtime > was.mtime || (rec.mtime === was.mtime && rec.gz)) byId.set(m[1], rec);
    }
    return [...byId.values()].sort((a, b) => (a.file < b.file ? -1 : 1));
  } catch (_) {
    return [];
  }
}

/** Файл графа целиком (сжатый — распаковать). */
function readGraphFile(file) {
  const buf = fs.readFileSync(file);
  return /\.gz$/.test(file) ? zlib.gunzipSync(buf) : buf;
}

/** Первые n байт графа (заголовок) — у сжатого распаковывается только начало. */
function readGraphHead(file, n) {
  const fd = fs.openSync(file, "r");
  try {
    const gz = /\.gz$/.test(file);
    const b = Buffer.alloc(gz ? 16384 : n);
    const got = fs.readSync(fd, b, 0, b.length, 0);
    const head = gz ? zlib.gunzipSync(b.subarray(0, got), { finishFlush: zlib.constants.Z_SYNC_FLUSH }) : b.subarray(0, got);
    if (head.length < n) throw new Error("файл графа короче заголовка");
    return head.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------ поток-работник ------------------------------ */

if (!isMainThread && workerData && workerData.zalMapRouter) {
  const G = require("./map-graph");
  // Городов много (вся Россия) — в памяти держим только нужные сейчас сети
  // дорог: границы каждого файла читаются из заголовка (48 байт), сам граф —
  // при первом маршруте в этом городе, лишние выгружаются (не больше MAX_LOADED).
  const MAX_LOADED = Number(workerData.maxLoaded) || 3;
  let index = [];
  const loaded = new Map(); // file → { g, used }
  const readBounds = (file) => {
    const b = readGraphHead(path.join(workerData.dir, file), 48);
    if (b.readUInt32LE(0) !== G.MAGIC) throw new Error("не граф дорог ZalPOS");
    return { bounds: [b.readInt32LE(32) / 1e6, b.readInt32LE(36) / 1e6, b.readInt32LE(40) / 1e6, b.readInt32LE(44) / 1e6], createdAt: b.readDoubleLE(24), nV: b.readUInt32LE(8), nE: b.readUInt32LE(12) };
  };
  const scan = () => {
    const next = [];
    for (const f of listGraphs(workerData.dir)) {
      try {
        next.push({ file: f.file, sig: `${f.size}:${f.mtime}`, ...readBounds(f.file) });
      } catch (e) {
        parentPort.postMessage({ log: `граф ${f.file} не прочитан: ${e.message}` });
      }
    }
    // Сменившиеся и удалённые файлы — выгрузить.
    for (const [file, rec] of loaded) {
      const now = next.find((x) => x.file === file);
      if (!now || now.sig !== rec.sig) loaded.delete(file);
    }
    index = next;
    parentPort.postMessage({ loaded: index.map((g) => ({ file: g.file, bounds: g.bounds, nV: g.nV, nE: g.nE, createdAt: g.createdAt })) });
  };
  const within = (g, p, pad = 0.02) => p.lat >= g.bounds[0] - pad && p.lat <= g.bounds[2] + pad && p.lng >= g.bounds[1] - pad && p.lng <= g.bounds[3] + pad;
  const graphFor = (points) => {
    // Самый маленький район, где все точки (город внутри большого района — точнее и быстрее).
    const cands = index.filter((g) => points.every((p) => within(g, p))).sort((a, b) => a.nV - b.nV);
    for (const c of cands) {
      let rec = loaded.get(c.file);
      if (!rec) {
        const g = G.loadGraph(readGraphFile(path.join(workerData.dir, c.file)));
        rec = { g, sig: c.sig, used: 0 };
        loaded.set(c.file, rec);
        while (loaded.size > MAX_LOADED) {
          let old = null;
          for (const [f, r] of loaded) if (f !== c.file && (!old || r.used < old[1].used)) old = [f, r];
          if (!old) break;
          loaded.delete(old[0]);
        }
      }
      rec.used = Date.now();
      if (points.every((p) => G.contains(rec.g, p.lat, p.lng))) return rec.g;
    }
    return null;
  };
  scan();
  parentPort.on("message", (msg) => {
    if (msg.reload) return scan();
    const { id, points, mode } = msg;
    try {
      const g = graphFor(points);
      if (!g) return parentPort.postMessage({ id, result: { ok: false, reason: "nomap" } });
      parentPort.postMessage({ id, result: G.route(g, points, mode) });
    } catch (e) {
      parentPort.postMessage({ id, result: { ok: false, reason: "error", message: String(e && e.message) } });
    }
  });
  return;
}

/* ------------------------------ основной поток ------------------------------ */

function createRouter({ dir, log = () => {}, checkMs = 60000, now = Date.now } = {}) {
  let worker = null;
  let loaded = [];
  let seq = 0;
  let sig = "";
  let lastCheck = 0;
  const pending = new Map();

  function signature() {
    return listGraphs(dir).map((f) => `${f.file}:${f.size}:${f.mtime}`).join("|");
  }

  function start() {
    worker = new Worker(__filename, {
      workerData: { zalMapRouter: true, dir },
      resourceLimits: { maxOldGenerationSizeMb: 384 },
    });
    worker.unref();
    worker.on("message", (msg) => {
      if (msg.log) return log(msg.log);
      if (msg.loaded) { loaded = msg.loaded; return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg.result);
    });
    const fail = (why) => {
      log(`маршруты: поток остановился (${why})`);
      worker = null;
      loaded = [];
      for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, reason: "error" }); }
      pending.clear();
    };
    worker.on("error", (e) => fail(e && e.message));
    worker.on("exit", (code) => { if (worker) fail(`код ${code}`); });
  }

  /** Есть ли графы и не поменялись ли файлы (не чаще раза в checkMs). */
  function refresh(force = false) {
    if (!force && now() - lastCheck < checkMs) return;
    lastCheck = now();
    const s = signature();
    if (s === sig && (worker || !s)) return;
    const changed = s !== sig;
    sig = s;
    if (!s) {
      if (worker) { const w = worker; worker = null; w.terminate().catch(() => {}); }
      loaded = [];
      return;
    }
    if (!worker) start();
    else if (changed) worker.postMessage({ reload: true });
  }

  /** points: [{lat, lng}, ...] (2–6 точек), mode: auto | bike | foot. */
  function route(points, mode = "auto", { timeoutMs = 5000 } = {}) {
    refresh();
    if (!worker) return Promise.resolve({ ok: false, reason: "nomap" });
    if (pending.size >= 32) return Promise.resolve({ ok: false, reason: "busy" });
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, reason: "timeout" }); }, timeoutMs);
      pending.set(id, { resolve, timer });
      worker.postMessage({ id, points, mode });
    });
  }

  function info() {
    refresh();
    return { regions: loaded.map((g) => ({ bounds: g.bounds, builtAt: g.createdAt || null })) };
  }

  function close() {
    if (worker) { const w = worker; worker = null; return w.terminate(); }
    return Promise.resolve();
  }

  return { route, info, refresh, close, available: () => !!sig };
}

module.exports = { createRouter, listGraphs };
