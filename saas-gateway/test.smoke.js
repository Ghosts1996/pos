"use strict";

// Проверка валидации без Firestore и GitHub: плохие запросы должны
// отклоняться до обращения к ним, поэтому тесты идут без секретов.

process.env.PORT = "8099";
const server = require("./server.js");
const http = require("http");

let passed = 0;
let failed = 0;

function request(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: "127.0.0.1", port: 8099, path, method, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (_) {}
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function check(name, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}

async function main() {
  await new Promise((r) => setTimeout(r, 200)); // дать серверу подняться

  {
    const r = await request("GET", "/health");
    check("GET /health -> 200 ok:true", r.status === 200 && r.json?.ok === true);
  }
  {
    const r = await request("GET", "/createTenant");
    check("GET /createTenant -> 405 (не POST)", r.status === 405);
  }
  {
    const r = await request("OPTIONS", "/createTenant");
    check("OPTIONS -> 200 (CORS preflight)", r.status === 200);
  }
  {
    const r = await request("POST", "/unknown-route", { body: {} });
    check("POST /unknown-route -> 404", r.status === 404);
  }
  {
    const r = await request("POST", "/createTenant", { body: { name: "Тест", slug: "test" } });
    check("POST /createTenant без токена -> 401", r.status === 401);
  }
  {
    const r = await request("POST", "/createBuildJob", { body: { tenantId: "x" } });
    check("POST /createBuildJob без токена -> 401", r.status === 401);
  }
  {
    const r = await request("POST", "/cancelSubscription", { body: { tenantId: "x" } });
    check("POST /cancelSubscription без токена -> 401", r.status === 401);
  }
  {
    const r = await request("POST", "/resumeSubscription", { body: { tenantId: "x" } });
    check("POST /resumeSubscription без токена -> 401", r.status === 401);
  }
  {
    const r = await request("POST", "/createCheckoutSession", { body: { tenantId: "x", planId: "start" } });
    check("POST /createCheckoutSession без токена -> 401", r.status === 401);
  }
  {
    const r = await request("POST", "/uploadBrandingLogo?tenantId=x", { body: {} });
    check("POST /uploadBrandingLogo без токена -> 401", r.status === 401);
  }
  {
    const r = await request("POST", "/recalculateUsage", { body: {} });
    check("POST /recalculateUsage без токена -> 401", r.status === 401);
  }
  {
    const r = await request("POST", "/grantBonusPeriod", { body: { tenantId: "x", days: 7 } });
    check("POST /grantBonusPeriod без токена -> 401", r.status === 401);
  }
  {
    // ЮKassa больше не принимается — её адреса уведомлений нет.
    const r = await request("POST", "/billingWebhook", { body: { object: { id: "x" } } });
    check("POST /billingWebhook (ЮKassa убрана) -> 404", r.status === 404);
  }
  {
    // Result URL Робокассы без InvId и подписи — отказ до обращения к базе:
    // и для подписок, и для гостей (Shp_t), с любого из двух адресов.
    let r = await request("GET", "/robokassaResult?OutSum=10");
    check("GET /robokassaResult без InvId -> 400", r.status === 400);
    r = await request("GET", "/guestPayRobokassa?OutSum=10&InvId=1&Shp_t=bad%20id");
    check("GET /guestPayRobokassa с плохим Shp_t -> 400", r.status === 400);
  }
  {
    const r = await request("POST", "/completeBuildJob", {
      headers: { "x-callback-secret": "wrong-secret" },
      body: { jobId: "x", status: "success" },
    });
    check("POST /completeBuildJob с неверным секретом -> 403", r.status === 403);
  }
  {
    // Автообновление: из GitHub — только с общим секретом, из панели —
    // только администратору платформы (без входа — 401).
    const r1 = await request("POST", "/rolloutApps", {
      headers: { "x-callback-secret": "wrong-secret" },
      body: { sha: "abcdef1" },
    });
    check("POST /rolloutApps с неверным секретом -> 403", r1.status === 403);
    const r2 = await request("POST", "/rolloutApps", { body: {} });
    check("POST /rolloutApps без входа -> 401", r2.status === 401);
  }
  {
    // Робокасса: Result URL без параметров — 400 до обращения к базе,
    // возврат без номера счёта — в личный кабинет.
    const r1 = await request("POST", "/robokassaResult", { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    check("POST /robokassaResult без параметров -> 400", r1.status === 400);
    const r2 = await request("GET", "/robokassaSuccess");
    check("GET /robokassaSuccess без счёта -> 302", r2.status === 302);
  }
  {
    // Счета для ИП и организаций: без входа — 401 до обращения к базе.
    for (const path of ["/createBankInvoice", "/markBankInvoicePaid", "/markBankInvoiceReceipt", "/cancelBankInvoice"]) {
      const r = await request("POST", path, { body: { id: "1" } });
      check(`POST ${path} без входа -> 401`, r.status === 401);
    }
    // Контрольные цифры ИНН (10 — организация, 12 — ИП).
    check("ИНН 7707083893 верный", server.innValid("7707083893") === true);
    check("ИНН 7707083894 с ошибкой", server.innValid("7707083894") === false);
    check("ИНН ИП 500100732259 верный", server.innValid("500100732259") === true);
    check("ИНН ИП 500100732258 с ошибкой", server.innValid("500100732258") === false);
    check("ИНН из 11 цифр неверный", server.innValid("77070838931") === false);
    // Чек при расчётах с ИП/организациями — до 9-го числа следующего месяца (по Москве).
    check("срок чека: 29.09 -> 09.10", server.receiptDeadline(Date.UTC(2026, 8, 29, 10)) === "2026-10-09");
    check("срок чека: 30.09 23:00 МСК -> 09.10", server.receiptDeadline(Date.UTC(2026, 8, 30, 20)) === "2026-10-09");
    check("срок чека: 01.10 01:00 МСК -> 09.11", server.receiptDeadline(Date.UTC(2026, 8, 30, 22)) === "2026-11-09");
    check("срок чека: декабрь -> 09.01 следующего года", server.receiptDeadline(Date.UTC(2026, 11, 15)) === "2027-01-09");
  }
  {
    // Восстановление входа гостя: без uid и ключа — 400 до обращения к базе.
    const r = await request("POST", "/restoreGuestSession", { body: "{}", headers: { "Content-Type": "application/json" } });
    check("POST /restoreGuestSession без ключа -> 400", r.status === 400);
  }
  {
    // Проверка обновлений: касса — только участнику заведения, гостю — без
    // входа, но с корректными полями (всё отваливается до Firestore).
    const r = await request("POST", "/appUpdate", { body: { tenantId: "t1", app: "pos", platform: "android", current: 5 } });
    check("POST /appUpdate кассы без токена -> 401", r.status === 401);
  }
  for (const [name, body] of [
    ["без tenantId", { app: "guest", current: 1 }],
    ["с tenantId-путём", { tenantId: "../x", app: "guest", current: 1 }],
    ["с неизвестным app", { tenantId: "t1", app: "admin", current: 1 }],
    ["гостевое под Windows", { tenantId: "t1", app: "guest", platform: "windows", current: 1 }],
    ["с неизвестной платформой", { tenantId: "t1", app: "pos", platform: "ios", current: 1 }],
    ["без номера сборки", { tenantId: "t1", app: "guest" }],
    ["с дробным номером сборки", { tenantId: "t1", app: "guest", current: 1.5 }],
  ]) {
    const r = await request("POST", "/appUpdate", { body });
    check(`POST /appUpdate ${name} -> 400`, r.status === 400);
  }
  {
    const r = await request("POST", "/resolveTenantBySlug", { body: { slug: "Some Bad Slug!" } });
    check("POST /resolveTenantBySlug с недопустимым slug -> 400", r.status === 400);
  }
  {
    const r = await request("POST", "/resolveTenantBySlug", { body: { slug: "admin" } });
    check("POST /resolveTenantBySlug с зарезервированным slug -> 400", r.status === 400);
  }
  {
    // Первые 5 (DEMO_RATE_LIMIT_MAX) запросов падают на попытке достучаться
    // до Firestore без настоящих credentials (500) — это ожидаемо в
    // smoke-тесте; 6-й должен упереться в лимит частоты раньше, чем в
    // Firestore, и вернуть 429.
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const r = await request("POST", "/createDemoTenant", { body: {} });
      lastStatus = r.status;
    }
    check("POST /createDemoTenant: 6-й подряд запрос -> 429 (rate limit)", lastStatus === 429);
  }
  {
    // Лимит считается по НАСТОЯЩЕМУ IP (X-Real-IP от nginx / хвост
    // X-Forwarded-For), а не по первому элементу X-Forwarded-For, который
    // присылает сам клиент: подмена заголовка лимит не сбрасывает.
    // За nginx заголовок выглядит как «подделка клиента, настоящий IP».
    const r = await request("POST", "/createDemoTenant", { body: {}, headers: { "X-Forwarded-For": "203.0.113.77, 127.0.0.1" } });
    check("POST /createDemoTenant: поддельный X-Forwarded-For не обходит лимит -> 429", r.status === 429);
  }
  for (const path of ["/grantSuperAdmin", "/revokeSuperAdmin", "/revokeAdminSessions", "/recordAdminLogin", "/overrideSubscription", "/savePlan", "/deletePlan", "/securityStatus", "/runCertificateCheck", "/runBackup", "/downloadBackup", "/reprovisionDomain", "/blockEntry", "/unblockEntry", "/securityDevices", "/disableDevice", "/enableDevice", "/aiProxy", "/createDataRequest", "/requestGuestDataDeletion", "/resolveDataRequest", "/findGuest", "/anonymizeGuest", "/deleteGuestData", "/registerGuestRecovery", "/uploadMenuImage?tenantId=x&folder=items&entityId=y", "/savePlatformLegal"]) {
    const r = await request("POST", path, { body: {} });
    check(`POST ${path} без токена -> 401`, r.status === 401);
  }

  {
    // Письма входа: неизвестный тип и кривой адрес отсекаются сразу; без
    // SMTP сервис отвечает 503 — консоль тогда отправляет письмо через Firebase.
    let r = await request("POST", "/sendAuthEmail", { body: { type: "spam", email: "a@b.ru" } });
    check("POST /sendAuthEmail: неизвестный тип -> 400", r.status === 400);
    r = await request("POST", "/sendAuthEmail", { body: { type: "signIn", email: "не почта" } });
    check("POST /sendAuthEmail: кривой адрес -> 400", r.status === 400);
    r = await request("POST", "/sendAuthEmail", { body: { type: "signIn", email: "owner@example.ru" } });
    check("POST /sendAuthEmail: без SMTP -> 503", r.status === 503);
  }

  {
    // Оплата со стола: без входа — 401, уведомление без заведения — 400.
    let r = await request("POST", "/guestPayStart", { body: { tenantId: "t1", sessionId: "s1" } });
    check("POST /guestPayStart: без токена -> 401", r.status === 401);
    r = await request("POST", "/guestPayNotify", { body: {} });
    check("POST /guestPayNotify: без заведения -> 400", r.status === 400);
    const gp = require("./guest-pay.js");
    check("guest-pay: счёт со скидкой без кальяна",
      gp.sessionBill({ orderItems: [{ name: "Чай", price: 300, qty: 2 }, { name: "Кальян", price: 1500, qty: 1 }], discountPercent: 10 }) === 2040);
    check("guest-pay: к оплате = счёт + чаевые − оплачено", gp.amountDue({ bill: 2040, tips: 200, paid: 1000 }) === 1240);
    const n = { TerminalKey: "K", PaymentId: 5, Status: "CONFIRMED", Success: true, Amount: 100, Data: { a: 1 } };
    n.Token = gp.tbankToken(n, "p");
    check("guest-pay: подпись уведомления Т-Банка", gp.tokenValid(n, "p") && !gp.tokenValid(n, "q"));
  }

  {
    let r = await request("POST", "/telegramLinkCode", { body: { tenantId: "t1" } });
    check("POST /telegramLinkCode: без токена -> 401", r.status === 401);
    r = await request("POST", "/telegramAccess", { body: { tenantId: "t1", allowed: [{ id: 123456 }] } });
    check("POST /telegramAccess: без токена -> 401", r.status === 401);
    const tg = require("./telegram.js");
    const day = tg.lastBusinessDay(new Date("2026-10-09T07:30:00Z"), "Europe/Moscow");
    check("telegram: рабочие сутки 06:00–06:00 по местному времени",
      day.key === "2026-10-08" && day.start.toISOString() === "2026-10-08T03:00:00.000Z");
    const text = tg.buildSummary({ venueName: "Тест", label: "08.10", sessions: [
      { orderItems: [{ name: "Чай", price: 300, qty: 2 }], paymentCash: 600 },
      { closedWithoutPayment: true, orderItems: [{ name: "Чай", price: 300, qty: 1 }] },
    ], audit: [] });
    check("telegram: итоги — выручка и закрытые без оплаты", text.includes("Выручка: 600 ₽") && text.includes("закрыто без оплаты: 1"));
    check("PIN-хэш сервера совпадает с кассой (эталон из test/pin_hash_test.dart)",
      server.pinHashFor("1234", "t1") === require("crypto").pbkdf2Sync("1234", "zalpos-pin:t1", 20000, 32, "sha256").toString("hex"));
    {
      const key = require("crypto").randomBytes(32);
      const enc = tg.encrypt(key, "123456:ABCdef");
      check("telegram: токен шифруется AES-256-GCM и расшифровывается", enc.startsWith("v1:") && !enc.includes("ABCdef") && tg.decrypt(key, enc) === "123456:ABCdef");
      let tampered = false;
      try { tg.decrypt(key, enc.slice(0, -4) + "AAAA"); } catch (_) { tampered = true; }
      check("telegram: подменённый шифротекст не расшифровывается", tampered);
      const card = tg.deliveryCardText({ id: "abcdef123456", orderNo: 17, orderType: "delivery", deliveryStatus: "cooking",
        guestTag: "Иван Петров", customerPhone: "+79001112233", deliveryAddress: "ул. Ленина, 1",
        orderItems: [{ name: "Пицца", price: 500, qty: 2 }] }, "Europe/Moscow");
      const oldCard = tg.deliveryCardText({ id: "abcdef123456", orderType: "takeaway", deliveryStatus: "new", orderItems: [] }, "Europe/Moscow");
      check("telegram: у заказа без порядкового номера — 4 последних знака id", oldCard.includes("№3456"));
      check("telegram: в карточке доставки нет имени, телефона и адреса гостя",
        card.includes("№17") && card.includes("Готовится") && !card.includes("Иван") && !card.includes("+7900") && !card.includes("Ленина"));
      const kb = tg.deliveryKeyboard({ id: "abc", orderType: "delivery", deliveryStatus: "cooking" }, "https://x/a");
      check("telegram: кнопки доставки — следующий шаг, курьер, адрес",
        kb.inline_keyboard[0][0].callback_data === "s:abc:courier" && kb.inline_keyboard[1].some((b) => b.url === "https://x/a"));
    }
    r = await request("POST", "/tgHook/t1", { body: {} });
    check("POST /tgHook: без секрета бота -> 403", r.status === 403);
    r = await request("GET", "/deliveryAddress?t=t1&s=s1&e=1&k=bad");
    check("GET /deliveryAddress: неверная подпись -> 403", r.status === 403);
    check("telegram: мелкая скидка не сигналит", tg.alertText("Тест", { action: "discount_applied", details: { percent: 5 } }) === null);
  }

  server.close();
  console.log(`\nsaas-gateway: smoke-тесты валидации — ${passed} прошли, ${failed} упали`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
