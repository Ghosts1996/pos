"use strict";
// Выручка «до копейки»: бот (telegram.js salesStats), кабинет (console.js
// sessionBill — сама функция из файла кабинета) и Z-отчёт кассы
// (test/revenue_parity_test.dart) считают одни и те же чеки
// (test-fixtures/revenue-sessions.json) и получают одни и те же числа.
process.env.PORT = process.env.PORT || "8099";
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { salesStats } = require("./telegram");
const { sessionBill: gatewayBill } = require("./guest-pay");

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "test-fixtures", "revenue-sessions.json"), "utf8"));
const sessions = Object.assign(fx.sessions.map((s) => ({ ...s })), { period: fx.period });

// 1. Бот.
const st = salesStats(sessions, fx.excludeTobacco);
assert.equal(Math.round(st.gross * 100) / 100, fx.expected.sales, "бот: продажи");
assert.equal(Math.round(st.refundSum * 100) / 100, fx.expected.refunds, "бот: возвраты");
assert.equal(Math.round(st.revenue * 100) / 100, fx.expected.revenue, "бот: выручка");
assert.equal(st.checks, fx.expected.checks, "бот: чеков");

// 2. Кабинет — функция sessionBill из console.js как есть.
const consoleSrc = fs.readFileSync(path.join(__dirname, "..", "saas", "console", "console.js"), "utf8");
const m = /const BILL_TOBACCO_RE = [^\n]+\nfunction sessionBill\([\s\S]*?\n}\n/.exec(consoleSrc);
assert.ok(m, "в console.js есть sessionBill");
const consoleBill = new Function(`${m[0]}; return sessionBill;`)();
const inP = (v) => v >= fx.period.from && v < fx.period.to;
let sales = 0, refunds = 0, checks = 0;
for (const s of fx.sessions) {
  // Запросы кабинета: status == closed и closedAt за сутки; refundedAt за сутки.
  if (s.status === "closed" && inP(s.closedAt) && !s.closedWithoutPayment) { checks++; sales += consoleBill(s, fx.excludeTobacco); }
  if (s.refunded === true && inP(s.refundedAt) && !s.closedWithoutPayment) refunds += consoleBill(s, fx.excludeTobacco);
}
assert.equal(Math.round(sales * 100) / 100, fx.expected.sales, "кабинет: продажи");
assert.equal(Math.round((sales - refunds) * 100) / 100, fx.expected.revenue, "кабинет: выручка");
assert.equal(checks, fx.expected.checks, "кабинет: чеков");

// 3. Формула счёта кабинета = формула шлюза на каждом чеке.
for (const s of fx.sessions) {
  for (const ex of [true, false]) assert.equal(consoleBill(s, ex), gatewayBill(s, ex), `${s.id}, excludeTobacco=${ex}`);
}
// 4. Выгрузка «Для бухгалтера» (accounting-export.js) — та же сумма каждого чека
// и те же итоги за период, что у кабинета и бота.
(async () => {
  const acc = await import(require("url").pathToFileURL(path.join(__dirname, "..", "saas", "console", "accounting-export.js")).href);
  for (const s of fx.sessions) {
    for (const ex of [true, false]) assert.equal(acc.checkTotal(s, ex), consoleBill(s, ex), `выгрузка: ${s.id}, excludeTobacco=${ex}`);
  }
  const sheets = acc.buildAccountingSheets({
    sessions: fx.sessions.filter((s) => s.status === "closed" && inP(s.closedAt)),
    refunds: fx.sessions.filter((s) => s.refunded === true && inP(s.refundedAt)),
  }, { excludeTobacco: fx.excludeTobacco });
  const sum = Object.fromEntries(sheets.find((x) => x.name === "Сводка").rows.slice(1));
  assert.equal(sum["Чеков"], fx.expected.checks, "выгрузка: чеков");
  assert.equal(sum["Выручка за вычетом возвратов, ₽"], fx.expected.revenue, "выгрузка: выручка");
  console.log("revenue-parity: выгрузка для бухгалтера совпала с кабинетом и ботом");
})().catch((e) => { console.error(e); process.exit(1); });
console.log("revenue-parity: бот и кабинет совпали — продажи", fx.expected.sales, "возвраты", fx.expected.refunds, "выручка", fx.expected.revenue);
