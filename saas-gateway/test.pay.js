"use strict";
// Онлайн-оплата гостя через банк заведения (guest-pay.js): запросы к пяти
// банкам, разбор статусов, подпись Робокассы, проверка реквизитов — на
// поддельном HTTP и простой памяти вместо Firestore.
const assert = require("assert/strict");
const crypto = require("crypto");
const gp = require("./guest-pay");

const { fakeDb, admin, HttpError } = require("./test-helpers");

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

test("кнопка оплаты — только когда банк подтвердил реквизиты и указан продавец", async () => {
  const { pay, store } = makePay((url) => ({
    status: 200,
    text: JSON.stringify(/register\.do/.test(url) ? { orderId: "o-1", formUrl: "https://pay.example/o-1" } : { errorCode: "6", errorMessage: "Заказ не найден" }),
  }));
  const creds = { onlinePayProvider: "sber", onlinePayLogin: "shop-api", onlinePayPassword: "pw" };
  store.set("tenants/t1", { status: "active" });
  store.set("tenants/t1/settings/integrations", creds);
  store.set("tenants/t1/meta/venueProfile", { guestSbpPay: true, onlinePay: "sber" });
  store.set("tenants/t1/sessionClaims/s1", { uid: "guest1" });
  store.set("tenants/t1/sessions/s1", { status: "active", orderItems: [{ name: "Чай", price: 300, qty: 2 }] });
  const start = () => pay.handleStart({ body: { tenantId: "t1", sessionId: "s1" } }, {});
  // Реквизиты сохранили, но не проверили — гость не платит, даже если кто-то поставил onlinePay.
  await assert.rejects(start(), (e) => e.status === 409 && /не проверило/.test(e.message));
  // Проверка: банк принял — шлюз сам публикует банк и отпечаток реквизитов.
  const res = {};
  await pay.handleCheck({ body: { tenantId: "t1" } }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sellerReady, false);
  assert.equal(store.get("tenants/t1/meta/venueProfile").onlinePay, "sber");
  assert.ok(store.get("tenants/t1/settings/integrations").onlinePayVerified);
  // Нет реквизитов продавца — оплаты нет.
  await assert.rejects(start(), (e) => e.status === 409 && /реквизиты продавца/.test(e.message));
  store.set("tenants/t1/meta/venueProfile", { ...store.get("tenants/t1/meta/venueProfile"),
    sellerName: "ООО «Лето»", sellerInn: "7701234567", sellerOgrn: "1027700000000", sellerAddress: "Москва, ул. Летняя, 1" });
  const ok = {};
  await pay.handleStart({ body: { tenantId: "t1", sessionId: "s1" } }, ok);
  assert.equal(ok.body.url, "https://pay.example/o-1");
  // Поменяли пароль — до новой проверки оплаты нет.
  store.set("tenants/t1/settings/integrations", { ...store.get("tenants/t1/settings/integrations"), onlinePayPassword: "new" });
  await assert.rejects(start(), (e) => e.status === 409 && /не проверило/.test(e.message));
  // Банк отклонил — кнопка у гостей пропадает.
  const { pay: pay2, store: store2 } = makePay(() => ({ status: 200, text: JSON.stringify({ errorCode: "5", errorMessage: "Access denied" }) }));
  store2.set("tenants/t1/settings/integrations", creds);
  store2.set("tenants/t1/meta/venueProfile", { guestSbpPay: true, onlinePay: "sber" });
  await pay2.handleCheck({ body: { tenantId: "t1" } }, {});
  assert.equal(store2.get("tenants/t1/meta/venueProfile").onlinePay, "");
});

test("реквизиты продавца: ИНН 10/12 цифр, ОГРН 13/15, имя и адрес", () => {
  const v = { sellerName: "ИП Иванов И. И.", sellerInn: "770123456789", sellerOgrn: "304770000000012", sellerAddress: "Москва, ул. 1" };
  assert.equal(gp.sellerReady(v), true);
  assert.equal(gp.sellerReady({ ...v, sellerInn: "12345" }), false);
  assert.equal(gp.sellerReady({ ...v, sellerOgrn: "123" }), false);
  assert.equal(gp.sellerReady({ ...v, sellerName: "" }), false);
  assert.equal(gp.sellerReady(null), false);
});

test("проверка реквизитов без денег: верные/неверные", async () => {
  let reply = { status: 200, text: JSON.stringify({ errorCode: "6", errorMessage: "Заказ не найден" }) };
  let { pay } = makePay(() => reply);
  assert.equal((await pay.checkCreds({ provider: "sber", login: "a", password: "b" })).ok, true);
  reply = { status: 200, text: JSON.stringify({ errorCode: "5", errorMessage: "Access denied" }) };
  ({ pay } = makePay(() => reply));
  assert.equal((await pay.checkCreds({ provider: "alfa", login: "a", password: "b" })).ok, false);
  // ЮKassa больше не поддерживается — такие настройки не включают оплату.
  assert.equal(gp.onlinePaySettings({ onlinePayProvider: "yookassa", onlinePayLogin: "a", onlinePayPassword: "b" }), null);
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
