"use strict";
// ИИ-импорт меню из фото/PDF («Перенос данных»): права, проверка снимков,
// «ИИ не подключён», распознавание (подставной ИИ) → строки предпросмотра.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { PassThrough } = require("stream");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "menu-ai-"));
Object.assign(process.env, {
  PORT: "8099", DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_AUTO_MIGRATE: "0",
  DATA_DB_FILE: path.join(dir, "data.sqlite"), AUTH_DB_FILE: path.join(dir, "auth.json"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
  TELEGRAM_SECRET_KEY: "test-secret-key-for-menu-ai-0123456789",
});
const server = require("./server.js");

const post = async (p, body, token) => {
  const r = await fetch(`http://127.0.0.1:8099${p}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
// Прямой вызов обработчика с подставным ИИ: запрос — поток с телом и токеном.
const call = (token, body, opts) => new Promise((resolve, reject) => {
  const req = new PassThrough();
  req.headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  req.method = "POST";
  req.url = "/menuImportAi";
  const res = { statusCode: 0, headers: {}, writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); }, setHeader() {}, end(b) { resolve({ status: this.statusCode, json: JSON.parse(String(b || "{}")) }); } };
  server.handleMenuImportAi(req, res, opts).catch((e) => (e && e.status ? resolve({ status: e.status, json: { error: e.message } }) : reject(e)));
  req.end(JSON.stringify(body));
});
const jpeg = Buffer.from("ffd8ffe000104a464946", "hex").toString("base64");

(async () => {
  let n = 0;
  await new Promise((r) => setTimeout(r, 300));
  const owner = (await post("/auth/signup", { email: "owner-ai@test.ru", password: "secret123" })).json;
  const stranger = (await post("/auth/signup", { email: "other-ai@test.ru", password: "secret123" })).json;
  const db = server.localDataStore();
  await db.collection("tenants").doc("mai1").set({ name: "Кафе", status: "active" });
  await db.collection("tenantMembers").doc(`mai1_${owner.uid}`).set({ tenantId: "mai1", userId: owner.uid, role: "owner", status: "active" });

  // Чужой человек — 403, даже с правильными снимками.
  let r = await post("/menuImportAi", { tenantId: "mai1", pages: [{ mediaType: "image/jpeg", data: jpeg }] }, stranger.idToken);
  assert.strictEqual(r.status, 403); n++;
  // Не картинка / слишком много / слишком большой снимок — 400/413.
  r = await post("/menuImportAi", { tenantId: "mai1", pages: [{ mediaType: "text/html", data: jpeg }] }, owner.idToken);
  assert.strictEqual(r.status, 400);
  r = await post("/menuImportAi", { tenantId: "mai1", pages: Array.from({ length: 11 }, () => ({ mediaType: "image/jpeg", data: jpeg })) }, owner.idToken);
  assert.strictEqual(r.status, 400);
  r = await post("/menuImportAi", { tenantId: "mai1", pages: [{ mediaType: "image/jpeg", data: "A".repeat(970000) }] }, owner.idToken);
  assert.ok(r.status === 413 || r.status === 400, `большой снимок: ${r.status}`); n++;
  // ИИ в заведении не подключён — понятная 412.
  r = await post("/menuImportAi", { tenantId: "mai1", pages: [{ mediaType: "image/jpeg", data: jpeg }] }, owner.idToken);
  assert.strictEqual(r.status, 412);
  assert.match(r.json.error, /Подключите ИИ/); n++;

  // Распознавание: подставной ИИ отвечает JSON в ```json, с дублем и мусором.
  const seen = [];
  const complete = async (vendor, { content }) => {
    seen.push(content.find((c) => c.type === "image").mediaType);
    return "Вот меню:\n```json\n" + JSON.stringify([
      { category: "Горячее", name: "Борщ", price: "350 ₽", weight: "300 г", description: "со сметаной" },
      { category: "Горячее", name: "Борщ", price: 350, weight: "300 г" },
      { category: "Напитки", name: "Морс", price: "120,50" },
      { category: "", name: "Без цены" },
      { name: "<b>Пицца</b>", price: 0 },
    ]) + "\n```";
  };
  const vendorOf = async () => ({ apiKey: "k", baseUrl: "https://example.ai", models: ["m", "m2"], format: "openai" });
  r = await call(owner.idToken, { tenantId: "mai1", pages: [{ mediaType: "image/jpeg", data: jpeg }] }, { complete, vendorOf });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.rows, [
    ["Категория", "Название", "Цена", "Описание", "Выход"],
    ["Горячее", "Борщ", "350", "со сметаной", "300 г"],
    ["Напитки", "Морс", "120.5", "", ""],
  ]);
  assert.deepStrictEqual(seen, ["image/jpeg"]); n++;

  // Строки годятся для обычного разбора «Переноса данных» (import-core).
  const I = await import(require("url").pathToFileURL(path.join(__dirname, "..", "saas", "console", "import-core.js")).href);
  const head = I.findHeader(r.json.rows);
  const map = I.guessMapping("menu", r.json.rows[head]);
  const built = I.buildRows("menu", r.json.rows.slice(head + 1), map, { headerIndex: head });
  assert.strictEqual(I.guessKind(r.json.rows[head]), "menu");
  assert.deepStrictEqual(built.items.map((x) => [x.category, x.name, x.price]), [["Горячее", "Борщ", 350], ["Напитки", "Морс", 120.5]]);
  // Выход распознанного меню — в граммовку позиции, а не в описание.
  assert.strictEqual(map.weight, 4);
  assert.deepStrictEqual([built.items[0].weight, built.items[0].weightUnit, built.items[0].description], [300, "g", "со сметаной"]);
  assert.ok(!("weight" in built.items[1])); n++;

  // ИИ ничего не нашёл — 422 с понятной причиной.
  r = await call(owner.idToken, { tenantId: "mai1", pages: [{ mediaType: "image/jpeg", data: jpeg }] }, { complete: async () => "[]", vendorOf });
  assert.strictEqual(r.status, 422); n++;

  // Лимит: не больше 60 снимков в час на заведение (уже потрачено 3).
  let accepted = 3;
  let refused = 0;
  for (let i = 0; i < 8; i++) {
    const x = await call(owner.idToken, { tenantId: "mai1", pages: Array.from({ length: 10 }, () => ({ mediaType: "image/jpeg", data: jpeg })) }, { complete, vendorOf });
    if (x.status === 429) refused++;
    else accepted += 10;
  }
  assert.ok(accepted <= 60 && accepted >= 50, `принято снимков: ${accepted}`);
  assert.ok(refused >= 2, "сверх лимита — 429");
  r = await call(owner.idToken, { tenantId: "mai1", pages: Array.from({ length: 10 }, () => ({ mediaType: "image/jpeg", data: jpeg })) }, { complete, vendorOf });
  assert.strictEqual(r.status, 429); n++;

  // pdf.js — свой, на сайте (не CDN), с лицензией.
  const v = path.join(__dirname, "..", "saas", "console", "vendor", "pdfjs");
  assert.ok(fs.existsSync(path.join(v, "pdf.min.js")) && fs.existsSync(path.join(v, "pdf.worker.min.js")) && fs.existsSync(path.join(v, "LICENSE")));
  assert.ok(/import\('\.\/vendor\/pdfjs\/pdf\.min\.js'\)/.test(fs.readFileSync(path.join(__dirname, "..", "saas", "console", "console.js"), "utf8"))); n++;
  console.log(`menu-import-ai: ${n} проверок`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
