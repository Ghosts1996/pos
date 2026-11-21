"use strict";
// Киоск самообслуживания: планшет у стойки, гость сам выбирает блюда и
// получает номер заказа, платит на кассе. Заказ попадает в кассу как
// заказ с собой (source "kiosk", номер — общий счётчик с кассой), его
// подтверждает кассир — так же, как заказ из приложения гостя.
//
// Владелец в кабинете (Настройки → «Киоск самообслуживания») получает
// ссылку https://pii.zalpos.ru/saas/kiosk/#<ключ> и открывает её на
// планшете. Ни имени, ни телефона гостя киоск не спрашивает. Табак,
// кальяны и алкоголь в киоске не продаются (возраст не проверить) — то же
// правило, что для заказов с собой и доставки (remoteSaleBanned).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { remoteSaleBanned, priceItems, openNow, localNow } = require("./guest-delivery");

const KEY_RE = /^[A-Za-z0-9]{24}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const MAX_LINES = 30;
const PER_HOUR = 120;
const TAKEAWAY_TABLE = "takeaway";
const FILES = { "": "index.html", "index.html": "index.html", "kiosk.js": "kiosk.js", "kiosk.css": "kiosk.css" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
function randomKey(n = 24) {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < n) for (const b of crypto.randomBytes(n * 2)) if (b < limit && out.length < n) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function createKiosk(deps) {
  const { db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, now = () => Date.now(),
    dir = path.join(__dirname, "kiosk-web"), publicUrl = (process.env.SAAS_GATEWAY_PUBLIC_URL || "https://pii.zalpos.ru/saas").replace(/\/+$/, "") } = deps;
  const Timestamp = admin.firestore.Timestamp;
  const keys = () => db().collection("kioskKeys");
  const tenant = (tid) => db().collection("tenants").doc(tid);
  const settingsRef = (tid) => tenant(tid).collection("settings").doc("kiosk");
  const hits = new Map();

  async function current(tid) {
    const d = (await settingsRef(tid).get()).data() || {};
    return { key: KEY_RE.test(d.key || "") ? d.key : "" };
  }

  /** Кабинет: ссылка на киоск (get | rotate). */
  async function handleLink(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const tid = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new HttpError(400, "Не указано заведение");
    await requireTenantRole(tid, decoded.uid, ["owner", "admin"]);
    const action = String(body.action || "get");
    if (!["get", "rotate"].includes(action)) throw new HttpError(400, "Неизвестное действие");
    let cur = await current(tid);
    if (action === "rotate" || !cur.key) {
      const key = randomKey();
      await keys().doc(key).set({ tenantId: tid, createdAt: Timestamp.fromMillis(now()), createdBy: decoded.uid });
      if (cur.key) await keys().doc(cur.key).delete().catch(() => {});
      await settingsRef(tid).set({ key }, { merge: true });
      cur = { key };
    }
    const venue = (await tenant(tid).collection("meta").doc("venueProfile").get()).data() || {};
    sendJson(res, 200, { url: `${publicUrl}/kiosk/#${cur.key}`, takeawayOn: venue.deliveryEnabled === true });
  }

  async function venueByKey(key) {
    if (!KEY_RE.test(key)) return null;
    const k = await keys().doc(key).get();
    if (!k.exists) return null;
    const tid = k.data().tenantId;
    const [t, cfg] = await Promise.all([tenant(tid).get(), current(tid)]);
    if (!t.exists || cfg.key !== key || ["deleted", "suspended", "past_due"].includes((t.data() || {}).status)) return null;
    return { tid, t: t.data() || {} };
  }

  async function menuOf(tid) {
    const [items, cats] = await Promise.all([tenant(tid).collection("menuItems").get(), tenant(tid).collection("menuCategories").get()]);
    const catMap = Object.fromEntries(cats.docs.map((d) => [d.id, d.data() || {}]));
    const categories = cats.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .filter((c) => c.hidden !== true && c.kind !== "hookah")
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.name || "").localeCompare(String(b.name || ""), "ru"));
    const list = items.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .filter((m) => m.available !== false && m.byWeight !== true && m.archived !== true && Number(m.price) > 0 && !remoteSaleBanned(m, String((catMap[m.categoryId] || {}).name || "")) && (catMap[m.categoryId] || {}).kind !== "hookah");
    return { catMap, categories, list };
  }

  async function menu(key) {
    const v = await venueByKey(key);
    if (!v) return null;
    const { categories, list } = await menuOf(v.tid);
    const used = new Set(list.map((m) => m.categoryId));
    return {
      venue: String(v.t.name || ""),
      categories: categories.filter((c) => used.has(c.id)).map((c) => ({ id: c.id, name: String(c.name || "") })),
      items: list.sort((a, b) => (Number(b.popularRank) || 0) - (Number(a.popularRank) || 0) || String(a.name).localeCompare(String(b.name), "ru")).map((m) => ({
        id: m.id, categoryId: m.categoryId || "", name: String(m.name || ""), price: round2(m.price),
        description: String(m.description || "").slice(0, 300), imageUrl: /^https:\/\//.test(m.imageUrl || "") ? m.imageUrl : "",
        weight: Number(m.weight) > 0 ? Number(m.weight) : null, weightUnit: m.weightUnit || null,
        groups: (Array.isArray(m.modifierGroups) ? m.modifierGroups : []).filter((g) => g && g.name && Array.isArray(g.options) && g.options.length)
          .map((g) => ({ name: String(g.name), min: Number(g.min) || 0, max: Number(g.max ?? 1),
            options: g.options.map((o) => ({ name: String(o.name || ""), price: round2(o.price) })).filter((o) => o.name) })),
      })),
    };
  }

  async function order(key, body) {
    const v = await venueByKey(key);
    if (!v) throw new HttpError(404, "Киоск не найден — откройте новую ссылку из кабинета");
    const { tid, t } = v;
    const h = hits.get(tid) || { n: 0, reset: now() + 3600e3 };
    if (h.reset <= now()) { h.n = 0; h.reset = now() + 3600e3; }
    if (++h.n > PER_HOUR) throw new HttpError(429, "Слишком много заказов — подойдите на кассу");
    hits.set(tid, h);
    const venue = (await tenant(tid).collection("meta").doc("venueProfile").get()).data() || {};
    if (venue.deliveryEnabled !== true) throw new HttpError(409, "Киоск сейчас не принимает заказы — подойдите на кассу");
    const hours = openNow(venue.workingHours, localNow(new Date(now()), t.timezone));
    if (!hours.open && venue.workingHours && Object.keys(venue.workingHours).length) throw new HttpError(409, "Заведение сейчас закрыто");
    const lines = Array.isArray(body.items) ? body.items : [];
    if (!lines.length) throw new HttpError(400, "Корзина пуста");
    if (lines.length > MAX_LINES) throw new HttpError(400, `Не больше ${MAX_LINES} позиций в заказе`);
    for (const l of lines) if (!l || typeof l.menuItemId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(l.menuItemId)) throw new HttpError(400, "В корзине неизвестная позиция");
    const { catMap } = await menuOf(tid);
    const docs = await Promise.all([...new Set(lines.map((l) => l.menuItemId))].map((id) => tenant(tid).collection("menuItems").doc(id).get()));
    const menuMap = Object.fromEntries(docs.filter((d) => d.exists).map((d) => [d.id, d.data()]));
    const names = Object.fromEntries(Object.entries(catMap).map(([id, c]) => [id, String(c.name || "")]));
    let priced;
    try { priced = priceItems(lines, menuMap, names); } catch (e) { throw new HttpError(409, e.message); }
    const items = priced.items.filter((i) => (catMap[(menuMap[i.menuItemId] || {}).categoryId] || {}).kind !== "hookah");
    if (!items.length) throw new HttpError(409, "Эти позиции в киоске не продаются — подойдите на кассу");
    const total = round2(items.reduce((a, i) => a + i.price * i.qty, 0));
    const here = body.here === true;
    const label = here ? "Киоск · здесь" : "Киоск · с собой";
    const tf = tenant(tid);
    const sessionRef = tf.collection("sessions").doc();
    const tableRef = tf.collection("tables").doc(TAKEAWAY_TABLE);
    const counterRef = tf.collection("settings").doc("orderCounter");
    const nowTs = Timestamp.fromMillis(now());
    let orderNo = 0;
    await db().runTransaction(async (tx) => {
      const table = (await tx.get(tableRef)).data();
      const counter = (await tx.get(counterRef)).data();
      orderNo = (Math.trunc(Number(counter?.last)) || 0) + 1;
      tx.set(counterRef, { last: orderNo }, { merge: true });
      const active = Array.isArray(table?.activeSessionIds) ? table.activeSessionIds.map(String) : [];
      tx.set(sessionRef, {
        tableId: TAKEAWAY_TABLE, tableName: label, employeeName: "Киоск", employeeId: "", guestTag: "",
        orderType: "takeaway", orderNo, deliveryStatus: "new", source: "kiosk", clientUid: "", payMethod: "on_receipt",
        ...(here ? { deliveryComment: "Гость ест в заведении" } : {}),
        appTotal: total, startTime: nowTs, plannedEnd: Timestamp.fromMillis(now() + 3 * 3600e3),
        refillCount: 0, refillHistory: [], discountCardId: "", discountPercent: 0, orderItems: [], status: "active", closedAt: null,
        paymentCash: 0, paymentCard: 0, paymentTerminal: 0, paymentComp: 0, closedWithoutPayment: false, receiptPrinted: false,
        fiscalReceiptPrinted: false, tipsCash: 0, tipsCard: 0, refunded: false, refundedAt: null,
      });
      if (table) tx.update(tableRef, { activeSessionIds: [...active, sessionRef.id], status: "occupied" });
      else tx.set(tableRef, { name: "С собой и доставка", x: 0, y: 0, seats: 0, maxOpenSessions: 200, activeSessionIds: [sessionRef.id], status: "occupied" });
      tx.set(tf.collection("guestOrders").doc(), {
        sessionId: sessionRef.id, tableId: TAKEAWAY_TABLE, tableName: `${label} · №${orderNo}`, clientUid: "", guestName: "",
        items, comment: here ? "Здесь" : "С собой", targetPosition: "", orderType: "takeaway", status: "new", createdAt: nowTs, source: "kiosk",
      });
    });
    return { orderNo: String(orderNo), total, skipped: priced.banned };
  }

  /** GET/POST /kiosk/… — страница, меню и заказ. */
  async function serve(req, res, sub, readJson) {
    const key = String((req.headers || {})["x-kiosk-key"] || "").trim();
    const json = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    if (sub === "menu" && req.method === "GET") {
      const m = await menu(key);
      return m ? json(200, m) : json(404, { error: "Киоск не найден — откройте новую ссылку из кабинета" });
    }
    if (sub === "order" && req.method === "POST") {
      try {
        return json(200, await order(key, await readJson(req)));
      } catch (e) {
        return json(e.status || e.statusCode || 500, { error: e.status || e.statusCode ? e.message : "Не получилось — подойдите на кассу" });
      }
    }
    const file = FILES[sub];
    if (!file || !(req.method === "GET" || req.method === "HEAD")) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("не найдено"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)], "Cache-Control": "no-cache", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    return res.end(req.method === "HEAD" ? undefined : fs.readFileSync(path.join(dir, file)));
  }

  return { handleLink, serve, menu, order };
}

module.exports = { createKiosk, KEY_RE };
