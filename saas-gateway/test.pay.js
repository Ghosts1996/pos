"use strict";
// Онлайн-оплата гостя через банк заведения (guest-pay.js): запросы к пяти
// банкам, разбор статусов, подпись Робокассы, проверка реквизитов — на
// поддельном HTTP и простой памяти вместо Firestore.
const assert = require("assert/strict");
const crypto = require("crypto");
const gp = require("./guest-pay");

// ---------- память вместо Firestore (только то, что нужно guest-pay.js)
function fakeDb() {
  const store = new Map();
  const ref = (path) => ({
    path,
    id: path.split("/").pop(),
    collection: (name) => col(`${path}/${name}`),
    get: async () => snap(path),
    set: async (data, opts) => { store.set(path, opts && opts.merge ? { ...(store.get(path) || {}), ...data } : { ...data }); },
    update: async (data) => { applyUpdate(path, data); },
    delete: async () => { store.delete(path); },
  });
  const snap = (path) => ({ exists: store.has(path), id: path.split("/").pop(), ref: ref(path), data: () => (store.has(path) ? { ...store.get(path) } : undefined) });
  function applyUpdate(path, data) {
    const cur = { ...(store.get(path) || {}) };
    for (const [k, v] of Object.entries(data)) {
      if (v && v.__inc !== undefined) cur[k] = (Number(cur[k]) || 0) + v.__inc;
      else if (v && v.__union) cur[k] = [...new Set([...(cur[k] || []), ...v.__union])];
      else cur[k] = v;
    }
    store.set(path, cur);
  }
  function col(path) {
    const filters = [];
    let max = Infinity;
    const q = {
      doc: (id) => ref(`${path}/${id || crypto.randomBytes(6).toString("hex")}`),
      add: async (data) => { const r = ref(`${path}/${crypto.randomBytes(6).toString("hex")}`); await r.set(data); return r; },
      where: (f, op, v) => { filters.push([f, v]); return q; },
      limit: (n) => { max = n; return q; },
      get: async () => {
        const docs = [...store.keys()]
          .filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/"))
          .map(snap)
          .filter((d) => filters.every(([f, v]) => d.data()[f] === v))
          .slice(0, max);
        return { docs, size: docs.length };
      },
    };
    return q;
  }
  const db = {
    collection: (name) => col(name),
    runTransaction: async (fn) => fn({
      get: async (r) => r.get(),
      set: (r, d, o) => r.set(d, o),
      update: (r, d) => applyUpdate(r.path, d),
    }),
  };
  return { db, store };
}

const admin = {
  firestore: {
    Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms) => ({ toMillis: () => ms }) },
    FieldValue: { increment: (n) => ({ __inc: n }), arrayUnion: (...v) => ({ __union: v }) },
  },
};
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function makePay(responder) {
  const { db, store } = fakeDb();
  const calls = [];
  const pay = gp.createGuestPay({
    db: () => db, admin, HttpError,
    verifyAuth: async () => ({ uid: "guest1" }),
    parseJsonBody: async (req) => req.body,
    readBody: async (req) => req.raw || "",
    sendJson: (res, status, body) => { res.status = status; res.body = body; },
    requireTenantRole: async () => {},
    publicUrl: "https://pii.zalpos.ru/saas",
    httpImpl: async (url, opts = {}) => { calls.push({ url, ...opts }); return responder(url, opts, calls.length); },
  });
  return { pay, calls, store };
}

let n = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("реквизиты: старый Т-Банк QR СБП из терминала работает и дальше", () => {
  const c = gp.onlinePaySettings({ terminalProvider: "tinkoff_sbp", terminalLogin: "T1", terminalPassword: "pw" });
  assert.equal(c.provider, "tinkoff");
  assert.equal(c.login, "T1");
  assert.equal(gp.onlinePaySettings({ onlinePayProvider: "robokassa", onlinePayLogin: "m", onlinePayPassword: "p1" }), null,
    "Робокасса без пароля №2 не включается");
  assert.equal(gp.onlinePaySettings({ onlinePayProvider: "robokassa", onlinePayLogin: "m", onlinePayPassword: "p1", onlinePayPassword2: "p2", onlinePayHash: "xxx" }).hash, "md5");
  assert.equal(gp.onlinePaySettings({ onlinePayProvider: "evil", onlinePayLogin: "a", onlinePayPassword: "b" }), null);
});

test("Т-Банк: Init в копейках с подписью, ссылка СБП из GetQr", async () => {
  const { pay, calls } = makePay((url) => ({
    status: 200,
    text: JSON.stringify(url.endsWith("/Init") ? { Success: true, PaymentId: 777 } : { Success: true, Data: "https://qr.nspk.ru/AD1" }),
  }));
  const r = await pay.createPayment({ provider: "tinkoff", login: "TK", password: "pw" }, { tenantId: "t1", amount: 1234.5, orderId: "g1", description: "Доставка" });
  assert.equal(r.docId, "777");
  assert.equal(r.url, "https://qr.nspk.ru/AD1");
  const init = JSON.parse(calls[0].body);
  assert.equal(calls[0].url, "https://securepay.tinkoff.ru/v2/Init");
  assert.equal(init.Amount, 123450);
  assert.ok(gp.tokenValid(init, "pw"), "подпись Init верна");
  assert.match(init.NotificationURL, /guestPayNotify\?t=t1$/);
});

test("ЮKassa: платёж СБП, сумма строкой в рублях, ключ идемпотентности", async () => {
  const { pay, calls } = makePay(() => ({ status: 200, text: JSON.stringify({ id: "2e1-yk", confirmation: { confirmation_url: "https://yoomoney.ru/checkout/x" } }) }));
  const r = await pay.createPayment({ provider: "yookassa", login: "shop", password: "sk" }, { tenantId: "t1", amount: 990, orderId: "g2", description: "Счёт" });
  assert.equal(r.providerId, "2e1-yk");
  assert.equal(calls[0].url, "https://api.yookassa.ru/v3/payments");
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from("shop:sk").toString("base64")}`);
  assert.equal(calls[0].headers["Idempotence-Key"], "g2");
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(body.amount, { value: "990.00", currency: "RUB" });
  assert.equal(body.payment_method_data.type, "sbp");
  assert.equal(body.confirmation.return_url, "https://pii.zalpos.ru/saas/guestPayDone");
});

test("ЮKassa: «нужен чек» — понятная подсказка владельцу", async () => {
  const { pay } = makePay(() => ({ status: 400, text: JSON.stringify({ description: "Receipt is missing or illegal" }) }));
  await assert.rejects(
    pay.createPayment({ provider: "yookassa", login: "s", password: "k" }, { tenantId: "t1", amount: 10, orderId: "g", description: "x" }),
    /Чеки от ЮKassa/);
});

test("Робокасса: подпись Пароль №1 с Shp_t, тестовый режим, свой номер счёта", async () => {
  const { pay, store } = makePay(() => ({ status: 200, text: "" }));
  const c = { provider: "robokassa", login: "shop", password: "p1", password2: "p2", hash: "md5", test: true };
  const r = await pay.createPayment(c, { tenantId: "t1", amount: 500, orderId: "g3", description: "Заказ с собой" });
  const u = new URL(r.url);
  assert.equal(u.origin + u.pathname, "https://auth.robokassa.ru/Merchant/Index.aspx");
  const inv = u.searchParams.get("InvId");
  assert.equal(inv, "700000001");
  assert.equal(u.searchParams.get("OutSum"), "500.00");
  assert.equal(u.searchParams.get("IsTest"), "1");
  assert.equal(u.searchParams.get("Shp_t"), "t1");
  const expected = crypto.createHash("md5").update(`shop:500.00:${inv}:p1:Shp_t=t1`).digest("hex");
  assert.equal(u.searchParams.get("SignatureValue"), expected);
  assert.equal(store.get("tenants/t1/meta/onlinePayCounter").robokassaInvId, 700000001);
});

test("Сбер и Альфа: register.do в копейках, боевой и тестовый контуры", async () => {
  for (const [provider, test, host] of [
    ["sber", false, "securepayments.sberbank.ru"], ["sber", true, "3dsec.sberbank.ru"],
    ["alfa", false, "payment.alfabank.ru"], ["alfa", true, "alfa.rbsuat.com"],
  ]) {
    const { pay, calls } = makePay(() => ({ status: 200, text: JSON.stringify({ orderId: "uuid-1", formUrl: `https://${host}/payment/merchants/x` }) }));
    const r = await pay.createPayment({ provider, login: "shop-api", password: "pw", test }, { tenantId: "t1", amount: 100.1, orderId: "g4", description: "Счёт" });
    assert.equal(r.providerId, "uuid-1");
    assert.equal(calls[0].url, `https://${host}/payment/rest/register.do`);
    const f = new URLSearchParams(calls[0].body);
    assert.equal(f.get("amount"), "10010");
    assert.equal(f.get("userName"), "shop-api");
    assert.equal(f.get("orderNumber"), "g4");
    assert.equal(f.get("returnUrl"), "https://pii.zalpos.ru/saas/guestPayDone");
  }
});

test("Сбер: отказ банка — его текст, а не «ошибка 500»", async () => {
  const { pay } = makePay(() => ({ status: 200, text: JSON.stringify({ errorCode: "5", errorMessage: "Access denied" }) }));
  await assert.rejects(
    pay.createPayment({ provider: "sber", login: "a", password: "b" }, { tenantId: "t1", amount: 10, orderId: "g", description: "x" }),
    /Сбербанк: Access denied/);
});

test("статусы банков: оплачен / отказ / ждём", async () => {
  const cases = [
    ["tinkoff", { Success: true, Status: "CONFIRMED" }, "paid"],
    ["tinkoff", { Success: true, Status: "REJECTED" }, "failed"],
    ["tinkoff", { Success: true, Status: "FORM_SHOWED" }, "pending"],
    ["yookassa", { status: "succeeded" }, "paid"],
    ["yookassa", { status: "canceled" }, "failed"],
    ["sber", { orderStatus: 2 }, "paid"],
    ["alfa", { orderStatus: 6 }, "failed"],
    ["alfa", { orderStatus: 0 }, "pending"],
  ];
  for (const [provider, reply, want] of cases) {
    const { pay } = makePay(() => ({ status: 200, text: JSON.stringify(reply) }));
    assert.equal(await pay.bankStatus({ provider, login: "l", password: "p" }, "id1"), want, `${provider} ${JSON.stringify(reply)}`);
  }
  const xml = (state) => `<?xml version="1.0"?><OperationStateResponse><Result><Code>0</Code></Result><State><Code>${state}</Code></State></OperationStateResponse>`;
  for (const [state, want] of [[100, "paid"], [10, "failed"], [5, "pending"]]) {
    const { pay, calls } = makePay(() => ({ status: 200, text: xml(state) }));
    assert.equal(await pay.bankStatus({ provider: "robokassa", login: "shop", password: "p1", password2: "p2", hash: "md5" }, "700000001"), want);
    const sig = crypto.createHash("md5").update("shop:700000001:p2").digest("hex");
    assert.ok(calls[0].url.includes(`Signature=${sig}`), "OpStateExt подписан паролем №2");
  }
});

test("Result URL Робокассы: верная подпись — оплачено, «OK<InvId>»; чужая — 403", async () => {
  const { pay, store } = makePay(() => ({ status: 200, text: "" }));
  store.set("tenants/t1/settings/integrations", { onlinePayProvider: "robokassa", onlinePayLogin: "shop", onlinePayPassword: "p1", onlinePayPassword2: "p2" });
  store.set("tenants/t1/sessions/s1", { status: "active", orderType: "delivery", orderItems: [] });
  store.set("tenants/t1/guestPayments/p_x", { provider: "robokassa", providerId: "700000005", sessionId: "s1", amount: 500, status: "pending" });
  const sig = crypto.createHash("md5").update("500.00:700000005:p2:Shp_t=t1").digest("hex");
  const res = { writeHead(code) { this.code = code; }, end(t) { this.text = t; } };
  await pay.handleRobokassaResult({ method: "GET", url: `/guestPayRobokassa?OutSum=500.00&InvId=700000005&SignatureValue=${sig.toUpperCase()}&Shp_t=t1` }, res);
  assert.equal(res.text, "OK700000005");
  assert.equal(store.get("tenants/t1/guestPayments/p_x").status, "paid");
  assert.equal(store.get("tenants/t1/sessions/s1").guestPaidTotal, 500);
  const call = [...store.entries()].find(([k]) => k.startsWith("tenants/t1/waiterCalls/"));
  assert.ok(call && /пробейте чек/.test(call[1].comment), "персоналу — «пробейте чек» для доставки");
  await assert.rejects(
    pay.handleRobokassaResult({ method: "GET", url: "/guestPayRobokassa?OutSum=500.00&InvId=700000005&SignatureValue=deadbeef&Shp_t=t1" }, res),
    (e) => e.status === 403);
});

test("проверка реквизитов без денег: верные/неверные", async () => {
  let reply = { status: 200, text: JSON.stringify({ errorCode: "6", errorMessage: "Заказ не найден" }) };
  let { pay } = makePay(() => reply);
  assert.equal((await pay.checkCreds({ provider: "sber", login: "a", password: "b" })).ok, true);
  reply = { status: 200, text: JSON.stringify({ errorCode: "5", errorMessage: "Access denied" }) };
  ({ pay } = makePay(() => reply));
  assert.equal((await pay.checkCreds({ provider: "alfa", login: "a", password: "b" })).ok, false);
  ({ pay } = makePay(() => ({ status: 401, text: "{}" })));
  assert.equal((await pay.checkCreds({ provider: "yookassa", login: "a", password: "b" })).ok, false);
  ({ pay } = makePay(() => ({ status: 404, text: "{}" })));
  assert.equal((await pay.checkCreds({ provider: "yookassa", login: "a", password: "b" })).ok, true);
  ({ pay } = makePay(() => ({ status: 200, text: "<Result><Code>3</Code></Result>" })));
  assert.equal((await pay.checkCreds({ provider: "robokassa", login: "a", password: "b", password2: "c", hash: "md5" })).ok, true);
  ({ pay } = makePay(() => ({ status: 200, text: "<Result><Code>1</Code></Result>" })));
  assert.equal((await pay.checkCreds({ provider: "robokassa", login: "a", password: "b", password2: "c", hash: "md5" })).ok, false);
});

test("корень Минцифры лежит рядом и это именно он", () => {
  const pem = require("fs").readFileSync(require("path").join(__dirname, "certs", "russian_trusted_root_ca.pem"), "utf8");
  const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
  const fp = crypto.createHash("sha256").update(der).digest("hex").toUpperCase();
  assert.equal(fp, "D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31");
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      n++;
    } catch (e) {
      console.error("FAIL", name, e);
      process.exitCode = 1;
    }
  }
  console.log(`pay: ${n} из ${tests.length} проверок`);
})();
