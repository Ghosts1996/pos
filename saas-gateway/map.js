"use strict";
/**
 * Своя карта ZalPOS (адрес /map/…, снаружи https://pii.zalpos.ru/saas/map/…):
 *
 *   map/info                        — есть ли карта и маршруты, версия, границы
 *   map/tiles/{z}/{x}/{y}.mvt       — векторные тайлы из файла PMTiles
 *   map/fonts/{шрифт}/{диапазон}.pbf — шрифты подписей
 *   map/maplibre-gl-csp.js …         — движок карты MapLibre (свой, без CDN)
 *   map/zal-map.js, map/map-style.js — наша обёртка и стиль
 *
 * Всё — с нашего сервера в России: браузер курьера, кабинета и гостя не
 * обращается к чужим картам, координаты никуда не уходят. Тайлы и граф
 * дорог собирает map-build.js (раз в неделю, в фоне, с пределом памяти).
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { openPmtiles } = require("./map-tiles");
const { createRouter } = require("./map-router");

const STATIC = {
  "maplibre-gl-csp.js": ["map-web", "text/javascript; charset=utf-8"],
  "maplibre-gl-csp-worker.js": ["map-web", "text/javascript; charset=utf-8"],
  "maplibre-gl.css": ["map-web", "text/css; charset=utf-8"],
  "zal-map.js": ["map-web", "text/javascript; charset=utf-8"],
  "zal-map.css": ["map-web", "text/css; charset=utf-8"],
  "LICENSE-maplibre.txt": ["map-web", "text/plain; charset=utf-8"],
  "LICENSE-fonts.txt": ["map-web", "text/plain; charset=utf-8"],
  "map-style.js": [".", "text/javascript; charset=utf-8"],
};
const EMPTY = Buffer.alloc(0);
const MODES = new Set(["auto", "bike", "foot"]);

function createMap({
  dir = process.env.MAP_DIR || "/opt/zalpos-maps",
  root = __dirname,
  regionsFile = null,
  log = () => {},
  now = Date.now,
} = {}) {
  const tilesFile = path.join(dir, "tiles.pmtiles");
  const fontsDir = path.join(root, "map-web", "fonts");
  const files = new Map();
  let tiles = null;
  let tilesSig = "";
  let lastCheck = 0;
  const router = createRouter({ dir, log });

  function headers(type, extra = {}) {
    return {
      "Content-Type": type,
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    };
  }

  function acceptsGzip(req) {
    return /\bgzip\b/.test(String((req.headers && req.headers["accept-encoding"]) || ""));
  }

  /** Тайлы: файл открыт один раз, после пересборки — открывается заново. */
  function currentTiles() {
    if (now() - lastCheck < 30000 && (tiles || tilesSig === "none")) return tiles;
    lastCheck = now();
    let st;
    try { st = fs.statSync(tilesFile); } catch (_) { st = null; }
    const sig = st ? `${st.size}:${Math.round(st.mtimeMs)}` : "none";
    if (sig === tilesSig) return tiles;
    if (tiles) { try { tiles.close(); } catch (_) {} }
    tiles = null;
    tilesSig = sig;
    if (!st) return null;
    try {
      const p = openPmtiles(tilesFile);
      if (p.header.tileType !== 1) throw new Error("не векторные тайлы");
      p.version = crypto.createHash("sha1").update(sig).digest("hex").slice(0, 10);
      tiles = p;
    } catch (e) {
      log(`карта: ${tilesFile} не открылся — ${e.message}`);
    }
    return tiles;
  }

  /** Итог последней сборки карты (map-build.js): когда, получилось ли, ошибки. */
  function buildStatus() {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
      return {
        at: String(st.finishedAt || st.startedAt || ""),
        ok: st.ok === true,
        regions: Array.isArray(st.regions) ? st.regions.length : 0,
        errors: (Array.isArray(st.errors) ? st.errors : []).map((e) => String(e).slice(0, 300)).slice(0, 5),
      };
    } catch (_) {
      return null;
    }
  }

  function info() {
    const t = currentTiles();
    const r = router.info();
    const h = t && t.header;
    return {
      ok: true,
      tiles: t ? {
        v: t.version,
        minzoom: h.minZoom,
        maxzoom: h.maxZoom,
        bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat],
        center: [h.centerLon, h.centerLat, h.centerZoom],
      } : null,
      route: router.available() ? { modes: [...MODES], regions: r.regions } : null,
      build: buildStatus(),
      attribution: "© OpenStreetMap",
    };
  }

  function sendStatic(req, res, name) {
    const [base, type] = STATIC[name];
    const file = path.join(root, base, name);
    let st;
    try { st = fs.statSync(file); } catch (_) { return notFound(res); }
    let f = files.get(name);
    if (!f || f.mtime !== st.mtimeMs) {
      const body = fs.readFileSync(file);
      f = {
        body,
        gz: zlib.gzipSync(body, { level: 9 }),
        mtime: st.mtimeMs,
        etag: `"${crypto.createHash("sha1").update(body).digest("hex").slice(0, 20)}"`,
      };
      files.set(name, f);
    }
    const h = headers(type, { "Cache-Control": "public, max-age=3600", ETag: f.etag, Vary: "Accept-Encoding" });
    // Поток карты живёт по своей политике безопасности (берётся из ответа на
    // сам скрипт): ему нужно только скачивать тайлы и шрифты с этого же адреса.
    if (name === "maplibre-gl-csp-worker.js") h["Content-Security-Policy"] = "default-src 'none'; connect-src 'self'";
    if (req.headers && req.headers["if-none-match"] === f.etag) { res.writeHead(304, h); return res.end(); }
    const gz = acceptsGzip(req);
    const body = gz ? f.gz : f.body;
    res.writeHead(200, { ...h, ...(gz ? { "Content-Encoding": "gzip" } : {}), "Content-Length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  function notFound(res) {
    res.writeHead(404, headers("text/plain; charset=utf-8"));
    res.end("Не найдено");
  }

  function sendFont(req, res, stack, range) {
    const names = decodeURIComponent(stack).split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9 ]{1,60}$/.test(s));
    let body = EMPTY;
    for (const n of names) {
      try { body = fs.readFileSync(path.join(fontsDir, n, `${range}.pbf`)); break; } catch (_) {}
    }
    // Нет такого диапазона знаков — пустой ответ: карта просто пропустит эти буквы.
    res.writeHead(200, headers("application/x-protobuf", { "Cache-Control": "public, max-age=604800", "Content-Length": body.length }));
    res.end(req.method === "HEAD" ? undefined : body);
  }

  function sendTile(req, res, z, x, y, v) {
    const t = currentTiles();
    if (!t) return notFound(res);
    const cache = v && v === t.version ? "public, max-age=2592000, immutable" : "public, max-age=3600";
    let data = null;
    try { data = t.tile(z, x, y); } catch (e) { log(`карта: тайл ${z}/${x}/${y} — ${e.message}`); }
    if (!data || !data.length) {
      res.writeHead(204, headers("application/vnd.mapbox-vector-tile", { "Cache-Control": cache }));
      return res.end();
    }
    const gzipped = t.encoding === "gzip";
    let body = data;
    let enc = {};
    if (gzipped && acceptsGzip(req)) enc = { "Content-Encoding": "gzip" };
    else if (gzipped) body = zlib.gunzipSync(data);
    res.writeHead(200, headers("application/vnd.mapbox-vector-tile", { ...enc, "Cache-Control": cache, Vary: "Accept-Encoding", "Content-Length": body.length }));
    res.end(req.method === "HEAD" ? undefined : body);
  }

  /** rel — путь после /map/, query — строка после «?». */
  function serve(req, res, rel, query = "") {
    if (rel === "info") {
      const body = Buffer.from(JSON.stringify(info()));
      res.writeHead(200, headers("application/json; charset=utf-8", { "Cache-Control": "no-cache", "Content-Length": body.length }));
      return res.end(req.method === "HEAD" ? undefined : body);
    }
    if (Object.prototype.hasOwnProperty.call(STATIC, rel)) return sendStatic(req, res, rel);
    let m = /^tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.mvt$/.exec(rel);
    if (m) {
      const z = Number(m[1]), x = Number(m[2]), y = Number(m[3]);
      if (z > 22 || x >= 2 ** z || y >= 2 ** z) return notFound(res);
      const v = (/(?:^|&)v=([0-9a-f]{1,20})(?:&|$)/.exec(query) || [])[1] || "";
      return sendTile(req, res, z, x, y, v);
    }
    m = /^fonts\/([^/]{1,200})\/(\d{1,5})-(\d{1,5})\.pbf$/.exec(rel);
    if (m && Number(m[3]) - Number(m[2]) === 255 && Number(m[2]) % 256 === 0) return sendFont(req, res, m[1], `${m[2]}-${m[3]}`);
    return notFound(res);
  }

  /** Маршрут для курьера или кабинета: points [{lat, lng}], mode. */
  async function route(body) {
    const raw = Array.isArray(body && body.points) ? body.points.slice(0, 6) : [];
    const points = raw
      .map((p) => ({ lat: Number(p && p.lat), lng: Number(p && p.lng) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180);
    if (points.length < 2 || points.length !== raw.length) return { ok: false, reason: "points" };
    const mode = MODES.has(body.mode) ? body.mode : "auto";
    const r = await router.route(points, mode);
    // Велосипед не проехал (одностороннее, лестница) — путь пешком с велосипедом в руках.
    if (!r.ok && r.reason === "noroute" && mode === "bike") {
      const f = await router.route(points, "foot");
      if (f.ok) return { ...f, mode: "bike", s: Math.round(f.s * 0.45), legs: (f.legs || []).map((l) => ({ m: l.m, s: Math.round(l.s * 0.45) })), viaFoot: true };
    }
    return r;
  }

  /** Координаты точек заведений — для сборки карты (только числа, без названий). */
  function saveRegions(points) {
    if (!regionsFile) return false;
    const list = [];
    const seen = new Set();
    for (const p of points || []) {
      const lat = Math.round(Number(p && p.lat) * 1000) / 1000;
      const lng = Math.round(Number(p && p.lng) * 1000) / 1000;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || (!lat && !lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const k = `${lat},${lng}`;
      if (seen.has(k)) continue;
      seen.add(k);
      list.push([lat, lng]);
    }
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const next = JSON.stringify({ points: list });
    let prev = "";
    try { prev = JSON.stringify({ points: JSON.parse(fs.readFileSync(regionsFile, "utf8")).points }); } catch (_) {}
    if (prev === next) return false;
    fs.mkdirSync(path.dirname(regionsFile), { recursive: true });
    const tmp = `${regionsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ points: list, updatedAt: new Date(now()).toISOString() }));
    fs.renameSync(tmp, regionsFile);
    return true;
  }

  function close() {
    if (tiles) { try { tiles.close(); } catch (_) {} tiles = null; }
    return router.close();
  }

  return { serve, info, route, saveRegions, close };
}

module.exports = { createMap };
