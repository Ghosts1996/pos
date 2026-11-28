"use strict";
// Известные банки табака — из каталога кассы (lib/services/hookah/tobacco_catalog.dart,
// kKnownCanLines) в tobacco-cans.json для сервера: одна база на кассу и сервер.
// Запуск: node tools/tobacco-cans-from-dart.js  (тест test.tobacco.js сверяет, что файл свежий).
const fs = require("fs");
const path = require("path");

function parseDart(src) {
  const start = src.indexOf("const List<String> kKnownCanLines = [");
  const end = src.indexOf("];", start);
  const body = src.slice(start, end);
  const out = {};
  for (const m of body.matchAll(/^\s*(['"])(.+?)\1,\s*$/gm)) {
    const [brand, names, flavors] = m[2].split("|");
    if (!brand || !names) continue;
    (out[brand] = out[brand] || []).push({
      names: names.split(";").map((s) => s.trim()).filter(Boolean),
      flavors: String(flavors || "").split(",").map((s) => s.trim()).filter(Boolean),
    });
  }
  return out;
}

/** Марки: основной список (TobaccoBrand(...)) и дополнительный (kMoreBrandLines). */
function parseBrands(src) {
  const out = [];
  const main = src.slice(src.indexOf("const List<TobaccoBrand> kTobaccoBrands = ["), src.indexOf("];", src.indexOf("const List<TobaccoBrand> kTobaccoBrands = [")));
  for (const m of main.matchAll(/TobaccoBrand\((?:'((?:[^'\\]|\\.)+)'|"([^"]+)"), \[([^\]]*)\], '(\w+)'\)/g)) {
    const aka = [...m[3].matchAll(/'((?:[^'\\]|\\.)+)'|"([^"]+)"/g)].map((x) => (x[1] || x[2]).replace(/\\'/g, "'"));
    out.push({ name: (m[1] || m[2]).replace(/\\'/g, "'"), aka, kind: m[4] });
  }
  const more = src.slice(src.indexOf("const List<String> kMoreBrandLines = ["), src.indexOf("];", src.indexOf("const List<String> kMoreBrandLines = [")));
  for (const m of more.matchAll(/'((?:[^'\\]|\\.)+)'/g)) {
    const [name, aka, kind] = m[1].replace(/\\'/g, "'").split("|");
    if (!name || !kind || out.some((b) => b.name === name)) continue;
    out.push({ name, aka: String(aka || "").split(";").map((s) => s.trim()).filter(Boolean), kind });
  }
  return out;
}

/** Линейки с крепостью (kLineStrength в brand_profiles.dart). */
function parseLines(src) {
  const start = src.indexOf("const Map<String, Map<String, int>> kLineStrength = {");
  const body = src.slice(start, src.indexOf("};", start));
  const out = {};
  for (const m of body.matchAll(/(?:'([^']+)'|"([^"]+)"): \{([^}]*)\}/g)) {
    out[m[1] || m[2]] = [...m[3].matchAll(/'([^']+)': (\d+)/g)].map((x) => ({ line: x[1], strength: Number(x[2]) }));
  }
  return out;
}

function build(repoRoot) {
  const dart = fs.readFileSync(path.join(repoRoot, "lib/services/hookah/tobacco_catalog.dart"), "utf8");
  const prof = fs.readFileSync(path.join(repoRoot, "lib/services/hookah/brand_profiles.dart"), "utf8");
  return { cans: parseDart(dart), brands: parseBrands(dart), lines: parseLines(prof) };
}

if (require.main === module) {
  const root = path.join(__dirname, "..", "..");
  const data = build(root);
  fs.writeFileSync(path.join(__dirname, "..", "tobacco-cans.json"), JSON.stringify(data, null, 1) + "\n");
  console.log(`банок: ${Object.values(data.cans).reduce((a, l) => a + l.length, 0)}, марок: ${data.brands.length}, линеек у марок: ${Object.keys(data.lines).length}`);
}
module.exports = { parseDart, parseBrands, parseLines, build };
