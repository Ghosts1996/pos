"use strict";
// Текст со скриншотов клиента — распознаётся здесь, на сервере в России
// (tesseract.js, русский и английский). ИИ получает только текст, и тот
// обезличенный (scrubPii/maskSecrets в support-bot.js), а сама картинка за
// пределы сервера не уходит: так скриншоты «видны» боту и в режиме «данные
// только в России» (152-ФЗ).
//
// Пакеты необязательные: нет tesseract.js или языковых данных — available()
// вернёт false, и бот попросит описать скриншот словами, как раньше.

const fs = require("fs");
const os = require("os");
const path = require("path");

const IDLE_MS = 10 * 60 * 1000;   // распознаватель держит ~100 МБ памяти — выгружаем без дела
const TIMEOUT_MS = 25 * 1000;     // одна картинка
const MAX_BYTES = 8 * 1024 * 1024;

let lib;       // tesseract.js или null — пакета нет
let worker = null;
let starting = null;
let idleTimer = null;
let queue = Promise.resolve();

function tesseract() {
  if (lib === undefined) {
    try {
      lib = require("tesseract.js");
    } catch (_) {
      lib = null;
    }
  }
  return lib;
}

/** Языковые данные из npm-пакетов — в одну папку (tesseract ждёт их рядом). */
function langDir() {
  const dir = path.join(process.env.SUPPORT_OCR_DIR || path.join(os.tmpdir(), "zalpos-ocr"), "lang");
  fs.mkdirSync(dir, { recursive: true });
  for (const lang of ["rus", "eng"]) {
    const dst = path.join(dir, `${lang}.traineddata.gz`);
    if (fs.existsSync(dst)) continue;
    const pkg = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
    fs.copyFileSync(path.join(pkg, "4.0.0_best_int", `${lang}.traineddata.gz`), dst);
  }
  return dir;
}

function available() {
  if (!tesseract()) return false;
  try {
    require.resolve("@tesseract.js-data/rus/package.json");
    require.resolve("@tesseract.js-data/eng/package.json");
    return true;
  } catch (_) {
    return false;
  }
}

async function getWorker() {
  if (worker) return worker;
  if (!starting) {
    const dir = langDir();
    starting = tesseract().createWorker(["rus", "eng"], 1, {
      langPath: dir, cachePath: path.join(dir, "..", "cache"), gzip: true, logger: () => {}, errorHandler: () => {},
    }).then((w) => { worker = w; return w; }).finally(() => { starting = null; });
  }
  return starting;
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const w = worker;
    worker = null;
    if (w) w.terminate().catch(() => {});
  }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

/** Текст картинки: строки без пустых и «мусора» распознавания. Пусто — текста нет. */
function clean(text) {
  return String(text || "").split("\n").map((l) => l.replace(/\s+/g, " ").trim())
    // Строка из одних значков и цифр (строка состояния телефона) — не текст.
    .filter((l) => l.length >= 2 && /[a-zа-яё]{2}/i.test(l))
    .join("\n").slice(0, 3000);
}

/** Распознать по одной картинке за раз (иначе память). */
function recognize(buffer) {
  if (!available() || !buffer || !buffer.length || buffer.length > MAX_BYTES) return Promise.resolve("");
  const job = queue.then(async () => {
    const w = await getWorker();
    let timer;
    try {
      const res = await Promise.race([
        w.recognize(buffer),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("распознавание дольше 25 с")), TIMEOUT_MS); }),
      ]);
      return clean(res && res.data && res.data.text);
    } catch (e) {
      // Завис или упал — распознаватель заново при следующей картинке.
      const old = worker;
      worker = null;
      if (old) old.terminate().catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
      touch();
    }
  });
  queue = job.catch(() => {});
  return job;
}

module.exports = { available, recognize, clean };
