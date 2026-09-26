"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { execFile } = require("child_process");
const tls = require("tls");
const zlib = require("zlib");

/**
 * Онбординг SaaS-платформы Hookah POS БЕЗ Cloud Functions.
 *
 * ПОЧЕМУ этот сервис вообще существует. `createTenant`, `createBuildJob`,
 * `resolveTenantBySlug` и `completeBuildJob` жили в `saas/functions/index.js`
 * как Cloud Functions — а Cloud Functions в принципе не работают без
 * подключённого тарифа Blaze у проекта `saas-3bdc8`, независимо от того,
 * сколько реально потрачено (это ограничение самого Google, а не размера
 * счёта). Пока Blaze недоступен (нет способа его оплатить), эти функции не
 * задеплоены — значит, ни одно новое заведение не может появиться, ни одна
 * сборка APK не может запуститься. Это ровно та же логика, что и у
 * `pii-gateway/` рядом: Admin SDK Firebase работает откуда угодно, не
 * только из Cloud Functions — значит, эти четыре операции можно перенести
 * на свой сервер, где они уже НЕ требуют Blaze вообще.
 *
 * Приём оплаты через ЮKassa (`createCheckoutSession`, `handleBillingWebhook`,
 * `chargeRecurringSubscriptions`, `enforceGracePeriod`) — тоже здесь, той же
 * причине: платформа сначала не принимала реальные платежи (только
 * тестовые/демо-заведения), поэтому перенос был отложен, но остаётся ровно
 * тем же самым fetch-к-API-плюс-Admin-SDK кодом, что и остальное — см.
 * секцию "billing (ЮKassa)" ниже. saas/functions/index.js эту логику
 * по-прежнему тоже содержит (не удалялась) — как и в случае с
 * createTenant/createBuildJob, это эталонная копия на случай, если Blaze
 * когда-нибудь появится, но реально работает только версия здесь.
 *
 * Приглашение сотрудников по email (`inviteTenantMember`) — тоже здесь
 * (раньше оставалось на Cloud Functions, и кнопка «Пригласить» в консоли
 * всегда падала: функция не задеплоена).
 *
 * `enableTenant`/`disableTenant`/`changeTenantPlan` (модерация из панели
 * супер-админа) и `deleteDemoTenant` (ручное удаление демо-заведения) —
 * ТОЖЕ здесь, не Cloud Functions: кнопки в консоли раньше звали их через
 * httpsCallable на несуществующие (никогда не задеплоенные) функции и
 * молча проваливались — см. handleDisableTenant и соседей ниже.
 *
 * ВАЖНО про изоляцию данных: этот сервис использует сервисный ключ
 * ИМЕННО проекта `saas-3bdc8` — совершенно отдельного от `hoocah-pos`
 * (собственное заведение владельца платформы и вообще все одно-арендные
 * сборки). База гостей/чеков/столов конкретного заведения владельца НИКАК
 * не связана с этим сервисом и не читается и не пишется отсюда ни при
 * каких условиях — только `saas-3bdc8`, коммерческий SaaS-проект целиком
 * отдельно от личного бизнеса.
 *
 * Домен/порт: слушает только 127.0.0.1 (см. PORT), наружу смотрит тот же
 * nginx, что и pii-gateway — отдельным `location /saas/` в том же
 * серверном блоке (общий сертификат, экономим ещё один цикл DNS+certbot).
 * См. README.md.
 *
 * Переменные окружения (см. README.md и setup.sh):
 *   PORT — порт сервиса (по умолчанию 8081).
 *   FIREBASE_SERVICE_ACCOUNT_B64 — сервисный аккаунт ИМЕННО saas-3bdc8
 *     (не hoocah-pos!) в base64.
 *   GITHUB_PAT — fine-grained personal access token с правами ТОЛЬКО
 *     "Actions: read and write" на репозиторий Ghosts1996/pos.
 *   BUILD_CALLBACK_SECRET — общий секрет для проверки обратного вызова от
 *     GitHub Actions (см. handleCompleteBuildJob) — то же значение должно
 *     быть прописано в секрете репозитория BUILD_CALLBACK_SECRET.
 *   GITHUB_REF — ветка/тег, из которого GitHub должен запускать
 *     saas-on-demand-build.yml (см. GITHUB_REF ниже) — по умолчанию
 *     claude/dazzling-babbage-n65p6l, не main: пока весь код SaaS-платформы живёт
 *     именно там (main трогать нельзя, см. историю разработки), запрос на
 *     запуск workflow с ref: "main" получал от GitHub 404 — файла с таким
 *     содержимым на main просто нет. Когда ветку в итоге смержат в main,
 *     достаточно прописать GITHUB_REF=main в /etc/saas-gateway.env и
 *     перезапустить сервис — код трогать не придётся.
 *   YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY — реквизиты магазина ЮKassa (тот
 *     же кабинет, что раньше настраивался под Secret Manager Cloud
 *     Functions — теперь просто переменные окружения этого сервиса). После
 *     переноса нужно один раз поменять URL webhook'а в личном кабинете
 *     ЮKassa на https://<ваш-домен>/saas/billingWebhook — см. README.md,
 *     раздел «Биллинг».
 */

const GITHUB_OWNER = "Ghosts1996";
const GITHUB_REPO = "pos";
const GITHUB_SAAS_WORKFLOW = "saas-on-demand-build.yml";
// Ветка, в которой идёт разработка платформы (сюда же деплоится этот
// сервис — см. README.md). Прежняя claude/pos-continued отстала: сборка из
// неё выдавала заведениям старое приложение, несовместимое с текущими
// правилами базы и этим сервером.
const GITHUB_REF = process.env.GITHUB_REF || "claude/dazzling-babbage-n65p6l";

// Куда saas-on-demand-build.yml кладёт готовые личные APK по SSH (шаг
// "Deploy APK to own server" — см. её же docstring и saas/README.md,
// раздел «APK-конвейер»). НЕ Firebase Storage: у saas-3bdc8 Storage
// недоступен без Blaze (та же причина, что и у публичного APK — см.
// PUBLIC_APK_URL в saas/console/console.js). Путь per-tenant
// (tenant-builds/{tenantId}/{jobId}.apk), доступ к файлу проверяется в
// handleDownloadBuild через Firebase Auth + роль в заведении, а не просто
// статикой через nginx — эта сборка личная (лого/название заведения), не
// предназначена для публичной раздачи, в отличие от универсальной.
const TENANT_BUILDS_DIR = path.join(__dirname, "tenant-builds");

// Логотип заведения (branding.logoUrl, см. handleUploadBrandingLogo) — та
// же история, что и у TENANT_BUILDS_DIR выше: Firebase Storage у
// saas-3bdc8 требует Blaze, бакета физически не существует. В отличие от
// личных сборок APK, логотип должен быть ПУБЛИЧНО читаемым без токена
// (гостевое приложение, иконка сборки, старый Storage-правило было
// `allow read: if true`) — поэтому раздаёт его напрямую статикой сам
// nginx (location /branding/, см. README.md), без X-Accel-Redirect и
// проверки токена на чтение: только на запись (см. сам хендлер).
const BRANDING_UPLOADS_DIR = path.join(__dirname, "branding-uploads");
const BRANDING_MAX_BYTES = 5 * 1024 * 1024;
const BRANDING_CONTENT_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

// Тот же список, что и RESERVED_SLUGS в saas/functions/index.js, плюс
// "demo"/"saas" — эти два слова теперь тоже значимы в маршрутизации сервиса.
const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "www", "download", "support", "billing",
  "docs", "static", "assets", "cdn", "mail", "status", "help", "demo", "saas",
]);

// Полный список вложенных коллекций заведения — см. TENANT_SUBCOLLECTIONS в
// saas/functions/index.js и saas/firestore.rules; используется только при
// удалении просроченных демо-заведений (purgeDemoTenant).
const TENANT_SUBCOLLECTIONS = [
  "aiActions", "aiJobs", "aiLogs", "aiUsage", "auditLog", "bonusOperations",
  "branding", "clients", "devices", "discountCards", "employees",
  "giftCardClaims", "giftCards", "guestOrders", "happyHours", "inventory",
  "inventoryCounts", "inventoryMovements", "marking_codes_sold",
  "menuCategories", "menuItems", "meta", "phoneIndex", "pushQueue",
  "referralCodes", "reservationSlots", "reservations", "reviews",
  "sessionClaims", "sessions", "settings", "shifts", "staffNotes", "stories",
  "tables", "tips", "usage", "waiterCalls", "waitlist",
];

// Демо-заведения живут недолго и создаются анонимно (без email/пароля) —
// поэтому вместо ручного удаления это делает сам сервис по расписанию.
const DEMO_TTL_MS = 3 * 60 * 60 * 1000; // 3 часа с момента создания
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
    // Консоль (saas/console/console.js) — отдельный сайт (Firebase
    // Hosting), обращается сюда с другого origin, поэтому CORS обязателен;
    // Flutter-приложению он не мешает.
    //
    // GET — ради downloadBuild: браузер шлёт CORS preflight (OPTIONS) на
    // любой запрос с заголовком Authorization, включая GET, и ждёт от него
    // именно этот список методов — раньше тут было только "POST, OPTIONS",
    // из-за чего preflight на GET /downloadBuild проходил, а сам GET браузер
    // молча блокировал (не ошибка сервера — он её даже не видел).
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-callback-secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      // Тело — короткие поля (название, слаг, id) — 256KB с большим запасом.
      if (data.length > 262144) {
        reject(new HttpError(413, "тело запроса слишком большое"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || "{}");
  } catch (e) {
    throw new HttpError(400, "invalid JSON body");
  }
}

/**
 * Нормализует и валидирует slug заведения — байт-в-байт та же проверка,
 * что и в saas/functions/index.js (см. её собственный docstring там про
 * то, почему именно такой алфавит и почему это защита сразу от нескольких
 * классов инъекций).
 */
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

function randomInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
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
    throw new HttpError(401, "невалидный токен: " + e.message);
  }
}

/** Сеанс супер-админа ещё действует: вход был ПОСЛЕ последнего «Выйти на
 *  всех устройствах» (superAdmins/{uid}.sessionsValidAfter, секунды — см.
 *  handleRevokeAdminSessions; та же проверка в isSuperAdmin() в
 *  saas/firestore.rules). */
function adminSessionValid(adminData, decoded) {
  const validAfter = adminData && adminData.sessionsValidAfter;
  return typeof validAfter !== "number" || (Number(decoded.auth_time) || 0) > validAfter;
}

/** См. одноимённую функцию в saas/functions/index.js — та же проверка,
 *  плюс завершённые сеансы (adminSessionValid). Возвращает данные
 *  superAdmins/{uid}. */
async function requireSuperAdmin(decoded) {
  if (!decoded || !decoded.uid) throw new HttpError(401, "Нужен вход");
  const doc = await db().collection("superAdmins").doc(decoded.uid).get();
  if (!doc.exists) throw new HttpError(403, "Только для супер-администратора платформы");
  if (!adminSessionValid(doc.data(), decoded)) {
    throw new HttpError(401, "Сеанс панели завершён — войдите заново");
  }
  return doc.data();
}

/** Не бросает — булев вариант requireSuperAdmin для точек, где супер-админ
 *  ДОПОЛНИТЕЛЬНО к обычным владельцам может выполнить действие (например,
 *  запросить сборку APK чужого заведения из панели поддержки), а не
 *  единственный, кому оно разрешено вообще. */
async function isSuperAdmin(decoded) {
  if (!decoded || !decoded.uid) return false;
  const doc = await db().collection("superAdmins").doc(decoded.uid).get();
  return doc.exists && adminSessionValid(doc.data(), decoded);
}

// Назначить/снять супер-админа можно только сразу после ввода пароля
// (консоль вызывает reauthenticate() и шлёт свежий токен): украденный или
// забытый открытым сеанс сам по себе на это не годится. Раньше то же самое
// окно пароля было только в браузере, а правила базы пускали писать в
// superAdmins любой сеанс супер-админа напрямую.
const RECENT_AUTH_MAX_AGE_SEC = 5 * 60;
function requireRecentAuth(decoded) {
  const age = Math.floor(Date.now() / 1000) - (Number(decoded.auth_time) || 0);
  if (age > RECENT_AUTH_MAX_AGE_SEC) {
    throw new HttpError(401, "Подтвердите пароль — это действие требует недавнего входа");
  }
}

/** См. одноимённую функцию в saas/functions/index.js — та же проверка. */
async function requireTenantRole(tenantId, uid, allowedRoles) {
  const memberDoc = await db().collection("tenantMembers").doc(`${tenantId}_${uid}`).get();
  const member = memberDoc.data();
  if (!memberDoc.exists || member.status !== "active" || !allowedRoles.includes(member.role)) {
    throw new HttpError(403, "Недостаточно прав в этом заведении");
  }
}

/** Тот же принцип, что и requireTenantRole, но на уровне сети заведений
 *  (chainMembers/{chainId}_{uid}, см. saas/firestore.rules). */
async function requireChainRole(chainId, uid, allowedRoles) {
  const memberDoc = await db().collection("chainMembers").doc(`${chainId}_${uid}`).get();
  const member = memberDoc.data();
  if (!memberDoc.exists || member.status !== "active" || !allowedRoles.includes(member.role)) {
    throw new HttpError(403, "Недостаточно прав в этой сети заведений");
  }
}

/**
 * Зеркалит членство в tenantMembers на chainMembers — вызывается везде,
 * где gateway пишет tenantMembers для точки, у которой задан chainId (см.
 * docstring chainMembers в saas/firestore.rules): без этого зеркала
 * сотрудник/устройство одной точки сети не сможет читать/писать общую
 * лояльность сети (chains/{chainId}/clients и соседние коллекции) —
 * правила проверяют именно chainMembers, а не tenantMembers напрямую,
 * потому что путь до тех коллекций не содержит tenantId.
 * Не бросает исключений — членство в самой точке (tenantMembers) уже
 * записано к моменту вызова, эта запись вторична и не должна ронять
 * основную операцию.
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
 * Журнал безопасности платформы (securityLog) — отдельно от auditLogs:
 * там жизненный цикл заведений и оплаты, здесь только то, чем можно
 * навредить платформе целиком (доступ супер-админов, ручные решения по
 * деньгам и данным, блокировки). Читает только супер-админ, пишет только
 * этот сервис (saas/firestore.rules). Не бросает — основное действие уже
 * выполнено и не должно откатываться из-за журнала.
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

/** { tenantName, tenantSlug } для записи журнала безопасности — чтобы
 *  лента читалась без поиска заведения по id (и оставалась понятной после
 *  удаления заведения). */
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
 * По человекочитаемому коду заведения отдаёт tenantId — нужен ДО того, как
 * устройство вообще состоит в заведении (см. lib/services/
 * saas_device_join_service.dart), поэтому не может идти через обычные
 * Firestore-правила (allow read требует уже быть участником).
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

/**
 * По человекочитаемому коду СЕТИ отдаёт chainId и список её точек — нужен
 * гостевому веб-приложению/приложению Kolibri в режиме сети (см. docstring
 * kSaasChainMode в lib/build_info.dart) для экрана "выберите заведение
 * сети", прежде чем гость вообще выбрал точку и получил её tenantId.
 * Та же причина, что и у resolveTenantBySlug выше: недоступно по обычным
 * Firestore-правилам, пока гость ни к чему не привязан.
 */
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
    .map((d) => ({ tenantId: d.id, name: d.data().name, slug: d.data().slug, status: d.data().status }))
    .filter((t) => t.status !== "deleted")
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));

  const brandingDoc = await firestore.collection("chains").doc(chain.id).collection("branding").doc("config").get();

  sendJson(res, 200, {
    chainId: chain.id,
    name: chainData.name,
    status: chainData.status,
    branding: brandingDoc.exists ? brandingDoc.data() : null,
    locations,
  });
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
 * Публичный веб-конфиг Firebase проекта saas-3bdc8 (apiKey/authDomain/
 * projectId и т.д.) — НЕ секрет, то же самое видно в исходном коде любой
 * веб-страницы, использующей Firebase, или в собранном APK.
 *
 * Раздаём его отсюда, а не с hookahpos.su/__/firebase/init.json (тот
 * путь — приём Firebase Hosting для страниц, которые САМИ размещены на
 * этом хостинге: saas/console/console.js читает его РЕЛЯТИВНЫМ путём,
 * т.е. тем же origin, и получает его без проблем. А saas/guest-web/
 * (app.js, table.html) размещены на nginx-поддоменах {slug}.hookahpos.su
 * — ЧУЖОЙ origin для hookahpos.su, и тот путь не отдаёт CORS для чужого
 * origin: fetch с гостевого поддомена падал с "Failed to fetch" ещё до
 * какого-либо ответа сервера). Здесь тот же sendJson с уже проверенным
 * "Access-Control-Allow-Origin: *" (см. resolveTenantBySlug — оттуда же
 * гостевой веб этот сервис уже успешно зовёт).
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
 * Скачивание гостевого APK по QR со стола (см. SaaS-версию public/table.html
 * и TableQrScreen.linkFor) — единственная точка входа в весь build-конвейер,
 * которая НЕ требует Firebase Auth вообще: гость, наведший камеру на стол,
 * не вошёл ни в один SaaS-аккаунт и не может им войти.
 *
 * ВАЖНО, почему это безопасно, хотя выдаёт файл без авторизации:
 *  - отдаёт только job.type === "guest" — сборку кассы (владельческий
 *    доступ ко всем данным заведения) публично получить так нельзя ни при
 *    каком slug;
 *  - slug у заведения и так публичный (он же в адресе поддомена/QR);
 *  - сам файл — обычный гостевой APK, без секретов внутри (в отличие от
 *    кассы, которая содержит код приглашения устройства).
 * Токен на скачивание — тот же одноразовый механизм, что и у владельца
 * (signDownloadToken/handleDownloadBuild), поэтому раздача самих байт
 * ничем не отличается от уже проверенного пути.
 */
async function handlePublicGuestApk(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  const slug = normalizeSlug(requestUrl.searchParams.get("slug") || "");
  if (!slug) throw new HttpError(400, "не указан код заведения");

  const firestore = db();
  const tenantSnap = await firestore.collection("tenants").where("slug", "==", slug).limit(1).get();
  if (tenantSnap.empty) throw new HttpError(404, "Заведение с таким кодом не найдено");
  const tenantDoc = tenantSnap.docs[0];
  if (tenantDoc.data().status === "deleted") {
    throw new HttpError(404, "Заведение с таким кодом не найдено");
  }

  // Последние 20 сборок (не только гостевые — индекс buildJobs уже есть
  // только на tenantId+createdAt, отдельный композитный под type/status
  // заводить незачем) — среди них ищем самую свежую успешную гостевую.
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
  // ВАЖНО: с префиксом /saas/, а не голый /downloadBuild — в отличие от
  // handleGetDownloadUrl (её JSON-ответ подставляет префикс САМ вызывающий
  // код, знающий SAAS_GATEWAY_URL, см. console.js/downloadBuild), здесь
  // редирект шлёт сам сервер: браузер разрешает Location с ведущим `/`
  // от КОРНЯ ДОМЕНА pii.hookahpos.su, а не от точки, куда nginx примонтировал
  // этот шлюз (`location /saas/` с обрезкой префикса перед проксированием
  // в Node) — без него запрос уходил на /downloadBuild мимо nginx-маршрута
  // шлюза вообще.
  const url = `/saas/downloadBuild?jobId=${encodeURIComponent(guestJob.id)}&token=${encodeURIComponent(`${expiresAt}.${token}`)}`;
  // Обычная навигация браузера (window.location.href), не fetch/XHR — CORS
  // тут ни при чём, редирект следует сам, как за обычной ссылкой.
  res.writeHead(302, { Location: url });
  res.end();
}

// ------------------------------------------------------- createTenant

/**
 * [name, slug] — точка сети создаётся с ЧИСТЫМ chainId (не входит в
 * batch.set(tenantRef, ...) напрямую): её статус сразу "active" (не
 * "trial" — пробный период относится к сети целиком, не к отдельной новой
 * точке в уже платящей сети) и у неё НЕТ собственного subscriptions-
 * документа — биллинг только один, на chains/{chainId} (см.
 * handleCreateChain). requireChainRole здесь — та же привилегия, что и
 * "hasRole(tenantId,['owner','admin'])" для одиночного заведения, просто
 * на уровне сети.
 */
async function handleCreateTenant(req, res) {
  const decoded = await verifyAuth(req);
  if (!decoded.email_verified) {
    throw new HttpError(412, "Подтвердите email, прежде чем создавать заведение");
  }
  await requireNotBlocked(req, decoded.email, "tenant");

  const body = await parseJsonBody(req);
  const { name, slug: rawSlug, planId, chainId: rawChainId } = body;
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
  }

  const existing = await firestore.collection("tenants").where("slug", "==", slug).limit(1).get();
  if (!existing.empty) throw new HttpError(409, "Этот код заведения уже занят, выберите другой");

  const tenantRef = firestore.collection("tenants").doc();
  const tenantId = tenantRef.id;
  const now = admin.firestore.FieldValue.serverTimestamp();
  // planId с клиента доверяем как ОДИНОЧНОМУ (chainId не передан) только
  // если это ДЕЙСТВИТЕЛЬНО не тариф для сети — иначе (например, старая
  // вкладка лендинга с уже выбранным тарифом сети в localStorage, у которой
  // почему-то не отметился чекбокс "Это сеть") заведение получило бы
  // planId с per-location ценой сети без самой сети — тот же класс бага,
  // что и isChainPlan-фильтрация в консоли, только с другой стороны запроса
  // (см. симметричную проверку в handleCreateChain для обратного случая).
  let resolvedPlanId = "start";
  if (!chainId && typeof planId === "string" && planId.trim()) {
    const requestedSnap = await firestore.collection("plans").doc(planId.trim()).get();
    if (requestedSnap.exists && !requestedSnap.data().isChainPlan) resolvedPlanId = planId.trim();
  } else if (chainId) {
    // Точка сети (chainId уже провалидирован выше) не имеет собственного
    // тарифа вовсе — planId с клиента для нового узла сети сюда не
    // передаётся (см. addChainLocation в консоли), а если бы и был передан,
    // не должен ни на что влиять: биллинг только на chains/{chainId}.
    resolvedPlanId = "start";
  }
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
    // email — чтобы во вкладке «Команда» владелец был подписан своим
    // адресом, а не безликим «Устройство · XXXX» (так консоль подписывает
    // членства без email — планшеты, присоединённые по коду).
    tenantId, userId: uid, email: decoded.email || null, role: "owner", status: "active", createdAt: now,
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
    primaryColor: "#0B5ED7",
    secondaryColor: "#162A4A",
    accentColor: "#0B5ED7",
    backgroundColor: "#02050B",
    textColor: "#F8FAFC",
    buttonColor: "#0B5ED7",
    darkMode: true,
  });
  batch.set(tenantRef.collection("settings").doc("deviceInvite"), {
    code: randomInviteCode(), rotatedAt: now,
  });
  // Собственная подписка есть только у одиночного заведения — у точки сети
  // биллинг общий, на chains/{chainId} (см. handleCreateChain).
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
  await writeAuditLog({ tenantId, actorId: uid, action: "tenantCreated", metadata: { slug, chainId } });

  // Не await: выпуск сертификата занимает несколько секунд (обращение к
  // Let's Encrypt) — владелец не должен ждать это внутри ответа на
  // создание заведения. Ошибка (если Let's Encrypt недоступен, лимит
  // запросов и т.п.) не должна ронять само создание заведения — только
  // логируется, см. docstring provisionTenantDomain.
  provisionTenantDomain(slug).catch((e) => {
    console.error(`provisionTenantDomain(${slug}) не удался:`, e.message || e);
  });

  recordSignupEvent(req, "tenant", { uid, email: decoded.email, tenantId, slug });
  sendJson(res, 200, { tenantId, slug, chainId });
}

/**
 * Создаёт сеть заведений (владелец нескольких точек с общим биллингом и
 * общей лояльностью, см. docstring "Сети заведений (chains)" в
 * saas/firestore.rules) — пустую, без единой точки внутри: первую и все
 * следующие точки владелец добавляет отдельным вызовом handleCreateTenant
 * с тем же chainId. Тариф на сеть — per-location (за каждую точку
 * отдельно, см. planPriceForPeriod ниже: цена тарифа умножается на число
 * точек сети при выставлении счёта), поэтому сама сеть без точек стоит 0 —
 * пробный период (trialDays тарифа) начинает отсчёт сразу, как и у
 * одиночного заведения.
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
  const existing = await firestore.collection("chains").where("slug", "==", slug).limit(1).get();
  if (!existing.empty) throw new HttpError(409, "Этот код сети уже занят, выберите другой");

  const chainRef = firestore.collection("chains").doc();
  const chainId = chainRef.id;
  const now = admin.firestore.FieldValue.serverTimestamp();
  // planId с клиента доверяем, только если это ДЕЙСТВИТЕЛЬНО тариф для сети
  // (isChainPlan) — иначе, например, владелец, выбравший обычный per-venue
  // тариф на публичном лендинге (localStorage.selectedPlanId) и уже в
  // онбординге отдельно отметивший чекбокс "Это сеть", завёл бы сеть на
  // тарифе без per-location цены за доп. точку (см. chainPriceForPeriod
  // ниже) — ровно тот же класс бага, что и isChainPlan-фильтрация в
  // plansHtml()/screenLanding() консоли, только с другой стороны запроса.
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
    primaryColor: "#0B5ED7",
    secondaryColor: "#162A4A",
    accentColor: "#0B5ED7",
    backgroundColor: "#02050B",
    textColor: "#F8FAFC",
    buttonColor: "#0B5ED7",
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
 * Перевод УЖЕ РАБОТАЮЩЕГО одиночного заведения в новую сеть — владелец
 * начинает сеть с уже настроенного заведения, а не заводит пустую сеть и
 * точку в ней заново (тот путь — handleCreateChain + handleCreateTenant с
 * chainId, он для НОВЫХ точек). Заведение остаётся тем же документом,
 * просто получает chainId — дальше это первая точка сети, как любая другая.
 *
 * Переносит: подписку (статус/даты как есть, без сброса уже идущего
 * пробного периода или оплаченного периода — просто с новым planId сети),
 * брендинг (гость не должен увидеть внезапную смену оформления в день
 * перевода) и всю накопленную лояльность гостей (clients/phoneIndex/
 * referralCodes/bonusOperations) из tenants/{tenantId}/... в
 * chains/{chainId}/... — ровно те коллекции, которые AppScope.loyaltyCol
 * начинает читать оттуда же, как только у tenant появляется chainId (см. её
 * докстринг в lib/services/app_scope.dart) — клиентскому коду мигрировать
 * ничего не нужно, он просто продолжит читать по новому пути.
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
  // Только владелец — та же операция необратима без ручного вмешательства
  // поддержки (обратной кнопки "разъединить сеть" нет), решать не может
  // ни admin, ни manager.
  await requireTenantRole(tenantId, uid, ["owner"]);

  const firestore = db();
  const tenantRef = firestore.collection("tenants").doc(tenantId);
  const tenantSnap = await tenantRef.get();
  if (!tenantSnap.exists) throw new HttpError(404, "Заведение не найдено");
  const tenant = tenantSnap.data();
  if (tenant.chainId) throw new HttpError(409, "Заведение уже состоит в сети");

  const slug = normalizeSlug(rawSlug || name);
  const existingChain = await firestore.collection("chains").where("slug", "==", slug).limit(1).get();
  if (!existingChain.empty) throw new HttpError(409, "Этот код сети уже занят, выберите другой");

  // planId с клиента доверяем, только если это ДЕЙСТВИТЕЛЬНО тариф для сети
  // — та же защита, что и в handleCreateChain (симметрично).
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
  // trialDays нужен только если у заведения почему-то не оказалось
  // собственной подписки (не должно происходить в норме, но подписка —
  // не то, ради чего стоит блокировать весь перевод в сеть).
  const trialDays = oldSub ? 0 : (Number((await firestore.collection("plans").doc(resolvedPlanId).get()).data()?.trialDays) || 7);

  const branding = brandingSnap.exists ? brandingSnap.data() : {
    appName: name.trim(), shortName: name.trim().slice(0, 12),
    primaryColor: "#0B5ED7", secondaryColor: "#162A4A", accentColor: "#0B5ED7",
    backgroundColor: "#02050B", textColor: "#F8FAFC", buttonColor: "#0B5ED7", darkMode: true,
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
  // Старая подписка одиночного заведения помечается "superseded", а не
  // удаляется и не перезаписывается в "cancelled" — та же философия, что и
  // в purgeChainData/purgeTenantData: платёжная история не должна исчезать
  // бесследно, а "cancelled" звучало бы так, будто владелец отменил
  // подписку, а не перевёл её на сеть. runCalculatePlatformMetrics эту
  // подписку больше не читает — как только tenant.chainId задан, тенант
  // считается по chains-циклу, а не по своему подписочному документу.
  if (oldSub) {
    batch.set(firestore.collection("subscriptions").doc(tenantId), {
      status: "superseded", supersededByChainId: chainId, updatedAt: now,
    }, { merge: true });
  }
  // status/subscriptionStatus/planId — та же тройка значений, что
  // handleCreateTenant проставляет НОВОЙ точке сети (chainId ветка): для
  // точки сети они не отражают реальный биллинг (он общий на chains/{chainId},
  // см. TenantConfigService.refresh — subscriptionId берётся из chainId, а не
  // tenantId), planId "start" здесь — тот же незначащий дефолт, что и у
  // новой точки, а не потеря информации о РЕАЛЬНОМ тарифе (он был перенесён
  // в chains/{chainId}.planId несколькими строками выше).
  batch.update(tenantRef, {
    chainId, status: "active", subscriptionStatus: "active", planId: "start", updatedAt: now,
  });
  await batch.commit();

  // Зеркалим ВСЕХ действующих участников заведения (не только владельца) в
  // chainMembers — иначе персонал заведения, кроме владельца, потерял бы
  // доступ к общей лояльности сети сразу после конвертации (см. docstring
  // syncChainMembership выше).
  await Promise.all(membersSnap.docs.map((d) => {
    const m = d.data();
    if (m.userId === uid || m.status !== "active") return null;
    return syncChainMembership(chainId, m.userId, m.role, m.status);
  }));

  // Перенос уже накопленной лояльности гостей — CHAIN_SUBCOLLECTIONS минус
  // "branding" (её уже скопировали отдельно выше, одним документом, а не
  // коллекцией с множеством документов гостей).
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
 * Приглашение в заведение по email (вкладка «Команда» в консоли) с ролью
 * manager/employee — перенос одноимённой Cloud Function из
 * saas/functions/index.js: Cloud Functions у проекта не развёрнуты (нужен
 * тариф Blaze), и кнопка «Пригласить» всегда падала. Найти uid по email
 * может только Admin SDK — поэтому это эндпоинт, а не прямая запись с
 * клиента. Роли owner/admin здесь не выдаются намеренно (как и в правилах
 * для прямой записи tenantMembers).
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
  // Точка сети — без зеркала в chainMembers новый сотрудник не увидел бы
  // общую лояльность сети (см. docstring syncChainMembership).
  const tenantSnap = await firestore.collection("tenants").doc(tenantId).get();
  const chainId = tenantSnap.exists ? tenantSnap.data().chainId : null;
  if (chainId) await syncChainMembership(chainId, invitedUser.uid, role, "active");
  await writeAuditLog({ tenantId, actorId: uid, action: "memberInvited", metadata: { email, role } });

  sendJson(res, 200, { ok: true, userId: invitedUser.uid });
}

/** Копирует все документы одной коллекции в другую (id сохраняется) и
 *  удаляет исходные — батчами по BATCH_CHUNK, чтобы не упереться в лимит
 *  Firestore на 500 операций в одном batch, даже если у заведения, которое
 *  переводят в сеть, уже накопилось много гостей. */
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
  for (let i = 0; i < snap.docs.length; i += BATCH_CHUNK) {
    const chunk = snap.docs.slice(i, i + BATCH_CHUNK);
    const deleteBatch = firestore.batch();
    chunk.forEach((d) => deleteBatch.delete(d.ref));
    await deleteBatch.commit();
  }
}

// ------------------------------------------- provisionTenantDomain

/**
 * Автоматически выпускает Let's Encrypt сертификат и nginx-конфиг для
 * поддомена нового заведения ({slug}.hookahpos.su, см. saas/guest-web/ —
 * веб-версия гостя и страница-прослойка QR стола).
 *
 * ПОЧЕМУ не единый wildcard-сертификат на *.hookahpos.su: DNS хостится у
 * регистратора без API, поддерживаемого certbot, — wildcard требует
 * DNS-01 challenge (TXT-запись), а его без API пришлось бы продлевать
 * руками каждые ~60 дней. Вместо этого — обычный HTTP-01 (никакого API
 * DNS не требует, только чтобы поддомен резолвился на этот сервер — а он
 * уже резолвится, DNS-запись `*.hookahpos.su` заведена один раз и
 * навсегда) на КАЖДЫЙ поддомен отдельно, зато полностью автоматически:
 * этот вызов — и на выпуск, и на будущее продление (стандартный таймер
 * certbot, тот же, что уже продлевает pii.hookahpos.su, ничего
 * дополнительно настраивать не нужно — просто больше файлов сертификатов
 * под тем же механизмом).
 *
 * Требует на сервере: certbot, скрипт /usr/local/bin/provision-tenant-
 * domain.sh (создаёт webroot-сертификат + отдельный server-блок nginx по
 * шаблону и перезагружает nginx) и точечное sudo-правило, разрешающее
 * пользователю saas-gateway запускать ИМЕННО этот скрипт без пароля — см.
 * saas/README.md, раздел «Веб-версия гостя и QR стола».
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

// ----------------------------------------------------- createBuildJob

async function githubDispatchBuild({ tenantId, jobIdPos, jobIdKolibri, jobIdPosWindows, appLabel, logoUrl, tenantSlug, inviteCode }) {
  const token = process.env.GITHUB_PAT;
  if (!token) throw new Error("GITHUB_PAT не настроен на сервере");
  // Один запуск workflow, но три job_id — saas-on-demand-build.yml собирает
  // кассу и гостевое приложение под Android матрицей (см. её же
  // комментарий) плюс кассу под Windows отдельным job'ом (другой раннер,
  // другой набор шагов) — каждое отчитывается о своём результате в свой
  // buildJobs-документ.
  const inputs = {
    tenant_id: tenantId, job_id_pos: jobIdPos, job_id_kolibri: jobIdKolibri,
    job_id_pos_windows: jobIdPosWindows, app_label: appLabel,
  };
  if (logoUrl) inputs.logo_url = logoUrl;
  if (tenantSlug) inputs.tenant_slug = tenantSlug;
  if (inviteCode) inputs.invite_code = inviteCode;
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_SAAS_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: GITHUB_REF, inputs }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
}

async function handleCreateBuildJob(req, res) {
  const decoded = await verifyAuth(req);
  const body = await parseJsonBody(req);
  const { tenantId } = body;
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");
  // Супер-админ платформы может пересобрать APK ЛЮБОГО заведения (например
  // из панели платформы, кнопка "Пересобрать" у неудачной сборки в общем
  // мониторе) — в дополнение к обычному владельцу/админу самого заведения,
  // не вместо него.
  if (!(await isSuperAdmin(decoded))) {
    await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);
  }

  const firestore = db();
  // Точка сети не имеет своей subscriptions/{tenantId} — биллинг общий, на
  // subscriptions/{chainId} (см. handleCreateChain) — без этого resolve'а
  // "Собрать APK" всегда падало бы 412 для ЛЮБОЙ точки сети, даже с активной
  // подпиской: подписки под её собственным tenantId просто не существует.
  const tenantDoc = await firestore.collection("tenants").doc(tenantId).get();
  const chainId = tenantDoc.exists ? tenantDoc.data().chainId || null : null;
  const sub = await firestore.collection("subscriptions").doc(chainId || tenantId).get();
  if (!sub.exists || !["trial", "active"].includes(sub.data().status)) {
    throw new HttpError(412, "Подписка неактивна — сборка APK недоступна");
  }

  // Без этой проверки повторные нажатия «Собрать APK» (например, пока первая
  // сборка ещё идёт 5–10 минут) плодят параллельные запуски одного и того же
  // workflow — GitHub Actions это не запрещает, а буквально захламляет
  // список сборок в консоли и впустую тратит минуты Actions. Один
  // незавершённый job на заведение — этого достаточно, чтобы кнопка не
  // превращалась в очередь дублей.
  const pending = await firestore
    .collection("buildJobs")
    .where("tenantId", "==", tenantId)
    .where("status", "==", "queued")
    .limit(1)
    .get();
  if (!pending.empty) {
    throw new HttpError(409, "Сборка уже запущена — дождитесь её завершения, прежде чем запускать новую");
  }

  // Одно нажатие «Собрать APK» — три приложения (см. build-apk.yml, откуда
  // и пришла сама идея матрицы): касса для Android-планшета владельца,
  // касса для Windows (тот же lib/main.dart, отдельный job на
  // windows-latest — см. saas-on-demand-build.yml) и гостевое приложение
  // «Colibri Lounge» для его гостей (брендинг заведения общий на все —
  // логотип и название берутся из тех же tenants/{tenantId}/branding, хотя
  // касса, в отличие от гостевого, его игнорирует и на Windows тоже).
  // Каждое — свой buildJobs-документ, поэтому в консоли сразу видно 3
  // записи «в очереди», и каждая получает свою ссылку «Скачать» по
  // готовности независимо от остальных.
  const firestoreNow = admin.firestore.FieldValue.serverTimestamp();
  const jobRefPos = firestore.collection("buildJobs").doc();
  const jobRefKolibri = firestore.collection("buildJobs").doc();
  const jobRefPosWindows = firestore.collection("buildJobs").doc();
  const jobIdPos = jobRefPos.id;
  const jobIdKolibri = jobRefKolibri.id;
  const jobIdPosWindows = jobRefPosWindows.id;
  const baseJob = {
    tenantId,
    status: "queued",
    requestedBy: decoded.uid,
    createdAt: firestoreNow,
    completedAt: null,
    downloadPath: null,
    runUrl: null,
    errorMessage: null,
  };
  const createBatch = firestore.batch();
  createBatch.set(jobRefPos, { ...baseJob, type: "pos", platform: "android" });
  createBatch.set(jobRefKolibri, { ...baseJob, type: "guest", platform: "android" });
  createBatch.set(jobRefPosWindows, { ...baseJob, type: "pos", platform: "windows" });
  await createBatch.commit();

  // Название и лого заведения — это бренд ТОЛЬКО гостевого приложения
  // (saas-on-demand-build.yml игнорирует app_label/logo_url для matrix.app
  // == pos: касса всегда "Hookah POS", бренд платформы, не арендатора).
  // appName предпочтительнее shortName: shortName — снимок имени на момент
  // создания заведения (обрезка до 12 символов), который не обновляется,
  // если владелец потом переименует заведение в «Брендинге» — appName как
  // раз то самое, живое поле «Имя приложения».
  let appLabel = "Colibri Lounge";
  let logoUrl = "";
  try {
    const branding = await firestore.collection("tenants").doc(tenantId).collection("branding").doc("config").get();
    if (branding.exists) {
      appLabel = branding.data().appName || branding.data().shortName || appLabel;
      logoUrl = branding.data().logoUrl || "";
    }
  } catch (_) {
    // Не критично — сборка всё равно пойдёт с дефолтным лейблом/иконкой.
  }

  // Слаг заведения и код приглашения устройства — чтобы собранный APK сразу
  // "знал", к какому заведению он относится (см. docstring в
  // saas-on-demand-build.yml, шаг "Прописать пресет привязки устройства"):
  // владелец получает APK, который на первом экране сам присоединяется к
  // ЕГО заведению, а не показывает форму "код заведения / код приглашения"
  // как для универсальной сборки. Необязательно — если что-то не читается,
  // сборка просто пойдёт без автопривязки, ничего не ломая.
  let tenantSlug = "";
  let inviteCode = "";
  try {
    const [tenantDoc, inviteDoc] = await Promise.all([
      firestore.collection("tenants").doc(tenantId).get(),
      firestore.collection("tenants").doc(tenantId).collection("settings").doc("deviceInvite").get(),
    ]);
    tenantSlug = tenantDoc.data()?.slug || "";
    inviteCode = inviteDoc.data()?.code || "";
  } catch (_) {
    // Не критично — сборка пойдёт без автопривязки устройства.
  }

  try {
    await githubDispatchBuild({ tenantId, jobIdPos, jobIdKolibri, jobIdPosWindows, appLabel, logoUrl, tenantSlug, inviteCode });
  } catch (e) {
    const failUpdate = {
      status: "failed",
      errorMessage: String(e),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await Promise.all([jobRefPos.update(failUpdate), jobRefKolibri.update(failUpdate), jobRefPosWindows.update(failUpdate)]);
    throw new HttpError(500, "Не удалось запустить сборку в GitHub Actions — см. записи в buildJobs");
  }

  await writeAuditLog({
    tenantId,
    actorId: decoded.uid,
    action: "buildJobRequested",
    metadata: { jobIdPos, jobIdKolibri },
  });
  sendJson(res, 200, { jobIdPos, jobIdKolibri });
}

// -------------------------------------------- cancelSubscription/resume

/**
 * Самостоятельная отмена автопродления — владелец решает, что не будет
 * платить за следующий период, и сам это включает/выключает, не дожидаясь
 * поддержки. НЕ отключает доступ немедленно — chargeRecurringSubscriptions
 * и enforceGracePeriod (см. saas/functions/index.js) уже умеют учитывать
 * cancelAtPeriodEnd: просто не будет попытки списания в конце периода,
 * заведение доработает до currentPeriodEnd как обычно.
 *
 * Firestore-правила запрещают клиенту писать в subscriptions напрямую
 * (allow write: if isSuperAdmin()) — этот сервис, как и createTenant выше,
 * делает то же самое через Admin SDK, но только для СВОЕГО заведения и
 * только это одно поле.
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
  // Причина отмены (супер-админ #6) — видна в панели платформы в карточке
  // заведения, помогает понять, почему уходят, не дозваниваясь владельцу.
  // Необязательна (пустая строка — "нажал ОК, но не написал"), обрезается
  // на случай, если кто-то вставит целое эссе. При возврате автопродления
  // очищается — старая причина не должна висеть как будто актуальная.
  const cancelReason = cancel ? String(reason || "").slice(0, 500) : null;
  await subRef.update({ cancelAtPeriodEnd: cancel, cancelReason });
  await writeAuditLog({
    tenantId: isChain ? null : tenantId,
    actorId: decoded.uid,
    action: cancel ? "subscriptionCancelRequested" : "subscriptionCancelWithdrawn",
    metadata: cancel ? { reason: cancelReason, chainId: isChain ? chainId : null } : { chainId: isChain ? chainId : null },
  });
  sendJson(res, 200, { ok: true });
}

// ------------------------------------------------------------ billing (ЮKassa)

/**
 * Перенесено из saas/functions/index.js — та же логика (createCheckoutSession,
 * handleBillingWebhook, chargeRecurringSubscriptions, enforceGracePeriod) и
 * та же причина, что и у createTenant/createBuildJob выше: весь этот код —
 * REST-запросы к ЮKassa (обычный fetch) плюс запись в Firestore через Admin
 * SDK, ни то ни другое не привязано к рантайму Cloud Functions и не требует
 * Blaze. saas/functions/index.js НЕ трогаем и не удаляем оттуда — тот файл
 * остаётся эталонной, готовой к деплою копией на случай, если Blaze
 * когда-нибудь появится (тот же принцип, что уже применён к createTenant и
 * остальным перенесённым операциям); реально с этого момента работает
 * только копия здесь.
 *
 * Секреты — переменные окружения (см. README.md/setup.sh), а не Secret
 * Manager, как раньше: YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY.
 */

const BILLING_PERIOD_DAYS = { monthly: 30, semiannual: 182, yearly: 365 };
const GRACE_PERIOD_DAYS = 10;

/** Единая нормализация периода оплаты — везде, где он приходит снаружи
 *  (checkout/webhook/автопродление), а не только в одном месте: раньше
 *  "любое не yearly" молча схлопывалось в monthly, из-за чего добавление
 *  нового периода потребовало бы искать все места по отдельности. */
function normalizeBillingPeriod(raw) {
  if (raw === "yearly") return "yearly";
  if (raw === "semiannual") return "semiannual";
  return "monthly";
}

/** Цена тарифа за billingPeriod ('monthly'|'semiannual'|'yearly'); период
 *  без заданной цены (priceRubSemiannual/priceRubYearly) считается
 *  недоступным (0 — вызывающий код сам решает, что это значит). */
function planPriceForPeriod(plan, billingPeriod) {
  if (billingPeriod === "yearly") return Number(plan.priceRubYearly) || 0;
  if (billingPeriod === "semiannual") return Number(plan.priceRubSemiannual) || 0;
  return Number(plan.priceRub) || 0;
}

/**
 * Цена ОДНОЙ дополнительной точки сети за billingPeriod. По умолчанию
 * (customAdditionalPrice не включён) — столько же, сколько первая: это
 * безопасный дефолт, платформа сама никогда не занижает цену сети без
 * явного решения. Только когда владелец платформы в Тарифах отдельно
 * включил переключатель "Своя цена за доп. точку", читаются поля
 * priceRubAdditional/priceRubAdditionalSemiannual/priceRubAdditionalYearly
 * (решение "за доп. заведения цены меньше").
 *
 * ВАЖНО: это НЕ "поле не задано → как первая, 0 → бесплатно" — числовое
 * поле в форме редактирования тарифа (см. savePlan() в console.js) всегда
 * сохраняется КОНКРЕТНЫМ числом (пустое поле сохраняется как 0), поэтому
 * само значение 0 не может служить признаком "владелец платформы про это
 * поле ещё не думал" — для этого и нужен отдельный явный флаг-чекбокс, а
 * не догадки по числу.
 */
function additionalLocationPriceForPeriod(plan, billingPeriod) {
  if (!plan.customAdditionalPrice) return planPriceForPeriod(plan, billingPeriod);
  const field = billingPeriod === "yearly" ? "priceRubAdditionalYearly"
    : billingPeriod === "semiannual" ? "priceRubAdditionalSemiannual"
    : "priceRubAdditional";
  return Number(plan[field]) || 0;
}

/** Полная цена подписки сети за billingPeriod: первая точка по обычной
 *  цене тарифа + каждая следующая — по (обычно более низкой) цене доп.
 *  точки, а не flat price × locationCount, как было до появления
 *  раздельного ценообразования (см. её докстринг выше). */
function chainPriceForPeriod(plan, billingPeriod, locationCount) {
  const first = planPriceForPeriod(plan, billingPeriod);
  const additional = additionalLocationPriceForPeriod(plan, billingPeriod);
  const extra = Math.max(0, locationCount - 1);
  return first + additional * extra;
}

async function yookassaRequest(path, { method = "GET", body, idempotenceKey } = {}) {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secretKey = process.env.YOOKASSA_SECRET_KEY;
  if (!shopId || !secretKey) {
    throw new Error("YOOKASSA_SHOP_ID/YOOKASSA_SECRET_KEY не настроены на сервере");
  }
  const auth = Buffer.from(`${shopId}:${secretKey}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, "Content-Type": "application/json" };
  if (idempotenceKey) headers["Idempotence-Key"] = idempotenceKey;
  const base = (process.env.YOOKASSA_API_URL || "https://api.yookassa.ru/v3").replace(/\/+$/, "");
  const res = await fetch(`${base}/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`YooKassa ${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/**
 * Чек 54-ФЗ за подписку («Чеки от ЮKassa»). Включается переменной
 * YOOKASSA_RECEIPTS=1 — только если в кабинете ЮKassa подключена
 * отправка чеков: тогда без чека ЮKassa отклоняет платёж. Ставка НДС —
 * YOOKASSA_VAT_CODE (по умолчанию 1 — «без НДС»), система налогообложения —
 * YOOKASSA_TAX_SYSTEM_CODE (необязательно, 1–6 по справочнику ЮKassa).
 */
function yookassaReceipt(description, price, email) {
  if (process.env.YOOKASSA_RECEIPTS !== "1" || !email) return undefined;
  const receipt = {
    customer: { email },
    items: [{
      description: description.slice(0, 128),
      quantity: "1.00",
      amount: { value: price.toFixed(2), currency: "RUB" },
      vat_code: Number(process.env.YOOKASSA_VAT_CODE) || 1,
      payment_mode: "full_payment",
      payment_subject: "service",
    }],
  };
  const tax = Number(process.env.YOOKASSA_TAX_SYSTEM_CODE);
  if (tax >= 1 && tax <= 6) receipt.tax_system_code = tax;
  return receipt;
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

/** Число НЕ удалённых точек сети — тариф на сеть посчитан за каждую точку
 *  отдельно (решение владельца платформы: "за каждую точку отдельно"), а
 *  не фиксированной суммой на сеть, поэтому цену пересчитываем каждый раз
 *  заново (и здесь, при оформлении, и в runChargeRecurringSubscriptions
 *  при продлении) — владелец платит ровно за то число точек, что у него
 *  есть на момент списания, без отдельного шага "обновить тариф вручную"
 *  при добавлении/закрытии точки.
 */
async function countChainLocations(chainId) {
  const snap = await db().collection("tenants").where("chainId", "==", chainId).get();
  return snap.docs.filter((d) => d.data().status !== "deleted").length;
}

/**
 * Создаёт платёж ЮKassa на оплату тарифа и возвращает ссылку на форму
 * оплаты — консоль делает location.href на неё. Статус подписки/заведения
 * НЕ меняется здесь (платёж ещё не оплачен, только создан) — единственное
 * место, где статус становится "active", это handleBillingWebhook, после
 * того как ЮKassa подтвердит оплату.
 */
async function handleCreateCheckoutSession(req, res) {
  const decoded = await verifyAuth(req);
  const { tenantId, chainId, planId, returnUrl, billingPeriod: rawBillingPeriod } = await parseJsonBody(req);
  const isChain = typeof chainId === "string" && !!chainId;
  if (!isChain && (typeof tenantId !== "string" || !tenantId)) {
    throw new HttpError(400, "Не указано заведение");
  }
  if (typeof planId !== "string" || !planId) throw new HttpError(400, "Не указан тариф");
  if (typeof returnUrl !== "string" || !returnUrl) {
    throw new HttpError(400, "Не передан адрес возврата после оплаты");
  }
  const billingPeriod = normalizeBillingPeriod(rawBillingPeriod);
  if (isChain) {
    await requireChainRole(chainId, decoded.uid, ["owner", "admin"]);
  } else {
    await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);
  }

  const planDoc = await db().collection("plans").doc(planId).get();
  if (!planDoc.exists) throw new HttpError(404, "Тариф не найден");
  const plan = planDoc.data();
  if (planPriceForPeriod(plan, billingPeriod) <= 0) {
    throw new HttpError(412, billingPeriod === "monthly"
      ? "Этот тариф не продаётся напрямую — свяжитесь с поддержкой платформы"
      : "Для этого тарифа не задана цена на выбранный период — оформите помесячную оплату или обратитесь в поддержку");
  }
  const locationCount = isChain ? Math.max(1, await countChainLocations(chainId)) : 1;
  const price = isChain ? chainPriceForPeriod(plan, billingPeriod, locationCount) : planPriceForPeriod(plan, billingPeriod);
  const periodLabel = { monthly: "месяц", semiannual: "полгода", yearly: "год" }[billingPeriod];

  const description = isChain
    ? `Hookah POS — тариф «${plan.name || planId}» (${periodLabel}), сеть ${chainId} × ${locationCount} точек`
    : `Hookah POS — тариф «${plan.name || planId}» (${periodLabel}), заведение ${tenantId}`;
  const payment = await yookassaRequest("payments", {
    method: "POST",
    idempotenceKey: crypto.randomUUID(),
    body: {
      amount: { value: price.toFixed(2), currency: "RUB" },
      capture: true,
      save_payment_method: true,
      confirmation: { type: "redirect", return_url: returnUrl },
      description,
      receipt: yookassaReceipt(`Подписка Hookah POS: тариф «${plan.name || planId}», ${periodLabel}`, price,
        decoded.email || await billingOwnerEmail(isChain, isChain ? chainId : tenantId)),
      metadata: {
        tenantId: isChain ? null : tenantId,
        chainId: isChain ? chainId : null,
        planId, billingPeriod, purpose: "subscription",
        locationCount: isChain ? locationCount : null,
      },
    },
  });

  sendJson(res, 200, { confirmationUrl: payment.confirmation?.confirmation_url || null, paymentId: payment.id });
}

/**
 * Webhook ЮKassa — БЕЗ Firebase Auth, платёжная система не умеет посылать
 * ID-токен. Подлинность — не по факту самого POST'а, а перепроверкой
 * платежа напрямую в API ЮKassa своим секретным ключом (см. развёрнутый
 * докстринг у handleBillingWebhook в saas/functions/index.js — тот же
 * приём, ЮKassa официально не подписывает уведомления секретом, поэтому
 * доверять телу запроса нельзя, только тому, что вернул сам API по id
 * платежа). Идемпотентно через billingEvents/{paymentId} — повторная
 * доставка того же уведомления не применяет оплату дважды.
 */
async function handleBillingWebhook(req, res) {
  const body = await parseJsonBody(req);
  const paymentId = body?.object?.id;
  if (typeof paymentId !== "string" || !paymentId) throw new HttpError(400, "bad request");
  // Для чек-листа «Безопасность → Платформа»: если уведомления от ЮKassa
  // давно не приходят, адрес webhook'а в её кабинете мог сбиться, и оплаты
  // перестанут продлевать подписки. Не мешает основной обработке.
  db().collection("platformStatus").doc("billingWebhook").set({
    lastReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastEvent: typeof body.event === "string" ? body.event.slice(0, 60) : null,
  }, { merge: true }).catch((e) => console.error("platformStatus/billingWebhook:", e.message || e));

  // Уведомления о возвратах несут id возврата, а не платежа: перепроверка
  // по payments/{id} дала бы 404 → 502, и ЮKassa ретраила бы их сутки.
  // Возвраты оформляются вручную из кабинета ЮKassa — здесь только журнал.
  if (typeof body.event === "string" && body.event.startsWith("refund.")) {
    await writeAuditLog({ tenantId: null, actorId: null, action: "billingRefundNotified", metadata: { refundId: paymentId } });
    sendJson(res, 200, { ok: true, ignored: true });
    return;
  }

  let payment;
  try {
    payment = await yookassaRequest(`payments/${paymentId}`);
  } catch (e) {
    console.error("saas-gateway: не удалось перепроверить платёж в ЮKassa", e.message || e);
    throw new HttpError(502, "upstream error");
  }

  const tenantId = payment.metadata?.tenantId || null;
  const chainId = payment.metadata?.chainId || null;
  const billingId = chainId || tenantId;
  const planId = payment.metadata?.planId;
  // Старые платежи (до появления годовой/полугодовой оплаты) не несут
  // этого поля — трактуем как помесячные, это было единственным вариантом
  // на тот момент.
  const billingPeriod = normalizeBillingPeriod(payment.metadata?.billingPeriod);
  if (!billingId || !planId) {
    // Платёж без наших metadata — не от этой платформы, но раз ЮKassa
    // прислала его на наш webhook, отвечаем 200, чтобы не получать
    // бесконечные повторы того, что мы всё равно никогда не обработаем.
    sendJson(res, 200, { ok: true, ignored: true });
    return;
  }
  // Промежуточные статусы (pending, waiting_for_capture) ничего не меняют —
  // и НЕ записываются как обработанные, иначе уведомление об успешной
  // оплате того же платежа потом было бы проигнорировано.
  if (payment.status !== "succeeded" && payment.status !== "canceled") {
    sendJson(res, 200, { ok: true, pending: true });
    return;
  }

  const firestore = db();
  const eventRef = firestore.collection("billingEvents").doc(paymentId);
  const alreadyProcessed = await firestore.runTransaction(async (tx) => {
    const seen = await tx.get(eventRef);
    // applied:false — прошлая доставка упала между записью события и
    // продлением подписки: применяем ещё раз. У старых записей поля нет —
    // они были обработаны целиком.
    if (seen.exists && seen.data().applied !== false) return true;
    tx.set(eventRef, {
      tenantId, chainId, planId, billingPeriod, status: payment.status,
      // Сумма — для аналитики платформы (панель Super Admin, выручка): без
      // неё пришлось бы на каждый показ дохода дёргать API ЮKassa отдельно
      // по каждому платежу, вместо одного чтения Firestore.
      amount: Number(payment.amount?.value) || 0,
      purpose: payment.metadata?.purpose || "subscription",
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      applied: false,
    });
    return false;
  });
  if (alreadyProcessed) {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (payment.status === "succeeded") {
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
        provider: "yookassa",
        externalSubscriptionId: paymentId,
        currentPeriodStart: admin.firestore.FieldValue.serverTimestamp(),
        currentPeriodEnd: admin.firestore.Timestamp.fromMillis(base + periodDays * 86400000),
        cancelAtPeriodEnd: false,
        // Иначе при СЛЕДУЮЩЕЙ просрочке остался бы старый pastDueSince
        // (markPastDue его не перезаписывает) — и данные заведения стёрлись
        // бы в ту же ночь, без льготных 10 дней.
        pastDueSince: null,
        renewalAttemptedAt: admin.firestore.FieldValue.delete(),
      };
      // save_payment_method делает способ оплаты сохранённым только с
      // согласия платёжной системы — сохраняем payment_method_id, только
      // когда ЮKassa это подтвердила.
      if (payment.payment_method?.saved) update.paymentMethodId = payment.payment_method.id;
      // set+merge, а не update: не роняем webhook 500-й ошибкой (ЮKassa
      // будет бесконечно ретраить), если документа почему-то ещё нет.
      tx.set(subRef, update, { merge: true });
    });
    await firestore.collection(chainId ? "chains" : "tenants").doc(billingId).set({
      status: "active",
      planId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await writeAuditLog({ tenantId, actorId: null, action: "subscriptionPaid", metadata: { paymentId, planId, chainId } });
  } else {
    await writeAuditLog({ tenantId, actorId: null, action: "subscriptionPaymentCanceled", metadata: { paymentId, planId, chainId } });
  }
  await eventRef.update({ applied: true });

  sendJson(res, 200, { ok: true });
}

/** Переводит и подписку, и само заведение/сеть в past_due синхронно и
 *  фиксирует момент начала льготного периода — см. одноимённую функцию в
 *  saas/functions/index.js, та же логика. Не трогает pastDueSince, если он
 *  уже стоит — иначе повторный вызов отодвигал бы дедлайн удаления.
 *  [isChain] — subscriptions/{id} принадлежит chains/{id}, а не
 *  tenants/{id} (см. subscriptions.chainId в saas/firestore.rules). */
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

/** Реально стирает операционные данные заведения после истечения льготного
 *  периода — см. purgeTenantData в saas/functions/index.js, та же логика.
 *  В отличие от purgeDemoTenant выше, здесь НАМЕРЕННО остаются сам
 *  tenant-документ (статус "deleted") и подписка (статус "cancelled") —
 *  история для поддержки/бухгалтерии, а не бесследное удаление, как у
 *  демо-заведений.
 *  [skipSubscription] — точка сети (tenant.chainId задан) не имеет
 *  собственного subscriptions-документа (биллинг общий на сеть, см.
 *  handleCreateTenant) — писать туда "cancelled" в этом случае значило бы
 *  создать ЛИШНИЙ документ subscriptions/{tenantId}, которого раньше не
 *  было и который никто не должен читать; вызывается из purgeChainData,
 *  которая сама отмечает cancelled ОДНУ подписку сети. */
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

/** Стирает сеть целиком после истечения льготного периода: каждую живую
 *  точку — тем же purgeTenantData (без собственной подписки, см. выше),
 *  затем общую лояльность/брендинг сети и членство chainMembers. Как и у
 *  purgeTenantData, сам документ chains/{chainId} (статус "deleted") и
 *  подписка (статус "cancelled") НАМЕРЕННО остаются — история для
 *  поддержки/бухгалтерии. */
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

/** Раз в сутки продлевает подписки, у которых скоро закончится оплаченный
 *  период — см. chargeRecurringSubscriptions в saas/functions/index.js,
 *  та же логика (включая идемпотентность продления и 20-часовую защёлку
 *  от повторных попыток в один и тот же день). */
async function runChargeRecurringSubscriptions() {
  const firestore = db();
  const withinADay = admin.firestore.Timestamp.fromMillis(Date.now() + 86400000);
  const subs = await firestore.collection("subscriptions")
    .where("status", "==", "active")
    .where("provider", "==", "yookassa")
    .where("currentPeriodEnd", "<=", withinADay)
    .get();

  for (const subDoc of subs.docs) {
    const sub = subDoc.data();
    const targetId = subDoc.id;
    const isChain = !!sub.chainId;
    if (sub.cancelAtPeriodEnd) continue;
    if (!sub.paymentMethodId) continue; // нечем продлить автоматически — сгорит в past_due само (см. runEnforceGracePeriod)

    const lastAttemptMs = sub.renewalAttemptedAt?.toMillis?.() ?? 0;
    if (Date.now() - lastAttemptMs < 20 * 3600000) continue;

    const planDoc = await firestore.collection("plans").doc(sub.planId).get();
    const plan = planDoc.data() || {};
    const billingPeriod = normalizeBillingPeriod(sub.billingPeriod);
    // За сеть — цена тарифа за число точек НА МОМЕНТ продления (первая
    // точка + доп. точки по своей, обычно более низкой цене — см.
    // chainPriceForPeriod), а не то, что было при первой оплате: владелец
    // мог за прошедший период добавить или закрыть точку.
    const locationCount = isChain ? Math.max(1, await countChainLocations(targetId)) : 1;
    const price = isChain ? chainPriceForPeriod(plan, billingPeriod, locationCount) : planPriceForPeriod(plan, billingPeriod);
    if (price <= 0) continue;
    const periodLabel = { monthly: "месяц", semiannual: "полгода", yearly: "год" }[billingPeriod];

    await subDoc.ref.update({ renewalAttemptedAt: admin.firestore.FieldValue.serverTimestamp() });
    try {
      const receipt = yookassaReceipt(`Подписка Hookah POS: продление тарифа «${plan.name || sub.planId}», ${periodLabel}`,
        price, await billingOwnerEmail(isChain, targetId));
      await yookassaRequest("payments", {
        method: "POST",
        // Ключ детерминирован от даты окончания периода — повторный прогон
        // в тот же день не создаёт второй платёж, даже если что-то упало
        // между первой попыткой и следующим тиком.
        idempotenceKey: `renewal_${targetId}_${sub.currentPeriodEnd.toMillis()}`,
        body: {
          amount: { value: price.toFixed(2), currency: "RUB" },
          capture: true,
          payment_method_id: sub.paymentMethodId,
          receipt,
          description: isChain
            ? `Hookah POS — продление тарифа «${sub.planId}» (${periodLabel}), сеть ${targetId} × ${locationCount} точек`
            : `Hookah POS — продление тарифа «${sub.planId}» (${periodLabel}), заведение ${targetId}`,
          metadata: {
            tenantId: isChain ? null : targetId,
            chainId: isChain ? targetId : null,
            planId: sub.planId, billingPeriod, purpose: "renewal",
          },
        },
      });
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

/** Раз в сутки продвигает жизненный цикл подписки там, где
 *  runChargeRecurringSubscriptions не справляется сама (просроченные
 *  триалы, зависшие "active" без продления, реальное удаление данных
 *  после GRACE_PERIOD_DAYS) — см. enforceGracePeriod в
 *  saas/functions/index.js, та же логика в тех же трёх шагах. */
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
    // Списание могло быть запущено только сегодня — даём webhook'у сутки
    // дойти, прежде чем считать подписку просроченной.
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

// Раз в сутки — тот же интервал по смыслу, что и у двух отдельных Cloud
// Functions на "every 24 hours" в saas/functions/index.js; здесь это один
// таймер на оба шага, а не гарантия конкретного порядка/времени суток —
// как и в оригинале, шаги независимы и защищены собственными проверками
// (renewalAttemptedAt) от повторного срабатывания в тот же день.
/**
 * Суточная задача, переживающая перезапуски: время последнего прогона — в
 * platformStatus/cronJobs, проверка — раз в час (первая — через
 * [firstDelayMs] после старта). Раньше задачи висели на setInterval(24 ч)
 * от момента запуска процесса: каждый деплой/перезапуск сбрасывал отсчёт,
 * и при обновлениях чаще раза в сутки автопродление подписок, льготный
 * период и подсчёт usage не запускались вообще.
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
 * Раз в сутки пересчитывает usage каждого активного заведения
 * (tenants/{id}/usage/current) — то же самое, что было Cloud Function
 * calculateUsage в saas/functions/index.js (перенесено сюда по той же
 * причине, что и весь остальной этот файл — Blaze недоступен). Без неё
 * этот документ никогда не появляется, и "Требует внимания"/карточка
 * заведения в панели платформы (planLimitWarnings в console.js, уже читает
 * ровно этот путь) молча никогда не показывает превышение лимита тарифа —
 * не потому что лимиты не превышены, а потому что их физически некому
 * посчитать.
 *
 * Считает только количества (count()), не читает содержимое документов —
 * дёшево по чтениям даже при большом числе заведений.
 */
async function runCalculateUsage() {
  const firestore = db();
  const tenants = await firestore
    .collection("tenants")
    .where("status", "in", ["trial", "active", "past_due"])
    .get();
  for (const tenantDoc of tenants.docs) {
    const ref = tenantDoc.ref;
    const [employees, devices, tables, clients] = await Promise.all([
      ref.collection("employees").count().get(),
      ref.collection("devices").count().get(),
      ref.collection("tables").count().get(),
      ref.collection("clients").count().get(),
    ]);
    await ref.collection("usage").doc("current").set({
      employees: employees.data().count,
      devices: devices.data().count,
      tables: tables.data().count,
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
 * Дневной снимок платформы (супер-админ #5) — тренд регистраций и MRR по
 * дням в "Аналитике" панели платформы. Регистрации за последние N дней
 * консоль и так считает на лету из tenants.createdAt (см. watchAnalytics в
 * console.js) — снимок нужен именно для MRR: это метрика "прямо сейчас"
 * (активные подписки × цена тарифа), её нельзя посчитать задним числом,
 * если не сохранять каждый день — в отличие от регистраций, у смены
 * тарифа/отмены подписки нет истории с датой изменения.
 *
 * Один документ в день (id — дата UTC), set() перезаписывает при повторном
 * запуске в тот же день — идемпотентно, повторный прогон не плодит дубли.
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
  // Точка сети (t.chainId задан) не считаем здесь по своим status/planId —
  // оба поля у неё не отражают реальный биллинг (он общий на сеть, см.
  // handleCreateChain/handleBillingWebhook): status у точки сети всегда
  // "active" уже с момента создания (даже пока СЕТЬ ещё на пробном периоде
  // или просрочена), а planId — просто дефолт "start", который никогда не
  // синхронизируется с реальным тарифом сети. Без этого исключения MRR
  // считал бы за каждую точку сети цену случайного одиночного тарифа
  // "start" вместо настоящей per-location цены сети — см. цикл по chains
  // ниже.
  const locationCountByChain = new Map();
  tenantsSnap.docs.forEach((d) => {
    const t = d.data();
    if (t.chainId) {
      // "deleted", а не (status !== "active") — та же граница, что и в
      // countChainLocations выше: тариф на сеть считается за каждую НЕ
      // удалённую точку, приостановленные ("suspended") в их число тоже
      // входят (владелец продолжает платить за них, пока не удалит).
      if (t.status !== "deleted") locationCountByChain.set(t.chainId, (locationCountByChain.get(t.chainId) || 0) + 1);
      return;
    }
    if (t.status !== "active") return;
    activeCount += 1;
    mrr += priceByPlanId.get(t.planId) || 0;
  });
  chainsSnap.docs.forEach((d) => {
    const c = d.data();
    if (c.status !== "active") return;
    const plan = plansById.get(c.planId);
    if (!plan) return;
    const locationCount = Math.max(1, locationCountByChain.get(d.id) || 0);
    activeCount += locationCount;
    // "monthly" — та же огрубление, что и для одиночных заведений выше
    // (priceRub, без учёта того, что заведение может платить за 6/12
    // месяцев сразу) — MRR здесь везде нормируется к месячной цене тарифа.
    mrr += chainPriceForPeriod(plan, "monthly", locationCount);
  });

  const dateId = new Date().toISOString().slice(0, 10);
  await firestore.collection("platformMetrics").doc(dateId).set({
    date: dateId,
    totalTenants: tenantsSnap.size,
    activeCount,
    mrr,
    calculatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

const PLATFORM_METRICS_CRON_INTERVAL_MS = 24 * 3600 * 1000;
function schedulePlatformMetricsCron() {
  scheduleDailyJob("platformMetrics", PLATFORM_METRICS_CRON_INTERVAL_MS, runCalculatePlatformMetrics, 20 * 60 * 1000);
}

/** Ручной запуск того же самого расчёта — кнопка "Пересчитать сейчас" в
 *  разделе "Инфраструктура" панели платформы: суточный таймер задумывался
 *  для тихой фоновой работы, но после первого деплоя этой фичи (или после
 *  перезапуска сервиса) ждать до суток, чтобы просто ПРОВЕРИТЬ, что она
 *  вообще считает, неудобно. Заодно снимает и дневную метрику платформы
 *  (см. runCalculatePlatformMetrics) — та же кнопка сразу даёт первую точку
 *  графика на "Аналитике", а не через сутки ожидания фонового таймера. */
async function handleRecalculateUsage(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  await Promise.all([runCalculateUsage(), runCalculatePlatformMetrics()]);
  sendJson(res, 200, { ok: true });
}

// --------------------------------------------------- completeBuildJob

/**
 * Обратный вызов от GitHub Actions (последний шаг saas-on-demand-build.yml)
 * — см. её же секрет SAAS_COMPLETE_BUILD_JOB_URL, который нужно перевести
 * на этот сервис (README.md). Подлинность — общий секрет в заголовке, не
 * Firebase Auth: раннеру GitHub не выдаётся токен ради одного действия.
 */
async function handleCompleteBuildJob(req, res) {
  const expected = process.env.BUILD_CALLBACK_SECRET || "";
  if (!expected || req.headers["x-callback-secret"] !== expected) {
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

  await jobRef.update({
    status,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    downloadPath: status === "success" ? (downloadPath || null) : null,
    runUrl: runUrl || null,
    errorMessage: status === "failed" ? (errorMessage || "неизвестная ошибка сборки") : null,
  });
  sendJson(res, 200, { ok: true });
}

// ----------------------------------------------------- downloadBuild

/**
 * Секрет для подписи одноразовых ссылок на скачивание — генерируется
 * заново при каждом старте процесса, хранить между рестартами не нужно:
 * сама ссылка живёт всего DOWNLOAD_TOKEN_TTL_MS, случайный рестарт сервера
 * ровно в это окно — цена ещё одного клика «Скачать», не более того.
 *
 * ПОЧЕМУ так, а не проверка заголовка Authorization на самом GET (как было
 * раньше): консоль скачивала через fetch()+blob с заголовком Authorization,
 * а обычный window.open() так не может — пришлось бы либо держать сложный
 * JS-путь (fetch → blob → синтетическая ссылка), либо звать этот GET
 * напрямую без заголовка. Первый способ на практике не сработал у
 * реального пользователя (браузер молча блокировал запрос) — а разбираться
 * дальше вслепую, без доступа к консоли разработчика на его телефоне,
 * бессмысленно. Подписанная одноразовая ссылка работает как у публичного
 * APK — просто window.open() — но всё равно требует СНАЧАЛА получить её
 * через getDownloadUrl (POST, с Firebase Auth), так что чужую сборку по
 * прямому URL не скачать: угадать jobId мало, нужен ещё и свежий токен.
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

/**
 * POST, с обычной проверкой Firebase Auth + роли — выдаёт саму ссылку для
 * скачивания (см. docstring выше). Консоль сразу открывает её window.open().
 */
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

/**
 * Сам файл — единственный GET в этом файле (остальные операции — POST с
 * JSON-телом, см. ROUTES ниже). Доступ проверяется токеном из
 * handleGetDownloadUrl выше, не заголовком Authorization — см. её же
 * docstring, почему.
 */
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

  // На диске файл ВСЕГДА лежит как "{jobId}.apk" независимо от платформы —
  // это фиксированное имя пишет forced-command скрипт deploy-tenant-apk.sh
  // на сервере (см. saas/README.md), которому нужно поправить один параметр
  // ("apk"), чтобы что-то поменять, а трогать его ради Windows-сборки не
  // нужно: то, что фактически внутри архива (APK или zip Windows-сборки),
  // определяет только это тело ответа — Content-Type и имя файла в
  // Content-Disposition, а не путь на диске. Браузер сохраняет файл под
  // именем из Content-Disposition, а не по URL/пути на сервере.
  const filePath = path.join(TENANT_BUILDS_DIR, job.tenantId, `${jobId}.apk`);
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (_) {
    throw new HttpError(404, "файл сборки не найден на сервере — попробуйте собрать заново");
  }

  const isWindows = job.platform === "windows";
  // Имя файла — по типу сборки, а не всегда "hookah-pos-...": иначе кассу и
  // гостевое приложение (независимые job'ы от одного нажатия «Собрать
  // APK», см. handleCreateBuildJob) в папке «Загрузки» не отличить друг от
  // друга без переименования вручную. Windows-кассу — от Android-кассы.
  const fileNamePrefix = job.type === "guest" ? "colibri-lounge" : isWindows ? "hookah-pos-windows" : "hookah-pos";
  const fileExt = isWindows ? "zip" : "apk";
  const contentType = isWindows ? "application/zip" : "application/vnd.android.package-archive";

  // X-Accel-Redirect, не fs.createReadStream(...).pipe(res): раньше файл
  // отдавал сам Node-процесс — на реальном телефоне загрузка зависала
  // ровно на 100% (все байты приходили, но браузер/загрузчик так и не
  // считал файл завершённым — судя по всему, что-то в связке Node ⇄ nginx
  // ⇄ клиент не закрывало соединение как положено). Публичный APK
  // (downloadPublicApk) отдаёт статикой сам nginx и НИ РАЗУ не зависал за
  // всю сессию — поэтому личные сборки теперь отдаёт тоже он: этот
  // заголовок говорит nginx подменить тело ответа на файл по внутреннему
  // пути (см. location /internal-tenant-builds/ в конфиге nginx,
  // saas/README.md), а Node только решает, МОЖНО ли этому запросу вообще
  // получить файл (проверка токена выше) — байты через Node больше не
  // идут вообще. Сам внутренний путь всегда "{jobId}.apk" (см. комментарий
  // выше про filePath) независимо от того, что фактически внутри.
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${fileNamePrefix}-${jobId}.${fileExt}"`,
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Redirect": `/internal-tenant-builds/${job.tenantId}/${jobId}.apk`,
  });
  res.end();
}

// ---------------------------------------------------- uploadBrandingLogo

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "файл слишком большой"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Загрузка логотипа заведения (branding.logoUrl, раздел "Брендинг" в
 * консоли) — раньше шла напрямую в Firebase Storage из браузера, но
 * Storage у saas-3bdc8 требует платный тариф Blaze (бакета физически не
 * существует — ровно та же история, что и с публичным APK, см.
 * saas/README.md раздел 8b и BRANDING_UPLOADS_DIR выше). Тело запроса —
 * СЫРЫЕ байты картинки (Content-Type: image/png|jpeg|webp), не JSON и не
 * multipart — так проще и на клиенте (XMLHttpRequest с прогрессом), и
 * здесь: не нужен парсер multipart ради одного файла без доп. полей.
 */
async function handleUploadBrandingLogo(req, res) {
  const decoded = await verifyAuth(req);
  const requestUrl = new URL(req.url, "http://localhost");
  const tenantId = requestUrl.searchParams.get("tenantId") || "";
  if (!tenantId) throw new HttpError(400, "не указан tenantId");
  await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);

  const contentType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const ext = BRANDING_CONTENT_TYPES[contentType];
  if (!ext) throw new HttpError(400, "поддерживаются только PNG, JPEG и WebP");

  const buffer = await readRawBody(req, BRANDING_MAX_BYTES);
  if (!buffer.length) throw new HttpError(400, "пустой файл");

  const dir = path.join(BRANDING_UPLOADS_DIR, tenantId);
  await fs.promises.mkdir(dir, { recursive: true });
  // У заведения один логотип, а не история версий — если раньше грузили
  // другой формат, старый файл остался бы висеть рядом с новым и (в теории)
  // мог бы отдаться по прямой ссылке, если кто-то её угадает/сохранил.
  await Promise.all(
    Object.values(BRANDING_CONTENT_TYPES)
      .filter((oldExt) => oldExt !== ext)
      .map((oldExt) => fs.promises.unlink(path.join(dir, `logo.${oldExt}`)).catch(() => {}))
  );
  await fs.promises.writeFile(path.join(dir, `logo.${ext}`), buffer);

  // Домен сюда сознательно не зашиваем (см. отсутствие PUBLIC_BASE_URL во
  // всём этом файле) — консоль и так уже знает свой SAAS_GATEWAY_URL и
  // достраивает из него origin сама (см. uploadBrandingLogo в console.js).
  sendJson(res, 200, { path: `/branding/${tenantId}/logo.${ext}` });
}

/**
 * Фото блюд и категорий меню кассы (раньше — общий бакет Supabase, где
 * файлы всех заведений лежали в одной папке и любое заведение могло
 * перезаписать или удалить чужие). Теперь — в папку своего заведения
 * рядом с логотипом: публичное чтение статикой nginx (/branding/, меню
 * видят гости), запись — только персонал этого заведения. Тело — сырые
 * байты картинки, как у uploadBrandingLogo.
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
 * Настоящий IP клиента. nginx (см. README.md, location /saas/) кладёт его в
 * X-Real-IP и ДОПИСЫВАЕТ в конец X-Forwarded-For ($proxy_add_x_forwarded_for).
 * Первый элемент X-Forwarded-For присылает сам клиент — раньше брался
 * именно он, и лимит на демо-заведения (а с ним и любые проверки по IP)
 * обходился одним поддельным заголовком.
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

const DEMO_TABLES = [
  { name: "Стол 1", x: 0.15, y: 0.2, seats: 4, shape: "rect" },
  { name: "Стол 2", x: 0.45, y: 0.2, seats: 2, shape: "circle" },
  { name: "Стол 3", x: 0.75, y: 0.2, seats: 6, shape: "rect" },
  { name: "Стол 4", x: 0.15, y: 0.6, seats: 4, shape: "rect" },
  { name: "Стол 5", x: 0.45, y: 0.6, seats: 2, shape: "circle" },
  { name: "Стол 6", x: 0.75, y: 0.6, seats: 8, shape: "rect" },
];

// Фото — стабильные ссылки на Wikimedia Commons (Special:FilePath — это
// официально предназначенный для внешнего хотлинка редирект на текущий
// файл, а не догадка о прямом пути на upload.wikimedia.org, который может
// смениться при переименовании). Свободные лицензии, править/показывать
// можно. Если конкретное фото когда-нибудь всё же пропадёт — не критично:
// _MenuImage в приложении молча откатывается на нейтральную иконку вместо
// сломанной картинки (см. menu_selection_screen.dart), а не ломает экран.
const WIKI_FILE = (name) => `https://commons.wikimedia.org/wiki/Special:FilePath/${name}`;

const DEMO_MENU = [
  {
    category: "Кальяны",
    items: [
      { name: "Классический кальян", price: 1200, image: WIKI_FILE("Hookah_2.jpg") },
      { name: "Кальян на молоке", price: 1500, image: WIKI_FILE("Hookah_0890.jpg") },
      { name: "Премиум-микс", price: 1800, image: WIKI_FILE("Shisha_hookah.jpg") },
    ],
  },
  {
    category: "Напитки",
    items: [
      { name: "Чай чёрный", price: 350, image: WIKI_FILE("Cup_of_black_tea.JPG") },
      { name: "Лимонад", price: 400, image: WIKI_FILE("Mug_of_Lemonade.jpg") },
      { name: "Морс", price: 350, image: WIKI_FILE("Glass_of_Mango_Juice.jpg") },
    ],
  },
  {
    category: "Снэки",
    items: [
      { name: "Орешки", price: 300, image: WIKI_FILE("Mixed_nuts_small_white2.jpg") },
      { name: "Фруктовая тарелка", price: 700, image: WIKI_FILE("Fruit_plate_with_fresh_fruits.jpg") },
      { name: "Чипсы", price: 250, image: WIKI_FILE("Potato_Chips.jpg") },
    ],
  },
];

// Готовые "чеки" для двух столов из истории (закрыты, оплачены) — чтобы
// в демо-заведении сразу было что показать в отчётах/истории смены, а не
// только пустой зал. minutesAgoStart/End — когда чек был открыт/закрыт
// относительно момента создания демо (см. seedDemoData ниже).
const DEMO_CLOSED_RECEIPTS = [
  {
    tableName: "Стол 1",
    minutesAgoStart: 150,
    minutesAgoEnd: 100,
    items: [
      { name: "Классический кальян", price: 1200, qty: 1 },
      { name: "Орешки", price: 300, qty: 1 },
    ],
    paymentMethod: "cash",
  },
  {
    tableName: "Стол 3",
    minutesAgoStart: 260,
    minutesAgoEnd: 190,
    items: [
      { name: "Кальян на молоке", price: 1500, qty: 2 },
      { name: "Морс", price: 350, qty: 2 },
      { name: "Чипсы", price: 250, qty: 1 },
    ],
    paymentMethod: "card",
  },
];

// Столы, занятые ПРЯМО СЕЙЧАС (активный, ещё не закрытый чек) — чтобы зал
// в демо выглядел живым, а не как только что созданное пустое заведение.
const DEMO_ACTIVE_SESSIONS = [
  {
    tableName: "Стол 2",
    guestTag: "Аня",
    minutesAgoStart: 25,
    durationMinutes: 90,
    items: [
      { name: "Кальян на молоке", price: 1500, qty: 1 },
      { name: "Лимонад", price: 400, qty: 2 },
    ],
  },
  {
    tableName: "Стол 5",
    guestTag: "Компания у окна",
    minutesAgoStart: 10,
    durationMinutes: 90,
    items: [
      { name: "Премиум-микс", price: 1800, qty: 1 },
      { name: "Фруктовая тарелка", price: 700, qty: 1 },
      { name: "Чай чёрный", price: 350, qty: 3 },
    ],
  },
];

function seedDemoData(tenantRef, batch, nowMs) {
  const tableRefsByName = {};
  DEMO_TABLES.forEach((t) => {
    tableRefsByName[t.name] = { ref: tenantRef.collection("tables").doc(), config: t };
  });

  DEMO_MENU.forEach((cat, ci) => {
    const catRef = tenantRef.collection("menuCategories").doc();
    batch.set(catRef, { name: cat.category, order: ci, imageUrl: "" });
    cat.items.forEach((item) => {
      batch.set(tenantRef.collection("menuItems").doc(), {
        categoryId: catRef.id,
        name: item.name,
        price: item.price,
        available: true,
        imageUrl: item.image || "",
        weight: 0,
        weightUnit: "",
        inventoryItemId: "",
        components: [],
      });
    });
  });

  // PIN-коды нарочно простые и совпадают с тем, что написано на лендинге
  // рядом с кнопкой скачивания демо-APK (см. screenLanding() в console.js)
  // — заведение живёт несколько часов и стирается само (purgeDemoTenant),
  // это не боевые учётные данные. Длина PIN соответствует роли (см.
  // AppConstants.pinLengthForRole) — иначе экран входа с этим кодом просто
  // не пустит: у сотрудника 4 цифры, у администратора 6.
  batch.set(tenantRef.collection("employees").doc(), { name: "Демо-сотрудник", pinCode: "1111", role: "employee" });
  batch.set(tenantRef.collection("employees").doc(), { name: "Демо-админ", pinCode: "111111", role: "admin" });

  const orderItemsOf = (items) => items.map((i) => ({ menuItemId: "", name: i.name, price: i.price, qty: i.qty }));
  const ts = (minutesAgo) => admin.firestore.Timestamp.fromMillis(nowMs - minutesAgo * 60000);

  // Активные чеки — стол переходит в "занят" (status/activeSessionIds/
  // busyUntil/openChecks) ровно так же, как это делает openSession() в
  // самом приложении (см. FirestoreService.openSession), просто одним
  // батчем при создании, а не через реальное "Начать сеанс".
  DEMO_ACTIVE_SESSIONS.forEach((s) => {
    const table = tableRefsByName[s.tableName];
    const sessionRef = tenantRef.collection("sessions").doc();
    const startTime = ts(s.minutesAgoStart);
    const plannedEnd = admin.firestore.Timestamp.fromMillis(
      nowMs - s.minutesAgoStart * 60000 + s.durationMinutes * 60000
    );
    batch.set(sessionRef, {
      tableId: table.ref.id,
      tableName: s.tableName,
      employeeName: "Демо-сотрудник",
      guestTag: s.guestTag,
      startTime,
      plannedEnd,
      refillCount: 0,
      refillHistory: [],
      discountCardId: null,
      discountPercent: 0,
      orderItems: orderItemsOf(s.items),
      status: "active",
      closedAt: null,
      paymentCash: 0, paymentCard: 0, paymentTerminal: 0, paymentComp: 0,
      guestContact: "", closedWithoutPayment: false, receiptPrinted: false, fiscalReceiptPrinted: false,
      refunded: false, refundedAt: null,
    });
    table.occupied = { sessionId: sessionRef.id, plannedEnd, startTime, guestTag: s.guestTag };
  });

  // Закрытые чеки из истории — просто документ sessions со status: 'closed'
  // и заполненной оплатой; на занятость стола не влияют (стол уже свободен,
  // как и было бы в жизни после реального закрытия чека).
  DEMO_CLOSED_RECEIPTS.forEach((r) => {
    const table = tableRefsByName[r.tableName];
    const sessionRef = tenantRef.collection("sessions").doc();
    const orderItems = orderItemsOf(r.items);
    const total = orderItems.reduce((acc, i) => acc + i.price * i.qty, 0);
    batch.set(sessionRef, {
      tableId: table.ref.id,
      tableName: r.tableName,
      employeeName: "Демо-сотрудник",
      guestTag: "",
      startTime: ts(r.minutesAgoStart),
      plannedEnd: ts(r.minutesAgoStart - 90 < 0 ? 0 : r.minutesAgoStart - 90),
      refillCount: 0,
      refillHistory: [],
      discountCardId: null,
      discountPercent: 0,
      orderItems,
      status: "closed",
      closedAt: ts(r.minutesAgoEnd),
      paymentCash: r.paymentMethod === "cash" ? total : 0,
      paymentCard: r.paymentMethod === "card" ? total : 0,
      paymentTerminal: 0, paymentComp: 0,
      guestContact: "", closedWithoutPayment: false, receiptPrinted: true, fiscalReceiptPrinted: false,
      refunded: false, refundedAt: null,
    });
  });

  Object.values(tableRefsByName).forEach(({ ref, config: t, occupied }) => {
    batch.set(ref, {
      name: t.name,
      x: t.x,
      y: t.y,
      seats: t.seats,
      shape: t.shape,
      status: occupied ? "occupied" : "free",
      activeSessionIds: occupied ? [occupied.sessionId] : [],
      maxOpenSessions: 2,
      busyUntil: occupied ? occupied.plannedEnd : null,
      openChecks: occupied
        ? [{ id: occupied.sessionId, label: occupied.guestTag, openedAt: occupied.startTime }]
        : [],
    });
  });
}

/**
 * Создаёт одноразовое тестовое заведение — без email/пароля, без владельца:
 * сразу возвращает tenantId + код приглашения устройства, чтобы клиент мог
 * присоединиться тем же путём, что и обычное устройство (см.
 * SaasDeviceJoinService.joinAsDevice), только не вводя код руками.
 * Помечено `demo: true` — по этому полю его позже найдёт и удалит
 * scheduleDemoCleanup.
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
  const slug = `demo-${randomDemoSuffix()}`;
  const tenantRef = firestore.collection("tenants").doc();
  const tenantId = tenantRef.id;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const inviteCode = randomInviteCode();

  const batch = firestore.batch();
  batch.set(tenantRef, {
    name: "Демо-заведение",
    slug,
    status: "active",
    subscriptionStatus: "active",
    planId: "start",
    ownerUserId: "",
    demo: true,
    createdAt: now,
    updatedAt: now,
  });
  batch.set(tenantRef.collection("settings").doc("general"), {
    name: "Демо-заведение", timezone: "Europe/Moscow", currency: "RUB", language: "ru",
  });
  batch.set(tenantRef.collection("settings").doc("session"), {
    defaultHookahDurationMinutes: 90,
    minimumHookahDurationMinutes: 30,
    maximumHookahDurationMinutes: 360,
    quickExtensions: [15, 30, 60],
  });
  batch.set(tenantRef.collection("branding").doc("config"), {
    appName: "Hookah POS (демо)",
    shortName: "Демо",
    primaryColor: "#0B5ED7",
    secondaryColor: "#162A4A",
    accentColor: "#0B5ED7",
    backgroundColor: "#02050B",
    textColor: "#F8FAFC",
    buttonColor: "#0B5ED7",
    darkMode: true,
  });
  batch.set(tenantRef.collection("settings").doc("deviceInvite"), { code: inviteCode, rotatedAt: now });
  batch.set(firestore.collection("subscriptions").doc(tenantId), {
    tenantId,
    planId: "start",
    status: "trial",
    provider: null,
    externalSubscriptionId: null,
    startedAt: now,
    trialEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() + 7 * 86400000),
    currentPeriodStart: now,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  });
  seedDemoData(tenantRef, batch, Date.now());
  await batch.commit();

  recordSignupEvent(req, "demo", { tenantId, slug });
  sendJson(res, 200, { tenantId, slug, inviteCode });
}

// -------------------------------------------------------- demo cleanup

async function purgeDemoTenant(tenantId) {
  const firestore = db();
  const tenantRef = firestore.collection("tenants").doc(tenantId);
  for (const name of TENANT_SUBCOLLECTIONS) {
    await firestore.recursiveDelete(tenantRef.collection(name));
  }
  await tenantRef.delete();
  await firestore.collection("subscriptions").doc(tenantId).delete().catch(() => {});
  await removeTenantUploads(tenantId);
}

// ----------------------------------------- super-admin: enable/disable/plan

/**
 * enableTenant/disableTenant/changeTenantPlan — раньше были Cloud Functions
 * (saas/functions/index.js), не задеплоены по той же причине, что и
 * createTenant/createBuildJob выше (Blaze недоступен у saas-3bdc8). Кнопки
 * «Заблокировать»/смена тарифа в панели платформы раньше звали их через
 * httpsCallable и молча проваливались (функция никогда не существовала —
 * не 403, а просто нет такого HTTP-эндпоинта вообще).
 */
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
  await db().collection("tenants").doc(tenantId).update({
    status: "active",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
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

  const tenantRef = db().collection("tenants").doc(tenantId);
  const before = (await tenantRef.get()).data() || {};
  await tenantRef.update({
    planId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await writeAuditLog({
    tenantId, actorId: decoded.uid, action: "planChangedBySuperAdmin", metadata: { planId },
  });
  await writeSecurityEvent(req, decoded, "planChangedBySuperAdmin", {
    tenantId, metadata: { ...(await tenantLabel(tenantId, before)), fromPlanId: before.planId || null, planId },
  });
  sendJson(res, 200, { ok: true });
}

/**
 * Бонусный период (супер-админ #7) — продлить доступ заведению вручную, не
 * трогая дату руками через "Ручное управление подпиской" (та форма в
 * консоли остаётся для точных исправлений, эта кнопка — для быстрого "дать
 * ещё N дней", например в благодарность за отзыв или при жалобе на баг).
 * Для триала продлевает trialEndsAt, иначе — currentPeriodEnd и сразу
 * возвращает status в "active" (снимая pastDueSince) — бонус должен снять
 * блокировку, а не тихо продлить дату у уже заблокированного заведения.
 * Отсчитывается от MAX(текущая дата окончания, сейчас) — иначе бонус,
 * выданный уже просроченному заведению, "сгорал" бы в прошлом.
 *
 * Точка сети (tenant.chainId задан) не имеет своей subscriptions/{tenantId}
 * — биллинг общий, на subscriptions/{chainId} (см. handleCreateChain) — без
 * этого resolve'а запрос всегда падал бы 404 для любой точки сети. Бонус
 * в этом случае продлевает подписку ВСЕЙ сети, а не одной точки — это и
 * есть верное поведение при общем биллинге.
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
  await writeAuditLog({
    tenantId, actorId: decoded.uid, action: "bonusPeriodGranted", metadata: { days: daysNum, chainId },
  });
  await writeSecurityEvent(req, decoded, "bonusPeriodGranted", {
    tenantId, metadata: { ...(await tenantLabel(tenantId, tenantDoc.data())), days: daysNum, chainId },
  });
  sendJson(res, 200, { ok: true, chainId });
}

/**
 * Удаление демо-заведения вручную из панели платформы — та же логика,
 * что и у автоматической ночной очистки (scheduleDemoCleanup ниже), но по
 * запросу супер-админа, не дожидаясь DEMO_TTL_MS. Намеренно ограничено
 * ТОЛЬКО демо-заведениями (tenant.demo === true) — это необратимое
 * рекурсивное удаление всех данных, давать его на произвольный (платящий)
 * tenantId из этой же кнопки было бы слишком лёгким способом снести чужие
 * реальные данные одним случайным кликом.
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

/**
 * Ручная правка подписки из карточки заведения в панели платформы
 * (статус, «оплачено до», «триал до») — по сути выдача или отключение
 * доступа без оплаты. Раньше писалась прямо из браузера и нигде не
 * оставляла следа; теперь только здесь, с записью «было → стало» в журнал
 * безопасности. Точка сети правит общую подписку сети (subscriptions/
 * {chainId}), как и раньше в консоли.
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
  // Ручная правка всегда означает «разобрались вручную» — сбрасываем
  // pastDueSince, иначе отсчёт до удаления данных продолжил бы тикать.
  if (status !== "past_due") payload.pastDueSince = null;
  await subRef.set(payload, { merge: true });

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
 * Создание/правка/удаление тарифа (цены, лимиты) — раньше прямо из
 * браузера; теперь здесь, чтобы каждое изменение цены попадало в журнал
 * безопасности с «было → стало». Принимаются только известные поля своих
 * типов — произвольный мусор в публичный документ тарифа не попадёт.
 */
const PLAN_NUMBER_FIELDS = [
  "priceRub", "priceRubSemiannual", "priceRubYearly",
  "priceRubAdditional", "priceRubAdditionalSemiannual", "priceRubAdditionalYearly",
  "maxEmployees", "maxDevices", "maxTables", "maxStorageMb", "trialDays",
];
const PLAN_BOOL_FIELDS = ["isChainPlan", "customAdditionalPrice", "aiEnabled", "customBranding", "customDomain"];
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
  if (src.features && typeof src.features === "object") {
    out.features = {};
    for (const f of PLAN_FEATURE_FIELDS) out.features[f] = src.features[f] === true;
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

  // Незаданное раньше поле, пришедшее как 0/false/пусто (форма шлёт все
  // поля разом, включая скрытые поля тарифа сети), изменением не считаем —
  // иначе в журнале тонули бы настоящие изменения цен.
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
  if (create || Object.keys(changes).length) {
    await writeSecurityEvent(req, decoded, create ? "planCreated" : "planUpdated", {
      metadata: { planId, planName: fields.name || before.name || planId, changes, priceRub: fields.priceRub ?? before.priceRub ?? null },
    });
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

/**
 * Раз в DEMO_CLEANUP_INTERVAL_MS стирает демо-заведения старше DEMO_TTL_MS
 * — замена Cloud Scheduler (тоже требует Blaze) обычным setInterval внутри
 * долгоживущего systemd-процесса. Первый прогон может упасть с
 * FAILED_PRECONDITION, если в Firestore ещё нет составного индекса
 * (demo ASC, createdAt ASC, см. saas/firestore.indexes.json) — ошибка
 * содержит прямую ссылку на консоль Firebase для его создания в один клик,
 * до этого демо-заведения просто накапливаются лишние несколько часов, без
 * какого-либо сбоя для гостей/владельцев.
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
 * «Выйти на всех устройствах»: отзывает refresh-токены (новый токен уже не
 * выдать) и ставит sessionsValidAfter — по нему и этот сервис
 * (requireSuperAdmin), и правила базы (isSuperAdmin в saas/firestore.rules)
 * перестают пускать ВСЕ ранее открытые сеансы сразу, а не через час, когда
 * истечёт уже выданный токен. Свои сеансы можно завершить в любой момент;
 * чужие — только после ввода пароля (иначе украденный сеанс мог бы
 * бесконечно выкидывать настоящих админов).
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

// Не чаще раза в 10 минут на один сеанс обновляем lastSeenAt — панель
// может открываться много раз подряд, а запись в базу не бесплатна.
const ADMIN_LOGIN_TOUCH_MS = 10 * 60 * 1000;
const adminLoginTouched = new Map(); // sessionId -> ms

/**
 * Консоль вызывает при каждом открытии панели платформы. Один документ
 * adminLogins/{uid}_{auth_time} на один вход (сеанс), с IP и браузером —
 * по ним супер-админ видит в «Безопасности», откуда заходили в панель, и
 * может нажать «Это был не я». Если в течение одного сеанса сменился IP,
 * он добавляется в ips — тоже повод присмотреться.
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

// Поддомены заведений {slug}.GUEST_BASE_DOMAIN выпускает provision-tenant-
// domain.sh (certbot) на этом же сервере — поэтому сертификаты проверяем,
// подключаясь к локальному nginx (CERT_CHECK_CONNECT_HOST) с нужным SNI, а
// не через внешний IP: многие хостинги не пускают сервер к самому себе
// по публичному адресу.
const GUEST_BASE_DOMAIN = process.env.GUEST_BASE_DOMAIN || "hookahpos.su";
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
// Firestore «managed export» требует тарифа Blaze и бакета Cloud Storage —
// у saas-3bdc8 их нет (см. шапку файла). Поэтому копия делается здесь:
// все документы читаются через Admin SDK и пишутся одним сжатым JSON в
// BACKUP_DIR на этом сервере (права 600, только пользователь сервиса).
// Каждый документ — одно чтение из бесплатной квоты Firebase (50 000 в
// сутки на тарифе Spark, при превышении база встаёт до конца суток!),
// поэтому перед копией размер базы оценивается через count(): больше
// BACKUP_MAX_DOCS — копия не делается, а панель объясняет, почему.
// Восстановление — вручную, скриптом restore-backup.js (см. README.md).
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
 * ЮKassa, сроки сертификатов, резервные копии, актуальны ли правила базы,
 * передаёт ли nginx настоящий IP.
 */
const SECURITY_SECRETS = [
  ["FIREBASE_SERVICE_ACCOUNT_B64", "Сервисный ключ Firebase"],
  ["FIREBASE_WEB_CONFIG_JSON", "Веб-конфиг Firebase (гостевой веб)"],
  ["YOOKASSA_SHOP_ID", "ЮKassa: идентификатор магазина"],
  ["YOOKASSA_SECRET_KEY", "ЮKassa: секретный ключ"],
  ["GITHUB_PAT", "GitHub: токен для сборки APK"],
  ["BUILD_CALLBACK_SECRET", "Секрет ответа сборки APK"],
];
// Уникальная строка из актуального saas/firestore.rules — по ней видно,
// задеплоены ли правила с защитой завершённых сеансов супер-админов.
const RULES_FEATURE_MARKER = "adminSessionFresh";

async function handleSecurityStatus(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded);
  const firestore = db();
  const [billing, certs, backup, lastPayment, admins] = await Promise.all([
    firestore.collection("platformStatus").doc("billingWebhook").get(),
    firestore.collection("platformStatus").doc("certificates").get(),
    firestore.collection("platformStatus").doc("backup").get(),
    firestore.collection("billingEvents").orderBy("receivedAt", "desc").limit(1).get().catch(() => null),
    firestore.collection("superAdmins").get(),
  ]);
  let rules = { status: "unknown" };
  try {
    const ruleset = await getFirebaseApp().securityRules().getFirestoreRuleset();
    const source = (ruleset.source || []).map((f) => f.content).join("\n");
    rules = { status: source.includes(RULES_FEATURE_MARKER) ? "ok" : "outdated", updatedAt: ruleset.createTime || null };
  } catch (e) {
    rules = { status: "unknown", error: String(e.message || e).slice(0, 200) };
  }
  const ts = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : null);
  const b = billing.exists ? billing.data() : {};
  const lp = lastPayment && !lastPayment.empty ? lastPayment.docs[0].data() : null;
  sendJson(res, 200, {
    secrets: SECURITY_SECRETS.map(([key, label]) => ({ key, label, set: !!(process.env[key] && String(process.env[key]).trim()) })),
    githubRef: GITHUB_REF,
    billingWebhook: { lastReceivedAt: ts(b.lastReceivedAt), lastEvent: b.lastEvent || null, lastPaymentAt: lp ? ts(lp.receivedAt) : null },
    certificates: certs.exists ? { ...certs.data(), checkedAt: ts(certs.data().checkedAt) } : null,
    backup: backup.exists ? { ...backup.data(), lastRunAt: ts(backup.data().lastRunAt), lastOkAt: ts(backup.data().lastOkAt) } : null,
    backups: listBackups(),
    backupSettings: { keep: BACKUP_KEEP, maxDocs: BACKUP_MAX_DOCS, intervalHours: BACKUP_INTERVAL_MS / 3600000 },
    rules,
    realIpHeader: typeof req.headers["x-real-ip"] === "string" && !!req.headers["x-real-ip"].trim(),
    superAdmins: admins.size,
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
 * Регистрации и попытки по IP (signupEvents): создание заведения, сети,
 * демо, упор в лимит демо, отказ по блок-листу. По ним раздел
 * «Безопасность → Активность» показывает всплески с одного адреса. Читает
 * только супер-админ; IP хранится отдельно от документа заведения, чтобы
 * его не видели сотрудники заведения. Упоры в лимит и отказы пишутся не
 * чаще раза в час на IP — иначе бот сам бы заполнял коллекцию.
 */
const signupEventThrottle = new Map(); // `${type}:${ip}` -> ms
function recordSignupEvent(req, type, { uid, email, tenantId, chainId, slug } = {}) {
  const ip = clientIp(req);
  if (type === "rateLimited" || type === "blocked") {
    const key = `${type}:${ip}`;
    if (Date.now() - (signupEventThrottle.get(key) || 0) < 60 * 60 * 1000) return;
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
// Реестр запросов субъектов персональных данных (dataRequests): удалить,
// выдать копию, исправить. Гость отправляет запрос на удаление сам (кнопка
// «Удалить мои данные» в профиле веб-версии), остальные запросы (письмо,
// звонок) супер-админ заводит вручную. Срок — 30 дней с получения (ч. 5
// ст. 21 152-ФЗ), панель подсвечивает просроченные. Читает только
// супер-админ, пишет только этот сервис.
const DATA_REQUEST_DUE_DAYS = 30;
const DATA_REQUEST_KINDS = ["delete", "export", "correct"];
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
    dueAt: admin.firestore.Timestamp.fromMillis(now + DATA_REQUEST_DUE_DAYS * 86400000),
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
    dueAt: admin.firestore.Timestamp.fromMillis(now + DATA_REQUEST_DUE_DAYS * 86400000),
  });
  sendJson(res, 200, { ok: true, id: ref.id, dueAt: now + DATA_REQUEST_DUE_DAYS * 86400000 });
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

/** Найти гостя по телефону во всех заведениях и сетях — для запросов,
 *  пришедших письмом или звонком. Читает phoneIndex/{телефон} у каждого
 *  заведения и сети (без запросов по коллекциям-группам, которым нужен
 *  отдельный индекс). */
function normalizeRuPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("8")) d = `7${d.slice(1)}`;
  if (d.length === 10 && d.startsWith("9")) d = `7${d}`;
  return d;
}
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
  const clientRef = root.collection("clients").doc(clientUid);
  const clientSnap = await clientRef.get();
  if (!clientSnap.exists) throw new HttpError(404, "Профиль гостя не найден");
  const c = clientSnap.data();

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

  // Анонимный аккаунт гостя (у владельцев/сотрудников с почтой не трогаем)
  let accountDeleted = false;
  try {
    const u = await getFirebaseApp().auth().getUser(clientUid);
    if (!u.email && !u.phoneNumber && (u.providerData || []).length === 0) {
      await getFirebaseApp().auth().deleteUser(clientUid);
      accountDeleted = true;
    }
  } catch (_) {}

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

/**
 * ИИ-консьерж гостевого приложения. Ключи ИИ заведения лежат в
 * meta/aiSecrets, который читает только персонал; гость шлёт сюда тело
 * запроса к модели, а сервер подставляет адрес и ключ провайдера и
 * возвращает ответ как есть. Гость не может выбрать другую (дорогую)
 * модель или огромный лимит ответа, и у него лимит запросов — иначе
 * посторонний мог бы расходовать баланс ИИ заведения.
 */
async function handleAiProxy(req, res) {
  const decoded = await verifyAuth(req);
  const now = Date.now();
  const lim = aiProxyLimiter.get(decoded.uid);
  if (!lim || lim.resetAt <= now) {
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
  const chainId = tenantDoc.data().chainId || null;
  const loyaltyRoot = chainId ? firestore.collection("chains").doc(chainId) : tenantRef;
  const [member, client, settingsDoc, secretsDoc] = await Promise.all([
    firestore.collection("tenantMembers").doc(`${tenantId}_${decoded.uid}`).get(),
    loyaltyRoot.collection("clients").doc(decoded.uid).get(),
    tenantRef.collection("meta").doc("aiSettings").get(),
    tenantRef.collection("meta").doc("aiSecrets").get(),
  ]);
  const isMember = member.exists && member.data().status === "active";
  if (!isMember && !client.exists) throw new HttpError(403, "Нет доступа к ИИ этого заведения");
  const settings = settingsDoc.data() || {};
  if (settings.enabled !== true) throw new HttpError(403, "ИИ в этом заведении выключен");
  const vendor = resolveAiVendor(settings, secretsDoc.data() || {}, slot);
  if (!vendor || !vendor.apiKey || !vendor.baseUrl) throw new HttpError(400, "ИИ заведения не настроен");

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
    upstream = await fetch(`${vendor.baseUrl}/${upstreamPath}`, {
      method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000),
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

// ------------------------------------------------------------- routing

const ROUTES = {
  "/resolveTenantBySlug": handleResolveTenantBySlug,
  "/resolveChainBySlug": handleResolveChainBySlug,
  "/createTenant": handleCreateTenant,
  "/createChain": handleCreateChain,
  "/convertTenantToChain": handleConvertTenantToChain,
  "/inviteTenantMember": handleInviteTenantMember,
  "/createBuildJob": handleCreateBuildJob,
  "/completeBuildJob": handleCompleteBuildJob,
  "/createDemoTenant": handleCreateDemoTenant,
  "/cancelSubscription": (req, res) => handleSetSubscriptionCancel(req, res, true),
  "/resumeSubscription": (req, res) => handleSetSubscriptionCancel(req, res, false),
  "/disableTenant": handleDisableTenant,
  "/enableTenant": handleEnableTenant,
  "/changeTenantPlan": handleChangeTenantPlan,
  "/grantBonusPeriod": handleGrantBonusPeriod,
  "/deleteDemoTenant": handleDeleteDemoTenant,
  "/getDownloadUrl": handleGetDownloadUrl,
  "/createCheckoutSession": handleCreateCheckoutSession,
  "/uploadBrandingLogo": handleUploadBrandingLogo,
  "/uploadMenuImage": handleUploadMenuImage,
  "/recalculateUsage": handleRecalculateUsage,
  "/overrideSubscription": handleOverrideSubscription,
  "/savePlan": handleSavePlan,
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
  "/aiProxy": handleAiProxy,
  "/grantSuperAdmin": handleGrantSuperAdmin,
  "/revokeSuperAdmin": handleRevokeSuperAdmin,
  "/revokeAdminSessions": handleRevokeAdminSessions,
  "/recordAdminLogin": handleRecordAdminLogin,
  // Публичный (без Auth) адрес — его нужно прописать в личном кабинете
  // ЮKassa как URL для уведомлений (webhook). Подлинность проверяется
  // внутри самого handleBillingWebhook, не на уровне роутинга.
  "/billingWebhook": handleBillingWebhook,
};

function runHandler(handler, req, res) {
  handler(req, res).catch((e) => {
    const status = e instanceof HttpError ? e.status : 500;
    // gateway: true — ошибка самого сервиса, а не проксированного ответа
    // провайдера (см. handleAiProxy и _errorFor в tooken_client.dart).
    sendJson(res, status, { error: e.message || String(e), gateway: true });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  const urlPath = (req.url || "").split("?")[0];
  if (req.method === "GET" && urlPath === "/health") return sendJson(res, 200, { ok: true });
  // Единственный GET с полезной нагрузкой — скачивание готового APK (см.
  // handleDownloadBuild) — остальные операции ниже намеренно только POST.
  if (req.method === "GET" && urlPath === "/downloadBuild") return runHandler(handleDownloadBuild, req, res);
  // Без Firebase Auth — гость сканирует QR стола, не входя ни в один
  // SaaS-аккаунт (см. docstring handlePublicGuestApk).
  if (req.method === "GET" && urlPath === "/publicGuestApk") return runHandler(handlePublicGuestApk, req, res);
  // Публичный веб-конфиг Firebase — см. docstring handleFirebaseWebConfig,
  // почему НЕ hookahpos.su/__/firebase/init.json.
  if (req.method === "GET" && urlPath === "/firebaseConfig") return runHandler(handleFirebaseWebConfig, req, res);
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

  const handler = ROUTES[urlPath];
  if (!handler) return sendJson(res, 404, { error: "not found" });
  runHandler(handler, req, res);
});

scheduleDemoCleanup();
scheduleBillingCron();
scheduleUsageCron();
schedulePlatformMetricsCron();
scheduleCertificateCheck();
scheduleFirestoreBackup();
scheduleAiSecretsMigration();

const port = Number(process.env.PORT || 8081);
server.listen(port, "127.0.0.1", () => {
  // Слушаем только localhost — снаружи виден через nginx (443, тот же
  // сертификат, что у pii-gateway, путь /saas/*), см. README.md.
  console.log(`saas-gateway listening on 127.0.0.1:${port}`);
});

module.exports = server;
