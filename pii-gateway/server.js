"use strict";

const http = require("http");
const { Pool } = require("pg");
const admin = require("firebase-admin");

/**
 * Первичная запись персональных данных гостя (имя, телефон) — точка входа
 * для гостевого приложения Kolibri Lounge (см.
 * lib/services/pii_gateway_service.dart и lib/services/guest_link_service.dart
 * → registerGuestProfile). Пишет СНАЧАЛА в PostgreSQL на этом же сервере
 * (физически в РФ) и только потом, внутри того же запроса, зеркалирует то
 * же самое в Firestore проекта hoocah-pos — касса и весь остальной код
 * приложения продолжают читать гостя из Firestore, как и раньше, ни одно
 * из ~30 других мест, где используется `clients/{uid}`, трогать не
 * пришлось.
 *
 * Зачем именно так, а не просто ещё одна запись в Firestore: см. раздел 7
 * политики конфиденциальности платформы (saas/console/console.js,
 * screenLegalPrivacy) — по ст. 18 ч.5 152-ФЗ важно, ГДЕ данные ПЕРВИЧНО
 * записываются, а не наличие более поздней копии где-либо ещё.
 *
 * Область Phase 1 (сознательно НЕ входит — см. README.md и docstring
 * PiiGatewayService в Flutter-коде): поиск гостя по телефону/сессии на
 * кассе, правка телефона во время оплаты, коллекции reservations/
 * discountCards/waitlist со своими независимыми копиями имени/телефона.
 *
 * Запускается как обычный процесс (systemd, см. pii-gateway.service) на
 * своём сервере — не serverless-функция, поэтому обычный http.createServer,
 * без event/context из облачного рантайма.
 *
 * Переменные окружения (см. README.md и .env.example):
 *   PORT — порт, на котором слушает сервис (по умолчанию 8080; наружу
 *     смотрит nginx на 443, см. README.md).
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD — подключение к
 *     PostgreSQL (локальный, на этом же сервере — PGHOST=127.0.0.1, ssl не
 *     нужен для локального подключения).
 *   FIREBASE_SERVICE_ACCOUNT_B64 — сервисный аккаунт ИМЕННО проекта
 *     hoocah-pos (не saas-3bdc8!) в base64 — им проверяется ID-токен
 *     гостя и делается запись в Firestore через Admin SDK.
 */

let pool;
function getPool() {
  if (pool) return pool;
  pool = new Pool({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    // Локальное подключение (тот же сервер) — TLS не нужен, трафик не
    // выходит за пределы localhost.
    ssl: false,
    max: 5,
  });
  return pool;
}

let firebaseApp;
function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;
  const raw = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, "base64").toString("utf8");
  const serviceAccount = JSON.parse(raw);
  firebaseApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return firebaseApp;
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    // Гостевой мобильный клиент CORS не спрашивает, но держим на случай
    // веб-сборки — лишним заголовком ничего не ломаем.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      // Тело заведомо крошечное (имя+телефон) — обрубаем на 64KB, чтобы
      // кто-то по ошибке (или специально) не залил гигабайты в открытый
      // публичный эндпоинт.
      if (data.length > 65536) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleRegisterGuestProfile(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || "{}");
  } catch (e) {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }

  const { tenantId, uid, name, phone } = body;
  if (!uid || typeof uid !== "string") {
    return sendJson(res, 400, { error: "uid обязателен" });
  }
  if (name === undefined && phone === undefined) {
    return sendJson(res, 400, { error: "нужно передать хотя бы name или phone" });
  }

  // Авторизация — тот же принцип, что у Firestore Security Rules для
  // clients/{uid} (allow write: if isSelf(uid)): гость может писать
  // ТОЛЬКО свой собственный профиль. Проверяем это здесь сами, потому что
  // запись теперь идёт мимо самих Firestore Rules.
  const authHeader = req.headers["authorization"] || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!idToken) {
    return sendJson(res, 401, { error: "нет токена авторизации" });
  }

  let decoded;
  try {
    decoded = await getFirebaseApp().auth().verifyIdToken(idToken);
  } catch (e) {
    return sendJson(res, 401, { error: "невалидный токен: " + e.message });
  }
  if (decoded.uid !== uid) {
    return sendJson(res, 403, { error: "нельзя писать чужой профиль" });
  }

  const tenant = typeof tenantId === "string" ? tenantId : "";
  const pgClient = await getPool().connect();
  try {
    await pgClient.query("BEGIN");
    const existing = await pgClient.query(
      "SELECT name, phone FROM guest_profiles WHERE tenant_id = $1 AND uid = $2 FOR UPDATE",
      [tenant, uid]
    );
    const prevName = existing.rows[0]?.name ?? "";
    const prevPhone = existing.rows[0]?.phone ?? "";
    const nextName = name === undefined ? prevName : String(name);
    const nextPhone = phone === undefined ? prevPhone : String(phone);

    await pgClient.query(
      `INSERT INTO guest_profiles (tenant_id, uid, name, phone, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, uid)
       DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, updated_at = now()`,
      [tenant, uid, nextName, nextPhone]
    );
    await pgClient.query("COMMIT");
  } catch (e) {
    try {
      await pgClient.query("ROLLBACK");
    } catch (_) {}
    pgClient.release();
    return sendJson(res, 500, { error: "не удалось сохранить в первичной базе: " + e.message });
  }
  pgClient.release();

  // Зеркало в Firestore — ТОЛЬКО после успешного commit в РФ-базу выше.
  try {
    const db = admin.firestore(getFirebaseApp());
    const path = tenant ? `tenants/${tenant}/clients/${uid}` : `clients/${uid}`;
    const patch = {};
    if (name !== undefined) patch.name = String(name);
    if (phone !== undefined) patch.phone = String(phone);
    await db.doc(path).set(patch, { merge: true });
  } catch (e) {
    // Первичная запись уже сохранена — гость не потеряет данные, но кассе
    // придётся подождать следующего изменения профиля, чтобы увидеть их.
    // Это не 500: с точки зрения 152-ФЗ цель уже достигнута.
    return sendJson(res, 200, { ok: true, firestoreMirrorFailed: String(e.message || e) });
  }

  return sendJson(res, 200, { ok: true });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/health") return sendJson(res, 200, { ok: true });
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

  handleRegisterGuestProfile(req, res).catch((e) => {
    sendJson(res, 500, { error: "internal error: " + (e?.message || e) });
  });
});

const port = Number(process.env.PORT || 8080);
server.listen(port, "127.0.0.1", () => {
  // Слушаем только localhost — снаружи сервис виден через nginx (443,
  // с настоящим TLS-сертификатом), см. README.md.
  console.log(`pii-gateway listening on 127.0.0.1:${port}`);
});

module.exports = server;
