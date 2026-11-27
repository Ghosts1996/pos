"use strict";
// Отдельный процесс (сервер запускает его через nice): патч от прошлой сборки
// APK к новой — см. apk-delta.js. Аргументы: старый.apk новый.apk префикс.
// Пишет <префикс>.zpatch и <префикс>.json, если патч заметно меньше файла.
// Патч сразу проверяется: из старого файла и патча собирается новый, и он
// должен совпасть байт в байт (SHA-256).

const fs = require("fs");
const { makePatch, applyPatch, sha256 } = require("./apk-delta");

const [oldPath, newPath, outPrefix] = process.argv.slice(2);
const MAX_SHARE = 0.8; // патч больше 80 % файла — смысла нет, качаем целиком

function main() {
  const oldBuf = fs.readFileSync(oldPath);
  const newBuf = fs.readFileSync(newPath);
  const started = Date.now();
  const { patch, stats } = makePatch(oldBuf, newBuf, { deadlineMs: 5 * 60 * 1000 });
  const rebuilt = applyPatch(oldBuf, patch);
  if (!rebuilt.equals(newBuf)) throw new Error("проверка патча не прошла");
  const out = { ...stats, ms: Date.now() - started, useful: patch.length < newBuf.length * MAX_SHARE };
  if (out.useful) {
    fs.writeFileSync(`${outPrefix}.zpatch.tmp`, patch);
    fs.renameSync(`${outPrefix}.zpatch.tmp`, `${outPrefix}.zpatch`);
  }
  const meta = {
    useful: out.useful,
    size: patch.length,
    newSize: newBuf.length,
    sha256: sha256(newBuf).toString("hex"),
    fromSize: oldBuf.length,
    fromSha256: sha256(oldBuf).toString("hex"),
    stats: out,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(`${outPrefix}.json.tmp`, JSON.stringify(meta));
  fs.renameSync(`${outPrefix}.json.tmp`, `${outPrefix}.json`);
  process.stdout.write(JSON.stringify(out));
}

try {
  main();
} catch (e) {
  process.stderr.write(String((e && e.message) || e));
  process.exit(1);
}
