"use strict";

/**
 * Партнёрская программа: менеджеры приводят заведения и получают процент с
 * их оплат подписки.
 *
 * - Супер-админ добавляет менеджера (почта, имя, процент, срок начислений) в
 *   панели платформы; менеджеру приходит письмо «задайте пароль и войдите».
 * - У менеджера — кабинет (zalpos.ru/#/partner) и Telegram-бот: личная
 *   ссылка zalpos.ru/?p=КОД и приглашение по почте. Приглашение уходит
 *   только с отметкой «клиент согласился получить письмо» (ст. 18 38-ФЗ), в
 *   письме — кто приглашает и ссылка отказа от писем.
 * - Новый владелец, зарегистрировавшийся по приглашению (30 дней) или по
 *   ссылке (кабинет помнит её 30 дней), закрепляется за менеджером навсегда;
 *   первый, кто пригласил, — тот и закрепил. Уже работающих клиентов
 *   закрепить нельзя.
 * - С каждой оплаты закреплённого клиента (подписка, продление, доп. точка
 *   сети) начисляется процент от суммы за вычетом налога платформы и
 *   комиссии платёжной системы (Robokassa присылает её в уведомлении, иначе —
 *   ставка из настроек). Тестовые оплаты не считаются.
 * - Выплаты делает владелец платформы сам и отмечает в панели «Выплачено».
 *
 * Данные — в хранилище на сервере (local-db), лимит Firebase не тратится.
 * Менеджер видит о клиенте только название заведения, тариф и суммы —
 * почту и телефон владельца после регистрации не показываем (152-ФЗ).
 */

const crypto = require("crypto");

const INVITE_TTL_MS = 30 * 24 * 3600 * 1000;
const INVITES_PER_DAY = 30;
// payoutMin — с какой суммы менеджер может запросить выплату; holdDays —
// сколько дней начисление ждёт после оплаты клиента (вдруг будет возврат).
const DEFAULT_SETTINGS = { taxPct: 6, feePct: 3.9, payoutMin: 1000, holdDays: 14 };
const DAY_MS = 24 * 3600 * 1000;
const NDFL_PCT = 13;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Редакция правил программы: менеджер принимает их в кабинете, редакция — в журнале.
const TERMS_EDITION = "Редакция № 2 от 24 октября 2026 г.";
const TAX_STATUSES = { npd: "самозанятый", ip: "ИП", person: "физлицо (налог удерживаете вы)" };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Сколько перечислить: самозанятому и ИП — всё начисленное (налоги они
 * платят сами); физлицу без статуса — за вычетом НДФЛ 13% (налог в полных
 * рублях, ст. 52 НК РФ), страховые взносы платформа платит сверху.
 */
function payoutCalc(gross, taxStatus) {
  const g = round2(gross);
  const ndfl = taxStatus === "person" ? Math.round(g * NDFL_PCT / 100) : 0;
  return { gross: g, ndfl, net: round2(g - ndfl) };
}

/** ИНН физлица/ИП — 12 цифр с двумя контрольными. */
function innOk(inn) {
  if (!/^\d{12}$/.test(inn)) return false;
  const d = inn.split("").map(Number);
  const k = (w) => (w.reduce((s, x, i) => s + x * d[i], 0) % 11) % 10;
  return k([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && k([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
}

/** Реквизиты для перевода по СБП: телефон, банк, ФИО, ИНН. */
function cleanDetails(body) {
  let phone = String(body.phone || "").replace(/\D/g, "");
  if (phone.length === 11 && phone[0] === "8") phone = `7${phone.slice(1)}`;
  if (phone.length === 10 && phone[0] === "9") phone = `7${phone}`;
  if (!/^79\d{9}$/.test(phone)) throw new Error("Телефон для СБП — российский мобильный, например +7 900 123-45-67");
  const bank = String(body.bank || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (bank.length < 2) throw new Error("Укажите банк, в который придёт перевод");
  const fullName = String(body.fullName || "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (!/^[А-ЯЁа-яё-]+(\s[А-ЯЁа-яё-]+){1,3}$/.test(fullName)) throw new Error("ФИО получателя — полностью, кириллицей, как в банке");
  const inn = String(body.inn || "").replace(/\D/g, "");
  if (!innOk(inn)) throw new Error("Проверьте ИНН: 12 цифр, как в «Мой налог» или на госуслугах");
  return { method: "sbp", phone: `+${phone}`, bank, fullName, inn };
}
/** Чек самозанятого за безналичную выплату — до 9-го числа следующего месяца (422-ФЗ, ст. 14). */
function receiptDue(paidMs) {
  const d = new Date(paidMs + 3 * 3600 * 1000); // по Москве
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 9, 20, 59, 59); // 9-е, 23:59 МСК
}
const RECEIPT_RE = /^https:\/\/lknpd\.nalog\.ru\/api\/v1\/receipt\/(\d{10,12})\/([\w-]{4,40})\/print\/?$/;

/**
 * Сроки по НДФЛ, удержанному в день выплаты (п. 6 ст. 226, п. 9 ст. 58 НК РФ):
 * удержан 1–22 — уведомление до 25-го, уплата до 28-го этого месяца;
 * 23–последнее — уведомление до 3-го, уплата до 5-го следующего; в декабре
 * с 23-го — всё до последнего рабочего дня года. Перенос с выходных — на
 * ближайший рабочий день (здесь не учитывается).
 */
function ndflDue(paidMs) {
  const d = new Date(paidMs + 3 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const at = (yy, mm, dd) => Date.UTC(yy, mm, dd, 12);
  if (d.getUTCDate() <= 22) return { noticeBy: at(y, m, 25), payBy: at(y, m, 28) };
  if (m === 11) return { noticeBy: at(y, 11, 31), payBy: at(y, 11, 31), yearEnd: true };
  return { noticeBy: at(y, m + 1, 3), payBy: at(y, m + 1, 5) };
}

const maskDetails = (d) => (d ? `СБП ${d.phone.slice(0, 2)} *** ***-${d.phone.slice(-4, -2)}-${d.phone.slice(-2)} · ${d.bank} · ${d.fullName.split(" ").map((w, i) => (i === 0 ? w : `${w[0]}.`)).join(" ")}` : "");
const normEmail = (e) => String(e || "").trim().toLowerCase();
const emailKey = (e) => crypto.createHash("sha256").update(normEmail(e)).digest("hex").slice(0, 32);
const toMs = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : typeof v === "number" ? v : 0);

/** a***@mail.ru — менеджер видит, кому ушло приглашение, без полного адреса. */
function maskEmail(e) {
  const [user, domain] = normEmail(e).split("@");
  if (!domain) return "";
  return `${user.slice(0, Math.min(2, user.length))}***@${domain}`;
}

const RU = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
/** «Анна Петрова» → «anna petrova» — для кода ссылки. */
const translit = (s) => String(s || "").toLowerCase().split("").map((ch) => (RU[ch] !== undefined ? RU[ch] : ch)).join("");

/** Код ссылки: латиница и цифры, 4–20 знаков. */
function cleanCode(c) {
  return String(c || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
}

/**
 * Начисление менеджеру с оплаты: процент от суммы за вычетом налога и
 * комиссии платёжной системы. Копейки — вниз не теряем, округляем до копейки.
 */
function computeAccrual({ gross, fee, taxPct, feePct, percent }) {
  const g = round2(gross);
  const f = Number.isFinite(Number(fee)) && Number(fee) > 0 ? round2(fee) : round2(g * (Number(feePct) || 0) / 100);
  const tax = round2(g * (Number(taxPct) || 0) / 100);
  const base = Math.max(0, round2(g - f - tax));
  return { gross: g, fee: f, tax, base, percent: Number(percent) || 0, amount: round2(base * (Number(percent) || 0) / 100) };
}

function createPartners(deps) {
  const {
    db, store, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireSuperAdmin,
    mailer, siteUrl = "https://zalpos.ru/", publicUrl = "", secretKey, encrypt, decrypt,
    fetchImpl = (...a) => fetch(...a), now = () => Date.now(),
    apiBase = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, ""),
    hookBase = (process.env.TELEGRAM_HOOK_BASE || "").replace(/\/+$/, ""),
    letters = require("./auth-email"),
    platformLegal = async () => ({}),
    notifyAdmins = () => {},
    npdApi = (process.env.NPD_STATUS_API || "https://statusnpd.nalog.ru/api/v1/tracker/taxpayer_status").replace(/\/+$/, ""),
    auth = () => admin.auth(),
  } = deps;
  const ts = (ms) => admin.firestore.Timestamp.fromMillis(ms);
  const col = (n) => store().collection(n);
  const partnersCol = () => col("partners");
  const aliasesCol = () => col("partnerCodeAliases");
  const settingsRef = () => col("partnerSettings").doc("main");
  const site = siteUrl.replace(/\/?$/, "/");

  async function settings() {
    const d = (await settingsRef().get()).data() || {};
    return { ...DEFAULT_SETTINGS, ...d };
  }

  async function isSuper(decoded) {
    try {
      await requireSuperAdmin(decoded);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function partnerByUid(uid) {
    const snap = await partnersCol().where("uid", "==", uid).limit(1).get();
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
  }

  async function partnerByCode(code) {
    const c = cleanCode(code);
    if (!c) return null;
    const snap = await partnersCol().where("code", "==", c).limit(1).get();
    if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
    // Прежний код после «Новая ссылка»: уже разосланные ссылки работают.
    const alias = (await aliasesCol().doc(c).get()).data();
    if (!alias || !alias.partnerId) return null;
    const d = (await partnersCol().doc(alias.partnerId).get()).data();
    return d ? { id: alias.partnerId, ...d } : null;
  }

  async function rememberOldCode(partnerId, code) {
    const c = cleanCode(code);
    if (c) await aliasesCol().doc(c).set({ partnerId, at: ts(now()) });
  }

  async function requirePartner(req) {
    const decoded = await verifyAuth(req);
    const p = await partnerByUid(decoded.uid);
    if (!p || p.status === "removed") throw new HttpError(403, "Вы не подключены к партнёрской программе — обратитесь к администратору ZalPOS");
    return { decoded, partner: p };
  }

  const linkOf = (p) => `${site}?p=${encodeURIComponent(p.code)}`;
  const optOutSig = (id) => crypto.createHmac("sha256", secretKey()).update(`partner-optout:${id}`).digest("hex").slice(0, 32);

  // ------------------------------------------------------------ сводки

  async function accrualsOf(partnerId) {
    return (await col("partnerAccruals").where("partnerId", "==", partnerId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  function sums(accruals) {
    let total = 0;
    let unpaid = 0;
    let paid = 0;
    for (const a of accruals) {
      if (a.status === "reversed") continue;
      total += a.amount;
      if (a.payoutId) paid += a.amount;
      else unpaid += a.amount;
    }
    return { total: round2(total), unpaid: round2(unpaid), paid: round2(paid) };
  }

  async function summaryOf(p) {
    const [clients, accruals] = await Promise.all([
      col("partnerClients").where("partnerId", "==", p.id).get(),
      accrualsOf(p.id),
    ]);
    return { clients: clients.size, ...sums(accruals), ...balanceOf(accruals, await settings(), p.taxStatus) };
  }

  // Новая редакция правил — менеджер принимает её заново.
  const termsOk = (p) => !!p.termsAcceptedAt && p.termsEditionAccepted === TERMS_EDITION;
  const detailsOf = (p) => {
    if (!p.payoutDetailsEnc) return null;
    try { return JSON.parse(decrypt(secretKey(), p.payoutDetailsEnc)); } catch (_) { return null; }
  };

  // ------------------------------------------------------------ баланс

  const isOpenAccrual = (a) => a.status !== "reversed" && !a.payoutId;
  /** Можно запросить: не выплачено, не в запросе, прошло holdDays (удержания — сразу). */
  const isAvailable = (a, s) => isOpenAccrual(a) && !a.requestId && (a.amount < 0 || toMs(a.paidAt) <= now() - s.holdDays * DAY_MS);

  function balanceOf(accruals, s, taxStatus) {
    let available = 0;
    let hold = 0;
    let requested = 0;
    let nextAt = 0;
    for (const a of accruals) {
      if (!isOpenAccrual(a)) continue;
      if (a.requestId) requested += a.amount;
      else if (isAvailable(a, s)) available += a.amount;
      else {
        hold += a.amount;
        const at = toMs(a.paidAt) + s.holdDays * DAY_MS;
        if (!nextAt || at < nextAt) nextAt = at;
      }
    }
    available = round2(available);
    return {
      available, hold: round2(hold), requested: round2(requested), holdUntil: nextAt || null,
      payoutMin: s.payoutMin, holdDays: s.holdDays, canRequest: available >= s.payoutMin && available > 0,
      calc: payoutCalc(Math.max(0, available), taxStatus),
    };
  }

  // ---- статус самозанятого — открытый сервис ФНС (не чаще 2 запросов в минуту)
  const npdCache = new Map(); // `${inn}:${день}` → { ok, message, at }
  const isoDay = (ms) => new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10);
  async function checkNpd(inn, atMs = now()) {
    const key = `${inn}:${isoDay(atMs)}`;
    const hit = npdCache.get(key);
    if (hit && now() - hit.at < 10 * 60 * 1000) return hit;
    let out;
    try {
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), 10000) : null;
      const r = await fetchImpl(npdApi, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inn, requestDate: isoDay(atMs) }), ...(ctl ? { signal: ctl.signal } : {}),
      });
      if (timer) clearTimeout(timer);
      const j = await r.json().catch(() => ({}));
      out = r.ok && typeof j.status === "boolean"
        ? { ok: j.status, message: String(j.message || "").slice(0, 300) }
        : { ok: null, message: String(j.message || `ФНС ответила ${r.status}`).slice(0, 300) };
    } catch (e) {
      out = { ok: null, message: `ФНС не ответила: ${String((e && e.message) || e).slice(0, 200)}` };
    }
    out.at = now();
    out.date = isoDay(atMs);
    if (out.ok !== null) npdCache.set(key, out);
    return out;
  }

  /** Номер договора не меняется вместе со ссылкой: запоминаем при первой выдаче. */
  async function contractNumberOf(p) {
    if (p.contractNumber) return p.contractNumber;
    const number = `${p.code}-${new Date(now()).getUTCFullYear()}`;
    await partnersCol().doc(p.id).set({ contractNumber: number }, { merge: true });
    p.contractNumber = number;
    return number;
  }

  const MONTHS_PREP = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  /** Назначение платежа: договор, период начислений, без НДС. */
  function purposeOf(number, accruals) {
    const months = [...new Set(accruals.filter((a) => a.amount > 0).map((a) => {
      const d = new Date(toMs(a.paidAt) + 3 * 3600 * 1000);
      return d.getUTCFullYear() * 100 + d.getUTCMonth();
    }))].sort();
    const name = (k) => `${MONTHS_PREP[k % 100]} ${Math.floor(k / 100)}`;
    const period = !months.length ? "" : months.length === 1 ? ` за ${name(months[0])} г.`
      : ` за ${name(months[0])} — ${name(months[months.length - 1])} г.`;
    return `Вознаграждение по договору № ${number} об оказании услуг по привлечению клиентов${period}${period ? "" : "."} НДС не облагается`;
  }

  const openRequestOf = async (partnerId) => {
    const snap = await col("partnerPayoutRequests").where("partnerId", "==", partnerId).get();
    const d = snap.docs.find((x) => x.data().status === "requested");
    return d ? { id: d.id, ...d.data() } : null;
  };
  const PAY_TERM_MS = 14 * DAY_MS; // договор: 10 рабочих дней с запроса
  const publicRequest = (r) => r && ({
    id: r.id, status: r.status, gross: r.gross, ndfl: r.ndfl, net: r.net, requestedAt: toMs(r.requestedAt), details: r.detailsMask || "",
    payBy: toMs(r.requestedAt) + PAY_TERM_MS, purpose: r.purpose || "", contractNumber: r.contractNumber || "", npdCheck: r.npdCheck || null,
  });

  const publicPartner = (p) => ({
    id: p.id, name: p.name || "", email: p.email, code: p.code, link: linkOf(p), percent: p.percent, months: p.months || 0,
    status: p.status, taxStatus: p.taxStatus || "npd", taxStatusLabel: TAX_STATUSES[p.taxStatus || "npd"],
    termsAcceptedAt: termsOk(p) ? toMs(p.termsAcceptedAt) : null, termsEdition: TERMS_EDITION, telegram: !!p.tgChatId,
    payoutDetails: p.payoutDetailsMask || "",
  });

  // ------------------------------------------------------------ кабинет менеджера

  async function handleMe(req, res) {
    const decoded = await verifyAuth(req);
    const p = await partnerByUid(decoded.uid);
    if (!p || p.status === "removed") return sendJson(res, 200, { partner: null });
    const s = await settings();
    sendJson(res, 200, { partner: publicPartner(p), summary: await summaryOf(p), settings: { taxPct: s.taxPct, feePct: s.feePct, payoutMin: s.payoutMin, holdDays: s.holdDays }, bot: botInfo() });
  }

  async function handleAcceptTerms(req, res) {
    const { partner } = await requirePartner(req);
    const body = await parseJsonBody(req);
    if (body.accept !== true) throw new HttpError(400, "Отметьте, что принимаете правила программы");
    await partnersCol().doc(partner.id).set({ termsAcceptedAt: ts(now()), termsEditionAccepted: TERMS_EDITION }, { merge: true });
    sendJson(res, 200, { ok: true });
  }

  const inviteRate = new Map(); // partnerId → { day, n }

  /** Пригласить заведение по почте (кабинет и бот). */
  async function invite(partner, { email, venueName = "", consent, ip = "" }) {
    if (partner.status !== "active") throw new HttpError(403, "Партнёрская программа для вас приостановлена — обратитесь к администратору");
    if (!partner.termsAcceptedAt) throw new HttpError(412, "Сначала примите правила партнёрской программы в кабинете");
    const e = normEmail(email);
    if (e.length > 254 || !EMAIL_RE.test(e)) throw new HttpError(400, "Проверьте адрес почты");
    if (consent !== true) throw new HttpError(400, "Отметьте, что клиент согласился получить приглашение на эту почту");
    if (normEmail(partner.email) === e) throw new HttpError(400, "Себя пригласить нельзя");
    const day = new Date(now()).toISOString().slice(0, 10);
    const r = inviteRate.get(partner.id);
    if (r && r.day === day && r.n >= INVITES_PER_DAY) throw new HttpError(429, `Не больше ${INVITES_PER_DAY} приглашений в сутки`);
    const key = emailKey(e);
    if ((await col("partnerOptOut").doc(key).get()).exists) {
      throw new HttpError(409, "Владелец этой почты отказался от приглашений — письмо не отправим");
    }
    // Уже клиент ZalPOS (есть аккаунт) — закрепить его нельзя.
    try {
      await auth().getUserByEmail(e);
      throw new HttpError(409, "По этой почте уже есть аккаунт ZalPOS — это действующий клиент, закрепить его нельзя");
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (!err || (err.code !== "auth/user-not-found" && err.code !== "auth/email-not-found")) throw err;
    }
    const prev = (await col("partnerInvites").where("emailKey", "==", key).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => x.status === "sent" && toMs(x.expiresAt) > now());
    const other = prev.find((x) => x.partnerId !== partner.id);
    if (other) throw new HttpError(409, "Это заведение уже пригласил другой менеджер — оно закреплено за ним до конца срока приглашения");
    const mine = prev.find((x) => x.partnerId === partner.id);
    if (mine && now() - toMs(mine.createdAt) < 24 * 3600 * 1000) throw new HttpError(429, "Приглашение на эту почту уже отправлено сегодня");
    if (!mailer()) throw new HttpError(503, "Почта платформы не настроена — приглашение не отправить");

    const id = mine ? mine.id : crypto.randomBytes(16).toString("hex");
    const at = now();
    const link = `${site}?invite=${id}#/signup`;
    const optOutLink = `${publicUrl}/partnerOptOut?i=${id}&k=${optOutSig(id)}`;
    const name = String(venueName || "").trim().slice(0, 80);
    await mailer().send({ to: e, ...letters.partnerInviteLetter({ managerName: partner.name || "", venueName: name, link, optOutLink, siteUrl: site }) });
    // Журнал согласия: кто, когда, на какую почту и с каким текстом отметки.
    await col("partnerInvites").doc(id).set({
      partnerId: partner.id, email: e, emailKey: key, venueName: name, status: "sent",
      consent: true, consentText: "Клиент согласился получить от ZalPOS письмо-приглашение на этот адрес", consentAt: ts(at), ip: String(ip).slice(0, 64),
      createdAt: mine ? mine.createdAt : ts(at), sentAt: ts(at), expiresAt: ts(at + INVITE_TTL_MS),
    }, { merge: true });
    inviteRate.set(partner.id, { day, n: (r && r.day === day ? r.n : 0) + 1 });
    return { id, expiresAt: at + INVITE_TTL_MS };
  }

  async function handleInvite(req, res) {
    const { partner } = await requirePartner(req);
    const body = await parseJsonBody(req);
    const ip = String((req.headers && (req.headers["x-real-ip"] || req.headers["x-forwarded-for"])) || "").split(",")[0];
    const r = await invite(partner, { email: body.email, venueName: body.venueName, consent: body.consent, ip });
    sendJson(res, 200, { ok: true, expiresAt: r.expiresAt });
  }

  /** Клиенты, приглашения и начисления менеджера. */
  async function dashboardOf(p) {
    const s0 = await settings();
    const [clientsSnap, invitesSnap, accruals, payoutsSnap] = await Promise.all([
      col("partnerClients").where("partnerId", "==", p.id).get(),
      col("partnerInvites").where("partnerId", "==", p.id).get(),
      accrualsOf(p.id),
      col("partnerPayouts").where("partnerId", "==", p.id).get(),
    ]);
    const byClient = new Map();
    for (const a of accruals) {
      if (a.status === "reversed") continue;
      const c = byClient.get(a.ownerUid) || { paid: 0, income: 0, payments: 0, lastPaidAt: 0 };
      c.paid += a.gross;
      c.income += a.amount;
      c.payments++;
      c.lastPaidAt = Math.max(c.lastPaidAt, toMs(a.paidAt));
      byClient.set(a.ownerUid, c);
    }
    const clients = clientsSnap.docs.map((d) => {
      const c = d.data();
      const s = byClient.get(d.id) || { paid: 0, income: 0, payments: 0, lastPaidAt: 0 };
      return {
        venueName: c.venueName || "Заведение", source: c.source, attachedAt: toMs(c.attachedAt), planName: c.planName || "",
        paidUntil: toMs(c.paidUntil) || null, payments: s.payments, paid: round2(s.paid), income: round2(s.income), lastPaidAt: s.lastPaidAt || null,
      };
    }).sort((a, b) => b.attachedAt - a.attachedAt);
    const invites = invitesSnap.docs.map((d) => {
      const x = d.data();
      const expired = x.status === "sent" && toMs(x.expiresAt) <= now();
      return { email: maskEmail(x.email), venueName: x.venueName || "", status: expired ? "expired" : x.status, sentAt: toMs(x.sentAt), expiresAt: toMs(x.expiresAt) };
    }).sort((a, b) => b.sentAt - a.sentAt).slice(0, 100);
    const history = accruals.map((a) => ({
      id: a.id, venueName: a.venueName || "", paidAt: toMs(a.paidAt), gross: a.gross, fee: a.fee, tax: a.tax, base: a.base,
      percent: a.percent, amount: a.amount, status: a.status, paidOut: !!a.payoutId, purpose: a.purpose || "",
      requested: !!a.requestId && !a.payoutId, availableAt: a.amount < 0 ? null : toMs(a.paidAt) + s0.holdDays * DAY_MS, clawback: !!a.clawbackOf,
    })).sort((a, b) => b.paidAt - a.paidAt);
    const payouts = payoutsSnap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id, amount: x.amount, ndfl: x.ndfl || 0, net: x.net ?? x.amount, paidAt: toMs(x.paidAt), note: x.note || "",
        taxStatus: x.taxStatus || "", receiptUrl: x.receiptUrl || "", receiptAt: toMs(x.receiptAt) || null,
        receivedAt: toMs(x.receivedAt) || null, notReceivedAt: toMs(x.notReceivedAt) || null, purpose: x.purpose || "",
        needReceipt: x.taxStatus === "npd" && !x.receiptUrl, receiptDue: x.taxStatus === "npd" ? receiptDue(toMs(x.paidAt)) : null,
      };
    }).sort((a, b) => b.paidAt - a.paidAt);
    const s = await settings();
    return {
      clients, invites, accruals: history, payouts, request: publicRequest(await openRequestOf(p.id)),
      summary: { clients: clients.length, ...sums(accruals), ...balanceOf(accruals, s, p.taxStatus) },
    };
  }

  async function handleDashboard(req, res) {
    const { partner } = await requirePartner(req);
    sendJson(res, 200, { partner: publicPartner(partner), ...(await dashboardOf(partner)) });
  }

  // ------------------------------------------------------------ приглашение: публичная часть

  /** Кабинет открыли по ссылке из письма — подставить почту в регистрацию. */
  async function handleInviteInfo(req, res) {
    const body = await parseJsonBody(req);
    const id = String(body.invite || "");
    if (!/^[a-f0-9]{32}$/.test(id)) return sendJson(res, 200, { ok: false });
    const x = (await col("partnerInvites").doc(id).get()).data();
    if (!x || x.status !== "sent" || toMs(x.expiresAt) <= now()) return sendJson(res, 200, { ok: false });
    const p = (await partnersCol().doc(x.partnerId).get()).data();
    sendJson(res, 200, { ok: true, email: x.email, managerName: (p && p.name) || "", code: (p && p.code) || "" });
  }

  /** «Согласия на письмо не было» — отказ от приглашений на эту почту. */
  async function handleOptOut(req, res) {
    const q = new URL(`http://x${req.url}`).searchParams;
    const id = String(q.get("i") || "");
    const ok = /^[a-f0-9]{32}$/.test(id) && crypto.timingSafeEqual(Buffer.from(optOutSig(id)), Buffer.from(String(q.get("k") || "").padEnd(32, "0").slice(0, 32)));
    let text = "Ссылка неверна или устарела.";
    if (ok) {
      const ref = col("partnerInvites").doc(id);
      const x = (await ref.get()).data();
      if (x) {
        await col("partnerOptOut").doc(x.emailKey).set({ at: ts(now()), inviteId: id });
        await ref.set({ status: "optedOut", optedOutAt: ts(now()), email: maskEmail(x.email) }, { merge: true });
        notify(x.partnerId, `🚫 Адрес ${maskEmail(x.email)}: получатель сообщил, что не давал согласия на письмо. Приглашения на этот адрес больше не отправляются.`).catch(() => {});
      }
      text = "Готово: приглашения ZalPOS на этот адрес больше приходить не будут. Извините за беспокойство.";
    }
    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZalPOS</title></head>
<body style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:#F3EEE6;color:#1D1A16;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box">
<div style="max-width:440px;background:#fff;border-radius:16px;padding:28px;line-height:1.5"><b style="font-size:20px">ZalPOS</b><p>${text}</p><a href="${site}" style="color:#B35C30">zalpos.ru</a></div></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  // ------------------------------------------------------------ закрепление и начисления

  /**
   * Новый владелец создал заведение или сеть. Закрепляем за менеджером, если
   * он пришёл по приглашению (та же почта, 30 дней) или по ссылке. Уже
   * закреплённого не перезакрепляем; владельца с другими заведениями —
   * не закрепляем (он уже клиент).
   */
  async function attachOwner({ uid, email, inviteId = "", code = "", venueName = "", firstVenue = true }) {
    if (!uid) return null;
    const ref = col("partnerClients").doc(uid);
    if ((await ref.get()).exists) return null;
    if (!firstVenue) return null;
    const e = normEmail(email);
    let partner = null;
    let source = "";
    let usedInvite = null;
    const invites = e ? (await col("partnerInvites").where("emailKey", "==", emailKey(e)).get()).docs.map((d) => ({ id: d.id, ...d.data() })) : [];
    const live = invites.filter((x) => x.status === "sent" && toMs(x.expiresAt) > now())
      .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
    usedInvite = live.find((x) => x.id === inviteId) || live[0] || null;
    if (usedInvite) {
      const p = (await partnersCol().doc(usedInvite.partnerId).get()).data();
      if (p && p.status === "active") { partner = { id: usedInvite.partnerId, ...p }; source = "invite"; }
    }
    if (!partner && code) {
      const p = await partnerByCode(code);
      if (p && p.status === "active") { partner = p; source = "link"; }
    }
    if (!partner || partner.uid === uid || normEmail(partner.email) === e) return null;
    // Закрепляется только новый клиент: аккаунт создан не раньше срока
    // приглашения (иначе это давний клиент, у которого просто не было точки).
    try {
      const created = Date.parse(((await auth().getUser(uid)) || {}).metadata?.creationTime || "");
      if (Number.isFinite(created) && created < now() - INVITE_TTL_MS) return null;
    } catch (_) { /* нет данных о входе — проверка по заведениям уже прошла */ }
    await ref.set({ partnerId: partner.id, ownerUid: uid, source, inviteId: source === "invite" ? usedInvite.id : null, venueName: String(venueName || "").slice(0, 80), attachedAt: ts(now()) });
    if (source === "invite") await col("partnerInvites").doc(usedInvite.id).set({ status: "registered", registeredAt: ts(now()), email: maskEmail(usedInvite.email) }, { merge: true });
    notify(partner.id, `🎉 Новый клиент: «${venueName || "заведение"}» — регистрация ${source === "invite" ? "по вашему приглашению" : "по вашей ссылке"}, клиент закреплён за вами.`).catch(() => {});
    return { partnerId: partner.id, source };
  }

  /** Оплата подписки зачислена: начисление менеджеру, если клиент закреплён. */
  async function onPayment({ invId, ownerUid, amount, fee, test, purpose, venueName = "", planName = "", paidUntil = null }) {
    if (!invId || !ownerUid || test) return null;
    const ref = col("partnerAccruals").doc(String(invId));
    if ((await ref.get()).exists) return null; // повтор уведомления
    const client = (await col("partnerClients").doc(ownerUid).get()).data();
    if (!client) return null;
    const partner = (await partnersCol().doc(client.partnerId).get()).data();
    if (!partner || partner.status !== "active") return null;
    const at = now();
    if (partner.months > 0 && at > toMs(client.attachedAt) + partner.months * 30.44 * 24 * 3600 * 1000) return null;
    const s = await settings();
    const a = computeAccrual({ gross: amount, fee, taxPct: s.taxPct, feePct: s.feePct, percent: partner.percent });
    await ref.set({
      partnerId: client.partnerId, ownerUid, invId: String(invId), purpose: purpose || "subscription", venueName: venueName || client.venueName || "",
      ...a, taxPct: s.taxPct, feeFromProvider: Number(fee) > 0, paidAt: ts(at), status: "accrued", payoutId: null,
    });
    await col("partnerClients").doc(ownerUid).set({
      ...(venueName ? { venueName } : {}), ...(planName ? { planName } : {}), ...(paidUntil ? { paidUntil: ts(paidUntil) } : {}), lastPaidAt: ts(at),
    }, { merge: true });
    notify(client.partnerId, `💰 Оплата от «${venueName || client.venueName || "клиента"}»: ${fmtRub(a.gross)}. Ваше начисление ${a.percent}%: <b>${fmtRub(a.amount)}</b> (база после налога и комиссии — ${fmtRub(a.base)}).`).catch(() => {});
    return a;
  }

  const fmtRub = (n) => `${round2(n).toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ₽`;

  // ------------------------------------------------------------ панель платформы

  async function handleAdminList(req, res) {
    await requireSuperAdmin(await verifyAuth(req));
    const s = await settings();
    const list = [];
    for (const d of (await partnersCol().get()).docs) {
      const p = { id: d.id, ...d.data() };
      if (p.status === "removed") continue;
      const r = await openRequestOf(p.id);
      // Администратору — полные реквизиты открытого запроса: по ним переводить.
      let request = null;
      if (r) {
        let details = null;
        try { details = JSON.parse(decrypt(secretKey(), r.detailsEnc)); } catch (_) {}
        request = { ...publicRequest(r), taxStatus: r.taxStatus, fullDetails: details };
      }
      const payouts = (await col("partnerPayouts").where("partnerId", "==", p.id).get()).docs.map((d) => d.data());
      const receiptsMissing = payouts.filter((x) => x.taxStatus === "npd" && !x.receiptUrl).length;
      list.push({ ...publicPartner(p), summary: await summaryOf(p), createdAt: toMs(p.createdAt), request, receiptsMissing });
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    sendJson(res, 200, { partners: list, settings: { taxPct: s.taxPct, feePct: s.feePct, payoutMin: s.payoutMin, holdDays: s.holdDays }, bot: botInfo(), termsEdition: TERMS_EDITION, taxStatuses: TAX_STATUSES });
  }

  async function handleAdminPartner(req, res) {
    await requireSuperAdmin(await verifyAuth(req));
    const body = await parseJsonBody(req);
    const id = String(body.id || "");
    if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(400, "Не указан менеджер");
    const p = (await partnersCol().doc(id).get()).data();
    if (!p) throw new HttpError(404, "Менеджер не найден");
    sendJson(res, 200, { partner: publicPartner({ id, ...p }), ...(await dashboardOf({ id, ...p })) });
  }

  /** Добавить или изменить менеджера. */
  async function handleAdminSave(req, res) {
    const decoded = await verifyAuth(req);
    await requireSuperAdmin(decoded);
    const body = await parseJsonBody(req);
    const percent = Number(body.percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new HttpError(400, "Процент — от 0 до 100");
    const months = Math.floor(Number(body.months) || 0);
    if (months < 0 || months > 120) throw new HttpError(400, "Срок начислений — от 0 (бессрочно) до 120 месяцев");
    const name = String(body.name || "").trim().slice(0, 80);
    const taxStatus = TAX_STATUSES[body.taxStatus] ? body.taxStatus : "npd";
    const status = ["active", "stopped", "removed"].includes(body.status) ? body.status : "active";
    if (body.id) {
      const ref = partnersCol().doc(String(body.id));
      const cur = (await ref.get()).data();
      if (!cur) throw new HttpError(404, "Менеджер не найден");
      const upd = { name, percent: round2(percent), months, taxStatus, status, updatedAt: ts(now()), updatedBy: decoded.uid };
      if (body.code !== undefined) {
        const code = cleanCode(body.code);
        if (code.length < 4) throw new HttpError(400, "Код ссылки — от 4 латинских букв и цифр");
        const other = await partnerByCode(code);
        if (other && other.id !== body.id) throw new HttpError(409, "Такой код ссылки уже занят");
        if (cur.code && cur.code !== code) await rememberOldCode(body.id, cur.code);
        upd.code = code;
      }
      await ref.set(upd, { merge: true });
      return sendJson(res, 200, { ok: true, id: body.id });
    }
    const email = normEmail(body.email);
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "Проверьте почту менеджера");
    const same = await partnersCol().where("email", "==", email).limit(1).get();
    if (!same.empty) {
      const old = { id: same.docs[0].id, ...same.docs[0].data() };
      if (old.status !== "removed") throw new HttpError(409, "Менеджер с этой почтой уже есть");
      // Удалённого раньше — возвращаем с прежним кодом ссылки и историей.
      await partnersCol().doc(old.id).set({ name, percent: round2(percent), months, taxStatus, status: "active", updatedAt: ts(now()), updatedBy: decoded.uid }, { merge: true });
      return sendJson(res, 200, { ok: true, id: old.id, code: old.code, restored: true, mailed: false });
    }
    let user;
    try {
      user = await auth().getUserByEmail(email);
    } catch (e) {
      if (e && (e.code === "auth/user-not-found" || e.code === "auth/email-not-found")) user = await auth().createUser({ email, displayName: name || undefined });
      else throw e;
    }
    let code = cleanCode(body.code) || cleanCode(translit(name)) || "";
    if (code.length < 4 || (await partnerByCode(code))) code = `${code.slice(0, 10)}${crypto.randomBytes(3).toString("hex").toUpperCase()}`.slice(0, 20);
    const ref = partnersCol().doc();
    await ref.set({ uid: user.uid, email, name, code, percent: round2(percent), months, taxStatus, status: "active", createdAt: ts(now()), createdBy: decoded.uid });
    let mailed = false;
    let mailError = mailer() ? "" : "почта платформы (SMTP) не настроена";
    if (mailer() && body.sendWelcome !== false) {
      try {
        const link = await auth().generatePasswordResetLink(email, { url: `${site}#/partner` });
        await mailer().send({ to: email, ...letters.partnerWelcomeLetter({ name, link, siteUrl: site }) });
        mailed = true;
      } catch (e) {
        mailError = String(e.message || e).slice(0, 200);
        console.error(`partners: письмо менеджеру ${email}: ${mailError}`);
      }
    }
    sendJson(res, 200, { ok: true, id: ref.id, code, mailed, mailError });
  }

  async function handleAdminSettings(req, res) {
    await requireSuperAdmin(await verifyAuth(req));
    const body = await parseJsonBody(req);
    const taxPct = Number(body.taxPct);
    const feePct = Number(body.feePct);
    if (!Number.isFinite(taxPct) || taxPct < 0 || taxPct > 50) throw new HttpError(400, "Налог — от 0 до 50%");
    if (!Number.isFinite(feePct) || feePct < 0 || feePct > 20) throw new HttpError(400, "Комиссия — от 0 до 20%");
    const upd = { taxPct: round2(taxPct), feePct: round2(feePct), updatedAt: ts(now()) };
    if (body.payoutMin !== undefined) {
      const v = Number(body.payoutMin);
      if (!Number.isFinite(v) || v < 0 || v > 100000) throw new HttpError(400, "Минимальная выплата — от 0 до 100 000 ₽");
      upd.payoutMin = round2(v);
    }
    if (body.holdDays !== undefined) {
      const v = Number(body.holdDays);
      if (!Number.isInteger(v) || v < 0 || v > 60) throw new HttpError(400, "Ожидание после оплаты — от 0 до 60 дней");
      upd.holdDays = v;
    }
    await settingsRef().set(upd, { merge: true });
    sendJson(res, 200, { ok: true });
  }

  // Одна выплата менеджера за раз: двойное нажатие не создаст двух выплат
  // на одни и те же начисления.
  const payoutLocks = new Map();
  function withPayoutLock(partnerId, fn) {
    const prev = payoutLocks.get(partnerId) || Promise.resolve();
    const run = prev.then(fn);
    const tail = run.catch(() => {});
    payoutLocks.set(partnerId, tail);
    tail.then(() => { if (payoutLocks.get(partnerId) === tail) payoutLocks.delete(partnerId); });
    return run;
  }

  /** «Выплачено»: все невыплаченные начисления менеджера закрываются выплатой. */
  async function handleAdminPayout(req, res) {
    const decoded = await verifyAuth(req);
    await requireSuperAdmin(decoded);
    const body = await parseJsonBody(req);
    const partnerId = String(body.partnerId || "");
    if (!/^[\w-]{1,64}$/.test(partnerId)) throw new HttpError(400, "Не указан менеджер");
    return withPayoutLock(partnerId, () => payout(decoded, body, partnerId, res));
  }

  async function payout(decoded, body, partnerId, res) {
    const pDoc = (await partnersCol().doc(partnerId).get()).data();
    if (!pDoc) throw new HttpError(404, "Менеджер не найден");
    const note = String(body.note || "").trim().slice(0, 200);
    const all = await accrualsOf(partnerId);
    let open;
    let request = null;
    if (body.requestId) {
      // По запросу менеджера — ровно те начисления, что попали в запрос.
      const rRef = col("partnerPayoutRequests").doc(String(body.requestId));
      const r = (await rRef.get()).data();
      if (!r || r.partnerId !== partnerId) throw new HttpError(404, "Запрос не найден");
      if (r.status !== "requested") throw new HttpError(409, r.status === "paid" ? "Этот запрос уже выплачен" : "Запрос отменён — обновите страницу");
      open = all.filter((a) => a.requestId === rRef.id && isOpenAccrual(a));
      request = { ref: rRef, ...r };
    } else {
      // Без запроса — всё невыплаченное, кроме того, что уже в чужом запросе.
      open = all.filter((a) => isOpenAccrual(a) && !a.requestId);
    }
    if (!open.length) throw new HttpError(400, "Невыплаченных начислений нет");
    const amount = round2(open.reduce((s, a) => s + a.amount, 0));
    if (amount <= 0) throw new HttpError(400, `К выплате ${fmtRub(amount)}: удержания за возвраты больше начислений`);
    if (request && Math.abs(request.gross - amount) > 0.009) throw new HttpError(409, "Сумма запроса не сходится с начислениями — отклоните запрос, менеджер запросит заново");
    if (body.expected !== undefined && Math.abs(Number(body.expected) - amount) > 0.009) {
      throw new HttpError(409, "Сумма к выплате изменилась — обновите страницу");
    }
    const taxStatus = (request && request.taxStatus) || pDoc.taxStatus || "npd";
    const calc = payoutCalc(amount, taxStatus);
    // Самозанятому — только если ФНС подтверждает статус на день перевода.
    let npdCheck = null;
    if (taxStatus === "npd") {
      const det = (request && (() => { try { return JSON.parse(decrypt(secretKey(), request.detailsEnc)); } catch (_) { return null; } })()) || detailsOf(pDoc);
      if (!det || !det.inn) {
        if (body.npdManual !== true) throw new HttpError(428, "У менеджера нет ИНН в реквизитах — проверьте статус самозанятого на npd.nalog.ru/check-status вручную и подтвердите");
        npdCheck = { ok: null, manual: true, at: now(), message: "ИНН не указан, проверено вручную" };
      } else {
        npdCheck = await checkNpd(det.inn);
        if (npdCheck.ok === false) {
          throw new HttpError(409, `ФНС: ИНН ${det.inn} не самозанятый на ${fmtDate(now())}. Не переводите как самозанятому: отклоните запрос и смените налоговый статус менеджера (физлицо — с удержанием НДФЛ, или ИП).`);
        }
        if (npdCheck.ok === null) {
          if (body.npdManual !== true) throw new HttpError(428, `ФНС сейчас не отвечает (${npdCheck.message}). Проверьте статус по ИНН ${det.inn} на npd.nalog.ru/check-status и подтвердите, что он действующий`);
          npdCheck = { ...npdCheck, manual: true };
        }
      }
    }
    const number = await contractNumberOf({ id: partnerId, ...pDoc });
    const purpose = (request && request.purpose) || purposeOf(number, open);
    const ref = col("partnerPayouts").doc();
    await ref.set({
      partnerId, amount, ndfl: calc.ndfl, net: calc.net, taxStatus, accrualIds: open.map((a) => a.id), note,
      contractNumber: number, purpose, ...(npdCheck ? { npdCheck } : {}),
      ...(request ? { requestId: request.ref.id } : {}), paidAt: ts(now()), by: decoded.uid,
    });
    for (const a of open) await col("partnerAccruals").doc(a.id).set({ payoutId: ref.id }, { merge: true });
    if (request) await request.ref.set({ status: "paid", payoutId: ref.id, paidAt: ts(now()) }, { merge: true });
    const lines = [`✅ <b>Выплата отправлена: ${fmtRub(calc.net)}</b>${note ? ` (${h(note)})` : ""}`];
    if (calc.ndfl) lines.push(`Начислено ${fmtRub(amount)}, удержан НДФЛ ${NDFL_PCT}% — ${fmtRub(calc.ndfl)}.`);
    if (taxStatus === "npd") {
      const pl = (await platformLegal().catch(() => ({}))) || {};
      const who = pl.fullName ? `ИП ${h(pl.fullName)}${pl.inn ? `, ИНН ${h(pl.inn)}` : ""}` : "ИП — правообладателя ZalPOS (реквизиты в договоре)";
      lines.push("", `🧾 Сформируйте чек в «Мой налог» на ${fmtRub(amount)}: покупатель — ${who}, услуга — «Привлечение клиентов по договору».`,
        `Срок — до ${fmtDate(receiptDue(now()))}. Пришлите сюда ссылку на чек («Поделиться» → «Скопировать ссылку»).`);
    }
    lines.push("", "Когда деньги придут, подтвердите — так у обеих сторон будет одна и та же картина.");
    notify(partnerId, lines.join("\n"), { reply_markup: { inline_keyboard: [[{ text: "✅ Деньги пришли", callback_data: `pgot_${ref.id}` }, { text: "❌ Не пришли", callback_data: `pnot_${ref.id}` }]] } }).catch(() => {});
    let ndfl = null;
    if (calc.ndfl) {
      const due = ndflDue(now());
      ndfl = { amount: calc.ndfl, noticeBy: due.noticeBy, payBy: due.payBy };
      try {
        notifyAdmins(`🧾 <b>НДФЛ ${fmtRub(calc.ndfl)}</b> удержан с выплаты ${h(pDoc.name || pDoc.email)}.\nУведомление об исчисленных суммах — до ${fmtDate(due.noticeBy)}, уплата ЕНП — до ${fmtDate(due.payBy)}${due.yearEnd ? " (декабрь: до последнего рабочего дня года)" : ""}. Если срок выпал на выходной — следующий рабочий день.\nСтраховые взносы с ${fmtRub(amount)} — по итогам месяца; квартальные 6-НДФЛ и РСВ — по реестру выплат в панели.`);
      } catch (_) {}
    }
    sendJson(res, 200, { ok: true, amount, ...calc, purpose, ndflDue: ndfl });
  }

  // ------------------------------------------------------------ запрос выплаты менеджером

  /** Реквизиты для перевода — хранятся зашифрованными, менеджеру видна маска. */
  async function handlePayoutDetails(req, res) {
    const { partner } = await requirePartner(req);
    const body = await parseJsonBody(req);
    let d;
    try { d = cleanDetails(body); } catch (e) { throw new HttpError(400, e.message); }
    await partnersCol().doc(partner.id).set({ payoutDetailsEnc: encrypt(secretKey(), JSON.stringify(d)), payoutDetailsMask: maskDetails(d), payoutDetailsAt: ts(now()) }, { merge: true });
    sendJson(res, 200, { ok: true, payoutDetails: maskDetails(d) });
  }

  async function requestPayout(partner) {
    return withPayoutLock(partner.id, async () => {
      const p = { id: partner.id, ...((await partnersCol().doc(partner.id).get()).data() || {}) };
      if (p.status !== "active") throw new HttpError(403, "Программа для вас приостановлена — обратитесь к администратору ZalPOS");
      if (!termsOk(p)) throw new HttpError(412, "Сначала примите правила партнёрской программы в кабинете");
      const details = detailsOf(p);
      if (!details) throw new HttpError(412, "Укажите реквизиты для перевода в кабинете менеджера");
      if (await openRequestOf(p.id)) throw new HttpError(409, "Запрос уже отправлен — дождитесь выплаты или отмените его");
      const overdue = (await col("partnerPayouts").where("partnerId", "==", p.id).get()).docs.map((d) => d.data())
        .find((x) => x.taxStatus === "npd" && !x.receiptUrl && receiptDue(toMs(x.paidAt)) < now());
      if (overdue) throw new HttpError(412, `Сначала прикрепите чек из «Мой налог» за выплату ${fmtRub(overdue.amount)} от ${fmtDate(toMs(overdue.paidAt))} — срок был до ${fmtDate(receiptDue(toMs(overdue.paidAt)))}. Без чеков новые выплаты не проводятся.`);
      const s = await settings();
      const avail = (await accrualsOf(p.id)).filter((a) => isAvailable(a, s));
      const gross = round2(avail.reduce((sum, a) => sum + a.amount, 0));
      if (gross <= 0 || gross < s.payoutMin) throw new HttpError(400, `Доступно к выплате ${fmtRub(Math.max(0, gross))} — запросить можно от ${fmtRub(s.payoutMin)}`);
      const taxStatus = p.taxStatus || "npd";
      let npd = null;
      if (taxStatus === "npd") {
        npd = await checkNpd(details.inn);
        if (npd.ok === false) {
          throw new HttpError(412, `ФНС: по ИНН ${details.inn} статус самозанятого на ${fmtDate(now())} не подтверждён${npd.message ? ` («${npd.message}»)` : ""}. Встаньте на учёт в «Мой налог» или сообщите администратору ZalPOS — выплата пойдёт как физлицу, с удержанием НДФЛ.`);
        }
      }
      const calc = payoutCalc(gross, taxStatus);
      const number = await contractNumberOf(p);
      const ref = col("partnerPayoutRequests").doc();
      await ref.set({
        partnerId: p.id, status: "requested", ...calc, taxStatus, accrualIds: avail.map((a) => a.id),
        detailsEnc: p.payoutDetailsEnc, detailsMask: maskDetails(details), requestedAt: ts(now()),
        contractNumber: number, purpose: purposeOf(number, avail), ...(npd ? { npdCheck: npd } : {}),
      });
      for (const a of avail) await col("partnerAccruals").doc(a.id).set({ requestId: ref.id }, { merge: true });
      try {
        notifyAdmins([
          `💸 <b>Запрос выплаты</b>: ${h(p.name || p.email)}`,
          `К перечислению: <b>${fmtRub(calc.net)}</b>${calc.ndfl ? ` (начислено ${fmtRub(calc.gross)}, НДФЛ ${fmtRub(calc.ndfl)} удержать и перечислить в бюджет)` : ""}`,
          `${TAX_STATUSES[taxStatus]} · СБП ${h(details.phone)} · ${h(details.bank)} · ${h(details.fullName)} · ИНН ${h(details.inn)}`,
          ...(npd ? [npd.ok ? "✅ ФНС: самозанятый на сегодня" : `⚠️ ФНС не ответила — проверьте статус на npd.nalog.ru/check-status перед переводом`] : []),
          `Назначение платежа: ${h(purposeOf(number, avail))}`,
          "Отметьте выплату в панели платформы → «Менеджеры».",
        ].join("\n"));
      } catch (_) {}
      return { id: ref.id, ...calc };
    });
  }

  async function cancelPayout(partner) {
    return withPayoutLock(partner.id, async () => {
      const r = await openRequestOf(partner.id);
      if (!r) throw new HttpError(404, "Открытого запроса нет");
      await releaseRequest(r, { status: "cancelled", cancelledAt: ts(now()) });
      return { ok: true };
    });
  }

  async function releaseRequest(r, patch) {
    await col("partnerPayoutRequests").doc(r.id).set(patch, { merge: true });
    for (const a of await accrualsOf(r.partnerId)) {
      if (a.requestId === r.id && !a.payoutId) await col("partnerAccruals").doc(a.id).set({ requestId: null }, { merge: true });
    }
  }

  async function handlePayoutRequest(req, res) {
    const { partner } = await requirePartner(req);
    const body = await parseJsonBody(req);
    if (body.action === "cancel") return sendJson(res, 200, await cancelPayout(partner));
    sendJson(res, 200, { ok: true, ...(await requestPayout(partner)) });
  }

  /** Самозанятый прикладывает ссылку на чек из «Мой налог» к выплате. */
  async function attachReceipt(partner, payoutId, url) {
    const u = String(url || "").trim();
    const m = u.match(RECEIPT_RE);
    if (!m) throw new HttpError(400, "Нужна ссылка на чек из «Мой налог»: https://lknpd.nalog.ru/api/v1/receipt/…/print");
    const det = detailsOf(partner);
    if (det && det.inn && m[1] !== det.inn) throw new HttpError(400, `Чек выбит на ИНН ${m[1]}, а в ваших реквизитах — ${det.inn}. Нужен чек, сформированный вами в «Мой налог».`);
    const dup = (await col("partnerPayouts").where("partnerId", "==", partner.id).get()).docs.find((d) => d.data().receiptUrl === u);
    if (dup) throw new HttpError(409, "Этот чек уже прикреплён к другой выплате — на каждую выплату нужен свой чек");
    let ref;
    if (payoutId) {
      ref = col("partnerPayouts").doc(String(payoutId));
      const x = (await ref.get()).data();
      if (!x || x.partnerId !== partner.id) throw new HttpError(404, "Выплата не найдена");
    } else {
      const waiting = (await col("partnerPayouts").where("partnerId", "==", partner.id).get()).docs
        .filter((d) => d.data().taxStatus === "npd" && !d.data().receiptUrl).sort((a, b) => toMs(a.data().paidAt) - toMs(b.data().paidAt));
      if (!waiting.length) throw new HttpError(404, "Нет выплат, которые ждут чека");
      ref = waiting[0].ref;
    }
    await ref.set({ receiptUrl: u, receiptAt: ts(now()) }, { merge: true });
    const x = (await ref.get()).data();
    try { notifyAdmins(`🧾 Чек от ${h(partner.name || partner.email)} за выплату ${fmtRub(x.amount)} от ${fmtDate(toMs(x.paidAt))}: ${h(u)}`); } catch (_) {}
    return { ok: true, payoutId: ref.id, amount: x.amount };
  }

  /** Менеджер подтверждает: деньги пришли / не пришли. */
  async function confirmPayout(partner, payoutId, got) {
    const ref = col("partnerPayouts").doc(String(payoutId || ""));
    const x = (await ref.get()).data();
    if (!x || x.partnerId !== partner.id) throw new HttpError(404, "Выплата не найдена");
    if (got) {
      await ref.set({ receivedAt: ts(now()), notReceivedAt: null }, { merge: true });
    } else {
      if (x.receivedAt) throw new HttpError(409, "Вы уже подтвердили, что деньги пришли");
      await ref.set({ notReceivedAt: ts(now()) }, { merge: true });
      try {
        notifyAdmins(`❗ <b>${h(partner.name || partner.email)}: деньги не пришли</b>\nВыплата ${fmtRub(x.net ?? x.amount)} от ${fmtDate(toMs(x.paidAt))}${x.note ? ` (${h(x.note)})` : ""}. Проверьте перевод в банке; если он не прошёл — переведите заново и напишите менеджеру.`);
      } catch (_) {}
    }
    return { ok: true, amount: x.net ?? x.amount };
  }

  async function handlePayoutConfirm(req, res) {
    const { partner } = await requirePartner(req);
    const body = await parseJsonBody(req);
    sendJson(res, 200, await confirmPayout(partner, body.payoutId, body.got === true));
  }

  async function handlePayoutReceipt(req, res) {
    const { partner } = await requirePartner(req);
    const body = await parseJsonBody(req);
    sendJson(res, 200, await attachReceipt(partner, body.payoutId, body.url));
  }

  // ---- документы для бухгалтерии

  const monthOf = (ms) => { const d = new Date(ms + 3 * 3600 * 1000); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }; };
  function sendFile(res, file, name, type) {
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Content-Length": file.length,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Disposition",
    });
    res.end(file);
  }

  async function actFile(p, monthStr) {
    const m = String(monthStr || "").match(/^(\d{4})-(\d{2})$/);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new HttpError(400, "Месяц — в виде 2026-10");
    const year = Number(m[1]);
    const month = Number(m[2]);
    const rows = (await accrualsOf(p.id)).filter((a) => a.status !== "reversed").filter((a) => {
      const x = monthOf(toMs(a.paidAt));
      return x.year === year && x.month === month;
    }).sort((a, b) => toMs(a.paidAt) - toMs(b.paidAt)).map((a) => ({
      venueName: a.venueName || "Клиент", paidAt: toMs(a.paidAt), gross: a.gross, base: a.base, amount: a.amount, clawback: !!a.clawbackOf,
    }));
    const number = await contractNumberOf(p);
    const file = require("./partner-contract").buildPartnerAct({
      platform: (await platformLegal().catch(() => ({}))) || {}, partner: p, details: detailsOf(p), number, year, month, rows, now: new Date(now()),
    });
    return { file, name: `Акт_${number}-${m[2]}.docx` };
  }

  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  async function handleAct(req, res) {
    const { partner } = await requirePartner(req);
    const body = await parseJsonBody(req);
    const { file, name } = await actFile(partner, body.month);
    sendFile(res, file, name, DOCX);
  }
  async function handleAdminAct(req, res) {
    await requireSuperAdmin(await verifyAuth(req));
    const body = await parseJsonBody(req);
    const id = String(body.id || "");
    if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(400, "Не указан менеджер");
    const d = (await partnersCol().doc(id).get()).data();
    if (!d) throw new HttpError(404, "Менеджер не найден");
    const { file, name } = await actFile({ id, ...d }, body.month);
    sendFile(res, file, name, DOCX);
  }

  /** Реестр выплат за год (CSV для Excel) — для 6-НДФЛ, РСВ и сверки чеков. */
  async function handleAdminPayoutsCsv(req, res) {
    await requireSuperAdmin(await verifyAuth(req));
    const body = await parseJsonBody(req);
    const year = Number(body.year) || monthOf(now()).year;
    const partners = new Map((await partnersCol().get()).docs.map((d) => [d.id, d.data()]));
    const rows = (await col("partnerPayouts").get()).docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => monthOf(toMs(x.paidAt)).year === year).sort((a, b) => toMs(a.paidAt) - toMs(b.paidAt));
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const num = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2).replace(".", ",");
    const head = ["Дата выплаты", "Менеджер", "ФИО получателя", "ИНН", "Статус", "Договор", "Начислено, ₽", "НДФЛ удержан, ₽", "Перечислено, ₽",
      "НДФЛ: уведомление до", "НДФЛ: уплата до", "Проверка ФНС (НПД)", "Чек «Мой налог»", "Получение подтверждено", "Назначение платежа", "Комментарий"];
    const lines = [head.map(q).join(";")];
    for (const x of rows) {
      const p = partners.get(x.partnerId) || {};
      const det = detailsOf(p) || {};
      const due = x.ndfl ? ndflDue(toMs(x.paidAt)) : null;
      const npd = x.npdCheck ? (x.npdCheck.ok === true ? `подтверждён ${x.npdCheck.date || ""}` : x.npdCheck.manual ? "проверено вручную" : "не подтверждён") : "";
      lines.push([
        fmtDate(toMs(x.paidAt)), p.name || p.email || "", det.fullName || "", det.inn || "", TAX_STATUSES[x.taxStatus] || x.taxStatus || "",
        x.contractNumber || p.contractNumber || "", num(x.amount), num(x.ndfl || 0), num(x.net ?? x.amount),
        due ? fmtDate(due.noticeBy) : "", due ? fmtDate(due.payBy) : "", npd,
        x.taxStatus === "npd" ? (x.receiptUrl || `нет (срок ${fmtDate(receiptDue(toMs(x.paidAt)))})`) : "",
        x.receivedAt ? fmtDate(toMs(x.receivedAt)) : x.notReceivedAt ? "менеджер: не пришли" : "", x.purpose || "", x.note || "",
      ].map(q).join(";"));
    }
    sendFile(res, Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8"), `Реестр_выплат_менеджерам_${year}.csv`, "text/csv; charset=utf-8");
  }

  /** Администратор: отклонить запрос (например, реквизиты не те) — деньги вернутся в «доступно». */
  async function handleAdminPayoutReject(req, res) {
    await requireSuperAdmin(await verifyAuth(req));
    const body = await parseJsonBody(req);
    const id = String(body.requestId || "");
    if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(400, "Не указан запрос");
    const r = (await col("partnerPayoutRequests").doc(id).get()).data();
    if (!r) throw new HttpError(404, "Запрос не найден");
    await withPayoutLock(r.partnerId, async () => {
      const cur = (await col("partnerPayoutRequests").doc(id).get()).data();
      if (cur.status !== "requested") throw new HttpError(409, "Запрос уже закрыт");
      const reason = String(body.reason || "").trim().slice(0, 300);
      await releaseRequest({ id, ...cur }, { status: "rejected", rejectedAt: ts(now()), reason });
      notify(r.partnerId, `↩️ Запрос выплаты ${fmtRub(cur.net)} отклонён${reason ? `: ${h(reason)}` : ""}. Сумма снова доступна — исправьте, что нужно, и запросите заново.`).catch(() => {});
    });
    sendJson(res, 200, { ok: true });
  }

  /** Возврат денег клиенту — начисление снимается (если ещё не выплачено — просто не войдёт в выплату). */
  async function handleAdminReverse(req, res) {
    await requireSuperAdmin(await verifyAuth(req));
    const body = await parseJsonBody(req);
    const accrualId = String(body.accrualId || "");
    if (!/^[\w-]{1,128}$/.test(accrualId)) throw new HttpError(400, "Не указано начисление");
    const ref = col("partnerAccruals").doc(accrualId);
    const a = (await ref.get()).data();
    if (!a) throw new HttpError(404, "Начисление не найдено");
    if (a.requestId && !a.payoutId) throw new HttpError(409, "Начисление в запросе на выплату — сначала отклоните запрос");
    if (a.payoutId) {
      // Уже выплачено: удерживаем из следующей выплаты (правила, раздел 3).
      if (body.restore) throw new HttpError(409, "Начисление выплачено — восстанавливать нечего");
      if (a.clawedBack) throw new HttpError(409, "Возврат по этой оплате уже учтён");
      await col("partnerAccruals").doc(`${accrualId}-back`).set({
        partnerId: a.partnerId, ownerUid: a.ownerUid || "", venueName: a.venueName || "", invId: `${a.invId || accrualId}-back`,
        gross: -a.gross, fee: -(a.fee || 0), tax: -(a.tax || 0), base: -(a.base || 0), percent: a.percent, amount: -a.amount,
        status: "accrued", payoutId: null, requestId: null, clawbackOf: accrualId, purpose: "Возврат клиенту — удержание из следующей выплаты",
        paidAt: ts(now()),
      });
      await ref.set({ clawedBack: true, clawedBackAt: ts(now()) }, { merge: true });
      notify(a.partnerId, `↩️ Клиенту «${h(a.venueName || "заведение")}» вернули оплату. Выплаченные ${fmtRub(a.amount)} будут удержаны из следующей выплаты.`).catch(() => {});
      return sendJson(res, 200, { ok: true, clawback: true });
    }
    await ref.set({ status: body.restore ? "accrued" : "reversed", reversedAt: ts(now()) }, { merge: true });
    sendJson(res, 200, { ok: true });
  }

  /** Договор с менеджером (.docx) — с реквизитами платформы и данными менеджера. */
  async function handleAdminContract(req, res) {
    await requireSuperAdmin(await verifyAuth(req));
    const body = await parseJsonBody(req);
    const id = String(body.id || "");
    if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(400, "Не указан менеджер");
    const p = (await partnersCol().doc(id).get()).data();
    if (!p) throw new HttpError(404, "Менеджер не найден");
    const number = await contractNumberOf({ id, ...p });
    const file = require("./partner-contract").buildPartnerContract({
      platform: (await platformLegal()) || {}, partner: p, settings: await settings(), number, now: new Date(now()), details: detailsOf(p),
    });
    const name = `Договор_${number}.docx`;
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="contract.docx"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Content-Length": file.length,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Disposition",
    });
    res.end(file);
  }

  // ------------------------------------------------------------ Telegram-бот менеджеров

  const HOOK_ID = "_partners";
  let bot = null; // { token, username, hookSecret }
  const awaiting = new Map(); // chatId → { email, venueName, at }

  async function loadBot() {
    const d = (await col("partnerSettings").doc("bot").get()).data();
    bot = null;
    if (!d || !d.tokenEnc) return;
    try {
      bot = { token: decrypt(secretKey(), d.tokenEnc), username: d.username || "", hookSecret: d.hookSecret || "" };
    } catch (_) {
      console.error("partners: токен бота менеджеров не расшифровать — подключите бота заново");
    }
  }

  function botInfo() {
    return bot ? { connected: true, username: bot.username } : { connected: false };
  }

  async function tg(method, params, token = bot && bot.token) {
    if (!token) throw new Error("бот менеджеров не подключён");
    const resp = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}), signal: AbortSignal.timeout(10000),
    });
    const json = await resp.json().catch(() => ({}));
    if (!json.ok) throw new Error(json.description || `Telegram ${resp.status}`);
    return json.result;
  }

  const say = (chatId, text, extra = {}) => tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  const h = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  async function notify(partnerId, html, extra = {}) {
    if (!bot) return;
    const p = (await partnersCol().doc(partnerId).get()).data();
    if (p && p.tgChatId) await say(p.tgChatId, html, extra).catch((e) => console.error(`partners: уведомление в Telegram: ${e.message || e}`));
  }

  async function handleAdminBot(req, res) {
    await requireSuperAdmin(await verifyAuth(req));
    const body = await parseJsonBody(req);
    const ref = col("partnerSettings").doc("bot");
    if (body.disconnect) {
      if (bot) await tg("deleteWebhook", {}).catch(() => {});
      await ref.set({ tokenEnc: null, username: null }, { merge: true });
      bot = null;
      return sendJson(res, 200, { ok: true, bot: botInfo() });
    }
    const token = String(body.token || "").trim();
    if (!/^\d{5,15}:[\w-]{30,60}$/.test(token)) throw new HttpError(400, "Токен бота — из @BotFather, вида 123456789:AA…");
    let me;
    try {
      me = await tg("getMe", {}, token);
    } catch (e) {
      throw new HttpError(400, `Telegram не принял токен: ${e.message || e}`);
    }
    const hookSecret = crypto.randomBytes(24).toString("hex");
    const url = hookBase ? `${hookBase}/${HOOK_ID}` : `${publicUrl}/tgHook/${HOOK_ID}`;
    await tg("setWebhook", { url, secret_token: hookSecret, allowed_updates: ["message", "callback_query"] }, token);
    await tg("setMyCommands", { commands: [
      { command: "income", description: "💼 Мой доход" },
      { command: "clients", description: "👥 Мои клиенты" },
      { command: "invite", description: "📨 Пригласить заведение" },
      { command: "link", description: "🔗 Моя ссылка для клиентов" },
      { command: "pitch", description: "✍️ Текст для клиента" },
      { command: "invites", description: "📋 Мои приглашения" },
      { command: "payouts", description: "💸 Мои выплаты" },
      { command: "help", description: "❓ Что умеет бот" },
    ] }, token).catch(() => {});
    await ref.set({ tokenEnc: encrypt(secretKey(), token), username: me.username || "", hookSecret, connectedAt: ts(now()) }, { merge: true });
    bot = { token, username: me.username || "", hookSecret };
    sendJson(res, 200, { ok: true, bot: botInfo() });
  }

  /**
   * Кабинет: «Новая ссылка». Код меняется, прежний остаётся рабочим — уже
   * разосланные ссылки по-прежнему закрепляют клиентов. 30 дней идут у
   * каждого посетителя от его последнего перехода по любой из ссылок.
   */
  async function renewLink(partner) {
    if (partner.status !== "active") throw new HttpError(403, "Программа для вас приостановлена — обратитесь к администратору ZalPOS");
    if (now() - toMs(partner.linkRenewedAt) < 60 * 1000) throw new HttpError(429, "Ссылку только что обновили — подождите минуту");
    const base = (cleanCode(translit(partner.name || "")) || "ZAL").slice(0, 10);
    let code = "";
    for (let i = 0; i < 6 && !code; i++) {
      const c = `${base}${crypto.randomBytes(3).toString("hex").toUpperCase()}`.slice(0, 20);
      if (!(await partnerByCode(c))) code = c;
    }
    if (!code) throw new HttpError(503, "Не удалось подобрать код — попробуйте ещё раз");
    await rememberOldCode(partner.id, partner.code);
    await partnersCol().doc(partner.id).set({ code, linkRenewedAt: ts(now()) }, { merge: true });
    return { code, link: linkOf({ code }) };
  }

  async function handleNewLink(req, res) {
    const { partner } = await requirePartner(req);
    sendJson(res, 200, { ok: true, ...(await renewLink(partner)) });
  }

  /** Кабинет: «Подключить Telegram» — одноразовая ссылка на бота. */
  async function handleTgLink(req, res) {
    const { partner } = await requirePartner(req);
    if (!bot || !bot.username) throw new HttpError(503, "Бот менеджеров ещё не подключён — администратор подключает его в панели платформы");
    const code = crypto.randomBytes(9).toString("hex");
    await partnersCol().doc(partner.id).set({ tgLinkCode: code, tgLinkUntil: ts(now() + 30 * 60 * 1000) }, { merge: true });
    sendJson(res, 200, { url: `https://t.me/${bot.username}?start=pl_${code}` });
  }

  async function partnerByChat(chatId) {
    const snap = await partnersCol().where("tgChatId", "==", chatId).limit(1).get();
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
  }

  // Кнопки внизу чата — всегда под рукой, команды набирать не нужно.
  const BTN = {
    income: "💼 Мой доход", clients: "👥 Клиенты", invite: "📨 Пригласить заведение", link: "🔗 Моя ссылка", pitch: "✍️ Текст для клиента",
    invites: "📋 Приглашения", payouts: "💸 Выплаты", help: "❓ Помощь",
  };
  const MENU = {
    keyboard: [
      [{ text: BTN.income }, { text: BTN.clients }],
      [{ text: BTN.invite }],
      [{ text: BTN.link }, { text: BTN.pitch }],
      [{ text: BTN.invites }, { text: BTN.payouts }],
      [{ text: BTN.help }],
    ],
    resize_keyboard: true, is_persistent: true, input_field_placeholder: "Выберите действие",
  };
  const cabinetUrl = () => `${site}#/partner`;
  const cabinetBtn = (text = "🖥 Открыть кабинет") => ({ text, url: cabinetUrl() });
  const HELP = [
    "<b>Бот менеджеров ZalPOS</b>",
    "",
    `${BTN.income} — начислено, к выплате и выплачено`,
    `${BTN.clients} — ваши заведения и их оплаты`,
    `${BTN.invite} — письмо владельцу заведения`,
    `${BTN.link} — ссылка для клиентов, её можно переслать`,
    `${BTN.pitch} — готовое сообщение владельцу со ссылкой`,
    `${BTN.invites} — кому отправлены письма и кто зарегистрировался`,
    `${BTN.payouts} — запросить выплату, история выплат и чеки`,
    "",
    "Бот сам сообщит о новых клиентах, оплатах и выплатах, а за 3 дня до конца подписки клиента — напомнит предложить продление.",
  ].join("\n");
  const ASK_EMAIL = "📨 <b>Пригласить заведение</b>\n\nНапишите почту владельца и, через пробел, название заведения:\n<code>owner@cafe.ru Кафе Лето</code>";
  const askingEmail = new Map(); // chatId → когда спросили почту

  const linkText = (p) => `🔗 <b>Ваша ссылка для клиентов</b>\n\n${h(linkOf(p))}\n\nКто зарегистрируется по ней в течение 30 дней после перехода, закрепится за вами. 30 дней считаются от последнего перехода — перешлите ссылку ещё раз, и отсчёт начнётся заново.`;
  const linkButtons = (p) => ({
    inline_keyboard: [
      [{ text: "↗️ Поделиться", url: `https://t.me/share/url?url=${encodeURIComponent(linkOf(p))}&text=${encodeURIComponent("Касса и управление заведением — попробуйте ZalPOS бесплатно")}` }],
      [{ text: "🔄 Новая ссылка", callback_data: "plink_new" }],
    ],
  });

  const MSK = "Europe/Moscow";
  const fmtDate = (ms) => new Date(ms).toLocaleDateString("ru-RU", { timeZone: MSK });
  const monthKey = (ms) => new Date(ms).toLocaleDateString("ru-RU", { timeZone: MSK, month: "2-digit", year: "numeric" });
  const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  const monthName = (key) => { const [m, y] = key.split("."); return `${MONTHS[Number(m) - 1]} ${y}`; };

  // Готовые сообщения владельцу: только факты о продукте, без сравнений.
  const PITCHES = [
    (link) => `Здравствуйте! Посмотрите ZalPOS — программу для кафе, баров и кальянных: касса, столы и зал, кухня, склад и техкарты, отчёты и меню по QR для гостей. Работает на планшете, телефоне и компьютере, касса продолжает работать без интернета. Попробовать можно бесплатно: ${link}`,
    (link) => `Добрый день! Если ищете кассу для заведения — попробуйте ZalPOS. Счета по столам, бегунки на кухню, склад со списанием по техкартам, смены и Z-отчёты, сотрудники с правами. Начать можно бесплатно, установка — за несколько минут: ${link}`,
  ];
  const pitchButtons = (link, i) => ({
    inline_keyboard: [
      [{ text: "↗️ Отправить клиенту", url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(PITCHES[i](link).replace(link, "").replace(/:\s*$/, ""))}` }],
      [{ text: "🔁 Другой вариант", callback_data: `ppitch_${(i + 1) % PITCHES.length}` }],
    ],
  });
  const sayPitch = (chatId, p, i) => say(chatId, `✍️ <b>Текст для клиента</b> — скопируйте или нажмите «Отправить клиенту»:\n\n${h(PITCHES[i](linkOf(p)))}`, { reply_markup: pitchButtons(linkOf(p), i) });

  const INVITE_STATUS = { sent: "⏳ ждёт регистрации", registered: "✅ зарегистрировался", expired: "⌛ срок истёк", optedOut: "🚫 отказался от писем" };

  async function sayPayouts(chatId, p) {
    const { payouts, summary: b, request } = await dashboardOf(p);
    const lines = ["💸 <b>Выплаты</b>", ""];
    if (request) {
      lines.push(`⏳ Запрос отправлен ${fmtDate(request.requestedAt)}: <b>${fmtRub(request.net)}</b>${request.ndfl ? ` (НДФЛ ${fmtRub(request.ndfl)} удерживается)` : ""}`, `   на ${h(request.details)}`, "");
    }
    lines.push(`Доступно к выплате: <b>${fmtRub(b.available)}</b>`);
    if (b.hold > 0) lines.push(`Ждут ${b.holdDays} дн. после оплаты: ${fmtRub(b.hold)}${b.holdUntil ? ` (ближайшее — ${fmtDate(b.holdUntil)})` : ""}`);
    lines.push(`Выплачено всего: ${fmtRub(b.paid)}`, "");
    const waiting = payouts.filter((x) => x.needReceipt);
    if (waiting.length) lines.push(`🧾 Нужен чек из «Мой налог»: ${waiting.map((x) => `${fmtRub(x.amount)} от ${fmtDate(x.paidAt)} (до ${fmtDate(x.receiptDue)})`).join("; ")}. Пришлите ссылку на чек сюда.`, "");
    lines.push(payouts.length ? payouts.slice(0, 15).map((x) => `• ${fmtDate(x.paidAt)} — <b>${fmtRub(x.net)}</b>${x.ndfl ? ` (НДФЛ ${fmtRub(x.ndfl)})` : ""}${x.note ? ` · ${h(x.note)}` : ""}${x.receiptUrl ? " · чек ✓" : ""}`).join("\n") : "Выплат пока не было.");
    const kb = [];
    if (request) kb.push([{ text: "✖️ Отменить запрос", callback_data: "ppay_cancel" }]);
    else if (b.canRequest) kb.push([{ text: `💸 Запросить ${fmtRub(b.calc.net)}`, callback_data: "ppay_ask" }]);
    else lines.push("", `<i>Запросить выплату можно от ${fmtRub(b.payoutMin)}. Начисление становится доступным через ${b.holdDays} дн. после оплаты клиента — на случай возврата.</i>`);
    if (!p.payoutDetailsEnc) lines.push("", "Чтобы получать выплаты, укажите реквизиты для перевода в кабинете (раздел «Выплаты»).");
    kb.push([cabinetBtn()]);
    return say(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: kb } });
  }

  async function askInvite(chatId, email, venueName) {
    if (!EMAIL_RE.test(email)) return say(chatId, "Проверьте адрес почты — например, <code>owner@cafe.ru Кафе Лето</code>");
    askingEmail.delete(chatId);
    awaiting.set(chatId, { email, venueName: String(venueName || "").trim().slice(0, 80), at: now() });
    return say(chatId, `Отправить приглашение на <b>${h(email)}</b>${venueName ? ` («${h(String(venueName).trim().slice(0, 80))}»)` : ""}?\n\nПисьмо можно отправить, только если владелец этой почты согласился его получить (закон о рекламе). В письме будет ваше имя и ссылка для отказа.`, {
      reply_markup: { inline_keyboard: [[{ text: "✅ Клиент согласен — отправить", callback_data: "pinv_yes" }], [{ text: "✖️ Отмена", callback_data: "pinv_no" }]] },
    });
  }

  async function onMessage(msg) {
    const chatId = msg.chat.id;
    if (msg.chat.type !== "private") return;
    const text = String(msg.text || "").trim();
    const start = text.match(/^\/start(?:\s+pl_([a-f0-9]{18}))?/);
    if (start && start[1]) {
      const snap = await partnersCol().where("tgLinkCode", "==", start[1]).limit(1).get();
      const d = snap.empty ? null : snap.docs[0];
      if (!d || toMs(d.data().tgLinkUntil) < now()) {
        return say(chatId, "Ссылка устарела. Откройте кабинет менеджера и нажмите «Подключить Telegram» ещё раз.", { reply_markup: { inline_keyboard: [[cabinetBtn()]] } });
      }
      // Один Telegram — один менеджер.
      const old = await partnerByChat(chatId);
      if (old && old.id !== d.id) await partnersCol().doc(old.id).set({ tgChatId: null }, { merge: true });
      await d.ref.set({ tgChatId: chatId, tgLinkCode: null, tgLinkedAt: ts(now()) }, { merge: true });
      return say(chatId, `✅ Готово, ${h(d.data().name || "менеджер")}! Telegram подключён.\n\n${HELP}\n\nКнопки — внизу чата.`, { reply_markup: MENU });
    }
    const p = await partnerByChat(chatId);
    if (!p || p.status === "removed") {
      return say(chatId, "Этот бот — для менеджеров партнёрской программы ZalPOS. Подключите его в кабинете менеджера: «Подключить Telegram».", {
        reply_markup: { inline_keyboard: [[cabinetBtn("🖥 Кабинет менеджера")]] },
      });
    }
    const byButton = Object.keys(BTN).find((k) => BTN[k] === text);
    const cmd = byButton || (text.match(/^\/(\w+)/) || [])[1] || "";
    if (cmd) askingEmail.delete(chatId);
    if (cmd === "start" || cmd === "help") return say(chatId, HELP, { reply_markup: MENU });
    if (cmd === "link") return say(chatId, linkText(p), { reply_markup: linkButtons(p) });
    if (cmd === "income") {
      const s = await summaryOf(p);
      const st = await settings();
      const accruals = (await accrualsOf(p.id)).filter((a) => a.status !== "reversed");
      const byMonth = new Map();
      for (const a of accruals) { const k = monthKey(toMs(a.paidAt)); byMonth.set(k, (byMonth.get(k) || 0) + a.amount); }
      const cur = monthKey(now());
      const prevD = new Date(now()); prevD.setUTCDate(1); prevD.setUTCHours(12); prevD.setUTCMonth(prevD.getUTCMonth() - 1);
      const prev = monthKey(prevD.getTime());
      return say(chatId, [
        "💼 <b>Ваш доход</b>",
        "",
        `Клиентов: <b>${s.clients}</b>`,
        `За ${monthName(cur)}: <b>${fmtRub(byMonth.get(cur) || 0)}</b>`,
        `За ${monthName(prev)}: ${fmtRub(byMonth.get(prev) || 0)}`,
        "",
        `Начислено всего: <b>${fmtRub(s.total)}</b>`,
        `К выплате: <b>${fmtRub(s.unpaid)}</b>`,
        `Выплачено: ${fmtRub(s.paid)}`,
        "",
        `<i>${p.percent}% от оплат после налога ${st.taxPct}% и комиссии платёжной системы.</i>`,
      ].join("\n"), { reply_markup: { inline_keyboard: [[{ text: "👥 Клиенты", callback_data: "pmenu_clients" }, { text: "💸 Выплаты", callback_data: "pmenu_payouts" }], [cabinetBtn()]] } });
    }
    if (cmd === "clients") {
      const dsh = await dashboardOf(p);
      if (!dsh.clients.length) {
        return say(chatId, "👥 Пока нет закреплённых клиентов.\n\nПригласите заведение по почте или отправьте владельцу свою ссылку.", {
          reply_markup: { inline_keyboard: [[{ text: "📨 Пригласить", callback_data: "pmenu_invite" }, { text: "🔗 Моя ссылка", callback_data: "pmenu_link" }]] },
        });
      }
      const until = (c) => {
        if (!c.paidUntil) return "";
        const days = Math.ceil((c.paidUntil - now()) / 86400000);
        return days < 0 ? `\n   ⚠️ подписка закончилась ${fmtDate(c.paidUntil)}` : days <= 3 ? `\n   ⏰ подписка до ${fmtDate(c.paidUntil)}` : `\n   оплачено до ${fmtDate(c.paidUntil)}`;
      };
      const lines = dsh.clients.slice(0, 30).map((c) => `• <b>${h(c.venueName)}</b>${c.planName ? ` · ${h(c.planName)}` : ""}\n   оплачено ${fmtRub(c.paid)}, ваш доход ${fmtRub(c.income)}${until(c)}`);
      const more = dsh.clients.length > 30 ? `\n\n…и ещё ${dsh.clients.length - 30} — все в кабинете.` : "";
      return say(chatId, `👥 <b>Ваши клиенты</b> (${dsh.clients.length})\n\n${lines.join("\n")}${more}`, { reply_markup: { inline_keyboard: [[cabinetBtn()]] } });
    }
    if (cmd === "pitch") return sayPitch(chatId, p, 0);
    if (cmd === "invites") {
      const { invites } = await dashboardOf(p);
      if (!invites.length) {
        return say(chatId, "📋 Вы ещё не отправляли приглашений.", { reply_markup: { inline_keyboard: [[{ text: "📨 Пригласить заведение", callback_data: "pmenu_invite" }]] } });
      }
      const count = (st) => invites.filter((x) => x.status === st).length;
      const lines = invites.slice(0, 20).map((x) => {
        const left = x.status === "sent" ? `, осталось ${Math.max(1, Math.ceil((x.expiresAt - now()) / 86400000))} дн.` : "";
        return `• ${h(x.email)}${x.venueName ? ` — ${h(x.venueName)}` : ""}\n   ${INVITE_STATUS[x.status] || h(x.status)}${left}`;
      });
      return say(chatId, [
        `📋 <b>Приглашения</b> (${invites.length})`,
        `ждут: ${count("sent")} · зарегистрировались: ${count("registered")} · истекли: ${count("expired")}`,
        "",
        lines.join("\n"),
        ...(invites.length > 20 ? ["", "Все приглашения — в кабинете."] : []),
      ].join("\n"), { reply_markup: { inline_keyboard: [[{ text: "📨 Пригласить ещё", callback_data: "pmenu_invite" }, cabinetBtn("🖥 Кабинет")]] } });
    }
    if (cmd === "payouts") return sayPayouts(chatId, p);
    if (cmd === "invite") {
      const m = text.match(/^\/invite(?:@\w+)?\s+(\S+@\S+)(?:\s+(.+))?$/);
      if (!m) {
        askingEmail.set(chatId, now());
        return say(chatId, ASK_EMAIL, { reply_markup: { inline_keyboard: [[{ text: "✖️ Отмена", callback_data: "pinv_no" }]] } });
      }
      return askInvite(chatId, normEmail(m[1]), m[2]);
    }
    if (!cmd && /^https:\/\/lknpd\.nalog\.ru\//.test(text)) {
      try {
        const r = await attachReceipt(p, "", text);
        return say(chatId, `🧾 Спасибо! Чек прикреплён к выплате ${fmtRub(r.amount)}.`, { reply_markup: MENU });
      } catch (e) {
        return say(chatId, h(e.message || e));
      }
    }
    // Ответ на «Напишите почту владельца».
    if (!cmd && askingEmail.has(chatId) && now() - askingEmail.get(chatId) < 30 * 60 * 1000) {
      const m = text.match(/^(\S+@\S+)(?:\s+(.+))?$/);
      if (m) return askInvite(chatId, normEmail(m[1]), m[2]);
      return say(chatId, "Нужна почта владельца — например, <code>owner@cafe.ru Кафе Лето</code>");
    }
    return say(chatId, HELP, { reply_markup: MENU });
  }

  async function onCallback(q) {
    const chatId = q.message && q.message.chat && q.message.chat.id;
    await tg("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
    if (!chatId) return;
    // Кнопки под ответом убираем — второй раз не нажмутся.
    const dropButtons = () => q.message.message_id
      && tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    const conf = String(q.data || "").match(/^p(got|not)_([\w-]{1,64})$/);
    if (conf) {
      const p = await partnerByChat(chatId);
      if (!p || p.status === "removed") return;
      try {
        const r = await confirmPayout(p, conf[2], conf[1] === "got");
        if (conf[1] === "got") await dropButtons();
        return say(chatId, conf[1] === "got" ? `👍 Спасибо! Получение ${fmtRub(r.amount)} отмечено.` : "Передал администратору — он проверит перевод. Если деньги придут позже, нажмите «✅ Деньги пришли».");
      } catch (e) {
        return say(chatId, h(e.message || e));
      }
    }
    if (["ppay_ask", "ppay_yes", "ppay_no", "ppay_cancel"].includes(q.data)) {
      const p = await partnerByChat(chatId);
      if (!p || p.status === "removed") return;
      if (q.data === "ppay_ask") {
        const b = await summaryOf(p);
        if (!p.payoutDetailsEnc) return say(chatId, "Сначала укажите реквизиты для перевода в кабинете менеджера (раздел «Выплаты»).", { reply_markup: { inline_keyboard: [[cabinetBtn()]] } });
        return say(chatId, [
          `Запросить выплату <b>${fmtRub(b.calc.net)}</b>?`,
          ...(b.calc.ndfl ? [`Начислено ${fmtRub(b.calc.gross)}, НДФЛ ${NDFL_PCT}% (${fmtRub(b.calc.ndfl)}) удержит и заплатит ZalPOS.`] : []),
          `Перевод — на ${h(p.payoutDetailsMask)}.`,
        ].join("\n"), { reply_markup: { inline_keyboard: [[{ text: "✅ Запросить", callback_data: "ppay_yes" }, { text: "✖️ Отмена", callback_data: "ppay_no" }]] } });
      }
      await dropButtons();
      if (q.data === "ppay_no") return say(chatId, "Хорошо, запрос не отправлен.");
      try {
        if (q.data === "ppay_cancel") {
          await cancelPayout(p);
          return say(chatId, "Запрос отменён, сумма снова доступна к выплате.", { reply_markup: MENU });
        }
        const r = await requestPayout(p);
        return say(chatId, `📤 Запрос отправлен: <b>${fmtRub(r.net)}</b>. Бот сообщит, когда деньги будут перечислены.`, { reply_markup: MENU });
      } catch (e) {
        return say(chatId, `Не получилось: ${h(e.message || e)}`);
      }
    }
    const pitch = String(q.data || "").match(/^ppitch_(\d)$/);
    if (pitch) {
      const p = await partnerByChat(chatId);
      if (!p || p.status === "removed") return;
      return sayPitch(chatId, p, Number(pitch[1]) % PITCHES.length);
    }
    const menu = String(q.data || "").match(/^pmenu_(\w+)$/);
    if (menu && BTN[menu[1]]) return onMessage({ chat: { id: chatId, type: "private" }, text: BTN[menu[1]] });
    if (q.data === "plink_new") {
      return say(chatId, "Создать новую ссылку?\n\nСтарые ссылки, которые вы уже отправили, продолжат работать — клиенты по ним тоже закрепятся за вами.", {
        reply_markup: { inline_keyboard: [[{ text: "🔄 Да, создать", callback_data: "plink_yes" }, { text: "✖️ Отмена", callback_data: "plink_no" }]] },
      });
    }
    if (q.data === "plink_no") { await dropButtons(); return say(chatId, "Ссылка осталась прежней."); }
    if (q.data === "plink_yes") {
      await dropButtons();
      const p = await partnerByChat(chatId);
      if (!p || p.status === "removed") return;
      try {
        const r = await renewLink(p);
        const np = { ...p, code: r.code };
        return say(chatId, `✨ Новая ссылка готова.\n\n${linkText(np)}`, { reply_markup: linkButtons(np) });
      } catch (e) {
        return say(chatId, `Не получилось: ${h(e.message || e)}`);
      }
    }
    if (q.data === "pinv_no") {
      awaiting.delete(chatId);
      askingEmail.delete(chatId);
      await dropButtons();
      return say(chatId, "Отменено.", { reply_markup: MENU });
    }
    if (q.data !== "pinv_yes") return;
    const pending = awaiting.get(chatId);
    awaiting.delete(chatId);
    await dropButtons();
    if (!pending || now() - pending.at > 30 * 60 * 1000) {
      return say(chatId, "Приглашение устарело — нажмите «📨 Пригласить заведение» ещё раз.", { reply_markup: MENU });
    }
    const p = await partnerByChat(chatId);
    if (!p) return;
    try {
      const r = await invite(p, { email: pending.email, venueName: pending.venueName, consent: true, ip: "telegram" });
      return say(chatId, `📨 Приглашение отправлено на ${h(maskEmail(pending.email))}.\n\nДействует до ${new Date(r.expiresAt).toLocaleDateString("ru-RU")}: если заведение зарегистрируется по этой почте, оно закрепится за вами.`, { reply_markup: MENU });
    } catch (e) {
      return say(chatId, `Не отправлено: ${h(e.message || e)}`, { reply_markup: MENU });
    }
  }

  async function handleHook(req, res, readBody) {
    const secret = String(req.headers["x-telegram-bot-api-secret-token"] || "");
    if (!bot || !bot.hookSecret || secret.length !== bot.hookSecret.length
      || !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(bot.hookSecret))) {
      res.writeHead(403);
      return res.end();
    }
    let update;
    try {
      update = JSON.parse(await readBody(req));
    } catch (_) {
      update = null;
    }
    res.writeHead(200);
    res.end();
    if (!update) return;
    try {
      if (update.callback_query) await onCallback(update.callback_query);
      else if (update.message && update.message.chat) await onMessage(update.message);
    } catch (e) {
      console.error(`partners bot: ${e && e.stack ? e.stack : e}`);
    }
  }

  /** Почта нужна, только пока приглашение действует: потом — скрытая (a***@mail.ru). */
  async function sweepInvites() {
    let n = 0;
    for (const d of (await col("partnerInvites").get()).docs) {
      const x = d.data();
      if (!x.email || x.email.includes("***")) continue;
      if (x.status === "sent" && toMs(x.expiresAt) > now()) continue;
      await d.ref.set({ email: maskEmail(x.email), ...(x.status === "sent" ? { status: "expired" } : {}) }, { merge: true });
      n++;
    }
    return n;
  }

  /**
   * За 3 дня до конца оплаченного периода клиента (и если он уже закончился,
   * в пределах недели) — напомнить менеджеру. Один раз на каждый срок.
   */
  async function remindRenewals() {
    let n = 0;
    const partners = new Map();
    for (const d of (await col("partnerClients").get()).docs) {
      const c = d.data();
      const until = toMs(c.paidUntil);
      if (!until || !c.partnerId || c.renewRemindedFor === until) continue;
      const left = until - now();
      if (left > 3 * 86400000 || left < -7 * 86400000) continue;
      if (!partners.has(c.partnerId)) partners.set(c.partnerId, (await partnersCol().doc(c.partnerId).get()).data() || null);
      const p = partners.get(c.partnerId);
      if (!p || p.status !== "active") continue;
      await d.ref.set({ renewRemindedFor: until }, { merge: true });
      const name = h(c.venueName || "клиента");
      await notify(c.partnerId, left > 0
        ? `⏰ У «${name}» подписка до ${fmtDate(until)}. Напомните владельцу продлить — с продления вы тоже получаете процент.`
        : `⚠️ У «${name}» подписка закончилась ${fmtDate(until)}. Свяжитесь с владельцем: возможно, нужна помощь с оплатой.`);
      n++;
    }
    return n;
  }

  /** Запрос висит больше 5 дней — напоминать администраторам раз в сутки до выплаты. */
  async function remindRequests() {
    let n = 0;
    for (const d of (await col("partnerPayoutRequests").get()).docs) {
      const r = d.data();
      if (r.status !== "requested") continue;
      const at = toMs(r.requestedAt);
      if (now() - at < 5 * DAY_MS || now() - toMs(r.adminRemindedAt) < DAY_MS) continue;
      const p = (await partnersCol().doc(r.partnerId).get()).data() || {};
      await d.ref.set({ adminRemindedAt: ts(now()) }, { merge: true });
      const left = Math.ceil((at + PAY_TERM_MS - now()) / DAY_MS);
      try {
        notifyAdmins(`⏰ <b>Запрос выплаты ждёт ${Math.floor((now() - at) / DAY_MS)} дн.</b>: ${h(p.name || p.email || "менеджер")} — ${fmtRub(r.net)}.\n${left > 0 ? `По договору перевести до ${fmtDate(at + PAY_TERM_MS)} (осталось ${left} дн.).` : `Срок по договору (${fmtDate(at + PAY_TERM_MS)}) прошёл.`} Если уже перевели — отметьте выплату в панели.`);
      } catch (_) {}
      n++;
    }
    return n;
  }

  /** Самозанятому — напомнить про чек: через 3 дня после выплаты и за 2 дня до срока. */
  async function remindReceipts() {
    let n = 0;
    for (const d of (await col("partnerPayouts").get()).docs) {
      const x = d.data();
      if (x.taxStatus !== "npd" || x.receiptUrl) continue;
      const paid = toMs(x.paidAt);
      const due = receiptDue(paid);
      const stage = now() > due - 2 * DAY_MS ? 2 : now() > paid + 3 * DAY_MS ? 1 : 0;
      if (!stage || (x.receiptReminded || 0) >= stage) continue;
      await d.ref.set({ receiptReminded: stage }, { merge: true });
      await notify(x.partnerId, `🧾 Нужен чек из «Мой налог» за выплату ${fmtRub(x.amount)} от ${fmtDate(paid)} — срок до ${fmtDate(due)}. Пришлите ссылку на чек сюда («Поделиться» → «Скопировать ссылку»).`);
      n++;
    }
    return n;
  }

  async function start() {
    await loadBot().catch((e) => console.error(`partners: бот: ${e.message || e}`));
    sweepInvites().catch(() => {});
    remindRenewals().catch(() => {});
    const t = setInterval(() => {
      sweepInvites().catch((e) => console.error(`partners: приглашения: ${e.message || e}`));
      remindRenewals().catch((e) => console.error(`partners: напоминания о продлении: ${e.message || e}`));
      remindReceipts().catch((e) => console.error(`partners: напоминания о чеках: ${e.message || e}`));
      remindRequests().catch((e) => console.error(`partners: напоминания о запросах: ${e.message || e}`));
    }, 6 * 3600 * 1000);
    if (t.unref) t.unref();
  }

  return {
    start, attachOwner, onPayment, invite, dashboardOf, computeAccrual, sweepInvites, remindRenewals, remindReceipts, remindRequests,
    handleMe, handleAcceptTerms, handleInvite, handleDashboard, handleInviteInfo, handleOptOut, handleTgLink, handleNewLink,
    handlePayoutDetails, handlePayoutRequest, handlePayoutReceipt, handleAdminPayoutReject,
    handlePayoutConfirm, handleAct, handleAdminAct, handleAdminPayoutsCsv,
    handleAdminList, handleAdminPartner, handleAdminSave, handleAdminSettings, handleAdminPayout, handleAdminReverse, handleAdminBot, handleAdminContract,
    handleHook, HOOK_ID, TERMS_EDITION, _onMessage: onMessage, _onCallback: onCallback,
  };
}

module.exports = { createPartners, computeAccrual, maskEmail, cleanCode, translit, TERMS_EDITION, TAX_STATUSES, INVITE_TTL_MS, payoutCalc, innOk, cleanDetails, receiptDue, ndflDue };
