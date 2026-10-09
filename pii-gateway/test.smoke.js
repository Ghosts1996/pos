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
      body: JSON.stringify({ uid: "abc123", phone: "79001234567" }),
    });
    assert.strictEqual(res.statusCode, 401);
  }
  {
    const res = await request("POST", "/", {
      headers: { Authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ uid: "abc123", phone: "79001234567" }),
    });
    assert.strictEqual(res.statusCode, 401);
  }

  {
    // tenantId со слэшами увёл бы запись с правами админа в чужой документ.
    const res = await request("POST", "/", {
      headers: { Authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ tenantId: "t1/clients/victim", uid: "abc123", phone: "79001234567" }),
    });
    assert.strictEqual(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /tenantId/);
  }

  {
    // Без ключа проекта платформы — понятная 503, а не «невалидный токен».
    delete process.env.SAAS_FIREBASE_SERVICE_ACCOUNT_B64;
    const res = await request("POST", "/", {
      headers: { Authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ tenantId: "t1", uid: "abc123", phone: "79001234567" }),
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
  {
    // Согласие гостя: без обеих отметок и без токена — отказ до базы.
    const post = (b, headers) => request("POST", "/", { headers, body: JSON.stringify({ kind: "guest_consent", ...b }) });
    const noEdition = await post({ tenantId: "t1", pd: true, crossBorder: true });
    assert.strictEqual(noEdition.statusCode, 400);
    const noXborder = await post({ tenantId: "t1", edition: "2026-10-09", pd: true });
    assert.strictEqual(noXborder.statusCode, 400);
    assert.match(JSON.parse(noXborder.body).error, /трансграничн/);
    const truthy = await post({ tenantId: "t1", edition: "2026-10-09", pd: "yes", crossBorder: 1 });
    assert.strictEqual(truthy.statusCode, 400);
    const badTenant = await post({ tenantId: "t1/clients/x", edition: "2026-10-09", pd: true, crossBorder: true });
    assert.strictEqual(badTenant.statusCode, 400);
    const noToken = await post({ tenantId: "t1", edition: "2026-10-09", pd: true, crossBorder: true });
    assert.strictEqual(noToken.statusCode, 401);
  }
  {
    // Справочник (vault.js): без заведения — 400, без токена и с чужим
    // внутренним секретом (в тесте он не задан) — 401, до базы не доходит.
    for (const kind of ["pii_sync", "pii_lookup", "pii_put", "pii_erase", "pii_search", "pii_phone"]) {
      const noTenant = await request("POST", "/", { body: JSON.stringify({ kind }) });
      assert.strictEqual(noTenant.statusCode, 400, kind);
      const noToken = await request("POST", "/", { body: JSON.stringify({ kind, tenantId: "t1" }) });
      assert.strictEqual(noToken.statusCode, 401, kind);
      const internal = await request("POST", "/", { headers: { "X-Pii-Internal": "guess" }, body: JSON.stringify({ kind, tenantId: "t1" }) });
      assert.strictEqual(internal.statusCode, 401, kind);
    }
    const unknown = await request("POST", "/", { body: JSON.stringify({ kind: "pii_drop", tenantId: "t1" }) });
    assert.notStrictEqual(unknown.statusCode, 200);
  }
  server.close(() => process.exit(0));
}

run().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  server.close(() => (process.exitCode = 1));
});
