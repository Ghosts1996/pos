"use strict";
// Телефония для доставки (telephony.js): разбор событий АТС (Манго с
// подписью, Новофон, общий «вызов адреса»), адрес из кабинета, звонок →
// карточка incomingCalls с постоянным гостем, без повторов, без номера в
// базе при справочнике в РФ; смена адреса; чужому заведению — нельзя.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tel-"));
const PORT = 8095;
Object.assign(process.env, {
  PORT: String(PORT), DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0", GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "tel-secret-key-0123456789abcdef0123",
});
const assert = require("assert/strict");
const { parseCallEvent, normalizePhone, parseBody } = require("./telephony");

// ---- чистые функции
{
  assert.equal(normalizePhone("8 (900) 123-45-67"), "79001234567");
  assert.equal(normalizePhone("9001234567"), "79001234567");
  assert.equal(normalizePhone("12"), "");
  const json = JSON.stringify({ entry_id: "E1", call_state: "Appeared", location: "ivr", from: { number: "79001234567" }, to: { number: "74951112233", line_number: "74951112233" } });
  const sign = crypto.createHash("sha256").update(`KEY${json}SALT`).digest("hex");
  let r = parseCallEvent({ body: { vpbx_api_key: "KEY", sign, json }, path: "events/call", salt: "SALT" });
  assert.deepEqual([r.incoming, r.phone, r.callId, r.provider], [true, "79001234567", "E1", "mango"]);
  r = parseCallEvent({ body: { vpbx_api_key: "KEY", sign: "bad", json }, path: "events/call", salt: "SALT" });
  assert.equal(r.bad, true, "чужая подпись");
  assert.equal(parseCallEvent({ body: { vpbx_api_key: "K", sign: "x", json }, path: "events/summary" }).incoming, false);
  const out = JSON.stringify({ call_state: "Appeared", from: { extension: "101", number: "74951112233" }, to: { number: "79001234567" } });
  assert.equal(parseCallEvent({ body: { vpbx_api_key: "K", sign: "x", json: out }, path: "events/call" }).incoming, false, "исходящий");
  const conn = JSON.stringify({ call_state: "Connected", from: { number: "79001234567" } });
  assert.equal(parseCallEvent({ body: { vpbx_api_key: "K", sign: "x", json: conn }, path: "events/call" }).incoming, false, "ответ — не новый звонок");
  // Новофон / Zadarma
  r = parseCallEvent({ body: { event: "NOTIFY_START", caller_id: "+79001234567", called_did: "74951112233", pbx_call_id: "in_1" } });
  assert.deepEqual([r.incoming, r.phone, r.callId], [true, "79001234567", "in_1"]);
  assert.equal(parseCallEvent({ body: { event: "NOTIFY_END", caller_id: "+79001234567" } }).incoming, false);
  assert.equal(parseCallEvent({ body: { event: "NOTIFY_OUT_START", caller_id: "+79001234567" } }).incoming, false);
  // общий GET и JSON
  assert.equal(parseCallEvent({ query: { phone: "89001234567" } }).phone, "79001234567");
  assert.equal(parseCallEvent({ body: { direction: "incoming", from: "+7 900 123-45-67" } }).phone, "79001234567");
  assert.equal(parseCallEvent({ body: { direction: "outgoing", from: "+7 900 123-45-67" } }).incoming, false);
  assert.equal(parseCallEvent({ query: {} }).incoming, false);
  assert.deepEqual(parseBody("a=1&b=%2B7", "application/x-www-form-urlencoded"), { a: "1", b: "+7" });
  assert.deepEqual(parseBody('{"x":1}', ""), { x: 1 });
}

const server = require("./server.js");
const store = server.localDataStore();
const doc = (p) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop());
const set = (p, d) => doc(p).set(d);

function req(method, p, { token, body, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method,
      headers: { "Content-Type": raw !== undefined ? "application/x-www-form-urlencoded" : "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(out); } catch (_) {} resolve({ status: res.statusCode, json: j, raw: out }); });
    });
    r.on("error", reject);
    r.end(raw !== undefined ? raw : body ? JSON.stringify(body) : undefined);
  });
}
const calls = async () => (await store.collection("tenants/tl1/incomingCalls").get()).docs.map((d) => ({ id: d.id, ...d.data() }));

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  let failed = 0;
  try {
    const sign = async (email) => (await req("POST", "/auth/signup", { body: { email, password: "secret-123456" } })).json;
    const me = await sign("owner-t@test.ru");
    const other = await sign("other-t@test.ru");
    await set("tenants/tl1", { name: "Пицца", status: "active", ownerUserId: me.uid, timezone: "Europe/Moscow" });
    await set(`tenantMembers/tl1_${me.uid}`, { tenantId: "tl1", userId: me.uid, role: "owner", status: "active" });
    await set("tenants/tl1/phoneIndex/79001234567", { uid: "g1" });
    await set("tenants/tl1/clients/g1", { name: "Иван", visits: 5, bonusBalance: 320.4, totalSpent: 9000 });

    assert.equal((await req("POST", "/telephonyLink", { token: other.idToken, body: { tenantId: "tl1" } })).status, 403);
    let r = await req("POST", "/telephonyLink", { token: me.idToken, body: { tenantId: "tl1" } });
    assert.equal(r.status, 200, r.raw);
    assert.match(r.json.url, /\/tel\/[A-Za-z0-9]{24}$/);
    const key = r.json.url.split("/tel/")[1];

    assert.equal((await req("GET", "/tel/AAAAAAAAAAAAAAAAAAAAAAAA?phone=79001234567")).status, 404, "чужой адрес");
    assert.equal((await req("GET", `/tel/${key}?zd_echo=abc123`)).raw, "abc123", "проверка адреса Новофоном");

    r = await req("GET", `/tel/${key}?phone=8%20900%20123-45-67&call_id=c1`);
    assert.equal(r.status, 200);
    let list = await calls();
    assert.equal(list.length, 1);
    assert.equal(list[0].status, "ringing");
    assert.equal(list[0].tail, "4567");
    assert.equal(list[0].guest.uid, "g1");
    assert.equal(list[0].guest.visits, 5);
    assert.equal(list[0].guest.bonus, 320);
    assert.equal(list[0].phone, "79001234567", "без справочника в РФ (стенд) номер в записи");
    assert.ok(!("name" in list[0].guest), "имени гостя в записи звонка нет");

    // Тот же номер через секунды (второе событие АТС) — без второй карточки.
    await req("POST", `/tel/${key}`, { body: { event: "incoming", from: "+79001234567" } });
    assert.equal((await calls()).length, 1);
    // Конец звонка — ничего.
    await req("POST", `/tel/${key}`, { body: { event: "hangup", from: "+79005550000" } });
    assert.equal((await calls()).length, 1);

    // Манго с подписью: соль из кабинета.
    r = await req("POST", "/telephonyLink", { token: me.idToken, body: { tenantId: "tl1", action: "settings", mangoSalt: "SALT" } });
    assert.equal(r.json.hasSalt, true);
    const json = JSON.stringify({ entry_id: "E9", call_state: "Appeared", from: { number: "79112223344" }, to: { number: "74951112233" } });
    const form = (s) => new URLSearchParams({ vpbx_api_key: "K", sign: s, json }).toString();
    assert.equal((await req("POST", `/tel/${key}/events/call`, { raw: form("wrong") })).status, 403);
    const good = crypto.createHash("sha256").update(`K${json}SALT`).digest("hex");
    assert.equal((await req("POST", `/tel/${key}/events/call`, { raw: form(good) })).status, 200);
    list = await calls();
    assert.equal(list.length, 2);
    const fresh = list.find((c) => c.tail === "3344");
    assert.equal(fresh.provider, "mango");
    assert.equal(fresh.guest, undefined, "новый номер — без гостя");

    // Выключили — звонки не пишутся; проверочный звонок из кабинета — пишется.
    await req("POST", "/telephonyLink", { token: me.idToken, body: { tenantId: "tl1", action: "settings", enabled: false } });
    await req("GET", `/tel/${key}?phone=79998887766`);
    assert.equal((await calls()).length, 2);
    r = await req("POST", "/telephonyLink", { token: me.idToken, body: { tenantId: "tl1", action: "test" } });
    assert.equal(r.status, 200);
    assert.ok((await calls()).some((c) => c.test === true && c.tail === "0000"));

    // Смена адреса — старый больше не работает.
    r = await req("POST", "/telephonyLink", { token: me.idToken, body: { tenantId: "tl1", action: "rotate" } });
    assert.notEqual(r.json.url.split("/tel/")[1], key);
    assert.equal((await req("GET", `/tel/${key}?phone=79001234567`)).status, 404);

    // Старше 2 суток — удаляются при следующем звонке.
    await set("tenants/tl1/incomingCalls/old", { at: new Date(Date.now() - 3 * 86400e3), status: "ringing", tail: "1111" });
    await req("POST", "/telephonyLink", { token: me.idToken, body: { tenantId: "tl1", action: "settings", enabled: true } });
    await req("GET", `/tel/${r.json.url.split("/tel/")[1]}?phone=79007776655`);
    await new Promise((res) => setTimeout(res, 200));
    assert.ok(!(await calls()).some((c) => c.id === "old"), "старый звонок удалён");
  } catch (e) {
    failed++;
    console.error(e);
  }
  if (failed) {
    console.error("telephony: ОШИБКИ");
    process.exit(1);
  }
  console.log("telephony: ok");
  process.exit(0);
})();
