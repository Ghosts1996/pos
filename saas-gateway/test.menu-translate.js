"use strict";
// Автоперевод меню гостя: перевод ИИ заведения, кеш на сервере, только новые
// строки, один запрос к ИИ на всех гостей сразу, ИИ выключен — «недоступно».
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "menu-tr-"));
Object.assign(process.env, {
  PORT: "8099", DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_AUTO_MIGRATE: "0",
  DATA_DB_FILE: path.join(dir, "data.sqlite"), AUTH_DB_FILE: path.join(dir, "auth.json"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
});
const server = require("./server.js");

(async () => {
  let n = 0;
  const db = server.localDataStore();
  const t = db.collection("tenants").doc("tr1");
  await t.set({ name: "Кафе", status: "active" });
  await t.collection("menuCategories").doc("c1").set({ name: "Горячее" });
  await t.collection("menuItems").doc("i1").set({ name: "Борщ", description: "Со сметаной, 300 г", categoryId: "c1", price: 350 });
  await t.collection("menuItems").doc("i2").set({ name: "Пельмени", categoryId: "c1", price: 420 });

  const calls = [];
  const fake = async (vendor, { content }) => {
    const arr = JSON.parse(content);
    calls.push(arr.length);
    await new Promise((r) => setTimeout(r, 30));
    return "```json\n" + JSON.stringify(arr.map((s) => `EN:${s}`)) + "\n```";
  };
  const vendorOf = async () => ({ apiKey: "k", baseUrl: "https://example.ai", models: ["m"], format: "openai" });

  const r1 = await server.translateMenu("tr1", "en", { complete: fake, vendorOf });
  assert.strictEqual(r1.available, true);
  assert.strictEqual(r1.map["Борщ"], "EN:Борщ");
  assert.strictEqual(r1.map["Со сметаной, 300 г"], "EN:Со сметаной, 300 г");
  assert.strictEqual(Object.keys(r1.map).length, 4);
  assert.deepStrictEqual(calls, [4]); n++;

  // Меню не менялось — из кеша, ИИ не вызывается.
  const r2 = await server.translateMenu("tr1", "en", { complete: fake, vendorOf });
  assert.strictEqual(r2.cached, true);
  assert.strictEqual(calls.length, 1); n++;

  // Новая позиция — переводится только она; удалённая уходит из словаря.
  await t.collection("menuItems").doc("i3").set({ name: "Морс", categoryId: "c1", price: 150 });
  await t.collection("menuItems").doc("i2").delete();
  const r3 = await server.translateMenu("tr1", "en", { complete: fake, vendorOf });
  assert.deepStrictEqual(calls, [4, 1]);
  assert.strictEqual(r3.map["Морс"], "EN:Морс");
  assert.ok(!("Пельмени" in r3.map)); n++;

  // 20 гостей одновременно на новом языке — один запрос к ИИ.
  const many = await Promise.all(Array.from({ length: 20 }, () => server.translateMenu("tr1", "zh", { complete: fake, vendorOf })));
  assert.ok(many.every((x) => x.map["Борщ"] === "EN:Борщ"));
  assert.deepStrictEqual(calls, [4, 1, 4]); n++;

  // ИИ в заведении выключен — честно «недоступно», без ошибки.
  await t.collection("menuItems").doc("i4").set({ name: "Компот", categoryId: "c1", price: 100 });
  const off = await server.translateMenu("tr1", "en", { complete: fake, vendorOf: async () => null });
  assert.deepStrictEqual(off, { available: false, reason: "ai-off" }); n++;

  // ИИ вернул не ту длину — ошибка, словарь не портится.
  const bad = async () => JSON.stringify(["a", "b", "c"]);
  await assert.rejects(server.translateMenu("tr1", "en", { complete: bad, vendorOf }), (e) => e.status === 502);
  const keep = (await db.collection("menuTranslations").doc("tr1_en").get()).data();
  assert.strictEqual(keep.map["Морс"], "EN:Морс"); n++;

  // Разбор JSON из ответа ИИ.
  assert.deepStrictEqual(server.extractJson('Вот: ```json\n[1,2]\n```'), [1, 2]);
  assert.deepStrictEqual(server.extractJson('{"a":1} хвост'), { a: 1 }); n++;

  // Правила базы: словари переводов клиентам закрыты (их пишет только сервер).
  const rules = fs.readFileSync(path.join(__dirname, "..", "saas", "firestore.rules"), "utf8");
  assert.ok(!/menuTranslations/.test(rules)); n++;
  console.log(`menu-translate: ${n} проверок`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
