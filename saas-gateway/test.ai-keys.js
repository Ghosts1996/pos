"use strict";
// Подключение ключа ИИ одним полем: провайдер, модели и проверка — сами.
const assert = require("assert");
const keys = require("./ai-keys");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Подставной интернет: по адресу и ключу — ответ провайдера.
function fakeNet(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", auth: (opts.headers || {}).Authorization || (opts.headers || {})["x-api-key"] });
    for (const [re, fn] of routes) {
      if (re.test(url)) {
        const [status, body] = fn(url, opts);
        return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      }
    }
    throw new Error("getaddrinfo ENOTFOUND");
  };
  return { fetchImpl, calls };
}

test("ключ шлюза без префикса: перебор, первый ответивший списком — наш; модели выбраны", async () => {
  const net = fakeNet([
    [/tooken\.club\/v1\/models/, (u, o) => (o.headers.Authorization === "Bearer sk-good-123"
      ? [200, { data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }, { id: "text-embedding-3-small" }, { id: "dall-e-3" }] }]
      : [401, { error: { message: "Invalid API key" } }])],
    [/tooken\.club\/v1\/chat\/completions/, () => [200, { choices: [{ message: { content: "OK" } }] }]],
    [/\/models$/, () => [401, { error: { message: "Incorrect API key provided" } }]],
  ]);
  const r = await keys.probeKey({ apiKey: "sk-good-123" }, { fetchImpl: net.fetchImpl });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.vendor, "tooken");
  assert.strictEqual(r.light, "gpt-4o-mini");
  assert.strictEqual(r.heavy, "gpt-4o");
  assert.ok(!r.models.includes("dall-e-3") && !r.models.includes("text-embedding-3-small"), "в списке не только текстовые");
});

test("ключ Claude узнаётся по началу, формат Anthropic, пробный ответ — через /v1/messages", async () => {
  const net = fakeNet([
    [/api\.anthropic\.com\/v1\/models/, () => [200, { data: [{ id: "claude-haiku-4-5-20251001" }, { id: "claude-sonnet-4-5-20250929" }] }]],
    [/api\.anthropic\.com\/v1\/messages/, () => [200, { content: [{ type: "text", text: "OK" }] }]],
  ]);
  const r = await keys.probeKey({ apiKey: "sk-ant-api03-xyz" }, { fetchImpl: net.fetchImpl });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.format, "anthropic");
  assert.ok(r.light.includes("haiku") && r.heavy.includes("sonnet"));
  assert.ok(net.calls.every((c) => /anthropic/.test(c.url)), "лишние провайдеры не опрашивались");
});

test("Gemini из России: понятная причина и совет взять рублёвый шлюз", async () => {
  const net = fakeNet([
    [/generativelanguage/, () => [400, { error: { message: "User location is not supported for the API use." } }]],
  ]);
  const r = await keys.probeKey({ apiKey: `AIza${"x".repeat(35)}` }, { fetchImpl: net.fetchImpl });
  assert.strictEqual(r.ok, false);
  assert.ok(/не пускает запросы из России/.test(r.reason) && /Tooken/.test(r.reason), r.reason);
});

test("деньги кончились — так и сказано; неверный ключ — так и сказано", async () => {
  const pay = fakeNet([
    [/openrouter\.ai\/api\/v1\/models/, () => [200, { data: [{ id: "openai/gpt-4o-mini" }] }]],
    [/openrouter\.ai\/api\/v1\/chat/, () => [402, { error: { message: "Insufficient credits" } }]],
  ]);
  const r1 = await keys.probeKey({ apiKey: "sk-or-v1-abc" }, { fetchImpl: pay.fetchImpl });
  assert.ok(!r1.ok && /закончились деньги/.test(r1.reason), r1.reason);
  const bad = fakeNet([[/./, () => [401, { error: { message: "Invalid API key" } }]]]);
  const r2 = await keys.probeKey({ apiKey: "sk-or-v1-bad" }, { fetchImpl: bad.fetchImpl });
  assert.ok(!r2.ok && /Ключ не подошёл/.test(r2.reason), r2.reason);
});

test("свой шлюз по адресу: OpenAI-формат не отдал список — пробуем Anthropic", async () => {
  const net = fakeNet([
    [/my\.gw\/v1\/models\?limit/, () => [200, { data: [{ id: "claude-sonnet-4-5" }] }]],
    [/my\.gw\/v1\/models$/, () => [404, "not found"]],
    [/my\.gw\/v1\/messages/, () => [200, { content: [{ type: "text", text: "OK" }] }]],
  ]);
  const r = await keys.probeKey({ apiKey: "anykey-123456", baseUrl: "https://my.gw/v1/" }, { fetchImpl: net.fetchImpl });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.vendor, "custom");
  assert.strictEqual(r.format, "anthropic");
  assert.strictEqual(r.baseUrl, "https://my.gw/v1");
});

test("выбор моделей: новее, без даты, живой псевдоним; замена пропавшей модели", () => {
  assert.deepStrictEqual(keys.pickModels(["claude-3-5-haiku-20241022", "claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"]),
    { light: "claude-haiku-4-5-20251001", heavy: "claude-sonnet-4-5-20250929" });
  assert.deepStrictEqual(keys.pickModels(["gemini-2.5-flash", "gemini-flash-latest", "gemini-pro-latest", "gemini-2.5-flash-image"]),
    { light: "gemini-flash-latest", heavy: "gemini-pro-latest" });
  assert.deepStrictEqual(keys.pickModels(["deepseek-chat", "deepseek-reasoner"]), { light: "deepseek-chat", heavy: "deepseek-chat" });
  assert.strictEqual(keys.replacementModel("gpt-4o-mini", ["gpt-4o-mini-2024-07-18", "gpt-4o"]), "gpt-4o-mini-2024-07-18");
  assert.strictEqual(keys.replacementModel("gemini-1.5-pro", ["gemini-2.5-flash", "gemini-2.5-pro"], "heavy"), "gemini-2.5-pro");
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      console.error(`✗ ${name}\n  ${e.stack || e}`);
    }
  }
  console.log(`ai-keys: ${passed} из ${tests.length} проверок`);
  if (passed !== tests.length) process.exit(1);
})();
