"use strict";
/**
 * Сборка своей карты на сервере (таймер zalpos-map, раз в сутки; работа
 * идёт, только если что-то поменялось):
 *
 *   1. Районы — вокруг каждой точки заведения (state/map-regions.json пишет
 *      шлюз) и демо в Санкт-Петербурге; близкие районы сливаются.
 *   2. Тайлы — вырезка из свежей сборки Protomaps (данные OpenStreetMap)
 *      только по нашим районам: pmtiles extract → tiles.pmtiles.
 *   3. Дороги — выгрузка OpenStreetMap федерального округа (Geofabrik) →
 *      osmconvert/osmfilter (вырезать район, оставить дороги; ~0,5 ГБ памяти) →
 *      osmium add-locations-to-ways → граф roads-<район>.graph.
 *
 * Тяжёлые шаги — с пониженным приоритетом и пределом памяти (systemd-run),
 * чтобы касса, кабинет и база не замедлялись. Скачанные выгрузки удаляются.
 * Готовые файлы подменяются целиком: шлюз подхватывает их сам.
 *
 *   4. Вся Россия — обзорная карта до масштаба 11 (russia.pmtiles): шлюз
 *      отдаёт участок из карты городов, а где её нет — из карты страны.
 *
 *   node map-build.js [--force] [--only=tiles|roads|country] [--dry-run]
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
const ROADS_MAX_DAYS = 30;
// Вся Россия — обзорная карта до масштаба COUNTRY_MAXZOOM; обновляется раз в
// COUNTRY_MAX_DAYS.
// До 11: города, районы и главные улицы страны — ≈1,3 ГБ (до 12 — 2,6 ГБ);
// подробные улицы и дома — в картах городов.
const COUNTRY_MAXZOOM = Number(process.env.MAP_COUNTRY_MAXZOOM) || 11;
const COUNTRY_MAX_DAYS = 60;
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
// Демо всегда в Санкт-Петербурге (Невский пр., 28 и Университетская наб., 3).
const DEMO_POINTS = [[59.9357, 30.3258], [59.9415, 30.3045]];
// Подробная карта (до домов) и маршруты есть всегда — для крупных городов
// России (CITIES ниже; просьба владельца: «карту всей России») и городов
// заведений; дополнительные — MAP_EXTRA_POINTS («шир,долг;шир,долг»).
// MAP_ALL_CITIES=0 — только Владикавказ и Петербург (маленький сервер).
const FIXED_POINTS = [[43.0247, 44.6819]];
const EXTRA_POINTS = String(process.env.MAP_EXTRA_POINTS || "").split(";")
  .map((x) => x.split(",").map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
// Названия районов в приложении — по ближайшему крупному городу внутри района.
const CITIES = [
  ["Санкт-Петербург", 59.9386, 30.3141], ["Москва", 55.7558, 37.6176], ["Владикавказ", 43.0247, 44.6819],
  ["Беслан", 43.1936, 44.5408], ["Нальчик", 43.4853, 43.6071], ["Грозный", 43.3178, 45.6949],
  ["Махачкала", 42.9849, 47.5047], ["Дербент", 42.0578, 48.2883], ["Пятигорск", 44.0486, 43.0594],
  ["Кисловодск", 43.9133, 42.7208], ["Ставрополь", 45.0428, 41.9734], ["Черкесск", 44.2269, 42.0467],
  ["Майкоп", 44.6098, 40.1006], ["Элиста", 46.3078, 44.2558], ["Магас", 43.1688, 44.8131],
  ["Краснодар", 45.0355, 38.9753], ["Сочи", 43.5855, 39.7231], ["Новороссийск", 44.7235, 37.7686],
  ["Анапа", 44.8946, 37.3166], ["Геленджик", 44.5622, 38.0848], ["Ростов-на-Дону", 47.2357, 39.7015],
  ["Волгоград", 48.708, 44.5133], ["Астрахань", 46.3497, 48.0408], ["Воронеж", 51.6608, 39.2003],
  ["Белгород", 50.5997, 36.5983], ["Курск", 51.7304, 36.1926], ["Липецк", 52.6031, 39.5708],
  ["Тамбов", 52.7212, 41.4523], ["Орёл", 52.9703, 36.0635], ["Брянск", 53.2434, 34.3644],
  ["Казань", 55.7963, 49.1088], ["Набережные Челны", 55.7436, 52.3958], ["Нижний Новгород", 56.3269, 44.0059],
  ["Самара", 53.1959, 50.1002], ["Тольятти", 53.5078, 49.4204], ["Саратов", 51.5331, 46.0342],
  ["Пенза", 53.1959, 45.0183], ["Ульяновск", 54.3142, 48.4031], ["Чебоксары", 56.1439, 47.2489],
  ["Йошкар-Ола", 56.6344, 47.8999], ["Саранск", 54.1838, 45.1749], ["Ижевск", 56.8526, 53.2045],
  ["Киров", 58.6036, 49.668], ["Уфа", 54.7388, 55.9721], ["Оренбург", 51.7682, 55.0969],
  ["Пермь", 58.0105, 56.2502], ["Екатеринбург", 56.8389, 60.6057], ["Нижний Тагил", 57.9194, 59.965],
  ["Челябинск", 55.1644, 61.4368], ["Магнитогорск", 53.4072, 58.9791], ["Курган", 55.441, 65.3411],
  ["Тюмень", 57.153, 65.5343], ["Сургут", 61.254, 73.3962], ["Омск", 54.9885, 73.3242],
  ["Новосибирск", 55.0084, 82.9357], ["Томск", 56.4846, 84.9476], ["Барнаул", 53.3548, 83.7698],
  ["Кемерово", 55.3547, 86.0873], ["Новокузнецк", 53.7557, 87.1099], ["Красноярск", 56.0153, 92.8932],
  ["Абакан", 53.7156, 91.4292], ["Иркутск", 52.2869, 104.305], ["Улан-Удэ", 51.8335, 107.5841],
  ["Чита", 52.0339, 113.4994], ["Якутск", 62.0355, 129.6755], ["Благовещенск", 50.2907, 127.5272],
  ["Хабаровск", 48.4802, 135.0719], ["Владивосток", 43.1155, 131.8855], ["Южно-Сахалинск", 46.9591, 142.738],
  ["Петропавловск-Камчатский", 53.0452, 158.6483], ["Магадан", 59.5638, 150.8035], ["Калининград", 54.7104, 20.4522],
  ["Псков", 57.8136, 28.3496], ["Великий Новгород", 58.5228, 31.2698], ["Петрозаводск", 61.7849, 34.3469],
  ["Мурманск", 68.9585, 33.0827], ["Архангельск", 64.5399, 40.5152], ["Вологда", 59.2181, 39.8886],
  ["Череповец", 59.1265, 37.9093], ["Сыктывкар", 61.6688, 50.8364], ["Ярославль", 57.6261, 39.8845],
  ["Кострома", 57.7665, 40.9269], ["Иваново", 57.0004, 40.9739], ["Владимир", 56.1291, 40.4066],
  ["Тверь", 56.8587, 35.9176], ["Смоленск", 54.7826, 32.0453], ["Калуга", 54.5293, 36.2754],
  ["Тула", 54.1931, 37.6173], ["Рязань", 54.6269, 39.6916], ["Севастополь", 44.6167, 33.5254],
  ["Симферополь", 44.9521, 34.1024], ["Ялта", 44.4952, 34.1663], ["Керчь", 45.3562, 36.4673],
];
function regionName(r) {
  const [w, s0, e, n] = r.bbox;
  let best = null;
  for (const [name, lat, lng] of CITIES) {
    if (lat < s0 || lat > n || lng < w || lng > e) continue;
    const d = (lat - r.center[0]) ** 2 + ((lng - r.center[1]) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (!best || d < best.d) best = { name, d };
  }
  return best ? best.name : `Район ${r.center[0].toFixed(2)}, ${r.center[1].toFixed(2)}`;
}

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
      const r = { id, bbox, center };
      r.name = regionName(r);
      return r;
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function readPoints(file = REGIONS_FILE) {
  let pts = [];
  try { pts = JSON.parse(fs.readFileSync(file, "utf8")).points || []; } catch (_) {}
  pts = pts.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const cities = process.env.MAP_ALL_CITIES === "0" ? [] : CITIES.map(([, lat, lng]) => [lat, lng]);
  return [...DEMO_POINTS, ...FIXED_POINTS, ...cities, ...EXTRA_POINTS, ...pts];
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

/** osmconvert и osmfilter (пакет osmctools): режут район и дороги в ~0,5 ГБ
 *  памяти. osmium extract/tags-filter для этого не годятся: их наборы номеров
 *  узлов по всей России занимают ~2 ГБ при любом размере файла. */
function ensureOsmctools() {
  const has = () => capture("sh", ["-c", "command -v osmconvert && command -v osmfilter"]).ok;
  if (has()) return;
  log("ставлю osmctools");
  run("apt-get", ["install", "-y", "-q", "--no-install-recommends", "osmctools"], { allowFail: true });
  if (!has()) throw new Error("osmctools не установился");
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

/* ------------------------------ вся Россия ------------------------------ */

/** Контур России для вырезки тайлов: округа Geofabrik (тот же список, что для дорог). */
function russiaGeoJson() {
  const polyDir = path.join(DIR, "geofabrik");
  fs.mkdirSync(polyDir, { recursive: true });
  const polys = [];
  for (const d of DISTRICTS) {
    const f = path.join(polyDir, `${d}.poly`);
    let st = null;
    try { st = fs.statSync(f); } catch (_) {}
    if (!st || Date.now() - st.mtimeMs > 30 * 86400000) {
      try { download(`${GEOFABRIK}${d}.poly`, f, { minBytes: 100 }); } catch (e) { if (!st) throw new Error(`${d}.poly: ${e.message}`); }
    }
    // Только внешние контуры (дыры не нужны: лишний участок тайлов не мешает).
    for (const r of parsePoly(fs.readFileSync(f, "utf8"))) if (!r.hole) polys.push([[...r.ring, r.ring[0]]]);
  }
  return { type: "MultiPolygon", coordinates: polys };
}

function buildCountry({ force, dryRun }) {
  const metaFile = path.join(DIR, "country.json");
  const meta = readJson(metaFile, {});
  const out = path.join(DIR, "russia.pmtiles");
  if (!force && fs.existsSync(out) && meta.maxzoom === COUNTRY_MAXZOOM && daysSince(meta.at) < COUNTRY_MAX_DAYS) {
    log(`Россия: без изменений (сборка ${meta.build}, ${daysSince(meta.at).toFixed(0)} дн.)`);
    return { skipped: true, ...meta };
  }
  const bin = ensurePmtiles();
  const build = latestBuild();
  const regionFile = path.join(DIR, "russia.geojson");
  writeJson(regionFile, russiaGeoJson());
  let maxzoom = COUNTRY_MAXZOOM;
  for (;;) {
    const est = capture(bin, ["extract", BUILD_BASE + build, path.join(DIR, "dry.pmtiles"), `--region=${regionFile}`, `--maxzoom=${maxzoom}`, "--dry-run"]);
    const m = /archive size of ([\d.]+) ([KMGT]?B)/.exec(est.out);
    const mb = m ? Number(m[1]) * ({ B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024, TB: 1048576 }[m[2]] || 1) : NaN;
    // Место: новый файл + старый до подмены + запас 3 ГБ для городов и дорог.
    const old = fs.existsSync(out) ? fs.statSync(out).size / 1048576 : 0;
    log(`Россия: сборка ${build}, масштаб до ${maxzoom}, размер ≈ ${Number.isFinite(mb) ? mb.toFixed(0) : "?"} МБ, свободно ${freeMb(DIR)} МБ`);
    if (!est.ok) throw new Error(`pmtiles: оценка не удалась — ${est.out.slice(-300)}`);
    if (Number.isFinite(mb) && mb + 3072 > freeMb(DIR) + old) {
      if (maxzoom > 9) { maxzoom--; continue; }
      throw new Error("Россия: мало места на диске");
    }
    break;
  }
  if (dryRun) return { dryRun: true, build, maxzoom };
  const tmp = path.join(DIR, "russia.pmtiles.new");
  try { fs.unlinkSync(tmp); } catch (_) {}
  run(bin, ["extract", BUILD_BASE + build, tmp, `--region=${regionFile}`, `--maxzoom=${maxzoom}`, "--download-threads=4", "--quiet"], { heavy: true, timeoutMs: 8 * 3600 * 1000 });
  const { openPmtiles } = require("./map-tiles");
  const p = openPmtiles(tmp);
  const ok = p.header.tileType === 1 && p.header.maxZoom >= 9;
  p.close();
  if (!ok) { fs.unlinkSync(tmp); throw new Error("Россия: собранный файл не подходит"); }
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, out);
  const res = { build, maxzoom, at: new Date().toISOString(), bytes: fs.statSync(out).size };
  writeJson(metaFile, res);
  log(`Россия: готово, ${(res.bytes / 1048576).toFixed(0)} МБ`);
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
  // Сеть дорог хранится только сжатой (roads-<район>.graph.gz): её же
  // скачивают телефоны, шлюз распаковывает в память при первом маршруте.
  const graphFile = (id) => {
    const gz = path.join(DIR, `roads-${id}.graph.gz`);
    if (fs.existsSync(gz)) return gz;
    const raw = path.join(DIR, `roads-${id}.graph`);
    return fs.existsSync(raw) ? raw : null;
  };
  const todo = regions.filter((r) => {
    const m = meta[r.id];
    return force || !m || JSON.stringify(m.bbox) !== JSON.stringify(r.bbox) || !graphFile(r.id) || daysSince(m.at) > ROADS_MAX_DAYS;
  });
  // Графы районов, которых больше нет, — убрать.
  const keep = new Set(regions.map((r) => r.id));
  for (const f of fs.readdirSync(DIR)) {
    const m = /^roads-([0-9-]+)\.graph(\.gz)?$/.exec(f);
    if (m && !keep.has(m[1]) && !dryRun) { fs.unlinkSync(path.join(DIR, f)); delete meta[m[1]]; log(`дороги: убрал ${f}`); }
  }
  // Несжатые графы прежних сборок — сжать и убрать (место на диске).
  if (!dryRun) {
    for (const r of regions) {
      const g = path.join(DIR, `roads-${r.id}.graph`);
      try {
        const st = fs.statSync(g);
        let gst = null;
        try { gst = fs.statSync(`${g}.gz`); } catch (_) {}
        if (!gst || gst.mtimeMs < st.mtimeMs) {
          fs.writeFileSync(`${g}.gz.tmp`, require("zlib").gzipSync(fs.readFileSync(g), { level: 9 }), { mode: 0o644 });
          fs.renameSync(`${g}.gz.tmp`, `${g}.gz`);
        }
        fs.unlinkSync(g);
        log(`дороги: ${r.name || r.id} — оставлена только сжатая копия`);
      } catch (_) { /* несжатого графа нет */ }
    }
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
  ensureOsmctools();
  const work = path.join(DIR, "work");
  fs.mkdirSync(work, { recursive: true });
  const done = [];
  const failed = [];
  for (const [d, list] of byDistrict) {
    const pbf = path.join(work, `${d}.osm.pbf`);
    if (freeMb(DIR) < 4096) throw new Error(`дороги: мало места (${freeMb(DIR)} МБ) для выгрузки ${d}`);
    log(`дороги: качаю ${d}`);
    download(`${GEOFABRIK}${d}-latest.osm.pbf`, pbf, { minBytes: 1 << 20 });
    try {
      for (const r of list) try {
        const cut = path.join(work, `cut-${r.id}.o5m`);
        const roadsO5m = path.join(work, `roads-${r.id}.o5m`);
        const roads = path.join(work, `roads-${r.id}.osm.pbf`);
        const opl = path.join(work, `roads-${r.id}.opl`);
        // Район с целыми дорогами (~0,5 ГБ памяти) → только дороги → pbf →
        // координаты в линиях (индекс по узлам района, ~0,3 ГБ). Обрывки
        // дорог на краю района пропускаются.
        const hash = ["--hash-memory=200"];
        run("osmconvert", [pbf, `-b=${r.bbox.join(",")}`, "--complete-ways", ...hash, `-o=${cut}`], { heavy: true });
        run("osmfilter", [cut, "--keep=highway=", "--drop-relations", "--drop-author", ...hash, `-o=${roadsO5m}`], { heavy: true });
        fs.unlinkSync(cut);
        run("osmconvert", [roadsO5m, ...hash, `-o=${roads}`], { heavy: true });
        fs.unlinkSync(roadsO5m);
        run(osmium, ["add-locations-to-ways", "-i", "sparse_mem_array", "--ignore-missing-nodes", "--overwrite", "-f", "opl,add_metadata=false", "-o", opl, roads], { heavy: true });
        fs.unlinkSync(roads);
        const out = path.join(DIR, `roads-${r.id}.graph`);
        run(process.execPath, ["--max-old-space-size=640", path.join(__dirname, "map-graph.js"), "build", opl, out], { heavy: true });
        fs.unlinkSync(opl);
        // Хранится только сжатая сеть дорог: её скачивают телефоны, шлюз
        // распаковывает в память при первом маршруте (место на диске).
        const gz = `${out}.gz`;
        fs.writeFileSync(`${gz}.tmp`, require("zlib").gzipSync(fs.readFileSync(out), { level: 9 }), { mode: 0o644 });
        fs.renameSync(`${gz}.tmp`, gz);
        const bytes = fs.statSync(out).size;
        fs.unlinkSync(out);
        meta[r.id] = { bbox: r.bbox, district: d, at: new Date().toISOString(), bytes, gzBytes: fs.statSync(gz).size };
        writeJson(metaFile, meta);
        done.push(r.id);
        log(`дороги: район ${r.id} (${r.name || ""}) готов`);
      } catch (e) {
        // Один город не получился — остальные собираются дальше; ошибка — в отчёт.
        failed.push(`${r.name || r.id}: ${e.message}`);
        log(`!! дороги: ${r.name || r.id} — ${e.message}`);
        for (const f of fs.readdirSync(work)) if (f.includes(r.id)) { try { fs.unlinkSync(path.join(work, f)); } catch (_) {} }
      }
    } finally {
      try { fs.unlinkSync(pbf); } catch (_) {}
    }
  }
  if (failed.length) throw new Error(`не собраны ${failed.length}: ${failed.slice(0, 5).join("; ")}`);
  return { done };
}

/* ------------------------------ запуск ------------------------------ */

/**
 * Остатки прерванных сборок (перезапуск, нехватка памяти): выгрузки
 * округов, недособранные карты, пробные файлы. Каждая — сотни МБ и больше.
 */
function cleanLeftovers() {
  let freed = 0;
  const rm = (f) => {
    try { const st = fs.statSync(f); fs.rmSync(f, { recursive: true, force: true }); freed += st.isDirectory() ? 0 : st.size; } catch (_) {}
  };
  const work = path.join(DIR, "work");
  try { for (const f of fs.readdirSync(work)) { freed += fs.statSync(path.join(work, f)).size; rm(path.join(work, f)); } } catch (_) {}
  for (const f of fs.readdirSync(DIR)) {
    if (/\.(new|part|tmp)$/.test(f) || f === "dry.pmtiles") rm(path.join(DIR, f));
  }
  if (freed > 1 << 20) log(`убраны остатки прошлых сборок: ${(freed / 1048576).toFixed(0)} МБ`);
}

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
  // Версия кода этой сборки: update-server.sh перезапускает идущую сборку,
  // если код карты обновился (иначе старая сборка доделает по-старому).
  try {
    const sum = crypto.createHash("sha1");
    for (const f of ["map-build.js", "map-graph.js"]) sum.update(fs.readFileSync(path.join(__dirname, f)));
    fs.writeFileSync(path.join(DIR, ".code"), sum.digest("hex"));
  } catch (_) {}
  if (!dryRun) cleanLeftovers();
  const status = { startedAt: new Date().toISOString(), errors: [] };
  try {
    const regions = clusterRegions(readPoints());
    status.regions = regions;
    log(`районов: ${regions.length} (${regions.map((r) => r.id).join(", ")})`);
    if (only !== "roads" && only !== "country") {
      try { status.tiles = buildTiles(regions, { force, dryRun }); } catch (e) { status.errors.push(`тайлы: ${e.message}`); log(`!! ${e.message}`); }
    }
    const partial = () => { if (!dryRun) writeJson(path.join(DIR, "status.json"), { ...status, running: true, ok: status.errors.length === 0 }); };
    partial(); // города уже видны приложению, пока идут дороги и страна
    if (only !== "tiles" && only !== "country") {
      try { status.roads = buildRoads(regions, { force, dryRun }); } catch (e) { status.errors.push(`дороги: ${e.message}`); log(`!! ${e.message}`); }
    }
    partial();
    // Страна — последней: города и их дороги нужнее курьерам и собираются быстрее.
    if ((only === "" || only === "country") && process.env.MAP_COUNTRY !== "0") {
      try { status.country = buildCountry({ force, dryRun }); } catch (e) { status.errors.push(`Россия: ${e.message}`); log(`!! ${e.message}`); }
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

module.exports = { clusterRegions, boxAround, parsePoly, inPoly, regionsGeoJson, readPoints, regionName, DEMO_POINTS, FIXED_POINTS };

if (require.main === module) process.exit(main());
