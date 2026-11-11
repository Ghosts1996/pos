"use strict";
/**
 * Маршруты своей карты: граф из OPL, одностороннее движение, режимы
 * (авто / велосипед / пешком), привязка к дороге, файл графа.
 */
const assert = require("assert");
const G = require("./map-graph");

// Сетка улиц 8×8, шаг ≈ 100 м (Москва, широта 55.75).
const LAT0 = 55.75, LON0 = 37.6;
const DLAT = 100 / 111195, DLON = 100 / (111195 * Math.cos(LAT0 * Math.PI / 180));
const N = 8;
const nodeId = (i, j) => 1000 + i * N + j;
const at = (i, j) => [LAT0 + i * DLAT, LON0 + j * DLON];
const enc = (s) => s.replace(/[ ,=%@]/g, (c) => `%${c.charCodeAt(0).toString(16)}%`);

function way(id, tags, nodes) {
  const T = Object.entries(tags).map(([k, v]) => `${enc(k)}=${enc(v)}`).join(",");
  const Nn = nodes.map(([nid, lat, lon]) => `n${nid}x${lon.toFixed(7)}y${lat.toFixed(7)}`).join(",");
  return `w${id} T${T} N${Nn}`;
}

function gridLines({ onewayRow = 3, footRow = 5 } = {}) {
  const lines = [];
  let wid = 1;
  // Горизонтальные улицы (по долготе), с промежуточной точкой между перекрёстками.
  for (let i = 0; i < N; i++) {
    const nodes = [];
    for (let j = 0; j < N; j++) {
      nodes.push([nodeId(i, j), ...at(i, j)]);
      if (j < N - 1) nodes.push([900000 + i * 100 + j, LAT0 + i * DLAT, LON0 + (j + 0.5) * DLON]);
    }
    const tags = { highway: "residential", name: `Улица ${i}` };
    if (i === onewayRow) tags.oneway = "yes"; // только на восток (j растёт)
    if (i === footRow) tags.highway = "footway";
    lines.push(way(wid++, tags, nodes));
  }
  // Вертикальные.
  for (let j = 0; j < N; j++) {
    const nodes = [];
    for (let i = 0; i < N; i++) nodes.push([nodeId(i, j), ...at(i, j)]);
    lines.push(way(wid++, { highway: j === 0 ? "secondary" : "residential" }, nodes));
  }
  // Островок (парковка), не связанный с сеткой, — должен отпасть.
  lines.push(way(wid++, { highway: "service" }, [[5000001, LAT0 - 0.01, LON0 - 0.01], [5000002, LAT0 - 0.0101, LON0 - 0.0101]]));
  // Не дорога.
  lines.push(way(wid++, { building: "yes" }, [[6000001, LAT0, LON0], [6000002, LAT0 + DLAT, LON0]]));
  // Нода без координат: линия прерывается, но не ломает сборку.
  lines.push(`w${wid++} Thighway=residential Nn${nodeId(0, 0)}x${LON0}y${LAT0},n7000001x y`);
  return lines;
}

async function build(lines) {
  const readLines = async (cb) => { for (const l of lines) cb(l); };
  return G.buildGraph(readLines);
}

const P = (i, j, dLat = 0, dLon = 0) => ({ lat: LAT0 + (i + dLat) * DLAT, lng: LON0 + (j + dLon) * DLON });

(async () => {
  let n = 0;
  const ok = (name) => { n++; console.log(`  ✓ ${name}`); };

  // Разбор OPL и разрешения.
  const w = G.parseWayLine("w1 Thighway=residential,name=Улица%20%Ленина,oneway=yes Nn1x37.6y55.7,n2x37.61y55.71");
  assert.strictEqual(w.tags.name, "Улица Ленина");
  assert.deepStrictEqual(w.nodes.map((x) => x[0]), [1, 2]);
  assert.strictEqual(G.wayFlags({ highway: "motorway" }) & G.F_FOOT, 0);
  assert.strictEqual(G.wayFlags({ highway: "footway" }) & (G.F_AUTO_FWD | G.F_AUTO_BACK), 0);
  assert.ok(G.wayFlags({ highway: "footway" }) & G.F_BIKE_FWD);
  assert.strictEqual(G.wayFlags({ highway: "footway", bicycle: "no" }) & G.F_BIKE_FWD, 0);
  assert.strictEqual(G.wayFlags({ highway: "residential", oneway: "yes" }) & G.F_AUTO_BACK, 0);
  assert.ok(G.wayFlags({ highway: "residential", oneway: "yes" }) & G.F_FOOT);
  assert.strictEqual(G.wayFlags({ highway: "residential", oneway: "yes", "oneway:bicycle": "no" }) & G.F_BIKE_BACK, G.F_BIKE_BACK);
  assert.ok(G.wayFlags({ highway: "primary", junction: "roundabout" }) & G.F_AUTO_FWD);
  assert.strictEqual(G.wayFlags({ highway: "primary", junction: "roundabout" }) & G.F_AUTO_BACK, 0);
  assert.strictEqual(G.wayFlags({ highway: "construction" }), -1);
  assert.strictEqual(G.wayFlags({ highway: "service", access: "no" }), -1);
  assert.ok(G.wayFlags({ highway: "service", access: "private" }) & G.F_PRIVATE);
  ok("разбор OPL и разрешения по тегам");

  const raw = await build(gridLines());
  assert.strictEqual(raw.vLat.length, N * N, "островок и обрывки отброшены, остались перекрёстки сетки");
  assert.strictEqual(raw.eFrom.length, 2 * N * (N - 1));
  ok("граф: только главная сеть, перекрёстки — вершины");

  const g = G.loadGraph(G.encodeGraph(raw));
  assert.strictEqual(g.nV, N * N);
  assert.ok(Math.abs(g.bounds[0] - LAT0) < 1e-5);
  ok("файл графа: запись и чтение");

  // Простой маршрут: по прямой 4 квартала ≈ 400 м.
  let r = G.route(g, [P(1, 1), P(1, 5)], "auto");
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(Math.abs(r.m - 400) < 5, `длина ${r.m}`);
  assert.ok(r.s > 60 && r.s < 120, `время ${r.s}`);
  assert.deepStrictEqual(r.line[0], [Math.round(P(1, 1).lat * 1e6) / 1e6, Math.round(P(1, 1).lng * 1e6) / 1e6]);
  assert.ok(r.line.length <= 3, "прямая упрощена до концов");
  ok("маршрут по прямой: метры и секунды");

  // «Манхэттен»: 3 вниз + 4 вправо = 700 м.
  r = G.route(g, [P(0, 1), P(3.5, 5)], "foot");
  assert.ok(r.ok);
  assert.ok(Math.abs(r.m - 750) < 6, `пешком ${r.m}`);
  ok("маршрут с поворотами");

  // Одностороннее: по улице 3 можно только на восток.
  const east = G.route(g, [P(3, 2), P(3, 6)], "auto");
  const west = G.route(g, [P(3, 6), P(3, 2)], "auto");
  assert.ok(Math.abs(east.m - 400) < 5);
  assert.ok(west.m >= 600, `на запад в объезд: ${west.m}`);
  const westFoot = G.route(g, [P(3, 6), P(3, 2)], "foot");
  assert.ok(Math.abs(westFoot.m - 400) < 5, "пешком одностороннее не мешает");
  ok("одностороннее движение — только для машин");

  // Пешеходная улица 5: машина туда не привязывается, пешеход идёт по ней.
  const footOnly = G.route(g, [P(5, 1.5), P(5, 6.5)], "foot");
  assert.ok(Math.abs(footOnly.m - 500) < 6, `пешком по пешеходной ${footOnly.m}`);
  const carNear = G.route(g, [P(5, 1.5), P(5, 6.5)], "auto");
  assert.ok(carNear.ok && carNear.m > 600, "машина — по соседним улицам");
  const bikeOn = G.route(g, [P(5, 1.5), P(5, 6.5)], "bike");
  assert.ok(Math.abs(bikeOn.m - 500) < 6, "велосипед по тротуару");
  ok("режимы: авто, велосипед, пешком");

  // Точка в стороне от дороги привязывается к ближайшей.
  r = G.route(g, [P(2.3, 2), P(2.3, 4)], "foot");
  assert.ok(r.ok && r.m >= 200);
  const sn = G.snap(g, P(2.3, 2).lat, P(2.3, 2).lng, "foot");
  assert.ok(sn && sn.d < 35, `до дороги ${sn && sn.d}`);
  ok("привязка к ближайшей дороге");

  // На одном ребре — напрямую; против одностороннего — в объезд.
  r = G.route(g, [P(1, 1.2), P(1, 1.8)], "auto");
  assert.ok(Math.abs(r.m - 60) < 3, `в пределах участка ${r.m}`);
  r = G.route(g, [P(3, 1.8), P(3, 1.2)], "auto");
  assert.ok(r.m > 200, `против одностороннего на одном участке — объезд ${r.m}`);
  ok("старт и финиш на одном участке");

  // Через несколько точек.
  r = G.route(g, [P(0, 0), P(0, 3), P(4, 3)], "bike");
  assert.ok(Math.abs(r.m - 700) < 6, `через точку ${r.m}`);
  ok("маршрут через несколько точек");

  // Далеко от дорог.
  r = G.route(g, [{ lat: LAT0 + 1, lng: LON0 + 1 }, P(1, 1)], "auto");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "far");
  assert.strictEqual(G.contains(g, LAT0 + 1, LON0 + 1), false);
  assert.strictEqual(G.contains(g, P(2, 2).lat, P(2, 2).lng), true);
  ok("точка вне карты — понятный отказ");

  // Скорость: 300 маршрутов по сетке побольше.
  const big = [];
  const M = 60;
  let id = 1;
  for (let i = 0; i < M; i++) {
    const nodes = [];
    for (let j = 0; j < M; j++) nodes.push([10 + i * M + j, LAT0 + i * DLAT, LON0 + j * DLON]);
    big.push(way(id++, { highway: i % 5 ? "residential" : "primary" }, nodes));
  }
  for (let j = 0; j < M; j++) {
    const nodes = [];
    for (let i = 0; i < M; i++) nodes.push([10 + i * M + j, LAT0 + i * DLAT, LON0 + j * DLON]);
    big.push(way(id++, { highway: "residential", ...(j % 7 === 3 ? { oneway: "yes" } : {}) }, nodes));
  }
  const gb = G.loadGraph(G.encodeGraph(await build(big)));
  const t0 = Date.now();
  for (let k = 0; k < 300; k++) {
    const a = P((k * 7) % M, (k * 13) % M), b = P((k * 11 + 17) % M, (k * 5 + 29) % M);
    const rr = G.route(gb, [a, b], ["auto", "bike", "foot"][k % 3]);
    assert.ok(rr.ok);
  }
  const per = (Date.now() - t0) / 300;
  assert.ok(per < 60, `маршрут считается долго: ${per} мс`);
  ok(`скорость: ${per.toFixed(1)} мс на маршрут (3600 перекрёстков)`);

  console.log(`map-graph: ${n} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
