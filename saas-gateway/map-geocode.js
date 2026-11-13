"use strict";
/**
 * Свой поиск адреса (адрес → точка на карте) по домам OpenStreetMap — без
 * внешних сервисов: адрес гостя никуда не уходит.
 *
 *  • build(oplLines, bbox) — справочник домов района из выгрузки OSM в формате
 *    OPL (osmium tags-filter nw/addr:housenumber + add-locations-to-ways):
 *    точки с адресом и здания (центр по углам). Сборка — map-build.js, файл
 *    addr-<район>.json рядом с графом дорог.
 *  • createIndex(data).find(text, near) — «Невский пр., 100» → { lat, lng }.
 *    Названия улиц сравниваются без типа («ул.», «пр-т», «наб.»), ё = е;
 *    одинаковые улицы в разных городах района — берём ближайшую к заведению.
 *    Нет точного дома — ближайший номер той же чётности (approx).
 */

const TYPE_WORDS = new Set([
  "улица", "ул", "проспект", "пр", "пр-т", "пр-кт", "пркт", "просп", "набережная", "наб", "площадь", "пл",
  "переулок", "пер", "шоссе", "ш", "бульвар", "б-р", "бул", "проезд", "пр-д", "аллея", "ал", "тупик", "туп",
  "дорога", "дор", "спуск", "мост", "линия", "лин", "микрорайон", "мкр", "квартал", "кв-л", "территория", "тер",
  "street", "avenue",
]);
// Слова, по которым отличают «Малую Садовую» от «Садовой», — оставляем.
const CITY_RE = /^(?:г\.?|город)?\s*(?:санкт[-\s]?петербург|спб|с[-\s]?пб|петербург|москва|мск)\b[\s,]*/i;

const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[«»"'()]/g, " ").replace(/\s+/g, " ").trim();

/** «Малая Садовая ул.» → { key: "малая садовая", type: "улица" }. */
function streetKey(raw) {
  let s = norm(raw).replace(/[.,]/g, " ");
  // «В.О.», «П.С.» — часть названия линии.
  s = s.replace(/\bв\s*о\b/g, "во").replace(/\bп\s*с\b/g, "пс");
  // «2-я», «3-й», «2я» → «2»: номер улицы пишут по-разному.
  s = s.replace(/\b(\d+)\s*-?\s*(?:я|й|ая|ий|ой|е|го)\b/g, "$1");
  const words = s.split(" ").filter(Boolean);
  let type = "";
  const keep = [];
  for (const w of words) {
    if (TYPE_WORDS.has(w)) { if (!type) type = w; continue; }
    keep.push(w);
  }
  return { key: keep.join(" "), type };
}

/** «12 к2», «12к.2», «12 корпус 2», «28А», «28 лит. А» → «12к2», «28а». */
function houseKey(raw) {
  let s = norm(raw).replace(/^(?:дом|д)\.?\s*/, "");
  s = s.replace(/\s*(?:корпус|корп|кор|к)\.?\s*(\d+)/g, "к$1");
  s = s.replace(/\s*(?:строение|стр|с)\.?\s*(\d+)/g, "с$1");
  s = s.replace(/\s*(?:литера|литер|лит|л)\.?\s*([а-яa-z])\b/g, "$1");
  return s.replace(/[\s.,]/g, "");
}

const HOUSE_RE = /(?:^|[\s,])(?:(?:дом|д)\.?\s*)?(\d+[а-яa-z]?(?:\/\d+[а-яa-z]?)?(?:\s*(?:корпус|корп|кор|к)\.?\s*\d+)?(?:\s*(?:строение|стр|с)\.?\s*\d+)?(?:\s*(?:литера|литер|лит)\.?\s*[а-яa-z])?)\s*$/i;

/** «Санкт-Петербург, Невский пр., 100» → { street: "Невский пр.", house: "100" }. */
function parseAddress(text) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  s = s.replace(CITY_RE, "");
  // Квартира, подъезд и прочее — если гость вписал их в ту же строку.
  s = s.split(/,\s*(?=кв\b|кв\.|квартира|офис|оф\.|подъезд|под\.|этаж|эт\.|домофон)/i)[0].trim();
  const m = HOUSE_RE.exec(s);
  if (!m) return { street: s.replace(/[\s,]+$/, ""), house: "" };
  return { street: s.slice(0, m.index).replace(/[\s,]+$/, ""), house: m[1] };
}

const baseNumber = (h) => { const m = /^(\d+)/.exec(h); return m ? Number(m[1]) : NaN; };

function unescapeOpl(s) {
  return s.indexOf("%") < 0 ? s : s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function parseTags(raw) {
  const tags = {};
  if (!raw) return tags;
  for (const kv of raw.split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) tags[unescapeOpl(kv.slice(0, i))] = unescapeOpl(kv.slice(i + 1));
  }
  return tags;
}

/**
 * Справочник домов из строк OPL. readLines(cb) вызывает cb(line) для каждой
 * строки (как в map-graph.js). → { v, bbox, streets: { key: [[дом, lat, lng]] }, names: { key: "как в OSM" } }.
 */
async function build(readLines, bbox = null) {
  const streets = new Map();
  const names = new Map();
  let count = 0;
  const add = (tags, lat, lng) => {
    const street = tags["addr:street"] || tags["addr:place"];
    const house = tags["addr:housenumber"];
    if (!street || !house || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const { key } = streetKey(street);
    if (!key) return;
    // «12;14» и «12-14» — несколько номеров у одного здания.
    for (const part of String(house).split(/[;]/)) {
      const h = houseKey(part);
      if (!h) continue;
      if (!streets.has(key)) streets.set(key, []);
      streets.get(key).push([h, Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6]);
      if (!names.has(key)) names.set(key, street);
      count += 1;
    }
  };
  await readLines((line) => {
    const c = line.charCodeAt(0);
    if (c !== 110 /* n */ && c !== 119 /* w */) return;
    let tagsRaw = "";
    let x = NaN;
    let y = NaN;
    let nodesRaw = "";
    for (const f of line.split(" ")) {
      if (f[0] === "T") tagsRaw = f.slice(1);
      else if (f[0] === "x") x = Number(f.slice(1));
      else if (f[0] === "y") y = Number(f.slice(1));
      else if (f[0] === "N") nodesRaw = f.slice(1);
    }
    if (!tagsRaw || tagsRaw.indexOf("addr%3a") < 0 && tagsRaw.indexOf("addr:") < 0) return;
    const tags = parseTags(tagsRaw);
    if (!tags["addr:housenumber"]) return;
    if (c === 110) return add(tags, y, x);
    // Здание: центр по углам (координаты дописал add-locations-to-ways).
    let sx = 0, sy = 0, n = 0;
    for (const p of nodesRaw.split(",")) {
      const m = /x([-\d.]+)y([-\d.]+)$/.exec(p);
      if (!m) continue;
      sx += Number(m[1]); sy += Number(m[2]); n += 1;
    }
    if (n) add(tags, sy / n, sx / n);
  });
  return { v: 1, bbox, count, streets: Object.fromEntries(streets), names: Object.fromEntries(names) };
}

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function distanceM(a, b) {
  const R = 6371000;
  const rad = (v) => (v * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Поиск по справочнику района. */
function createIndex(data) {
  const streets = (data && data.streets) || {};
  const names = (data && data.names) || {};
  const keys = Object.keys(streets);
  // Порядок слов бывает разный: «проспект Невский», «Садовая Малая».
  const bySorted = new Map();
  for (const k of keys) {
    const s = k.split(" ").sort().join(" ");
    if (!bySorted.has(s)) bySorted.set(s, k);
  }

  function streetOf(raw) {
    const { key } = streetKey(raw);
    if (!key) return "";
    if (streets[key]) return key;
    const sorted = bySorted.get(key.split(" ").sort().join(" "));
    if (sorted) return sorted;
    // Опечатка: одна буква на 5+ символов, две — на 10+.
    if (key.length < 5) return "";
    const max = key.length >= 10 ? 2 : 1;
    let best = "";
    let bestD = max + 1;
    for (const k of keys) {
      if (k[0] !== key[0]) continue;
      const d = levenshtein(k, key, max);
      if (d < bestD) { best = k; bestD = d; }
    }
    return bestD <= max ? best : "";
  }

  /**
   * text — «улица, дом» как вводит гость; near — точка заведения (из двух
   * одинаковых улиц выбрать ближнюю). → null или { lat, lng, label, exact }.
   */
  function find(text, near = null) {
    const { street, house } = parseAddress(text);
    if (!street || !house) return null;
    const key = streetOf(street);
    if (!key) return null;
    const list = streets[key];
    const h = houseKey(house);
    const pick = (cands) => {
      if (!cands.length) return null;
      if (!near || cands.length === 1) return cands[0];
      return cands.reduce((a, b) => (distanceM(near, { lat: a[1], lng: a[2] }) <= distanceM(near, { lat: b[1], lng: b[2] }) ? a : b));
    };
    let hit = pick(list.filter((x) => x[0] === h));
    let exact = !!hit;
    if (!hit) {
      // «28А» нет — есть «28» (и наоборот); дальше — ближайший номер той же чётности.
      const n = baseNumber(h);
      if (!Number.isFinite(n)) return null;
      hit = pick(list.filter((x) => baseNumber(x[0]) === n));
      if (!hit) {
        const same = list.filter((x) => Number.isFinite(baseNumber(x[0])) && baseNumber(x[0]) % 2 === n % 2 && Math.abs(baseNumber(x[0]) - n) <= 20);
        if (!same.length) return null;
        const d = Math.min(...same.map((x) => Math.abs(baseNumber(x[0]) - n)));
        hit = pick(same.filter((x) => Math.abs(baseNumber(x[0]) - n) === d));
      }
      exact = false;
    }
    return { lat: hit[1], lng: hit[2], label: `${names[key] || street}, ${hit[0]}`, exact };
  }

  return { find, size: keys.length };
}

module.exports = { build, createIndex, parseAddress, streetKey, houseKey };

/* Командная строка: node map-geocode.js build <addr.opl> <out.json> [запад,юг,восток,север] */
if (require.main === module) {
  const [cmd, input, output, bboxRaw] = process.argv.slice(2);
  if (cmd !== "build" || !input || !output) {
    console.error("Использование: node map-geocode.js build <addr.opl> <out.json> [bbox]");
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
  const bbox = bboxRaw ? bboxRaw.split(",").map(Number) : null;
  build(readLines, bbox)
    .then((data) => {
      if (!data.count) throw new Error("в выгрузке нет адресов");
      const tmp = `${output}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, output);
      console.log(`готово: ${output} — домов ${data.count}, улиц ${Object.keys(data.streets).length}`);
    })
    .catch((e) => { console.error(`ошибка: ${e.message}`); process.exit(1); });
}
