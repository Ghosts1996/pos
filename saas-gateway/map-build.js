"use strict";
/**
 * Сборка своей карты на сервере (таймер zalpos-map, раз в сутки; работа
 * идёт, только если что-то поменялось):
 *
 *   1. Районы — вокруг каждой точки заведения (state/map-regions.json пишет
 *      шлюз) и демо в Москве; близкие районы сливаются.
 *   2. Тайлы — вырезка из свежей сборки Protomaps (данные OpenStreetMap)
 *      только по нашим районам: pmtiles extract → tiles.pmtiles.
 *   3. Дороги — выгрузка OpenStreetMap федерального округа (Geofabrik) →
 *      osmium (вырезать район, оставить дороги) → граф roads-<район>.graph.
 *
 * Тяжёлые шаги — с пониженным приоритетом и пределом памяти (systemd-run),
 * чтобы касса, кабинет и база не замедлялись. Скачанные выгрузки удаляются.
 * Готовые файлы подменяются целиком: шлюз подхватывает их сам.
 *
 *   node map-build.js [--force] [--only=tiles|roads] [--dry-run]
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DIR = process.env.MAP_DIR || "/opt/zalpos-maps";
const REGIONS_FILE = process.env.MAP_REGIONS_FILE || "/opt/saas-gateway/state/map-regions.json";
const RADIUS_KM = Number(process.env.MAP_RADIUS_KM) || 25;
const MAXZOOM = Number(process.env.MAP_MAXZOOM) || 15;
const TILES_MAX_DAYS = 30;
const ROADS_MAX_DAYS = 14;
const MEMORY_MAX = process.env.MAP_MEMORY_MAX || "900M";
const PMTILES_VERSION = "1.31.2";
const PMTILES_SHA256 = "3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f";
const PMTILES_URL = `https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz`;
const BUILDS_URL = "https://build-metadata.protomaps.dev/builds.json";
const BUILD_BASE = "https://build.protomaps.com/";
const GEOFABRIK = "https://download.geofabrik.de/russia/";
// Федеральные округа (имена файлов Geofabrik).
const DISTRICTS = [
  "central-fed-district", "northwestern-fed-district", "volga-fed-district", "south-fed-district",
  "north-caucasus-fed-district", "ural-fed-district", "siberian-fed-district", "far-eastern-fed-district",
  "crimean-fed-district", "kaliningrad",
];
// Демо всегда в Москве.
const DEMO_POINTS = [[55.7579, 37.6108], [55.7507, 37.5439]];

const log = (s) => console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} ${s}`);

/* ------------------------------ районы ------------------------------ */

/** Квадрат ±radiusKm вокруг точки: [запад, юг, восток, север]. */
function boxAround(lat, lng, radiusKm) {
  const dLat = radiusKm / 111.2;
  const dLng = radiusKm / (111.2 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}
const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const round3 = (v) => Math.round(v * 1000) / 1000;

/** Точки → слитые районы [{id, bbox, center}]. */
function clusterRegions(points, radiusKm = RADIUS_KM) {
  let boxes = points.map(([lat, lng]) => boxAround(lat, lng, radiusKm));
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (overlaps(boxes[i], boxes[j])) {
          boxes[i] = union(boxes[i], boxes[j]);
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return boxes
    .map((b) => {
      const bbox = b.map(round3);
      const center = [round3((bbox[1] + bbox[3]) / 2), round3((bbox[0] + bbox[2]) / 2)];
      const id = `${Math.round(center[0] * 100)}-${Math.round(center[1] * 100)}`.replace(/[^0-9-]/g, "");
      return { id, bbox, center };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function readPoints(file = REGIONS_FILE) {
  let pts = [];
  try { pts = JSON.parse(fs.readFileSync(file, "utf8")).points || []; } catch (_) {}
  pts = pts.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return [...DEMO_POINTS, ...pts];
}

function regionsGeoJson(regions) {
  return {
    type: "MultiPolygon",
    coordinates: regions.map(({ bbox: [w, s, e, n] }) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]]),
  };
}

/* ------------------------- файлы .poly (Geofabrik) ------------------------- */

/** Текст .poly → [{hole, ring:[[lng, lat]]}]. */
function parsePoly(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const rings = [];
  let cur = null;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (l === "END") {
      if (cur) { rings.push(cur); cur = null; continue; }
      break;
    }
    if (!cur) { cur = { hole: l.startsWith("!"), ring: [] }; continue; }
    const [x, y] = l.split(/\s+/).map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) cur.ring.push([x, y]);
  }
  return rings;
}

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPoly(rings, lat, lng) {
  let inside = false;
  for (const r of rings) if (inRing(r.ring, lng, lat)) inside = !r.hole;
  return inside;
}

/* ------------------------------ команды ------------------------------ */

function run(cmd, args, { heavy = false, allowFail = false, timeoutMs = 3 * 3600 * 1000 } = {}) {
  let c = cmd, a = args;
  if (heavy) {
    // Предел памяти и низкий приоритет: превысит — остановится только эта команда.
    const sd = spawnSync("sh", ["-c", "command -v systemd-run"], { encoding: "utf8" });
    const nice = ["nice", "-n", "15", "ionice", "-c", "3"];
    if (process.getuid && process.getuid() === 0 && sd.status === 0) {
      a = ["--scope", "--quiet", "-p", `MemoryMax=${MEMORY_MAX}`, "-p", "MemorySwapMax=0", ...nice, cmd, ...args];
      c = "systemd-run";
    } else {
      a = [...nice.slice(1), cmd, ...args];
      c = nice[0];
    }
  }
  const r = spawnSync(c, a, { stdio: ["ignore", "inherit", "inherit"], timeout: timeoutMs });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")}… — код ${r.status}${r.error ? `, ${r.error.message}` : ""}`);
  return r.status === 0;
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 600000, maxBuffer: 32 << 20 });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}` };
}

function freeMb(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Math.floor((s.bavail * s.bsize) / 1048576);
  } catch (_) {
    const r = capture("df", ["-Pm", dir]);
    const m = /\n\S+\s+\d+\s+\d+\s+(\d+)/.exec(r.out);
    return m ? Number(m[1]) : 0;
  }
}

function download(url, file, { minBytes = 1 } = {}) {
  const tmp = `${file}.part`;
  run("curl", ["-fsSL", "--retry", "3", "--retry-delay", "10", "--connect-timeout", "30", "-C", "-", "-o", tmp, url]);
  if (fs.statSync(tmp).size < minBytes) throw new Error(`${url}: файл слишком мал`);
  fs.renameSync(tmp, file);
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const writeJson = (f, v) => { fs.writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 1)); fs.renameSync(`${f}.tmp`, f); };
const daysSince = (iso) => (Date.now() - Date.parse(iso || 0)) / 86400000;

/* ------------------------------ инструменты ------------------------------ */

function ensurePmtiles() {
  const bin = path.join(DIR, "bin", "pmtiles");
  if (fs.existsSync(bin) && capture(bin, ["version"]).out.includes(PMTILES_VERSION)) return bin;
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const tgz = path.join(DIR, "bin", "pmtiles.tgz");
  log(`качаю pmtiles ${PMTILES_VERSION}`);
  download(PMTILES_URL, tgz, { minBytes: 1 << 20 });
  const sum = crypto.createHash("sha256").update(fs.readFileSync(tgz)).digest("hex");
  if (sum !== PMTILES_SHA256) { fs.unlinkSync(tgz); throw new Error("pmtiles: контрольная сумма не совпала — файл не принят"); }
  run("tar", ["-xzf", tgz, "-C", path.dirname(bin), "pmtiles"]);
  fs.unlinkSync(tgz);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function ensureOsmium() {
  if (capture("sh", ["-c", "command -v osmium"]).ok) return "osmium";
  log("ставлю osmium-tool");
  run("apt-get", ["install", "-y", "-q", "--no-install-recommends", "osmium-tool"], { allowFail: true });
  if (!capture("sh", ["-c", "command -v osmium"]).ok) throw new Error("osmium-tool не установился");
  return "osmium";
}

/* ------------------------------ тайлы ------------------------------ */

function latestBuild() {
  const r = capture("curl", ["-fsSL", "--retry", "2", "--connect-timeout", "20", BUILDS_URL]);
  const keys = r.ok ? [...new Set(r.out.match(/\b\d{8}\.pmtiles\b/g) || [])].sort() : [];
  if (keys.length) return keys[keys.length - 1];
  // Запасной путь: ищем по датам назад.
  for (let d = 0; d < 10; d++) {
    const key = `${new Date(Date.now() - d * 86400000).toISOString().slice(0, 10).replace(/-/g, "")}.pmtiles`;
    if (capture("curl", ["-fsSI", "--connect-timeout", "20", BUILD_BASE + key]).ok) return key;
  }
  throw new Error("не нашёл свежую сборку тайлов Protomaps");
}

function buildTiles(regions, { force, dryRun }) {
  const metaFile = path.join(DIR, "tiles.json");
  const meta = readJson(metaFile, {});
  const key = crypto.createHash("sha1").update(JSON.stringify({ r: regions.map((r) => r.bbox), z: MAXZOOM })).digest("hex").slice(0, 12);
  const out = path.join(DIR, "tiles.pmtiles");
  if (!force && meta.key === key && fs.existsSync(out) && daysSince(meta.at) < TILES_MAX_DAYS) {
    log(`тайлы: без изменений (сборка ${meta.build}, ${daysSince(meta.at).toFixed(0)} дн.)`);
    return { skipped: true, ...meta };
  }
  const bin = ensurePmtiles();
  const build = latestBuild();
  const regionFile = path.join(DIR, "regions.geojson");
  writeJson(regionFile, regionsGeoJson(regions));
  let maxzoom = MAXZOOM;
  // Оценка размера заранее: места должно хватить с запасом 2 ГБ.
  for (;;) {
    const est = capture(bin, ["extract", BUILD_BASE + build, path.join(DIR, "dry.pmtiles"), `--region=${regionFile}`, `--maxzoom=${maxzoom}`, "--dry-run"]);
    const m = /archive size of ([\d.]+) ([KMGT]?B)/.exec(est.out);
    const mb = m ? Number(m[1]) * ({ B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024, TB: 1048576 }[m[2]] || 1) : NaN;
    log(`тайлы: сборка ${build}, масштаб до ${maxzoom}, размер ≈ ${Number.isFinite(mb) ? mb.toFixed(0) : "?"} МБ, свободно ${freeMb(DIR)} МБ`);
    if (!est.ok) throw new Error(`pmtiles: оценка не удалась — ${est.out.slice(-300)}`);
    if (Number.isFinite(mb) && mb + 2048 > freeMb(DIR)) {
      if (maxzoom > 13) { maxzoom--; continue; }
      throw new Error("тайлы: мало места на диске");
    }
    break;
  }
  if (dryRun) return { dryRun: true, build, maxzoom };
  const tmp = path.join(DIR, "tiles.pmtiles.new");
  try { fs.unlinkSync(tmp); } catch (_) {}
  run(bin, ["extract", BUILD_BASE + build, tmp, `--region=${regionFile}`, `--maxzoom=${maxzoom}`, "--download-threads=4", "--quiet"], { heavy: true });
  // Проверка: файл читается и тайлы векторные.
  const { openPmtiles } = require("./map-tiles");
  const p = openPmtiles(tmp);
  const ok = p.header.tileType === 1 && p.header.maxZoom >= 12;
  p.close();
  if (!ok) { fs.unlinkSync(tmp); throw new Error("тайлы: собранный файл не подходит"); }
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, out);
  const res = { key, build, maxzoom, at: new Date().toISOString(), bytes: fs.statSync(out).size };
  writeJson(metaFile, res);
  log(`тайлы: готово, ${(res.bytes / 1048576).toFixed(0)} МБ`);
  return res;
}

/* ------------------------------ дороги ------------------------------ */

function districtOf(region) {
  const polyDir = path.join(DIR, "geofabrik");
  fs.mkdirSync(polyDir, { recursive: true });
  for (const d of DISTRICTS) {
    const f = path.join(polyDir, `${d}.poly`);
    let st = null;
    try { st = fs.statSync(f); } catch (_) {}
    if (!st || Date.now() - st.mtimeMs > 30 * 86400000) {
      try { download(`${GEOFABRIK}${d}.poly`, f, { minBytes: 100 }); } catch (e) { if (!st) { log(`!! ${d}.poly: ${e.message}`); continue; } }
    }
    if (inPoly(parsePoly(fs.readFileSync(f, "utf8")), region.center[0], region.center[1])) return d;
  }
  return null;
}

function buildRoads(regions, { force, dryRun }) {
  const metaFile = path.join(DIR, "roads.json");
  const meta = readJson(metaFile, {});
  const todo = regions.filter((r) => {
    const m = meta[r.id];
    const file = path.join(DIR, `roads-${r.id}.graph`);
    return force || !m || JSON.stringify(m.bbox) !== JSON.stringify(r.bbox) || !fs.existsSync(file) || daysSince(m.at) > ROADS_MAX_DAYS;
  });
  // Графы районов, которых больше нет, — убрать.
  const keep = new Set(regions.map((r) => `roads-${r.id}.graph`));
  for (const f of fs.readdirSync(DIR)) {
    if (/^roads-[0-9-]+\.graph$/.test(f) && !keep.has(f) && !dryRun) { fs.unlinkSync(path.join(DIR, f)); delete meta[f.slice(6, -6)]; log(`дороги: убрал ${f}`); }
  }
  if (!todo.length) { log("дороги: без изменений"); if (!dryRun) writeJson(metaFile, meta); return { skipped: true }; }
  const byDistrict = new Map();
  for (const r of todo) {
    const d = districtOf(r);
    if (!d) { log(`!! дороги: район ${r.id} вне России — пропускаю`); continue; }
    if (!byDistrict.has(d)) byDistrict.set(d, []);
    byDistrict.get(d).push(r);
  }
  if (dryRun) return { dryRun: true, plan: [...byDistrict].map(([d, rs]) => ({ district: d, regions: rs.map((r) => r.id) })) };
  const osmium = ensureOsmium();
  const work = path.join(DIR, "work");
  fs.mkdirSync(work, { recursive: true });
  const done = [];
  for (const [d, list] of byDistrict) {
    const pbf = path.join(work, `${d}.osm.pbf`);
    if (freeMb(DIR) < 4096) throw new Error(`дороги: мало места (${freeMb(DIR)} МБ) для выгрузки ${d}`);
    log(`дороги: качаю ${d}`);
    download(`${GEOFABRIK}${d}-latest.osm.pbf`, pbf, { minBytes: 1 << 20 });
    try {
      for (const r of list) {
        const cut = path.join(work, `cut-${r.id}.osm.pbf`);
        const roads = path.join(work, `roads-${r.id}.osm.pbf`);
        const opl = path.join(work, `roads-${r.id}.opl`);
        run(osmium, ["extract", "-b", r.bbox.join(","), "-s", "simple", "--overwrite", "-o", cut, pbf], { heavy: true });
        run(osmium, ["tags-filter", "--overwrite", "-o", roads, cut, "w/highway"], { heavy: true });
        fs.unlinkSync(cut);
        run(osmium, ["add-locations-to-ways", "--overwrite", "-f", "opl,add_metadata=false", "-o", opl, roads], { heavy: true });
        fs.unlinkSync(roads);
        const out = path.join(DIR, `roads-${r.id}.graph`);
        run(process.execPath, ["--max-old-space-size=640", path.join(__dirname, "map-graph.js"), "build", opl, out], { heavy: true });
        fs.unlinkSync(opl);
        fs.chmodSync(out, 0o644);
        meta[r.id] = { bbox: r.bbox, district: d, at: new Date().toISOString(), bytes: fs.statSync(out).size };
        writeJson(metaFile, meta);
        done.push(r.id);
        log(`дороги: район ${r.id} готов`);
      }
    } finally {
      try { fs.unlinkSync(pbf); } catch (_) {}
    }
  }
  return { done };
}

/* ------------------------------ запуск ------------------------------ */

function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const only = (args.find((a) => a.startsWith("--only=")) || "").slice(7);
  fs.mkdirSync(DIR, { recursive: true, mode: 0o755 });
  const lock = path.join(DIR, ".build.lock");
  try {
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); log(`уже идёт сборка (процесс ${pid})`); return 0; } catch (_) { /* старый замок */ }
    }
  } catch (_) {}
  fs.writeFileSync(lock, String(process.pid));
  const status = { startedAt: new Date().toISOString(), errors: [] };
  try {
    const regions = clusterRegions(readPoints());
    status.regions = regions;
    log(`районов: ${regions.length} (${regions.map((r) => r.id).join(", ")})`);
    if (only !== "roads") {
      try { status.tiles = buildTiles(regions, { force, dryRun }); } catch (e) { status.errors.push(`тайлы: ${e.message}`); log(`!! ${e.message}`); }
    }
    if (only !== "tiles") {
      try { status.roads = buildRoads(regions, { force, dryRun }); } catch (e) { status.errors.push(`дороги: ${e.message}`); log(`!! ${e.message}`); }
    }
  } finally {
    status.finishedAt = new Date().toISOString();
    status.ok = status.errors.length === 0;
    if (!dryRun) writeJson(path.join(DIR, "status.json"), status);
    try { fs.unlinkSync(lock); } catch (_) {}
  }
  log(status.ok ? "карта: готово" : `карта: есть ошибки (${status.errors.length})`);
  return status.ok ? 0 : 1;
}

module.exports = { clusterRegions, boxAround, parsePoly, inPoly, regionsGeoJson, readPoints, DEMO_POINTS };

if (require.main === module) process.exit(main());
