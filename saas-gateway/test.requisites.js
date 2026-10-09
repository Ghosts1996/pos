"use strict";
// Реквизиты продавца (requisites.js): контрольные цифры ИНН/ОГРН и сверка
// с ЕГРЮЛ — на поддельном ответе egrul.nalog.ru.
const assert = require("assert/strict");
const r = require("./requisites");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("контрольные цифры: настоящие номера проходят, выдуманные — нет", () => {
  assert.equal(r.innValid("7707083893"), true); // ПАО Сбербанк
  assert.equal(r.innValid("500100732259"), true); // ИП
  assert.equal(r.innValid("7707083894"), false);
  assert.equal(r.innValid("111664888423"), false);
  assert.equal(r.ogrnValid("1027700132195"), true);
  assert.equal(r.ogrnValid("304500116000157"), true);
  assert.equal(r.ogrnValid("494855721555528"), false); // ОГРНИП начинается с 3
  assert.equal(r.ogrnValid("1027700132196"), false);
});

test("тип: у организации ИНН 10 + ОГРН 13, у ИП — 12 + 15", () => {
  assert.equal(r.requisitesProblem("7707083893", "1027700132195"), null);
  assert.equal(r.requisitesProblem("500100732259", "304500116000157"), null);
  assert.match(r.requisitesProblem("7707083893", "304500116000157"), /ОГРН из 13/);
  assert.match(r.requisitesProblem("500100732259", "1027700132195"), /ОГРНИП из 15/);
  assert.match(r.requisitesProblem("12345", "1027700132195"), /10 цифр/);
});

const egrul = (rows, { captcha = false, wait = 0 } = {}) => {
  let polls = 0;
  return async (url, opts = {}) => {
    const json = (o) => ({ ok: true, json: async () => o });
    if (opts.method === "POST") return json(captcha ? { captchaRequired: true } : { t: "tok" });
    polls++;
    return json(polls <= wait ? { status: "wait" } : { rows });
  };
};
const SBER = { i: "7707083893", o: "1027700132195", c: "ПАО СБЕРБАНК", n: "ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО «СБЕРБАНК РОССИИ»" };

test("ЕГРЮЛ: найдено и ОГРН совпадает", async () => {
  const res = await r.checkSeller({ inn: "7707083893", ogrn: "1027700132195" }, egrul([SBER], { wait: 1 }));
  assert.equal(res.status, "ok");
  assert.equal(res.name, "ПАО СБЕРБАНК");
});

test("ЕГРЮЛ: такого ИНН нет / другой ОГРН / деятельность прекращена", async () => {
  assert.equal((await r.checkSeller({ inn: "7707083893", ogrn: "1027700132195" }, egrul([]))).status, "problem");
  const other = await r.checkSeller({ inn: "7707083893", ogrn: "5077746887312" }, egrul([SBER]));
  assert.equal(other.status, "problem");
  assert.match(other.message, /1027700132195/);
  const closed = await r.checkSeller({ inn: "7707083893", ogrn: "1027700132195" }, egrul([{ ...SBER, e: "01.02.2025" }]));
  assert.match(closed.message, /прекращена/);
});

test("ФНС не ответила или ответ непонятен — не мешаем владельцу", async () => {
  assert.equal((await r.checkSeller({ inn: "7707083893", ogrn: "1027700132195" }, egrul([], { captcha: true }))).status, "unavailable");
  assert.equal((await r.checkSeller({ inn: "7707083893", ogrn: "1027700132195" }, async () => { throw new Error("сеть"); })).status, "unavailable");
  assert.equal((await r.checkSeller({ inn: "7707083893", ogrn: "1027700132195" }, egrul([{ x: 1 }]))).status, "unavailable");
});

test("выдуманные цифры отсекаются до запроса в ФНС", async () => {
  let called = false;
  const res = await r.checkSeller({ inn: "111664888423", ogrn: "494855721555528" }, async () => { called = true; });
  assert.equal(res.status, "problem");
  assert.equal(called, false);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
    } catch (e) {
      console.error(`✗ ${name}\n`, e);
      process.exit(1);
    }
  }
  console.log(`requisites: ${tests.length} тестов прошли`);
})();
