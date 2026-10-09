"use strict";
/**
 * Telegram-боты заведений. У каждого заведения свой бот (токен владелец
 * вводит в кабинете), свой чат владельца и своя рабочая группа сотрудников.
 *
 * Изоляция заведений:
 *  - Telegram шлёт обновления каждого бота на свой адрес
 *    /tgHook/<tenantId> с секретом этого заведения (заголовок
 *    X-Telegram-Bot-Api-Secret-Token) — чужой секрет не пройдёт;
 *  - отвечаем и пишем только токеном этого заведения и только в чаты,
 *    привязанные к нему одноразовым кодом из кабинета;
 *  - один бот (botId) — одно заведение: второй раз тот же токен не примем.
 *
 * Токен в базе — только зашифрованным (AES-256-GCM). Ключ живёт на сервере
 * в РФ: TELEGRAM_SECRET_KEY или файл /var/lib/zalpos/telegram.key (0600).
 *
 * 152-ФЗ: в Telegram не уходят имена и телефоны гостей и адреса. Карточка
 * доставки — номер заказа, позиции, сумма, статус. Адрес курьер открывает
 * кнопкой: подписанная ссылка на наш сервер в РФ, действует 12 часов.
 *
 * Что умеет:
 *  - группа сотрудников: карточка каждого заказа с собой/доставки с
 *    кнопками «следующий шаг», «Назначить курьера», «Адрес»; статус
 *    меняется в кассе сразу (Firestore), а нажатие на кассе обновляет
 *    карточку;
 *  - чат владельца: меню отчётов (выручка, средний чек, доли цехов,
 *    посадка, смена, доставка), начало и конец смен, сигналы об отменах,
 *    закрытии без оплаты, возвратах и больших скидках, итоги в 10:00.
 *
 * Данные: telegramBots/{tenantId} (настройки), …/cards/{sessionId}
 * (карточки доставки), telegramLinks/{code} (коды привязки, 30 минут).
 */
const crypto = require("crypto");
const fs = require("fs");
const { sessionBill } = require("./guest-pay");
const flow = require("./delivery-flow");

// Адрес Bot API. С серверов в РФ api.telegram.org бывает недоступен —
// тогда сюда ставится свой ретранслятор (TELEGRAM_API_BASE в
// /etc/saas-gateway.env), например Cloudflare Worker, пересылающий запросы
// на api.telegram.org как есть.
const API_BASE = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
// Куда Telegram шлёт нажатия кнопок и сообщения. Если до сервера в РФ
// Telegram не достучится, сюда ставится тот же ретранслятор
// (TELEGRAM_HOOK_BASE=<адрес ретранслятора>/hook) — он перешлёт на /tgHook.
const HOOK_BASE = (process.env.TELEGRAM_HOOK_BASE || "").replace(/\/+$/, "");
const API_TIMEOUT_MS = 10000;

class TelegramUnreachable extends Error {}

const DAY_START_HOUR = 6; // рабочие сутки 06:00–06:00: ночная смена — один день
const SUMMARY_HOUR = 10;
const BIG_DISCOUNT_PERCENT = 20;
const ADDRESS_LINK_TTL_MS = 12 * 3600 * 1000;
const TAKEAWAY_TABLE = "takeaway";
const POSITIONS = { waiter: "официант", hookah_master: "кальянщик", bartender: "бармен", universal: "универсал" };

const MENU = {
  revenue: "💰 Выручка сегодня",
  avg: "🧾 Средний чек",
  kinds: "🍽 Кухня · Бар · Кальяны",
  seating: "🪑 Посадка",
  shift: "👥 Текущая смена",
  delivery: "🛵 Доставка",
};
const MENU_KEYBOARD = {
  keyboard: [
    [{ text: MENU.revenue }, { text: MENU.avg }],
    [{ text: MENU.kinds }, { text: MENU.seating }],
    [{ text: MENU.shift }, { text: MENU.delivery }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const rub = (v) => `${Math.round(Number(v) || 0).toLocaleString("ru-RU")} ₽`;
const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : v instanceof Date ? v : null);

// ---------------------------------------------------------------- шифрование

/** AES-256-GCM: "v1:" + base64(iv | tag | шифротекст). */
function encrypt(key, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
}

function decrypt(key, enc) {
  const raw = Buffer.from(String(enc).replace(/^v1:/, ""), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

let cachedKey = null;
/** Ключ шифрования токенов: TELEGRAM_SECRET_KEY в /etc/saas-gateway.env
 *  (создаётся задачей обслуживания сервера) или файл TELEGRAM_KEY_FILE.
 *  Сами ключ не создаём: потерянный ключ — нерасшифруемые токены. */
function secretKey() {
  if (cachedKey) return cachedKey;
  const env = (process.env.TELEGRAM_SECRET_KEY || "").trim();
  if (env) return (cachedKey = crypto.createHash("sha256").update(env).digest());
  const file = process.env.TELEGRAM_KEY_FILE;
  if (file) {
    const k = fs.readFileSync(file);
    if (k.length === 32) return (cachedKey = k);
  }
  throw new Error("TELEGRAM_SECRET_KEY не задан на сервере");
}

/** Подпись ссылки на адрес доставки: заведение, заказ, срок. */
function addressSig(key, tenantId, sessionId, exp) {
  return crypto.createHmac("sha256", key).update(`addr|${tenantId}|${sessionId}|${exp}`).digest("hex").slice(0, 32);
}

function sigOk(given, expected) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- время

function localParts(date, tz) {
  const f = new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz || "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute };
}

function tzOffsetMin(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime()) / 60000);
}

/** Начало текущих рабочих суток (06:00 по местному времени). */
function businessDayStart(now, tz) {
  const lp = localParts(now, tz);
  let start = Date.UTC(lp.y, lp.m - 1, lp.d, DAY_START_HOUR, 0, 0) - tzOffsetMin(now, tz) * 60000;
  if (lp.h < DAY_START_HOUR) start -= 24 * 3600 * 1000;
  return new Date(start);
}

/** Закончившиеся рабочие сутки: ключ (дата начала), интервал, подпись. */
function lastBusinessDay(now, tz) {
  const end = businessDayStart(now, tz);
  const start = new Date(end.getTime() - 24 * 3600 * 1000);
  const sp = localParts(new Date(start.getTime() + 3600000), tz);
  const dd = String(sp.d).padStart(2, "0");
  const mm = String(sp.m).padStart(2, "0");
  return { key: `${sp.y}-${mm}-${dd}`, start, end, label: `${dd}.${mm}` };
}

const hhmm = (date, tz) => {
  const p = localParts(date, tz);
  return `${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`;
};

// ---------------------------------------------------------------- тексты (чистые функции)

const orderNo = (sessionId) => String(sessionId).slice(-6).toUpperCase();

/** Деньги чеков: выручка, чеки, оплаты, доли цехов. */
function salesStats(sessions, excludeTobacco = true) {
  const st = { revenue: 0, checks: 0, cash: 0, card: 0, terminal: 0, comp: 0, unpaid: 0, unpaidSum: 0,
    refunds: 0, refundSum: 0, discount: 0, takeaway: 0, delivery: 0, kinds: { kitchen: 0, bar: 0, hookah: 0 }, items: new Map() };
  for (const s of sessions) {
    const bill = sessionBill(s, excludeTobacco);
    if (s.refunded) { st.refunds++; st.refundSum += bill; continue; }
    if (s.closedWithoutPayment) { st.unpaid++; st.unpaidSum += bill; continue; }
    st.checks++;
    st.revenue += bill;
    st.cash += Number(s.paymentCash) || 0;
    st.card += Number(s.paymentCard) || 0;
    st.terminal += Number(s.paymentTerminal) || 0;
    st.comp += Number(s.paymentComp) || 0;
    if (s.orderType === "takeaway") st.takeaway++;
    if (s.orderType === "delivery") st.delivery++;
    let full = 0;
    for (const i of s.orderItems || []) {
      const sum = (Number(i.price) || 0) * (Number(i.qty) || 0);
      full += sum;
      const kind = i.kind === "hookah" || i.kind === "bar" ? i.kind : "kitchen";
      st.kinds[kind] += sum;
      const name = i.name || "—";
      st.items.set(name, (st.items.get(name) || 0) + sum);
    }
    st.discount += Math.max(0, full - bill);
  }
  return st;
}

function buildSummary({ venueName, label, sessions, audit, excludeTobacco = true }) {
  const st = salesStats(sessions, excludeTobacco);
  const lines = [
    `📊 ${venueName} — итоги ${label}`,
    "",
    `Выручка: ${rub(st.revenue)}`,
    `Чеков: ${st.checks}${st.checks ? ` · средний чек ${rub(st.revenue / st.checks)}` : ""}`,
  ];
  const pays = [
    st.cash ? `наличные ${rub(st.cash)}` : "",
    st.card ? `карта ${rub(st.card)}` : "",
    st.terminal ? `терминал/СБП ${rub(st.terminal)}` : "",
    st.comp ? `за счёт заведения ${rub(st.comp)}` : "",
  ].filter(Boolean);
  if (pays.length) lines.push(`Оплаты: ${pays.join(", ")}`);
  if (st.takeaway || st.delivery) lines.push(`С собой: ${st.takeaway} · доставка: ${st.delivery}`);
  if (st.discount >= 1) lines.push(`Скидки: ${rub(st.discount)}`);
  const top = [...st.items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) {
    lines.push("", "Топ продаж:");
    top.forEach(([n, v], idx) => lines.push(`${idx + 1}. ${n} — ${rub(v)}`));
  }
  const voids = audit.filter((a) => a.action === "order_item_voided" || a.action === "order_item_removed");
  const voidSum = voids.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  const warn = [];
  if (voids.length) warn.push(`удалено позиций: ${voids.length} на ${rub(voidSum)}`);
  if (st.unpaid) warn.push(`закрыто без оплаты: ${st.unpaid} на ${rub(st.unpaidSum)}`);
  if (st.refunds) warn.push(`возвратов: ${st.refunds} на ${rub(st.refundSum)}`);
  if (warn.length) lines.push("", `⚠️ Обратите внимание: ${warn.join("; ")}`);
  if (!st.checks && !warn.length) lines.push("", "Продаж не было.");
  return lines.join("\n");
}

/** Сигнал по записи журнала кассы; null — не сигналить. Имён гостей нет. */
function alertText(venueName, a) {
  const who = a.employeeName ? ` — ${a.employeeName}` : "";
  const where = a.tableName ? `${a.tableName}: ` : "";
  const d = a.details || {};
  switch (a.action) {
    case "order_item_voided":
      return `⚠️ ${venueName}. ${where}отменена позиция «${d.item || "?"}»${d.qty ? ` ×${d.qty}` : ""} на ${rub(a.amount)}`
        + `${d.reason ? `. Причина: ${d.reason}` : ""}${d.approvedBy ? `. Подтвердил: ${d.approvedBy}` : ""}${who}`;
    case "order_item_removed":
      return `⚠️ ${venueName}. ${where}удалена позиция «${d.item || "?"}»${d.qty ? ` ×${d.qty}` : ""} на ${rub(a.amount)}${who}`;
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

/** Карточка заказа с собой/доставки — без имени, телефона и адреса гостя. */
/**
 * Текст карточки. Ни имени, ни телефона, ни адреса гостя (152-ФЗ) — их
 * видит касса; комментарий гостя тоже не пересылаем: в нём бывают контакты.
 * pendingItems — позиции заказа из приложения, ещё не подтверждённого.
 */
function deliveryCardText(s, tz, pendingItems = []) {
  const type = s.orderType === "delivery" ? "delivery" : "takeaway";
  const confirmed = s.orderItems || [];
  const items = confirmed.length ? confirmed : pendingItems;
  const qty = items.reduce((a, i) => a + (Number(i.qty) || 0), 0);
  const total = confirmed.length
    ? sessionBill(s)
    : Math.round(items.reduce((a, i) => a + (Number(i.price) || 0) * (Number(i.qty) || 0), 0) * 100) / 100;
  const app = s.source === "app";
  const lines = [
    `${type === "delivery" ? "🛵 Доставка" : "🥡 С собой"} №${orderNo(s.id)}${app ? " · 📱 из приложения" : ""}`,
    `Статус: ${flow.label(type, s.deliveryStatus)}`,
    `Позиций: ${qty} · ${rub(total)}`,
  ];
  const paid = Number(s.guestPaidTotal) || 0;
  if (paid > 0) lines.push(`💳 Оплачено онлайн: ${rub(paid)}`);
  else if (s.payMethod === "online") lines.push("Оплата: онлайн после подтверждения");
  else if (s.payMethod === "on_receipt") lines.push("Оплата: при получении");
  if (app && flow.normalize(type, s.deliveryStatus) === "new") {
    lines.push("☎️ Позвоните гостю с кассы и подтвердите заказ — телефон там");
  }
  if (items.length) {
    lines.push(items.slice(0, 15).map((i) => `• ${i.name}${i.mods && i.mods.length ? ` (${i.mods.join(", ")})` : ""} ×${i.qty}`).join("\n"));
    if (items.length > 15) lines.push(`…и ещё ${items.length - 15}`);
  }
  if (s.courierName) lines.push(`Курьер: ${s.courierName}`);
  const start = toDate(s.startTime);
  if (start) lines.push(`Принят в ${hhmm(start, tz)}`);
  return lines.join("\n");
}

function deliveryKeyboard(s, addressUrl) {
  const type = s.orderType === "delivery" ? "delivery" : "takeaway";
  const rows = [];
  // Заказ из приложения подтверждают на кассе после звонка гостю.
  const awaitingCall = s.source === "app" && flow.normalize(type, s.deliveryStatus) === "new";
  const next = awaitingCall ? null : flow.next(type, s.deliveryStatus);
  if (next) rows.push([{ text: `▶️ ${flow.actionLabel(type, s.deliveryStatus)}`, callback_data: `s:${s.id}:${next}` }]);
  if (type === "delivery") {
    const row = [];
    if (next && next !== "done") row.push({ text: "🚴 Назначить курьера", callback_data: `c:${s.id}` });
    if (addressUrl) row.push({ text: "📍 Адрес", url: addressUrl });
    if (row.length) rows.push(row);
  }
  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------- модуль

function createTelegram({ db, admin, verifyAuth, parseJsonBody, readBody, sendJson, HttpError, requireTenantRole, publicUrl, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const botsCol = () => db().collection("telegramBots");
  const tenantRef = (t) => db().collection("tenants").doc(t);
  const linkRef = (code) => db().collection("telegramLinks").doc(code);

  /** tenantId → { token, cfg, unsubs, startedAt } */
  const bots = new Map();

  async function api(token, method, params = {}) {
    let resp;
    try {
      resp = await doFetch(`${API_BASE}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        // Недоступный Telegram не должен подвешивать шлюз и очередь сообщений.
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (e) {
      throw new TelegramUnreachable(`Telegram недоступен: ${e.message || e}`);
    }
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || resp.status}`);
    return data.result;
  }

  const say = (bot, chatId, text, extra = {}) => api(bot.token, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...extra })
    .catch((e) => console.error(`telegram send (${bot.tenantId}):`, e.message));

  function checkTenantId(tenantId) {
    if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new HttpError(400, "Не указано заведение");
  }

  async function guard(req) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    checkTenantId(body.tenantId);
    await requireTenantRole(body.tenantId, decoded.uid, ["owner", "admin"]);
    return { decoded, body };
  }

  const hookUrl = (tenantId) => (HOOK_BASE ? `${HOOK_BASE}/${tenantId}` : `${publicUrl}/tgHook/${tenantId}`);

  // ------------------------------------------------------------ кабинет

  /** Владелец вводит токен своего бота: проверяем, шифруем, ставим webhook. */
  async function handleSetup(req, res) {
    const { body } = await guard(req);
    const { tenantId } = body;
    const token = String(body.token || "").trim();
    if (!/^\d{5,15}:[A-Za-z0-9_-]{30,50}$/.test(token)) throw new HttpError(400, "Это не похоже на токен бота — скопируйте его из @BotFather целиком");
    let me;
    try {
      me = await api(token, "getMe");
    } catch (e) {
      if (e instanceof TelegramUnreachable) {
        throw new HttpError(503, "Сервер сейчас не может достучаться до Telegram — попробуйте позже или напишите в поддержку");
      }
      throw new HttpError(400, "Telegram не принял токен — проверьте, что скопировали его целиком и бот не удалён");
    }
    const taken = await botsCol().where("botId", "==", me.id).limit(2).get();
    if (taken.docs.some((d) => d.id !== tenantId)) {
      throw new HttpError(409, "Этот бот уже подключён к другому заведению — создайте для этого заведения отдельного бота");
    }
    let key;
    try {
      key = secretKey();
    } catch (_) {
      throw new HttpError(503, "Подключение ботов на сервере ещё настраивается — попробуйте через несколько минут");
    }
    const ref = botsCol().doc(tenantId);
    const prev = (await ref.get()).data() || {};
    const hookSecret = crypto.randomBytes(24).toString("hex");
    await api(token, "setWebhook", {
      url: hookUrl(tenantId),
      secret_token: hookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    const sameBot = prev.botId === me.id;
    await ref.set({
      tokenEnc: encrypt(key, token),
      botId: me.id,
      username: me.username || "",
      hookSecret,
      hookUrl: hookUrl(tenantId),
      ownerChats: sameBot ? prev.ownerChats || [] : [],
      staffChat: sameBot ? prev.staffChat || null : null,
      notify: prev.notify || { delivery: true, shifts: true, alerts: true, summary: true },
      auditCursor: prev.auditCursor || admin.firestore.Timestamp.now(),
      lastSummaryDay: prev.lastSummaryDay || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    sendJson(res, 200, { username: me.username || "" });
  }

  async function handleStatus(req, res) {
    const { body } = await guard(req);
    const d = (await botsCol().doc(body.tenantId).get()).data();
    if (!d) return sendJson(res, 200, { configured: false });
    sendJson(res, 200, {
      configured: true,
      username: d.username || "",
      owners: (d.ownerChats || []).map((c) => c.name || "Чат"),
      staffChat: d.staffChat ? d.staffChat.title || "Группа" : "",
      notify: d.notify || {},
    });
  }

  /** Код привязки: kind 'owner' — личный чат, 'staff' — рабочая группа. */
  async function handleLinkCode(req, res) {
    const { body } = await guard(req);
    const kind = body.kind === "staff" ? "staff" : "owner";
    const d = (await botsCol().doc(body.tenantId).get()).data();
    if (!d) throw new HttpError(409, "Сначала подключите бота заведения");
    const code = crypto.randomBytes(9).toString("hex");
    await linkRef(code).set({
      tenantId: body.tenantId, kind,
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 60 * 1000),
    });
    const link = kind === "staff"
      ? `https://t.me/${d.username}?startgroup=${code}`
      : `https://t.me/${d.username}?start=${code}`;
    sendJson(res, 200, { link });
  }

  async function handleNotify(req, res) {
    const { body } = await guard(req);
    const n = body.notify || {};
    const notify = {
      delivery: n.delivery !== false, shifts: n.shifts !== false, alerts: n.alerts !== false, summary: n.summary !== false,
    };
    await botsCol().doc(body.tenantId).update({ notify });
    sendJson(res, 200, { notify });
  }

  async function handleUnlink(req, res) {
    const { body } = await guard(req);
    const ref = botsCol().doc(body.tenantId);
    const d = (await ref.get()).data();
    if (d) {
      try {
        await api(decrypt(secretKey(), d.tokenEnc), "deleteWebhook", { drop_pending_updates: true });
      } catch (_) { /* бот мог быть удалён в BotFather — всё равно отключаем */ }
      const cards = await ref.collection("cards").get();
      for (const c of cards.docs) await c.ref.delete();
      await ref.delete();
    }
    sendJson(res, 200, { ok: true });
  }

  /** Адрес доставки — страница на нашем сервере в РФ по подписанной ссылке. */
  async function handleAddress(req, res) {
    const u = new URL(req.url, "http://x");
    const t = u.searchParams.get("t") || "";
    const s = u.searchParams.get("s") || "";
    const exp = Number(u.searchParams.get("e")) || 0;
    const page = (code, html) => {
      res.writeHead(code, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
        "Referrer-Policy": "no-referrer",
      });
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Адрес доставки</title><body style="font:18px/1.5 system-ui,sans-serif;margin:24px;max-width:520px">${html}</body>`);
    };
    const esc = (v) => String(v || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(t) || !/^[A-Za-z0-9_-]{1,128}$/.test(s) || exp < Date.now()
        || !sigOk(u.searchParams.get("k"), addressSig(secretKey(), t, s, exp))) {
      return page(403, "<p>Ссылка устарела или неверна. Откройте адрес из свежей карточки заказа.</p>");
    }
    const ses = (await tenantRef(t).collection("sessions").doc(s).get()).data();
    if (!ses || ses.orderType !== "delivery") return page(404, "<p>Заказ не найден.</p>");
    const phone = String(ses.customerPhone || "");
    page(200, `<h2 style="margin:0 0 12px">Доставка №${esc(orderNo(s))}</h2>
<p><b>Адрес:</b><br>${esc(ses.deliveryAddress) || "не указан"}</p>
${phone ? `<p><b>Телефон:</b> <a href="tel:${esc(phone.replace(/[^+\d]/g, ""))}">${esc(phone)}</a></p>` : ""}
${ses.guestTag ? `<p><b>Имя:</b> ${esc(ses.guestTag)}</p>` : ""}
${ses.deliveryAddress ? `<p><a href="https://yandex.ru/maps/?text=${encodeURIComponent(ses.deliveryAddress)}">Открыть на карте</a></p>` : ""}`);
  }

  function addressUrl(tenantId, sessionId) {
    const exp = Date.now() + ADDRESS_LINK_TTL_MS;
    const k = addressSig(secretKey(), tenantId, sessionId, exp);
    return `${publicUrl}/deliveryAddress?t=${encodeURIComponent(tenantId)}&s=${encodeURIComponent(sessionId)}&e=${exp}&k=${k}`;
  }

  // ------------------------------------------------------------ webhook

  async function handleHook(req, res, tenantId) {
    const bot = bots.get(tenantId);
    const given = req.headers["x-telegram-bot-api-secret-token"];
    if (!bot || !sigOk(given, bot.cfg.hookSecret)) {
      res.writeHead(403);
      return res.end();
    }
    let update;
    try {
      update = JSON.parse(await readBody(req));
    } catch (_) {
      res.writeHead(200);
      return res.end();
    }
    // Отвечаем сразу: Telegram ждёт ответ и иначе пришлёт повтор.
    res.writeHead(200);
    res.end();
    try {
      if (update.callback_query) await onCallback(bot, update.callback_query);
      else if (update.message) await onMessage(bot, update.message);
    } catch (e) {
      console.error(`telegram update (${tenantId}):`, e.message || e);
    }
  }

  const isOwnerChat = (bot, chatId) => (bot.cfg.ownerChats || []).some((c) => c.id === chatId);
  const isStaffChat = (bot, chatId) => !!bot.cfg.staffChat && bot.cfg.staffChat.id === chatId;

  async function onMessage(bot, msg) {
    const chat = msg.chat || {};
    const text = String(msg.text || "").trim();
    if (!chat.id || !text) return;
    const group = chat.type === "group" || chat.type === "supergroup";
    const [cmdRaw, arg] = text.split(/\s+/, 2);
    const cmd = cmdRaw.replace(/@\w+$/, "");

    if (cmd === "/start" && arg) {
      const ref = linkRef(arg.replace(/[^a-f0-9]/g, "").slice(0, 32) || "-");
      const link = (await ref.get()).data();
      if (!link || link.tenantId !== bot.tenantId || link.expiresAt.toMillis() < Date.now()) {
        return say(bot, chat.id, "Ссылка устарела. Нажмите кнопку подключения в кабинете ещё раз.");
      }
      const venue = (await tenantRef(bot.tenantId).get()).data() || {};
      if (link.kind === "staff") {
        if (!group) return say(bot, chat.id, "Эту ссылку нужно открыть, добавляя бота в рабочую группу сотрудников.");
        await botsCol().doc(bot.tenantId).update({ staffChat: { id: chat.id, title: chat.title || "Группа" } });
        await ref.delete();
        return say(bot, chat.id, `Группа подключена к «${venue.name || "заведению"}». Сюда будут приходить заказы с собой и доставки — с кнопками статусов.`);
      }
      if (group) return say(bot, chat.id, "Эта ссылка — для личного чата владельца, а не для группы.");
      const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ") || "Владелец";
      await db().runTransaction(async (tx) => {
        const r = botsCol().doc(bot.tenantId);
        const cur = (await tx.get(r)).data() || {};
        const owners = (cur.ownerChats || []).filter((c) => c.id !== chat.id).concat([{ id: chat.id, name }]).slice(-5);
        tx.update(r, { ownerChats: owners });
        tx.delete(ref);
      });
      return say(bot, chat.id, `Готово: «${venue.name || "заведение"}» подключено.\n\n`
        + `Каждое утро в ${SUMMARY_HOUR}:00 — итоги прошлой смены. Начало и конец смен, отмены позиций, `
        + `закрытие без оплаты, возвраты и скидки от ${BIG_DISCOUNT_PERCENT}% — сразу. Отчёты — кнопками ниже.`,
      { reply_markup: MENU_KEYBOARD });
    }

    if (cmd === "/stop" && !group && isOwnerChat(bot, chat.id)) {
      await db().runTransaction(async (tx) => {
        const r = botsCol().doc(bot.tenantId);
        const cur = (await tx.get(r)).data() || {};
        tx.update(r, { ownerChats: (cur.ownerChats || []).filter((c) => c.id !== chat.id) });
      });
      return say(bot, chat.id, "Уведомления отключены. Подключить снова можно в кабинете.", { reply_markup: { remove_keyboard: true } });
    }

    if (group) return; // в группе — только кнопки карточек
    if (!isOwnerChat(bot, chat.id)) {
      return say(bot, chat.id, "Это бот заведения. Доступ выдаёт владелец в кабинете ZalPOS → Настройки → Telegram.");
    }
    const report = REPORTS[Object.keys(MENU).find((k) => MENU[k] === text)];
    if (report) return say(bot, chat.id, await report(bot), { reply_markup: MENU_KEYBOARD });
    if (cmd === "/start" || cmd === "/menu") return say(bot, chat.id, "Выберите отчёт:", { reply_markup: MENU_KEYBOARD });
  }

  async function onCallback(bot, q) {
    const chatId = q.message && q.message.chat && q.message.chat.id;
    const answer = (text) => api(bot.token, "answerCallbackQuery", { callback_query_id: q.id, text: text || "" }).catch(() => {});
    if (!chatId || (!isStaffChat(bot, chatId) && !isOwnerChat(bot, chatId))) return answer("Нет доступа");
    const [kind, sessionId, arg] = String(q.data || "").split(":");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId || "")) return answer();
    const sesRef = tenantRef(bot.tenantId).collection("sessions").doc(sessionId);
    const who = [q.from && q.from.first_name, q.from && q.from.last_name].filter(Boolean).join(" ") || "Сотрудник";

    if (kind === "s") {
      let result = "";
      await db().runTransaction(async (tx) => {
        const s = (await tx.get(sesRef)).data();
        const inWork = s && (s.status === "active" || s.deliveryOpen === true);
        if (!s || !inWork || s.tableId !== TAKEAWAY_TABLE) { result = "Заказ уже закрыт"; return; }
        const type = s.orderType === "delivery" ? "delivery" : "takeaway";
        if (s.source === "app" && flow.normalize(type, s.deliveryStatus) === "new") {
          result = "Подтвердите на кассе после звонка гостю";
          return;
        }
        if (!flow.canMove(type, s.deliveryStatus, arg)) {
          result = `Статус уже «${flow.label(type, s.deliveryStatus)}»`;
          return;
        }
        const patch = { deliveryStatus: arg, deliveryStatusAt: admin.firestore.Timestamp.now() };
        if (arg === "done") patch.deliveryOpen = false;
        if (arg === "courier" && !s.courierName) patch.courierName = who;
        tx.update(sesRef, patch);
        result = flow.label(type, arg);
      });
      // Карточку обновит слушатель чеков — тот же путь, что и для нажатий на кассе.
      return answer(result);
    }

    if (kind === "c") {
      const team = await onShiftStaff(bot.tenantId);
      const rows = team.slice(0, 8).map((m) => [{ text: `${m.name}${m.position ? ` · ${POSITIONS[m.position] || m.position}` : ""}`, callback_data: `k:${sessionId}:${m.id}`.slice(0, 64) }]);
      rows.push([{ text: "🙋 Я везу", callback_data: `k:${sessionId}:me` }]);
      rows.push([{ text: "← Назад", callback_data: `b:${sessionId}` }]);
      await api(bot.token, "editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: rows } }).catch(() => {});
      return answer("Кто везёт?");
    }

    if (kind === "k" || kind === "b") {
      if (kind === "k") {
        let name = who;
        if (arg !== "me") {
          const m = (await onShiftStaff(bot.tenantId)).find((x) => x.id === arg);
          if (m) name = m.name;
        }
        await db().runTransaction(async (tx) => {
          const s = (await tx.get(sesRef)).data();
          if (!s || !(s.status === "active" || s.deliveryOpen === true)) return;
          const patch = { courierName: name };
          // Готовый к передаче заказ сразу уходит «у курьера».
          if (s.orderType === "delivery" && flow.canMove("delivery", s.deliveryStatus, "courier") && s.deliveryStatus === "cooking") {
            Object.assign(patch, { deliveryStatus: "courier", deliveryStatusAt: admin.firestore.Timestamp.now() });
          }
          tx.update(sesRef, patch);
        });
      }
      const s = (await sesRef.get()).data();
      if (s) await refreshCard(bot, { id: sessionId, ...s }, true);
      return answer(kind === "k" ? "Курьер назначен" : "");
    }
    return answer();
  }

  // ------------------------------------------------------------ отчёты

  async function venueOf(tenantId) {
    return (await tenantRef(tenantId).get()).data() || {};
  }

  async function loyaltyExclude(tenantId) {
    const l = (await tenantRef(tenantId).collection("settings").doc("loyalty").get()).data() || {};
    return typeof l.excludeTobaccoFromPromo === "boolean" ? l.excludeTobaccoFromPromo : true;
  }

  async function closedSince(tenantId, start, end = new Date()) {
    const snap = await tenantRef(tenantId).collection("sessions")
      .where("closedAt", ">=", start).where("closedAt", "<", end).get();
    return snap.docs.map((d) => d.data());
  }

  async function activeSessions(tenantId) {
    const snap = await tenantRef(tenantId).collection("sessions").where("status", "==", "active").get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  async function onShiftStaff(tenantId) {
    const snap = await tenantRef(tenantId).collection("staffShifts").where("status", "==", "open").get();
    const out = [];
    for (const d of snap.docs) {
      const s = d.data();
      const emp = s.employeeId ? (await tenantRef(tenantId).collection("employees").doc(s.employeeId).get()).data() || {} : {};
      out.push({ id: s.employeeId || d.id, name: s.employeeName || emp.name || "Сотрудник", position: emp.position || "", since: toDate(s.startedAt) });
    }
    return out.sort((a, b) => (a.since || 0) - (b.since || 0));
  }

  const REPORTS = {
    async revenue(bot) {
      const venue = await venueOf(bot.tenantId);
      const st = salesStats(await closedSince(bot.tenantId, businessDayStart(new Date(), venue.timezone)), await loyaltyExclude(bot.tenantId));
      const open = await activeSessions(bot.tenantId);
      const openSum = open.reduce((a, s) => a + sessionBill(s), 0);
      return [
        `💰 Выручка сегодня (с ${DAY_START_HOUR}:00): ${rub(st.revenue)}`,
        `Чеков закрыто: ${st.checks}`,
        `Наличные ${rub(st.cash)} · карта ${rub(st.card)} · терминал/СБП ${rub(st.terminal)}`,
        st.comp ? `За счёт заведения: ${rub(st.comp)}` : "",
        `Открыто сейчас: ${open.length} чек. на ${rub(openSum)}`,
      ].filter(Boolean).join("\n");
    },
    async avg(bot) {
      const venue = await venueOf(bot.tenantId);
      const ex = await loyaltyExclude(bot.tenantId);
      const now = new Date();
      const start = businessDayStart(now, venue.timezone);
      const today = salesStats(await closedSince(bot.tenantId, start, now), ex);
      // Вчера к этому же часу — честное сравнение незаконченного дня.
      const yStart = new Date(start.getTime() - 24 * 3600 * 1000);
      const yesterday = salesStats(await closedSince(bot.tenantId, yStart, new Date(now.getTime() - 24 * 3600 * 1000)), ex);
      const a = today.checks ? today.revenue / today.checks : 0;
      const b = yesterday.checks ? yesterday.revenue / yesterday.checks : 0;
      const diff = b ? Math.round(((a - b) / b) * 100) : null;
      return `🧾 Средний чек сегодня: ${rub(a)} (${today.checks} чек.)\n`
        + `Вчера к этому часу: ${rub(b)} (${yesterday.checks} чек.)${diff === null ? "" : `\nИзменение: ${diff > 0 ? "+" : ""}${diff}%`}`;
    },
    async kinds(bot) {
      const venue = await venueOf(bot.tenantId);
      const st = salesStats(await closedSince(bot.tenantId, businessDayStart(new Date(), venue.timezone)), await loyaltyExclude(bot.tenantId));
      const total = st.kinds.kitchen + st.kinds.bar + st.kinds.hookah;
      const pct = (v) => (total ? Math.round((v / total) * 100) : 0);
      return [
        "🍽 Доли выручки сегодня:",
        `Кухня: ${rub(st.kinds.kitchen)} · ${pct(st.kinds.kitchen)}%`,
        `Бар: ${rub(st.kinds.bar)} · ${pct(st.kinds.bar)}%`,
        st.kinds.hookah ? `Кальяны: ${rub(st.kinds.hookah)} · ${pct(st.kinds.hookah)}%` : "",
      ].filter(Boolean).join("\n");
    },
    async seating(bot) {
      const tables = await tenantRef(bot.tenantId).collection("tables").get();
      const hall = tables.docs.filter((d) => d.id !== TAKEAWAY_TABLE);
      const busy = hall.filter((d) => (d.data().activeSessionIds || []).length > 0).length;
      const open = await activeSessions(bot.tenantId);
      const take = open.filter((s) => s.tableId === TAKEAWAY_TABLE).length;
      const pct = hall.length ? Math.round((busy / hall.length) * 100) : 0;
      return `🪑 Посадка: занято ${busy} из ${hall.length} столов (${pct}%)\nОткрытых чеков в зале: ${open.length - take}`
        + (take ? `\nС собой и доставка в работе: ${take}` : "");
    },
    async shift(bot) {
      const venue = await venueOf(bot.tenantId);
      const team = await onShiftStaff(bot.tenantId);
      const st = (await tenantRef(bot.tenantId).collection("meta").doc("shiftState").get()).data() || {};
      const lines = [st.openShiftId ? "👥 Касса открыта" : "👥 Касса закрыта"];
      if (!team.length) lines.push("На смене никого не отмечено.");
      for (const m of team) {
        lines.push(`• ${m.name}${m.position ? ` — ${POSITIONS[m.position] || m.position}` : ""}${m.since ? `, с ${hhmm(m.since, venue.timezone)}` : ""}`);
      }
      return lines.join("\n");
    },
    async delivery(bot) {
      const open = (await activeSessions(bot.tenantId)).filter((s) => s.tableId === TAKEAWAY_TABLE);
      if (!open.length) return "🛵 Заказов с собой и доставки в работе нет.";
      return ["🛵 В работе:"].concat(open.map((s) => {
        const type = s.orderType === "delivery" ? "delivery" : "takeaway";
        return `• №${orderNo(s.id)} ${type === "delivery" ? "доставка" : "с собой"} — ${flow.label(type, s.deliveryStatus)}, ${rub(sessionBill(s))}`;
      })).join("\n");
    },
  };

  // ------------------------------------------------------------ карточки доставки

  async function refreshCard(bot, s, force = false) {
    const staff = bot.cfg.staffChat;
    if (!staff || (bot.cfg.notify && bot.cfg.notify.delivery === false)) return;
    const cardRef = botsCol().doc(bot.tenantId).collection("cards").doc(s.id);
    const card = (await cardRef.get()).data();
    const venue = await venueOf(bot.tenantId);
    let pending = [];
    if (s.source === "app" && !(s.orderItems || []).length) {
      const g = await tenantRef(bot.tenantId).collection("guestOrders").where("sessionId", "==", s.id).get();
      pending = g.docs.map((d) => d.data()).filter((o) => o.status === "new").flatMap((o) => o.items || []);
    }
    const text = deliveryCardText(s, venue.timezone, pending);
    const markup = deliveryKeyboard(s, s.orderType === "delivery" ? addressUrl(bot.tenantId, s.id) : null);
    const sig = `${s.deliveryStatus || "new"}|${s.courierName || ""}|${(s.orderItems || []).length}|${sessionBill(s)}|${pending.length}|${Number(s.guestPaidTotal) || 0}|${s.status}`;
    if (!card || card.chatId !== staff.id) {
      const m = await api(bot.token, "sendMessage", { chat_id: staff.id, text, reply_markup: markup }).catch((e) => {
        console.error(`telegram card (${bot.tenantId}):`, e.message);
        return null;
      });
      if (m) await cardRef.set({ chatId: staff.id, messageId: m.message_id, sig });
      return;
    }
    if (!force && card.sig === sig) return;
    await api(bot.token, "editMessageText", { chat_id: card.chatId, message_id: card.messageId, text, reply_markup: markup })
      .catch(() => { /* «message is not modified» и т.п. — не важно */ });
    await cardRef.update({ sig });
  }

  /** Заказ вышел из работы: выдан, доставлен, отменён или закрыт на кассе. */
  async function closeCard(bot, sessionId, s = null) {
    const cardRef = botsCol().doc(bot.tenantId).collection("cards").doc(sessionId);
    const card = (await cardRef.get()).data();
    if (!card) return;
    const type = s && s.orderType === "delivery" ? "delivery" : "takeaway";
    const st = s ? flow.normalize(type, s.deliveryStatus) : "";
    const text = st === "cancelled"
      ? `❌ №${orderNo(sessionId)} отменён${s.cancelReason ? `: ${String(s.cancelReason).slice(0, 120)}` : ""}`
      : st === "done"
        ? `✅ №${orderNo(sessionId)} ${type === "delivery" ? "доставлен" : "выдан"}`
        : `✅ №${orderNo(sessionId)} закрыт на кассе`;
    await api(bot.token, "editMessageReplyMarkup", { chat_id: card.chatId, message_id: card.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await api(bot.token, "sendMessage", { chat_id: card.chatId, text, reply_to_message_id: card.messageId }).catch(() => {});
    await cardRef.delete();
  }

  // ------------------------------------------------------------ слушатели

  function attach(tenantId, cfg) {
    detach(tenantId);
    let token;
    try {
      token = decrypt(secretKey(), cfg.tokenEnc);
    } catch (e) {
      console.error(`telegram: не расшифровать токен ${tenantId} — подключите бота заново`);
      return;
    }
    const bot = { tenantId, token, cfg, unsubs: [], startedAt: admin.firestore.Timestamp.now() };
    bots.set(tenantId, bot);
    // Адрес вебхука сменился (включили или убрали ретранслятор) — переставляем
    // его у Telegram сами, владельцу подключать бота заново не нужно.
    if (cfg.hookSecret && cfg.hookUrl !== hookUrl(tenantId)) {
      api(token, "setWebhook", { url: hookUrl(tenantId), secret_token: cfg.hookSecret, allowed_updates: ["message", "callback_query"] })
        .then(() => botsCol().doc(tenantId).update({ hookUrl: hookUrl(tenantId) }))
        .catch((e) => console.error(`telegram webhook (${tenantId}):`, e.message));
    }
    const t = tenantRef(tenantId);
    const owners = () => bot.cfg.ownerChats || [];
    const on = (flag) => !bot.cfg.notify || bot.cfg.notify[flag] !== false;

    // Заказы с собой и доставки в работе: открытые чеки и уже оплаченные,
    // но ещё не выданные (deliveryOpen). Новые — карточкой, изменения —
    // правкой, выдан/отменён/закрыт — итогом в ответ на карточку.
    const live = { active: new Map(), open: new Map() };
    const tracked = new Set();
    const reconcile = async (id) => {
      const s = live.active.get(id) || live.open.get(id);
      const type = s && s.orderType === "delivery" ? "delivery" : "takeaway";
      const inWork = !!s && !flow.isFinal(type, s.deliveryStatus) && (s.status === "active" || s.deliveryOpen === true);
      if (inWork) {
        tracked.add(id);
        return refreshCard(bot, s);
      }
      if (!tracked.has(id) && s) return closeCard(bot, id, s);
      if (!tracked.has(id)) return;
      tracked.delete(id);
      const fresh = s || { id, ...((await t.collection("sessions").doc(id).get()).data() || {}) };
      return closeCard(bot, id, fresh);
    };
    const watch = (which, query) => bot.unsubs.push(query.onSnapshot((snap) => {
      snap.docChanges().forEach((ch) => {
        if (ch.type === "removed") live[which].delete(ch.doc.id);
        else live[which].set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
        reconcile(ch.doc.id).catch((e) => console.error(`telegram card (${tenantId}):`, e.message));
      });
    }, (e) => console.error(`telegram sessions (${tenantId}):`, e.message)));
    const takeaway = t.collection("sessions").where("tableId", "==", TAKEAWAY_TABLE);
    watch("active", takeaway.where("status", "==", "active"));
    watch("open", takeaway.where("deliveryOpen", "==", true));

    // Журнал кассы: сигналы владельцу — с курсора, без повторов после рестарта.
    const cursor = cfg.auditCursor || bot.startedAt;
    bot.unsubs.push(t.collection("auditLog").where("createdAt", ">", cursor).orderBy("createdAt")
      .onSnapshot(async (snap) => {
        const venue = await venueOf(tenantId).catch(() => ({}));
        let last = null;
        for (const ch of snap.docChanges()) {
          if (ch.type !== "added") continue;
          const a = ch.doc.data();
          last = a.createdAt || last;
          const text = on("alerts") ? alertText(venue.name || "Заведение", a) : null;
          if (text) for (const c of owners()) await say(bot, c.id, text);
        }
        if (last) botsCol().doc(tenantId).update({ auditCursor: last }).catch(() => {});
      }, (e) => console.error(`telegram audit (${tenantId}):`, e.message)));

    // Смены сотрудников: начало и конец — владельцу, с ролью и временем.
    const dayAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 36 * 3600 * 1000);
    bot.unsubs.push(t.collection("staffShifts").where("startedAt", ">=", dayAgo)
      .onSnapshot(async (snap) => {
        if (!on("shifts")) return;
        const venue = await venueOf(tenantId).catch(() => ({}));
        for (const ch of snap.docChanges()) {
          const s = ch.doc.data();
          const started = toDate(s.startedAt);
          const ended = toDate(s.endedAt);
          const since = bot.startedAt.toMillis();
          let text = null;
          if (ch.type === "added" && s.status === "open" && started && started.getTime() > since) text = "🟢 Начал смену";
          if (ch.type === "modified" && s.status !== "open" && ended && ended.getTime() > since) text = "🔴 Закончил смену";
          if (!text) continue;
          const emp = s.employeeId ? (await t.collection("employees").doc(s.employeeId).get()).data() || {} : {};
          const role = POSITIONS[emp.position] || (emp.role === "admin" ? "администратор" : "сотрудник");
          const at = hhmm(text.startsWith("🟢") ? started : ended, venue.timezone);
          for (const c of owners()) await say(bot, c.id, `${text}: ${s.employeeName || emp.name || "сотрудник"} (${role}) в ${at}`);
        }
      }, (e) => console.error(`telegram shifts (${tenantId}):`, e.message)));
  }

  function detach(tenantId) {
    const bot = bots.get(tenantId);
    if (!bot) return;
    bot.unsubs.forEach((u) => { try { u(); } catch (_) { /* уже отписан */ } });
    bots.delete(tenantId);
  }

  /** Утренние итоги — раз в рабочие сутки после SUMMARY_HOUR. */
  async function tick() {
    for (const bot of bots.values()) {
      try {
        if (bot.cfg.notify && bot.cfg.notify.summary === false) continue;
        const owners = bot.cfg.ownerChats || [];
        if (!owners.length) continue;
        const venue = await venueOf(bot.tenantId);
        if (venue.status === "deleted" || venue.status === "disabled") continue;
        const now = new Date();
        const lb = lastBusinessDay(now, venue.timezone);
        if (localParts(now, venue.timezone).h < SUMMARY_HOUR || bot.cfg.lastSummaryDay === lb.key) continue;
        const [sessions, audit] = await Promise.all([
          closedSince(bot.tenantId, lb.start, lb.end),
          tenantRef(bot.tenantId).collection("auditLog").where("createdAt", ">=", lb.start).where("createdAt", "<", lb.end).get()
            .then((s) => s.docs.map((d) => d.data())),
        ]);
        const text = buildSummary({ venueName: venue.name || "Заведение", label: lb.label, sessions, audit, excludeTobacco: await loyaltyExclude(bot.tenantId) });
        await botsCol().doc(bot.tenantId).update({ lastSummaryDay: lb.key });
        bot.cfg.lastSummaryDay = lb.key;
        for (const c of owners) await say(bot, c.id, text, { reply_markup: MENU_KEYBOARD });
      } catch (e) {
        console.error(`telegram summary (${bot.tenantId}):`, e.message || e);
      }
    }
  }

  function start() {
    // Настройки всех ботов — живьём: подключили, сменили токен, отключили.
    botsCol().onSnapshot((snap) => {
      snap.docChanges().forEach((ch) => {
        const id = ch.doc.id;
        if (ch.type === "removed") return detach(id);
        const cfg = ch.doc.data();
        const cur = bots.get(id);
        const staffSame = cur && (cur.cfg.staffChat || {}).id === (cfg.staffChat || {}).id;
        // Тот же бот и та же группа — только обновляем чаты, флаги, курсор.
        // Новая группа — переподключаемся: заказы в работе придут в неё.
        if (cur && cur.cfg.tokenEnc === cfg.tokenEnc && staffSame) cur.cfg = cfg;
        else attach(id, cfg);
      });
    }, (e) => console.error("telegram bots:", e.message));
    setInterval(() => tick().catch((e) => console.error("telegram tick:", e.message)), 2 * 60 * 1000);
  }

  return {
    handleSetup, handleStatus, handleLinkCode, handleNotify, handleUnlink, handleAddress, handleHook, start,
  };
}

module.exports = {
  createTelegram, buildSummary, alertText, lastBusinessDay, businessDayStart, localParts, encrypt, decrypt,
  deliveryCardText, deliveryKeyboard, salesStats, addressSig,
};
