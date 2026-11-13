/**
 * Стиль своей карты ZalPOS — светлый и тёмный, премиальный: платиновый
 * фон, магистрали цвета шампань, приглушённые вода и парки, белые улицы,
 * подписи по-русски, номера домов на крупном масштабе.
 *
 * Тайлы — Protomaps (данные OpenStreetMap). Стиль понимает обе схемы:
 * v4 (поля kind / kind_detail) и v3 (pmap:kind / pmap:kind_detail),
 * поэтому старые и новые сборки тайлов показываются одинаково.
*/
(function () {
"use strict";

const PALETTES = {
  light: {
    bg: "#F2F0EB",
    earth: "#F2F0EB",
    urban: "#EDEAE3",
    park: "#D9E6CF",
    wood: "#CFDFC3",
    grass: "#E0EAD5",
    sand: "#F1EAD6",
    hospital: "#F3E4E2",
    school: "#F1ECDD",
    industrial: "#EAE7E1",
    pedestrian: "#F7F5F0",
    aerodrome: "#E8E6EC",
    water: "#BCD3E2",
    waterLine: "#A6C4D8",
    waterLabel: "#557A94",
    building: "#E5E1D9",
    buildingLine: "#D6D0C5",
    path: "#D8D1C4",
    minor: "#FFFFFF",
    minorCase: "#DCD6CB",
    service: "#FFFFFF",
    medium: "#FFFFFF",
    mediumCase: "#D2CBBE",
    major: "#F6E7C4",
    majorCase: "#D7BD86",
    highway: "#EED29A",
    highwayCase: "#C29A52",
    tunnel: "#F0EDE7",
    rail: "#BFB9AF",
    boundary: "#BDAFC6",
    label: "#33302B",
    labelSoft: "#6F6A62",
    halo: "#FFFFFF",
    roadLabel: "#45413A",
    house: "#8C8577",
    oneway: "#B3AB9C",
    place: "#25221E",
    poi: "#6B665E",
    station: "#B42318",
  },
  dark: {
    bg: "#111113",
    earth: "#111113",
    urban: "#141416",
    park: "#15201A",
    wood: "#131D16",
    grass: "#16201A",
    sand: "#1F1D17",
    hospital: "#241A1B",
    school: "#201E17",
    industrial: "#161618",
    pedestrian: "#19191C",
    aerodrome: "#18181C",
    water: "#0F1D2A",
    waterLine: "#16293A",
    waterLabel: "#6E8FAA",
    building: "#1F1F22",
    buildingLine: "#2A2A2E",
    path: "#2E2D2B",
    minor: "#2A2A2D",
    minorCase: "#1A1A1C",
    service: "#252528",
    medium: "#34332F",
    mediumCase: "#1A1A1C",
    major: "#4A3F27",
    majorCase: "#2A2416",
    highway: "#7C6331",
    highwayCase: "#3A2F18",
    tunnel: "#1E1E21",
    rail: "#3A3936",
    boundary: "#55496A",
    label: "#DCD6CB",
    labelSoft: "#9E978B",
    halo: "#0E0E10",
    roadLabel: "#C9C2B5",
    house: "#8E877B",
    oneway: "#4D4A44",
    place: "#EFE9DE",
    poi: "#9E978B",
    station: "#FF7F73",
  },
};

const KIND = ["coalesce", ["get", "kind"], ["get", "pmap:kind"], ""];
const DETAIL = ["coalesce", ["get", "kind_detail"], ["get", "pmap:kind_detail"], ""];
const NAME = ["coalesce", ["get", "name:ru"], ["get", "name"], ""];
const REG = ["Noto Sans Regular"];
const MED = ["Noto Sans Medium"];

const isKind = (...k) => ["in", KIND, ["literal", k]];
const isDetail = (...k) => ["in", DETAIL, ["literal", k]];
const notTunnel = ["!", ["any", ["has", "is_tunnel"], ["==", ["get", "pmap:level"], -1]]];
const isTunnel = ["any", ["has", "is_tunnel"], ["==", ["get", "pmap:level"], -1]];
const isBridge = ["any", ["has", "is_bridge"], ["==", ["get", "pmap:level"], 1]];
const isLink = ["any", ["has", "is_link"], ["==", ["get", "pmap:link"], 1]];

/** Ширина линии по масштабу: пары [zoom, px]. */
function width(stops) {
  const e = ["interpolate", ["exponential", 1.6], ["zoom"]];
  for (const [z, w] of stops) e.push(z, w);
  return e;
}

/** Съезды и развязки — тоньше основной дороги (масштаб остаётся верхним уровнем). */
function linkWidth(expr) {
  const out = expr.slice(0, 3);
  for (let i = 3; i < expr.length; i += 2) out.push(expr[i], ["case", isLink, expr[i + 1] * 0.6, expr[i + 1]]);
  return out;
}

/** Классы дорог: магистраль, главная, средняя, улица, проезд, дорожка. */
const ROAD_CLASSES = {
  highway: ["all", isKind("highway")],
  major: ["all", isKind("major_road"), ["!", isDetail("secondary", "tertiary", "secondary_link", "tertiary_link")]],
  medium: ["any", isKind("medium_road"), ["all", isKind("major_road"), isDetail("secondary", "tertiary", "secondary_link", "tertiary_link")]],
  minor: ["all", isKind("minor_road"), ["!", isDetail("service")]],
  service: ["all", isKind("minor_road"), isDetail("service")],
  path: ["all", isKind("path", "other"), ["!", isDetail("pier")]],
};

const ROAD_W = {
  highway: { w: width([[5, 0.6], [10, 2.2], [14, 6], [17, 16], [19, 34]]), c: width([[5, 1], [10, 3.2], [14, 8.4], [17, 20], [19, 40]]), min: 4 },
  major: { w: width([[7, 0.5], [11, 1.6], [14, 5], [17, 13], [19, 28]]), c: width([[7, 0.9], [11, 2.6], [14, 7], [17, 16.5], [19, 33]]), min: 7 },
  medium: { w: width([[10, 0.5], [12, 1.2], [14, 3.6], [17, 10], [19, 22]]), c: width([[10, 0.8], [12, 2], [14, 5.2], [17, 12.6], [19, 26]]), min: 10 },
  minor: { w: width([[12, 0.4], [14, 1.6], [16, 4.4], [18, 10], [20, 22]]), c: width([[12, 0.6], [14, 2.6], [16, 6], [18, 12.6], [20, 26]]), min: 12 },
  service: { w: width([[14, 0.4], [16, 1.6], [18, 5], [20, 12]]), c: width([[14, 0.7], [16, 2.6], [18, 6.6], [20, 14.4]]), min: 14 },
  path: { w: width([[14, 0.5], [16, 1], [18, 2.2], [20, 4]]), c: null, min: 14 },
};

/**
 * Стиль MapLibre. tilesUrl — шаблон тайлов ({z}/{x}/{y}), glyphsUrl —
 * шаблон шрифтов ({fontstack}/{range}), info — данные о тайлах
 * (minzoom, maxzoom, bounds).
 */
function buildStyle({ theme = "light", tilesUrl, glyphsUrl, info = {} } = {}) {
  const p = PALETTES[theme] || PALETTES.light;
  const src = "zal";
  const L = [];
  const fill = (id, layer, filter, color, extra = {}) =>
    L.push({ id, type: "fill", source: src, "source-layer": layer, filter, paint: { "fill-color": color, ...extra.paint }, ...(extra.minzoom ? { minzoom: extra.minzoom } : {}) });

  L.push({ id: "background", type: "background", paint: { "background-color": p.bg } });
  fill("earth", "earth", ["==", ["geometry-type"], "Polygon"], p.earth);

  // Природа и кварталы.
  for (const layer of ["landcover", "natural"]) {
    fill(`${layer}_wood`, layer, isKind("forest", "wood", "nature_reserve"), p.wood, { paint: { "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.5, 10, 1] } });
    fill(`${layer}_grass`, layer, isKind("grassland", "grass", "scrub", "farmland", "meadow"), p.grass, { paint: { "fill-opacity": 0.8 } });
    fill(`${layer}_sand`, layer, isKind("sand", "beach", "barren", "glacier"), p.sand);
  }
  fill("landuse_urban", "landuse", isKind("residential", "neighbourhood", "urban_area", "commercial", "retail"), p.urban, { minzoom: 10 });
  fill("landuse_industrial", "landuse", isKind("industrial", "railway", "garages", "brownfield", "construction"), p.industrial, { minzoom: 11 });
  fill("landuse_park", "landuse", isKind("park", "garden", "cemetery", "golf_course", "national_park", "protected_area", "village_green", "recreation_ground", "playground", "allotments", "dog_park", "pitch", "nature_reserve"), p.park, { paint: { "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.4, 12, 1] } });
  fill("landuse_wood", "landuse", isKind("forest", "wood", "scrub", "grassland", "grass", "meadow"), p.wood);
  fill("landuse_hospital", "landuse", isKind("hospital", "clinic"), p.hospital, { minzoom: 12 });
  fill("landuse_school", "landuse", isKind("school", "university", "college", "kindergarten"), p.school, { minzoom: 12 });
  fill("landuse_beach", "landuse", isKind("beach", "sand"), p.sand, { minzoom: 11 });
  fill("landuse_aerodrome", "landuse", isKind("aerodrome", "airfield", "runway", "taxiway"), p.aerodrome, { minzoom: 10 });
  fill("landuse_pedestrian", "landuse", isKind("pedestrian", "platform", "plaza"), p.pedestrian, { minzoom: 13 });

  // Вода.
  fill("water", "water", ["==", ["geometry-type"], "Polygon"], p.water);
  L.push({
    id: "water_line", type: "line", source: src, "source-layer": "water", minzoom: 11,
    filter: ["all", ["==", ["geometry-type"], "LineString"], isKind("river", "stream", "canal", "drain", "ditch")],
    paint: { "line-color": p.waterLine, "line-width": width([[11, 0.6], [14, 1.6], [18, 5]]) },
  });
  L.push({
    id: "physical_water_line", type: "line", source: src, "source-layer": "physical_line", minzoom: 11,
    filter: isKind("river", "stream", "canal"),
    paint: { "line-color": p.waterLine, "line-width": width([[11, 0.6], [14, 1.6], [18, 5]]) },
  });

  // Тоннели — бледно и пунктиром, под зданиями.
  L.push({
    id: "roads_tunnels", type: "line", source: src, "source-layer": "roads", minzoom: 13,
    filter: ["all", isTunnel, isKind("highway", "major_road", "medium_road", "minor_road")],
    layout: { "line-cap": "butt", "line-join": "round" },
    paint: { "line-color": p.tunnel, "line-dasharray": [1.5, 1], "line-width": width([[13, 1.4], [16, 5], [19, 18]]) },
  });

  // Здания.
  L.push({
    id: "buildings", type: "fill", source: src, "source-layer": "buildings", minzoom: 13,
    filter: ["all", ["==", ["geometry-type"], "Polygon"], ["!=", KIND, "address"]],
    paint: {
      "fill-color": p.building,
      "fill-outline-color": p.buildingLine,
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, 1],
    },
  });

  // Дороги: сначала обводки, потом заливки — так перекрёстки чистые.
  const roadOrder = ["path", "service", "minor", "medium", "major", "highway"];
  const plain = ["all", notTunnel, ["!", isBridge]];
  const layerRoads = (suffix, base) => {
    for (const cls of roadOrder) {
      const w = ROAD_W[cls];
      if (!w.c) continue;
      L.push({
        id: `roads_${cls}_case${suffix}`, type: "line", source: src, "source-layer": "roads", minzoom: w.min,
        filter: ["all", base, ROAD_CLASSES[cls]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": p[`${cls}Case`] || p.minorCase, "line-width": w.c },
      });
    }
    for (const cls of roadOrder) {
      const w = ROAD_W[cls];
      const paint = { "line-color": p[cls], "line-width": cls === "major" || cls === "highway" ? linkWidth(w.w) : w.w };
      if (cls === "path") paint["line-dasharray"] = [2, 1.4];
      L.push({
        id: `roads_${cls}${suffix}`, type: "line", source: src, "source-layer": "roads", minzoom: w.min,
        filter: ["all", base, ROAD_CLASSES[cls]],
        layout: { "line-cap": cls === "path" ? "butt" : "round", "line-join": "round" },
        paint,
      });
    }
  };
  layerRoads("", plain);
  L.push({
    id: "roads_rail", type: "line", source: src, "source-layer": "roads", minzoom: 11,
    filter: ["all", notTunnel, isKind("rail")],
    paint: { "line-color": p.rail, "line-width": width([[11, 0.6], [15, 1.4], [18, 2.4]]), "line-dasharray": [3, 2] },
  });
  L.push({
    id: "transit_rail", type: "line", source: src, "source-layer": "transit", minzoom: 11,
    filter: ["all", notTunnel, isKind("rail")],
    paint: { "line-color": p.rail, "line-width": width([[11, 0.6], [15, 1.4], [18, 2.4]]), "line-dasharray": [3, 2] },
  });
  layerRoads("_bridge", isBridge);

  L.push({
    id: "boundaries", type: "line", source: src, "source-layer": "boundaries",
    filter: ["<=", ["coalesce", ["get", "kind_detail"], ["get", "pmap:min_admin_level"], 4], 4],
    paint: { "line-color": p.boundary, "line-width": 1, "line-dasharray": [3, 2] },
  });

  // Односторонние улицы — стрелки «›» вдоль линии.
  L.push({
    id: "roads_oneway", type: "symbol", source: src, "source-layer": "roads", minzoom: 16,
    filter: ["all", ["any", ["==", ["get", "oneway"], "yes"], ["==", ["get", "oneway"], true]], isKind("major_road", "medium_road", "minor_road")],
    layout: {
      "symbol-placement": "line", "symbol-spacing": 120, "text-field": "›", "text-font": MED,
      "text-size": 16, "text-keep-upright": false, "text-rotation-alignment": "map", "text-allow-overlap": false,
    },
    paint: { "text-color": p.oneway },
  });

  // Подписи воды.
  L.push({
    id: "water_label", type: "symbol", source: src, "source-layer": "water", minzoom: 12,
    filter: ["all", ["==", ["geometry-type"], "Point"], ["!=", NAME, ""]],
    layout: { "text-field": NAME, "text-font": REG, "text-size": 12, "text-max-width": 7 },
    paint: { "text-color": p.waterLabel, "text-halo-color": p.halo, "text-halo-width": 1 },
  });

  // Названия улиц.
  L.push({
    id: "roads_labels", type: "symbol", source: src, "source-layer": "roads", minzoom: 13,
    filter: ["all", ["!=", NAME, ""], isKind("highway", "major_road", "medium_road", "minor_road", "path")],
    layout: {
      "symbol-placement": "line", "symbol-spacing": 280, "text-field": NAME, "text-font": REG,
      "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 16, 12, 18, 14],
      "text-max-angle": 30, "text-padding": 2,
    },
    paint: { "text-color": p.roadLabel, "text-halo-color": p.halo, "text-halo-width": 1.6 },
  });

  // Номера домов — то, что курьеру нужнее всего.
  L.push({
    id: "address_label", type: "symbol", source: src, "source-layer": "buildings", minzoom: 16.5,
    filter: ["all", ["==", KIND, "address"], ["has", "addr_housenumber"]],
    layout: { "text-field": ["get", "addr_housenumber"], "text-font": REG, "text-size": ["interpolate", ["linear"], ["zoom"], 16.5, 10, 19, 13], "text-padding": 1 },
    paint: { "text-color": p.house, "text-halo-color": p.halo, "text-halo-width": 1.2 },
  });

  // Станции и заметные места.
  L.push({
    id: "pois_station", type: "symbol", source: src, "source-layer": "pois", minzoom: 13,
    filter: ["all", isKind("station", "subway_entrance"), ["!=", NAME, ""]],
    layout: { "text-field": ["concat", "М · ", NAME], "text-font": MED, "text-size": 12, "text-max-width": 8, "text-padding": 6 },
    paint: { "text-color": p.station, "text-halo-color": p.halo, "text-halo-width": 1.4 },
  });
  L.push({
    id: "pois", type: "symbol", source: src, "source-layer": "pois", minzoom: 15,
    filter: ["all", isKind("park", "garden", "university", "college", "hospital", "stadium", "mall", "marketplace", "theatre", "museum", "cinema", "zoo", "attraction"), ["!=", NAME, ""]],
    layout: { "text-field": NAME, "text-font": REG, "text-size": 11, "text-max-width": 8, "text-padding": 8 },
    paint: { "text-color": p.poi, "text-halo-color": p.halo, "text-halo-width": 1.2 },
  });

  // Районы и города.
  L.push({
    id: "places_subplace", type: "symbol", source: src, "source-layer": "places", minzoom: 11,
    filter: isKind("neighbourhood", "macrohood", "suburb", "quarter"),
    layout: {
      "text-field": NAME, "text-font": REG, "text-transform": "uppercase", "text-letter-spacing": 0.08,
      "text-size": ["interpolate", ["linear"], ["zoom"], 11, 9, 15, 12], "text-max-width": 7, "text-padding": 6,
    },
    paint: { "text-color": p.labelSoft, "text-halo-color": p.halo, "text-halo-width": 1.4 },
  });
  L.push({
    id: "places_locality", type: "symbol", source: src, "source-layer": "places",
    filter: isKind("locality"),
    layout: {
      "text-field": NAME, "text-font": MED, "text-max-width": 8, "text-padding": 4,
      "text-size": ["interpolate", ["linear"], ["zoom"], 4, ["case", ["<=", ["coalesce", ["get", "population_rank"], ["get", "pmap:population_rank"], 0], 10], 10, 12], 10, 15, 14, 18],
    },
    paint: { "text-color": p.place, "text-halo-color": p.halo, "text-halo-width": 1.8 },
  });
  L.push({
    id: "places_region", type: "symbol", source: src, "source-layer": "places", maxzoom: 8,
    filter: isKind("region"),
    layout: { "text-field": NAME, "text-font": REG, "text-size": 11, "text-transform": "uppercase", "text-letter-spacing": 0.1 },
    paint: { "text-color": p.labelSoft, "text-halo-color": p.halo, "text-halo-width": 1.2 },
  });

  const source = {
    type: "vector",
    tiles: [tilesUrl],
    minzoom: Number.isFinite(info.minzoom) ? info.minzoom : 0,
    maxzoom: Number.isFinite(info.maxzoom) ? info.maxzoom : 15,
    attribution: "© OpenStreetMap",
  };
  if (Array.isArray(info.bounds) && info.bounds.length === 4) source.bounds = info.bounds;

  return {
    version: 8,
    name: `ZalPOS ${theme === "dark" ? "тёмная" : "светлая"}`,
    glyphs: glyphsUrl,
    sources: { [src]: source },
    layers: L,
  };
}

const api = { buildStyle, PALETTES };
if (typeof module === "object" && module.exports) module.exports = api;
else self.ZalMapStyle = api;
})();
