"use strict";

// Smoke-тесты валидации входа — реально поднимают HTTP-сервер и шлют ему
// запросы, но не требуют живой БД/Firebase (см. тот же приём в
// pii-gateway/test.smoke.js): всё, что здесь проверяется, отваливается ДО
// обращения к Firestore/GitHub, поэтому проходит и без настоящих секретов.

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
    // Проверка paymentId отваливается ДО обращения к ЮKassa/Firestore —
    // тот же приём, что и у остальных тестов этого файла.
    const r = await request("POST", "/billingWebhook", { body: { object: {} } });
    check("POST /billingWebhook без object.id -> 400", r.status === 400);
  }
  {
    const r = await request("POST", "/completeBuildJob", {
      headers: { "x-callback-secret": "wrong-secret" },
      body: { jobId: "x", status: "success" },
    });
    check("POST /completeBuildJob с неверным секретом -> 403", r.status === 403);
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

  server.close();
  console.log(`\nsaas-gateway: smoke-тесты валидации — ${passed} прошли, ${failed} упали`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
