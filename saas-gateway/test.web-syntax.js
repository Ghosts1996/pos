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
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(m?js|html)$/.test(e.name)) files.push(p);
  }
})(root);

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
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`web-syntax: ${checked - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
