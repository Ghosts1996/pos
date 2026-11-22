"use strict";
// Заказы Яндекс Еды и Купера — сразу в кассу.
//
// Кабинет · «Настройки» → «Яндекс Еда и Купер» (владелец, админ) выдаёт:
//  • Яндекс Еда — интеграция «касса как сервер»: адрес
//    https://pii.zalpos.ru/saas/agg/yandex/<ключ>, client_id и client_secret.
//    Менеджер Яндекс Еды вписывает их у себя; дальше Яндекс сам берёт токен
//    (POST /security/oauth/token), меню (GET /menu/{id}/composition),
//    стоп-лист (GET /menu/{id}/availability), присылает заказ (POST /order),
//    спрашивает статус (GET /order/{id}/status) и отменяет (DELETE /order/{id}).
//  • Купер — адрес для уведомлений о заказах …/agg/kuper/<ключ> и токен
//    (заголовок Authorization: Bearer <токен>); заказ — POST, статус — GET
//    …/orders/<номер>. Формат Купер согласует при подключении; разбор гибкий.
//
// Заказ становится заказом «с собой» на кассе (как с киоска): источник
// yandex_eda / kuper, номер — общий счётчик, оплата — «Оплачено в
// агрегаторе». Кассир жмёт «Подтвердить» — позиции встают в чек и уходят на
// кухню; статусы «Принят → Готовится → Готов → Выдан» агрегатор видит сам.
// Цены — из меню заведения (не из заказа). Имени и телефона гостя не храним:
// курьер агрегатора забирает заказ сам; комментарий — через вычистку ПДн.
// Табак, кальяны, алкоголь и весовой товар в меню для агрегаторов не уходят.
// С настоящими кабинетами Яндекс Еды и Купера не проверено — первое
// подключение вместе с их менеджером, на тестовом заказе.

const crypto = require("crypto");
const { remoteSaleBanned, priceItems } = require("./guest-delivery");
const { scrubText } = require("./pii-scrub");

const KEY_RE = /^[A-Za-z0-9]{24}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const TAKEAWAY_TABLE = "takeaway";
const TOKEN_TTL = 3600;
const PER_HOUR = 300;
const MAX_LINES = 60;
const SOURCES = { yandex: "yandex_eda", kuper: "kuper" };
const NAMES = { yandex_eda: "Яндекс Еда", kuper: "Купер" };
// Статус заказа на кассе → статус для Яндекс Еды.
const YANDEX_STATUS = { new: "NEW", accepted: "ACCEPTED_BY_RESTAURANT", cooking: "COOKING", ready: "READY", courier: "READY",
  done: "TAKEN_BY_COURIER", cancelled: "CANCELLED" };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
function randomKey(n = 24) {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < n) for (const b of crypto.randomBytes(n * 2)) if (b < limit && out.length < n) out += ALPHABET[b % ALPHABET.length];
  return out;
}
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** id добавки для агрегатора: «<позиция>~<группа>~<вариант>». */
const modId = (itemId, gi, oi) => `${itemId}~${gi}~${oi}`;

/** Меню заведения в формате Яндекс Еды (composition). */
function yandexComposition(cats, items) {
  const used = new Set(items.map((m) => m.categoryId || "other"));
  return {
    categories: [
      ...cats.filter((c) => used.has(c.id)).map((c, i) => ({ id: c.id, name: String(c.name || "Меню"), sortOrder: Number(c.order) || i })),
      ...(used.has("other") ? [{ id: "other", name: "Меню", sortOrder: 999 }] : []),
    ],
    items: items.map((m, i) => ({
      id: m.id,
      categoryId: m.categoryId || "other",
      name: String(m.name || ""),
      description: String(m.description || "").slice(0, 500),
      price: round2(m.price),
      vat: m.vat === "vat22" ? 22 : m.vat === "vat10" ? 10 : m.vat === "none" ? -1 : 0,
      measure: Number(m.weight) > 0 ? Number(m.weight) : 1,
      measureUnit: m.weightUnit === "ml" || m.weightUnit === "l" ? "мл" : Number(m.weight) > 0 ? "г" : "шт",
      sortOrder: i,
      images: /^https:\/\//.test(m.imageUrl || "") ? [{ url: m.imageUrl }] : [],
      modifierGroups: (Array.isArray(m.modifierGroups) ? m.modifierGroups : []).filter((g) => g && Array.isArray(g.options) && g.options.length)
        .map((g, gi) => ({
          id: `${m.id}~${gi}`, name: String(g.name || "Добавки"),
          minSelectedModifiers: Number(g.min) || 0, maxSelectedModifiers: Number(g.max ?? 1) || g.options.length,
          modifiers: g.options.map((o, oi) => ({ id: modId(m.id, gi, oi), name: String(o.name || ""), price: round2(o.price), minAmount: 0, maxAmount: 1 })),
        })),
    })),
  };
}

/** Строки заказа агрегатора → [{ menuItemId, qty, mods: [названия] }]. */
function linesOf(items, menuMap) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== "object") continue;
    const id = String(it.id ?? it.itemId ?? it.external_id ?? it.externalId ?? it.sku ?? it.product_id ?? "").trim();
    const qty = Math.floor(Number(it.quantity ?? it.qty ?? it.amount ?? 1));
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !(qty >= 1)) continue;
    const m = menuMap[id] || {};
    const mods = [];
    for (const md of [...(it.modifications || []), ...(it.modifiers || []), ...(it.options || [])]) {
      const mid = String((md && (md.id ?? md.external_id)) || "");
      const [, gi, oi] = mid.split("~");
      const g = (m.modifierGroups || [])[Number(gi)];
      const o = g && (g.options || [])[Number(oi)];
      const name = o ? o.name : md && md.name;
      if (name) mods.push(String(name));
    }
    out.push({ menuItemId: id, qty, mods, name: String(it.name || "") });
  }
  return out;
}

function createAggregators(deps) {
  const { db, admin, verifyAuth, parseJsonBody, readBody, sendJson, HttpError, requireTenantRole,
    now = () => Date.now(), publicUrl = (process.env.SAAS_GATEWAY_PUBLIC_URL || "https://pii.zalpos.ru/saas").replace(/\/+$/, "") } = deps;
  const Timestamp = admin.firestore.Timestamp;
  const keys = () => db().collection("aggregatorKeys");
  const tenant = (tid) => db().collection("tenants").doc(tid);
  const settingsRef = (tid) => tenant(tid).collection("settings").doc("aggregatorLinks");
  const tokens = new Map(); // токен → { tid, exp }
  const hits = new Map();

  async function current(tid) {
    return (await settingsRef(tid).get()).data() || {};
  }

  // ------------------------------------------------ кабинет

  async function handleLink(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const tid = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new HttpError(400, "Не указано заведение");
    await requireTenantRole(tid, decoded.uid, ["owner", "admin"]);
    const kind = body.kind === "kuper" ? "kuper" : "yandex";
    const action = String(body.action || "get");
    if (!["get", "create", "rotate", "disable"].includes(action)) throw new HttpError(400, "Неизвестное действие");
    const cur = await current(tid);
    const c = cur[kind] || {};
    let secretShown = "";
    if (action === "create" || action === "rotate") {
      const key = randomKey();
      const secret = randomKey(32);
      await keys().doc(key).set({ tenantId: tid, kind, createdAt: Timestamp.fromMillis(now()), createdBy: decoded.uid });
      if (c.key) await keys().doc(c.key).delete().catch(() => {});
      await settingsRef(tid).set({ [kind]: { key, secretHash: sha(secret), enabled: true, createdAt: Timestamp.fromMillis(now()) } }, { merge: true });
      for (const [t, v] of tokens) if (v.key === c.key) tokens.delete(t);
      secretShown = secret;
    } else if (action === "disable") {
      if (c.key) await keys().doc(c.key).delete().catch(() => {});
      await settingsRef(tid).set({ [kind]: admin.firestore.FieldValue.delete() }, { merge: true });
    }
    const fresh = (await current(tid))[kind] || {};
    const venue = (await tenant(tid).collection("meta").doc("venueProfile").get()).data() || {};
    sendJson(res, 200, {
      kind,
      connected: !!fresh.key,
      url: fresh.key ? `${publicUrl}/agg/${kind}/${fresh.key}` : "",
      clientId: fresh.key || "",
      secret: secretShown, // только сразу после создания
      takeawayOn: venue.deliveryEnabled === true,
      lastOrderAt: fresh.lastOrderAt && typeof fresh.lastOrderAt.toMillis === "function" ? fresh.lastOrderAt.toMillis() : null,
    });
  }

  async function venueByKey(kind, key) {
    if (!KEY_RE.test(key)) return null;
    const k = await keys().doc(key).get();
    if (!k.exists || k.data().kind !== kind) return null;
    const tid = k.data().tenantId;
    const [t, cfg] = await Promise.all([tenant(tid).get(), current(tid)]);
    const c = cfg[kind] || {};
    if (!t.exists || c.key !== key || ["deleted", "suspended", "past_due"].includes((t.data() || {}).status)) return null;
    return { tid, t: t.data() || {}, c, key };
  }

  // ------------------------------------------------ меню

  async function menuOf(tid) {
    const [items, cats] = await Promise.all([tenant(tid).collection("menuItems").get(), tenant(tid).collection("menuCategories").get()]);
    const catMap = Object.fromEntries(cats.docs.map((d) => [d.id, d.data() || {}]));
    const categories = cats.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .filter((c) => c.hidden !== true && c.kind !== "hookah")
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    const all = items.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    const sellable = all.filter((m) => m.archived !== true && m.byWeight !== true && m.deliveryOff !== true && Number(m.price) > 0
      && !remoteSaleBanned(m, String((catMap[m.categoryId] || {}).name || "")) && (catMap[m.categoryId] || {}).kind !== "hookah"
      && (catMap[m.categoryId] || {}).deliveryOff !== true);
    return { catMap, categories, sellable, menuMap: Object.fromEntries(all.map((m) => [m.id, m])) };
  }

  // ------------------------------------------------ заказ

  async function createOrder(v, source, { extId, items, comment = "", total = 0, pickupAt = null }) {
    const { tid } = v;
    const h = hits.get(tid) || { n: 0, reset: now() + 3600e3 };
    if (h.reset <= now()) { h.n = 0; h.reset = now() + 3600e3; }
    if (++h.n > PER_HOUR) throw new HttpError(429, "Слишком много заказов за час");
    hits.set(tid, h);
    const venue = (await tenant(tid).collection("meta").doc("venueProfile").get()).data() || {};
    if (venue.deliveryEnabled !== true) throw new HttpError(409, "Заведение сейчас не принимает заказы с собой");
    const ext = String(extId || "").slice(0, 80);
    if (!ext) throw new HttpError(400, "Нет номера заказа");
    const tf = tenant(tid);
    const extRef = tf.collection("aggregatorOrders").doc(`${source}_${crypto.createHash("sha1").update(ext).digest("hex").slice(0, 24)}`);
    const seen = await extRef.get();
    if (seen.exists) return { orderId: seen.data().sessionId, dup: true };
    const { catMap, menuMap } = await menuOf(tid);
    const lines = linesOf(items, menuMap);
    if (!lines.length) throw new HttpError(400, "В заказе нет позиций из меню заведения");
    if (lines.length > MAX_LINES) throw new HttpError(400, "Слишком много позиций");
    const names = Object.fromEntries(Object.entries(catMap).map(([id, c]) => [id, String(c.name || "")]));
    let priced;
    try { priced = priceItems(lines, menuMap, names); } catch (e) { throw new HttpError(409, e.message); }
    const sellItems = priced.items.filter((i) => (catMap[(menuMap[i.menuItemId] || {}).categoryId] || {}).kind !== "hookah");
    if (!sellItems.length) throw new HttpError(409, "Этих позиций нет в продаже через агрегатор");
    const ourTotal = round2(sellItems.reduce((a, i) => a + i.price * i.qty, 0));
    const name = NAMES[source];
    const label = `${name} · ${ext.slice(-8)}`;
    const sessionRef = tf.collection("sessions").doc();
    const tableRef = tf.collection("tables").doc(TAKEAWAY_TABLE);
    const counterRef = tf.collection("settings").doc("orderCounter");
    const nowTs = Timestamp.fromMillis(now());
    const note = scrubText(String(comment || "")).replace(/\s+/g, " ").trim().slice(0, 300);
    let orderNo = 0;
    await db().runTransaction(async (tx) => {
      const dup = await tx.get(extRef);
      if (dup.exists) return;
      const table = (await tx.get(tableRef)).data();
      const counter = (await tx.get(counterRef)).data();
      orderNo = (Math.trunc(Number(counter?.last)) || 0) + 1;
      tx.set(counterRef, { last: orderNo }, { merge: true });
      const active = Array.isArray(table?.activeSessionIds) ? table.activeSessionIds.map(String) : [];
      tx.set(sessionRef, {
        tableId: TAKEAWAY_TABLE, tableName: label, employeeName: name, employeeId: "", guestTag: "",
        orderType: "takeaway", orderNo, deliveryStatus: "new", source, clientUid: "", payMethod: "aggregator",
        aggregatorOrderId: ext, aggregatorTotal: round2(total) || ourTotal,
        ...(note ? { deliveryComment: note } : {}),
        ...(pickupAt ? { pickupAt: Timestamp.fromMillis(pickupAt) } : {}),
        appTotal: ourTotal, startTime: nowTs, plannedEnd: Timestamp.fromMillis(now() + 3 * 3600e3),
        refillCount: 0, refillHistory: [], discountCardId: "", discountPercent: 0, orderItems: [], status: "active", closedAt: null,
        paymentCash: 0, paymentCard: 0, paymentTerminal: 0, paymentComp: 0, closedWithoutPayment: false, receiptPrinted: false,
        fiscalReceiptPrinted: false, tipsCash: 0, tipsCard: 0, refunded: false, refundedAt: null,
      });
      if (table) tx.update(tableRef, { activeSessionIds: [...active, sessionRef.id], status: "occupied" });
      else tx.set(tableRef, { name: "С собой и доставка", x: 0, y: 0, seats: 0, maxOpenSessions: 200, activeSessionIds: [sessionRef.id], status: "occupied" });
      tx.set(tf.collection("guestOrders").doc(), {
        sessionId: sessionRef.id, tableId: TAKEAWAY_TABLE, tableName: `${label} · №${orderNo}`, clientUid: "", guestName: "",
        items: sellItems, comment: note || name, targetPosition: "", orderType: "takeaway", status: "new", createdAt: nowTs, source,
      });
      tx.set(extRef, { sessionId: sessionRef.id, source, extId: ext, createdAt: nowTs });
    });
    await settingsRef(tid).set({ [source === "kuper" ? "kuper" : "yandex"]: { lastOrderAt: nowTs } }, { merge: true }).catch(() => {});
    const fresh = await extRef.get();
    return { orderId: fresh.data().sessionId, orderNo, total: ourTotal, skipped: priced.banned };
  }

  async function sessionOf(tid, orderId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(orderId || ""))) return null;
    const s = await tenant(tid).collection("sessions").doc(orderId).get();
    return s.exists && ["yandex_eda", "kuper"].includes(s.data().source) ? s : null;
  }

  async function cancel(v, s, by, reason) {
    const d = s.data();
    if (d.deliveryStatus === "cancelled") return;
    await s.ref.update({ deliveryStatus: "cancelled", cancelledBy: by, cancelReason: scrubText(String(reason || "")).slice(0, 200) });
    await tenant(v.tid).collection("waiterCalls").add({
      tableId: TAKEAWAY_TABLE, tableName: d.tableName || "", sessionId: s.id, clientUid: "", guestName: "", type: "order",
      comment: `${NAMES[d.source]} отменила заказ №${d.orderNo || ""}${reason ? `: ${String(reason).slice(0, 120)}` : ""} — не готовьте его`,
      status: "new", createdAt: Timestamp.fromMillis(now()),
    });
  }

  // ------------------------------------------------ Яндекс Еда

  async function yandex(req, res, key, rest) {
    const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    const v = await venueByKey("yandex", key);
    if (!v) return json(404, [{ code: 404, description: "integration not found" }]);
    if (rest === "security/oauth/token" && req.method === "POST") {
      const raw = await readBody(req, 16384);
      const p = /^\s*\{/.test(raw) ? (() => { try { return JSON.parse(raw); } catch (_) { return {}; } })() : Object.fromEntries(new URLSearchParams(raw));
      if (String(p.client_id || "") !== key || !safeEq(sha(p.client_secret || ""), v.c.secretHash || "")) return json(401, [{ code: 401, description: "invalid client" }]);
      const token = randomKey(40);
      tokens.set(token, { tid: v.tid, key, exp: now() + TOKEN_TTL * 1000 });
      if (tokens.size > 5000) for (const [t, x] of tokens) if (x.exp < now()) tokens.delete(t);
      return json(200, { access_token: token, token_type: "Bearer", expires_in: TOKEN_TTL });
    }
    const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const tok = tokens.get(auth);
    if (!tok || tok.key !== key || tok.exp < now()) return json(401, [{ code: 401, description: "token expired" }]);
    const parts = rest.split("/").filter(Boolean);
    if (parts[0] === "restaurants" && req.method === "GET") {
      return json(200, { places: [{ id: key, title: String(v.t.name || "Заведение"), address: "" }] });
    }
    if (parts[0] === "menu" && parts[2] === "composition" && req.method === "GET") {
      const { categories, sellable } = await menuOf(v.tid);
      return json(200, yandexComposition(categories, sellable));
    }
    if (parts[0] === "menu" && parts[2] === "availability" && req.method === "GET") {
      const { sellable } = await menuOf(v.tid);
      return json(200, { items: sellable.filter((m) => m.available === false).map((m) => ({ itemId: m.id, stock: 0 })), modifiers: [] });
    }
    if (parts[0] === "order" && parts.length === 1 && req.method === "POST") {
      const body = JSON.parse((await readBody(req, 262144)) || "{}");
      const pay = body.paymentInfo || {};
      const di = body.deliveryInfo || {};
      try {
        const r = await createOrder(v, "yandex_eda", {
          extId: body.eatsId || body.orderId || body.id, items: body.items, comment: body.comment,
          total: pay.itemsCost ?? pay.total, pickupAt: Date.parse(di.courierArrivementDate || di.deliveryDate || "") || null,
        });
        return json(200, { result: "OK", orderId: r.orderId });
      } catch (e) {
        return json(e.status || 500, [{ code: e.status || 500, description: e.status ? e.message : "internal error" }]);
      }
    }
    if (parts[0] === "order" && parts[1]) {
      const s = await sessionOf(v.tid, parts[1]);
      if (!s) return json(404, [{ code: 404, description: "order not found" }]);
      const d = s.data();
      if (parts[2] === "status" && req.method === "GET") {
        return json(200, { status: YANDEX_STATUS[d.deliveryStatus] || "NEW", comment: "", updatedAt: new Date(now()).toISOString() });
      }
      if (!parts[2] && req.method === "GET") {
        return json(200, { eatsId: d.aggregatorOrderId, restaurantId: key, comment: d.deliveryComment || "",
          items: [], status: YANDEX_STATUS[d.deliveryStatus] || "NEW" });
      }
      if (!parts[2] && req.method === "DELETE") {
        const body = JSON.parse((await readBody(req, 65536)) || "{}");
        await cancel(v, s, "yandex", body.comment || body.reason || "");
        return json(200, { result: "OK" });
      }
      if (!parts[2] && req.method === "PUT") return json(200, { result: "OK" }); // правку состава кассир сверит сам
    }
    return json(404, [{ code: 404, description: "not found" }]);
  }

  // ------------------------------------------------ Купер

  async function kuper(req, res, key, rest) {
    const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    const v = await venueByKey("kuper", key);
    if (!v) return json(404, { error: "not found" });
    const auth = String(req.headers.authorization || req.headers["x-api-key"] || "").replace(/^Bearer\s+/i, "").trim();
    if (!auth || !safeEq(sha(auth), v.c.secretHash || "")) return json(401, { error: "unauthorized" });
    const parts = rest.split("/").filter(Boolean);
    if (req.method === "GET" && parts[0] === "menu") {
      const { categories, sellable } = await menuOf(v.tid);
      return json(200, yandexComposition(categories, sellable));
    }
    if (req.method === "GET" && parts[0] === "orders" && parts[1]) {
      const ext = await db().collection("tenants").doc(v.tid).collection("aggregatorOrders")
        .doc(`kuper_${crypto.createHash("sha1").update(parts[1]).digest("hex").slice(0, 24)}`).get();
      const s = ext.exists ? await sessionOf(v.tid, ext.data().sessionId) : null;
      if (!s) return json(404, { error: "order not found" });
      return json(200, { id: parts[1], status: s.data().deliveryStatus || "new" });
    }
    if (req.method === "POST") {
      const b = JSON.parse((await readBody(req, 262144)) || "{}");
      const o = b.order || b.data || b.payload || b;
      const event = String(b.event || b.event_type || b.type || o.status || "").toLowerCase();
      const ext = o.id ?? o.order_id ?? o.orderId ?? o.number ?? o.uuid;
      if (/cancel/.test(event)) {
        const extRef = await db().collection("tenants").doc(v.tid).collection("aggregatorOrders")
          .doc(`kuper_${crypto.createHash("sha1").update(String(ext || "")).digest("hex").slice(0, 24)}`).get();
        const s = extRef.exists ? await sessionOf(v.tid, extRef.data().sessionId) : null;
        if (s) await cancel(v, s, "kuper", o.cancel_reason || o.reason || "");
        return json(200, { ok: true });
      }
      try {
        const r = await createOrder(v, "kuper", {
          extId: ext, items: o.items || o.products || o.positions, comment: o.comment || o.customer_comment || "",
          total: o.total ?? o.total_price ?? o.items_total ?? 0,
        });
        return json(200, { ok: true, orderId: r.orderId, number: r.orderNo });
      } catch (e) {
        return json(e.status || 500, { error: e.status ? e.message : "internal error" });
      }
    }
    return json(404, { error: "not found" });
  }

  /** /agg/<yandex|kuper>/<ключ>/… */
  async function serve(req, res, sub) {
    const [kind, key, ...rest] = String(sub || "").split("/");
    if (kind === "yandex") return yandex(req, res, key || "", rest.join("/"));
    if (kind === "kuper") return kuper(req, res, key || "", rest.join("/"));
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    return res.end('{"error":"not found"}');
  }

  return { handleLink, serve, createOrder, _tokens: tokens };
}

module.exports = { createAggregators, yandexComposition, linesOf, YANDEX_STATUS };
