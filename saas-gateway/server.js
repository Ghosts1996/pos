"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { execFile } = require("child_process");

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
 * ЧТО ЭТИМ НЕ ЗАКРЫТО (сознательно, см. обсуждение с владельцем платформы):
 * приглашение сотрудников по email (`inviteTenantMember`) — остаётся на
 * Cloud Functions/Blaze как есть (нужен Admin SDK auth().getUserByEmail —
 * привилегированная операция, но сам по себе email-инвайт не блокирует
 * приём платежей, поэтому его перенос отложен отдельно).
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
 *     claude/pos-continued, не main: пока весь код SaaS-платформы живёт
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
const GITHUB_REF = process.env.GITHUB_REF || "claude/pos-continued";

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

/** См. одноимённую функцию в saas/functions/index.js — та же проверка. */
async function requireSuperAdmin(uid) {
  if (!uid) throw new HttpError(401, "Нужен вход");
  const doc = await db().collection("superAdmins").doc(uid).get();
  if (!doc.exists) throw new HttpError(403, "Только для супер-администратора платформы");
}

/** См. одноимённую функцию в saas/functions/index.js — та же проверка. */
async function requireTenantRole(tenantId, uid, allowedRoles) {
  const memberDoc = await db().collection("tenantMembers").doc(`${tenantId}_${uid}`).get();
  const member = memberDoc.data();
  if (!memberDoc.exists || member.status !== "active" || !allowedRoles.includes(member.role)) {
    throw new HttpError(403, "Недостаточно прав в этом заведении");
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
  sendJson(res, 200, { tenantId: tenant.id, status: tenant.data().status });
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

async function handleCreateTenant(req, res) {
  const decoded = await verifyAuth(req);
  if (!decoded.email_verified) {
    throw new HttpError(412, "Подтвердите email, прежде чем создавать заведение");
  }

  const body = await parseJsonBody(req);
  const { name, slug: rawSlug, planId } = body;
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
    throw new HttpError(400, "Название заведения: от 2 до 80 символов");
  }
  const slug = normalizeSlug(rawSlug || name);

  const firestore = db();
  const existing = await firestore.collection("tenants").where("slug", "==", slug).limit(1).get();
  if (!existing.empty) throw new HttpError(409, "Этот код заведения уже занят, выберите другой");

  const tenantRef = firestore.collection("tenants").doc();
  const tenantId = tenantRef.id;
  const uid = decoded.uid;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const resolvedPlanId = planId || "start";
  const planSnap = await firestore.collection("plans").doc(resolvedPlanId).get();
  const trialDays = Number(planSnap.data()?.trialDays) || 7;

  const batch = firestore.batch();
  batch.set(tenantRef, {
    name: name.trim(),
    slug,
    status: "trial",
    subscriptionStatus: "trial",
    planId: resolvedPlanId,
    ownerUserId: uid,
    createdAt: now,
    updatedAt: now,
  });
  batch.set(firestore.collection("tenantMembers").doc(`${tenantId}_${uid}`), {
    tenantId, userId: uid, role: "owner", status: "active", createdAt: now,
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
  batch.set(firestore.collection("users").doc(uid), { lastActiveTenantId: tenantId }, { merge: true });

  await batch.commit();
  await writeAuditLog({ tenantId, actorId: uid, action: "tenantCreated", metadata: { slug } });

  // Не await: выпуск сертификата занимает несколько секунд (обращение к
  // Let's Encrypt) — владелец не должен ждать это внутри ответа на
  // создание заведения. Ошибка (если Let's Encrypt недоступен, лимит
  // запросов и т.п.) не должна ронять само создание заведения — только
  // логируется, см. docstring provisionTenantDomain.
  provisionTenantDomain(slug).catch((e) => {
    console.error(`provisionTenantDomain(${slug}) не удался:`, e.message || e);
  });

  sendJson(res, 200, { tenantId, slug });
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

async function githubDispatchBuild({ tenantId, jobIdPos, jobIdKolibri, appLabel, logoUrl, tenantSlug, inviteCode }) {
  const token = process.env.GITHUB_PAT;
  if (!token) throw new Error("GITHUB_PAT не настроен на сервере");
  // Один запуск workflow, но два job_id — saas-on-demand-build.yml собирает
  // ОБА приложения матрицей (см. её же комментарий), каждое отчитывается о
  // своём результате в свой buildJobs-документ.
  const inputs = { tenant_id: tenantId, job_id_pos: jobIdPos, job_id_kolibri: jobIdKolibri, app_label: appLabel };
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
  await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);

  const firestore = db();
  const sub = await firestore.collection("subscriptions").doc(tenantId).get();
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

  // Одно нажатие «Собрать APK» — два приложения (см. build-apk.yml, откуда
  // и пришла сама идея матрицы): касса для владельца и гостевое приложение
  // «Colibri Lounge» для его гостей (брендинг заведения общий для обоих —
  // логотип и название берутся из тех же tenants/{tenantId}/branding).
  // Каждое — свой buildJobs-документ, поэтому в консоли сразу видно 2
  // записи «в очереди», и каждая получает свою ссылку «Скачать» по
  // готовности независимо от второй.
  const firestoreNow = admin.firestore.FieldValue.serverTimestamp();
  const jobRefPos = firestore.collection("buildJobs").doc();
  const jobRefKolibri = firestore.collection("buildJobs").doc();
  const jobIdPos = jobRefPos.id;
  const jobIdKolibri = jobRefKolibri.id;
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
  createBatch.set(jobRefPos, { ...baseJob, type: "pos" });
  createBatch.set(jobRefKolibri, { ...baseJob, type: "guest" });
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
    await githubDispatchBuild({ tenantId, jobIdPos, jobIdKolibri, appLabel, logoUrl, tenantSlug, inviteCode });
  } catch (e) {
    const failUpdate = {
      status: "failed",
      errorMessage: String(e),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await Promise.all([jobRefPos.update(failUpdate), jobRefKolibri.update(failUpdate)]);
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
  const { tenantId } = body;
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");
  await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);

  const subRef = db().collection("subscriptions").doc(tenantId);
  const subDoc = await subRef.get();
  if (!subDoc.exists) throw new HttpError(404, "Подписка не найдена");
  await subRef.update({ cancelAtPeriodEnd: cancel });
  await writeAuditLog({
    tenantId,
    actorId: decoded.uid,
    action: cancel ? "subscriptionCancelRequested" : "subscriptionCancelWithdrawn",
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

const BILLING_PERIOD_DAYS = { monthly: 30, yearly: 365 };
const GRACE_PERIOD_DAYS = 10;

/** Цена тарифа за billingPeriod ('monthly'|'yearly'); yearly без заданного
 *  priceRubYearly считается недоступным. */
function planPriceForPeriod(plan, billingPeriod) {
  if (billingPeriod === "yearly") return Number(plan.priceRubYearly) || 0;
  return Number(plan.priceRub) || 0;
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
  const res = await fetch(`https://api.yookassa.ru/v3/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`YooKassa ${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
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
  const { tenantId, planId, returnUrl, billingPeriod: rawBillingPeriod } = await parseJsonBody(req);
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");
  if (typeof planId !== "string" || !planId) throw new HttpError(400, "Не указан тариф");
  if (typeof returnUrl !== "string" || !returnUrl) {
    throw new HttpError(400, "Не передан адрес возврата после оплаты");
  }
  const billingPeriod = rawBillingPeriod === "yearly" ? "yearly" : "monthly";
  await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);

  const planDoc = await db().collection("plans").doc(planId).get();
  if (!planDoc.exists) throw new HttpError(404, "Тариф не найден");
  const plan = planDoc.data();
  const price = planPriceForPeriod(plan, billingPeriod);
  if (price <= 0) {
    throw new HttpError(412, billingPeriod === "yearly"
      ? "Для этого тарифа не задана годовая цена — оформите помесячную оплату или обратитесь в поддержку"
      : "Этот тариф не продаётся напрямую — свяжитесь с поддержкой платформы");
  }

  const payment = await yookassaRequest("payments", {
    method: "POST",
    idempotenceKey: crypto.randomUUID(),
    body: {
      amount: { value: price.toFixed(2), currency: "RUB" },
      capture: true,
      save_payment_method: true,
      confirmation: { type: "redirect", return_url: returnUrl },
      description: `Hookah POS — тариф «${plan.name || planId}» (${billingPeriod === "yearly" ? "год" : "месяц"}), заведение ${tenantId}`,
      metadata: { tenantId, planId, billingPeriod, purpose: "subscription" },
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

  let payment;
  try {
    payment = await yookassaRequest(`payments/${paymentId}`);
  } catch (e) {
    console.error("saas-gateway: не удалось перепроверить платёж в ЮKassa", e.message || e);
    throw new HttpError(502, "upstream error");
  }

  const tenantId = payment.metadata?.tenantId;
  const planId = payment.metadata?.planId;
  // Старые платежи (до появления годовой оплаты) не несут этого поля —
  // трактуем как помесячные, это было единственным вариантом на тот момент.
  const billingPeriod = payment.metadata?.billingPeriod === "yearly" ? "yearly" : "monthly";
  if (!tenantId || !planId) {
    // Платёж без наших metadata — не от этой платформы, но раз ЮKassa
    // прислала его на наш webhook, отвечаем 200, чтобы не получать
    // бесконечные повторы того, что мы всё равно никогда не обработаем.
    sendJson(res, 200, { ok: true, ignored: true });
    return;
  }

  const firestore = db();
  const eventRef = firestore.collection("billingEvents").doc(paymentId);
  const alreadyProcessed = await firestore.runTransaction(async (tx) => {
    const seen = await tx.get(eventRef);
    if (seen.exists) return true;
    tx.set(eventRef, {
      tenantId, planId, billingPeriod, status: payment.status,
      // Сумма — для аналитики платформы (панель Super Admin, выручка): без
      // неё пришлось бы на каждый показ дохода дёргать API ЮKassa отдельно
      // по каждому платежу, вместо одного чтения Firestore.
      amount: Number(payment.amount?.value) || 0,
      purpose: payment.metadata?.purpose || "subscription",
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return false;
  });
  if (alreadyProcessed) {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (payment.status === "succeeded") {
    const periodDays = BILLING_PERIOD_DAYS[billingPeriod];
    const periodEnd = admin.firestore.Timestamp.fromMillis(Date.now() + periodDays * 86400000);
    const update = {
      tenantId, planId, billingPeriod,
      status: "active",
      provider: "yookassa",
      externalSubscriptionId: paymentId,
      currentPeriodStart: admin.firestore.FieldValue.serverTimestamp(),
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    };
    // save_payment_method делает способ оплаты сохранённым только с согласия
    // платёжной системы — сохраняем payment_method_id, только когда ЮKassa
    // это подтвердила.
    if (payment.payment_method?.saved) update.paymentMethodId = payment.payment_method.id;

    // set+merge, а не update: не роняем webhook 500-й ошибкой (ЮKassa будет
    // бесконечно ретраить), если документ заведения почему-то ещё не
    // существует — webhook обязан быть maximally resilient.
    await firestore.collection("subscriptions").doc(tenantId).set(update, { merge: true });
    await firestore.collection("tenants").doc(tenantId).set({
      status: "active",
      planId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await writeAuditLog({ tenantId, actorId: null, action: "subscriptionPaid", metadata: { paymentId, planId } });
  } else if (payment.status === "canceled") {
    await writeAuditLog({ tenantId, actorId: null, action: "subscriptionPaymentCanceled", metadata: { paymentId, planId } });
  }

  sendJson(res, 200, { ok: true });
}

/** Переводит и подписку, и само заведение в past_due синхронно и
 *  фиксирует момент начала льготного периода — см. одноимённую функцию в
 *  saas/functions/index.js, та же логика. Не трогает pastDueSince, если он
 *  уже стоит — иначе повторный вызов отодвигал бы дедлайн удаления. */
async function markPastDue(tenantId, subRef) {
  const sub = (await subRef.get()).data();
  const update = { status: "past_due" };
  if (!sub?.pastDueSince) update.pastDueSince = admin.firestore.FieldValue.serverTimestamp();
  await subRef.set(update, { merge: true });
  await db().collection("tenants").doc(tenantId).set({
    status: "past_due",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

/** Реально стирает операционные данные заведения после истечения льготного
 *  периода — см. purgeTenantData в saas/functions/index.js, та же логика.
 *  В отличие от purgeDemoTenant выше, здесь НАМЕРЕННО остаются сам
 *  tenant-документ (статус "deleted") и подписка (статус "cancelled") —
 *  история для поддержки/бухгалтерии, а не бесследное удаление, как у
 *  демо-заведений. */
async function purgeTenantData(tenantId) {
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
  await firestore.collection("subscriptions").doc(tenantId).set({ status: "cancelled" }, { merge: true });
  await writeAuditLog({
    tenantId, actorId: null, action: "tenantDataPurged",
    metadata: { reason: "grace_period_expired", graceDays: GRACE_PERIOD_DAYS },
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
    const tenantId = subDoc.id;
    if (sub.cancelAtPeriodEnd) continue;
    if (!sub.paymentMethodId) continue; // нечем продлить автоматически — сгорит в past_due само (см. runEnforceGracePeriod)

    const lastAttemptMs = sub.renewalAttemptedAt?.toMillis?.() ?? 0;
    if (Date.now() - lastAttemptMs < 20 * 3600000) continue;

    const planDoc = await firestore.collection("plans").doc(sub.planId).get();
    const billingPeriod = sub.billingPeriod === "yearly" ? "yearly" : "monthly";
    const price = planPriceForPeriod(planDoc.data() || {}, billingPeriod);
    if (price <= 0) continue;

    await subDoc.ref.update({ renewalAttemptedAt: admin.firestore.FieldValue.serverTimestamp() });
    try {
      await yookassaRequest("payments", {
        method: "POST",
        // Ключ детерминирован от даты окончания периода — повторный прогон
        // в тот же день не создаёт второй платёж, даже если что-то упало
        // между первой попыткой и следующим тиком.
        idempotenceKey: `renewal_${tenantId}_${sub.currentPeriodEnd.toMillis()}`,
        body: {
          amount: { value: price.toFixed(2), currency: "RUB" },
          capture: true,
          payment_method_id: sub.paymentMethodId,
          description: `Hookah POS — продление тарифа «${sub.planId}» (${billingPeriod === "yearly" ? "год" : "месяц"}), заведение ${tenantId}`,
          metadata: { tenantId, planId: sub.planId, billingPeriod, purpose: "renewal" },
        },
      });
    } catch (e) {
      console.error(`saas-gateway: не удалось продлить ${tenantId}`, e.message || e);
      await markPastDue(tenantId, subDoc.ref);
      await writeAuditLog({ tenantId, actorId: null, action: "subscriptionRenewalFailed", metadata: { error: String(e) } });
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
    await markPastDue(subDoc.id, subDoc.ref);
    await writeAuditLog({ tenantId: subDoc.id, actorId: null, action: "trialExpired" });
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
    await markPastDue(subDoc.id, subDoc.ref);
  }

  const deadline = admin.firestore.Timestamp.fromMillis(now - GRACE_PERIOD_DAYS * 86400000);
  const overdue = await firestore.collection("subscriptions")
    .where("status", "==", "past_due")
    .where("pastDueSince", "<=", deadline)
    .get();
  for (const subDoc of overdue.docs) {
    await purgeTenantData(subDoc.id);
    console.log(`saas-gateway: данные заведения ${subDoc.id} стёрты по истечении льготного периода`);
  }
}

// Раз в сутки — тот же интервал по смыслу, что и у двух отдельных Cloud
// Functions на "every 24 hours" в saas/functions/index.js; здесь это один
// таймер на оба шага, а не гарантия конкретного порядка/времени суток —
// как и в оригинале, шаги независимы и защищены собственными проверками
// (renewalAttemptedAt) от повторного срабатывания в тот же день.
const BILLING_CRON_INTERVAL_MS = 24 * 3600 * 1000;
function scheduleBillingCron() {
  setInterval(async () => {
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
  }, BILLING_CRON_INTERVAL_MS);
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

  const filePath = path.join(TENANT_BUILDS_DIR, job.tenantId, `${jobId}.apk`);
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (_) {
    throw new HttpError(404, "файл сборки не найден на сервере — попробуйте собрать заново");
  }

  // Имя файла — по типу сборки, а не всегда "hookah-pos-...": иначе кассу и
  // гостевое приложение (два независимых job'а от одного нажатия «Собрать
  // APK», см. handleCreateBuildJob) в папке «Загрузки» не отличить друг от
  // друга без переименования вручную.
  const fileNamePrefix = job.type === "guest" ? "colibri-lounge" : "hookah-pos";

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
  // идут вообще.
  res.writeHead(200, {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": `attachment; filename="${fileNamePrefix}-${jobId}.apk"`,
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

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
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
  checkDemoRateLimit(clientIp(req));

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
  await requireSuperAdmin(decoded.uid);
  const { tenantId, reason } = await parseJsonBody(req);
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");
  await db().collection("tenants").doc(tenantId).update({
    status: "suspended",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await writeAuditLog({
    tenantId, actorId: decoded.uid, action: "tenantSuspended", metadata: { reason: reason || null },
  });
  sendJson(res, 200, { ok: true });
}

async function handleEnableTenant(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded.uid);
  const { tenantId } = await parseJsonBody(req);
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");
  await db().collection("tenants").doc(tenantId).update({
    status: "active",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await writeAuditLog({ tenantId, actorId: decoded.uid, action: "tenantEnabled" });
  sendJson(res, 200, { ok: true });
}

async function handleChangeTenantPlan(req, res) {
  const decoded = await verifyAuth(req);
  await requireSuperAdmin(decoded.uid);
  const { tenantId, planId } = await parseJsonBody(req);
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");
  if (typeof planId !== "string" || !planId) throw new HttpError(400, "Не указан тариф");

  const planDoc = await db().collection("plans").doc(planId).get();
  if (!planDoc.exists) throw new HttpError(404, "Тариф не найден");

  await db().collection("tenants").doc(tenantId).update({
    planId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await writeAuditLog({
    tenantId, actorId: decoded.uid, action: "planChangedBySuperAdmin", metadata: { planId },
  });
  sendJson(res, 200, { ok: true });
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
  await requireSuperAdmin(decoded.uid);
  const { tenantId } = await parseJsonBody(req);
  if (typeof tenantId !== "string" || !tenantId) throw new HttpError(400, "Не указано заведение");

  const tenantDoc = await db().collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) throw new HttpError(404, "Заведение не найдено");
  if (tenantDoc.data().demo !== true) {
    throw new HttpError(400, "Удалить вручную можно только демо-заведение");
  }

  await purgeDemoTenant(tenantId);
  await writeAuditLog({ tenantId, actorId: decoded.uid, action: "demoTenantDeletedBySuperAdmin" });
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

// ------------------------------------------------------------- routing

const ROUTES = {
  "/resolveTenantBySlug": handleResolveTenantBySlug,
  "/createTenant": handleCreateTenant,
  "/createBuildJob": handleCreateBuildJob,
  "/completeBuildJob": handleCompleteBuildJob,
  "/createDemoTenant": handleCreateDemoTenant,
  "/cancelSubscription": (req, res) => handleSetSubscriptionCancel(req, res, true),
  "/resumeSubscription": (req, res) => handleSetSubscriptionCancel(req, res, false),
  "/disableTenant": handleDisableTenant,
  "/enableTenant": handleEnableTenant,
  "/changeTenantPlan": handleChangeTenantPlan,
  "/deleteDemoTenant": handleDeleteDemoTenant,
  "/getDownloadUrl": handleGetDownloadUrl,
  "/createCheckoutSession": handleCreateCheckoutSession,
  "/uploadBrandingLogo": handleUploadBrandingLogo,
  // Публичный (без Auth) адрес — его нужно прописать в личном кабинете
  // ЮKassa как URL для уведомлений (webhook). Подлинность проверяется
  // внутри самого handleBillingWebhook, не на уровне роутинга.
  "/billingWebhook": handleBillingWebhook,
};

function runHandler(handler, req, res) {
  handler(req, res).catch((e) => {
    const status = e instanceof HttpError ? e.status : 500;
    sendJson(res, status, { error: e.message || String(e) });
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

const port = Number(process.env.PORT || 8081);
server.listen(port, "127.0.0.1", () => {
  // Слушаем только localhost — снаружи виден через nginx (443, тот же
  // сертификат, что у pii-gateway, путь /saas/*), см. README.md.
  console.log(`saas-gateway listening on 127.0.0.1:${port}`);
});

module.exports = server;
