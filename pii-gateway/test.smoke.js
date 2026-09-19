"use strict";

// Лёгкий smoke-тест валидации входа — без реального Postgres/Firebase (их
// не поднять здесь без боевых кредов). Поднимает настоящий HTTP-сервер на
// свободном порту и шлёт ему настоящие запросы — проверяет, что сервис
// корректно отклоняет некорректные запросы ДО обращения к базе или к
// Firebase Admin SDK, а не падает необработанным исключением.
// Запуск: `npm test` или `node test.smoke.js`.

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

  console.log("pii-gateway: smoke-тесты валидации — все прошли");
  server.close(() => process.exit(0));
}

run().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  server.close(() => (process.exitCode = 1));
});
