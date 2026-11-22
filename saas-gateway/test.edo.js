"use strict";
// Накладные из ЭДО (edo.js): подставные Диадок и СБИС отвечают как
// настоящие API — вход, ящик организации, входящие УПД (только УПД),
// файл накладной, повторный вход при протухшем токене, понятные ошибки
// доступа, ключи зашифрованы, сигнал о новых накладных один раз, отметка
// «проведена».
const fs = require("fs");
const os = require("os");
const path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edo-"));
Object.assign(process.env, {
  PORT: "8097", DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0", GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "edo-secret-key-0123456789abcdef01234",
});
const assert = require("assert/strict");
const server = require("./server.js");
const admin = require("firebase-admin");
const { encrypt, decrypt, secretKey } = require("./telegram");
const E = require("./edo");
const store = server.localDataStore();
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const UPD = '<?xml version="1.0" encoding="windows-1251"?><Файл ИдФайл="ON_NSCHFDOPPR_1"><Документ Функция="СЧФДОП"/></Файл>';
const calls = [];
let diadocToken = "T1";
let sbisSid = "S1";
const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), arrayBuffer: async () => Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) });

async function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  calls.push({ url, headers: opts.headers || {}, body: opts.body });
  const auth = (opts.headers || {}).Authorization || "";
  if (u.hostname === "diadoc-api.kontur.ru") {
    if (u.pathname === "/V3/Authenticate") {
      const b = JSON.parse(opts.body);
      if (!auth.includes("ddauth_api_client_id=KEY") || b.password !== "pass") return json(401, "bad");
      return json(200, diadocToken);
    }
    if (!auth.includes(`ddauth_token=${diadocToken}`)) return json(401, "expired");
    if (u.pathname === "/GetMyOrganizations") return json(200, { Organizations: [{ FullName: "ООО «Кафе»", Boxes: [{ BoxIdGuid: "box-1", Title: "Кафе" }] }] });
    if (u.pathname === "/V3/GetDocuments") {
      assert.equal(u.searchParams.get("filterCategory"), "Any.Inbound");
      return json(200, { Documents: [
        { MessageId: "m1", EntityId: "e1", TypeNamedId: "UniversalTransferDocument", DocumentNumber: "123", DocumentDate: "20.11.2026", CounteragentBoxId: "x", UniversalTransferDocumentMetadata: { Total: "15480.50" }, IndexKey: "k1" },
        { MessageId: "m2", EntityId: "e2", TypeNamedId: "Nonformalized", DocumentNumber: "письмо", IndexKey: "k2" },
      ] });
    }
    if (u.pathname === "/V4/GetEntityContent") {
      assert.equal(u.searchParams.get("messageId"), "m1");
      return json(200, UPD);
    }
  }
  if (u.hostname === "online.sbis.ru") {
    const b = JSON.parse(opts.body || "{}");
    if (u.pathname === "/auth/service/") {
      if (b.params["Параметр"]["Пароль"] !== "pass") return json(200, { error: { message: "Неверный логин или пароль" } });
      return json(200, { result: sbisSid });
    }
    if ((opts.headers || {})["X-SBISSessionID"] !== sbisSid) return json(401, {});
    if (u.pathname === "/service/") {
      const doc = { "Идентификатор": "g-1", "Номер": "77", "Дата": "21.11.2026", "Сумма": "990.00",
        "Контрагент": { "СвЮЛ": { "Название": "ООО «Овощи»", "ИНН": "7700000001" } },
        "Вложение": [{ "Тип": "УпдСчфДоп", "Файл": { "Имя": "ON_NSCHFDOPPR_2.xml", "Ссылка": "https://online.sbis.ru/disk/api/v1/f1" } }] };
      if (b.method === "СБИС.СписокДокументов") {
        assert.equal(b.params["Фильтр"]["Тип"], "ДокОтгрВх");
        return json(200, { result: { "Документ": [doc, { "Идентификатор": "g-2", "Номер": "без файла", "Вложение": [] }] } });
      }
      if (b.method === "СБИС.ПрочитатьДокумент") return json(200, { result: doc });
    }
    if (u.pathname === "/disk/api/v1/f1") return json(200, UPD);
  }
  return json(404, { error: "нет такого адреса в подделке" });
}

const alerts = [];
const lib = E.createEdo({
  db: () => store, admin, verifyAuth: async () => ({ uid: "u1" }), parseJsonBody: async () => ({}), sendJson: () => {}, HttpError,
  requireTenantRole: async () => {}, encrypt: (v) => encrypt(secretKey(), v), decrypt: (v) => decrypt(secretKey(), v),
  ownerAlert: async (tid, text) => alerts.push({ tid, text }), fetchImpl: fakeFetch,
});

const tests = [];
const test = (n, f) => tests.push([n, f]);
const call = (tid, body) => new Promise((resolve, reject) => {
  const h = E.createEdo({
    db: () => store, admin, verifyAuth: async () => ({ uid: "u1" }), parseJsonBody: async () => ({ tenantId: tid, ...body }),
    sendJson: (_res, status, data) => resolve({ status, data }), HttpError, requireTenantRole: async () => {},
    encrypt: (v) => encrypt(secretKey(), v), decrypt: (v) => decrypt(secretKey(), v), ownerAlert: async (t, text) => alerts.push({ tid: t, text }), fetchImpl: fakeFetch,
  });
  h.handle({}, {}).catch(reject);
});

test("Диадок: неверный пароль — понятная ошибка, настройки сохранены", async () => {
  await assert.rejects(call("t1", { action: "settings", settings: { provider: "diadoc", login: "u", password: "nope", apiKey: "KEY" } }), /Сохранено, но Диадок не принял/);
  const raw = (await store.collection("edo").doc("t1").get()).data();
  assert.ok(raw.passwordEnc && !JSON.stringify(raw).includes("nope"), "пароль только зашифрованным");
});

test("Диадок: подключение, только УПД во входящих, файл, ящик запомнен", async () => {
  const r = await call("t1", { action: "settings", settings: { provider: "diadoc", login: "u", password: "pass", apiKey: "KEY" } });
  assert.equal(r.data.configured, true);
  assert.equal(r.data.orgName, "ООО «Кафе»");
  const l = await call("t1", { action: "list" });
  assert.equal(l.data.docs.length, 1, "неформализованное письмо — не накладная");
  assert.deepEqual([l.data.docs[0].number, l.data.docs[0].date, l.data.docs[0].total], ["123", "20.11.2026", 15480.5]);
  const f = await call("t1", { action: "file", id: l.data.docs[0].id });
  assert.equal(Buffer.from(f.data.xml, "base64").toString(), UPD);
  // Токен протух — сервер входит заново сам.
  diadocToken = "T2";
  assert.equal((await call("t1", { action: "list" })).data.docs.length, 1);
  await assert.rejects(call("t1", { action: "file", id: "d|box-1|../../x|e" }), /Неверный документ/);
});

test("СБИС: подключение, список с файлом УПД, файл по ссылке с сессией", async () => {
  await assert.rejects(call("t2", { action: "settings", settings: { provider: "sbis", login: "u", password: "x" } }), /Неверный логин или пароль/);
  const r = await call("t2", { action: "settings", settings: { provider: "sbis", login: "u", password: "pass" } });
  assert.equal(r.data.provider, "sbis");
  const l = await call("t2", { action: "list" });
  assert.equal(l.data.docs.length, 1, "документ без файла не показываем");
  assert.equal(l.data.docs[0].supplier, "ООО «Овощи»");
  assert.equal(l.data.docs[0].fileUrl, undefined, "ссылку на файл в кабинет не отдаём");
  const f = await call("t2", { action: "file", id: l.data.docs[0].id });
  assert.equal(Buffer.from(f.data.xml, "base64").toString(), UPD);
  assert.equal(calls.filter((c) => c.url.includes("/disk/api/")).pop().headers["X-SBISSessionID"], "S1");
});

test("сторож: о новой накладной — один раз, первая проверка не шлёт старое, «проведена» — отметка", async () => {
  alerts.length = 0;
  await store.collection("edoState").doc("t3").delete().catch(() => {});
  await store.collection("edo").doc("t3").set({ provider: "diadoc", loginEnc: encrypt(secretKey(), "u"), passwordEnc: encrypt(secretKey(), "pass"), apiKeyEnc: encrypt(secretKey(), "KEY"), alerts: true });
  await store.collection("edoState").doc("t1").delete();
  await store.collection("edoState").doc("t2").delete();
  await lib.runAll();
  assert.equal(alerts.length, 0, "первая проверка после подключения — без старых накладных");
  await store.collection("edoState").doc("t3").set({ alerted: [] });
  await lib.runAll();
  const a = alerts.filter((x) => x.tid === "t3");
  assert.equal(a.length, 1);
  assert.match(a[0].text, /№ 123 от 20\.11\.2026, 15\s480,50 ₽/);
  await lib.runAll();
  assert.equal(alerts.filter((x) => x.tid === "t3").length, 1, "второй раз не пишем");
  const id = (await call("t3", { action: "list" })).data.docs[0].id;
  await call("t3", { action: "posted", ids: [id] });
  assert.equal((await call("t3", { action: "list" })).data.docs[0].posted, true);
  await call("t3", { action: "disconnect" });
  assert.equal((await call("t3", { action: "status" })).data.configured, false);
});

test("разбор списков", () => {
  const s = E.sbisSummary({ "Идентификатор": "x", "Номер": "1", "Сумма": "1 234,50", "Контрагент": { "СвФЛ": { "Фамилия": "Иванов", "Имя": "Пётр" } }, "Вложение": [{ "Тип": "УпдСчфДоп", "Файл": { "Ссылка": "https://online.sbis.ru/f" } }] });
  assert.equal(s.total, 1234.5);
  assert.equal(s.supplier, "Иванов Пётр");
  assert.equal(E.dmy(Date.UTC(2026, 10, 5)), "05.11.2026");
});

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  let ok = 0;
  for (const [name, fn] of tests) {
    try { await fn(); ok++; } catch (e) { console.error(`✗ ${name}\n`, e); }
  }
  console.log(`edo: ${ok} из ${tests.length}`);
  process.exit(ok === tests.length ? 0 : 1);
})();
