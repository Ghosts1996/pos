"use strict";
/**
 * Обновления приложения курьера:
 *  - версия APK из файла (apk-info.js): двоичный AndroidManifest.xml в zip;
 *  - version.json и версия в index.html (courier-web.js): меняется вместе с
 *    файлами приложения и движка карты, ETag главной — тоже;
 *  - app.js и sw.js: проверка обновлений есть, version.json мимо кэша.
 */
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { apkVersion, createApkInfo, manifestInfo } = require("./apk-info");
const { createCourierWeb } = require("./courier-web");

let n = 0;
const ok = (name) => { n++; console.log(`  ✓ ${name}`); };

/** Простейший zip (одна запись, сжатие deflate) — как APK. */
function zipOf(name, data) {
  const comp = zlib.deflateRawSync(data);
  const nameB = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameB.length, 28);
  central.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, nameB, comp]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameB.length, 12); eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, central, nameB, eocd]);
}

const axml = fs.readFileSync(path.join(__dirname, "test-fixtures", "courier-manifest.axml"));
assert.deepEqual(manifestInfo(axml), { versionCode: 3, versionName: "1.0.3", package: "ru.zalpos.courier" });
ok("версия из AndroidManifest.xml собранного APK курьера: 3 / 1.0.3");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zc-upd-"));
const apkFile = path.join(tmp, "courier.apk");
fs.writeFileSync(apkFile, zipOf("AndroidManifest.xml", axml));
assert.equal(apkVersion(fs.readFileSync(apkFile)).versionCode, 3);
const info = createApkInfo(apkFile);
const first = info();
assert.equal(first.versionCode, 3);
assert.equal(first.size, fs.statSync(apkFile).size);
assert.equal(info(), first, "без изменений файла — из памяти");
fs.writeFileSync(apkFile, Buffer.from("не apk"));
const broken = info();
assert.ok(broken && !broken.versionCode && broken.error, "битый файл — без версии, без падения");
assert.equal(createApkInfo(path.join(tmp, "нет.apk"))(), null, "нет файла — null");
ok("APK на сервере: версия, память по файлу, битый и отсутствующий файл");

// Копия приложения и движка карты во временной папке.
const appDir = path.join(tmp, "courier-web");
const mapDir = path.join(tmp, "map-web");
fs.cpSync(path.join(__dirname, "courier-web"), appDir, { recursive: true });
fs.mkdirSync(mapDir);
fs.writeFileSync(path.join(mapDir, "zal-map.js"), "// карта v1\n");
fs.writeFileSync(apkFile, zipOf("AndroidManifest.xml", axml));
const web = createCourierWeb({ dir: appDir, mapDir, apkInfo: info });

function get(rel, headers = {}) {
  let status = 0; let h = {}; let body = "";
  web.serve({ method: "GET", headers }, { writeHead(s, hh) { status = s; h = hh || {}; }, end(b) { body = b ? String(b) : ""; } }, rel);
  return { status, h, body };
}
const v1 = get("version.json");
assert.equal(v1.status, 200);
assert.equal(v1.h["Cache-Control"], "no-store");
const j1 = JSON.parse(v1.body);
assert.match(j1.web, /^[0-9a-f]{12}$/);
assert.ok(j1.webAt > 0, "дата версии");
assert.deepEqual(j1.apk, { code: 3, name: "1.0.3", size: fs.statSync(apkFile).size, at: Math.round(fs.statSync(apkFile).mtimeMs) });
const idx1 = get("");
assert.ok(idx1.body.includes(`<meta name="zc-ver" content="${j1.web}">`), "версия в index.html");
assert.ok(idx1.h.ETag.includes(j1.web), "ETag главной зависит от версии");
assert.equal(get("", { "if-none-match": idx1.h.ETag }).status, 304, "та же версия — 304");
ok("version.json: версия приложения и APK; версия вписана в index.html");

// Правка app.js → новая версия; правка движка карты → тоже.
const bump = (f, s) => { fs.appendFileSync(f, s); const t = new Date(Date.now() + 5000 + n * 1000); fs.utimesSync(f, t, t); };
bump(path.join(appDir, "app.js"), "\n// правка\n");
const j2 = JSON.parse(get("version.json").body);
assert.notEqual(j2.web, j1.web, "правка app.js — новая версия");
const idx2 = get("", { "if-none-match": idx1.h.ETag });
assert.equal(idx2.status, 200, "старая главная после правки — не 304");
assert.ok(idx2.body.includes(j2.web));
bump(path.join(mapDir, "zal-map.js"), "// v2\n");
const j3 = JSON.parse(get("version.json").body);
assert.notEqual(j3.web, j2.web, "правка движка карты — новая версия");
assert.equal(JSON.parse(get("version.json").body).web, j3.web, "без правок версия та же");
ok("версия меняется с файлами приложения и карты, без правок — та же");

// Нет APK — apk: null.
const noApk = createCourierWeb({ dir: appDir, mapDir, apkInfo: () => null });
let body = "";
noApk.serve({ method: "GET", headers: {} }, { writeHead() {}, end(b) { body = String(b); } }, "version.json");
assert.equal(JSON.parse(body).apk, null);
ok("APK ещё не собран — apk: null");

// Клиент: проверка обновлений, кнопка, мимо кэша служебного скрипта.
const appJs = fs.readFileSync(path.join(__dirname, "courier-web", "app.js"), "utf8");
const swJs = fs.readFileSync(path.join(__dirname, "courier-web", "sw.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "courier-web", "index.html"), "utf8");
assert.ok(html.includes('<meta name="zc-ver" content="">'), "место для версии в index.html");
assert.ok(/version\.json/.test(appJs) && /data-a="upd-check"/.test(appJs) && /Проверить обновления/.test(appJs));
assert.ok(/installUpdate/.test(appJs) && /\.\.\/zcApk/.test(appJs), "APK — скачивание внутри приложения");
assert.ok(/pathname\.endsWith\("\/version\.json"\)\) return;/.test(swJs), "version.json не кэшируется");
const java = fs.readFileSync(path.join(__dirname, "..", "android-courier", "app", "src", "main", "java", "ru", "zalpos", "courier", "MainActivity.java"), "utf8");
assert.ok(/public void installUpdate\(String url\)/.test(java) && /public int versionCode\(\)/.test(java), "мост ZalNative умеет обновляться");
const manifest = fs.readFileSync(path.join(__dirname, "..", "android-courier", "app", "src", "main", "AndroidManifest.xml"), "utf8");
assert.ok(manifest.includes("android.permission.REQUEST_INSTALL_PACKAGES"));
ok("приложение: проверка по расписанию и кнопкой, APK обновляется из приложения");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`courier-update: ${n} проверок пройдено`);
