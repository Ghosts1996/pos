"use strict";
/**
 * Заказ доставки или с собой из приложения гостя.
 *
 * Гость собирает корзину и жмёт «Оформить» → шлюз проверяет всё сам:
 * заведение принимает такие заказы и сейчас работает, позиции есть в меню
 * и их можно продавать навынос (табак, кальяны и алкоголь — нельзя:
 * ст. 19 закона № 15-ФЗ и ст. 16 закона № 171-ФЗ запрещают дистанционную
 * продажу), цены — из меню, а не с телефона. Имя, телефон и адрес сначала
 * записываются в базу в РФ (pii-gateway, ч. 5 ст. 18 закона № 152-ФЗ) и
 * только потом — заказ в Firestore.
 *
 * Заказ появляется на кассе в «С собой и доставка» со статусом «Новый»:
 * сотрудник звонит гостю, подтверждает — и тогда позиции встают в чек
 * (accept на кассе). Оплата онлайн — после подтверждения (guest-pay.js),
 * поэтому за отклонённый заказ деньги не списываются.
 */
const flow = require("./delivery-flow");
const { sellerReady } = require("./guest-pay");

const TAKEAWAY_TABLE = "takeaway";
const TOBACCO = /кальян|табак|никотин|hookah|shisha|снюс|вейп|сигар|чаш[аи]|забивк/i;
const ALCOHOL = /(^|[^а-яё])(пив[оа]|пивн|вин[оа]($|[^а-яё])|винн|игрист|шампанск|просекко|виски|коньяк|водк|ром($|[^а-яё])|джин($|[^а-яё])|текил|ликёр|ликер|настойк|наливк|сидр|абсент|бренди|вермут|мартини|портвейн|херес|саке|бурбон|кальвадос|граппа|самбук|аперол|медовух|алко)/i;
const MAX_LINES = 40;
const MAX_QTY = 30;
const MAX_OPEN_ORDERS = 2;
const MAX_ORDERS_PER_HOUR = 5;

const round2 = (v) => Math.round(v * 100) / 100;
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Российский номер к виду 7XXXXXXXXXX; не похоже на номер — "". */
function normalizePhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  let n = d;
  if (d.length === 11 && (d[0] === "8" || d[0] === "7")) n = `7${d.slice(1)}`;
  else if (d.length === 10 && /^[3489]/.test(d)) n = `7${d}`;
  return /^7\d{10}$/.test(n) ? n : "";
}

/** Нельзя продавать навынос и с доставкой: табак и кальяны, алкоголь (подакцизное). */
function remoteSaleBanned(item, categoryName = "") {
  const name = String(item.name || "");
  if (item.tobacco === true || TOBACCO.test(name) || TOBACCO.test(categoryName)) return true;
  if (item.fiscalSubject === "excise" || item.alcohol === true) return true;
  if (/безалк/i.test(name)) return false;
  return ALCOHOL.test(name) || ALCOHOL.test(categoryName);
}

/** Окно работы «14:00-06:00» на день недели (1 — понедельник). */
function windowOf(hours, weekday) {
  const raw = String((hours || {})[String(weekday)] || "").trim();
  const m = /(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/.exec(raw);
  if (!m) return null;
  const open = +m[1] * 60 + +m[2];
  let close = +m[3] * 60 + +m[4];
  if (close <= open) close += 24 * 60;
  return { open, close, raw: `${m[1].padStart(2, "0")}:${m[2]}–${m[3].padStart(2, "0")}:${m[4]}` };
}

/**
 * Работает ли заведение сейчас по местному времени. Часы не заданы вовсе —
 * считаем открытым (владелец их не заполнял). Ночная смена относится к
 * предыдущему дню: 01:30 во вторник — это ещё понедельник 14:00–06:00.
 * → { open, today } — today — часы сегодня для подсказки гостю.
 */
function openNow(hours, local) {
  const any = Object.values(hours || {}).some((v) => String(v || "").trim());
  if (!any) return { open: true, today: "" };
  const minutes = local.h * 60 + local.min;
  const wd = local.wd; // 1..7
  const today = windowOf(hours, wd);
  if (today && minutes >= today.open && minutes < today.close) return { open: true, today: today.raw };
  const prev = windowOf(hours, wd === 1 ? 7 : wd - 1);
  if (prev && prev.close > 24 * 60 && minutes < prev.close - 24 * 60) return { open: true, today: prev.raw };
  return { open: false, today: today ? today.raw : "" };
}

function localNow(date, tz) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz || "Europe/Moscow", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday] || 1;
  return { wd, h: +p.hour, min: +p.minute };
}

/** Позиции корзины по меню: цена с модификаторами, проверка выбора. */
function priceItems(lines, menu, categoryNames) {
  const out = [];
  const banned = [];
  for (const line of lines) {
    const m = menu[line.menuItemId];
    if (!m || m.available === false) throw new Error(`Позиции «${clean(line.name || "", 60) || "из корзины"}» больше нет в меню — обновите корзину`);
    const catName = categoryNames[m.categoryId] || "";
    if (remoteSaleBanned(m, catName)) {
      banned.push(m.name);
      continue;
    }
    const groups = Array.isArray(m.modifierGroups) ? m.modifierGroups : [];
    const chosen = [...new Set((Array.isArray(line.mods) ? line.mods : []).map((x) => clean(x, 60)).filter(Boolean))];
    const options = [];
    for (const g of groups) {
      const opts = (Array.isArray(g.options) ? g.options : []).filter((o) => chosen.includes(String(o.name || "").trim()));
      const min = Number(g.min) || 0;
      const max = Number(g.max ?? 1);
      if (opts.length < min) throw new Error(`«${m.name}»: выберите ${String(g.name || "добавку").toLowerCase()}`);
      if (max > 0 && opts.length > max) throw new Error(`«${m.name}»: в «${g.name}» не больше ${max}`);
      options.push(...opts);
    }
    const known = new Set(options.map((o) => String(o.name).trim()));
    const mods = chosen.filter((x) => known.has(x));
    const price = round2((Number(m.price) || 0) + options.reduce((a, o) => a + (Number(o.price) || 0), 0));
    const qty = Math.floor(Number(line.qty));
    if (!(qty >= 1 && qty <= MAX_QTY)) throw new Error(`«${m.name}»: количество от 1 до ${MAX_QTY}`);
    out.push({ menuItemId: line.menuItemId, name: String(m.name || ""), price, qty, ...(mods.length ? { mods } : {}) });
  }
  return { items: out, banned };
}

function createGuestDelivery({ db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, recordContact, onlinePayReady, now = () => new Date() }) {
  const tenantRef = (t) => db().collection("tenants").doc(t);

  function checkTenantId(tenantId) {
    if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new HttpError(400, "Не указано заведение");
  }

  async function guestOf(tenantId, uid) {
    const tenant = (await tenantRef(tenantId).get()).data();
    if (!tenant || ["deleted", "disabled", "blocked", "suspended"].includes(tenant.status)) {
      throw new HttpError(404, "Заведение сейчас не принимает заказы");
    }
    // Приложение гостя не входит в тариф заведения — как guestAppOn в правилах базы.
    if (tenant.guestAppOff === true) throw new HttpError(403, "Заказ из приложения в этом заведении недоступен");
    const own = await tenantRef(tenantId).collection("clients").doc(uid).get();
    let client = own.exists ? own.data() : null;
    if (!client && tenant.chainId) {
      const chain = await db().collection("chains").doc(tenant.chainId).collection("clients").doc(uid).get();
      client = chain.exists ? chain.data() : null;
    }
    if (!client) throw new HttpError(403, "Сначала откройте профиль в приложении заведения");
    return { tenant, client };
  }

  async function handleCreate(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const { tenantId } = body;
    checkTenantId(tenantId);
    const t = tenantRef(tenantId);
    const { tenant } = await guestOf(tenantId, decoded.uid);

    const venue = (await t.collection("meta").doc("venueProfile").get()).data() || {};
    if (venue.deliveryEnabled !== true) throw new HttpError(409, "Заведение сейчас не принимает заказы с собой и доставку");
    // Дистанционная продажа: гость должен видеть, у кого покупает (ст. 26.1
    // закона «О защите прав потребителей»).
    if (!sellerReady(venue)) throw new HttpError(409, "Заведение ещё не указало реквизиты продавца — заказ из приложения пока недоступен");
    const local = localNow(now(), tenant.timezone);
    const hours = openNow(venue.workingHours, local);
    if (!hours.open) {
      throw new HttpError(409, hours.today
        ? `Заведение сейчас закрыто — заказы принимаются с ${hours.today.split("–")[0]} (сегодня ${hours.today})`
        : "Сегодня заведение не работает — заказ можно оформить в рабочий день");
    }

    const orderType = body.orderType === "delivery" ? "delivery" : body.orderType === "takeaway" ? "takeaway" : "";
    if (!orderType) throw new HttpError(400, "Выберите: доставка или заберу сам");
    const name = clean(body.name, 60);
    if (name.length < 2) throw new HttpError(400, "Как к вам обращаться? Укажите имя");
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, "Проверьте телефон: нужен российский номер, +7 и 10 цифр");
    const addr = body.address && typeof body.address === "object" ? body.address : {};
    const street = clean(addr.street, 160);
    const parts = [
      street,
      clean(addr.flat, 20) && `кв./офис ${clean(addr.flat, 20)}`,
      clean(addr.entrance, 10) && `подъезд ${clean(addr.entrance, 10)}`,
      clean(addr.floor, 10) && `этаж ${clean(addr.floor, 10)}`,
      clean(addr.intercom, 20) && `домофон ${clean(addr.intercom, 20)}`,
    ].filter(Boolean);
    const address = orderType === "delivery" ? parts.join(", ").slice(0, 300) : "";
    if (orderType === "delivery" && street.length < 5) throw new HttpError(400, "Укажите адрес: улицу и дом");
    const comment = clean(body.comment, 300);
    const payMethod = body.payMethod === "online" ? "online" : "on_receipt";
    if (payMethod === "online" && !(await onlinePayReady(tenantId))) {
      throw new HttpError(409, "Онлайн-оплата в заведении сейчас не подключена — выберите оплату при получении");
    }

    const lines = Array.isArray(body.items) ? body.items : [];
    if (!lines.length) throw new HttpError(400, "Корзина пуста");
    if (lines.length > MAX_LINES) throw new HttpError(400, `В одном заказе не больше ${MAX_LINES} позиций`);
    for (const l of lines) {
      if (!l || typeof l.menuItemId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(l.menuItemId)) throw new HttpError(400, "В корзине неизвестная позиция");
    }
    const ids = [...new Set(lines.map((l) => l.menuItemId))];
    const docs = await Promise.all(ids.map((id) => t.collection("menuItems").doc(id).get()));
    const menu = Object.fromEntries(docs.filter((d) => d.exists).map((d) => [d.id, d.data()]));
    const catIds = [...new Set(Object.values(menu).map((m) => m.categoryId).filter(Boolean))];
    const cats = await Promise.all(catIds.map((id) => t.collection("menuCategories").doc(String(id)).get()));
    const categoryNames = Object.fromEntries(cats.map((c) => [c.id, String((c.data() || {}).name || "")]));
    let priced;
    try {
      priced = priceItems(lines, menu, categoryNames);
    } catch (e) {
      throw new HttpError(409, e.message);
    }
    if (!priced.items.length) {
      throw new HttpError(409, "Табак, кальяны и алкоголь не продаются с собой и с доставкой — добавьте другие позиции");
    }
    const total = round2(priced.items.reduce((a, i) => a + i.price * i.qty, 0));

    // Не больше двух незавершённых заказов и пяти в час с одного профиля —
    // защита от розыгрышей с чужими адресами.
    const mine = (await t.collection("sessions").where("clientUid", "==", decoded.uid).get()).docs
      .map((d) => d.data()).filter((s) => s.source === "app");
    if (mine.filter((s) => s.status === "active").length >= MAX_OPEN_ORDERS) {
      throw new HttpError(429, "У вас уже есть заказы в работе — дождитесь их или позвоните в заведение");
    }
    const hourAgo = Date.now() - 3600 * 1000;
    if (mine.filter((s) => (s.startTime?.toMillis?.() || 0) > hourAgo).length >= MAX_ORDERS_PER_HOUR) {
      throw new HttpError(429, "Слишком много заказов за час — попробуйте позже или позвоните в заведение");
    }

    const sessionRef = t.collection("sessions").doc();
    const sessionId = sessionRef.id;
    // Сначала — в базу в РФ. Не записалось — заказ не создаём.
    await recordContact(req, { tenantId, kind: "delivery", id: sessionId, name, phone, address });

    const ts = admin.firestore.Timestamp;
    const nowTs = ts.now();
    const label = orderType === "delivery" ? "Доставка" : "С собой";
    const tableRef = t.collection("tables").doc(TAKEAWAY_TABLE);
    // Порядковый номер заказа: один счётчик на заведение — с кассой
    // (FirestoreService.openSession), чтобы №12 не повторился.
    const counterRef = t.collection("settings").doc("orderCounter");
    let orderNo = 0;
    await db().runTransaction(async (tx) => {
      const table = (await tx.get(tableRef)).data();
      const counter = (await tx.get(counterRef)).data();
      orderNo = (Math.trunc(Number(counter?.last)) || 0) + 1;
      tx.set(counterRef, { last: orderNo }, { merge: true });
      const active = Array.isArray(table?.activeSessionIds) ? table.activeSessionIds.map(String) : [];
      tx.set(sessionRef, {
        tableId: TAKEAWAY_TABLE,
        tableName: label,
        employeeName: "Приложение гостя",
        employeeId: "",
        guestTag: "",
        orderType,
        orderNo,
        customerName: name,
        customerPhone: phone,
        ...(address ? { deliveryAddress: address } : {}),
        ...(comment ? { deliveryComment: comment } : {}),
        deliveryStatus: "new",
        source: "app",
        clientUid: decoded.uid,
        payMethod,
        appTotal: total,
        startTime: nowTs,
        plannedEnd: ts.fromMillis(nowTs.toMillis() + 3 * 3600 * 1000),
        refillCount: 0,
        refillHistory: [],
        discountCardId: "",
        discountPercent: 0,
        orderItems: [],
        status: "active",
        closedAt: null,
        paymentCash: 0,
        paymentCard: 0,
        paymentTerminal: 0,
        paymentComp: 0,
        guestContact: phone,
        closedWithoutPayment: false,
        receiptPrinted: false,
        fiscalReceiptPrinted: false,
        tipsCash: 0,
        tipsCard: 0,
        refunded: false,
        refundedAt: null,
      });
      if (table) {
        tx.update(tableRef, { activeSessionIds: [...active, sessionId], status: "occupied" });
      } else {
        tx.set(tableRef, {
          name: "С собой и доставка", x: 0, y: 0, seats: 0, maxOpenSessions: 200,
          activeSessionIds: [sessionId], status: "occupied",
        });
      }
      // Чек «за» гостем: по нему он видит статус и платит онлайн.
      tx.set(t.collection("sessionClaims").doc(sessionId), { uid: decoded.uid, tableId: TAKEAWAY_TABLE, claimedAt: nowTs, source: "app" });
      tx.set(t.collection("guestOrders").doc(), {
        sessionId,
        tableId: TAKEAWAY_TABLE,
        tableName: `${label} · ${name}`,
        clientUid: decoded.uid,
        guestName: name,
        items: priced.items,
        comment,
        targetPosition: "",
        orderType,
        status: "new",
        createdAt: nowTs,
      });
    });
    sendJson(res, 200, {
      sessionId,
      orderNo: String(orderNo),
      total,
      skipped: priced.banned,
    });
  }

  /** Гость отменяет свой заказ, пока его не подтвердили и не оплатили. */
  async function handleCancel(req, res) {
    const decoded = await verifyAuth(req);
    const { tenantId, sessionId } = await parseJsonBody(req);
    checkTenantId(tenantId);
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw new HttpError(400, "Не указан заказ");
    const t = tenantRef(tenantId);
    const ref = t.collection("sessions").doc(sessionId);
    const orders = await t.collection("guestOrders").where("sessionId", "==", sessionId).get();
    let problem = null;
    await db().runTransaction(async (tx) => {
      const s = (await tx.get(ref)).data();
      if (!s || s.clientUid !== decoded.uid || s.source !== "app") { problem = [404, "Заказ не найден"]; return; }
      if (s.status !== "active") { problem = [409, "Заказ уже закрыт"]; return; }
      if ((Number(s.guestPaidTotal) || 0) > 0) { problem = [409, "Заказ уже оплачен — для отмены позвоните в заведение"]; return; }
      if (flow.normalize(s.orderType, s.deliveryStatus) !== "new") {
        problem = [409, "Заказ уже готовят — для отмены позвоните в заведение"];
        return;
      }
      const tableRef = t.collection("tables").doc(TAKEAWAY_TABLE);
      const table = (await tx.get(tableRef)).data();
      const nowTs = admin.firestore.Timestamp.now();
      tx.update(ref, {
        status: "cancelled", deliveryStatus: "cancelled", cancelReason: "Отменён гостем",
        cancelledBy: "guest", cancelledAt: nowTs, closedAt: nowTs,
      });
      if (table) {
        const ids = (table.activeSessionIds || []).map(String).filter((id) => id !== sessionId);
        tx.update(tableRef, { activeSessionIds: ids, status: ids.length ? "occupied" : "free" });
      }
      for (const d of orders.docs) {
        if (d.data().status === "new") tx.update(d.ref, { status: "rejected", rejectReason: "Отменён гостем", handledAt: nowTs, handledBy: "Гость" });
      }
    });
    if (problem) throw new HttpError(problem[0], problem[1]);
    sendJson(res, 200, { ok: true });
  }

  return { handleCreate, handleCancel };
}

module.exports = { createGuestDelivery, remoteSaleBanned, priceItems, openNow, windowOf, localNow, normalizePhone };
