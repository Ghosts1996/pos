"use strict";
// Открытый API заведения.
//
// Владелец в кабинете создаёт ключ доступа (POST /apiKeys) и отдаёт его своей
// бухгалтерии, сайту, BI или интегратору. По ключу — только чтение данных
// своей точки: профиль, меню, стоп-лист, чеки, Z-отчёты, склад.
//
//   GET /api/v1/venue
//   GET /api/v1/menu
//   GET /api/v1/stoplist
//   GET /api/v1/sales?from=2026-11-01&to=2026-11-07[&cursor=…]
//   GET /api/v1/shifts?from=…&to=…
//   GET /api/v1/stock
//   Authorization: Bearer zp_<id>_<secret>
//
// Персональных данных гостей и сотрудников в ответах нет (имена, телефоны,
// адреса, пожелания к блюдам): интеграциям нужны цифры, а не люди, и так
// заведению не нужно ничего согласовывать по 152-ФЗ. Сотрудник — только id.
// Ключ хранится как SHA-256, показывается один раз; отозванный перестаёт
// работать в течение минуты (кеш ключей).

const crypto = require("crypto");

const MAX_KEYS = 5;
const PAGE = 500;
const MAX_RANGE_DAYS = 31;
const RATE_PER_MIN = 120;
const BAD_PER_MIN = 30;
const CACHE_MS = 60 * 1000;
const TOUCH_MS = 5 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const KEY_RE = /^zp_([A-Za-z0-9]{12})_([A-Za-z0-9]{32})$/;
const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_TZ = "Europe/Moscow";

/** Случайная строка из [ALPHABET] без перекоса: лишние байты отбрасываются. */
function randomToken(n) {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < n) {
    for (const b of crypto.randomBytes(n * 2)) {
      if (b < limit && out.length < n) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

const hashSecret = (secret) => crypto.createHash("sha256").update(secret).digest("hex");

function parseKey(raw) {
  const m = KEY_RE.exec(String(raw || "").trim());
  return m ? { id: m[1], secret: m[2] } : null;
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Ключ из заголовка: «Authorization: Bearer …» или «X-Api-Key: …». В адресе — нет: он остаётся в журналах. */
function keyFromRequest(req) {
  const h = req.headers || {};
  const auth = String(h.authorization || "");
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return String(h["x-api-key"] || "").trim();
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "object" && typeof v._seconds === "number") return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6);
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}
const iso = (v) => { const ms = toMs(v); return ms == null ? null : new Date(ms).toISOString(); };

/** Смещение часового пояса [tz] в минутах в момент [ms] (Москва → +180). */
function tzOffsetMin(tz, ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Полночь даты «YYYY-MM-DD» в поясе заведения, в мс UTC; NaN — такой даты нет. */
function midnightIn(tz, ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  if (new Date(guess).toISOString().slice(0, 10) !== ymd) return NaN; // 2026-02-30 и т. п.
  let ms = guess - tzOffsetMin(tz, guess) * 60000;
  ms = guess - tzOffsetMin(tz, ms) * 60000; // переход на летнее время
  return ms;
}

/** Следующий календарный день после «YYYY-MM-DD». */
function nextDay(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Период запроса: from и to — дата «YYYY-MM-DD» (to включительно, сутки по
 * часовому поясу заведения) или время ISO 8601 с поясом (to не включается).
 */
function parseRange(query, tz, HttpError, now) {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
  const one = (v, end) => {
    if (DATE.test(v)) {
      const ms = midnightIn(tz, v);
      if (Number.isNaN(ms)) return null;
      return end ? midnightIn(tz, nextDay(v)) : ms;
    }
    if (ISO.test(v)) { const ms = Date.parse(v); return Number.isNaN(ms) ? null : ms; }
    return null;
  };
  const fromRaw = String(query.get("from") || "");
  const toRaw = String(query.get("to") || "");
  if (!fromRaw) throw new HttpError(400, "Укажите from — дату (2026-11-01) или время ISO 8601");
  const from = one(fromRaw, false);
  const to = toRaw ? one(toRaw, true) : now();
  if (from == null) throw new HttpError(400, "from: ожидается дата 2026-11-01 или время 2026-11-01T06:00:00+03:00");
  if (to == null) throw new HttpError(400, "to: ожидается дата 2026-11-07 или время 2026-11-07T06:00:00+03:00");
  if (to <= from) throw new HttpError(400, "to должно быть позже from");
  if (to - from > MAX_RANGE_DAYS * DAY_MS + 3600 * 1000) throw new HttpError(400, `Период — не больше ${MAX_RANGE_DAYS} дней за запрос`);
  return { from, to };
}

const encodeCursor = (t, id) => Buffer.from(JSON.stringify({ t, id })).toString("base64url");
function decodeCursor(raw, HttpError) {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    if (typeof c.t === "number" && typeof c.id === "string" && c.id.length <= 200) return c;
  } catch (_) { /* ниже — ошибка */ }
  throw new HttpError(400, "cursor: возьмите значение next из прошлого ответа");
}

// ------------------------------------------------------------- ответы без ПДн

function checkOut(id, d) {
  const items = (Array.isArray(d.orderItems) ? d.orderItems : []).map((i) => ({
    menuItemId: i.menuItemId || null,
    name: String(i.name || ""),
    qty: num(i.qty),
    price: round2(i.price),
    total: round2(num(i.price) * num(i.qty)),
    ...(Array.isArray(i.mods) && i.mods.length ? { mods: i.mods.map(String) } : {}),
  }));
  const subtotal = round2(items.reduce((s, i) => s + i.total, 0));
  const payments = {
    cash: round2(d.paymentCash), card: round2(d.paymentCard), terminal: round2(d.paymentTerminal),
    aggregator: round2(d.paymentAggregator), comp: round2(d.paymentComp),
  };
  return {
    id,
    openedAt: iso(d.startTime),
    closedAt: iso(d.closedAt),
    table: d.tableName ? String(d.tableName) : null,
    guests: num(d.guests) || null,
    orderType: d.orderType ? String(d.orderType) : "hall",
    source: d.source ? String(d.source) : null,
    employeeId: d.employeeId ? String(d.employeeId) : null,
    items,
    subtotal,
    discountPercent: num(d.discountPercent),
    paid: round2(payments.cash + payments.card + payments.terminal + payments.aggregator + payments.comp),
    payments,
    ...(d.aggregator ? { aggregator: String(d.aggregator), aggregatorCommission: num(d.aggregatorCommission) } : {}),
    tips: { cash: round2(d.tipsCash), card: round2(d.tipsCard) },
    withoutPayment: d.closedWithoutPayment === true,
    fiscal: d.fiscalReceiptPrinted === true,
    refunded: d.refunded === true,
    refundedAt: iso(d.refundedAt),
  };
}

const Z_FIELDS = ["number", "salesCount", "salesTotal", "salesCash", "salesCard", "salesTerminal", "salesAggregator",
  "salesComp", "discounts", "refundsCount", "refundsTotal", "refundsCash", "refundsCashless", "unpaidCount",
  "unpaidTotal", "tipsCash", "tipsCard", "openingCash", "deposits", "payouts", "collections", "expectedCash",
  "countedCash", "leftCash"];

function shiftOut(id, d) {
  const z = d.z && typeof d.z === "object" ? d.z : null;
  const out = { id, status: d.status || null, openedAt: iso(d.openedAt), closedAt: iso(d.closedAt), z: null };
  if (z) {
    out.z = {};
    for (const k of Z_FIELDS) if (z[k] != null) out.z[k] = k === "number" || k.endsWith("Count") ? num(z[k]) : round2(z[k]);
  }
  return out;
}

function menuItemOut(id, d) {
  return {
    id,
    categoryId: d.categoryId || null,
    name: String(d.name || ""),
    price: round2(d.price),
    available: d.available !== false,
    description: d.description ? String(d.description) : "",
    weight: num(d.weight) || null,
    weightUnit: d.weightUnit || null,
    imageUrl: d.imageUrl || null,
    vat: d.vat || null,
  };
}

function stockOut(id, d) {
  return {
    id,
    name: String(d.name || ""),
    category: d.category ? String(d.category) : "",
    unit: d.unit || null,
    quantity: round2(d.quantity),
    minQuantity: round2(d.minQuantity),
    costPrice: round2(d.costPrice),
    active: d.active !== false,
  };
}

// ---------------------------------------------------------------- модуль

function createOpenApi(deps) {
  const {
    db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole,
    writeAuditLog = async () => {}, clientIp = () => "", now = () => Date.now(),
  } = deps;
  const Timestamp = admin.firestore.Timestamp;
  const keysCol = () => db().collection("apiKeys");

  const keyCache = new Map(); // id → { at, data }
  const tenantCache = new Map(); // tenantId → { at, data }
  const hits = new Map(); // key:<id> | bad:<ip> → { count, resetAt }
  const touched = new Map(); // id → когда записали lastUsedAt

  function hit(name, max) {
    const t = now();
    const e = hits.get(name);
    if (!e || e.resetAt <= t) {
      hits.set(name, { count: 1, resetAt: t + 60 * 1000 });
      if (hits.size > 20000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      return true;
    }
    e.count += 1;
    return e.count <= max;
  }
  const overLimit = (name, max) => { const e = hits.get(name); return !!e && e.resetAt > now() && e.count >= max; };

  async function cached(map, id, load) {
    const c = map.get(id);
    if (c && c.at + CACHE_MS > now()) return c.data;
    const data = await load();
    if (map.size > 5000) map.clear();
    map.set(id, { at: now(), data });
    return data;
  }

  async function keyRecord(raw) {
    const k = parseKey(raw);
    if (!k) return null;
    const d = await cached(keyCache, k.id, async () => {
      const snap = await keysCol().doc(k.id).get();
      return snap.exists ? snap.data() : null;
    });
    if (!d || d.status !== "active" || !d.tenantId) return null;
    return safeEqualHex(hashSecret(k.secret), d.hash) ? { id: k.id, ...d } : null;
  }

  // --------------------------------------------------- ключи (кабинет, владелец)

  function keyOut(id, d) {
    return {
      id, name: d.name || "", preview: `zp_${id}_…`, status: d.status || "active",
      createdAt: iso(d.createdAt), lastUsedAt: iso(d.lastUsedAt), revokedAt: iso(d.revokedAt),
    };
  }

  async function handleKeys(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const tenantId = String(body.tenantId || "").trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)) throw new HttpError(400, "tenantId обязателен");
    await requireTenantRole(tenantId, decoded.uid, ["owner"]);
    const action = String(body.action || "list");

    if (action === "list") {
      const snap = await keysCol().where("tenantId", "==", tenantId).get();
      const keys = snap.docs.map((d) => keyOut(d.id, d.data()))
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      return sendJson(res, 200, { ok: true, keys });
    }

    if (action === "create") {
      const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!name) throw new HttpError(400, "Назовите ключ: для чего он — «Бухгалтерия», «Сайт доставки»");
      if (!hit(`create:${tenantId}`, 10)) throw new HttpError(429, "Слишком много ключей подряд — попробуйте через минуту");
      const snap = await keysCol().where("tenantId", "==", tenantId).get();
      const active = snap.docs.filter((d) => d.data().status === "active").length;
      if (active >= MAX_KEYS) throw new HttpError(409, `Активных ключей не больше ${MAX_KEYS} — отзовите ненужный`);
      const id = randomToken(12);
      const secret = randomToken(32);
      await keysCol().doc(id).set({
        tenantId, name, hash: hashSecret(secret), status: "active", scopes: ["read"],
        createdAt: Timestamp.fromMillis(now()), createdBy: decoded.uid,
      });
      await writeAuditLog({ tenantId, actorId: decoded.uid, action: "apiKeyCreated", metadata: { keyId: id, name } });
      return sendJson(res, 200, { ok: true, key: `zp_${id}_${secret}`, info: keyOut(id, { name, status: "active", createdAt: now() }) });
    }

    if (action === "revoke") {
      const id = String(body.keyId || "");
      if (!/^[A-Za-z0-9]{12}$/.test(id)) throw new HttpError(400, "keyId обязателен");
      const ref = keysCol().doc(id);
      const snap = await ref.get();
      if (!snap.exists || snap.data().tenantId !== tenantId) throw new HttpError(404, "Ключ не найден");
      if (snap.data().status !== "revoked") {
        await ref.set({ status: "revoked", revokedAt: Timestamp.fromMillis(now()), revokedBy: decoded.uid }, { merge: true });
        await writeAuditLog({ tenantId, actorId: decoded.uid, action: "apiKeyRevoked", metadata: { keyId: id } });
      }
      keyCache.delete(id);
      return sendJson(res, 200, { ok: true });
    }

    throw new HttpError(400, "action: list, create или revoke");
  }

  // --------------------------------------------------------------- сам API

  async function venueTz(tenantId) {
    const s = await db().doc(`tenants/${tenantId}/settings/general`).get();
    const tz = s.exists ? String(s.data().timezone || "") : "";
    try { if (tz) { new Intl.DateTimeFormat("ru", { timeZone: tz }); return tz; } } catch (_) { /* неизвестный пояс */ }
    return DEFAULT_TZ;
  }

  /** Страница документов коллекции за период по полю [field], по возрастанию (время, id). */
  async function pageByTime(colPath, field, range, cursor, map) {
    const startMs = cursor ? Math.max(range.from, cursor.t) : range.from;
    const after = (t, id) => !cursor || t > cursor.t || (t === cursor.t && id > cursor.id);
    for (let limit = PAGE + 1; ; limit *= 4) {
      const snap = await db().collection(colPath)
        .where(field, ">=", Timestamp.fromMillis(startMs))
        .where(field, "<", Timestamp.fromMillis(range.to))
        .orderBy(field)
        .limit(limit)
        .get();
      const truncated = snap.docs.length >= limit;
      let rows = snap.docs
        .map((d) => ({ id: d.id, t: toMs(d.data()[field]), d: d.data() }))
        .filter((r) => r.t != null && after(r.t, r.id))
        .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (truncated && rows.length) {
        // Последняя группа с одинаковым временем могла попасть не целиком —
        // её отдадим на следующей странице, чтобы ничего не потерять.
        const lastT = toMs(snap.docs[snap.docs.length - 1].data()[field]);
        const complete = rows.filter((r) => r.t < lastT);
        if (!complete.length && limit < 20000) continue;
        if (complete.length) rows = complete;
      }
      const page = rows.slice(0, PAGE);
      const more = rows.length > PAGE || truncated;
      const last = page[page.length - 1];
      return { data: page.map((r) => map(r.id, r.d)), next: more && last ? encodeCursor(last.t, last.id) : null };
    }
  }

  const ENDPOINTS = {
    async venue(tid, tenant) {
      const profile = await db().doc(`tenants/${tid}/meta/venueProfile`).get();
      const p = profile.exists ? profile.data() : {};
      return {
        data: {
          id: tid, name: tenant.name || p.name || "", slug: tenant.slug || null,
          chainId: tenant.chainId || null, timezone: await venueTz(tid), currency: "RUB",
          type: p.venueType || null,
        },
      };
    },
    async menu(tid) {
      const [cats, items] = await Promise.all([
        db().collection(`tenants/${tid}/menuCategories`).get(),
        db().collection(`tenants/${tid}/menuItems`).get(),
      ]);
      const categories = cats.docs.map((d) => ({ id: d.id, name: String(d.data().name || ""), order: num(d.data().order), kind: d.data().kind || null }))
        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "ru"));
      return { data: { categories, items: items.docs.map((d) => menuItemOut(d.id, d.data())) } };
    },
    async stoplist(tid) {
      const items = await db().collection(`tenants/${tid}/menuItems`).get();
      return { data: items.docs.filter((d) => d.data().available === false).map((d) => ({ id: d.id, name: String(d.data().name || "") })) };
    },
    async stock(tid) {
      const items = await db().collection(`tenants/${tid}/inventoryItems`).get();
      return { data: items.docs.map((d) => stockOut(d.id, d.data())) };
    },
    async sales(tid, tenant, query) {
      const range = parseRange(query, await venueTz(tid), HttpError, now);
      const cursor = decodeCursor(query.get("cursor"), HttpError);
      return pageByTime(`tenants/${tid}/sessions`, "closedAt", range, cursor, checkOut);
    },
    async shifts(tid, tenant, query) {
      const range = parseRange(query, await venueTz(tid), HttpError, now);
      const cursor = decodeCursor(query.get("cursor"), HttpError);
      return pageByTime(`tenants/${tid}/shifts`, "closedAt", range, cursor, shiftOut);
    },
  };

  async function handleApi(req, res, urlPath) {
    if (req.method !== "GET") throw new HttpError(405, "API только читает данные: метод GET");
    const ip = clientIp(req) || "?";
    if (overLimit(`bad:${ip}`, BAD_PER_MIN)) throw new HttpError(429, "Слишком много неверных ключей — подождите минуту");
    const raw = keyFromRequest(req);
    const key = raw ? await keyRecord(raw) : null;
    if (!key) {
      hit(`bad:${ip}`, BAD_PER_MIN);
      throw new HttpError(401, raw ? "Ключ не подходит или отозван" : "Нужен ключ: заголовок Authorization: Bearer zp_…");
    }
    if (!hit(`key:${key.id}`, RATE_PER_MIN)) throw new HttpError(429, `Не больше ${RATE_PER_MIN} запросов в минуту на ключ`);

    const tid = key.tenantId;
    const tenant = await cached(tenantCache, tid, async () => {
      const snap = await db().collection("tenants").doc(tid).get();
      return snap.exists ? snap.data() : null;
    });
    if (!tenant || tenant.status === "deleted" || tenant.status === "suspended") {
      throw new HttpError(403, "Заведение недоступно");
    }

    const name = urlPath.replace(/^\/api\/v1\/?/, "").replace(/\/+$/, "");
    const fn = Object.prototype.hasOwnProperty.call(ENDPOINTS, name) ? ENDPOINTS[name] : null;
    if (!fn) throw new HttpError(404, `Нет такого адреса. Есть: ${Object.keys(ENDPOINTS).map((n) => `/api/v1/${n}`).join(", ")}`);
    const query = new URL(req.url || "/", "http://x").searchParams;
    const out = await fn(tid, tenant, query);

    if ((touched.get(key.id) || 0) + TOUCH_MS < now()) {
      touched.set(key.id, now());
      keysCol().doc(key.id).set({ lastUsedAt: Timestamp.fromMillis(now()) }, { merge: true })
        .catch((e) => console.error("open-api lastUsedAt:", e.message || e));
    }
    return sendJson(res, 200, { ok: true, ...out });
  }

  return { handleKeys, handleApi, ENDPOINTS: Object.keys(ENDPOINTS), _cache: { keyCache, tenantCache, hits } };
}

module.exports = {
  createOpenApi, parseKey, hashSecret, randomToken, checkOut, shiftOut, parseRange, tzOffsetMin, midnightIn,
  encodeCursor, decodeCursor, MAX_KEYS, PAGE, RATE_PER_MIN,
};
