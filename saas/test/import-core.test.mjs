// Перенос данных: разбор выгрузок других касс. Запуск: node saas/test/import-core.test.mjs
import assert from 'node:assert/strict';
import * as I from '../console/import-core.js';
import { readFileSync } from 'node:fs';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Минимальный .xlsx: zip с XML листа (часть файлов сжата deflate). */
async function makeXlsx(rows, { shared = true } = {}) {
  const enc = new TextEncoder();
  const strings = [];
  const sIdx = (v) => { let i = strings.indexOf(v); if (i < 0) { strings.push(v); i = strings.length - 1; } return i; };
  const col = (i) => String.fromCharCode(65 + i);
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    const ref = `${col(ci)}${ri + 1}`;
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    if (!shared) return `<c r="${ref}" t="inlineStr"><is><t>${v.replace(/&/g, '&amp;')}</t></is></c>`;
    return `<c r="${ref}" t="s"><v>${sIdx(v)}</v></c>`;
  }).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files = {
    'xl/workbook.xml': '<workbook><sheets><sheet name="Меню" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
    'xl/sharedStrings.xml': `<sst>${strings.map((x) => `<si><t>${x.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`,
  };
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const deflate = name.includes('sheet1');
    const data = deflate ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()) : raw;
    const nameB = enc.encode(name);
    const local = new Uint8Array(30 + nameB.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(8, deflate ? 8 : 0, true);
    dv.setUint32(18, data.length, true); dv.setUint32(22, raw.length, true); dv.setUint16(26, nameB.length, true);
    local.set(nameB, 30);
    const cen = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, raw.length, true); cv.setUint16(28, nameB.length, true); cv.setUint32(42, offset, true);
    cen.set(nameB, 46);
    parts.push(local, data);
    central.push(cen);
    offset += local.length + data.length;
  }
  const cenSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
  return new Uint8Array(await new Blob([...parts, ...central, eocd]).arrayBuffer());
}

test('числа, единицы, должности', () => {
  assert.equal(I.parseNumber('1 234,50 ₽'), 1234.5);
  assert.equal(I.parseNumber('1234.5'), 1234.5);
  assert.equal(I.parseNumber('0,234'), 0.234);
  assert.equal(I.parseNumber('1,234'), 1.234, 'по-русски запятая — дробь');
  assert.equal(I.parseNumber('1,234,567'), 1234567);
  assert.equal(I.parseNumber('390 руб.'), 390);
  assert.equal(I.parseNumber(''), null);
  assert.equal(I.parseNumber('нет'), null);
  assert.equal(I.parseUnit('кг'), 'kg');
  assert.equal(I.parseUnit('гр.'), 'g');
  assert.equal(I.parseUnit('Литр'), 'l');
  assert.equal(I.parseUnit('шт.'), 'pcs');
  assert.equal(I.parseUnit('порц'), 'pcs');
  assert.equal(I.convertUnit(2, 'kg', 'g'), 2000);
  assert.equal(I.convertUnit(2, 'kg', 'pcs'), null);
  assert.deepEqual(I.parseRole('Старший официант'), { role: 'admin', position: 'waiter' });
  assert.deepEqual(I.parseRole('Кальянный мастер'), { role: 'employee', position: 'hookah_master' });
  assert.deepEqual(I.parseRole('Бариста'), { role: 'employee', position: 'bartender' });
  assert.deepEqual(I.parseRole('Управляющий'), { role: 'admin', position: 'universal' });
  assert.deepEqual(I.parseRole('Администратор зала'), { role: 'employee', position: 'host' });
});

test('CSV: Windows-1251, «;», кавычки; вид таблицы и столбцы угадываются', () => {
  const text = 'Номенклатура;Группа;Цена продажи;Комментарий\r\n"Капучино ""Большой""";Кофе;220,00;\r\nБорщ;Супы;390;свёкла, говядина\r\n';
  const cp = new Uint8Array([...text].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0;
    if (c === 0x451) return 0xb8;
    return c;
  }));
  const rows = I.parseCsv(I.decodeText(cp));
  assert.equal(rows.length, 3);
  assert.equal(rows[1][0], 'Капучино "Большой"');
  assert.equal(I.guessKind(rows[0]), 'menu');
  const map = I.guessMapping('menu', rows[0]);
  assert.deepEqual(map, { name: 0, category: 1, price: 2, description: 3 });
  const { items, errors } = I.buildRows('menu', rows.slice(1), map);
  assert.equal(errors.length, 0);
  assert.deepEqual(items[1], { name: 'Борщ', price: 390, category: 'Супы', description: 'свёкла, говядина' });
});

test('виды выгрузок: склад, техкарты, сотрудники, карты', () => {
  assert.equal(I.guessKind(['Наименование', 'Ед. изм.', 'Остаток', 'Себестоимость']), 'stock');
  assert.equal(I.guessKind(['Блюдо', 'Ингредиент', 'Брутто', 'Ед.']), 'recipes');
  assert.equal(I.guessKind(['ФИО', 'Должность']), 'staff');
  assert.equal(I.guessKind(['Номер карты', 'Скидка %']), 'cards');
  assert.equal(I.guessKind(['Что-то', 'Непонятное']), '');
  // Шапка не в первой строке: название отчёта сверху.
  const rows = [['Остатки на 18.10.2026'], [], ['Наименование', 'Ед. изм.', 'Остаток']];
  assert.equal(I.findHeader(rows.filter((r) => r.length)), 1);
});

test('меню без столбца категории: строки-группы становятся категориями; без цены — ошибка с номером строки', () => {
  const rows = [['Горячее'], ['Стейк', '1200'], ['Паста', '650'], ['Напитки'], ['Морс', 'по запросу'], ['Лимонад', '350']];
  const { items, errors } = I.buildRows('menu', rows, { name: 0, price: 1 });
  assert.deepEqual(items.map((x) => `${x.category}:${x.name}`), ['Горячее:Стейк', 'Горячее:Паста', 'Напитки:Лимонад']);
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /Морс/);
  assert.equal(errors[0].row, 6);
});

test('склад: цена за грамм → за кг, минус в остатке → 0 с предупреждением', () => {
  const { items, errors } = I.buildRows('stock', [['Сахар', 'г', '1500', '0,08'], ['Молоко', 'л', '-2', '95']], { name: 0, unit: 1, quantity: 2, cost: 3 });
  assert.equal(items[0].cost, 80);
  assert.equal(items[1].quantity, 0);
  assert.equal(errors.length, 1);
});

test('план: что создать, обновить и пропустить; техкарты связываются с меню и складом', () => {
  const existing = {
    categories: [{ id: 'c1', name: 'Супы' }],
    menu: [{ id: 'm1', name: 'Борщ', components: [] }, { id: 'm2', name: 'Солянка', components: [{ inventoryItemId: 'x' }] }],
    stock: [{ id: 's1', name: 'Свёкла', unit: 'kg', quantity: 3 }],
    staffNames: ['Анна'],
    cards: [{ id: 'k1', cardNumber: '100245' }],
  };
  let p = I.planImport('menu', [{ name: 'борщ ', price: 400, category: 'Супы' }, { name: 'Морс', price: 150, category: 'Напитки' }], existing);
  assert.equal(p.create.length, 1);
  assert.equal(p.skip[0].why, 'уже есть в меню');
  assert.deepEqual(p.newCategories, ['Напитки']);
  p = I.planImport('menu', [{ name: 'Борщ', price: 400, category: 'Супы' }], existing, { update: true });
  assert.equal(p.update[0].id, 'm1');

  p = I.planImport('stock', [{ name: 'Свёкла', unit: 'g', quantity: 2500 }], existing, { update: true });
  assert.equal(p.update[0].quantity, 2.5, 'остаток переводится в единицу склада');

  p = I.planImport('recipes', [
    { dish: 'Борщ', ingredient: 'Свёкла', amount: 500, unit: 'g', loss: 15, portions: 10 },
    { dish: 'Борщ', ingredient: 'Говядина', amount: 0.6, unit: 'kg', loss: 0, portions: 10 },
    { dish: 'Борщ', ingredient: 'Свёкла', amount: 100, unit: 'g', loss: 15, portions: 10 },
    { dish: 'Пицца', ingredient: 'Тесто', amount: 300, unit: 'g', loss: 0, portions: 1 },
    { dish: 'Солянка', ingredient: 'Лимон', amount: 1, unit: 'pcs', loss: 0, portions: 1 },
  ], existing);
  assert.equal(p.create.length, 1);
  assert.deepEqual(p.create[0].lines.map((l) => `${l.ingredient}:${l.amount}${l.unit}`), ['Свёкла:600g', 'Говядина:0.6kg']);
  assert.equal(p.create[0].portions, 10);
  assert.deepEqual(p.newStock.map((s) => `${s.name}:${s.unit}`), ['Говядина:kg', 'Лимон:pcs']);
  assert.ok(p.errors.some((e) => /Пицца/.test(e.msg)), 'нет блюда в меню');
  assert.equal(p.skip[0].why, 'у блюда уже есть рецепт');

  p = I.planImport('staff', [{ name: 'Анна', role: 'employee', position: 'waiter' }, { name: 'Илья', role: 'admin', position: 'universal' }], existing);
  assert.deepEqual(p.create.map((x) => x.name), ['Илья']);
  p = I.planImport('cards', [{ number: '100245', percent: 10 }, { number: '100246', percent: 15 }], existing);
  assert.deepEqual(p.create.map((x) => x.number), ['100246']);
});

test('PIN: длина по роли, без повторов и простых', () => {
  const taken = new Set(['1234']);
  const pins = Array.from({ length: 50 }, () => I.newPin('employee', taken));
  assert.equal(new Set(pins).size, 50);
  assert.ok(pins.every((p) => /^\d{4}$/.test(p) && p !== '1234' && !/^(\d)\1+$/.test(p)));
  assert.match(I.newPin('admin', taken), /^\d{6}$/);
});

test('Excel .xlsx читается без библиотек: общие строки, числа, сжатый лист', async () => {
  const bytes = await makeXlsx([['Наименование', 'Группа', 'Цена'], ['Капучино & сироп', 'Кофе', 250], ['Борщ', 'Супы', 390.5]]);
  const sheets = await I.readTable(bytes, 'menu.xlsx');
  assert.equal(sheets[0].name, 'Меню');
  assert.deepEqual(sheets[0].rows[1], ['Капучино & сироп', 'Кофе', '250']);
  assert.equal(I.parseNumber(sheets[0].rows[2][2]), 390.5);
  const inline = await I.readTable(await makeXlsx([['ФИО', 'Должность'], ['Анна', 'Официант']], { shared: false }), 'staff.xlsx');
  assert.equal(I.guessKind(inline[0].rows[0]), 'staff');
  await assert.rejects(I.readTable(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'old.xls'), /\.xls/);
});

test('шаблоны CSV открываются в Excel и сами распознаются', () => {
  for (const kind of Object.keys(I.KINDS)) {
    const csv = I.templateCsv(kind);
    assert.ok(csv.startsWith('﻿'));
    const rows = I.parseCsv(I.decodeText(new TextEncoder().encode(csv)));
    assert.equal(I.guessKind(rows[0]), kind, kind);
    const { items, errors } = I.buildRows(kind, rows.slice(1), I.guessMapping(kind, rows[0]));
    assert.equal(errors.length, 0, `${kind}: ${JSON.stringify(errors)}`);
    assert.equal(items.length, 2, kind);
  }
});

test('выгрузки любых систем: .xls (Excel 97–2003), .ods, таблица XML 2003, «xls»-страница — читаются одинаково', async () => {
  const fx = (f) => new Uint8Array(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
  const expectRows = (rows) => {
    assert.equal(rows.length, 185);
    assert.deepEqual(rows[0], ['Наименование', 'Цена продажи', 'Группа']);
    assert.deepEqual(rows[2], ['Раф', '280', 'Кофе'], 'значение формулы');
    assert.deepEqual(rows[3], ['Чай & мёд', '199.9', 'Чай']);
    assert.equal(rows[100][0], 'Позиция №97 «особая» с очень длинным названием для проверки продолжения строк');
    assert.deepEqual(rows[184], ['Last ёжик', '1', 'Ω-группа']);
  };
  // Файлы сохранены LibreOffice: общие строки .xls переходят в записи-продолжения.
  for (const f of ['menu.xls', 'menu.ods']) {
    const sheets = await I.readTable(fx(f), f);
    expectRows(sheets[0].rows);
    assert.equal(I.guessKind(sheets[0].rows[0]), 'menu', f);
  }
  const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Склад"><Table>
    <Row><Cell><Data ss:Type="String">Наименование</Data></Cell><Cell><Data ss:Type="String">Ед. изм.</Data></Cell><Cell><Data ss:Type="String">Остаток</Data></Cell></Row>
    <Row><Cell><Data ss:Type="String">Мука &amp; соль</Data></Cell><Cell ss:Index="3"><Data ss:Type="Number">12.5</Data></Cell></Row></Table></Worksheet></Workbook>`;
  const xs = await I.readTable(new TextEncoder().encode(xml), 'stock.xml');
  assert.equal(xs[0].name, 'Склад');
  assert.deepEqual(xs[0].rows[1], ['Мука & соль', '', '12.5']);
  const html = '<html><body><table><tr><th>ФИО</th><th>Должность</th></tr><tr><td>Анна&nbsp;</td><td>Официант<br>старший</td></tr><tr><td colspan="2">итого</td></tr></table></body></html>';
  const hs = await I.readTable(new TextEncoder().encode(html), 'staff.xls');
  assert.equal(I.guessKind(hs[0].rows[0]), 'staff');
  assert.deepEqual(hs[0].rows[1], ['Анна', 'Официант\nстарший']);
  assert.deepEqual(hs[0].rows[2], ['итого', '']);
  // Синонимы столбцов разных систем.
  assert.deepEqual(I.guessMapping('menu', ['Наименование товара', 'Цена реализации', 'Группа товаров']), { name: 0, price: 1, category: 2 });
  assert.equal(I.guessMapping('stock', ['Товар', 'Фактический остаток', 'Цена поставщика']).quantity, 1);
});

for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  }
}
console.log(`import-core: ${passed} из ${tests.length} проверок`);
