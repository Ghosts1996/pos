"use strict";
// Синтаксис скриптов сайта, кабинета и веб-приложения гостя: одна лишняя
// скобка — и браузер не запускает страницу вовсе (вечная загрузка).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..", "saas");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // node_modules и vendor/ — сторонние библиотеки как есть (pdf.js и т. п.).
    if (e.name === "node_modules" || e.name === "vendor") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(m?js|html)$/.test(e.name)) files.push(p);
  }
})(root);
// Приложение курьера — его отдаёт сам шлюз (courier-web/).
for (const e of fs.readdirSync(path.join(__dirname, "courier-web"))) {
  if (/\.(m?js|html)$/.test(e)) files.push(path.join(__dirname, "courier-web", e));
}
// Табло заказов — тоже отдаёт шлюз (board-web/).
for (const d of ["board-web", "kiosk-web"]) {
  for (const e of fs.readdirSync(path.join(__dirname, d))) {
    if (/\.(m?js|html)$/.test(e)) files.push(path.join(__dirname, d, e));
  }
}
// Своя карта: наша обёртка (движок MapLibre — готовая сборка, его не проверяем).
files.push(path.join(__dirname, "map-web", "zal-map.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "websyntax-"));
let failed = 0;
let checked = 0;
function check(label, code, type) {
  const f = path.join(tmp, `${checked}.${type === "module" ? "mjs" : "cjs"}`);
  fs.writeFileSync(f, code);
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  checked++;
  if (r.status !== 0) {
    failed++;
    console.error(`✗ ${label}\n${(r.stderr || "").split("\n").slice(0, 6).join("\n")}`);
  }
}
for (const f of files) {
  const rel = path.relative(root, f);
  const text = fs.readFileSync(f, "utf8");
  if (f.endsWith(".html")) {
    const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
    let m;
    let i = 0;
    while ((m = re.exec(text))) {
      const attrs = m[1] || "";
      if (/\ssrc=/.test(attrs) || /type=["']?(application\/(ld\+)?json|text\/template)/i.test(attrs) || !m[2].trim()) continue;
      check(`${rel} <script #${++i}>`, m[2], /type=["']?module/i.test(attrs) ? "module" : "classic");
    }
  } else {
    // Модули (import/export) — как ES-модули, остальное — как обычный скрипт.
    const isModule = f.endsWith(".mjs") || /^\s*(import|export)\s/m.test(text);
    check(rel, text, isModule ? "module" : "classic");
  }
}
// 20.11.2026: разбор ?p= / ?v= / Telegram шёл прямо при загрузке модуля, раньше
// объявления своих констант ниже по файлу, — ошибку глотал try, и ссылки
// менеджеров не закрепляли заведения. Вызовы — только через микрозадачу.
{
  const consoleJs = fs.readFileSync(path.join(__dirname, "..", "saas", "console", "console.js"), "utf8");
  checked++;
  if (/^(captureTelegramApp|capturePartnerRef)\(\);/m.test(consoleJs)) {
    failed++;
    console.error("FAIL console.js: captureTelegramApp()/capturePartnerRef() вызваны до объявления констант — только в Promise.resolve().then(...)");
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`web-syntax: ${checked - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
