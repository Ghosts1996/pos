// График смен в кабинете (saas/console/staff-schedule.js): разбор времени,
// неделя с понедельника, план против факта.
import assert from 'node:assert/strict';
import { parseShift, shiftHours, weekStart, weekDays, dayKey, planVsFact, weekTotals } from '../saas/console/staff-schedule.js';

assert.equal(parseShift('10-22').text, '10–22');
assert.equal(parseShift('9:30 - 18').text, '9:30–18');
assert.equal(parseShift('с 10 до 22').text, '10–22');
assert.equal(parseShift('10:00–22:00').text, '10–22');
assert.equal(parseShift('18-02').start, '18:00');
assert.equal(parseShift('18-2').text, '18–02');
assert.equal(parseShift('18-02').overnight, true);
assert.equal(shiftHours('18-02'), 8);
assert.equal(parseShift('25-10'), null);
assert.equal(parseShift('выходной'), null);
assert.equal(parseShift(''), null);

const mon = weekStart(new Date(2026, 10, 22)); // воскресенье 22.11 → понедельник 16.11
assert.equal(dayKey(mon), '2026-11-16');
assert.equal(dayKey(weekDays(mon)[6]), '2026-11-22');
assert.equal(dayKey(weekStart(new Date(2026, 10, 22), 1)), '2026-11-23');

const day = new Date(2026, 10, 20);
const at = (h, m = 0) => new Date(2026, 10, 20, h, m);
const late = new Date(2026, 10, 21, 12);
assert.equal(planVsFact(day, '10-22', [{ start: at(10, 3), end: at(22, 5) }], late).status, 'ok');
assert.equal(planVsFact(day, '10-22', [{ start: at(10, 40), end: at(22) }], late).lateMin, 40);
assert.equal(planVsFact(day, '10-22', [], late).status, 'absent');
assert.equal(planVsFact(day, '10-22', [{ start: at(10), end: at(20) }], late).status, 'early');
assert.equal(planVsFact(day, '10-22', [], at(9)).status, 'future');
assert.equal(planVsFact(day, '10-22', [{ start: at(9, 58), end: null }], at(12)).status, 'working');
assert.deepEqual(weekTotals(weekDays(mon), { '2026-11-16': { e1: '10:00–22:00' }, '2026-11-17': { e1: '18:00–02:00' } }, 'e1'), { shifts: 2, hours: 20 });
console.log('staff-schedule-ui: ok');
