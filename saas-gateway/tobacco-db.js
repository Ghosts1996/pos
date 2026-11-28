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
  { name: "Darkside", aka: ["dark side", "дарксайд", "дарк сайд"], look: "чёрная матовая банка, крупный белый логотип DARKSIDE, цветная наклейка вкуса латиницей; линейка подписана на банке (CORE, BASE, RARE, XPERIENCE, SHOT)", lines: "Core, Base (крепче), Rare, Xperience, Shot" },
  { name: "Musthave", aka: ["must have", "маст хэв", "мастхэв", "мастхев"], look: "чёрная банка, крупный белый рукописный логотип MUSTHAVE, подпись «Undercoal» и «табак, каким он должен быть», вкус белыми буквами «с ароматом …»", lines: "" },
  { name: "Black Burn", aka: ["blackburn", "блэк бёрн", "блэк берн", "блек берн"], look: "чёрная банка, логотип BLACK BURN, яркая рисованная этикетка вкуса, название вкуса по-русски; линейка Shock подписана SHOCK", lines: "обычная, Shock (крепче)" },
  { name: "Burn", aka: ["бёрн", "берн"], look: "чёрная банка, красная лента, белый логотип BURN, вкус белыми буквами («Мармелад с колой»)", lines: "" },
  { name: "Banger", aka: ["бангер", "бэнгер", "бенгер"], look: "чёрная банка, жёлтые ленты с крупной стилизованной буквой «B» и надписью BANGER, вкус в кавычках на жёлтой ленте", lines: "" },
  { name: "Overdose", aka: ["овердоз", "over dose"], look: "чёрная банка, цветная лента (часто фиолетовая) со звёздочками-искрами по краям, «с ароматом» и вкус в кавычках («Мята», «Пако Рабан»)", lines: "" },
  { name: "Element", aka: ["элемент"], look: "банка со знаком стихии; цвет по линейке: Вода — синий, Воздух — светлый, Земля — коричнево-зелёный, Огонь — красный", lines: "Вода, Воздух (мягче), Земля, Огонь (крепче)" },
  { name: "Spectrum", aka: ["спектрум"], look: "логотип SPECTRUM tobacco, вкус крупно на цветной наклейке («мощная мята»); на ленте надпись линейки — CLASSIC LINE, HARD LINE или KITCHEN LINE", lines: "Classic Line (светлая банка, мягче), Hard Line (тёмная банка, крепче), Kitchen Line (гастрономичные вкусы)" },
  { name: "NАШ", aka: ["nash", "наш"], look: "белая банка, лента с геометрическим узором, надпись «NАШ с ароматом …», вкус по-русски («бузина», «черника ромашка»)", lines: "" },
  { name: "Северный", aka: ["severny", "северный табак", "север"], look: "цветные ленты с рисунком-скетчем, надпись СЕВЕРНЫЙ или СЕВЕР", lines: "" },
  { name: "Timeline", aka: ["таймлайн", "timelime"], look: "белая банка, надпись TIMELINE, вкус на цветной ленте («лайм»)", lines: "" },
  { name: "Deus", aka: ["деус"], look: "серебристая лента с надписью DEUS, ниже «аромат …» мелко; название вкуса — на верхней наклейке крышки («ORANGE TIC TAC»); линейка PERFUME — парфюмированная, вкусы по мотивам духов (Balenciaga 100%, Varanasi, Buio, Ganymede, Black Afgano, But Not Today, Last Season, Vanilla Blend, Oud for Happiness)", lines: "обычная, Perfume (парфюмная)" },
  { name: "Sarma", aka: ["сарма"], look: "надпись САРМА или SARMA на ленте, вкус по-русски; линейка 360 подписана «360»", lines: "обычная, 360" },
  { name: "Trofimoff's", aka: ["trofimoff", "trofimoffs", "трофимов", "трофимофф", "terror", "террор"], look: "надпись TROFIMOFF'S; на ленте часто только название линейки. TERROR — это линейка Trofimoff's Terror (brand = Trofimoff's, line = Terror), не отдельная марка. Красная банка — линейка Burley", lines: "Classic, Burley (красная банка, крепче), Terror (крепкая)" },
  { name: "Bonche", aka: ["бонче", "бонш", "бонч"], look: "крафтовая банка цвета бумаги, надпись BONCHE, вкус крупно латиницей (SALAMI, SESAME)", lines: "" },
  { name: "Dogma", aka: ["догма"], look: "надпись DOGMA, тёмная банка", lines: "" },
  { name: "Хулиган", aka: ["hooligan", "huligan"], look: "надпись ХУЛИГАН / HOOLIGAN, дерзкий рисунок; линейка Hard подписана HARD", lines: "обычная, Hard (крепче)" },
  { name: "Sebero", aka: ["себеро"], look: "надпись SEBERO; у линейки Black — тёмное оформление и надпись BLACK", lines: "Classic, Black (тёмная банка, крепче)" },
  { name: "Duft", aka: ["дуфт"], look: "надпись DUFT; линейка подписана на ленте (STRONG, PHEROMONE, ALL-IN)", lines: "Pheromone, Strong (крепче), All-in" },
  { name: "Satyr", aka: ["сатир"], look: "надпись SATYR, рисунок сатира", lines: "" },
  { name: "Jent", aka: ["джент"], look: "надпись JENT; линейка Cigar подписана CIGAR", lines: "Cigar (крепче)" },
  { name: "Tangiers", aka: ["танжирс", "noir", "нуар"], look: "простая банка или жестянка с наклейкой Tangiers и названием вкуса; надпись NOIR — это линейка Tangiers Noir", lines: "Noir, Birquq, F-Line (очень крепкие)" },
  { name: "WTO", aka: ["вто", "world tobacco original"], look: "надпись WTO / World Tobacco Original, линейки по странам листа", lines: "" },
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
  { name: "Dedushka", aka: ["дедушка"], look: "надпись ДЕДУШКА, ретро-оформление", lines: "" },
  { name: "Chabacco", aka: ["чабакко"], look: "надпись CHABACCO — чайная смесь без табака", lines: "" },
  { name: "Brusko", aka: ["бруско"], look: "надпись BRUSKO", lines: "" },
  { name: "Zomo", aka: ["зомо"], look: "надпись ZOMO", lines: "" },
  { name: "Sapphire Crown", aka: ["сапфир кроун"], look: "надпись SAPPHIRE CROWN с короной, синие тона", lines: "" },
  { name: "Original Virginia", aka: ["ориджинал вирджиния"], look: "надпись ORIGINAL VIRGINIA", lines: "" },
  { name: "Frigate", aka: ["фригат", "фрегат"], look: "надпись FRIGATE — сухой табак без глицерина для крепости, вкуса часто нет", lines: "" },
  { name: "Al Fakher", aka: ["alfakher", "аль факер", "альфакер"], look: "яркая банка или коробка с надписью AL FAKHER и рисунком фрукта", lines: "" },
  { name: "Adalya", aka: ["адалия", "адалья"], look: "яркая банка с надписью ADALYA и рисунком фруктов, вкусы латиницей («Love 66», «Lady Killer»)", lines: "обычная; Black — тёмная упаковка с надписью BLACK, крепче" },
  { name: "Serbetli", aka: ["щербетли", "шербетли"], look: "надпись SERBETLI, рисунок фрукта", lines: "" },
  { name: "Fumari", aka: ["фумари"], look: "надпись FUMARI", lines: "" },
  { name: "Starbuzz", aka: ["старбаз"], look: "надпись STARBUZZ со звездой", lines: "" },
  { name: "Nakhla", aka: ["нахла"], look: "надпись NAKHLA, зелёные тона; линейки подписаны (MIZO, MIX)", lines: "классика, Mizo, Mix (мягче)" },
];

// Из каталога кассы: известные банки, все марки с синонимами и видом
// (classic/light/mixed/dark/strong/herbal), линейки с крепостью.
let db = { cans: {}, brands: [], lines: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(path.join(__dirname, "tobacco-cans.json"), "utf8")) };
} catch (_) {
  /* без файла — только BRANDS */
}
const cans = db.cans || {};
const KIND_WORD = { classic: "классика на светлом листе", light: "светлый лист", medium: "средняя крепость", mixed: "смешанный лист",
  dark: "тёмный лист, крепкий", strong: "крепкий тёмный лист", herbal: "без табака" };

const key = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]/g, "");

/** Марка к одному написанию: «BLACKBURN», «блэк берн» → «Black Burn». */
function canonicalBrand(raw) {
  const k = key(raw);
  if (!k) return String(raw || "").trim();
  for (const b of BRANDS) {
    if (key(b.name) === k || b.aka.some((a) => key(a) === k)) return b.name;
  }
  for (const b of db.brands || []) {
    if (key(b.name) === k || (b.aka || []).some((a) => key(a) === k)) return b.name;
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
  const linesOf = (name) => ((db.lines || {})[name] || []).map((l) => l.line).filter((l) => /^[a-z0-9]/i.test(l) || /^[а-я]/i.test(l));
  for (const b of BRANDS) {
    const known = (cans[b.name] || []).map((c) => c.names[0]).slice(0, namesPerBrand);
    const lineList = b.lines || linesOf(b.name).join(", ");
    lines.push(`• ${b.name}${b.aka.length ? ` (${b.aka.slice(0, 3).join(", ")})` : ""} — ${b.look}.`
      + (lineList ? ` Линейки: ${lineList}.` : "")
      + (known.length ? ` Вкусы марки: ${known.join(", ")}.` : ""));
  }
  // Остальные марки — по надписи на банке (вид оформления у них разный).
  const rest = (db.brands || []).filter((b) => !BRANDS.some((x) => x.name === b.name));
  if (rest.length) {
    lines.push(`Ещё марки (узнавай по надписи на банке, пиши так): ${rest.map((b) => {
      const ls = linesOf(b.name);
      const ru = (b.aka || []).find((a) => /[а-я]/i.test(a));
      return `${b.name}${ru ? ` / ${ru}` : ""}${ls.length ? ` [линейки ${ls.join(", ")}]` : ""}`;
    }).join("; ")}.`);
  }
  return lines.join("\n");
}

/** Вид марки словами (для подсказок): «тёмный лист, крепкий». */
function kindOf(brand) {
  const b = (db.brands || []).find((x) => x.name === canonicalBrand(brand));
  return b ? KIND_WORD[b.kind] || "" : "";
}

/** Правка ответа ИИ по базе: марка к одному написанию, пустая марка — по известному вкусу. */
/** Линейка из надписи марки: «TERROR» → Trofimoff's, линейка Terror; «Darkside Shot» → Shot. */
function lineFromBrand(raw, brand) {
  const t = ` ${String(raw || "").toLowerCase().replace(/ё/g, "е")} `;
  for (const l of ((db.lines || {})[brand] || [])) {
    const k = l.line;
    if (new RegExp(`[^a-zа-я0-9]${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-zа-я0-9])`).test(t)) {
      if (k === "нуар") return "Noir";
      if (k === "террор") return "Terror";
      return k[0].toUpperCase() + k.slice(1);
    }
  }
  return "";
}

function enrich(items) {
  for (const it of items) {
    if (it.brand) {
      const raw = it.brand;
      it.brand = canonicalBrand(raw);
      if (!it.line && it.brand !== raw) {
        const l = lineFromBrand(raw, it.brand);
        if (l) it.line = l;
      }
    }
    if (!it.brand) {
      const b = brandByName(it.name);
      if (b) it.brand = b;
    }
  }
  return items;
}

module.exports = { BRANDS, canonicalBrand, brandByName, promptCatalog, enrich, kindOf, cans: () => cans, brands: () => db.brands || [] };
