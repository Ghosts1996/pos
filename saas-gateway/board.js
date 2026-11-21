"use strict";
// Табло заказов для гостей: «Готовится» / «Готов — заберите» с номерами
// заказов с собой (и, по настройке, заказов в зале — с названием стола).
//
// Владелец в кабинете (Настройки → «Табло заказов») получает ссылку вида
// https://pii.zalpos.ru/saas/board/#<ключ> и открывает её на любом
// телевизоре или планшете с браузером. Ключ — случайный, 24 знака, его
// можно сменить (старая ссылка перестанет работать). Страница раз в 4 с
// спрашивает /board/data с ключом в заголовке X-Board-Key.
//
// На табло только номера заказов и название заведения: ни имён, ни
// телефонов, ни состава заказа.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const KEY_RE = /^[A-Za-z0-9]{24}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const WINDOW_MS = 4 * 3600e3;
const READY_KEEP_MS = 40 * 60e3;
const CACHE_MS = 2000;
const FILES = { "": "index.html", "index.html": "index.html", "board.js": "board.js", "board.css": "board.css" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function randomKey(n = 24) {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < n) for (const b of crypto.randomBytes(n * 2)) if (b < limit && out.length < n) out += ALPHABET[b % ALPHABET.length];
  return out;
}

const toMs = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : typeof v === "number" ? v : 0);
const n = (x) => Math.max(0, Math.round(Number(x) || 0));

/** Номер заказа для табло — как в кассе (orderNumberLabel). */
function orderLabel(id, orderNo) {
  if (n(orderNo) > 0) return String(n(orderNo));
  const s = String(id || "");
  return (s.length <= 4 ? s : s.slice(-4)).toUpperCase();
}

/**
 * Состояние заказа для табло по строкам: только отправленные на кухню/бар.
 * → "cooking" | "ready" | null (нечего показывать / всё выдано).
 */
function boardState(s, t = Date.now()) {
  if (!s || s.status === "cancelled" || s.deliveryStatus === "cancelled" || s.training === true) return null;
  const items = (Array.isArray(s.orderItems) ? s.orderItems : []).filter((i) => n(i.sent) > 0 && i.hold !== true);
  if (!items.length) return null;
  if (items.some((i) => n(i.ready) < n(i.sent))) return "cooking";
  if (items.every((i) => n(i.served) >= n(i.ready))) return null;
  const readyAt = Math.max(...items.map((i) => n(i.readyAt)));
  if (readyAt && t - readyAt > READY_KEEP_MS) return null;
  return "ready";
}

function createBoard(deps) {
  const { db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, now = () => Date.now(),
    dir = path.join(__dirname, "board-web"), publicUrl = (process.env.SAAS_GATEWAY_PUBLIC_URL || "https://pii.zalpos.ru/saas").replace(/\/+$/, "") } = deps;
  const Timestamp = admin.firestore.Timestamp;
  const keys = () => db().collection("boardKeys");
  const settingsRef = (tid) => db().collection("tenants").doc(tid).collection("settings").doc("board");
  const cache = new Map(); // key → { at, body }

  async function current(tid) {
    const d = (await settingsRef(tid).get()).data() || {};
    return { key: KEY_RE.test(d.key || "") ? d.key : "", hall: d.hall === true };
  }

  async function issue(tid, uid, hall) {
    const old = await current(tid);
    const key = randomKey();
    await keys().doc(key).set({ tenantId: tid, createdAt: Timestamp.fromMillis(now()), createdBy: uid });
    if (old.key) await keys().doc(old.key).delete().catch(() => {});
    await settingsRef(tid).set({ key, hall: hall === undefined ? old.hall : hall === true }, { merge: true });
    return key;
  }

  /** Кабинет: ссылка на табло. action: get | rotate | settings. */
  async function handleLink(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const tid = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new HttpError(400, "Не указано заведение");
    await requireTenantRole(tid, decoded.uid, ["owner", "admin", "manager"]);
    const action = String(body.action || "get");
    let cur = await current(tid);
    if (action === "rotate" || (action === "get" && !cur.key)) {
      await issue(tid, decoded.uid);
    } else if (action === "settings") {
      await settingsRef(tid).set({ hall: body.hall === true }, { merge: true });
    } else if (action !== "get") {
      throw new HttpError(400, "Неизвестное действие");
    }
    cur = await current(tid);
    for (const k of cache.keys()) cache.delete(k);
    sendJson(res, 200, { url: `${publicUrl}/board/#${cur.key}`, hall: cur.hall });
  }

  async function data(key) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.body;
    const k = await keys().doc(key).get();
    if (!k.exists) return null;
    const tid = k.data().tenantId;
    const [tenant, cfg] = await Promise.all([db().collection("tenants").doc(tid).get(), current(tid)]);
    const t = tenant.data() || {};
    if (!tenant.exists || t.status === "deleted" || cfg.key !== key) return null;
    const since = Timestamp.fromMillis(now() - WINDOW_MS);
    const snap = await db().collection("tenants").doc(tid).collection("sessions").where("startTime", ">=", since).get();
    const cooking = [];
    const ready = [];
    for (const d of snap.docs) {
      const s = d.data() || {};
      const type = s.orderType || "hall";
      if (type !== "takeaway" && !(cfg.hall && type === "hall")) continue;
      const st = boardState(s, now());
      if (!st) continue;
      const label = type === "hall" ? String(s.tableName || orderLabel(d.id, s.orderNo)) : orderLabel(d.id, s.orderNo);
      (st === "ready" ? ready : cooking).push({ label, at: toMs(s.startTime), table: type === "hall" });
    }
    const by = (a, b) => a.at - b.at;
    const body = { venue: String(t.name || ""), cooking: cooking.sort(by).map((x) => ({ label: x.label, table: x.table })),
      ready: ready.sort(by).map((x) => ({ label: x.label, table: x.table })), at: now() };
    cache.set(key, { at: now(), body });
    if (cache.size > 2000) cache.clear();
    return body;
  }

  /** GET /board/… — страница табло и её данные. */
  async function serve(req, res, sub) {
    if (sub === "data") {
      const key = String((req.headers || {})["x-board-key"] || "").trim();
      const body = KEY_RE.test(key) ? await data(key) : null;
      res.writeHead(body ? 200 : 404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return res.end(JSON.stringify(body || { error: "Табло не найдено — возьмите новую ссылку в кабинете" }));
    }
    const file = FILES[sub];
    if (!file) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("не найдено"); }
    const buf = fs.readFileSync(path.join(dir, file));
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)], "Cache-Control": "no-cache", "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    });
    return res.end(req.method === "HEAD" ? undefined : buf);
  }

  return { handleLink, serve, data };
}

module.exports = { createBoard, boardState, orderLabel, KEY_RE };
