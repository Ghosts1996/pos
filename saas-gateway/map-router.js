"use strict";
/**
 * Маршруты своей карты в отдельном потоке: граф дорог (файлы roads-*.graph
 * в папке карт) живёт в потоке-работнике, поиск не задерживает остальной
 * сервер. Новые файлы графа (после еженедельной сборки) подхватываются сами.
 */
const fs = require("fs");
const path = require("path");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const FILE_RE = /^roads-[a-z0-9_-]+\.graph$/;

function listGraphs(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => FILE_RE.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => (a.file < b.file ? -1 : 1));
  } catch (_) {
    return [];
  }
}

/* ------------------------------ поток-работник ------------------------------ */

if (!isMainThread && workerData && workerData.zalMapRouter) {
  const G = require("./map-graph");
  let graphs = [];
  const load = () => {
    const next = [];
    for (const f of listGraphs(workerData.dir)) {
      try {
        const g = G.loadGraph(fs.readFileSync(path.join(workerData.dir, f.file)));
        g.file = f.file;
        next.push(g);
      } catch (e) {
        parentPort.postMessage({ log: `граф ${f.file} не прочитан: ${e.message}` });
      }
    }
    graphs = next;
    parentPort.postMessage({
      loaded: graphs.map((g) => ({ file: g.file, bounds: g.bounds, nV: g.nV, nE: g.nE, createdAt: g.createdAt })),
    });
  };
  load();
  parentPort.on("message", (msg) => {
    if (msg.reload) return load();
    const { id, points, mode } = msg;
    try {
      const g = graphs.find((x) => points.every((p) => G.contains(x, p.lat, p.lng)));
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
      resourceLimits: { maxOldGenerationSizeMb: 256 },
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
