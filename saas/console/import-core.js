// Перенос данных из другой кассы: чтение выгрузок (Excel .xlsx и .xls, .ods,
// таблица XML 2003, «Excel»-страница с таблицей, CSV) и
// разбор в меню, склад, техкарты, сотрудников и скидочные карты ZalPOS.
// Только разбор и план — запись делает кабинет (console.js). Без внешних
// библиотек: .xlsx — это zip с XML, распаковываем встроенным в браузер
// DecompressionStream. Модуль работает и в Node (тесты).
//
// Законность: данные выгружает сам владелец штатной функцией экспорта своей
// прежней системы — это его данные. К чужим программам и их базам мы не
// подключаемся. Гостей (имена, телефоны) не переносим: согласие они давали
// прежнему оператору, в ZalPOS гость даёт его сам в приложении.

export const MAX_ROWS = 5000;

const F = (key, label, synonyms, { required = false } = {}) => ({ key, label, synonyms, required });

/** Что можно перенести и как называются столбцы в выгрузках разных систем. */
export const KINDS = {
  menu: {
    label: 'Меню',
    hint: 'Номенклатура или прайс: название, цена продажи, категория (группа).',
    fields: [
      F('name', 'Название', ['наименование', 'название', 'блюдо', 'товар', 'позиция', 'номенклатура', 'наименование блюда', 'наименование товара', 'название товара', 'товар услуга', 'name', 'item', 'title'], { required: true }),
      F('price', 'Цена продажи, ₽', ['цена', 'цена продажи', 'цена руб', 'стоимость', 'розничная цена', 'цена в меню', 'базовая цена', 'цена реализации', 'продажная цена', 'розница', 'price', 'sale price'], { required: true }),
      F('category', 'Категория', ['категория', 'группа', 'раздел', 'папка', 'родительская группа', 'группа меню', 'категория меню', 'группа товаров', 'категория товара', 'category', 'group']),
      F('description', 'Описание / состав', ['описание', 'состав', 'комментарий', 'description']),
    ],
  },
  stock: {
    label: 'Склад',
    hint: 'Остатки: название продукта, единица, количество, цена закупки.',
    fields: [
      F('name', 'Продукт', ['наименование', 'название', 'продукт', 'товар', 'номенклатура', 'ингредиент', 'сырье', 'name', 'item', 'product'], { required: true }),
      F('unit', 'Единица', ['ед', 'ед изм', 'единица', 'единица измерения', 'ед измерения', 'unit', 'uom']),
      F('quantity', 'Остаток', ['остаток', 'количество', 'кол во', 'конечный остаток', 'остаток на складе', 'остаток на конец', 'фактический остаток', 'остаток на дату', 'qty', 'quantity', 'stock']),
      F('cost', 'Цена закупки, ₽', ['себестоимость', 'закупочная цена', 'цена закупки', 'учетная цена', 'средняя цена', 'цена поставщика', 'последняя закупочная цена', 'цена', 'cost', 'purchase price']),
      F('min', 'Мин. остаток', ['мин остаток', 'минимальный остаток', 'минимум', 'неснижаемый остаток', 'min']),
      F('category', 'Категория', ['категория', 'группа', 'раздел', 'category', 'group']),
    ],
  },
  recipes: {
    label: 'Техкарты',
    hint: 'Каждая строка — продукт в блюде: блюдо, продукт, количество, единица.',
    fields: [
      F('dish', 'Блюдо', ['блюдо', 'техкарта', 'тех карта', 'технологическая карта', 'наименование блюда', 'готовое блюдо', 'позиция меню', 'наименование техкарты', 'блюдо заготовка', 'dish', 'recipe'], { required: true }),
      F('ingredient', 'Продукт', ['ингредиент', 'продукт', 'сырье', 'компонент', 'ингредиенты', 'товар', 'наименование ингредиента', 'ингредиент полуфабрикат', 'ingredient', 'product'], { required: true }),
      F('amount', 'Количество', ['количество', 'кол во', 'брутто', 'нетто', 'вес', 'расход', 'норма', 'норма закладки', 'amount', 'qty']),
      F('unit', 'Единица', ['ед', 'ед изм', 'единица', 'единица измерения', 'unit']),
      F('loss', 'Отход, %', ['отход', 'отход %', 'процент отхода', 'потери', 'отходы', 'loss']),
      F('portions', 'Порций в рецепте', ['порций', 'кол во порций', 'выход порций', 'на порций', 'portions']),
    ],
  },
  staff: {
    label: 'Сотрудники',
    hint: 'Имя и должность. PIN-коды для входа в кассу создадим новые.',
    fields: [
      F('name', 'Имя', ['имя', 'фио', 'ф и о', 'сотрудник', 'работник', 'официант', 'name', 'employee'], { required: true }),
      F('role', 'Должность', ['должность', 'роль', 'профессия', 'position', 'role']),
    ],
  },
  cards: {
    label: 'Скидочные карты',
    hint: 'Номер карты и скидка в процентах. Имена гостей не переносим.',
    fields: [
      F('number', 'Номер карты', ['номер карты', 'карта', 'номер', 'код карты', 'штрихкод', 'card', 'card number'], { required: true }),
      F('percent', 'Скидка, %', ['скидка', 'скидка %', 'процент', 'процент скидки', 'размер скидки', 'discount'], { required: true }),
    ],
  },
};

// ---------------------------------------------------------------- текст и числа

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9%]+/g, ' ').trim();
/** Ключ для сравнения названий: «Капучино 0,3» и «капучино 0.3 » — одно. */
export const nameKey = (s) => norm(s).replace(/\s+/g, ' ');

/** «1 234,50 ₽», «1234.5», «-3» → число; пусто или не число → null. */
export function parseNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').replace(/[\s ₽рруб.$€]+$/giu, '').replace(/[\s  ']/g, '').trim();
  if (!s) return null;
  // «1,234,567» и «1,234.50» — запятая разделяет тысячи; «1,234» по-русски — дробь.
  if (/^-?\d{1,3}(,\d{3}){2,}(\.\d+)?$/.test(s) || /^-?\d{1,3}(,\d{3})+\.\d+$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = Number(s.replace(/[^0-9.\-]/g, ''));
  return /\d/.test(s) && Number.isFinite(n) ? n : null;
}

/** Единица выгрузки → единица склада ZalPOS. */
export function parseUnit(v) {
  const s = norm(v);
  if (!s) return null;
  if (/^(кг|килограмм|kg)/.test(s)) return 'kg';
  if (/^(мл|миллилитр|ml)/.test(s)) return 'ml';
  if (/^(г|гр|грамм|g)$|^грам/.test(s)) return 'g';
  if (/^(л|литр|l)$|^литр/.test(s)) return 'l';
  if (/^(шт|штук|порц|ед|упак|бут|банк|pcs|pc|piece)/.test(s)) return 'pcs';
  return null;
}

const FAMILY = { g: 'mass', kg: 'mass', ml: 'vol', l: 'vol', pcs: 'pcs' };
const TO_BASE = { g: 1, kg: 1000, ml: 1, l: 1000, pcs: 1 };
/** Перевод количества между единицами одного рода; разные роды — null. */
export function convertUnit(value, from, to) {
  if (from === to) return value;
  if (FAMILY[from] !== FAMILY[to]) return null;
  return (value * TO_BASE[from]) / TO_BASE[to];
}

/** Должность → роль и специализация кассы (AppConstants.position*). */
export function parseRole(v) {
  const s = norm(v);
  const admin = /(админ|управля|менеджер|директор|владел|старш|admin|manager)/.test(s);
  const position = /кальян|hookah/.test(s) ? 'hookah_master'
    : /бармен|бариста|бар|bartender|barista/.test(s) ? 'bartender'
      : /повар|кух|шеф|cook|chef/.test(s) ? 'cook'
        : /хостес|хост|администратор зала|host/.test(s) ? 'host'
          : /официант|waiter/.test(s) ? 'waiter' : 'universal';
  return { role: admin && !/зала/.test(s) ? 'admin' : 'employee', position };
}

// ---------------------------------------------------------------- чтение файлов

/** Байты → текст: UTF-8 (с BOM или без), иначе Windows-1251 — так
 *  сохраняют CSV старые кассы и Excel на русской Windows. */
export function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch (_) {
    return new TextDecoder('windows-1251').decode(u8);
  }
}

/** CSV с автоопределением разделителя (; , табуляция) и кавычками. */
export function parseCsv(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const head = src.split('\n').slice(0, 10).join('\n');
  const count = (ch) => (head.match(new RegExp(ch === '\t' ? '\t' : `\\${ch}`, 'g')) || []).length;
  const delim = ['\t', ';', ','].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
}

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return XML_ENT[e] ?? m;
});
const textOf = (xml) => [...String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

/** Распаковать zip: имя файла → байты. */
async function unzip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('файл повреждён или это не таблица Excel');
  const entries = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  for (let n = 0; n < entries; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^(xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet\d+\.xml)|content\.xml)$/.test(name)) continue;
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const data = u8.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
    }
  }
  return out;
}

const colIndex = (ref) => {
  const letters = String(ref).replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Excel .xlsx → листы с таблицами строк. */
export async function readXlsx(bytes) {
  const files = await unzip(bytes);
  const td = new TextDecoder();
  const xml = (name) => (files.has(name) ? td.decode(files.get(name)) : '');
  const shared = [...xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rels = new Map([...xml('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
    const id = (m[0].match(/\bId="([^"]+)"/) || [])[1];
    const target = (m[0].match(/\bTarget="([^"]+)"/) || [])[1] || '';
    return [id, `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`];
  }));
  let sheets = [...xml('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: unxml((m[0].match(/\bname="([^"]*)"/) || [])[1] || 'Лист'),
    file: rels.get((m[0].match(/\br:id="([^"]+)"/) || [])[1]) || '',
  }));
  if (!sheets.length || !sheets.some((s) => files.has(s.file))) {
    sheets = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort().map((file, i) => ({ name: `Лист ${i + 1}`, file }));
  }
  return sheets.filter((s) => files.has(s.file)).map(({ name, file }) => {
    const rows = [];
    for (const r of xml(file).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const body = c[2] || '';
        const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
        const type = (attrs.match(/\bt="(\w+)"/) || [])[1] || '';
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = '';
        if (type === 's') val = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') val = textOf(body);
        else if (v != null) val = unxml(v);
        const idx = ref ? colIndex(ref) : row.length;
        while (row.length < idx) row.push('');
        row[idx] = String(val).trim();
      }
      if (row.some((x) => x !== '')) rows.push(row);
    }
    return { name, rows };
  }).filter((s) => s.rows.length);
}

/** OpenDocument (.ods — LibreOffice, «Мой офис») → листы. */
export async function readOds(bytes) {
  const files = await unzip(bytes);
  const xml = files.has('content.xml') ? new TextDecoder().decode(files.get('content.xml')) : '';
  if (!xml) throw new Error('файл повреждён или это не таблица');
  const sheets = [];
  for (const t of xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    const name = unxml((t[1].match(/table:name="([^"]*)"/) || [])[1] || `Лист ${sheets.length + 1}`);
    const rows = [];
    for (const r of t[2].matchAll(/<table:table-row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
      const row = [];
      for (const c of (r[2] || '').matchAll(/<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
        const attrs = c[1];
        const value = (attrs.match(/office:value="([^"]*)"/) || [])[1];
        const text = [...(c[2] || '').matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)]
          .map((p) => unxml(p[1].replace(/<text:s\b[^>]*\/>/g, ' ').replace(/<text:tab\b[^>]*\/>/g, '\t').replace(/<[^>]+>/g, ''))).join('\n');
        const val = (value != null && /float|percentage|currency/.test(attrs) ? value : text).trim();
        // Повторы: пустые хвосты строк бывают «повторить 16000 раз» — их не разворачиваем.
        const rep = Math.min(Number((attrs.match(/table:number-columns-repeated="(\d+)"/) || [])[1]) || 1, val ? 200 : 1);
        for (let i = 0; i < rep; i++) row.push(val);
      }
      while (row.length && row[row.length - 1] === '') row.pop();
      if (row.some((x) => x !== '')) rows.push(row);
      if (rows.length > MAX_ROWS + 50) break;
    }
    if (rows.length) sheets.push({ name, rows });
  }
  return sheets;
}

const HTML_ENT = { ...XML_ENT, nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', times: '×', deg: '°', euro: '€', copy: '©', reg: '®', shy: '' };
const unhtml = (s) => String(s).replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return HTML_ENT[e.toLowerCase()] ?? m;
});

/** «Excel», который на деле веб-страница с таблицей: так выгружают многие
 *  облачные кассы и учётные системы (файл .xls, внутри <table>). */
export function readHtmlTables(text) {
  const src = String(text).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const sheets = [];
  for (const t of src.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [];
    for (const r of t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table>|$)/gi)) {
      const row = [];
      for (const c of r[1].matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)(?=<t[dh]\b|<\/tr>|$)/gi)) {
        const val = unhtml(c[3].replace(/<\/t[dh]>[\s\S]*$/i, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t ]+/g, ' ').trim();
        const span = Math.min(Number((c[2].match(/colspan\s*=\s*["']?(\d+)/i) || [])[1]) || 1, 50);
        row.push(val);
        for (let i = 1; i < span; i++) row.push('');
      }
      if (row.some((x) => x !== '')) rows.push(row);
    }
    if (rows.length) sheets.push({ name: `Таблица ${sheets.length + 1}`, rows });
  }
  return sheets;
}

/** Таблица XML 2003 (SpreadsheetML): «Сохранить как → Таблица XML». */
export function readSpreadsheetXml(text) {
  const sheets = [];
  for (const w of String(text).matchAll(/<(?:\w+:)?Worksheet\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Worksheet>/g)) {
    const name = unxml((w[1].match(/(?:\w+:)?Name="([^"]*)"/) || [])[1] || `Лист ${sheets.length + 1}`);
    const rows = [];
    for (const r of w[2].matchAll(/<(?:\w+:)?Row\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?Row>)/g)) {
      const row = [];
      for (const c of (r[1] || '').matchAll(/<(?:\w+:)?Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?Cell>)/g)) {
        const idx = Number((c[1].match(/(?:\w+:)?Index="(\d+)"/) || [])[1]) || 0;
        while (idx && row.length < Math.min(idx - 1, 500)) row.push('');
        const data = (c[2] || '').match(/<(?:\w+:)?Data\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Data>/);
        row.push(data ? unxml(data[1].replace(/<[^>]+>/g, '')).trim() : '');
      }
      if (row.some((x) => x !== '')) rows.push(row);
    }
    if (rows.length) sheets.push({ name, rows });
  }
  return sheets;
}

// ---- старый Excel (.xls, BIFF8 в составном файле OLE)

/** Составной файл OLE (CFB) → поток с именем из [names]. */
function cfbStream(u8, names) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ss = 1 << dv.getUint16(0x1e, true);
  const mss = 1 << dv.getUint16(0x20, true);
  const cutoff = dv.getUint32(0x38, true);
  const sector = (n) => (n + 1) * ss;
  const END = 0xfffffffe;
  // Таблица размещения: сначала список её секторов (DIFAT).
  const difat = [];
  for (let i = 0; i < 109; i++) difat.push(dv.getUint32(0x4c + i * 4, true));
  let next = dv.getUint32(0x44, true);
  for (let guard = 0; next < END && guard < 10000; guard++) {
    const off = sector(next);
    if (off + ss > u8.length) break;
    for (let i = 0; i < ss / 4 - 1; i++) difat.push(dv.getUint32(off + i * 4, true));
    next = dv.getUint32(off + ss - 4, true);
  }
  const fat = [];
  for (const s of difat) {
    if (s >= END) continue;
    const off = sector(s);
    if (off + ss > u8.length) continue;
    for (let i = 0; i < ss / 4; i++) fat.push(dv.getUint32(off + i * 4, true));
  }
  const chain = (start, table, limit) => {
    const out = [];
    for (let s = start; s < END && out.length < limit; s = table[s] ?? END) out.push(s);
    return out;
  };
  const readChain = (start, size) => {
    const parts = chain(start, fat, Math.ceil(size / ss) + 1).map((s) => u8.subarray(sector(s), sector(s) + ss));
    const out = new Uint8Array(parts.length * ss);
    parts.forEach((p, i) => out.set(p, i * ss));
    return out.subarray(0, size);
  };
  // Каталог: записи по 128 байт.
  const dirBytes = readChain(dv.getUint32(0x30, true), fat.length * ss);
  const ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const entries = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const len = ddv.getUint16(off + 0x40, true);
    const type = dirBytes[off + 0x42];
    if (!type) continue;
    let name = '';
    for (let i = 0; i < Math.max(0, len / 2 - 1); i++) name += String.fromCharCode(ddv.getUint16(off + i * 2, true));
    entries.push({ name, type, start: ddv.getUint32(off + 0x74, true), size: ddv.getUint32(off + 0x78, true) });
  }
  const root = entries.find((e) => e.type === 5);
  const want = entries.find((e) => e.type === 2 && names.includes(e.name));
  if (!want) return null;
  if (want.size >= cutoff || !root) return readChain(want.start, want.size);
  // Маленький поток — в «мини-потоке» корня, по своей таблице.
  const mini = readChain(root.start, root.size);
  const mfatBytes = readChain(dv.getUint32(0x3c, true), dv.getUint32(0x40, true) * ss);
  const mdv = new DataView(mfatBytes.buffer, mfatBytes.byteOffset, mfatBytes.byteLength);
  const mfat = [];
  for (let i = 0; i + 4 <= mfatBytes.length; i += 4) mfat.push(mdv.getUint32(i, true));
  const out = new Uint8Array(want.size);
  let pos = 0;
  for (const s of chain(want.start, mfat, Math.ceil(want.size / mss) + 1)) {
    const part = mini.subarray(s * mss, s * mss + mss);
    out.set(part.subarray(0, Math.min(part.length, want.size - pos)), pos);
    pos += part.length;
    if (pos >= want.size) break;
  }
  return out;
}

/** Excel 97–2003 (.xls) → листы: строки, числа, формулы (их значения). */
export function readXls(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const wb = cfbStream(u8, ['Workbook', 'Book']);
  if (!wb) throw new Error('в файле нет таблицы Excel');
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  const records = [];
  for (let p = 0; p + 4 <= wb.length;) {
    const type = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    records.push({ type, off: p + 4, len });
    p += 4 + len;
  }
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  const latin = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(wb[o + i]); return s; };
  const wide = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u16(o + i * 2)); return s; };
  const str16 = (o) => { const n = u16(o); return (wb[o + 2] & 1) ? wide(o + 3, n) : latin(o + 3, n); };
  const rk = (v) => {
    let n;
    if (v & 2) n = v >> 2;
    else {
      const b = new DataView(new ArrayBuffer(8));
      b.setUint32(4, v & 0xfffffffc, true);
      n = b.getFloat64(0, true);
    }
    return v & 1 ? n / 100 : n;
  };
  const num = (n) => (Number.isFinite(n) ? String(Math.round(n * 1e9) / 1e9) : '');
  const bof = records[0];
  if (!bof || bof.type !== 0x0809 || u16(bof.off) !== 0x0600) throw new Error('это очень старый Excel (5.0/95) — откройте файл в Excel и сохраните как .xlsx');
  if (records.some((r) => r.type === 0x002f)) throw new Error('файл защищён паролем — снимите пароль в Excel и сохраните заново');

  // Общие строки (SST) с продолжениями (CONTINUE): строка может переходить в
  // следующую запись, и там заново указано, однобайтные символы или двухбайтные.
  const sst = [];
  const si = records.findIndex((r) => r.type === 0x00fc);
  if (si >= 0) {
    const segs = [records[si]];
    for (let j = si + 1; j < records.length && records[j].type === 0x003c; j++) segs.push(records[j]);
    let seg = 0;
    let p = segs[0].off + 8;
    const left = () => segs[seg].off + segs[seg].len - p;
    const nextSeg = () => { seg++; if (seg >= segs.length) throw new RangeError('sst'); p = segs[seg].off; };
    const need = (n) => { while (left() < n) { if (left() > 0) throw new RangeError('sst'); nextSeg(); } };
    const skip = (n) => { while (n > 0) { if (!left()) nextSeg(); const k = Math.min(n, left()); p += k; n -= k; } };
    const total = u32(segs[0].off + 4);
    try {
      for (let k = 0; k < total; k++) {
        need(3);
        let cch = u16(p);
        let high = wb[p + 2] & 1;
        const flags = wb[p + 2];
        p += 3;
        let runs = 0;
        let ext = 0;
        if (flags & 8) { need(2); runs = u16(p); p += 2; }
        if (flags & 4) { need(4); ext = u32(p); p += 4; }
        let s = '';
        while (cch > 0) {
          if (!left()) { nextSeg(); high = wb[p] & 1; p += 1; }
          const can = high ? Math.floor(left() / 2) : left();
          const n = Math.min(cch, can);
          s += high ? wide(p, n) : latin(p, n);
          p += n * (high ? 2 : 1);
          cch -= n;
        }
        skip(runs * 4 + ext);
        sst.push(s);
      }
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
    }
  }

  const sheets = [];
  for (const r of records.filter((x) => x.type === 0x0085)) {
    if (wb[r.off + 5] !== 0) continue; // не лист с ячейками (диаграмма, макрос)
    const start = u32(r.off);
    const n = wb[r.off + 6];
    const name = (wb[r.off + 7] & 1) ? wide(r.off + 8, n) : latin(r.off + 8, n);
    const grid = new Map();
    const put = (row, col, v) => {
      if (row > MAX_ROWS + 50 || col > 500) return;
      if (!grid.has(row)) grid.set(row, []);
      grid.get(row)[col] = String(v).trim();
    };
    let i = records.findIndex((x) => x.off - 4 === start);
    if (i < 0) continue;
    let pendingFormula = null;
    for (i++; i < records.length && records[i].type !== 0x000a; i++) {
      const { type, off } = records[i];
      if (type === 0x00fd) put(u16(off), u16(off + 2), sst[u32(off + 6)] ?? '');
      else if (type === 0x0204) put(u16(off), u16(off + 2), str16(off + 6));
      else if (type === 0x0203) put(u16(off), u16(off + 2), num(dv.getFloat64(off + 6, true)));
      else if (type === 0x027e) put(u16(off), u16(off + 2), num(rk(u32(off + 6))));
      else if (type === 0x00bd) {
        const row = u16(off);
        const first = u16(off + 2);
        const cnt = (records[i].len - 6) / 6;
        for (let k = 0; k < cnt; k++) put(row, first + k, num(rk(u32(off + 4 + k * 6 + 2))));
      } else if (type === 0x0006) {
        const row = u16(off);
        const col = u16(off + 2);
        if (u16(off + 12) === 0xffff) {
          const kind = wb[off + 6];
          if (kind === 0) pendingFormula = { row, col };
          else if (kind === 1) put(row, col, wb[off + 8] ? 'ИСТИНА' : 'ЛОЖЬ');
        } else put(row, col, num(dv.getFloat64(off + 6, true)));
      } else if (type === 0x0207 && pendingFormula) {
        put(pendingFormula.row, pendingFormula.col, str16(off));
        pendingFormula = null;
      } else if (type === 0x0205 && !wb[off + 7]) put(u16(off), u16(off + 2), wb[off + 6] ? 'ИСТИНА' : 'ЛОЖЬ');
    }
    const rows = [...grid.keys()].sort((a, b) => a - b).map((k) => Array.from(grid.get(k), (x) => x ?? ''))
      .filter((row) => row.some((x) => x !== ''));
    if (rows.length) sheets.push({ name, rows });
  }
  return sheets;
}

/** Файл выгрузки → листы. Понимает .xlsx, .xls (Excel 97–2003), .ods,
 *  «xls» в виде веб-страницы, таблицу XML 2003 и CSV/TXT в любой кодировке. */
export async function readTable(bytes, filename = '') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const name = String(filename).toLowerCase();
  let sheets;
  if (u8[0] === 0x50 && u8[1] === 0x4b) {
    const head = new TextDecoder().decode(u8.subarray(30, 120));
    sheets = /opendocument\.spreadsheet/.test(head) || /\.ods$/.test(name) ? await readOds(u8) : await readXlsx(u8);
  } else if (u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0) {
    try {
      sheets = readXls(u8);
    } catch (e) {
      if (/паролем|очень старый/.test(e?.message || '')) throw e;
      throw new Error('файл .xls не читается: он повреждён или сохранён нестандартно — откройте его в Excel и сохраните как .xlsx');
    }
  } else {
    if (/\.numbers$/.test(name)) throw new Error('файл Numbers — экспортируйте таблицу в Excel или CSV');
    const text = decodeText(u8);
    const start = text.slice(0, 4000).toLowerCase();
    if (/<(?:\w+:)?workbook\b/.test(start) && /urn:schemas-microsoft-com:office:spreadsheet/.test(start)) sheets = readSpreadsheetXml(text);
    else if (/<(table|html|tr)\b/.test(start)) sheets = readHtmlTables(text);
    else {
      const rows = parseCsv(text);
      sheets = rows.length ? [{ name: filename || 'CSV', rows }] : [];
    }
  }
  if (!sheets.length) throw new Error('в файле нет данных — проверьте, что выгрузили таблицу');
  return sheets;
}

// ---------------------------------------------------------------- столбцы

function fieldScore(header, field) {
  const h = norm(header);
  if (!h) return 0;
  let best = 0;
  for (const syn of field.synonyms) {
    const s = norm(syn);
    if (h === s) best = Math.max(best, 3);
    else if (s.length >= 3 && (` ${h} `.includes(` ${s} `) || h.startsWith(s))) best = Math.max(best, 2);
  }
  return best;
}

/** Сопоставление столбцов: поле → номер столбца (лучшее совпадение, без повторов). */
export function guessMapping(kind, headers) {
  const fields = KINDS[kind].fields;
  const pairs = [];
  fields.forEach((f, fi) => headers.forEach((h, ci) => {
    const sc = fieldScore(h, f);
    if (sc) pairs.push({ fi, ci, sc: sc - fi * 0.001 });
  }));
  pairs.sort((a, b) => b.sc - a.sc);
  const map = {};
  const usedCols = new Set();
  for (const p of pairs) {
    const key = fields[p.fi].key;
    if (map[key] != null || usedCols.has(p.ci)) continue;
    map[key] = p.ci;
    usedCols.add(p.ci);
  }
  return map;
}

/** Строка заголовков — первая из 15, где узнаются хотя бы два столбца. */
export function findHeader(rows) {
  let best = { index: 0, score: -1 };
  rows.slice(0, 15).forEach((r, i) => {
    let s = 0;
    for (const k of Object.keys(KINDS)) s = Math.max(s, Object.keys(guessMapping(k, r)).length);
    if (s > best.score) best = { index: i, score: s };
  });
  return best.score >= 2 ? best.index : 0;
}

/** Что в таблице: меню, склад, техкарты, сотрудники или карты. */
export function guessKind(headers) {
  const scored = Object.entries(KINDS).map(([k, def]) => {
    const map = guessMapping(k, headers);
    const req = def.fields.filter((f) => f.required);
    if (!req.every((f) => map[f.key] != null)) return { k, score: 0 };
    let score = Object.keys(map).length + req.length;
    if (k === 'recipes') score += 3; // блюдо + продукт — однозначно техкарта
    if (k === 'stock' && (map.quantity != null || map.unit != null)) score += 2;
    if (k === 'stock' && map.quantity == null && map.unit == null) score = 0;
    if (k === 'menu' && map.quantity != null) score -= 1;
    return { k, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].k : '';
}

// ---------------------------------------------------------------- строки → записи

const cell = (r, i) => (i == null ? '' : String(r[i] ?? '').trim());

/**
 * Строки таблицы (после заголовка) → записи нужного вида и ошибки по строкам.
 * Номер строки в ошибке — как в Excel (с учётом заголовка).
 */
export function buildRows(kind, rows, map, { headerIndex = 0 } = {}) {
  const items = [];
  const errors = [];
  const line = (i) => headerIndex + i + 2;
  let group = '';
  rows.slice(0, MAX_ROWS).forEach((r, i) => {
    const err = (msg) => errors.push({ row: line(i), msg });
    if (kind === 'menu') {
      const name = cell(r, map.name);
      const price = parseNumber(cell(r, map.price));
      if (!name) return;
      // Строка-группа в выгрузке без столбца категории: «Горячее», а под ней блюда.
      if (price == null && map.category == null && r.filter((x) => String(x).trim()).length === 1) { group = name; return; }
      if (price == null || price < 0) return err(`«${name}»: нет цены`);
      items.push({ name: name.slice(0, 120), price: Math.round(price * 100) / 100, category: (cell(r, map.category) || group || 'Перенесённое').slice(0, 60), description: cell(r, map.description).slice(0, 300) });
    } else if (kind === 'stock') {
      const name = cell(r, map.name);
      if (!name) return;
      const unit = parseUnit(cell(r, map.unit)) || 'pcs';
      const q = parseNumber(cell(r, map.quantity));
      let cost = parseNumber(cell(r, map.cost));
      // Цена закупки в ZalPOS — за кг, литр или штуку. Цена «за грамм» в
      // выгрузке (копейки) — пересчитываем; рубли — уже за кг.
      if (cost != null && (unit === 'g' || unit === 'ml') && cost > 0 && cost < 5) cost *= 1000;
      if (q != null && q < 0) err(`«${name}»: остаток меньше нуля — перенесём как 0`);
      items.push({
        name: name.slice(0, 120), unit, quantity: q != null && q > 0 ? q : 0,
        cost: cost != null && cost > 0 ? Math.round(cost * 100) / 100 : 0,
        min: Math.max(0, parseNumber(cell(r, map.min)) || 0), category: cell(r, map.category).slice(0, 60),
      });
    } else if (kind === 'recipes') {
      const dish = cell(r, map.dish);
      const ingredient = cell(r, map.ingredient);
      if (!dish && !ingredient) return;
      if (!dish || !ingredient) return err('нужны и блюдо, и продукт');
      const amount = parseNumber(cell(r, map.amount));
      if (amount == null || amount <= 0) return err(`«${dish}» → «${ingredient}»: нет количества`);
      const loss = parseNumber(cell(r, map.loss));
      items.push({
        dish: dish.slice(0, 120), ingredient: ingredient.slice(0, 120), amount,
        unit: parseUnit(cell(r, map.unit)), loss: loss != null && loss > 0 && loss < 95 ? loss : 0,
        portions: Math.max(1, Math.round(parseNumber(cell(r, map.portions)) || 1)),
      });
    } else if (kind === 'staff') {
      const name = cell(r, map.name).replace(/\s+/g, ' ');
      if (!name) return;
      items.push({ name: name.slice(0, 60), ...parseRole(cell(r, map.role)) });
    } else if (kind === 'cards') {
      const number = cell(r, map.number).replace(/\s+/g, '');
      if (!number) return;
      const percent = parseNumber(String(cell(r, map.percent)).replace('%', ''));
      if (percent == null || percent <= 0 || percent > 100) return err(`карта ${number}: скидка должна быть от 1 до 100 %`);
      items.push({ number: number.slice(0, 40), percent });
    }
  });
  if (rows.length > MAX_ROWS) errors.push({ row: line(MAX_ROWS), msg: `в одном файле — не больше ${MAX_ROWS} строк, остальные не перенесены` });
  return { items, errors };
}

// ---------------------------------------------------------------- план переноса

/**
 * Что создать, что обновить, что пропустить — с учётом того, что уже есть
 * в заведении. [existing]: { categories, menu, stock, staffNames, cards } —
 * списки с полями name / cardNumber. [update] — обновлять совпавшее по
 * названию (цену, остаток) вместо пропуска.
 */
export function planImport(kind, items, existing = {}, { update = false } = {}) {
  const by = (list, f = (x) => x.name) => new Map((list || []).map((x) => [nameKey(f(x)), x]));
  const plan = { kind, create: [], update: [], skip: [], errors: [], newCategories: [], newStock: [] };
  if (kind === 'menu') {
    const cats = by(existing.categories);
    const menu = by(existing.menu);
    const seen = new Set();
    for (const it of items) {
      const k = nameKey(it.name);
      if (seen.has(k)) { plan.skip.push({ ...it, why: 'повтор в файле' }); continue; }
      seen.add(k);
      const ck = nameKey(it.category);
      if (!cats.has(ck) && !plan.newCategories.some((c) => nameKey(c) === ck)) plan.newCategories.push(it.category);
      const cur = menu.get(k);
      if (!cur) plan.create.push(it);
      else if (update) plan.update.push({ ...it, id: cur.id });
      else plan.skip.push({ ...it, why: 'уже есть в меню' });
    }
  } else if (kind === 'stock') {
    const stock = by(existing.stock);
    const seen = new Set();
    for (const it of items) {
      const k = nameKey(it.name);
      if (seen.has(k)) { plan.skip.push({ ...it, why: 'повтор в файле' }); continue; }
      seen.add(k);
      const cur = stock.get(k);
      if (!cur) plan.create.push(it);
      else if (update) {
        // Остаток в единице, которая уже на складе: «2 кг» при складе в граммах — 2000.
        const q = convertUnit(it.quantity, it.unit, cur.unit);
        if (q == null) plan.errors.push({ msg: `«${it.name}»: на складе ${cur.unit}, в файле ${it.unit} — остаток не обновлён` });
        plan.update.push({ ...it, id: cur.id, unit: cur.unit, quantity: q == null ? null : q, was: Number(cur.quantity) || 0 });
      } else plan.skip.push({ ...it, why: 'уже есть на складе' });
    }
  } else if (kind === 'recipes') {
    const menu = by(existing.menu);
    const stock = by(existing.stock);
    const dishes = new Map();
    for (const it of items) {
      const dk = nameKey(it.dish);
      const dish = menu.get(dk);
      if (!dish) { plan.errors.push({ msg: `«${it.dish}»: такого блюда нет в меню — сначала перенесите меню` }); continue; }
      const ik = nameKey(it.ingredient);
      let inv = stock.get(ik) || plan.newStock.find((s) => nameKey(s.name) === ik);
      const unit = it.unit || (inv ? (inv.unit === 'kg' ? 'g' : inv.unit === 'l' ? 'ml' : inv.unit) : 'g');
      if (!inv) {
        inv = { name: it.ingredient, unit: unit === 'g' ? 'kg' : unit === 'ml' ? 'l' : unit, isNew: true };
        plan.newStock.push(inv);
      }
      if (convertUnit(1, unit, inv.unit) == null) {
        plan.errors.push({ msg: `«${it.dish}» → «${it.ingredient}»: в техкарте ${unit}, на складе ${inv.unit} — строка пропущена` });
        continue;
      }
      const d = dishes.get(dk) || { dish: dish.name, id: dish.id, portions: it.portions, lines: [], hadRecipe: (dish.components || []).length > 0 };
      d.portions = Math.max(d.portions, it.portions);
      const same = d.lines.find((l) => nameKey(l.ingredient) === ik);
      if (same && same.unit === unit) same.amount += it.amount;
      else d.lines.push({ ingredient: inv.name, unit, amount: it.amount, loss: it.loss });
      dishes.set(dk, d);
    }
    for (const d of dishes.values()) {
      if (d.hadRecipe && !update) plan.skip.push({ ...d, why: 'у блюда уже есть рецепт' });
      else (d.hadRecipe ? plan.update : plan.create).push(d);
    }
  } else if (kind === 'staff') {
    const names = new Set((existing.staffNames || []).map(nameKey));
    for (const it of items) {
      if (names.has(nameKey(it.name))) { plan.skip.push({ ...it, why: 'уже есть в команде' }); continue; }
      names.add(nameKey(it.name));
      plan.create.push(it);
    }
  } else if (kind === 'cards') {
    const cards = new Map((existing.cards || []).map((c) => [String(c.cardNumber).replace(/\s+/g, ''), c]));
    const seen = new Set();
    for (const it of items) {
      if (seen.has(it.number)) { plan.skip.push({ ...it, why: 'повтор в файле' }); continue; }
      seen.add(it.number);
      const cur = cards.get(it.number);
      if (!cur) plan.create.push(it);
      else if (update) plan.update.push({ ...it, id: cur.id });
      else plan.skip.push({ ...it, why: 'карта уже есть' });
    }
  }
  return plan;
}

/** PIN, которого ещё нет: 4 цифры сотруднику, 6 — администратору. */
export function newPin(role, taken, rnd = Math.random) {
  const len = role === 'admin' ? 6 : 4;
  for (let i = 0; i < 2000; i++) {
    const pin = String(Math.floor(rnd() * 10 ** len)).padStart(len, '0');
    if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || taken.has(pin)) continue;
    taken.add(pin);
    return pin;
  }
  throw new Error('не удалось подобрать свободный PIN');
}

/** Шаблон CSV для Excel (UTF-8 с BOM, разделитель «;»). */
export function templateCsv(kind) {
  const samples = {
    menu: [['Название', 'Цена', 'Категория', 'Описание'], ['Капучино 0,3', '220', 'Кофе', 'Двойной эспрессо и молоко'], ['Борщ', '390', 'Супы', '']],
    stock: [['Продукт', 'Единица', 'Остаток', 'Цена закупки', 'Мин. остаток', 'Категория'], ['Молоко 3,2%', 'л', '12', '95', '4', 'Бар'], ['Свёкла', 'кг', '5', '40', '1', 'Овощи']],
    recipes: [['Блюдо', 'Продукт', 'Количество', 'Единица', 'Отход, %', 'Порций'], ['Борщ', 'Свёкла', '500', 'г', '15', '10'], ['Борщ', 'Говядина', '0,6', 'кг', '', '10']],
    staff: [['Имя', 'Должность'], ['Анна', 'Официант'], ['Илья', 'Администратор']],
    cards: [['Номер карты', 'Скидка, %'], ['100245', '10'], ['100246', '15']],
  }[kind];
  return `﻿${samples.map((r) => r.map((x) => (/[;"\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(';')).join('\r\n')}\r\n`;
}
