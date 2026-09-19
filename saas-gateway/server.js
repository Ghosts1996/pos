"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

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
 * ЧТО ЭТИМ НЕ ЗАКРЫТО (сознательно, см. обсуждение с владельцем платформы):
 * приём оплаты через ЮKassa (`createCheckoutSession`, `handleBillingWebhook`,
 * `chargeRecurringSubscriptions`), приглашение сотрудников по email
 * (`inviteTenantMember`), включение/отключение заведения и смена тарифа
 * супер-админом (`enableTenant`/`disableTenant`/`changeTenantPlan`) —
 * остаются на Cloud Functions/Blaze как есть. На момент внедрения платформа
 * ещё не принимает реальные платежи (только тестовые/демо-заведения), так
 * что это не блокирует текущий этап.
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
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-callback-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

  sendJson(res, 200, { tenantId, slug });
}

// ----------------------------------------------------- createBuildJob

async function githubDispatchBuild({ tenantId, jobId, appLabel, logoUrl, tenantSlug, inviteCode }) {
  const token = process.env.GITHUB_PAT;
  if (!token) throw new Error("GITHUB_PAT не настроен на сервере");
  const inputs = { tenant_id: tenantId, job_id: jobId, app_label: appLabel };
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
  const { tenantId, type } = body;
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

  const jobRef = firestore.collection("buildJobs").doc();
  const jobId = jobRef.id;
  await jobRef.set({
    tenantId,
    type: type || "apk",
    status: "queued",
    requestedBy: decoded.uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    completedAt: null,
    downloadPath: null,
    runUrl: null,
    errorMessage: null,
  });

  let appLabel = "Hookah POS (SaaS)";
  let logoUrl = "";
  try {
    const branding = await firestore.collection("tenants").doc(tenantId).collection("branding").doc("config").get();
    if (branding.exists) {
      appLabel = branding.data().shortName || branding.data().appName || appLabel;
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
    await githubDispatchBuild({ tenantId, jobId, appLabel, logoUrl, tenantSlug, inviteCode });
  } catch (e) {
    await jobRef.update({
      status: "failed",
      errorMessage: String(e),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    throw new HttpError(500, "Не удалось запустить сборку в GitHub Actions — см. запись в buildJobs");
  }

  await writeAuditLog({ tenantId, actorId: decoded.uid, action: "buildJobRequested", metadata: { jobId } });
  sendJson(res, 200, { jobId });
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
 * Отдаёт владельцу/админу заведения готовый личный APK — единственный GET
 * с проверкой прав в этом файле (остальные операции — POST с JSON-телом,
 * см. ROUTES/server ниже). GET осознанно: консоль скачивает файл через
 * fetch()+blob (см. downloadBuild в saas/console/console.js), а не через
 * window.open() — тому нельзя передать заголовок Authorization, а
 * скачивание должно быть закрыто именно им (файл не публичный).
 */
async function handleDownloadBuild(req, res) {
  const decoded = await verifyAuth(req);
  const requestUrl = new URL(req.url, "http://localhost");
  const jobId = requestUrl.searchParams.get("jobId") || "";
  if (!/^[A-Za-z0-9]+$/.test(jobId)) throw new HttpError(400, "некорректный jobId");

  const jobDoc = await db().collection("buildJobs").doc(jobId).get();
  if (!jobDoc.exists) throw new HttpError(404, "сборка не найдена");
  const job = jobDoc.data();
  if (job.status !== "success") throw new HttpError(409, "сборка ещё не готова");

  await requireTenantRole(job.tenantId, decoded.uid, ["owner", "admin"]);

  const filePath = path.join(TENANT_BUILDS_DIR, job.tenantId, `${jobId}.apk`);
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (_) {
    throw new HttpError(404, "файл сборки не найден на сервере — попробуйте собрать заново");
  }

  res.writeHead(200, {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="hookah-pos-${jobId}.apk"`,
    "Access-Control-Allow-Origin": "*",
  });
  fs.createReadStream(filePath).pipe(res);
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

const DEMO_MENU = [
  {
    category: "Кальяны",
    items: [
      { name: "Классический кальян", price: 1200 },
      { name: "Кальян на молоке", price: 1500 },
      { name: "Премиум-микс", price: 1800 },
    ],
  },
  {
    category: "Напитки",
    items: [
      { name: "Чай чёрный", price: 350 },
      { name: "Лимонад", price: 400 },
      { name: "Морс", price: 350 },
    ],
  },
  {
    category: "Снэки",
    items: [
      { name: "Орешки", price: 300 },
      { name: "Фруктовая тарелка", price: 700 },
      { name: "Чипсы", price: 250 },
    ],
  },
];

function seedDemoData(tenantRef, batch) {
  DEMO_TABLES.forEach((t) => {
    batch.set(tenantRef.collection("tables").doc(), {
      name: t.name,
      x: t.x,
      y: t.y,
      seats: t.seats,
      shape: t.shape,
      status: "free",
      activeSessionIds: [],
      maxOpenSessions: 2,
      busyUntil: null,
      openChecks: [],
    });
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
        imageUrl: "",
        weight: 0,
        weightUnit: "",
        inventoryItemId: "",
        components: [],
      });
    });
  });
  // PIN-коды нарочно простые — заведение живёт несколько часов и стирается
  // само (см. purgeDemoTenant), это не боевые учётные данные.
  batch.set(tenantRef.collection("employees").doc(), { name: "Демо-админ", pinCode: "1111", role: "admin" });
  batch.set(tenantRef.collection("employees").doc(), { name: "Демо-сотрудник", pinCode: "2222", role: "employee" });
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
  seedDemoData(tenantRef, batch);
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
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

  const handler = ROUTES[urlPath];
  if (!handler) return sendJson(res, 404, { error: "not found" });
  runHandler(handler, req, res);
});

scheduleDemoCleanup();

const port = Number(process.env.PORT || 8081);
server.listen(port, "127.0.0.1", () => {
  // Слушаем только localhost — снаружи виден через nginx (443, тот же
  // сертификат, что у pii-gateway, путь /saas/*), см. README.md.
  console.log(`saas-gateway listening on 127.0.0.1:${port}`);
});

module.exports = server;
