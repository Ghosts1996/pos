"use strict";

/**
 * Восстановление базы из резервной копии saas-gateway (см.
 * runFirestoreBackup в server.js и README.md, раздел «Резервные копии»).
 *
 *   set -a; . /etc/saas-gateway.env; set +a
 *   node restore-backup.js backups/firestore-2026-09-26T03-00.json.gz --dry-run
 *   node restore-backup.js backups/firestore-...json.gz --only=tenants/abc --yes
 *
 * --dry-run  — только показать, сколько документов будет записано.
 * --only=P   — только документы, чей путь начинается с P (например одно
 *              заведение со всеми вложенными коллекциями).
 * --yes      — без этого флага скрипт ничего не пишет: восстановление
 *              ПЕРЕЗАПИСЫВАЕТ документы целиком тем, что было в копии.
 *
 * Документы, созданные после копии, не удаляются — скрипт только
 * возвращает то, что было в копии.
 */

const fs = require("fs");
const zlib = require("zlib");
const admin = require("firebase-admin");

function deserialize(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(deserialize);
  if (v.__t === "ts") return admin.firestore.Timestamp.fromMillis(v.v);
  if (v.__t === "geo") return new admin.firestore.GeoPoint(v.lat, v.lng);
  if (v.__t === "ref") return admin.firestore().doc(v.v);
  if (v.__t === "bytes") return Buffer.from(v.v, "base64");
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = deserialize(x);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");
  const only = (args.find((a) => a.startsWith("--only=")) || "").slice("--only=".length);
  if (!file) {
    console.error("Укажите файл копии: node restore-backup.js backups/firestore-....json.gz [--dry-run] [--only=путь] [--yes]");
    process.exit(2);
  }
  const backup = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  if (backup.format !== 1) throw new Error("Неизвестный формат копии");
  const paths = Object.keys(backup.docs).filter((p) => !only || p === only || p.startsWith(only.endsWith("/") ? only : `${only}/`));
  console.log(`Копия от ${backup.createdAt}: всего ${Object.keys(backup.docs).length} документов, к восстановлению — ${paths.length}${only ? ` (только ${only})` : ""}.`);
  if (dryRun || !yes) {
    if (!dryRun) console.log("Ничего не записано: добавьте --yes, чтобы восстановить.");
    return;
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, "base64").toString("utf8"));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  } else {
    admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  }
  const db = admin.firestore();
  for (let i = 0; i < paths.length; i += 400) {
    const batch = db.batch();
    paths.slice(i, i + 400).forEach((p) => batch.set(db.doc(p), deserialize(backup.docs[p])));
    await batch.commit();
    console.log(`записано ${Math.min(i + 400, paths.length)} / ${paths.length}`);
  }
  console.log("Готово.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
