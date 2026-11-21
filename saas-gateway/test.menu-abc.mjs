// ABC-анализ меню в кабинете («Обзор») — та же логика, что в отчётах кассы.
import assert from 'node:assert/strict';
import { menuAbc, abcSummary } from '../saas/console/menu-abc.js';

const sessions = [
  { orderItems: [{ menuItemId: 'm1', name: 'Кальян', price: 1500, qty: 4 }, { menuItemId: 'm2', name: 'Латте', price: 250, qty: 4 }] },
  { orderItems: [{ menuItemId: 'm3', name: 'Чай', price: 300, qty: 1 }, { menuItemId: 'm4', name: 'Вода', price: 100, qty: 1 }, { name: 'Свободная позиция', price: 50, qty: 1 }] },
  { refunded: true, orderItems: [{ menuItemId: 'm4', name: 'Вода', price: 100, qty: 100 }] },
  { closedWithoutPayment: true, orderItems: [{ menuItemId: 'm4', name: 'Вода', price: 100, qty: 100 }] },
  { training: true, orderItems: [{ menuItemId: 'm4', name: 'Вода', price: 100, qty: 100 }] },
  { orderItems: [{ menuItemId: 'm2', name: 'Латте', price: 250, qty: 0 }] },
];
const menu = [
  { id: 'm1', name: 'Кальян' }, { id: 'm5', name: 'Пирог' }, { id: 'm6', name: 'Старое', available: false },
  { id: 'zalpos_delivery', name: 'Доставка' }, { id: 'm7', name: 'Свободная позиция' },
];
const r = menuAbc(sessions, menu);
// 6000 + 1000 + 300 + 100 + 50 = 7450
assert.equal(r.total, 7450);
assert.equal(r.checks, 3, 'возврат, без оплаты и учебный — не в счёт');
assert.deepEqual(r.items.map((i) => i.name), ['Кальян', 'Латте', 'Чай', 'Вода', 'Свободная позиция'], 'по выручке, от большей');
const cls = Object.fromEntries(r.items.map((i) => [i.name, i.cls]));
assert.equal(cls['Кальян'], 'A');
assert.equal(cls['Латте'], 'B', 'накопленная доля до позиции 80,5% — B');
assert.equal(cls['Чай'], 'B', 'до позиции 93,96% — ещё B');
assert.equal(cls['Вода'], 'C', 'до позиции 97,99% — C');
assert.equal(r.items[0].qty, 4);
assert.ok(Math.abs(r.items[0].share - 6000 / 7450) < 1e-9);
assert.deepEqual(r.unsold.map((u) => u.name), ['Пирог'], 'не продавались: без выключенных, служебных и проданных по названию');
const sum = abcSummary(r.items);
assert.equal(sum.A.count, 1);
assert.equal(sum.B.count, 2);
assert.equal(sum.C.count, 2);
// Пусто — без ошибок.
assert.deepEqual(menuAbc([], []), { items: [], total: 0, checks: 0, unsold: [] });
console.log('menu-abc: ok');
