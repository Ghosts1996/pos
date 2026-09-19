"use strict";

// Лёгкий smoke-тест валидации входа — без реального Postgres/Firebase (их
// не поднять в CI без боевых кредов). Проверяет только то, что можно
// проверить без сети: отклонение некорректных запросов ДО обращения к базе
// или к Firebase Admin SDK. Запуск: `node test.smoke.js`.

const assert = require("assert");
const { handler } = require("./index.js");

async function run() {
  // 405 — не POST
  {
    const res = await handler({ httpMethod: "GET" });
    assert.strictEqual(res.statusCode, 405);
  }

  // 200 — CORS preflight
  {
    const res = await handler({ httpMethod: "OPTIONS" });
    assert.strictEqual(res.statusCode, 200);
  }

  // 400 — невалидный JSON
  {
    const res = await handler({ httpMethod: "POST", body: "{not json" });
    assert.strictEqual(res.statusCode, 400);
  }

  // 400 — нет uid
  {
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ name: "Гость" }),
    });
    assert.strictEqual(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /uid/);
  }

  // 400 — ни name, ни phone не переданы
  {
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ uid: "abc123" }),
    });
    assert.strictEqual(res.statusCode, 400);
  }

  // 401 — нет заголовка авторизации
  {
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ uid: "abc123", phone: "79995061580" }),
      headers: {},
    });
    assert.strictEqual(res.statusCode, 401);
  }

  // 401 — невалидный токен (нет реального Firebase — verifyIdToken упадёт,
  // и это ожидаемо: цель теста в том, что код ДОХОДИТ до проверки токена
  // и корректно превращает её ошибку в 401, а не падает необработанным
  // исключением).
  {
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ uid: "abc123", phone: "79995061580" }),
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    assert.strictEqual(res.statusCode, 401);
  }

  console.log("yandex-pii-gateway: smoke-тесты валидации — все прошли");
}

run().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exitCode = 1;
});
