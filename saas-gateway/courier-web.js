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
const FILES = new Set(["index.html", "rules.html", "app.js", "app.css", "qr.js", "sw.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]);
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

function createCourierWeb({ dir = path.join(__dirname, "courier-web") } = {}) {
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

  /** rel — путь после /courier/ ("" — главная). */
  function serve(req, res, rel) {
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

  return { serve };
}

module.exports = { createCourierWeb, CSP, FILES };
