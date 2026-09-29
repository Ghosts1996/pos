"use strict";

// Проверка валидации без Postgres и Firebase: плохие запросы должны
// отклоняться до обращения к базе. Запуск: npm test.

const assert = require("assert");
const http = require("http");

const TEST_PORT = 8099;
process.env.PORT = String(TEST_PORT);

const server = require("./server.js");

function request(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: TEST_PORT, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  // Даём серверу время встать на порт.
  await new Promise((r) => setTimeout(r, 300));

  {
    const res = await request("GET", "/health");
    assert.strictEqual(res.statusCode, 200);
  }
  {
    const res = await request("GET", "/");
    assert.strictEqual(res.statusCode, 405);
  }
  {
    const res = await request("OPTIONS", "/");
    assert.strictEqual(res.statusCode, 200);
  }
  {
    const res = await request("POST", "/", { body: "{not json" });
    assert.strictEqual(res.statusCode, 400);
  }
  {
    const res = await request("POST", "/", { body: "null" });
    assert.strictEqual(res.statusCode, 400);
  }
  {
    const res = await request("POST", "/", { body: JSON.stringify({ uid: "abc123", name: "x".repeat(70000) }) });
    assert.strictEqual(res.statusCode, 413);
  }
  {
    const res = await request("POST", "/", { body: JSON.stringify({ name: "Гость" }) });
    assert.strictEqual(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /uid/);
  }
  {
    const res = await request("POST", "/", { body: JSON.stringify({ uid: "abc123" }) });
    assert.strictEqual(res.statusCode, 400);
  }
  {
    const res = await request("POST", "/", {
      body: JSON.stringify({ uid: "abc123", phone: "79995061580" }),
    });
    assert.strictEqual(res.statusCode, 401);
  }
  {
    const res = await request("POST", "/", {
      headers: { Authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ uid: "abc123", phone: "79995061580" }),
    });
    assert.strictEqual(res.statusCode, 401);
  }

  {
    // Без ключа проекта платформы — понятная 503, а не «невалидный токен».
    delete process.env.SAAS_FIREBASE_SERVICE_ACCOUNT_B64;
    const res = await request("POST", "/", {
      headers: { Authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ tenantId: "t1", uid: "abc123", phone: "79995061580" }),
    });
    assert.strictEqual(res.statusCode, 503);
    assert.match(JSON.parse(res.body).error, /SAAS_FIREBASE_SERVICE_ACCOUNT_B64/);
  }

  {
    // Владелец: без согласий и с кривым email — 400 до обращения к базе.
    const noConsent = await request("POST", "/", { body: JSON.stringify({ kind: "owner", email: "o@x.ru", offer: true }) });
    assert.strictEqual(noConsent.statusCode, 400);
    const badEmail = await request("POST", "/", { body: JSON.stringify({ kind: "owner", email: "nope", offer: true, pdConsent: true }) });
    assert.strictEqual(badEmail.statusCode, 400);
    const noToken = await request("POST", "/", { body: JSON.stringify({ kind: "owner_link" }) });
    assert.strictEqual(noToken.statusCode, 401);
  }

  {
    // Реквизиты плательщика по счёту: неверные — 400, без токена — 401.
    const bad = await request("POST", "/", { body: JSON.stringify({ kind: "payer", invoiceId: "1", billingId: "t1", payerType: "org", inn: "12" }) });
    assert.strictEqual(bad.statusCode, 400);
    const noToken = await request("POST", "/", { body: JSON.stringify({ kind: "payer", invoiceId: "1", billingId: "t1", payerType: "org", inn: "7707083893" }) });
    assert.strictEqual(noToken.statusCode, 401);
  }
  {
    // Гость удаляет свои данные: без заведения — 400, без токена — 401.
    const noTenant = await request("POST", "/", { body: JSON.stringify({ kind: "guest_delete" }) });
    assert.strictEqual(noTenant.statusCode, 400);
    const noToken = await request("POST", "/", { body: JSON.stringify({ kind: "guest_delete", tenantId: "t1" }) });
    assert.strictEqual(noToken.statusCode, 401);
  }

  console.log("pii-gateway: smoke-тесты валидации — все прошли");
  server.close(() => process.exit(0));
}

run().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  server.close(() => (process.exitCode = 1));
});
