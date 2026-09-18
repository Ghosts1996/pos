/**
 * Переносит данные ОДНОГО действующего одно-арендного проекта (например,
 * hoocah-pos) в НОВЫЙ SaaS-проект как первого арендатора (ТЗ §55).
 *
 * Специально НЕ запускается автоматически и НЕ является частью деплоя —
 * это разовая операция, которую выполняет человек, когда решает завести
 * своё текущее заведение как первого клиента платформы (после того как
 * Phase 1–3 обкатаны на тестовых заведениях, а не на живых данных).
 *
 * Что делает:
 *   1. Создаёт запись в tenants/{tenantId} нового проекта (если не передан
 *      готовый tenantId — например, из createTenant).
 *   2. Копирует каждую известную коллекцию верхнего уровня из старого
 *      проекта в tenants/{tenantId}/<та же коллекция> нового проекта,
 *      постранично (пачками по 300 документов — тот же размер батча,
 *      что и в остальных частях приложения, см. guest_link_service.dart).
 *   3. НИЧЕГО не удаляет и не меняет в исходном проекте — миграция
 *      только читает из старого, пишет в новый. Старое заведение продолжает
 *      работать всё это время без остановки.
 *
 * Использование:
 *   node migrate-single-tenant-to-tenant.js \
 *     --source-project hoocah-pos \
 *     --source-key ./hoocah-pos-service-account.json \
 *     --target-project <ваш-saas-project-id> \
 *     --target-key ./saas-service-account.json \
 *     --tenant-id <tenantId из createTenant, если заведение уже создано>
 *
 * Ключи сервисного аккаунта скачиваются в Firebase Console → Project
 * settings → Service accounts → Generate new private key. НЕ коммитить их
 * в репозиторий (см. .gitignore).
 */
const admin = require("firebase-admin");

// Коллекции верхнего уровня исходного (одно-арендного) проекта, которые
// становятся подколлекциями tenants/{tenantId}/... в новом. Список сверен
// с firestore.rules корня репозитория (см. секцию "Всё остальное" там же).
const TOP_LEVEL_COLLECTIONS = [
  "employees",
  "tables",
  "sessions",
  "menuCategories",
  "menuItems",
  "clients",
  "reservations",
  "reservationSlots",
  "waiterCalls",
  "guestOrders",
  "reviews",
  "bonusOperations",
  "phoneIndex",
  "referralCodes",
  "sessionClaims",
  "stories",
  "happyHours",
  "giftCards",
  "giftCardOperations",
  "giftCardClaims",
  "tips",
  "waitlist",
  "inventory",
  "inventoryMovements",
  "inventoryCounts",
  "discountCards",
  "marking_codes_sold",
  "auditLog",
  "aiLogs",
  "aiActions",
  "staffNotes",
  "aiJobs",
];

// Одиночные документы (не коллекции), которые переносятся под
// tenants/{tenantId}/meta/... и tenants/{tenantId}/settings/...
const SINGLE_DOCS = [
  { from: ["meta", "venueProfile"], to: ["meta", "venueProfile"] },
  { from: ["meta", "aiSettings"], to: ["meta", "aiSettings"] },
  { from: ["settings", "integrations"], to: ["settings", "integrations"] },
];

const BATCH_SIZE = 300;

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i].replace(/^--/, "");
    args[key] = process.argv[i + 1];
  }
  const required = ["source-project", "source-key", "target-project", "target-key"];
  for (const r of required) {
    if (!args[r]) throw new Error(`Не хватает обязательного параметра --${r}`);
  }
  return args;
}

async function copyCollection(sourceDb, targetRootRef, name) {
  const sourceRef = sourceDb.collection(name);
  let lastDoc = null;
  let total = 0;

  // Подколлекция clients/{uid}/visits переносится отдельным проходом ниже —
  // здесь копируются только документы самого верхнего уровня коллекции.
  while (true) {
    let query = sourceRef.orderBy("__name__").limit(BATCH_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;

    const batch = targetRootRef.firestore.batch();
    for (const doc of snap.docs) {
      batch.set(targetRootRef.collection(name).doc(doc.id), doc.data());
    }
    await batch.commit();
    total += snap.size;
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < BATCH_SIZE) break;
  }
  console.log(`  ${name}: перенесено ${total} документов`);
  return total;
}

async function copyClientVisits(sourceDb, targetRootRef) {
  const clientsSnap = await sourceDb.collection("clients").get();
  let total = 0;
  for (const clientDoc of clientsSnap.docs) {
    const visitsSnap = await sourceDb.collection("clients").doc(clientDoc.id).collection("visits").get();
    if (visitsSnap.empty) continue;
    const batch = targetRootRef.firestore.batch();
    for (const v of visitsSnap.docs) {
      batch.set(
        targetRootRef.collection("clients").doc(clientDoc.id).collection("visits").doc(v.id),
        v.data()
      );
    }
    await batch.commit();
    total += visitsSnap.size;
  }
  console.log(`  clients/*/visits: перенесено ${total} документов`);
}

async function copySingleDocs(sourceDb, targetRootRef) {
  for (const { from, to } of SINGLE_DOCS) {
    const doc = await sourceDb.doc(from.join("/")).get();
    if (!doc.exists) continue;
    await targetRootRef.doc(to.join("/")).set(doc.data(), { merge: true });
    console.log(`  ${from.join("/")} → tenants/{tenantId}/${to.join("/")}`);
  }
}

async function main() {
  const args = parseArgs();

  const sourceApp = admin.initializeApp(
    {
      credential: admin.credential.cert(require(require("path").resolve(args["source-key"]))),
      projectId: args["source-project"],
    },
    "source"
  );
  const targetApp = admin.initializeApp(
    {
      credential: admin.credential.cert(require(require("path").resolve(args["target-key"]))),
      projectId: args["target-project"],
    },
    "target"
  );

  const sourceDb = sourceApp.firestore();
  const targetDb = targetApp.firestore();

  let tenantId = args["tenant-id"];
  if (!tenantId) {
    const ref = targetDb.collection("tenants").doc();
    tenantId = ref.id;
    console.log(`--tenant-id не передан — создаю новый: ${tenantId}`);
    console.log(
      "ВНИМАНИЕ: этот скрипт не заводит owner/tenantMembers/подписку — " +
        "сначала выполните обычный онбординг (createTenant) для этого заведения, " +
        "а сюда передайте уже готовый --tenant-id, чтобы миграция дозаписала " +
        "рабочие данные поверх правильно настроенного tenant."
    );
    return;
  }

  const targetTenantDoc = await targetDb.collection("tenants").doc(tenantId).get();
  if (!targetTenantDoc.exists) {
    throw new Error(
      `tenants/${tenantId} не существует в целевом проекте — сначала создайте заведение через createTenant`
    );
  }

  const targetRootRef = targetDb.collection("tenants").doc(tenantId);

  console.log(`Перенос данных: ${args["source-project"]} → ${args["target-project"]}/tenants/${tenantId}`);
  for (const name of TOP_LEVEL_COLLECTIONS) {
    await copyCollection(sourceDb, targetRootRef, name);
  }
  await copyClientVisits(sourceDb, targetRootRef);
  await copySingleDocs(sourceDb, targetRootRef);

  console.log("Готово. Старые данные в исходном проекте не изменены и не удалены.");
}

main().catch((e) => {
  console.error("Миграция прервана с ошибкой:", e);
  process.exit(1);
});
