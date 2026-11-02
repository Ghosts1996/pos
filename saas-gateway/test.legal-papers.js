"use strict";
// Бумаги владельцу: акт об уничтожении ПДн (приказ РКН № 179) — состав, номер,
// отправка только владельцу, работа без почты и при её сбое.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { createLegalPapers, destructionActBlocks, operatorName } = require("./legal-papers");

const LEGAL = {
  fullName: "ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ ИВАНОВ ИВАН ИВАНОВИЧ", ogrnip: "300000000000000", inn: "770000000000",
  address: "Российская Федерация, г. Москва", email: "owner@example.ru",
};

// Текст документа из .docx (zip без сжатия или deflate) — для проверок.
function docxText(buf) {
  let i = 0;
  while (i < buf.length - 30) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString();
    const start = i + 30 + nameLen + extra;
    const data = buf.slice(start, start + size);
    if (name === "word/document.xml") {
      const xml = (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
      return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    }
    i = start + size;
  }
  return "";
}

function fakeDb() {
  const docs = new Map();
  const ref = (p) => ({
    get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }),
    set: async (v, o) => { docs.set(p, o && o.merge ? { ...(docs.get(p) || {}), ...v } : v); },
  });
  return () => ({ collection: (c) => ({ doc: (d) => ref(`${c}/${d}`) }) });
}

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("акт: все сведения по п. 3 приказа № 179 и выгрузка из журнала", () => {
  const blocks = destructionActBlocks({
    legal: LEGAL, number: 7, at: Date.UTC(2026, 10, 2, 9, 0),
    items: [{ subject: "Гость Анна, телефон ***4567, идентификатор u1", categories: ["имя", "номер телефона"], processor: "Заведение «Кофейня» (Заказчик Платформы)" }],
    reason: "Отзыв согласия",
  });
  const text = JSON.stringify(blocks);
  for (const need of ["АКТ № 7", "Индивидуальный предприниматель Иванов Иван Иванович", "ОГРНИП 300000000000000", "г. Москва",
    "Заведение «Кофейня»", "Гость Анна", "имя, номер телефона", "Платформа ZalPOS", "Удаление записей", "Отзыв согласия", "02.11.2026",
    "ВЫГРУЗКА ИЗ ЖУРНАЛА", "12:00 МСК", "Подпись"]) {
    assert.ok(text.includes(need), `в акте нет: ${need}`);
  }
  assert.strictEqual(operatorName("ООО Ромашка"), "ООО Ромашка");
});

test("удаление → акт с номером по порядку, на почту владельцу и копия на сервере", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papers-"));
  const mails = [];
  const papers = createLegalPapers({
    db: fakeDb(), dir, env: {}, now: () => Date.UTC(2026, 10, 2, 9, 0),
    getMailer: () => ({ send: async (m) => { mails.push(m); } }),
    platformLegal: async () => LEGAL,
  });
  const item = { subject: "Гость, идентификатор u1", categories: ["имя"] };
  const r1 = await papers.destruction([item], { reason: "Отзыв согласия" });
  const r2 = await papers.destruction([item, { ...item, subject: "Гость, идентификатор u2" }], { reason: "Истечение срока хранения" });
  assert.ok(r1.emailed && r2.emailed);
  assert.strictEqual(mails.length, 2);
  assert.ok(mails.every((m) => m.to === "owner@example.ru"), "только владельцу");
  assert.match(mails[0].subject, /Акт № 1 /);
  assert.match(mails[1].subject, /Акт № 2 /);
  const file = mails[1].attachments[0];
  assert.match(file.filename, /^Акт_уничтожения_ПДн_2_02\.11\.2026\.docx$/);
  const text = docxText(file.content);
  assert.ok(text.includes("u2") && text.includes("Истечение срока хранения"), text.slice(0, 300));
  assert.ok(fs.existsSync(path.join(dir, file.filename)), "копия на сервере");
  assert.strictEqual(await papers.destruction([], { reason: "x" }), null, "пусто — без акта");
});

test("LEGAL_PAPERS_TO важнее почты из реквизитов; без почты — только файл; сбой почты не бросает", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papers-"));
  const mails = [];
  const base = { db: fakeDb(), dir, platformLegal: async () => LEGAL };
  await createLegalPapers({ ...base, env: { LEGAL_PAPERS_TO: "me@private.ru" }, getMailer: () => ({ send: async (m) => mails.push(m) }) })
    .destruction([{ subject: "s", categories: [] }], { reason: "r" });
  assert.strictEqual(mails[0].to, "me@private.ru");
  const off = await createLegalPapers({ ...base, env: {}, getMailer: () => null }).destruction([{ subject: "s", categories: [] }], { reason: "r" });
  assert.ok(!off.emailed && fs.existsSync(off.saved));
  const broken = await createLegalPapers({ ...base, env: {}, getMailer: () => ({ send: async () => { throw new Error("SMTP down"); } }) })
    .destruction([{ subject: "s", categories: [] }], { reason: "r" });
  assert.strictEqual(broken, null);
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
  console.log(`legal-papers: ${passed} из ${tests.length} проверок`);
  if (passed !== tests.length) process.exit(1);
})();
