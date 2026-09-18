/**
 * Загружает тарифы из saas/plans.seed.json в коллекцию plans/{planId}
 * нового SaaS-проекта — цены/лимиты не зашиты во Flutter-код (ТЗ §32),
 * это разовая настройка данных, а не деплой.
 *
 * Использование:
 *   node seed-plans.js --project <ваш-saas-project-id> --key ./saas-service-account.json
 */
const admin = require("firebase-admin");
const path = require("path");

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
  }
  if (!args.project || !args.key) throw new Error("Нужны --project и --key");
  return args;
}

async function main() {
  const args = parseArgs();
  const app = admin.initializeApp({
    credential: admin.credential.cert(require(path.resolve(args.key))),
    projectId: args.project,
  });
  const db = app.firestore();
  const plans = require(path.join(__dirname, "..", "plans.seed.json"));

  const batch = db.batch();
  for (const [planId, data] of Object.entries(plans)) {
    batch.set(db.collection("plans").doc(planId), data);
  }
  await batch.commit();
  console.log(`Загружено тарифов: ${Object.keys(plans).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
