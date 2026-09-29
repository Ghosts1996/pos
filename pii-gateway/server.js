"use strict";

const http = require("http");
const { Pool } = require("pg");
const admin = require("firebase-admin");

/**
 * Первичная запись персональных данных в базу в РФ (ч. 5 ст. 18 152-ФЗ):
 * профили гостей, контакты броней и листа ожидания, владельцы кабинета,
 * реквизиты плательщиков. Сначала пишем в PostgreSQL на этом сервере,
 * копию в Firestore делаем только после успешного COMMIT.
 *
 * Окружение (см. README.md):
 *   PORT — по умолчанию 8080, слушаем только 127.0.0.1, снаружи nginx;
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD — локальный Postgres;
 *   FIREBASE_SERVICE_ACCOUNT_B64 — ключ проекта hoocah-pos (одно заведение);
 *   SAAS_FIREBASE_SERVICE_ACCOUNT_B64 — ключ проекта платформы saas-3bdc8.
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
    ssl: false, // тот же сервер, трафик не выходит за localhost
    max: 5,
  });
  return pool;
}

let firebaseApp;
function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;
  const raw = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, "base64").toString("utf8");
  firebaseApp = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return firebaseApp;
}

// Гости SaaS-заведений живут в проекте платформы: без его ключа их
// ID-токены не проходят проверку (aud другого проекта).
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
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  res.end(body);
}

class BodyTooLarge extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Буферы, а не строка: кириллица в UTF-8 может разрезаться между чанками.
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 65536) {
        chunks.push(chunk);
        return;
      }
      // Отвечаем 413 сразу, остаток дочитываем вхолостую; совсем большие рвём.
      reject(new BodyTooLarge());
      if (size > 1048576) req.destroy();
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const bearer = (req) => (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();

/** ID-токен пользователя проекта платформы или готовый ответ с ошибкой. */
async function verifySaasUser(req, res) {
  const idToken = bearer(req);
  if (!idToken) {
    sendJson(res, 401, { error: "нет токена авторизации" });
    return null;
  }
  const fbApp = getSaasApp();
  if (!fbApp) {
    sendJson(res, 503, { error: "pii-gateway не подключён к проекту платформы" });
    return null;
  }
  try {
    return { fbApp, decoded: await fbApp.auth().verifyIdToken(idToken) };
  } catch (_) {
    sendJson(res, 401, { error: "невалидный токен" });
    return null;
  }
}

async function handleRegisterGuestProfile(req, res, body) {
  const { tenantId, uid } = body;
  // null считаем «не передано»: иначе в базу уйдёт строка "null".
  const name = body.name == null ? undefined : str(String(body.name), 200);
  const phone = body.phone == null ? undefined : str(String(body.phone), 40);
  if (!uid || typeof uid !== "string") {
    return sendJson(res, 400, { error: "uid обязателен" });
  }
  if (name === undefined && phone === undefined) {
    return sendJson(res, 400, { error: "нужно передать хотя бы name или phone" });
  }

  // Запись идёт мимо Firestore Rules, поэтому «гость пишет только себя»
  // проверяем сами.
  const idToken = bearer(req);
  if (!idToken) {
    return sendJson(res, 401, { error: "нет токена авторизации" });
  }

  // Непустой tenantId — гость SaaS-заведения, пустой — сборка одного заведения.
  const tenant = typeof tenantId === "string" ? tenantId : "";
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

  // У сети один профиль гостя на все точки. Сеть берём из заведения,
  // а не из запроса.
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
  const storeKey = chainId ? `chain:${chainId}` : tenant;

  const pgClient = await getPool().connect();
  try {
    await pgClient.query("BEGIN");
    const existing = await pgClient.query(
      "SELECT name, phone FROM guest_profiles WHERE tenant_id = $1 AND uid = $2 FOR UPDATE",
      [storeKey, uid]
    );
    const nextName = name ?? existing.rows[0]?.name ?? "";
    const nextPhone = phone ?? existing.rows[0]?.phone ?? "";
    await pgClient.query(
      `INSERT INTO guest_profiles (tenant_id, uid, name, phone, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, uid)
       DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, updated_at = now()`,
      [storeKey, uid, nextName, nextPhone]
    );
    await pgClient.query("COMMIT");
  } catch (e) {
    await pgClient.query("ROLLBACK").catch(() => {});
    return sendJson(res, 500, { error: "не удалось сохранить в первичной базе: " + e.message });
  } finally {
    pgClient.release();
  }

  try {
    const db = admin.firestore(fbApp || getFirebaseApp());
    const path = chainId
      ? `chains/${chainId}/clients/${uid}`
      : tenant ? `tenants/${tenant}/clients/${uid}` : `clients/${uid}`;
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (phone !== undefined) patch.phone = phone;
    await db.doc(path).set(patch, { merge: true });
  } catch (e) {
    // В РФ уже записано, копия догонит при следующем изменении профиля.
    return sendJson(res, 200, { ok: true, firestoreMirrorFailed: String(e.message || e) });
  }

  return sendJson(res, 200, { ok: true });
}

function clientIp(req) {
  return String(req.headers["x-real-ip"] || req.socket?.remoteAddress || "").slice(0, 64);
}

// Регистрация владельца идёт без входа, поэтому ограничиваем частоту по IP.
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
 * Владелец кабинета: консоль вызывает это до регистрации в Firebase Auth,
 * так что email и отметки о согласиях сначала попадают в базу в РФ.
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

/** После первого входа привязываем запись владельца к uid. */
async function handleLinkOwner(req, res) {
  const auth = await verifySaasUser(req, res);
  if (!auth) return;
  const email = String(auth.decoded.email || "").toLowerCase();
  if (!email) return sendJson(res, 400, { error: "в аккаунте нет email" });
  try {
    await getPool().query(
      `INSERT INTO owner_registrations (email, firebase_uid) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET firebase_uid = EXCLUDED.firebase_uid, updated_at = now()`,
      [email, auth.decoded.uid]
    );
  } catch (e) {
    return sendJson(res, 500, { error: "не удалось сохранить: " + (e?.message || e) });
  }
  sendJson(res, 200, { ok: true });
}

/** Активный владелец или администратор заведения либо сети. */
async function isBillingManager(db, billingId, uid) {
  for (const col of ["tenantMembers", "chainMembers"]) {
    const snap = await db.collection(col).doc(`${billingId}_${uid}`).get();
    const m = snap.exists ? snap.data() : null;
    if (m && m.status === "active" && (m.role === "owner" || m.role === "admin")) return true;
  }
  return false;
}

/**
 * Реквизиты плательщика по счёту: ФИО и ИНН ИП — персональные данные.
 * saas-gateway вызывает это токеном владельца и заводит счёт в Firestore
 * только после ответа 200.
 */
async function handleRecordPayer(req, res, body) {
  const invoiceId = str(body.invoiceId, 12);
  const billingId = str(body.billingId, 64);
  const payerType = body.payerType === "org" ? "org" : body.payerType === "ip" ? "ip" : "";
  const inn = str(body.inn, 12);
  if (!/^\d{1,9}$/.test(invoiceId) || !/^[A-Za-z0-9_-]{1,64}$/.test(billingId) || !payerType || !/^(\d{10}|\d{12})$/.test(inn)) {
    return sendJson(res, 400, { error: "некорректные реквизиты плательщика" });
  }
  const auth = await verifySaasUser(req, res);
  if (!auth) return;
  // Без этой проверки любой пользователь платформы мог бы занять номер
  // будущего счёта своими реквизитами (ниже ON CONFLICT DO NOTHING).
  try {
    if (!(await isBillingManager(admin.firestore(auth.fbApp), billingId, auth.decoded.uid))) {
      return sendJson(res, 403, { error: "нет прав на оплату этого заведения" });
    }
  } catch (_) {
    return sendJson(res, 502, { error: "не удалось проверить права" });
  }
  try {
    await getPool().query(
      `INSERT INTO payer_requisites (invoice_id, billing_id, payer_type, name, inn, kpp, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (invoice_id) DO NOTHING`,
      [invoiceId, billingId, payerType, str(body.name, 200), inn, str(body.kpp, 9), auth.decoded.uid]
    );
  } catch (_) {
    return sendJson(res, 500, { error: "не удалось сохранить в первичной базе" });
  }
  return sendJson(res, 200, { ok: true });
}

/**
 * Контакт брони или листа ожидания. Документ в Firestore клиент создаёт
 * сам, но только после ответа 200. Писать может любой вошедший
 * пользователь платформы: и сотрудник на кассе, и гость в приложении.
 */
async function handleRecordContact(req, res, body) {
  const { tenantId, kind, id, name, phone } = body;
  const idOk = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
  if (!idOk(tenantId) || !idOk(id) || !["reservation", "waitlist"].includes(kind)) {
    return sendJson(res, 400, { error: "некорректные tenantId/kind/id" });
  }
  const auth = await verifySaasUser(req, res);
  if (!auth) return;
  try {
    const t = await admin.firestore(auth.fbApp).doc(`tenants/${tenantId}`).get();
    if (!t.exists) return sendJson(res, 404, { error: "заведение не найдено" });
  } catch (_) {
    return sendJson(res, 502, { error: "не удалось прочитать заведение" });
  }
  try {
    await getPool().query(
      `INSERT INTO contact_records (tenant_id, kind, record_id, name, phone, created_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (tenant_id, kind, record_id)
       DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, updated_at = now()`,
      [tenantId, kind, id, str(name, 200), str(phone, 40), auth.decoded.uid]
    );
  } catch (_) {
    return sendJson(res, 500, { error: "не удалось сохранить в первичной базе" });
  }
  return sendJson(res, 200, { ok: true });
}

/**
 * «Удалить мои данные» в профиле гостя: стираем профиль и контакты его
 * броней и листа ожидания во всех точках заведения или сети. Брони,
 * заведённые персоналом, находим по clientUid. Firestore приложение потом
 * обезличивает через saas-gateway (/deleteGuestData).
 */
async function handleDeleteGuest(req, res, body) {
  const { tenantId } = body;
  if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) {
    return sendJson(res, 400, { error: "некорректный tenantId" });
  }
  const auth = await verifySaasUser(req, res);
  if (!auth) return;
  const uid = auth.decoded.uid;
  let tenantIds;
  let storeKey;
  const recordIds = { reservation: [], waitlist: [] };
  try {
    const fdb = admin.firestore(auth.fbApp);
    const t = await fdb.doc(`tenants/${tenantId}`).get();
    if (!t.exists) return sendJson(res, 404, { error: "заведение не найдено" });
    const chainId = String(t.data().chainId || "");
    storeKey = chainId ? `chain:${chainId}` : tenantId;
    tenantIds = chainId
      ? (await fdb.collection("tenants").where("chainId", "==", chainId).get()).docs.map((d) => d.id)
      : [tenantId];
    for (const tid of tenantIds) {
      for (const [kind, col] of [["reservation", "reservations"], ["waitlist", "waitlist"]]) {
        const snap = await fdb.collection(`tenants/${tid}/${col}`).where("clientUid", "==", uid).get();
        recordIds[kind].push(...snap.docs.map((d) => d.id));
      }
    }
  } catch (_) {
    return sendJson(res, 502, { error: "не удалось прочитать данные заведения" });
  }
  const where = `tenant_id = ANY($1) AND (created_by = $2
      OR (kind = 'reservation' AND record_id = ANY($3))
      OR (kind = 'waitlist' AND record_id = ANY($4)))`;
  const args = [tenantIds, uid, recordIds.reservation, recordIds.waitlist];
  try {
    const db = getPool();
    try {
      await db.query("DELETE FROM guest_profiles WHERE tenant_id = $1 AND uid = $2", [storeKey, uid]);
      await db.query(`DELETE FROM contact_records WHERE ${where}`, args);
    } catch (e) {
      // 42501 — на сервере старая схема без права DELETE; затираем значения.
      if (e && e.code !== "42501") throw e;
      await db.query("UPDATE guest_profiles SET name = '', phone = '', updated_at = now() WHERE tenant_id = $1 AND uid = $2", [storeKey, uid]);
      await db.query(`UPDATE contact_records SET name = '', phone = '', updated_at = now() WHERE ${where}`, args);
    }
  } catch (_) {
    return sendJson(res, 500, { error: "не удалось удалить данные в первичной базе" });
  }
  return sendJson(res, 200, { ok: true });
}

const HANDLERS = {
  owner: handleRegisterOwner,
  owner_link: handleLinkOwner,
  guest_delete: handleDeleteGuest,
  payer: handleRecordPayer,
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/health") return sendJson(res, 200, { ok: true });
  if (req.method !== "POST") return sendJson(res, 405, { error: "метод не поддерживается" });

  readBody(req)
    .then((raw) => {
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch (_) {
        return sendJson(res, 400, { error: "тело запроса — не JSON" });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return sendJson(res, 400, { error: "ожидается JSON-объект" });
      }
      // Один адрес на всё (не трогаем nginx), различаем по kind.
      const handler = HANDLERS[body.kind] || (body.kind ? handleRecordContact : handleRegisterGuestProfile);
      return handler(req, res, body);
    })
    .catch((e) => {
      if (res.headersSent) return;
      if (e instanceof BodyTooLarge) return sendJson(res, 413, { error: "слишком большое тело запроса" });
      sendJson(res, 500, { error: "внутренняя ошибка: " + (e?.message || e) });
    });
});

const port = Number(process.env.PORT || 8080);
server.listen(port, "127.0.0.1", () => {
  console.log(`pii-gateway listening on 127.0.0.1:${port}`);
});

module.exports = server;
