// Приход по накладной: УПД (универсальный передаточный документ) в XML —
// так его выгружают системы ЭДО (Диадок, СБИС, Контур и другие) и присылают
// поставщики. Здесь — только разбор и расчёты, без браузера и базы: файл →
// поставщик, номер, дата и строки товаров; сопоставление строк с позициями
// склада; перевод количества в единицы склада; средняя цена закупки.

/** Текст XML из байтов файла: кодировка из пролога (у ЭДО — windows-1251). */
export function decodeXml(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = new TextDecoder('latin1').decode(u8.slice(0, 200));
  const enc = (/encoding\s*=\s*["']([^"']+)["']/i.exec(head) || [])[1] || 'utf-8';
  try {
    return new TextDecoder(enc.toLowerCase()).decode(u8);
  } catch (_) {
    return new TextDecoder('utf-8').decode(u8);
  }
}

const ENT = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
const unescapeXml = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos);/gi, (_, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e.toLowerCase()] || '';
});

/** Атрибуты тега: <Тег А="1" Б="2"> → { А: '1', Б: '2' }. */
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\p{L}\p{N}_.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/gu)) out[m[1]] = unescapeXml(m[3] ?? m[4] ?? '');
  return out;
}
const firstTag = (xml, name) => {
  const m = new RegExp(`<${name}(\\s[^>]*)?\\/?>`, 'u').exec(xml);
  return m ? attrs(m[0]) : null;
};
const num = (v) => {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

// Коды ОКЕИ и подписи единиц → единицы склада кассы (g, kg, ml, l, pcs).
const OKEI = { '163': 'g', '166': 'kg', '111': 'ml', '112': 'l', '796': 'pcs', '778': 'pcs', '736': 'pcs', '839': 'pcs', '715': 'pcs', '868': 'pcs', '870': 'pcs' };
export function unitFrom(okei, label) {
  if (OKEI[String(okei || '').trim()]) return OKEI[String(okei).trim()];
  const l = String(label || '').toLowerCase().replace(/[.\s]/g, '');
  if (/^(кг|килограмм)/.test(l)) return 'kg';
  if (/^(г|гр|грамм)$/.test(l)) return 'g';
  if (/^(л|литр|дм3)/.test(l)) return 'l';
  if (/^(мл|миллилитр|см3)/.test(l)) return 'ml';
  if (/^(шт|штук|бут|бутыл|уп|упак|пач|пачк|бан|банк|кор|коробк|рул|компл|набор|пар)/.test(l)) return 'pcs';
  return '';
}

/**
 * Разбор УПД (формат ФНС 5.01–5.03): номер и дата, поставщик, строки.
 * Цена строки — за единицу накладной с НДС (себестоимость заведения).
 * → { number, date, supplier: { name, inn }, lines: [{ n, name, qty, unit, unitLabel, price, sum, vat }], total }
 */
export function parseUpd(xml) {
  const text = String(xml || '');
  if (!/<Файл[\s>]/u.test(text) || !/<СведТов[\s>]/u.test(text)) {
    throw new Error('Это не УПД: в файле нет строк товаров. Выгрузите из ЭДО именно XML-файл УПД (не PDF и не картинку).');
  }
  const head = firstTag(text, 'СвСчФакт') || firstTag(text, 'СвДокПТПрКорр') || {};
  const number = head.НомерСчФ || head.НомерДок || head.НомСчФ || '';
  const date = head.ДатаСчФ || head.ДатаДок || '';
  // Поставщик — первый блок СвПрод: организация или ИП.
  const prodBlock = (/<СвПрод[\s>][\s\S]*?<\/СвПрод>/u.exec(text) || [''])[0];
  let supplier = { name: '', inn: '' };
  const ul = firstTag(prodBlock, 'СвЮЛУч');
  const ip = firstTag(prodBlock, 'СвИП');
  if (ul) supplier = { name: ul.НаимОрг || '', inn: ul.ИННЮЛ || '' };
  else if (ip) {
    const fio = firstTag(prodBlock, 'ФИО') || {};
    supplier = { name: ['ИП', fio.Фамилия, fio.Имя, fio.Отчество].filter(Boolean).join(' '), inn: ip.ИННФЛ || '' };
  }
  const lines = [];
  for (const m of text.matchAll(/<СведТов(\s[^>]*)?\/?>/gu)) {
    const a = attrs(m[0]);
    const qty = num(a.КолТов);
    const name = String(a.НаимТов || '').replace(/\s+/g, ' ').trim();
    if (!name || !(qty > 0)) continue;
    const withVat = num(a.СтТовУчНал);
    const noVat = num(a.СтТовБезНДС);
    const rate = (/(\d+)/.exec(String(a.НалСт || '')) || [])[1];
    const sum = withVat > 0 ? withVat : noVat > 0 ? noVat * (1 + (rate ? Number(rate) / 100 : 0)) : num(a.ЦенаТов) * qty;
    lines.push({
      n: Number(a.НомСтр) || lines.length + 1,
      name, qty,
      unit: unitFrom(a.ОКЕИ_Тов, a.НаимЕдИзм),
      unitLabel: a.НаимЕдИзм || '',
      price: Math.round((sum / qty) * 100) / 100,
      sum: Math.round(sum * 100) / 100,
      vat: a.НалСт || '',
    });
  }
  if (!lines.length) throw new Error('В накладной нет строк с количеством — проверьте файл.');
  return { number, date, supplier, lines, total: Math.round(lines.reduce((s, l) => s + l.sum, 0) * 100) / 100 };
}

// ------------------------------------------------------------ единицы

const BASE = { g: ['mass', 1], kg: ['mass', 1000], ml: ['vol', 1], l: ['vol', 1000], pcs: ['pcs', 1] };
/** Количество из единиц накладной в единицы склада; null — несовместимы (кг и штуки). */
export function convertQty(qty, from, to) {
  const a = BASE[from];
  const b = BASE[to];
  if (!a || !b || a[0] !== b[0]) return null;
  return (qty * a[1]) / b[1];
}
/** Единица цены склада: за кг, литр или штуку (как InventoryUnit.priceUnit в кассе). */
export const priceUnit = (u) => (u === 'g' ? 'kg' : u === 'ml' ? 'l' : u);

/** Цена закупки за единицу цены склада (₽/кг, ₽/л, ₽/шт) из цены строки за её единицу. */
export function costPerPriceUnit(line, itemUnit) {
  const pu = priceUnit(itemUnit);
  const perOne = convertQty(1, line.unit || itemUnit, pu);
  if (!perOne) return 0;
  return Math.round((line.price / perOne) * 100) / 100;
}

/** Средняя цена закупки после прихода (средневзвешенная, как в учёте). */
export function averageCost(oldQty, oldCost, addQty, addCost) {
  if (!(addCost > 0)) return oldCost || 0;
  if (!(oldQty > 0) || !(oldCost > 0)) return addCost;
  return Math.round(((oldQty * oldCost + addQty * addCost) / (oldQty + addQty)) * 100) / 100;
}

// ------------------------------------------------------------ сопоставление

const STOP = new Set(['и', 'в', 'с', 'для', 'по', 'на', 'гост', 'ту', 'шт', 'кг', 'г', 'л', 'мл', 'упак', 'уп', 'бут']);
const words = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/["«»'(),.;:%/\\+-]/g, ' ')
  .split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+([.,]\d+)?$/.test(w));
// Основа слова — первые пять букв: «стаканы» и «стакан», «бумажные» и «бумажный» совпадут.
const stem = (w) => w.slice(0, 5);

/** Похожесть названий 0…1: общие слова (по основе) к числу слов короче из двух. */
export function similarity(a, b) {
  const A = new Set(words(a).map(stem));
  const B = new Set(words(b).map(stem));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size);
}

/** Позиция склада для строки: та же единица измерения (масса/объём/штуки) и похожее имя. */
export function matchItem(line, items, threshold = 0.6) {
  let best = null;
  for (const it of items || []) {
    if (!it || it.active === false) continue;
    if (line.unit && convertQty(1, line.unit, it.unit) === null) continue;
    const s = similarity(line.name, it.name);
    if (s >= threshold && (!best || s > best.score)) best = { id: it.id, score: s };
  }
  return best;
}
