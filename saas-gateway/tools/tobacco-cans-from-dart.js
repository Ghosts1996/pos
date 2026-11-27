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

function build(repoRoot) {
  const dart = fs.readFileSync(path.join(repoRoot, "lib/services/hookah/tobacco_catalog.dart"), "utf8");
  return parseDart(dart);
}

if (require.main === module) {
  const root = path.join(__dirname, "..", "..");
  const data = build(root);
  fs.writeFileSync(path.join(__dirname, "..", "tobacco-cans.json"), JSON.stringify(data, null, 1) + "\n");
  console.log(`банок: ${Object.values(data).reduce((a, l) => a + l.length, 0)}, марок: ${Object.keys(data).length}`);
}
module.exports = { parseDart, build };
