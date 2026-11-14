// Калькулятор экономии и таблица тарифов на главной (saas/console/savings.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planForTills, savingsEstimate, planTableRows } from '../saas/console/savings.js';

// Сетка тарифов — как в каталоге сервера (PLAN_CATALOG в server.js).
const PLANS = [
  { id: 'start', name: 'Старт', priceRub: 1790, priceRubYearly: 17190, maxDevices: 2, maxCouriers: 1, aiEnabled: false },
  { id: 'standard', name: 'Бизнес', priceRub: 2390, priceRubYearly: 22890, maxDevices: 5, maxCouriers: 3, aiEnabled: true },
  { id: 'pro', name: 'Про', priceRub: 2990, priceRubYearly: 28690, maxDevices: 0, maxCouriers: 10, aiEnabled: true },
  { id: 'chain', name: 'Сеть', isChainPlan: true, priceRub: 2590, priceRubYearly: 24790, priceRubAdditional: 990, maxDevices: 5, maxCouriers: 10 },
  { id: 'chain-pro', name: 'Сеть Про', isChainPlan: true, priceRub: 3990, priceRubYearly: 38290, priceRubAdditional: 1290, maxDevices: 0, maxCouriers: -1 },
  { id: 'old', name: 'Архив', priceRub: 990, archived: true },
];
let n = 0;

assert.equal(planForTills(PLANS, 1).id, 'start'); n++;
assert.equal(planForTills(PLANS, 2).id, 'start'); n++;
assert.equal(planForTills(PLANS, 3).id, 'standard'); n++;
assert.equal(planForTills(PLANS, 6).id, 'pro'); n++; // без ограничений
assert.equal(planForTills([], 3), null); n++;

const r = savingsEstimate({ tills: 2, currentMonthly: 5000, deliveryMonthly: 300000, commissionPct: 25, sharePct: 30 }, PLANS);
assert.equal(r.plan.id, 'start');
assert.equal(r.subscriptionYear, (5000 - 1790) * 12);
assert.equal(r.commissionYear, Math.round(300000 * 0.25 * 0.3 * 12));
assert.equal(r.totalYear, r.subscriptionYear + r.commissionYear); n++;

// Сейчас платят меньше нас — разница честно отрицательная, без «приукрашивания».
const cheaper = savingsEstimate({ tills: 1, currentMonthly: 1000, deliveryMonthly: 0, commissionPct: 25, sharePct: 30 }, PLANS);
assert.equal(cheaper.subscriptionYear, (1000 - 1790) * 12);
assert.equal(cheaper.commissionYear, 0); n++;

// Мусор в полях — не NaN и не отрицательная комиссия.
const junk = savingsEstimate({ tills: 'abc', currentMonthly: -5, deliveryMonthly: 'x', commissionPct: 500, sharePct: -1 }, PLANS);
assert.ok(Number.isFinite(junk.totalYear));
assert.equal(junk.tills, 1);
assert.equal(junk.commissionYear, 0); n++;

const rows = planTableRows(PLANS);
assert.deepEqual(rows.map((x) => x.name), ['Старт', 'Бизнес', 'Про', 'Сеть', 'Сеть Про']); // архив скрыт, сети — после
assert.equal(rows[0].month, `${(1790).toLocaleString('ru-RU')} ₽`);
assert.equal(rows[2].devices, 'без ограничений');
assert.equal(rows[3].devices.includes('на точку'), true);
assert.equal(rows[4].couriers, 'без ограничений');
assert.equal(rows[0].ai, 'нет');
assert.equal(rows[4].extra, `${(1290).toLocaleString('ru-RU')} ₽/мес`); n++;

// Закон о рекламе: на странице и в расчёте нет названий чужих систем.
const src = readFileSync(new URL('../saas/console/savings.js', import.meta.url), 'utf8')
  + readFileSync(new URL('../saas/console/console.js', import.meta.url), 'utf8').split('savings-calc')[1].slice(0, 4000);
for (const name of ['iiko', 'Poster', 'r_keeper', 'r-keeper', 'Presto', 'Quick Resto', 'Яндекс Ед', 'Delivery Club']) {
  assert.ok(!src.includes(name), `в калькуляторе не должно быть «${name}»`);
}
n++;
console.log(`savings: ${n} проверок`);
