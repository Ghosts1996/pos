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

// Гости SaaS-заведений входят в ОТДЕЛЬНЫЙ Firebase-проект платформы (не
// hoocah-pos): их ID-токен проверяется и профиль зеркалируется только его
// сервисным аккаунтом. Без этого проверка токена SaaS-гостя падала с
// «incorrect aud», и в SaaS-приложении гостя не сохранялись ни профиль, ни
// бронь. На сервере это тот же ключ, что у saas-gateway
// (FIREBASE_SERVICE_ACCOUNT_B64 в /etc/saas-gateway.env), см. README.md.
let saasApp;
function getSaasApp() {
  if (saasApp !== undefined) return saasApp;
  const b64 = process.env.SAAS_FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) {
    saasApp = null;
    return null;
  }
  const serviceAccount = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  saasApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }, "saas");
  return saasApp;
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

async function handleRegisterGuestProfile(req, res, body) {

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

  const tenant = typeof tenantId === "string" ? tenantId : "";
  // tenantId непустой — гость SaaS-заведения (проект платформы), пустой —
  // одно-арендная сборка (проект hoocah-pos), как было.
  let fbApp;
  if (tenant) {
    fbApp = getSaasApp();
    if (!fbApp) {
      return sendJson(res, 503, {
        error: "pii-gateway не подключён к проекту платформы: задайте SAAS_FIREBASE_SERVICE_ACCOUNT_B64 (см. README.md)",
      });
    }
  }

  let decoded;
  try {
    decoded = await (fbApp || getFirebaseApp()).auth().verifyIdToken(idToken);
  } catch (e) {
    return sendJson(res, 401, { error: "невалидный токен: " + e.message });
  }
  if (decoded.uid !== uid) {
    return sendJson(res, 403, { error: "нельзя писать чужой профиль" });
  }

  // Профиль гостя СЕТИ заведений общий на все её точки (лояльность сети,
  // chains/{chainId}/clients — оттуда его читает приложение гостя, см.
  // AppScope.loyaltyCol). Сеть берём из документа заведения, а не из
  // запроса: клиенту здесь не доверяем.
  let chainId = "";
  if (tenant) {
    let tenantSnap;
    try {
      tenantSnap = await admin.firestore(fbApp).doc(`tenants/${tenant}`).get();
    } catch (e) {
      return sendJson(res, 502, { error: "не удалось прочитать заведение: " + e.message });
    }
    if (!tenantSnap.exists) {
      return sendJson(res, 404, { error: "заведение не найдено" });
    }
    chainId = String(tenantSnap.data().chainId || "");
  }
  // Ключ в первичной базе совпадает с тем, где живёт профиль: у сети — одна
  // запись на все её точки.
  const storeKey = chainId ? `chain:${chainId}` : tenant;
  const pgClient = await getPool().connect();
  try {
    await pgClient.query("BEGIN");
    const existing = await pgClient.query(
      "SELECT name, phone FROM guest_profiles WHERE tenant_id = $1 AND uid = $2 FOR UPDATE",
      [storeKey, uid]
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
      [storeKey, uid, nextName, nextPhone]
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
    const db = admin.firestore(fbApp || getFirebaseApp());
    const path = chainId
      ? `chains/${chainId}/clients/${uid}`
      : tenant ? `tenants/${tenant}/clients/${uid}` : `clients/${uid}`;
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

// Первичная запись контакта брони/листа ожидания (имя, телефон) в РФ-базу.
// Тот же адрес, что и профиль гостя (различаем по полю kind в теле) — чтобы
// не трогать конфиг nginx. Документ в Firestore клиент создаёт сам, только
// после ответа 200 отсюда. Писать может любой вошедший пользователь проекта
// (сотрудник на кассе или гость в приложении) — в реальное заведение.
// ---------- владельцы личного кабинета ZalPOS ----------

/** IP клиента: nginx передаёт настоящий в X-Real-IP. */
function clientIp(req) {
  return String(req.headers["x-real-ip"] || req.socket?.remoteAddress || "").slice(0, 64);
}

// Регистрация владельца идёт без входа — ограничиваем частоту по IP.
const OWNER_LIMIT_PER_HOUR = 20;
const ownerHits = new Map(); // ip -> [ms]
function ownerRateLimited(ip) {
  const now = Date.now();
  const list = (ownerHits.get(ip) || []).filter((t) => now - t < 3600000);
  list.push(now);
  ownerHits.set(ip, list);
  if (ownerHits.size > 10000) ownerHits.clear();
  return list.length > OWNER_LIMIT_PER_HOUR;
}

/**
 * Первичная запись владельца (ч. 5 ст. 18 152-ФЗ): личный кабинет
 * (saas/console/console.js, recordOwnerInRussia) вызывает её ДО
 * регистрации в Firebase Auth — email сначала оказывается в базе в РФ.
 * Вместе с ним — моменты принятия оферты и согласия на обработку ПД.
 */
async function handleRegisterOwner(req, res, body) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return sendJson(res, 400, { error: "некорректный email" });
  }
  if (body.offer !== true || body.pdConsent !== true) {
    return sendJson(res, 400, { error: "нужны принятие оферты и согласие на обработку персональных данных" });
  }
  const ip = clientIp(req);
  if (ownerRateLimited(ip)) return sendJson(res, 429, { error: "слишком много попыток — попробуйте через час" });
  const edition = typeof body.edition === "string" ? body.edition.slice(0, 80) : "";
  const ua = String(req.headers["user-agent"] || "").slice(0, 300);
  try {
    await getPool().query(
      `INSERT INTO owner_registrations (email, offer_accepted_at, pd_consent_at, pd_consent_edition, ip, user_agent)
       VALUES ($1, now(), now(), $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET
         offer_accepted_at = now(), pd_consent_at = now(), pd_consent_edition = EXCLUDED.pd_consent_edition,
         ip = EXCLUDED.ip, user_agent = EXCLUDED.user_agent, updated_at = now()`,
      [email, edition, ip, ua]
    );
  } catch (e) {
    return sendJson(res, 500, { error: "не удалось сохранить: " + (e?.message || e) });
  }
  sendJson(res, 200, { ok: true });
}

/** После первого входа — привязать запись к аккаунту (по ID-токену). */
async function handleLinkOwner(req, res) {
  const idToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!idToken) return sendJson(res, 401, { error: "нет токена авторизации" });
  const fbApp = getSaasApp();
  if (!fbApp) return sendJson(res, 503, { error: "pii-gateway не подключён к проекту платформы" });
  let decoded;
  try {
    decoded = await fbApp.auth().verifyIdToken(idToken);
  } catch (e) {
    return sendJson(res, 401, { error: "невалидный токен" });
  }
  const email = String(decoded.email || "").toLowerCase();
  if (!email) return sendJson(res, 400, { error: "в аккаунте нет email" });
  try {
    await getPool().query(
      `INSERT INTO owner_registrations (email, firebase_uid) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET firebase_uid = EXCLUDED.firebase_uid, updated_at = now()`,
      [email, decoded.uid]
    );
  } catch (e) {
    return sendJson(res, 500, { error: "не удалось сохранить: " + (e?.message || e) });
  }
  sendJson(res, 200, { ok: true });
}

/**
 * Реквизиты плательщика по счёту (ИП или организация) — первичная запись в
 * РФ: у ИП ФИО и ИНН — персональные данные (ч. 5 ст. 18 152-ФЗ).
 * saas-gateway (/createBankInvoice) вызывает это от имени владельца (его
 * ID-токен) и только после успешного ответа заводит счёт в Firestore.
 */
async function handleRecordPayer(req, res, body) {
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const invoiceId = str(body.invoiceId, 12);
  const billingId = str(body.billingId, 64);
  const payerType = body.payerType === "org" ? "org" : body.payerType === "ip" ? "ip" : "";
  const inn = str(body.inn, 12);
  if (!/^\d{1,9}$/.test(invoiceId) || !/^[A-Za-z0-9_-]{1,64}$/.test(billingId) || !payerType || !/^(\d{10}|\d{12})$/.test(inn)) {
    return sendJson(res, 400, { error: "некорректные реквизиты плательщика" });
  }
  const idToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!idToken) return sendJson(res, 401, { error: "нет токена авторизации" });
  const fbApp = getSaasApp();
  if (!fbApp) return sendJson(res, 503, { error: "pii-gateway не подключён к проекту платформы" });
  let decoded;
  try {
    decoded = await fbApp.auth().verifyIdToken(idToken);
  } catch (e) {
    return sendJson(res, 401, { error: "невалидный токен" });
  }
  try {
    await getPool().query(
      `INSERT INTO payer_requisites (invoice_id, billing_id, payer_type, name, inn, kpp, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (invoice_id) DO NOTHING`,
      [invoiceId, billingId, payerType, str(body.name, 200), inn, str(body.kpp, 9), decoded.uid]
    );
  } catch (e) {
    return sendJson(res, 500, { error: "не удалось сохранить в первичной базе" });
  }
  return sendJson(res, 200, { ok: true });
}

async function handleRecordContact(req, res, body) {
  const { tenantId, kind, id, name, phone } = body;
  const idOk = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
  if (!idOk(tenantId) || !idOk(id) || !["reservation", "waitlist"].includes(kind)) {
    return sendJson(res, 400, { error: "некорректные tenantId/kind/id" });
  }
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const idToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!idToken) return sendJson(res, 401, { error: "нет токена авторизации" });
  const fbApp = getSaasApp();
  if (!fbApp) return sendJson(res, 503, { error: "pii-gateway не подключён к проекту платформы" });
  let decoded;
  try {
    decoded = await fbApp.auth().verifyIdToken(idToken);
  } catch (e) {
    return sendJson(res, 401, { error: "невалидный токен" });
  }
  try {
    const t = await admin.firestore(fbApp).doc(`tenants/${tenantId}`).get();
    if (!t.exists) return sendJson(res, 404, { error: "заведение не найдено" });
  } catch (e) {
    return sendJson(res, 502, { error: "не удалось прочитать заведение" });
  }
  try {
    await getPool().query(
      `INSERT INTO contact_records (tenant_id, kind, record_id, name, phone, created_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (tenant_id, kind, record_id)
       DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, updated_at = now()`,
      [tenantId, kind, id, str(name, 200), str(phone, 40), decoded.uid]
    );
  } catch (e) {
    return sendJson(res, 500, { error: "не удалось сохранить в первичной базе" });
  }
  return sendJson(res, 200, { ok: true });
}

/**
 * Гость удаляет свои данные сам (кнопка «Удалить мои данные» в профиле):
 * стираем его имя и телефон в первичной базе в РФ — профиль и контакты его
 * броней и листа ожидания во всех точках заведения/сети. Брони, которые
 * завёл персонал, находим по clientUid в Firestore. Потом приложение
 * обезличивает Firestore через saas-gateway (/deleteGuestData).
 */
async function handleDeleteGuest(req, res, body) {
  const { tenantId } = body;
  if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) {
    return sendJson(res, 400, { error: "некорректный tenantId" });
  }
  const idToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!idToken) return sendJson(res, 401, { error: "нет токена авторизации" });
  const fbApp = getSaasApp();
  if (!fbApp) return sendJson(res, 503, { error: "pii-gateway не подключён к проекту платформы" });
  let decoded;
  try {
    decoded = await fbApp.auth().verifyIdToken(idToken);
  } catch (e) {
    return sendJson(res, 401, { error: "невалидный токен" });
  }
  const uid = decoded.uid;
  let tenantIds;
  let storeKey;
  const recordIds = { reservation: [], waitlist: [] };
  try {
    const fs = admin.firestore(fbApp);
    const t = await fs.doc(`tenants/${tenantId}`).get();
    if (!t.exists) return sendJson(res, 404, { error: "заведение не найдено" });
    const chainId = String(t.data().chainId || "");
    storeKey = chainId ? `chain:${chainId}` : tenantId;
    tenantIds = chainId
      ? (await fs.collection("tenants").where("chainId", "==", chainId).get()).docs.map((d) => d.id)
      : [tenantId];
    for (const tid of tenantIds) {
      for (const [kind, col] of [["reservation", "reservations"], ["waitlist", "waitlist"]]) {
        const snap = await fs.collection(`tenants/${tid}/${col}`).where("clientUid", "==", uid).get();
        recordIds[kind].push(...snap.docs.map((d) => d.id));
      }
    }
  } catch (e) {
    return sendJson(res, 502, { error: "не удалось прочитать данные заведения" });
  }
  const where = `tenant_id = ANY($1) AND (created_by = $2
      OR (kind = 'reservation' AND record_id = ANY($3))
      OR (kind = 'waitlist' AND record_id = ANY($4)))`;
  const args = [tenantIds, uid, recordIds.reservation, recordIds.waitlist];
  try {
    const pool = getPool();
    try {
      await pool.query("DELETE FROM guest_profiles WHERE tenant_id = $1 AND uid = $2", [storeKey, uid]);
      await pool.query(`DELETE FROM contact_records WHERE ${where}`, args);
    } catch (e) {
      // Схема ещё без права DELETE (не применён свежий schema.sql) —
      // затираем значения: данные всё равно уничтожены.
      if (e && e.code !== "42501") throw e;
      await pool.query("UPDATE guest_profiles SET name = '', phone = '', updated_at = now() WHERE tenant_id = $1 AND uid = $2", [storeKey, uid]);
      await pool.query(`UPDATE contact_records SET name = '', phone = '', updated_at = now() WHERE ${where}`, args);
    }
  } catch (e) {
    return sendJson(res, 500, { error: "не удалось удалить данные в первичной базе" });
  }
  return sendJson(res, 200, { ok: true });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/health") return sendJson(res, 200, { ok: true });
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

  const fail = (e) => sendJson(res, 500, { error: "internal error: " + (e?.message || e) });
  // Тело читаем один раз и по полю kind решаем, что это: контакт брони /
  // листа ожидания или профиль гостя (как раньше).
  readBody(req)
    .then((raw) => {
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch (_) {
        return sendJson(res, 400, { error: "invalid JSON body" });
      }
      if (body && body.kind === "owner") return handleRegisterOwner(req, res, body);
      if (body && body.kind === "owner_link") return handleLinkOwner(req, res);
      if (body && body.kind === "guest_delete") return handleDeleteGuest(req, res, body);
      if (body && body.kind === "payer") return handleRecordPayer(req, res, body);
      if (body && body.kind) return handleRecordContact(req, res, body);
      return handleRegisterGuestProfile(req, res, body);
    })
    .catch(fail);
});

const port = Number(process.env.PORT || 8080);
server.listen(port, "127.0.0.1", () => {
  // Слушаем только localhost — снаружи сервис виден через nginx (443,
  // с настоящим TLS-сертификатом), см. README.md.
  console.log(`pii-gateway listening on 127.0.0.1:${port}`);
});

module.exports = server;
