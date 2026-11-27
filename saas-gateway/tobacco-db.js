"use strict";
// База табаков для распознавания полки: как выглядят банки марок, линейки и
// известные вкусы (из каталога кассы — tobacco-cans.json). Из неё собирается
// подсказка ИИ (как узнать марку по одной стороне банки) и правка ответа:
// марка к одному написанию, марка по известному названию вкуса.
//
// Вид банок — ориентир по оформлению марок (логотип, цвет банки и ленты);
// у марок бывают переиздания, поэтому главное — надпись, а вид — когда
// надписи не видно. Крепость, жаростойкость и лист — на кассе
// (lib/services/hookah/brand_profiles.dart).

const fs = require("fs");
const path = require("path");

/** name — как пишем; aka — как ещё пишут на банках и говорят; look — вид; lines — линейки. */
const BRANDS = [
  { name: "Darkside", aka: ["dark side", "дарксайд", "дарк сайд"], look: "чёрная матовая банка, крупный белый логотип DARKSIDE, цветная наклейка вкуса латиницей", lines: "Core, Base (крепче), Rare, Xperience" },
  { name: "Musthave", aka: ["must have", "маст хэв", "мастхэв", "мастхев"], look: "чёрная банка, крупный белый рукописный логотип MUSTHAVE, подпись «Undercoal» и «табак, каким он должен быть», вкус белыми буквами «с ароматом …»", lines: "" },
  { name: "Black Burn", aka: ["blackburn", "блэк бёрн", "блэк берн", "блек берн"], look: "чёрная банка, логотип BLACK BURN, яркая рисованная этикетка вкуса, название вкуса по-русски", lines: "" },
  { name: "Burn", aka: ["бёрн", "берн"], look: "чёрная банка, красная лента, белый логотип BURN, вкус белыми буквами («Мармелад с колой»)", lines: "" },
  { name: "Banger", aka: ["бангер", "бэнгер", "бенгер"], look: "чёрная банка, жёлтые ленты с крупной стилизованной буквой «B» и надписью BANGER, вкус в кавычках на жёлтой ленте", lines: "" },
  { name: "Overdose", aka: ["овердоз", "over dose"], look: "чёрная банка, цветная лента (часто фиолетовая) со звёздочками-искрами по краям, «с ароматом» и вкус в кавычках («Мята», «Пако Рабан»)", lines: "" },
  { name: "Element", aka: ["элемент"], look: "банка со знаком стихии; цвет по линейке: Вода — синий, Воздух — светлый, Земля — коричнево-зелёный, Огонь — красный", lines: "Вода, Воздух (мягче), Земля, Огонь (крепче)" },
  { name: "Spectrum", aka: ["спектрум"], look: "белая банка, логотип SPECTRUM tobacco, вкус крупно на цветной наклейке («мощная мята»)", lines: "Classic (мягче), Hard Line (крепче), Kitchen Line (гастрономичные вкусы)" },
  { name: "NАШ", aka: ["nash", "наш"], look: "белая банка, лента с геометрическим узором, надпись «NАШ с ароматом …», вкус по-русски («бузина», «черника ромашка»)", lines: "" },
  { name: "Северный", aka: ["severny", "северный табак", "север"], look: "цветные ленты с рисунком-скетчем, надпись СЕВЕРНЫЙ или СЕВЕР", lines: "" },
  { name: "Timeline", aka: ["таймлайн", "timelime"], look: "белая банка, надпись TIMELINE, вкус на цветной ленте («лайм»)", lines: "" },
  { name: "Deus", aka: ["деус"], look: "серебристая лента с надписью DEUS, ниже «аромат …» мелко; название вкуса — на верхней наклейке крышки («ORANGE TIC TAC»)", lines: "" },
  { name: "Sarma", aka: ["сарма"], look: "надпись САРМА или SARMA на ленте, вкус по-русски", lines: "" },
  { name: "Trofimoff", aka: ["trofimoff's", "трофимов", "трофимофф"], look: "надпись TROFIMOFF'S, строгая банка", lines: "Classic, Burley (крепче)" },
  { name: "Bonche", aka: ["бонче", "бонш", "бонч"], look: "крафтовая банка цвета бумаги, надпись BONCHE, вкус крупно латиницей (SALAMI, SESAME)", lines: "" },
  { name: "Dogma", aka: ["догма"], look: "надпись DOGMA, тёмная банка", lines: "" },
  { name: "Хулиган", aka: ["hooligan", "huligan"], look: "надпись ХУЛИГАН / HOOLIGAN, дерзкий рисунок", lines: "Hard (крепче)" },
  { name: "Sebero", aka: ["себеро"], look: "надпись SEBERO", lines: "Classic, Black (крепче)" },
  { name: "Duft", aka: ["дуфт"], look: "надпись DUFT", lines: "Pheromone, Strong (крепче), All-in" },
  { name: "Satyr", aka: ["сатир"], look: "надпись SATYR, рисунок сатира", lines: "" },
  { name: "Jent", aka: ["джент"], look: "надпись JENT", lines: "Cigar (крепче)" },
  { name: "Tangiers", aka: ["танжирс"], look: "простая банка или жестянка с наклейкой Tangiers и названием вкуса", lines: "Noir, Birquq, F-Line (очень крепкие)" },
  { name: "WTO", aka: ["вто", "world tobacco original"], look: "надпись WTO / World Tobacco Original, линейки по странам листа", lines: "" },
  { name: "Noir", aka: ["нуар"], look: "тёмная банка, надпись NOIR", lines: "" },
  { name: "Blanch", aka: ["бланш", "бланч"], look: "светлая банка, надпись BLANCH", lines: "" },
  { name: "Timeless", aka: ["таймлесс"], look: "надпись TIMELESS", lines: "" },
  { name: "Kraken", aka: ["кракен"], look: "надпись KRAKEN, рисунок осьминога/кракена", lines: "" },
  { name: "Daily Hookah", aka: ["дейли хука"], look: "надпись DAILY HOOKAH, яркие цвета", lines: "" },
  { name: "Palitra", aka: ["палитра"], look: "надпись ПАЛИТРА, разноцветная банка", lines: "" },
  { name: "MattPear", aka: ["matt pear", "мэтт пир"], look: "надпись MattPear", lines: "" },
  { name: "Craftium", aka: ["крафтиум"], look: "надпись CRAFTIUM", lines: "" },
  { name: "Starline", aka: ["старлайн"], look: "надпись STARLINE со звездой", lines: "" },
  { name: "Morpheus", aka: ["морфеус"], look: "надпись MORPHEUS", lines: "" },
  { name: "Lastochka", aka: ["ласточка"], look: "надпись ЛАСТОЧКА с птицей-ласточкой", lines: "" },
  { name: "Terror", aka: ["террор"], look: "чёрная банка, надпись TERROR", lines: "" },
  { name: "Dedushka", aka: ["дедушка"], look: "надпись ДЕДУШКА, ретро-оформление", lines: "" },
  { name: "Chabacco", aka: ["чабакко"], look: "надпись CHABACCO — чайная смесь без табака", lines: "" },
  { name: "Brusko", aka: ["бруско"], look: "надпись BRUSKO", lines: "" },
  { name: "Zomo", aka: ["зомо"], look: "надпись ZOMO", lines: "" },
  { name: "Sapphire Crown", aka: ["сапфир кроун"], look: "надпись SAPPHIRE CROWN с короной, синие тона", lines: "" },
  { name: "Original Virginia", aka: ["ориджинал вирджиния"], look: "надпись ORIGINAL VIRGINIA", lines: "" },
  { name: "Frigate", aka: ["фригат", "фрегат"], look: "надпись FRIGATE — сухой табак без глицерина для крепости, вкуса часто нет", lines: "" },
  { name: "Al Fakher", aka: ["alfakher", "аль факер", "альфакер"], look: "яркая банка или коробка с надписью AL FAKHER и рисунком фрукта", lines: "" },
  { name: "Adalya", aka: ["адалия", "адалья"], look: "яркая банка с надписью ADALYA и рисунком фруктов, вкусы латиницей («Love 66», «Lady Killer»)", lines: "" },
  { name: "Serbetli", aka: ["щербетли", "шербетли"], look: "надпись SERBETLI, рисунок фрукта", lines: "" },
  { name: "Fumari", aka: ["фумари"], look: "надпись FUMARI", lines: "" },
  { name: "Starbuzz", aka: ["старбаз"], look: "надпись STARBUZZ со звездой", lines: "" },
  { name: "Nakhla", aka: ["нахла"], look: "надпись NAKHLA, зелёные тона", lines: "" },
];

let cans = {};
try {
  cans = JSON.parse(fs.readFileSync(path.join(__dirname, "tobacco-cans.json"), "utf8"));
} catch (_) {
  cans = {};
}

const key = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]/g, "");

/** Марка к одному написанию: «BLACKBURN», «блэк берн» → «Black Burn». */
function canonicalBrand(raw) {
  const k = key(raw);
  if (!k) return String(raw || "").trim();
  for (const b of BRANDS) {
    if (key(b.name) === k || b.aka.some((a) => key(a) === k)) return b.name;
  }
  for (const b of Object.keys(cans)) if (key(b) === k) return b;
  return String(raw || "").trim();
}

/** Марка по известному названию вкуса, если оно есть только у одной марки. */
function brandByName(name) {
  const k = key(name);
  if (k.length < 4) return "";
  const found = new Set();
  for (const [brand, list] of Object.entries(cans)) {
    if (list.some((c) => c.names.some((n) => key(n) === k))) found.add(brand);
  }
  if (found.size !== 1) return "";
  // Однословное короткое название («Мята») бывает у всех — по нему марку не ставим.
  const plain = String(name || "").trim();
  if (plain.split(/\s+/).length < 2 && plain.length < 10) return "";
  return [...found][0];
}

/** Текст для подсказки ИИ: как выглядят банки марок и их известные вкусы. */
function promptCatalog({ namesPerBrand = 30 } = {}) {
  const lines = [];
  for (const b of BRANDS) {
    const known = (cans[b.name] || []).map((c) => c.names[0]).slice(0, namesPerBrand);
    lines.push(`• ${b.name}${b.aka.length ? ` (${b.aka.slice(0, 3).join(", ")})` : ""} — ${b.look}.`
      + (b.lines ? ` Линейки: ${b.lines}.` : "")
      + (known.length ? ` Вкусы марки: ${known.join(", ")}.` : ""));
  }
  return lines.join("\n");
}

/** Правка ответа ИИ по базе: марка к одному написанию, пустая марка — по известному вкусу. */
function enrich(items) {
  for (const it of items) {
    if (it.brand) it.brand = canonicalBrand(it.brand);
    if (!it.brand) {
      const b = brandByName(it.name);
      if (b) it.brand = b;
    }
  }
  return items;
}

module.exports = { BRANDS, canonicalBrand, brandByName, promptCatalog, enrich, cans: () => cans };
