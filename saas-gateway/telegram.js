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
 *  - управлять ботом (отчёты, привязка чатов, кнопки заказов) могут только
 *    те, чей Telegram ID владелец вписал в кабинете (allowed): даже в
 *    рабочей группе чужой человек кнопку не нажмёт;
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
 *    посадка, смена, доставка, касса; «Ещё»: вчера, неделя, топ продаж,
 *    склад на исходе, брони, отмены и скидки, отзывы), начало и конец
 *    смен, сигналы об отменах, закрытии без оплаты, возвратах и больших
 *    скидках, итоги в 10:00, напоминание о незакрытой смене кассы.
 *
 * Сеть заведений: один бот на всю сеть. Подключают его в любой точке —
 * он видит все точки (tenants.chainId). Владелец кнопкой «📍» выбирает
 * точку или «Все точки» (сводка по сети); сигналы, смены и заказы
 * приходят от всех точек с подписью точки. Рабочая группа — своя у
 * точки (staffChats) или общая — группа точки, где подключён бот.
 *
 * Данные: telegramBots/{tenantId} (настройки; у сети — tenantId точки,
 * где подключён бот, и chainId), …/cards/{sessionId} (карточки
 * доставки), telegramLinks/{code} (коды привязки, 30 минут). Отчёты
 * считаются из копии чеков на сервере (telegram-cache/, KEEP_DAYS суток):
 * каждый чек читается из Firestore один раз, а не при каждом отчёте.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
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
// «👤 Кто» — имя сотрудника на странице сервера в РФ: в Telegram (серверы за
// рубежом) имён сотрудников и гостей не отправляем.
const WHO_LINK_TTL_MS = 14 * 24 * 3600 * 1000;
const TAKEAWAY_TABLE = "takeaway";
const MAX_ALLOWED = 30;
const POSITIONS = { waiter: "официант", hookah_master: "кальянщик", bartender: "бармен", universal: "универсал" };

// Смена кассы открыта дольше — её, скорее всего, забыли закрыть: продажи
// новых дней копятся в старой смене. Личная смена сотрудника — так же.
const STALE_CASH_SHIFT_MS = 20 * 3600 * 1000;
const STALE_STAFF_SHIFT_MS = 16 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
// Лимит сообщения Telegram — 4096 символов.
const TEXT_LIMIT = 3900;
// Копия чеков на сервере (см. «копия данных точки»): сколько прошедших
// рабочих суток держать и где. Папка переживает обновления сервера.
const KEEP_DAYS = 15;
const CACHE_DIR = process.env.TELEGRAM_CACHE_DIR || path.join(__dirname, "telegram-cache");
// Поля чека, нужные отчётам. Имён, телефонов и адресов гостей в копии нет.
const SALE_FIELDS = ["status", "tableId", "orderType", "refunded", "refundCashOut", "closedWithoutPayment", "discountPercent",
  "paymentCash", "paymentCard", "paymentTerminal", "terminalBank", "paymentComp", "paymentAggregator", "tipsCash"];
const msOf = (v) => { const d = toDate(v); return d ? d.getTime() : 0; };
function saleOf(id, d) {
  const s = { id, closedAt: msOf(d.closedAt), refundedAt: msOf(d.refundedAt) };
  for (const k of SALE_FIELDS) if (d[k] !== undefined && d[k] !== null) s[k] = d[k];
  s.orderItems = (Array.isArray(d.orderItems) ? d.orderItems : [])
    .map((i) => ({ name: i.name, price: i.price, qty: i.qty, kind: i.kind, noPromo: i.noPromo === true }));
  return s;
}

// Как часто бот сети перечитывает список точек (новая точка, своя группа).
// Реже — меньше чтений из суточной квоты Firestore; точки добавляют редко.
const POINTS_RESYNC_MS = 30 * 60 * 1000;

const MENU = {
  revenue: "💰 Выручка сегодня",
  avg: "🧾 Средний чек",
  kinds: "🍽 Кухня · Бар · Кальяны",
  seating: "🪑 Посадка",
  shift: "👥 Текущая смена",
  delivery: "🛵 Доставка",
  cash: "💵 Касса сейчас",
  more: "📊 Ещё отчёты",
};
// «Ещё отчёты» — кнопками под сообщением (callback r:<ключ>).
const MORE = [
  ["yesterday", "📅 Вчера"], ["week", "📆 Неделя"],
  ["top", "🏆 Топ продаж"], ["stock", "📦 Склад на исходе"],
  ["bookings", "📖 Брони сегодня"], ["voids", "⚠️ Отмены и скидки"],
  ["reviews", "⭐ Отзывы"],
];
const POINT_MARK = "📍";

/** Клавиатура отчётов; pointLabel — у сети, кнопка выбора точки сверху. */
function menuKeyboard(pointLabel = "") {
  const keyboard = [];
  if (pointLabel) keyboard.push([{ text: `${POINT_MARK} ${pointLabel}` }]);
  keyboard.push(
    [{ text: MENU.revenue }, { text: MENU.avg }],
    [{ text: MENU.kinds }, { text: MENU.seating }],
    [{ text: MENU.shift }, { text: MENU.delivery }],
    [{ text: MENU.cash }, { text: MENU.more }],
  );
  return { keyboard, resize_keyboard: true, is_persistent: true };
}

function moreKeyboard() {
  const rows = [];
  for (let i = 0; i < MORE.length; i += 2) rows.push(MORE.slice(i, i + 2).map(([k, t]) => ({ text: t, callback_data: `r:${k}` })));
  return { inline_keyboard: rows };
}

const clip = (text) => (text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n…(не поместилось — выберите отдельную точку)` : text);
const UNITS = { g: "г", kg: "кг", ml: "мл", l: "л", pcs: "шт" };
const qtyText = (v, unit) => `${(Number(v) || 0).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${UNITS[unit] || unit || ""}`.trim();

const rub = (v) => `${Math.round(Number(v) || 0).toLocaleString("ru-RU")} ₽`;
const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : v instanceof Date ? v
  : typeof v === "number" && v > 0 ? new Date(v) : null);

// ---------------------------------------------------------------- доступ

/**
 * Кто управляет ботом: [{ id, name, role }] — Telegram ID, вписанные
 * владельцем в кабинете. role 'owner' — владелец или управляющий: отчёты,
 * уведомления, привязка чатов, кнопки; 'staff' — сотрудник: только кнопки
 * заказов в рабочей группе. До появления списка — владельцы, уже
 * привязавшие личный чат (личный чат в Telegram = ID пользователя).
 */
function allowedList(cfg) {
  if (Array.isArray(cfg && cfg.allowed)) return cfg.allowed;
  return ((cfg && cfg.ownerChats) || []).map((c) => ({ id: c.id, name: c.name || "", role: "owner" }));
}

const roleOf = (cfg, userId) => {
  const a = allowedList(cfg).find((x) => x.id === userId);
  return a ? a.role : null;
};

/** Список из кабинета → проверенный: ID — положительное число до 15 цифр, без повторов. */
function parseAllowed(raw, HttpError) {
  if (!Array.isArray(raw)) throw new HttpError(400, "Список доступа не передан");
  if (raw.length > MAX_ALLOWED) throw new HttpError(400, `Не больше ${MAX_ALLOWED} человек`);
  const out = [];
  const seen = new Set();
  for (const a of raw) {
    const idStr = String(a && a.id != null ? a.id : "").trim();
    if (!/^[1-9]\d{0,14}$/.test(idStr)) {
      throw new HttpError(400, `«${idStr.slice(0, 20) || "пусто"}» — не Telegram ID. Это число, его пришлёт ваш бот в ответ на /id`);
    }
    const id = Number(idStr);
    if (seen.has(id)) continue;
    seen.add(id);
    const name = String((a && a.name) || "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    out.push({ id, name, role: a && a.role === "staff" ? "staff" : "owner" });
  }
  return out;
}

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

function whoSig(key, tenantId, what, id, exp) {
  return crypto.createHmac("sha256", key).update(`who|${tenantId}|${what}|${id}|${exp}`).digest("hex").slice(0, 32);
}

/** Должность словами — вместо имени в сообщениях Telegram. */
function roleLabel(emp) {
  const e = emp || {};
  return POSITIONS[e.position] || (e.role === "admin" ? "администратор" : "сотрудник");
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

/** Номер заказа: порядковый (sessions.orderNo), у старых — хвост id. Как orderNumberLabel в кассе. */
const orderNo = (sessionId, no = 0) => (Number(no) > 0 ? String(Math.trunc(no)) : String(sessionId).slice(-4).toUpperCase());

/** Деньги чеков: выручка, чеки, оплаты, доли цехов. */
function salesStats(sessions, excludeTobacco = true) {
  const st = { revenue: 0, checks: 0, cash: 0, card: 0, terminal: 0, comp: 0, aggregator: 0, unpaid: 0, unpaidSum: 0,
    refunds: 0, refundSum: 0, discount: 0, takeaway: 0, delivery: 0, kinds: { kitchen: 0, bar: 0, hookah: 0 }, items: new Map(),
    itemQty: new Map(), terminalBanks: new Map() };
  for (const s of sessions) {
    // Отменённый заказ с собой/доставки тоже получает closedAt, но денег
    // не принёс — как и в кабинете (там только status == "closed").
    if (s.status === "cancelled") continue;
    const bill = sessionBill(s, excludeTobacco);
    if (s.refunded) { st.refunds++; st.refundSum += bill; continue; }
    if (s.closedWithoutPayment) { st.unpaid++; st.unpaidSum += bill; continue; }
    st.checks++;
    st.revenue += bill;
    st.cash += Number(s.paymentCash) || 0;
    st.card += Number(s.paymentCard) || 0;
    st.terminal += Number(s.paymentTerminal) || 0;
    // Через какой банк прошёл терминал (sessions.terminalBank) — для сверки.
    if ((Number(s.paymentTerminal) || 0) > 0) {
      const bank = String(s.terminalBank || "").trim() || "банк не указан";
      st.terminalBanks.set(bank, (st.terminalBanks.get(bank) || 0) + Number(s.paymentTerminal));
    }
    st.comp += Number(s.paymentComp) || 0;
    // Агрегатор доставки (Яндекс Еда и др.): деньги переведёт он, позже.
    st.aggregator += Number(s.paymentAggregator) || 0;
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
      st.itemQty.set(name, (st.itemQty.get(name) || 0) + (Number(i.qty) || 0));
    }
    st.discount += Math.max(0, full - bill);
  }
  return st;
}

/** Что не так за сутки: удалённые позиции, закрытие без оплаты, возвраты. */
function summaryWarnings(st, audit) {
  const voids = (audit || []).filter((a) => a.action === "order_item_voided" || a.action === "order_item_removed");
  const voidSum = voids.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  const warn = [];
  if (voids.length) warn.push(`удалено позиций: ${voids.length} на ${rub(voidSum)}`);
  if (st.unpaid) warn.push(`закрыто без оплаты: ${st.unpaid} на ${rub(st.unpaidSum)}`);
  if (st.refunds) warn.push(`возвратов: ${st.refunds} на ${rub(st.refundSum)}`);
  return warn;
}

function payLines(st) {
  return [
    st.cash ? `наличные ${rub(st.cash)}` : "",
    st.card ? `карта ${rub(st.card)}` : "",
    st.terminal ? `терминал/СБП ${rub(st.terminal)}` : "",
    st.aggregator ? `агрегаторы ${rub(st.aggregator)}` : "",
    st.comp ? `за счёт заведения ${rub(st.comp)}` : "",
  ].filter(Boolean);
}

/** Топ позиций по выручке: [[название, сумма, штук]]. */
function topItems(stats, n = 5) {
  const sum = new Map();
  const qty = new Map();
  for (const st of stats) {
    for (const [k, v] of st.items) sum.set(k, (sum.get(k) || 0) + v);
    for (const [k, v] of st.itemQty || []) qty.set(k, (qty.get(k) || 0) + v);
  }
  return [...sum.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, v, qty.get(k) || 0]);
}

/**
 * Итоги сети за сутки: сумма по всем точкам и строка на каждую точку.
 * points: [{ name, sessions, audit, excludeTobacco, notes }].
 */
function buildChainSummary({ chainName, label, points }) {
  const per = points.map((p) => ({ ...p, st: salesStats(p.sessions || [], p.excludeTobacco !== false) }));
  const total = per.reduce((a, p) => {
    for (const k of ["revenue", "checks", "cash", "card", "terminal", "aggregator", "comp", "discount"]) a[k] += p.st[k];
    return a;
  }, { revenue: 0, checks: 0, cash: 0, card: 0, terminal: 0, aggregator: 0, comp: 0, discount: 0 });
  const lines = [
    `📊 Сеть «${chainName || "Сеть"}» — итоги ${label}`,
    "",
    `Выручка: ${rub(total.revenue)}`,
    `Чеков: ${total.checks}${total.checks ? ` · средний чек ${rub(total.revenue / total.checks)}` : ""}`,
  ];
  const pays = payLines(total);
  if (pays.length) lines.push(`Оплаты: ${pays.join(", ")}`);
  if (total.discount >= 1) lines.push(`Скидки: ${rub(total.discount)}`);
  lines.push("");
  for (const p of per) {
    lines.push(p.st.checks
      ? `${POINT_MARK} ${p.name}: ${rub(p.st.revenue)} · ${p.st.checks} чек. · средний ${rub(p.st.revenue / p.st.checks)}`
      : `${POINT_MARK} ${p.name}: продаж не было`);
  }
  const top = topItems(per.map((p) => p.st));
  if (top.length) {
    lines.push("", "Топ продаж сети:");
    top.forEach(([n, v], idx) => lines.push(`${idx + 1}. ${n} — ${rub(v)}`));
  }
  const warn = [];
  for (const p of per) {
    for (const w of [...summaryWarnings(p.st, p.audit), ...(p.notes || [])]) warn.push(`• ${p.name}: ${w}`);
  }
  if (warn.length) lines.push("", "⚠️ Обратите внимание:", ...warn);
  return lines.join("\n");
}

function buildSummary({ venueName, label, sessions, audit, excludeTobacco = true, notes = [] }) {
  const st = salesStats(sessions, excludeTobacco);
  const lines = [
    `📊 ${venueName} — итоги ${label}`,
    "",
    `Выручка: ${rub(st.revenue)}`,
    `Чеков: ${st.checks}${st.checks ? ` · средний чек ${rub(st.revenue / st.checks)}` : ""}`,
  ];
  const pays = payLines(st);
  if (pays.length) lines.push(`Оплаты: ${pays.join(", ")}`);
  const banks = [...st.terminalBanks.entries()];
  if (banks.some(([b]) => b !== "банк не указан")) {
    lines.push(`Терминал по банкам: ${banks.map(([b, v]) => `${b} ${rub(v)}`).join(", ")}`);
  }
  if (st.takeaway || st.delivery) lines.push(`С собой: ${st.takeaway} · доставка: ${st.delivery}`);
  if (st.discount >= 1) lines.push(`Скидки: ${rub(st.discount)}`);
  const top = [...st.items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) {
    lines.push("", "Топ продаж:");
    top.forEach(([n, v], idx) => lines.push(`${idx + 1}. ${n} — ${rub(v)}`));
  }
  const warn = [...summaryWarnings(st, audit), ...notes];
  if (warn.length) lines.push("", `⚠️ Обратите внимание: ${warn.join("; ")}`);
  if (!st.checks && !warn.length) lines.push("", "Продаж не было.");
  return lines.join("\n");
}

/** Сигнал по записи журнала кассы; null — не сигналить. Имён гостей нет. */
/**
 * Сигнал владельцу. Имени сотрудника нет — только должность (whoRole,
 * approvedRole); кто именно — по кнопке «👤 Кто» на сервере в РФ.
 */
function alertText(venueName, a) {
  const who = a.whoRole ? ` — ${a.whoRole}` : "";
  const where = a.tableName ? `${a.tableName}: ` : "";
  const d = a.details || {};
  switch (a.action) {
    case "order_item_voided":
      return `⚠️ ${venueName}. ${where}отменена позиция «${d.item || "?"}»${d.qty ? ` ×${d.qty}` : ""} на ${rub(a.amount)}`
        + `${d.reason ? `. Причина: ${d.reason}` : ""}${a.approvedRole ? `. Подтвердил: ${a.approvedRole}` : ""}${who}`;
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
function deliveryCardText(s, tz, pendingItems = [], pointName = "") {
  const type = s.orderType === "delivery" ? "delivery" : "takeaway";
  const confirmed = s.orderItems || [];
  const items = confirmed.length ? confirmed : pendingItems;
  const qty = items.reduce((a, i) => a + (Number(i.qty) || 0), 0);
  const total = confirmed.length
    ? sessionBill(s)
    : Math.round(items.reduce((a, i) => a + (Number(i.price) || 0) * (Number(i.qty) || 0), 0) * 100) / 100;
  const app = s.source === "app";
  const lines = [
    ...(pointName ? [`${POINT_MARK} ${pointName}`] : []),
    `${type === "delivery" ? "🛵 Доставка" : "🥡 С собой"} №${orderNo(s.id, s.orderNo)}${app ? " · 📱 из приложения" : ""}`,
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
  if (s.courierName || s.courierSet) lines.push("🚴 Курьер назначен");
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


/** Подпись дня недели и даты для отчёта «Неделя». */
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
function dayLabel(start, tz) {
  const p = localParts(new Date(start.getTime() + 3600000), tz);
  const wd = WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
  return `${wd} ${String(p.d).padStart(2, "0")}.${String(p.m).padStart(2, "0")}`;
}

/** «⚠️ Смена кассы открыта с 02.10 12:57…» — забыли закрыть; null — всё в порядке. */
function staleCashText(openedAt, tz, now = new Date()) {
  if (!openedAt || now.getTime() - openedAt.getTime() < STALE_CASH_SHIFT_MS) return null;
  const p = localParts(openedAt, tz);
  const when = `${String(p.d).padStart(2, "0")}.${String(p.m).padStart(2, "0")} ${hhmm(openedAt, tz)}`;
  return `смена кассы не закрыта с ${when} — закройте её на кассе (Z-отчёт), иначе продажи новых дней копятся в старой смене`;
}

// ---------------------------------------------------------------- модуль

function createTelegram({ db, admin, verifyAuth, parseJsonBody, readBody, sendJson, HttpError, requireTenantRole, publicUrl, fetchImpl, pii }) {
  const doFetch = fetchImpl || fetch;
  const botsCol = () => db().collection("telegramBots");
  const tenantRef = (t) => db().collection("tenants").doc(t);
  const linkRef = (code) => db().collection("telegramLinks").doc(code);

  /** tenantId точки, где подключён бот → { tenantId, token, cfg, points, … } */
  const bots = new Map();

  // Запросы, которые безопасно повторить: второй раз ничего не задвоят.
  // sendMessage не повторяем — первое сообщение могло дойти, а ответ нет.
  const IDEMPOTENT = new Set(["getMe", "setWebhook", "deleteWebhook", "getWebhookInfo", "getChat", "setMyCommands"]);

  async function api(token, method, params = {}) {
    let resp;
    const attempts = IDEMPOTENT.has(method) ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        resp = await doFetch(`${API_BASE}/bot${token}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
          // Недоступный Telegram не должен подвешивать шлюз и очередь сообщений.
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
        break;
      } catch (e) {
        // Причина — в журнал (без токена): «таймаут», «соединение сброшено»,
        // «нет DNS» — по ней видно, где рвётся связь сервера с Telegram.
        const cause = (e && e.cause && (e.cause.code || e.cause.message)) || (e && (e.name || e.message)) || String(e);
        console.error(`telegram ${method}: нет связи (попытка ${attempt}/${attempts}, ${API_BASE === "https://api.telegram.org" ? "напрямую" : "через ретранслятор"}): ${cause}`);
        if (attempt >= attempts) throw new TelegramUnreachable(`Telegram недоступен: ${cause}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || resp.status}`);
    return data.result;
  }

  const say = (bot, chatId, text, extra = {}) => api(bot.token, "sendMessage", { chat_id: chatId, text: clip(text), disable_web_page_preview: true, ...extra })
    .catch((e) => console.error(`telegram send (${bot.tenantId}):`, e.message));

  function checkTenantId(tenantId) {
    if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new HttpError(400, "Не указано заведение");
  }

  // ------------------------------------------------------------ точки сети

  const venueTitle = (venue) => String(venue.name || "").trim().slice(0, 60);

  /** Точки сети без удалённых — по имени. */
  async function chainPoints(chainId) {
    const snap = await db().collection("tenants").where("chainId", "==", chainId).get();
    return snap.docs
      .filter((d) => (d.data() || {}).status !== "deleted")
      .map((d) => ({ id: d.id, name: venueTitle(d.data() || {}) || "Точка" }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }

  /**
   * Чей бот у точки сети без своего бота. Раньше у каждой точки сети был
   * свой бот — такие точки остаются за своим ботом, а остальные берёт бот
   * с наименьшим id точки: один, чтобы карточки и сигналы не дублировались.
   */
  async function chainBotHolders(points, skip = "") {
    const out = [];
    for (const id of points.map((p) => p.id).sort()) {
      if (id !== skip && (await botsCol().doc(id).get()).exists) out.push(id);
    }
    return out;
  }

  /**
   * Точки бота: у сети — её точки (кроме тех, где подключён свой бот), у
   * одиночного заведения — оно само. homeId — где подключён бот.
   */
  async function loadPoints(homeId) {
    const home = (await tenantRef(homeId).get()).data() || {};
    const chainId = String(home.chainId || "");
    const self = { id: homeId, name: venueTitle(home) || "Заведение" };
    if (!chainId) return { chainId: "", chainName: "", points: [self] };
    const all = await chainPoints(chainId);
    const holders = await chainBotHolders(all, homeId);
    const main = !holders.length || homeId < holders[0];
    const points = main ? all.filter((p) => !holders.includes(p.id)) : all.filter((p) => p.id === homeId);
    if (!points.some((p) => p.id === homeId)) points.unshift(self);
    const chain = (await db().collection("chains").doc(chainId).get()).data() || {};
    return { chainId, chainName: String(chain.name || "").trim() || "Сеть", points };
  }

  /** Бот заведения: свой документ или, у точки сети, бот всей сети. → { id, data } */
  async function botDocFor(tenantId) {
    const own = await botsCol().doc(tenantId).get();
    if (own.exists) return { id: tenantId, data: own.data() };
    const t = (await tenantRef(tenantId).get()).data() || {};
    if (t.chainId) {
      const [id] = await chainBotHolders(await chainPoints(String(t.chainId)), tenantId);
      if (id) return { id, data: (await botsCol().doc(id).get()).data() };
    }
    return { id: tenantId, data: null };
  }

  async function guard(req) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    checkTenantId(body.tenantId);
    await requireTenantRole(body.tenantId, decoded.uid, ["owner", "admin"]);
    const found = await botDocFor(body.tenantId);
    // Бот сети подключён в другой точке — управлять им можно с правами и там:
    // администратор одной точки не откроет себе отчёты всей сети.
    if (found.id !== body.tenantId) {
      try {
        await requireTenantRole(found.id, decoded.uid, ["owner", "admin"]);
      } catch (_) {
        throw new HttpError(403, "Бот сети подключён в другой точке — управлять им может владелец или администратор сети");
      }
    }
    return { decoded, body, botId: found.id, cfg: found.data };
  }

  /** Рабочая группа точки: своя, иначе группа точки, где подключён бот. */
  function staffChatOf(cfg, tenantId, homeId) {
    const own = ((cfg && cfg.staffChats) || {})[tenantId];
    if (own && own.id) return { chat: own, shared: false };
    const main = cfg && cfg.staffChat;
    if (main && main.id) return { chat: main, shared: tenantId !== homeId };
    return { chat: null, shared: false };
  }

  const hookUrl = (tenantId) => (HOOK_BASE ? `${HOOK_BASE}/${tenantId}` : `${publicUrl}/tgHook/${tenantId}`);

  // ------------------------------------------------------------ кабинет


  /**
   * Владелец вводит токен своего бота: проверяем, шифруем, ставим webhook.
   * У сети бот один: из любой точки настраивается бот всей сети.
   */
  async function handleSetup(req, res) {
    const { body, botId } = await guard(req);
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
    if (taken.docs.some((d) => d.id !== botId)) {
      throw new HttpError(409, "Этот бот уже подключён к другому заведению — создайте для этого заведения отдельного бота");
    }
    let key;
    try {
      key = secretKey();
    } catch (_) {
      throw new HttpError(503, "Подключение ботов на сервере ещё настраивается — попробуйте через несколько минут");
    }
    const ref = botsCol().doc(botId);
    const prev = (await ref.get()).data() || {};
    const home = (await tenantRef(botId).get()).data() || {};
    const hookSecret = crypto.randomBytes(24).toString("hex");
    await api(token, "setWebhook", {
      url: hookUrl(botId),
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
      hookUrl: hookUrl(botId),
      chainId: home.chainId ? String(home.chainId) : null,
      ownerChats: sameBot ? prev.ownerChats || [] : [],
      // Список людей — заведения, а не бота: при смене бота не теряется.
      allowed: allowedList(prev),
      staffChat: sameBot ? prev.staffChat || null : null,
      staffChats: sameBot ? prev.staffChats || {} : {},
      views: sameBot ? prev.views || {} : {},
      notify: prev.notify || { delivery: true, shifts: true, alerts: true, summary: true },
      auditCursor: prev.auditCursor || admin.firestore.Timestamp.now(),
      auditCursors: prev.auditCursors || {},
      lastSummaryDay: prev.lastSummaryDay || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    sendJson(res, 200, { username: me.username || "" });
  }

  /** Подпись чата в кабинете — из «Кто управляет ботом», не из Telegram. */
  const chatLabel = (cfg, c) => (allowedList(cfg).find((a) => a.id === c.id) || {}).name || c.name || "Чат";

  async function handleStatus(req, res) {
    const { body, botId, cfg: d } = await guard(req);
    const info = await loadPoints(botId).catch(() => null);
    const chain = info && info.points.length > 1 ? {
      name: info.chainName,
      points: info.points.map((p) => p.name),
      home: (info.points.find((p) => p.id === botId) || {}).name || "",
    } : null;
    if (!d) return sendJson(res, 200, { configured: false, chain });
    const group = staffChatOf(d, body.tenantId, botId);
    sendJson(res, 200, {
      configured: true,
      username: d.username || "",
      owners: (d.ownerChats || []).filter((c) => roleOf(d, c.id) === "owner").map((c) => chatLabel(d, c)),
      allowed: allowedList(d),
      staffChat: group.chat ? group.chat.title || "Группа" : "",
      staffChatShared: group.shared,
      notify: d.notify || {},
      chain,
    });
  }

  /**
   * Код привязки: kind 'owner' — личный чат, 'staff' — рабочая группа той
   * точки, из кабинета которой его попросили.
   */
  async function handleLinkCode(req, res) {
    const { body, botId, cfg: d } = await guard(req);
    const kind = body.kind === "staff" ? "staff" : "owner";
    if (!d) throw new HttpError(409, "Сначала подключите бота заведения");
    if (!allowedList(d).some((a) => a.role === "owner")) {
      throw new HttpError(409, "Сначала впишите свой Telegram ID в «Кто управляет ботом» — его пришлёт бот в ответ на /id");
    }
    const code = crypto.randomBytes(9).toString("hex");
    await linkRef(code).set({
      tenantId: body.tenantId, bot: botId, kind,
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 60 * 1000),
    });
    const link = kind === "staff"
      ? `https://t.me/${d.username}?startgroup=${code}`
      : `https://t.me/${d.username}?start=${code}`;
    sendJson(res, 200, { link });
  }

  /** Кто управляет ботом. Убрали человека — его личный чат больше ничего не получает. */
  async function handleAccess(req, res) {
    const { body, botId, cfg: d } = await guard(req);
    if (!d) throw new HttpError(409, "Сначала подключите бота заведения");
    const allowed = parseAllowed(body.allowed, HttpError);
    const owners = new Set(allowed.filter((a) => a.role === "owner").map((a) => a.id));
    const chats = (d.ownerChats || []).filter((c) => owners.has(c.id));
    await botsCol().doc(botId).update({ allowed, ownerChats: chats });
    sendJson(res, 200, { allowed, owners: chats.map((c) => chatLabel({ allowed }, c)) });
  }

  async function handleNotify(req, res) {
    const { body, botId, cfg: d } = await guard(req);
    if (!d) throw new HttpError(409, "Сначала подключите бота заведения");
    const n = body.notify || {};
    const notify = {
      delivery: n.delivery !== false, shifts: n.shifts !== false, alerts: n.alerts !== false, summary: n.summary !== false,
    };
    await botsCol().doc(botId).update({ notify });
    sendJson(res, 200, { notify });
  }

  async function handleUnlink(req, res) {
    const { botId, cfg: d } = await guard(req);
    if (d) {
      const ref = botsCol().doc(botId);
      try {
        await api(decrypt(secretKey(), d.tokenEnc), "deleteWebhook", { drop_pending_updates: true });
      } catch (_) { /* бот мог быть удалён в BotFather — всё равно отключаем */ }
      const cards = await ref.collection("cards").get();
      for (const c of cards.docs) await c.ref.delete();
      await ref.delete();
    }
    sendJson(res, 200, { ok: true });
  }

  const escHtml = (v) => String(v || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** Страница на нашем сервере в РФ: адрес доставки, кто из сотрудников. */
  function htmlPage(res, code, title, html) {
    res.writeHead(code, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer",
    });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title><body style="font:18px/1.5 system-ui,sans-serif;margin:24px;max-width:520px">${html}</body>`);
  }

  /** Заведение переведено на хранение в РФ: имён и контактов в Firestore нет. */
  const rfMode = async (tenantId) => !!pii && (await pii.mode(tenantId).catch(() => "mirror")) === "rf";

  /** Адрес доставки — страница на нашем сервере в РФ по подписанной ссылке. */
  async function handleAddress(req, res) {
    const u = new URL(req.url, "http://x");
    const t = u.searchParams.get("t") || "";
    const s = u.searchParams.get("s") || "";
    const exp = Number(u.searchParams.get("e")) || 0;
    const page = (code, html) => htmlPage(res, code, "Адрес доставки", html);
    const esc = escHtml;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(t) || !/^[A-Za-z0-9_-]{1,128}$/.test(s) || exp < Date.now()
        || !sigOk(u.searchParams.get("k"), addressSig(secretKey(), t, s, exp))) {
      return page(403, "<p>Ссылка устарела или неверна. Откройте адрес из свежей карточки заказа.</p>");
    }
    const ses = (await tenantRef(t).collection("sessions").doc(s).get()).data();
    if (!ses || ses.orderType !== "delivery") return page(404, "<p>Заказ не найден.</p>");
    let address = String(ses.deliveryAddress || "");
    let phone = String(ses.customerPhone || "");
    let name = String(ses.guestTag || "");
    if (await rfMode(t)) {
      // Контакт гостя — в справочнике в РФ; в документе он может остаться
      // только у старого заказа, ещё не перенесённого (pii-migrate.js).
      const rec = (await pii.lookup(t, [{ k: "delivery", id: s }]).catch(() => new Map())).get(`delivery:${s}`) || {};
      address = String(rec.address || address);
      phone = String(rec.phone || phone);
      name = String(rec.name || name);
    }
    page(200, `<h2 style="margin:0 0 12px">Доставка №${esc(orderNo(s, ses.orderNo))}</h2>
<p><b>Адрес:</b><br>${esc(address) || "не указан"}</p>
${phone ? `<p><b>Телефон:</b> <a href="tel:${esc(phone.replace(/[^+\d]/g, ""))}">${esc(phone)}</a></p>` : ""}
${name ? `<p><b>Имя:</b> ${esc(name)}</p>` : ""}
${address ? `<p><a href="https://yandex.ru/maps/?text=${encodeURIComponent(address)}">Открыть на карте</a></p>` : ""}`);
  }

  // ------------------------------------------------------------ «кто» без имён в Telegram

  function whoUrl(tenantId, what, id) {
    const exp = Date.now() + WHO_LINK_TTL_MS;
    const k = whoSig(secretKey(), tenantId, what, id, exp);
    return `${publicUrl}/staffWho?t=${encodeURIComponent(tenantId)}&w=${what}&id=${encodeURIComponent(id)}&e=${exp}&k=${k}`;
  }
  const whoButton = (tenantId, what, id) => ({ reply_markup: { inline_keyboard: [[{ text: "👤 Кто", url: whoUrl(tenantId, what, id) }]] } });

  /** Карточка сотрудника по полю «кто сделал»: ссылка staff:<id> (режим РФ) или имя. */
  async function employeeOf(tenantId, raw, employeeId = "") {
    const v = String(raw || "");
    const id = v.startsWith("staff:") ? v.slice(6) : employeeId;
    const col = tenantRef(tenantId).collection("employees");
    if (id) {
      const d = await col.doc(id).get();
      return d.exists ? { id, ...d.data() } : null;
    }
    if (!v) return null;
    const snap = await col.where("name", "==", v).limit(1).get();
    return snap.docs.length ? { id: snap.docs[0].id, ...snap.docs[0].data() } : null;
  }

  /** Должность — то, что уходит в Telegram вместо имени. */
  async function roleOfWho(tenantId, raw, employeeId = "") {
    if (!raw && !employeeId) return "";
    return roleLabel(await employeeOf(tenantId, raw, employeeId).catch(() => null));
  }

  /** Имя — только для страницы на сервере в РФ. */
  async function nameOfWho(tenantId, raw, employeeId = "") {
    if (pii) {
      const n = await pii.staffName(tenantId, raw, employeeId).catch(() => "");
      if (n) return n;
    }
    const v = String(raw || "");
    if (v && !v.startsWith("staff:")) return v;
    const emp = await employeeOf(tenantId, raw, employeeId).catch(() => null);
    return (emp && emp.name) || "сотрудник";
  }

  /** Кто из сотрудников: событие журнала (a), смена (sh) или вся смена сейчас (team). */
  async function handleWho(req, res) {
    const u = new URL(req.url, "http://x");
    const t = u.searchParams.get("t") || "";
    const what = u.searchParams.get("w") || "";
    const id = u.searchParams.get("id") || "";
    const exp = Number(u.searchParams.get("e")) || 0;
    const page = (code, html) => htmlPage(res, code, "Кто из сотрудников", html);
    const esc = escHtml;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(t) || !["a", "sh", "team"].includes(what) || !/^[A-Za-z0-9_-]{1,128}$/.test(id)
        || exp < Date.now() || !sigOk(u.searchParams.get("k"), whoSig(secretKey(), t, what, id, exp))) {
      return page(403, "<p>Ссылка устарела или неверна. Откройте её из свежего сообщения бота.</p>");
    }
    const venue = await venueOf(t).catch(() => ({}));
    const person = async (raw, employeeId = "") => {
      const name = await nameOfWho(t, raw, employeeId);
      const role = await roleOfWho(t, raw, employeeId);
      return `${esc(name)}${role ? ` <span style="color:#666">(${esc(role)})</span>` : ""}`;
    };
    if (what === "a") {
      const a = (await tenantRef(t).collection("auditLog").doc(id).get()).data();
      if (!a) return page(404, "<p>Событие не найдено.</p>");
      const d = a.details || {};
      const text = alertText(venue.name || "Заведение", { ...a, whoRole: "", approvedRole: "" }) || "";
      return page(200, `<p>${esc(text)}</p>
<p><b>Кто:</b> ${await person(a.employeeName)}</p>
${d.approvedBy ? `<p><b>Подтвердил:</b> ${await person(d.approvedBy)}</p>` : ""}`);
    }
    if (what === "sh") {
      const sh = (await tenantRef(t).collection("staffShifts").doc(id).get()).data();
      if (!sh) return page(404, "<p>Смена не найдена.</p>");
      const started = toDate(sh.startedAt);
      const ended = toDate(sh.endedAt);
      return page(200, `<p><b>Сотрудник:</b> ${await person(sh.employeeName, sh.employeeId)}</p>
${started ? `<p>Начал смену в ${esc(hhmm(started, venue.timezone))}</p>` : ""}
${ended ? `<p>Закончил в ${esc(hhmm(ended, venue.timezone))}</p>` : ""}`);
    }
    const team = await onShiftStaff(t);
    if (!team.length) return page(200, "<p>Сейчас на смене никого не отмечено.</p>");
    const rows = [];
    for (const m of team) {
      rows.push(`<li>${await person(m.raw, m.id)}${m.since ? `, ${esc(sinceLabel(m.since, venue.timezone))}` : ""}</li>`);
    }
    return page(200, `<h2 style="margin:0 0 12px">${esc(venueTitle(venue))}${venueTitle(venue) ? " — " : ""}на смене сейчас</h2><ul>${rows.join("")}</ul>`);
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
      await bot.ready;
      if (update.callback_query) await onCallback(bot, update.callback_query);
      else if (update.message) await onMessage(bot, update.message);
    } catch (e) {
      console.error(`telegram update (${tenantId}):`, e.message || e);
    }
  }

  // Личный чат владельца: привязан и его ID по-прежнему в списке владельцев.
  const ownerChats = (cfg) => (cfg.ownerChats || []).filter((c) => roleOf(cfg, c.id) === "owner");
  const isOwnerChat = (bot, chatId) => ownerChats(bot.cfg).some((c) => c.id === chatId);
  const noAccess = (userId) => `Ваш Telegram ID: ${userId}. Управлять ботом могут только те, кого владелец `
    + "добавил в кабинете ZalPOS → Настройки → Telegram-бот → «Кто управляет ботом». Перешлите ему это число.";
  const isStaffChat = (bot, chatId) => (!!bot.cfg.staffChat && bot.cfg.staffChat.id === chatId)
    || Object.values(bot.cfg.staffChats || {}).some((c) => c && c.id === chatId);

  // ---- точка, которую смотрит владелец

  const multi = (bot) => (bot.points || []).length > 1;
  const pointName = (bot, tid) => ((bot.points || []).find((p) => p.id === tid) || {}).name || "Точка";
  /** Что показывать в этом чате: точку сети или "all". У одиночного — само заведение. */
  function viewOf(bot, chatId) {
    if (!multi(bot)) return bot.tenantId;
    const v = (bot.cfg.views || {})[String(chatId)] || "all";
    return v === "all" || bot.points.some((p) => p.id === v) ? v : "all";
  }
  const viewLabel = (bot, view) => (view === "all" ? "Все точки" : pointName(bot, view));
  const keyboardFor = (bot, chatId) => menuKeyboard(multi(bot) ? viewLabel(bot, viewOf(bot, chatId)) : "");

  async function setView(bot, chatId, view) {
    bot.cfg.views = { ...(bot.cfg.views || {}), [String(chatId)]: view };
    await botsCol().doc(bot.tenantId).update({ [`views.${chatId}`]: view }).catch(() => {});
  }

  function choosePoint(bot, chatId) {
    if (!multi(bot)) return say(bot, chatId, "У заведения одна точка — отчёты сразу по ней.", { reply_markup: keyboardFor(bot, chatId) });
    const cur = viewOf(bot, chatId);
    const rows = [[{ text: `${cur === "all" ? "✅ " : ""}🏢 Все точки — сводка по сети`, callback_data: "p:all" }]];
    for (const p of bot.points) rows.push([{ text: `${cur === p.id ? "✅ " : ""}${p.name}`.slice(0, 64), callback_data: `p:${p.id}` }]);
    return say(bot, chatId, "Какую точку показывать?", { reply_markup: { inline_keyboard: rows } });
  }

  function helpText(bot) {
    const lines = ["Отчёты — кнопками ниже. «📊 Ещё отчёты»: вчера, неделя, топ продаж, склад, брони, отмены, отзывы."];
    if (multi(bot)) lines.push(`Сеть «${bot.chainName}»: кнопка «${POINT_MARK}» сверху — выбрать точку или «Все точки» (сводка по сети).`);
    lines.push(`Сами приходят: итоги прошлой смены в ${SUMMARY_HOUR}:00, начало и конец смен, отмены позиций, закрытие без оплаты, возвраты, скидки от ${BIG_DISCOUNT_PERCENT}%.`);
    lines.push("/menu — отчёты, /id — ваш Telegram ID, /stop — отключить уведомления.");
    return lines.join("\n");
  }

  /** Личный чат владельца или управляющего из списка — получать отчёты и сигналы. */
  async function linkOwnerChat(bot, chat) {
    // Имя из Telegram не храним (Firestore — за рубежом): в кабинете чат
    // виден по подписи из «Кто управляет ботом».
    const name = "";
    await db().runTransaction(async (tx) => {
      const r = botsCol().doc(bot.tenantId);
      const cur = (await tx.get(r)).data() || {};
      // Владельцев и управляющих в списке до 30 — столько же и чатов.
      const owners = (cur.ownerChats || []).filter((c) => c.id !== chat.id).concat([{ id: chat.id, name }]).slice(-MAX_ALLOWED);
      tx.update(r, { ownerChats: owners });
    });
    bot.cfg.ownerChats = (bot.cfg.ownerChats || []).filter((c) => c.id !== chat.id).concat([{ id: chat.id, name }]);
    const n = bot.points.length;
    const word = n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? "точки" : n % 10 === 1 && n % 100 !== 11 ? "точка" : "точек";
    const what = multi(bot) ? `сеть «${bot.chainName}» (${n} ${word})` : `«${pointName(bot, bot.tenantId)}»`;
    return say(bot, chat.id, `Готово: ${what} подключено.\n\n${helpText(bot)}`, { reply_markup: keyboardFor(bot, chat.id) });
  }

  async function onMessage(bot, msg) {
    const chat = msg.chat || {};
    const text = String(msg.text || "").trim();
    if (!chat.id || !text) return;
    const group = chat.type === "group" || chat.type === "supergroup";
    const [cmdRaw, arg] = text.split(/\s+/, 2);
    const cmd = cmdRaw.replace(/@\w+$/, "");
    const userId = msg.from && msg.from.id;
    if (!userId) return;
    const role = roleOf(bot.cfg, userId);

    // Свой Telegram ID — любому, чтобы передать его владельцу.
    if (cmd === "/id") {
      return say(bot, chat.id, role
        ? `Ваш Telegram ID: ${userId}. Вы в списке: ${role === "owner" ? "владелец или управляющий" : "сотрудник"}.`
        : `Ваш Telegram ID: ${userId}. Перешлите это число владельцу заведения — он добавит его в кабинете ZalPOS → Настройки → Telegram-бот.`);
    }

    if (cmd === "/start" && arg) {
      const ref = linkRef(arg.replace(/[^a-f0-9]/g, "").slice(0, 32) || "-");
      const link = (await ref.get()).data();
      if (!link || (link.bot || link.tenantId) !== bot.tenantId || link.expiresAt.toMillis() < Date.now()) {
        return say(bot, chat.id, "Ссылка устарела. Нажмите кнопку подключения в кабинете ещё раз.");
      }
      // Группа — той точки, из кабинета которой её подключают.
      const point = bot.points.some((p) => p.id === link.tenantId) ? link.tenantId : bot.tenantId;
      if (link.kind === "staff") {
        if (!group) return say(bot, chat.id, "Эту ссылку нужно открыть, добавляя бота в рабочую группу сотрудников.");
        if (role !== "owner") return say(bot, chat.id, `Подключить группу может только владелец или управляющий из списка. ${noAccess(userId)}`);
        const staff = { id: chat.id, title: chat.title || "Группа" };
        await botsCol().doc(bot.tenantId).update(point === bot.tenantId ? { staffChat: staff } : { [`staffChats.${point}`]: staff });
        await ref.delete();
        const others = multi(bot) && point === bot.tenantId
          ? "\nСюда же придут заказы точек сети, у которых нет своей группы." : "";
        return say(bot, chat.id, `Группа подключена к «${pointName(bot, point)}». Сюда будут приходить заказы с собой и доставки — с кнопками статусов.${others}`);
      }
      if (group) return say(bot, chat.id, "Эта ссылка — для личного чата владельца, а не для группы.");
      // Ссылку могли переслать: подключается только ID из списка владельцев.
      if (role !== "owner" || chat.id !== userId) return say(bot, chat.id, noAccess(userId));
      await ref.delete();
      return linkOwnerChat(bot, chat);
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
    if (role === "staff") {
      return say(bot, chat.id, "Вы в списке сотрудников: заказы ведёте кнопками в рабочей группе. Отчёты получает владелец.");
    }
    if (role !== "owner" || chat.id !== userId) return say(bot, chat.id, noAccess(userId));
    // ID в списке владельцев — подключаем личный чат сразу, без ссылки из
    // кабинета: достаточно открыть бота и нажать «Запустить».
    if (!isOwnerChat(bot, chat.id)) return linkOwnerChat(bot, chat);
    if (text.startsWith(POINT_MARK) || cmd === "/point") return choosePoint(bot, chat.id);
    const key = Object.keys(MENU).find((k) => MENU[k] === text);
    if (key === "more") return say(bot, chat.id, "Ещё отчёты:", { reply_markup: moreKeyboard() });
    if (key) return say(bot, chat.id, await report(bot, key, viewOf(bot, chat.id)), { reply_markup: keyboardFor(bot, chat.id) });
    if (cmd === "/help") return say(bot, chat.id, helpText(bot), { reply_markup: keyboardFor(bot, chat.id) });
    return say(bot, chat.id, "Выберите отчёт:", { reply_markup: keyboardFor(bot, chat.id) });
  }

  /** Точка, к которой относится заказ из карточки: записана в карточке, иначе ищем. */
  async function tenantOfSession(bot, sessionId) {
    const card = (await botsCol().doc(bot.tenantId).collection("cards").doc(sessionId).get()).data();
    if (card && card.tenantId && bot.points.some((p) => p.id === card.tenantId)) return card.tenantId;
    for (const p of bot.points) {
      if ((await tenantRef(p.id).collection("sessions").doc(sessionId).get()).exists) return p.id;
    }
    return bot.tenantId;
  }

  async function onCallback(bot, q) {
    const chatId = q.message && q.message.chat && q.message.chat.id;
    const answer = (text, alert = false) => api(bot.token, "answerCallbackQuery", { callback_query_id: q.id, text: text || "", show_alert: alert }).catch(() => {});
    const userId = q.from && q.from.id;
    const [kind, sessionId, arg] = String(q.data || "").split(":");

    // Выбор точки и «Ещё отчёты» — только владельцу в его личном чате.
    if (kind === "p" || kind === "r") {
      if (!chatId || !isOwnerChat(bot, chatId) || roleOf(bot.cfg, userId) !== "owner") return answer("Нет доступа");
      if (kind === "p") {
        const view = sessionId === "all" ? "all" : bot.points.some((p) => p.id === sessionId) ? sessionId : null;
        if (!view || !multi(bot)) return answer();
        await setView(bot, chatId, view);
        await answer(`Точка: ${viewLabel(bot, view)}`);
        await api(bot.token, "editMessageText", { chat_id: chatId, message_id: q.message.message_id, text: `${POINT_MARK} Выбрано: ${viewLabel(bot, view)}` }).catch(() => {});
        return say(bot, chatId, view === "all"
          ? `Отчёты — по всей сети «${bot.chainName}». Выберите отчёт:`
          : `Отчёты — по точке «${pointName(bot, view)}». Выберите отчёт:`, { reply_markup: keyboardFor(bot, chatId) });
      }
      const key = (MORE.find(([k]) => k === sessionId) || [])[0];
      if (!key) return answer();
      await answer();
      return say(bot, chatId, await report(bot, key, viewOf(bot, chatId)), { reply_markup: keyboardFor(bot, chatId) });
    }

    if (!chatId || (!isStaffChat(bot, chatId) && !isOwnerChat(bot, chatId))) return answer("Нет доступа");
    // Нажимать кнопки могут только люди из списка — даже в рабочей группе.
    if (!userId || !roleOf(bot.cfg, userId)) {
      return answer(`Нет доступа. Ваш Telegram ID: ${userId || "?"} — попросите владельца добавить его в кабинете.`, true);
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId || "")) return answer();
    const tid = await tenantOfSession(bot, sessionId);
    const sesRef = tenantRef(tid).collection("sessions").doc(sessionId);
    const who = [q.from && q.from.first_name, q.from && q.from.last_name].filter(Boolean).join(" ") || "Сотрудник";

    // Режим РФ: имя курьера — в справочник, в чеке только отметка.
    const rf = await rfMode(tid);
    let courierToSave = "";

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
        if (arg === "courier" && !(s.courierName || s.courierSet)) {
          patch.courierSet = true;
          if (rf) courierToSave = who;
          else patch.courierName = who;
        }
        tx.update(sesRef, patch);
        result = flow.label(type, arg);
      });
      if (courierToSave) await saveCourier(tid, sessionId, courierToSave);
      // Карточку обновит слушатель чеков — тот же путь, что и для нажатий на кассе.
      return answer(result);
    }

    if (kind === "c") {
      const team = (await onShiftStaff(tid)).filter((m) => m.id);
      const tz = (await venueOf(tid).catch(() => ({}))).timezone;
      // Без имён: должность и время начала смены отличают людей друг от друга.
      const rows = team.slice(0, 8).map((m) => [{ text: `${m.role}${m.since ? ` · с ${hhmm(m.since, tz)}` : ""}`, callback_data: `k:${sessionId}:${m.id}`.slice(0, 64) }]);
      rows.push([{ text: "🙋 Я везу", callback_data: `k:${sessionId}:me` }]);
      rows.push([{ text: "← Назад", callback_data: `b:${sessionId}` }]);
      await api(bot.token, "editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: rows } }).catch(() => {});
      return answer("Кто везёт?");
    }

    if (kind === "k" || kind === "b") {
      if (kind === "k") {
        let name = who;
        if (arg !== "me") {
          const m = (await onShiftStaff(tid)).find((x) => x.id === arg);
          if (m) name = await nameOfWho(tid, m.raw, m.id);
        }
        let assigned = false;
        await db().runTransaction(async (tx) => {
          const s = (await tx.get(sesRef)).data();
          if (!s || !(s.status === "active" || s.deliveryOpen === true)) return;
          const patch = rf ? { courierSet: true } : { courierName: name, courierSet: true };
          assigned = true;
          // Готовый к передаче заказ сразу уходит «у курьера».
          if (s.orderType === "delivery" && flow.canMove("delivery", s.deliveryStatus, "courier") && s.deliveryStatus === "cooking") {
            Object.assign(patch, { deliveryStatus: "courier", deliveryStatusAt: admin.firestore.Timestamp.now() });
          }
          tx.update(sesRef, patch);
        });
        if (rf && assigned) await saveCourier(tid, sessionId, name);
      }
      const s = (await sesRef.get()).data();
      if (s) await refreshCard(bot, tid, { id: sessionId, ...s }, true);
      return answer(kind === "k" ? "Курьер назначен" : "");
    }
    return answer();
  }

  /** Имя курьера — в справочник в РФ (режим rf). */
  async function saveCourier(tenantId, sessionId, name) {
    await pii.put(tenantId, [{ k: "delivery", id: sessionId, fields: { extra: { courierName: name } } }])
      .catch((e) => console.error(`telegram courier (${tenantId}): ${e.message}`));
  }

  // ------------------------------------------------------------ копия данных точки
  //
  // Каждое чтение Firestore — из суточной квоты, а отчёты бота раньше
  // перечитывали все чеки дня (неделя — за 14 дней) при каждом нажатии.
  // Теперь сервер держит копию у себя, и отчёты считаются из неё:
  //  - чеки текущих рабочих суток — живой подпиской: чек читается один раз,
  //    когда его закрыли (и ещё раз — при возврате);
  //  - прошедшие сутки (до KEEP_DAYS) — в файле на сервере: из Firestore их
  //    читаем один раз; вчерашние перечитываем утром ещё раз — на случай
  //    касс, работавших без сети;
  //  - заведение, лояльность, смена кассы — подписками на документы.
  // Возврат и его отмена (refundedAt) обновляют копию. Подписка не
  // поднялась — отчёты читают Firestore напрямую, как раньше.

  /** tenantId → копия точки (пока точку слушает бот). */
  const stores = new Map();

  function watchDoc(st, ref, apply) {
    return new Promise((resolve) => {
      let first = true;
      const done = () => { if (first) { first = false; resolve(); } };
      st.unsubs.push(ref.onSnapshot((snap) => {
        Promise.resolve(apply(snap.exists ? snap.data() || {} : null)).catch(() => {}).then(done);
      }, (e) => {
        // Без настроек точки копия не годится — отчёты читают базу напрямую.
        console.error(`telegram copy (${st.tid}): ${e.message}`);
        st.failed = true;
        done();
      }));
    });
  }

  const cacheFile = (tid) => path.join(CACHE_DIR, `${tid}.json`);

  function saveSoon(st) {
    if (st.saveTimer || st.closed) return;
    st.saveTimer = setTimeout(() => { st.saveTimer = null; saveStore(st); }, 1000);
    if (st.saveTimer.unref) st.saveTimer.unref();
  }

  /** В файл — только прошедшие полные сутки: сегодняшние чеки придут подпиской. */
  function saveStore(st) {
    if (!st.today) return;
    const sales = [...st.sales.values()].filter((x) => x.closedAt < st.today && st.days.has(dayStartOf(st, x.closedAt)));
    const data = JSON.stringify({ v: 1, tz: st.venue.timezone || "", today: st.today, reconciled: st.reconciled || 0, days: [...st.days], sales });
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
      const tmp = `${cacheFile(st.tid)}.tmp`;
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, cacheFile(st.tid));
    } catch (e) {
      console.error(`telegram copy (${st.tid}): не записать файл — ${e.message}`);
    }
  }

  function loadStore(st) {
    let f;
    try {
      f = JSON.parse(fs.readFileSync(cacheFile(st.tid), "utf8"));
    } catch (_) {
      return;
    }
    // Сменили часовой пояс — границы суток другие, копия не годится.
    if (!f || f.v !== 1 || (f.tz || "") !== (st.venue.timezone || "")) return;
    const today = businessDayStart(new Date(), st.venue.timezone).getTime();
    const oldest = today - KEEP_DAYS * DAY_MS;
    for (const d of f.days || []) if (d >= oldest && d < today) st.days.add(d);
    for (const x of f.sales || []) if (x && x.id && x.closedAt >= oldest && x.closedAt < today) st.sales.set(x.id, x);
    st.reconciled = f.reconciled || 0;
  }

  /** Начало рабочих суток, в которые закрыт чек (ms). */
  function dayStartOf(st, ms) {
    if (ms >= st.today) return st.today + Math.floor((ms - st.today) / DAY_MS) * DAY_MS;
    return st.today - Math.ceil((st.today - ms) / DAY_MS) * DAY_MS;
  }

  function acquireStore(tid) {
    let st = stores.get(tid);
    if (!st) {
      st = { tid, refs: 0, venue: {}, ex: true, shift: null, sales: new Map(), days: new Set(), loading: new Map(),
        today: 0, reconciled: 0, unsubs: [], liveUnsub: null, liveReady: null, liveFailed: false, closed: false };
      stores.set(tid, st);
      st.ready = openStore(st).catch((e) => {
        console.error(`telegram copy (${tid}): ${e.message}; отчёты читают базу напрямую`);
        st.failed = true;
      });
    }
    st.refs++;
    return () => {
      if (--st.refs > 0) return;
      st.closed = true;
      stores.delete(tid);
      if (st.saveTimer) clearTimeout(st.saveTimer);
      saveStore(st);
      for (const u of [...st.unsubs, st.liveUnsub, st.shiftUnsub]) { try { if (u) u(); } catch (_) { /* уже отписан */ } }
    };
  }

  async function openStore(st) {
    const t = tenantRef(st.tid);
    await watchDoc(st, t, (d) => { st.venue = d || {}; });
    await watchDoc(st, t.collection("settings").doc("loyalty"), (d) => {
      st.ex = d && typeof d.excludeTobaccoFromPromo === "boolean" ? d.excludeTobaccoFromPromo : true;
    });
    // Смена кассы: какая открыта — и сама смена (время открытия, размен).
    await watchDoc(st, t.collection("meta").doc("shiftState"), (d) => {
      const id = d && d.openShiftId ? String(d.openShiftId) : null;
      if (id === st.shiftId) return null;
      if (st.shiftUnsub) { try { st.shiftUnsub(); } catch (_) { /* уже отписан */ } }
      st.shiftId = id;
      st.shiftUnsub = null;
      st.shift = null;
      if (!id) return null;
      return new Promise((resolve) => {
        st.shiftUnsub = t.collection("shifts").doc(id).onSnapshot((snap) => {
          const sh = snap.exists ? snap.data() : null;
          const openedAt = sh && (sh.status || "open") === "open" ? toDate(sh.openedAt) : null;
          if (st.shiftId === id) st.shift = openedAt ? { id, openedAt, data: sh } : null;
          resolve();
        }, (e) => { console.error(`telegram copy (${st.tid}): ${e.message}`); resolve(); });
      });
    });
    loadStore(st);
    await watchToday(st);
    // Возвраты (и их отмена) за срок копии — обновляем сохранённые чеки.
    const cutoff = Date.now() - (KEEP_DAYS + 1) * DAY_MS;
    let first = true;
    st.unsubs.push(t.collection("sessions").where("refundedAt", ">=", new Date(cutoff)).onSnapshot(async (snap) => {
      const stale = [];
      for (const ch of snap.docChanges()) {
        if (!st.sales.has(ch.doc.id)) continue;
        if (ch.type === "removed") stale.push(ch.doc.id);
        else st.sales.set(ch.doc.id, saleOf(ch.doc.id, ch.doc.data()));
      }
      if (first) {
        // Возврат отменили, пока сервер не работал.
        first = false;
        const ids = new Set(snap.docs.map((d) => d.id));
        for (const x of st.sales.values()) if (x.refunded && x.refundedAt >= cutoff && !ids.has(x.id)) stale.push(x.id);
      }
      for (const id of stale) {
        const d = await t.collection("sessions").doc(id).get().catch(() => null);
        if (d && d.exists) st.sales.set(id, saleOf(id, d.data()));
      }
      saveSoon(st);
    }, (e) => console.error(`telegram copy refunds (${st.tid}): ${e.message}`)));
  }

  /**
   * Подписка на чеки текущих рабочих суток. Сутки сменились — вчерашние
   * становятся полными (в файл), подписка — с новых суток.
   */
  function watchToday(st) {
    const start = businessDayStart(new Date(), st.venue.timezone).getTime();
    if (st.today === start && (st.liveUnsub || st.liveFailed)) return st.liveReady;
    if (st.today && st.today < start) {
      if (st.liveUnsub && !st.liveFailed) for (let d = st.today; d < start; d += DAY_MS) st.days.add(d);
      const oldest = start - KEEP_DAYS * DAY_MS;
      for (const [id, x] of st.sales) if (x.closedAt < oldest) st.sales.delete(id);
      for (const d of [...st.days]) if (d < oldest) st.days.delete(d);
    }
    if (st.liveUnsub) { try { st.liveUnsub(); } catch (_) { /* уже отписан */ } }
    st.liveUnsub = null;
    st.liveFailed = false;
    st.today = start;
    st.liveReady = new Promise((resolve) => {
      let first = true;
      st.liveUnsub = tenantRef(st.tid).collection("sessions").where("closedAt", ">=", new Date(start)).onSnapshot((snap) => {
        for (const ch of snap.docChanges()) {
          if (ch.type === "removed") st.sales.delete(ch.doc.id);
          else st.sales.set(ch.doc.id, saleOf(ch.doc.id, ch.doc.data()));
        }
        if (first) { first = false; resolve(); }
      }, (e) => {
        console.error(`telegram copy (${st.tid}): подписка на чеки — ${e.message}; отчёты читают базу напрямую`);
        st.liveFailed = true;
        st.liveUnsub = null;
        if (first) { first = false; resolve(); }
      });
    });
    saveSoon(st);
    return st.liveReady;
  }

  /** Прошедшие сутки [from, to) (границы — начала суток) — одним запросом, в копию. */
  async function loadDays(st, from, to, replace = false) {
    const key = `${from}-${to}`;
    if (st.loading.has(key)) return st.loading.get(key);
    const p = (async () => {
      const snap = await tenantRef(st.tid).collection("sessions")
        .where("closedAt", ">=", new Date(from)).where("closedAt", "<", new Date(to)).get();
      if (replace) for (const [id, x] of st.sales) if (x.closedAt >= from && x.closedAt < to) st.sales.delete(id);
      for (const d of snap.docs) st.sales.set(d.id, saleOf(d.id, d.data()));
      for (let d = from; d < to; d += DAY_MS) st.days.add(d);
      saveSoon(st);
    })().finally(() => st.loading.delete(key));
    st.loading.set(key, p);
    return p;
  }

  /** Копия точки, если она есть и исправна. */
  async function storeOf(tid) {
    const st = stores.get(tid);
    if (!st) return null;
    await st.ready;
    return st.failed || st.closed ? null : st;
  }

  /** Чеки из копии; недостающие прошедшие сутки — один раз из Firestore. */
  async function salesFromStore(st, from, to) {
    await watchToday(st);
    if (st.liveFailed) return null;
    const oldest = st.today - KEEP_DAYS * DAY_MS;
    const first = Math.max(dayStartOf(st, Math.max(from, oldest)), oldest);
    // Недостающие сутки — подряд идущими кусками, по запросу на кусок.
    let gap = null;
    for (let d = first; d < st.today && d < to; d += DAY_MS) {
      if (!st.days.has(d)) { if (gap === null) gap = d; continue; }
      if (gap !== null) { await loadDays(st, gap, d); gap = null; }
    }
    if (gap !== null) await loadDays(st, gap, Math.min(st.today, dayStartOf(st, to - 1) + DAY_MS));
    const out = [];
    for (const x of st.sales.values()) if (x.closedAt >= from && x.closedAt < to) out.push(x);
    // Старше срока копии (забытая смена кассы) — прямо из базы, без копии.
    if (from < oldest) {
      const snap = await tenantRef(st.tid).collection("sessions")
        .where("closedAt", ">=", new Date(from)).where("closedAt", "<", new Date(Math.min(oldest, to))).get();
      for (const d of snap.docs) out.push(saleOf(d.id, d.data()));
    }
    return out;
  }

  /** Утром — вчерашние сутки ещё раз: касса без сети могла прислать чеки позже. */
  async function reconcileStores() {
    for (const st of stores.values()) {
      try {
        await st.ready;
        if (st.failed || st.closed) continue;
        await watchToday(st);
        const h = localParts(new Date(), st.venue.timezone).h;
        if (st.liveFailed || st.reconciled === st.today || h < DAY_START_HOUR + 1) continue;
        await loadDays(st, st.today - DAY_MS, st.today, true);
        st.reconciled = st.today;
        saveSoon(st);
      } catch (e) {
        console.error(`telegram copy (${st.tid}): ${e.message}`);
      }
    }
  }

  // ------------------------------------------------------------ данные для отчётов

  async function venueOf(tenantId) {
    const st = await storeOf(tenantId);
    if (st) return st.venue || {};
    return (await tenantRef(tenantId).get()).data() || {};
  }

  async function loyaltyExclude(tenantId) {
    const st = await storeOf(tenantId);
    if (st) return st.ex;
    const l = (await tenantRef(tenantId).collection("settings").doc("loyalty").get()).data() || {};
    return typeof l.excludeTobaccoFromPromo === "boolean" ? l.excludeTobaccoFromPromo : true;
  }

  /**
   * Закрытые чеки с start; end не задан — без верхней границы. Время
   * закрытия ставят часы кассы: если они спешат хоть на минуту, условие
   * «раньше, чем сейчас на сервере» прятало только что пробитый чек.
   * У точек бота — из копии на сервере.
   */
  async function closedSince(tenantId, start, end = null) {
    const st = await storeOf(tenantId);
    if (st) {
      const out = await salesFromStore(st, start.getTime(), end ? end.getTime() : Infinity);
      if (out) return out;
    }
    let q = tenantRef(tenantId).collection("sessions").where("closedAt", ">=", start);
    if (end) q = q.where("closedAt", "<", end);
    const snap = await q.get();
    return snap.docs.map((d) => d.data());
  }

  /** Открытая кассовая смена — та же, что «Текущая смена» в X-отчёте. */
  async function openCashShift(tenantId) {
    const store = await storeOf(tenantId);
    if (store) return store.shift;
    const st = (await tenantRef(tenantId).collection("meta").doc("shiftState").get()).data() || {};
    if (!st.openShiftId) return null;
    const sh = (await tenantRef(tenantId).collection("shifts").doc(String(st.openShiftId)).get()).data();
    const openedAt = sh && (sh.status || "open") === "open" ? toDate(sh.openedAt) : null;
    return openedAt ? { id: String(st.openShiftId), openedAt, data: sh } : null;
  }

  /** «с 15:43» или «с 09.10 22:00», если смену открыли в другой день. */
  function sinceLabel(date, tz, now = new Date()) {
    const a = localParts(date, tz);
    const b = localParts(now, tz);
    const day = a.d === b.d && a.m === b.m && a.y === b.y ? "" : `${String(a.d).padStart(2, "0")}.${String(a.m).padStart(2, "0")} `;
    return `с ${day}${hhmm(date, tz)}`;
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
      // Имени нет: в Telegram — должность и время, имя — на странице в РФ.
      out.push({ id: s.employeeId || "", raw: s.employeeName || "", position: emp.position || "", role: roleLabel(emp), since: toDate(s.startedAt) });
    }
    return out.sort((a, b) => (a.since || 0) - (b.since || 0));
  }

  /** Сегодняшние рабочие сутки точки: заведение, часовой пояс, начало. */
  async function dayOf(tid) {
    const venue = await venueOf(tid);
    const now = new Date();
    return { venue, tz: venue.timezone, now, start: businessDayStart(now, venue.timezone), ex: await loyaltyExclude(tid) };
  }

  /** Деньги точки за сегодня и смену кассы — для «Выручки» и сводки сети. */
  async function moneyOf(tid) {
    const d = await dayOf(tid);
    const st = salesStats(await closedSince(tid, d.start), d.ex);
    const open = await activeSessions(tid);
    const shift = await openCashShift(tid);
    const shiftSt = shift ? salesStats(await closedSince(tid, shift.openedAt), d.ex) : null;
    return { ...d, st, open, openSum: open.reduce((a, s) => a + sessionBill(s), 0), shift, shiftSt, stale: shift ? staleCashText(shift.openedAt, d.tz, d.now) : null };
  }

  async function auditSince(tid, start, end = null) {
    let q = tenantRef(tid).collection("auditLog").where("createdAt", ">=", start);
    if (end) q = q.where("createdAt", "<", end);
    return (await q.get()).docs.map((x) => x.data());
  }

  /** Неделя: 7 рабочих суток по сегодня включительно и прошлые 7 — для сравнения. */
  async function weekOf(tid) {
    const d = await dayOf(tid);
    const from = new Date(d.start.getTime() - 6 * DAY_MS);
    const sessions = await closedSince(tid, new Date(from.getTime() - 7 * DAY_MS));
    const buckets = Array.from({ length: 7 }, () => []);
    const prev = [];
    for (const s of sessions) {
      const at = toDate(s.closedAt);
      if (!at) continue;
      const idx = Math.floor((at.getTime() - from.getTime()) / DAY_MS);
      if (idx < 0) prev.push(s);
      else buckets[Math.min(6, idx)].push(s);
    }
    return {
      tz: d.tz,
      days: buckets.map((list, i) => ({ start: new Date(from.getTime() + i * DAY_MS), st: salesStats(list, d.ex) })),
      prev: salesStats(prev, d.ex),
    };
  }

  function weekText(days, prevRevenue, tz) {
    const lines = ["📆 Неделя по дням (рабочие сутки с 6:00):"];
    let revenue = 0;
    let checks = 0;
    days.forEach((x, i) => {
      revenue += x.revenue;
      checks += x.checks;
      lines.push(`${dayLabel(x.start, tz)}${i === days.length - 1 ? " (сегодня)" : ""} — ${rub(x.revenue)} · ${x.checks} чек.`);
    });
    lines.push("", `Итого: ${rub(revenue)} · ${checks} чек.${checks ? ` · средний ${rub(revenue / checks)}` : ""}`);
    if (prevRevenue > 0) {
      const diff = Math.round(((revenue - prevRevenue) / prevRevenue) * 100);
      lines.push(`К прошлым 7 дням (${rub(prevRevenue)}): ${diff > 0 ? "+" : ""}${diff}%`);
    }
    return lines.join("\n");
  }

  // ------------------------------------------------------------ отчёты по точке

  const ONE = {
    async revenue(bot, tid) {
      const m = await moneyOf(tid);
      const st = m.st;
      // Смена кассы — те же цифры, что «Текущая смена» в X-отчёте: ночная
      // смена, начатая вчера, видна целиком.
      const shiftLine = m.shift
        ? `Смена кассы ${sinceLabel(m.shift.openedAt, m.tz)}: ${rub(m.shiftSt.revenue)} · чеков ${m.shiftSt.checks}`
          + ` (нал. ${rub(m.shiftSt.cash)}, карта ${rub(m.shiftSt.card)}, терминал/СБП ${rub(m.shiftSt.terminal)})`
        : "Касса закрыта — смена не открыта";
      return [
        venueTitle(m.venue) ? `🏠 ${venueTitle(m.venue)}` : "",
        `💰 Выручка сегодня (с ${DAY_START_HOUR}:00): ${rub(st.revenue)}`,
        `Чеков закрыто: ${st.checks}${st.checks ? ` · средний ${rub(st.revenue / st.checks)}` : ""}`,
        `Наличные ${rub(st.cash)} · карта ${rub(st.card)} · терминал/СБП ${rub(st.terminal)}`,
        st.aggregator ? `Агрегаторы: ${rub(st.aggregator)} (переведут позже)` : "",
        st.comp ? `За счёт заведения: ${rub(st.comp)}` : "",
        st.takeaway || st.delivery ? `С собой: ${st.takeaway} · доставка: ${st.delivery}` : "",
        shiftLine,
        `Открыто сейчас: ${m.open.length} чек. на ${rub(m.openSum)}`,
        m.stale ? `\n⚠️ ${m.stale[0].toUpperCase()}${m.stale.slice(1)}.` : "",
      ].filter(Boolean).join("\n");
    },
    async avg(bot, tid) {
      const d = await dayOf(tid);
      const today = salesStats(await closedSince(tid, d.start), d.ex);
      // Вчера к этому же часу — честное сравнение незаконченного дня.
      const yStart = new Date(d.start.getTime() - DAY_MS);
      const yesterday = salesStats(await closedSince(tid, yStart, new Date(d.now.getTime() - DAY_MS)), d.ex);
      const a = today.checks ? today.revenue / today.checks : 0;
      const b = yesterday.checks ? yesterday.revenue / yesterday.checks : 0;
      const diff = b ? Math.round(((a - b) / b) * 100) : null;
      return `🧾 Средний чек сегодня: ${rub(a)} (${today.checks} чек.)\n`
        + `Вчера к этому часу: ${rub(b)} (${yesterday.checks} чек.)${diff === null ? "" : `\nИзменение: ${diff > 0 ? "+" : ""}${diff}%`}`;
    },
    async kinds(bot, tid) {
      const d = await dayOf(tid);
      const st = salesStats(await closedSince(tid, d.start), d.ex);
      const total = st.kinds.kitchen + st.kinds.bar + st.kinds.hookah;
      const pct = (v) => (total ? Math.round((v / total) * 100) : 0);
      return [
        "🍽 Доли выручки сегодня:",
        `Кухня: ${rub(st.kinds.kitchen)} · ${pct(st.kinds.kitchen)}%`,
        `Бар: ${rub(st.kinds.bar)} · ${pct(st.kinds.bar)}%`,
        st.kinds.hookah ? `Кальяны: ${rub(st.kinds.hookah)} · ${pct(st.kinds.hookah)}%` : "",
      ].filter(Boolean).join("\n");
    },
    async seating(bot, tid) {
      const tables = await tenantRef(tid).collection("tables").get();
      const hall = tables.docs.filter((d) => d.id !== TAKEAWAY_TABLE);
      const busy = hall.filter((d) => (d.data().activeSessionIds || []).length > 0).length;
      const open = await activeSessions(tid);
      const take = open.filter((s) => s.tableId === TAKEAWAY_TABLE).length;
      const pct = hall.length ? Math.round((busy / hall.length) * 100) : 0;
      const b = await bookingsOf(tid);
      const next = b.upcoming[0];
      return `🪑 Посадка: занято ${busy} из ${hall.length} столов (${pct}%)\nОткрытых чеков в зале: ${open.length - take}`
        + (take ? `\nС собой и доставка в работе: ${take}` : "")
        + (b.list.length ? `\nБроней сегодня: ${b.list.length}${next ? ` · ближайшая в ${hhmm(next.at, b.tz)}` : ""}` : "");
    },
    async shift(bot, tid) {
      const venue = await venueOf(tid);
      const now = new Date();
      const team = await onShiftStaff(tid);
      const cash = await openCashShift(tid);
      const lines = [cash ? `👥 Касса открыта ${sinceLabel(cash.openedAt, venue.timezone)}` : "👥 Касса закрыта — смена не открыта"];
      const stale = cash ? staleCashText(cash.openedAt, venue.timezone, now) : null;
      if (stale) lines.push(`⚠️ ${stale[0].toUpperCase()}${stale.slice(1)}.`);
      if (!team.length) lines.push("На смене никого не отмечено.");
      for (const m of team) {
        const old = m.since && now.getTime() - m.since.getTime() > STALE_STAFF_SHIFT_MS;
        lines.push(`• ${m.role}${m.since ? `, ${sinceLabel(m.since, venue.timezone, now)}` : ""}${old ? " ⚠️ не закрыта" : ""}`);
      }
      if (team.some((m) => m.since && now.getTime() - m.since.getTime() > STALE_STAFF_SHIFT_MS)) {
        lines.push("⚠️ — личная смена идёт больше 16 часов: похоже, её забыли закрыть на кассе (зарплата посчитается неверно).");
      }
      if (team.length) lines.push("", `Кто именно: ${whoUrl(tid, "team", "now")}`);
      return lines.join("\n");
    },
    async delivery(bot, tid) {
      const open = (await activeSessions(tid)).filter((s) => s.tableId === TAKEAWAY_TABLE);
      if (!open.length) return "🛵 Заказов с собой и доставки в работе нет.";
      open.sort((a, b) => (Number(a.orderNo) || 0) - (Number(b.orderNo) || 0));
      return ["🛵 В работе:"].concat(open.map((s) => {
        const type = s.orderType === "delivery" ? "delivery" : "takeaway";
        const paid = (Number(s.guestPaidTotal) || 0) > 0 ? " · оплачен онлайн" : "";
        const app = s.source === "app" ? " · 📱" : "";
        return `• №${orderNo(s.id, s.orderNo)} ${type === "delivery" ? "доставка" : "с собой"} — ${flow.label(type, s.deliveryStatus)}, ${rub(sessionBill(s))}${paid}${app}`;
      })).join("\n");
    },
    async cash(bot, tid) {
      const venue = await venueOf(tid);
      const shift = await openCashShift(tid);
      if (!shift) return "💵 Касса закрыта — смена не открыта.";
      const sessions = (await closedSince(tid, shift.openedAt)).filter((s) => s.status !== "cancelled");
      let sales = 0;
      let tips = 0;
      for (const s of sessions) {
        if (s.closedWithoutPayment) continue;
        if (s.refunded && !s.refundCashOut) continue;
        sales += Number(s.paymentCash) || 0;
        tips += Number(s.tipsCash) || 0;
      }
      const ops = (await tenantRef(tid).collection("cashOps").where("shiftId", "==", shift.id).get()).docs.map((d) => d.data()).filter((o) => !o.cancelled);
      const sumOf = (type) => ops.filter((o) => o.type === type).reduce((a, o) => a + (Number(o.amount) || 0), 0);
      const opening = Number(shift.data.openingCash) || 0;
      const dep = sumOf("deposit");
      const col = sumOf("collection");
      const pay = sumOf("payout");
      const ref = sumOf("refund");
      const expected = opening + sales + tips + dep - col - pay - ref;
      const st = salesStats(sessions, await loyaltyExclude(tid));
      const stale = staleCashText(shift.openedAt, venue.timezone);
      return [
        `💵 Касса, смена ${sinceLabel(shift.openedAt, venue.timezone)}`,
        `На начало смены: ${rub(opening)}`,
        `+ наличные продажи: ${rub(sales)}`,
        tips ? `+ чаевые наличными: ${rub(tips)}` : "",
        dep ? `+ внесения: ${rub(dep)}` : "",
        col ? `− инкассация: ${rub(col)}` : "",
        pay ? `− выплаты: ${rub(pay)}` : "",
        ref ? `− возвраты наличными: ${rub(ref)}` : "",
        `= должно быть в кассе: ${rub(expected)}`,
        "",
        `Безнал за смену: карта ${rub(st.card)} · терминал/СБП ${rub(st.terminal)}${st.aggregator ? ` · агрегаторы ${rub(st.aggregator)}` : ""}`,
        stale ? `\n⚠️ ${stale[0].toUpperCase()}${stale.slice(1)}.` : "",
      ].filter((x) => x !== "").join("\n");
    },
    async yesterday(bot, tid) {
      const venue = await venueOf(tid);
      const lb = lastBusinessDay(new Date(), venue.timezone);
      const [sessions, audit] = await Promise.all([closedSince(tid, lb.start, lb.end), auditSince(tid, lb.start, lb.end)]);
      return buildSummary({ venueName: venueTitle(venue) || "Заведение", label: lb.label, sessions, audit, excludeTobacco: await loyaltyExclude(tid) });
    },
    async week(bot, tid) {
      const w = await weekOf(tid);
      return weekText(w.days.map((x) => ({ start: x.start, revenue: x.st.revenue, checks: x.st.checks })), w.prev.revenue, w.tz);
    },
    async top(bot, tid) {
      const d = await dayOf(tid);
      const top = topItems([salesStats(await closedSince(tid, d.start), d.ex)], 10);
      if (!top.length) return "🏆 Сегодня продаж ещё не было.";
      return ["🏆 Топ продаж сегодня:"].concat(top.map(([n, v, q], i) => `${i + 1}. ${n} — ${q} шт · ${rub(v)}`)).join("\n");
    },
    async stock(bot, tid) {
      const items = (await tenantRef(tid).collection("inventoryItems").get()).docs.map((d) => d.data())
        .filter((x) => x.active !== false && (Number(x.minQuantity) || 0) > 0 && (Number(x.quantity) || 0) <= Number(x.minQuantity));
      if (!items.length) return "📦 Склад: всё в норме, ничего не заканчивается.";
      items.sort((a, b) => (Number(a.quantity) / Number(a.minQuantity)) - (Number(b.quantity) / Number(b.minQuantity)));
      return [`📦 Заканчивается (${items.length}):`].concat(items.slice(0, 25).map((x) =>
        `• ${String(x.name || "—").slice(0, 60)}: ${qtyText(x.quantity, x.unit)} (минимум ${qtyText(x.minQuantity, x.unit)})`)).join("\n");
    },
    async bookings(bot, tid) {
      const b = await bookingsOf(tid);
      if (!b.list.length) return "📖 Броней на сегодня нет.";
      const guests = b.list.reduce((a, r) => a + (Number(r.guestsCount) || 0), 0);
      const waiting = b.list.filter((r) => r.status === "new").length;
      const STATUS = { new: "ждёт подтверждения", confirmed: "подтверждена", seated: "гости пришли" };
      // Без имён и телефонов гостей — время, стол, сколько человек.
      const lines = [`📖 Брони сегодня: ${b.list.length} · гостей ${guests}`];
      if (waiting) lines.push(`⏳ Ждут подтверждения: ${waiting} — подтвердите на кассе`);
      if (b.upcoming.length) {
        lines.push("", "Ближайшие:");
        for (const r of b.upcoming.slice(0, 12)) {
          lines.push(`• ${hhmm(r.at, b.tz)} · ${r.tableName || "стол не выбран"} · ${Number(r.guestsCount) || "?"} гост. · ${STATUS[r.status] || r.status || ""}`);
        }
      }
      return lines.join("\n");
    },
    async voids(bot, tid) {
      const d = await dayOf(tid);
      const audit = await auditSince(tid, d.start);
      const st = salesStats(await closedSince(tid, d.start), d.ex);
      const by = (action) => audit.filter((a) => a.action === action);
      const sum = (list) => list.reduce((a, x) => a + (Number(x.amount) || 0), 0);
      const voided = by("order_item_voided");
      const removed = by("order_item_removed");
      const unpaid = by("closed_without_payment");
      const refunds = by("refund");
      const discounts = by("discount_applied").filter((a) => (Number((a.details || {}).percent) || 0) >= BIG_DISCOUNT_PERCENT);
      const reasons = new Map();
      for (const a of voided) {
        const r = String((a.details || {}).reason || "без причины").slice(0, 40);
        reasons.set(r, (reasons.get(r) || 0) + 1);
      }
      const lines = ["⚠️ Отмены и скидки сегодня:"];
      lines.push(`Отменено позиций, которые уже готовили: ${voided.length}${voided.length ? ` на ${rub(sum(voided))}` : ""}`);
      if (reasons.size) lines.push(`Причины: ${[...reasons.entries()].map(([r, n]) => `${r} ×${n}`).join(", ")}`);
      lines.push(`Удалено до отправки на кухню: ${removed.length}${removed.length ? ` на ${rub(sum(removed))}` : ""}`);
      lines.push(`Закрыто без оплаты: ${unpaid.length}${unpaid.length ? ` на ${rub(sum(unpaid))}` : ""}`);
      lines.push(`Возвратов: ${refunds.length}${refunds.length ? ` на ${rub(sum(refunds))}` : ""}`);
      lines.push(`Скидок от ${BIG_DISCOUNT_PERCENT}%: ${discounts.length}`);
      if (st.discount >= 1) lines.push(`Все скидки в чеках: ${rub(st.discount)}`);
      if (voided.length || unpaid.length || refunds.length) lines.push("", "Кто именно — в кабинете: «Активность и журнал».");
      return lines.join("\n");
    },
    async reviews(bot, tid) {
      const since = new Date(Date.now() - 7 * DAY_MS);
      const list = (await tenantRef(tid).collection("reviews").where("createdAt", ">=", since).get()).docs.map((d) => d.data());
      const rated = list.filter((r) => (Number(r.rating) || 0) > 0);
      if (!rated.length) return "⭐ Отзывов за 7 дней нет.";
      const avg = rated.reduce((a, r) => a + Number(r.rating), 0) / rated.length;
      const count = (n) => rated.filter((r) => Math.round(Number(r.rating)) === n).length;
      const low = rated.filter((r) => Number(r.rating) <= 3).length;
      return [
        `⭐ Отзывы за 7 дней: ${rated.length} · средняя оценка ${avg.toFixed(1).replace(".", ",")}`,
        `5★ ${count(5)} · 4★ ${count(4)} · 3★ ${count(3)} · 2★ ${count(2)} · 1★ ${count(1)}`,
        low ? `Оценок 3 и ниже: ${low} — тексты отзывов в кабинете («Отзывы»).` : "Низких оценок нет 👍",
      ].join("\n");
    },
  };

  /** Брони точки на сегодняшние рабочие сутки, без отменённых. */
  async function bookingsOf(tid) {
    const d = await dayOf(tid);
    const end = new Date(d.start.getTime() + DAY_MS);
    const snap = await tenantRef(tid).collection("reservations").where("startTime", ">=", d.start).where("startTime", "<", end).get();
    const list = snap.docs.map((x) => ({ ...x.data(), at: toDate(x.data().startTime) }))
      .filter((r) => r.at && !["cancelled", "noShow", "no_show"].includes(r.status))
      .sort((a, b) => a.at - b.at);
    const soon = d.now.getTime() - 30 * 60000;
    return { tz: d.tz, list, upcoming: list.filter((r) => r.at.getTime() >= soon && r.status !== "seated") };
  }

  // ------------------------------------------------------------ отчёты по всей сети

  const section = (bot, tid, text) => `${POINT_MARK} ${pointName(bot, tid)}\n${text}`;
  async function perPoint(bot, key) {
    const parts = [];
    for (const p of bot.points) parts.push(section(bot, p.id, await ONE[key](bot, p.id)));
    return `🏢 Сеть «${bot.chainName}» — все точки\n\n${parts.join("\n\n")}`;
  }

  const ALL = {
    async revenue(bot) {
      const per = [];
      for (const p of bot.points) per.push({ p, m: await moneyOf(p.id) });
      const t = per.reduce((a, { m }) => {
        for (const k of ["revenue", "checks", "cash", "card", "terminal", "aggregator", "comp"]) a[k] += m.st[k];
        a.open += m.open.length;
        a.openSum += m.openSum;
        return a;
      }, { revenue: 0, checks: 0, cash: 0, card: 0, terminal: 0, aggregator: 0, comp: 0, open: 0, openSum: 0 });
      const lines = [
        `🏢 Сеть «${bot.chainName}» — все точки`,
        `💰 Выручка сегодня (с ${DAY_START_HOUR}:00): ${rub(t.revenue)}`,
        `Чеков закрыто: ${t.checks}${t.checks ? ` · средний ${rub(t.revenue / t.checks)}` : ""}`,
        `Наличные ${rub(t.cash)} · карта ${rub(t.card)} · терминал/СБП ${rub(t.terminal)}`,
        t.aggregator ? `Агрегаторы: ${rub(t.aggregator)} (переведут позже)` : "",
        t.comp ? `За счёт заведения: ${rub(t.comp)}` : "",
        `Открыто сейчас: ${t.open} чек. на ${rub(t.openSum)}`,
        "",
      ];
      const warn = [];
      for (const { p, m } of per) {
        const shift = m.shift ? `касса ${sinceLabel(m.shift.openedAt, m.tz)}` : "касса закрыта";
        lines.push(`${POINT_MARK} ${p.name}: ${rub(m.st.revenue)} · ${m.st.checks} чек. · открыто ${m.open.length} · ${shift}`);
        if (m.stale) warn.push(`• ${p.name}: ${m.stale}`);
      }
      if (warn.length) lines.push("", "⚠️ Обратите внимание:", ...warn);
      return lines.filter((x, i) => x !== "" || i > 0).join("\n");
    },
    async avg(bot) {
      let rev = 0;
      let chk = 0;
      const rows = [];
      for (const p of bot.points) {
        const d = await dayOf(p.id);
        const st = salesStats(await closedSince(p.id, d.start), d.ex);
        rev += st.revenue;
        chk += st.checks;
        rows.push(`${POINT_MARK} ${p.name}: ${rub(st.checks ? st.revenue / st.checks : 0)} (${st.checks} чек.)`);
      }
      return [`🏢 Сеть «${bot.chainName}»`, `🧾 Средний чек сегодня: ${rub(chk ? rev / chk : 0)} (${chk} чек.)`, "", ...rows].join("\n");
    },
    async kinds(bot) {
      const total = { kitchen: 0, bar: 0, hookah: 0 };
      const rows = [];
      for (const p of bot.points) {
        const d = await dayOf(p.id);
        const st = salesStats(await closedSince(p.id, d.start), d.ex);
        for (const k of Object.keys(total)) total[k] += st.kinds[k];
        rows.push(`${POINT_MARK} ${p.name}: кухня ${rub(st.kinds.kitchen)} · бар ${rub(st.kinds.bar)}${st.kinds.hookah ? ` · кальяны ${rub(st.kinds.hookah)}` : ""}`);
      }
      const sum = total.kitchen + total.bar + total.hookah;
      const pct = (v) => (sum ? Math.round((v / sum) * 100) : 0);
      return [
        `🏢 Сеть «${bot.chainName}» — доли выручки сегодня:`,
        `Кухня: ${rub(total.kitchen)} · ${pct(total.kitchen)}%`,
        `Бар: ${rub(total.bar)} · ${pct(total.bar)}%`,
        total.hookah ? `Кальяны: ${rub(total.hookah)} · ${pct(total.hookah)}%` : "",
        "",
        ...rows,
      ].filter((x, i, a) => x !== "" || (i > 0 && a[i - 1] !== "")).join("\n");
    },
    seating: (bot) => perPoint(bot, "seating"),
    shift: (bot) => perPoint(bot, "shift"),
    delivery: (bot) => perPoint(bot, "delivery"),
    cash: (bot) => perPoint(bot, "cash"),
    async yesterday(bot) {
      const home = await venueOf(bot.tenantId);
      const lb = lastBusinessDay(new Date(), home.timezone);
      return buildChainSummary({ chainName: bot.chainName, label: lb.label, points: await chainDay(bot, lb) });
    },
    async week(bot) {
      const days = Array.from({ length: 7 }, () => ({ start: null, revenue: 0, checks: 0 }));
      let prev = 0;
      let tz;
      const rows = [];
      for (const p of bot.points) {
        const w = await weekOf(p.id);
        tz = tz || w.tz;
        w.days.forEach((x, i) => {
          days[i].start = days[i].start || x.start;
          days[i].revenue += x.st.revenue;
          days[i].checks += x.st.checks;
        });
        prev += w.prev.revenue;
        const rev = w.days.reduce((a, x) => a + x.st.revenue, 0);
        rows.push(`${POINT_MARK} ${p.name}: ${rub(rev)}`);
      }
      return `🏢 Сеть «${bot.chainName}»\n${weekText(days, prev, tz)}\n\nПо точкам за 7 дней:\n${rows.join("\n")}`;
    },
    async top(bot) {
      const stats = [];
      for (const p of bot.points) {
        const d = await dayOf(p.id);
        stats.push(salesStats(await closedSince(p.id, d.start), d.ex));
      }
      const top = topItems(stats, 10);
      if (!top.length) return `🏢 Сеть «${bot.chainName}»: сегодня продаж ещё не было.`;
      return [`🏢 Сеть «${bot.chainName}» — топ продаж сегодня:`].concat(top.map(([n, v, q], i) => `${i + 1}. ${n} — ${q} шт · ${rub(v)}`)).join("\n");
    },
    stock: (bot) => perPoint(bot, "stock"),
    bookings: (bot) => perPoint(bot, "bookings"),
    voids: (bot) => perPoint(bot, "voids"),
    reviews: (bot) => perPoint(bot, "reviews"),
  };

  /** Данные закончившихся суток по каждой точке — для итогов сети. */
  async function chainDay(bot, lb) {
    const out = [];
    for (const p of bot.points) {
      const venue = await venueOf(p.id);
      if (venue.status === "deleted" || venue.status === "disabled") continue;
      const [sessions, audit, shift] = await Promise.all([closedSince(p.id, lb.start, lb.end), auditSince(p.id, lb.start, lb.end), openCashShift(p.id)]);
      const stale = shift ? staleCashText(shift.openedAt, venue.timezone) : null;
      out.push({ name: p.name, sessions, audit, excludeTobacco: await loyaltyExclude(p.id), notes: stale ? [stale] : [] });
    }
    return out;
  }

  /** Текст отчёта: по точке или по всей сети ("all"). */
  async function report(bot, key, view) {
    if (view === "all" && multi(bot)) return ALL[key](bot);
    const tid = view === "all" ? bot.tenantId : view;
    const text = await ONE[key](bot, tid);
    // У сети подписываем точку (в «Выручке» она уже есть — «🏠 …»).
    return multi(bot) && !text.startsWith("🏠") ? section(bot, tid, text) : text;
  }

  // ------------------------------------------------------------ карточки доставки

  async function refreshCard(bot, tid, s, force = false) {
    const staff = staffChatOf(bot.cfg, tid, bot.tenantId).chat;
    if (!staff || (bot.cfg.notify && bot.cfg.notify.delivery === false)) return;
    const cardRef = botsCol().doc(bot.tenantId).collection("cards").doc(s.id);
    const card = (await cardRef.get()).data();
    const venue = await venueOf(tid);
    let pending = [];
    if (s.source === "app" && !(s.orderItems || []).length) {
      const g = await tenantRef(tid).collection("guestOrders").where("sessionId", "==", s.id).get();
      pending = g.docs.map((d) => d.data()).filter((o) => o.status === "new").flatMap((o) => o.items || []);
    }
    const text = deliveryCardText(s, venue.timezone, pending, multi(bot) ? pointName(bot, tid) : "");
    const markup = deliveryKeyboard(s, s.orderType === "delivery" ? addressUrl(tid, s.id) : null);
    const sig = `${s.deliveryStatus || "new"}|${s.courierName || ""}|${s.courierSet ? 1 : 0}|${(s.orderItems || []).length}|${sessionBill(s)}|${pending.length}|${Number(s.guestPaidTotal) || 0}|${s.status}`;
    if (!card || card.chatId !== staff.id) {
      const m = await api(bot.token, "sendMessage", { chat_id: staff.id, text, reply_markup: markup }).catch((e) => {
        console.error(`telegram card (${tid}):`, e.message);
        return null;
      });
      if (m) await cardRef.set({ chatId: staff.id, messageId: m.message_id, sig, tenantId: tid });
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
      ? `❌ №${orderNo(sessionId, s && s.orderNo)} отменён${s.cancelReason ? `: ${String(s.cancelReason).slice(0, 120)}` : ""}`
      : st === "done"
        ? `✅ №${orderNo(sessionId, s && s.orderNo)} ${type === "delivery" ? "доставлен" : "выдан"}`
        : `✅ №${orderNo(sessionId, s && s.orderNo)} закрыт на кассе`;
    await api(bot.token, "editMessageReplyMarkup", { chat_id: card.chatId, message_id: card.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await api(bot.token, "sendMessage", { chat_id: card.chatId, text, reply_to_message_id: card.messageId }).catch(() => {});
    await cardRef.delete();
  }

  // ------------------------------------------------------------ слушатели

  /** Слушатели одной точки: заказы с собой и доставки, журнал кассы, смены. */
  function attachPoint(bot, tid) {
    // Копия чеков и настроек точки на сервере — отчёты считаются из неё.
    const unsubs = [acquireStore(tid)];
    const t = tenantRef(tid);
    const owners = () => ownerChats(bot.cfg);
    const on = (flag) => !bot.cfg.notify || bot.cfg.notify[flag] !== false;
    const label = () => (multi(bot) ? pointName(bot, tid) : "");

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
        return refreshCard(bot, tid, s);
      }
      if (!tracked.has(id) && s) return closeCard(bot, id, s);
      if (!tracked.has(id)) return;
      tracked.delete(id);
      const fresh = s || { id, ...((await t.collection("sessions").doc(id).get()).data() || {}) };
      return closeCard(bot, id, fresh);
    };
    const watch = (which, query) => unsubs.push(query.onSnapshot((snap) => {
      snap.docChanges().forEach((ch) => {
        if (ch.type === "removed") live[which].delete(ch.doc.id);
        else live[which].set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
        reconcile(ch.doc.id).catch((e) => console.error(`telegram card (${tid}):`, e.message));
      });
    }, (e) => console.error(`telegram sessions (${tid}):`, e.message)));
    const takeaway = t.collection("sessions").where("tableId", "==", TAKEAWAY_TABLE);
    watch("active", takeaway.where("status", "==", "active"));
    watch("open", takeaway.where("deliveryOpen", "==", true));

    // Журнал кассы: сигналы владельцу — с курсора, без повторов после рестарта.
    const cursor = (bot.cfg.auditCursors || {})[tid] || (tid === bot.tenantId ? bot.cfg.auditCursor : null) || bot.startedAt;
    unsubs.push(t.collection("auditLog").where("createdAt", ">", cursor).orderBy("createdAt")
      .onSnapshot(async (snap) => {
        const venue = await venueOf(tid).catch(() => ({}));
        let last = null;
        for (const ch of snap.docChanges()) {
          if (ch.type !== "added") continue;
          const a = ch.doc.data();
          last = a.createdAt || last;
          // Сначала — нужен ли сигнал вообще, потом должности (запросы к базе).
          let text = on("alerts") ? alertText(venue.name || "Заведение", { ...a, whoRole: "", approvedRole: "" }) : null;
          if (!text) continue;
          const d = a.details || {};
          text = alertText(venue.name || "Заведение", {
            ...a,
            whoRole: await roleOfWho(tid, a.employeeName),
            approvedRole: d.approvedBy ? await roleOfWho(tid, d.approvedBy) : "",
          });
          const extra = a.employeeName || d.approvedBy ? whoButton(tid, "a", ch.doc.id) : {};
          for (const c of owners()) await say(bot, c.id, text, extra);
        }
        if (last) {
          const patch = tid === bot.tenantId ? { auditCursor: last, [`auditCursors.${tid}`]: last } : { [`auditCursors.${tid}`]: last };
          botsCol().doc(bot.tenantId).update(patch).catch(() => {});
        }
      }, (e) => console.error(`telegram audit (${tid}):`, e.message)));

    // Смены сотрудников: начало и конец — владельцу, с ролью и временем.
    const dayAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 36 * 3600 * 1000);
    unsubs.push(t.collection("staffShifts").where("startedAt", ">=", dayAgo)
      .onSnapshot(async (snap) => {
        if (!on("shifts")) return;
        const venue = await venueOf(tid).catch(() => ({}));
        for (const ch of snap.docChanges()) {
          const s = ch.doc.data();
          const started = toDate(s.startedAt);
          const ended = toDate(s.endedAt);
          const since = bot.startedAt.toMillis();
          let what = null;
          if (ch.type === "added" && s.status === "open" && started && started.getTime() > since) what = "start";
          if (ch.type === "modified" && s.status !== "open" && ended && ended.getTime() > since) what = "end";
          if (!what) continue;
          const role = await roleOfWho(tid, s.employeeName, s.employeeId) || "сотрудник";
          const at = hhmm(what === "start" ? started : ended, venue.timezone);
          const icon = what === "start" ? "🟢" : "🔴";
          const verb = what === "start" ? "Начал смену" : "Закончил смену";
          // Имени нет — кто именно, по кнопке на сервере в РФ.
          const text = label() ? `${icon} ${label()} — ${verb.toLowerCase()}: ${role} в ${at}` : `${icon} ${verb}: ${role} в ${at}`;
          for (const c of owners()) await say(bot, c.id, text, whoButton(tid, "sh", ch.doc.id));
        }
      }, (e) => console.error(`telegram shifts (${tid}):`, e.message)));
    return unsubs;
  }

  /** Подтянуть точки сети и слушать новые; ушедшие — отключить. */
  async function syncPoints(bot) {
    const info = await loadPoints(bot.tenantId);
    if (bots.get(bot.tenantId) !== bot) return; // бота уже переподключили
    bot.chainId = info.chainId;
    bot.chainName = info.chainName;
    bot.points = info.points;
    bot.pointsAt = Date.now();
    const want = new Set(info.points.map((p) => p.id));
    for (const [tid, unsubs] of bot.pointUnsubs) {
      if (want.has(tid)) continue;
      unsubs.forEach((u) => { try { u(); } catch (_) { /* уже отписан */ } });
      bot.pointUnsubs.delete(tid);
    }
    for (const p of info.points) if (!bot.pointUnsubs.has(p.id)) bot.pointUnsubs.set(p.id, attachPoint(bot, p.id));
    // По chainId кабинет любой точки сети находит этого бота.
    if ((bot.cfg.chainId || null) !== (info.chainId || null)) {
      botsCol().doc(bot.tenantId).update({ chainId: info.chainId || null }).catch(() => {});
    }
  }

  function attach(tenantId, cfg) {
    detach(tenantId);
    let token;
    try {
      token = decrypt(secretKey(), cfg.tokenEnc);
    } catch (e) {
      console.error(`telegram: не расшифровать токен ${tenantId} — подключите бота заново`);
      return;
    }
    const bot = {
      tenantId, token, cfg, startedAt: admin.firestore.Timestamp.now(),
      chainId: "", chainName: "", points: [{ id: tenantId, name: "Заведение" }], pointsAt: 0, pointUnsubs: new Map(),
    };
    bots.set(tenantId, bot);
    // Адрес вебхука сменился (включили или убрали ретранслятор) — переставляем
    // его у Telegram сами, владельцу подключать бота заново не нужно.
    if (cfg.hookSecret && cfg.hookUrl !== hookUrl(tenantId)) {
      api(token, "setWebhook", { url: hookUrl(tenantId), secret_token: cfg.hookSecret, allowed_updates: ["message", "callback_query"] })
        .then(() => botsCol().doc(tenantId).update({ hookUrl: hookUrl(tenantId) }))
        .catch((e) => console.error(`telegram webhook (${tenantId}):`, e.message));
    }
    bot.ready = syncPoints(bot)
      .catch((e) => console.error(`telegram points (${tenantId}):`, e.message))
      .then(() => {
        const commands = [
          { command: "menu", description: "Отчёты" },
          ...(multi(bot) ? [{ command: "point", description: "Выбрать точку сети" }] : []),
          { command: "id", description: "Мой Telegram ID" },
          { command: "help", description: "Что умеет бот" },
          { command: "stop", description: "Отключить уведомления" },
        ];
        return api(token, "setMyCommands", { commands }).catch(() => {});
      });
  }

  function detach(tenantId) {
    const bot = bots.get(tenantId);
    if (!bot) return;
    for (const unsubs of bot.pointUnsubs.values()) unsubs.forEach((u) => { try { u(); } catch (_) { /* уже отписан */ } });
    bots.delete(tenantId);
  }

  /** Утренние итоги — раз в рабочие сутки после SUMMARY_HOUR; заодно — новые точки сети. */
  async function tick() {
    await reconcileStores();
    for (const bot of bots.values()) {
      try {
        await bot.ready;
        if (Date.now() - bot.pointsAt > POINTS_RESYNC_MS) await syncPoints(bot);
        if (bot.cfg.notify && bot.cfg.notify.summary === false) continue;
        const owners = ownerChats(bot.cfg);
        if (!owners.length) continue;
        const venue = await venueOf(bot.tenantId);
        if (venue.status === "deleted" || venue.status === "disabled") continue;
        const now = new Date();
        const lb = lastBusinessDay(now, venue.timezone);
        if (localParts(now, venue.timezone).h < SUMMARY_HOUR || bot.cfg.lastSummaryDay === lb.key) continue;
        let text;
        if (multi(bot)) {
          text = buildChainSummary({ chainName: bot.chainName, label: lb.label, points: await chainDay(bot, lb) });
        } else {
          const [sessions, audit, shift] = await Promise.all([
            closedSince(bot.tenantId, lb.start, lb.end), auditSince(bot.tenantId, lb.start, lb.end), openCashShift(bot.tenantId),
          ]);
          const stale = shift ? staleCashText(shift.openedAt, venue.timezone, now) : null;
          text = buildSummary({ venueName: venue.name || "Заведение", label: lb.label, sessions, audit,
            excludeTobacco: await loyaltyExclude(bot.tenantId), notes: stale ? [stale] : [] });
        }
        await botsCol().doc(bot.tenantId).update({ lastSummaryDay: lb.key });
        bot.cfg.lastSummaryDay = lb.key;
        for (const c of owners) await say(bot, c.id, text, { reply_markup: keyboardFor(bot, c.id) });
      } catch (e) {
        console.error(`telegram summary (${bot.tenantId}):`, e.message || e);
      }
    }
  }

  const groupsKey = (cfg) => JSON.stringify([(cfg.staffChat || {}).id || null, Object.entries(cfg.staffChats || {}).map(([k, v]) => [k, (v || {}).id]).sort()]);

  function start() {
    // Настройки всех ботов — живьём: подключили, сменили токен, отключили.
    botsCol().onSnapshot((snap) => {
      snap.docChanges().forEach((ch) => {
        const id = ch.doc.id;
        if (ch.type === "removed") return detach(id);
        const cfg = ch.doc.data();
        const cur = bots.get(id);
        // Тот же бот и те же группы — только обновляем чаты, флаги, курсоры.
        // Новая группа — переподключаемся: заказы в работе придут в неё.
        if (cur && cur.cfg.tokenEnc === cfg.tokenEnc && groupsKey(cur.cfg) === groupsKey(cfg)) cur.cfg = cfg;
        else attach(id, cfg);
      });
    }, (e) => console.error("telegram bots:", e.message));
    setInterval(() => tick().catch((e) => console.error("telegram tick:", e.message)), 2 * 60 * 1000);
  }

  return {
    handleSetup, handleStatus, handleLinkCode, handleAccess, handleNotify, handleUnlink, handleAddress, handleWho, handleHook, start,
  };
}

module.exports = {
  createTelegram, buildSummary, buildChainSummary, alertText, lastBusinessDay, businessDayStart, localParts, encrypt, decrypt,
  deliveryCardText, deliveryKeyboard, salesStats, addressSig, whoSig, roleLabel, allowedList, parseAllowed, staleCashText, menuKeyboard,
};
