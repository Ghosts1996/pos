"use strict";
// Обмен с 1С без файлов руками.
//
// 1) Бухгалтеру на почту — сам: Кабинет · «Обзор» → «Для бухгалтера» →
//    «Отправлять бухгалтеру автоматически»: почта и как часто (каждый день —
//    за вчера, каждую неделю — за прошлую, каждый месяц — за прошлый).
//    Письмо с той же книгой Excel, что кнопка «Скачать»: чеки, позиции,
//    возвраты, склад, смены и листы для 1С (розничные продажи по дням,
//    оплаты, номенклатура). Сервер проверяет раз в час и шлёт после 7:00 по
//    времени заведения — один раз за период.
// 2) 1С забирает сама: GET /api/v1/accounting?from&to (open-api.js, ключ
//    «Открытый API») — те же листы для 1С в JSON, для обработки загрузки.
//
// Книгу строит saas/console/accounting-export.js (одна и та же для кабинета
// и сервера); на сервере update-server.sh кладёт копию в kb/.

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { midnightIn } = require("./open-api");

const EMAIL_RE = /^[^\s@<>,;]{1,64}@[^\s@<>,;]{1,190}\.[a-zа-яё]{2,24}$/i;
const PERIODS = ["day", "week", "month"];

let exportMod = null;
/** accounting-export.js: на сервере — копия в kb/, в разработке — из saas/console. */
async function accountingExport() {
  if (exportMod) return exportMod;
  const candidates = [
    process.env.ACCOUNTING_EXPORT_JS,
    path.join(__dirname, "kb", "accounting-export.mjs"),
    path.join(__dirname, "..", "saas", "console", "accounting-export.js"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    exportMod = await import(pathToFileURL(p).href);
    return exportMod;
  }
  throw new Error("нет accounting-export.js — обновите сервер");
}

const pad = (n) => String(n).padStart(2, "0");

/** Местная дата «YYYY-MM-DD», час и день недели (пн = 1). */
function localParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday] || 1;
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: wd, y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const ruDate = (ymd) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

/**
 * Последний закончившийся период: { key, from, to (мс), label, file }.
 * day — вчера, week — прошлая неделя пн–вс, month — прошлый месяц.
 */
function lastPeriod(kind, nowMs, tz) {
  const t = localParts(nowMs, tz);
  let a, b, label;
  if (kind === "month") {
    const y = t.m === 1 ? t.y - 1 : t.y;
    const m = t.m === 1 ? 12 : t.m - 1;
    a = `${y}-${pad(m)}-01`;
    b = `${t.y}-${pad(t.m)}-01`;
    label = `${MONTHS[m - 1]} ${y}`;
  } else if (kind === "week") {
    const monday = addDays(t.ymd, -(t.weekday - 1));
    a = addDays(monday, -7);
    b = monday;
    label = `${ruDate(a)} — ${ruDate(addDays(b, -1))}`;
  } else {
    a = addDays(t.ymd, -1);
    b = t.ymd;
    label = ruDate(a);
  }
  return { key: `${kind}:${a}`, from: midnightIn(tz, a), to: midnightIn(tz, b), label, start: a };
}

/** Данные для книги — те же запросы, что у кнопки в кабинете. */
async function collect(db, admin, tid, from, to) {
  const t = db().collection("tenants").doc(tid);
  const ts = admin.firestore.Timestamp.fromMillis(from);
  const ms = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : v instanceof Date ? v.getTime() : 0);
  const rows = (snap, field) => snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => { const v = ms(x[field]); return v >= from && v < to; });
  const [sales, refunds, moves, shifts, adj, loyalty, menuSnap] = await Promise.all([
    t.collection("sessions").where("closedAt", ">=", ts).get(),
    t.collection("sessions").where("refundedAt", ">=", ts).get(),
    t.collection("inventoryMovements").where("createdAt", ">=", ts).get(),
    t.collection("staffShifts").where("startedAt", ">=", ts).get(),
    t.collection("payrollAdjustments").where("at", ">=", ts).get(),
    t.collection("settings").doc("loyalty").get().catch(() => null),
    t.collection("menuItems").get(),
  ]);
  const menu = {};
  menuSnap.docs.forEach((d) => { menu[d.id] = d.data(); });
  const ex = loyalty && loyalty.exists ? loyalty.data().excludeTobaccoFromPromo : undefined;
  return {
    data: {
      sessions: rows(sales, "closedAt").filter((s) => s.status === "closed"), refunds: rows(refunds, "refundedAt"),
      movements: rows(moves, "createdAt"), shifts: rows(shifts, "startedAt"), adjustments: rows(adj, "at"), menu,
    },
    excludeTobacco: typeof ex === "boolean" ? ex : true,
  };
}

async function venueTz(db, tid, tenant) {
  const g = await db().collection("tenants").doc(tid).collection("settings").doc("general").get().catch(() => null);
  const tz = String((g && g.exists && g.data().timezone) || (tenant && tenant.timezone) || "Europe/Moscow");
  try { new Intl.DateTimeFormat("ru", { timeZone: tz }); return tz; } catch (_) { return "Europe/Moscow"; }
}

/** Книга Excel за период → { buf, checks, total }. */
async function buildBook(db, admin, tid, from, to, tz) {
  const X = await accountingExport();
  const { data, excludeTobacco } = await collect(db, admin, tid, from, to);
  const sheets = X.buildAccountingSheets(data, { tz, excludeTobacco, tobaccoRe: X.BILL_TOBACCO_RE });
  const checks = Math.max(0, ((sheets.find((x) => x.name === "Чеки") || {}).rows || []).length - 2);
  const total = data.sessions.filter((s) => !s.closedWithoutPayment && s.training !== true)
    .reduce((a, s) => a + X.checkTotal(s, excludeTobacco, X.BILL_TOBACCO_RE), 0);
  return { buf: Buffer.from(X.buildXlsx(sheets)), checks, total, sheets };
}

function createAccountingMail(deps) {
  const { db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, getMailer, now = () => Date.now() } = deps;
  const settingsRef = (tid) => db().collection("tenants").doc(tid).collection("settings").doc("accountingMail");

  async function publicSettings(tid) {
    const d = (await settingsRef(tid).get()).data() || {};
    const ms = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : null);
    return {
      enabled: d.enabled === true, email: d.email || "", period: PERIODS.includes(d.period) ? d.period : "month",
      lastSentAt: ms(d.lastSentAt), lastLabel: d.lastLabel || "", lastError: d.lastError || "",
      mailReady: !!getMailer(),
    };
  }

  async function send(tid, period, { email } = {}) {
    const tsnap = await db().collection("tenants").doc(tid).get();
    const tenant = tsnap.data() || {};
    const tz = await venueTz(db, tid, tenant);
    const p = lastPeriod(period, now(), tz);
    const s = (await settingsRef(tid).get()).data() || {};
    const to = email || s.email;
    if (!to) throw new HttpError(400, "Укажите почту бухгалтера");
    const mailer = getMailer();
    if (!mailer) throw new HttpError(503, "Почта сервера не настроена — письмо отправить нельзя");
    const book = await buildBook(db, admin, tid, p.from, p.to, tz);
    const name = String(tenant.name || "Заведение").replace(/[\\/:*?"<>|]/g, " ").trim();
    const rub = (v) => `${Math.round(v).toLocaleString("ru-RU")} ₽`;
    await mailer.send({
      to,
      subject: `${name}: выгрузка для бухгалтера и 1С — ${p.label}`,
      text: [
        `Здравствуйте!`,
        ``,
        `Выгрузка продаж ${name} за ${p.label}: чеков ${book.checks}, выручка ${rub(book.total)}.`,
        `В файле: чеки, позиции, возвраты, склад, смены и листы для 1С — розничные продажи по дням (номенклатура, количество, сумма, ставка НДС), оплаты по дням и номенклатура.`,
        ``,
        `Письмо пришло автоматически из ZalPOS. Изменить почту или отключить — в кабинете заведения: «Обзор» → «Для бухгалтера».`,
      ].join("\n"),
      attachments: [{ filename: `${name} — ${p.start} — для бухгалтера.xlsx`, content: book.buf,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
    });
    return { ...p, checks: book.checks, total: book.total, to };
  }

  async function handle(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const tid = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new HttpError(400, "Не указано заведение");
    await requireTenantRole(tid, decoded.uid, ["owner", "admin"]);
    const action = String(body.action || "get");
    if (action === "get") return sendJson(res, 200, await publicSettings(tid));
    if (action === "settings") {
      const email = String(body.email || "").trim().toLowerCase();
      const enabled = body.enabled === true;
      if (enabled && !EMAIL_RE.test(email)) throw new HttpError(400, "Почта бухгалтера указана неверно");
      const period = PERIODS.includes(body.period) ? body.period : "month";
      await settingsRef(tid).set({ enabled, email, period, updatedAt: admin.firestore.Timestamp.fromMillis(now()), updatedBy: decoded.uid }, { merge: true });
      return sendJson(res, 200, await publicSettings(tid));
    }
    if (action === "send") {
      const cur = await publicSettings(tid);
      const period = PERIODS.includes(body.period) ? body.period : cur.period;
      const r = await send(tid, period);
      return sendJson(res, 200, { ok: true, label: r.label, checks: r.checks, total: Math.round(r.total * 100) / 100, to: r.to });
    }
    throw new HttpError(400, "Неизвестное действие");
  }

  /** Раз в час: у кого включено — за закончившийся период, после 7:00, один раз. */
  async function runAll() {
    const tenants = await db().collection("tenants").where("status", "in", ["active", "trial"]).get();
    let sent = 0;
    for (const t of tenants.docs) {
      const tid = t.id;
      try {
        const s = (await settingsRef(tid).get()).data();
        if (!s || s.enabled !== true || !s.email) continue;
        const tz = await venueTz(db, tid, t.data());
        if (localParts(now(), tz).hour < 7) continue;
        const period = PERIODS.includes(s.period) ? s.period : "month";
        const p = lastPeriod(period, now(), tz);
        if (s.lastKey === p.key) continue;
        // Сбой почты — не чаще раза в 6 часов, чтобы не стучать каждый час.
        const failedAt = s.lastErrorAt && typeof s.lastErrorAt.toMillis === "function" ? s.lastErrorAt.toMillis() : 0;
        if (s.lastErrorKey === p.key && now() - failedAt < 6 * 3600e3) continue;
        try {
          const r = await send(tid, period);
          await settingsRef(tid).set({ lastKey: p.key, lastLabel: r.label, lastSentAt: admin.firestore.Timestamp.fromMillis(now()), lastError: "" }, { merge: true });
          sent++;
        } catch (e) {
          await settingsRef(tid).set({ lastError: String(e.message || e).slice(0, 200), lastErrorKey: p.key, lastErrorAt: admin.firestore.Timestamp.fromMillis(now()) }, { merge: true });
        }
      } catch (e) {
        console.error(`saas-gateway: выгрузка бухгалтеру ${tid}:`, e.message || e);
      }
    }
    return sent;
  }

  return { handle, runAll, send };
}

/** Листы для 1С в JSON (GET /api/v1/accounting): строки таблиц → объекты. */
async function accountingJson(db, admin, tid, from, to, tz) {
  const X = await accountingExport();
  const { data, excludeTobacco } = await collect(db, admin, tid, from, to);
  const sheets = X.build1cSheets(data.sessions.filter((s) => !s.closedWithoutPayment && s.training !== true && s.refunded !== true), data.menu,
    { tz, excludeTobacco, tobaccoRe: X.BILL_TOBACCO_RE });
  const rows = (i) => (sheets[i].rows || []).slice(1);
  return {
    retail: rows(0).map(([date, name, qty, price, sum, vat, kind]) => ({ date, name, qty, price, sum, vat: vat || null, kind: kind === "Услуга" ? "service" : "goods" })),
    payments: rows(1).map(([date, cash, cashless, aggregator, comp, total]) => ({ date, cash, cashless, aggregator, comp, total })),
    nomenclature: rows(2).map(([name, unit, vat, kind]) => ({ name, unit, vat: vat || null, kind: kind === "Услуга" ? "service" : "goods" })),
  };
}

module.exports = { createAccountingMail, lastPeriod, localParts, accountingJson, accountingExport, buildBook, EMAIL_RE };
