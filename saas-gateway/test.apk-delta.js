"use strict";
// Обновление «как у Google» (apk-delta.js): патч по записям ZIP + bsdiff,
// сборка нового файла байт в байт, и весь путь на сервере — прошлая сборка
// остаётся базой, сервер строит патч, /appUpdate отдаёт его устройству с
// прошлой версией, после патча база удаляется.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apkdelta-"));
const buildsDir = path.join(dir, "builds");
Object.assign(process.env, {
  PORT: "8093", DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"),
  SUPPORT_DB_FILE: path.join(dir, "support-db.json"), AUTH_DB_FILE: path.join(dir, "auth.json"),
  BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0", REJECTED_DIR: path.join(dir, "rejected"),
  GITHUB_PAT: "", TENANT_BUILDS_DIR: buildsDir, APK_DELTAS: "1", BUILD_CALLBACK_SECRET: "cb-secret-apkdelta",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "apkdelta-secret-key-0123456789abcdef",
});

const { makePatch, applyPatch, zipEntries } = require("./apk-delta");

let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => (cond ? passed++ : (failed++, console.error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`)));

/** Простой ZIP: записи без сжатия (method 0) и со сжатием (8), как в APK. */
function zip(entries) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = e.method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const crc = zlib.crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** «Код приложения»: похож на машинный — повторяющиеся куски с вариациями. */
function fakeCode(seed, size) {
  const rnd = crypto.createHash("sha256").update(String(seed)).digest();
  const block = crypto.randomBytes(4096);
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) block.copy(out, i, 0, Math.min(4096, size - i));
  for (let i = 0; i < size; i += 97) out[i] = (out[i] + rnd[i % 32] + (i >> 12)) & 0xff;
  return out;
}

function versions() {
  const code1 = fakeCode(1, 900 * 1024);
  // Новая версия: вставка в середине (сдвиг кода), правки и хвост.
  const ins = crypto.randomBytes(3000);
  const code2 = Buffer.concat([code1.subarray(0, 400000), ins, code1.subarray(400000)]);
  for (let i = 500000; i < 520000; i += 50) code2[i] ^= 0x5a;
  const engine = crypto.randomBytes(700 * 1024); // движок — не меняется
  const font = Buffer.from("шрифт ".repeat(40000)); // сжатый ресурс — не меняется
  const v1 = zip([
    { name: "AndroidManifest.xml", data: Buffer.from("versionCode=100 ".repeat(200)), method: 8 },
    { name: "lib/arm64-v8a/libflutter.so", data: engine, method: 0 },
    { name: "lib/arm64-v8a/libapp.so", data: code1, method: 0 },
    { name: "assets/flutter_assets/fonts/Onest.ttf", data: font, method: 8 },
  ]);
  const v2 = zip([
    { name: "AndroidManifest.xml", data: Buffer.from("versionCode=101 ".repeat(200)), method: 8 },
    { name: "lib/arm64-v8a/libflutter.so", data: engine, method: 0 },
    { name: "lib/arm64-v8a/libapp.so", data: code2, method: 0 },
    { name: "assets/flutter_assets/fonts/Onest.ttf", data: font, method: 8 },
  ]);
  return { v1, v2 };
}

function request(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({ hostname: "127.0.0.1", port: 8093, path: p, method, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor(fn, ms = 90000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  // --- патч сам по себе
  const { v1, v2 } = versions();
  check("ZIP разбирается", zipEntries(v2).length === 4);
  const { patch, stats } = makePatch(v1, v2);
  check("патч собирает новый файл байт в байт", applyPatch(v1, patch).equals(v2));
  check("движок и шрифт взяты из старого файла", stats.copy >= 700 * 1024, JSON.stringify(stats));
  check("код приложения — разницей (bsdiff)", stats.bsdiff > 800 * 1024, JSON.stringify(stats));
  check("патч в разы меньше файла", patch.length < v2.length / 10, `${patch.length} из ${v2.length}`);
  let wrongBase = false;
  try { applyPatch(v2, patch); } catch (e) { wrongBase = /не к этой версии/.test(e.message); }
  check("к другой версии патч не применяется", wrongBase);
  let broken = false;
  try { makePatch(Buffer.from("не zip"), v2); } catch (_) { broken = true; }
  check("не ZIP — ошибка, а не мусор", broken);

  // Образец для теста кассы (test/apk_patch_test.dart) — тот же формат.
  const fx = path.join(__dirname, "..", "test", "fixtures", "apk_delta");
  check("образец для кассы собирается этим же кодом",
    applyPatch(fs.readFileSync(path.join(fx, "old.apk")), fs.readFileSync(path.join(fx, "update.zpatch"))).equals(fs.readFileSync(path.join(fx, "new.apk"))));

  // --- весь путь на сервере
  const server = require("./server.js");
  const admin = require("firebase-admin");
  const store = server.localDataStore();
  const set = (p, d) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop()).set(d);
  const get = async (p) => (await store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop()).get()).data();
  const T = (ms) => admin.firestore.Timestamp.fromMillis(ms);
  await new Promise((r) => setTimeout(r, 300));
  const tdir = path.join(buildsDir, "tA");
  fs.mkdirSync(tdir, { recursive: true });
  const now = Date.now();
  await set("tenants/tA", { name: "A", slug: "a", status: "active" });
  await set("buildJobs/j1", { tenantId: "tA", type: "guest", platform: "android", status: "success", buildNumber: 100, createdAt: T(now - 60000) });
  fs.writeFileSync(path.join(tdir, "j1.apk"), v1);
  await set("buildJobs/j2", { tenantId: "tA", type: "guest", platform: "android", status: "queued", createdAt: T(now) });
  fs.writeFileSync(path.join(tdir, "j2.apk"), v2);
  const cb = await request("POST", "/completeBuildJob", {
    headers: { "x-callback-secret": "cb-secret-apkdelta" },
    body: { jobId: "j2", status: "success", buildNumber: 101 },
  });
  check("сборка отчиталась", cb.status === 200, JSON.stringify(cb.json));
  const built = await waitFor(() => fs.existsSync(path.join(tdir, "j2.from100.json")) && !fs.existsSync(path.join(tdir, "j1.apk")));
  check("сервер построил патч и убрал прошлую сборку", built, fs.readdirSync(tdir).join(","));
  const j1 = await get("buildJobs/j1");
  check("прошлая сборка — superseded, не база", j1.status === "superseded" && j1.deltaBase === false, JSON.stringify(j1));

  const up = await request("POST", "/appUpdate", { body: { tenantId: "tA", app: "guest", platform: "android", current: 100 } });
  const p = (up.json || {}).patch;
  check("устройству с прошлой версией — патч", up.status === 200 && p && p.sizeBytes < v2.length / 10, JSON.stringify(up.json));
  check("в ответе отпечатки старого и нового файла",
    p && p.sha256 === crypto.createHash("sha256").update(v2).digest("hex")
      && p.fromSha256 === crypto.createHash("sha256").update(v1).digest("hex") && p.fromSize === v1.length);
  const dl = await request("GET", p ? p.url : "/downloadBuild");
  check("патч раздаёт nginx", dl.status === 200 && /\/tA\/j2\.from100\.zpatch$/.test(dl.headers["x-accel-redirect"] || ""), JSON.stringify(dl.headers));
  check("файл патча на диске собирает новую версию", applyPatch(v1, fs.readFileSync(path.join(tdir, "j2.from100.zpatch"))).equals(v2));
  const older = await request("POST", "/appUpdate", { body: { tenantId: "tA", app: "guest", platform: "android", current: 99 } });
  check("устройству со старой версией — целиком", older.json && older.json.update === true && !older.json.patch);
  const bad = await request("GET", `${up.json.url}&from=99`);
  check("чужой патч — 404", bad.status === 404);

  // Третья сборка: база — вторая, старые патчи убираются.
  await set("buildJobs/j3", { tenantId: "tA", type: "guest", platform: "android", status: "queued", createdAt: T(now + 1000) });
  const v3 = Buffer.from(v2);
  fs.writeFileSync(path.join(tdir, "j3.apk"), v3);
  await request("POST", "/completeBuildJob", { headers: { "x-callback-secret": "cb-secret-apkdelta" }, body: { jobId: "j3", status: "success", buildNumber: 102 } });
  const third = await waitFor(() => fs.existsSync(path.join(tdir, "j3.from101.json")) && !fs.existsSync(path.join(tdir, "j2.apk")));
  check("следующая сборка: патч от предыдущей", third, fs.readdirSync(tdir).join(","));
  check("старые патчи убраны", !fs.existsSync(path.join(tdir, "j2.from100.zpatch")), fs.readdirSync(tdir).join(","));

  console.log(`apk-delta: ${passed} passed, ${failed} failed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
