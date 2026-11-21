"use strict";
// ФГИС «Меркурий» (mercury.js): подставной Ветис.API отвечает как настоящий
// (свои префиксы пространств — проверяем разбор по URI), гашение переносит
// партию, отправителя, получателя, транспорт и ТТН из ВСД в нужном порядке,
// ошибки «Меркурия» понятны, ключи зашифрованы, права на /mercury.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-"));
const PORT = 8088;
Object.assign(process.env, {
  PORT: String(PORT), DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0", GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "mercury-secret-key-0123456789abcd",
});
const assert = require("assert/strict");
const server = require("./server.js");
const admin = require("firebase-admin");
const { encrypt, decrypt, secretKey } = require("./telegram");
const M = require("./mercury");
const store = server.localDataStore();
const doc = (p) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop());

const U1 = "11111111-2222-3333-4444-555555555555";
const U2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const UBAD = "99999999-2222-3333-4444-555555555555";
const ISSUER = "0c6f1a7e-1111-2222-3333-444444444444";
const ENT = "5e6f7a8b-1111-2222-3333-444444444444";

// ВСД так, как его отдаёт «Меркурий»: префиксы ns2…ns5, а не vd/bs/dt.
const vsdXml = (uuid, product, volume) => `<ns3:vetDocument xmlns:ns3="${M.NS.vd}" xmlns:ns2="${M.NS.bs}" xmlns:ns4="${M.NS.dt}">
  <ns2:uuid>${uuid}</ns2:uuid><ns3:issueSeries>A</ns3:issueSeries><ns3:issueNumber>12345</ns3:issueNumber><ns3:issueDate>2026-11-20</ns3:issueDate>
  <ns3:vetDForm>ELECTRONIC_CERTIFICATE</ns3:vetDForm><ns3:vetDType>INCOMING</ns3:vetDType><ns3:vetDStatus>CONFIRMED</ns3:vetDStatus>
  <ns3:certifiedConsignment>
    <ns3:consignor><ns4:businessEntity><ns2:guid>be-sender</ns2:guid><ns4:name>ООО «Мясной двор»</ns4:name></ns4:businessEntity><ns4:enterprise><ns2:guid>ent-sender</ns2:guid></ns4:enterprise></ns3:consignor>
    <ns3:consignee><ns4:businessEntity><ns2:guid>${ISSUER}</ns2:guid></ns4:businessEntity><ns4:enterprise><ns2:guid>${ENT}</ns2:guid></ns4:enterprise></ns3:consignee>
    <ns3:transportInfo><ns3:transportType>1</ns3:transportType><ns3:transportNumber><ns3:vehicleNumber>А123ВС</ns3:vehicleNumber></ns3:transportNumber></ns3:transportInfo>
    <ns3:transportStorageType>CHILLED</ns3:transportStorageType>
    <ns3:batch>
      <ns3:productType>1</ns3:productType><ns3:product><ns2:guid>p-guid</ns2:guid></ns3:product><ns3:subProduct><ns2:guid>sp-guid</ns2:guid></ns3:subProduct>
      <ns3:productItem><ns2:guid>pi-guid</ns2:guid><ns4:name>${product}</ns4:name></ns3:productItem>
      <ns3:volume>${volume}</ns3:volume><ns3:unit><ns2:guid>kg-guid</ns2:guid><ns4:name>кг</ns4:name></ns3:unit>
      <ns3:dateOfProduction><ns3:firstDate><ns2:year>2026</ns2:year><ns2:month>11</ns2:month><ns2:day>18</ns2:day></ns3:firstDate></ns3:dateOfProduction>
      <ns3:expiryDate><ns3:firstDate><ns2:year>2026</ns2:year><ns2:month>11</ns2:month><ns2:day>28</ns2:day></ns3:firstDate></ns3:expiryDate>
      <ns3:perishable>true</ns3:perishable><ns3:origin><ns3:country><ns2:guid>ru</ns2:guid></ns3:country></ns3:origin><ns3:lowGradeCargo>false</ns3:lowGradeCargo>
    </ns3:batch>
  </ns3:certifiedConsignment>
  <ns3:precedingVetDocuments><ns3:vetDocument><ns2:uuid>00000000-0000-0000-0000-000000000000</ns2:uuid></ns3:vetDocument></ns3:precedingVetDocuments>
  <ns3:referencedDocument><ns3:issueSeries>ТН</ns3:issueSeries><ns3:issueNumber>777</ns3:issueNumber><ns3:issueDate>2026-11-19</ns3:issueDate><ns3:type>1</ns3:type><ns3:relationshipType>1</ns3:relationshipType></ns3:referencedDocument>
</ns3:vetDocument>`;

// ---------- подставной Ветис.API ----------
const seen = [];
let pending = new Map();
let nextApp = 1;
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const auth = Buffer.from(String(req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString();
    const soap = (inner) => `<?xml version="1.0"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>${inner}</S:Body></S:Envelope>`;
    if (auth !== "apiuser:apipass") { res.writeHead(401); return res.end("no"); }
    const x = M.parseXml(raw);
    seen.push({ action: req.headers.soapaction, xml: raw, doc: x });
    const ws = M.NS.ws, app = M.NS.app;
    if (req.headers.soapaction === '"submitApplicationRequest"') {
      const data = M.find(x, "data");
      const req0 = data.children.find((c) => typeof c === "object");
      const id = `app-${nextApp++}`;
      pending.set(id, req0);
      return res.end(soap(`<a:submitApplicationResponse xmlns:a="${ws}"><b:application xmlns:b="${app}"><b:applicationId>${id}</b:applicationId><b:status>ACCEPTED</b:status></b:application></a:submitApplicationResponse>`));
    }
    const id = M.text(M.find(x, "applicationId"));
    const r = pending.get(id);
    let result;
    if (r.local === "getVetDocumentListRequest") {
      result = `<m:getVetDocumentListResponse xmlns:m="${M.NS.merc}"><v:vetDocumentList xmlns:v="${M.NS.vd}" count="2" total="2" offset="0">${vsdXml(U1, "Говядина вырезка", "12.5")}${vsdXml(U2, "Сливки 33%", "6")}</v:vetDocumentList></m:getVetDocumentListResponse>`;
    } else if (r.local === "getVetDocumentByUuidRequest") {
      const u = M.text(M.find(r, "uuid"));
      result = `<m:getVetDocumentByUuidResponse xmlns:m="${M.NS.merc}">${vsdXml(u, "Говядина вырезка", "12.5")}</m:getVetDocumentByUuidResponse>`;
    } else if (r.local === "processIncomingConsignmentRequest") {
      const u = M.text(M.find(M.find(r, "vetCertificate"), "uuid"));
      if (u === UBAD) {
        return res.end(soap(`<a:receiveApplicationResultResponse xmlns:a="${ws}"><b:application xmlns:b="${app}"><b:applicationId>${id}</b:applicationId><b:status>REJECTED</b:status><b:errors><b:error code="MERC13363">Не указаны номера транспортного средства</b:error></b:errors></b:application></a:receiveApplicationResultResponse>`));
      }
      result = `<m:processIncomingConsignmentResponse xmlns:m="${M.NS.merc}"/>`;
    }
    res.end(soap(`<a:receiveApplicationResultResponse xmlns:a="${ws}"><b:application xmlns:b="${app}"><b:applicationId>${id}</b:applicationId><b:status>COMPLETED</b:status><b:result>${result}</b:result></b:application></a:receiveApplicationResultResponse>`));
  });
});

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const alerts = [];
let lib;

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("разбор XML: пространства по URI, сущности, CDATA, обратная запись", () => {
  const x = M.parseXml(`<?xml version="1.0"?><!-- c --><a:r xmlns:a="${M.NS.vd}" xmlns:q="${M.NS.bs}"><a:x id="1">A &amp; B &lt;</a:x><q:y><![CDATA[<raw>]]></q:y></a:r>`);
  assert.equal(x.local, "r");
  assert.equal(x.ns, M.NS.vd);
  assert.equal(M.text(M.child(x, "x")), "A & B <");
  assert.equal(M.child(x, "y").ns, M.NS.bs);
  const back = M.writeXml(x);
  assert.ok(back.startsWith("<vd:r>") && back.includes('<vd:x id="1">A &amp; B &lt;</vd:x>') && back.includes("<bs:y>&lt;raw&gt;</bs:y>"), back);
  assert.throws(() => M.parseXml("<a><b></a>"));
  // Неизвестное пространство объявляется на месте.
  assert.ok(M.writeXml(M.parseXml('<z:k xmlns:z="urn:x"/>')).includes('xmlns:n1="urn:x"'));
});

test("список входящих ВСД: вход по API, заявка, ожидание, разбор", async () => {
  const docs = (await lib.list(await lib.config("m1"))).map(M.vetDocSummary);
  assert.equal(docs.length, 2, "вложенные «предыдущие» ВСД не считаются");
  assert.deepEqual(docs.map((d) => d.uuid), [U1, U2]);
  assert.equal(docs[0].product, "Говядина вырезка");
  assert.equal(docs[0].volume, 12.5);
  assert.equal(docs[0].unit, "кг");
  assert.equal(docs[0].supplier, "ООО «Мясной двор»");
  assert.equal(docs[0].produced, "18.11.2026");
  const sub = seen.find((s) => s.action === '"submitApplicationRequest"');
  assert.ok(sub.xml.includes("<ws:apiKey>KEY-1</ws:apiKey>") && sub.xml.includes(`<app:issuerId>${ISSUER}</app:issuerId>`) && sub.xml.includes("<app:serviceId>mercury-g2b.service:2.1</app:serviceId>"));
  assert.match(sub.xml, /<app:issueDate>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+03:00<\/app:issueDate>/);
  const lr = M.find(sub.doc, "getVetDocumentListRequest");
  assert.deepEqual(lr.children.filter((c) => typeof c === "object").map((c) => c.local),
    ["localTransactionId", "initiator", "listOptions", "vetDocumentType", "vetDocumentStatus", "enterpriseGuid"]);
  assert.equal(M.child(lr, "listOptions").ns, M.NS.bs);
  assert.equal(M.child(lr, "enterpriseGuid").ns, M.NS.dt);
  assert.equal(M.text(M.find(lr, "login")), "merc_user");
});

test("гашение: всё из ВСД, порядок полей и пространства как в схеме", async () => {
  seen.length = 0;
  const r = await lib.accept("m1", await lib.config("m1"), [U1], "u1");
  assert.equal(r.done.length, 1, JSON.stringify(r.failed));
  const pr = seen.map((s) => M.find(s.doc, "processIncomingConsignmentRequest")).find(Boolean);
  assert.ok(pr, "запрос гашения ушёл");
  const names = (n) => n.children.filter((c) => typeof c === "object").map((c) => c.local);
  assert.deepEqual(names(pr), ["localTransactionId", "initiator", "delivery", "deliveryFacts"]);
  const d = M.child(pr, "delivery");
  assert.deepEqual(names(d), ["deliveryDate", "consignor", "consignee", "consignment", "transportInfo", "transportStorageType", "accompanyingForms"]);
  assert.ok(d.children.filter((c) => typeof c === "object").every((c) => c.ns === M.NS.vd), "поля delivery — в пространстве vet-document");
  const cons = M.child(d, "consignment");
  assert.deepEqual(names(cons), ["productType", "product", "subProduct", "productItem", "volume", "unit", "dateOfProduction", "expiryDate", "perishable", "origin", "lowGradeCargo"]);
  assert.equal(M.text(M.child(cons, "volume")), "12.5");
  assert.equal(M.child(M.child(cons, "productItem"), "name").ns, M.NS.dt, "вложенные пространства сохранены");
  assert.equal(M.text(M.find(M.child(d, "consignor"), "guid")), "be-sender");
  const af = M.child(d, "accompanyingForms");
  assert.deepEqual(names(af), ["waybill", "vetCertificate"]);
  assert.deepEqual(names(M.child(af, "waybill")), ["issueSeries", "issueNumber", "issueDate", "type"], "ТТН без relationshipType");
  assert.equal(M.text(M.find(M.child(af, "vetCertificate"), "uuid")), U1);
  const f = M.child(pr, "deliveryFacts");
  assert.deepEqual(names(f), ["vetCertificatePresence", "docInspection", "vetInspection", "decision"]);
  assert.equal(M.text(M.child(f, "decision")), "ACCEPT_ALL");
  assert.equal(M.text(M.find(M.child(f, "docInspection"), "login")), "merc_user");
  assert.equal(M.text(M.child(M.child(f, "vetInspection"), "result")), "CORRESPONDS");
  const st = (await doc("mercuryState/m1").get()).data();
  assert.equal(st.accepted[0].uuid, U1);
});

test("отказ «Меркурия» — с кодом и текстом; неверный пароль — понятно", async () => {
  const r = await lib.accept("m1", await lib.config("m1"), [UBAD], "u1");
  assert.equal(r.done.length, 0);
  assert.match(r.failed[0].error, /MERC13363: Не указаны номера транспортного средства/);
  const cfg = { ...(await lib.config("m1")), password: "wrong" };
  await assert.rejects(() => lib.list(cfg), /не принял логин и пароль/);
});

test("сигнал о новых ВСД — один раз на документ", async () => {
  await doc("mercuryState/m1").set({ seen: [U1] }, { merge: true });
  await lib.runAll();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /пришло ВСД — 1/);
  assert.match(alerts[0].text, /Сливки 33%/);
  await lib.runAll();
  assert.equal(alerts.length, 1, "повторно не шлём");
});

function call(p, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

test("/mercury: настройки шифруются, наружу не отдаются; права; без настроек — 412", async () => {
  const made = (await call("/auth/signup", null, { email: "owner@merc.test", password: "secret-123456" })).json;
  await server.ownAuth().adminAuth().updateUser(made.uid, { emailVerified: true });
  const me = (await call("/auth/login", null, { email: "owner@merc.test", password: "secret-123456" })).json;
  await doc("tenants/m2").set({ name: "Кафе", status: "active", ownerUserId: me.uid });
  await doc(`tenantMembers/m2_${me.uid}`).set({ tenantId: "m2", userId: me.uid, role: "owner", status: "active" });
  assert.equal((await call("/mercury", me.idToken, { tenantId: "m2", action: "list" })).status, 412);
  let r = await call("/mercury", me.idToken, { tenantId: "m2", action: "settings", settings: { login: "l", password: "p", apiKey: "k", issuerId: "bad", enterpriseGuid: ENT, userLogin: "u" } });
  assert.equal(r.status, 400);
  r = await call("/mercury", me.idToken, { tenantId: "m2", action: "settings", settings: { login: "l", password: "p", apiKey: "secret-api-key", issuerId: ISSUER, enterpriseGuid: ENT, userLogin: "u" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.configured, true);
  assert.ok(!JSON.stringify(r.json).includes("secret-api-key"), "ключ наружу не уходит");
  const saved = (await doc("mercury/m2").get()).data();
  assert.ok(!JSON.stringify(saved).includes("secret-api-key"), "ключ в базе зашифрован");
  assert.equal(decrypt(secretKey(), saved.apiKeyEnc), "secret-api-key");
  // Пароль можно не повторять при правке.
  r = await call("/mercury", me.idToken, { tenantId: "m2", action: "settings", settings: { issuerId: ISSUER, enterpriseGuid: ENT, userLogin: "u2", env: "test" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.env, "test");
  const other = (await call("/auth/signup", null, { email: "other@merc.test", password: "secret-123456" })).json;
  assert.equal((await call("/mercury", other.idToken, { tenantId: "m2", action: "status" })).status, 403);
  assert.equal((await call("/mercury", null, { tenantId: "m2", action: "status" })).status, 401);
});

(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${fake.address().port}/ams`;
  lib = M.createMercury({
    db: () => store, admin, verifyAuth: async () => ({ uid: "u1" }), parseJsonBody: async () => ({}), sendJson: () => {}, HttpError,
    requireTenantRole: async () => {}, encrypt, decrypt, secretKey, ownerAlert: async (tid, text) => alerts.push({ tid, text }),
    endpoints: { prod: url, test: url }, pollMs: 5, pollTries: 5,
  });
  await doc("mercury/m1").set({ loginEnc: encrypt(secretKey(), "apiuser"), passwordEnc: encrypt(secretKey(), "apipass"), apiKeyEnc: encrypt(secretKey(), "KEY-1"),
    issuerId: ISSUER, enterpriseGuid: ENT, userLogin: "merc_user", env: "prod", alerts: true });
  await new Promise((r) => setTimeout(r, 300));
  let ok = 0;
  for (const [name, fn] of tests) {
    try { await fn(); ok++; } catch (e) { console.error("FAIL", name, e); process.exitCode = 1; }
  }
  console.log(`mercury: ${ok} из ${tests.length} проверок`);
  fake.close();
  process.exit(process.exitCode || 0);
})();
