"use strict";

// Удаление старой копии в Firestore: полная копия на сервер, проверка,
// удаление (вложенные коллекции и «сироты» тоже). На эмуляторе Firestore.
// Нет java или эмулятора — тест падает (не пропускается молча).

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn, execSync } = require("child_process");

const jar = path.join(os.homedir(), ".cache", "firebase", "emulators", "cloud-firestore-emulator-v1.19.8.jar");
try { execSync("java -version", { stdio: "ignore" }); } catch (_) { console.error("firestore-purge: нет java — тест не может пройти"); process.exit(1); }
if (!fs.existsSync(jar)) { console.error(`firestore-purge: нет эмулятора Firestore (${jar}) — тест не может пройти`); process.exit(1); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-purge-"));
const port = 8186;
const emu = spawn("java", ["-jar", jar, "--host=127.0.0.1", `--port=${port}`], { stdio: "ignore" });
// Учётные записи Google — поддельный сервер на этой машине (как эмулятор
// Firebase Auth): в нём два пользователя, которых уход из Firebase должен
// перенести в свой вход и удалить у «Google».
const authPort = 8187;
const fakeUsers = new Map([
  ["fbU1", { localId: "fbU1", email: "owner1@test.ru", emailVerified: true, createdAt: "1700000000000" }],
  ["fbU2", { localId: "fbU2", email: "", createdAt: "1700000000000" }],
]);
const fakeAuth = require("http").createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : {};
    let out = {};
    if (/accounts:batchGet/.test(req.url)) out = { users: [...fakeUsers.values()] };
    else if (/accounts:lookup/.test(req.url)) out = { users: (j.localId || []).map((id) => fakeUsers.get(id)).filter(Boolean) };
    else if (/accounts:delete/.test(req.url)) fakeUsers.delete(j.localId);
    else if (/accounts:batchDelete/.test(req.url)) (j.localIds || []).forEach((id) => fakeUsers.delete(id));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  });
}).listen(authPort, "127.0.0.1");
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
Object.assign(process.env, {
  PORT: "8099", FIRESTORE_EMULATOR_HOST: `127.0.0.1:${port}`, GCLOUD_PROJECT: "demo-zal",
  FIREBASE_SERVICE_ACCOUNT_B64: Buffer.from(JSON.stringify({
    type: "service_account", project_id: "demo-zal", client_email: "t@demo-zal.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  })).toString("base64"),
  DATA_BACKEND: "local", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"), AUTH_DB_FILE: path.join(dir, "auth.json"),
  BACKUP_DIR: path.join(dir, "backups"), FIRESTORE_PURGE_FILE: path.join(dir, "purge.json"), DATA_AUTO_MIGRATE: "0",
  FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${authPort}`, AUTH_BACKEND: "own", FIREBASE_EXIT_FILE: path.join(dir, "exit.json"),
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

  // ---- Уход из Firebase сам (без кнопок): без связи справочника ПДн с этим
  // сервером — ничего не трогаем; с ней — данные и учётные записи удалены,
  // учётные записи перенесены в свой вход, отметка «готово» для сторожа.
  delete process.env.PII_INTERNAL_TOKEN;
  let ex = await server.runFirebaseExit();
  check("без PII_INTERNAL_TOKEN уход не начинается", !ex.done && fakeUsers.size === 2);
  process.env.PII_INTERNAL_TOKEN = "test-internal-token";
  await fsdb.doc("tenants/late2").set({ late: true }); // в Google снова что-то есть
  server.saveFirestorePurge({ ...late, phase: "check" });
  ex = await server.runFirebaseExit();
  check(`уход завершён (${ex.error})`, ex.done === true && ex.firestore === "done" && ex.authLeft === 0);
  check("учётные записи удалены у «Google»", fakeUsers.size === 0 && ex.authDeleted === 2);
  check("Firestore пуст после ухода", (await fsdb.listCollections()).length === 0);
  const stats = await server.ownAuth().migrationStats();
  const u1 = await server.ownAuth().adminAuth().getUser("fbU1").catch(() => null);
  check("учётные записи перенесены в свой вход (uid и почта сохранены)", stats.users === 2 && stats.firebaseDeleted === 2 && u1 && u1.email === "owner1@test.ru");
  check("отметка для сторожа", JSON.parse(fs.readFileSync(path.join(dir, "exit.json"), "utf8")).done === true);
  const again2 = await server.runFirebaseExit();
  check("повтор ничего не делает", again2.done === true && again2.doneAt === ex.doneAt);
  console.log(`firestore-purge: ${failed ? "есть ошибки" : "17 проверок прошли"}`);
}

main().then(() => { emu.kill(); fakeAuth.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(failed ? 1 : 0); },
  (e) => { console.error(e); emu.kill(); process.exit(1); });
