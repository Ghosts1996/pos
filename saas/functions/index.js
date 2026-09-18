/**
 * Cloud Functions платформы Colibri POS SaaS.
 *
 * Отдельный проект/деплой от functions/ в корне репозитория (те
 * обслуживают одно живое заведение и не должны меняться). Здесь живут
 * ТОЛЬКО привилегированные операции, которые нельзя доверить клиенту:
 * создание/блокировку tenant, обработку платёжных webhook'ов, постановку
 * задач на сборку APK и подсчёт usage для Super Admin.
 *
 * Требует тариф Blaze (исходящие вызовы/секреты/scheduler недоступны на
 * бесплатном Spark) — это осознанное решение при переходе на SaaS,
 * отдельное от бесплатного тарифа основного (одно-арендного) проекта.
 *
 * Развёртывание:
 *   cd saas/functions && npm i
 *   firebase deploy --only functions --project <ваш-saas-project-id>
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const REGION = "europe-west1";

// -------------------------------------------------------------- helpers

/** Список зарезервированных slug — совпадение с системными путями/поддоменами
 *  недопустимо (например "admin" или "api" не должны стать именем заведения). */
const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "www", "download", "support", "billing",
  "docs", "static", "assets", "cdn", "mail", "status", "help",
]);

/**
 * Нормализует и валидирует slug заведения.
 *
 * Это значение потом используется и в URL (tenant-slug.yourdomain.com), и
 * как основа Android package name (com.colibripos.client.<slug>) — то есть
 * ошибка здесь становится инъекцией в две разные системы. Разрешены только
 * строчные латинские буквы, цифры и дефис, 3–40 символов, не может
 * начинаться/заканчиваться дефисом или содержать "--" (двусмысленно с URL-
 * кодированием) — что автоматически исключает "../", кавычки, пробелы,
 * шелл-спецсимволы и произвольный XML/Gradle синтаксис.
 */
function normalizeSlug(raw) {
  if (typeof raw !== "string") {
    throw new HttpsError("invalid-argument", "Название-код заведения обязательно");
  }
  const slug = raw.trim().toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new HttpsError(
      "invalid-argument",
      "Код заведения: только латинские буквы, цифры и дефис, без пробелов и спецсимволов"
    );
  }
  if (slug.length < 3 || slug.length > 40) {
    throw new HttpsError("invalid-argument", "Код заведения должен быть от 3 до 40 символов");
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new HttpsError("invalid-argument", "Этот код зарезервирован платформой, выберите другой");
  }
  return slug;
}

async function requireSuperAdmin(uid) {
  if (!uid) throw new HttpsError("unauthenticated", "Нужен вход");
  const doc = await db.collection("superAdmins").doc(uid).get();
  if (!doc.exists) throw new HttpsError("permission-denied", "Только для супер-администратора платформы");
}

function randomInviteCode() {
  // Без символов, которые легко перепутать при ручном вводе на планшете
  // (0/O, 1/I/l) — тот же алфавит, что и короткий код устройства гостя
  // в основном приложении (см. lib/client/services/kolibri_auth_service.dart).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function writeAuditLog({ tenantId, actorId, action, metadata }) {
  await db.collection("auditLogs").add({
    tenantId: tenantId || null,
    actorId: actorId || null,
    action,
    metadata: metadata || {},
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ---------------------------------------------------------- createTenant

/**
 * Создаёт новое заведение: единственный способ появления записи в
 * tenants/{tenantId} — правила Firestore явно запрещают клиенту создавать
 * её напрямую (см. saas/firestore.rules), чтобы обход тарифных лимитов и
 * онбординга был невозможен в принципе, а не только "неудобен".
 *
 * Вызывающий становится owner нового заведения. Заводит: сам tenant,
 * первое членство, дефолтные настройки (в т.ч. таймер кальяна — TOR §12),
 * дефолтный брендинг, код приглашения устройств, пробную подписку.
 */
exports.createTenant = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Нужен вход в платформу");

  const { name, slug: rawSlug, planId } = request.data || {};
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
    throw new HttpsError("invalid-argument", "Название заведения: от 2 до 80 символов");
  }
  const slug = normalizeSlug(rawSlug || name);

  const existing = await db.collection("tenants").where("slug", "==", slug).limit(1).get();
  if (!existing.empty) {
    throw new HttpsError("already-exists", "Этот код заведения уже занят, выберите другой");
  }

  const tenantRef = db.collection("tenants").doc();
  const tenantId = tenantRef.id;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const trialDays = 14; // TOR §34 — конфигурируемый срок; пока константа, вынести в plans при необходимости

  const batch = db.batch();

  batch.set(tenantRef, {
    name: name.trim(),
    slug,
    status: "trial",
    subscriptionStatus: "trial",
    planId: planId || "start",
    ownerUserId: uid,
    createdAt: now,
    updatedAt: now,
  });

  batch.set(db.collection("tenantMembers").doc(`${tenantId}_${uid}`), {
    tenantId,
    userId: uid,
    role: "owner",
    status: "active",
    createdAt: now,
  });

  batch.set(tenantRef.collection("settings").doc("general"), {
    name: name.trim(),
    timezone: "Europe/Moscow",
    currency: "RUB",
    language: "ru",
  });

  // TOR §12 — длительность кальяна конфигурируема с самого создания
  // заведения, а не хардкод где-то в Dart-коде.
  batch.set(tenantRef.collection("settings").doc("session"), {
    defaultHookahDurationMinutes: 90,
    minimumHookahDurationMinutes: 30,
    maximumHookahDurationMinutes: 360,
    quickExtensions: [15, 30, 60],
  });

  batch.set(tenantRef.collection("branding").doc("config"), {
    appName: name.trim(),
    shortName: name.trim().slice(0, 12),
    primaryColor: "#12B886",
    secondaryColor: "#0E1512",
    accentColor: "#F06595",
    backgroundColor: "#0E1512",
    textColor: "#EAF3EF",
    buttonColor: "#12B886",
    darkMode: true,
  });

  // Код приглашения устройств — замена общего на всю платформу staffSecret
  // из одно-арендной версии: у каждого заведения свой код, компрометация
  // одного не открывает данные остальных.
  batch.set(tenantRef.collection("settings").doc("deviceInvite"), {
    code: randomInviteCode(),
    rotatedAt: now,
  });

  batch.set(db.collection("subscriptions").doc(tenantId), {
    tenantId,
    planId: planId || "start",
    status: "trial",
    provider: null,
    externalSubscriptionId: null,
    startedAt: now,
    trialEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() + trialDays * 86400000),
    currentPeriodStart: now,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  });

  batch.set(db.collection("users").doc(uid), { lastActiveTenantId: tenantId }, { merge: true });

  await batch.commit();
  await writeAuditLog({ tenantId, actorId: uid, action: "tenantCreated", metadata: { slug } });

  return { tenantId, slug };
});

// ------------------------------------------------------ resolveTenantBySlug

/**
 * По коду заведения (из URL вида tenant-slug.yourdomain.com или из
 * download.yourdomain.com/{tenantSlug}) отдаёт публичный branding —
 * ничего приватного (без owner, без счётчиков использования, без роли
 * вызывающего — вызывающий может быть вообще не авторизован).
 */
exports.resolveTenantBySlug = onCall({ region: REGION }, async (request) => {
  const slug = normalizeSlug((request.data || {}).slug);
  const snap = await db.collection("tenants").where("slug", "==", slug).limit(1).get();
  if (snap.empty) throw new HttpsError("not-found", "Заведение с таким кодом не найдено");
  const tenant = snap.docs[0];
  if (tenant.data().status === "deleted") {
    throw new HttpsError("not-found", "Заведение с таким кодом не найдено");
  }
  const branding = await tenant.ref.collection("branding").doc("config").get();
  return {
    tenantId: tenant.id,
    name: tenant.data().name,
    status: tenant.data().status,
    branding: branding.exists ? branding.data() : null,
  };
});

// --------------------------------------------------- enable/disableTenant

exports.disableTenant = onCall({ region: REGION }, async (request) => {
  await requireSuperAdmin(request.auth?.uid);
  const { tenantId, reason } = request.data || {};
  if (typeof tenantId !== "string" || !tenantId) {
    throw new HttpsError("invalid-argument", "Не указан tenantId");
  }
  await db.collection("tenants").doc(tenantId).update({
    status: "suspended",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await writeAuditLog({
    tenantId,
    actorId: request.auth.uid,
    action: "tenantSuspended",
    metadata: { reason: reason || null },
  });
  return { ok: true };
});

exports.enableTenant = onCall({ region: REGION }, async (request) => {
  await requireSuperAdmin(request.auth?.uid);
  const { tenantId } = request.data || {};
  if (typeof tenantId !== "string" || !tenantId) {
    throw new HttpsError("invalid-argument", "Не указан tenantId");
  }
  await db.collection("tenants").doc(tenantId).update({
    status: "active",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await writeAuditLog({ tenantId, actorId: request.auth.uid, action: "tenantEnabled" });
  return { ok: true };
});

// ------------------------------------------------------------- calculateUsage

/**
 * Раз в сутки пересчитывает usage каждого активного заведения — это то,
 * что видит Super Admin (TOR §46), и в будущем основа для проверки
 * тарифных лимитов (maxEmployees/maxDevices/maxTables и т.п.).
 *
 * Считает только количества (count()), не читает содержимое документов —
 * дёшево по чтениям даже при большом числе заведений.
 */
exports.calculateUsage = onSchedule(
  { region: REGION, schedule: "every 24 hours" },
  async () => {
    const tenants = await db.collection("tenants").where("status", "in", ["trial", "active", "past_due"]).get();
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
);

// --------------------------------------------------- handleBillingWebhook

/**
 * ЗАГОТОВКА. Провайдер биллинга ещё не выбран (Stripe/YooKassa/CloudPayments
 * и т.п. — Фаза 5 по ТЗ), поэтому подпись webhook'а здесь проверить нечем:
 * реализовать её вслепую, без реального провайдера и его секрета
 * подписи, означало бы либо принимать неаутентифицированные запросы (дыра
 * в безопасности — кто угодно смог бы прислать "invoice.paid" и продлить
 * себе подписку бесплатно), либо выдумать формат, который не совпадёт с
 * реальным провайдером. Оставлено честной заготовкой с уже готовым
 * идемпотентным каркасом (TOR §14/§37: authenticated, idempotent,
 * retry-safe, logged) — при выборе провайдера сюда добавляется проверка
 * подписи в начале функции, дальше каркас не меняется.
 */
exports.handleBillingWebhook = onCall({ region: REGION }, async (request) => {
  // TODO(billing): проверить подпись запроса конкретного провайдера ДО
  // того, как читать request.data — иначе это не webhook, а открытая дверь.
  throw new HttpsError(
    "failed-precondition",
    "Провайдер биллинга не подключён — см. TODO(billing) в saas/functions/index.js"
  );

  // Ниже — каркас на будущее (недостижим, пока throw выше не убран):
  // eslint-disable-next-line no-unreachable
  const { eventId, type, tenantId, data } = request.data || {};
  if (!eventId) throw new HttpsError("invalid-argument", "Нет eventId — webhook не идемпотентен без него");

  const eventRef = db.collection("billingEvents").doc(eventId);
  await db.runTransaction(async (tx) => {
    const seen = await tx.get(eventRef);
    if (seen.exists) return; // уже обработан — повтор webhook'а не должен применяться дважды
    tx.set(eventRef, { type, tenantId, receivedAt: admin.firestore.FieldValue.serverTimestamp() });

    const subRef = db.collection("subscriptions").doc(tenantId);
    if (type === "invoice.paid") {
      tx.update(subRef, { status: "active" });
    } else if (type === "invoice.failed") {
      tx.update(subRef, { status: "past_due" });
    } else if (type === "subscription.cancelled") {
      tx.update(subRef, { status: "cancelled", cancelAtPeriodEnd: true });
    }
  });
  return { ok: true };
});

// ------------------------------------------------------------ createBuildJob

/**
 * ЗАГОТОВКА. Постановка задачи на сборку APK требует решить, КАК именно
 * Cloud Function запускает существующий GitHub Actions pipeline
 * (.github/workflows/build-apk.yml) с параметрами конкретного tenant —
 * это либо GitHub REST API "workflow_dispatch" с personal access token
 * заведения-платформы (хранится в Secret Manager, не в Firestore), либо
 * repository_dispatch. Не реализовано вслепую, чтобы не заложить в токен
 * доступа больше прав, чем нужно, и не собирать APK без реальной проверки
 * лимитов тарифа. Каркас документа задачи и статусов — уже по TOR §21.
 */
exports.createBuildJob = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  const { tenantId, type } = request.data || {};
  if (!uid || !tenantId) throw new HttpsError("unauthenticated", "Нужен вход и tenantId");

  const memberDoc = await db.collection("tenantMembers").doc(`${tenantId}_${uid}`).get();
  const role = memberDoc.data()?.role;
  if (!memberDoc.exists || !["owner", "admin"].includes(role)) {
    throw new HttpsError("permission-denied", "Собирать APK может владелец или админ заведения");
  }

  const sub = await db.collection("subscriptions").doc(tenantId).get();
  if (!sub.exists || !["trial", "active"].includes(sub.data().status)) {
    throw new HttpsError("failed-precondition", "Подписка неактивна — сборка APK недоступна");
  }

  throw new HttpsError(
    "unimplemented",
    "Запуск GitHub Actions пока не реализован (нужен выбор способа аутентификации к GitHub API) — " +
      "см. TODO в saas/functions/index.js. Задача НЕ создана."
  );

  // Каркас на будущее (недостижим):
  // eslint-disable-next-line no-unreachable
  const jobRef = db.collection("buildJobs").doc();
  await jobRef.set({
    tenantId,
    type: type || "android_guest",
    status: "queued",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    startedAt: null,
    finishedAt: null,
    downloadUrl: null,
    commit: null,
    error: null,
  });
  return { buildId: jobRef.id };
});
