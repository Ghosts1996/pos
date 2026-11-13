"use strict";
/**
 * Районы городов для доставки — из административных границ OpenStreetMap
 * (boundary=administrative), без чужих сервисов.
 *
 * Сборка (map-build.js, раз в месяц вместе с дорогами):
 *   osmconvert -b=район --complete-boundaries → osmfilter boundary=administrative
 *   → osmium export (geojson) → `node map-districts.js build in.geojson out.json`
 *   → districts-<район>.json: все границы уровней 4…10 района с упрощёнными
 *   контурами, площадью и точкой внутри.
 *
 * Запрос (map.js → /map/districts?lat=&lng=): районы вокруг точки заведения.
 * Иерархию делит само: регион → районы/округа → (если район большой) его
 * поселения или муниципальные округа. Так у Петербурга — 18 районов, у
 * Владикавказа — 4 района города и сельские поселения вокруг, у Москвы —
 * округа и районы. Районы не перекрываются: каждая точка попадает в один.
 *
 * Контуры: [[[lng, lat], …], …] — внешние кольца и дыры одним списком,
 * точка внутри по правилу «чётное-нечётное» (как в GeoJSON).
 */

const fs = require("fs");

/** Район больше этого — делим на его части (поселения, муниципальные округа), км². */
const SPLIT_KM2 = 120;
/** Части покрывают родителя не меньше чем на столько — иначе делить нельзя
 *  (частичные «микрорайоны» уровня 10 не должны заменить целый район). */
const COVER = 0.4; // у Петербурга и приморских городов в границы входит вода — районы её не покрывают
const MIN_KM2 = 0.05;
const KM_PER_DEG = 111.2;

/* ------------------------------ геометрия ------------------------------ */

function ringArea(ring) {
  // Площадь кольца, км² (равнопромежуточно по широте кольца — для районов хватает).
  let s = 0;
  let lat0 = 0;
  for (const p of ring) lat0 += p[1];
  lat0 /= ring.length || 1;
  const kx = KM_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] * kx) * (ring[i][1] * KM_PER_DEG) - (ring[i][0] * kx) * (ring[j][1] * KM_PER_DEG);
  }
  return s / 2;
}

/** Площадь контура: внешние кольца минус дыры (знак кольца у GeoJSON не надёжен — берём по вложенности). */
function polyArea(rings) {
  let s = 0;
  for (const r of rings) {
    const a = Math.abs(ringArea(r));
    const inside = rings.some((o) => o !== r && Math.abs(ringArea(o)) > a && inRing(o, r[0][0], r[0][1]));
    s += inside ? -a : a;
  }
  return Math.max(0, s);
}

function inRing(ring, x, y) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Точка внутри контура (чётное-нечётное по всем кольцам). */
function contains(rings, lat, lng) {
  if (!Array.isArray(rings)) return false;
  let c = false;
  for (const r of rings) if (Array.isArray(r) && r.length >= 4 && inRing(r, lng, lat)) c = !c;
  return c;
}

function bboxOf(rings) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) for (const p of r) {
    if (p[0] < b[0]) b[0] = p[0];
    if (p[1] < b[1]) b[1] = p[1];
    if (p[0] > b[2]) b[2] = p[0];
    if (p[1] > b[3]) b[3] = p[1];
  }
  return b;
}

/**
 * Точка заведомо внутри: центр рамки, если он внутри; иначе середина самого
 * широкого отрезка внутри контура на горизонтали через центр (и рядом).
 */
function innerPoint(rings, b = bboxOf(rings)) {
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  if (contains(rings, cy, cx)) return [cx, cy];
  for (const f of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
    const y = b[1] + (b[3] - b[1]) * f;
    const xs = [];
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const yi = r[i][1], yj = r[j][1];
      if ((yi > y) !== (yj > y)) xs.push(r[i][0] + ((r[j][0] - r[i][0]) * (y - yi)) / (yj - yi));
    }
    xs.sort((a, c) => a - c);
    let best = null;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      if (!best || w > best.w) best = { w, x: (xs[i] + xs[i + 1]) / 2 };
    }
    if (best && contains(rings, y, best.x)) return [best.x, y];
  }
  return [cx, cy];
}

/** Упрощение линии (Дуглас — Пекер), допуск в градусах. */
function simplifyRing(ring, tol) {
  if (ring.length <= 8) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a];
    const [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1, fd = t2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      let d2;
      if (!len2) d2 = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > fd) { fd = d2; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring.slice(0, 4);
}

const round5 = (v) => Math.round(v * 1e5) / 1e5;

/** Контуры GeoJSON (Polygon/MultiPolygon) → список колец, упрощённых, с округлёнными координатами. */
function ringsOf(geometry, tol) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  const rings = [];
  for (const poly of polys) for (const r of poly) {
    if (!Array.isArray(r) || r.length < 4) continue;
    const s = simplifyRing(r, tol).map((p) => [round5(p[0]), round5(p[1])]);
    if (s.length >= 4) rings.push(s);
  }
  return rings;
}

/**
 * Для хранения в настройках доставки (их читает каждый заказ): ещё проще —
 * не больше maxPoints точек на весь район.
 */
function compactRings(rings, maxPoints = 400) {
  let tol = 0.0002;
  let out = rings;
  for (let k = 0; k < 8; k++) {
    out = rings.map((r) => simplifyRing(r, tol)).filter((r) => r.length >= 4);
    // Мелкие острова и дыры (меньше 0,02 км²) — не нужны для цены доставки.
    out = out.filter((r) => Math.abs(ringArea(r)) >= 0.02 || out.length === 1);
    const n = out.reduce((a, r) => a + r.length, 0);
    if (n <= maxPoints) break;
    tol *= 1.8;
  }
  return out.map((r) => r.map((p) => [round5(p[0]), round5(p[1])]));
}

/* ------------------------------ сборка ------------------------------ */

/**
 * GeoJSON от `osmium export -a type,id` → { v, list: [{ id, n, l, a, b, p, r }] }:
 * id — "r123"/"w123", n — название, l — admin_level, a — площадь км²,
 * b — рамка, p — точка внутри, r — контуры (упрощение ~20 м).
 */
function build(geojson, { bbox = null } = {}) {
  const feats = Array.isArray(geojson && geojson.features) ? geojson.features : [];
  const list = [];
  const seen = new Set();
  for (const f of feats) {
    const p = (f && f.properties) || {};
    const g = f && f.geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
    if (p.boundary !== "administrative") continue;
    const l = Number(p.admin_level);
    if (!(l >= 4 && l <= 10)) continue;
    const n = String(p["name:ru"] || p.name || "").trim();
    if (!n) continue;
    const id = `${p["@type"] === "way" ? "w" : "r"}${p["@id"] || list.length}`;
    if (seen.has(id)) continue;
    const rings = ringsOf(g, 0.00018);
    if (!rings.length) continue;
    const b = bboxOf(rings);
    if (bbox && !(b[0] <= bbox[2] && bbox[0] <= b[2] && b[1] <= bbox[3] && bbox[1] <= b[3])) continue;
    const a = polyArea(rings);
    if (a < MIN_KM2) continue;
    seen.add(id);
    list.push({ id, n: n.slice(0, 80), l, a: Math.round(a * 100) / 100, b: b.map(round5), p: innerPoint(rings, b).map(round5), r: rings });
  }
  return { v: 1, at: new Date().toISOString(), list };
}

/* ------------------------------ запрос ------------------------------ */

const bboxHas = (b, x, y) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

/**
 * Части контура P: следующий уровень внутри него, если он покрывает P там,
 * где ищем (рамка поиска): в выгрузку города попадают не все части большого
 * района, а вода у приморских городов в районы не входит — поэтому покрытие
 * считается по сетке точек рядом с заведением, а не по площадям.
 */
function partsOf(P, list, box) {
  const inside = list.filter((c) => c.l > P.l && bboxHas(P.b, c.p[0], c.p[1]) && contains(P.r, c.p[1], c.p[0]));
  if (inside.length < 1) return null;
  const minL = Math.min(...inside.map((c) => c.l));
  const kids = inside.filter((c) => c.l === minL);
  const x0 = Math.max(P.b[0], box[0]), x1 = Math.min(P.b[2], box[2]);
  const y0 = Math.max(P.b[1], box[1]), y1 = Math.min(P.b[3], box[3]);
  if (x0 >= x1 || y0 >= y1) return null;
  const N = 22;
  let inP = 0, covered = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = x0 + ((i + 0.5) * (x1 - x0)) / N;
    const y = y0 + ((j + 0.5) * (y1 - y0)) / N;
    if (!contains(P.r, y, x)) continue;
    inP++;
    if (kids.some((k) => bboxHas(k.b, x, y) && contains(k.r, y, x))) covered++;
  }
  if (inP < 4) return kids.length >= 2 ? { kids, rest: false } : null;
  const share = covered / inP;
  // Части покрывают мало (горы и леса без поселений) — части отдельно и
  // «остальная часть» самого района: цена выберет самый маленький район с точкой.
  if (share >= COVER) return { kids, rest: false };
  return share >= 0.08 && kids.length >= 1 ? { kids, rest: true } : null;
}

/** Расстояние от точки до рамки контура, км (0 — внутри рамки). */
function boxKm(b, lat, lng) {
  const kx = KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const dx = lng < b[0] ? b[0] - lng : lng > b[2] ? lng - b[2] : 0;
  const dy = lat < b[1] ? b[1] - lat : lat > b[3] ? lat - b[3] : 0;
  return Math.hypot(dx * kx, dy * KM_PER_DEG);
}

/**
 * Районы вокруг точки, км: регион → его районы → большие делятся на части
 * (больше SPLIT_KM2). → [{ id, name, level, areaKm2, km, center:[lat,lng], rings, parent }]
 * отсортировано по удалённости, свой район — первым.
 */
function near(data, lat, lng, radiusKm = 30, { max = 120 } = {}) {
  const list = (data && data.list) || [];
  if (!list.length) return [];
  const close = list.filter((d) => boxKm(d.b, lat, lng) <= radiusKm);
  if (!close.length) return [];
  const top = Math.min(...close.map((d) => d.l));
  const dLat = radiusKm / KM_PER_DEG;
  const dLng = radiusKm / (KM_PER_DEG * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const box = [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
  const leaves = [];
  const walk = (P, parent, depth) => {
    if (boxKm(P.b, lat, lng) > radiusKm) return;
    // Делим: регион; большой район; административный округ (Москва) — на районы.
    const split = P.l === top || P.a > SPLIT_KM2 || /административный округ/i.test(P.n);
    const parts = depth < 4 && split ? partsOf(P, list, box) : null;
    if (parts) {
      for (const k of parts.kids) walk(k, P.n, depth + 1);
      if (!parts.rest || P.l === top) return;
      leaves.push({ P, parent, rest: true });
      return;
    }
    if (P.l === top && close.length > 1) return; // целый регион — не район доставки
    leaves.push({ P, parent });
  };
  for (const P of close.filter((d) => d.l === top)) walk(P, "", 0);
  const kx = KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  // Ближайшая точка границы дальше радиуса — район не наш (рамка большого
  // района бывает рядом, а сам он — за десятки км).
  const edgeKm = (P) => {
    let m = Infinity;
    for (const r of P.r) for (const q of r) { const d = Math.hypot((q[0] - lng) * kx, (q[1] - lat) * KM_PER_DEG); if (d < m) m = d; }
    return m;
  };
  const out = leaves.filter(({ P }) => contains(P.r, lat, lng) || edgeKm(P) <= radiusKm).map(({ P, parent, rest }) => {
    // «Здесь» — самый маленький район с точкой (у «остальной части» внутри есть поселения).
    const here = contains(P.r, lat, lng) && !(rest && leaves.some((o) => o.P !== P && o.P.a < P.a && contains(o.P.r, lat, lng)));
    const km = here ? 0 : Math.round(Math.hypot((P.p[0] - lng) * kx, (P.p[1] - lat) * KM_PER_DEG) * 10) / 10;
    return { id: P.id, name: rest ? `${P.n} — остальная часть` : P.n, level: P.l, areaKm2: P.a, km, here, center: [P.p[1], P.p[0]], parent, rest: !!rest, rings: P.r };
  });
  out.sort((a, b) => (b.here - a.here) || a.km - b.km);
  return out.slice(0, max);
}

/**
 * Какой из контуров содержит точку → индекс или -1. Несколько (поселение
 * внутри «остальной части» района) — самый маленький по площади.
 */
function whichContains(polys, lat, lng) {
  let best = -1, bestA = Infinity;
  for (let i = 0; i < polys.length; i++) {
    if (!polys[i] || !contains(polys[i], lat, lng)) continue;
    const a = polyArea(polys[i]);
    if (a < bestA) { bestA = a; best = i; }
  }
  return best;
}

module.exports = { build, near, contains, compactRings, polyArea, innerPoint, simplifyRing, whichContains, bboxOf, SPLIT_KM2 };

if (require.main === module) {
  const [cmd, input, output, bboxArg] = process.argv.slice(2);
  if (cmd !== "build" || !input || !output) {
    console.error("node map-districts.js build in.geojson out.json [minLng,minLat,maxLng,maxLat]");
    process.exit(2);
  }
  const bbox = bboxArg ? bboxArg.split(",").map(Number) : null;
  const data = build(JSON.parse(fs.readFileSync(input, "utf8")), { bbox });
  fs.writeFileSync(`${output}.tmp`, JSON.stringify(data));
  fs.renameSync(`${output}.tmp`, output);
  console.log(`районы: ${data.list.length} границ → ${output}`);
}
