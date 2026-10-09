"use strict";
/**
 * Telegram-бот платформы для владельцев: утренние итоги вчерашней смены и
 * мгновенные сигналы о подозрительных действиях на кассе (удалили позицию
 * после отправки на кухню, закрыли стол без оплаты, возврат, большая
 * скидка).
 *
 * Подключение: владелец в кабинете жмёт «Подключить Telegram» → ссылка
 * t.me/<бот>?start=<код> → бот получает /start <код> и запоминает чат.
 * Бот один на платформу, токен — TELEGRAM_BOT_TOKEN в /etc/saas-gateway.env.
 * Без токена всё выключено, кабинет честно пишет, что бот не подключён.
 *
 * Данные: telegramTenants/{tenantId} {chats:[{id,name}], lastSummaryDay,
 * auditCursor}; telegramLinks/{code} — одноразовые коды на 30 минут.
 */
const crypto = require("crypto");
const { sessionBill } = require("./guest-pay");

const DAY_START_HOUR = 6; // рабочие сутки 06:00–06:00: ночная смена — один день
const SUMMARY_HOUR = 10; // когда присылать итоги
const ALERT_ACTIONS = new Set(["order_item_voided", "closed_without_payment", "refund", "discount_applied"]);
const BIG_DISCOUNT_PERCENT = 20;

const rub = (v) => `${Math.round(Number(v) || 0).toLocaleString("ru-RU")} ₽`;

/** Локальные дата и час в часовом поясе заведения. */
function localParts(date, tz) {
  const f = new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz || "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour };
}

/** Смещение пояса от UTC в минутах на момент [date]. */
function tzOffsetMin(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * Границы рабочих суток, которые закончились к моменту [now]: с 06:00
 * позавчера/вчера до 06:00 сегодня по местному времени. Возвращает ключ
 * дня (дата начала) и интервал в UTC.
 */
function lastBusinessDay(now, tz) {
  const lp = localParts(now, tz);
  // Сегодняшние 06:00 по местному времени.
  const off = tzOffsetMin(now, tz);
  let endUtc = Date.UTC(lp.y, lp.m - 1, lp.d, DAY_START_HOUR, 0, 0) - off * 60000;
  if (lp.h < DAY_START_HOUR) endUtc -= 24 * 3600 * 1000;
  const startUtc = endUtc - 24 * 3600 * 1000;
  const sp = localParts(new Date(startUtc + 60 * 60000), tz);
  const key = `${sp.y}-${String(sp.m).padStart(2, "0")}-${String(sp.d).padStart(2, "0")}`;
  return { key, start: new Date(startUtc), end: new Date(endUtc), label: `${String(sp.d).padStart(2, "0")}.${String(sp.m).padStart(2, "0")}` };
}

/** Итоги дня по закрытым чекам и журналу кассы — чистая функция для тестов. */
function buildSummary({ venueName, label, sessions, audit, excludeTobacco = true }) {
  let revenue = 0, checks = 0, cash = 0, card = 0, terminal = 0, comp = 0, guests = 0;
  let unpaid = 0, unpaidSum = 0, refunds = 0, refundSum = 0, takeaway = 0, delivery = 0, discount = 0;
  const items = new Map();
  for (const s of sessions) {
    const bill = sessionBill(s, excludeTobacco);
    if (s.refunded) { refunds++; refundSum += bill; continue; }
    if (s.closedWithoutPayment) { unpaid++; unpaidSum += bill; continue; }
    checks++;
    revenue += bill;
    cash += Number(s.paymentCash) || 0;
    card += Number(s.paymentCard) || 0;
    terminal += Number(s.paymentTerminal) || 0;
    comp += Number(s.paymentComp) || 0;
    guests += Number(s.guestsCount) || 0;
    if (s.orderType === "takeaway") takeaway++;
    if (s.orderType === "delivery") delivery++;
    const full = (s.orderItems || []).reduce((a, i) => a + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
    discount += Math.max(0, full - bill);
    for (const i of s.orderItems || []) {
      const k = i.name || "—";
      items.set(k, (items.get(k) || 0) + (Number(i.price) || 0) * (Number(i.qty) || 0));
    }
  }
  const voids = audit.filter((a) => a.action === "order_item_voided" || a.action === "order_item_removed");
  const voidSum = voids.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  const top = [...items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const lines = [
    `📊 ${venueName} — итоги ${label}`,
    "",
    `Выручка: ${rub(revenue)}`,
    `Чеков: ${checks}${checks ? ` · средний чек ${rub(revenue / checks)}` : ""}`,
  ];
  const pays = [
    cash ? `наличные ${rub(cash)}` : "",
    card ? `карта ${rub(card)}` : "",
    terminal ? `терминал/СБП ${rub(terminal)}` : "",
    comp ? `за счёт заведения ${rub(comp)}` : "",
  ].filter(Boolean);
  if (pays.length) lines.push(`Оплаты: ${pays.join(", ")}`);
  if (takeaway || delivery) lines.push(`С собой: ${takeaway} · доставка: ${delivery}`);
  if (discount >= 1) lines.push(`Скидки: ${rub(discount)}`);
  if (top.length) {
    lines.push("", "Топ продаж:");
    top.forEach(([n, v], idx) => lines.push(`${idx + 1}. ${n} — ${rub(v)}`));
  }
  const warn = [];
  if (voids.length) warn.push(`удалено позиций: ${voids.length} на ${rub(voidSum)}`);
  if (unpaid) warn.push(`закрыто без оплаты: ${unpaid} на ${rub(unpaidSum)}`);
  if (refunds) warn.push(`возвратов: ${refunds} на ${rub(refundSum)}`);
  if (warn.length) lines.push("", `⚠️ Обратите внимание: ${warn.join("; ")}`);
  if (!checks && !warn.length) lines.push("", "Продаж не было.");
  return lines.join("\n");
}

/** Текст сигнала по записи журнала; null — не сигналить. */
function alertText(venueName, a) {
  const who = a.employeeName ? ` — ${a.employeeName}` : "";
  const where = a.tableName ? `${a.tableName}: ` : "";
  const d = a.details || {};
  switch (a.action) {
    case "order_item_voided":
      return `⚠️ ${venueName}. ${where}отменена позиция «${d.item || "?"}»${d.qty ? ` ×${d.qty}` : ""} на ${rub(a.amount)}`
        + `${d.reason ? `. Причина: ${d.reason}` : ""}${d.approvedBy ? `. Подтвердил: ${d.approvedBy}` : ""}${who}`;
    case "closed_without_payment":
      return `⚠️ ${venueName}. ${where}стол закрыт без оплаты на ${rub(a.amount)}${d.reason ? `. Причина: ${d.reason}` : ""}${who}`;
    case "refund":
      return `↩️ ${venueName}. ${where}возврат ${rub(a.amount)}${d.reason ? `. Причина: ${d.reason}` : ""}${who}`;
    case "discount_applied": {
      const pct = Number(d.percent) || 0;
      if (pct < BIG_DISCOUNT_PERCENT) return null;
      return `🏷 ${venueName}. ${where}скидка ${pct}%${a.amount ? ` (${rub(a.amount)})` : ""}${who}`;
    }
    default:
      return null;
  }
}

function createTelegram({ db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, token, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  let botUsername = process.env.TELEGRAM_BOT_USERNAME || "";
  const enabled = () => !!token;

  async function api(method, params = {}) {
    const resp = await doFetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || resp.status}`);
    return data.result;
  }

  const send = (chatId, text) => api("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true })
    .catch((e) => console.error("telegram send:", e.message));

  async function ensureUsername() {
    if (botUsername || !enabled()) return botUsername;
    const me = await api("getMe");
    botUsername = me.username || "";
    return botUsername;
  }

  const linkRef = (code) => db().collection("telegramLinks").doc(code);
  const tgRef = (tenantId) => db().collection("telegramTenants").doc(tenantId);

  function checkTenantId(tenantId) {
    if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new HttpError(400, "Не указано заведение");
  }

  async function handleLinkCode(req, res) {
    const decoded = await verifyAuth(req);
    const { tenantId } = await parseJsonBody(req);
    checkTenantId(tenantId);
    await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);
    if (!enabled()) throw new HttpError(503, "Telegram-бот платформы ещё не подключён — напишите в поддержку");
    const name = await ensureUsername();
    const code = crypto.randomBytes(9).toString("hex");
    await linkRef(code).set({
      tenantId, uid: decoded.uid,
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 60 * 1000),
    });
    sendJson(res, 200, { link: `https://t.me/${name}?start=${code}` });
  }

  async function handleStatus(req, res) {
    const decoded = await verifyAuth(req);
    const { tenantId } = await parseJsonBody(req);
    checkTenantId(tenantId);
    await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);
    const d = (await tgRef(tenantId).get()).data() || {};
    sendJson(res, 200, { botEnabled: enabled(), chats: (d.chats || []).map((c) => c.name || "Чат") });
  }

  async function handleUnlink(req, res) {
    const decoded = await verifyAuth(req);
    const { tenantId } = await parseJsonBody(req);
    checkTenantId(tenantId);
    await requireTenantRole(tenantId, decoded.uid, ["owner", "admin"]);
    const d = (await tgRef(tenantId).get()).data() || {};
    await tgRef(tenantId).delete();
    for (const c of d.chats || []) send(c.id, "Уведомления заведения отключены в кабинете.");
    sendJson(res, 200, { ok: true });
  }

  async function onMessage(msg) {
    const chatId = msg.chat && msg.chat.id;
    const text = String(msg.text || "").trim();
    if (!chatId || !text.startsWith("/")) return;
    const [cmd, arg] = text.split(/\s+/, 2);
    if (cmd === "/start" && arg) {
      const ref = linkRef(arg.replace(/[^a-f0-9]/g, "").slice(0, 32) || "-");
      const link = (await ref.get()).data();
      if (!link || link.expiresAt.toMillis() < Date.now()) {
        return send(chatId, "Ссылка устарела. Нажмите «Подключить Telegram» в кабинете ещё раз.");
      }
      const tenant = (await db().collection("tenants").doc(link.tenantId).get()).data() || {};
      const name = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") || msg.chat.title || "Чат";
      await db().runTransaction(async (tx) => {
        const ref2 = tgRef(link.tenantId);
        const cur = (await tx.get(ref2)).data() || {};
        const chats = (cur.chats || []).filter((c) => c.id !== chatId).concat([{ id: chatId, name }]).slice(-10);
        tx.set(ref2, {
          chats,
          auditCursor: cur.auditCursor || admin.firestore.Timestamp.now(),
          lastSummaryDay: cur.lastSummaryDay || lastBusinessDay(new Date(), tenant.timezone).key,
        }, { merge: true });
        tx.delete(ref);
      });
      return send(chatId, `Готово: «${tenant.name || "заведение"}» подключено.\n\n`
        + `Каждое утро в ${SUMMARY_HOUR}:00 — итоги прошлой смены. Удаление позиций, закрытие без оплаты, возвраты `
        + `и скидки от ${BIG_DISCOUNT_PERCENT}% — сразу.\n\n/today — итоги прямо сейчас, /stop — отключить.`);
    }
    if (cmd === "/stop") {
      const snap = await db().collection("telegramTenants").get();
      for (const d of snap.docs) {
        const chats = (d.data().chats || []).filter((c) => c.id !== chatId);
        if (chats.length !== (d.data().chats || []).length) {
          if (chats.length) await d.ref.update({ chats }); else await d.ref.delete();
        }
      }
      return send(chatId, "Уведомления отключены. Подключить снова можно в кабинете.");
    }
    if (cmd === "/today") {
      const snap = await db().collection("telegramTenants").get();
      const mine = snap.docs.filter((d) => (d.data().chats || []).some((c) => c.id === chatId));
      if (!mine.length) return send(chatId, "Заведение не подключено. Нажмите «Подключить Telegram» в кабинете.");
      for (const d of mine) {
        const tenant = (await db().collection("tenants").doc(d.id).get()).data() || {};
        const lb = lastBusinessDay(new Date(), tenant.timezone);
        // Текущие сутки: от конца прошлых до сейчас.
        const text = await summaryFor(d.id, tenant, lb.end, new Date(), "сегодня (пока)");
        await send(chatId, text);
      }
      return;
    }
    if (cmd === "/start") {
      return send(chatId, "Это бот ZalPOS для владельцев. Подключите заведение кнопкой «Подключить Telegram» в кабинете.");
    }
  }

  async function summaryFor(tenantId, tenant, start, end, label) {
    const t = db().collection("tenants").doc(tenantId);
    const [ses, aud, loyalty] = await Promise.all([
      t.collection("sessions").where("closedAt", ">=", start).where("closedAt", "<", end).get(),
      t.collection("auditLog").where("createdAt", ">=", start).where("createdAt", "<", end).get(),
      t.collection("settings").doc("loyalty").get(),
    ]);
    const l = loyalty.data() || {};
    return buildSummary({
      venueName: tenant.name || "Заведение",
      label,
      sessions: ses.docs.map((d) => d.data()),
      audit: aud.docs.map((d) => d.data()),
      excludeTobacco: typeof l.excludeTobaccoFromPromo === "boolean" ? l.excludeTobaccoFromPromo : true,
    });
  }

  /** Раз в несколько минут: итоги тем, у кого наступило утро, и сигналы по журналу. */
  async function tick() {
    const snap = await db().collection("telegramTenants").get();
    for (const d of snap.docs) {
      const cfg = d.data();
      const chats = cfg.chats || [];
      if (!chats.length) continue;
      try {
        const tenant = (await db().collection("tenants").doc(d.id).get()).data() || {};
        if (tenant.status === "deleted" || tenant.status === "disabled") continue;
        const now = new Date();
        // Сигналы — новые записи журнала после курсора.
        const cursor = cfg.auditCursor || admin.firestore.Timestamp.now();
        const aud = await db().collection("tenants").doc(d.id).collection("auditLog")
          .where("createdAt", ">", cursor).orderBy("createdAt").limit(50).get();
        let last = cursor;
        for (const a of aud.docs) {
          const data = a.data();
          last = data.createdAt || last;
          if (!ALERT_ACTIONS.has(data.action)) continue;
          const text = alertText(tenant.name || "Заведение", data);
          if (text) for (const c of chats) await send(c.id, text);
        }
        const upd = {};
        if (aud.docs.length) upd.auditCursor = last;
        // Итоги — после SUMMARY_HOUR местного времени, раз за рабочие сутки.
        const lb = lastBusinessDay(now, tenant.timezone);
        if (localParts(now, tenant.timezone).h >= SUMMARY_HOUR && cfg.lastSummaryDay !== lb.key) {
          const text = await summaryFor(d.id, tenant, lb.start, lb.end, lb.label);
          for (const c of chats) await send(c.id, text);
          upd.lastSummaryDay = lb.key;
        }
        if (Object.keys(upd).length) await d.ref.update(upd);
      } catch (e) {
        console.error(`telegram tick ${d.id}:`, e.message || e);
      }
    }
  }

  let offset = 0;
  let stopped = false;
  async function pollLoop() {
    while (!stopped) {
      try {
        const updates = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
        for (const u of updates) {
          offset = u.update_id + 1;
          if (u.message) await onMessage(u.message).catch((e) => console.error("telegram message:", e.message));
        }
      } catch (e) {
        console.error("telegram poll:", e.message || e);
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
  }

  function start() {
    if (!enabled()) return;
    pollLoop();
    setInterval(() => tick().catch((e) => console.error("telegram tick:", e.message)), 2 * 60 * 1000);
  }

  return { handleLinkCode, handleStatus, handleUnlink, start, stop: () => { stopped = true; } };
}

module.exports = { createTelegram, buildSummary, alertText, lastBusinessDay, localParts };
