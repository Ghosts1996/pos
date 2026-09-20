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
 * ЧТО ЭТИМ НЕ ЗАКРЫТО (сознательно, см. обсуждение с владельцем платформы):
 * приём оплаты через ЮKassa (`createCheckoutSession`, `handleBillingWebhook`,
 * `chargeRecurringSubscriptions`), приглашение сотрудников по email
 * (`inviteTenantMember`) — остаются на Cloud Functions/Blaze как есть. На
 * момент внедрения платформа ещё не принимает реальные платежи (только
 * тестовые/демо-заведения), так что это не блокирует текущий этап.
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
  const url = `/downloadBuild?jobId=${encodeURIComponent(guestJob.id)}&token=${encodeURIComponent(`${expiresAt}.${token}`)}`;
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
