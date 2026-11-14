"use strict";
/**
 * Файлы приложения курьера (courier-web/) — отдаёт сам шлюз по адресу
 * /courier/… (снаружи — https://pii.zalpos.ru/saas/courier/): nginx и
 * update-server.sh не трогаем. Только файлы из списка, с ETag и своей
 * политикой безопасности: скрипты — только свои, запросы — только к шлюзу,
 * встраивать можно только карту Яндекса.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const FILES = new Set(["index.html", "rules.html", "app.js", "theme.js", "app.css", "qr.js", "sw.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]);
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * dir — файлы приложения; mapDir — движок своей карты (map-web/, тоже часть
 * приложения: его правка — тоже обновление); apkInfo() — версия APK для
 * Android на сервере ({versionCode, versionName, size, at} или null).
 */
function createCourierWeb({ dir = path.join(__dirname, "courier-web"), mapDir = path.join(__dirname, "map-web"), apkInfo = () => null } = {}) {
  const cache = new Map();

  function load(name) {
    const file = path.join(dir, name);
    const st = fs.statSync(file);
    const hit = cache.get(name);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    const body = fs.readFileSync(file);
    const entry = { body, mtime: st.mtimeMs, etag: `"${crypto.createHash("sha1").update(body).digest("hex").slice(0, 20)}"` };
    cache.set(name, entry);
    return entry;
  }

  // Версия приложения: отпечаток всех его файлов и движка карты. Меняется с
  // каждым обновлением на сервере; приложение сверяет её со своей
  // (<meta name="zc-ver"> в index.html) и подтягивает новую само.
  let verMemo = { key: "", value: "", at: 0 };
  function mapFiles() {
    const out = [];
    const walk = (d, pre) => {
      let list = [];
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of list.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.isDirectory()) { if (e.name !== "fonts") walk(path.join(d, e.name), `${pre}${e.name}/`); } else if (/\.(js|css)$/.test(e.name)) out.push(path.join(d, e.name));
      }
    };
    walk(mapDir, "");
    return out;
  }
  function version() {
    const files = [...[...FILES].sort().map((n) => path.join(dir, n)), ...mapFiles()];
    let at = 0;
    const stats = files.map((f) => { try { const s = fs.statSync(f); at = Math.max(at, s.mtimeMs); return `${f}:${s.mtimeMs}:${s.size}`; } catch (_) { return `${f}:-`; } });
    const key = stats.join("|");
    if (verMemo.key === key) return verMemo.value;
    const h = crypto.createHash("sha1");
    for (const f of files) {
      if (path.basename(f) === "index.html") continue; // в index.html — сама версия
      try { h.update(path.relative(dir, f)).update(fs.readFileSync(f)); } catch (_) { /* нет файла */ }
    }
    try { h.update(fs.readFileSync(path.join(dir, "index.html"))); } catch (_) { /* нет файла */ }
    verMemo = { key, value: h.digest("hex").slice(0, 12), at: Math.round(at) };
    return verMemo.value;
  }

  /** Что сейчас на сервере: версия приложения и APK для Android. */
  function versionJson(res) {
    let apk = null;
    try { apk = apkInfo(); } catch (_) { apk = null; }
    const body = JSON.stringify({
      web: version(),
      webAt: verMemo.at,
      apk: apk && apk.versionCode ? { code: apk.versionCode, name: apk.versionName || "", size: apk.size || 0, at: apk.at || 0 } : null,
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    res.end(body);
  }

  /** rel — путь после /courier/ ("" — главная). */
  function serve(req, res, rel) {
    if (rel === "version.json") return versionJson(res);
    const name = rel === "" ? "index.html" : rel;
    if (!FILES.has(name)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Не найдено");
    }
    let f;
    try {
      f = load(name);
    } catch (_) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Не найдено");
    }
    // Главная — с версией приложения внутри (по ней приложение узнаёт, что вышло новое).
    if (name === "index.html") {
      const v = version();
      const body = Buffer.from(f.body.toString("utf8").replace('<meta name="zc-ver" content="">', `<meta name="zc-ver" content="${v}">`));
      f = { body, etag: `"${f.etag.slice(1, 13)}-${v}"` };
    }
    const ext = path.extname(name);
    const headers = {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      // Обновления приходят сразу: браузер каждый раз сверяет ETag.
      "Cache-Control": "no-cache",
      ETag: f.etag,
      "Content-Security-Policy": CSP,
      "X-Robots-Tag": "noindex",
    };
    // Служебный скрипт отвечает за всё приложение (/courier/).
    if (name === "sw.js") headers["Service-Worker-Allowed"] = "./";
    if (req.headers && req.headers["if-none-match"] === f.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, "Content-Length": f.body.length });
    res.end(req.method === "HEAD" ? undefined : f.body);
  }

  return { serve, version };
}

module.exports = { createCourierWeb, CSP, FILES };
