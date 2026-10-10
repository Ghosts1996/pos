"use strict";

const crypto = require("crypto");
const http = require("http");
const { Pool } = require("pg");
const admin = require("firebase-admin");
const { createVault, VaultError, phoneOk, phoneDigits } = require("./vault");

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
 *   SAAS_FIREBASE_SERVICE_ACCOUNT_B64 — ключ проекта платформы saas-3bdc8;
 *   PII_INTERNAL_TOKEN — общий секрет с saas-gateway (ставит update-server.sh).
 *
 * Справочник заведения (сотрудники, гости, контакты) и его режим — в
 * vault.js. Режим заведения — meta/venueProfile.piiMode: 'mirror' (пока
 * все кассы не обновились: копия имён и телефонов идёт и в Firestore) или
 * 'rf' (в Firestore только идентификаторы).
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

/**
 * Режим заведения: 'rf' — имена и телефоны в Firestore больше не копируем.
 * Не прочитали — считаем 'mirror': лишняя копия лучше пустых имён на кассе.
 */
async function piiMode(db, tenantId) {
  if (!tenantId) return "mirror";
  try {
    const snap = await db.doc(`tenants/${tenantId}/meta/venueProfile`).get();
    return snap.exists && snap.data().piiMode === "rf" ? "rf" : "mirror";
  } catch (_) {
    return "mirror";
  }
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Pii-Internal",
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
  // Формат проверяем: из него собирается путь записи с правами админа, и
  // «T/clients/<uid>» увёл бы запись в чужой документ.
  const tenant = typeof tenantId === "string" ? tenantId : "";
  if (tenant && !/^[A-Za-z0-9_-]{1,64}$/.test(tenant)) {
    return sendJson(res, 400, { error: "некорректный tenantId" });
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
    return sendJson(res, 400, { error: "некорректный uid" });
  }
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

  let nextPhone = "";
  const pgClient = await getPool().connect();
  try {
    await pgClient.query("BEGIN");
    const existing = await pgClient.query(
      "SELECT name, phone FROM guest_profiles WHERE tenant_id = $1 AND uid = $2 FOR UPDATE",
      [storeKey, uid]
    );
    const nextName = name ?? existing.rows[0]?.name ?? "";
    nextPhone = phone ?? existing.rows[0]?.phone ?? "";
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
    // После переключения заведения на справочник в РФ имя и телефон в
    // Firestore не копируем; профиль (бонусы, визиты) заводим пустым.
    const rfOnly = (await piiMode(db, tenant)) === "rf";
    const patch = {};
    if (!rfOnly && name !== undefined) patch.name = name;
    if (!rfOnly && phone !== undefined) patch.phone = phone;
    if (rfOnly && !(await db.doc(path).get()).exists) patch.createdAt = admin.firestore.FieldValue.serverTimestamp();
    // «Номер записан в РФ»: по этой отметке правила базы пускают гостя за
    // стол, когда самого номера в профиле нет (режим rf). Гостю её писать
    // правила не дают — ставит только этот сервер.
    if (tenant && phone !== undefined) patch.phoneOnFile = phoneOk(nextPhone);
    if (Object.keys(patch).length) await db.doc(path).set(patch, { merge: true });
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
 * Переписать уже записанный контакт может только тот, кто его создал
 * (повтор после обрыва связи), — чужую бронь по id не перезаписать.
 *
 * Если номер похож на настоящий, кладём в Firestore квитанцию
 * contactReceipts/{kind}_{id} — только uid, без номера. В режиме rf
 * телефона в документе брони нет, и правила базы вместо него проверяют,
 * что номер этой брони записан в РФ этим же гостем.
 */
async function handleRecordContact(req, res, body) {
  const { tenantId, kind, id, name, phone, address } = body;
  const idOk = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
  if (!idOk(tenantId) || !idOk(id) || !["reservation", "waitlist", "delivery"].includes(kind)) {
    return sendJson(res, 400, { error: "некорректные tenantId/kind/id" });
  }
  const auth = await verifySaasUser(req, res);
  if (!auth) return;
  const db = admin.firestore(auth.fbApp);
  try {
    const t = await db.doc(`tenants/${tenantId}`).get();
    if (!t.exists) return sendJson(res, 404, { error: "заведение не найдено" });
  } catch (_) {
    return sendJson(res, 502, { error: "не удалось прочитать заведение" });
  }
  let mine = false;
  try {
    const r = await getPool().query(
      `INSERT INTO contact_records (tenant_id, kind, record_id, name, phone, address, created_by, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, now())
       ON CONFLICT (tenant_id, kind, record_id)
       DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, address = EXCLUDED.address,
         updated_by = EXCLUDED.updated_by, updated_at = now()
       WHERE contact_records.created_by = EXCLUDED.created_by
       RETURNING record_id`,
      [tenantId, kind, id, str(name, 200), str(phone, 40), str(address, 300), auth.decoded.uid]
    );
    mine = r.rows.length > 0;
  } catch (_) {
    return sendJson(res, 500, { error: "не удалось сохранить в первичной базе" });
  }
  if (mine && kind !== "delivery" && phoneOk(phone)) {
    try {
      await db.doc(`tenants/${tenantId}/contactReceipts/${kind}_${id}`).set({
        uid: auth.decoded.uid,
        at: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      // Контакт в РФ записан. Без квитанции бронь без номера (режим rf)
      // правила не пропустят — клиент покажет ошибку и повторит.
      return sendJson(res, 200, { ok: true, receiptFailed: String(e.message || e) });
    }
  }
  return sendJson(res, 200, { ok: true });
}

/**
 * Согласие гостя перед первой отправкой имени или телефона: на обработку,
 * а пока заведение не переведено на хранение в РФ (piiMode !== 'rf') — и на
 * трансграничную передачу. Без нужных отметок гость дальше не проходит
 * (приложение не даёт нажать кнопку), здесь — проверка на случай старой
 * или подделанной версии. Пишем в РФ; в Firestore — только номер редакции,
 * чтобы приложение на другом устройстве не спрашивало заново.
 */
async function handleGuestConsent(req, res, body) {
  const tenant = typeof body.tenantId === "string" ? body.tenantId : "";
  const edition = str(body.edition, 40);
  if (tenant && !/^[A-Za-z0-9_-]{1,64}$/.test(tenant)) {
    return sendJson(res, 400, { error: "некорректный tenantId" });
  }
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(edition)) {
    return sendJson(res, 400, { error: "некорректная редакция согласия" });
  }
  if (body.pd !== true) {
    return sendJson(res, 400, { error: "нужно согласие на обработку персональных данных" });
  }
  const crossBorder = body.crossBorder === true;
  const idToken = bearer(req);
  if (!idToken) return sendJson(res, 401, { error: "нет токена авторизации" });
  let fbApp;
  if (tenant) {
    fbApp = getSaasApp();
    if (!fbApp) return sendJson(res, 503, { error: "pii-gateway не подключён к проекту платформы" });
  }
  let decoded;
  try {
    decoded = await (fbApp || getFirebaseApp()).auth().verifyIdToken(idToken);
  } catch (_) {
    return sendJson(res, 401, { error: "невалидный токен" });
  }
  const db = admin.firestore(fbApp || getFirebaseApp());
  let chainId = "";
  if (tenant) {
    try {
      const t = await db.doc(`tenants/${tenant}`).get();
      if (!t.exists) return sendJson(res, 404, { error: "заведение не найдено" });
      chainId = String(t.data().chainId || "");
    } catch (_) {
      return sendJson(res, 502, { error: "не удалось прочитать заведение" });
    }
  }
  // Заведение в режиме РФ данные за рубеж не передаёт — второе согласие
  // не нужно. В остальных — без него не записываем.
  if (!crossBorder && (await piiMode(db, tenant)) !== "rf") {
    return sendJson(res, 400, { error: "нужно согласие на трансграничную передачу" });
  }
  const storeKey = chainId ? `chain:${chainId}` : tenant;
  try {
    await getPool().query(
      `INSERT INTO guest_consents (tenant_id, uid, edition, pd_consent_at, xborder_consent_at, ip, user_agent)
       VALUES ($1, $2, $3, now(), CASE WHEN $6 THEN now() END, $4, $5)
       ON CONFLICT (tenant_id, uid, edition) DO UPDATE SET
         pd_consent_at = now(), xborder_consent_at = EXCLUDED.xborder_consent_at, withdrawn_at = NULL,
         ip = EXCLUDED.ip, user_agent = EXCLUDED.user_agent`,
      [storeKey, decoded.uid, edition, clientIp(req), String(req.headers["user-agent"] || "").slice(0, 300), crossBorder]
    );
  } catch (_) {
    return sendJson(res, 500, { error: "не удалось сохранить согласие в первичной базе" });
  }
  // Профиль ещё может не существовать (заказ без регистрации) — тогда
  // отметку помнит само устройство, а в Firestore пустой профиль не заводим.
  try {
    const path = chainId ? `chains/${chainId}/clients/${decoded.uid}` : tenant ? `tenants/${tenant}/clients/${decoded.uid}` : `clients/${decoded.uid}`;
    const ref = db.doc(path);
    if ((await ref.get()).exists) await ref.set({ consentEdition: edition }, { merge: true });
  } catch (_) {
    // Согласие уже записано в РФ — копия отметки не обязательна.
  }
  return sendJson(res, 200, { ok: true });
}

/**
 * «Удалить мои данные» в профиле гостя: стираем профиль и контакты его
 * броней и листа ожидания во всех точках заведения или сети. Брони,
 * заведённые персоналом, находим по clientUid. Firestore приложение потом
 * обезличивает через saas-gateway (/deleteGuestData).
 */
/**
 * Стирает гостя в базе в РФ: профиль (у сети — общий), контакты его броней,
 * очереди, заказов из приложения и чеков, где ему начисляли кешбэк, во всех
 * точках заведения или сети. Брони, заведённые персоналом, и чеки находим
 * по clientUid/loyaltyClientUid в Firestore. Значения затираем, а строки
 * оставляем: кассы держат копию справочника и узнают об удалении при
 * следующей синхронизации (pii_sync) — строка без имени и телефона
 * приходит к ним как «стёрто». Ошибка — { status, error }.
 */
async function forgetGuest(fdb, tenantId, uid) {
  let tenantIds;
  let storeKey;
  const recordIds = { reservation: [], waitlist: [], session: [] };
  try {
    const t = await fdb.doc(`tenants/${tenantId}`).get();
    if (!t.exists) return { status: 404, error: "заведение не найдено" };
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
      // Чеки с кешбэком гостю (подпись и контакт для электронного чека) и
      // его заказы, которые завёл кассир.
      for (const field of ["loyaltyClientUid", "clientUid"]) {
        const snap = await fdb.collection(`tenants/${tid}/sessions`).where(field, "==", uid).get();
        recordIds.session.push(...snap.docs.map((d) => d.id));
      }
    }
  } catch (_) {
    return { status: 502, error: "не удалось прочитать данные заведения" };
  }
  const where = `tenant_id = ANY($1) AND (created_by = $2
      OR (kind = 'reservation' AND record_id = ANY($3))
      OR (kind = 'waitlist' AND record_id = ANY($4))
      OR (kind IN ('session', 'delivery') AND record_id = ANY($5)))`;
  const args = [tenantIds, uid, recordIds.reservation, recordIds.waitlist, [...new Set(recordIds.session)]];
  const db = getPool();
  const erase = (table, cond, params, blank) => db.query(`UPDATE ${table} SET ${blank}, updated_at = now() WHERE ${cond}`, params);
  try {
    await erase("guest_profiles", "tenant_id = $1 AND uid = $2", [storeKey, uid], "name = '', phone = ''");
    // Заказы доставки из приложения записаны токеном гостя (created_by) —
    // вместе с ними уходят адрес, пожелания и подпись чека.
    await erase("contact_records", where, args, "name = '', phone = '', address = '', extra = '{}'::jsonb");
    // Отзыв согласия: сама отметка остаётся доказательством того, что
    // данные до удаления обрабатывались законно, но без IP и браузера.
    await db
      .query(
        `UPDATE guest_consents SET withdrawn_at = now(), ip = '', user_agent = ''
         WHERE tenant_id = $1 AND uid = $2 AND withdrawn_at IS NULL`,
        [storeKey, uid]
      )
      .catch((e) => console.error(`guest_consent_withdraw ${tenantId}/${uid}: ${e?.code || ""}`));
  } catch (e) {
    console.error(`guest_delete ${tenantId}/${uid}: ${e?.code || ""} ${e?.message || e}`);
    return { status: 500, error: `не удалось удалить данные в первичной базе (${e?.code || "нет связи с базой"})` };
  }
  return null;
}

/** «Удалить мои данные» — гость своим токеном. */
async function handleDeleteGuest(req, res, body) {
  const { tenantId } = body;
  if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) {
    return sendJson(res, 400, { error: "некорректный tenantId" });
  }
  const auth = await verifySaasUser(req, res);
  if (!auth) return;
  const failed = await forgetGuest(admin.firestore(auth.fbApp), tenantId, auth.decoded.uid);
  if (failed) return sendJson(res, failed.status, { error: failed.error });
  return sendJson(res, 200, { ok: true });
}

/** Запрос от saas-gateway на этом же сервере (заголовок X-Pii-Internal). */
function isInternal(req) {
  const want = process.env.PII_INTERNAL_TOKEN || "";
  const got = String(req.headers["x-pii-internal"] || "");
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/**
 * Супер-админ обезличивает гостя по запросу (письмо, звонок): saas-gateway
 * стирает его и здесь — в первичной базе, а не только в Firestore.
 */
async function handleForgetGuest(req, res, body) {
  if (!isInternal(req)) return sendJson(res, 403, { error: "только для сервера платформы" });
  const { tenantId, uid } = body;
  if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId) || typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
    return sendJson(res, 400, { error: "некорректные tenantId/uid" });
  }
  const fbApp = getSaasApp();
  if (!fbApp) return sendJson(res, 503, { error: "pii-gateway не подключён к проекту платформы" });
  const failed = await forgetGuest(admin.firestore(fbApp), tenantId, uid);
  if (failed) return sendJson(res, failed.status, { error: failed.error });
  return sendJson(res, 200, { ok: true });
}

/**
 * Чей номер — во всех заведениях и сетях (супер-админ ищет гостя по
 * запросу, пришедшему письмом или звонком). Только для saas-gateway.
 */
async function handleFindGuestPhone(req, res, body) {
  if (!isInternal(req)) return sendJson(res, 403, { error: "только для сервера платформы" });
  const phone = phoneDigits(body.phone);
  if (phone.length < 10 || phone.length > 15) return sendJson(res, 400, { error: "некорректный номер" });
  try {
    const r = await getPool().query(
      `SELECT tenant_id, uid, name FROM guest_profiles WHERE phone = $1 ORDER BY updated_at DESC LIMIT 50`,
      [phone]
    );
    return sendJson(res, 200, { matches: r.rows.map((x) => ({ store: x.tenant_id, uid: x.uid, name: x.name })) });
  } catch (_) {
    return sendJson(res, 500, { error: "ошибка хранилища в РФ" });
  }
}

const HANDLERS_EXTRA = {};
const vault = createVault({
  query: (sql, params) => getPool().query(sql, params),
  firestore: () => {
    const app = getSaasApp();
    if (!app) throw new VaultError(503, "pii-gateway не подключён к проекту платформы");
    return admin.firestore(app);
  },
  verifyToken: (token) => {
    const app = getSaasApp();
    if (!app) throw new VaultError(503, "pii-gateway не подключён к проекту платформы");
    return app.auth().verifyIdToken(token);
  },
  internalToken: process.env.PII_INTERNAL_TOKEN || "",
});

async function handleVault(req, res, body) {
  const out = await vault.handle({ token: bearer(req), internal: String(req.headers["x-pii-internal"] || "") }, body);
  sendJson(res, out.status, out.json);
}
for (const op of vault.ops) HANDLERS_EXTRA[op] = handleVault;

const HANDLERS = {
  owner: handleRegisterOwner,
  owner_link: handleLinkOwner,
  guest_delete: handleDeleteGuest,
  guest_forget: handleForgetGuest,
  guest_find_phone: handleFindGuestPhone,
  guest_consent: handleGuestConsent,
  payer: handleRecordPayer,
  ...HANDLERS_EXTRA,
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
