"use strict";
/**
 * Районы города (map-districts.js) и цена доставки по районам с границами
 * (delivery-pricing.js): деление города на районы, «остальная часть»,
 * район по точке гостя, «сюда не доставляем».
 */
const assert = require("assert/strict");
const md = require("./map-districts");
const pricing = require("./delivery-pricing");

let n = 0;
const ok = (name) => { n++; console.log(`  ✓ ${name}`); };

// Квадрат [lng0, lat0] — [lng1, lat1] как кольцо GeoJSON.
const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const feat = (id, level, name, ...rings) => ({
  type: "Feature",
  properties: { "@type": "relation", "@id": id, boundary: "administrative", admin_level: String(level), name },
  geometry: { type: "MultiPolygon", coordinates: rings.map((r) => [r]) },
});

// Регион (уровень 4) 0..1° × 0..1°; город (6) в левом нижнем углу; его 3 района (9);
// большой «сельский район» (6) справа, поселения (8) покрывают лишь его часть.
const geo = {
  type: "FeatureCollection",
  features: [
    feat(1, 4, "Регион", box(0, 0, 1, 1)),
    feat(2, 6, "городской округ Город", box(0, 0, 0.3, 0.3)),
    feat(3, 9, "Центральный район", box(0, 0, 0.1, 0.3)),
    feat(4, 9, "Северный район", box(0.1, 0, 0.2, 0.3)),
    feat(5, 9, "Южный район", box(0.2, 0, 0.3, 0.3)),
    feat(6, 6, "Пригородный район", box(0.3, 0, 1, 1)),
    feat(7, 8, "Ивановское сельское поселение", box(0.3, 0, 0.4, 0.1)),
    feat(8, 8, "Петровское сельское поселение", box(0.4, 0, 0.5, 0.1)),
    feat(9, 6, "Дальний район", box(0, 0.3, 0.3, 1)),
    { type: "Feature", properties: { boundary: "administrative", admin_level: "9", name: "Линия" }, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } },
    feat(10, 9, "", box(0, 0, 0.05, 0.05)),
  ],
};

const data = md.build(geo);
assert.equal(data.list.length, 9, "без названия и не-полигоны — не районы");
assert.ok(data.list.every((d) => d.a > 0 && d.p.length === 2 && md.contains(d.r, d.p[1], d.p[0])), "точка внутри каждого района");
ok("сборка: границы уровней 4–10 с названием, площадь и точка внутри");

const near = md.near(data, 0.05, 0.15, 40); // широта, долгота — в «Северном районе»
const names = near.map((d) => d.name);
assert.deepEqual(names.slice(0, 1), ["Северный район"], "свой район — первым");
assert.ok(names.includes("Центральный район") && names.includes("Южный район"), "город — по районам");
assert.ok(!names.includes("городской округ Город") && !names.includes("Регион"), "город и регион целиком — не районы доставки");
assert.ok(names.includes("Ивановское сельское поселение") && names.includes("Пригородный район — остальная часть"),
  `поселения большого района и его «остальная часть»: ${names.join(", ")}`);
assert.ok(near.find((d) => d.name === "Северный район").here, "заведение — в «Северном»");
ok(`деление: ${names.length} районов, свой первым, большой район — поселения + остальная часть`);

// Точка в поселении внутри «остальной части» — самый маленький район.
const ivan = near.find((d) => d.name.startsWith("Ивановское"));
const rest = near.find((d) => d.name.startsWith("Пригородный"));
assert.equal(md.whichContains([rest.rings, ivan.rings], 0.05, 0.35), 1, "поселение, а не остальная часть");
assert.equal(md.whichContains([rest.rings, ivan.rings], 0.5, 0.8), 0, "вне поселений — остальная часть");
assert.equal(md.whichContains([ivan.rings], 0.9, 0.9), -1);
ok("точка → самый маленький район (поселение внутри остальной части)");

// Упрощение для настроек: не больше заданного числа точек.
const circle = [];
for (let i = 0; i <= 2000; i++) circle.push([Math.cos((i / 2000) * 2 * Math.PI) * 0.1, Math.sin((i / 2000) * 2 * Math.PI) * 0.1]);
circle[circle.length - 1] = circle[0];
const c = md.compactRings([circle], 200);
assert.ok(c[0].length <= 200 && c[0].length >= 8, `точек: ${c[0].length}`);
assert.ok(md.contains(c, 0, 0) && !md.contains(c, 0.2, 0.2), "форма сохранилась");
ok("контур района для настроек — не больше 200 точек, форма та же");

// Цена доставки: районы с границами.
const settings = {
  fee: 200, freeFrom: 0, minOrder: 0, etaMin: 60,
  zones: [
    { id: "dr4", name: "Северный район", osm: "r4", poly: data.list.find((d) => d.id === "r4").r, fee: 150 },
    { id: "dr5", name: "Южный район", osm: "r5", poly: data.list.find((d) => d.id === "r5").r, fee: 250, etaMin: 90 },
  ],
};
assert.equal(pricing.settingsProblem(settings), "", "районы с границами проходят проверку");
let q = pricing.quote(settings, 1000, "", { point: { lat: 0.1, lng: 0.25 } });
assert.ok(q.ok && q.fee === 250 && q.zone.id === "dr5" && q.autoZone && q.etaMin === 90, `район по точке: ${JSON.stringify(q)}`);
q = pricing.quote(settings, 1000, "dr4", { point: { lat: 0.1, lng: 0.25 } });
assert.equal(q.zone.id, "dr5", "точка гостя важнее выбранного вручную района");
q = pricing.quote(settings, 1000, "", { point: { lat: 0.9, lng: 0.9 } });
assert.ok(!q.ok && q.outOfArea && /не доставляем/.test(q.error), "точка вне районов — не доставляем");
q = pricing.quote(settings, 1000, "dr4");
assert.ok(q.ok && q.fee === 150, "без точки — район из списка");
q = pricing.quote(settings, 1000, "");
assert.ok(!q.ok && /Выберите район/.test(q.error), "без точки и без района — выбрать район");
ok("цена: район по точке гостя, вне районов — отказ, без точки — выбор из списка");

// Смешанные районы: вне районов с границей — можно выбрать район по названию.
const mixed = { ...settings, zones: [...settings.zones, { id: "z9", name: "Пригород", fee: 400 }] };
q = pricing.quote(mixed, 1000, "z9", { point: { lat: 0.9, lng: 0.9 } });
assert.ok(q.ok && q.fee === 400, "есть район без границы — гость выбирает его");
ok("районы по названию и по карте вместе");

const g = pricing.zonesForGuest(pricing.normalizeSettings(settings).zones);
assert.ok(g.every((z) => !z.poly && !z.osm && z.area === true), "гостю — без контуров, с отметкой «по карте»");
assert.match(pricing.settingsProblem({ zones: [{ name: "Плохой", poly: [[[0, 0], [1, "x"], [1, 1], [0, 0]]] }] }), /граница района повреждена/);
const big = [];
for (let i = 0; i < 700; i++) big.push([i / 1000, (i % 7) / 1000]);
assert.match(pricing.settingsProblem({ zones: [{ name: "Огромный", poly: [big] }] }), /граница района повреждена/, "слишком подробная граница — отказ");
ok("гостю районы без границ; кривая или огромная граница не сохраняется");

// Сервер карты: /map/districts по точке заведения.
{
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zdist-"));
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ ok: true, regions: [{ id: "1-1", name: "Город", bbox: [0, 0, 1, 1], center: [0.5, 0.5] }] }));
  const { createMap } = require("./map");
  let m = createMap({ dir });
  assert.equal(m.districts(0.05, 0.15).reason, "building", "карта есть, районов ещё нет — «собираются»");
  m.close();
  fs.writeFileSync(path.join(dir, "districts-1-1.json"), JSON.stringify(data));
  m = createMap({ dir });
  const r = m.districts(0.05, 0.15, 40);
  assert.ok(r.ok && r.area.id === "1-1" && r.list[0].name === "Северный район" && r.list[0].rings.length, JSON.stringify(r).slice(0, 200));
  assert.equal(m.districts(55, 37).reason, "noarea", "там, где карты нет, — «нет района»");
  assert.equal(m.districts("x", 1).reason, "point");
  // Через serve: ответ JSON (сжатие — по Accept-Encoding).
  const res = { headers: null, body: null, writeHead(code, h) { this.code = code; this.headers = h; }, end(b) { this.body = b; } };
  m.serve({ method: "GET", headers: {} }, res, "districts", "lat=0.05&lng=0.15&km=40");
  assert.equal(res.code, 200);
  assert.ok(JSON.parse(res.body.toString()).list.length >= 5);
  m.close();
  fs.rmSync(dir, { recursive: true, force: true });
  ok("сервер карты: районы по точке, «собираются», «нет района»");
}

console.log(`districts: ${n} проверок пройдено`);
