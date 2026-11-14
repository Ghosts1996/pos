"use strict";
// «Отлично подойдёт к вашему заказу» в корзине веб-версии гостя (pickUpsell).
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const src = fs.readFileSync(path.join(__dirname, "..", "saas", "guest-web", "app", "app.js"), "utf8");
const m = src.match(/function pickUpsell\([\s\S]*?\n}\n/);
assert.ok(m, "pickUpsell есть в app.js");
const pickUpsell = new Function(`${m[0]}; return pickUpsell;`)();
let n = 0;
const items = [
  { id: "borsch", name: "Борщ", categoryId: "hot", price: 350, popularRank: 1 },
  { id: "pelmeni", name: "Пельмени", categoryId: "hot", price: 420, popularRank: 2 },
  { id: "mors", name: "Морс", categoryId: "drinks", price: 150, popularRank: 3 },
  { id: "tea", name: "Чай", categoryId: "drinks", price: 120 },
  { id: "cake", name: "Медовик", categoryId: "dessert", price: 280, popularRank: 5 },
  { id: "beer", name: "Пиво", categoryId: "bar", price: 300, popularRank: 4 },
  { id: "salad", name: "Цезарь", categoryId: "salads", price: 390, available: false },
  { id: "free", name: "Хлеб", categoryId: "bread", price: 0 },
];
const all = () => true;
// Пустая корзина — ничего не предлагаем.
assert.deepStrictEqual(pickUpsell(items, {}, all), []); n++;
// Борщ в корзине: не горячее, по одному из раздела, популярные первыми, без стоп-листа и бесплатного.
assert.deepStrictEqual(pickUpsell(items, { borsch: 1 }, all).map((i) => i.id), ["mors", "beer", "cake"]); n++;
// Навынос алкоголь нельзя — его место занимает следующий раздел.
const noBar = (i) => i.categoryId !== "bar";
assert.deepStrictEqual(pickUpsell(items, { borsch: 2 }, noBar).map((i) => i.id), ["mors", "cake"]); n++;
// Позиция с добавками в корзине (ключ «id|…») — раздел тоже считается занятым.
assert.deepStrictEqual(pickUpsell(items, { "mors|sugar": 1, borsch: 1 }, all).map((i) => i.id), ["beer", "cake"]); n++;
// Всё уже в корзине — пусто, лимит соблюдается.
assert.strictEqual(pickUpsell(items, { borsch: 1 }, all, 1).length, 1); n++;
// Блок только в корзине (cartBlock получает его третьим аргументом) и с понятным заголовком.
assert.ok(/cartBlock\(items, false, upsellBlock\(pickUpsell\(regular/.test(src));
assert.ok(/cartBlock\(items, true, upsellBlock\(pickUpsell\(regular, state\.cart, \(i\) => !hasMods\(i\) && canTakeAway\(i\)\)\)\)/.test(src));
assert.ok(src.includes("Отлично подойдёт к вашему заказу")); n++;
console.log(`guest-upsell: ${n} проверок`);
