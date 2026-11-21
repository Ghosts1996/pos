// «Для бухгалтера»: листы выгрузки и файл .xlsx (saas/console/accounting-export.js).
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildAccountingSheets, buildXlsx, checkTotal } from '../saas/console/accounting-export.js';
import { readXlsx } from '../saas/console/import-core.js';

let n = 0;
const ts = (iso) => ({ toDate: () => new Date(iso) });
const data = {
  sessions: [
    { id: 's1', status: 'closed', closedAt: ts('2026-11-14T10:00:00Z'), checkNumber: 101, tableName: 'Стол 1', discountPercent: 10,
      orderItems: [{ name: 'Латте', price: 200, qty: 2 }, { name: 'Кальян классика', price: 1500, qty: 1 }],
      paymentCash: 1860, paymentCard: 0, paymentTerminal: 0, tipsCash: 100, fiscalReceiptPrinted: true },
    { id: 's2', status: 'closed', closedAt: ts('2026-11-14T12:00:00Z'), checkNumber: 102, orderItems: [{ name: '=HYPERLINK("x")', price: 300, qty: 1 }],
      paymentTerminal: 300 },
    { id: 's3', status: 'closed', closedAt: ts('2026-11-14T13:00:00Z'), closedWithoutPayment: true, orderItems: [{ name: 'Чай', price: 100, qty: 1 }] },
    { id: 's4', status: 'closed', closedAt: ts('2026-11-14T14:00:00Z'), training: true, orderItems: [{ name: 'Учебный', price: 999, qty: 1 }], paymentCash: 999 },
  ],
  refunds: [{ id: 's1', refunded: true, refundedAt: ts('2026-11-14T15:00:00Z'), checkNumber: 101, refundedBy: 'Анна',
    orderItems: [{ name: 'Латте', price: 200, qty: 2 }] }],
  movements: [
    { type: 'receipt', createdAt: ts('2026-11-13T09:00:00Z'), itemName: 'Молоко', delta: 12, unit: 'l', reason: 'УПД №55 от ООО «Ферма»' },
    { type: 'writeoff', createdAt: ts('2026-11-13T09:00:00Z'), itemName: 'Молоко', delta: -1, unit: 'l' },
  ],
  shifts: [{ employeeName: 'Анна', startedAt: ts('2026-11-14T08:00:00Z'), endedAt: ts('2026-11-14T16:30:00Z') }],
  adjustments: [{ type: 'bonus', amount: 1000, employeeName: 'Анна', at: ts('2026-11-14T16:00:00Z'), comment: 'План' }],
};

// Сумма чека — как в «Обзоре»: скидка 10% только на латте, кальян без скидки.
assert.equal(checkTotal(data.sessions[0]), 400 - 40 + 1500); n++;

const sheets = buildAccountingSheets(data, { tz: 'Europe/Moscow' });
const by = Object.fromEntries(sheets.map((s) => [s.name, s.rows]));
assert.deepEqual(Object.keys(by), ['Сводка', 'Чеки', 'Продажи по позициям', 'Возвраты', 'Приходы по накладным', 'Смены сотрудников', 'Зарплата — корректировки',
  '1С — розничные продажи', '1С — оплаты по дням', '1С — номенклатура']); n++;
assert.equal(by['Чеки'].length, 1 + 2 + 1, 'без «закрыт без оплаты» и учебного чека'); n++;
assert.equal(by['Чеки'][1][0], '14.11.2026 13:00', 'время по поясу заведения'); n++;
assert.equal(by['Чеки'].at(-1)[3], 1860 + 300); n++;

// 1С: по дням, скидка разнесена по строкам, сумма дня = сумме чеков, НДС из меню.
{
  const s1c = buildAccountingSheets({ ...data, menu: { latte: { vat: 'vat22' }, hk: { vat: 'none', fiscalSubject: 'service' } } }, { tz: 'Europe/Moscow' });
  const b = Object.fromEntries(s1c.map((x) => [x.name, x.rows]));
  const sales = b['1С — розничные продажи'];
  assert.deepEqual(sales[0], ['Дата', 'Номенклатура', 'Количество', 'Цена, ₽', 'Сумма, ₽', 'Ставка НДС', 'Вид']); n++;
  const total = sales.slice(1).reduce((a, r) => a + r[4], 0);
  assert.equal(Math.round(total * 100) / 100, 1860 + 300, 'сумма продаж дня = сумма чеков (без учебных и без оплаты)'); n++;
  const latte = sales.find((r) => r[1] === 'Латте');
  assert.deepEqual(latte.slice(0, 5), ['14.11.2026', 'Латте', 2, 180, 360], 'скидка 10% на латте'); n++;
  assert.equal(sales.find((r) => r[1] === 'Кальян классика')[4], 1500, 'кальян без скидки'); n++;
  const pays = b['1С — оплаты по дням'];
  assert.deepEqual(pays[1], ['14.11.2026', 1860, 300, 0, 0, 2160]); n++;
  assert.ok(b['1С — номенклатура'].some((r) => r[0] === 'Латте'));
  const withVat = buildAccountingSheets({ ...data, sessions: [{ ...data.sessions[0], orderItems: [{ menuItemId: 'latte', name: 'Латте', price: 200, qty: 2 }] }],
    menu: { latte: { vat: 'vat22' } } }, { tz: 'Europe/Moscow' });
  assert.equal(Object.fromEntries(withVat.map((x) => [x.name, x.rows]))['1С — розничные продажи'][1][5], '22%'); n++;
  // Неровная скидка: копейки не теряются.
  const odd = buildAccountingSheets({ sessions: [{ status: 'closed', closedAt: ts('2026-11-15T10:00:00Z'), discountPercent: 7,
    orderItems: [{ name: 'А', price: 33.33, qty: 3 }, { name: 'Б', price: 17.17, qty: 1 }], paymentCash: 108 }] }, { tz: 'Europe/Moscow' });
  const oddSales = Object.fromEntries(odd.map((x) => [x.name, x.rows]))['1С — розничные продажи'];
  assert.equal(Math.round(oddSales.slice(1).reduce((a, r) => a + r[4], 0) * 100) / 100, checkTotal({ discountPercent: 7, orderItems: [{ name: 'А', price: 33.33, qty: 3 }, { name: 'Б', price: 17.17, qty: 1 }] })); n++;
}
assert.equal(by['Возвраты'].at(-1)[2], 400); n++;
assert.equal(by['Приходы по накладным'].length, 2, 'только приходы'); n++;
assert.equal(by['Смены сотрудников'][1][3], 8.5); n++;
assert.equal(by['Зарплата — корректировки'][1][2], 'Премия'); n++;
const summary = Object.fromEntries(by['Сводка'].slice(1));
assert.equal(summary['Выручка за вычетом возвратов, ₽'], 2160 - 400); n++;
assert.equal(summary['Картой и переводом, ₽'], 300); n++;

// Файл .xlsx: собирается и читается обратно (тот же разбор, что у «Переноса данных»).
const bytes = buildXlsx(sheets);
const back = await readXlsx(bytes);
assert.deepEqual(back.map((s) => s.name), Object.keys(by)); n++;
const checksBack = back.find((s) => s.name === 'Чеки').rows;
assert.equal(checksBack[0][0], 'Дата');
assert.equal(Number(checksBack[1][3]), 1860, 'числа — числами');
assert.equal(back.find((s) => s.name === 'Продажи по позициям').rows[3][2], '=HYPERLINK("x")', 'формула осталась текстом'); n++;

// Независимая проверка: файл открывает Python zipfile + XML-разбор (как Excel — по стандарту OOXML).
const dir = mkdtempSync(join(tmpdir(), 'acc-'));
const file = join(dir, 'export.xlsx');
writeFileSync(file, bytes);
const out = execFileSync('python3', ['-I', '-c', `
import zipfile, sys, xml.dom.minidom
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
for n in z.namelist():
    if n.endswith('.xml') or n.endswith('.rels'): xml.dom.minidom.parseString(z.read(n))
print(len(z.namelist()))
`, file]).toString().trim();
assert.equal(Number(out), 5 + sheets.length); n++;
console.log(`accounting: ${n} проверок`);
