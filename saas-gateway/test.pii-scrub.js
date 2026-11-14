"use strict";
// Провайдеры ИИ — за рубежом: персональные данные вычищаются на сервере в РФ.
const assert = require("assert/strict");
const { scrubText, scrubAiPayload } = require("./pii-scrub");
let n = 0;
const check = (name, fn) => { fn(); n++; };
check("телефоны, почта, карта, СНИЛС, ИНН — пометки", () => {
  assert.equal(scrubText("Позвоните +7 (900) 123-45-67 или 8 912 345 67 89, почта ivan@mail.ru, карта 4276 1600 1234 5678"),
    "Позвоните [телефон] или [телефон], почта [почта], карта [номер]");
  assert.equal(scrubText("СНИЛС 123-456-789 01, ИНН 151211052290, номер 9001234567"), "СНИЛС [номер], ИНН [номер], номер [телефон]");
});
check("суммы, столы, время, граммы не трогаются", () => {
  const plain = "Стол 12, счёт 3500 ₽, 2 гостя, бронь на 19:30 14.11.2026, чек №1045, 250 г, выручка 1 250 000 ₽";
  assert.equal(scrubText(plain), plain);
});
check("тело запроса OpenAI/Anthropic: сообщения чистятся, модель и картинки — нет", () => {
  const out = scrubAiPayload({ model: "gpt-4o", system: "почта a@b.ru", max_tokens: 900,
    messages: [{ role: "user", content: [{ type: "text", text: "тел 89001234567" }, { type: "image_url", image_url: { url: "data:x;89001234567" } }] }] });
  assert.equal(out.model, "gpt-4o");
  assert.equal(out.system, "почта [почта]");
  assert.equal(out.messages[0].content[0].text, "тел [телефон]");
  assert.equal(out.messages[0].content[1].image_url.url, "data:x;89001234567");
});
check("сервер ставит вычистку на оба пути к ИИ", () => {
  const fs = require("fs");
  assert.ok(/body: JSON\.stringify\(scrubAiPayload\(payload\)\)/.test(fs.readFileSync(__dirname + "/server.js", "utf8")), "aiProxy");
  assert.ok(/const messages = scrubAiPayload\(rawMessages\)/.test(fs.readFileSync(__dirname + "/support-ai.js", "utf8")), "бот поддержки");
});
console.log(`pii-scrub: ${n} проверок`);
