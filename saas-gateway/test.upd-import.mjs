// Приход по накладной (УПД из ЭДО): разбор XML, единицы, цены, сопоставление.
import assert from 'node:assert/strict';
import {
  decodeXml, parseUpd, unitFrom, convertQty, costPerPriceUnit, averageCost, similarity, matchItem,
} from '../saas/console/upd-import.js';

let n = 0;
const check = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e}`); process.exitCode = 1; } };

// Образец УПД 5.01 (как выгружает ЭДО), кодировка windows-1251.
const XML = `<?xml version="1.0" encoding="windows-1251"?>
<Файл ИдФайл="ON_NSCHFDOPPR_1" ВерсФорм="5.01" ВерсПрог="Диадок">
 <Документ КНД="1115131" Функция="СЧФДОП">
  <СвСчФакт НомерСчФ="Т-1245" ДатаСчФ="28.10.2026" КодОКВ="643">
   <СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО &quot;Молочный двор&quot;" ИННЮЛ="7701234567" КПП="770101001"/></ИдСв></СвПрод>
   <СвПокуп><ИдСв><СвИП ИННФЛ="151211052290"><ФИО Фамилия="Иванов" Имя="Иван"/></СвИП></ИдСв></СвПокуп>
  </СвСчФакт>
  <ТаблСчФакт>
   <СведТов НомСтр="1" НаимТов="Молоко питьевое 3,2% 1 л" ОКЕИ_Тов="112" НаимЕдИзм="л" КолТов="20" ЦенаТов="80.00" СтТовБезНДС="1600.00" НалСт="10%" СтТовУчНал="1760.00"/>
   <СведТов НомСтр="2" НаимТов="Сливки 33% " ОКЕИ_Тов="112" НаимЕдИзм="л" КолТов="5" ЦенаТов="400" СтТовБезНДС="2000" НалСт="20%" СтТовУчНал="2400"/>
   <СведТов НомСтр="3" НаимТов="Кофе зерновой Арабика 1 кг" ОКЕИ_Тов="166" НаимЕдИзм="кг" КолТов="3" ЦенаТов="1500" СтТовБезНДС="4500" НалСт="без НДС" СтТовУчНал="4500"/>
   <СведТов НомСтр="4" НаимТов="Стаканы бумажные 250 мл" ОКЕИ_Тов="796" НаимЕдИзм="шт" КолТов="500" ЦенаТов="3" СтТовБезНДС="1500" НалСт="20%" СтТовУчНал="1800"/>
   <ВсегоОпл СтТовБезНДСВсего="9600" СтТовУчНалВсего="10460"/>
  </ТаблСчФакт>
 </Документ>
</Файл>`;

// Кодируем в windows-1251, как настоящий файл из ЭДО.
const cp1251 = (s) => {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 128) out.push(c);
    else if (c >= 0x410 && c <= 0x44f) out.push(c - 0x410 + 0xc0);
    else if (c === 0x401) out.push(0xa8);
    else if (c === 0x451) out.push(0xb8);
    else out.push(0x3f);
  }
  return new Uint8Array(out);
};

check('windows-1251 читается, шапка и поставщик разобраны', () => {
  const text = decodeXml(cp1251(XML));
  const d = parseUpd(text);
  assert.equal(d.number, 'Т-1245');
  assert.equal(d.date, '28.10.2026');
  assert.deepEqual(d.supplier, { name: 'ООО "Молочный двор"', inn: '7701234567' });
  assert.equal(d.lines.length, 4);
  assert.equal(d.total, 10460);
});

check('строки: количество, единицы, цена с НДС за единицу', () => {
  const d = parseUpd(XML);
  assert.deepEqual(d.lines.map((l) => [l.name, l.qty, l.unit, l.price]), [
    ['Молоко питьевое 3,2% 1 л', 20, 'l', 88],
    ['Сливки 33%', 5, 'l', 480],
    ['Кофе зерновой Арабика 1 кг', 3, 'kg', 1500],
    ['Стаканы бумажные 250 мл', 500, 'pcs', 3.6],
  ]);
});

check('не УПД — понятная ошибка', () => {
  assert.throws(() => parseUpd('<html><body>счёт</body></html>'), /не УПД/);
});

check('единицы: ОКЕИ и подписи, перевод в единицы склада, цена за кг/л/шт', () => {
  assert.equal(unitFrom('', 'бут.'), 'pcs');
  assert.equal(unitFrom('', 'кг'), 'kg');
  assert.equal(unitFrom('111', ''), 'ml');
  assert.equal(convertQty(20, 'l', 'ml'), 20000);
  assert.equal(convertQty(3, 'kg', 'g'), 3000);
  assert.equal(convertQty(1, 'kg', 'pcs'), null);
  // Склад в мл: цена 88 ₽ за литр по накладной → 88 ₽/л (цена склада за литр).
  assert.equal(costPerPriceUnit({ unit: 'l', price: 88 }, 'ml'), 88);
  // Склад в г, накладная в г по 1,5 ₽ → 1500 ₽/кг.
  assert.equal(costPerPriceUnit({ unit: 'g', price: 1.5 }, 'g'), 1500);
});

check('средняя цена закупки — средневзвешенная', () => {
  assert.equal(averageCost(10, 80, 20, 88), 85.33);
  assert.equal(averageCost(0, 0, 20, 88), 88);
  assert.equal(averageCost(5, 100, 5, 0), 100);
});

check('сопоставление: похожее имя и совместимая единица; штуки с литрами не путаются', () => {
  const items = [
    { id: 'milk', name: 'Молоко 3,2%', unit: 'ml' },
    { id: 'cream', name: 'Сливки 33', unit: 'ml' },
    { id: 'beans', name: 'Кофе в зёрнах арабика', unit: 'g' },
    { id: 'cups', name: 'Стакан бумажный 250', unit: 'pcs' },
    { id: 'milk-pcs', name: 'Молоко питьевое (бутылка)', unit: 'pcs' },
  ];
  const d = parseUpd(XML);
  assert.equal(matchItem(d.lines[0], items).id, 'milk');
  assert.equal(matchItem(d.lines[1], items).id, 'cream');
  assert.equal(matchItem(d.lines[3], items).id, 'cups');
  assert.ok(similarity('Кофе зерновой Арабика 1 кг', 'Кофе в зёрнах арабика') >= 0.5);
  assert.equal(matchItem({ name: 'Огурцы свежие', unit: 'kg' }, items), null);
});

console.log(`upd-import: ${n} проверок`);
