// Мульти-склад (saas/console/stock-zones.js): остатки по местам и перемещение приращениями.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zoneBalances, hasZones, planTransfer, zoneLabel, STOCK_ZONES } from '../saas/console/stock-zones.js';

let n = 0;
const milk = { quantity: 10, zones: { bar: 1.5, kitchen: 2 } };
assert.deepEqual(zoneBalances(milk), { main: 6.5, bar: 1.5, kitchen: 2, hookah: 0 });
assert.deepEqual(zoneBalances({ quantity: 3 }), { main: 3, bar: 0, kitchen: 0, hookah: 0 });
assert.equal(hasZones(milk), true);
assert.equal(hasZones({ quantity: 3, zones: { bar: 0 } }), false); n++;
// Продали больше, чем было в цехе: на экране цех не уходит в минус, основной склад — честно.
assert.deepEqual(zoneBalances({ quantity: 1, zones: { bar: -0.2, kitchen: 2 } }), { main: -1, bar: 0, kitchen: 2, hookah: 0 }); n++;

assert.deepEqual(planTransfer(milk, 'main', 'bar', 2), { qty: 2, inc: { 'zones.bar': 2 } });
assert.deepEqual(planTransfer(milk, 'bar', 'kitchen', 1.5), { qty: 1.5, inc: { 'zones.bar': -1.5, 'zones.kitchen': 1.5 } });
assert.deepEqual(planTransfer(milk, 'kitchen', 'main', 0.25), { qty: 0.25, inc: { 'zones.kitchen': -0.25 } }); n++;
assert.throws(() => planTransfer(milk, 'bar', 'kitchen', 2), /«Бар» только 1,5/);
assert.throws(() => planTransfer(milk, 'bar', 'bar', 1), /одно и то же/);
assert.throws(() => planTransfer(milk, 'main', 'bar', 0), /больше нуля/);
assert.throws(() => planTransfer(milk, 'main', 'garage', 1), /откуда и куда/); n++;
assert.equal(zoneLabel('hookah'), 'Кальянная');
assert.deepEqual(STOCK_ZONES.map((z) => z.id), ['main', 'bar', 'kitchen', 'hookah']); n++;

// Те же цеха, что у кассы (lib/utils/stock_zones.dart), и касса не пишет zones обычным сохранением.
const dart = readFileSync(new URL('../lib/utils/stock_zones.dart', import.meta.url), 'utf8');
assert.ok(dart.includes("const List<String> kStockWorkshops = ['bar', 'kitchen', 'hookah'];"));
const model = readFileSync(new URL('../lib/models/inventory_models.dart', import.meta.url), 'utf8');
const toMap = model.slice(model.indexOf('Map<String, dynamic> toMap() => {', model.indexOf('class InventoryItem ')));
assert.ok(!toMap.slice(0, toMap.indexOf('};')).includes("'zones'")); n++;
console.log(`stock-zones: ${n} проверок`);
