"use strict";

// Удаление старой копии в Firestore: полная копия на сервер, проверка,
// удаление (вложенные коллекции и «сироты» тоже). На эмуляторе Firestore.
// Нет java или эмулятора — тест пропускается.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn, execSync } = require("child_process");

const jar = path.join(os.homedir(), ".cache", "firebase", "emulators", "cloud-firestore-emulator-v1.19.8.jar");
try { execSync("java -version", { stdio: "ignore" }); } catch (_) { console.log("firestore-purge: пропущено — нет java"); process.exit(0); }
if (!fs.existsSync(jar)) { console.log("firestore-purge: пропущено — нет эмулятора Firestore"); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-purge-"));
const port = 8186;
const emu = spawn("java", ["-jar", jar, "--host=127.0.0.1", `--port=${port}`], { stdio: "ignore" });
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
Object.assign(process.env, {
  PORT: "8099", FIRESTORE_EMULATOR_HOST: `127.0.0.1:${port}`, GCLOUD_PROJECT: "demo-zal",
  FIREBASE_SERVICE_ACCOUNT_B64: Buffer.from(JSON.stringify({
    type: "service_account", project_id: "demo-zal", client_email: "t@demo-zal.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  })).toString("base64"),
  DATA_BACKEND: "local", DATA_DB_FILE: path.join(dir, "data.sqlite"), AUTH_DB_FILE: path.join(dir, "auth.json"),
  BACKUP_DIR: path.join(dir, "backups"), FIRESTORE_PURGE_FILE: path.join(dir, "purge.json"), DATA_AUTO_MIGRATE: "0",
});

let failed = 0;
const check = (name, ok) => { if (!ok) { failed++; console.error(`FAIL: ${name}`); } };

async function main() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const server = require("./server.js");
  const admin = require("firebase-admin");
  const fsdb = admin.firestore(admin.apps[0]);
  const b = fsdb.batch();
  b.set(fsdb.doc("tenants/t1"), { name: "Кафе", at: admin.firestore.Timestamp.fromMillis(1700000000000) });
  for (let i = 0; i < 30; i++) b.set(fsdb.doc(`tenants/t1/sessions/s${i}`), { n: i });
  b.set(fsdb.doc("tenants/t1/sessions/s1/items/i1"), { x: 1 });
  b.set(fsdb.doc("ghost/none/orders/o1"), { orphan: true }); // родителя нет
  b.set(fsdb.doc("users/u1"), { email: "a@b.ru" });
  await b.commit();

  server.saveFirestorePurge({ phase: "backup", startedAt: new Date().toISOString(), deleted: 0 });
  const st = await server.runFirestorePurge();
  check(`задание завершено (${st && st.error})`, st && st.phase === "done");
  check("копия: все 34 документа", st.backupDocs === 34);
  const copy = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, "backups", st.backup))).toString("utf8"));
  check("в копии вложенные и «сироты»", !!copy.docs["tenants/t1/sessions/s1/items/i1"] && !!copy.docs["ghost/none/orders/o1"]);
  check("метки времени в копии", copy.docs["tenants/t1"].at && copy.docs["tenants/t1"].at.__t === "ts");
  check("Firestore пуст", (await fsdb.listCollections()).length === 0 && (await fsdb.collectionGroup("items").get()).empty);
  check("удалено 34", st.deleted === 34);
  check("копия не попала в обычную ротацию", !fs.readdirSync(path.join(dir, "backups")).some((f) => /^firestore-/.test(f)));
  const again = await server.runFirestorePurge();
  check("повтор — ничего не делает", again.phase === "done" && again.deleted === 34);
  // Документ записали уже после копии: он не удаляется вслепую — сначала своя копия.
  await fsdb.doc("tenants/late").set({ late: true });
  server.saveFirestorePurge({ ...again, phase: "check" });
  const late = await server.runFirestorePurge();
  check("поздний документ: вторая копия и удаление", late.phase === "done" && late.backups.length === 2 && late.backups[1].docs === 1);
  check("Firestore снова пуст", (await fsdb.listCollections()).length === 0);
  console.log(`firestore-purge: ${failed ? "есть ошибки" : "10 проверок прошли"}`);
}

main().then(() => { emu.kill(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(failed ? 1 : 0); },
  (e) => { console.error(e); emu.kill(); process.exit(1); });
