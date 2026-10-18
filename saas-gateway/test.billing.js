"use strict";
// Срок подписки при оплате: пробные дни бесплатны и не пересчитываются по
// цене, оплаченные при смене тарифа — пересчитываются. Запуск: node test.billing.js
process.env.PORT = "8099"; // как smoke-тесты: без бота и фоновых задач
const assert = require("assert");
const server = require("./server.js");
const { periodCarry, paidDaysLeft } = server;

const DAY = 86400000;
const now = Date.UTC(2026, 9, 18, 12);
const T = (ms) => ({ toMillis: () => ms });
const days = (ms) => Math.round((ms / DAY) * 100) / 100;
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("пробный период: оставшиеся 7 дней переходят бесплатными — и на тот же тариф, и на дороже", () => {
  const cur = { status: "trial", planId: "start", trialEndsAt: T(now + 7 * DAY) };
  let r = periodCarry({ now, cur, planId: "start" });
  assert.deepStrictEqual([days(r.carryMs), days(r.freeMs)], [7, 7]);
  // Пробный «Старт», оплатили «Бизнес»: 7 бесплатных дней не пересчитываются по цене.
  r = periodCarry({ now, cur, planId: "standard", wasMonthly: 1790, nextMonthly: 2390 });
  assert.deepStrictEqual([days(r.carryMs), days(r.freeMs)], [7, 7]);
  // Пробный период уже кончился — переносить нечего.
  r = periodCarry({ now, cur: { status: "trial", trialEndsAt: T(now - DAY) }, planId: "start" });
  assert.strictEqual(r.carryMs, 0);
});

test("смена тарифа после оплаты: оплаченные дни — по цене нового тарифа, бесплатные — как есть", () => {
  // 60 оплаченных дней «Бизнеса» (2 390 ₽) → «Про» (2 990 ₽): ≈ 48 дней.
  let r = periodCarry({ now, cur: { status: "active", planId: "standard", currentPeriodEnd: T(now + 60 * DAY) }, planId: "pro", wasMonthly: 2390, nextMonthly: 2990 });
  assert.strictEqual(days(r.carryMs), 47.96);
  assert.strictEqual(r.freeMs, 0);
  // На тариф дешевле дней больше: 60 → ≈ 80 на «Старте».
  r = periodCarry({ now, cur: { status: "active", planId: "standard", currentPeriodEnd: T(now + 60 * DAY) }, planId: "start", wasMonthly: 2390, nextMonthly: 1790 });
  assert.strictEqual(days(r.carryMs), 80.11);
  // В сроке 5 бесплатных дней из пробного периода и 30 оплаченных: пересчитываются только 30.
  const cur = { status: "active", planId: "standard", currentPeriodEnd: T(now + 35 * DAY), freeUntil: T(now + 5 * DAY) };
  r = periodCarry({ now, cur, planId: "pro", wasMonthly: 2390, nextMonthly: 2990 });
  assert.strictEqual(days(r.freeMs), 5);
  assert.strictEqual(days(r.carryMs), 5 + 23.98);
});

test("продление того же тарифа: весь остаток как есть, бесплатная часть помнится", () => {
  const cur = { status: "active", planId: "standard", currentPeriodEnd: T(now + 35 * DAY), freeUntil: T(now + 5 * DAY) };
  const r = periodCarry({ now, cur, planId: "standard", wasMonthly: 2390, nextMonthly: 2390 });
  assert.deepStrictEqual([days(r.carryMs), days(r.freeMs)], [35, 5]);
  // Бесплатные дни уже прошли — весь остаток оплаченный.
  const r2 = periodCarry({ now, cur: { ...cur, freeUntil: T(now - DAY) }, planId: "standard" });
  assert.deepStrictEqual([days(r2.carryMs), r2.freeMs], [35, 0]);
});

test("просрочка: старый срок не переносится, новый период — с момента оплаты", () => {
  for (const status of ["past_due", "cancelled", undefined]) {
    const r = periodCarry({ now, cur: { status, planId: "standard", currentPeriodEnd: T(now + 10 * DAY) }, planId: "standard" });
    assert.strictEqual(r.carryMs, 0, String(status));
  }
});

test("новая точка сети доплачивает только за оплаченные дни, не за пробные", () => {
  assert.strictEqual(paidDaysLeft({ currentPeriodEnd: T(now + 35 * DAY), freeUntil: T(now + 5 * DAY) }, now), 30);
  assert.strictEqual(paidDaysLeft({ currentPeriodEnd: T(now + 35 * DAY) }, now), 35);
  assert.strictEqual(paidDaysLeft({ currentPeriodEnd: T(now + 3 * DAY), freeUntil: T(now + 5 * DAY) }, now), 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      console.error(`✗ ${name}\n  ${e && e.stack ? e.stack : e}`);
      process.exitCode = 1;
    }
  }
  console.log(`billing: ${passed} из ${tests.length} проверок`);
  process.exit(process.exitCode || 0);
})();
