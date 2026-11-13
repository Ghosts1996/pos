"use strict";
/**
 * Курьеры и приложение курьера (docs/delivery.md, разделы 2, 6–8, 11).
 *
 * Кто такой курьер. Учётка couriers/{id} у «корня» — заведения (establishment):
 * одиночное заведение — root "t_<точка>", сеть — "c_<сеть>" (курьер сети ездит
 * на все точки или на выбранные — points). Курьера заводит заведение в
 * кабинете (имя, почта, телефон, транспорт) в пределах тарифа (maxCouriers);
 * курьер видит заказы только своего заведения.
 *
 * Вход — по почте и одноразовому 6-значному коду (courierCodes, 10 минут, не
 * чаще раза в минуту). Галочка согласия + код из письма = простая
 * электронная подпись (ст. 5 63-ФЗ): в учётке — когда, с какого адреса, на
 * какую почту и какую редакцию правил (POLICY_VERSION) курьер принял. Почта в
 * нескольких заведениях — курьер выбирает, в каком работать. Ключ входа —
 * на телефоне, на сервере только SHA-256; блокировка курьера гасит его сразу.
 * Коллекции couriers, courierSettings и courierCodes правилами базы закрыты:
 * читает и пишет только шлюз.
 *
 * Заказ. Статусы заказа (deliveryStatus) общие с кассой и ботом; у курьера
 * внутри — стадия courierStage: toVenue → onWay → arrived → done, или
 * failed → (arrived | returned). Каждое действие — транзакция по заказу:
 * сервер заново проверяет, чей заказ, какая стадия и какая точка. Действия
 * повторяемы: «Забрал» второй раз (повтор из очереди без связи) — не ошибка.
 *
 * Данные гостя. Свободные заказы — только улица; полный адрес, имя, телефон
 * и комментарий — курьеру своего заказа, пока заказ у него. В режиме РФ
 * (pii) контакты лежат в справочнике в РФ — читаем оттуда.
 *
 * Геолокация. Телефон курьера на смене шлёт точки (пачкой, если связи не
 * было). Последняя — в учётке (стирается в конце смены), в заказе в пути —
 * courierPos (видит гость; стирается при закрытии). В поездке — только
 * километры, без координат.
 */
const crypto = require("crypto");
const flow = require("./delivery-flow");
const pricing = require("./delivery-pricing");
const { sessionBill } = require("./guest-pay");

/** Редакция условий для курьеров (courier-web/rules.html): новая — согласие заново. */
const POLICY_VERSION = "2.0";
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;
const CODE_TRIES = 5;
const TICKET_TTL_MS = 10 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>,;]{1,64}@[^\s@<>,;]{1,190}\.[^\s@<>,;.]{2,24}$/;
const TRANSPORTS = { foot: "пешком", bike: "велосипед или самокат", car: "автомобиль" };
const DISPATCH = { pool: "Свободный пул", manual: "Ручное назначение" };
const normEmail = (v) => String(v == null ? "" : v).trim().toLowerCase();
const TOKEN_IDLE_MS = 30 * 24 * 3600 * 1000;
// Взял заказ и пропал со связи — заказ снова свободен.
const LOST_MS = 15 * 60 * 1000;
// Смена без связи и без заказов закрывается сама.
const SHIFT_AUTO_END_MS = 6 * 3600 * 1000;
const POS_FRESH_MS = 5 * 60 * 1000;
/** Дорога длиннее прямой линии — средний коэффициент для города. */
const ROAD_FACTOR = 1.3;
/** Точка гостя: широта/долгота в разумных пределах. */
const geoOf = (g) => (g && Number.isFinite(Number(g.lat)) && Number.isFinite(Number(g.lng))
  && Math.abs(Number(g.lat)) <= 90 && Math.abs(Number(g.lng)) <= 180 && !(Number(g.lat) === 0 && Number(g.lng) === 0)
  ? { lat: Math.round(Number(g.lat) * 1e6) / 1e6, lng: Math.round(Number(g.lng) * 1e6) / 1e6 } : null);
const MAX_ACTIVE = 8;
/** Демо: курьеров на одно демо и входов с одного адреса за час. */
const DEMO_MAX_COURIERS = 20;
const DEMO_LOGINS_PER_HOUR = 10;
const MAX_COURIERS = 300;
const DAY_START_HOUR = 6; // рабочие сутки 06:00–06:00, как в отчётах бота
const OPEN_ORDER_MAX_AGE_MS = 24 * 3600 * 1000;
const MANAGE_ROLES = ["owner", "admin", "manager"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const FAIL_REASONS = {
  no_answer: "не открывают и не отвечают",
  wrong_address: "неверный адрес",
  refused: "гость отказался от заказа",
  other: "другая причина",
};
const STAGE_LABEL = {
  toVenue: "едет в заведение",
  onWay: "в пути",
  arrived: "у двери",
  failed: "не удалось вручить",
  done: "вручил",
};
const METHOD_LABEL = { cash: "наличными", card: "картой", qr: "по QR", prepaid: "оплачено заранее" };
const ACTIVE_STAGES = ["toVenue", "onWay", "arrived", "failed"];

const round2 = (v) => Math.round(v * 100) / 100;
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const ms = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : typeof v === "number" ? v : v instanceof Date ? v.getTime() : 0);
const rubText = (n) => pricing.fmtRub(n);

/** Российский номер → 7XXXXXXXXXX; иначе "". */
function normalizePhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  let n = d;
  if (d.length === 11 && (d[0] === "8" || d[0] === "7")) n = `7${d.slice(1)}`;
  else if (d.length === 10 && /^9/.test(d)) n = `7${d}`;
  return /^7\d{10}$/.test(n) ? n : "";
}

/** Расстояние между точками, м (гаверсинус). */
function distanceM(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Пройденный путь по точкам телефона: отбрасываем неточные (> 50 м), дрожь
 * на месте (< 15 м) и прыжки быстрее 160 км/ч. → { meters, last }.
 */
function odometerStep(last, points) {
  let meters = 0;
  let cur = last && Number.isFinite(last.lat) ? last : null;
  for (const p of points) {
    if (!(p.acc <= 50)) continue;
    if (!cur) { cur = p; continue; }
    if (p.at <= cur.at) continue;
    const d = distanceM(cur, p);
    if (d < 15) continue;
    const speed = d / ((p.at - cur.at) / 1000);
    if (speed > 45) continue;
    meters += d;
    cur = p;
  }
  return { meters: Math.round(meters), last: cur };
}

/** Улица и дом без квартиры, подъезда, этажа и домофона — для свободных заказов. */
function streetOf(address) {
  const a = String(address || "");
  // Квартира, подъезд, этаж, домофон — только после «Беру».
  return a.split(/,\s*(?=кв\.\/офис|кв\.?\s|квартира|офис|оф\.|подъезд|под\.|этаж|эт\.|домофон|код\s)/i)[0].trim().slice(0, 160);
}

/** Начало рабочих суток (06:00 по поясу точки), мс. */
function dayStartMs(atMs, tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(atMs)).map((x) => [x.type, x.value]));
  let day = `${p.year}-${p.month}-${p.day}`;
  if (+p.hour < DAY_START_HOUR) {
    const prev = new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - 86400000);
    day = prev.toISOString().slice(0, 10);
  }
  return { day, start: zonedMs(day, DAY_START_HOUR, tz) };
}

/** Местные «день + час» в поясе → мс UTC. */
function zonedMs(day, hour, tz) {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz || "Europe/Moscow", hour: "2-digit", minute: "2-digit", hourCycle: "h23", day: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  let offsetH = +p.hour - hour;
  if (+p.day !== d) offsetH += +p.day > d || (d > 25 && +p.day < 5) ? 24 : -24;
  return guess - offsetH * 3600000 - (+p.minute || 0) * 60000;
}

function createCourier({
  db, admin, verifyAuth, parseJsonBody, sendJson, HttpError,
  requireTenantRole, requireChainRole, pii = null, publicUrl = "",
  authFailed = () => {}, guestPay = null, now = () => Date.now(),
  // Почта платформы (auth-email.createMailer) и лимит курьеров тарифа: -1 — без ограничений.
  getMailer = () => null, courierLimit = async () => -1, appUrl = "",
}) {
  const letters = require("./auth-email");
  const Timestamp = admin.firestore.Timestamp;
  const FieldValue = admin.firestore.FieldValue;
  const del = () => FieldValue.delete();
  const ts = (at = now()) => Timestamp.fromMillis(at);
  const tenantRef = (t) => db().collection("tenants").doc(t);
  const couriersCol = () => db().collection("couriers");
  const settingsRef = (root) => db().collection("courierSettings").doc(root);
  const codesCol = () => db().collection("courierCodes");
  // Telegram и подобное — подключаются после создания (setHooks).
  let hooks = { event: async () => {}, moved: async () => {} };

  // ------------------------------------------------------------ кэши

  const cache = new Map();
  async function cached(key, ttlMs, load) {
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.value;
    const value = await load();
    cache.set(key, { value, until: now() + ttlMs });
    if (cache.size > 5000) for (const [k, v] of cache) if (v.until <= now()) cache.delete(k);
    return value;
  }
  const forget = (prefix) => { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); };

  const rfMode = (t) => cached(`rf:${t}`, 60000, async () => !!pii && (await pii.mode(t).catch(() => "mirror")) === "rf");

  /** Корень учёток для точки: сеть или само заведение. */
  const rootOf = (tenantId) => cached(`root:${tenantId}`, 60000, async () => {
    const tenant = (await tenantRef(tenantId).get()).data();
    if (!tenant || tenant.status === "deleted") throw new HttpError(404, "Заведение не найдено");
    return { root: tenant.chainId ? `c_${tenant.chainId}` : `t_${tenantId}`, chainId: tenant.chainId || "", tenant };
  });

  /** Точки корня: id, название, адрес, пояс. */
  const pointsOf = (root) => cached(`points:${root}`, 60000, async () => {
    let docs;
    if (root.startsWith("c_")) {
      docs = (await db().collection("tenants").where("chainId", "==", root.slice(2)).get()).docs
        .filter((d) => (d.data() || {}).status !== "deleted")
        .sort((a, b) => ms(a.data().createdAt) - ms(b.data().createdAt));
    } else {
      const d = await tenantRef(root.slice(2)).get();
      docs = d.exists ? [d] : [];
    }
    return Promise.all(docs.map(async (d) => {
      const [venue, settings, integ] = await Promise.all([
        tenantRef(d.id).collection("meta").doc("venueProfile").get(),
        tenantRef(d.id).collection("settings").doc("delivery").get(),
        tenantRef(d.id).collection("settings").doc("integrations").get(),
      ]);
      const v = venue.data() || {};
      const s = settings.data() || {};
      const pay = pricing.normalizeSettings(s).payAtDoor;
      // QR у двери — только через подтверждённый банк заведения (демо платит без банка).
      const bank = !!(integ.data() || {}).onlinePayVerified || (d.data() || {}).demo === true;
      return {
        id: d.id,
        name: String(d.data().name || v.name || "Заведение"),
        address: String(v.address || ""),
        tz: String(d.data().timezone || "Europe/Moscow"),
        venuePos: s.venuePos && Number.isFinite(s.venuePos.lat) ? { lat: s.venuePos.lat, lng: s.venuePos.lng } : null,
        payAtDoor: { ...pay, qr: pay.qr && bank },
      };
    }));
  });

  /** Точки, где работает курьер. */
  async function scopeOf(courier) {
    const all = await pointsOf(courier.root);
    const only = Array.isArray(courier.points) ? courier.points : [];
    return only.length ? all.filter((p) => only.includes(p.id)) : all;
  }

  const rates = (root) => cached(`rates:${root}`, 30000, async () => {
    const s = (await settingsRef(root).get()).data() || {};
    return {
      ratePerTrip: Math.max(0, Number(s.ratePerTrip) || 0), ratePerKm: Math.max(0, Number(s.ratePerKm) || 0),
      // Раздача заказов: «pool» — все курьеры на смене видят и берут сами, «manual» — назначает касса.
      dispatch: s.dispatch === "manual" ? "manual" : "pool",
    };
  });

  /** Название заведения (или сети) — в шапке приложения курьера и в письмах. */
  const rootTitle = (root) => cached(`title:${root}`, 300000, async () => {
    if (root.startsWith("c_")) {
      const ch = (await db().collection("chains").doc(root.slice(2)).get()).data() || {};
      if (ch.name) return String(ch.name);
    }
    const pts = await pointsOf(root).catch(() => []);
    return String((pts[0] && pts[0].name) || "Заведение");
  });

  const excludeTobaccoOf = (t) => cached(`loy:${t}`, 60000, async () => {
    const l = (await tenantRef(t).collection("settings").doc("loyalty").get()).data() || {};
    return typeof l.excludeTobaccoFromPromo === "boolean" ? l.excludeTobaccoFromPromo : true;
  });

  /** Открытые заказы доставки точки (за сутки). */
  const openDeliveries = (t) => cached(`open:${t}`, 2000, async () => {
    const col = tenantRef(t).collection("sessions");
    const [a, b] = await Promise.all([col.where("status", "==", "active").get(), col.where("deliveryOpen", "==", true).get()]);
    const byId = new Map();
    for (const d of [...a.docs, ...b.docs]) {
      const s = d.data() || {};
      if (s.orderType !== "delivery") continue;
      if (now() - ms(s.startTime) > OPEN_ORDER_MAX_AGE_MS) continue;
      byId.set(d.id, { id: d.id, ...s });
    }
    return [...byId.values()];
  });

  /** Контакты гостя заказов: адрес, телефон, имя, комментарий. */
  async function contactsOf(t, sessions) {
    const out = new Map();
    const need = [];
    for (const s of sessions) {
      const hit = cache.get(`pd:${t}:${s.id}`);
      if (hit && hit.until > now()) out.set(s.id, hit.value);
      else need.push(s);
    }
    if (!need.length) return out;
    const rf = await rfMode(t);
    let recs = new Map();
    if (rf) recs = await pii.lookup(t, need.map((s) => ({ k: "delivery", id: s.id }))).catch(() => new Map());
    for (const s of need) {
      const r = recs.get(`delivery:${s.id}`) || {};
      const extra = r.extra && typeof r.extra === "object" ? r.extra : {};
      const v = {
        address: String(r.address || s.deliveryAddress || ""),
        phone: String(r.phone || s.customerPhone || extra.guestContact || s.guestContact || ""),
        name: String(r.name || s.customerName || s.guestTag || ""),
        comment: String(extra.comment || r.comment || s.deliveryComment || ""),
        geo: geoOf(extra.geo) || geoOf(s.deliveryGeo),
      };
      cache.set(`pd:${t}:${s.id}`, { value: v, until: now() + 60000 });
      out.set(s.id, v);
    }
    return out;
  }

  // ------------------------------------------------------------ заказ глазами курьера

  const isFree = (s) => {
    if (s.courierId) return false;
    const st = flow.normalize("delivery", s.deliveryStatus);
    if (st === "courier") return s.courierStage === "returned";
    return (st === "accepted" || st === "cooking") && s.courierSet !== true;
  };

  /** Деньги заказа: сумма, оплачено, сколько получить при вручении. */
  async function moneyOf(t, s) {
    const fee = s.delivery && Number(s.delivery.fee) > 0 ? Number(s.delivery.fee) : 0;
    const dishes = (s.orderItems || []).filter((i) => !pricing.isFeeLine(i));
    let total;
    if (dishes.length) {
      total = sessionBill(s, await excludeTobaccoOf(t));
      if (s.deliveryFeePending === true && !(s.orderItems || []).some(pricing.isFeeLine)) total += fee;
    } else {
      total = Number(s.appTotal) || 0;
    }
    total = round2(total);
    const paid = round2(Number(s.guestPaidTotal) || 0);
    // Чек закрыт на кассе раньше доставки — гость рассчитался в заведении.
    const settled = s.status === "closed";
    const toCollect = settled ? 0 : Math.max(0, round2(total - paid));
    return { total, paid, fee, toCollect, settled };
  }

  const ageMin = (s) => Math.max(0, Math.round((now() - ms(s.startTime)) / 60000));
  const dishesReady = (s) => {
    const d = (s.orderItems || []).filter((i) => !pricing.isFeeLine(i));
    return d.length > 0 && d.every((i) => (Number(i.ready) || 0) >= (Number(i.qty) || 0));
  };

  /**
   * Путь заведение → гость, метров: по дорогам своей карты (hooks.route,
   * ответ запоминается), а где карты нет — по прямой с поправкой.
   */
  const roadCache = new Map();
  async function roadM(a, b) {
    if (!a || !b) return null;
    const straight = Math.round(distanceM(a, b) * ROAD_FACTOR);
    if (!hooks.route) return straight;
    const key = `${Number(a.lat).toFixed(4)},${Number(a.lng).toFixed(4)}>${Number(b.lat).toFixed(4)},${Number(b.lng).toFixed(4)}`;
    const hit = roadCache.get(key);
    if (hit && now() - hit.at < 6 * 3600 * 1000) return hit.m;
    let m = straight;
    try {
      const r = await hooks.route({ points: [{ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }], mode: "auto" });
      if (r && r.ok && Number.isFinite(r.m)) m = Math.round(r.m);
      else if (r && (r.reason === "busy" || r.reason === "timeout")) return straight; // не запоминаем
    } catch (_) { return straight; }
    if (roadCache.size > 3000) roadCache.clear();
    roadCache.set(key, { m, at: now() });
    return m;
  }

  /** Оценка пути заведение → гость по дороге (м) и заработка курьера. */
  async function estimateOf(point, dest, r) {
    const tripM = point.venuePos && dest ? await roadM(point.venuePos, dest) : null;
    const paid = r.ratePerTrip + r.ratePerKm > 0;
    const payout = !paid ? null : Math.round(r.ratePerTrip + (r.ratePerKm * (tripM || 0)) / 1000);
    return { tripM, payout, payoutExact: !r.ratePerKm || tripM != null };
  }

  async function freeDto(point, s, contact, courier) {
    const m = await moneyOf(point.id, s);
    const pos = courier.pos && now() - ms(courier.pos.at) < POS_FRESH_MS ? courier.pos : null;
    const dest = contact.geo || null;
    const est = await estimateOf(point, dest, await rates(courier.root));
    return {
      key: `${point.id}__${s.id}`,
      t: point.id,
      s: s.id,
      no: String(s.orderNo || s.id.slice(-4)),
      point: { id: point.id, name: point.name, address: point.address, pos: point.venuePos || null },
      street: streetOf(contact.address),
      dest,
      tripM: est.tripM,
      payout: est.payout,
      payoutExact: est.payoutExact,
      promisedAt: s.delivery && s.delivery.etaMin ? ms(s.startTime) + s.delivery.etaMin * 60000 : null,
      zone: (s.delivery && s.delivery.zoneName) || "",
      etaMin: (s.delivery && s.delivery.etaMin) || 0,
      ageMin: ageMin(s),
      status: flow.label("delivery", s.deliveryStatus),
      ready: dishesReady(s),
      returned: s.courierStage === "returned",
      items: (s.orderItems || []).filter((i) => !pricing.isFeeLine(i)).reduce((a, i) => a + (Number(i.qty) || 0), 0),
      total: m.total,
      toCollect: m.toCollect,
      fee: m.fee,
      toPointM: pos && point.venuePos ? Math.round(distanceM(pos, point.venuePos)) : null,
    };
  }

  async function mineDto(point, s, contact, courier) {
    const base = await freeDto(point, s, contact, courier);
    const cancelled = flow.normalize("delivery", s.deliveryStatus) === "cancelled";
    return {
      ...base,
      stage: s.courierStage || "toVenue",
      stageAt: ms(s.courierStageAt),
      cancelled,
      address: contact.address,
      phone: contact.phone,
      guestName: contact.name,
      comment: contact.comment,
      lines: (s.orderItems || []).filter((i) => !pricing.isFeeLine(i)).map((i) => ({
        name: String(i.name || ""), qty: Number(i.qty) || 0, mods: Array.isArray(i.mods) ? i.mods.map(String) : [],
      })),
      fail: s.courierFail ? { reason: s.courierFail.reason, label: FAIL_REASONS[s.courierFail.reason] || "", note: s.courierFail.note || "" } : null,
      payAtDoor: point.payAtDoor,
      payment: s.courierPayment || null,
      receipt: receiptOf(s),
    };
  }

  /**
   * Чек заказа, пробитый кассой автоматически (fiscalAuto): курьер видит
   * «Чек пробит» и может показать гостю ссылку на электронный чек.
   */
  function receiptOf(s) {
    const a = s.fiscalAuto || {};
    const pick = (x, kind) => (x && x.ok === true ? { kind, queued: x.queued === true, url: /^https:\/\//.test(String(x.url || "")) ? String(x.url) : "" } : null);
    return pick(a.full, "full") || pick(a.prepay, "prepay");
  }

  // ------------------------------------------------------------ вход курьера

  async function courierByToken(req) {
    const auth = String(req.headers && req.headers.authorization || "");
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(auth);
    if (!m) throw new HttpError(401, "Войдите по почте: код придёт в письме");
    const h = sha(m[1]);
    const id = await cached(`tok:${h}`, 30000, async () => {
      const snap = await couriersCol().where("tokenHash", "==", h).limit(1).get();
      return snap.docs.length ? snap.docs[0].id : "";
    });
    const doc = id ? await couriersCol().doc(id).get() : null;
    const c = doc && doc.exists ? doc.data() : null;
    if (!c || c.tokenHash !== h) {
      authFailed(req);
      forget(`tok:${h}`);
      throw new HttpError(401, "Вход устарел — войдите заново по почте");
    }
    if (c.enabled === false) throw Object.assign(new HttpError(403, "Доступ закрыт администратором заведения"), { code: "COURIER_BLOCKED" });
    if (now() - Math.max(ms(c.lastSeenAt), ms(c.tokenAt)) > TOKEN_IDLE_MS) {
      throw new HttpError(401, "Вы долго не заходили — войдите заново по почте");
    }
    return { id, ...c };
  }

  // ------------------------------------------------------------ вход по почте

  const ipOf = (req) => String((req.headers && req.headers["x-real-ip"]) || (req.socket && req.socket.remoteAddress) || "").slice(0, 64);
  const codeRef = (email) => codesCol().doc(sha(`courier:${email}`).slice(0, 40));
  /** Частота: не больше n раз за окно с одного адреса (поверх щита). */
  function limiter(max, windowMs, message) {
    const hits = new Map();
    return (key) => {
      const hit = hits.get(key);
      if (hit && hit.until > now()) {
        if (hit.n >= max) throw Object.assign(new HttpError(429, message), { code: "TOO_MANY" });
        hit.n += 1;
      } else {
        hits.set(key, { n: 1, until: now() + windowMs });
      }
      if (hits.size > 5000) for (const [k, v] of hits) if (v.until <= now()) hits.delete(k);
    };
  }
  const codeLimit = limiter(10, 3600 * 1000, "Слишком много запросов кода с этого устройства — попробуйте через час");

  /** Активные учётки курьера с этой почтой во всех заведениях. */
  async function couriersByEmail(email) {
    const snap = await couriersCol().where("email", "==", email).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((c) => c.enabled !== false && !c.forgottenAt && !c.demo && c.root);
  }

  /** Шаг 1: галочка согласия + почта → код на почту. */
  async function handleRequestCode(req, res) {
    const body = await parseJsonBody(req);
    if (body.consent_accepted !== true) {
      throw Object.assign(new HttpError(400, "Примите условия и согласие на обработку данных — без этого код не отправляется"), { code: "CONSENT_REQUIRED" });
    }
    const email = normEmail(body.email);
    if (!EMAIL_RE.test(email)) throw Object.assign(new HttpError(400, "Проверьте адрес почты"), { code: "BAD_EMAIL" });
    const list = await couriersByEmail(email);
    if (!list.length) {
      authFailed(req);
      throw Object.assign(new HttpError(404, "Аккаунт не найден. Обратитесь к администратору вашего заведения"), { code: "COURIER_NOT_FOUND" });
    }
    const ref = codeRef(email);
    const cur = (await ref.get()).data() || {};
    const wait = ms(cur.sentAt) + CODE_RESEND_MS - now();
    if (wait > 0) {
      throw Object.assign(new HttpError(429, `Код уже отправлен — новый можно запросить через ${Math.ceil(wait / 1000)} с`), { code: "CODE_TOO_OFTEN", retryIn: Math.ceil(wait / 1000) });
    }
    codeLimit(ipOf(req));
    const mailer = getMailer();
    if (!mailer) throw Object.assign(new HttpError(503, "Почта временно не работает — попробуйте позже"), { code: "MAIL_UNAVAILABLE" });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    await ref.set({
      emailHash: sha(email), codeHash: sha(`${email}:${code}`), exp: ts(now() + CODE_TTL_MS), sentAt: ts(), tries: 0,
      consentAskedAt: ts(), ticketHash: del(), ticketExp: del(),
    }, { merge: true });
    const letter = letters.courierCodeLetter({ code, venue: list.length === 1 ? await rootTitle(list[0].root) : "" });
    try {
      await mailer.send({ to: email, ...letter });
    } catch (e) {
      console.error(`courier code mail: ${e.message}`);
      await ref.update({ sentAt: del() }).catch(() => {});
      throw Object.assign(new HttpError(503, "Не удалось отправить письмо — попробуйте через минуту"), { code: "MAIL_FAILED" });
    }
    sendJson(res, 200, { ok: true, resendIn: CODE_RESEND_MS / 1000, ttl: CODE_TTL_MS / 1000 });
  }

  /** Ключ входа и доказательство согласия (ПЭП) — в учётку курьера. */
  async function signIn(req, c, email, device) {
    const token = crypto.randomBytes(32).toString("base64url");
    if (c.tokenHash) forget(`tok:${c.tokenHash}`);
    await couriersCol().doc(c.id).update({
      tokenHash: sha(token), tokenAt: ts(), lastSeenAt: ts(), device: clean(device, 80),
      consentAt: ts(), consentIp: ipOf(req), consentEmail: email, policyVersion: POLICY_VERSION, updatedAt: ts(),
    });
    return { token, courier: { no: c.no, name: c.name, venue: await rootTitle(c.root) } };
  }

  /** Шаг 2: код из письма → вход (или выбор заведения, если их несколько). */
  async function handleVerifyCode(req, res) {
    const body = await parseJsonBody(req);
    if (body.consent_accepted !== true) throw Object.assign(new HttpError(400, "Примите условия и согласие на обработку данных"), { code: "CONSENT_REQUIRED" });
    const email = normEmail(body.email);
    const code = String(body.code || "").replace(/\D/g, "");
    const ref = codeRef(email);
    const wrong = (text = "Код неверный — проверьте письмо или запросите новый") => {
      authFailed(req);
      return Object.assign(new HttpError(403, text), { code: "BAD_CODE" });
    };
    if (!EMAIL_RE.test(email) || code.length !== 6) throw wrong();
    let ok = false;
    let left = 0;
    await db().runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data();
      if (!cur || !cur.codeHash || ms(cur.exp) < now()) return;
      if ((Number(cur.tries) || 0) >= CODE_TRIES) return;
      if (cur.codeHash !== sha(`${email}:${code}`)) {
        left = CODE_TRIES - (Number(cur.tries) || 0) - 1;
        tx.update(ref, { tries: (Number(cur.tries) || 0) + 1 });
        return;
      }
      ok = true;
      tx.update(ref, { codeHash: del(), exp: del(), tries: 0 });
    });
    if (!ok) {
      if (left > 0) throw wrong(`Код неверный — осталось попыток: ${left}`);
      throw wrong("Код устарел или попытки закончились — запросите новый");
    }
    const list = await couriersByEmail(email);
    if (!list.length) throw Object.assign(new HttpError(403, "Доступ закрыт. Обратитесь к администратору вашего заведения"), { code: "COURIER_NOT_FOUND" });
    if (list.length === 1) return sendJson(res, 200, await signIn(req, list[0], email, body.device));
    // Почта в нескольких заведениях — курьер выбирает, где работать сейчас.
    const ticket = crypto.randomBytes(24).toString("base64url");
    await ref.update({ ticketHash: sha(ticket), ticketExp: ts(now() + TICKET_TTL_MS) });
    const venues = [];
    for (const c of list) venues.push({ id: c.id, name: await rootTitle(c.root), no: c.no });
    venues.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    sendJson(res, 200, { choose: true, ticket, venues });
  }

  /** Шаг 3 (если заведений несколько): выбор заведения → вход. */
  async function handleSelect(req, res) {
    const body = await parseJsonBody(req);
    const email = normEmail(body.email);
    const ticket = String(body.ticket || "");
    const cur = EMAIL_RE.test(email) ? (await codeRef(email).get()).data() : null;
    if (!cur || !cur.ticketHash || cur.ticketHash !== sha(ticket) || ms(cur.ticketExp) < now()) {
      authFailed(req);
      throw Object.assign(new HttpError(403, "Вход устарел — запросите код ещё раз"), { code: "TICKET_EXPIRED" });
    }
    const c = (await couriersByEmail(email)).find((x) => x.id === String(body.courierId || ""));
    if (!c) throw Object.assign(new HttpError(404, "Заведение не найдено — запросите код ещё раз"), { code: "COURIER_NOT_FOUND" });
    await codeRef(email).update({ ticketHash: del(), ticketExp: del() });
    sendJson(res, 200, await signIn(req, c, email, body.device));
  }

  /**
   * Демо: вход в приложение курьера по коду демо-сети — тому же, что касса
   * показывает для приложения гостя. Каждый вход — новый «Курьер №N · Демо»
   * на обе точки сети; демо стирается вместе с курьерами (purgeRoot).
   */
  const demoHits = new Map(); // адрес -> { n, until }
  async function handleDemoLogin(req, res) {
    const { code, device } = await parseJsonBody(req);
    const ip = String(req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "");
    const hit = demoHits.get(ip);
    if (hit && hit.until > now() && hit.n >= DEMO_LOGINS_PER_HOUR) {
      throw new HttpError(429, "Слишком много входов в демо — попробуйте через час");
    }
    const c = String(code || "").trim().toLowerCase();
    const bad = () => {
      authFailed(req);
      return new HttpError(404, "Демо с таким кодом не найдено — возможно, оно уже сбросилось. Код показан на экране входа демо-кассы");
    };
    if (!/^demo-[a-z0-9]{4,32}$/.test(c)) throw bad();
    const snap = await db().collection("tenants").where("demoCode", "==", c).limit(4).get();
    const t = snap.docs.find((d) => d.data().demo === true && d.data().status === "active");
    if (!t) throw bad();
    const td = t.data();
    if (ms(td.demoExpiresAt) && ms(td.demoExpiresAt) < now()) throw bad();
    const root = td.chainId ? `c_${td.chainId}` : `t_${t.id}`;
    const count = (await couriersCol().where("root", "==", root).get()).docs.length;
    if (count >= DEMO_MAX_COURIERS) throw new HttpError(409, "В этом демо уже много курьеров — откройте новое демо в кассе");
    if (!hit || hit.until <= now()) demoHits.set(ip, { n: 1, until: now() + 3600 * 1000 });
    else hit.n += 1;
    if (demoHits.size > 5000) for (const [k, v] of demoHits) if (v.until <= now()) demoHits.delete(k);
    let no = 0;
    await db().runTransaction(async (tx) => {
      const s = (await tx.get(settingsRef(root))).data() || {};
      no = (Math.trunc(Number(s.lastNo)) || 0) + 1;
      // В демо видно, сколько курьер зарабатывает: 120 ₽ за заказ + 18 ₽ за км.
      tx.set(settingsRef(root), { lastNo: no, ...(s.ratePerTrip === undefined ? { ratePerTrip: 140, ratePerKm: 20 } : {}) }, { merge: true });
    });
    forget(`rates:${root}`);
    const token = crypto.randomBytes(32).toString("base64url");
    const name = "Демо";
    await couriersCol().doc().set({
      root, no, name, phone: "", points: [], enabled: true, onShift: false, demo: true,
      cashOnHand: 0, odometerM: 0, createdAt: ts(), createdBy: "demo",
      tokenHash: sha(token), tokenAt: ts(), lastSeenAt: ts(), device: clean(device, 80),
    });
    sendJson(res, 200, { token, courier: { no, name } });
  }

  /** Стереть курьеров заведения или сети целиком (сброс демо). */
  async function purgeRoot(root) {
    const snap = await couriersCol().where("root", "==", root).get();
    for (const d of snap.docs) {
      for (const sub of ["trips", "shifts", "cash", "payouts"]) {
        const docs = (await d.ref.collection(sub).get()).docs;
        for (const x of docs) await x.ref.delete();
      }
      await d.ref.delete();
    }
    await settingsRef(root).delete().catch(() => {});
    cache.clear();
    return snap.docs.length;
  }

  async function handleLogout(req, res) {
    const c = await courierByToken(req);
    if (c.onShift && Object.keys(c.active || {}).length) throw new HttpError(409, "Сначала завершите заказы и смену");
    await couriersCol().doc(c.id).update({ tokenHash: del(), tokenAt: del(), ...(c.onShift ? await shiftEndPatch(c) : {}) });
    forget(`tok:${c.tokenHash}`);
    sendJson(res, 200, { ok: true });
  }

  /** Согласие в приложении: демо-курьер и новая редакция правил (вход по почте пишет его сам). */
  async function handleConsent(req, res) {
    const c = await courierByToken(req);
    const body = await parseJsonBody(req).catch(() => ({}));
    if (body.consent_accepted !== true) throw Object.assign(new HttpError(400, "Отметьте согласие"), { code: "CONSENT_REQUIRED" });
    await couriersCol().doc(c.id).update({
      consentAt: ts(), consentIp: ipOf(req), policyVersion: POLICY_VERSION, ...(c.email ? { consentEmail: c.email } : {}),
    });
    sendJson(res, 200, { ok: true });
  }
  const consentOk = (c) => !!c.consentAt && c.policyVersion === POLICY_VERSION;

  // ------------------------------------------------------------ смена

  async function shiftEndPatch(c) {
    const r = await rates(c.root);
    if (c.shiftId) {
      const trips = await couriersCol().doc(c.id).collection("trips").where("shiftId", "==", c.shiftId).get();
      const done = trips.docs.map((d) => d.data()).filter((x) => x.result === "done");
      await couriersCol().doc(c.id).collection("shifts").doc(c.shiftId).set({
        endAt: ts(),
        trips: done.length,
        distanceM: Math.max(0, (Number(c.odometerM) || 0) - (Number(c.shiftOdo) || 0)),
        earned: done.reduce((a, x) => a + (Number(x.earned) || 0), 0),
        cash: done.reduce((a, x) => a + (x.payment && x.payment.method === "cash" ? Number(x.payment.amount) || 0 : 0), 0),
        ratePerTrip: r.ratePerTrip,
        ratePerKm: r.ratePerKm,
      }, { merge: true });
    }
    // Геолокация вне смены не нужна — стираем.
    return { onShift: false, shiftId: del(), shiftStartedAt: del(), shiftOdo: del(), pos: del() };
  }

  async function handleShift(req, res) {
    const c = await courierByToken(req);
    const { on } = await parseJsonBody(req);
    if (on === true) {
      if (!consentOk(c)) throw new HttpError(409, "Сначала примите условия и согласие на передачу геолокации");
      if (!c.onShift) {
        const shift = couriersCol().doc(c.id).collection("shifts").doc();
        await shift.set({ startAt: ts(), root: c.root });
        await couriersCol().doc(c.id).update({ onShift: true, shiftId: shift.id, shiftStartedAt: ts(), shiftOdo: Number(c.odometerM) || 0, lastSeenAt: ts() });
      }
    } else if (c.onShift) {
      const busy = await activeOf(c);
      if (busy.length) throw new HttpError(409, `Сначала завершите заказы: ${busy.length}`);
      await couriersCol().doc(c.id).update(await shiftEndPatch(c));
    }
    sendJson(res, 200, { ok: true });
  }

  /** Заказы курьера в работе — по заказам, а не только по отметкам в учётке. */
  async function activeOf(c) {
    const out = [];
    const keys = Object.keys(c.active || {});
    for (const key of keys) {
      const [t, s] = key.split("__");
      const snap = await tenantRef(t).collection("sessions").doc(s).get();
      const x = snap.data();
      if (x && x.courierId === c.id && ACTIVE_STAGES.includes(x.courierStage)) out.push({ t, s, x });
    }
    return out;
  }

  // ------------------------------------------------------------ состояние для приложения

  async function stateOf(c) {
    const points = await scopeOf(c);
    // Ручное назначение: свободные заказы курьеру не показываем — их назначает касса.
    const manual = (await rates(c.root)).dispatch === "manual";
    const byId = new Map(points.map((p) => [p.id, p]));
    const free = [];
    const mine = [];
    const stale = [];
    for (const p of points) {
      const open = await openDeliveries(p.id);
      const take = open.filter((s) => isFree(s) || s.courierId === c.id);
      const contacts = await contactsOf(p.id, take);
      for (const s of take) {
        const contact = contacts.get(s.id) || {};
        if (s.courierId === c.id) {
          const st = flow.normalize("delivery", s.deliveryStatus);
          // Отменили, пока курьер ехал в заведение, — заказ просто уходит.
          if (st === "cancelled" && (s.courierStage || "toVenue") === "toVenue") { stale.push([p.id, s.id]); continue; }
          if (!ACTIVE_STAGES.includes(s.courierStage)) continue;
          mine.push(await mineDto(p, s, contact, c));
        } else if (!manual) {
          free.push(await freeDto(p, s, contact, c));
        }
      }
    }
    // Заказы, которые числятся за курьером в других (закрытых) чеках.
    const mineKeys = new Set(mine.map((m) => m.key));
    for (const key of Object.keys(c.active || {})) {
      if (mineKeys.has(key)) continue;
      const [t, s] = key.split("__");
      if (!byId.has(t)) { stale.push([t, s]); continue; }
      const x = (await tenantRef(t).collection("sessions").doc(s).get()).data();
      if (x && x.courierId === c.id && ACTIVE_STAGES.includes(x.courierStage) &&
          !(flow.normalize("delivery", x.deliveryStatus) === "cancelled" && x.courierStage === "toVenue")) {
        const contact = (await contactsOf(t, [{ id: s, ...x }])).get(s) || {};
        mine.push(await mineDto(byId.get(t), { id: s, ...x }, contact, c));
      } else {
        stale.push([t, s]);
      }
    }
    for (const [t, s] of stale) await dropStale(c, t, s).catch(() => {});
    free.sort((a, b) => (b.returned - a.returned) || (b.ageMin - a.ageMin));
    mine.sort((a, b) => a.stageAt - b.stageAt);
    return { points, free, mine, stats: await statsOf(c, points) };
  }

  /** Заказ ушёл от курьера (отменён до забора, закрыт без него) — убрать отметку. */
  async function dropStale(c, t, s) {
    const ref = tenantRef(t).collection("sessions").doc(s);
    let wasCancelled = false;
    await db().runTransaction(async (tx) => {
      const x = (await tx.get(ref)).data();
      if (x && x.courierId === c.id && x.courierStage === "toVenue" && flow.normalize("delivery", x.deliveryStatus) === "cancelled") {
        tx.update(ref, clearCourierPatch());
        wasCancelled = true;
      }
    });
    await couriersCol().doc(c.id).update({ [`active.${t}__${s}`]: del() });
    const trip = couriersCol().doc(c.id).collection("trips").doc(`${t}__${s}`);
    if (wasCancelled) await trip.set({ result: "cancelled", endedAt: ts() }, { merge: true }).catch(() => {});
  }

  async function statsOf(c, points) {
    const tz = (points[0] && points[0].tz) || "Europe/Moscow";
    const { day } = dayStartMs(now(), tz);
    const trips = (await couriersCol().doc(c.id).collection("trips").where("day", "==", day).get()).docs.map((d) => d.data());
    const done = trips.filter((x) => x.result === "done");
    const durations = done.filter((x) => ms(x.pickedAt) && ms(x.doneAt)).map((x) => (ms(x.doneAt) - ms(x.pickedAt)) / 60000);
    return {
      day,
      trips: done.length,
      km: round2(done.reduce((a, x) => a + (Number(x.distanceM) || 0), 0) / 1000),
      earned: Math.round(done.reduce((a, x) => a + (Number(x.earned) || 0), 0)),
      avgMin: durations.length ? Math.round(durations.reduce((a, x) => a + x, 0) / durations.length) : 0,
      cashOnHand: round2(Number(c.cashOnHand) || 0),
    };
  }

  async function handleState(req, res) {
    const c = await courierByToken(req);
    const body = await parseJsonBody(req).catch(() => ({}));
    if (now() - ms(c.lastSeenAt) > 30000) await couriersCol().doc(c.id).update({ lastSeenAt: ts() }).catch(() => {});
    const st = await stateOf(c);
    const settingsRoot = await rates(c.root);
    const out = {
      me: {
        no: c.no, name: c.name, onShift: c.onShift === true, shiftStartedAt: ms(c.shiftStartedAt),
        consent: consentOk(c), consentAt: ms(c.consentAt), policy: c.policyVersion || "", cashOnHand: round2(Number(c.cashOnHand) || 0),
        venue: await rootTitle(c.root), email: c.email || "", transport: c.transport || "", dispatch: settingsRoot.dispatch,
        points: st.points.map((p) => ({ id: p.id, name: p.name, address: p.address, pos: p.venuePos || null })),
        rates: settingsRoot,
        pos: c.pos && now() - ms(c.pos.at) < POS_FRESH_MS ? { lat: c.pos.lat, lng: c.pos.lng } : null,
        demo: c.demo === true,
      },
      free: st.free,
      mine: st.mine,
      stats: st.stats,
      serverTime: now(),
    };
    const v = sha(JSON.stringify({ ...out, serverTime: 0, free: out.free.map((f) => ({ ...f, ageMin: 0 })) })).slice(0, 16);
    if (body && body.v === v) return sendJson(res, 200, { same: true, v, serverTime: out.serverTime });
    sendJson(res, 200, { ...out, v });
  }

  /** Доход: последние 7 дней по дням, поездки за выбранный день, наличные. */
  async function handleHistory(req, res) {
    const c = await courierByToken(req);
    const body = await parseJsonBody(req).catch(() => ({}));
    const points = await scopeOf(c);
    const tz = (points[0] && points[0].tz) || "Europe/Moscow";
    const today = dayStartMs(now(), tz).day;
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(dayStartMs(now() - i * 86400000, tz).day);
    const uniq = [...new Set(days)];
    const trips = (await couriersCol().doc(c.id).collection("trips").where("day", ">=", uniq[0]).get()).docs.map((d) => d.data());
    const byDay = uniq.map((day) => {
      const done = trips.filter((x) => x.day === day && x.result === "done");
      return {
        day,
        trips: done.length,
        km: round2(done.reduce((a, x) => a + (Number(x.distanceM) || 0), 0) / 1000),
        earned: Math.round(done.reduce((a, x) => a + (Number(x.earned) || 0), 0)),
      };
    });
    const pick = uniq.includes(String(body.day || "")) ? String(body.day) : today;
    const list = trips.filter((x) => x.day === pick && x.result !== "active")
      .sort((a, b) => ms(b.doneAt || b.endedAt || b.takenAt) - ms(a.doneAt || a.endedAt || a.takenAt))
      .slice(0, 100)
      .map((x) => ({
        no: String(x.orderNo || ""), point: String(x.pointName || ""), zone: String(x.zoneName || ""),
        result: String(x.result || ""), at: ms(x.doneAt || x.endedAt || x.takenAt),
        takenAt: ms(x.takenAt), pickedAt: ms(x.pickedAt), doneAt: ms(x.doneAt),
        km: round2((Number(x.distanceM) || 0) / 1000), earned: Number(x.earned) || 0,
        payment: x.payment ? { method: String(x.payment.method || ""), amount: Number(x.payment.amount) || 0 } : null,
      }));
    const cash = (await couriersCol().doc(c.id).collection("cash").orderBy("at", "desc").limit(20).get()).docs
      .map((d) => d.data()).map((x) => ({ type: x.type, amount: Number(x.amount) || 0, orderNo: String(x.orderNo || ""), at: ms(x.at) }));
    sendJson(res, 200, { today, day: pick, days: byDay, trips: list, cash, cashOnHand: round2(Number(c.cashOnHand) || 0), rates: await rates(c.root) });
  }

  // ------------------------------------------------------------ действия

  const clearCourierPatch = () => ({
    courierId: del(), courierNo: del(), courierStage: del(), courierStageAt: del(),
    courierTakenAt: del(), courierPickedAt: del(), courierArrivedAt: del(),
    courierSet: false, courierName: del(), courierPhone: del(), courierPos: del(), courierFail: del(),
  });

  /** Имя и телефон курьера — гостю (кнопка «Позвонить курьеру»): в РФ-справочник или в заказ. */
  async function publishCourierContact(t, s, c, clear = false) {
    const name = clear ? "" : String(c.name || "").split(" ")[0];
    const phone = clear ? "" : String(c.phone || "");
    if (await rfMode(t)) {
      await pii.put(t, [{ k: "delivery", id: s, fields: { extra: { courierName: name, courierPhone: phone } } }])
        .catch((e) => console.error(`courier contact (${t}): ${e.message}`));
      return {};
    }
    return clear ? {} : { courierName: name, ...(phone ? { courierPhone: phone } : {}) };
  }

  /**
   * Курьер берёт заказ (или заведение назначает его). by — кто назначил
   * (uid или "telegram"); без by — взял сам.
   */
  async function assignTo(c, t, s, by = "") {
    const ref = tenantRef(t).collection("sessions").doc(s);
    // Имя и телефон курьера: без справочника РФ — в самом заказе (в той же
    // транзакции), со справочником — после, когда заказ точно за курьером.
    const rf = await rfMode(t);
    const contact = rf ? {} : await publishCourierContact(t, s, c);
    let prev = "";
    let result = "";
    await db().runTransaction(async (tx) => {
      const x = (await tx.get(ref)).data();
      if (!x || x.orderType !== "delivery") throw new HttpError(404, "Заказ не найден");
      if (x.courierId === c.id) { result = "same"; return; }
      const st = flow.normalize("delivery", x.deliveryStatus);
      // Заведение может передать заказ другому курьеру, пока его не забрали.
      const reassign = by && x.courierId && x.courierStage === "toVenue";
      if (!isFree(x) && !reassign) {
        throw new HttpError(409, x.courierId ? "Заказ уже взял другой курьер" : st === "new" ? "Заказ ещё не подтвердили" : "Заказ уже не свободен");
      }
      prev = reassign ? x.courierId : "";
      // Вернувшийся в заведение заказ новый курьер тоже сначала забирает.
      tx.update(ref, {
        ...contact,
        courierId: c.id,
        courierNo: c.no,
        courierStage: "toVenue",
        courierStageAt: ts(),
        courierTakenAt: ts(),
        courierSet: true,
        courierFail: del(),
        ...(by ? { courierAssignedBy: by } : { courierAssignedBy: del() }),
      });
      result = "toVenue";
    });
    if (result === "same") return "same";
    if (rf) await publishCourierContact(t, s, c);
    forget(`open:${t}`);
    const x = (await ref.get()).data() || {};
    const point = (await pointsOf(c.root)).find((p) => p.id === t) || {};
    const tz = point.tz || "Europe/Moscow";
    // Оценка пути по карте: если GPS телефона недосчитает, заработок не меньше её.
    const geo = ((await contactsOf(t, [{ id: s, ...x }])).get(s) || {}).geo;
    const estM = point.venuePos && geo ? (await roadM(point.venuePos, geo)) || 0 : 0;
    await couriersCol().doc(c.id).update({ [`active.${t}__${s}`]: result });
    await couriersCol().doc(c.id).collection("trips").doc(`${t}__${s}`).set({
      root: c.root, tenantId: t, sessionId: s, orderNo: String(x.orderNo || ""), pointName: point.name || "",
      zoneName: (x.delivery && x.delivery.zoneName) || "", fee: (x.delivery && x.delivery.fee) || 0,
      ...(estM ? { estM } : {}),
      day: dayStartMs(now(), tz).day, shiftId: c.shiftId || "", takenAt: ts(), result: "active",
      ...(by ? { assignedBy: by } : {}),
    });
    if (prev) await releaseTrip(prev, t, s, "reassigned");
    await hooks.event(t, s, by ? `🛵 Назначен курьер №${c.no}` : `🛵 Курьер №${c.no} взял заказ`).catch(() => {});
    return result;
  }

  async function releaseTrip(courierId, t, s, result) {
    await couriersCol().doc(courierId).update({ [`active.${t}__${s}`]: del() }).catch(() => {});
    const trip = couriersCol().doc(courierId).collection("trips").doc(`${t}__${s}`);
    if (result === "released" || result === "reassigned") await trip.delete().catch(() => {});
    else await trip.set({ result, endedAt: ts() }, { merge: true }).catch(() => {});
  }

  /** Действие курьера над своим заказом. → новая стадия. */
  async function act(c, op, t, s, args = {}) {
    if (!SID_RE.test(String(s || "")) || !ID_RE.test(String(t || ""))) throw new HttpError(400, "Не указан заказ");
    const points = await scopeOf(c);
    const point = points.find((p) => p.id === t);
    if (!point) throw new HttpError(403, "Этот заказ не из ваших точек");
    if (op === "take") {
      if (!c.onShift) throw new HttpError(409, "Начните смену, чтобы брать заказы");
      if ((await rates(c.root)).dispatch === "manual") throw new HttpError(409, "Заказы назначает заведение — дождитесь назначения");
      if (Object.keys(c.active || {}).length >= MAX_ACTIVE) throw new HttpError(409, `На руках уже ${MAX_ACTIVE} заказов — сначала доставьте их`);
      return assignTo(c, t, s);
    }
    const ref = tenantRef(t).collection("sessions").doc(s);
    const rf = await rfMode(t);
    const excludeTobacco = await excludeTobaccoOf(t);
    let effect = null;
    await db().runTransaction(async (tx) => {
      const x = (await tx.get(ref)).data();
      if (!x || x.orderType !== "delivery") throw new HttpError(404, "Заказ не найден");
      const st = flow.normalize("delivery", x.deliveryStatus);
      const mine = x.courierId === c.id;
      const stage = mine ? x.courierStage || "toVenue" : "";
      const now_ = ts();
      const notMine = () => new HttpError(409, x.courierId ? "Заказ у другого курьера" : "Этот заказ у вас уже не числится");
      // Заказ уже вручён: шаги из очереди без связи, пришедшие позже, — не ошибка.
      if (mine && stage === "done" && op !== "release" && op !== "returned") return;
      switch (op) {
        case "release": {
          if (!mine) return;
          if (stage !== "toVenue") throw new HttpError(409, "Заказ уже у вас — если не получилось вручить, нажмите «Не удалось»");
          tx.update(ref, clearCourierPatch());
          effect = { kind: "release" };
          return;
        }
        case "pickup": {
          if (!mine) throw notMine();
          if (stage !== "toVenue") return;
          if (st === "cancelled") throw new HttpError(409, "Заказ отменён заведением");
          if (st === "new") throw new HttpError(409, "Заказ ещё не подтвердили");
          tx.update(ref, {
            courierStage: "onWay", courierStageAt: now_, courierPickedAt: now_,
            ...(st === "accepted" || st === "cooking" ? { deliveryStatus: "courier", deliveryStatusAt: now_ } : {}),
          });
          effect = { kind: "pickup" };
          return;
        }
        case "arrive": {
          if (!mine) throw notMine();
          if (stage === "arrived" || stage === "failed") return;
          if (stage !== "onWay") throw new HttpError(409, "Сначала нажмите «Забрал заказ»");
          tx.update(ref, { courierStage: "arrived", courierStageAt: now_, courierArrivedAt: now_ });
          effect = { kind: "arrive" };
          return;
        }
        case "deliver": {
          if (!mine) {
            if (x.courierPayment && x.courierPayment.courierId === c.id) return; // повтор из очереди
            throw notMine();
          }
          if (stage !== "onWay" && stage !== "arrived") throw new HttpError(409, "Сначала заберите заказ");
          if (st === "cancelled") throw new HttpError(409, "Заказ отменён — верните его в заведение");
          const items = x.orderItems || [];
          const fee = x.delivery && Number(x.delivery.fee) > 0 ? Number(x.delivery.fee) : 0;
          let total = items.filter((i) => !pricing.isFeeLine(i)).length ? sessionBill(x, excludeTobacco) : Number(x.appTotal) || 0;
          if (x.deliveryFeePending === true && !items.some(pricing.isFeeLine) && items.length) total += fee;
          total = round2(total);
          const due = x.status === "closed" ? 0 : Math.max(0, round2(total - (Number(x.guestPaidTotal) || 0)));
          let method = "prepaid";
          let received = 0;
          if (due >= 0.01) {
            method = String(args.method || "");
            const allowed = point.payAtDoor || {};
            if (method === "qr") throw new HttpError(409, "Банк ещё не подтвердил оплату по QR — подождите или выберите другой способ");
            if (method !== "cash" && method !== "card") throw new HttpError(400, "Выберите, как гость оплатил");
            if (!allowed[method]) throw new HttpError(409, `Заведение не принимает оплату ${METHOD_LABEL[method]} при доставке`);
            received = method === "cash" ? round2(Number(args.received) || due) : due;
            if (received + 0.005 < due) throw new HttpError(409, `Получено меньше суммы заказа: нужно ${rubText(due)}`);
          } else if (Number(x.guestPaidTotal) > 0) {
            method = "qr_or_online";
          }
          const collected = method === "cash" || method === "card" ? due : 0;
          tx.update(ref, {
            deliveryStatus: "done", deliveryStatusAt: now_, deliveryOpen: false,
            courierStage: "done", courierStageAt: now_, deliveredAt: now_, courierPos: del(),
            ...(rf ? {} : { courierPhone: del() }),
            // Касса с онлайн-кассой сама пробьёт чек полного расчёта.
            fiscalNeed: true,
            courierPayment: {
              method: method === "qr_or_online" ? "online" : method,
              amount: collected,
              ...(method === "cash" ? { received, change: round2(received - due) } : {}),
              courierId: c.id, courierNo: c.no, at: now_,
            },
          });
          effect = { kind: "deliver", method, collected, received, change: round2(received - due), orderNo: String(x.orderNo || ""), total };
          return;
        }
        case "fail": {
          if (!mine) throw notMine();
          if (stage === "failed") return;
          if (stage !== "onWay" && stage !== "arrived") throw new HttpError(409, "Сначала заберите заказ");
          const reason = FAIL_REASONS[args.reason] ? args.reason : "";
          if (!reason) throw new HttpError(400, "Выберите причину");
          const note = clean(args.note, 200);
          if (reason === "other" && note.length < 3) throw new HttpError(400, "Опишите причину в двух словах");
          tx.update(ref, { courierStage: "failed", courierStageAt: now_, courierFail: { reason, note, at: now_ } });
          effect = { kind: "fail", reason, note, orderNo: String(x.orderNo || "") };
          return;
        }
        case "retry": {
          if (!mine) throw notMine();
          if (stage === "arrived") return;
          if (stage !== "failed") throw new HttpError(409, "Повторить можно после «Не удалось вручить»");
          if (st === "cancelled") throw new HttpError(409, "Заказ отменён — верните его в заведение");
          tx.update(ref, { courierStage: "arrived", courierStageAt: now_, courierFail: del() });
          effect = { kind: "retry" };
          return;
        }
        case "returned": {
          if (!mine) return;
          const held = stage === "onWay" || stage === "arrived" || stage === "failed";
          if (!(stage === "failed" || (st === "cancelled" && held))) {
            throw new HttpError(409, "Вернуть заказ можно после «Не удалось вручить»");
          }
          tx.update(ref, { ...clearCourierPatch(), ...(st === "cancelled" ? {} : { courierStage: "returned", courierStageAt: now_ }) });
          effect = { kind: "returned", cancelled: st === "cancelled", orderNo: String(x.orderNo || "") };
          return;
        }
        default:
          throw new HttpError(400, "Неизвестное действие");
      }
    });
    if (!effect) return "same";
    forget(`open:${t}`);
    await afterAct(c, point, t, s, effect).catch((e) => console.error(`courier after ${effect.kind} (${t}/${s}): ${e.message}`));
    return effect.kind;
  }

  /** Последствия действия: поездка, наличные, сигналы кассе и в Telegram. */
  async function afterAct(c, point, t, s, e) {
    const me = couriersCol().doc(c.id);
    const trip = me.collection("trips").doc(`${t}__${s}`);
    const key = `active.${t}__${s}`;
    const no = `Курьер №${c.no}`;
    switch (e.kind) {
      case "release":
        await publishCourierContact(t, s, c, true);
        await releaseTrip(c.id, t, s, "released");
        await hooks.event(t, s, `↩️ ${no} отказался от заказа — он снова свободен`);
        return;
      case "pickup": {
        await me.update({ [key]: "onWay" });
        await trip.set({ pickedAt: ts(), odoAtPickup: Number(c.odometerM) || 0 }, { merge: true });
        await learnVenuePos(c, t).catch(() => {});
        await hooks.event(t, s, `📦 ${no} забрал заказ — в пути`);
        return;
      }
      case "arrive":
        await me.update({ [key]: "arrived" });
        await trip.set({ arrivedAt: ts() }, { merge: true });
        return;
      case "retry":
        await me.update({ [key]: "arrived" });
        return;
      case "fail": {
        await me.update({ [key]: "failed" });
        await trip.set({ failedAt: ts(), failReason: e.reason }, { merge: true });
        const why = `${FAIL_REASONS[e.reason]}${e.note ? ` («${e.note}»)` : ""}`;
        await staffCall(t, s, e.orderNo, "callWaiter", `${no}: не удалось вручить — ${why}. Позвоните гостю или курьеру`);
        await hooks.event(t, s, `⚠️ ${no}: не удалось вручить — ${why}`);
        return;
      }
      case "returned":
        await publishCourierContact(t, s, c, true);
        await releaseTrip(c.id, t, s, e.cancelled ? "cancelled" : "returned");
        await hooks.event(t, s, e.cancelled ? `↩️ ${no} вернул отменённый заказ в заведение` : `↩️ ${no} вернул заказ в заведение — он снова свободен для курьеров`);
        return;
      case "deliver": {
        const tripData = (await trip.get()).data() || {};
        const fresh = (await me.get()).data() || c;
        const odo = Math.max(0, (Number(fresh.odometerM) || 0) - (Number(tripData.odoAtPickup) || 0));
        const dist = Math.max(odo, Number(tripData.estM) || 0);
        const r = await rates(c.root);
        const earned = Math.round(r.ratePerTrip + (r.ratePerKm * dist) / 1000);
        await trip.set({
          doneAt: ts(), result: "done", distanceM: dist, earned,
          payment: { method: e.method === "qr_or_online" ? "online" : e.method, amount: e.collected },
        }, { merge: true });
        const patch = { [key]: del() };
        if (e.method === "cash" && e.collected > 0) patch.cashOnHand = FieldValue.increment(e.collected);
        await me.update(patch);
        if (e.method === "cash" && e.collected > 0) {
          await me.collection("cash").add({ type: "collect", amount: e.collected, tenantId: t, sessionId: s, orderNo: e.orderNo, at: ts() });
        }
        if (e.collected > 0) {
          await staffCall(t, s, e.orderNo, "bill",
            `${no} получил ${rubText(e.collected)} ${METHOD_LABEL[e.method]} — пробейте чек сейчас, гостю уйдёт электронный чек`);
        }
        const paidText = e.collected > 0 ? ` · ${METHOD_LABEL[e.method]} ${rubText(e.collected)}` : e.method === "prepaid" ? "" : " · оплачено онлайн";
        await hooks.event(t, s, `✅ ${no} вручил заказ${paidText}`);
        if (await rfMode(t)) await publishCourierContact(t, s, c, true);
        return;
      }
      default:
    }
  }

  /** Сигнал на кассу (как вызов гостя): тип — из тех, что касса уже знает. */
  async function staffCall(t, s, orderNo, type, comment) {
    await tenantRef(t).collection("waiterCalls").add({
      tableId: "takeaway",
      tableName: `Доставка №${orderNo || s.slice(-4)}`,
      sessionId: s,
      clientUid: "",
      guestName: "",
      type,
      comment,
      status: "new",
      createdAt: ts(),
    });
  }

  /**
   * Координаты точки — по тому, где курьеры забирают заказы (медиана
   * последних 15 заборов): заведению не нужно ставить точку на карте.
   */
  async function learnVenuePos(c, t) {
    const pos = c.pos;
    if (!pos || now() - ms(pos.at) > 2 * 60 * 1000 || !(pos.acc <= 80)) return;
    const ref = tenantRef(t).collection("settings").doc("delivery");
    await db().runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data() || {};
      const list = (Array.isArray(cur.pickupPoints) ? cur.pickupPoints : []).slice(-14);
      list.push({ lat: Math.round(pos.lat * 1e5) / 1e5, lng: Math.round(pos.lng * 1e5) / 1e5 });
      const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
      const venuePos = { lat: med(list.map((p) => p.lat)), lng: med(list.map((p) => p.lng)) };
      tx.set(ref, { pickupPoints: list, ...(list.length >= 3 ? { venuePos } : {}) }, { merge: true });
    });
    forget(`points:${c.root}`);
  }

  async function handleAct(req, res) {
    const c = await courierByToken(req);
    const body = await parseJsonBody(req);
    const done = await act(c, String(body.op || ""), body.t, body.s, body);
    sendJson(res, 200, { ok: true, result: done });
  }

  // ------------------------------------------------------------ геолокация

  const lastSessionPos = new Map();

  /** Маршрут по своей карте (map.js): только курьеру, не чаще 40 раз в минуту. */
  const routeHits = new Map();
  async function handleRoute(req, res) {
    const c = await courierByToken(req);
    const body = await parseJsonBody(req);
    const minute = Math.floor(now() / 60000);
    const hit = routeHits.get(c.id);
    const n = hit && hit.minute === minute ? hit.n + 1 : 1;
    routeHits.set(c.id, { minute, n });
    if (routeHits.size > 5000) routeHits.clear();
    if (n > 40) throw new HttpError(429, "Слишком часто — маршрут обновится через минуту");
    if (!hooks.route) return sendJson(res, 200, { ok: false, reason: "nomap" });
    const out = await hooks.route({ points: body.points, mode: body.mode });
    sendJson(res, 200, out || { ok: false, reason: "nomap" });
  }

  async function handlePing(req, res) {
    const c = await courierByToken(req);
    const body = await parseJsonBody(req);
    if (!c.onShift) return sendJson(res, 200, { ok: true, off: true });
    const raw = Array.isArray(body.points) ? body.points.slice(-300) : [];
    const points = raw
      .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), acc: Math.round(Number(p.acc) || 9999), at: Math.round(Number(p.at) || 0) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && (p.lat || p.lng))
      .map((p) => ({ ...p, at: p.at > 0 && p.at <= now() + 60000 && p.at > now() - 6 * 3600 * 1000 ? p.at : now() }))
      .sort((a, b) => a.at - b.at);
    if (!points.length) return sendJson(res, 200, { ok: true });
    const prev = c.pos ? { lat: c.pos.lat, lng: c.pos.lng, acc: c.pos.acc, at: ms(c.pos.at) } : null;
    const step = odometerStep(prev, points);
    const latest = points[points.length - 1];
    const pos = { lat: round6(latest.lat), lng: round6(latest.lng), acc: latest.acc, at: ts(latest.at) };
    await couriersCol().doc(c.id).update({
      pos,
      lastSeenAt: ts(),
      ...(step.meters > 0 ? { odometerM: FieldValue.increment(step.meters) } : {}),
    });
    // Заказы в пути: точка курьера — гостю и на страницу адреса.
    for (const [key, stage] of Object.entries(c.active || {})) {
      if (stage !== "onWay" && stage !== "arrived") continue;
      const prevW = lastSessionPos.get(key);
      if (prevW && latest.at - prevW.at < 15000 && distanceM(prevW, latest) < 30) continue;
      lastSessionPos.set(key, latest);
      const [t, s] = key.split("__");
      await tenantRef(t).collection("sessions").doc(s).update({ courierPos: { lat: pos.lat, lng: pos.lng, acc: pos.acc, at: pos.at } }).catch(() => {});
      await hooks.moved(t, s, pos.lat, pos.lng).catch(() => {});
    }
    if (lastSessionPos.size > 5000) lastSessionPos.clear();
    sendJson(res, 200, { ok: true });
  }

  const round6 = (v) => Math.round(v * 1e6) / 1e6;

  // ------------------------------------------------------------ оплата по QR у двери

  async function handlePay(req, res) {
    const c = await courierByToken(req);
    const { t, s, paymentId } = await parseJsonBody(req);
    if (!SID_RE.test(String(s || "")) || !ID_RE.test(String(t || ""))) throw new HttpError(400, "Не указан заказ");
    const point = (await scopeOf(c)).find((p) => p.id === t);
    if (!point) throw new HttpError(403, "Этот заказ не из ваших точек");
    if (!guestPay) throw new HttpError(409, "Оплата по QR недоступна");
    const x = (await tenantRef(t).collection("sessions").doc(s).get()).data();
    if (!x || x.courierId !== c.id) throw new HttpError(409, "Этот заказ у вас уже не числится");
    if (paymentId) {
      const st = await guestPay.courierPayStatus(t, String(paymentId));
      forget(`open:${t}`);
      return sendJson(res, 200, st);
    }
    if (!point.payAtDoor.qr) throw new HttpError(409, "Заведение не принимает оплату по QR при доставке");
    const made = await guestPay.courierPayStart(t, s, { courierId: c.id, courierNo: c.no });
    sendJson(res, 200, made);
  }

  // ------------------------------------------------------------ кабинет

  /**
   * Права в кабинете. Владелец/администратор сети — все курьеры сети;
   * администратор точки (owner/admin/manager точки) — курьеры, которые
   * ездят на его точку; создаёт и меняет — только «своих» (points = [точка]).
   */
  async function staffCtx(req, body) {
    const decoded = await verifyAuth(req);
    const tenantId = String(body.tenantId || "");
    if (!ID_RE.test(tenantId)) throw new HttpError(400, "Не указано заведение");
    const { root, chainId } = await rootOf(tenantId);
    let chainAdmin = false;
    if (chainId) {
      try { await requireChainRole(chainId, decoded.uid, ["owner", "admin"]); chainAdmin = true; } catch (_) { chainAdmin = false; }
    }
    if (!chainAdmin) await requireTenantRole(tenantId, decoded.uid, MANAGE_ROLES);
    const full = chainAdmin || !chainId;
    return { uid: decoded.uid, tenantId, root, chainId, full };
  }

  const servesPoint = (courier, tenantId) => !courier.points || !courier.points.length || courier.points.includes(tenantId);
  const ownsCourier = (ctx, courier) => courier.root === ctx.root &&
    (ctx.full || (Array.isArray(courier.points) && courier.points.length === 1 && courier.points[0] === ctx.tenantId));

  async function courierOf(ctx, courierId) {
    if (!ID_RE.test(String(courierId || ""))) throw new HttpError(400, "Не указан курьер");
    const d = await couriersCol().doc(courierId).get();
    const c = d.data();
    if (!c || c.root !== ctx.root || (!ctx.full && !servesPoint(c, ctx.tenantId))) throw new HttpError(404, "Курьер не найден");
    return { id: d.id, ...c };
  }

  /** Активные курьеры заведения (занимают места тарифа) и лимит: max -1 — без ограничений. */
  async function slotsOf(root) {
    const all = (await couriersCol().where("root", "==", root).get()).docs.map((d) => d.data());
    const active = all.filter((c) => c.enabled !== false && !c.forgottenAt && !c.demo).length;
    let max = -1;
    try { max = Number(await courierLimit(root)); } catch (_) { max = -1; }
    if (!Number.isFinite(max)) max = -1;
    return { active, max: max < 0 ? -1 : Math.floor(max) };
  }
  async function requireSlot(root) {
    const sl = await slotsOf(root);
    if (sl.max >= 0 && sl.active >= sl.max) {
      throw Object.assign(new HttpError(403, sl.max === 0
        ? "В вашем тарифе нет курьеров — смените тариф в разделе «Оплата»"
        : `Лимит тарифа — ${sl.max} ${sl.max === 1 ? "активный курьер" : sl.max < 5 ? "активных курьера" : "активных курьеров"}. Заблокируйте неактивного или увеличьте лимит в разделе «Оплата»`), { code: "COURIER_LIMIT_EXCEEDED" });
    }
  }

  /** Приветственное письмо курьеру: кто добавил и как войти. Ошибка почты — не ошибка сохранения. */
  async function sendWelcome(c) {
    const mailer = getMailer();
    if (!mailer || !c.email) return false;
    try {
      await mailer.send({ to: c.email, ...letters.courierWelcomeLetter({ venue: await rootTitle(c.root), name: c.name, appUrl }) });
      await couriersCol().doc(c.id).update({ welcomedAt: ts() }).catch(() => {});
      return true;
    } catch (e) {
      console.error(`courier welcome mail: ${e.message}`);
      return false;
    }
  }

  async function handleAdminList(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    const points = await pointsOf(ctx.root);
    const visible = ctx.full ? points : points.filter((p) => p.id === ctx.tenantId);
    const all = (await couriersCol().where("root", "==", ctx.root).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    const list = all.filter((c) => ctx.full || servesPoint(c, ctx.tenantId)).sort((a, b) => (a.no || 0) - (b.no || 0));
    const tz = (visible[0] && visible[0].tz) || "Europe/Moscow";
    const { day } = dayStartMs(now(), tz);
    const couriers = [];
    for (const c of list) {
      const trips = (await couriersCol().doc(c.id).collection("trips").where("day", "==", day).get()).docs.map((d) => d.data());
      const done = trips.filter((x) => x.result === "done" && (ctx.full || x.tenantId === ctx.tenantId));
      const fresh = c.onShift && c.pos && now() - ms(c.pos.at) < POS_FRESH_MS;
      couriers.push({
        id: c.id, no: c.no, name: c.name || "", phone: c.phone || "", points: c.points || [],
        email: c.email || "", transport: c.transport || "", demo: c.demo === true,
        consent: c.consentAt ? { at: ms(c.consentAt), version: c.policyVersion || "", current: consentOk(c) } : null,
        enabled: c.enabled !== false,
        forgotten: !!c.forgottenAt,
        onShift: c.onShift === true, shiftStartedAt: ms(c.shiftStartedAt),
        lastSeenAt: ms(c.lastSeenAt),
        linked: !!c.tokenHash, welcomedAt: ms(c.welcomedAt),
        orders: Object.keys(c.active || {}).length,
        cashOnHand: round2(Number(c.cashOnHand) || 0),
        pos: fresh ? { lat: c.pos.lat, lng: c.pos.lng, at: ms(c.pos.at) } : null,
        today: {
          trips: done.length,
          km: round2(done.reduce((a, x) => a + (Number(x.distanceM) || 0), 0) / 1000),
          earned: Math.round(done.reduce((a, x) => a + (Number(x.earned) || 0), 0)),
        },
        editable: ownsCourier(ctx, c),
      });
    }
    // Заказы доставки в работе — по видимым точкам.
    const orders = [];
    for (const p of visible) {
      for (const s of await openDeliveries(p.id)) {
        const st = flow.normalize("delivery", s.deliveryStatus);
        if (st === "new" || st === "done" || (st === "cancelled" && !s.courierId)) continue;
        const m = await moneyOf(p.id, s);
        orders.push({
          t: p.id, s: s.id, no: String(s.orderNo || ""), point: p.name,
          status: flow.label("delivery", s.deliveryStatus), stage: s.courierStage || "",
          stageLabel: STAGE_LABEL[s.courierStage] || "",
          courierId: s.courierId || "", courierNo: s.courierNo || null, external: !s.courierId && s.courierSet === true,
          zone: (s.delivery && s.delivery.zoneName) || "", ageMin: ageMin(s), total: m.total, toCollect: m.toCollect,
          fail: s.courierFail ? FAIL_REASONS[s.courierFail.reason] || "" : "",
          free: isFree(s),
          // Курьер службы доставки (Яндекс, Достависта) — delivery-services.js.
          ext: s.ext && s.ext.provider ? {
            provider: s.ext.provider, step: s.ext.step || "", label: s.ext.label || "", status: s.ext.status || "",
            price: s.ext.price || s.ext.quoted || null, courier: s.ext.courier || null, track: s.ext.track || "",
            approve: s.ext.status === "ready_for_approval", error: s.ext.error || "",
          } : null,
          pos: s.courierPos && now() - ms(s.courierPos.at) < POS_FRESH_MS * 2 ? { lat: s.courierPos.lat, lng: s.courierPos.lng } : null,
        });
      }
    }
    const r = await rates(ctx.root);
    sendJson(res, 200, {
      services: hooks.services ? await hooks.services(visible.map((p) => p.id)).catch(() => ({})) : {},
      root: ctx.root, chain: !!ctx.chainId, full: ctx.full,
      points: points.map((p) => ({ id: p.id, name: p.name, venuePos: p.venuePos })),
      couriers, orders, rates: r, day,
      slots: await slotsOf(ctx.root), dispatch: r.dispatch, mail: !!getMailer(), appUrl,
    });
  }

  async function handleAdminSave(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    const input = body.courier && typeof body.courier === "object" ? body.courier : {};
    const name = clean(input.name, 60);
    if (name.length < 2) throw new HttpError(400, "Укажите имя курьера");
    const email = normEmail(input.email);
    if (!EMAIL_RE.test(email)) throw Object.assign(new HttpError(400, "Укажите почту курьера — по ней он входит в приложение"), { code: "BAD_EMAIL" });
    const phone = input.phone ? normalizePhone(input.phone) : "";
    if (input.phone && !phone) throw new HttpError(400, "Проверьте телефон: нужен российский номер, +7 и 10 цифр");
    const transport = TRANSPORTS[input.transport] ? String(input.transport) : "";
    if (!transport) throw new HttpError(400, "Выберите транспорт курьера");
    const all = await pointsOf(ctx.root);
    let points = Array.isArray(input.points) ? [...new Set(input.points.map(String))].filter((id) => all.some((p) => p.id === id)) : [];
    if (points.length === all.length) points = [];
    if (!ctx.full) points = [ctx.tenantId];
    // Почта — логин: в одном заведении один курьер на почту (в разных — можно).
    const same = (await couriersCol().where("email", "==", email).get()).docs
      .filter((d) => (d.data() || {}).root === ctx.root && !(d.data() || {}).forgottenAt && d.id !== String(input.id || ""));
    if (same.length) throw Object.assign(new HttpError(409, `Курьер с почтой ${email} уже есть в этом заведении — №${same[0].data().no}`), { code: "EMAIL_TAKEN" });
    if (input.id) {
      const cur = await courierOf(ctx, input.id);
      if (!ownsCourier(ctx, cur)) throw new HttpError(403, "Этого курьера меняет владелец сети");
      if (cur.forgottenAt) throw new HttpError(409, "Данные курьера удалены — заведите нового");
      const emailChanged = (cur.email || "") !== email;
      await couriersCol().doc(cur.id).update({
        name, email, phone, transport, points, updatedAt: ts(), updatedBy: ctx.uid,
        // Новая почта — новый вход: старый телефон выходит.
        ...(emailChanged ? { tokenHash: del(), tokenAt: del() } : {}),
      });
      if (emailChanged && cur.tokenHash) forget(`tok:${cur.tokenHash}`);
      const welcomed = emailChanged && cur.enabled !== false ? await sendWelcome({ ...cur, name, email }) : false;
      return sendJson(res, 200, { ok: true, id: cur.id, welcomed });
    }
    await requireSlot(ctx.root);
    const count = (await couriersCol().where("root", "==", ctx.root).get()).docs.length;
    if (count >= MAX_COURIERS) throw new HttpError(409, `Курьеров — не больше ${MAX_COURIERS}`);
    let no = 0;
    await db().runTransaction(async (tx) => {
      const s = (await tx.get(settingsRef(ctx.root))).data() || {};
      no = (Math.trunc(Number(s.lastNo)) || 0) + 1;
      tx.set(settingsRef(ctx.root), { lastNo: no }, { merge: true });
    });
    const ref = couriersCol().doc();
    const doc = {
      root: ctx.root, no, name, email, phone, transport, points, enabled: true, onShift: false,
      cashOnHand: 0, odometerM: 0, createdAt: ts(), updatedAt: ts(), createdBy: ctx.uid,
    };
    await ref.set(doc);
    const welcomed = await sendWelcome({ id: ref.id, ...doc });
    sendJson(res, 200, { ok: true, id: ref.id, no, welcomed });
  }

  /** Письмо курьеру ещё раз: «как войти в приложение». */
  async function handleAdminWelcome(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    const c = await courierOf(ctx, body.courierId);
    if (!ownsCourier(ctx, c)) throw new HttpError(403, "Письмо этому курьеру отправляет владелец сети");
    if (c.enabled === false) throw new HttpError(409, "Курьер заблокирован — сначала включите его");
    if (!c.email) throw new HttpError(409, "У курьера нет почты — укажите её в карточке");
    if (ms(c.welcomedAt) && now() - ms(c.welcomedAt) < 60 * 1000) throw new HttpError(429, "Письмо только что ушло — повторить можно через минуту");
    if (!getMailer()) throw Object.assign(new HttpError(503, "Почта платформы не настроена — передайте курьеру адрес приложения сами"), { code: "MAIL_UNAVAILABLE" });
    if (!(await sendWelcome(c))) throw new HttpError(503, "Письмо не отправилось — попробуйте через минуту");
    sendJson(res, 200, { ok: true });
  }

  /** Отключить/включить. Отключение закрывает вход и возвращает незабранные заказы. */
  async function handleAdminEnable(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    const c = await courierOf(ctx, body.courierId);
    if (!ownsCourier(ctx, c)) throw new HttpError(403, "Этого курьера отключает владелец сети");
    if (body.enabled === false) {
      const busy = await activeOf(c);
      const held = busy.filter((b) => b.x.courierStage !== "toVenue");
      if (held.length) throw new HttpError(409, `У курьера заказы в пути: ${held.length}. Отключить можно, когда он их вручит или вернёт`);
      for (const b of busy) await systemRelease(c, b.t, b.s, `↩️ Курьер №${c.no} отключён — заказ снова свободен`);
      if (c.tokenHash) forget(`tok:${c.tokenHash}`);
      await couriersCol().doc(c.id).update({
        enabled: false, tokenHash: del(), tokenAt: del(), updatedAt: ts(),
        ...(c.onShift ? await shiftEndPatch(c) : {}),
      });
    } else if (c.enabled === false) {
      if (c.forgottenAt) throw new HttpError(409, "Данные курьера удалены — заведите нового");
      await requireSlot(ctx.root);
      await couriersCol().doc(c.id).update({ enabled: true, updatedAt: ts() });
    }
    sendJson(res, 200, { ok: true });
  }

  /**
   * Курьер ушёл — его имя и телефон стираются (152-ФЗ: цель обработки
   * достигнута). Поездки остаются за номером: отчёты прошлых дней сходятся.
   * Только отключённого, без наличных на руках.
   */
  async function handleAdminForget(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    const c = await courierOf(ctx, body.courierId);
    if (!ownsCourier(ctx, c)) throw new HttpError(403, "Данные этого курьера удаляет владелец сети");
    if (c.enabled !== false) throw new HttpError(409, "Сначала отключите курьера");
    if ((Number(c.cashOnHand) || 0) > 0.005) throw new HttpError(409, `У курьера на руках ${rubText(c.cashOnHand)} — сначала примите наличные`);
    await couriersCol().doc(c.id).update({
      name: `Курьер №${c.no}`, phone: "", email: "", forgottenAt: ts(), forgottenBy: ctx.uid,
      device: del(), pos: del(), consentAt: del(), consentIp: del(), consentEmail: del(), policyVersion: del(), tokenHash: del(),
    });
    sendJson(res, 200, { ok: true });
  }

  /** Заказ, который курьер не забрал, — снова свободен (отключение, пропал со связи). */
  async function systemRelease(c, t, s, note) {
    const ref = tenantRef(t).collection("sessions").doc(s);
    let released = false;
    await db().runTransaction(async (tx) => {
      const x = (await tx.get(ref)).data();
      if (x && x.courierId === c.id && x.courierStage === "toVenue") {
        tx.update(ref, clearCourierPatch());
        released = true;
      }
    });
    if (!released) return false;
    forget(`open:${t}`);
    await publishCourierContact(t, s, c, true);
    await releaseTrip(c.id, t, s, "released");
    await hooks.event(t, s, note).catch(() => {});
    return true;
  }

  /** Курьер сдал наличные в точке. */
  async function handleAdminCash(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    const c = await courierOf(ctx, body.courierId);
    const amount = round2(Number(body.amount));
    const onHand = round2(Number(c.cashOnHand) || 0);
    if (!(amount > 0)) throw new HttpError(400, "Укажите сумму");
    if (amount > onHand + 0.005) throw new HttpError(409, `У курьера на руках ${rubText(onHand)}`);
    const ref = couriersCol().doc(c.id);
    await db().runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data() || {};
      const have = round2(Number(cur.cashOnHand) || 0);
      if (amount > have + 0.005) throw new HttpError(409, `У курьера на руках ${rubText(have)}`);
      tx.update(ref, { cashOnHand: round2(have - amount) });
    });
    await ref.collection("cash").add({ type: "handover", amount, tenantId: ctx.tenantId, by: ctx.uid, at: ts() });
    sendJson(res, 200, { ok: true, cashOnHand: round2(onHand - amount) });
  }

  /** Назначить курьера на заказ (или снять, пока не забрал). */
  async function handleAdminAssign(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    const t = String(body.t || ctx.tenantId);
    const s = String(body.s || "");
    if (!SID_RE.test(s) || !ID_RE.test(t)) throw new HttpError(400, "Не указан заказ");
    if (t !== ctx.tenantId && !(ctx.full && (await pointsOf(ctx.root)).some((p) => p.id === t))) {
      throw new HttpError(403, "Это заказ другой точки");
    }
    if (!body.courierId) {
      const x = (await tenantRef(t).collection("sessions").doc(s).get()).data();
      if (!x || !x.courierId) return sendJson(res, 200, { ok: true });
      const cur = (await couriersCol().doc(x.courierId).get()).data();
      if (x.courierStage !== "toVenue") throw new HttpError(409, "Курьер уже забрал заказ — снять его нельзя");
      await systemRelease({ id: x.courierId, ...cur }, t, s, `↩️ Заведение сняло курьера №${(cur && cur.no) || ""} — заказ снова свободен`);
      return sendJson(res, 200, { ok: true });
    }
    const c = await courierOf(ctx, body.courierId);
    await assignByStaff(c, t, s, ctx.uid);
    sendJson(res, 200, { ok: true });
  }

  async function assignByStaff(c, t, s, by) {
    if (c.enabled === false) throw new HttpError(409, "Курьер отключён");
    if (!c.onShift) throw new HttpError(409, `Курьер №${c.no} сейчас не на смене`);
    if (!servesPoint(c, t)) throw new HttpError(409, `Курьер №${c.no} не работает на этой точке`);
    if (Object.keys(c.active || {}).length >= MAX_ACTIVE) throw new HttpError(409, `У курьера №${c.no} уже ${MAX_ACTIVE} заказов`);
    return assignTo(c, t, s, by);
  }

  async function handleAdminRates(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    if (!ctx.full) throw new HttpError(403, "Ставки курьеров сети задаёт владелец сети");
    const perTrip = Number(body.ratePerTrip);
    const perKm = Number(body.ratePerKm);
    if (!(perTrip >= 0 && perTrip <= 100000)) throw new HttpError(400, "Ставка за доставку — от 0 до 100 000 ₽");
    if (!(perKm >= 0 && perKm <= 10000)) throw new HttpError(400, "Ставка за километр — от 0 до 10 000 ₽");
    const dispatch = body.dispatch === undefined ? null : DISPATCH[body.dispatch] ? String(body.dispatch) : "";
    if (dispatch === "") throw new HttpError(400, "Режим раздачи заказов: свободный пул или ручное назначение");
    await settingsRef(ctx.root).set({ ratePerTrip: round2(perTrip), ratePerKm: round2(perKm), ...(dispatch ? { dispatch } : {}) }, { merge: true });
    forget(`rates:${ctx.root}`);
    sendJson(res, 200, { ok: true });
  }

  /** Отчёт за рабочие сутки: поездки курьеров (без данных гостей). */
  async function handleAdminReport(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.day || "")) ? String(body.day) : dayStartMs(now(), "Europe/Moscow").day;
    const couriers = (await couriersCol().where("root", "==", ctx.root).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    const rows = [];
    for (const c of couriers) {
      const trips = (await couriersCol().doc(c.id).collection("trips").where("day", "==", day).get()).docs
        .map((d) => d.data())
        .filter((x) => ctx.full || x.tenantId === ctx.tenantId);
      if (!trips.length) continue;
      const done = trips.filter((x) => x.result === "done");
      const mins = done.filter((x) => ms(x.pickedAt) && ms(x.doneAt)).map((x) => (ms(x.doneAt) - ms(x.pickedAt)) / 60000);
      rows.push({
        id: c.id, no: c.no, name: c.name || "",
        trips: done.length,
        failed: trips.filter((x) => x.result === "returned" || x.failReason).length,
        km: round2(done.reduce((a, x) => a + (Number(x.distanceM) || 0), 0) / 1000),
        avgMin: mins.length ? Math.round(mins.reduce((a, x) => a + x, 0) / mins.length) : 0,
        earned: Math.round(done.reduce((a, x) => a + (Number(x.earned) || 0), 0)),
        cash: round2(done.reduce((a, x) => a + (x.payment && x.payment.method === "cash" ? Number(x.payment.amount) || 0 : 0), 0)),
        list: trips.sort((a, b) => ms(a.takenAt) - ms(b.takenAt)).map((x) => ({
          orderNo: x.orderNo, point: x.pointName, zone: x.zoneName, result: x.result,
          takenAt: ms(x.takenAt), pickedAt: ms(x.pickedAt), doneAt: ms(x.doneAt),
          km: round2((Number(x.distanceM) || 0) / 1000), earned: Number(x.earned) || 0,
          payment: x.payment || null, fail: x.failReason ? FAIL_REASONS[x.failReason] : "",
        })),
      });
    }
    sendJson(res, 200, { day, rows });
  }

  // ------------------------------------------------------------ Telegram: назначение

  /** Курьеры приложения на смене, кто ездит на точку: для кнопок бота (без имён). */
  async function onShiftFor(t) {
    const { root } = await rootOf(t);
    const list = (await couriersCol().where("root", "==", root).get()).docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((c) => c.onShift === true && c.enabled !== false && servesPoint(c, t));
    return list.sort((a, b) => a.no - b.no).map((c) => ({ id: c.id, no: c.no, busy: Object.keys(c.active || {}).length }));
  }

  async function assignFromBot(t, s, courierId) {
    const d = await couriersCol().doc(courierId).get();
    const c = d.data();
    const { root } = await rootOf(t);
    if (!c || c.root !== root) throw new HttpError(404, "Курьер не найден");
    return assignByStaff({ id: d.id, ...c }, t, s, "telegram");
  }

  // ------------------------------------------------------------ сторож

  /** Пропал со связи: незабранные заказы — свободны; без связи и заказов 6 ч — конец смены. */
  async function sweep() {
    const list = (await couriersCol().where("onShift", "==", true).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    for (const c of list) {
      const silent = now() - ms(c.lastSeenAt);
      if (silent > LOST_MS) {
        for (const key of Object.keys(c.active || {})) {
          if (c.active[key] !== "toVenue") continue;
          const [t, s] = key.split("__");
          await systemRelease(c, t, s, `↩️ Курьер №${c.no} не на связи ${Math.round(silent / 60000)} мин — заказ снова свободен`).catch(() => {});
        }
      }
      if (silent > SHIFT_AUTO_END_MS) {
        const fresh = (await couriersCol().doc(c.id).get()).data() || {};
        if (!Object.keys(fresh.active || {}).length) await couriersCol().doc(c.id).update(await shiftEndPatch({ id: c.id, ...fresh })).catch(() => {});
      }
    }
  }

  /** Разово: учётки прежней модели «свободных курьеров» (root "free") — стереть целиком. */
  async function purgeLegacyFree() {
    const n = await purgeRoot("free");
    if (n) console.log(`courier: стёрто учёток свободных курьеров прежней модели — ${n}`);
    return n;
  }

  function start() {
    purgeLegacyFree().catch((e) => console.error(`courier purge free: ${e.message}`));
    const timer = setInterval(() => { sweep().catch((e) => console.error(`courier sweep: ${e.message}`)); }, 60 * 1000);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
  }

  return {
    // приложение курьера
    invalidate: (t) => forget(`open:${t}`),
    handleRequestCode, handleVerifyCode, handleSelect, handleDemoLogin, handleLogout, handleConsent, handleHistory, handleState, handleShift, handleAct, handlePing, handlePay, handleRoute,
    // кабинет
    handleAdminList, handleAdminSave, handleAdminWelcome, handleAdminEnable, handleAdminCash, handleAdminAssign,
    handleAdminRates, handleAdminReport, handleAdminForget,
    // Telegram, сторож, тесты
    onShiftFor, assignFromBot, sweep, start, act, stateOf, purgeRoot, purgeLegacyFree, slotsOf,
    setHooks: (h) => { hooks = { ...hooks, ...h }; },
    forgetCache: () => cache.clear(),
  };
}

module.exports = {
  createCourier, distanceM, odometerStep, streetOf, dayStartMs, zonedMs, normalizePhone,
  FAIL_REASONS, LOST_MS, MAX_ACTIVE, POLICY_VERSION, CODE_TTL_MS, CODE_RESEND_MS, TRANSPORTS,
};
