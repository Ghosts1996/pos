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

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const REGION = "europe-west1";

// Репозиторий, чей build-apk workflow дёргает createBuildJob — тот же, что
// хранит этот код (Ghosts1996/pos), не параметр развёртывания: платформа
// всегда собирает APK из одного и того же места.
const GITHUB_OWNER = "Ghosts1996";
const GITHUB_REPO = "pos";
const GITHUB_SAAS_WORKFLOW = "saas-on-demand-build.yml";

// Секреты — заводятся один раз в Secret Manager (`firebase functions:secrets:set <ИМЯ>`),
// не хранятся в коде и не попадают в git. См. saas/README.md, раздел «Биллинг» и «APK-конвейер».
const YOOKASSA_SHOP_ID = defineSecret("YOOKASSA_SHOP_ID");
const YOOKASSA_SECRET_KEY = defineSecret("YOOKASSA_SECRET_KEY");
const GITHUB_PAT = defineSecret("GITHUB_PAT");
const BUILD_CALLBACK_SECRET = defineSecret("BUILD_CALLBACK_SECRET");

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

/**
 * Проверяет, что uid состоит в tenantId с одной из allowedRoles ролей —
 * то же самое, что проверило бы правило Firestore для прямой записи с
 * клиента, но здесь нужно явно: Admin SDK правилам не подчиняется, а
 * привилегия вызывающего в конкретном заведении — единственное, что
 * отличает "владелец приглашает себе сотрудника" от "кто угодно
 * приглашает кого угодно в чужое заведение".
 */
async function requireTenantRole(tenantId, uid, allowedRoles) {
  if (!uid) throw new HttpsError("unauthenticated", "Нужен вход в платформу");
  const memberDoc = await db.collection("tenantMembers").doc(`${tenantId}_${uid}`).get();
  const member = memberDoc.data();
  if (!memberDoc.exists || member.status !== "active" || !allowedRoles.includes(member.role)) {
    throw new HttpsError("permission-denied", "Недостаточно прав в этом заведении");
  }
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

  // Ровно палитра "Midnight Blue" из lib/theme/app_colors.dart
  // (AppColors.primary/background/textPrimary/selection) — новое
  // заведение без кастомного брендинга должно выглядеть байт-в-байт как
  // проверенный одно-арендный продукт, а не какой-то другой палитрой по
  // умолчанию (см. lib/models/tenant_models.dart, BrandingConfig).
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

// -------------------------------------------------------- inviteTenantMember

/**
 * Приглашает уже зарегистрированного в консоли пользователя (по email) в
 * заведение с ролью manager/employee.
 *
 * Почему это Cloud Function, а не прямая запись с клиента (как для
 * device-присоединения, см. saas/firestore.rules, tenantMembers.create):
 * владелец знает email приглашаемого, но не его Firebase Auth uid — а
 * найти uid по email может только Admin SDK (admin.auth().getUserByEmail),
 * это привилегированная операция, недоступная клиенту в принципе, а не
 * просто закрытая правилами.
 *
 * Роль 'owner'/'admin' здесь НЕ выдаётся намеренно — как и в правилах для
 * прямой записи manager/employee, повышение до совладельца остаётся вне
 * самообслуживания (позже considered as Cloud Function с проверкой лимита
 * тарифа на число совладельцев).
 */
exports.inviteTenantMember = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Нужен вход в платформу");

  const { tenantId, email: rawEmail, role } = request.data || {};
  if (typeof tenantId !== "string" || !tenantId) {
    throw new HttpsError("invalid-argument", "Не указано заведение");
  }
  if (!["manager", "employee"].includes(role)) {
    throw new HttpsError("invalid-argument", "Роль должна быть 'manager' или 'employee'");
  }
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!email) throw new HttpsError("invalid-argument", "Укажите email приглашаемого");

  await requireTenantRole(tenantId, uid, ["owner", "admin"]);

  let invitedUser;
  try {
    invitedUser = await admin.auth().getUserByEmail(email);
  } catch (e) {
    throw new HttpsError(
      "not-found",
      "Пользователь с таким email ещё не регистрировался в консоли — попросите его сначала создать аккаунт (Регистрация), а потом пригласите ещё раз"
    );
  }

  const memberId = `${tenantId}_${invitedUser.uid}`;
  const existing = await db.collection("tenantMembers").doc(memberId).get();
  if (existing.exists && existing.data().status === "active") {
    throw new HttpsError("already-exists", "Этот человек уже состоит в заведении");
  }

  await db.collection("tenantMembers").doc(memberId).set({
    tenantId,
    userId: invitedUser.uid,
    email,
    role,
    status: "active",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await writeAuditLog({ tenantId, actorId: uid, action: "memberInvited", metadata: { email, role } });

  return { ok: true, userId: invitedUser.uid };
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

/**
 * Ручная смена тарифа заведению из панели Super Admin — например, для
 * заведения, оплатившего вне ЮKassa (индивидуальный договор, Enterprise),
 * или для исправления ошибки. Обычный клиентский путь смены тарифа —
 * createCheckoutSession (владелец сам оформляет оплату); эта функция для
 * администрирования платформы, не для владельца заведения.
 */
exports.changeTenantPlan = onCall({ region: REGION }, async (request) => {
  await requireSuperAdmin(request.auth?.uid);
  const { tenantId, planId } = request.data || {};
  if (typeof tenantId !== "string" || !tenantId) throw new HttpsError("invalid-argument", "Не указано заведение");
  if (typeof planId !== "string" || !planId) throw new HttpsError("invalid-argument", "Не указан тариф");

  const planDoc = await db.collection("plans").doc(planId).get();
  if (!planDoc.exists) throw new HttpsError("not-found", "Тариф не найден");

  await db.collection("tenants").doc(tenantId).update({
    planId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await writeAuditLog({
    tenantId, actorId: request.auth.uid, action: "planChangedBySuperAdmin", metadata: { planId },
  });
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

// ------------------------------------------------------------------ billing

/**
 * Вызывает REST API ЮKassa (https://yookassa.ru/developers/api) с Basic-
 * авторизацией по shopId/секретному ключу магазина. Один helper — и для
 * создания платежа, и для его перепроверки в вебхуке.
 */
async function yookassaRequest(path, { method = "GET", body, idempotenceKey } = {}) {
  const auth = Buffer.from(`${YOOKASSA_SHOP_ID.value()}:${YOOKASSA_SECRET_KEY.value()}`).toString("base64");
  const headers = { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" };
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
 * оплаты (confirmation_url) — консоль просто делает location.href на неё.
 * save_payment_method сохраняет способ оплаты для последующих
 * автоматических списаний при продлении (chargeRecurringSubscriptions).
 *
 * Статус подписки/заведения НЕ меняется здесь — платёж на этом этапе
 * ещё не оплачен, только создан. Единственное место, где статус реально
 * становится "active", — handleBillingWebhook, после того как ЮKassa
 * подтвердит оплату (и сама перепроверена нашим секретным ключом, а не
 * просто "доверена" по факту вызова этой функции).
 */
exports.createCheckoutSession = onCall(
  { region: REGION, secrets: [YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    const { tenantId, planId, returnUrl } = request.data || {};
    if (typeof tenantId !== "string" || !tenantId) throw new HttpsError("invalid-argument", "Не указано заведение");
    if (typeof planId !== "string" || !planId) throw new HttpsError("invalid-argument", "Не указан тариф");
    if (typeof returnUrl !== "string" || !returnUrl) {
      throw new HttpsError("invalid-argument", "Не передан адрес возврата после оплаты");
    }
    await requireTenantRole(tenantId, uid, ["owner", "admin"]);

    const planDoc = await db.collection("plans").doc(planId).get();
    if (!planDoc.exists) throw new HttpsError("not-found", "Тариф не найден");
    const plan = planDoc.data();
    const price = Number(plan.priceRub) || 0;
    if (price <= 0) {
      throw new HttpsError("failed-precondition", "Этот тариф не продаётся напрямую — свяжитесь с поддержкой платформы");
    }

    const payment = await yookassaRequest("payments", {
      method: "POST",
      idempotenceKey: crypto.randomUUID(),
      body: {
        amount: { value: price.toFixed(2), currency: "RUB" },
        capture: true,
        save_payment_method: true,
        confirmation: { type: "redirect", return_url: returnUrl },
        description: `Colibri POS — тариф «${plan.name || planId}», заведение ${tenantId}`,
        metadata: { tenantId, planId, purpose: "subscription" },
      },
    });

    return { confirmationUrl: payment.confirmation?.confirmation_url || null, paymentId: payment.id };
  }
);

/**
 * Webhook ЮKassa. ЮKassa НЕ подписывает уведомления секретом (в отличие,
 * например, от Stripe) — их официально рекомендованная защита именно
 * такая: не доверять телу запроса, а по id платежа перезапросить его
 * напрямую в API ЮKassa своим секретным ключом и действовать по тому,
 * что вернул API, а не по тому, что прислали в POST. Подделать уведомление
 * так нельзя, даже зная URL этого webhook'а и формат тела: подделыватель
 * не может заставить API ЮKassa подтвердить чужой платёж как оплаченный.
 *
 * Идемпотентно (billingEvents/{paymentId}) — повторная доставка того же
 * уведомления (ЮKassa ретраит, если не получила 200 вовремя) не применяет
 * оплату дважды.
 */
exports.handleBillingWebhook = onRequest(
  { region: REGION, secrets: [YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("method not allowed");
      return;
    }

    const paymentId = req.body?.object?.id;
    if (typeof paymentId !== "string" || !paymentId) {
      res.status(400).send("bad request");
      return;
    }

    let payment;
    try {
      payment = await yookassaRequest(`payments/${paymentId}`);
    } catch (e) {
      console.error("handleBillingWebhook: не удалось перепроверить платёж в ЮKassa", e);
      res.status(502).send("upstream error");
      return;
    }

    const tenantId = payment.metadata?.tenantId;
    const planId = payment.metadata?.planId;
    if (!tenantId || !planId) {
      // Платёж без наших metadata — не от этой платформы, но раз ЮKassa
      // прислала его на наш webhook, отвечаем 200, чтобы не получать
      // бесконечные повторы того, что мы всё равно никогда не обработаем.
      res.status(200).send("ignored");
      return;
    }

    const eventRef = db.collection("billingEvents").doc(paymentId);
    const alreadyProcessed = await db.runTransaction(async (tx) => {
      const seen = await tx.get(eventRef);
      if (seen.exists) return true;
      tx.set(eventRef, {
        tenantId, planId, status: payment.status,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return false;
    });
    if (alreadyProcessed) {
      res.status(200).send("ok");
      return;
    }

    if (payment.status === "succeeded") {
      const periodEnd = admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 86400000);
      const update = {
        tenantId, planId,
        status: "active",
        provider: "yookassa",
        externalSubscriptionId: paymentId,
        currentPeriodStart: admin.firestore.FieldValue.serverTimestamp(),
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      };
      // save_payment_method делает способ оплаты сохранённым только с
      // согласия платёжной системы (не любая карта позволяет рекуррент) —
      // сохраняем payment_method_id, только когда ЮKassa это подтвердила.
      if (payment.payment_method?.saved) update.paymentMethodId = payment.payment_method.id;

      await db.collection("subscriptions").doc(tenantId).set(update, { merge: true });
      // set+merge, а не update: не роняем webhook 500-й ошибкой (что заставит
      // ЮKassa бесконечно ретраить), если документ заведения почему-то ещё
      // не существует — такое не должно случаться, но webhook обязан быть
      // maximally resilient, а не полагаться на то, что "не должно".
      await db.collection("tenants").doc(tenantId).set({
        status: "active",
        planId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await writeAuditLog({ tenantId, actorId: null, action: "subscriptionPaid", metadata: { paymentId, planId } });
    } else if (payment.status === "canceled") {
      await writeAuditLog({ tenantId, actorId: null, action: "subscriptionPaymentCanceled", metadata: { paymentId, planId } });
    }

    res.status(200).send("ok");
  }
);

/**
 * Раз в сутки продлевает подписки, у которых скоро закончится оплаченный
 * период — списывает сохранённый способ оплаты (payment_method_id) без
 * участия владельца, как и положено автоплатежу. Статус подписки этот шаг
 * НЕ трогает при успехе (кроме renewalAttemptedAt) — единственный источник
 * истины "оплачено" один, handleBillingWebhook, который применит
 * подтверждение, когда оно придёт, и продлит currentPeriodEnd сам.
 * При явном отказе списания (карта отклонена и т.п.) переводит подписку в
 * past_due сразу, не дожидаясь webhook'а, которого в этом случае не будет.
 */
exports.chargeRecurringSubscriptions = onSchedule(
  { region: REGION, schedule: "every 24 hours", secrets: [YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY] },
  async () => {
    const withinADay = admin.firestore.Timestamp.fromMillis(Date.now() + 86400000);
    const subs = await db.collection("subscriptions")
      .where("status", "==", "active")
      .where("provider", "==", "yookassa")
      .where("currentPeriodEnd", "<=", withinADay)
      .get();

    for (const subDoc of subs.docs) {
      const sub = subDoc.data();
      const tenantId = subDoc.id;
      if (!sub.paymentMethodId) continue; // нечем продлить автоматически — сгорит в past_due само по окончании периода (см. TenantConfig.operationsAllowed на клиенте)

      // Не пытаться продлевать чаще раза в сутки: без этой защёлки при
      // задержке подтверждения от ЮKassa каждый следующий ежедневный
      // прогон создавал бы ещё один платёж, пока не придёт первый webhook.
      const lastAttemptMs = sub.renewalAttemptedAt?.toMillis?.() ?? 0;
      if (Date.now() - lastAttemptMs < 20 * 3600000) continue;

      const planDoc = await db.collection("plans").doc(sub.planId).get();
      const price = Number(planDoc.data()?.priceRub) || 0;
      if (price <= 0) continue;

      await subDoc.ref.update({ renewalAttemptedAt: admin.firestore.FieldValue.serverTimestamp() });
      try {
        await yookassaRequest("payments", {
          method: "POST",
          // Ключ детерминирован от даты окончания периода — повторный
          // прогон этой функции в тот же день не создаёт второй платёж,
          // даже если что-то упало между первой попыткой и следующим тиком.
          idempotenceKey: `renewal_${tenantId}_${sub.currentPeriodEnd.toMillis()}`,
          body: {
            amount: { value: price.toFixed(2), currency: "RUB" },
            capture: true,
            payment_method_id: sub.paymentMethodId,
            description: `Colibri POS — продление тарифа «${sub.planId}», заведение ${tenantId}`,
            metadata: { tenantId, planId: sub.planId, purpose: "renewal" },
          },
        });
      } catch (e) {
        console.error(`chargeRecurringSubscriptions: не удалось продлить ${tenantId}`, e);
        await subDoc.ref.update({ status: "past_due" });
        await writeAuditLog({ tenantId, actorId: null, action: "subscriptionRenewalFailed", metadata: { error: String(e) } });
      }
    }
  }
);

// ------------------------------------------------------------ createBuildJob

/**
 * Ставит задачу на сборку APK и запускает существующий GitHub Actions
 * workflow saas-on-demand-build.yml через REST API "workflow_dispatch" —
 * personal access token хранится в Secret Manager (GITHUB_PAT), с правами
 * ТОЛЬКО "Actions: read and write" на этот один репозиторий (fine-grained
 * PAT), не более широкими.
 *
 * Сама сборка сообщает о завершении обратным вызовом в completeBuildJob
 * (см. ниже) — а не через опрос статуса workflow run отсюда: опрос means
 * либо Cloud Function ждала бы 5-10 минут сборки (таймаут/деньги), либо
 * нужен был бы отдельный планировщик — обратный вызов проще и мгновенный.
 */
exports.createBuildJob = onCall({ region: REGION, secrets: [GITHUB_PAT] }, async (request) => {
  const uid = request.auth?.uid;
  const { tenantId, type } = request.data || {};
  if (typeof tenantId !== "string" || !tenantId) throw new HttpsError("invalid-argument", "Не указано заведение");
  await requireTenantRole(tenantId, uid, ["owner", "admin"]);

  const sub = await db.collection("subscriptions").doc(tenantId).get();
  if (!sub.exists || !["trial", "active"].includes(sub.data().status)) {
    throw new HttpsError("failed-precondition", "Подписка неактивна — сборка APK недоступна");
  }

  const jobRef = db.collection("buildJobs").doc();
  const jobId = jobRef.id;
  await jobRef.set({
    tenantId,
    type: type || "apk",
    status: "queued",
    requestedBy: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    completedAt: null,
    downloadPath: null,
    runUrl: null,
    errorMessage: null,
  });

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_SAAS_WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GITHUB_PAT.value()}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main", inputs: { tenant_id: tenantId, job_id: jobId } }),
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status}: ${text}`);
    }
  } catch (e) {
    await jobRef.update({
      status: "failed",
      errorMessage: String(e),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    throw new HttpsError("internal", "Не удалось запустить сборку в GitHub Actions — см. запись в buildJobs");
  }

  await writeAuditLog({ tenantId, actorId: uid, action: "buildJobRequested", metadata: { jobId } });
  return { jobId };
});

// ---------------------------------------------------------- completeBuildJob

/**
 * Обратный вызов от GitHub Actions (последний шаг
 * saas-on-demand-build.yml) — сообщает, что сборка закончилась, успешно
 * или нет. Это обычный HTTP-эндпойнт (onRequest), не onCall: раннер
 * GitHub Actions не является клиентом Firebase и не может вызвать
 * callable-функцию через её protobuf-протокол — только curl.
 *
 * Проверка подлинности — общий секрет в заголовке (BUILD_CALLBACK_SECRET),
 * а не IAM/Firebase Auth: раннеру не выдаётся сервисный аккаунт Firebase
 * ради одного узкого действия "пометь эту задачу законченной".
 */
exports.completeBuildJob = onRequest({ region: REGION, secrets: [BUILD_CALLBACK_SECRET] }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("method not allowed");
    return;
  }
  if (req.get("x-callback-secret") !== BUILD_CALLBACK_SECRET.value()) {
    res.status(403).send("forbidden");
    return;
  }

  const { jobId, status, downloadPath, runUrl, errorMessage } = req.body || {};
  if (typeof jobId !== "string" || !jobId || !["success", "failed"].includes(status)) {
    res.status(400).send("bad request");
    return;
  }

  const jobRef = db.collection("buildJobs").doc(jobId);
  const jobDoc = await jobRef.get();
  if (!jobDoc.exists) {
    res.status(404).send("job not found");
    return;
  }

  await jobRef.update({
    status,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    downloadPath: status === "success" ? (downloadPath || null) : null,
    runUrl: runUrl || null,
    errorMessage: status === "failed" ? (errorMessage || "неизвестная ошибка сборки") : null,
  });
  res.status(200).send("ok");
});
