"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Короткий хеш коммита: его пишет migrate-domain.sh, а /health отдаёт,
// чтобы было видно, обновился ли сервер.
const SERVER_VERSION = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "VERSION"), "utf8").trim();
  } catch (_) {
    return "";
  }
})();
const admin = require("firebase-admin");
const { execFile } = require("child_process");
const tls = require("tls");
const dns = require("dns");
const net = require("net");
const zlib = require("zlib");
const { authEmailLetter, passwordLetter, createMailer, AUTH_EMAIL_TYPES } = require("./auth-email");
const { createGuestPay, onlinePaySettings, credsPrint, sellerReady } = require("./guest-pay");
const { createGuestDelivery } = require("./guest-delivery");
const { createTelegram } = require("./telegram");

/**
 * saas-gateway — серверная часть платформы ZalPOS (проект saas-3bdc8).
 * Здесь всё, что нельзя доверить клиенту и нельзя держать в Cloud Functions
 * без тарифа Blaze: заведения и сети, приглашения, модерация, сборки APK,
 * оплата подписок, выдача файлов.
 *
 * Слушает 127.0.0.1:PORT, снаружи nginx (location /saas/ на домене
 * pii-gateway, см. README.md). Проект hoocah-pos отсюда не трогаем.
 *
 * Окружение (README.md, setup.sh):
 *   PORT — по умолчанию 8081;
 *   FIREBASE_SERVICE_ACCOUNT_B64 — ключ проекта saas-3bdc8;
 *   GITHUB_PAT — токен с правами Actions: read and write на Ghosts1996/pos;
 *   BUILD_CALLBACK_SECRET — секрет обратного вызова сборки, тот же, что
 *     в секретах репозитория;
 *   GITHUB_REF — ветка, из которой запускаются сборки;
 *   ROBOKASSA_LOGIN / ROBOKASSA_PASSWORD1 / ROBOKASSA_PASSWORD2 — магазин
 *     Робокассы, через который оплачиваются подписки.
 */

const GITHUB_OWNER = "Ghosts1996";
const GITHUB_REPO = "pos";
const GITHUB_SAAS_WORKFLOW = "saas-on-demand-build.yml";
// Когда ветку сольют в main, достаточно GITHUB_REF=main в /etc/saas-gateway.env.
const GITHUB_REF = process.env.GITHUB_REF || "claude/dazzling-babbage-n65p6l";

// Личные APK заведений: сборка кладёт их сюда по SSH (Storage у проекта
// без Blaze недоступен). Отдаёт handleDownloadBuild после проверки роли.
const TENANT_BUILDS_DIR = path.join(__dirname, "tenant-builds");

// Логотипы заведений. Читаются публично (nginx, location /branding/),
// запись — только через handleUploadBrandingLogo.
const BRANDING_UPLOADS_DIR = path.join(__dirname, "branding-uploads");
const BRANDING_MAX_BYTES = 5 * 1024 * 1024;
const BRANDING_CONTENT_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** Проверяем сигнатуру файла, а не присланный Content-Type: иначе под
 *  видом логотипа можно выложить на домен HTML или скрипт. */
function imageMatchesType(buffer, ext) {
  if (ext === "png") return buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === "jpg") return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (ext === "webp") return buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  return false;
}

// Код заведения становится поддоменом, поэтому служебные имена заняты.
const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "www", "download", "support", "billing",
  "docs", "static", "assets", "cdn", "mail", "status", "help", "demo", "saas",
  "pii", "ftp", "smtp", "imap", "pop", "pop3", "webmail", "ns1", "ns2", "ns3", "ns4",
  "autoconfig", "autodiscover", "dns-check",
]);

// Все вложенные коллекции заведения — для удаления демо (purgeDemoTenant).
// Держать в синхроне с saas/firestore.rules.
const TENANT_SUBCOLLECTIONS = [
  "aiActions", "aiJobs", "aiLogs", "aiUsage", "auditLog", "bonusOperations",
  "branding", "cashOps", "clients", "devices", "discountCards", "employees",
  "giftCardClaims", "giftCards", "guestOrders", "hallLabels", "hallWalls", "happyHours", "inventory",
  "inventoryCounts", "inventoryItems", "inventoryMovements", "jobRuns",
  "marking_codes_sold", "menuCategories", "menuItems", "meta", "payrollAdjustments", "phoneIndex",
  "pushQueue", "referralCodes", "reservations", "reservationSlots",
  "reviews", "sessionClaims", "sessions", "settings", "shifts", "staffNotes",
  "staffShifts", "stories", "tableKeys", "tables", "tips", "usage",
  "waiterCalls", "waitlist", "guestPayments",
];

// Демо-заведения создаются анонимно и живут 3 дня с момента запуска демо
// на телефоне: потом удаляются, а касса сама открывает новое демо в
// исходном виде (DemoGate в приложении). Так демо нельзя превратить в
// бесплатную рабочую кассу — всё введённое через 3 дня исчезает.
const DEMO_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const DEMO_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // проверка каждые 30 минут
const DEMO_RATE_LIMIT_MAX = 5; // создание демо-заведений с одного IP
const DEMO_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // за час — защита от накрутки

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let firebaseApp;
function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;
  const raw = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, "base64").toString("utf8");
  const serviceAccount = JSON.parse(raw);
  firebaseApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return firebaseApp;
}
function db() {
  return admin.firestore(getFirebaseApp());
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    // Консоль живёт на другом origin. GET нужен для downloadBuild: preflight
    // с Authorization приходит и на GET.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-callback-secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Буферы, а не строка: иначе кириллица бьётся на стыке чанков.
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 262144) {
        chunks.push(chunk);
        return;
      }
      reject(new HttpError(413, "тело запроса слишком большое"));
      if (size > 1048576) req.destroy();
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch (e) {
    throw new HttpError(400, "тело запроса — не JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "ожидается JSON-объект");
  }
  return body;
}

/** Код заведения: латиница, цифры и дефис — он же поддомен. */
function normalizeSlug(raw) {
  if (typeof raw !== "string") {
    throw new HttpError(400, "Название-код заведения обязательно");
  }
  const slug = raw.trim().toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new HttpError(
      400,
      "Код заведения: только латинские буквы, цифры и дефис, без пробелов и спецсимволов"
    );
  }
  if (slug.length < 3 || slug.length > 40) {
    throw new HttpError(400, "Код заведения должен быть от 3 до 40 символов");
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new HttpError(400, "Этот код зарезервирован платформой, выберите другой");
  }
  return slug;
}

/** Код заведения и код сети — один поддомен, поэтому проверяем обе коллекции:
 *  гостевой веб сначала ищет заведение, и сеть с тем же кодом не открылась бы. */
async function assertSlugFree(firestore, slug, message) {
  const [tenants, chains] = await Promise.all([
    firestore.collection("tenants").where("slug", "==", slug).limit(1).get(),
    firestore.collection("chains").where("slug", "==", slug).limit(1).get(),
  ]);
  if (!tenants.empty || !chains.empty) throw new HttpError(409, message);
}

function randomInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  // crypto.randomInt, а не Math.random: код приглашения открывает доступ
  // кассы ко всем данным заведения — он должен быть непредсказуемым.
  for (let i = 0; i < 8; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

/** Сравнение секретов за постоянное время — по времени ответа нельзя
 *  подбирать секрет посимвольно. */
function secretsEqual(given, expected) {
  const a = Buffer.from(String(given || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
}

function randomDemoSuffix() {
  return crypto.randomBytes(4).toString("hex");
}

async function verifyAuth(req) {
  const authHeader = req.headers["authorization"] || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!idToken) throw new HttpError(401, "нет токена авторизации");
  try {
    return await getFirebaseApp().auth().verifyIdToken(idToken);
  } catch (e) {
    throw new HttpError(401, "Сеанс истёк или недействителен — войдите заново");
  }
}

/** Вход был после последнего «Выйти на всех устройствах»
 *  (superAdmins/{uid}.sessionsValidAfter, секунды). То же в firestore.rules. */
function adminSessionValid(adminData, decoded) {
  const validAfter = adminData && adminData.sessionsValidAfter;
  return typeof validAfter !== "number" || (Number(decoded.auth_time) || 0) > validAfter;
}

/** Возвращает данные superAdmins/{uid}. */
async function requireSuperAdmin(decoded) {
  if (!decoded || !decoded.uid) throw new HttpError(401, "Нужен вход");
  const doc = await db().collection("superAdmins").doc(decoded.uid).get();
  if (!doc.exists) throw new HttpError(403, "Только для супер-администратора платформы");
  if (!adminSessionValid(doc.data(), decoded)) {
    throw new HttpError(401, "Сеанс панели завершён — войдите заново");
  }
  return doc.data();
}

/** Для действий, которые кроме владельца может сделать и супер-админ. */
async function isSuperAdmin(decoded) {
  if (!decoded || !decoded.uid) return false;
  const doc = await db().collection("superAdmins").doc(decoded.uid).get();
  return doc.exists && adminSessionValid(doc.data(), decoded);
}

// Самые опасные действия (например, назначить супер-админа) — только сразу
// после ввода пароля: открытый или украденный сеанс для них не годится.
const RECENT_AUTH_MAX_AGE_SEC = 5 * 60;
function requireRecentAuth(decoded) {
  const age = Math.floor(Date.now() / 1000) - (Number(decoded.auth_time) || 0);
  if (age > RECENT_AUTH_MAX_AGE_SEC) {
    throw new HttpError(401, "Подтвердите пароль — это действие требует недавнего входа");
  }
}

async function requireTenantRole(tenantId, uid, allowedRoles) {
  const memberDoc = await db().collection("tenantMembers").doc(`${tenantId}_${uid}`).get();
  const member = memberDoc.data();
  if (!memberDoc.exists || member.status !== "active" || !allowedRoles.includes(member.role)) {
    throw new HttpError(403, "Недостаточно прав в этом заведении");
  }
}

async function requireChainRole(chainId, uid, allowedRoles) {
  const memberDoc = await db().collection("chainMembers").doc(`${chainId}_${uid}`).get();
  const member = memberDoc.data();
  if (!memberDoc.exists || member.status !== "active" || !allowedRoles.includes(member.role)) {
    throw new HttpError(403, "Недостаточно прав в этой сети заведений");
  }
}

/**
 * Членство в точке сети дублируем в chainMembers: правила общих коллекций
 * сети (chains/{chainId}/clients и др.) смотрят туда, в пути нет tenantId.
 * Ошибку только логируем — основная запись уже сделана.
 */
async function syncChainMembership(chainId, uid, role, status) {
  if (!chainId) return;
  try {
    await db().collection("chainMembers").doc(`${chainId}_${uid}`).set(
      { chainId, userId: uid, role, status, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (e) {
    console.error(`syncChainMembership(${chainId}, ${uid}) не удался:`, e.message || e);
  }
}

/**
 * securityLog — то, чем можно навредить платформе целиком: доступ
 * супер-админов, ручные решения по деньгам и данным, блокировки.
 * Не бросает: действие уже выполнено.
 */
async function writeSecurityEvent(req, decoded, action, { targetUid, targetEmail, tenantId, metadata } = {}) {
  try {
    await db().collection("securityLog").add({
      action,
      actorId: (decoded && decoded.uid) || null,
      actorEmail: (decoded && decoded.email) || null,
      targetUid: targetUid || null,
      targetEmail: targetEmail || null,
      tenantId: tenantId || null,
      metadata: metadata || {},
      ip: req ? clientIp(req) : null,
      userAgent: req ? String(req.headers["user-agent"] || "").slice(0, 300) : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error(`writeSecurityEvent(${action}) не удался:`, e.message || e);
  }
}

/** Название и код заведения в журнал — чтобы запись была понятна и после
 *  удаления заведения. */
async function tenantLabel(tenantId, knownData) {
  try {
    const data = knownData || (await db().collection("tenants").doc(tenantId).get()).data() || {};
    return { tenantName: data.name || null, tenantSlug: data.slug || null };
  } catch (_) {
    return { tenantName: null, tenantSlug: null };
  }
}

async function writeAuditLog({ tenantId, actorId, action, metadata }) {
  await db().collection("auditLogs").add({
    tenantId: tenantId || null,
    actorId: actorId || null,
    action,
    metadata: metadata || {},
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ------------------------------------------------ resolveTenantBySlug

/**
 * tenantId по коду заведения. Нужен устройству до вступления в заведение,
 * когда правила ещё не дают читать tenants.
 */
async function handleResolveTenantBySlug(req, res) {
  const body = await parseJsonBody(req);
  const slug = normalizeSlug(body.slug);
  const snap = await db().collection("tenants").where("slug", "==", slug).limit(1).get();
  if (snap.empty) throw new HttpError(404, "Заведение с таким кодом не найдено");
  const tenant = snap.docs[0];
  if (tenant.data().status === "deleted") {
    throw new HttpError(404, "Заведение с таким кодом не найдено");
  }
  sendJson(res, 200, { tenantId: tenant.id, status: tenant.data().status, chainId: tenant.data().chainId || null });
}

/** Сеть по коду и список её точек — экран «выберите заведение» у гостя. */
async function handleResolveChainBySlug(req, res) {
  const body = await parseJsonBody(req);
  const slug = normalizeSlug(body.slug);
  const firestore = db();
  const snap = await firestore.collection("chains").where("slug", "==", slug).limit(1).get();
  if (snap.empty) throw new HttpError(404, "Сеть заведений с таким кодом не найдена");
  const chain = snap.docs[0];
  const chainData = chain.data();
  if (chainData.status === "deleted") {
    throw new HttpError(404, "Сеть заведений с таким кодом не найдена");
  }

  const locationsSnap = await firestore.collection("tenants").where("chainId", "==", chain.id).get();
  const locations = locationsSnap.docs
    .filter((d) => d.data().status !== "deleted")
    // Порядок, в котором точки открывали: первая — обычно главная.
    .sort((a, b) => (a.data().createdAt?.toMillis?.() || 0) - (b.data().createdAt?.toMillis?.() || 0) || String(a.data().name || "").localeCompare(String(b.data().name || ""), "ru"))
    .map((d) => ({ tenantId: d.id, name: d.data().name, slug: d.data().slug, status: d.data().status }));

  const brandingDoc = await firestore.collection("chains").doc(chain.id).collection("branding").doc("config").get();

  sendJson(res, 200, {
    chainId: chain.id,
    name: chainData.name,
    status: chainData.status,
    branding: brandingDoc.exists ? brandingDoc.data() : null,
    locations,
  });
}

// ------------------------------------------- chain points for the kassa

/**
 * Сеть, в которой работает этот планшет кассы (или участник): активное
 * членство в точке сети. Отключённый в кабинете планшет членства не имеет —
 * и к другим точкам не попадёт.
 */
async function callerChainMembership(uid, chainId) {
  const firestore = db();
  const snap = await firestore.collection("tenantMembers").where("userId", "==", uid).where("status", "==", "active").get();
  for (const m of snap.docs) {
    const tenantId = m.data().tenantId;
    const t = (await firestore.collection("tenants").doc(tenantId).get()).data();
    if (t && t.chainId === chainId && t.status !== "deleted") return { tenantId, member: m.data(), tenant: t };
  }
  return null;
}

/** Точки сети для выбора кассы при входе: название, код, подключена ли
 *  уже эта касса к точке. */
async function handleChainPoints(req, res) {
  const decoded = await verifyAuth(req);
  const { chainId } = await parseJsonBody(req);
  if (typeof chainId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(chainId)) throw new HttpError(400, "Не указана сеть");
  const own = await callerChainMembership(decoded.uid, chainId);
  if (!own) throw new HttpError(403, "Эта касса не подключена к точкам сети");
  const firestore = db();
  const chain = (await firestore.collection("chains").doc(chainId).get()).data();
  if (!chain || chain.status === "deleted") throw new HttpError(404, "Сеть заведений не найдена");
  const [points, mine] = await Promise.all([
    firestore.collection("tenants").where("chainId", "==", chainId).get(),
    firestore.collection("tenantMembers").where("userId", "==", decoded.uid).where("status", "==", "active").get(),
  ]);
  const joined = new Set(mine.docs.map((d) => d.data().tenantId));
  sendJson(res, 200, {
    chainId,
    name: chain.name || "",
    points: points.docs
      .filter((d) => !["deleted"].includes(d.data().status))
      // Порядок, в котором точки открывали: первая — обычно главная.
      .sort((a, b) => (a.data().createdAt?.toMillis?.() || 0) - (b.data().createdAt?.toMillis?.() || 0) || String(a.data().name || "").localeCompare(String(b.data().name || ""), "ru"))
      .map((d) => ({ tenantId: d.id, name: d.data().name || "", slug: d.data().slug || "", status: d.data().status, joined: joined.has(d.id) })),
  });
}

/**
 * Касса точки сети заходит в кассу другой точки той же сети: устройство
 * записывается в неё так же, как по коду приглашения, только код не нужен
 * — владелец сети уже пустил планшет в одну из своих точек. Сотрудники у
 * каждой точки свои: PIN другой точки здесь не подойдёт.
 */
async function handleChainPointJoin(req, res) {
  const decoded = await verifyAuth(req);
  const { tenantId } = await parseJsonBody(req);
  if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new HttpError(400, "Не указана точка");
  const firestore = db();
  const target = (await firestore.collection("tenants").doc(tenantId).get()).data();
  if (!target || !target.chainId || target.status === "deleted") throw new HttpError(404, "Точка сети не найдена");
  const memberRef = firestore.collection("tenantMembers").doc(`${tenantId}_${decoded.uid}`);
  const existing = (await memberRef.get()).data();
  if (existing?.status === "active") {
    sendJson(res, 200, { ok: true, tenantId });
    return;
  }
  // Отключённого владельцем в этой точке планшет сам не возвращает.
  if (existing) throw new HttpError(403, "Эту кассу отключили в этой точке — подключите её заново в кабинете");
  const own = await callerChainMembership(decoded.uid, target.chainId);
  if (!own) throw new HttpError(403, "Эта касса не подключена к точкам этой сети");
  const sourceDevice = (await firestore.collection("tenants").doc(own.tenantId).collection("devices").doc(decoded.uid).get()).data();
  if (!sourceDevice || sourceDevice.status === "disabled") throw new HttpError(403, "Эта касса отключена в кабинете");
  const invite = (await firestore.collection("tenants").doc(tenantId).collection("settings").doc("deviceInvite").get()).data();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = firestore.batch();
  batch.set(firestore.collection("tenants").doc(tenantId).collection("devices").doc(decoded.uid), {
    inviteCode: invite?.code || "",
    deviceName: sourceDevice.deviceName || "",
    deviceType: "pos",
    platform: sourceDevice.platform || null,
    userId: decoded.uid,
    joinedVia: "chain",
    joinedFromTenantId: own.tenantId,
    createdAt: now,
    lastSeenAt: now,
    status: "active",
  });
  batch.set(memberRef, { tenantId, userId: decoded.uid, role: "employee", status: "active", createdAt: now });
  await batch.commit();
  await writeAuditLog({ tenantId, actorId: decoded.uid, action: "deviceJoinedFromChain", metadata: { fromTenantId: own.tenantId } });
  sendJson(res, 200, { ok: true, tenantId });
}

// ------------------------------------------------------ firebaseConfig

let cachedWebConfig;
function getFirebaseWebConfig() {
  if (cachedWebConfig !== undefined) return cachedWebConfig;
  const raw = process.env.FIREBASE_WEB_CONFIG_JSON;
  cachedWebConfig = raw ? JSON.parse(raw) : null;
  return cachedWebConfig;
}

/**
 * Публичный веб-конфиг Firebase (не секрет). Гостевой веб живёт на
 * поддоменах {slug}.zalpos.ru, а /__/firebase/init.json хостинга не отдаёт
 * CORS для чужого origin, поэтому раздаём конфиг отсюда.
 */
async function handleFirebaseWebConfig(req, res) {
  const config = getFirebaseWebConfig();
  if (!config) {
    throw new HttpError(500, "FIREBASE_WEB_CONFIG_JSON не настроен на сервере — см. README.md");
  }
  sendJson(res, 200, config);
}

// -------------------------------------------------- publicGuestApk

/**
 * Гостевой APK по QR со стола — единственная выдача сборки без входа.
 * Отдаём только сборку типа guest: в ней нет секретов, а код заведения и так
 * публичный. Кассу (у неё внутри код приглашения устройства) так не получить.
 */
async function handlePublicGuestApk(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  const slug = normalizeSlug(requestUrl.searchParams.get("slug") || "");

  const firestore = db();
  const tenantSnap = await firestore.collection("tenants").where("slug", "==", slug).limit(1).get();
  if (tenantSnap.empty) throw new HttpError(404, "Заведение с таким кодом не найдено");
  const tenantDoc = tenantSnap.docs[0];
  if (tenantDoc.data().status === "deleted") {
    throw new HttpError(404, "Заведение с таким кодом не найдено");
  }
  if (tenantDoc.data().guestAppOff === true) {
    throw new HttpError(403, "Приложение гостя в этом заведении не подключено");
  }

  // Индекс есть только на tenantId+createdAt, поэтому берём последние 20
  // сборок и ищем среди них успешную гостевую.
  const jobsSnap = await firestore
    .collection("buildJobs")
    .where("tenantId", "==", tenantDoc.id)
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();
  const guestJob = jobsSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .find((j) => j.type === "guest" && j.status === "success");
  if (!guestJob) {
    throw new HttpError(404, "Гостевое приложение для этого заведения ещё не собрано");
  }

  const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
  const token = signDownloadToken(guestJob.id, expiresAt);
  // Редирект отдаёт сам сервер, поэтому префикс /saas/ нужен здесь: nginx
  // срезает его перед проксированием, а браузер считает Location от корня.
  const url = `/saas/downloadBuild?jobId=${encodeURIComponent(guestJob.id)}&token=${encodeURIComponent(`${expiresAt}.${token}`)}`;
  res.writeHead(302, { Location: url });
  res.end();
}

/**
 * Демо приложения гостя для кнопки на сайте. Файл кладёт workflow
 * «Публичный APK» (deploy-tenant-apk.sh, папка publicdemo), отдаёт nginx
 * (location /internal-tenant-builds/), как и личные сборки.
 */
const PUBLIC_DEMO_DIR = "publicdemo";
async function handleGuestDemoApk(req, res) {
  const filePath = path.join(TENANT_BUILDS_DIR, PUBLIC_DEMO_DIR, "guestdemo.apk");
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (_) {
    throw new HttpError(404, "Демо приложения гостя ещё не собрано — загляните чуть позже");
  }
  res.writeHead(200, {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": 'attachment; filename="zalpos-guest-demo.apk"',
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Redirect": `/internal-tenant-builds/${PUBLIC_DEMO_DIR}/guestdemo.apk`,
  });
  res.end();
}

/**
 * Демо-касса для Windows (установщик setup.exe) для кнопки на сайте. Кладёт
 * её тот же workflow «Публичный APK» (job build-windows, папка publicdemo,
 * файл kassawin.apk — скрипт доставки пишет только *.apk), отдаёт nginx.
 */
async function handleWindowsDemo(req, res) {
  const filePath = path.join(TENANT_BUILDS_DIR, PUBLIC_DEMO_DIR, "kassawin.apk");
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (_) {
    throw new HttpError(404, "Демо для Windows ещё не собрано — загляните чуть позже");
  }
  res.writeHead(200, {
    "Content-Type": "application/vnd.microsoft.portable-executable",
    "Content-Disposition": 'attachment; filename="zalpos-kassa-demo-setup.exe"',
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Redirect": `/internal-tenant-builds/${PUBLIC_DEMO_DIR}/kassawin.apk`,
  });
  res.end();
}

// ------------------------------------------------------- createTenant

const VENUE_TYPES = ["hookah", "restaurant", "cafe", "bar"];
const DEFAULT_TRIAL_PLAN_ID = "standard";

/**
 * Записи нового заведения (или точки сети [chainId]): само заведение,
 * владелец, настройки, брендинг, код приглашения, подписка одиночного
 * заведения. Права и оплату проверяет вызывающий.
 */
async function createTenantRecords({ name, slug, chainId = null, uid, email = null, planId = null, venueType = "hookah" }) {
  const firestore = db();
  await assertSlugFree(firestore, slug, "Этот код заведения уже занят, выберите другой");

  const tenantRef = firestore.collection("tenants").doc();
  const tenantId = tenantRef.id;
  const now = admin.firestore.FieldValue.serverTimestamp();
  // Тариф сети одиночному заведению не даём: иначе оно получит цену
  // «за точку» без самой сети. Обратная проверка — в handleCreateChain.
  // Тариф не выбран (или снят с продажи) — пробный период на «Бизнесе»:
  // владелец сразу видит и приложение гостя, а платит потом за любой.
  const sellable = (snap) => snap.exists && !snap.data().isChainPlan && snap.data().archived !== true;
  let resolvedPlanId = "start";
  if (!chainId) {
    const requestedSnap = typeof planId === "string" && /^[a-z0-9-]{1,40}$/.test(planId.trim())
      ? await firestore.collection("plans").doc(planId.trim()).get() : null;
    if (requestedSnap && sellable(requestedSnap)) {
      resolvedPlanId = planId.trim();
    } else if (sellable(await firestore.collection("plans").doc(DEFAULT_TRIAL_PLAN_ID).get())) {
      resolvedPlanId = DEFAULT_TRIAL_PLAN_ID;
    }
  }
  // У точки сети своего тарифа нет, биллинг — на chains/{chainId}; «start» —
  // заглушка, возможности точки считаются по тарифу сети.
  const planSnap = await firestore.collection("plans").doc(resolvedPlanId).get();
  const trialDays = Number(planSnap.data()?.trialDays) || 7;

  const batch = firestore.batch();
  batch.set(tenantRef, {
    name: name.trim(),
    slug,
    status: chainId ? "active" : "trial",
    subscriptionStatus: chainId ? "active" : "trial",
    planId: resolvedPlanId,
    ownerUserId: uid,
    chainId: chainId || null,
    createdAt: now,
    updatedAt: now,
  });
  batch.set(firestore.collection("tenantMembers").doc(`${tenantId}_${uid}`), {
    // email — чтобы в «Команде» владелец был подписан адресом, а не «Устройство».
    tenantId, userId: uid, email: email || null, role: "owner", status: "active", createdAt: now,
  });
  batch.set(tenantRef.collection("settings").doc("general"), {
    name: name.trim(), timezone: "Europe/Moscow", currency: "RUB", language: "ru",
  });
  batch.set(tenantRef.collection("settings").doc("session"), {
    defaultHookahDurationMinutes: 90,
    minimumHookahDurationMinutes: 30,
    maximumHookahDurationMinutes: 360,
    quickExtensions: [15, 30, 60],
  });
  batch.set(tenantRef.collection("branding").doc("config"), {
    appName: name.trim(),
    shortName: name.trim().slice(0, 12),
    primaryColor: "#B35C30",
    secondaryColor: "#CFA567",
    accentColor: "#B35C30",
    backgroundColor: "#15120F",
    textColor: "#F2EADF",
    buttonColor: "#B35C30",
    darkMode: true,
  });
  batch.set(tenantRef.collection("settings").doc("deviceInvite"), {
    code: randomInviteCode(), rotatedAt: now,
  });
  // Название нужно чеку, ИИ-помощнику и профилю заведения на кассе.
  batch.set(tenantRef.collection("meta").doc("venueProfile"), { name: name.trim(), venueType }, { merge: true });
  // Своя подписка только у одиночного заведения.
  if (!chainId) {
    batch.set(firestore.collection("subscriptions").doc(tenantId), {
      tenantId,
      planId: resolvedPlanId,
      status: "trial",
      provider: null,
      externalSubscriptionId: null,
      startedAt: now,
      trialEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() + trialDays * 86400000),
      currentPeriodStart: now,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });
  }
  batch.set(firestore.collection("users").doc(uid), { lastActiveTenantId: tenantId }, { merge: true });

  await batch.commit();
  if (chainId) await syncChainMembership(chainId, uid, "owner", "active");
  await syncCapabilities({ tenantId }).catch((e) => console.error(`saas-gateway: возможности тарифа ${tenantId}:`, e.message || e));
  await writeAuditLog({ tenantId, actorId: uid, action: "tenantCreated", metadata: { slug, chainId } });

  // Сертификат выпускается несколько секунд — не ждём, ошибку только логируем.
  provisionTenantDomain(slug).catch((e) => {
    console.error(`provisionTenantDomain(${slug}) не удался:`, e.message || e);
  });

  return { tenantId, slug, chainId };
}

async function handleCreateTenant(req, res) {
  const decoded = await verifyAuth(req);
  if (!decoded.email_verified) {
    throw new HttpError(412, "Подтвердите email, прежде чем создавать заведение");
  }
  await requireNotBlocked(req, decoded.email, "tenant");

  const body = await parseJsonBody(req);
  const { name, slug: rawSlug, planId, chainId: rawChainId } = body;
  // От типа заведения зависят слова в приложении гостя.
  const venueType = VENUE_TYPES.includes(body.venueType) ? body.venueType : "hookah";
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
    throw new HttpError(400, "Название заведения: от 2 до 80 символов");
  }
  const slug = normalizeSlug(rawSlug || name);
  const uid = decoded.uid;

  const firestore = db();
  let chainId = null;
  if (typeof rawChainId === "string" && rawChainId.trim()) {
    chainId = rawChainId.trim();
    const chainDoc = await firestore.collection("chains").doc(chainId).get();
    if (!chainDoc.exists || chainDoc.data().status === "deleted") {
      throw new HttpError(404, "Сеть заведений не найдена");
    }
    await requireChainRole(chainId, uid, ["owner", "admin"]);
    // Новая точка оплаченной сети — только через оплату доп. точки
    // (handleChainLocationCheckout): иначе владелец получал бы точку даром.
    if (!(await isSuperAdmin(decoded))) {
      const quote = await chainLocationQuote(chainId);
      if (!quote.free) {
        throw new HttpError(402, `Новая точка сети — после оплаты доп. точки (${quote.amount.toLocaleString("ru-RU")} ₽): кнопка «Добавить точку сети» в кабинете`);
      }
    }
  }

  const created = await createTenantRecords({
    name: name.trim(), slug, chainId, uid, email: decoded.email || null, planId, venueType,
  });
  const tenantId = created.tenantId;
  // Точка своей сети — не новая регистрация.
  if (!chainId) recordSignupEvent(req, "tenant", { uid, email: decoded.email, tenantId, slug });
  sendJson(res, 200, { tenantId, slug, chainId });
}

/**
 * Пустая сеть заведений: точки добавляются потом через handleCreateTenant
 * с этим chainId. Цена тарифа сети считается за каждую точку
 * (chainPriceForPeriod), пробный период идёт сразу.
 */
async function handleCreateChain(req, res) {
  const decoded = await verifyAuth(req);
  if (!decoded.email_verified) {
    throw new HttpError(412, "Подтвердите email, прежде чем создавать сеть заведений");
  }
  await requireNotBlocked(req, decoded.email, "chain");

  const body = await parseJsonBody(req);
  const { name, slug: rawSlug, planId } = body;
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
    throw new HttpError(400, "Название сети: от 2 до 80 символов");
  }
  const slug = normalizeSlug(rawSlug || name);
  const uid = decoded.uid;

  const firestore = db();
  await assertSlugFree(firestore, slug, "Этот код сети уже занят, выберите другой");

  const chainRef = firestore.collection("chains").doc();
  const chainId = chainRef.id;
  const now = admin.firestore.FieldValue.serverTimestamp();
  // Только тариф сети: обычный тариф не знает цены за дополнительную точку.
  let resolvedPlanId = "chain";
  if (typeof planId === "string" && planId.trim()) {
    const requestedSnap = await firestore.collection("plans").doc(planId.trim()).get();
    if (requestedSnap.exists && requestedSnap.data().isChainPlan) resolvedPlanId = planId.trim();
  }
  const planSnap = await firestore.collection("plans").doc(resolvedPlanId).get();
  const trialDays = Number(planSnap.data()?.trialDays) || 7;

  const batch = firestore.batch();
  batch.set(chainRef, {
    name: name.trim(),
    slug,
    status: "trial",
    planId: resolvedPlanId,
    ownerUserId: uid,
    createdAt: now,
    updatedAt: now,
  });
  batch.set(firestore.collection("chainMembers").doc(`${chainId}_${uid}`), {
    chainId, userId: uid, role: "owner", status: "active", createdAt: now,
  });
  batch.set(chainRef.collection("branding").doc("config"), {
    appName: name.trim(),
    shortName: name.trim().slice(0, 12),
    primaryColor: "#B35C30",
    secondaryColor: "#CFA567",
    accentColor: "#B35C30",
    backgroundColor: "#15120F",
    textColor: "#F2EADF",
    buttonColor: "#B35C30",
    darkMode: true,
  });
  batch.set(firestore.collection("subscriptions").doc(chainId), {
    chainId,
    planId: resolvedPlanId,
    status: "trial",
    provider: null,
    externalSubscriptionId: null,
    startedAt: now,
    trialEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() + trialDays * 86400000),
    currentPeriodStart: now,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  });

  await batch.commit();
  await writeAuditLog({ tenantId: null, actorId: uid, action: "chainCreated", metadata: { slug, chainId } });

  provisionTenantDomain(slug).catch((e) => {
    console.error(`provisionTenantDomain(${slug}) не удался (сеть):`, e.message || e);
  });

  recordSignupEvent(req, "chain", { uid, email: decoded.email, chainId, slug });
  sendJson(res, 200, { chainId, slug });
}

/**
 * Перевод работающего заведения в новую сеть: документ заведения тот же,
 * он просто получает chainId и становится первой точкой. Подписка
 * переносится как есть (с planId сети), брендинг и лояльность гостей
 * (clients, phoneIndex, referralCodes, bonusOperations) копируются в
 * chains/{chainId}/… — оттуда их начинает читать AppScope.loyaltyCol.
 */
async function handleConvertTenantToChain(req, res) {
  const decoded = await verifyAuth(req);
  if (!decoded.email_verified) {
    throw new HttpError(412, "Подтвердите email, прежде чем переводить заведение в сеть");
  }
  const uid = decoded.uid;
  const body = await parseJsonBody(req);
  const { tenantId, name, slug: rawSlug, planId } = body;

  if (typeof tenantId !== "string" || !tenantId.trim()) {
    throw new HttpError(400, "tenantId обязателен");
  }
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
    throw new HttpError(400, "Название сети: от 2 до 80 символов");
  }
  // Только владелец: обратного действия «выйти из сети» нет.
  await requireTenantRole(tenantId, uid, ["owner"]);

  const firestore = db();
  const tenantRef = firestore.collection("tenants").doc(tenantId);
  const tenantSnap = await tenantRef.get();
  if (!tenantSnap.exists) throw new HttpError(404, "Заведение не найдено");
  const tenant = tenantSnap.data();
  if (tenant.chainId) throw new HttpError(409, "Заведение уже состоит в сети");

  const slug = normalizeSlug(rawSlug || name);
  // Код самого заведения сети тоже не подходит: его поддомен уже занят.
  await assertSlugFree(firestore, slug, "Этот код сети уже занят, выберите другой");

  let resolvedPlanId = "chain";
  if (typeof planId === "string" && planId.trim()) {
    const requestedSnap = await firestore.collection("plans").doc(planId.trim()).get();
    if (requestedSnap.exists && requestedSnap.data().isChainPlan) resolvedPlanId = planId.trim();
  }

  const [brandingSnap, oldSubSnap, membersSnap] = await Promise.all([
    tenantRef.collection("branding").doc("config").get(),
    firestore.collection("subscriptions").doc(tenantId).get(),
    firestore.collection("tenantMembers").where("tenantId", "==", tenantId).get(),
  ]);
  const oldSub = oldSubSnap.exists ? oldSubSnap.data() : null;
  // Подписки у заведения быть не может только при сбое — тогда даём пробный период.
  const trialDays = oldSub ? 0 : (Number((await firestore.collection("plans").doc(resolvedPlanId).get()).data()?.trialDays) || 7);

  const branding = brandingSnap.exists ? brandingSnap.data() : {
    appName: name.trim(), shortName: name.trim().slice(0, 12),
    primaryColor: "#B35C30", secondaryColor: "#CFA567", accentColor: "#B35C30",
    backgroundColor: "#15120F", textColor: "#F2EADF", buttonColor: "#B35C30", darkMode: true,
  };

  const chainRef = firestore.collection("chains").doc();
  const chainId = chainRef.id;
  const now = admin.firestore.FieldValue.serverTimestamp();

  const batch = firestore.batch();
  batch.set(chainRef, {
    name: name.trim(), slug, status: tenant.status === "deleted" ? "trial" : (tenant.status || "trial"),
    planId: resolvedPlanId, ownerUserId: uid, createdAt: now, updatedAt: now,
  });
  batch.set(chainRef.collection("branding").doc("config"), branding);
  batch.set(firestore.collection("chainMembers").doc(`${chainId}_${uid}`), {
    chainId, userId: uid, role: "owner", status: "active", createdAt: now,
  });
  batch.set(firestore.collection("subscriptions").doc(chainId), oldSub ? {
    chainId,
    planId: resolvedPlanId,
    status: oldSub.status || "trial",
    provider: oldSub.provider || null,
    externalSubscriptionId: oldSub.externalSubscriptionId || null,
    startedAt: oldSub.startedAt || now,
    trialEndsAt: oldSub.trialEndsAt || null,
    currentPeriodStart: oldSub.currentPeriodStart || now,
    currentPeriodEnd: oldSub.currentPeriodEnd || null,
    cancelAtPeriodEnd: !!oldSub.cancelAtPeriodEnd,
  } : {
    chainId, planId: resolvedPlanId, status: "trial", provider: null, externalSubscriptionId: null,
    startedAt: now, trialEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() + trialDays * 86400000),
    currentPeriodStart: now, currentPeriodEnd: null, cancelAtPeriodEnd: false,
  });
  // Старую подписку не удаляем и не отменяем: история платежей остаётся,
  // а «cancelled» выглядело бы как отказ владельца. Метрики её больше не
  // считают — у заведения теперь есть chainId.
  if (oldSub) {
    batch.set(firestore.collection("subscriptions").doc(tenantId), {
      status: "superseded", supersededByChainId: chainId, updatedAt: now,
    }, { merge: true });
  }
  // Как у новой точки сети: реальный тариф теперь в chains/{chainId}.
  batch.update(tenantRef, {
    chainId, status: "active", subscriptionStatus: "active", planId: "start", updatedAt: now,
  });
  await batch.commit();
  await syncCapabilities({ chainId }).catch((e) => console.error(`saas-gateway: возможности тарифа сети ${chainId}:`, e.message || e));

  // Весь персонал, не только владелец, должен видеть общую лояльность сети.
  await Promise.all(membersSnap.docs.map((d) => {
    const m = d.data();
    if (m.userId === uid || m.status !== "active") return null;
    return syncChainMembership(chainId, m.userId, m.role, m.status);
  }));

  // branding уже скопирован выше одним документом.
  for (const colName of CHAIN_SUBCOLLECTIONS) {
    if (colName === "branding") continue;
    await migrateCollectionDocs(firestore, tenantRef.collection(colName), chainRef.collection(colName));
  }

  await writeAuditLog({
    tenantId, actorId: uid, action: "tenantConvertedToChain", metadata: { chainId, slug },
  });

  provisionTenantDomain(slug).catch((e) => {
    console.error(`provisionTenantDomain(${slug}) не удался (перевод в сеть):`, e.message || e);
  });

  sendJson(res, 200, { chainId, slug });
}

/**
 * Приглашение по email во вкладке «Команда». uid по email находит только
 * Admin SDK. Роли owner/admin так не выдаются — как и в правилах.
 */
async function handleInviteTenantMember(req, res) {
  const decoded = await verifyAuth(req);
  const uid = decoded.uid;
  const body = await parseJsonBody(req);
  const { tenantId, email: rawEmail, role } = body;
  if (typeof tenantId !== "string" || !tenantId.trim()) {
    throw new HttpError(400, "Не указано заведение");
  }
  if (!["manager", "employee"].includes(role)) {
    throw new HttpError(400, "Роль должна быть «Менеджер» или «Сотрудник»");
  }
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) throw new HttpError(400, "Укажите email приглашаемого");

  await requireTenantRole(tenantId, uid, ["owner", "admin"]);

  let invitedUser;
  try {
    invitedUser = await getFirebaseApp().auth().getUserByEmail(email);
  } catch (_) {
    throw new HttpError(
      404,
      "Пользователь с таким email ещё не регистрировался в консоли — попросите его сначала создать аккаунт, а потом пригласите ещё раз"
    );
  }

  const firestore = db();
  const memberRef = firestore.collection("tenantMembers").doc(`${tenantId}_${invitedUser.uid}`);
  const existing = await memberRef.get();
  if (existing.exists && existing.data().status === "active") {
    throw new HttpError(409, "Этот человек уже состоит в заведении");
  }
  await memberRef.set({
    tenantId,
    userId: invitedUser.uid,
    email,
    role,
    status: "active",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const tenantSnap = await firestore.collection("tenants").doc(tenantId).get();
  const chainId = tenantSnap.exists ? tenantSnap.data().chainId : null;
  if (chainId) await syncChainMembership(chainId, invitedUser.uid, role, "active");
  await writeAuditLog({ tenantId, actorId: uid, action: "memberInvited", metadata: { email, role } });

  sendJson(res, 200, { ok: true, userId: invitedUser.uid });
}

/** Переносит документы коллекции вместе с вложенными коллекциями
 *  (например, clients/{uid}/visits) и удаляет исходные. Пачками по 400 —
 *  лимит batch в Firestore 500 операций. */
async function migrateCollectionDocs(firestore, srcCol, destCol) {
  const snap = await srcCol.get();
  if (snap.empty) return;
  const BATCH_CHUNK = 400;
  for (let i = 0; i < snap.docs.length; i += BATCH_CHUNK) {
    const chunk = snap.docs.slice(i, i + BATCH_CHUNK);
    const writeBatch = firestore.batch();
    chunk.forEach((d) => writeBatch.set(destCol.doc(d.id), d.data()));
    await writeBatch.commit();
  }
  for (const d of snap.docs) {
    for (const sub of await d.ref.listCollections()) {
      await migrateCollectionDocs(firestore, sub, destCol.doc(d.id).collection(sub.id));
    }
  }
  for (let i = 0; i < snap.docs.length; i += BATCH_CHUNK) {
    const chunk = snap.docs.slice(i, i + BATCH_CHUNK);
    const deleteBatch = firestore.batch();
    chunk.forEach((d) => deleteBatch.delete(d.ref));
    await deleteBatch.commit();
  }
}

// ------------------------------------------- provisionTenantDomain

/**
 * Сертификат Let's Encrypt и server-блок nginx для {slug}.zalpos.ru.
 * Wildcard не подходит: у регистратора нет API для DNS-01, продлевать
 * пришлось бы руками. HTTP-01 на каждый поддомен продлевает обычный таймер
 * certbot. Нужны скрипт /usr/local/bin/provision-tenant-domain.sh и
 * sudo-правило на него (saas/README.md, «Веб-версия гостя и QR стола»).
 */
async function provisionTenantDomain(slug) {
  await new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/sudo",
      ["/usr/local/bin/provision-tenant-domain.sh", slug],
      { timeout: 60000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
        } else {
          console.log(`provisionTenantDomain(${slug}): ${stdout.trim()}`);
          resolve();
        }
      },
    );
  });
}

// ------------------------------------------------- chain location payment

/**
 * Сколько стоит новая точка сети прямо сейчас. Подписка сети оплачена
 * вперёд за точки, что были на момент оплаты, — за новую доплачивают
 * цену доп. точки за дни, оставшиеся до конца оплаченного периода; со
 * следующего продления она входит в цену тарифа (chainPriceForPeriod
 * считает точки). Пробный период, сеть без точек и последний день периода
 * — бесплатно. Просрочка — сначала оплатить сеть.
 */
async function chainLocationQuote(chainId) {
  const firestore = db();
  const [chainSnap, subSnap, locationCount] = await Promise.all([
    firestore.collection("chains").doc(chainId).get(),
    firestore.collection("subscriptions").doc(chainId).get(),
    countChainLocations(chainId),
  ]);
  if (!chainSnap.exists || chainSnap.data().status === "deleted") throw new HttpError(404, "Сеть заведений не найдена");
  const sub = subSnap.data() || {};
  const plan = (await firestore.collection("plans").doc(sub.planId || chainSnap.data().planId || "chain").get()).data() || {};
  const billingPeriod = normalizeBillingPeriod(sub.billingPeriod);
  const planId = sub.planId || chainSnap.data().planId || "chain";
  const monthlyAdditional = billingPrice(plan, sub, planId, (p) => additionalLocationPriceForPeriod(p, "monthly"));
  const base = { locationCount, monthlyAdditional, billingPeriod, planName: plan.name || null };
  if (chainSnap.data().demo === true) return { ...base, free: true, reason: "demo", amount: 0 };
  if (locationCount === 0) return { ...base, free: true, reason: "firstLocation", amount: 0 };
  if (sub.status === "trial") return { ...base, free: true, reason: "trial", amount: 0 };
  if (sub.status !== "active") {
    throw new HttpError(402, "Подписка сети не оплачена — сначала продлите её во вкладке «Оплата»");
  }
  const endMs = sub.currentPeriodEnd?.toMillis ? sub.currentPeriodEnd.toMillis() : 0;
  const remainingDays = Math.max(0, Math.ceil((endMs - Date.now()) / 86400000));
  const periodPrice = billingPrice(plan, sub, planId, (p) => additionalLocationPriceForPeriod(p, billingPeriod));
  const amount = Math.round((periodPrice / BILLING_PERIOD_DAYS[billingPeriod]) * remainingDays);
  if (amount < 1) return { ...base, free: true, reason: "periodEnds", amount: 0, remainingDays };
  return {
    ...base, free: false, amount, remainingDays,
    periodEnd: endMs ? new Date(endMs).toISOString() : null,
  };
}

async function handleChainLocationQuote(req, res) {
  const decoded = await verifyAuth(req);
  const { chainId } = await parseJsonBody(req);
  if (typeof chainId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(chainId)) throw new HttpError(400, "Не указана сеть");
  await requireChainRole(chainId, decoded.uid, ["owner", "admin"]);
  sendJson(res, 200, await chainLocationQuote(chainId));
}

/**
 * «Добавить точку сети»: бесплатно (см. chainLocationQuote) — точка сразу,
 * иначе ссылка на оплату; точку создаёт подтверждённая оплата
 * (applyChainLocationPayment).
 */
async function handleChainLocationCheckout(req, res) {
  const decoded = await verifyAuth(req);
  if (!decoded.email_verified) throw new HttpError(412, "Подтвердите email, прежде чем добавлять точку");
  const body = await parseJsonBody(req);
  const { chainId, name, returnUrl } = body;
  if (typeof chainId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(chainId)) throw new HttpError(400, "Не указана сеть");
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
    throw new HttpError(400, "Название точки: от 2 до 80 символов");
  }
  await requireChainRole(chainId, decoded.uid, ["owner", "admin"]);
  const slug = normalizeSlug(body.slug || name);
  const venueType = VENUE_TYPES.includes(body.venueType) ? body.venueType : "hookah";
  const firestore = db();
  await assertSlugFree(firestore, slug, "Этот код точки уже занят, выберите другой");
  const quote = await chainLocationQuote(chainId);
  if (quote.free) {
    const created = await createTenantRecords({ name: name.trim(), slug, chainId, uid: decoded.uid, email: decoded.email || null, venueType });
    sendJson(res, 200, { created: true, tenantId: created.tenantId, slug: created.slug });
    return;
  }
  if (typeof returnUrl !== "string" || !returnUrl) throw new HttpError(400, "Не передан адрес возврата после оплаты");
  const location = { name: name.trim(), slug, venueType };
  const email = decoded.email || await billingOwnerEmail(true, chainId);
  const description = `ZalPOS: новая точка сети «${location.name}» до конца оплаченного периода (${quote.remainingDays} дн.)`;
  const invoice = await createRobokassaInvoice({
    tenantId: null, chainId, planId: null, billingPeriod: quote.billingPeriod, purpose: "chainLocation",
    amount: quote.amount, email, returnUrl, requestedBy: decoded.uid, recurring: false, location,
  });
  const url = robokassaPaymentUrl({
    invId: invoice.invId, outSum: invoice.outSum, description, email, recurring: false,
    receipt: robokassaReceipt(description, quote.amount),
  });
  sendJson(res, 200, { confirmationUrl: url, paymentId: String(invoice.invId), amount: quote.amount });
}

/**
 * Оплата новой точки сети подтверждена — создаём точку. Повторное
 * уведомление о той же оплате точку второй раз не создаст: событие
 * billingEvents/{eventId} и отметка createdTenantId в счёте.
 */
async function applyChainLocationPayment({ eventId, provider, chainId, amount, location, requestedBy, test = false, invRef = null }) {
  const firestore = db();
  const eventRef = firestore.collection("billingEvents").doc(eventId);
  const already = await firestore.runTransaction(async (tx) => {
    const seen = await tx.get(eventRef);
    if (seen.exists && seen.data().applied !== false) return true;
    tx.set(eventRef, {
      tenantId: null, chainId, planId: null, billingPeriod: null, status: "succeeded", provider,
      amount, purpose: "chainLocation", test: test === true,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(), applied: false,
    });
    return false;
  });
  if (already) return;
  let tenantId = invRef ? ((await invRef.get()).data()?.createdTenantId || null) : null;
  const chain = (await firestore.collection("chains").doc(chainId).get()).data();
  if (!tenantId && chain && chain.status !== "deleted" && location?.name && requestedBy) {
    let email = null;
    try { email = (await admin.auth().getUser(requestedBy)).email || null; } catch (_) {}
    const baseSlug = normalizeSlug(location.slug || location.name);
    // Код могли занять, пока шла оплата, — тогда с хвостом.
    for (let attempt = 0; attempt < 5 && !tenantId; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug.slice(0, 56)}-${crypto.randomInt(1000, 9999)}`;
      try {
        const created = await createTenantRecords({
          name: String(location.name).slice(0, 80), slug, chainId, uid: requestedBy, email,
          venueType: VENUE_TYPES.includes(location.venueType) ? location.venueType : "hookah",
        });
        tenantId = created.tenantId;
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 409)) throw e;
      }
    }
    if (invRef && tenantId) await invRef.set({ createdTenantId: tenantId }, { merge: true });
  }
  await eventRef.set({ applied: true, tenantId }, { merge: true });
  await writeAuditLog({
    tenantId, actorId: requestedBy || null,
    action: tenantId ? "chainLocationPaid" : "chainLocationPaymentUnapplied",
    metadata: { chainId, eventId, amount, ...(test ? { test: true } : {}) },
  });
}

// ------------------------------------------------- setBillingEventTest

/**
 * Супер-админ отмечает оплату тестовой (или снимает отметку): проверочные
 * оплаты до запуска не должны попадать в выручку и MRR панели. Если этим
 * платежом оплачена текущая подписка — отметка и у заведения (сети).
 */
async function handleSetBillingEventTest(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { eventId, test } = await parseJsonBody(req);
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(eventId)) throw new HttpError(400, "Не указан платёж");
  const firestore = db();
  const ref = firestore.collection("billingEvents").doc(eventId);
  const ev = (await ref.get()).data();
  if (!ev) throw new HttpError(404, "Платёж не найден");
  const flag = test === true;
  await ref.set({ test: flag, testMarkedBy: decoded.uid, testMarkedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const billingId = ev.chainId || ev.tenantId;
  if (billingId && ev.status === "succeeded") {
    const sub = (await firestore.collection("subscriptions").doc(billingId).get()).data();
    if (sub?.externalSubscriptionId === eventId) {
      await firestore.collection(ev.chainId ? "chains" : "tenants").doc(billingId).set({ testPayment: flag }, { merge: true });
    }
  }
  await writeAuditLog({ tenantId: ev.tenantId || null, actorId: decoded.uid, action: flag ? "billingMarkedTest" : "billingMarkedReal", metadata: { eventId } });
  sendJson(res, 200, { ok: true });
}

// ----------------------------------------------------- createBuildJob

async function githubDispatchBuild({ tenantId, jobIdPos, jobIdKolibri, jobIdPosWindows, appLabel, logoUrl, tenantSlug, inviteCode, chainSlug }) {
  const token = process.env.GITHUB_PAT;
  if (!token) throw new Error("GITHUB_PAT не настроен на сервере");
  // Один запуск workflow, три job_id: касса и гость под Android, касса под
  // Windows. Каждая сборка отчитывается в свой buildJobs-документ.
  // Без job_id_kolibri workflow не собирает приложение гостя (нет в тарифе).
  const inputs = {
    tenant_id: tenantId, job_id_pos: jobIdPos,
    job_id_pos_windows: jobIdPosWindows, app_label: appLabel,
  };
  if (jobIdKolibri) inputs.job_id_kolibri = jobIdKolibri;
  if (logoUrl) inputs.logo_url = logoUrl;
  if (tenantSlug) inputs.tenant_slug = tenantSlug;
  if (inviteCode) inputs.invite_code = inviteCode;
  if (chainSlug) inputs.chain_slug = chainSlug;
  const dispatch = (withInputs) => fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_SAAS_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: GITHUB_REF, inputs: withInputs }),
    }
  );
  let res = await dispatch(inputs);
  let text = res.ok ? "" : await res.text().catch(() => "");
  // Workflow в ветке GITHUB_REF старше сетей и не знает chain_slug — без
  // него кассы всё равно соберутся, а приложение гостя будет точки.
  if (res.status === 422 && inputs.chain_slug && /chain_slug/.test(text)) {
    console.error("saas-gateway: workflow сборки не знает chain_slug — собираем без него");
    const { chain_slug: _, ...rest } = inputs;
    res = await dispatch(rest);
    text = res.ok ? "" : await res.text().catch(() => "");
  }
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${text}`);
}

async function handleCreateBuildJob(req, res) {
  const decoded = await verifyAuth(req);
  const body = await parseJsonBody(req);
  const { tenantId } = body;
  // Формат — до любых проверок: tenantId уходит в параметры сборки в CI.
  if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new HttpError(400, "Не указано заведение");
  // Супер-админ может пересобрать приложения любого заведения из панели.
  if (!(await isSuperAdmin(decoded))) {
    await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);
  }
  sendJson(res, 200, await startTenantBuild(tenantId, { requestedBy: decoded.uid }));
}

/**
 * Сборка всех приложений заведения: по кнопке «Собрать APK» и при
 * автообновлении (runAppRolloutTick, rolloutSha — коммит, ради которого
 * собираем). Права проверяет вызывающий.
 */
async function startTenantBuild(tenantId, { requestedBy, rolloutSha = null }) {
  const firestore = db();
  // У точки сети подписка общая — subscriptions/{chainId}.
  const tenantDoc = await firestore.collection("tenants").doc(tenantId).get();
  const chainId = tenantDoc.exists ? tenantDoc.data().chainId || null : null;
  const sub = await firestore.collection("subscriptions").doc(chainId || tenantId).get();
  if (!sub.exists || !["trial", "active"].includes(sub.data().status)) {
    throw new HttpError(412, "Подписка неактивна — сборка APK недоступна");
  }

  // Одна незавершённая сборка на заведение: повторные нажатия иначе
  // запускают параллельные сборки и тратят минуты Actions.
  const pending = await firestore
    .collection("buildJobs")
    .where("tenantId", "==", tenantId)
    .where("status", "==", "queued")
    .get();
  // Сборку, которая не отчиталась за APP_ROLLOUT_STALE_MS (отменили в
  // GitHub, пропал раннер), закрываем — иначе заведение больше не соберётся.
  const isStale = (d) => {
    const at = d.data().createdAt;
    return at && typeof at.toMillis === "function" && Date.now() - at.toMillis() > APP_ROLLOUT_STALE_MS;
  };
  if (pending.docs.some((d) => !isStale(d))) {
    throw new HttpError(409, "Сборка уже запущена — дождитесь её завершения, прежде чем запускать новую");
  }
  for (const d of pending.docs) {
    await d.ref.update({
      status: "failed",
      rolloutSha: null,
      errorMessage: "Сборка не отчиталась вовремя — запущена заново",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Три приложения — три записи buildJobs, у каждой своя ссылка «Скачать».
  // Приложение гостя — только если оно есть в тарифе заведения.
  const caps = await syncTenantCapabilities(tenantDoc).catch(() => null);
  const withGuest = !caps || caps.guestApp !== false;
  const firestoreNow = admin.firestore.FieldValue.serverTimestamp();
  const jobRefPos = firestore.collection("buildJobs").doc();
  const jobRefKolibri = withGuest ? firestore.collection("buildJobs").doc() : null;
  const jobRefPosWindows = firestore.collection("buildJobs").doc();
  const jobIdPos = jobRefPos.id;
  const jobIdKolibri = jobRefKolibri ? jobRefKolibri.id : "";
  const jobIdPosWindows = jobRefPosWindows.id;
  const baseJob = {
    tenantId,
    status: "queued",
    requestedBy,
    createdAt: firestoreNow,
    completedAt: null,
    downloadPath: null,
    runUrl: null,
    errorMessage: null,
    rolloutSha,
  };
  const createBatch = firestore.batch();
  createBatch.set(jobRefPos, { ...baseJob, type: "pos", platform: "android" });
  if (jobRefKolibri) createBatch.set(jobRefKolibri, { ...baseJob, type: "guest", platform: "android" });
  createBatch.set(jobRefPosWindows, { ...baseJob, type: "pos", platform: "windows" });
  await createBatch.commit();

  // Название и логотип нужны только гостевому приложению: касса всегда
  // «ZalPOS». appName, а не shortName: shortName — снимок имени при
  // создании, обрезанный до 12 символов.
  let appLabel = (tenantDoc.exists && String(tenantDoc.data().name || "").trim()) || "Меню заведения";
  let logoUrl = "";
  try {
    const branding = await firestore.collection("tenants").doc(tenantId).collection("branding").doc("config").get();
    if (branding.exists) {
      const saved = [branding.data().appName, branding.data().shortName]
        .map((v) => String(v || "").trim())
        .find((v) => v && !["Hookah POS", "Hoocah POS", "HookahPOS", "ZalPOS"].includes(v));
      appLabel = saved || appLabel;
      logoUrl = branding.data().logoUrl || "";
    }
  } catch (_) {
    // Не критично: соберём с названием заведения и стандартной иконкой.
  }

  // Код заведения и приглашения зашиваются в кассу, чтобы она сама
  // присоединилась к заведению при первом запуске. Не прочитали — соберём
  // без автопривязки.
  const tenantSlug = tenantDoc.data()?.slug || "";
  let inviteCode = "";
  try {
    const inviteDoc = await firestore.collection("tenants").doc(tenantId).collection("settings").doc("deviceInvite").get();
    inviteCode = inviteDoc.data()?.code || "";
  } catch (_) {
    // сборка пойдёт без автопривязки
  }

  // Точка сети: приложение гостя общее на сеть — с выбором заведения при
  // запуске, названием и логотипом сети.
  let chainSlug = "";
  if (chainId) {
    try {
      const chainDoc = await firestore.collection("chains").doc(chainId).get();
      chainSlug = chainDoc.data()?.slug || "";
      const chainBranding = (await firestore.collection("chains").doc(chainId).collection("branding").doc("config").get()).data() || {};
      const chainName = [chainBranding.appName, chainDoc.data()?.name]
        .map((v) => String(v || "").trim())
        .find((v) => v && !["ZalPOS", "Hookah POS", "HookahPOS"].includes(v));
      if (chainName) appLabel = chainName;
      if (chainBranding.logoUrl) logoUrl = chainBranding.logoUrl;
    } catch (_) {
      // Без сети в сборке приложение гостя будет только этой точки.
    }
  }

  try {
    await githubDispatchBuild({ tenantId, jobIdPos, jobIdKolibri, jobIdPosWindows, appLabel, logoUrl, tenantSlug, inviteCode, chainSlug });
  } catch (e) {
    const failUpdate = {
      status: "failed",
      errorMessage: String(e),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await Promise.all([jobRefPos, jobRefKolibri, jobRefPosWindows].filter(Boolean).map((r) => r.update(failUpdate)));
    throw new HttpError(500, "Не удалось запустить сборку в GitHub Actions — см. записи в buildJobs");
  }

  // По этой отметке автообновление решает, кого пересобирать. Ручная
  // сборка берёт свежую ветку, то есть уже содержит текущий коммит.
  let sha = rolloutSha;
  if (!sha) {
    sha = (await firestore.collection("platformStatus").doc("appRollout").get().catch(() => null))?.data()?.sha || "manual";
  }
  await firestore.collection("tenants").doc(tenantId)
    .set({ appBuild: { sha, at: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });

  await writeAuditLog({
    tenantId,
    actorId: requestedBy,
    action: rolloutSha ? "buildJobAutoUpdate" : "buildJobRequested",
    metadata: { jobIdPos, jobIdKolibri, ...(rolloutSha ? { sha: rolloutSha } : {}) },
  });
  return { jobIdPos, jobIdKolibri };
}

// -------------------------------------------- cancelSubscription/resume

/**
 * Владелец сам выключает или возвращает автопродление. Доступ не
 * отключается: заведение работает до конца оплаченного периода, просто
 * без списания. Клиенту писать в subscriptions правила не дают.
 */
async function handleSetSubscriptionCancel(req, res, cancel) {
  const decoded = await verifyAuth(req);
  const body = await parseJsonBody(req);
  const { tenantId, chainId, reason } = body;
  const isChain = typeof chainId === "string" && !!chainId;
  if (!isChain && (typeof tenantId !== "string" || !tenantId)) {
    throw new HttpError(400, "Не указано заведение");
  }
  const billingId = isChain ? chainId : tenantId;
  if (isChain) {
    await requireChainRole(chainId, decoded.uid, ["owner", "admin"]);
  } else {
    await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);
  }

  const subRef = db().collection("subscriptions").doc(billingId);
  const subDoc = await subRef.get();
  if (!subDoc.exists) throw new HttpError(404, "Подписка не найдена");
  // Причина отмены видна супер-админу в карточке заведения. При возврате
  // автопродления стираем её.
  const cancelReason = cancel ? String(reason || "").slice(0, 500) : null;
  // Без родительского платежа Робокассы (оплатили без согласия на
  // автосписание) списывать нечего — так и говорим.
  const sub = subDoc.data() || {};
  if (!cancel && sub.provider === "robokassa" && !sub.robokassaParentInvId) {
    throw new HttpError(409, "Автопродление включается при оплате: во вкладке «Тарифы» отметьте «Автопродление» и оплатите следующий период");
  }
  await subRef.update({ cancelAtPeriodEnd: cancel, cancelReason });
  await writeAuditLog({
    tenantId: isChain ? null : tenantId,
    actorId: decoded.uid,
    action: cancel ? "subscriptionCancelRequested" : "subscriptionCancelWithdrawn",
    metadata: cancel ? { reason: cancelReason, chainId: isChain ? chainId : null } : { chainId: isChain ? chainId : null },
  });
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- billing

// Секреты платёжных систем — переменные окружения (README.md, setup.sh).
const BILLING_PERIOD_DAYS = { monthly: 30, semiannual: 182, yearly: 365 };
const GRACE_PERIOD_DAYS = 10;

/** «1 точка», «2 точки», «5 точек» — для описания платежа сети. */
function pointsWord(n) {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return "точка";
  if (!teen && last >= 2 && last <= 4) return "точки";
  return "точек";
}

function normalizeBillingPeriod(raw) {
  if (raw === "yearly") return "yearly";
  if (raw === "semiannual") return "semiannual";
  return "monthly";
}

/** Цена тарифа за период; 0 — на этот период тариф не продаётся. */
function planPriceForPeriod(plan, billingPeriod) {
  if (billingPeriod === "yearly") return Number(plan.priceRubYearly) || 0;
  if (billingPeriod === "semiannual") return Number(plan.priceRubSemiannual) || 0;
  return Number(plan.priceRub) || 0;
}

/**
 * Цена каждой следующей точки сети. Пока в тарифе не включён флажок
 * «Своя цена за доп. точку» (customAdditionalPrice), она равна цене первой.
 * Смотреть на 0 в полях нельзя: форма тарифа сохраняет пустое поле как 0.
 */
function additionalLocationPriceForPeriod(plan, billingPeriod) {
  if (!plan.customAdditionalPrice) return planPriceForPeriod(plan, billingPeriod);
  const field = billingPeriod === "yearly" ? "priceRubAdditionalYearly"
    : billingPeriod === "semiannual" ? "priceRubAdditionalSemiannual"
    : "priceRubAdditional";
  return Number(plan[field]) || 0;
}

/** Первая точка по цене тарифа, остальные — по цене доп. точки. */
function chainPriceForPeriod(plan, billingPeriod, locationCount) {
  const first = planPriceForPeriod(plan, billingPeriod);
  const additional = additionalLocationPriceForPeriod(plan, billingPeriod);
  const extra = Math.max(0, locationCount - 1);
  return first + additional * extra;
}

/**
 * Повышение цен по оферте действует через 30 дней после уведомления:
 * подписчику, который уже платит, до subscriptions.priceLock.until цена
 * считается по прежним ценам тарифа, если они ниже новых. Блокировку
 * ставит «Применить рекомендованную сетку» (handleApplyPlanCatalog).
 */
const PRICE_LOCK_FIELDS = [
  "priceRub", "priceRubSemiannual", "priceRubYearly",
  "priceRubAdditional", "priceRubAdditionalSemiannual", "priceRubAdditionalYearly", "customAdditionalPrice",
];
const PRICE_LOCK_DAYS = 30;
function billingPrice(plan, sub, planId, compute) {
  const now = compute(plan);
  const lock = sub && sub.priceLock;
  const until = lock && lock.until && typeof lock.until.toMillis === "function" ? lock.until.toMillis() : 0;
  if (!lock || until <= Date.now() || lock.planId !== planId || !lock.prices) return now;
  const was = compute({ ...plan, ...lock.prices });
  return was > 0 && was < now ? was : now;
}

/** E-mail владельца заведения/сети — для чека автопродления. */
async function billingOwnerEmail(isChain, id) {
  const doc = await db().collection(isChain ? "chains" : "tenants").doc(id).get();
  const uid = doc.data()?.ownerUserId;
  if (!uid) return null;
  try {
    return (await admin.auth().getUser(uid)).email || null;
  } catch (_) {
    return null;
  }
}

/** Число действующих точек сети. Сеть платит за каждую точку, поэтому
 *  считаем заново при оплате и при каждом продлении. */
async function countChainLocations(chainId) {
  const snap = await db().collection("tenants").where("chainId", "==", chainId).get();
  return snap.docs.filter((d) => d.data().status !== "deleted").length;
}

/** Тариф, период, цена и email для чека — общее для оплаты картой и по
 *  счёту. Платить может только владелец или администратор. Статус
 *  подписки здесь не меняется: это делает только подтверждённая оплата. */
async function resolveSubscriptionCheckout(decoded, { tenantId, chainId, planId, billingPeriod: rawBillingPeriod }) {
  const isChain = typeof chainId === "string" && !!chainId;
  if (!isChain && (typeof tenantId !== "string" || !tenantId)) {
    throw new HttpError(400, "Не указано заведение");
  }
  if (typeof planId !== "string" || !planId) throw new HttpError(400, "Не указан тариф");
  const billingPeriod = normalizeBillingPeriod(rawBillingPeriod);
  if (isChain) {
    await requireChainRole(chainId, decoded.uid, ["owner", "admin"]);
  } else {
    await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);
  }

  const planDoc = await db().collection("plans").doc(planId).get();
  if (!planDoc.exists) throw new HttpError(404, "Тариф не найден");
  const plan = planDoc.data();
  if (!!plan.isChainPlan !== isChain) {
    throw new HttpError(412, isChain ? "Сети подходит только тариф сети" : "Тариф сети — только для сети заведений");
  }
  // Архивный тариф не продаётся — продлить можно только тот, на котором уже есть.
  if (plan.archived === true) {
    const cur = (await db().collection("subscriptions").doc(isChain ? chainId : tenantId).get()).data();
    if (!cur || cur.planId !== planId) throw new HttpError(412, "Этот тариф больше не продаётся — выберите другой");
  }
  if (planPriceForPeriod(plan, billingPeriod) <= 0) {
    throw new HttpError(412, billingPeriod === "monthly"
      ? "Этот тариф не продаётся напрямую — свяжитесь с поддержкой платформы"
      : "Для этого тарифа не задана цена на выбранный период — оформите помесячную оплату или обратитесь в поддержку");
  }
  const locationCount = isChain ? Math.max(1, await countChainLocations(chainId)) : 1;
  const currentSub = (await db().collection("subscriptions").doc(isChain ? chainId : tenantId).get()).data() || null;
  const price = billingPrice(plan, currentSub, planId, (p) => (isChain ? chainPriceForPeriod(p, billingPeriod, locationCount) : planPriceForPeriod(p, billingPeriod)));
  const periodLabel = { monthly: "месяц", semiannual: "полгода", yearly: "год" }[billingPeriod];
  const email = decoded.email || await billingOwnerEmail(isChain, isChain ? chainId : tenantId);
  return {
    isChain, tenantId: isChain ? null : tenantId, chainId: isChain ? chainId : null,
    planId, plan, billingPeriod, locationCount, price, periodLabel, email,
  };
}

async function handleCreateCheckoutSession(req, res) {
  const decoded = await verifyAuth(req);
  const body = await parseJsonBody(req);
  const { returnUrl, autoRenew } = body;
  if (typeof returnUrl !== "string" || !returnUrl) {
    throw new HttpError(400, "Не передан адрес возврата после оплаты");
  }
  const { isChain, planId, plan, billingPeriod, locationCount, price, periodLabel, email } =
    await resolveSubscriptionCheckout(decoded, body);
  const tenantId = body.tenantId;
  const chainId = body.chainId;

  // Автосписание только с явного согласия (галочка «Автопродление»,
  // по умолчанию снята) — правила Робокассы и ст. 16 закона № 2300-1.
  const recurring = robokassaConfig().recurring && autoRenew === true;
  const invoice = await createRobokassaInvoice({
    tenantId: isChain ? null : tenantId, chainId: isChain ? chainId : null,
    planId, billingPeriod, purpose: "subscription", amount: price, email, returnUrl,
    locationCount: isChain ? locationCount : null, requestedBy: decoded.uid, recurring,
    // Картой платят как физлицо: чек в «Мой налог» без ИНН покупателя.
    payerType: "individual",
  });
  const url = robokassaPaymentUrl({
    invId: invoice.invId, outSum: invoice.outSum,
    description: `ZalPOS: тариф «${plan.name || planId}», ${periodLabel}`,
    email, recurring,
    // С включёнными «Робочеками» платёж без чека Робокасса отклонит —
    // автопродление чек уже передаёт, первая оплата тоже должна.
    receipt: robokassaReceipt(`Подписка ZalPOS: тариф «${plan.name || planId}», ${periodLabel}`, price),
  });
  sendJson(res, 200, { confirmationUrl: url, paymentId: String(invoice.invId) });
}

// ---------------------------------------------- счета для ИП и организаций

/**
 * Владелец платформы на НПД: Робокасса принимает карты физлиц и выбивает
 * чек без ИНН, а при расчётах с ИП и организациями ИНН покупателя в чеке
 * обязателен (ст. 14 422-ФЗ, ставка 6 %). Поэтому они платят переводом по
 * счёту, а чек с ИНН владелец платформы делает в «Мой налог» сам — до
 * 9-го числа следующего месяца.
 *
 *  createBankInvoice — реквизиты плательщика сначала в базу в РФ
 *    (pii-gateway), потом bankInvoices/{номер};
 *  markBankInvoicePaid — супер-админ отмечает поступление, подписка
 *    продлевается (идемпотентно);
 *  markBankInvoiceReceipt — чек с ИНН выбит, ссылка видна владельцу;
 *  cancelBankInvoice — отмена неоплаченного счёта.
 */
// pii-gateway на этом же сервере; если локально не отвечает — через домен.
const PII_GATEWAY_URLS = process.env.PII_GATEWAY_URL
  ? [process.env.PII_GATEWAY_URL]
  : ["http://127.0.0.1:8080/", "https://pii.zalpos.ru/"];

/** Контрольные цифры ИНН: 10 знаков — организация, 12 — ИП/физлицо. */
function innValid(inn) {
  if (!/^(\d{10}|\d{12})$/.test(inn)) return false;
  const d = inn.split("").map(Number);
  const check = (weights) => (weights.reduce((sum, w, i) => sum + w * d[i], 0) % 11) % 10;
  if (d.length === 10) return check([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  return check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10]
    && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
}

/** Реквизиты плательщика из запроса: { type: "ip"|"org", name, inn, kpp }. */
function parsePayer(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const type = p.type === "org" ? "org" : p.type === "ip" ? "ip" : null;
  if (!type) throw new HttpError(400, "Укажите, кто платит: ИП или организация");
  const name = String(p.name || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (name.length < 3) {
    throw new HttpError(400, type === "ip" ? "Укажите ФИО индивидуального предпринимателя" : "Укажите название организации");
  }
  const inn = String(p.inn || "").replace(/\D/g, "");
  if ((type === "ip" && inn.length !== 12) || (type === "org" && inn.length !== 10) || !innValid(inn)) {
    throw new HttpError(400, type === "ip"
      ? "ИНН индивидуального предпринимателя — 12 цифр; проверьте, в номере ошибка"
      : "ИНН организации — 10 цифр; проверьте, в номере ошибка");
  }
  const kpp = type === "org" ? String(p.kpp || "").replace(/\s/g, "").toUpperCase() : "";
  if (kpp && !/^\d{4}[\dA-Z]{2}\d{3}$/.test(kpp)) throw new HttpError(400, "КПП — 9 знаков");
  return { type, name, inn, kpp };
}

/** Реквизиты — в базу в РФ токеном владельца, до записи счёта. */
async function recordPayerInRussia(req, payload) {
  const auth = String(req.headers["authorization"] || "");
  let resp = null;
  for (const url of PII_GATEWAY_URLS) {
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ kind: "payer", ...payload }),
        signal: AbortSignal.timeout(15000),
      });
      break;
    } catch (_) { /* следующий адрес */ }
  }
  if (!resp) throw new HttpError(503, "Сервер данных в РФ недоступен — попробуйте через минуту");
  if (!resp.ok) {
    let msg = "";
    try { msg = (await resp.json()).error || ""; } catch (_) {}
    throw new HttpError(503, `Не удалось сохранить реквизиты плательщика: ${msg || resp.status}`);
  }
}

/** Свой счётчик номеров. Занятые пропускаем: если счётчик обнулят, новый
 *  счёт не наложится на старый и его событие оплаты bank_<номер>. */
async function nextBankInvoiceNumber() {
  const ref = db().collection("platformStatus").doc("bankInvoices");
  return db().runTransaction(async (tx) => {
    let next = (Number((await tx.get(ref)).data()?.lastNumber) || 0) + 1;
    while ((await tx.get(db().collection("bankInvoices").doc(String(next)))).exists) next += 1;
    tx.set(ref, { lastNumber: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return next;
  });
}

/** Срок чека с ИНН — 9-е число следующего месяца по Москве. */
function receiptDeadline(paidAtMs) {
  const msk = new Date(paidAtMs + 3 * 3600e3);
  return new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth() + 1, 9)).toISOString().slice(0, 10);
}

async function handleCreateBankInvoice(req, res) {
  const decoded = await verifyAuth(req);
  const body = await parseJsonBody(req);
  const payer = parsePayer(body.payer);
  const c = await resolveSubscriptionCheckout(decoded, body);
  const number = await nextBankInvoiceNumber();
  const id = String(number);
  await recordPayerInRussia(req, {
    invoiceId: id, billingId: c.chainId || c.tenantId,
    payerType: payer.type, name: payer.name, inn: payer.inn, kpp: payer.kpp,
  });
  // Точку сети запоминаем, чтобы счёт был виден в её кабинете; продлевается
  // всё равно подписка сети.
  let pointId = c.tenantId;
  if (c.isChain && typeof body.tenantId === "string" && body.tenantId) {
    const t = await db().collection("tenants").doc(body.tenantId).get();
    if (t.exists && t.data().chainId === c.chainId) pointId = body.tenantId;
  }
  const planName = c.plan.name || c.planId;
  const invoice = {
    number, tenantId: pointId, chainId: c.chainId, planId: c.planId, planName,
    billingPeriod: c.billingPeriod, periodLabel: c.periodLabel,
    locationCount: c.isChain ? c.locationCount : null,
    amount: c.price, email: c.email || null, payer,
    title: c.isChain
      ? `Право использования ZalPOS (подписка), тариф «${planName}», ${c.periodLabel}, сеть — ${c.locationCount} ${pointsWord(c.locationCount)}`
      : `Право использования ZalPOS (подписка), тариф «${planName}», ${c.periodLabel}`,
    status: "pending", requestedBy: decoded.uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db().collection("bankInvoices").doc(id).set(invoice);
  await writeAuditLog({
    tenantId: pointId, actorId: decoded.uid, action: "bankInvoiceCreated",
    metadata: { number, amount: c.price, chainId: c.chainId, payerType: payer.type },
  });
  sendJson(res, 200, { id, number, amount: c.price });
}

async function loadBankInvoice(id) {
  if (typeof id !== "string" || !/^\d{1,9}$/.test(id)) throw new HttpError(400, "Не указан счёт");
  const ref = db().collection("bankInvoices").doc(id);
  const inv = (await ref.get()).data();
  if (!inv) throw new HttpError(404, "Счёт не найден");
  return { ref, inv };
}

async function handleMarkBankInvoicePaid(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { id } = await parseJsonBody(req);
  const { ref, inv } = await loadBankInvoice(id);
  if (inv.status === "cancelled") throw new HttpError(409, "Счёт отменён");
  await applySubscriptionPayment({
    eventId: `bank_${id}`,
    provider: "bank",
    status: "succeeded",
    tenantId: inv.tenantId, chainId: inv.chainId, planId: inv.planId,
    billingPeriod: normalizeBillingPeriod(inv.billingPeriod),
    amount: Number(inv.amount) || 0,
    purpose: "subscription",
  });
  if (inv.status !== "paid") {
    const now = Date.now();
    await ref.set({
      status: "paid", paidAt: admin.firestore.FieldValue.serverTimestamp(),
      paidBy: decoded.uid, receiptDueDate: receiptDeadline(now),
    }, { merge: true });
    await writeAuditLog({ tenantId: inv.tenantId, actorId: decoded.uid, action: "bankInvoicePaid", metadata: { number: inv.number, amount: inv.amount } });
  }
  sendJson(res, 200, { ok: true });
}

async function handleMarkBankInvoiceReceipt(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { id, receiptUrl } = await parseJsonBody(req);
  const { ref, inv } = await loadBankInvoice(id);
  if (inv.status !== "paid") throw new HttpError(409, "Сначала отметьте, что счёт оплачен");
  const url = String(receiptUrl || "").trim();
  if (url && !/^https:\/\/lknpd\.nalog\.ru\/api\/v1\/receipt\/[\w/.-]+$/i.test(url)) {
    throw new HttpError(400, "Ссылка на чек — из «Мой налог» (https://lknpd.nalog.ru/api/v1/receipt/…)");
  }
  await ref.set({
    receiptIssuedAt: admin.firestore.FieldValue.serverTimestamp(),
    receiptUrl: url || null,
  }, { merge: true });
  sendJson(res, 200, { ok: true });
}

async function handleCancelBankInvoice(req, res) {
  const decoded = await verifyAuth(req);
  const { id } = await parseJsonBody(req);
  const { ref, inv } = await loadBankInvoice(id);
  if (!(await isSuperAdmin(decoded))) {
    if (inv.chainId) await requireChainRole(inv.chainId, decoded.uid, ["owner", "admin"]);
    else await requireTenantRole(inv.tenantId, decoded.uid, ["owner", "admin"]);
  }
  if (inv.status !== "pending") throw new HttpError(409, "Отменить можно только неоплаченный счёт");
  await ref.set({ status: "cancelled", cancelledAt: admin.firestore.FieldValue.serverTimestamp(), cancelledBy: decoded.uid }, { merge: true });
  sendJson(res, 200, { ok: true });
}

// -------------------------------------------------- billing (Робокасса)

/**
 * Чек в «Мой налог» Робокасса для самозанятого делает сама.
 *
 *  1. createCheckoutSession заводит billingInvoices/{InvId} (счётчик
 *     platformStatus/robokassa) и отдаёт ссылку на форму с подписью по
 *     паролю №1.
 *  2. Result URL (/robokassaResult) с подписью по паролю №2 — единственное
 *     место, где продлевается подписка; ответ «OK<InvId>».
 *  3. Success/Fail URL только возвращают в кабинет.
 *  4. Автопродление (ROBOKASSA_RECURRING=1): первая оплата с Recurring=true,
 *     её номер — robokassaParentInvId; продление — POST на
 *     Merchant/Recurring с PreviousInvoiceID, ответ на тот же Result URL.
 *
 * Переменные: ROBOKASSA_LOGIN, ROBOKASSA_PASSWORD1, ROBOKASSA_PASSWORD2,
 * ROBOKASSA_HASH (по умолчанию md5), ROBOKASSA_TEST=1, ROBOKASSA_RECURRING=1,
 * ROBOKASSA_RECEIPTS=1 + ROBOKASSA_SNO/ROBOKASSA_TAX (только для «Робочеков»).
 */
const ROBOKASSA_PAY_URL = "https://auth.robokassa.ru/Merchant/Index.aspx";
const ROBOKASSA_RECURRING_URL = "https://auth.robokassa.ru/Merchant/Recurring";
const ROBOKASSA_HASHES = ["md5", "sha1", "sha256", "sha384", "sha512"];

function robokassaConfig() {
  const login = String(process.env.ROBOKASSA_LOGIN || "").trim();
  const password1 = String(process.env.ROBOKASSA_PASSWORD1 || "");
  const password2 = String(process.env.ROBOKASSA_PASSWORD2 || "");
  if (!login || !password1 || !password2) {
    throw new Error("ROBOKASSA_LOGIN/ROBOKASSA_PASSWORD1/ROBOKASSA_PASSWORD2 не настроены на сервере");
  }
  const algo = String(process.env.ROBOKASSA_HASH || "md5").trim().toLowerCase();
  if (!ROBOKASSA_HASHES.includes(algo)) throw new Error(`ROBOKASSA_HASH: неизвестный алгоритм ${algo}`);
  return {
    login, password1, password2, algo,
    test: process.env.ROBOKASSA_TEST === "1",
    recurring: process.env.ROBOKASSA_RECURRING === "1",
  };
}

function robokassaHash(algo, str) {
  return crypto.createHash(algo).update(str, "utf8").digest("hex");
}

/** Shp_-параметры для подписи: «Shp_x=значение», по алфавиту. */
function robokassaShpPart(params) {
  const pairs = Object.keys(params).filter((k) => /^shp_/i.test(k)).sort().map((k) => `${k}=${params[k]}`);
  return pairs.length ? `:${pairs.join(":")}` : "";
}

/** Чек для «Робочеков» (54-ФЗ) — уже URL-кодированный, в этом виде он и
 *  входит в подпись. Самозанятым не нужен: null. */
function robokassaReceipt(name, price) {
  if (process.env.ROBOKASSA_RECEIPTS !== "1") return null;
  const receipt = {
    items: [{
      name: String(name).slice(0, 128), quantity: 1, sum: Number(price.toFixed(2)),
      payment_method: "full_payment", payment_object: "service",
      tax: process.env.ROBOKASSA_TAX || "none",
    }],
  };
  if (process.env.ROBOKASSA_SNO) receipt.sno = process.env.ROBOKASSA_SNO;
  return encodeURIComponent(JSON.stringify(receipt));
}

/** Следующий номер счёта (InvId — целое до 2^31). */
async function nextRobokassaInvId() {
  const ref = db().collection("platformStatus").doc("robokassa");
  return db().runTransaction(async (tx) => {
    const last = Number((await tx.get(ref)).data()?.lastInvId) || 100000;
    const next = last + 1;
    tx.set(ref, { lastInvId: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return next;
  });
}

/** Адрес возврата после оплаты — только в свой личный кабинет. */
const BILLING_RETURN_HOSTS = ["zalpos.ru", "www.zalpos.ru", "hookahpos.su", "saas-3bdc8.web.app", "saas-3bdc8.firebaseapp.com"];
function safeReturnUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    if (u.protocol === "https:" && BILLING_RETURN_HOSTS.includes(u.hostname)) return u.toString();
  } catch (_) {}
  return "https://zalpos.ru/#/";
}

async function createRobokassaInvoice({ tenantId, chainId, planId, billingPeriod, purpose, amount, email, returnUrl, locationCount = null, parentInvId = null, requestedBy = null, recurring = null, payerType = "individual", location = null }) {
  const invId = await nextRobokassaInvId();
  const outSum = amount.toFixed(2);
  await db().collection("billingInvoices").doc(String(invId)).set({
    provider: "robokassa", invId, tenantId, chainId, planId, billingPeriod, purpose,
    amount, outSum, email: email || null, returnUrl: safeReturnUrl(returnUrl),
    locationCount, parentInvId, requestedBy, recurring, payerType,
    // Новая точка сети (purpose chainLocation) создаётся после оплаты.
    ...(location ? { location } : {}),
    // Тестовый режим Робокассы (ROBOKASSA_TEST=1): деньги не списываются —
    // такую оплату панель платформы не считает выручкой.
    test: robokassaConfig().test === true,
    status: "pending", createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { invId, outSum };
}

/** Ссылка на платёжную форму. Подпись: MerchantLogin:OutSum:InvId[:Receipt]:Пароль№1. */
function robokassaPaymentUrl({ invId, outSum, description, email, recurring, receipt = null }) {
  const c = robokassaConfig();
  const sig = robokassaHash(c.algo, [c.login, outSum, String(invId), ...(receipt ? [receipt] : []), c.password1].join(":"));
  const params = new URLSearchParams({
    MerchantLogin: c.login,
    OutSum: outSum,
    InvId: String(invId),
    // Описание у Робокассы — до 100 символов.
    Description: String(description).slice(0, 100),
    SignatureValue: sig,
    Culture: "ru",
    Encoding: "utf-8",
  });
  if (email) params.set("Email", email);
  // URLSearchParams кодирует ещё раз: в ссылке Receipt закодирован дважды,
  // в подписи — один раз (так требует Робокасса).
  if (receipt) params.set("Receipt", receipt);
  if (recurring) params.set("Recurring", "true");
  if (c.test) params.set("IsTest", "1");
  return `${ROBOKASSA_PAY_URL}?${params.toString()}`;
}

/** Параметры запроса Робокассы: GET — из адреса, POST — из формы. */
async function readRobokassaParams(req) {
  const params = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
  if (req.method === "POST") {
    const raw = (await readRawBody(req, 64 * 1024)).toString("utf8");
    const type = String(req.headers["content-type"] || "");
    if (type.includes("application/json")) {
      try { Object.assign(params, JSON.parse(raw)); } catch (_) {}
    } else {
      Object.assign(params, Object.fromEntries(new URLSearchParams(raw)));
    }
  }
  return params;
}

function sendPlain(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

/**
 * Result URL Робокассы — оплата прошла. Подпись:
 * OutSum:InvId:Пароль№2[:Shp_…]. Ответ «OK<InvId>», иначе Робокасса
 * будет повторять уведомление.
 */
async function handleRobokassaResult(req, res) {
  const p = await readRobokassaParams(req);
  const outSum = String(p.OutSum || "");
  const invId = String(p.InvId || "");
  const given = String(p.SignatureValue || "").toLowerCase();
  if (!outSum || !/^\d{1,10}$/.test(invId) || !given) return sendPlain(res, 400, "bad request");
  const c = robokassaConfig();
  const expected = robokassaHash(c.algo, `${outSum}:${invId}:${c.password2}${robokassaShpPart(p)}`);
  if (!secretsEqual(given, expected)) return sendPlain(res, 400, "bad sign");

  db().collection("platformStatus").doc("billingWebhook").set({
    lastReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastEvent: "robokassa.result",
  }, { merge: true }).catch((e) => console.error("platformStatus/billingWebhook:", e.message || e));

  const invRef = db().collection("billingInvoices").doc(invId);
  const inv = (await invRef.get()).data();
  if (!inv) {
    // Подпись наша, а счёта нет — записываем и отвечаем OK, чтобы Робокасса
    // не повторяла уведомление, которое всё равно нечем применить.
    await writeAuditLog({ tenantId: null, actorId: null, action: "billingUnknownInvoice", metadata: { invId, outSum } });
    return sendPlain(res, 200, `OK${invId}`);
  }
  if (Math.abs(Number(outSum) - Number(inv.amount)) > 0.009) {
    await writeAuditLog({ tenantId: inv.tenantId, actorId: null, action: "billingAmountMismatch", metadata: { invId, outSum, expected: inv.amount } });
    return sendPlain(res, 200, `OK${invId}`);
  }

  if (inv.purpose === "chainLocation") {
    await applyChainLocationPayment({
      eventId: `robokassa_${invId}`, provider: "robokassa", chainId: inv.chainId,
      amount: Number(inv.amount) || 0, location: inv.location, requestedBy: inv.requestedBy,
      test: inv.test === true || String(p.IsTest || "") === "1", invRef,
    });
    await invRef.set({
      status: "paid", paidAt: admin.firestore.FieldValue.serverTimestamp(),
      paymentMethod: p.PaymentMethod || null, fee: p.Fee || null,
    }, { merge: true });
    return sendPlain(res, 200, `OK${invId}`);
  }

  // Первая оплата с Recurring=true — «родитель» будущих автосписаний.
  // recurring == null — счёт создан до галочки согласия (старая логика).
  const withConsent = inv.recurring == null ? c.recurring : inv.recurring === true;
  const parent = inv.parentInvId || (withConsent && inv.purpose === "subscription" ? Number(invId) : null);
  // Оплатил без галочки — прежнее согласие на автосписания больше не действует.
  const noAutoRenew = !parent && inv.purpose === "subscription" && inv.recurring === false;
  await applySubscriptionPayment({
    eventId: `robokassa_${invId}`,
    provider: "robokassa",
    status: "succeeded",
    tenantId: inv.tenantId, chainId: inv.chainId, planId: inv.planId,
    billingPeriod: normalizeBillingPeriod(inv.billingPeriod),
    amount: Number(inv.amount) || 0,
    purpose: inv.purpose || "subscription",
    test: inv.test === true || String(p.IsTest || "") === "1",
    extra: parent
      ? { robokassaParentInvId: parent, ...(inv.parentInvId ? {} : { autoRenewConsentAt: admin.firestore.FieldValue.serverTimestamp() }) }
      : noAutoRenew ? { robokassaParentInvId: null, cancelAtPeriodEnd: true } : {},
  });
  await invRef.set({
    status: "paid", paidAt: admin.firestore.FieldValue.serverTimestamp(),
    paymentMethod: p.PaymentMethod || null, fee: p.Fee || null,
  }, { merge: true });
  sendPlain(res, 200, `OK${invId}`);
}

/** Success/Fail URL — вернуть владельца в личный кабинет. Подписку здесь
 *  не трогаем: оплату подтверждает только Result URL. */
async function handleRobokassaReturn(req, res) {
  const p = await readRobokassaParams(req);
  const invId = String(p.InvId || "");
  let target = "https://zalpos.ru/#/";
  if (/^\d{1,10}$/.test(invId)) {
    const inv = (await db().collection("billingInvoices").doc(invId).get().catch(() => null))?.data();
    if (inv?.returnUrl) target = safeReturnUrl(inv.returnUrl);
  }
  res.writeHead(302, { Location: target });
  res.end();
}

/**
 * Один магазин Робокассы может принимать и подписки ZalPOS, и оплату гостей
 * заведения, а в «Технических настройках» у магазина один Result URL и один
 * Success/Fail URL. Поэтому любой из наших адресов принимает оба вида:
 * у платежа гостя есть Shp_t (заведение, входит в подпись), у подписки —
 * нет. Тело запроса читаем один раз и передаём обработчику как GET.
 */
function robokassaAsGet(req, p) {
  return { method: "GET", url: `/robokassa?${new URLSearchParams(p).toString()}`, headers: req.headers };
}

async function handleAnyRobokassaResult(req, res) {
  const p = await readRobokassaParams(req);
  const guest = Object.keys(p).some((k) => k.toLowerCase() === "shp_t");
  return guest ? guestPay.handleRobokassaResult(robokassaAsGet(req, p), res) : handleRobokassaResult(robokassaAsGet(req, p), res);
}

async function handleAnyRobokassaReturn(req, res) {
  const p = await readRobokassaParams(req);
  const guest = Object.keys(p).some((k) => k.toLowerCase() === "shp_t");
  return guest ? guestPay.handleDone(robokassaAsGet(req, p), res) : handleRobokassaReturn(robokassaAsGet(req, p), res);
}

/** Автосписание очередного периода по родительскому платежу. Возвращает
 *  номер нового счёта; результат придёт на Result URL. */
async function robokassaCharge({ sub, targetId, isChain, price, billingPeriod, description, locationCount }) {
  const c = robokassaConfig();
  if (c.test) throw new Error("у Робокассы нет тестового режима для автосписаний (ROBOKASSA_TEST=1)");
  const invoice = await createRobokassaInvoice({
    tenantId: isChain ? null : targetId, chainId: isChain ? targetId : null,
    planId: sub.planId, billingPeriod, purpose: "renewal", amount: price,
    email: await billingOwnerEmail(isChain, targetId), returnUrl: null,
    locationCount: isChain ? locationCount : null, parentInvId: sub.robokassaParentInvId,
  });
  const receipt = robokassaReceipt(description, price);
  const sig = robokassaHash(c.algo, [c.login, invoice.outSum, String(invoice.invId), ...(receipt ? [receipt] : []), c.password1].join(":"));
  const form = new URLSearchParams({
    MerchantLogin: c.login,
    InvoiceID: String(invoice.invId),
    PreviousInvoiceID: String(sub.robokassaParentInvId),
    OutSum: invoice.outSum,
    Description: String(description).slice(0, 100),
    SignatureValue: sig,
  });
  if (receipt) form.set("Receipt", receipt);
  const resp = await fetch(ROBOKASSA_RECURRING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = (await resp.text()).trim();
  if (!resp.ok || !/^OK/i.test(text)) throw new Error(`Робокасса не приняла автосписание: ${resp.status} ${text.slice(0, 200)}`);
  return invoice.invId;
}

/**
 * Зачисление оплаты подписки (handleRobokassaResult). Идемпотентно через
 * billingEvents/{eventId}: повторная доставка того же уведомления не
 * продлевает подписку дважды. [extra] — поля провайдера для автопродления
 * (robokassaParentInvId — родительский платёж Робокассы).
 */
async function applySubscriptionPayment({ eventId, provider, status, tenantId, chainId, planId, billingPeriod, amount, purpose, test = false, extra = {} }) {
  const billingId = chainId || tenantId;
  const paymentId = eventId;
  const firestore = db();
  const eventRef = firestore.collection("billingEvents").doc(paymentId);
  const alreadyProcessed = await firestore.runTransaction(async (tx) => {
    const seen = await tx.get(eventRef);
    // applied:false — прошлая доставка упала между записью события и
    // продлением подписки: применяем ещё раз. У старых записей поля нет —
    // они были обработаны целиком.
    if (seen.exists && seen.data().applied !== false) return true;
    tx.set(eventRef, {
      tenantId, chainId, planId, billingPeriod, status, provider,
      // Сумма — для выручки в панели платформы без запросов к провайдеру.
      amount,
      purpose,
      test: test === true,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      applied: false,
    });
    return false;
  });
  if (alreadyProcessed) return;

  if (status === "succeeded") {
    const periodDays = BILLING_PERIOD_DAYS[billingPeriod];
    const subRef = firestore.collection("subscriptions").doc(billingId);
    await firestore.runTransaction(async (tx) => {
      const cur = (await tx.get(subRef)).data() || {};
      // Оплата раньше срока (или автопродление за сутки до конца) не должна
      // съедать оставшиеся оплаченные/пробные дни: новый период — от конца
      // текущего, если он ещё не наступил.
      const now = Date.now();
      const ends = [now];
      if (cur.status === "active" && cur.currentPeriodEnd?.toMillis) ends.push(cur.currentPeriodEnd.toMillis());
      if (cur.status === "trial" && cur.trialEndsAt?.toMillis) ends.push(cur.trialEndsAt.toMillis());
      const base = Math.max(...ends);
      const update = {
        tenantId, chainId, planId, billingPeriod,
        status: "active",
        provider,
        externalSubscriptionId: paymentId,
        currentPeriodStart: admin.firestore.FieldValue.serverTimestamp(),
        currentPeriodEnd: admin.firestore.Timestamp.fromMillis(base + periodDays * 86400000),
        cancelAtPeriodEnd: false,
        // Иначе при СЛЕДУЮЩЕЙ просрочке остался бы старый pastDueSince
        // (markPastDue его не перезаписывает) — и данные заведения стёрлись
        // бы в ту же ночь, без льготных 10 дней.
        pastDueSince: null,
        renewalAttemptedAt: admin.firestore.FieldValue.delete(),
        ...extra,
      };
      // set+merge, а не update: не роняем уведомление 500-й ошибкой
      // (Робокасса будет его повторять), если документа почему-то ещё нет.
      tx.set(subRef, update, { merge: true });
    });
    await firestore.collection(chainId ? "chains" : "tenants").doc(billingId).set({
      status: "active",
      planId,
      // Подписка оплачена тестовым платежом — в MRR платформы не идёт.
      testPayment: test === true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await syncCapabilities(chainId ? { chainId } : { tenantId })
      .catch((e) => console.error(`saas-gateway: возможности тарифа ${billingId}:`, e.message || e));
    await writeAuditLog({ tenantId, actorId: null, action: "subscriptionPaid", metadata: { paymentId, planId, chainId, ...(test ? { test: true } : {}) } });
  } else {
    await writeAuditLog({ tenantId, actorId: null, action: "subscriptionPaymentCanceled", metadata: { paymentId, planId, chainId } });
  }
  await eventRef.update({ applied: true });
}

/** Подписку и заведение (или сеть) — в past_due. pastDueSince ставим
 *  только один раз, иначе повторный вызов отодвигал бы удаление данных. */
async function markPastDue(id, subRef, isChain = false) {
  const sub = (await subRef.get()).data();
  const update = { status: "past_due" };
  if (!sub?.pastDueSince) update.pastDueSince = admin.firestore.FieldValue.serverTimestamp();
  await subRef.set(update, { merge: true });
  await db().collection(isChain ? "chains" : "tenants").doc(id).set({
    status: "past_due",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

/** Удаляет данные заведения после льготного периода. Сам документ
 *  заведения (status: deleted) и подписка (cancelled) остаются для истории,
 *  в отличие от демо. skipSubscription — для точки сети: своей подписки у
 *  неё нет, подписку сети отменяет purgeChainData. */
async function purgeTenantData(tenantId, { skipSubscription = false } = {}) {
  const firestore = db();
  const tenantRef = firestore.collection("tenants").doc(tenantId);

  for (const name of TENANT_SUBCOLLECTIONS) {
    await firestore.recursiveDelete(tenantRef.collection(name));
  }

  const members = await firestore.collection("tenantMembers").where("tenantId", "==", tenantId).get();
  if (!members.empty) {
    const batch = firestore.batch();
    members.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  await tenantRef.set({ status: "deleted", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await removeTenantUploads(tenantId);
  if (!skipSubscription) {
    await firestore.collection("subscriptions").doc(tenantId).set({ status: "cancelled" }, { merge: true });
  }
  await writeAuditLog({
    tenantId, actorId: null, action: "tenantDataPurged",
    metadata: { reason: "grace_period_expired", graceDays: GRACE_PERIOD_DAYS },
  });
}

// Коллекции сети верхнего уровня (chains/{chainId}/...) — аналог
// TENANT_SUBCOLLECTIONS, но для общей лояльности сети (см. saas/firestore.rules).
const CHAIN_SUBCOLLECTIONS = ["branding", "clients", "phoneIndex", "referralCodes", "bonusOperations"];

/** Удаляет сеть после льготного периода: точки, общую лояльность и
 *  членство. Документ сети и подписка остаются для истории. */
async function purgeChainData(chainId) {
  const firestore = db();
  const locations = await firestore.collection("tenants").where("chainId", "==", chainId).get();
  for (const tenantDoc of locations.docs) {
    if (tenantDoc.data().status === "deleted") continue;
    await purgeTenantData(tenantDoc.id, { skipSubscription: true });
  }

  const chainRef = firestore.collection("chains").doc(chainId);
  for (const name of CHAIN_SUBCOLLECTIONS) {
    await firestore.recursiveDelete(chainRef.collection(name));
  }

  const members = await firestore.collection("chainMembers").where("chainId", "==", chainId).get();
  if (!members.empty) {
    const batch = firestore.batch();
    members.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  await chainRef.set({ status: "deleted", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await firestore.collection("subscriptions").doc(chainId).set({ status: "cancelled" }, { merge: true });
  await writeAuditLog({
    tenantId: null, actorId: null, action: "chainDataPurged",
    metadata: { chainId, reason: "grace_period_expired", graceDays: GRACE_PERIOD_DAYS },
  });
}

/** Раз в сутки продлевает подписки, у которых период кончается в
 *  ближайшие сутки. Повторы в тот же день отсекает 20-часовая защёлка. */
async function runChargeRecurringSubscriptions() {
  const firestore = db();
  const withinADay = admin.firestore.Timestamp.fromMillis(Date.now() + 86400000);
  const byProvider = async (provider) => (await firestore.collection("subscriptions")
    .where("status", "==", "active")
    .where("provider", "==", provider)
    .where("currentPeriodEnd", "<=", withinADay)
    .get()).docs;
  // Подписки, оплаченные раньше через ЮKassa, автоматически не продлеваются:
  // владелец оплачивает следующий период из кабинета (через Робокассу).
  const docs = await byProvider("robokassa");

  for (const subDoc of docs) {
    const sub = subDoc.data();
    const targetId = subDoc.id;
    const isChain = !!sub.chainId;
    if (sub.cancelAtPeriodEnd) continue;
    // Нечем списать — подписка уйдёт в past_due сама, владелец оплатит из кабинета.
    if (!sub.robokassaParentInvId) continue;

    const lastAttemptMs = sub.renewalAttemptedAt?.toMillis?.() ?? 0;
    if (Date.now() - lastAttemptMs < 20 * 3600000) continue;

    const planDoc = await firestore.collection("plans").doc(sub.planId).get();
    const plan = planDoc.data() || {};
    const billingPeriod = normalizeBillingPeriod(sub.billingPeriod);
    // Сеть платит за число точек на момент продления: их могли добавить или закрыть.
    const locationCount = isChain ? Math.max(1, await countChainLocations(targetId)) : 1;
    const price = billingPrice(plan, sub, sub.planId, (p) => (isChain ? chainPriceForPeriod(p, billingPeriod, locationCount) : planPriceForPeriod(p, billingPeriod)));
    if (price <= 0) continue;
    const periodLabel = { monthly: "месяц", semiannual: "полгода", yearly: "год" }[billingPeriod];

    await subDoc.ref.update({ renewalAttemptedAt: admin.firestore.FieldValue.serverTimestamp() });
    try {
      const invId = await robokassaCharge({
        sub, targetId, isChain, price, billingPeriod, locationCount,
        description: `ZalPOS: продление тарифа «${plan.name || sub.planId}», ${periodLabel}`,
      });
      await subDoc.ref.update({ renewalInvId: invId });
    } catch (e) {
      console.error(`saas-gateway: не удалось продлить ${targetId}`, e.message || e);
      await markPastDue(targetId, subDoc.ref, isChain);
      await writeAuditLog({
        tenantId: isChain ? null : targetId, actorId: null, action: "subscriptionRenewalFailed",
        metadata: { error: String(e), chainId: isChain ? targetId : null },
      });
    }
  }
}

/** Раз в сутки: истёкшие пробные периоды и неоплаченные подписки — в
 *  past_due, а через GRACE_PERIOD_DAYS после этого данные удаляются. */
async function runEnforceGracePeriod() {
  const firestore = db();
  const now = Date.now();
  const nowTs = admin.firestore.Timestamp.fromMillis(now);

  const expiredTrials = await firestore.collection("subscriptions")
    .where("status", "==", "trial")
    .where("trialEndsAt", "<=", nowTs)
    .get();
  for (const subDoc of expiredTrials.docs) {
    const isChain = !!subDoc.data().chainId;
    await markPastDue(subDoc.id, subDoc.ref, isChain);
    await writeAuditLog({
      tenantId: isChain ? null : subDoc.id, actorId: null, action: "trialExpired",
      metadata: { chainId: isChain ? subDoc.id : null },
    });
  }

  const staleActive = await firestore.collection("subscriptions")
    .where("status", "==", "active")
    .where("currentPeriodEnd", "<=", nowTs)
    .get();
  for (const subDoc of staleActive.docs) {
    const sub = subDoc.data();
    // Если списание запустили сегодня, даём уведомлению об оплате сутки.
    const lastAttemptMs = sub.renewalAttemptedAt?.toMillis?.() ?? 0;
    if (now - lastAttemptMs < 24 * 3600000) continue;
    await markPastDue(subDoc.id, subDoc.ref, !!sub.chainId);
  }

  const deadline = admin.firestore.Timestamp.fromMillis(now - GRACE_PERIOD_DAYS * 86400000);
  const overdue = await firestore.collection("subscriptions")
    .where("status", "==", "past_due")
    .where("pastDueSince", "<=", deadline)
    .get();
  for (const subDoc of overdue.docs) {
    if (subDoc.data().chainId) {
      await purgeChainData(subDoc.id);
      console.log(`saas-gateway: данные сети ${subDoc.id} стёрты по истечении льготного периода`);
    } else {
      await purgeTenantData(subDoc.id);
      console.log(`saas-gateway: данные заведения ${subDoc.id} стёрты по истечении льготного периода`);
    }
  }
}

/**
 * Суточная задача, которая переживает перезапуски: время прогона хранится в
 * platformStatus/cronJobs, проверяем раз в час. С setInterval(24 ч) каждый
 * деплой сбрасывал отсчёт, и при частых обновлениях задачи не шли вообще.
 */
function scheduleDailyJob(name, intervalMs, run, firstDelayMs = 5 * 60 * 1000) {
  const ref = () => db().collection("platformStatus").doc("cronJobs");
  const tick = async () => {
    try {
      const last = (await ref().get()).data()?.[name]?.toMillis?.() ?? 0;
      if (Date.now() - last < intervalMs - 60 * 60 * 1000) return;
      await ref().set({ [name]: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      await run();
    } catch (e) {
      console.error(`saas-gateway: задача ${name}:`, e.message || e);
    }
  };
  setTimeout(tick, Number(process.env.CRON_FIRST_DELAY_MS) || firstDelayMs);
  setInterval(tick, 60 * 60 * 1000);
}

const BILLING_CRON_INTERVAL_MS = 24 * 3600 * 1000;
function scheduleBillingCron() {
  scheduleDailyJob("billing", BILLING_CRON_INTERVAL_MS, async () => {
    try {
      await runChargeRecurringSubscriptions();
    } catch (e) {
      console.error("saas-gateway: ошибка автопродления подписок:", e.message || e);
    }
    try {
      await runEnforceGracePeriod();
    } catch (e) {
      console.error("saas-gateway: ошибка проверки льготного периода:", e.message || e);
    }
  });
}

// ------------------------------------------------------- calculateUsage

/**
 * Раз в сутки: число сотрудников, устройств, столов и гостей заведения
 * (tenants/{id}/usage/current) — по нему панель платформы показывает
 * превышение лимитов тарифа. Только count(), документы не читаем.
 */
async function runCalculateUsage() {
  const firestore = db();
  const tenants = await firestore
    .collection("tenants")
    .where("status", "in", ["trial", "active", "past_due"])
    .get();
  for (const tenantDoc of tenants.docs) {
    const ref = tenantDoc.ref;
    const [employees, devices, tables, clients, takeaway] = await Promise.all([
      ref.collection("employees").count().get(),
      ref.collection("devices").count().get(),
      ref.collection("tables").count().get(),
      ref.collection("clients").count().get(),
      // Служебный стол «С собой и доставка» в лимит тарифа не входит.
      ref.collection("tables").doc("takeaway").get(),
    ]);
    await ref.collection("usage").doc("current").set({
      employees: employees.data().count,
      devices: devices.data().count,
      tables: Math.max(0, tables.data().count - (takeaway.exists ? 1 : 0)),
      guests: clients.data().count,
      calculatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

const USAGE_CRON_INTERVAL_MS = 24 * 3600 * 1000;
function scheduleUsageCron() {
  scheduleDailyJob("usage", USAGE_CRON_INTERVAL_MS, runCalculateUsage, 15 * 60 * 1000);
}

/**
 * Дневной снимок для графиков «Аналитики»: регистрации консоль считает
 * сама, а MRR задним числом не восстановить — истории смены тарифа нет.
 * Один документ на день (id — дата UTC), повторный прогон его перезаписывает.
 */
async function runCalculatePlatformMetrics() {
  const firestore = db();
  const [tenantsSnap, chainsSnap, plansSnap] = await Promise.all([
    firestore.collection("tenants").get(),
    firestore.collection("chains").get(),
    firestore.collection("plans").get(),
  ]);
  const plansById = new Map();
  plansSnap.docs.forEach((d) => plansById.set(d.id, d.data()));
  const priceByPlanId = new Map();
  plansById.forEach((p, id) => priceByPlanId.set(id, Number(p.priceRub) || 0));

  let activeCount = 0;
  let mrr = 0;
  // Точки сети считаем через сеть: у точки status всегда active, а planId —
  // заглушка «start», настоящий тариф и цена — у сети.
  const locationCountByChain = new Map();
  // Демо-заведения и подписки, оплаченные тестовым платежом, — не клиенты.
  let totalTenants = 0;
  tenantsSnap.docs.forEach((d) => {
    const t = d.data();
    if (t.demo === true) return;
    if (t.status !== "deleted") totalTenants += 1;
    if (t.chainId) {
      // Как в countChainLocations: платят за все неудалённые точки, включая приостановленные.
      if (t.status !== "deleted") locationCountByChain.set(t.chainId, (locationCountByChain.get(t.chainId) || 0) + 1);
      return;
    }
    if (t.status !== "active" || t.testPayment === true) return;
    activeCount += 1;
    mrr += priceByPlanId.get(t.planId) || 0;
  });
  chainsSnap.docs.forEach((d) => {
    const c = d.data();
    if (c.status !== "active" || c.demo === true || c.testPayment === true) return;
    const plan = plansById.get(c.planId);
    if (!plan) return;
    const locationCount = Math.max(1, locationCountByChain.get(d.id) || 0);
    activeCount += locationCount;
    // MRR везде по месячной цене, даже если платят за полгода или год.
    mrr += chainPriceForPeriod(plan, "monthly", locationCount);
  });

  const dateId = new Date().toISOString().slice(0, 10);
  await firestore.collection("platformMetrics").doc(dateId).set({
    date: dateId,
    totalTenants,
    activeCount,
    mrr,
    calculatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

const PLATFORM_METRICS_CRON_INTERVAL_MS = 24 * 3600 * 1000;
function schedulePlatformMetricsCron() {
  scheduleDailyJob("platformMetrics", PLATFORM_METRICS_CRON_INTERVAL_MS, runCalculatePlatformMetrics, 20 * 60 * 1000);
}

/** Кнопка «Пересчитать сейчас» в панели: usage и дневной снимок сразу, не
 *  дожидаясь суточного таймера. */
async function handleRecalculateUsage(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  await Promise.all([runCalculateUsage(), runCalculatePlatformMetrics()]);
  sendJson(res, 200, { ok: true });
}

// --------------------------------------------------- completeBuildJob

/**
 * Обратный вызов последнего шага saas-on-demand-build.yml. Подлинность —
 * общий секрет в заголовке x-callback-secret.
 */
async function handleCompleteBuildJob(req, res) {
  const expected = process.env.BUILD_CALLBACK_SECRET || "";
  if (!expected || !secretsEqual(req.headers["x-callback-secret"], expected)) {
    throw new HttpError(403, "forbidden");
  }
  const body = await parseJsonBody(req);
  const { jobId, status, downloadPath, runUrl, errorMessage } = body;
  if (typeof jobId !== "string" || !jobId || !["success", "failed"].includes(status)) {
    throw new HttpError(400, "bad request");
  }

  const jobRef = db().collection("buildJobs").doc(jobId);
  const jobDoc = await jobRef.get();
  if (!jobDoc.exists) throw new HttpError(404, "job not found");

  // Номер запуска workflow — это versionCode APK: по нему приложение видит
  // новую версию (handleAppUpdate).
  const buildNumber = Number(body.buildNumber);
  await jobRef.update({
    status,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    downloadPath: status === "success" ? (downloadPath || null) : null,
    runUrl: runUrl || null,
    errorMessage: status === "failed" ? (errorMessage || "неизвестная ошибка сборки") : null,
    buildNumber: status === "success" && Number.isInteger(buildNumber) && buildNumber > 0 ? buildNumber : null,
  });
  const job = jobDoc.data();
  forgetAppUpdates(job.tenantId);
  if (status === "success") {
    await supersedeOldBuilds(job.tenantId).catch((e) => console.error("saas-gateway: чистка старых сборок:", e.message || e));
  } else if (job.rolloutSha) {
    // Автообновление не собралось: заведение остаётся в очереди, а раскатка
    // встаёт на паузу (runAppRolloutTick), чтобы не собирать всем битую версию.
    await db().collection("tenants").doc(job.tenantId)
      .set({ appBuild: { sha: "failed" } }, { merge: true })
      .catch(() => {});
  }
  sendJson(res, 200, { ok: true });
}

// ------------------------------------------- хранение сборок на диске

/**
 * На сервере храним только последнюю готовую сборку каждого приложения
 * заведения: устройства обновляются до неё сами, а каждое обновление
 * платформы пересобирает всех. Старые помечаются superseded, файлы удаляются.
 */
async function supersedeOldBuilds(tenantId) {
  const snap = await db()
    .collection("buildJobs")
    .where("tenantId", "==", tenantId)
    .orderBy("createdAt", "desc")
    .limit(60)
    .get();
  const newest = new Map(); // "type/platform" -> самая свежая готовая
  const rank = (j) => (Number.isInteger(j.buildNumber) ? j.buildNumber : 0);
  const done = snap.docs.filter((d) => d.data().status === "success");
  for (const d of done) {
    const key = `${d.data().type}/${d.data().platform || "android"}`;
    const cur = newest.get(key);
    if (!cur || rank(d.data()) > rank(cur.data())) newest.set(key, d);
  }
  const keep = new Set([...newest.values()].map((d) => d.id));
  const old = done.filter((d) => !keep.has(d.id));
  for (const d of old) {
    await d.ref.update({ status: "superseded", downloadPath: null });
    await fs.promises.rm(path.join(TENANT_BUILDS_DIR, tenantId, `${d.id}.apk`), { force: true }).catch(() => {});
  }
  if (old.length) forgetAppUpdates(tenantId);
  return old.length;
}

/**
 * Суточная уборка tenant-builds на случай, если supersedeOldBuilds что-то
 * пропустил: остаются файлы готовых и идущих сборок живых заведений.
 * Файлы моложе 3 часов не трогаем — сборка могла ещё не отчитаться.
 * Записи buildJobs без файла старше 60 дней удаляем.
 */
const BUILD_FILE_GRACE_MS = 3 * 3600 * 1000;
const BUILD_JOB_HISTORY_DAYS = 60;

async function sweepTenantBuilds() {
  let removedFiles = 0;
  let freedBytes = 0;
  const firestore = db();
  const dirs = await fs.promises.readdir(TENANT_BUILDS_DIR, { withFileTypes: true }).catch(() => []);
  for (const dirent of dirs) {
    if (!dirent.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(dirent.name)) continue;
    // Демо приложения гостя для сайта — не заведение, не трогаем.
    if (dirent.name === PUBLIC_DEMO_DIR) continue;
    const tenantId = dirent.name;
    const dir = path.join(TENANT_BUILDS_DIR, tenantId);
    const tenantDoc = await firestore.collection("tenants").doc(tenantId).get();
    if (!tenantDoc.exists || tenantDoc.data().status === "deleted") {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    await supersedeOldBuilds(tenantId);
    const snap = await firestore
      .collection("buildJobs")
      .where("tenantId", "==", tenantId)
      .orderBy("createdAt", "desc")
      .limit(60)
      .get();
    const keep = new Set(snap.docs.filter((d) => ["success", "queued"].includes(d.data().status)).map((d) => d.id));
    for (const name of await fs.promises.readdir(dir).catch(() => [])) {
      const m = /^([A-Za-z0-9]+)\.apk$/.exec(name);
      if (m && keep.has(m[1])) continue;
      const file = path.join(dir, name);
      const st = await fs.promises.stat(file).catch(() => null);
      if (!st || !st.isFile() || Date.now() - st.mtimeMs < BUILD_FILE_GRACE_MS) continue;
      await fs.promises.rm(file, { force: true }).catch(() => {});
      removedFiles++;
      freedBytes += st.size;
    }
  }

  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - BUILD_JOB_HISTORY_DAYS * 86400 * 1000);
  for (const status of ["failed", "superseded"]) {
    const old = await firestore.collection("buildJobs").where("status", "==", status).limit(400).get();
    const stale = old.docs.filter((d) => {
      const at = d.data().createdAt;
      return at && typeof at.toMillis === "function" && at.toMillis() < cutoff.toMillis();
    });
    if (stale.length) {
      const batch = firestore.batch();
      stale.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
  if (removedFiles) console.log(`saas-gateway: удалено старых сборок: ${removedFiles}, освобождено ${Math.round(freedBytes / 1048576)} МБ`);
  return { removedFiles, freedBytes };
}

// ------------------------------------------------- хиты меню

/**
 * Раз в сутки: топ-10 позиций меню каждого заведения по числу продаж за
 * 30 дней — menuItems/{id}.popularRank (1 — самая популярная, 0 — не в
 * топе). Гость видит «Хит» у первой пятёрки, ИИ-помощник называет их на
 * «что у вас популярное». Приложение гостя чеки не видит, поэтому считает
 * сервер; наружу уходит только место в топе, без сумм и чеков. Табак в
 * хиты не попадает — это было бы стимулированием продаж (ст. 16 15-ФЗ).
 */
const POPULAR_DAYS = 30;
const POPULAR_TOP = 10;
const TOBACCO_RE = /кальян|табак|никотин|hookah|shisha|снюс|вейп|сигар/i;

async function computeMenuPopularity(tenantRef) {
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - POPULAR_DAYS * 86400 * 1000);
  const [sessions, items, cats] = await Promise.all([
    tenantRef.collection("sessions").where("closedAt", ">=", since).get(),
    tenantRef.collection("menuItems").get(),
    tenantRef.collection("menuCategories").get(),
  ]);
  const sold = new Map();
  for (const s of sessions.docs) {
    const d = s.data();
    if (d.status !== "closed" || d.refunded) continue;
    for (const it of d.orderItems || []) {
      if (!it || !it.menuItemId) continue;
      sold.set(it.menuItemId, (sold.get(it.menuItemId) || 0) + (Number(it.qty) || 0));
    }
  }
  const catName = new Map(cats.docs.map((c) => [c.id, String(c.data().name || "")]));
  const ranked = items.docs
    .filter((d) => (sold.get(d.id) || 0) > 0)
    .filter((d) => d.data().tobacco !== true && !TOBACCO_RE.test(String(d.data().name || "")) && !TOBACCO_RE.test(catName.get(d.data().categoryId) || ""))
    .sort((a, b) => sold.get(b.id) - sold.get(a.id))
    .slice(0, POPULAR_TOP);
  const rankOf = new Map(ranked.map((d, i) => [d.id, i + 1]));
  const changes = items.docs.filter((d) => (Number(d.data().popularRank) || 0) !== (rankOf.get(d.id) || 0));
  for (let i = 0; i < changes.length; i += 400) {
    const batch = db().batch();
    changes.slice(i, i + 400).forEach((d) => batch.update(d.ref, { popularRank: rankOf.get(d.id) || 0 }));
    await batch.commit();
  }
  return { top: ranked.length, changed: changes.length };
}

async function runMenuPopularity() {
  const tenants = await db().collection("tenants").get();
  for (const t of tenants.docs) {
    if (t.data().status === "deleted") continue;
    try {
      await computeMenuPopularity(t.ref);
    } catch (e) {
      console.error(`saas-gateway: хиты меню ${t.id}:`, e.message || e);
    }
  }
}

function scheduleMenuPopularity() {
  scheduleDailyJob("menuPopularity", 24 * 3600 * 1000, runMenuPopularity, 30 * 60 * 1000);
}

function scheduleBuildsSweep() {
  scheduleDailyJob("buildsSweep", 24 * 3600 * 1000, sweepTenantBuilds, 25 * 60 * 1000);
}

// ------------------------------------------------- автообновление

/**
 * Автообновление приложений всех заведений. saas-rollout.yml присылает
 * коммит, и сервер по очереди пересобирает приложения тем, у кого они уже
 * собирались (tenants.appBuild). Устройства сами находят новую версию
 * (handleAppUpdate).
 *
 * Очередь в Firestore (platformStatus/appRollout, tenants.appBuild.sha) и
 * переживает перезапуск. Пуши подряд склеиваются (APP_ROLLOUT_DELAY_MS),
 * одновременно собирается не больше APP_ROLLOUT_CONCURRENCY заведений.
 * Упала сборка — раскатка встаёт на паузу до следующего обновления или
 * кнопки в панели.
 */
const APP_ROLLOUT_DELAY_MS = 5 * 60 * 1000;
const APP_ROLLOUT_CONCURRENCY = 2;
const APP_ROLLOUT_STALE_MS = 90 * 60 * 1000; // «в очереди» дольше — сборка потерялась, место не держит
const appRolloutRef = () => db().collection("platformStatus").doc("appRollout");

async function handleRolloutApps(req, res) {
  const body = await parseJsonBody(req);
  const expected = process.env.BUILD_CALLBACK_SECRET || "";
  let sha;
  let by;
  if (req.headers["x-callback-secret"] !== undefined) {
    // Из GitHub Actions — тот же общий секрет, что у completeBuildJob.
    if (!expected || !secretsEqual(req.headers["x-callback-secret"], expected)) throw new HttpError(403, "forbidden");
    sha = typeof body.sha === "string" && /^[0-9a-f]{7,40}$/.test(body.sha) ? body.sha : "";
    if (!sha) throw new HttpError(400, "bad request");
    by = "github";
  } else {
    // Кнопка «Обновить приложения всем» в панели платформы.
    const decoded = await verifyAuth(req);
    if (!(await isSuperAdmin(decoded))) throw new HttpError(403, "Только для администратора платформы");
    sha = `manual-${Date.now()}`;
    by = decoded.uid;
  }
  await backfillAppBuildMarks();
  const now = Date.now();
  await appRolloutRef().set({
    sha,
    requestedBy: by,
    requestedAt: admin.firestore.Timestamp.fromMillis(now),
    // Из панели — сразу, из GitHub — после паузы: вдруг следом ещё push.
    startAfter: admin.firestore.Timestamp.fromMillis(by === "github" ? now + APP_ROLLOUT_DELAY_MS : now),
    state: "waiting",
    pausedReason: null,
    finishedAt: null,
  });
  sendJson(res, 200, { ok: true, sha });
}

/** Заведения, собиравшие приложения до появления tenants.appBuild, —
 *  тоже в раскатку: у них уже стоят приложения, которые надо обновлять. */
async function backfillAppBuildMarks() {
  const firestore = db();
  const snap = await firestore.collection("buildJobs").where("status", "==", "success").select("tenantId").get();
  const ids = [...new Set(snap.docs.map((d) => d.data().tenantId).filter(Boolean))];
  for (const id of ids) {
    const ref = firestore.collection("tenants").doc(id);
    const t = await ref.get();
    if (t.exists && !t.data().appBuild) await ref.set({ appBuild: { sha: "legacy" } }, { merge: true });
  }
}

let appRolloutRunning = false;

async function runAppRolloutTick() {
  if (appRolloutRunning) return;
  appRolloutRunning = true;
  try {
    const firestore = db();
    const r = (await appRolloutRef().get()).data();
    if (!r || !r.sha || r.state === "done" || r.state === "paused") return;
    if (r.startAfter && Date.now() < r.startAfter.toMillis()) return;

    // Сборка этой версии у кого-то упала — дальше не раскатываем.
    const failed = await firestore.collection("buildJobs")
      .where("rolloutSha", "==", r.sha).where("status", "==", "failed").limit(1).get();
    if (!failed.empty) {
      const f = failed.docs[0].data();
      await appRolloutRef().set({
        state: "paused",
        pausedReason: `Сборка не удалась (заведение ${f.tenantId}): ${String(f.errorMessage || "").slice(0, 200)}`,
      }, { merge: true });
      return;
    }

    const queued = await firestore.collection("buildJobs").where("status", "==", "queued").get();
    const busy = new Set(queued.docs
      .filter((d) => {
        const at = d.data().createdAt;
        return at && typeof at.toMillis === "function" && Date.now() - at.toMillis() < APP_ROLLOUT_STALE_MS;
      })
      .map((d) => d.data().tenantId));
    let slots = APP_ROLLOUT_CONCURRENCY - busy.size;

    // "!=" не находит заведения без appBuild — те, что приложений ещё не
    // собирали, раскатка не трогает.
    const todo = await firestore.collection("tenants").where("appBuild.sha", "!=", r.sha).limit(50).get();
    if (todo.empty) {
      if (busy.size === 0) await appRolloutRef().set({ state: "done", finishedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return;
    }
    if (r.state !== "running") await appRolloutRef().set({ state: "running" }, { merge: true });
    for (const doc of todo.docs) {
      if (slots <= 0) break;
      if (busy.has(doc.id)) continue;
      const t = doc.data();
      if (t.status === "deleted" || t.demo) {
        await doc.ref.set({ appBuild: { sha: r.sha, skipped: "deleted" } }, { merge: true });
        continue;
      }
      try {
        await startTenantBuild(doc.id, { requestedBy: "platform", rolloutSha: r.sha });
        slots--;
      } catch (e) {
        if (e.status === 412) {
          // Подписка неактивна — пропускаем; оплатит и нажмёт «Собрать APK»
          // или получит следующее обновление.
          await doc.ref.set({ appBuild: { sha: r.sha, skipped: "subscription" } }, { merge: true });
        } else if (e.status !== 409) {
          // GitHub недоступен, кончился токен и т. п. — не долбим каждую
          // минуту, пробуем через полчаса.
          await appRolloutRef().set({
            startAfter: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 60 * 1000),
            lastError: String(e.message || e).slice(0, 300),
          }, { merge: true });
          return;
        }
      }
    }
  } catch (e) {
    console.error("saas-gateway: автообновление приложений:", e.message || e);
  } finally {
    appRolloutRunning = false;
  }
}

function scheduleAppRollout() {
  setInterval(runAppRolloutTick, 60 * 1000);
}

// ----------------------------------------------------- downloadBuild

/**
 * Одноразовые минутные ссылки на скачивание: консоль сначала получает
 * ссылку через getDownloadUrl (с Firebase Auth и проверкой роли), потом
 * просто открывает её. fetch+blob с заголовком Authorization на телефонах
 * молча блокировался. Секрет живёт до перезапуска — ссылка всё равно минутная.
 */
const DOWNLOAD_TOKEN_SECRET = crypto.randomBytes(32).toString("hex");
const DOWNLOAD_TOKEN_TTL_MS = 60000;

function signDownloadToken(jobId, expiresAt) {
  return crypto.createHmac("sha256", DOWNLOAD_TOKEN_SECRET).update(`${jobId}.${expiresAt}`).digest("hex");
}

function verifyDownloadToken(jobId, token) {
  const [expiresAtStr, sig] = String(token || "").split(".");
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || !sig || Date.now() > expiresAt) return false;
  const expected = signDownloadToken(jobId, expiresAt);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Выдаёт ссылку на скачивание сборки (Firebase Auth + роль). */
async function handleGetDownloadUrl(req, res) {
  const decoded = await verifyAuth(req);
  const { jobId } = await parseJsonBody(req);
  if (typeof jobId !== "string" || !/^[A-Za-z0-9]+$/.test(jobId)) throw new HttpError(400, "некорректный jobId");

  const jobDoc = await db().collection("buildJobs").doc(jobId).get();
  if (!jobDoc.exists) throw new HttpError(404, "сборка не найдена");
  const job = jobDoc.data();
  if (job.status !== "success") throw new HttpError(409, "сборка ещё не готова");

  await requireTenantRole(job.tenantId, decoded.uid, ["owner", "admin"]);

  const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
  const token = signDownloadToken(jobId, expiresAt);
  sendJson(res, 200, {
    url: `/downloadBuild?jobId=${encodeURIComponent(jobId)}&token=${encodeURIComponent(`${expiresAt}.${token}`)}`,
  });
}

/** Сам файл: доступ по токену из ссылки, без заголовка Authorization. */
async function handleDownloadBuild(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  const jobId = requestUrl.searchParams.get("jobId") || "";
  const token = requestUrl.searchParams.get("token") || "";
  if (!/^[A-Za-z0-9]+$/.test(jobId)) throw new HttpError(400, "некорректный jobId");
  if (!verifyDownloadToken(jobId, token)) {
    throw new HttpError(403, "Ссылка устарела — вернитесь в консоль и нажмите «Скачать» заново");
  }

  const jobDoc = await db().collection("buildJobs").doc(jobId).get();
  if (!jobDoc.exists) throw new HttpError(404, "сборка не найдена");
  const job = jobDoc.data();
  if (job.status !== "success") throw new HttpError(409, "сборка ещё не готова");

  // На диске файл всегда "{jobId}.apk" (так пишет deploy-tenant-apk.sh),
  // что внутри — определяют Content-Type и имя в Content-Disposition.
  const filePath = path.join(TENANT_BUILDS_DIR, job.tenantId, `${jobId}.apk`);
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (_) {
    throw new HttpError(404, "файл сборки не найден на сервере — попробуйте собрать заново");
  }

  const isWindows = job.platform === "windows";
  // Разные имена, чтобы кассу и гостевое приложение можно было отличить в «Загрузках».
  const fileNamePrefix = job.type === "guest" ? "zalpos-guest" : isWindows ? "zalpos-windows" : "zalpos";
  // Windows-касса раньше была zip, теперь установщик: смотрим сигнатуру «MZ».
  let isInstaller = false;
  if (isWindows) {
    try {
      const fh = await fs.promises.open(filePath, "r");
      const { buffer } = await fh.read(Buffer.alloc(2), 0, 2, 0);
      await fh.close();
      isInstaller = buffer.toString("latin1") === "MZ";
    } catch (_) {}
  }
  const fileNamePrefix2 = isInstaller ? "zalpos-setup" : fileNamePrefix;
  const fileExt = isWindows ? (isInstaller ? "exe" : "zip") : "apk";
  const contentType = isWindows
    ? (isInstaller ? "application/vnd.microsoft.portable-executable" : "application/zip")
    : "application/vnd.android.package-archive";

  // Байты отдаёт nginx (location /internal-tenant-builds/), Node только
  // проверяет доступ: при отдаче из Node загрузка на телефонах зависала на 100 %.
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${fileNamePrefix2}-${jobId}.${fileExt}"`,
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Redirect": `/internal-tenant-builds/${job.tenantId}/${jobId}.apk`,
  });
  res.end();
}

// --------------------------------------------------------- appUpdate

/**
 * «Вышла ли новая версия?» — касса и гостевое приложение спрашивают сами
 * (app_update_service.dart) и ставят обновление поверх, данные на месте.
 * Версия — buildNumber сборки (номер запуска workflow); у старых сборок
 * номера нет, им обновление не предлагаем.
 *
 * Гостевому приложению отвечаем без входа: его APK и так раздаётся по QR.
 * Кассе — только участнику заведения: в неё зашит код приглашения.
 *
 * Гостей у заведения сотни, поэтому список сборок кэшируется в памяти и
 * сбрасывается, как только completeBuildJob отметил новую сборку.
 */
const APP_UPDATE_TYPES = { pos: "pos", guest: "guest" };
const APP_UPDATE_PLATFORMS = ["android", "windows"];
const APP_UPDATE_CACHE_TTL_MS = 30 * 60 * 1000;
const appUpdateCache = new Map(); // tenantId -> { at, points: [tenantId], jobs: [{ id, tenantId, type, platform, buildNumber, completedAt }] | null }

/** Сборка заведения изменилась — сбросить ответы его и всех точек его сети. */
function forgetAppUpdates(tenantId) {
  for (const [id, entry] of appUpdateCache) {
    if (id === tenantId || entry.points.includes(tenantId)) appUpdateCache.delete(id);
  }
}

async function latestTenantBuilds(tenantId) {
  const cached = appUpdateCache.get(tenantId);
  if (cached && Date.now() - cached.at < APP_UPDATE_CACHE_TTL_MS) return cached.jobs;

  const firestore = db();
  const tenantDoc = await firestore.collection("tenants").doc(tenantId).get();
  let jobs = null;
  const points = [tenantId];
  if (tenantDoc.exists && tenantDoc.data().status !== "deleted") {
    // Тот же запрос, что и в handlePublicGuestApk: индекс только на
    // tenantId+createdAt, одно нажатие «Собрать APK» — три сборки.
    const buildsOf = async (id) => (await firestore
      .collection("buildJobs")
      .where("tenantId", "==", id)
      .orderBy("createdAt", "desc")
      .limit(20)
      .get()).docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((j) => j.status === "success")
      .map((j) => ({
        id: j.id,
        tenantId: j.tenantId,
        type: j.type,
        platform: j.platform || "android",
        buildNumber: Number.isInteger(j.buildNumber) ? j.buildNumber : 0,
        completedAt: j.completedAt && typeof j.completedAt.toDate === "function" ? j.completedAt.toDate().toISOString() : null,
      }));
    jobs = await buildsOf(tenantId);
    // Точка сети: касса могла перейти сюда из другой точки, а у этой своих
    // сборок может не быть вовсе — берём свежие сборки любой точки сети
    // (приложения у точек одинаковые, приложение гостя — общее на сеть).
    const chainId = tenantDoc.data().chainId;
    if (chainId) {
      const chainPoints = await firestore.collection("tenants").where("chainId", "==", chainId).get();
      for (const p of chainPoints.docs) {
        if (p.id === tenantId || p.data().status === "deleted") continue;
        points.push(p.id);
        jobs.push(...await buildsOf(p.id));
      }
      jobs.sort((a, b) => b.buildNumber - a.buildNumber);
    }
  }
  if (appUpdateCache.size > 5000) appUpdateCache.clear();
  appUpdateCache.set(tenantId, { at: Date.now(), points, jobs });
  return jobs;
}

async function handleAppUpdate(req, res) {
  const body = await parseJsonBody(req);
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const type = APP_UPDATE_TYPES[body.app];
  const platform = body.platform === undefined ? "android" : body.platform;
  const current = Number(body.current);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)) throw new HttpError(400, "некорректный tenantId");
  if (!type) throw new HttpError(400, "app должен быть pos или guest");
  // Гостевое приложение собирается только под Android (см. handleCreateBuildJob).
  if (!APP_UPDATE_PLATFORMS.includes(platform) || (type === "guest" && platform !== "android")) {
    throw new HttpError(400, "некорректная платформа");
  }
  if (!Number.isInteger(current) || current < 0) throw new HttpError(400, "некорректный номер сборки");

  if (type === "pos") {
    const decoded = await verifyAuth(req);
    await requireTenantRole(tenantId, decoded.uid, ["owner", "admin", "manager", "employee"]);
  }

  const jobs = await latestTenantBuilds(tenantId);
  if (jobs === null) throw new HttpError(404, "Заведение не найдено");
  const latest = jobs.find((j) => j.type === type && j.platform === platform);
  const buildNumber = latest ? latest.buildNumber : 0;
  if (!latest || buildNumber <= current) return sendJson(res, 200, { update: false, buildNumber });

  let sizeBytes;
  try {
    sizeBytes = (await fs.promises.stat(path.join(TENANT_BUILDS_DIR, latest.tenantId || tenantId, `${latest.id}.apk`))).size;
  } catch (_) {
    // Файла на сервере нет (удалили, переносили диск) — предлагать нечего.
    return sendJson(res, 200, { update: false, buildNumber });
  }
  const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
  const token = signDownloadToken(latest.id, expiresAt);
  sendJson(res, 200, {
    update: true,
    buildNumber,
    jobId: latest.id,
    sizeBytes,
    builtAt: latest.completedAt,
    url: `/downloadBuild?jobId=${encodeURIComponent(latest.id)}&token=${encodeURIComponent(`${expiresAt}.${token}`)}`,
  });
}

// ---------------------------------------------------- uploadBrandingLogo

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) {
        chunks.push(chunk);
        return;
      }
      // Дочитываем вхолостую, чтобы клиент увидел 413, а не обрыв; совсем большое рвём.
      reject(new HttpError(413, "файл слишком большой"));
      if (size > maxBytes * 2 + 1048576) req.destroy();
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Логотип заведения (Storage у проекта без Blaze недоступен). Тело —
 * сырые байты картинки с Content-Type image/png|jpeg|webp: на клиенте это
 * XMLHttpRequest с прогрессом, здесь не нужен разбор multipart.
 */
async function handleUploadBrandingLogo(req, res) {
  const decoded = await verifyAuth(req);
  const requestUrl = new URL(req.url, "http://localhost");
  const tenantId = requestUrl.searchParams.get("tenantId") || "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new HttpError(400, "не указан tenantId");
  await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);

  const contentType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const ext = BRANDING_CONTENT_TYPES[contentType];
  if (!ext) throw new HttpError(400, "поддерживаются только PNG, JPEG и WebP");

  const buffer = await readRawBody(req, BRANDING_MAX_BYTES);
  if (!buffer.length) throw new HttpError(400, "пустой файл");
  if (!imageMatchesType(buffer, ext)) throw new HttpError(400, "файл не похож на картинку PNG, JPEG или WebP");

  const dir = path.join(BRANDING_UPLOADS_DIR, tenantId);
  await fs.promises.mkdir(dir, { recursive: true });
  // Логотип один: файл другого формата от прошлой загрузки удаляем.
  await Promise.all(
    Object.values(BRANDING_CONTENT_TYPES)
      .filter((oldExt) => oldExt !== ext)
      .map((oldExt) => fs.promises.unlink(path.join(dir, `logo.${oldExt}`)).catch(() => {}))
  );
  await fs.promises.writeFile(path.join(dir, `logo.${ext}`), buffer);

  // Путь без домена: консоль достраивает адрес от SAAS_GATEWAY_URL.
  sendJson(res, 200, { path: `/branding/${tenantId}/logo.${ext}` });
}

/**
 * Фото блюд и категорий меню — в папку своего заведения (раньше лежали в
 * общем бакете, и заведения могли перезаписать чужие). Читаются публично
 * через nginx (/branding/), пишет только персонал заведения.
 */
const MENU_IMAGE_FOLDERS = new Set(["items", "categories"]);
async function handleUploadMenuImage(req, res) {
  const decoded = await verifyAuth(req);
  const requestUrl = new URL(req.url, "http://localhost");
  const tenantId = requestUrl.searchParams.get("tenantId") || "";
  const folder = requestUrl.searchParams.get("folder") || "";
  const entityId = requestUrl.searchParams.get("entityId") || "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new HttpError(400, "не указан tenantId");
  if (!MENU_IMAGE_FOLDERS.has(folder)) throw new HttpError(400, "неизвестная папка меню");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(entityId)) throw new HttpError(400, "некорректный id позиции");
  await requireTenantRole(tenantId, decoded.uid, ["owner", "admin", "manager", "employee"]);

  const contentType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const ext = BRANDING_CONTENT_TYPES[contentType];
  if (!ext) throw new HttpError(400, "поддерживаются только PNG, JPEG и WebP");
  const buffer = await readRawBody(req, BRANDING_MAX_BYTES);
  if (!buffer.length) throw new HttpError(400, "пустой файл");
  if (!imageMatchesType(buffer, ext)) throw new HttpError(400, "файл не похож на картинку PNG, JPEG или WebP");

  const dir = path.join(BRANDING_UPLOADS_DIR, tenantId, "menu", folder);
  await fs.promises.mkdir(dir, { recursive: true });
  await Promise.all(
    Object.values(BRANDING_CONTENT_TYPES)
      .filter((oldExt) => oldExt !== ext)
      .map((oldExt) => fs.promises.unlink(path.join(dir, `${entityId}.${oldExt}`)).catch(() => {}))
  );
  await fs.promises.writeFile(path.join(dir, `${entityId}.${ext}`), buffer);
  sendJson(res, 200, { path: `/branding/${tenantId}/menu/${folder}/${entityId}.${ext}` });
}

/** Логотип и фото меню удалённого заведения — вместе с его данными. */
async function removeTenantUploads(tenantId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) return;
  await fs.promises.rm(path.join(TENANT_BUILDS_DIR, tenantId), { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(path.join(BRANDING_UPLOADS_DIR, tenantId), { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------- createDemoTenant

const demoRateLimiter = new Map(); // ip -> { count, resetAt }

function checkDemoRateLimit(ip) {
  const now = Date.now();
  const entry = demoRateLimiter.get(ip);
  if (!entry || entry.resetAt <= now) {
    demoRateLimiter.set(ip, { count: 1, resetAt: now + DEMO_RATE_LIMIT_WINDOW_MS });
    return;
  }
  if (entry.count >= DEMO_RATE_LIMIT_MAX) {
    throw new HttpError(429, "Слишком много демо-заведений с этого адреса — попробуйте через час");
  }
  entry.count += 1;
}

/**
 * IP клиента. nginx кладёт его в X-Real-IP и дописывает в конец
 * X-Forwarded-For; первый элемент X-Forwarded-For присылает сам клиент,
 * ему верить нельзя.
 */
function clientIp(req) {
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) {
    const parts = fwd.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || "unknown";
}

// ------------------------------------------------------------ демо-данные
//
// Демо с первого экрана показывает почти всё: три зала, живую посадку
// (заняты, «скоро освободится», «время вышло», бронь, два чека на баре),
// меню с фото, открытую смену с выручкой, брони, сотрудников с зарплатой,
// склад с позициями на исходе, гостей разных уровней, отзывы и акции.
// Все данные вымышленные, заведение удаляется само (DEMO_TTL_MS).

// Схема зала — логический холст 1000×640 с плиткой 104 (как в
// lib/utils/hall_layout.dart). Столы задаются левым верхним углом плитки в
// точках холста, доли x/y считает demoTableFraction. Все координаты кратны
// шагу сетки редактора (26), поэтому при правке схемы столы не «прыгают».
const DEMO_HALL = { width: 1000, height: 640, tile: 104 };

const DEMO_TABLES = [
  { name: "Бар", zone: "Основной зал", shape: "bar", seats: 6, left: 52, top: 52, maxOpenSessions: 4 },
  { name: "Стол 1", zone: "Основной зал", shape: "circle", seats: 2, left: 442, top: 52 },
  { name: "Стол 2", zone: "Основной зал", shape: "circle", seats: 2, left: 598, top: 52 },
  { name: "Стол 3", zone: "Основной зал", shape: "rect", seats: 4, left: 754, top: 52 },
  { name: "Стол 4", zone: "Основной зал", shape: "rect", seats: 4, left: 52, top: 234 },
  { name: "Стол 5", zone: "Основной зал", shape: "rect", seats: 4, left: 208, top: 234 },
  { name: "Стол 6", zone: "Основной зал", shape: "long", seats: 6, left: 390, top: 234 },
  { name: "Стол 7", zone: "Основной зал", shape: "oval", seats: 6, left: 650, top: 234 },
  { name: "Диван 8", zone: "Основной зал", shape: "corner", seats: 8, left: 52, top: 416 },
  { name: "Стол 9", zone: "Основной зал", shape: "long", seats: 6, left: 390, top: 416 },
  { name: "Стол 10", zone: "Основной зал", shape: "rect", seats: 4, left: 702, top: 416 },
  // Второй этаж: VIP-кабинеты сверху, лаунж — колонками под ними.
  { name: "Кабинет 1", zone: "2 этаж", shape: "corner", rotation: 1, seats: 10, left: 52, top: 52 },
  { name: "Кабинет 2", zone: "2 этаж", shape: "oval", seats: 6, left: 338, top: 104 },
  { name: "Кабинет 3", zone: "2 этаж", shape: "long", rotation: 1, seats: 8, left: 624, top: 52 },
  { name: "Лаунж 1", zone: "2 этаж", shape: "circle", seats: 2, left: 806, top: 52 },
  { name: "Лаунж 2", zone: "2 этаж", shape: "circle", seats: 2, left: 806, top: 208 },
  { name: "Лаунж 3", zone: "2 этаж", shape: "long", seats: 6, left: 52, top: 364 },
  { name: "Лаунж 4", zone: "2 этаж", shape: "long", seats: 6, left: 338, top: 364 },
  { name: "Лаунж 5", zone: "2 этаж", shape: "rect", seats: 4, left: 624, top: 364 },
  { name: "Лаунж 6", zone: "2 этаж", shape: "rect", seats: 4, left: 806, top: 364 },
  // Терраса: двухместные вдоль перил, столы для компаний и угловой диван.
  { name: "Стол 11", zone: "Терраса", shape: "circle", seats: 2, left: 52, top: 52 },
  { name: "Стол 12", zone: "Терраса", shape: "circle", seats: 2, left: 208, top: 52 },
  { name: "Стол 13", zone: "Терраса", shape: "circle", seats: 2, left: 364, top: 52 },
  { name: "Стол 14", zone: "Терраса", shape: "circle", seats: 2, left: 520, top: 52 },
  { name: "Стол 15", zone: "Терраса", shape: "long", seats: 6, left: 52, top: 234 },
  { name: "Стол 16", zone: "Терраса", shape: "oval", seats: 4, left: 312, top: 234 },
  { name: "Стол 17", zone: "Терраса", shape: "corner", rotation: 2, seats: 8, left: 676, top: 52 },
];

// Стены залов для презентации (как рисует редактор зала): углы в точках
// холста, кратные шагу сетки 26; проёмы в стенах — двери и входы.
// Основной зал: справа кухня и туалет за перегородкой с дверями, вход
// снизу. 2 этаж: три закрытых VIP-кабинета с дверями и открытый лаунж.
// Терраса: стена здания и перила с выходом на улицу.
const DEMO_WALLS = [
  { zone: "Основной зал", points: [[520, 650], [26, 650], [26, 26], [1092, 26], [1092, 650], [650, 650]] },
  { zone: "Основной зал", points: [[884, 26], [884, 182]] },
  { zone: "Основной зал", points: [[884, 260], [884, 442]] },
  { zone: "Основной зал", points: [[884, 520], [884, 650]] },
  { zone: "Основной зал", points: [[884, 338], [1092, 338]] },
  { zone: "2 этаж", points: [[416, 520], [26, 520], [26, 26], [936, 26], [936, 520], [546, 520]] },
  { zone: "2 этаж", points: [[26, 312], [130, 312]] },
  { zone: "2 этаж", points: [[312, 26], [312, 312]] },
  { zone: "2 этаж", points: [[208, 312], [416, 312]] },
  { zone: "2 этаж", points: [[598, 26], [598, 312]] },
  { zone: "2 этаж", points: [[494, 312], [650, 312]] },
  { zone: "2 этаж", points: [[754, 26], [754, 312]] },
  { zone: "2 этаж", points: [[728, 312], [754, 312]] },
  { zone: "Терраса", points: [[390, 442], [26, 442], [26, 26], [910, 26], [910, 442], [520, 442]] },
];

// Подписи на схемах: входы, служебные помещения и заметка.
const DEMO_LABELS = [
  { zone: "Основной зал", text: "Вход", x: 585, y: 684 },
  { zone: "Основной зал", text: "Хостес", x: 585, y: 598 },
  { zone: "Основной зал", text: "Кухня", x: 988, y: 182 },
  { zone: "Основной зал", text: "WC", x: 988, y: 494 },
  { zone: "2 этаж", text: "Вход", x: 481, y: 554 },
  { zone: "2 этаж", text: "Лаунж-зона", x: 845, y: 338 },
  { zone: "Терраса", text: "Выход на улицу", x: 455, y: 476 },
  { zone: "Терраса", text: "Курящая зона", x: 780, y: 338 },
];

/** Доли x/y стола: левый верхний угол / свободное место (холст минус плитка). */
function demoTableFraction(t) {
  const { width, height, tile } = DEMO_HALL;
  const cells = t.shape === "bar" ? 3 : ["long", "oval", "corner"].includes(t.shape) ? 2 : 1;
  let w = tile * cells;
  let h = t.shape === "corner" ? w : tile;
  if (t.shape !== "corner" && (t.rotation || 0) % 2 === 1) [w, h] = [h, w];
  const round = (v) => Math.round(v * 10000) / 10000;
  return { x: round(t.left / (width - w)), y: round(t.top / (height - h)) };
}

// Склад: [ключ, название, категория, единица, остаток, минимум]. Три позиции
// ниже минимума — чтобы в демо было видно предупреждения о закупке.
const DEMO_STOCK = [
  ["tobacco", "Табак (ассорти)", "Табак", "g", 180, 250],
  ["coal", "Уголь кокосовый", "Табак", "pcs", 240, 100],
  ["milk", "Молоко 3,2%", "Бар", "l", 8, 5],
  ["coffee", "Кофе в зёрнах", "Бар", "kg", 2.4, 1],
  ["puer", "Чай пуэр", "Бар", "g", 450, 200],
  ["syrup", "Сироп «Лаванда»", "Бар", "ml", 150, 300],
  ["lemon", "Лимоны", "Бар", "kg", 3, 1],
  ["cola", "Кола 0,33", "Бар", "pcs", 9, 24],
  ["water", "Вода 0,5", "Бар", "pcs", 48, 24],
  ["beef", "Говядина (фарш)", "Кухня", "kg", 4, 2],
  ["mozzarella", "Моцарелла", "Кухня", "kg", 2.5, 1],
  ["fries", "Картофель фри (заморозка)", "Кухня", "kg", 7, 3],
  ["cheesecake", "Чизкейк (порции)", "Кухня", "pcs", 11, 4],
];

// Меню. img — живое фото из saas/console/demo-menu (свободные лицензии,
// авторы в CREDITS.txt): лежит на том же хостинге, что и консоль, и не
// зависит от чужих сайтов. use — списание со склада:
// [ключ из DEMO_STOCK, сколько, единица]. rank — место в «Популярном».
const DEMO_MENU = [
  {
    // Табак без фото и описаний, с флагом tobacco (ст. 16 15-ФЗ): флаг
    // убирает скидки и «Хит», гостю табак показывается строгим списком.
    // Фото категории видят только сотрудники в кассе.
    category: "Кальяны",
    img: "hookah",
    tobacco: true,
    items: [
      { name: "Классический кальян", price: 1200, use: [["tobacco", 20, "g"], ["coal", 3, "pcs"]] },
      { name: "Кальян на молоке", price: 1500, use: [["tobacco", 20, "g"], ["coal", 3, "pcs"], ["milk", 300, "ml"]] },
      { name: "Кальян на грейпфруте", price: 1800, use: [["tobacco", 20, "g"], ["coal", 3, "pcs"]] },
      { name: "Кальян на ананасе", price: 2000, use: [["tobacco", 20, "g"], ["coal", 3, "pcs"]] },
      { name: "Перезабивка", price: 700, use: [["tobacco", 20, "g"], ["coal", 3, "pcs"]] },
    ],
  },
  {
    category: "Завтраки",
    img: "syrniki",
    items: [
      { name: "Сырники со сметаной", price: 390, weight: [220, "g"], img: "syrniki", description: "Три сырника, сметана и ягодный соус. До 16:00" },
      { name: "Омлет с беконом", price: 420, weight: [250, "g"], img: "omelette", description: "Три яйца, бекон, томаты черри и тост. До 16:00" },
      { name: "Круассан с лососем", price: 480, weight: [200, "g"], img: "croissant", description: "Слабосолёный лосось, крем-сыр и руккола. До 16:00" },
      { name: "Гранола с йогуртом", price: 350, weight: [250, "g"], img: "granola", description: "Греческий йогурт, домашняя гранола и мёд. До 16:00" },
    ],
  },
  {
    category: "Салаты",
    img: "caesar",
    items: [
      { name: "Цезарь с курицей", price: 520, weight: [250, "g"], img: "caesar",
        description: "Романо, курица гриль, пармезан и соус цезарь" },
      { name: "Греческий салат", price: 450, weight: [250, "g"], img: "greek",
        description: "Огурцы, томаты, перец, маслины и фета" },
      { name: "Салат с авокадо и креветками", price: 640, weight: [230, "g"], img: "avocado",
        description: "Тигровые креветки, авокадо, микс салатов и цитрусовая заправка" },
      { name: "Овощной салат", price: 360, weight: [220, "g"], img: "veggie",
        description: "Сезонные овощи и ароматное масло" },
    ],
  },
  {
    category: "Супы",
    img: "ramen",
    items: [
      { name: "Рамен с курицей", price: 490, weight: [400, "ml"], img: "ramen", description: "Насыщенный бульон, лапша, курица и яйцо" },
      { name: "Том ям с креветками", price: 590, weight: [350, "ml"], img: "tomyum", description: "Острый, на кокосовом молоке, с рисом" },
      { name: "Борщ со сметаной", price: 380, weight: [350, "ml"], img: "borscht", description: "С говядиной, сметаной и бородинским хлебом" },
    ],
  },
  {
    category: "Горячее",
    img: "steak",
    items: [
      { name: "Стейк рибай", price: 1690, weight: [300, "g"], img: "steak", description: "Мраморная говядина, прожарка на выбор" },
      { name: "Куриные крылья BBQ", price: 520, weight: [350, "g"], img: "wings", description: "Крылья в соусе барбекю и соус блю-чиз" },
      { name: "Паста карбонара", price: 560, weight: [300, "g"], img: "carbonara",
        description: "Спагетти, бекон, желток и пармезан" },
      { name: "Креветки темпура", price: 690, weight: [200, "g"], img: "tempura", description: "Хрустящие креветки и соус свит-чили" },
    ],
  },
  {
    category: "Пицца и хачапури",
    img: "pizza",
    items: [
      { name: "Пицца Маргарита", price: 590, weight: [450, "g"], img: "pizza",
        description: "Томатный соус, моцарелла и базилик", use: [["mozzarella", 120, "g"]] },
      { name: "Хачапури по-аджарски", price: 550, weight: [400, "g"], img: "khachapuri",
        description: "Сулугуни, яйцо и сливочное масло", use: [["mozzarella", 80, "g"]] },
    ],
  },
  {
    category: "Бургеры и сэндвичи",
    img: "burger",
    items: [
      { name: "Бургер с говядиной", price: 590, weight: [350, "g"], img: "burger", rank: 4,
        description: "Котлета из говядины, чеддер, томаты и соус барбекю", use: [["beef", 150, "g"]] },
      { name: "Клаб-сэндвич", price: 480, weight: [300, "g"], img: "club", description: "Курица, бекон, яйцо, томаты и картофель фри" },
      { name: "Хот-дог", price: 350, weight: [250, "g"], img: "hotdog", description: "Баварская колбаска, горчица и маринованный лук" },
      { name: "Тако с курицей", price: 420, weight: [220, "g"], img: "taco", description: "Две лепёшки, курица, сальса и гуакамоле" },
    ],
  },
  {
    category: "Закуски",
    img: "fries",
    items: [
      { name: "Картофель фри", price: 250, weight: [150, "g"], img: "fries",
        description: "Хрустящий, с соусом на выбор", use: [["fries", 150, "g"]] },
      { name: "Сырные палочки", price: 340, weight: [180, "g"], img: "cheese-sticks",
        description: "Моцарелла в панировке и соус ранч", use: [["mozzarella", 150, "g"]] },
      { name: "Гёдза с креветкой", price: 460, weight: [180, "g"], img: "gyoza", description: "Шесть штук, соевый соус и кунжут" },
      { name: "Роллы Филадельфия", price: 690, weight: [250, "g"], img: "rolls", description: "Лосось, сливочный сыр и огурец, 8 штук" },
    ],
  },
  {
    category: "Десерты",
    img: "cheesecake",
    items: [
      { name: "Чизкейк Нью-Йорк", price: 390, weight: [150, "g"], img: "cheesecake", rank: 3,
        description: "Классический сливочный чизкейк", use: [["cheesecake", 1, "pcs"]] },
      { name: "Шоколадный фондан", price: 420, weight: [120, "g"], img: "fondant",
        description: "Тёплый, с жидкой серединкой и шариком мороженого" },
      { name: "Мороженое", price: 290, weight: [150, "g"], img: "ice-cream",
        description: "Три шарика: ваниль, шоколад и клубника" },
      { name: "Бельгийские вафли", price: 380, weight: [200, "g"], img: "waffles", description: "С ягодами и кленовым сиропом" },
      { name: "Пончики", price: 260, weight: [150, "g"], img: "donuts", description: "Два пончика в шоколадной глазури" },
    ],
  },
  {
    category: "Чай",
    img: "oolong",
    items: [
      { name: "Пуэр", price: 450, weight: [600, "ml"], img: "puer", rank: 5,
        description: "Выдержанный шу пуэр, заваривается в чайнике", use: [["puer", 8, "g"]] },
      { name: "Молочный улун", price: 450, weight: [600, "ml"], img: "oolong",
        description: "Мягкий улун со сливочным ароматом" },
      { name: "Облепиховый чай", price: 520, weight: [600, "ml"], img: "sea-buckthorn",
        description: "Облепиха, апельсин, мёд и розмарин" },
      { name: "Ягодный чай", price: 490, weight: [600, "ml"], img: "berry-tea",
        description: "Черника, малина, смородина и мята" },
      { name: "Мате", price: 420, weight: [400, "ml"], img: "mate", description: "Бодрящий парагвайский чай в калебасе" },
    ],
  },
  {
    category: "Кофе",
    img: "cappuccino",
    items: [
      { name: "Капучино", price: 290, weight: [300, "ml"], img: "cappuccino", rank: 1,
        description: "Двойной эспрессо и плотная молочная пена", use: [["coffee", 18, "g"], ["milk", 180, "ml"]] },
      { name: "Латте", price: 320, weight: [400, "ml"], img: "latte",
        description: "Эспрессо и много нежного молока", use: [["coffee", 18, "g"], ["milk", 280, "ml"]] },
      { name: "Раф", price: 360, weight: [350, "ml"], img: "raf",
        description: "Эспрессо, сливки и ванильный сахар", use: [["coffee", 18, "g"]] },
      { name: "Американо", price: 220, weight: [250, "ml"], img: "americano",
        description: "Эспрессо с горячей водой", use: [["coffee", 18, "g"]] },
    ],
  },
  {
    category: "Лимонады",
    img: "lemonade",
    items: [
      { name: "Классический лимонад", price: 390, weight: [500, "ml"], img: "lemonade",
        description: "Лимон, лайм, мята и содовая", use: [["lemon", 80, "g"]] },
      { name: "Манго-маракуйя", price: 420, weight: [500, "ml"], img: "mango", rank: 2,
        description: "Пюре манго, маракуйя и лайм" },
      { name: "Клубника-базилик", price: 420, weight: [500, "ml"], img: "strawberry",
        description: "Клубника, базилик и лимонный сок" },
      { name: "Мохито безалкогольный", price: 390, weight: [500, "ml"], img: "mojito",
        description: "Лайм, мята, тростниковый сахар и содовая" },
      { name: "Арбузный лимонад", price: 420, weight: [500, "ml"], img: "watermelon", description: "Свежий арбуз, лайм и мята" },
    ],
  },
  {
    category: "Милкшейки и смузи",
    img: "banana-shake",
    items: [
      { name: "Банановый милкшейк", price: 390, weight: [400, "ml"], img: "banana-shake", description: "Банан, мороженое и молоко" },
      { name: "Ванильный милкшейк", price: 370, weight: [400, "ml"], img: "vanilla-shake", description: "Пломбир, ваниль и взбитые сливки" },
      { name: "Смузи киви-шпинат", price: 420, weight: [400, "ml"], img: "kiwi-smoothie", description: "Киви, шпинат, яблоко и мёд" },
      { name: "Вишнёвый смузи", price: 420, weight: [400, "ml"], img: "cherry-smoothie", description: "Вишня, банан и йогурт" },
    ],
  },
  {
    category: "Снеки",
    img: "popcorn",
    items: [
      { name: "Орешки", price: 300, weight: [100, "g"], img: "nuts", description: "Кешью, миндаль и фундук" },
      { name: "Фруктовая тарелка", price: 700, weight: [600, "g"], img: "fruit", description: "Сезонные фрукты и ягоды" },
      { name: "Попкорн", price: 250, weight: [80, "g"], img: "popcorn", description: "Солёный или карамельный" },
      { name: "Печенье с шоколадом", price: 190, weight: [90, "g"], img: "cookies", description: "Домашнее, три штуки" },
    ],
  },
  {
    category: "Напитки",
    img: "cola",
    items: [
      { name: "Вода негазированная", price: 150, weight: [500, "ml"], img: "water", use: [["water", 1, "pcs"]] },
      { name: "Кола", price: 250, weight: [330, "ml"], img: "cola", description: "Классическая, в стекле", use: [["cola", 1, "pcs"]] },
      { name: "Сок яблочный", price: 220, weight: [300, "ml"], img: "apple-juice", description: "Прямого отжима" },
      { name: "Морс клюквенный", price: 250, weight: [400, "ml"], img: "mors", description: "Домашний, из клюквы и брусники" },
    ],
  },
];

// PIN-коды нарочно простые, они же написаны на лендинге у демо-APK.
// Длина по роли (AppConstants.pinLengthForRole): 4 цифры у сотрудника, 6 у
// администратора.
const DEMO_STAFF = [
  { key: "admin", name: "Демо-админ", pinCode: "111111", role: "admin", position: "universal" },
  { key: "hookah", name: "Максим", pinCode: "1111", role: "employee", position: "hookah_master",
    hourlyRateEnabled: true, hourlyRate: 250, salesPercentEnabled: true, hookahPercentRate: 10 },
  { key: "waiter", name: "Алина", pinCode: "2222", role: "employee", position: "waiter",
    shiftRateEnabled: true, shiftRate: 2000, salesPercentEnabled: true, salesPercentRate: 3, checkPercentExcludesHookah: true },
  { key: "bar", name: "Денис", pinCode: "3333", role: "employee", position: "bartender",
    hourlyRateEnabled: true, hourlyRate: 220, salesPercentEnabled: true, barPercentRate: 5 },
];

// Вторая точка демо-сети: свои сотрудники и PIN-коды — видно, что PIN одной
// точки в другой не подходит. PIN администратора — 6 цифр, как везде.
const DEMO_STAFF_RIVER = [
  { key: "admin", name: "Демо-админ «Набережной»", pinCode: "222222", role: "admin", position: "universal" },
  { key: "hookah", name: "Артём", pinCode: "4444", role: "employee", position: "hookah_master",
    hourlyRateEnabled: true, hourlyRate: 260, salesPercentEnabled: true, hookahPercentRate: 10 },
  { key: "waiter", name: "Вика", pinCode: "5555", role: "employee", position: "waiter",
    shiftRateEnabled: true, shiftRate: 2200, salesPercentEnabled: true, salesPercentRate: 3, checkPercentExcludesHookah: true },
  { key: "bar", name: "Олег", pinCode: "6666", role: "employee", position: "bartender",
    hourlyRateEnabled: true, hourlyRate: 230, salesPercentEnabled: true, barPercentRate: 5 },
];

/** PIN-коды для подсказки на экранах входа кассы (tenants.demoPins). */
/** Хэш PIN сотрудника — тот же расчёт, что PinHash в кассе
 *  (lib/utils/pin_hash.dart) и hashEmployeePin в кабинете. */
function pinHashFor(pin, tenantId) {
  return crypto.pbkdf2Sync(String(pin), `zalpos-pin:${tenantId}`, 20000, 32, "sha256").toString("hex");
}

function demoPinsOf(staff) {
  const pin = (key) => staff.find((e) => e.key === key)?.pinCode || "";
  return { admin: pin("admin"), hookah: pin("hookah"), waiter: pin("waiter"), bar: pin("bar") };
}

// Смена открыта столько минут назад — в неё попадают все закрытые чеки
// ниже, и X-отчёт сразу показывает выручку, наличные и чаевые.
const DEMO_SHIFT_OPENED_MINUTES_AGO = 360;

// Категории демо-меню, позиции которых — бар и напитки (процент бармену).
const DEMO_BAR_CATEGORIES = new Set(["Чай", "Кофе", "Лимонады", "Милкшейки и смузи", "Напитки"]);

// Закрытые за смену чеки: [стол, открыт (мин назад), закрыт, кто вёл,
// оплата, позиции [название, кол-во], чаевые].
const DEMO_CLOSED_RECEIPTS = [
  ["Стол 3", 340, 280, "hookah", "cash", [["Классический кальян", 1], ["Пуэр", 1], ["Орешки", 1]], { cash: 200 }],
  ["Стол 11", 330, 290, "waiter", "card", [["Сырники со сметаной", 2], ["Капучино", 2], ["Бельгийские вафли", 1]]],
  ["Стол 5", 310, 230, "hookah", "card", [["Кальян на молоке", 1], ["Манго-маракуйя", 2], ["Картофель фри", 1]], { card: 300 }],
  ["Бар", 290, 260, "bar", "cash", [["Раф", 1], ["Латте", 1]]],
  ["Стол 9", 280, 170, "hookah", "mixed", [["Классический кальян", 2], ["Перезабивка", 1], ["Пицца Маргарита", 1], ["Классический лимонад", 3]]],
  ["Кабинет 2", 260, 150, "waiter", "card", [["Кальян на грейпфруте", 1], ["Бургер с говядиной", 2], ["Цезарь с курицей", 1], ["Облепиховый чай", 1]], { card: 500, team: true }],
  ["Стол 4", 200, 130, "waiter", "card", [["Том ям с креветками", 1], ["Паста карбонара", 1], ["Бургер с говядиной", 1], ["Кола", 2]]],
  ["Стол 15", 180, 95, "hookah", "cash", [["Классический кальян", 1], ["Молочный улун", 1], ["Фруктовая тарелка", 1]]],
  ["Стол 2", 140, 70, "waiter", "card", [["Манго-маракуйя", 1], ["Клубника-базилик", 1], ["Шоколадный фондан", 1]], { card: 150 }],
  ["Стол 10", 120, 45, "hookah", "card", [["Кальян на молоке", 1], ["Капучино", 2], ["Сырные палочки", 1]]],
];

// Столы, занятые прямо сейчас. Время подобрано так, чтобы в зале были все
// состояния: Стол 6 — «скоро освободится», Диван 8 — «время вышло», на
// баре два отдельных чека, в VIP-кабинете — скидка по карте. refills — перезабивки
// (минут назад).
const DEMO_ACTIVE_SESSIONS = [
  { table: "Стол 1", tag: "Аня", start: 25, duration: 90, staff: "hookah", client: "demo-guest-1",
    items: [["Кальян на молоке", 1], ["Манго-маракуйя", 2]], refills: [10] },
  { table: "Стол 6", tag: "Компания у окна", start: 80, duration: 90, staff: "hookah",
    items: [["Классический кальян", 2], ["Пицца Маргарита", 1], ["Пуэр", 2]], refills: [55, 30] },
  { table: "Диван 8", tag: "День рождения", start: 100, duration: 90, staff: "waiter",
    items: [["Кальян на грейпфруте", 2], ["Фруктовая тарелка", 1], ["Чизкейк Нью-Йорк", 3], ["Классический лимонад", 4]], refills: [70, 40] },
  { table: "Кабинет 1", tag: "Банкет", start: 40, duration: 180, staff: "waiter", card: "0001",
    items: [["Классический кальян", 3], ["Стейк рибай", 2], ["Роллы Филадельфия", 2], ["Цезарь с курицей", 2], ["Капучино", 4]] },
  { table: "Стол 12", tag: "Олег", start: 15, duration: 90, staff: "waiter",
    items: [["Раф", 2], ["Сырные палочки", 1]] },
  { table: "Стол 17", tag: "Компания", start: 35, duration: 120, staff: "hookah",
    items: [["Кальян на молоке", 2], ["Ягодный чай", 2], ["Фруктовая тарелка", 1]], refills: [10] },
  { table: "Лаунж 4", tag: "Студенты", start: 50, duration: 120, staff: "waiter",
    items: [["Кальян на ананасе", 1], ["Куриные крылья BBQ", 2], ["Картофель фри", 2], ["Банановый милкшейк", 3]], refills: [20] },
  { table: "Бар", tag: "Кирилл", start: 30, duration: 60, staff: "bar", items: [["Кола", 1], ["Попкорн", 1]] },
  { table: "Бар", tag: "Двое справа", start: 5, duration: 60, staff: "bar", items: [["Мохито безалкогольный", 2]] },
];

// Гости с профилем в приложении — по одному на каждый уровень бонусной
// программы (Бронза … Алмаз). Телефонов нет: в настоящей работе они лежат
// на сервере в РФ, а не в Firestore.
const DEMO_CLIENTS = [
  { uid: "demo-guest-1", name: "Анна", totalSpent: 8200, visits: 6, bonusBalance: 410, lastVisitDays: 0, sinceDays: 60 },
  { uid: "demo-guest-2", name: "Игорь", totalSpent: 14500, visits: 11, bonusBalance: 1450, lastVisitDays: 6, sinceDays: 150 },
  { uid: "demo-guest-3", name: "Мария", totalSpent: 31800, visits: 19, bonusBalance: 2300, lastVisitDays: 3, sinceDays: 240 },
  { uid: "demo-guest-4", name: "Сергей", totalSpent: 56000, visits: 34, bonusBalance: 4100, lastVisitDays: 9, sinceDays: 320 },
  { uid: "demo-guest-5", name: "Ольга", totalSpent: 112000, visits: 61, bonusBalance: 9800, lastVisitDays: 2, sinceDays: 420 },
];

function seedDemoData(tenantRef, batch, nowMs, { staffList = DEMO_STAFF, loyaltyRef = null, seedClients = true, venueName = "Демо-заведение", address = "Москва, ул. Примерная, 1" } = {}) {
  const col = (name) => tenantRef.collection(name);
  // Точка сети: гости и бонусы общие на сеть (chains/{chainId}/clients).
  const loyaltyCol = (name) => (loyaltyRef || tenantRef).collection(name);
  const ts = (minutesAgo) => admin.firestore.Timestamp.fromMillis(nowMs - minutesAgo * 60000);
  const image = (slug) => (slug ? new URL(`demo-menu/${slug}.jpg`, CONSOLE_URL).href : "");

  // Склад
  const stockIds = {};
  DEMO_STOCK.forEach(([key, name, category, unit, quantity, minQuantity]) => {
    const ref = col("inventoryItems").doc();
    stockIds[key] = ref.id;
    batch.set(ref, {
      name, category, unit, quantity, minQuantity,
      active: true, note: "", updatedAt: ts(30), isMarked: false, gtin: "",
    });
  });

  // Меню
  const menuByName = {};
  const categoryIds = {};
  DEMO_MENU.forEach((cat, ci) => {
    const catRef = col("menuCategories").doc();
    categoryIds[cat.category] = catRef.id;
    batch.set(catRef, { name: cat.category, order: ci, imageUrl: image(cat.img) });
    cat.items.forEach((item) => {
      const ref = col("menuItems").doc();
      const tobacco = cat.tobacco === true;
      menuByName[item.name] = { id: ref.id, price: item.price, tobacco, kind: tobacco ? "hookah" : DEMO_BAR_CATEGORIES.has(cat.category) ? "bar" : "kitchen" };
      batch.set(ref, {
        categoryId: catRef.id,
        name: item.name,
        price: item.price,
        available: true,
        imageUrl: tobacco ? "" : image(item.img),
        description: tobacco ? "" : item.description || "",
        tobacco,
        popularRank: tobacco ? 0 : item.rank || 0,
        vat: "",
        fiscalSubject: "commodity",
        // Вес порции — только для показа гостю; со склада списывают components.
        weight: item.weight ? item.weight[0] : 0,
        weightUnit: item.weight ? item.weight[1] : "g",
        inventoryItemId: "",
        components: (item.use || []).map(([key, weight, weightUnit]) => ({
          inventoryItemId: stockIds[key], weight, weightUnit,
        })),
      });
    });
  });

  // Позиции чека как в приложении: табак помечен noPromo — на него не
  // действуют скидки (ст. 16 закона № 15-ФЗ). kind — вид продажи (кому
  // процент), by — кто добавил позицию: кальяны — кальянщик, напитки —
  // бармен, остальное — тот, кто вёл стол ([waiterId]; у заказов гостя и
  // предзаказов брони его нет — их ещё никто не принял).
  const orderItemsOf = (items, waiterId) => items.map(([name, qty]) => {
    const m = menuByName[name];
    const by = !waiterId ? null : m.kind === "hookah" ? staff.hookah.id : m.kind === "bar" ? staff.bar.id : waiterId;
    return {
      menuItemId: m.id, name, price: m.price, qty, kind: m.kind,
      ...(m.tobacco ? { noPromo: true } : {}),
      ...(by ? { by: { [by]: qty } } : {}),
    };
  });

  // Сотрудники
  const staff = {};
  staffList.forEach(({ key, pinCode, ...e }) => {
    const ref = col("employees").doc();
    staff[key] = { id: ref.id, name: e.name, position: e.position };
    batch.set(ref, {
      hourlyRateEnabled: false, hourlyRate: 0, shiftRateEnabled: false, shiftRate: 0,
      overtimeEnabled: false, salesPercentEnabled: false, salesPercentRate: 0, tipsLink: "",
      checkPercentExcludesHookah: false, hookahPercentRate: 0, barPercentRate: 0,
      ...e,
      // PIN в базе — только хэшем, как PinHash в кассе.
      pinHash: pinHashFor(pinCode, tenantRef.id),
    });
  });

  // Скидочные карты
  const cardIds = {};
  [
    { cardNumber: "0001", guestName: "Постоянный гость", discountPercent: 10, notes: "Скидка на кухню и напитки" },
    { cardNumber: "0002", guestName: "Сергей", discountPercent: 15, notes: "Карта друга заведения" },
  ].forEach((c) => {
    const ref = col("discountCards").doc();
    cardIds[c.cardNumber] = { id: ref.id, percent: c.discountPercent };
    batch.set(ref, { ...c, active: true });
  });

  // Профиль заведения: без часов работы гостевая бронь была бы недоступна
  // (каждый день «закрыто»), а без имени ИИ-помощник не знал бы, как
  // называется заведение.
  const demoHours = {};
  for (let d = 1; d <= 7; d++) demoHours[String(d)] = "12:00-02:00";
  batch.set(col("meta").doc("venueProfile"), {
    name: venueName,
    address,
    phone: "+7 900 000-00-00",
    about: "Лаундж-бар: основной зал, летняя терраса и второй этаж с VIP-кабинетами. Тестовое заведение платформы — все данные вымышленные.",
    workingHours: demoHours,
    faq: [
      { q: "Можно ли прийти с детьми?", a: "Да, до 18:00." },
      { q: "Есть ли парковка?", a: "Бесплатная парковка во дворе." },
      { q: "Можно со своим тортом?", a: "Да, сервисный сбор — 300 ₽." },
    ],
    rules: "Бронь держим 15 минут. Продажа табачной продукции — только лицам старше 18 лет.",
    venueType: "hookah",
    tipsEnabled: true,
    tipsTeamEnabled: true,
  });

  // Смена кассы и личные смены сотрудников
  const shiftRef = col("shifts").doc();
  batch.set(shiftRef, {
    openedAt: ts(DEMO_SHIFT_OPENED_MINUTES_AGO), closedAt: null,
    openedBy: staff.admin.name, openedById: staff.admin.id, closedBy: null,
    status: "open", openingCash: 5000,
  });
  batch.set(col("meta").doc("shiftState"), { openShiftId: shiftRef.id });
  ["hookah", "waiter"].forEach((key) => {
    batch.set(col("staffShifts").doc(), {
      employeeId: staff[key].id, employeeName: staff[key].name,
      startedAt: ts(DEMO_SHIFT_OPENED_MINUTES_AGO - 5), endedAt: null, status: "open", manual: false,
    });
  });

  DEMO_WALLS.forEach((w) => {
    batch.set(col("hallWalls").doc(), { zone: w.zone, points: w.points.flat(), closed: false, createdAt: ts(60 * 24) });
  });
  DEMO_LABELS.forEach((l) => {
    batch.set(col("hallLabels").doc(), { ...l, createdAt: ts(60 * 24) });
  });

  const tables = {};
  DEMO_TABLES.forEach((t) => {
    tables[t.name] = { ref: col("tables").doc(), config: t, checks: [] };
  });

  const sessionBase = {
    refillCount: 0, refillHistory: [], discountCardId: null, discountPercent: 0,
    paymentCash: 0, paymentCard: 0, paymentTerminal: 0, paymentComp: 0,
    guestContact: "", closedWithoutPayment: false, receiptPrinted: false, fiscalReceiptPrinted: false,
    tipsCash: 0, tipsCard: 0, refunded: false, refundedAt: null, refundCashOut: false,
  };

  // Открытые чеки — стол переходит в «занят» (status/activeSessionIds/
  // busyUntil/openChecks) так же, как это делает FirestoreService.openSession.
  const activeSessionIds = {};
  const clientAtTable = {};
  DEMO_ACTIVE_SESSIONS.forEach((s) => {
    const table = tables[s.table];
    const ref = col("sessions").doc();
    const startTime = ts(s.start);
    const plannedEnd = ts(s.start - s.duration);
    const card = s.card ? cardIds[s.card] : null;
    batch.set(ref, {
      ...sessionBase,
      tableId: table.ref.id,
      tableName: s.table,
      employeeName: staff[s.staff].name,
      employeeId: staff[s.staff].id,
      guestTag: s.tag,
      startTime,
      plannedEnd,
      refillCount: (s.refills || []).length,
      refillHistory: (s.refills || []).map((m) => ({ time: ts(m) })),
      discountCardId: card ? card.id : null,
      discountPercent: card ? card.percent : 0,
      orderItems: orderItemsOf(s.items, staff[s.staff].id),
      status: "active",
      closedAt: null,
    });
    activeSessionIds[s.table] = activeSessionIds[s.table] || ref.id;
    table.checks.push({ id: ref.id, label: s.tag, openedAt: startTime, plannedEnd });
    if (s.client) clientAtTable[s.client] = { sessionId: ref.id, tableId: table.ref.id };
  });

  // Закрытые за смену чеки и чаевые по ним
  const closedIds = [];
  DEMO_CLOSED_RECEIPTS.forEach(([tableName, start, end, staffKey, pay, items, tips]) => {
    const ref = col("sessions").doc();
    closedIds.push({ id: ref.id, tableName, end });
    const orderItems = orderItemsOf(items, staff[staffKey].id);
    const total = orderItems.reduce((acc, i) => acc + i.price * i.qty, 0);
    const cash = pay === "cash" ? total : pay === "mixed" ? Math.round(total / 200) * 100 : 0;
    const who = staff[staffKey];
    batch.set(ref, {
      ...sessionBase,
      tableId: tables[tableName].ref.id,
      tableName,
      employeeName: who.name,
      employeeId: who.id,
      guestTag: "",
      startTime: ts(start),
      plannedEnd: ts(start - 90),
      orderItems,
      status: "closed",
      closedAt: ts(end),
      paymentCash: cash,
      paymentCard: total - cash,
      receiptPrinted: true,
      tipsCash: (tips && tips.cash) || 0,
      tipsCard: (tips && tips.card) || 0,
    });
    if (tips) {
      const amount = (tips.cash || 0) + (tips.card || 0);
      const team = tips.team === true;
      batch.set(col("tips").doc(), {
        amount,
        target: team ? "team" : "employee",
        employeeId: team ? "" : who.id,
        employeeName: team ? "" : who.name,
        position: team ? "" : who.position,
        teamMembers: team ? [staff.hookah, staff.waiter].map((m) => ({ id: m.id, name: m.name })) : [],
        sessionId: ref.id,
        tableName,
        clientUid: "",
        comment: team ? "Спасибо всей команде!" : "",
        method: "bill",
        status: "paid",
        paidVia: tips.cash ? "cash" : "card",
        source: team ? "guest" : "pos",
        createdAt: ts(end),
        paidAt: ts(end),
      });
    }
  });

  Object.values(tables).forEach(({ ref, config: t, checks }) => {
    const { x, y } = demoTableFraction(t);
    const busyUntil = checks.reduce((max, c) => (!max || c.plannedEnd.toMillis() > max.toMillis() ? c.plannedEnd : max), null);
    batch.set(ref, {
      name: t.name,
      zone: t.zone,
      x,
      y,
      seats: t.seats,
      shape: t.shape,
      rotation: t.rotation || 0,
      status: checks.length ? "occupied" : "free",
      activeSessionIds: checks.map((c) => c.id),
      maxOpenSessions: t.maxOpenSessions || 2,
      busyUntil,
      openChecks: checks.map(({ id, label, openedAt }) => ({ id, label, openedAt })),
    });
  });

  // Гости с бонусами
  if (seedClients) DEMO_CLIENTS.forEach((c) => {
    const atTable = clientAtTable[c.uid];
    batch.set(loyaltyCol("clients").doc(c.uid), {
      name: c.name, phone: "", bonusBalance: c.bonusBalance, totalSpent: c.totalSpent, visits: c.visits,
      discountCardId: "", discountPercent: 0, lastVisitId: "", ratedVisitId: "",
      activeSessionId: atTable ? atTable.sessionId : "", activeTableId: atTable ? atTable.tableId : "",
      favoriteItemIds: [menuByName["Капучино"].id, menuByName["Чизкейк Нью-Йорк"].id],
      pushToken: "", aiProfile: "",
      createdAt: ts(c.sinceDays * 1440), lastVisitAt: ts(c.lastVisitDays * 1440 + 60),
    });
  });

  // Вызовы и заказ из приложения гостя — видны на плитках зала.
  batch.set(col("waiterCalls").doc(), {
    tableId: tables["Диван 8"].ref.id, tableName: "Диван 8", sessionId: activeSessionIds["Диван 8"],
    clientUid: "", guestName: "Гость", type: "bill", comment: "", status: "new",
    createdAt: ts(3), doneAt: null, doneBy: "",
  });
  batch.set(col("waiterCalls").doc(), {
    tableId: tables["Стол 1"].ref.id, tableName: "Стол 1", sessionId: activeSessionIds["Стол 1"],
    clientUid: "demo-guest-1", guestName: "Анна", type: "coal", comment: "", status: "new",
    createdAt: ts(1), doneAt: null, doneBy: "",
  });
  batch.set(col("guestOrders").doc(), {
    sessionId: activeSessionIds["Стол 1"], tableId: tables["Стол 1"].ref.id, tableName: "Стол 1",
    clientUid: "demo-guest-1", guestName: "Анна",
    items: orderItemsOf([["Чизкейк Нью-Йорк", 1], ["Латте", 1]]),
    comment: "Латте на овсяном, если можно", status: "new", rejectReason: "",
    createdAt: ts(2), handledAt: null, handledBy: "",
  });

  // Брони: две в ближайшие два часа (стол подсвечен «Бронь»), одна новая
  // заявка из приложения ждёт подтверждения, две — на завтра.
  const msk = new Date(nowMs + 3 * 3600000);
  const tomorrowAt = (hour) =>
    admin.firestore.Timestamp.fromMillis(
      Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() + 1, hour - 3, 0)
    );
  const inMinutes = (m) => ts(-m);
  [
    { guestName: "Мария", clientUid: "demo-guest-3", guestsCount: 4, table: "Стол 7", startTime: inMinutes(45),
      status: "confirmed", source: "kolibri", guestConfirmed: true, comment: "Отмечаем повышение",
      preOrder: [["Манго-маракуйя", 2], ["Фруктовая тарелка", 1]] },
    { guestName: "Игорь", clientUid: "demo-guest-2", guestsCount: 6, table: "Кабинет 2", startTime: inMinutes(90),
      durationMinutes: 180, status: "new", source: "kolibri", comment: "Будем с коллегами" },
    { guestName: "Екатерина", guestsCount: 2, table: "Стол 11", startTime: inMinutes(180),
      status: "confirmed", source: "pos", comment: "Столик у окна" },
    { guestName: "Сергей", clientUid: "demo-guest-4", guestsCount: 8, table: "Кабинет 3", startTime: tomorrowAt(19),
      status: "confirmed", source: "pos", comment: "" },
    { guestName: "Ольга", clientUid: "demo-guest-5", guestsCount: 3, table: "", startTime: tomorrowAt(21),
      status: "new", source: "kolibri", comment: "Если можно — у окна" },
  ].forEach((r) => {
    const confirmed = r.status === "confirmed";
    batch.set(col("reservations").doc(), {
      clientUid: r.clientUid || "",
      guestName: r.guestName,
      phone: "",
      guestsCount: r.guestsCount,
      tableId: r.table ? tables[r.table].ref.id : "",
      tableName: r.table,
      startTime: r.startTime,
      durationMinutes: r.durationMinutes || 120,
      status: r.status,
      comment: r.comment,
      source: r.source,
      preOrder: orderItemsOf(r.preOrder || []),
      aiNote: "",
      sessionId: "",
      guestConfirmed: r.guestConfirmed === true,
      createdAt: ts(240),
      confirmedAt: confirmed ? ts(200) : null,
      handledBy: confirmed ? staff.waiter.name : "",
    });
  });

  // Лист ожидания
  [
    { guestName: "Дмитрий", guestsCount: 3, promisedMinutes: 20, created: 12, source: "pos", comment: "Хотят в основной зал" },
    { guestName: "Светлана", guestsCount: 2, promisedMinutes: 15, created: 4, source: "kolibri", comment: "" },
  ].forEach((w) => {
    batch.set(col("waitlist").doc(), {
      guestName: w.guestName, phone: "", clientUid: "", guestsCount: w.guestsCount, comment: w.comment,
      status: "waiting", promisedMinutes: w.promisedMinutes, createdAt: ts(w.created), invitedAt: null, source: w.source,
    });
  });

  // Отзывы гостей — к закрытым чекам этой смены.
  [
    [0, "demo-guest-3", "Мария", 5, "Очень уютно, чай пуэр — лучший в городе!"],
    [2, "demo-guest-5", "Ольга", 5, "Отличный сервис, Максим всё подсказал."],
    [5, "demo-guest-2", "Игорь", 4, "Вкусные бургеры, но хотелось бы потише музыку."],
    [6, "", "Гость", 3, "Долго ждали заказ, но потом всё исправили."],
  ].forEach(([i, clientUid, guestName, rating, text]) => {
    batch.set(col("reviews").doc(), {
      sessionId: closedIds[i].id, clientUid, guestName, rating, text, aiSummary: "", createdAt: ts(closedIds[i].end - 10),
    });
  });

  // Истории в приложении гостя и счастливые часы. Без табака: истории —
  // это уже реклама.
  [
    { title: "Счастливые часы", text: "По будням с 14:00 до 17:00 — скидка 20% на горячее, закуски, бургеры, пиццу и десерты.",
      img: "burger", action: "menu", actionLabel: "Открыть меню", menuItemId: "" },
    { title: "Новинка — облепиховый чай", text: "Облепиха, апельсин, мёд и розмарин — согреет в любую погоду.",
      img: "sea-buckthorn", action: "menu", actionLabel: "Попробовать", menuItemId: menuByName["Облепиховый чай"].id },
  ].forEach((s, order) => {
    batch.set(col("stories").doc(), {
      title: s.title, text: s.text, imageUrl: image(s.img), action: s.action, actionLabel: s.actionLabel,
      menuItemId: s.menuItemId, published: true, byAi: false, createdAt: ts(600 - order), publishUntil: null, order,
    });
  });
  batch.set(col("happyHours").doc(), {
    title: "Счастливые часы",
    weekdays: [1, 2, 3, 4, 5],
    fromMinutes: 14 * 60,
    toMinutes: 17 * 60,
    discountPercent: 20,
    categoryIds: ["Горячее", "Пицца и хачапури", "Бургеры и сэндвичи", "Закуски", "Десерты"].map((c) => categoryIds[c]),
    active: true,
  });

  batch.set(col("staffNotes").doc(), {
    title: "На вечер",
    text: "Банкет на 2 этаже: подготовить Кабинет 2 к приходу гостей. Табак (ассорти) на исходе — дозаказать.",
    priority: "info",
    source: "manual",
    createdAt: ts(20),
    read: false,
  });
}

/**
 * Одноразовое демо-заведение без владельца: сразу отдаём tenantId и код
 * приглашения, клиент присоединяется как обычное устройство
 * (SaasDeviceJoinService.joinAsDevice). По флагу demo его потом удаляет
 * scheduleDemoCleanup.
 */
/**
 * Демо — сеть из двух точок одного заведения («Центр» и «Набережная»):
 * касса показывает выбор точки при входе, у каждой точки свои сотрудники и
 * PIN-коды, гости и бонусы — общие на сеть. Приложение гостя открывает ту
 * же сеть по коду демо (chainSlug), который касса показывает на экране
 * входа. Через DEMO_TTL_MS сеть стирается целиком.
 */
async function handleCreateDemoTenant(req, res) {
  try {
    checkDemoRateLimit(clientIp(req));
  } catch (e) {
    recordSignupEvent(req, "rateLimited", {});
    throw e;
  }
  await requireNotBlocked(req, null, "demo");

  const firestore = db();
  const chainSlug = `demo-${randomDemoSuffix()}`;
  const chainRef = firestore.collection("chains").doc();
  const chainId = chainRef.id;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const nowMs = Date.now();
  const expiresAt = admin.firestore.Timestamp.fromMillis(nowMs + DEMO_TTL_MS);
  const branding = {
    appName: "ZalPOS (демо)",
    shortName: "Демо",
    primaryColor: "#B35C30",
    secondaryColor: "#CFA567",
    accentColor: "#B35C30",
    backgroundColor: "#15120F",
    textColor: "#F2EADF",
    buttonColor: "#B35C30",
    darkMode: true,
  };

  const head = firestore.batch();
  head.set(chainRef, {
    name: "Демо-сеть", slug: chainSlug, status: "active", planId: "chain", ownerUserId: "",
    demo: true, demoExpiresAt: expiresAt, createdAt: now, updatedAt: now,
  });
  head.set(chainRef.collection("branding").doc("config"), branding);
  head.set(firestore.collection("subscriptions").doc(chainId), {
    chainId, planId: "chain", status: "trial", provider: null, externalSubscriptionId: null,
    startedAt: now, trialEndsAt: admin.firestore.Timestamp.fromMillis(nowMs + 7 * 86400000),
    currentPeriodStart: now, currentPeriodEnd: null, cancelAtPeriodEnd: false,
  });
  await head.commit();

  const points = [
    { key: "center", name: "Демо · Центр", address: "Москва, ул. Примерная, 1", staffList: DEMO_STAFF },
    { key: "river", name: "Демо · Набережная", address: "Москва, Набережная ул., 7", staffList: DEMO_STAFF_RIVER },
  ];
  const created = [];
  for (const point of points) {
    const tenantRef = firestore.collection("tenants").doc();
    const inviteCode = randomInviteCode();
    const batch = firestore.batch();
    batch.set(tenantRef, {
      name: point.name,
      slug: `${chainSlug}-${point.key}`,
      status: "active",
      subscriptionStatus: "active",
      planId: "start",
      ownerUserId: "",
      chainId,
      demo: true,
      // Код демо для приложения гостя и PIN-коды точки — подсказки кассы.
      demoCode: chainSlug,
      demoPins: demoPinsOf(point.staffList),
      // Когда демо сбросится — касса показывает обратный отсчёт.
      demoExpiresAt: expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    batch.set(tenantRef.collection("settings").doc("general"), {
      name: point.name, timezone: "Europe/Moscow", currency: "RUB", language: "ru",
    });
    batch.set(tenantRef.collection("settings").doc("session"), {
      defaultHookahDurationMinutes: 90,
      minimumHookahDurationMinutes: 30,
      maximumHookahDurationMinutes: 360,
      quickExtensions: [15, 30, 60],
    });
    batch.set(tenantRef.collection("branding").doc("config"), branding);
    batch.set(tenantRef.collection("settings").doc("deviceInvite"), { code: inviteCode, rotatedAt: now });
    seedDemoData(tenantRef, batch, nowMs, {
      staffList: point.staffList,
      // Гости и бонусы общие на сеть — записываем один раз, с первой точкой.
      loyaltyRef: chainRef,
      seedClients: created.length === 0,
      venueName: point.name,
      address: point.address,
    });
    await batch.commit();
    created.push({ tenantId: tenantRef.id, inviteCode });
  }

  recordSignupEvent(req, "demo", { tenantId: created[0].tenantId, chainId, slug: chainSlug });
  sendJson(res, 200, { tenantId: created[0].tenantId, inviteCode: created[0].inviteCode, chainId, chainSlug, slug: chainSlug });
}

// -------------------------------------------------------- demo cleanup

async function purgeDemoTenant(tenantId) {
  const firestore = db();
  const tenantRef = firestore.collection("tenants").doc(tenantId);
  const chainId = (await tenantRef.get()).data()?.chainId || null;
  for (const name of TENANT_SUBCOLLECTIONS) {
    await firestore.recursiveDelete(tenantRef.collection(name));
  }
  await tenantRef.delete();
  await firestore.collection("subscriptions").doc(tenantId).delete().catch(() => {});
  await removeTenantUploads(tenantId);
  // Демо-сеть: последняя точка ушла — стираем и сеть (гости, бонусы,
  // членства, подписку).
  if (chainId) {
    const chainRef = firestore.collection("chains").doc(chainId);
    const chain = (await chainRef.get()).data();
    const left = await firestore.collection("tenants").where("chainId", "==", chainId).limit(1).get();
    if (chain?.demo === true && left.empty) {
      for (const name of CHAIN_SUBCOLLECTIONS) {
        await firestore.recursiveDelete(chainRef.collection(name));
      }
      const members = await firestore.collection("chainMembers").where("chainId", "==", chainId).get();
      for (const d of members.docs) await d.ref.delete();
      await chainRef.delete();
      await firestore.collection("subscriptions").doc(chainId).delete().catch(() => {});
    }
  }
}

// ----------------------------------------- super-admin: enable/disable/plan

// Модерация из панели платформы.
async function handleDisableTenant(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { tenantId, reason } = await parseJsonBody(req);
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");
  await db().collection("tenants").doc(tenantId).update({
    status: "suspended",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await writeAuditLog({
    tenantId, actorId: decoded.uid, action: "tenantSuspended", metadata: { reason: reason || null },
  });
  await writeSecurityEvent(req, decoded, "tenantSuspended", {
    tenantId, metadata: { ...(await tenantLabel(tenantId)), reason: reason || null },
  });
  sendJson(res, 200, { ok: true });
}

async function handleEnableTenant(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { tenantId } = await parseJsonBody(req);
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");
  const tenantRef = db().collection("tenants").doc(tenantId);
  const tenant = (await tenantRef.get()).data();
  if (!tenant) throw new HttpError(404, "Заведение не найдено");
  // Возвращаем статус подписки: разблокированный триал не должен стать
  // «active» и попасть в MRR. У точки сети статус всегда active.
  let status = "active";
  if (!tenant.chainId) {
    const sub = (await db().collection("subscriptions").doc(tenantId).get()).data();
    if (sub && ["trial", "active", "past_due"].includes(sub.status)) status = sub.status;
  }
  await tenantRef.update({ status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  await writeAuditLog({ tenantId, actorId: decoded.uid, action: "tenantEnabled" });
  await writeSecurityEvent(req, decoded, "tenantEnabled", { tenantId, metadata: await tenantLabel(tenantId) });
  sendJson(res, 200, { ok: true });
}

async function handleChangeTenantPlan(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { tenantId, planId } = await parseJsonBody(req);
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");
  if (typeof planId !== "string" || !planId) throw new HttpError(400, "Не указан тариф");

  const planDoc = await db().collection("plans").doc(planId).get();
  if (!planDoc.exists) throw new HttpError(404, "Тариф не найден");

  const firestore = db();
  const tenantRef = firestore.collection("tenants").doc(tenantId);
  const before = (await tenantRef.get()).data();
  if (!before) throw new HttpError(404, "Заведение не найдено");
  // Тариф точки сети — это тариф всей сети; заглушка planId у точки биллинг
  // не отражает. Подписке тоже ставим новый тариф — по ней идёт продление.
  const chainId = before.chainId || null;
  if (!!planDoc.data().isChainPlan !== !!chainId) {
    throw new HttpError(412, chainId ? "Точке сети подходит только тариф сети — он меняется у всей сети" : "Тариф сети — только для сети заведений");
  }
  const now = admin.firestore.FieldValue.serverTimestamp();
  await firestore.collection(chainId ? "chains" : "tenants").doc(chainId || tenantId).set({ planId, updatedAt: now }, { merge: true });
  const subRef = firestore.collection("subscriptions").doc(chainId || tenantId);
  if ((await subRef.get()).exists) await subRef.set({ planId }, { merge: true });
  await syncCapabilities(chainId ? { chainId } : { tenantId });
  await writeAuditLog({
    tenantId, actorId: decoded.uid, action: "planChangedBySuperAdmin", metadata: { planId },
  });
  await writeSecurityEvent(req, decoded, "planChangedBySuperAdmin", {
    tenantId, metadata: { ...(await tenantLabel(tenantId, before)), fromPlanId: before.planId || null, planId, chainId },
  });
  sendJson(res, 200, { ok: true });
}

/** Статус подписки дублируется в документе заведения (или сети) — его
 *  читают консоль и приложения. Приостановленное вручную не трогаем. */
async function syncBillingOwnerStatus(chainId, billingId, subStatus) {
  if (!["trial", "active", "past_due"].includes(subStatus)) return;
  const ref = db().collection(chainId ? "chains" : "tenants").doc(billingId);
  const cur = (await ref.get()).data();
  if (!cur || cur.status === "suspended" || cur.status === "deleted") return;
  await ref.set({ status: subStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

/**
 * «Дать ещё N дней» из панели платформы. Триалу продлевает trialEndsAt,
 * остальным — currentPeriodEnd и снимает блокировку. Считаем от
 * max(дата окончания, сейчас), иначе бонус просроченному заведению сгорел
 * бы в прошлом. У точки сети продлевается подписка всей сети.
 */
async function handleGrantBonusPeriod(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { tenantId, days } = await parseJsonBody(req);
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");
  const daysNum = Number(days);
  if (!Number.isFinite(daysNum) || daysNum <= 0 || daysNum > 365) {
    throw new HttpError(400, "Число дней должно быть от 1 до 365");
  }

  const tenantDoc = await db().collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) throw new HttpError(404, "Заведение не найдено");
  const chainId = tenantDoc.data().chainId || null;
  const billingId = chainId || tenantId;

  const subRef = db().collection("subscriptions").doc(billingId);
  const subDoc = await subRef.get();
  if (!subDoc.exists) throw new HttpError(404, "Подписка не найдена");
  const sub = subDoc.data();
  const bonusMs = daysNum * 86400000;
  const now = Date.now();

  const update = {};
  if (sub.status === "trial") {
    const base = Math.max(sub.trialEndsAt ? sub.trialEndsAt.toMillis() : now, now);
    update.trialEndsAt = admin.firestore.Timestamp.fromMillis(base + bonusMs);
  } else {
    const base = Math.max(sub.currentPeriodEnd ? sub.currentPeriodEnd.toMillis() : now, now);
    update.currentPeriodEnd = admin.firestore.Timestamp.fromMillis(base + bonusMs);
    update.status = "active";
    update.pastDueSince = null;
  }
  await subRef.update(update);
  if (update.status) await syncBillingOwnerStatus(chainId, billingId, update.status);
  await writeAuditLog({
    tenantId, actorId: decoded.uid, action: "bonusPeriodGranted", metadata: { days: daysNum, chainId },
  });
  await writeSecurityEvent(req, decoded, "bonusPeriodGranted", {
    tenantId, metadata: { ...(await tenantLabel(tenantId, tenantDoc.data())), days: daysNum, chainId },
  });
  sendJson(res, 200, { ok: true, chainId });
}

/**
 * Удаление демо-заведения вручную, не дожидаясь DEMO_TTL_MS. Только демо:
 * удаление рекурсивное и необратимое, по случайному клику нельзя снести
 * данные настоящего заведения.
 */
async function handleDeleteDemoTenant(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { tenantId } = await parseJsonBody(req);
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");

  const tenantDoc = await db().collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) throw new HttpError(404, "Заведение не найдено");
  if (tenantDoc.data().demo !== true) {
    throw new HttpError(400, "Удалить вручную можно только демо-заведение");
  }

  await purgeDemoTenant(tenantId);
  await writeAuditLog({ tenantId, actorId: decoded.uid, action: "demoTenantDeletedBySuperAdmin" });
  await writeSecurityEvent(req, decoded, "demoTenantDeletedBySuperAdmin", {
    tenantId, metadata: await tenantLabel(tenantId, tenantDoc.data()),
  });
  sendJson(res, 200, { ok: true });
}

// ------------------------------------------------ бэкап заведения или сети
//
// Кнопка «Скачать бэкап» в кабинете (владелец — своё заведение или сеть) и
// в панели платформы (супер-админ — любое). Формат тот же, что у ночной
// копии всей базы (format: 1, docs: путь → данные), поэтому одно заведение
// восстанавливается тем же restore-backup.js. Чтения идут из общей квоты
// базы — из кабинета большие заведения не выгружаем целиком, а просим
// написать нам; супер-админ в панели платформы выгружает без ограничения.
const EXPORT_MAX_DOCS = Math.max(100, Number(process.env.EXPORT_MAX_DOCS) || 15000);
// Владелец скачивает бэкап заведения (или сети) не чаще раза в 3 дня:
// каждая выгрузка — тысячи чтений из общей квоты базы. Когда была
// последняя — backupExports/{tenant_|chain_}{id}, только для сервера (в
// firestore.rules правила для неё нет — клиентам закрыта). Супер-админа
// ограничение не касается.
const EXPORT_OWNER_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
// Вложенные коллекции внутри коллекций заведения и сети (см. firestore.rules).
const EXPORT_NESTED = { clients: ["visits"] };

class ExportTooLarge extends HttpError {
  constructor(count) {
    super(413, `В копии больше ${EXPORT_MAX_DOCS} документов (${count}) — напишите в поддержку, выгрузим с сервера`);
  }
}

/** Документ со всеми вложенными коллекциями — в docs (путь → данные).
 *  [limit] — сколько документов всего можно выгрузить. */
async function exportDocTree(ref, docs, limit) {
  const snap = await ref.get();
  if (snap.exists) docs[ref.path] = serializeFirestoreValue(snap.data());
  for (const col of await ref.listCollections()) {
    const all = await col.get();
    if (Object.keys(docs).length + all.size > limit) throw new ExportTooLarge(Object.keys(docs).length + all.size);
    all.docs.forEach((d) => { docs[d.ref.path] = serializeFirestoreValue(d.data()); });
    const nested = EXPORT_NESTED[col.id] || [];
    for (let i = 0; nested.length && i < all.docs.length; i += 20) {
      await Promise.all(all.docs.slice(i, i + 20).map(async (d) => {
        for (const name of nested) {
          const sub = await d.ref.collection(name).get();
          sub.docs.forEach((x) => { docs[x.ref.path] = serializeFirestoreValue(x.data()); });
        }
      }));
      if (Object.keys(docs).length > limit) throw new ExportTooLarge(Object.keys(docs).length);
    }
  }
}

/** Корневые документы, которые относятся к заведению или сети по полю. */
async function exportWhere(collection, field, value, docs) {
  const snap = await db().collection(collection).where(field, "==", value).get();
  snap.docs.forEach((d) => { docs[d.ref.path] = serializeFirestoreValue(d.data()); });
}

async function exportTenant(tenantId, docs, limit) {
  const firestore = db();
  await exportDocTree(firestore.collection("tenants").doc(tenantId), docs, limit);
  const sub = await firestore.collection("subscriptions").doc(tenantId).get();
  if (sub.exists) docs[sub.ref.path] = serializeFirestoreValue(sub.data());
  await exportWhere("tenantMembers", "tenantId", tenantId, docs);
  await exportWhere("billingInvoices", "tenantId", tenantId, docs);
  await exportWhere("bankInvoices", "tenantId", tenantId, docs);
}

async function handleExportBackup(req, res) {
  const decoded = await verifyAuth(req);
  const { tenantId, chainId, unlimited } = await parseJsonBody(req);
  const id = typeof chainId === "string" && chainId ? chainId : typeof tenantId === "string" ? tenantId : "";
  if (!id || id.includes("/")) throw new HttpError(400, "Не указано заведение или сеть");
  const isChain = id === chainId;
  // Свои данные выгружает владелец; чужие — только супер-админ и только
  // сразу после ввода пароля: в файле телефоны и бонусы гостей.
  let superAdmin = false;
  // Без ограничения по числу документов — только из панели платформы.
  if (unlimited === true) {
    await requireSuperAdmin(decoded);
    requireRecentAuth(decoded);
    superAdmin = true;
  } else {
    try {
      if (isChain) await requireChainRole(id, decoded.uid, ["owner"]);
      else {
        // Точку сети выгружает и владелец сети.
        const pointChainId = (await db().collection("tenants").doc(id).get()).data()?.chainId;
        await requireTenantRole(id, decoded.uid, ["owner"]).catch(async (e) => {
          if (!pointChainId) throw e;
          await requireChainRole(pointChainId, decoded.uid, ["owner"]);
        });
      }
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 403) throw e;
      superAdmin = await isSuperAdmin(decoded);
      if (!superAdmin) throw e;
      requireRecentAuth(decoded);
    }
  }
  const firestore = db();
  const root = await firestore.collection(isChain ? "chains" : "tenants").doc(id).get();
  if (!root.exists) throw new HttpError(404, isChain ? "Сеть не найдена" : "Заведение не найдено");

  const throttleRef = firestore.collection("backupExports").doc(`${isChain ? "chain" : "tenant"}_${id}`);
  if (!superAdmin) {
    const last = (await throttleRef.get()).data()?.lastAt;
    const nextAt = last ? last.toMillis() + EXPORT_OWNER_INTERVAL_MS : 0;
    if (nextAt > Date.now()) {
      const when = new Date(nextAt).toLocaleString("ru-RU", {
        timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
      });
      throw new HttpError(429, `Бэкап можно скачивать раз в 3 дня — следующий будет доступен ${when} (МСК)`);
    }
  }

  const docs = {};
  const tenantIds = [];
  const limit = unlimited === true ? Infinity : EXPORT_MAX_DOCS;
  if (isChain) {
    await exportDocTree(root.ref, docs, limit);
    const sub = await firestore.collection("subscriptions").doc(id).get();
    if (sub.exists) docs[sub.ref.path] = serializeFirestoreValue(sub.data());
    await exportWhere("chainMembers", "chainId", id, docs);
    await exportWhere("billingInvoices", "chainId", id, docs);
    await exportWhere("bankInvoices", "chainId", id, docs);
    const locations = await firestore.collection("tenants").where("chainId", "==", id).get();
    for (const t of locations.docs) {
      tenantIds.push(t.id);
      await exportTenant(t.id, docs, limit);
    }
  } else {
    tenantIds.push(id);
    await exportTenant(id, docs, limit);
  }

  const name = String(root.data().name || root.data().slug || id);
  if (!superAdmin) {
    await throttleRef.set({ lastAt: admin.firestore.FieldValue.serverTimestamp(), byUid: decoded.uid });
  }
  await writeSecurityEvent(req, decoded, isChain ? "chainBackupExported" : "tenantBackupExported", {
    tenantId: isChain ? null : id,
    metadata: { name, chainId: isChain ? id : null, docs: Object.keys(docs).length, bySuperAdmin: superAdmin, unlimited: unlimited === true },
  });
  const body = zlib.gzipSync(JSON.stringify({
    format: 1, kind: isChain ? "chain" : "tenant", id, name, tenantIds,
    createdAt: new Date().toISOString(), docs,
  }));
  // Сжатый JSON: браузер сам распакует его (Content-Encoding), и владелец
  // сохранит обычный .json, который открывается чем угодно.
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Encoding": "gzip",
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-callback-secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

/**
 * Ручная правка подписки из карточки заведения (статус, «оплачено до»,
 * «триал до») с записью «было → стало» в журнал безопасности. У точки сети
 * правится подписка сети.
 */
const SUBSCRIPTION_STATUSES = ["trial", "active", "past_due", "cancelled", "incomplete"];
function dateInputToTimestamp(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${label}: дата в формате ГГГГ-ММ-ДД`);
  }
  const ms = Date.parse(`${value}T12:00:00Z`);
  if (!Number.isFinite(ms)) throw new HttpError(400, `${label}: некорректная дата`);
  return admin.firestore.Timestamp.fromMillis(ms);
}
async function handleOverrideSubscription(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const body = await parseJsonBody(req);
  const { tenantId, status } = body;
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");
  if (!SUBSCRIPTION_STATUSES.includes(status)) throw new HttpError(400, "Неизвестный статус подписки");
  const tenantDoc = await db().collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) throw new HttpError(404, "Заведение не найдено");
  const chainId = tenantDoc.data().chainId || null;
  const subRef = db().collection("subscriptions").doc(chainId || tenantId);
  const before = (await subRef.get()).data() || {};

  const payload = { status };
  const periodEnd = dateInputToTimestamp(body.currentPeriodEnd, "Оплачено до");
  const trialEnd = dateInputToTimestamp(body.trialEndsAt, "Триал до");
  if (periodEnd) payload.currentPeriodEnd = periodEnd;
  if (trialEnd) payload.trialEndsAt = trialEnd;
  // Разобрались вручную — останавливаем отсчёт до удаления данных.
  if (status !== "past_due") payload.pastDueSince = null;
  await subRef.set(payload, { merge: true });
  await syncBillingOwnerStatus(chainId, chainId || tenantId, status);

  const day = (ts) => (ts && typeof ts.toDate === "function" ? ts.toDate().toISOString().slice(0, 10) : null);
  await writeAuditLog({ tenantId, actorId: decoded.uid, action: "subscriptionOverridden", metadata: { status, chainId } });
  await writeSecurityEvent(req, decoded, "subscriptionOverridden", {
    tenantId,
    metadata: {
      ...(await tenantLabel(tenantId, tenantDoc.data())),
      chainId,
      from: { status: before.status || null, currentPeriodEnd: day(before.currentPeriodEnd), trialEndsAt: day(before.trialEndsAt) },
      to: { status, currentPeriodEnd: day(periodEnd) || day(before.currentPeriodEnd), trialEndsAt: day(trialEnd) || day(before.trialEndsAt) },
    },
  });
  sendJson(res, 200, { ok: true, chainId });
}

/**
 * Создание, правка и удаление тарифов — с записью изменений цен в журнал
 * безопасности. Принимаем только известные поля своих типов.
 */
const PLAN_NUMBER_FIELDS = [
  "priceRub", "priceRubSemiannual", "priceRubYearly",
  "priceRubAdditional", "priceRubAdditionalSemiannual", "priceRubAdditionalYearly",
  "maxEmployees", "maxDevices", "maxTables", "maxStorageMb", "trialDays",
];
const PLAN_BOOL_FIELDS = ["isChainPlan", "customAdditionalPrice", "aiEnabled", "customBranding", "customDomain", "prioritySupport", "archived"];
const PLAN_FEATURE_FIELDS = ["reservations", "loyalty", "guestApp", "advancedReports"];
function sanitizePlanFields(raw) {
  const out = {};
  const src = raw && typeof raw === "object" ? raw : {};
  if (src.name !== undefined) {
    if (typeof src.name !== "string" || !src.name.trim() || src.name.length > 80) {
      throw new HttpError(400, "Название тарифа: от 1 до 80 символов");
    }
    out.name = src.name.trim();
  }
  for (const f of PLAN_NUMBER_FIELDS) {
    if (src[f] === undefined) continue;
    const n = Number(src[f]);
    if (!Number.isFinite(n) || n < 0 || n > 10000000) throw new HttpError(400, `Поле ${f}: число от 0`);
    out[f] = n;
  }
  for (const f of PLAN_BOOL_FIELDS) {
    if (src[f] === undefined) continue;
    out[f] = src[f] === true;
  }
  // Только присланные ключи: set с merge сливает features с прежними, и
  // форма может менять одну галочку, не зная про остальные.
  if (src.features && typeof src.features === "object") {
    out.features = {};
    for (const f of PLAN_FEATURE_FIELDS) {
      if (src.features[f] !== undefined) out.features[f] = src.features[f] === true;
    }
  }
  return out;
}
async function handleSavePlan(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const body = await parseJsonBody(req);
  const planId = typeof body.planId === "string" ? body.planId : "";
  if (!/^[a-z0-9-]{1,40}$/.test(planId)) throw new HttpError(400, "Код тарифа: только латиница, цифры и дефис");
  const fields = sanitizePlanFields(body.fields);
  const ref = db().collection("plans").doc(planId);
  const snap = await ref.get();
  const create = body.create === true;
  if (create && snap.exists) throw new HttpError(409, "Тариф с таким кодом уже есть");
  if (!create && !snap.exists) throw new HttpError(404, "Тариф не найден");
  const before = snap.exists ? snap.data() : {};
  await ref.set(fields, { merge: true });

  // Форма шлёт все поля разом: ранее незаданное поле, пришедшее пустым,
  // изменением не считаем, иначе в журнале утонут настоящие изменения цен.
  const changes = {};
  if (!create) {
    for (const [k, v] of Object.entries(fields)) {
      if (k === "features") continue;
      const was = before[k];
      if (was === v) continue;
      if (was === undefined && (v === 0 || v === false || v === "")) continue;
      changes[k] = [was === undefined ? null : was, v];
    }
  }
  if (fields.features) {
    for (const [k, v] of Object.entries(fields.features)) {
      const was = (before.features || {})[k];
      if (was !== v && !(was === undefined && v === false)) changes[`features.${k}`] = [was === undefined ? null : was, v];
    }
  }
  if (create || Object.keys(changes).length) {
    await writeSecurityEvent(req, decoded, create ? "planCreated" : "planUpdated", {
      metadata: { planId, planName: fields.name || before.name || planId, changes, priceRub: fields.priceRub ?? before.priceRub ?? null },
    });
  }
  // Поменялись возможности тарифа — заведения на нём узнают сразу.
  if (!create && ["aiEnabled", "maxEmployees", "features.guestApp"].some((k) => k in changes)) {
    syncCapabilitiesForPlan(planId).catch((e) => console.error(`saas-gateway: возможности тарифа ${planId}:`, e.message || e));
  }
  sendJson(res, 200, { ok: true, changed: Object.keys(changes).length });
}
async function handleDeletePlan(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { planId } = await parseJsonBody(req);
  if (typeof planId !== "string" || !/^[a-z0-9-]{1,40}$/.test(planId)) throw new HttpError(400, "Не указан тариф");
  const ref = db().collection("plans").doc(planId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "Тариф не найден");
  const inUse = await db().collection("tenants").where("planId", "==", planId).limit(1).get();
  await ref.delete();
  await writeSecurityEvent(req, decoded, "planDeleted", {
    metadata: { planId, planName: snap.data().name || planId, priceRub: snap.data().priceRub ?? null, wasInUse: !inUse.empty },
  });
  sendJson(res, 200, { ok: true });
}

// ------------------------------------------- тарифы: возможности и сетка

/**
 * Что даёт тариф заведению: приложение гостя (и меню по QR), ИИ-помощник,
 * число сотрудников (0 — без лимита). Тарифа нет (удалили, ещё не
 * заведён) — возможностей у заведения не отнимаем.
 */
const FULL_CAPABILITIES = Object.freeze({ guestApp: true, ai: true, maxEmployees: 0 });
function planCapabilities(plan) {
  if (!plan) return { ...FULL_CAPABILITIES };
  return {
    guestApp: !plan.features || plan.features.guestApp !== false,
    ai: plan.aiEnabled !== false,
    maxEmployees: Math.max(0, Math.floor(Number(plan.maxEmployees) || 0)),
  };
}

/** Тариф, по которому работает заведение: у точки сети — тариф сети. */
async function effectivePlanId(tenantDoc, subCache = null) {
  const t = tenantDoc.data();
  const billingId = t.chainId || tenantDoc.id;
  let sub = subCache ? subCache.get(billingId) : undefined;
  if (sub === undefined) {
    sub = (await db().collection("subscriptions").doc(billingId).get()).data() || null;
    if (subCache) subCache.set(billingId, sub);
  }
  if (sub && sub.planId) return sub.planId;
  if (t.chainId) {
    const chain = (await db().collection("chains").doc(t.chainId).get()).data();
    return (chain && chain.planId) || "chain";
  }
  return t.planId || "start";
}

/**
 * Возможности тарифа — в само заведение: tenants/{id}.guestAppOff (по нему
 * правила базы пускают гостей, см. isTenantGuest) и
 * tenants/{id}/public/features (его читают касса, приложение и веб гостя).
 * Демо показывает всё.
 */
async function syncTenantCapabilities(tenantDoc, { plans = null, subCache = null } = {}) {
  const t = tenantDoc.data();
  if (!t || t.status === "deleted") return null;
  let caps;
  if (t.demo === true) {
    caps = { ...FULL_CAPABILITIES };
  } else {
    const planId = await effectivePlanId(tenantDoc, subCache);
    const plan = plans ? plans.get(planId) : (await db().collection("plans").doc(planId).get()).data();
    caps = planCapabilities(plan);
  }
  const off = caps.guestApp === false;
  const writes = [
    tenantDoc.ref.collection("public").doc("features").set({
      ...caps, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }),
  ];
  if ((t.guestAppOff === true) !== off) writes.push(tenantDoc.ref.set({ guestAppOff: off }, { merge: true }));
  await Promise.all(writes);
  return caps;
}

/** Заведение или все точки сети — после смены тарифа или оплаты. */
async function syncCapabilities({ tenantId = null, chainId = null }) {
  const firestore = db();
  const docs = chainId
    ? (await firestore.collection("tenants").where("chainId", "==", chainId).get()).docs
    : tenantId ? [await firestore.collection("tenants").doc(tenantId).get()].filter((d) => d.exists) : [];
  for (const d of docs) await syncTenantCapabilities(d);
}

/** Возможности тарифа поменялись — у всех, кто на нём. */
async function syncCapabilitiesForPlan(planId) {
  const subs = await db().collection("subscriptions").where("planId", "==", planId).get();
  for (const s of subs.docs) {
    const sub = s.data();
    if (sub.chainId) await syncCapabilities({ chainId: sub.chainId });
    else await syncCapabilities({ tenantId: sub.tenantId || s.id });
  }
}

/** Все заведения — раз в сутки, на случай пропущенной синхронизации. */
async function syncAllCapabilities() {
  const firestore = db();
  const plans = new Map((await firestore.collection("plans").get()).docs.map((d) => [d.id, d.data()]));
  const subCache = new Map();
  const tenants = await firestore.collection("tenants").get();
  let n = 0;
  for (const d of tenants.docs) {
    if (d.data().status === "deleted" || d.data().demo === true) continue;
    try {
      await syncTenantCapabilities(d, { plans, subCache });
      n += 1;
    } catch (e) {
      console.error(`saas-gateway: возможности тарифа ${d.id}:`, e.message || e);
    }
  }
  return n;
}

const CAPABILITIES_CRON_INTERVAL_MS = 24 * 3600 * 1000;
function scheduleCapabilitiesCron() {
  scheduleDailyJob("capabilities", CAPABILITIES_CRON_INTERVAL_MS, syncAllCapabilities, 25 * 60 * 1000);
}

/**
 * Рекомендованная сетка тарифов к запуску продаж. Сама по себе ничего не
 * меняет: записывает её супер-админ кнопкой в панели («Тарифы» →
 * «Применить рекомендованную сетку»), увидев список изменений. Дальше цены
 * правятся в той же панели как обычно.
 *
 * Три тарифа для одного заведения и два для сети. От «Старта» за 1 790 ₽
 * каждая ступень дороже на 600 ₽ и даёт больше команды: приложение гостя под
 * брендом заведения есть во всех тарифах (у облачных касс для общепита его
 * продают отдельным модулем за 2,5–5 тыс. ₽ в месяц), ИИ-помощник — с
 * «Бизнеса», приоритетная поддержка — в «Про». Рабочие места (планшеты,
 * телефоны, компьютеры) не ограничены — касса их и не ограничивает. Скидка
 * за 6 месяцев ≈ 10 %, за год ≈ 20 %. Следующая точка сети намного дешевле
 * первой: две точки на «Сети» дешевле двух заведений на «Бизнесе».
 */
const PLAN_BASE = {
  maxDevices: 0, maxTables: 0, maxStorageMb: 0, trialDays: 14, archived: false,
  isChainPlan: false, customAdditionalPrice: false, prioritySupport: false,
  priceRubAdditional: 0, priceRubAdditionalSemiannual: 0, priceRubAdditionalYearly: 0,
  customBranding: true, customDomain: true,
};
const PLAN_CATALOG = {
  start: {
    ...PLAN_BASE, name: "Старт",
    priceRub: 1790, priceRubSemiannual: 9590, priceRubYearly: 17190,
    maxEmployees: 5, aiEnabled: false,
    features: { reservations: true, loyalty: true, guestApp: true, advancedReports: false },
  },
  standard: {
    ...PLAN_BASE, name: "Бизнес",
    priceRub: 2390, priceRubSemiannual: 12890, priceRubYearly: 22890,
    maxEmployees: 10, aiEnabled: true,
    features: { reservations: true, loyalty: true, guestApp: true, advancedReports: false },
  },
  pro: {
    ...PLAN_BASE, name: "Про",
    priceRub: 2990, priceRubSemiannual: 16090, priceRubYearly: 28690,
    maxEmployees: 0, aiEnabled: true, prioritySupport: true,
    features: { reservations: true, loyalty: true, guestApp: true, advancedReports: false },
  },
  chain: {
    ...PLAN_BASE, name: "Сеть",
    isChainPlan: true, customAdditionalPrice: true,
    priceRub: 2590, priceRubSemiannual: 13890, priceRubYearly: 24790,
    priceRubAdditional: 990, priceRubAdditionalSemiannual: 5290, priceRubAdditionalYearly: 9490,
    maxEmployees: 10, aiEnabled: true,
    features: { reservations: true, loyalty: true, guestApp: true, advancedReports: false },
  },
  "chain-pro": {
    ...PLAN_BASE, name: "Сеть Про",
    isChainPlan: true, customAdditionalPrice: true,
    priceRub: 3990, priceRubSemiannual: 21490, priceRubYearly: 38290,
    priceRubAdditional: 1290, priceRubAdditionalSemiannual: 6890, priceRubAdditionalYearly: 12390,
    maxEmployees: 0, aiEnabled: true, prioritySupport: true,
    features: { reservations: true, loyalty: true, guestApp: true, advancedReports: false },
  },
};
// Тарифы вне сетки уходят в архив: с сайта и из выбора пропадают, а кто
// на них уже есть — остаётся на прежних условиях.
const PLAN_CATALOG_KEEP = new Set(Object.keys(PLAN_CATALOG));

/** Что поменяет сетка: по каждому тарифу — было/станет (для подтверждения). */
async function planCatalogDiff() {
  const plans = new Map((await db().collection("plans").get()).docs.map((d) => [d.id, d.data()]));
  const rows = [];
  for (const [planId, fields] of Object.entries(PLAN_CATALOG)) {
    const before = plans.get(planId) || null;
    rows.push({ planId, action: before ? "update" : "create", before: before && {
      name: before.name || planId, priceRub: Number(before.priceRub) || 0, archived: before.archived === true,
    }, after: { name: fields.name, priceRub: fields.priceRub, priceRubYearly: fields.priceRubYearly,
      priceRubAdditional: fields.priceRubAdditional, maxEmployees: fields.maxEmployees,
      guestApp: fields.features.guestApp, ai: fields.aiEnabled, prioritySupport: fields.prioritySupport === true } });
  }
  for (const [planId, p] of plans) {
    if (PLAN_CATALOG_KEEP.has(planId) || p.archived === true) continue;
    rows.push({ planId, action: "archive", before: { name: p.name || planId, priceRub: Number(p.priceRub) || 0 }, after: null });
  }
  // Заведения без выбранного тарифа заводились с planId «start», которого
  // не было, — и получали всё. Теперь у «Старта» нет ИИ и сотрудников до
  // пяти, поэтому их пробный период переносится на тариф по умолчанию
  // («Бизнес»), а не урезается молча.
  if (!plans.has("start")) {
    const orphans = (await db().collection("subscriptions").where("planId", "==", "start").get()).docs
      .filter((d) => !d.data().chainId);
    if (orphans.length) rows.push({ planId: "start", action: "moveOrphans", count: orphans.length, to: DEFAULT_TRIAL_PLAN_ID });
  }
  return rows;
}

async function handleApplyPlanCatalog(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { confirm } = await parseJsonBody(req);
  const diff = await planCatalogDiff();
  // Без confirm — только показать изменения. Цены меняются у всех клиентов —
  // как и прочие опасные действия панели, только сразу после входа.
  if (confirm !== true) return sendJson(res, 200, { ok: true, diff });
  requireRecentAuth(decoded);

  const firestore = db();
  const lockUntil = admin.firestore.Timestamp.fromMillis(Date.now() + PRICE_LOCK_DAYS * 86400000);
  let locked = 0;
  for (const row of diff) {
    const ref = firestore.collection("plans").doc(row.planId);
    // Подорожало — у тех, кто уже платит, прежние цены ещё 30 дней (оферта).
    const before = (await ref.get()).data();
    if (row.action === "update" && before && PRICE_LOCK_FIELDS.some((f) => f !== "customAdditionalPrice" &&
        Number(PLAN_CATALOG[row.planId][f] || 0) > Number(before[f] || 0) && Number(before[f] || 0) > 0)) {
      const prices = Object.fromEntries(PRICE_LOCK_FIELDS.filter((f) => before[f] !== undefined).map((f) => [f, before[f]]));
      const subs = await firestore.collection("subscriptions").where("planId", "==", row.planId).get();
      for (const sd of subs.docs) {
        if (!["active", "past_due"].includes(sd.data().status)) continue;
        await sd.ref.set({ priceLock: { planId: row.planId, until: lockUntil, prices } }, { merge: true });
        locked += 1;
      }
    }
    if (row.action === "moveOrphans") {
      const orphans = (await firestore.collection("subscriptions").where("planId", "==", "start").get()).docs
        .filter((d) => !d.data().chainId);
      for (const d of orphans) {
        await d.ref.set({ planId: row.to }, { merge: true });
        await firestore.collection("tenants").doc(d.data().tenantId || d.id).set({ planId: row.to }, { merge: true });
      }
      await writeSecurityEvent(req, decoded, "planUpdated", {
        metadata: { planId: "start", source: "planCatalog", movedTo: row.to, moved: orphans.length },
      });
      continue;
    }
    if (row.action === "archive") await ref.set({ archived: true }, { merge: true });
    else await ref.set(PLAN_CATALOG[row.planId], { merge: true });
    await writeSecurityEvent(req, decoded, row.action === "create" ? "planCreated" : "planUpdated", {
      metadata: { planId: row.planId, planName: row.after?.name || row.before?.name || row.planId, source: "planCatalog",
        changes: row.action === "archive" ? { archived: [false, true] } : { priceRub: [row.before?.priceRub ?? null, row.after.priceRub], name: [row.before?.name ?? null, row.after.name] },
        priceRub: row.after?.priceRub ?? row.before?.priceRub ?? null },
    });
  }
  const synced = await syncAllCapabilities();
  sendJson(res, 200, { ok: true, diff, synced, priceLocked: locked, priceLockUntil: lockUntil.toDate().toISOString() });
}

/**
 * Пока идёт пробный период, владелец меняет тариф сам, без оплаты: попробовал
 * «Старт» — может включить «Бизнес» и проверить приложение гостя. Срок
 * пробного периода не меняется. Сеть выбирает только тариф сети.
 */
async function handleChangeTrialPlan(req, res) {
  const decoded = await verifyAuth(req);
  const { tenantId, chainId, planId } = await parseJsonBody(req);
  if (typeof planId !== "string" || !/^[a-z0-9-]{1,40}$/.test(planId)) throw new HttpError(400, "Не указан тариф");
  const isChain = typeof chainId === "string" && !!chainId;
  if (isChain && !/^[A-Za-z0-9_-]{1,64}$/.test(chainId)) throw new HttpError(400, "Не указана сеть");
  if (!isChain && (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId))) throw new HttpError(400, "Не указано заведение");
  if (isChain) await requireChainRole(chainId, decoded.uid, ["owner", "admin"]);
  else await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);

  const firestore = db();
  if (!isChain && (await firestore.collection("tenants").doc(tenantId).get()).data()?.chainId) {
    throw new HttpError(412, "Тариф точки — это тариф всей сети: меняйте его у сети");
  }
  const plan = (await firestore.collection("plans").doc(planId).get()).data();
  if (!plan || plan.archived === true) throw new HttpError(404, "Тариф не найден");
  if (!!plan.isChainPlan !== isChain) {
    throw new HttpError(412, isChain ? "Сети подходит только тариф сети" : "Тариф сети — только для сети заведений");
  }
  const billingId = isChain ? chainId : tenantId;
  const subRef = firestore.collection("subscriptions").doc(billingId);
  const sub = (await subRef.get()).data();
  if (!sub || sub.status !== "trial") {
    throw new HttpError(412, "Без оплаты тариф меняется только в пробный период — дальше выберите тариф при оплате");
  }
  if (sub.planId === planId) return sendJson(res, 200, { ok: true, planId });
  await subRef.set({ planId }, { merge: true });
  await firestore.collection(isChain ? "chains" : "tenants").doc(billingId)
    .set({ planId, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await syncCapabilities(isChain ? { chainId } : { tenantId });
  await writeAuditLog({ tenantId: isChain ? null : tenantId, actorId: decoded.uid, action: "trialPlanChanged", metadata: { chainId: isChain ? chainId : null, from: sub.planId || null, planId } });
  sendJson(res, 200, { ok: true, planId });
}

/**
 * Каждые DEMO_CLEANUP_INTERVAL_MS удаляет демо старше DEMO_TTL_MS. Нужен
 * составной индекс demo+createdAt (saas/firestore.indexes.json); без него
 * запрос падает с FAILED_PRECONDITION и ссылкой на создание индекса.
 */
function scheduleDemoCleanup() {
  setInterval(async () => {
    try {
      const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - DEMO_TTL_MS);
      const snap = await db()
        .collection("tenants")
        .where("demo", "==", true)
        .where("createdAt", "<=", cutoff)
        .get();
      for (const doc of snap.docs) {
        await purgeDemoTenant(doc.id);
        console.log(`saas-gateway: удалено демо-заведение ${doc.id}`);
      }
    } catch (e) {
      console.error("saas-gateway: ошибка очистки демо-заведений:", e.message || e);
    }
  }, DEMO_CLEANUP_INTERVAL_MS);
}

// ------------------------------------------------------------ security

/**
 * Назначить супер-админа по email. Только супер-админ и только сразу после
 * ввода пароля (requireRecentAuth). Кандидат ищется в Firebase Auth, а не в
 * users/ (туда может написать сам пользователь), и почта у него должна
 * быть подтверждена — иначе доступ к панели получил бы тот, кто просто
 * зарегистрировался на чужой адрес.
 */
async function handleGrantSuperAdmin(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  requireRecentAuth(decoded);
  const body = await parseJsonBody(req);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Введите корректный email");

  let user;
  try {
    user = await getFirebaseApp().auth().getUserByEmail(email);
  } catch (e) {
    throw new HttpError(404, "Этот email ещё не зарегистрирован в консоли — попросите сотрудника сначала зарегистрироваться, затем попробуйте снова");
  }
  if (!user.emailVerified) {
    throw new HttpError(400, "Почта этого пользователя не подтверждена — попросите его войти по ссылке из письма, затем попробуйте снова");
  }
  const ref = db().collection("superAdmins").doc(user.uid);
  if ((await ref.get()).exists) throw new HttpError(409, "Уже супер-админ");
  await ref.set({
    email,
    grantedAt: admin.firestore.FieldValue.serverTimestamp(),
    grantedBy: decoded.uid,
    grantedByEmail: decoded.email || null,
  });
  await writeSecurityEvent(req, decoded, "superAdminGranted", { targetUid: user.uid, targetEmail: email });
  sendJson(res, 200, { ok: true, uid: user.uid });
}

/** Снять супер-админа. Себя снять нельзя — так в панели всегда остаётся
 *  хотя бы один супер-админ. Открытые сеансы снятого сразу завершаются. */
async function handleRevokeSuperAdmin(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  requireRecentAuth(decoded);
  const { uid } = await parseJsonBody(req);
  if (typeof uid !== "string" || !uid) throw new HttpError(400, "Не указан пользователь");
  if (uid === decoded.uid) throw new HttpError(400, "Нельзя снять доступ у самого себя — попросите другого супер-админа");
  const ref = db().collection("superAdmins").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "Этот пользователь не супер-админ");
  await ref.delete();
  try {
    await getFirebaseApp().auth().revokeRefreshTokens(uid);
  } catch (e) {
    console.error(`revokeRefreshTokens(${uid}) не удался:`, e.message || e);
  }
  await writeSecurityEvent(req, decoded, "superAdminRevoked", { targetUid: uid, targetEmail: snap.data().email || null });
  sendJson(res, 200, { ok: true });
}

/**
 * «Выйти на всех устройствах»: отзываем refresh-токены и ставим
 * sessionsValidAfter — по нему и сервис, и правила базы сразу перестают
 * пускать уже открытые сеансы. Чужие сеансы — только после ввода пароля,
 * иначе украденный сеанс мог бы выкидывать настоящих админов.
 */
async function handleRevokeAdminSessions(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const body = await parseJsonBody(req);
  const uid = typeof body.uid === "string" && body.uid ? body.uid : decoded.uid;
  if (uid !== decoded.uid) requireRecentAuth(decoded);
  const ref = db().collection("superAdmins").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "Этот пользователь не супер-админ");
  await getFirebaseApp().auth().revokeRefreshTokens(uid);
  await ref.set({ sessionsValidAfter: Math.floor(Date.now() / 1000) }, { merge: true });
  await writeSecurityEvent(req, decoded, "adminSessionsRevoked", {
    targetUid: uid,
    targetEmail: snap.data().email || null,
    metadata: { reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : null },
  });
  sendJson(res, 200, { ok: true, self: uid === decoded.uid });
}

// lastSeenAt обновляем не чаще раза в 10 минут на сеанс.
const ADMIN_LOGIN_TOUCH_MS = 10 * 60 * 1000;
const adminLoginTouched = new Map(); // sessionId -> ms

/**
 * Консоль вызывает при каждом открытии панели платформы: один документ
 * adminLogins/{uid}_{auth_time} на вход, с IP и браузером, для «Это был не
 * я». Смена IP внутри сеанса добавляется в ips.
 */
async function handleRecordAdminLogin(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const authTime = Number(decoded.auth_time) || 0;
  const sessionId = `${decoded.uid}_${authTime}`;
  const ip = clientIp(req);
  const userAgent = String(req.headers["user-agent"] || "").slice(0, 300);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = db().collection("adminLogins").doc(sessionId);
  const snap = await ref.get();
  let newSession = false;
  if (!snap.exists) {
    newSession = true;
    await ref.set({
      uid: decoded.uid,
      email: decoded.email || null,
      ip,
      ips: [ip],
      userAgent,
      signInProvider: (decoded.firebase && decoded.firebase.sign_in_provider) || null,
      authTime: admin.firestore.Timestamp.fromMillis(authTime * 1000),
      firstSeenAt: now,
      lastSeenAt: now,
    });
  } else {
    const known = snap.data().ips || [];
    const touched = adminLoginTouched.get(sessionId) || 0;
    if (!known.includes(ip) || Date.now() - touched > ADMIN_LOGIN_TOUCH_MS) {
      await ref.update({ lastSeenAt: now, ips: admin.firestore.FieldValue.arrayUnion(ip) });
    }
  }
  adminLoginTouched.set(sessionId, Date.now());
  if (newSession) {
    await db().collection("superAdmins").doc(decoded.uid).set(
      { lastLoginAt: now, lastLoginIp: ip, lastLoginUserAgent: userAgent },
      { merge: true }
    );
  }
  sendJson(res, 200, { ok: true, newSession });
}

// ------------------------------------------- security: состояние платформы

// Сертификаты поддоменов выпускает этот же сервер, поэтому проверяем через
// локальный nginx с нужным SNI: многие хостинги не пускают сервер к самому
// себе по публичному адресу.
const GUEST_BASE_DOMAIN = process.env.GUEST_BASE_DOMAIN || "zalpos.ru";
const GATEWAY_PUBLIC_HOST = process.env.GATEWAY_PUBLIC_HOST || `pii.${GUEST_BASE_DOMAIN}`;
const CERT_CHECK_CONNECT_HOST = process.env.CERT_CHECK_CONNECT_HOST || "127.0.0.1";
const CERT_CHECK_PORT = Number(process.env.CERT_CHECK_PORT) || 443;
const CERT_WARN_DAYS = 14;
const CERT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function checkCertificate(host) {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: CERT_CHECK_CONNECT_HOST, port: CERT_CHECK_PORT, servername: host, rejectUnauthorized: false, timeout: 8000,
    }, () => {
      const cert = socket.getPeerCertificate();
      const authError = socket.authorizationError ? String(socket.authorizationError) : null;
      socket.end();
      if (!cert || !cert.valid_to) return resolve({ host, error: "сертификат не найден" });
      // Сертификат другого домена (nginx отдал сертификат по умолчанию) —
      // значит, для этого поддомена сертификата нет вовсе.
      const names = String(cert.subjectaltname || "").split(",").map((n) => n.trim().replace(/^DNS:/, ""));
      if (!names.includes(host) && !names.includes(`*.${host.split(".").slice(1).join(".")}`)) {
        return resolve({ host, error: "сертификат выдан на другой домен" });
      }
      const validTo = new Date(cert.valid_to).getTime();
      resolve({ host, validTo, daysLeft: Math.floor((validTo - Date.now()) / 86400000), authError });
    });
    socket.on("timeout", () => { socket.destroy(); resolve({ host, error: "нет ответа" }); });
    socket.on("error", (e) => resolve({ host, error: e.code || e.message }));
  });
}

let certCheckRunning = null;
async function runCertificateCheck() {
  if (certCheckRunning) return certCheckRunning;
  certCheckRunning = (async () => {
    const firestore = db();
    const [tenants, chains] = await Promise.all([
      firestore.collection("tenants").get(),
      firestore.collection("chains").get(),
    ]);
    const slugs = new Set();
    tenants.docs.forEach((d) => {
      const t = d.data();
      if (t.slug && t.demo !== true && t.status !== "deleted") slugs.add(t.slug);
    });
    chains.docs.forEach((d) => {
      const c = d.data();
      if (c.slug && c.status !== "deleted") slugs.add(c.slug);
    });
    const hosts = [GATEWAY_PUBLIC_HOST, ...[...slugs].sort().map((slug) => `${slug}.${GUEST_BASE_DOMAIN}`)];
    const results = [];
    for (let i = 0; i < hosts.length; i += 5) {
      results.push(...(await Promise.all(hosts.slice(i, i + 5).map(checkCertificate))));
    }
    const problems = results.filter((r) => r.error || r.daysLeft < CERT_WARN_DAYS);
    const soonest = results.filter((r) => typeof r.daysLeft === "number").sort((a, b) => a.daysLeft - b.daysLeft)[0] || null;
    const summary = {
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
      total: results.length,
      problems: problems.slice(0, 200),
      soonest,
    };
    await firestore.collection("platformStatus").doc("certificates").set(summary);
    return { total: results.length, problems: problems.length };
  })();
  try {
    return await certCheckRunning;
  } finally {
    certCheckRunning = null;
  }
}

function scheduleCertificateCheck() {
  setTimeout(() => runCertificateCheck().catch((e) => console.error("проверка сертификатов:", e.message || e)), 5 * 60 * 1000);
  setInterval(() => runCertificateCheck().catch((e) => console.error("проверка сертификатов:", e.message || e)), CERT_CHECK_INTERVAL_MS);
}

// ------------------------------------------------ резервные копии базы
//
// Managed export Firestore требует Blaze и бакета, поэтому читаем все
// документы через Admin SDK и пишем один сжатый JSON в BACKUP_DIR (права
// 600). Чтения идут из бесплатной квоты (50 000 в сутки, при превышении база
// встаёт до конца суток), поэтому сначала оцениваем размер через count():
// больше BACKUP_MAX_DOCS — копию не делаем. Восстановление — restore-backup.js.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "backups");
const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);
const BACKUP_MAX_DOCS = Math.max(100, Number(process.env.BACKUP_MAX_DOCS) || 20000);
const BACKUP_INTERVAL_MS = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS) || 24) * 60 * 60 * 1000;
// Вложенные коллекции, которые не всегда удаётся найти выборкой (пустые
// у первых документов): известные заранее + найденные по ходу обхода.
const KNOWN_SUBCOLLECTIONS = [...TENANT_SUBCOLLECTIONS, "visits", "messages", "logins"];

function serializeFirestoreValue(v) {
  if (v === null || v === undefined) return v === undefined ? null : v;
  if (v instanceof admin.firestore.Timestamp) return { __t: "ts", v: v.toMillis() };
  if (v instanceof admin.firestore.GeoPoint) return { __t: "geo", lat: v.latitude, lng: v.longitude };
  if (v instanceof admin.firestore.DocumentReference) return { __t: "ref", v: v.path };
  if (Buffer.isBuffer(v)) return { __t: "bytes", v: v.toString("base64") };
  if (Array.isArray(v)) return v.map(serializeFirestoreValue);
  if (typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = serializeFirestoreValue(x);
    return out;
  }
  return v;
}

/** Все id коллекций базы: корневые + вложенные, найденные выборкой по 5
 *  документов на уровень (до 4 уровней вложенности) и известные заранее. */
async function discoverCollectionIds(firestore) {
  const roots = (await firestore.listCollections()).map((c) => c.id);
  const groups = new Set([...roots, ...KNOWN_SUBCOLLECTIONS]);
  let frontier = [...groups];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next = [];
    for (const id of frontier) {
      const sample = await firestore.collectionGroup(id).limit(5).get();
      for (const d of sample.docs) {
        for (const sub of await d.ref.listCollections()) {
          if (!groups.has(sub.id)) { groups.add(sub.id); next.push(sub.id); }
        }
      }
    }
    frontier = next;
  }
  return [...groups].sort();
}

let backupRunning = null;
async function runFirestoreBackup({ reason = "schedule" } = {}) {
  if (backupRunning) return backupRunning;
  backupRunning = (async () => {
    const firestore = db();
    const statusRef = firestore.collection("platformStatus").doc("backup");
    const startedAt = Date.now();
    try {
      const ids = await discoverCollectionIds(firestore);
      let estimate = 0;
      for (const id of ids) estimate += (await firestore.collectionGroup(id).count().get()).data().count;
      if (estimate > BACKUP_MAX_DOCS) {
        await statusRef.set({
          lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
          status: "too_large", docs: estimate, maxDocs: BACKUP_MAX_DOCS, reason,
          error: `В базе ~${estimate} документов — больше лимита ${BACKUP_MAX_DOCS} для копии в пределах бесплатной квоты чтений`,
        }, { merge: true });
        return { status: "too_large", docs: estimate };
      }
      const docs = {};
      for (const id of ids) {
        const snap = await firestore.collectionGroup(id).get();
        snap.docs.forEach((d) => { docs[d.ref.path] = serializeFirestoreValue(d.data()); });
      }
      fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/:/g, "-").slice(0, 16);
      const file = `firestore-${stamp}.json.gz`;
      const payload = zlib.gzipSync(JSON.stringify({ format: 1, createdAt: new Date().toISOString(), collections: ids, docs }));
      fs.writeFileSync(path.join(BACKUP_DIR, file), payload, { mode: 0o600 });
      // Храним только последние BACKUP_KEEP копий.
      const all = fs.readdirSync(BACKUP_DIR).filter((f) => /^firestore-.*\.json\.gz$/.test(f)).sort();
      all.slice(0, Math.max(0, all.length - BACKUP_KEEP)).forEach((f) => fs.unlinkSync(path.join(BACKUP_DIR, f)));
      const result = { status: "ok", file, docs: Object.keys(docs).length, bytes: payload.length, ms: Date.now() - startedAt };
      await statusRef.set({
        lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
        lastOkAt: admin.firestore.FieldValue.serverTimestamp(),
        ...result, reason, error: null, kept: Math.min(all.length, BACKUP_KEEP),
      }, { merge: true });
      return result;
    } catch (e) {
      await statusRef.set({
        lastRunAt: admin.firestore.FieldValue.serverTimestamp(), status: "error", reason, error: String(e.message || e).slice(0, 300),
      }, { merge: true }).catch(() => {});
      throw e;
    }
  })();
  try {
    return await backupRunning;
  } finally {
    backupRunning = null;
  }
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^firestore-.*\.json\.gz$/.test(f))
      .sort().reverse()
      .map((f) => ({ name: f, bytes: fs.statSync(path.join(BACKUP_DIR, f)).size }));
  } catch (_) {
    return [];
  }
}

function scheduleFirestoreBackup() {
  // Первая копия — через 10 минут после старта и только если последняя
  // была давно: перезапуски сервиса не должны каждый раз читать всю базу.
  const tick = async () => {
    try {
      const st = (await db().collection("platformStatus").doc("backup").get()).data() || {};
      const last = st.lastRunAt && st.lastRunAt.toMillis ? st.lastRunAt.toMillis() : 0;
      if (Date.now() - last < BACKUP_INTERVAL_MS - 60 * 60 * 1000) return;
      await runFirestoreBackup({ reason: "schedule" });
    } catch (e) {
      console.error("резервная копия базы:", e.message || e);
    }
  };
  setTimeout(tick, 10 * 60 * 1000);
  setInterval(tick, 60 * 60 * 1000);
}

/**
 * Чек-лист «Безопасность → Платформа»: что можно проверить только на
 * сервере — заданы ли секреты (без значений), доходят ли уведомления
 * Робокассы, сроки сертификатов, резервные копии, актуальны ли правила базы,
 * передаёт ли nginx настоящий IP.
 */
const SECURITY_SECRETS_BASE = [
  ["FIREBASE_SERVICE_ACCOUNT_B64", "Сервисный ключ Firebase"],
  ["FIREBASE_WEB_CONFIG_JSON", "Веб-конфиг Firebase (гостевой веб)"],
  ["GITHUB_PAT", "GitHub: токен для сборки APK"],
  ["BUILD_CALLBACK_SECRET", "Секрет ответа сборки APK"],
];
const BILLING_SECRETS = [
  ["ROBOKASSA_LOGIN", "Робокасса: идентификатор магазина"],
  ["ROBOKASSA_PASSWORD1", "Робокасса: пароль №1"],
  ["ROBOKASSA_PASSWORD2", "Робокасса: пароль №2"],
];
// Строки из актуального saas/firestore.rules — по ним видно, опубликованы
// ли последние правила (защита сеансов супер-админов, склад кассы, ключи
// ИИ отдельно от гостей, реквизиты платформы).
const RULES_FEATURE_MARKERS = ["adminSessionFresh", "inventoryItems", "aiSecrets", "platformConfig"];

// Реквизиты владельца платформы для оферты, политики конфиденциальности и
// подвала сайта (их требует и модерация платёжного сервиса). Хранятся в
// platformConfig/legal — публичное чтение, запись только здесь.
const LEGAL_FIELDS = {
  fullName: "ФИО ИП / название организации", ogrnip: "ОГРНИП / ОГРН", inn: "ИНН", address: "Адрес",
  bankAccount: "Расчётный счёт", bankName: "Банк", bik: "БИК", corrAccount: "Корр. счёт",
  email: "E-mail для претензий и обращений", phone: "Телефон", rknNumber: "Номер в реестре операторов ПДн",
  taxRegime: "Налоговый режим",
};
const LEGAL_REQUIRED = ["fullName", "ogrnip", "inn", "address", "email"];

function legalMissing(legal) {
  return LEGAL_REQUIRED.filter((k) => !(legal && String(legal[k] || "").trim()));
}

async function handleSavePlatformLegal(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  requireRecentAuth(decoded);
  const body = await parseJsonBody(req);
  const out = {};
  for (const k of Object.keys(LEGAL_FIELDS)) {
    const v = body[k] == null ? "" : String(body[k]).trim();
    if (v.length > 300) throw new HttpError(400, `Слишком длинное поле «${LEGAL_FIELDS[k]}»`);
    out[k] = v;
  }
  if (out.inn && !/^(\d{10}|\d{12})$/.test(out.inn)) throw new HttpError(400, "ИНН — 10 или 12 цифр");
  if (out.ogrnip && !/^(\d{13}|\d{15})$/.test(out.ogrnip)) throw new HttpError(400, "ОГРН — 13 цифр, ОГРНИП — 15 цифр");
  if (out.bik && !/^\d{9}$/.test(out.bik)) throw new HttpError(400, "БИК — 9 цифр");
  if (out.bankAccount && !/^\d{20}$/.test(out.bankAccount)) throw new HttpError(400, "Расчётный счёт — 20 цифр");
  if (out.corrAccount && !/^\d{20}$/.test(out.corrAccount)) throw new HttpError(400, "Корр. счёт — 20 цифр");
  if (out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) throw new HttpError(400, "Проверьте e-mail");
  if (!["", "npd"].includes(out.taxRegime)) throw new HttpError(400, "Неизвестный налоговый режим");
  await db().collection("platformConfig").doc("legal").set({
    ...out, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: decoded.uid,
  });
  await writeSecurityEvent(req, decoded, "platformLegalUpdated", { metadata: { missing: legalMissing(out) } });
  sendJson(res, 200, { ok: true, missing: legalMissing(out) });
}

async function handleSecurityStatus(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const firestore = db();
  const [billing, certs, backup, lastPayment, admins, legalDoc] = await Promise.all([
    firestore.collection("platformStatus").doc("billingWebhook").get(),
    firestore.collection("platformStatus").doc("certificates").get(),
    firestore.collection("platformStatus").doc("backup").get(),
    firestore.collection("billingEvents").orderBy("receivedAt", "desc").limit(1).get().catch(() => null),
    firestore.collection("superAdmins").get(),
    firestore.collection("platformConfig").doc("legal").get(),
  ]);
  let rules = { status: "unknown" };
  try {
    const ruleset = await getFirebaseApp().securityRules().getFirestoreRuleset();
    const source = (ruleset.source || []).map((f) => f.content).join("\n");
    rules = {
      status: RULES_FEATURE_MARKERS.every((m) => source.includes(m)) ? "ok" : "outdated",
      updatedAt: ruleset.createTime || null,
    };
  } catch (e) {
    rules = { status: "unknown", error: String(e.message || e).slice(0, 200) };
  }
  const ts = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : null);
  const b = billing.exists ? billing.data() : {};
  const lp = lastPayment && !lastPayment.empty ? lastPayment.docs[0].data() : null;
  sendJson(res, 200, {
    secrets: [...SECURITY_SECRETS_BASE.slice(0, 2), ...BILLING_SECRETS, ...SECURITY_SECRETS_BASE.slice(2)]
      .map(([key, label]) => ({ key, label, set: !!(process.env[key] && String(process.env[key]).trim()) })),
    billingProvider: "robokassa",
    robokassaTest: process.env.ROBOKASSA_TEST === "1",
    githubRef: GITHUB_REF,
    billingWebhook: { lastReceivedAt: ts(b.lastReceivedAt), lastEvent: b.lastEvent || null, lastPaymentAt: lp ? ts(lp.receivedAt) : null },
    certificates: certs.exists ? { ...certs.data(), checkedAt: ts(certs.data().checkedAt) } : null,
    backup: backup.exists ? { ...backup.data(), lastRunAt: ts(backup.data().lastRunAt), lastOkAt: ts(backup.data().lastOkAt) } : null,
    backups: listBackups(),
    backupSettings: { keep: BACKUP_KEEP, maxDocs: BACKUP_MAX_DOCS, intervalHours: BACKUP_INTERVAL_MS / 3600000 },
    rules,
    realIpHeader: typeof req.headers["x-real-ip"] === "string" && !!req.headers["x-real-ip"].trim(),
    superAdmins: admins.size,
    legal: { missing: legalMissing(legalDoc.exists ? legalDoc.data() : null), fields: LEGAL_FIELDS },
    gateway: { uptimeSec: Math.round(process.uptime()), node: process.version },
  });
}

async function handleRunCertificateCheck(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  sendJson(res, 200, { ok: true, ...(await runCertificateCheck()) });
}

async function handleRunBackup(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const result = await runFirestoreBackup({ reason: "manual" });
  await writeSecurityEvent(req, decoded, "backupCreated", { metadata: { file: result.file || null, docs: result.docs || null, status: result.status } });
  sendJson(res, 200, { ok: true, ...result });
}

/** Скачать резервную копию — это вся база с персональными данными, поэтому
 *  только сразу после ввода пароля и с записью в журнал безопасности. */
async function handleDownloadBackup(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  requireRecentAuth(decoded);
  const { name } = await parseJsonBody(req);
  if (typeof name !== "string" || !/^firestore-[0-9T-]+\.json\.gz$/.test(name)) throw new HttpError(400, "Неизвестная копия");
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw new HttpError(404, "Копия не найдена");
  await writeSecurityEvent(req, decoded, "backupDownloaded", { metadata: { file: name } });
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Length": data.length,
    "Content-Disposition": `attachment; filename="${name}"`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-callback-secret",
  });
  res.end(data);
}

/** Повторно выпустить сертификат поддомена (тот же provision-tenant-
 *  domain.sh, что и при создании заведения) — кнопка у проблемного домена
 *  в чек-листе. */
async function handleReprovisionDomain(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { host } = await parseJsonBody(req);
  const suffix = `.${GUEST_BASE_DOMAIN}`;
  if (typeof host !== "string" || !host.endsWith(suffix)) throw new HttpError(400, "Можно только поддомен заведения");
  const slug = normalizeSlug(host.slice(0, -suffix.length));
  await provisionTenantDomain(slug);
  await writeSecurityEvent(req, decoded, "domainReprovisioned", { metadata: { host } });
  const check = await checkCertificate(host);
  sendJson(res, 200, { ok: true, check });
}

// ------------------------------------- security: подозрительная активность

/**
 * signupEvents: создание заведений, сетей и демо, упоры в лимит и отказы
 * по блок-листу — по ним «Безопасность → Активность» показывает всплески с
 * одного IP. Читает только супер-админ. Упоры и отказы пишем не чаще раза в
 * час на IP, иначе бот сам заполнял бы коллекцию.
 */
const signupEventThrottle = new Map(); // `${type}:${ip}` -> ms
function recordSignupEvent(req, type, { uid, email, tenantId, chainId, slug } = {}) {
  const ip = clientIp(req);
  if (type === "rateLimited" || type === "blocked") {
    const key = `${type}:${ip}`;
    if (Date.now() - (signupEventThrottle.get(key) || 0) < 60 * 60 * 1000) return;
    if (signupEventThrottle.size > 10000) signupEventThrottle.clear();
    signupEventThrottle.set(key, Date.now());
  }
  let col;
  try {
    col = db().collection("signupEvents");
  } catch (e) {
    console.error("signupEvents:", e.message || e);
    return;
  }
  col.add({
    type, ip,
    uid: uid || null,
    email: email || null,
    emailDomain: email && email.includes("@") ? email.split("@").pop().toLowerCase() : null,
    tenantId: tenantId || null,
    chainId: chainId || null,
    slug: slug || null,
    userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }).catch((e) => console.error("signupEvents:", e.message || e));
}

/**
 * Блок-лист (blocklist/{ip_… | email_…}): IP-адреса и домены почты, с
 * которых нельзя создавать заведения, сети и демо. Кэш на минуту — чтобы
 * не читать коллекцию на каждый запрос.
 */
let blocklistCache = { at: 0, entries: [] };
async function loadBlocklist() {
  if (Date.now() - blocklistCache.at < 60 * 1000) return blocklistCache.entries;
  const snap = await db().collection("blocklist").get();
  blocklistCache = { at: Date.now(), entries: snap.docs.map((d) => d.data()) };
  return blocklistCache.entries;
}
async function requireNotBlocked(req, email, kind) {
  let entries;
  try {
    entries = await loadBlocklist();
  } catch (e) {
    // База недоступна — основная операция всё равно упадёт на ней же;
    // здесь не подменяем её ошибку своей.
    console.error("blocklist:", e.message || e);
    return;
  }
  if (!entries.length) return;
  const ip = clientIp(req);
  const domain = email && email.includes("@") ? email.split("@").pop().toLowerCase() : null;
  const hit = entries.find((e) => (e.type === "ip" && e.value === ip) || (e.type === "emailDomain" && domain && e.value === domain));
  if (hit) {
    recordSignupEvent(req, "blocked", { email, slug: kind });
    throw new HttpError(403, "Регистрация с этого адреса ограничена. Если это ошибка — напишите в поддержку.");
  }
}

function blockEntryId(type, value) {
  return `${type === "ip" ? "ip" : "email"}_${value.replace(/[^a-zA-Z0-9.:-]/g, "_")}`;
}

async function handleBlockEntry(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const body = await parseJsonBody(req);
  const type = body.type === "emailDomain" ? "emailDomain" : body.type === "ip" ? "ip" : null;
  if (!type) throw new HttpError(400, "Тип блокировки: IP или домен почты");
  const value = typeof body.value === "string" ? body.value.trim().toLowerCase() : "";
  if (type === "ip" && !/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{2,39}$/.test(value)) throw new HttpError(400, "Некорректный IP-адрес");
  if (type === "emailDomain" && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) throw new HttpError(400, "Некорректный домен почты (например, spam-mail.ru)");
  if (type === "emailDomain" && ["gmail.com", "yandex.ru", "mail.ru", "ya.ru", "icloud.com", "outlook.com", "bk.ru", "inbox.ru", "list.ru", "rambler.ru"].includes(value)) {
    throw new HttpError(400, "Это массовый почтовый сервис — блокировка отрежет обычных клиентов. Блокируйте конкретный IP.");
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
  await db().collection("blocklist").doc(blockEntryId(type, value)).set({
    type, value, reason: reason || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: decoded.uid, createdByEmail: decoded.email || null,
  });
  blocklistCache.at = 0;
  await writeSecurityEvent(req, decoded, type === "ip" ? "ipBlocked" : "emailDomainBlocked", { metadata: { value, reason: reason || null } });
  sendJson(res, 200, { ok: true });
}

async function handleUnblockEntry(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { id } = await parseJsonBody(req);
  if (typeof id !== "string" || !/^(ip|email)_[a-zA-Z0-9._:-]+$/.test(id)) throw new HttpError(400, "Не указана блокировка");
  const ref = db().collection("blocklist").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "Блокировка не найдена");
  await ref.delete();
  blocklistCache.at = 0;
  const e = snap.data();
  await writeSecurityEvent(req, decoded, e.type === "ip" ? "ipUnblocked" : "emailDomainUnblocked", { metadata: { value: e.value } });
  sendJson(res, 200, { ok: true });
}

/**
 * Кассовые устройства всех заведений с последней активностью. Приложение
 * само lastSeenAt не обновляет (пишется один раз при подключении), зато
 * каждое устройство — анонимный аккаунт Firebase Auth, и Firebase сам
 * отмечает lastRefreshTime при каждом обновлении токена (примерно раз в
 * час, пока касса работает). Её и берём — без изменений в приложении.
 */
async function handleSecurityDevices(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const firestore = db();
  const [devicesSnap, tenantsSnap] = await Promise.all([
    firestore.collectionGroup("devices").get(),
    firestore.collection("tenants").get(),
  ]);
  const tenants = new Map(tenantsSnap.docs.map((d) => [d.id, d.data()]));
  const devices = devicesSnap.docs
    .filter((d) => d.ref.parent.parent && d.ref.parent.parent.parent.id === "tenants")
    .map((d) => ({ uid: d.id, tenantId: d.ref.parent.parent.id, data: d.data() }));
  const authInfo = new Map();
  for (let i = 0; i < devices.length; i += 100) {
    const chunk = devices.slice(i, i + 100).map((x) => ({ uid: x.uid }));
    try {
      const r = await getFirebaseApp().auth().getUsers(chunk);
      r.users.forEach((u) => authInfo.set(u.uid, u));
    } catch (e) {
      console.error("getUsers(devices):", e.message || e);
    }
  }
  const ms = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : null);
  const parse = (v) => (v ? Date.parse(v) || null : null);
  const list = devices.map(({ uid, tenantId, data }) => {
    const u = authInfo.get(uid);
    const t = tenants.get(tenantId) || {};
    const lastActiveAt = Math.max(
      ms(data.lastSeenAt) || 0,
      parse(u && u.metadata && u.metadata.lastRefreshTime) || 0,
      parse(u && u.metadata && u.metadata.lastSignInTime) || 0,
    ) || null;
    return {
      uid, tenantId,
      tenantName: t.name || null, tenantSlug: t.slug || null, tenantStatus: t.status || null, demo: t.demo === true,
      deviceName: data.deviceName || null, platform: data.platform || null, deviceType: data.deviceType || null,
      status: data.status || "active",
      authDisabled: !!(u && u.disabled),
      authMissing: !u,
      createdAt: ms(data.createdAt),
      lastActiveAt,
    };
  });
  sendJson(res, 200, { devices: list });
}

/** Отключить/включить кассовое устройство: членство в заведении (и сети),
 *  статус устройства и сам анонимный аккаунт (с отзывом сеансов) — так
 *  потерянный планшет не сможет даже прочитать данные заведения. */
async function setDeviceEnabled(req, res, enabled) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { tenantId, uid, reason } = await parseJsonBody(req);
  if (typeof tenantId !== "string" || !tenantId || typeof uid !== "string" || !uid) throw new HttpError(400, "Не указано устройство");
  const firestore = db();
  const deviceRef = firestore.collection("tenants").doc(tenantId).collection("devices").doc(uid);
  const deviceSnap = await deviceRef.get();
  if (!deviceSnap.exists) throw new HttpError(404, "Устройство не найдено");
  const tenantDoc = await firestore.collection("tenants").doc(tenantId).get();
  const status = enabled ? "active" : "disabled";
  await deviceRef.set({ status, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const memberRef = firestore.collection("tenantMembers").doc(`${tenantId}_${uid}`);
  if ((await memberRef.get()).exists) await memberRef.set({ status }, { merge: true });
  const chainId = tenantDoc.exists ? tenantDoc.data().chainId : null;
  if (chainId) await syncChainMembership(chainId, uid, "employee", status);
  await getFirebaseApp().auth().updateUser(uid, { disabled: !enabled });
  if (!enabled) await getFirebaseApp().auth().revokeRefreshTokens(uid);
  await writeSecurityEvent(req, decoded, enabled ? "deviceEnabled" : "deviceDisabled", {
    tenantId,
    targetUid: uid,
    metadata: {
      ...(await tenantLabel(tenantId, tenantDoc.data())),
      deviceName: deviceSnap.data().deviceName || null,
      reason: typeof reason === "string" ? reason.slice(0, 200) : null,
    },
  });
  sendJson(res, 200, { ok: true });
}

// ------------------------------------ security: персональные данные (152-ФЗ)
//
// Реестр запросов субъектов ПД (dataRequests): удалить, выдать копию,
// исправить. Гость просит удалить данные сам из веб-версии, письма и звонки
// супер-админ заводит вручную. Сроки — ст. 20 и 21 152-ФЗ: сведения и
// прекращение обработки — 10 рабочих дней, уточнение — 7 рабочих дней.
const DATA_REQUEST_KINDS = ["delete", "export", "correct"];
const DATA_REQUEST_WORKDAYS = { delete: 10, export: 10, correct: 7 };

/** Срок ответа: рабочие дни без учёта праздников — считаем с запасом. */
function dataRequestDueMs(kind, fromMs) {
  let days = DATA_REQUEST_WORKDAYS[kind] || 10;
  const d = new Date(fromMs + 3 * 3600000); // день недели по Москве
  while (days > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) days--;
  }
  return d.getTime() - 3 * 3600000;
}
const DATA_REQUEST_SUBJECTS = ["guest", "owner", "other"];

async function handleCreateDataRequest(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const body = await parseJsonBody(req);
  const subjectType = DATA_REQUEST_SUBJECTS.includes(body.subjectType) ? body.subjectType : null;
  const kind = DATA_REQUEST_KINDS.includes(body.kind) ? body.kind : null;
  if (!subjectType || !kind) throw new HttpError(400, "Укажите, чей запрос и что просят сделать");
  const contact = typeof body.contact === "string" ? body.contact.trim().slice(0, 120) : "";
  if (!contact) throw new HttpError(400, "Укажите контакт (телефон или email), по которому пришёл запрос");
  const now = Date.now();
  const ref = await db().collection("dataRequests").add({
    subjectType, kind, contact,
    tenantId: typeof body.tenantId === "string" && body.tenantId ? body.tenantId : null,
    note: typeof body.note === "string" ? body.note.trim().slice(0, 500) : null,
    source: "manual",
    status: "new",
    createdAt: admin.firestore.Timestamp.fromMillis(now),
    dueAt: admin.firestore.Timestamp.fromMillis(dataRequestDueMs(kind, now)),
    createdBy: decoded.uid, createdByEmail: decoded.email || null,
  });
  await writeSecurityEvent(req, decoded, "dataRequestCreated", { metadata: { requestId: ref.id, subjectType, kind, contact } });
  sendJson(res, 200, { ok: true, id: ref.id });
}

/** Гость сам просит удалить свои данные (веб-версия гостя). Нужен его
 *  (анонимный) вход и существующий профиль в этом заведении/сети; один
 *  открытый запрос на гостя — повторное нажатие не плодит дубли. */
async function handleRequestGuestDataDeletion(req, res) {
  const decoded = await verifyAuth(req);
  const body = await parseJsonBody(req);
  const tenantId = typeof body.tenantId === "string" && body.tenantId ? body.tenantId : null;
  if (!tenantId) throw new HttpError(400, "Не указано заведение");
  const firestore = db();
  const tenantDoc = await firestore.collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) throw new HttpError(404, "Заведение не найдено");
  const chainId = tenantDoc.data().chainId || null;
  const loyaltyRoot = chainId ? firestore.collection("chains").doc(chainId) : firestore.collection("tenants").doc(tenantId);
  const client = await loyaltyRoot.collection("clients").doc(decoded.uid).get();
  if (!client.exists) throw new HttpError(404, "Профиль гостя не найден");
  const open = await firestore.collection("dataRequests").where("clientUid", "==", decoded.uid).get();
  const existing = open.docs.find((d) => d.data().status === "new" && d.data().kind === "delete");
  if (existing) {
    sendJson(res, 200, { ok: true, id: existing.id, dueAt: existing.data().dueAt.toMillis(), existing: true });
    return;
  }
  const c = client.data();
  const now = Date.now();
  const ref = await firestore.collection("dataRequests").add({
    subjectType: "guest", kind: "delete",
    contact: c.phone || (c.shortDeviceId ? `ID устройства ${c.shortDeviceId}` : "без контакта"),
    guestName: c.name || null,
    clientUid: decoded.uid, tenantId, chainId,
    source: "guest-web",
    status: "new",
    createdAt: admin.firestore.Timestamp.fromMillis(now),
    dueAt: admin.firestore.Timestamp.fromMillis(dataRequestDueMs("delete", now)),
  });
  sendJson(res, 200, { ok: true, id: ref.id, dueAt: dataRequestDueMs("delete", now) });
}

async function handleResolveDataRequest(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { id, status, resolution } = await parseJsonBody(req);
  if (typeof id !== "string" || !id) throw new HttpError(400, "Не указан запрос");
  if (!["done", "rejected"].includes(status)) throw new HttpError(400, "Статус: выполнен или отклонён");
  const ref = db().collection("dataRequests").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "Запрос не найден");
  await ref.set({
    status,
    resolution: typeof resolution === "string" ? resolution.trim().slice(0, 500) : null,
    resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
    resolvedBy: decoded.uid, resolvedByEmail: decoded.email || null,
  }, { merge: true });
  await writeSecurityEvent(req, decoded, status === "done" ? "dataRequestDone" : "dataRequestRejected", {
    metadata: { requestId: id, contact: snap.data().contact || null, kind: snap.data().kind || null },
  });
  sendJson(res, 200, { ok: true });
}

function normalizeRuPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("8")) d = `7${d.slice(1)}`;
  if (d.length === 10 && d.startsWith("9")) d = `7${d}`;
  return d;
}
/** Поиск гостя по телефону во всех заведениях и сетях — для запросов,
 *  пришедших письмом или звонком. Читаем phoneIndex/{телефон} у каждого
 *  корня: запросу по группе коллекций нужен был бы отдельный индекс. */
async function handleFindGuest(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const { phone } = await parseJsonBody(req);
  const normalized = normalizeRuPhone(phone);
  if (!/^7\d{10}$/.test(normalized)) throw new HttpError(400, "Телефон в формате +7 999 123-45-67");
  const firestore = db();
  const [tenants, chains] = await Promise.all([firestore.collection("tenants").get(), firestore.collection("chains").get()]);
  const roots = [
    ...tenants.docs.filter((d) => !d.data().chainId && d.data().status !== "deleted" && d.data().demo !== true)
      .map((d) => ({ scope: "tenant", id: d.id, name: d.data().name, slug: d.data().slug, ref: d.ref })),
    ...chains.docs.filter((d) => d.data().status !== "deleted")
      .map((d) => ({ scope: "chain", id: d.id, name: d.data().name, slug: d.data().slug, ref: d.ref })),
  ];
  const matches = [];
  for (let i = 0; i < roots.length; i += 10) {
    await Promise.all(roots.slice(i, i + 10).map(async (r) => {
      const idx = await r.ref.collection("phoneIndex").doc(normalized).get();
      const uid = idx.exists ? idx.data().uid : null;
      if (!uid) return;
      const client = await r.ref.collection("clients").doc(uid).get();
      const c = client.exists ? client.data() : {};
      matches.push({
        scope: r.scope, id: r.id, name: r.name || null, slug: r.slug || null, clientUid: uid,
        guestName: c.name || null, visits: c.visits || 0, anonymized: c.anonymized === true,
      });
    }));
  }
  await writeSecurityEvent(req, decoded, "guestLookup", { metadata: { phone: normalized, found: matches.length } });
  sendJson(res, 200, { phone: normalized, matches });
}

/**
 * Обезличить гостя (удаление по запросу, 152-ФЗ): в профиле остаются
 * только обезличенные цифры (сколько потратил и визитов — для отчётов
 * заведения), имя, телефон, день рождения и прочее стираются; удаляются
 * указатели телефона и реферального кода; из броней, листа ожидания,
 * заказов, вызовов и отзывов во всех точках убираются имя и телефон;
 * анонимный аккаунт гостя удаляется. Только после ввода пароля.
 */
async function handleAnonymizeGuest(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  requireRecentAuth(decoded);
  const body = await parseJsonBody(req);
  const clientUid = typeof body.clientUid === "string" ? body.clientUid : "";
  const scope = body.scope === "chain" ? "chain" : "tenant";
  const rootId = typeof body.id === "string" ? body.id : "";
  if (!clientUid || !rootId) throw new HttpError(400, "Не указан гость");
  const firestore = db();
  const root = firestore.collection(scope === "chain" ? "chains" : "tenants").doc(rootId);
  const rootDoc = await root.get();
  if (!rootDoc.exists) throw new HttpError(404, "Заведение или сеть не найдены");
  const clientSnap = await root.collection("clients").doc(clientUid).get();
  if (!clientSnap.exists) throw new HttpError(404, "Профиль гостя не найден");
  const c = clientSnap.data();
  const { scrubbed, accountDeleted } = await anonymizeGuestData({ root, scope, rootId, clientUid, c });

  if (typeof body.requestId === "string" && body.requestId) {
    await firestore.collection("dataRequests").doc(body.requestId).set({
      status: "done",
      resolution: "Гость обезличен",
      resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
      resolvedBy: decoded.uid, resolvedByEmail: decoded.email || null,
    }, { merge: true });
  }
  await writeSecurityEvent(req, decoded, "guestAnonymized", {
    tenantId: scope === "tenant" ? rootId : null,
    targetUid: clientUid,
    metadata: {
      scope, rootId, rootName: rootDoc.data().name || null,
      guestName: c.name || null, phone: c.phone || null,
      scrubbedRecords: scrubbed, accountDeleted, requestId: body.requestId || null,
    },
  });
  sendJson(res, 200, { ok: true, scrubbedRecords: scrubbed, accountDeleted });
}

/**
 * «Удалить мои данные» у гостя — сразу, без очереди. Имя и телефон в базе в
 * РФ приложение уже стёрло (pii-gateway, guest_delete), здесь то же
 * обезличивание, что у супер-админа. В реестр пишем выполненный запрос без
 * имени и телефона.
 */
async function handleDeleteGuestData(req, res) {
  const decoded = await verifyAuth(req);
  const body = await parseJsonBody(req);
  const tenantId = typeof body.tenantId === "string" && body.tenantId ? body.tenantId : null;
  if (!tenantId) throw new HttpError(400, "Не указано заведение");
  const firestore = db();
  const tenantDoc = await firestore.collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) throw new HttpError(404, "Заведение не найдено");
  const chainId = tenantDoc.data().chainId || null;
  const scope = chainId ? "chain" : "tenant";
  const rootId = chainId || tenantId;
  const root = firestore.collection(chainId ? "chains" : "tenants").doc(rootId);
  const clientUid = decoded.uid;
  const clientSnap = await root.collection("clients").doc(clientUid).get();
  if (!clientSnap.exists) throw new HttpError(404, "Профиль гостя не найден");
  const c = clientSnap.data();
  if (c.anonymized === true) {
    sendJson(res, 200, { ok: true, alreadyDeleted: true });
    return;
  }
  // За столом открыт счёт — бонусы и заказ привязаны к профилю; удаляем
  // после закрытия счёта, чтобы не сломать гостю и персоналу расчёт.
  // Проверяем сам чек: после «закрыть без оплаты» отметка в профиле могла
  // остаться, и гость не смог бы удалить данные никогда.
  if (c.activeSessionId) {
    const sessionTenant = chainId ? (c.activeTenantId || tenantId) : tenantId;
    const ses = /^[A-Za-z0-9_-]{1,64}$/.test(String(sessionTenant)) && /^[A-Za-z0-9_-]{1,128}$/.test(String(c.activeSessionId))
      ? await firestore.collection("tenants").doc(String(sessionTenant)).collection("sessions").doc(String(c.activeSessionId)).get()
      : null;
    if (ses?.exists && ses.data().status === "active") {
      throw new HttpError(409, "У вас открыт счёт за столом — удалить данные можно после его закрытия");
    }
  }
  const { scrubbed, accountDeleted } = await anonymizeGuestData({ root, scope, rootId, clientUid, c });

  const now = admin.firestore.FieldValue.serverTimestamp();
  const open = await firestore.collection("dataRequests").where("clientUid", "==", clientUid).get();
  for (const d of open.docs) {
    if (d.data().status === "new") {
      await d.ref.set({ status: "done", resolution: "Гость удалил данные сам", resolvedAt: now, contact: "данные удалены", guestName: null }, { merge: true });
    }
  }
  await firestore.collection("dataRequests").add({
    subjectType: "guest", kind: "delete", contact: "данные удалены",
    clientUid, tenantId, chainId, source: "guest-self",
    status: "done", resolution: "Гость удалил данные сам",
    createdAt: now, resolvedAt: now,
  });
  await writeSecurityEvent(req, decoded, "guestSelfDeleted", {
    tenantId: chainId ? null : tenantId,
    targetUid: clientUid,
    metadata: { scope, rootId, rootName: tenantDoc.data().name || null, scrubbedRecords: scrubbed, accountDeleted },
  });
  sendJson(res, 200, { ok: true, scrubbedRecords: scrubbed, accountDeleted });
}

// ------------------------------------------------ восстановление входа гостя
//
// Гость входит анонимно, и профиль держится на сессии Firebase в телефоне.
// При первом входе приложение создаёт случайный ключ и присылает его сюда
// (храним только sha256). Потеряв сессию, оно предъявляет uid и ключ и
// получает custom token на тот же uid (kolibri_auth_service.dart).
const GUEST_RECOVERY_LIMIT = 30; // попыток восстановления с одного IP в час
const guestRecoveryHits = new Map(); // ip -> [ms]
const RECOVERY_SECRET_RE = /^[A-Za-z0-9_-]{43,128}$/;
const sha256hex = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

function guestRecoveryLimited(ip) {
  const now = Date.now();
  const list = (guestRecoveryHits.get(ip) || []).filter((t) => now - t < 3600000);
  list.push(now);
  guestRecoveryHits.set(ip, list);
  if (guestRecoveryHits.size > 10000) guestRecoveryHits.clear();
  return list.length > GUEST_RECOVERY_LIMIT;
}

async function handleRegisterGuestRecovery(req, res) {
  const decoded = await verifyAuth(req);
  const { secret } = await parseJsonBody(req);
  if (typeof secret !== "string" || !RECOVERY_SECRET_RE.test(secret)) throw new HttpError(400, "Некорректный ключ");
  const user = await getFirebaseApp().auth().getUser(decoded.uid);
  // Только гостевые аккаунты: у владельцев и сотрудников свой вход.
  if (user.email || user.phoneNumber) throw new HttpError(403, "Не гостевой аккаунт");
  await db().collection("guestRecovery").doc(decoded.uid).set({
    hash: sha256hex(secret),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  sendJson(res, 200, { ok: true });
}

async function handleRestoreGuestSession(req, res) {
  if (guestRecoveryLimited(clientIp(req))) throw new HttpError(429, "Слишком много попыток — попробуйте позже");
  const { uid, secret } = await parseJsonBody(req);
  if (typeof uid !== "string" || !/^[A-Za-z0-9]{10,128}$/.test(uid)
      || typeof secret !== "string" || !RECOVERY_SECRET_RE.test(secret)) {
    throw new HttpError(400, "Некорректный запрос");
  }
  const ref = db().collection("guestRecovery").doc(uid);
  const snap = await ref.get();
  const stored = snap.exists ? String(snap.data().hash || "") : "";
  const given = sha256hex(secret);
  if (stored.length !== given.length || !crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(given))) {
    throw new HttpError(403, "Не удалось восстановить вход");
  }
  try {
    const user = await getFirebaseApp().auth().getUser(uid);
    if (user.email || user.phoneNumber) throw new HttpError(403, "Не гостевой аккаунт");
  } catch (e) {
    // Аккаунта нет — custom token создаст его заново с тем же uid. Другие
    // ошибки (сеть, квоты) не превращаем в выдачу токена.
    if (e instanceof HttpError || e?.code !== "auth/user-not-found") throw e;
  }
  const token = await getFirebaseApp().auth().createCustomToken(uid);
  await ref.set({
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
    restoreCount: admin.firestore.FieldValue.increment(1),
  }, { merge: true });
  sendJson(res, 200, { token });
}

/** Общая часть обезличивания гостя (супер-админ и сам гость). */
async function anonymizeGuestData({ root, scope, rootId, clientUid, c }) {
  const firestore = db();
  const clientRef = root.collection("clients").doc(clientUid);
  // Указатели на гостя
  if (c.phone) {
    const idx = root.collection("phoneIndex").doc(String(c.phone));
    const idxSnap = await idx.get();
    if (idxSnap.exists && idxSnap.data().uid === clientUid) await idx.delete();
  }
  if (c.referralCode) {
    const code = root.collection("referralCodes").doc(String(c.referralCode));
    const codeSnap = await code.get();
    if (codeSnap.exists && codeSnap.data().uid === clientUid) await code.delete();
  }
  // Профиль: только обезличенная статистика
  await clientRef.set({
    name: "", phone: "",
    totalSpent: Number(c.totalSpent) || 0,
    visits: Number(c.visits) || 0,
    bonusBalance: 0,
    anonymized: true,
    anonymizedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Имя и телефон в записях точек (у сети — во всех её точках)
  const tenantIds = scope === "chain"
    ? (await firestore.collection("tenants").where("chainId", "==", rootId).get()).docs.map((d) => d.id)
    : [rootId];
  let scrubbed = 0;
  for (const tid of tenantIds) {
    for (const [col, patch] of [
      ["reservations", { guestName: "Гость (данные удалены)", phone: "" }],
      ["waitlist", { guestName: "Гость (данные удалены)", phone: "" }],
      ["guestOrders", { guestName: "" }],
      ["waiterCalls", { guestName: "" }],
      ["reviews", { guestName: "" }],
    ]) {
      const snap = await firestore.collection("tenants").doc(tid).collection(col).where("clientUid", "==", clientUid).get();
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = firestore.batch();
        snap.docs.slice(i, i + 400).forEach((d) => batch.update(d.ref, patch));
        await batch.commit();
      }
      scrubbed += snap.size;
    }
  }

  // Чеки, за которые гостю начисляли кешбэк (касса пишет loyaltyClientUid):
  // в них подпись с именем гостя и его контакт для электронного чека.
  for (const tid of tenantIds) {
    const snap = await firestore.collection("tenants").doc(tid).collection("sessions")
      .where("loyaltyClientUid", "==", clientUid).get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = firestore.batch();
      snap.docs.slice(i, i + 400).forEach((d) => batch.update(d.ref, { guestTag: "", guestContact: "" }));
      await batch.commit();
    }
    scrubbed += snap.size;
  }

  // Заказы доставки и с собой из приложения: имя, телефон и адрес гостя.
  for (const tid of tenantIds) {
    const snap = await firestore.collection("tenants").doc(tid).collection("sessions")
      .where("clientUid", "==", clientUid).get();
    const own = snap.docs.filter((d) => d.data().source === "app");
    for (let i = 0; i < own.length; i += 400) {
      const batch = firestore.batch();
      own.slice(i, i + 400).forEach((d) => batch.update(d.ref, {
        customerName: "", customerPhone: "", deliveryAddress: "", deliveryComment: "", guestContact: "",
      }));
      await batch.commit();
    }
    scrubbed += own.length;
  }

  // Ключ восстановления входа (guestRecovery) — иначе приложение вернуло бы
  // удалённый аккаунт при следующем запуске.
  await firestore.collection("guestRecovery").doc(clientUid).delete().catch(() => {});

  // Анонимный аккаунт гостя (у владельцев/сотрудников с почтой не трогаем)
  let accountDeleted = false;
  try {
    const u = await getFirebaseApp().auth().getUser(clientUid);
    if (!u.email && !u.phoneNumber && (u.providerData || []).length === 0) {
      await getFirebaseApp().auth().deleteUser(clientUid);
      accountDeleted = true;
    }
  } catch (_) {}
  return { scrubbed, accountDeleted };
}

// ------------------------------------------------------------ ИИ: прокси

// Провайдеры ИИ — те же значения по умолчанию, что и AiVendors в
// lib/services/ai/ai_settings.dart (держать синхронно).
const AI_VENDOR_DEFAULTS = {
  tooken: { baseUrl: "https://tooken.club/v1", format: "openai", model: "gpt-4o-mini", analyticsModel: "gpt-4o" },
  darkapi: { baseUrl: "https://darkapi.shop/v1", format: "openai", model: "deepseek-chat", analyticsModel: "deepseek-chat" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", format: "openai",
    model: "gemini-flash-latest", analyticsModel: "gemini-flash-latest",
  },
  custom: { baseUrl: "", format: "auto", model: "gpt-4o-mini", analyticsModel: "gpt-4o-mini" },
};
const AI_PROXY_PATHS = new Set(["chat/completions", "messages", "v1/messages"]);
const AI_PROXY_LIMIT = 30; // запросов гостя
const AI_PROXY_WINDOW_MS = 10 * 60 * 1000; // за 10 минут
const aiProxyLimiter = new Map(); // uid -> { count, resetAt }

function inferAiVendor(baseUrl) {
  const u = String(baseUrl || "").toLowerCase();
  if (!u || u.includes("tooken.club")) return "tooken";
  if (u.includes("darkapi")) return "darkapi";
  if (u.includes("generativelanguage.googleapis.com")) return "gemini";
  return "custom";
}

/** Подключение провайдера для слота primary/fallback из meta/aiSettings и
 *  meta/aiSecrets заведения (и старого формата, где ключ лежал прямо в
 *  aiSettings). */
function resolveAiVendor(settings, secrets, slot) {
  const vendorId = slot === "fallback"
    ? settings.fallbackVendor
    : (settings.vendor || inferAiVendor(settings.baseUrl));
  if (!vendorId || !AI_VENDOR_DEFAULTS[vendorId]) return null;
  const def = AI_VENDOR_DEFAULTS[vendorId];
  const pub = ((settings.vendors || {})[vendorId]) || {};
  const sec = ((secrets.vendors || {})[vendorId]) || {};
  // Старый формат (ключ и модель прямо в aiSettings) — только у основного.
  const legacy = slot === "primary" ? settings : {};
  let apiKey = sec.apiKey || "";
  let baseUrl = sec.baseUrl || "";
  if (!apiKey && legacy.apiKey) {
    apiKey = legacy.apiKey;
    baseUrl = baseUrl || legacy.baseUrl || "";
  }
  return {
    vendorId,
    apiKey,
    baseUrl: (baseUrl || def.baseUrl).replace(/\/+$/, ""),
    format: pub.format || (vendorId === "custom" ? legacy.provider : "") || def.format,
    models: [
      pub.model || legacy.model || def.model,
      pub.analyticsModel || legacy.analyticsModel || legacy.model || def.analyticsModel,
    ],
  };
}

/** Адрес из IPv4/IPv6, который нельзя отдавать в руки владельца заведения:
 *  loopback, частные сети, link-local (метаданные облака), CGNAT,
 *  multicast и служебные диапазоны. */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

/** Адрес провайдера ИИ задаёт владелец заведения — сервер не должен по его
 *  команде ходить во внутреннюю сеть (127.0.0.1, соседние сервисы,
 *  метаданные облака) и отдавать ответ обратно (SSRF). Только https и
 *  только внешние адреса; для тестов с локальным провайдером —
 *  AI_PROXY_ALLOW_PRIVATE=1 (в бою не задавать). */
async function assertPublicAiUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    throw new HttpError(400, "Адрес провайдера ИИ указан неверно");
  }
  if (process.env.AI_PROXY_ALLOW_PRIVATE === "1") return;
  if (u.protocol !== "https:") throw new HttpError(400, "Адрес провайдера ИИ должен начинаться с https://");
  if (u.username || u.password) throw new HttpError(400, "Адрес провайдера ИИ не должен содержать логин и пароль");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = net.isIP(host) ? [host] : (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
  } catch (_) {
    throw new HttpError(502, "Адрес провайдера ИИ не найден — проверьте его в настройках ИИ");
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new HttpError(400, "Адрес провайдера ИИ должен быть внешним сервисом, а не внутренним адресом");
  }
}

/**
 * ИИ-помощник гостя. Ключи заведения лежат в meta/aiSecrets, который гостю
 * не виден: гость присылает тело запроса, сервер подставляет адрес и ключ
 * провайдера. Модель и лимит ответа берём из настроек заведения, у гостя —
 * лимит запросов, иначе посторонний мог бы тратить баланс ИИ заведения.
 */
async function handleAiProxy(req, res) {
  const decoded = await verifyAuth(req);
  const now = Date.now();
  const lim = aiProxyLimiter.get(decoded.uid);
  if (!lim || lim.resetAt <= now) {
    if (aiProxyLimiter.size > 20000) aiProxyLimiter.clear();
    aiProxyLimiter.set(decoded.uid, { count: 1, resetAt: now + AI_PROXY_WINDOW_MS });
  } else if (lim.count >= AI_PROXY_LIMIT) {
    throw new HttpError(429, "Слишком много вопросов подряд — попробуйте через несколько минут");
  } else {
    lim.count += 1;
  }

  const body = await parseJsonBody(req);
  const { tenantId, slot, path: apiPath, format } = body;
  const payload = body.body && typeof body.body === "object" ? { ...body.body } : null;
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");
  if (slot !== "primary" && slot !== "fallback") throw new HttpError(400, "Неизвестный провайдер");
  if (!AI_PROXY_PATHS.has(apiPath) || !payload) throw new HttpError(400, "Некорректный запрос к ИИ");

  const firestore = db();
  const tenantRef = firestore.collection("tenants").doc(tenantId);
  const tenantDoc = await tenantRef.get();
  if (!tenantDoc.exists || ["deleted", "suspended"].includes(tenantDoc.data().status)) {
    throw new HttpError(404, "Заведение не найдено");
  }
  // ИИ-помощник — в тарифе заведения (syncTenantCapabilities); демо — всё.
  if (tenantDoc.data().demo !== true) {
    const caps = (await tenantRef.collection("public").doc("features").get()).data();
    if (caps && caps.ai === false) {
      throw new HttpError(403, "ИИ-помощник не входит в тариф заведения — его можно подключить, сменив тариф в личном кабинете");
    }
  }
  const chainId = tenantDoc.data().chainId || null;
  const loyaltyRoot = chainId ? firestore.collection("chains").doc(chainId) : tenantRef;
  // У сети один набор ключей на все точки (chains/{id}/meta/ai*); пока его
  // нет — прежние настройки самой точки.
  const [member, client, chainSettingsDoc, chainSecretsDoc] = await Promise.all([
    firestore.collection("tenantMembers").doc(`${tenantId}_${decoded.uid}`).get(),
    loyaltyRoot.collection("clients").doc(decoded.uid).get(),
    chainId ? loyaltyRoot.collection("meta").doc("aiSettings").get() : null,
    chainId ? loyaltyRoot.collection("meta").doc("aiSecrets").get() : null,
  ]);
  const isMember = member.exists && member.data().status === "active";
  if (!isMember && !client.exists) throw new HttpError(403, "Нет доступа к ИИ этого заведения");
  if (!isMember) {
    // Те же условия, что проверяет приложение гостя (consumeAiQuota), но на
    // сервере: анонимный аккаунт с профилем заводится бесплатно, и без этой
    // проверки ИИ заведения можно было бы расходовать в обход приложения.
    const c = client.data() || {};
    const sid = String(c.activeSessionId || "");
    const sessionTenant = chainId ? String(c.activeTenantId || "") : tenantId;
    const idOk = (v, max) => new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(v);
    if (!String(c.phone || "").trim() || !idOk(sid, 128) || !idOk(sessionTenant, 64)) {
      throw new HttpError(403, "ИИ-помощник доступен гостю за столом с указанным в профиле телефоном");
    }
    const ses = await firestore.collection("tenants").doc(sessionTenant).collection("sessions").doc(sid).get();
    if (!ses.exists || ses.data().status !== "active") {
      throw new HttpError(403, "ИИ-помощник доступен, пока за столом открыт счёт");
    }
  }
  const useChain = !!(chainSettingsDoc && chainSettingsDoc.exists);
  const [settingsDoc, secretsDoc] = useChain
    ? [chainSettingsDoc, chainSecretsDoc]
    : await Promise.all([
      tenantRef.collection("meta").doc("aiSettings").get(),
      tenantRef.collection("meta").doc("aiSecrets").get(),
    ]);
  const settings = settingsDoc.data() || {};
  if (settings.enabled !== true) throw new HttpError(403, "ИИ в этом заведении выключен");
  const vendor = resolveAiVendor(settings, secretsDoc.data() || {}, slot);
  if (!vendor || !vendor.apiKey || !vendor.baseUrl) throw new HttpError(400, "ИИ заведения не настроен");
  await assertPublicAiUrl(vendor.baseUrl);

  // Модель и лимит ответа — только из настроек заведения.
  if (!vendor.models.includes(payload.model)) payload.model = vendor.models[0];
  const maxCap = Math.min(8000, Math.max(512, (Number(settings.maxTokens) || 900) * 2));
  if (!(Number(payload.max_tokens) > 0) || Number(payload.max_tokens) > maxCap) payload.max_tokens = maxCap;
  delete payload.stream;

  const fmt = vendor.format === "auto" ? (format === "anthropic" ? "anthropic" : "openai") : vendor.format;
  const headers = fmt === "anthropic"
    ? { "Content-Type": "application/json", "x-api-key": vendor.apiKey, "anthropic-version": "2023-06-01", Authorization: `Bearer ${vendor.apiKey}` }
    : { "Content-Type": "application/json", Authorization: `Bearer ${vendor.apiKey}` };
  let upstream;
  try {
    // Путь — по формату и настоящему адресу (гость адреса не видит и не
    // знает, есть ли в нём уже /v1).
    const upstreamPath = fmt === "anthropic"
      ? (vendor.baseUrl.endsWith("/v1") ? "messages" : "v1/messages")
      : "chat/completions";
    // redirect: "error" — иначе внешний адрес мог бы переадресовать запрос
    // во внутреннюю сеть уже после проверки выше.
    upstream = await fetch(`${vendor.baseUrl}/${upstreamPath}`, {
      method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000),
      redirect: "error",
    });
  } catch (e) {
    throw new HttpError(502, `Провайдер ИИ не ответил: ${e.message || e}`);
  }
  const text = await upstream.text();
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-callback-secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(text);
}

/**
 * Разовый перенос ключей ИИ из meta/aiSettings (его читают гости) в
 * meta/aiSecrets (только персонал) у заведений, сохранивших настройки
 * старой версией приложения. После переноса правила базы не дают снова
 * записать ключ в aiSettings.
 */
async function migrateAiSecrets() {
  const firestore = db();
  const tenants = await firestore.collection("tenants").get();
  let moved = 0;
  for (const t of tenants.docs) {
    const ref = t.ref.collection("meta").doc("aiSettings");
    const snap = await ref.get();
    const d = snap.exists ? snap.data() : null;
    if (!d || !(d.apiKey || d.vendorKeys)) continue;
    const vendorId = AI_VENDOR_DEFAULTS[d.vendor] ? d.vendor : inferAiVendor(d.baseUrl);
    const secVendors = {};
    for (const [id, v] of Object.entries(d.vendorKeys || {})) {
      if (AI_VENDOR_DEFAULTS[id] && v && typeof v === "object") {
        secVendors[id] = { apiKey: String(v.apiKey || ""), baseUrl: String(v.baseUrl || "") };
      }
    }
    if (d.apiKey && !(secVendors[vendorId] && secVendors[vendorId].apiKey)) {
      secVendors[vendorId] = { apiKey: d.apiKey, baseUrl: d.baseUrl || "" };
    }
    // В публичной части — только известные провайдеры и без ключей/адресов
    // (иначе правила базы не дадут владельцу сохранить настройки).
    const pubVendors = {};
    for (const [id, v] of Object.entries(d.vendors || {})) {
      if (!AI_VENDOR_DEFAULTS[id] || !v || typeof v !== "object") continue;
      const { apiKey: _k, baseUrl: _b, ...rest } = v;
      pubVendors[id] = rest;
    }
    for (const [id, v] of Object.entries(secVendors)) {
      pubVendors[id] = { ...(pubVendors[id] || {}), hasKey: !!v.apiKey };
    }
    if (d.apiKey) {
      pubVendors[vendorId] = {
        ...pubVendors[vendorId],
        model: pubVendors[vendorId].model || d.model || "",
        analyticsModel: pubVendors[vendorId].analyticsModel || d.analyticsModel || d.model || "",
        format: pubVendors[vendorId].format || (vendorId === "custom" ? d.provider || "" : ""),
      };
    }
    await t.ref.collection("meta").doc("aiSecrets").set({ vendors: secVendors }, { merge: true });
    const del = admin.firestore.FieldValue.delete();
    await ref.set({
      vendor: vendorId, vendors: pubVendors,
      apiKey: del, baseUrl: del, provider: del, model: del, analyticsModel: del, vendorKeys: del,
    }, { merge: true });
    moved += 1;
  }
  if (moved) console.log(`saas-gateway: ключи ИИ перенесены в aiSecrets у ${moved} заведений`);
  return moved;
}

function scheduleAiSecretsMigration() {
  const delay = Number(process.env.AI_SECRETS_MIGRATION_DELAY_MS) || 2 * 60 * 1000;
  setTimeout(() => migrateAiSecrets().catch((e) => console.error("перенос ключей ИИ:", e.message || e)), delay);
}

// ------------------------------------------------------- письма входа

/**
 * Письмо входа по ссылке, смены пароля или подтверждения почты — в
 * оформлении ZalPOS (см. auth-email.js), а не шаблоном Firebase. Ссылку
 * делает Firebase Admin, письмо уходит через SMTP платформы. Почта не
 * настроена — 503, и консоль отправляет письмо через Firebase, как раньше.
 *
 * Вход и смена пароля — без авторизации (человек ещё не вошёл), поэтому
 * лимиты: с одного IP и на один адрес. Подтверждение почты — только своей,
 * с токеном. Есть ли такой пользователь, наружу не сообщаем: иначе по
 * ответу можно было бы перебирать, чьи адреса зарегистрированы.
 */
const CONSOLE_URL = process.env.CONSOLE_URL || `https://${GUEST_BASE_DOMAIN}/`;
const CONSOLE_HOSTS = new Set([
  GUEST_BASE_DOMAIN, `www.${GUEST_BASE_DOMAIN}`,
  ...String(process.env.CONSOLE_HOSTS || "saas-3bdc8.web.app,saas-3bdc8.firebaseapp.com")
    .split(",").map((h) => h.trim()).filter(Boolean),
]);
const AUTH_EMAIL_IP_MAX = 10;
const AUTH_EMAIL_ADDRESS_MAX = 5;
const AUTH_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const authEmailHits = new Map();
let authMailer;

function hitAuthEmailLimit(key, max) {
  const now = Date.now();
  const entry = authEmailHits.get(key);
  if (!entry || entry.resetAt <= now) {
    authEmailHits.set(key, { count: 1, resetAt: now + AUTH_EMAIL_WINDOW_MS });
    if (authEmailHits.size > 20000) {
      for (const [k, v] of authEmailHits) if (v.resetAt <= now) authEmailHits.delete(k);
    }
    return;
  }
  if (entry.count >= max) {
    throw new HttpError(429, "Слишком много писем подряд — попробуйте через час");
  }
  entry.count += 1;
}

/** Куда вернуть человека после ссылки: только на сам кабинет платформы. */
function authContinueUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    if (u.protocol === "https:" && CONSOLE_HOSTS.has(u.hostname)) return u.toString();
  } catch (_) { /* кривой адрес — берём адрес по умолчанию */ }
  return `${CONSOLE_URL}#/`;
}

async function handleSendAuthEmail(req, res) {
  const body = await parseJsonBody(req);
  const type = String(body.type || "");
  if (!AUTH_EMAIL_TYPES.includes(type) && type !== "password") throw new HttpError(400, "Неизвестный тип письма");
  const email = String(body.email || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new HttpError(400, "Проверьте адрес почты");
  }
  if (authMailer === undefined) authMailer = createMailer();
  if (!authMailer) throw new HttpError(503, "Почта платформы не настроена");
  if (type === "verifyEmail" || type === "password") {
    const decoded = await verifyAuth(req);
    if (String(decoded.email || "").toLowerCase() !== email) {
      throw new HttpError(403, "Письмо можно отправить только на свою почту");
    }
  }
  if (type === "password") {
    // Пароль владелец только что поставил себе сам (консоль, issueNewPassword)
    // — сервер его не хранит и не проверяет, только пересылает на его же почту.
    const password = String(body.password || "");
    if (password.length < 8 || password.length > 64) throw new HttpError(400, "Некорректный пароль");
    hitAuthEmailLimit(`to:${email}`, AUTH_EMAIL_ADDRESS_MAX);
    await authMailer.send({ to: email, ...passwordLetter(password, { siteUrl: CONSOLE_URL }) });
    return sendJson(res, 200, { ok: true });
  }
  hitAuthEmailLimit(`ip:${clientIp(req)}`, AUTH_EMAIL_IP_MAX);
  hitAuthEmailLimit(`to:${email}`, AUTH_EMAIL_ADDRESS_MAX);

  const url = authContinueUrl(body.continueUrl);
  const auth = getFirebaseApp().auth();
  let link;
  try {
    if (type === "signIn") link = await auth.generateSignInWithEmailLink(email, { url, handleCodeInApp: true });
    else if (type === "passwordReset") link = await auth.generatePasswordResetLink(email, { url });
    else link = await auth.generateEmailVerificationLink(email, { url });
  } catch (e) {
    if (e && (e.code === "auth/user-not-found" || e.code === "auth/email-not-found")) {
      return sendJson(res, 200, { ok: true });
    }
    throw e;
  }
  const letter = authEmailLetter(type, link, { siteUrl: CONSOLE_URL });
  await authMailer.send({ to: email, ...letter });
  sendJson(res, 200, { ok: true });
}

// ------------------------------------------------------------- оплата со стола

const guestPay = createGuestPay({
  db,
  admin,
  verifyAuth,
  parseJsonBody,
  readBody,
  sendJson,
  HttpError,
  requireTenantRole,
  publicUrl: (process.env.SAAS_GATEWAY_PUBLIC_URL || "https://pii.zalpos.ru/saas").replace(/\/+$/, ""),
});

/** Контакт гостя (имя, телефон, адрес) — в базу в РФ его же токеном, до заказа. */
async function recordContactInRussia(req, payload) {
  const auth = String(req.headers["authorization"] || "");
  let resp = null;
  for (const url of PII_GATEWAY_URLS) {
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      break;
    } catch (_) { /* следующий адрес */ }
  }
  if (!resp) throw new HttpError(503, "Сервер заказов недоступен — попробуйте через минуту");
  if (!resp.ok) throw new HttpError(503, "Не удалось сохранить контакт — попробуйте через минуту");
}

// Заказ доставки и с собой из приложения гостя — см. guest-delivery.js.
const guestDelivery = createGuestDelivery({
  db,
  admin,
  verifyAuth,
  parseJsonBody,
  sendJson,
  HttpError,
  recordContact: recordContactInRussia,
  onlinePayReady: async (tenantId) => {
    const t = db().collection("tenants").doc(tenantId);
    const [integ, venue] = await Promise.all([
      t.collection("settings").doc("integrations").get(),
      t.collection("meta").doc("venueProfile").get(),
    ]);
    const v = venue.data() || {};
    const i = integ.data() || {};
    const c = onlinePaySettings(i);
    // Как venueSettings в guest-pay.js: включено, банк подтвердил реквизиты, указан продавец.
    return v.guestSbpPay === true && !!c && i.onlinePayVerified === credsPrint(c) && sellerReady(v);
  },
});

/**
 * Имя, телефон и адрес из заказов доставки нужны, пока заказ везут и
 * разбираются с ним. Через 30 дней после закрытия — обезличиваем
 * (ч. 7 ст. 5 закона № 152-ФЗ): чек и суммы остаются для отчётов.
 */
const DELIVERY_PII_DAYS = 30;
async function runDeliveryPiiRetention() {
  const border = Date.now() - DELIVERY_PII_DAYS * 24 * 3600 * 1000;
  const tenants = await db().collection("tenants").get();
  for (const t of tenants.docs) {
    try {
      const snap = await t.ref.collection("sessions").where("source", "==", "app").get();
      const old = snap.docs.filter((d) => {
        const s = d.data();
        const closed = s.closedAt?.toMillis?.() || s.cancelledAt?.toMillis?.() || 0;
        return s.status !== "active" && closed && closed < border && (s.customerPhone || s.deliveryAddress || s.customerName);
      });
      for (let i = 0; i < old.length; i += 400) {
        const batch = db().batch();
        old.slice(i, i + 400).forEach((d) => batch.update(d.ref, {
          customerName: "", customerPhone: "", deliveryAddress: "", deliveryComment: "", guestContact: "", piiErasedAt: admin.firestore.FieldValue.serverTimestamp(),
        }));
        await batch.commit();
      }
    } catch (e) {
      console.error(`saas-gateway: обезличивание доставки ${t.id}:`, e.message || e);
    }
  }
}

// Telegram-боты заведений: доставка, смены, отчёты, сигналы — см. telegram.js.
const telegram = createTelegram({
  db,
  admin,
  verifyAuth,
  parseJsonBody,
  readBody,
  sendJson,
  HttpError,
  requireTenantRole,
  publicUrl: (process.env.SAAS_GATEWAY_PUBLIC_URL || "https://pii.zalpos.ru/saas").replace(/\/+$/, ""),
});

// ------------------------------------------------------------- routing

const ROUTES = {
  "/telegramSetup": telegram.handleSetup,
  "/telegramLinkCode": telegram.handleLinkCode,
  "/telegramAccess": telegram.handleAccess,
  "/telegramStatus": telegram.handleStatus,
  "/telegramNotify": telegram.handleNotify,
  "/telegramUnlink": telegram.handleUnlink,
  // Гость платит онлайн (счёт за столом, доставка) через банк заведения — см. guest-pay.js.
  "/guestPayStart": guestPay.handleStart,
  "/guestPayStatus": guestPay.handleStatus,
  "/guestPayNotify": guestPay.handleNotify,
  "/guestPayRobokassa": handleAnyRobokassaResult,
  "/onlinePayCheck": guestPay.handleCheck,
  // Заказ доставки/с собой из приложения гостя и его отмена гостем.
  "/guestDeliveryOrder": guestDelivery.handleCreate,
  "/guestDeliveryCancel": guestDelivery.handleCancel,
  "/resolveTenantBySlug": handleResolveTenantBySlug,
  "/resolveChainBySlug": handleResolveChainBySlug,
  "/createTenant": handleCreateTenant,
  "/createChain": handleCreateChain,
  "/convertTenantToChain": handleConvertTenantToChain,
  "/inviteTenantMember": handleInviteTenantMember,
  "/createBuildJob": handleCreateBuildJob,
  "/setBillingEventTest": handleSetBillingEventTest,
  "/chainPoints": handleChainPoints,
  "/chainPointJoin": handleChainPointJoin,
  "/chainLocationQuote": handleChainLocationQuote,
  "/chainLocationCheckout": handleChainLocationCheckout,
  "/completeBuildJob": handleCompleteBuildJob,
  "/rolloutApps": handleRolloutApps,
  "/createDemoTenant": handleCreateDemoTenant,
  // Бэкап заведения или сети: владелец — своё, супер-админ — любое.
  "/exportBackup": handleExportBackup,
  // Письма входа/смены пароля/подтверждения почты в оформлении ZalPOS.
  "/sendAuthEmail": handleSendAuthEmail,
  "/cancelSubscription": (req, res) => handleSetSubscriptionCancel(req, res, true),
  "/resumeSubscription": (req, res) => handleSetSubscriptionCancel(req, res, false),
  "/disableTenant": handleDisableTenant,
  "/enableTenant": handleEnableTenant,
  "/changeTenantPlan": handleChangeTenantPlan,
  "/grantBonusPeriod": handleGrantBonusPeriod,
  "/deleteDemoTenant": handleDeleteDemoTenant,
  "/getDownloadUrl": handleGetDownloadUrl,
  // Проверка обновлений: гостю без входа, кассе — участнику заведения.
  "/appUpdate": handleAppUpdate,
  "/createCheckoutSession": handleCreateCheckoutSession,
  "/createBankInvoice": handleCreateBankInvoice,
  "/markBankInvoicePaid": handleMarkBankInvoicePaid,
  "/markBankInvoiceReceipt": handleMarkBankInvoiceReceipt,
  "/cancelBankInvoice": handleCancelBankInvoice,
  "/uploadBrandingLogo": handleUploadBrandingLogo,
  "/uploadMenuImage": handleUploadMenuImage,
  "/savePlatformLegal": handleSavePlatformLegal,
  "/recalculateUsage": handleRecalculateUsage,
  "/overrideSubscription": handleOverrideSubscription,
  "/savePlan": handleSavePlan,
  "/applyPlanCatalog": handleApplyPlanCatalog,
  "/changeTrialPlan": handleChangeTrialPlan,
  "/deletePlan": handleDeletePlan,
  "/securityStatus": handleSecurityStatus,
  "/runCertificateCheck": handleRunCertificateCheck,
  "/runBackup": handleRunBackup,
  "/downloadBackup": handleDownloadBackup,
  "/reprovisionDomain": handleReprovisionDomain,
  "/blockEntry": handleBlockEntry,
  "/unblockEntry": handleUnblockEntry,
  "/securityDevices": handleSecurityDevices,
  "/disableDevice": (req, res) => setDeviceEnabled(req, res, false),
  "/enableDevice": (req, res) => setDeviceEnabled(req, res, true),
  "/createDataRequest": handleCreateDataRequest,
  "/requestGuestDataDeletion": handleRequestGuestDataDeletion,
  "/resolveDataRequest": handleResolveDataRequest,
  "/findGuest": handleFindGuest,
  "/anonymizeGuest": handleAnonymizeGuest,
  "/deleteGuestData": handleDeleteGuestData,
  "/registerGuestRecovery": handleRegisterGuestRecovery,
  "/restoreGuestSession": handleRestoreGuestSession,
  "/aiProxy": handleAiProxy,
  "/grantSuperAdmin": handleGrantSuperAdmin,
  "/revokeSuperAdmin": handleRevokeSuperAdmin,
  "/revokeAdminSessions": handleRevokeAdminSessions,
  "/recordAdminLogin": handleRecordAdminLogin,
  // Робокасса: Result URL (оплата прошла) и возврат после оплаты.
  // Подлинность Result URL — подпись паролем №2 внутри обработчика.
  // Любой из адресов принимает и подписки, и оплату гостей (см. ниже).
  "/robokassaResult": handleAnyRobokassaResult,
  "/robokassaSuccess": handleAnyRobokassaReturn,
  "/robokassaFail": handleAnyRobokassaReturn,
};

function runHandler(handler, req, res) {
  handler(req, res).catch((e) => {
    const known = e instanceof HttpError;
    if (res.headersSent) {
      // Ответ уже начат — второй writeHead уронил бы процесс.
      if (!known) console.error(`saas-gateway ${(req.url || "").split("?")[0]}:`, e && e.stack ? e.stack : e);
      return;
    }
    // Непредусмотренная ошибка (Firestore, сеть, баг) — подробности только в
    // журнал сервера: наружу они выдавали бы внутреннее устройство
    // платформы (пути, коллекции, тексты исключений библиотек).
    if (!known) console.error(`saas-gateway ${(req.url || "").split("?")[0]}:`, e && e.stack ? e.stack : e);
    // gateway: true — ошибка самого сервиса, а не проксированного ответа
    // провайдера (см. handleAiProxy и _errorFor в tooken_client.dart).
    sendJson(res, known ? e.status : 500, {
      error: known ? e.message : "Внутренняя ошибка сервера — попробуйте ещё раз чуть позже",
      gateway: true,
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  const urlPath = (req.url || "").split("?")[0];
  if (req.method === "GET" && urlPath === "/health") return sendJson(res, 200, { ok: true, version: SERVER_VERSION });
  if (req.method === "GET" && urlPath === "/downloadBuild") return runHandler(handleDownloadBuild, req, res);
  // Гостевой APK по QR стола — без входа.
  if (req.method === "GET" && urlPath === "/publicGuestApk") return runHandler(handlePublicGuestApk, req, res);
  if (req.method === "GET" && urlPath === "/guestDemoApk") return runHandler(handleGuestDemoApk, req, res);
  if (req.method === "GET" && urlPath === "/windowsDemo") return runHandler(handleWindowsDemo, req, res);
  if (req.method === "GET" && urlPath === "/firebaseConfig") return runHandler(handleFirebaseWebConfig, req, res);
  // Адрес доставки для курьера — по подписанной ссылке из карточки в Telegram.
  if (req.method === "GET" && urlPath === "/deliveryAddress") return runHandler(telegram.handleAddress, req, res);
  // Обновления Telegram-бота заведения: /tgHook/<tenantId>, секрет в заголовке.
  if (req.method === "POST" && urlPath.startsWith("/tgHook/")) {
    return runHandler((rq, rs) => telegram.handleHook(rq, rs, urlPath.slice("/tgHook/".length)), req, res);
  }
  // Робокасса может слать Result/Success/Fail и методом GET (выбирается в
  // «Технических настройках» магазина).
  if (req.method === "GET" && urlPath === "/robokassaResult") return runHandler(handleAnyRobokassaResult, req, res);
  if (req.method === "GET" && (urlPath === "/robokassaSuccess" || urlPath === "/robokassaFail")) return runHandler(handleAnyRobokassaReturn, req, res);
  // Онлайн-оплата гостя: Result URL Робокассы заведения и страница возврата из банка.
  if (req.method === "GET" && urlPath === "/guestPayRobokassa") return runHandler(handleAnyRobokassaResult, req, res);
  if (req.method === "GET" && urlPath === "/guestPayDone") return runHandler(handleAnyRobokassaReturn, req, res);
  if (req.method !== "POST") return sendJson(res, 405, { error: "метод не поддерживается" });

  const handler = ROUTES[urlPath];
  if (!handler) return sendJson(res, 404, { error: "адрес не найден" });
  runHandler(handler, req, res);
});

scheduleDemoCleanup();
scheduleBillingCron();
scheduleUsageCron();
scheduleCapabilitiesCron();
schedulePlatformMetricsCron();
scheduleCertificateCheck();
scheduleFirestoreBackup();
scheduleAiSecretsMigration();
scheduleBuildsSweep();
scheduleAppRollout();
scheduleMenuPopularity();
scheduleDailyJob("deliveryPiiRetention", 24 * 3600 * 1000, runDeliveryPiiRetention, 40 * 60 * 1000);
// Smoke-тесты поднимают сервер без секретов — бот там не нужен.
if (process.env.PORT !== "8099") {
  telegram.start();
  guestPay.startSweeper();
}

const port = Number(process.env.PORT || 8081);
server.listen(port, "127.0.0.1", () => {
  console.log(`saas-gateway listening on 127.0.0.1:${port}`);
});

module.exports = server;
// Для test.smoke.js — чистые функции счёта для ИП и организаций.
Object.assign(module.exports, { innValid, receiptDeadline, pinHashFor });
