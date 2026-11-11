"use strict";
/**
 * Свой построитель маршрутов ZalPOS — без внешних служб (152-ФЗ: координаты
 * курьеров никуда не уходят).
 *
 * 1. buildGraph(oplLines) — граф дорог из выгрузки OpenStreetMap в формате
 *    OPL (osmium add-locations-to-ways -f opl): перекрёстки — вершины, участки
 *    улиц между ними — рёбра с длиной, классом дороги, разрешениями
 *    (авто / велосипед / пешком) и односторонним движением. Остаётся только
 *    самая большая связная сеть — без «островков» парковок и дворов.
 * 2. encodeGraph / loadGraph — компактный двоичный файл (типизированные массивы).
 * 3. route(graph, points, mode) — A* от точки к точке с привязкой к ближайшей
 *    подходящей дороге; ответ — метры, секунды и линия маршрута.
 */

const CLASSES = [
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
  "residential", "living_street", "service", "track", "road", "pedestrian",
  "footway", "path", "cycleway", "steps", "bridleway",
];
const CLASS_ID = new Map(CLASSES.map((c, i) => [c, i]));

// Скорости в городе, км/ч (с учётом светофоров и пробок — не «по знаку»).
const SPEEDS = {
  auto: {
    motorway: 65, motorway_link: 40, trunk: 50, trunk_link: 35, primary: 36, primary_link: 28,
    secondary: 32, secondary_link: 26, tertiary: 28, tertiary_link: 22, unclassified: 24,
    residential: 20, living_street: 10, service: 12, track: 10, road: 18,
  },
  bike: {
    trunk: 14, trunk_link: 14, primary: 16, primary_link: 15, secondary: 17, secondary_link: 16,
    tertiary: 17, tertiary_link: 16, unclassified: 17, residential: 16, living_street: 14,
    service: 14, track: 12, road: 15, pedestrian: 11, footway: 12, path: 12, cycleway: 18,
    steps: 2, bridleway: 8,
  },
  foot: {
    trunk: 4.5, trunk_link: 4.5, primary: 5, primary_link: 5, secondary: 5, secondary_link: 5,
    tertiary: 5, tertiary_link: 5, unclassified: 5, residential: 5, living_street: 5,
    service: 5, track: 4.5, road: 5, pedestrian: 5, footway: 5, path: 4.6, cycleway: 5,
    steps: 2.5, bridleway: 4.5,
  },
};
const MODES = ["auto", "bike", "foot"];
// Скорость в м/с по режиму и классу (0 — нельзя).
const SPEED_MS = Object.fromEntries(MODES.map((m) => [m, Float64Array.from(CLASSES, (c) => (SPEEDS[m][c] || 0) / 3.6)]));
const VMAX = Object.fromEntries(MODES.map((m) => [m, Math.max(...SPEED_MS[m])]));

// Флаги ребра.
const F_AUTO_FWD = 1, F_AUTO_BACK = 2, F_BIKE_FWD = 4, F_BIKE_BACK = 8, F_FOOT = 16, F_PRIVATE = 32;
const PRIVATE_PENALTY = 2.5;

const R = 6371008.8;
const RAD = Math.PI / 180;

function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* ---------------------------- разбор OPL ---------------------------- */

function unescapeOpl(s) {
  return s.indexOf("%") < 0 ? s : s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** Строка OPL с линией → {tags, nodes:[[id, lat, lon] | [id, NaN, NaN]]} или null. */
function parseWayLine(line) {
  if (line.charCodeAt(0) !== 119 /* w */) return null;
  let tagsRaw = "";
  let nodesRaw = "";
  for (const f of line.split(" ")) {
    if (f[0] === "T") tagsRaw = f.slice(1);
    else if (f[0] === "N") nodesRaw = f.slice(1);
  }
  const tags = {};
  if (tagsRaw) {
    for (const kv of tagsRaw.split(",")) {
      const i = kv.indexOf("=");
      if (i > 0) tags[unescapeOpl(kv.slice(0, i))] = unescapeOpl(kv.slice(i + 1));
    }
  }
  const nodes = [];
  if (nodesRaw) {
    for (const n of nodesRaw.split(",")) {
      const m = /^n(\d+)x([-\d.]*)y([-\d.]*)$/.exec(n);
      if (!m) continue;
      nodes.push([Number(m[1]), m[3] === "" ? NaN : Number(m[3]), m[2] === "" ? NaN : Number(m[2])]);
    }
  }
  return { tags, nodes };
}

const NO = new Set(["no", "private_no"]);
const RESTRICTED = new Set(["private", "destination", "customers", "delivery"]);
const YES = new Set(["yes", "designated", "permissive", "destination", "official"]);

/** Разрешения и направление по тегам → флаги, или -1 (линия не для маршрутов). */
function wayFlags(tags) {
  const hw = tags.highway;
  if (!hw || !CLASS_ID.has(hw)) return -1;
  if (tags.area === "yes" && hw !== "pedestrian" && hw !== "footway") return -1;
  const access = tags.access || "";
  if (access === "no" && !YES.has(tags.foot) && !YES.has(tags.bicycle) && !YES.has(tags.motor_vehicle) && !YES.has(tags.motorcar)) return -1;
  let flags = 0;
  const c = hw;
  // Авто.
  let auto = (SPEEDS.auto[c] || 0) > 0;
  const mv = tags.motorcar || tags.motor_vehicle || tags.vehicle || "";
  if (access === "no" || NO.has(mv)) auto = false;
  if (YES.has(mv)) auto = (SPEEDS.auto[c] || 0) > 0 || c === "pedestrian";
  // Велосипед.
  let bike = (SPEEDS.bike[c] || 0) > 0;
  if (access === "no" || NO.has(tags.bicycle || tags.vehicle || "")) bike = false;
  if (YES.has(tags.bicycle)) bike = true;
  if (c === "motorway" || c === "motorway_link") bike = false;
  // Пешком.
  let foot = (SPEEDS.foot[c] || 0) > 0;
  if (access === "no" || NO.has(tags.foot || "")) foot = false;
  if (YES.has(tags.foot)) foot = true;
  if (c === "motorway" || c === "motorway_link") foot = false;
  if (!auto && !bike && !foot) return -1;

  // Одностороннее движение.
  const ow = tags.oneway || "";
  let dir = 0; // 0 — в обе стороны, 1 — по линии, -1 — против
  if (ow === "yes" || ow === "1" || ow === "true") dir = 1;
  else if (ow === "-1" || ow === "reverse") dir = -1;
  else if (ow !== "no" && (tags.junction === "roundabout" || tags.junction === "circular" || c === "motorway")) dir = 1;
  if (auto) {
    if (dir >= 0) flags |= F_AUTO_FWD;
    if (dir <= 0) flags |= F_AUTO_BACK;
  }
  if (bike) {
    const bikeTwoWay = tags["oneway:bicycle"] === "no" || /^opposite/.test(tags.cycleway || "") || (c !== "cycleway" && !auto && dir !== 0);
    const bdir = bikeTwoWay ? 0 : (tags["oneway:bicycle"] === "yes" ? 1 : dir);
    if (bdir >= 0) flags |= F_BIKE_FWD;
    if (bdir <= 0) flags |= F_BIKE_BACK;
  }
  if (foot) flags |= F_FOOT;
  if (RESTRICTED.has(access) || RESTRICTED.has(mv)) flags |= F_PRIVATE;
  return flags;
}

/* ---------------------------- сборка ---------------------------- */

class GrowF64 {
  constructor(n = 1024) { this.a = new Float64Array(n); this.n = 0; }
  push(v) { if (this.n === this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  view() { return this.a.subarray(0, this.n); }
}
class Grow {
  constructor(Type, n = 1024) { this.T = Type; this.a = new Type(n); this.n = 0; }
  push(v) { if (this.n === this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  view() { return this.a.slice(0, this.n); }
}

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * readLines(cb) — вызывает cb(line) для каждой строки OPL (дважды: граф
 * собирается в два прохода, чтобы не держать все линии в памяти).
 */
async function buildGraph(readLines, { log = () => {} } = {}) {
  // Проход 1: какие точки — перекрёстки (встречаются ≥2 раз или концы линий).
  const refs = new GrowF64(1 << 16);
  let ways = 0;
  await readLines((line) => {
    const w = parseWayLine(line);
    if (!w || wayFlags(w.tags) < 0) return;
    ways++;
    const nodes = w.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const [id, lat] = nodes[i];
      refs.push(id);
      const end = i === 0 || i === nodes.length - 1;
      const gap = Number.isNaN(lat) || (i > 0 && Number.isNaN(nodes[i - 1][1])) || (i < nodes.length - 1 && Number.isNaN(nodes[i + 1][1]));
      if (end || gap) refs.push(id);
    }
  });
  const sorted = refs.view().sort();
  const vIds = new GrowF64(1 << 14);
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j] === sorted[i]) j++;
    if (j - i >= 2) vIds.push(sorted[i]);
    i = j;
  }
  const ids = vIds.view().slice();
  const nV0 = ids.length;
  log(`линий: ${ways}, перекрёстков: ${nV0}`);
  const vLat = new Int32Array(nV0).fill(0x7fffffff);
  const vLon = new Int32Array(nV0);
  const eFrom = new Grow(Uint32Array), eTo = new Grow(Uint32Array), eLen = new Grow(Float32Array);
  const eCls = new Grow(Uint8Array), eFlags = new Grow(Uint8Array), eOff = new Grow(Uint32Array), eCnt = new Grow(Uint32Array);
  const sLat = new Grow(Int32Array, 1 << 16), sLon = new Grow(Int32Array, 1 << 16);
  const vIndex = (id) => { const i = lowerBound(ids, id); return i < ids.length && ids[i] === id ? i : -1; };

  // Проход 2: рёбра между перекрёстками.
  await readLines((line) => {
    const w = parseWayLine(line);
    if (!w) return;
    const flags = wayFlags(w.tags);
    if (flags < 0) return;
    const cls = CLASS_ID.get(w.tags.highway);
    let start = -1, len = 0, prevLat = 0, prevLon = 0, shapeOff = 0, shapeCnt = 0;
    for (const [id, lat, lon] of w.nodes) {
      if (Number.isNaN(lat)) { start = -1; continue; }
      const vi = vIndex(id);
      if (start < 0) {
        if (vi < 0) continue;
        start = vi; len = 0; prevLat = lat; prevLon = lon; shapeOff = sLat.n; shapeCnt = 0;
        vLat[vi] = Math.round(lat * 1e6); vLon[vi] = Math.round(lon * 1e6);
        continue;
      }
      len += haversine(prevLat, prevLon, lat, lon);
      prevLat = lat; prevLon = lon;
      if (vi < 0) {
        sLat.push(Math.round(lat * 1e6)); sLon.push(Math.round(lon * 1e6)); shapeCnt++;
        continue;
      }
      vLat[vi] = Math.round(lat * 1e6); vLon[vi] = Math.round(lon * 1e6);
      if (vi !== start || shapeCnt > 0) {
        if (vi === start) {
          // Кольцо из одного перекрёстка — для маршрутов бесполезно.
          sLat.n = shapeOff; sLon.n = shapeOff;
        } else {
          eFrom.push(start); eTo.push(vi); eLen.push(Math.max(0.1, len)); eCls.push(cls); eFlags.push(flags);
          eOff.push(shapeOff); eCnt.push(shapeCnt);
        }
      }
      start = vi; len = 0; shapeOff = sLat.n; shapeCnt = 0;
    }
    // Хвост без перекрёстка в конце (обрезка выгрузки) — отбрасываем.
    if (start >= 0 && shapeCnt > 0) { sLat.n = shapeOff; sLon.n = shapeOff; }
  });

  const E = { from: eFrom.view(), to: eTo.view(), len: eLen.view(), cls: eCls.view(), flags: eFlags.view(), off: eOff.view(), cnt: eCnt.view() };
  const nE0 = E.from.length;

  // Самая большая связная сеть (union-find).
  const parent = new Int32Array(nV0);
  for (let i = 0; i < nV0; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let e = 0; e < nE0; e++) { const a = find(E.from[e]), b = find(E.to[e]); if (a !== b) parent[a] = b; }
  const size = new Uint32Array(nV0);
  for (let e = 0; e < nE0; e++) { size[find(E.from[e])]++; }
  let best = -1, bestSize = 0;
  for (let i = 0; i < nV0; i++) if (size[i] > bestSize) { bestSize = size[i]; best = i; }

  // Перенумерация: только вершины главной сети.
  const remap = new Int32Array(nV0).fill(-1);
  let nV = 0;
  for (let e = 0; e < nE0; e++) {
    if (find(E.from[e]) !== best) continue;
    for (const v of [E.from[e], E.to[e]]) if (remap[v] < 0) remap[v] = nV++;
  }
  const out = {
    vLat: new Int32Array(nV), vLon: new Int32Array(nV),
    eFrom: [], eTo: [], eLen: [], eCls: [], eFlags: [], eOff: [], eCnt: [],
  };
  for (let v = 0; v < nV0; v++) if (remap[v] >= 0) { out.vLat[remap[v]] = vLat[v]; out.vLon[remap[v]] = vLon[v]; }
  const shLat = new Grow(Int32Array, 1 << 16), shLon = new Grow(Int32Array, 1 << 16);
  for (let e = 0; e < nE0; e++) {
    if (find(E.from[e]) !== best) continue;
    out.eFrom.push(remap[E.from[e]]); out.eTo.push(remap[E.to[e]]); out.eLen.push(E.len[e]);
    out.eCls.push(E.cls[e]); out.eFlags.push(E.flags[e]); out.eOff.push(shLat.n); out.eCnt.push(E.cnt[e]);
    for (let k = 0; k < E.cnt[e]; k++) { shLat.push(sLat.a[E.off[e] + k]); shLon.push(sLon.a[E.off[e] + k]); }
  }
  log(`главная сеть: ${nV} перекрёстков, ${out.eFrom.length} участков (было ${nE0})`);
  return {
    vLat: out.vLat, vLon: out.vLon,
    eFrom: Uint32Array.from(out.eFrom), eTo: Uint32Array.from(out.eTo), eLen: Float32Array.from(out.eLen),
    eCls: Uint8Array.from(out.eCls), eFlags: Uint8Array.from(out.eFlags),
    eOff: Uint32Array.from(out.eOff), eCnt: Uint32Array.from(out.eCnt),
    sLat: shLat.view(), sLon: shLon.view(),
  };
}

/* ------------------------ двоичный файл ------------------------ */

const MAGIC = 0x3147525a; // "ZRG1"
const HEADER = 64;

function encodeGraph(g, { createdAt = Date.now() } = {}) {
  const nV = g.vLat.length, nE = g.eFrom.length, nS = g.sLat.length;
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (let i = 0; i < nV; i++) {
    if (g.vLat[i] < minLat) minLat = g.vLat[i]; if (g.vLat[i] > maxLat) maxLat = g.vLat[i];
    if (g.vLon[i] < minLon) minLon = g.vLon[i]; if (g.vLon[i] > maxLon) maxLon = g.vLon[i];
  }
  for (let i = 0; i < nS; i++) {
    if (g.sLat[i] < minLat) minLat = g.sLat[i]; if (g.sLat[i] > maxLat) maxLat = g.sLat[i];
    if (g.sLon[i] < minLon) minLon = g.sLon[i]; if (g.sLon[i] > maxLon) maxLon = g.sLon[i];
  }
  const parts = [g.vLat, g.vLon, g.eFrom, g.eTo, g.eLen, g.eOff, g.eCnt, g.sLat, g.sLon, g.eCls, g.eFlags];
  const total = HEADER + parts.reduce((s, a) => s + a.byteLength, 0);
  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(MAGIC, 0); buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(nV, 8); buf.writeUInt32LE(nE, 12); buf.writeUInt32LE(nS, 16);
  buf.writeDoubleLE(createdAt, 24);
  buf.writeInt32LE(nV ? minLat : 0, 32); buf.writeInt32LE(nV ? minLon : 0, 36);
  buf.writeInt32LE(nV ? maxLat : 0, 40); buf.writeInt32LE(nV ? maxLon : 0, 44);
  let off = HEADER;
  for (const a of parts) { Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(buf, off); off += a.byteLength; }
  return buf;
}

function loadGraph(input) {
  // Типизированным массивам нужно выравнивание — копия в свой буфер.
  const u8 = new Uint8Array(input.length);
  u8.set(input);
  const buf = u8.buffer;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("не граф дорог ZalPOS");
  const nV = dv.getUint32(8, true), nE = dv.getUint32(12, true), nS = dv.getUint32(16, true);
  let off = HEADER;
  const take = (T, n) => { const a = new T(buf, off, n); off += a.byteLength; return a; };
  const g = {
    nV, nE, nS,
    createdAt: dv.getFloat64(24, true),
    bounds: [dv.getInt32(32, true) / 1e6, dv.getInt32(36, true) / 1e6, dv.getInt32(40, true) / 1e6, dv.getInt32(44, true) / 1e6],
    vLat: take(Int32Array, nV), vLon: take(Int32Array, nV),
    eFrom: take(Uint32Array, nE), eTo: take(Uint32Array, nE), eLen: take(Float32Array, nE),
    eOff: take(Uint32Array, nE), eCnt: take(Uint32Array, nE),
    sLat: take(Int32Array, nS), sLon: take(Int32Array, nS),
    eCls: take(Uint8Array, nE), eFlags: take(Uint8Array, nE),
  };
  prepare(g);
  return g;
}

/** Смежность и сетка для привязки точки к дороге. */
function prepare(g) {
  const { nV, nE } = g;
  const deg = new Uint32Array(nV + 1);
  for (let e = 0; e < nE; e++) { deg[g.eFrom[e]]++; deg[g.eTo[e]]++; }
  g.adjOff = new Uint32Array(nV + 1);
  for (let v = 0; v < nV; v++) g.adjOff[v + 1] = g.adjOff[v] + deg[v];
  g.adj = new Uint32Array(2 * nE);
  const fill = g.adjOff.slice(0, nV);
  for (let e = 0; e < nE; e++) { g.adj[fill[g.eFrom[e]]++] = e * 2; g.adj[fill[g.eTo[e]]++] = e * 2 + 1; }

  const [minLat, minLon, maxLat, maxLon] = g.bounds;
  const midLat = (minLat + maxLat) / 2;
  g.kx = Math.cos(midLat * RAD) * R * RAD; // метров в градусе долготы
  g.ky = R * RAD;
  let cellM = 150;
  let W, H;
  for (;;) {
    W = Math.max(1, Math.ceil(((maxLon - minLon) * g.kx) / cellM) + 1);
    H = Math.max(1, Math.ceil(((maxLat - minLat) * g.ky) / cellM) + 1);
    if (W * H <= 4e6) break;
    cellM *= 1.5;
  }
  Object.assign(g, { cellM, W, H, gMinLat: minLat, gMinLon: minLon });
  const cellOf = (lat, lon) => {
    const x = Math.min(W - 1, Math.max(0, Math.floor(((lon - minLon) * g.kx) / cellM)));
    const y = Math.min(H - 1, Math.max(0, Math.floor(((lat - minLat) * g.ky) / cellM)));
    return [x, y];
  };
  const count = new Uint32Array(W * H + 1);
  const visit = (e, fn) => {
    let pLat = g.vLat[g.eFrom[e]] / 1e6, pLon = g.vLon[g.eFrom[e]] / 1e6;
    const n = g.eCnt[e];
    for (let k = 0; k <= n; k++) {
      const qLat = k < n ? g.sLat[g.eOff[e] + k] / 1e6 : g.vLat[g.eTo[e]] / 1e6;
      const qLon = k < n ? g.sLon[g.eOff[e] + k] / 1e6 : g.vLon[g.eTo[e]] / 1e6;
      const [x0, y0] = cellOf(Math.min(pLat, qLat), Math.min(pLon, qLon));
      const [x1, y1] = cellOf(Math.max(pLat, qLat), Math.max(pLon, qLon));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn(y * W + x);
      pLat = qLat; pLon = qLon;
    }
  };
  const last = new Int32Array(W * H).fill(-1);
  for (let e = 0; e < nE; e++) visit(e, (c) => { if (last[c] !== e) { last[c] = e; count[c + 1]++; } });
  for (let c = 0; c < W * H; c++) count[c + 1] += count[c];
  g.gridOff = count;
  g.grid = new Uint32Array(count[W * H]);
  const pos = count.slice(0, W * H);
  last.fill(-1);
  for (let e = 0; e < nE; e++) visit(e, (c) => { if (last[c] !== e) { last[c] = e; g.grid[pos[c]++] = e; } });
  g.cellOf = cellOf;

  // Рабочие массивы поиска (один поиск за раз — в отдельном потоке).
  g.dist = new Float64Array(nV);
  g.prev = new Int32Array(nV);
  g.seen = new Uint32Array(nV);
  g.done = new Uint32Array(nV);
  g.stamp = 0;
  return g;
}

/* ------------------------ поиск маршрута ------------------------ */

function allowed(flags, mode, dir) {
  if (mode === "foot") return (flags & F_FOOT) !== 0;
  if (mode === "bike") return (flags & (dir === 0 ? F_BIKE_FWD : F_BIKE_BACK)) !== 0;
  return (flags & (dir === 0 ? F_AUTO_FWD : F_AUTO_BACK)) !== 0;
}
function edgeAnyAllowed(g, e, mode) {
  return SPEED_MS[mode][g.eCls[e]] > 0 && (allowed(g.eFlags[e], mode, 0) || allowed(g.eFlags[e], mode, 1));
}
function edgeCost(g, e, mode, meters) {
  const v = SPEED_MS[mode][g.eCls[e]];
  if (!(v > 0)) return Infinity;
  const pen = mode !== "foot" && (g.eFlags[e] & F_PRIVATE) ? PRIVATE_PENALTY : 1;
  return (meters / v) * pen;
}

/** Точки ребра от from к to: [[lat, lon], ...]. */
function edgeCoords(g, e) {
  const pts = [[g.vLat[g.eFrom[e]] / 1e6, g.vLon[g.eFrom[e]] / 1e6]];
  for (let k = 0; k < g.eCnt[e]; k++) pts.push([g.sLat[g.eOff[e] + k] / 1e6, g.sLon[g.eOff[e] + k] / 1e6]);
  pts.push([g.vLat[g.eTo[e]] / 1e6, g.vLon[g.eTo[e]] / 1e6]);
  return pts;
}

/** Ближайшая к точке дорога, по которой можно в этом режиме. */
function snap(g, lat, lon, mode, maxM = 1500) {
  const [cx, cy] = g.cellOf(lat, lon);
  let best = null;
  const seen = new Set();
  const rings = Math.ceil(maxM / g.cellM) + 1;
  for (let r = 0; r <= rings; r++) {
    for (let y = cy - r; y <= cy + r; y++) {
      if (y < 0 || y >= g.H) continue;
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= g.W || (Math.abs(x - cx) !== r && Math.abs(y - cy) !== r)) continue;
        const c = y * g.W + x;
        for (let i = g.gridOff[c]; i < g.gridOff[c + 1]; i++) {
          const e = g.grid[i];
          if (seen.has(e)) continue;
          seen.add(e);
          if (!edgeAnyAllowed(g, e, mode)) continue;
          const pts = edgeCoords(g, e);
          let along = 0;
          for (let k = 0; k + 1 < pts.length; k++) {
            const ax = (pts[k][1] - lon) * g.kx, ay = (pts[k][0] - lat) * g.ky;
            const bx = (pts[k + 1][1] - lon) * g.kx, by = (pts[k + 1][0] - lat) * g.ky;
            const dx = bx - ax, dy = by - ay;
            const L2 = dx * dx + dy * dy;
            const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
            const px = ax + t * dx, py = ay + t * dy;
            const d = Math.hypot(px, py);
            const segLen = Math.sqrt(L2);
            if (!best || d < best.d) {
              best = { e, k, t, d, along: along + t * segLen, lat: lat + py / g.ky, lon: lon + px / g.kx };
            }
            along += segLen;
          }
          // Длина ребра по сетке может чуть отличаться от точной — приводим к ней.
          if (best && best.e === e && along > 0) best.scale = g.eLen[e] / along;
        }
      }
    }
    if (best && best.d <= r * g.cellM) break;
  }
  if (!best || best.d > maxM) return null;
  best.along *= best.scale || 1;
  return best;
}

/** Часть линии ребра между отметками (в метрах от from). */
function slice(g, e, a, b) {
  const pts = edgeCoords(g, e);
  const lens = [0];
  for (let k = 1; k < pts.length; k++) lens.push(lens[k - 1] + haversine(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]));
  const total = lens[lens.length - 1] || 1;
  const scale = total / (g.eLen[e] || total);
  const lo = Math.min(a, b) * scale, hi = Math.max(a, b) * scale;
  const at = (m) => {
    for (let k = 1; k < pts.length; k++) {
      if (lens[k] >= m) {
        const t = lens[k] - lens[k - 1] > 0 ? (m - lens[k - 1]) / (lens[k] - lens[k - 1]) : 0;
        return [pts[k - 1][0] + t * (pts[k][0] - pts[k - 1][0]), pts[k - 1][1] + t * (pts[k][1] - pts[k - 1][1])];
      }
    }
    return pts[pts.length - 1];
  };
  const out = [at(lo)];
  for (let k = 1; k < pts.length - 1; k++) if (lens[k] > lo && lens[k] < hi) out.push(pts[k]);
  out.push(at(hi));
  return a <= b ? out : out.reverse();
}

/* Двоичная куча (минимум) по ключу. */
class Heap {
  constructor() { this.k = new Float64Array(1024); this.v = new Int32Array(1024); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0];
    const key = this.k[--this.n];
    const val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
  get topKey() { return this.k[0]; }
}

/** Маршрут между двумя привязанными точками: {cost, meters, line} или null. */
function search(g, s, t, mode, { maxSettled = 3e6 } = {}) {
  const tLat = t.lat, tLon = t.lon;
  const vmax = VMAX[mode];
  const h = (v) => haversine(g.vLat[v] / 1e6, g.vLon[v] / 1e6, tLat, tLon) / vmax;
  g.stamp = (g.stamp + 1) >>> 0;
  if (g.stamp === 0) { g.seen.fill(0); g.done.fill(0); g.stamp = 1; }
  const st = g.stamp;
  const heap = new Heap();
  const relax = (v, d, prevCode) => {
    if (g.seen[v] === st && g.dist[v] <= d) return;
    g.seen[v] = st; g.dist[v] = d; g.prev[v] = prevCode;
    heap.push(d + h(v), v);
  };
  const se = s.e, te = t.e;
  const sLen = g.eLen[se], tLen = g.eLen[te];
  // Старт: от точки на ребре к его концам (−1 / −2 — признак старта).
  if (allowed(g.eFlags[se], mode, 0)) relax(g.eTo[se], edgeCost(g, se, mode, sLen - s.along), -1);
  if (allowed(g.eFlags[se], mode, 1)) relax(g.eFrom[se], edgeCost(g, se, mode, s.along), -2);
  // Финиш: с концов ребра к точке.
  const tailFrom = allowed(g.eFlags[te], mode, 0) ? edgeCost(g, te, mode, t.along) : Infinity; // from → точка
  const tailTo = allowed(g.eFlags[te], mode, 1) ? edgeCost(g, te, mode, tLen - t.along) : Infinity; // to → точка
  let best = Infinity, bestEnd = -1, bestViaFrom = false, direct = false;
  if (se === te) {
    const fwd = t.along >= s.along && allowed(g.eFlags[se], mode, 0);
    const back = t.along <= s.along && allowed(g.eFlags[se], mode, 1);
    if (fwd || back) { best = edgeCost(g, se, mode, Math.abs(t.along - s.along)); direct = true; }
  }
  let settled = 0;
  while (heap.n > 0) {
    if (heap.topKey >= best) break;
    const v = heap.pop();
    if (g.done[v] === st) continue;
    g.done[v] = st;
    if (++settled > maxSettled) break;
    const dv = g.dist[v];
    if (v === g.eFrom[te] && dv + tailFrom < best) { best = dv + tailFrom; bestEnd = v; bestViaFrom = true; direct = false; }
    if (v === g.eTo[te] && dv + tailTo < best) { best = dv + tailTo; bestEnd = v; bestViaFrom = false; direct = false; }
    for (let i = g.adjOff[v]; i < g.adjOff[v + 1]; i++) {
      const code = g.adj[i];
      const e = code >>> 1, dir = code & 1; // dir 0: v = from → to
      if (!allowed(g.eFlags[e], mode, dir)) continue;
      const w = dir === 0 ? g.eTo[e] : g.eFrom[e];
      if (g.done[w] === st) continue;
      const c = edgeCost(g, e, mode, g.eLen[e]);
      if (c === Infinity) continue;
      relax(w, dv + c, code);
    }
  }
  if (best === Infinity) return null;

  const line = [];
  let meters = 0;
  const pushPts = (pts) => { for (const p of pts) { const q = line[line.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) line.push(p); } };
  if (direct) {
    pushPts([[s.lat, s.lon], ...slice(g, se, s.along, t.along), [t.lat, t.lon]]);
    meters = Math.abs(t.along - s.along);
    return { cost: best, meters, line };
  }
  // Путь назад от конца к старту.
  const chain = [];
  let v = bestEnd;
  for (;;) {
    const code = g.prev[v];
    if (code < 0) { chain.push(code); break; }
    chain.push(code);
    const e = code >>> 1, dir = code & 1;
    v = dir === 0 ? g.eFrom[e] : g.eTo[e];
  }
  chain.reverse();
  pushPts([[s.lat, s.lon]]);
  const startCode = chain[0];
  if (startCode === -1) { pushPts(slice(g, se, s.along, sLen)); meters += sLen - s.along; } else { pushPts(slice(g, se, s.along, 0)); meters += s.along; }
  for (let i = 1; i < chain.length; i++) {
    const e = chain[i] >>> 1, dir = chain[i] & 1;
    const pts = edgeCoords(g, e);
    pushPts(dir === 0 ? pts : pts.reverse());
    meters += g.eLen[e];
  }
  if (bestViaFrom) {
    pushPts(slice(g, te, 0, t.along)); meters += t.along;
  } else {
    pushPts(slice(g, te, tLen, t.along)); meters += tLen - t.along;
  }
  pushPts([[t.lat, t.lon]]);
  return { cost: best, meters, line };
}

/** Упрощение линии (Дуглас — Пекер), допуск в метрах. */
function simplify(line, tolM, kx, ky) {
  if (line.length <= 2) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    const ax = line[a][1] * kx, ay = line[a][0] * ky, bx = line[b][1] * kx, by = line[b][0] * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const px = line[i][1] * kx, py = line[i][0] * ky;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > md) { md = d; mi = i; }
    }
    if (md > tolM && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return line.filter((_, i) => keep[i]);
}

/**
 * Маршрут через точки [{lat, lng}, ...]. Ответ: {ok, m, s, line:[[lat, lng]]}
 * или {ok:false, reason}.
 */
function route(g, points, mode = "auto") {
  if (!MODES.includes(mode)) mode = "auto";
  const snaps = [];
  for (const p of points) {
    const sp = snap(g, p.lat, p.lng, mode);
    if (!sp) return { ok: false, reason: "far" };
    snaps.push(sp);
  }
  let m = 0, s = 0;
  const line = [];
  const legs = [];
  for (let i = 0; i + 1 < snaps.length; i++) {
    const r = search(g, snaps[i], snaps[i + 1], mode);
    if (!r) return { ok: false, reason: "noroute" };
    m += r.meters; s += r.cost;
    legs.push({ m: Math.round(r.meters), s: Math.round(r.cost) });
    for (const p of r.line) { const q = line[line.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) line.push(p); }
  }
  const simple = simplify(line, 2.5, g.kx, g.ky).map(([la, lo]) => [Math.round(la * 1e6) / 1e6, Math.round(lo * 1e6) / 1e6]);
  return { ok: true, mode, m: Math.round(m), s: Math.round(s), legs, line: simple };
}

function contains(g, lat, lng, padDeg = 0.02) {
  const [a, b, c, d] = g.bounds;
  return lat >= a - padDeg && lat <= c + padDeg && lng >= b - padDeg && lng <= d + padDeg;
}

module.exports = {
  buildGraph, encodeGraph, loadGraph, route, snap, contains, parseWayLine, wayFlags, haversine, simplify,
  CLASSES, MODES, F_AUTO_FWD, F_AUTO_BACK, F_BIKE_FWD, F_BIKE_BACK, F_FOOT, F_PRIVATE,
};

/* Командная строка: node map-graph.js build <roads.opl> <out.graph> */
if (require.main === module) {
  const [cmd, input, output] = process.argv.slice(2);
  if (cmd !== "build" || !input || !output) {
    console.error("Использование: node map-graph.js build <roads.opl> <out.graph>");
    process.exit(2);
  }
  const fs = require("fs");
  const readline = require("readline");
  const readLines = (cb) => new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
    rl.on("line", cb);
    rl.on("close", resolve);
    rl.on("error", reject);
  });
  buildGraph(readLines, { log: (s) => console.log(s) })
    .then((g) => {
      if (!g.eFrom.length) throw new Error("в выгрузке нет дорог");
      const tmp = `${output}.tmp`;
      fs.writeFileSync(tmp, encodeGraph(g));
      fs.renameSync(tmp, output);
      console.log(`готово: ${output} (${(fs.statSync(output).size / 1048576).toFixed(1)} МБ)`);
    })
    .catch((e) => { console.error(`ошибка: ${e.message}`); process.exit(1); });
}
