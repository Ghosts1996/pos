"use strict";
/**
 * Своя карта: чтение PMTiles, адреса /map/… (тайлы, шрифты, движок, info),
 * маршруты через поток-работник, районы для сборки (map-build.js).
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { openPmtiles, zxyToTileId } = require("./map-tiles");
const { createMap } = require("./map");
const G = require("./map-graph");
const B = require("./map-build");
const { buildStyle } = require("./map-style");

/* Небольшой файл PMTiles v3 (gzip), как его собирает pmtiles extract. */
function varint(n) {
  const out = [];
  while (n >= 0x80) { out.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); }
  out.push(n);
  return out;
}
function writePmtiles(file, tiles, { bounds = [37.5, 55.7, 37.7, 55.8] } = {}) {
  const entries = tiles
    .map(([z, x, y, body]) => ({ id: zxyToTileId(z, x, y), data: zlib.gzipSync(body) }))
    .sort((a, b) => a.id - b.id);
  let off = 0;
  for (const e of entries) { e.off = off; off += e.data.length; }
  const dir = [...varint(entries.length)];
  let last = 0;
  for (const e of entries) { dir.push(...varint(e.id - last)); last = e.id; }
  for (const _ of entries) dir.push(...varint(1));
  for (const e of entries) dir.push(...varint(e.data.length));
  entries.forEach((e, i) => dir.push(...varint(i > 0 && e.off === entries[i - 1].off + entries[i - 1].data.length ? 0 : e.off + 1)));
  const root = zlib.gzipSync(Buffer.from(dir));
  const meta = zlib.gzipSync(Buffer.from(JSON.stringify({ name: "test", vector_layers: [] })));
  const data = Buffer.concat(entries.map((e) => e.data));
  const h = Buffer.alloc(127);
  h.write("PMTiles", 0, "latin1");
  h[7] = 3;
  const set64 = (pos, v) => h.writeBigUInt64LE(BigInt(v), pos);
  set64(8, 127); set64(16, root.length);
  set64(24, 127 + root.length); set64(32, meta.length);
  set64(40, 127 + root.length + meta.length); set64(48, 0);
  set64(56, 127 + root.length + meta.length); set64(64, data.length);
  set64(72, entries.length); set64(80, entries.length); set64(88, entries.length);
  h[96] = 1; h[97] = 2; h[98] = 2; h[99] = 1; h[100] = 0; h[101] = 15;
  h.writeInt32LE(Math.round(bounds[0] * 1e7), 102); h.writeInt32LE(Math.round(bounds[1] * 1e7), 106);
  h.writeInt32LE(Math.round(bounds[2] * 1e7), 110); h.writeInt32LE(Math.round(bounds[3] * 1e7), 114);
  h[118] = 12;
  h.writeInt32LE(Math.round(((bounds[0] + bounds[2]) / 2) * 1e7), 119);
  h.writeInt32LE(Math.round(((bounds[1] + bounds[3]) / 2) * 1e7), 123);
  fs.writeFileSync(file, Buffer.concat([h, root, meta, data]));
}

function gridOpl(lat0, lon0, n = 6, step = 0.001) {
  const lines = [];
  let w = 1;
  for (let i = 0; i < n; i++) {
    lines.push(`w${w++} Thighway=residential N${Array.from({ length: n }, (_, j) => `n${1 + i * n + j}x${(lon0 + j * step).toFixed(6)}y${(lat0 + i * step).toFixed(6)}`).join(",")}`);
    lines.push(`w${w++} Thighway=residential${i === 2 ? ",oneway=yes" : ""} N${Array.from({ length: n }, (_, j) => `n${1 + j * n + i}x${(lon0 + i * step).toFixed(6)}y${(lat0 + j * step).toFixed(6)}`).join(",")}`);
  }
  // Лестница — велосипеду только пешком.
  lines.push(`w${w++} Thighway=steps N${[`n900001x${(lon0 - 0.002).toFixed(6)}y${lat0.toFixed(6)}`, `n1x${lon0.toFixed(6)}y${lat0.toFixed(6)}`].join(",")}`);
  return lines;
}

(async () => {
  let n = 0;
  const ok = (name) => { n++; console.log(`  ✓ ${name}`); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalmap-"));

  // ---- PMTiles
  const tileA = Buffer.from("tile-z14");
  writePmtiles(path.join(dir, "tiles.pmtiles"), [[0, 0, 0, Buffer.from("world")], [14, 9898, 5120, tileA], [14, 9899, 5120, Buffer.from("tile-b")], [1, 1, 0, Buffer.from("z1")]]);
  const p = openPmtiles(path.join(dir, "tiles.pmtiles"));
  assert.strictEqual(p.header.tileType, 1);
  assert.strictEqual(p.encoding, "gzip");
  assert.deepStrictEqual(zlib.gunzipSync(p.tile(14, 9898, 5120)), tileA);
  assert.deepStrictEqual(zlib.gunzipSync(p.tile(1, 1, 0)).toString(), "z1");
  assert.strictEqual(p.tile(14, 1, 1), null);
  assert.strictEqual(p.metadata.name, "test");
  p.close();
  ok("PMTiles: заголовок, каталог, тайлы, пустые места");

  // ---- граф дорог в папке карт
  const lat0 = 55.75, lon0 = 37.6;
  const readLines = async (cb) => gridOpl(lat0, lon0).forEach(cb);
  fs.writeFileSync(path.join(dir, "roads-5575-3760.graph"), G.encodeGraph(await G.buildGraph(readLines)));

  // ---- адреса /map/…
  const regionsFile = path.join(dir, "state", "map-regions.json");
  const map = createMap({ dir, regionsFile });
  const srv = http.createServer((req, res) => {
    const [p0, q] = req.url.split("?");
    if (!p0.startsWith("/map/")) { res.writeHead(404); return res.end(); }
    map.serve(req, res, p0.slice(5), q || "");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/map`;
  const get = (u, h = {}) => new Promise((resolve, reject) => {
    http.get(`${base}/${u}`, { headers: h }, (res) => {
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    }).on("error", reject);
  });

  let r = await get("info");
  const info = JSON.parse(r.body);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers["access-control-allow-origin"], "*");
  assert.ok(info.tiles && info.tiles.v && info.tiles.maxzoom === 15);
  assert.deepStrictEqual(info.tiles.bounds, [37.5, 55.7, 37.7, 55.8]);
  assert.ok(info.route && info.route.modes.includes("bike"));
  ok("map/info: версия тайлов, границы, маршруты");

  r = await get(`tiles/14/9898/5120.mvt?v=${info.tiles.v}`, { "Accept-Encoding": "gzip" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers["content-encoding"], "gzip");
  assert.match(r.headers["cache-control"], /immutable/);
  assert.deepStrictEqual(zlib.gunzipSync(r.body), tileA);
  r = await get("tiles/14/9898/5120.mvt");
  assert.strictEqual(r.headers["content-encoding"], undefined, "без gzip — распакованный тайл");
  assert.deepStrictEqual(r.body, tileA);
  assert.doesNotMatch(r.headers["cache-control"], /immutable/, "без версии — не навсегда");
  r = await get("tiles/14/1/1.mvt");
  assert.strictEqual(r.status, 204);
  for (const bad of ["tiles/3/9/0.mvt", "tiles/../../etc/passwd", "tiles/1/0/0.png", "server.js", "../map.js"]) {
    assert.strictEqual((await get(bad)).status, 404, bad);
  }
  assert.strictEqual((await get("fonts/..%2F..%2Fserver.js/0-255.pbf")).body.length, 0, "имя шрифта с путём — ничего не читается");
  ok("тайлы: gzip, кэш по версии, пустые — 204, чужие пути — 404");

  r = await get("fonts/Noto%20Sans%20Regular/1024-1279.pbf");
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.length > 10000, "кириллица на месте");
  r = await get("fonts/Noto%20Sans%20Medium,Noto%20Sans%20Regular/0-255.pbf");
  assert.ok(r.body.length > 10000);
  r = await get("fonts/Noto%20Sans%20Regular/19968-20223.pbf");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.length, 0, "нет диапазона — пустой ответ, а не ошибка");
  assert.strictEqual((await get("fonts/Noto%20Sans%20Regular/0-200.pbf")).status, 404);
  ok("шрифты: кириллица, запасной шрифт, пустые диапазоны");

  r = await get("maplibre-gl-csp-worker.js", { "Accept-Encoding": "gzip" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers["content-encoding"], "gzip");
  assert.match(r.headers["content-security-policy"], /connect-src 'self'/, "потоку карты можно качать тайлы");
  const etag = r.headers.etag;
  assert.strictEqual((await get("maplibre-gl-csp-worker.js", { "If-None-Match": etag })).status, 304);
  for (const f of ["maplibre-gl-csp.js", "maplibre-gl.css", "zal-map.js", "zal-map.css", "map-style.js"]) {
    const x = await get(f);
    assert.strictEqual(x.status, 200, f);
    assert.ok(!/sourceMappingURL/.test(x.body.toString()), `${f}: без ссылок на отсутствующие карты исходников`);
  }
  ok("движок карты: сжатие, ETag, своя политика для потока");

  // ---- маршрут через поток-работник
  const P = (i, j) => ({ lat: lat0 + i * 0.001, lng: lon0 + j * 0.001 });
  let rt = await map.route({ points: [P(0, 0), P(0, 4)], mode: "auto" });
  assert.ok(rt.ok, JSON.stringify(rt));
  assert.ok(Math.abs(rt.m - 250) < 10, `метры ${rt.m}`);
  assert.strictEqual(rt.legs.length, 1);
  rt = await map.route({ points: [P(4, 2), P(0, 2)], mode: "auto" });
  assert.ok(rt.ok && rt.m > 450, `одностороннее — в объезд: ${rt.m}`);
  rt = await map.route({ points: [P(4, 2), P(0, 2)], mode: "foot" });
  assert.ok(Math.abs(rt.m - 445) < 10, `пешком напрямую: ${rt.m}`);
  rt = await map.route({ points: [{ lat: lat0, lng: lon0 - 0.002 }, P(1, 1)], mode: "bike" });
  assert.ok(rt.ok && rt.mode === "bike", JSON.stringify(rt));
  rt = await map.route({ points: [{ lat: 43, lng: 11 }, { lat: 43.01, lng: 11 }], mode: "auto" });
  assert.deepStrictEqual(rt, { ok: false, reason: "nomap" });
  rt = await map.route({ points: [P(0, 0)], mode: "auto" });
  assert.strictEqual(rt.reason, "points");
  rt = await map.route({ points: [P(0, 0), { lat: "x", lng: 1 }] });
  assert.strictEqual(rt.reason, "points");
  ok("маршруты: поток-работник, одностороннее, пешком, вне карты, ошибки ввода");

  // ---- районы для сборки
  assert.strictEqual(map.saveRegions([{ lat: 55.7579, lng: 37.6108 }, { lat: 55.75791, lng: 37.61081 }, { lat: "x" }, { lat: 0, lng: 0 }]), true);
  const saved = JSON.parse(fs.readFileSync(regionsFile, "utf8"));
  assert.deepStrictEqual(saved.points, [[55.758, 37.611]], "без дублей и мусора, только округлённые числа");
  assert.strictEqual(map.saveRegions([{ lat: 55.7579, lng: 37.6108 }]), false, "не поменялось — файл не трогаем");
  ok("точки заведений для сборки карты");

  const regs = B.clusterRegions([[55.7579, 37.6108], [55.7507, 37.5439], [55.0302, 82.9204], [55.04, 82.93]], 25);
  assert.strictEqual(regs.length, 2, "Москва и Новосибирск — два района");
  const msk = regs.find((x) => x.center[1] < 50);
  assert.ok(msk.bbox[0] < 37.2 && msk.bbox[2] > 37.9 && msk.bbox[1] < 55.6 && msk.bbox[3] > 55.9, JSON.stringify(msk));
  assert.match(msk.id, /^[0-9-]+$/);
  assert.strictEqual(B.clusterRegions([[55.75, 37.6], [56.1, 38.0]], 25).length, 1, "соседние квадраты сливаются");
  const gj = B.regionsGeoJson(regs);
  assert.strictEqual(gj.type, "MultiPolygon");
  assert.strictEqual(gj.coordinates.length, 2);
  assert.deepStrictEqual(gj.coordinates[0][0][0], gj.coordinates[0][0][4], "кольцо замкнуто");
  const poly = B.parsePoly("central\n1\n   36.0 55.0\n   39.0 55.0\n   39.0 57.0\n   36.0 57.0\nEND\n!2\n   37.0 55.5\n   37.2 55.5\n   37.2 55.6\n   37.0 55.6\nEND\nEND\n");
  assert.strictEqual(poly.length, 2);
  assert.strictEqual(B.inPoly(poly, 55.75, 37.6), true);
  assert.strictEqual(B.inPoly(poly, 55.55, 37.1), false, "дырка в контуре");
  assert.strictEqual(B.inPoly(poly, 55.03, 82.92), false);
  ok("районы: слияние, GeoJSON для pmtiles, контуры округов");

  // ---- стиль
  for (const theme of ["light", "dark"]) {
    const st = buildStyle({ theme, tilesUrl: "t/{z}/{x}/{y}.mvt", glyphsUrl: "f/{fontstack}/{range}.pbf", info: { minzoom: 0, maxzoom: 15, bounds: [1, 2, 3, 4] } });
    assert.strictEqual(st.version, 8);
    assert.deepStrictEqual(st.sources.zal.bounds, [1, 2, 3, 4]);
    const ids = new Set();
    for (const l of st.layers) {
      assert.ok(!ids.has(l.id), `повтор слоя ${l.id}`);
      ids.add(l.id);
      // MapLibre: масштаб (zoom) — только на верхнем уровне выражения.
      const w = l.paint && l.paint["line-width"];
      if (Array.isArray(w) && w[0] === "interpolate") assert.ok(!JSON.stringify(w.slice(3)).includes("zoom"), `${l.id}: zoom внутри`);
      if (Array.isArray(w) && w[0] === "case") assert.fail(`${l.id}: case поверх zoom`);
    }
    assert.ok(ids.has("roads_labels") && ids.has("address_label"), "подписи улиц и номера домов");
  }
  ok("стиль: светлый и тёмный, без ошибок выражений");

  await map.close();
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`map: ${n} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
