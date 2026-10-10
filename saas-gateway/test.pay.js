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
    sellerName: "ООО «Лето»", sellerInn: "7707083893", sellerOgrn: "1027700132195", sellerAddress: "Москва, ул. Летняя, 1" });
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

test("демо-заведение: оплата проходит сразу, без банка и без денег", async () => {
  const { pay, calls, store } = makePay(() => { throw new Error("в демо к банку не ходим"); });
  store.set("tenants/d1", { status: "active", demo: true });
  store.set("tenants/d1/meta/venueProfile", { guestSbpPay: true, onlinePay: "tinkoff_form" });
  store.set("tenants/d1/sessionClaims/s1", { uid: "guest1" });
  store.set("tenants/d1/sessions/s1", { status: "active", orderType: "delivery", deliveryStatus: "accepted", orderItems: [{ name: "Пицца", price: 590, qty: 1 }] });
  const res = {};
  await pay.handleStart({ body: { tenantId: "d1", sessionId: "s1" } }, res);
  assert.equal(calls.length, 0);
  assert.equal(res.body.provider, "demo");
  assert.match(res.body.url, /\/guestPayDemo\?a=590$/);
  const p = store.get(`tenants/d1/guestPayments/${res.body.paymentId}`);
  assert.equal(p.status, "paid");
  assert.equal(store.get("tenants/d1/sessions/s1").guestPaidTotal, 590);
  const call = [...store.entries()].find(([k, v]) => k.startsWith("tenants/d1/waiterCalls/") && v.type === "paid");
  assert.ok(call && /демо, деньги не списаны/.test(call[1].comment));
  const st = {};
  await pay.handleStatus({ body: { tenantId: "d1", paymentId: res.body.paymentId } }, st);
  assert.equal(st.body.status, "paid");
  const page = { writeHead(code) { this.code = code; }, end(t) { this.text = t; } };
  await pay.handleDemoPage({ url: "/guestPayDemo?a=590" }, page);
  assert.equal(page.code, 200);
  assert.match(page.text, /деньги не списываются/);
});

test("реквизиты продавца: ИНН 10/12 цифр, ОГРН 13/15, имя и адрес", () => {
  const v = { sellerName: "ИП Иванов И. И.", sellerInn: "500100732259", sellerOgrn: "304500116000157", sellerAddress: "Москва, ул. 1" };
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

test("ВТБ и МТС Банк: тот же шлюз RBS, свои боевые и тестовые адреса", async () => {
  for (const [provider, test, host] of [
    ["vtb", false, "platezh.vtb24.ru"], ["vtb", true, "vtb.rbsuat.com"],
    ["mts", false, "oplata.mtsbank.ru"], ["mts", true, "mts.rbsuat.com"],
  ]) {
    const { pay, calls } = makePay((url) => ({
      status: 200,
      text: JSON.stringify(/register/.test(url) ? { orderId: "u-2", formUrl: `https://${host}/payment/merchants/x` } : { orderStatus: 2 }),
    }));
    const c = { provider, login: "shop-api", password: "pw", test };
    const r = await pay.createPayment(c, { tenantId: "t1", amount: 50, orderId: "g5", description: "Счёт" });
    assert.equal(calls[0].url, `https://${host}/payment/rest/register.do`);
    assert.equal(r.url, `https://${host}/payment/merchants/x`);
    assert.equal(await pay.bankStatus(c, "u-2"), "paid");
    assert.equal(calls[1].url, `https://${host}/payment/rest/getOrderStatusExtended.do`);
  }
});

test("другой банк на шлюзе RBS: только https-домен с путём …/payment/rest", async () => {
  const s = (url) => gp.onlinePaySettings({ onlinePayProvider: "rbs_custom", onlinePayLogin: "a-api", onlinePayPassword: "p", onlinePayUrl: url });
  assert.equal(s("https://pay.examplebank.ru/payment/rest/").url, "https://pay.examplebank.ru/payment/rest");
  assert.equal(s("https://ecom.bank.ru/ab/payment/rest").url, "https://ecom.bank.ru/ab/payment/rest");
  assert.equal(s("https://оплата.банк.рф/payment/rest").url, `https://${new URL("https://оплата.банк.рф").hostname}/payment/rest`);
  for (const bad of [
    "", "http://pay.bank.ru/payment/rest", "https://127.0.0.1/payment/rest", "https://[::1]/payment/rest",
    "https://localhost/payment/rest", "https://gw.internal/payment/rest", "https://pay.bank.ru:8443/payment/rest",
    "https://pay.bank.ru/payment/rest?x=1", "https://user:pw@pay.bank.ru/payment/rest", "https://pay.bank.ru/admin",
    "https://10.0.0.5/payment/rest", "https://pay.bank.ru/../payment/rest/x",
  ]) {
    assert.equal(s(bad), null, `не годится: ${bad}`);
  }
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
    assert.equal(gp.privateIp(ip), true, ip);
  }
  for (const ip of ["213.180.204.1", "8.8.8.8", "2a02:6b8::1"]) assert.equal(gp.privateIp(ip), false, ip);
  // Запросы — на адрес банка и с проверкой DNS на внутреннюю сеть.
  const { pay, calls } = makePay(() => ({ status: 200, text: JSON.stringify({ orderId: "o-9", formUrl: "https://pay.examplebank.ru/pay/o-9" }) }));
  const c = s("https://pay.examplebank.ru/payment/rest");
  const r = await pay.createPayment(c, { tenantId: "t1", amount: 10, orderId: "g6", description: "Счёт" });
  assert.equal(calls[0].url, "https://pay.examplebank.ru/payment/rest/register.do");
  assert.equal(calls[0].publicOnly, true);
  assert.equal(r.providerId, "o-9");
  // Отпечаток: у «другого банка» в нём адрес, у остальных — прежний.
  assert.notEqual(gp.credsPrint(c), gp.credsPrint({ ...c, url: "https://pay2.examplebank.ru/payment/rest" }));
  const old = { provider: "sber", login: "l", password: "p", password2: "", test: false, hash: "md5" };
  assert.equal(gp.credsPrint(old), crypto.createHash("sha256").update(["sber", "l", "p", "", 0, "md5"].join("\u0001")).digest("hex"));
  // Ответ не похож на шлюз RBS — подключение не подтверждаем.
  const { pay: p2 } = makePay(() => ({ status: 200, text: "<html>hello</html>" }));
  assert.equal((await p2.checkCreds(c)).ok, false);
});

test("Райффайзенбанк СБП: QR без ключа, статус и отмена — с секретным ключом", async () => {
  const { pay, calls } = makePay((url, opts) => {
    if (url.endsWith("/sbp/v1/qr/register")) {
      return { status: 200, text: JSON.stringify({ code: "SUCCESS", qrId: "AD100004BAL7227F9BNP6KNE007J9B3K", payload: "https://qr.nspk.ru/AD100004BAL7227F9BNP6KNE007J9B3K?type=02", qrUrl: "x" }) };
    }
    if (/payment-info$/.test(url)) return { status: 200, text: JSON.stringify({ code: "SUCCESS", paymentStatus: opts.headers.Authorization === "Bearer key" ? "SUCCESS" : "NO_INFO" }) };
    return { status: 200, text: "{}" };
  });
  const c = { provider: "raiffeisen", login: "MA0000000552", password: "key", test: false };
  const r = await pay.createPayment(c, { tenantId: "t1", amount: 1234.5, orderId: "gabc123", description: "Доставка" });
  assert.equal(calls[0].url, "https://e-commerce.raiffeisen.ru/api/sbp/v1/qr/register");
  assert.equal(calls[0].headers.Authorization, undefined, "регистрация QR — без ключа");
  const body = JSON.parse(calls[0].body);
  assert.equal(body.amount, 1234.5, "сумма в рублях");
  assert.equal(body.sbpMerchantId, "MA0000000552");
  assert.equal(body.order, "gabc123");
  assert.equal(body.qrType, "QRDynamic");
  assert.match(body.qrExpirationDate, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+03:00$/);
  assert.equal(r.providerId, "AD100004BAL7227F9BNP6KNE007J9B3K");
  assert.match(r.url, /^https:\/\/qr\.nspk\.ru\//);
  assert.equal(await pay.bankStatus(c, r.providerId), "paid");
  assert.equal(calls[1].url, "https://e-commerce.raiffeisen.ru/api/sbp/v1/qr/AD100004BAL7227F9BNP6KNE007J9B3K/payment-info");
  await pay.cancelPayment(c, r.providerId);
  assert.equal(calls[2].method, "DELETE");
  assert.equal(calls[2].url, "https://e-commerce.raiffeisen.ru/api/sbp/v2/qrs/AD100004BAL7227F9BNP6KNE007J9B3K");
  assert.equal(calls[2].headers.Authorization, "Bearer key");
  for (const [ps, want] of [["DECLINED", "failed"], ["IN_PROGRESS", "pending"], ["NO_INFO", "pending"]]) {
    const { pay: p } = makePay(() => ({ status: 200, text: JSON.stringify({ code: "SUCCESS", paymentStatus: ps }) }));
    assert.equal(await p.bankStatus({ ...c, test: true }, "q"), want);
  }
  assert.equal(gp.moscowIso(Date.UTC(2026, 9, 9, 21, 30, 5)), "2026-10-10T00:30:05+03:00");
});

test("Райффайзенбанк: проверка подключения — ID партнёра и секретный ключ", async () => {
  const reply = (infoStatus) => (url) => {
    if (url.endsWith("/register")) return { status: 200, text: JSON.stringify({ code: "SUCCESS", qrId: "Q1", payload: "https://qr.nspk.ru/Q1" }) };
    if (url.endsWith("/payment-info")) return { status: infoStatus, text: JSON.stringify({ code: "SUCCESS", paymentStatus: "NO_INFO" }) };
    return { status: 200, text: "" };
  };
  const c = { provider: "raiffeisen", login: "MA1", password: "key", test: true };
  let { pay, calls } = makePay(reply(200));
  let r = await pay.checkCreds(c);
  assert.equal(r.ok, true);
  assert.ok(calls[0].url.startsWith("https://test.ecom.raiffeisen.ru/api/"), "тестовый контур");
  assert.ok(calls.some((x) => x.method === "DELETE"), "проверочный QR отменён");
  ({ pay } = makePay(reply(401)));
  r = await pay.checkCreds(c);
  assert.equal(r.ok, false);
  assert.match(r.message, /секретный ключ/);
  ({ pay } = makePay(() => ({ status: 400, text: JSON.stringify({ code: "ERROR.MERCHANT_NOT_REGISTERED", message: "Партнер не зарегистрирован" }) })));
  r = await pay.checkCreds(c);
  assert.equal(r.ok, false);
  assert.match(r.message, /нет партнёра СБП с ID MA1/);
});

test("Т-Банк, страница оплаты: ссылка PaymentURL, возврат на guestPayDone, уведомления принимаются", async () => {
  const { pay, calls, store } = makePay(() => ({ status: 200, text: JSON.stringify({ Success: true, PaymentId: 555, PaymentURL: "https://pay.tbank.ru/abc" }) }));
  const c = { provider: "tinkoff_form", login: "TK", password: "pw" };
  const r = await pay.createPayment(c, { tenantId: "t1", amount: 100, orderId: "g7", description: "Счёт" });
  assert.equal(r.url, "https://pay.tbank.ru/abc");
  assert.equal(calls.length, 1, "без GetQr");
  const init = JSON.parse(calls[0].body);
  assert.equal(init.SuccessURL, "https://pii.zalpos.ru/saas/guestPayDone");
  assert.ok(gp.tokenValid(init, "pw"));
  store.set("tenants/t1/settings/integrations", { onlinePayProvider: "tinkoff_form", onlinePayLogin: "TK", onlinePayPassword: "pw" });
  store.set("tenants/t1/sessions/s1", { status: "active", orderItems: [] });
  store.set("tenants/t1/guestPayments/555", { provider: "tinkoff_form", providerId: "555", sessionId: "s1", amount: 100, status: "pending" });
  const note = { TerminalKey: "TK", PaymentId: 555, Status: "CONFIRMED", Success: true, Amount: 10000 };
  note.Token = gp.tbankToken(note, "pw");
  const res = { writeHead(code) { this.code = code; }, end(t) { this.text = t; } };
  await pay.handleNotify({ url: "/guestPayNotify?t=t1", raw: JSON.stringify(note) }, res);
  assert.equal(res.text, "OK");
  assert.equal(store.get("tenants/t1/guestPayments/555").status, "paid");
});

test("касса: QR через банк заведения — оплачено, отмена, деньги после закрытия окна", async () => {
  let bank = { orderStatus: 0 };
  const { pay, store, calls } = makePay((url) => ({
    status: 200,
    text: JSON.stringify(/register\.do/.test(url) ? { orderId: "o-k1", formUrl: "https://securepayments.sberbank.ru/pay/o-k1" } : bank),
  }));
  const integ = { onlinePayProvider: "sber", onlinePayLogin: "shop-api", onlinePayPassword: "pw" };
  store.set("tenants/t1/settings/integrations", integ);
  const start = async (amount = 450) => { const res = {}; await pay.handleKassaStart({ body: { tenantId: "t1", amount } }, res); return res.body; };
  // Банк не проверен — QR не выдаём.
  await assert.rejects(start(), (e) => e.status === 409 && /не подтвердил/.test(e.message));
  store.set("tenants/t1/settings/integrations", { ...integ, onlinePayVerified: gp.credsPrint(gp.onlinePaySettings(integ)) });
  await assert.rejects(start(0.5), (e) => e.status === 400);
  const s = await start();
  assert.equal(s.url, "https://securepayments.sberbank.ru/pay/o-k1");
  assert.equal(s.sbp, false);
  assert.equal(s.ttlSec, 300);
  const reg = new URLSearchParams(calls[0].body);
  assert.equal(reg.get("amount"), "45000");
  assert.equal(reg.get("sessionTimeoutSecs"), "600");
  const id = s.paymentId;
  assert.equal(store.get(`tenants/t1/kassaPayments/${id}`).status, "pending");
  assert.equal(store.get(`pendingGuestPayments/t1__${id}`).kind, "kassa");
  // Пока окно открыто — ждём; гость заплатил — оплачено, в счёт гостя не пишем.
  const status = async () => { const res = {}; await pay.handleKassaStatus({ body: { tenantId: "t1", paymentId: id } }, res); return res.body.status; };
  assert.equal(await status(), "pending");
  bank = { orderStatus: 2 };
  assert.equal(await status(), "paid");
  assert.equal(store.get(`tenants/t1/kassaPayments/${id}`).status, "paid");
  assert.equal(store.has(`pendingGuestPayments/t1__${id}`), false);
  // Второй платёж: кассир закрыл окно — отмена в банке, статус «отменён».
  bank = { orderStatus: 0 };
  const s2 = await start(300);
  const cancel = {};
  await pay.handleKassaCancel({ body: { tenantId: "t1", paymentId: s2.paymentId } }, cancel);
  assert.equal(cancel.body.status, "cancelled");
  assert.ok(calls.some((x) => /decline\.do$/.test(x.url)), "неоплаченный заказ отменён в банке");
  // Деньги всё же пришли позже — фоновая проверка зовёт персонал.
  bank = { orderStatus: 2 };
  await pay.sweep();
  assert.equal(store.get(`tenants/t1/kassaPayments/${s2.paymentId}`).status, "paid_late");
  const late = [...store.entries()].find(([k, v]) => k.startsWith("tenants/t1/waiterCalls/") && /после закрытия окна: 300/.test(v.comment));
  assert.ok(late, "персоналу — «оплата пришла после закрытия окна»");
  // Окно ещё открыто (касса сама опрашивает) — фон платёж не трогает.
  bank = { orderStatus: 0 };
  const s3 = await start(200);
  bank = { orderStatus: 2 };
  await pay.sweep();
  assert.equal(store.get(`tenants/t1/kassaPayments/${s3.paymentId}`).status, "pending");
  // Касса пропала, окно давно истекло, а деньги пришли — фон сообщает персоналу.
  store.set(`pendingGuestPayments/t1__${s3.paymentId}`, { ...store.get(`pendingGuestPayments/t1__${s3.paymentId}`), createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 9 * 60 * 1000) });
  await pay.sweep();
  assert.equal(store.get(`tenants/t1/kassaPayments/${s3.paymentId}`).status, "paid_late");
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
