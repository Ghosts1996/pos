"use strict";

const { Pool } = require("pg");
const admin = require("firebase-admin");

/**
 * Первичная запись персональных данных гостя (имя, телефон) — точка входа
 * для гостевого приложения Kolibri Lounge (см.
 * lib/services/pii_gateway_service.dart и lib/services/guest_link_service.dart
 * → registerGuestProfile). Пишет СНАЧАЛА в Managed PostgreSQL (физически в
 * РФ) и только потом, внутри того же запроса, зеркалирует то же самое в
 * Firestore проекта hoocah-pos — касса и весь остальной код приложения
 * продолжают читать гостя из Firestore, как и раньше, ни одно из ~30 других
 * мест, где используется `clients/{uid}`, трогать не пришлось.
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
 * Переменные окружения (задаются при деплое — см. README.md):
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD — подключение к
 *     Yandex Managed Service for PostgreSQL.
 *   PGSSLROOTCERT_B64 — корневой сертификат Managed PostgreSQL, base64.
 *   FIREBASE_SERVICE_ACCOUNT_B64 — сервисный аккаунт ИМЕННО проекта
 *     hoocah-pos (не saas-3bdc8!) в base64 — им проверяется ID-токен
 *     гостя и делается запись в Firestore через Admin SDK.
 */

let pool;
function getPool() {
  if (pool) return pool;
  const caB64 = process.env.PGSSLROOTCERT_B64;
  const ssl = caB64
    ? { ca: Buffer.from(caB64, "base64").toString("utf8"), rejectUnauthorized: true }
    : { rejectUnauthorized: false };
  pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 6432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl,
    max: 3,
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

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Гостевой мобильный клиент CORS не спрашивает, но держим на случай
      // веб-сборки — лишним заголовком ничего не ломаем.
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async function handler(event) {
  const method = (event.httpMethod || "POST").toUpperCase();
  if (method === "OPTIONS") return json(200, { ok: true });
  if (method !== "POST") return json(405, { error: "method not allowed" });

  let body;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "{}";
    body = JSON.parse(raw);
  } catch (e) {
    return json(400, { error: "invalid JSON body" });
  }

  const { tenantId, uid, name, phone } = body;
  if (!uid || typeof uid !== "string") {
    return json(400, { error: "uid обязателен" });
  }
  if (name === undefined && phone === undefined) {
    return json(400, { error: "нужно передать хотя бы name или phone" });
  }

  // Авторизация — тот же принцип, что у Firestore Security Rules для
  // clients/{uid} (allow write: if isSelf(uid)): гость может писать
  // ТОЛЬКО свой собственный профиль. Проверяем это здесь сами, потому что
  // запись теперь идёт мимо самих Firestore Rules.
  const authHeader = event.headers?.Authorization || event.headers?.authorization || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!idToken) {
    return json(401, { error: "нет токена авторизации" });
  }

  let decoded;
  try {
    decoded = await getFirebaseApp().auth().verifyIdToken(idToken);
  } catch (e) {
    return json(401, { error: "невалидный токен: " + e.message });
  }
  if (decoded.uid !== uid) {
    return json(403, { error: "нельзя писать чужой профиль" });
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
    return json(500, { error: "не удалось сохранить в первичной базе: " + e.message });
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
    return json(200, { ok: true, firestoreMirrorFailed: String(e.message || e) });
  }

  return json(200, { ok: true });
};
