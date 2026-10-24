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
const DEFAULT_SETTINGS = { taxPct: 6, feePct: 3.9 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Редакция правил программы: менеджер принимает их в кабинете, редакция — в журнале.
const TERMS_EDITION = "Редакция от 24 октября 2026 г.";
const TAX_STATUSES = { npd: "самозанятый", ip: "ИП", person: "физлицо (налог удерживаете вы)" };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
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
    auth = () => admin.auth(),
  } = deps;
  const ts = (ms) => admin.firestore.Timestamp.fromMillis(ms);
  const col = (n) => store().collection(n);
  const partnersCol = () => col("partners");
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
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
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
    return { clients: clients.size, ...sums(accruals) };
  }

  const publicPartner = (p) => ({
    id: p.id, name: p.name || "", email: p.email, code: p.code, link: linkOf(p), percent: p.percent, months: p.months || 0,
    status: p.status, taxStatus: p.taxStatus || "npd", taxStatusLabel: TAX_STATUSES[p.taxStatus || "npd"],
    termsAcceptedAt: toMs(p.termsAcceptedAt) || null, termsEdition: TERMS_EDITION, telegram: !!p.tgChatId,
  });

  // ------------------------------------------------------------ кабинет менеджера

  async function handleMe(req, res) {
    const decoded = await verifyAuth(req);
    const p = await partnerByUid(decoded.uid);
    if (!p || p.status === "removed") return sendJson(res, 200, { partner: null });
    const s = await settings();
    sendJson(res, 200, { partner: publicPartner(p), summary: await summaryOf(p), settings: { taxPct: s.taxPct, feePct: s.feePct }, bot: botInfo() });
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
    })).sort((a, b) => b.paidAt - a.paidAt);
    const payouts = payoutsSnap.docs.map((d) => ({ id: d.id, amount: d.data().amount, paidAt: toMs(d.data().paidAt), note: d.data().note || "" }))
      .sort((a, b) => b.paidAt - a.paidAt);
    return { clients, invites, accruals: history, payouts, summary: { clients: clients.length, ...sums(accruals) } };
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
      list.push({ ...publicPartner(p), summary: await summaryOf(p), createdAt: toMs(p.createdAt) });
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    sendJson(res, 200, { partners: list, settings: { taxPct: s.taxPct, feePct: s.feePct }, bot: botInfo(), termsEdition: TERMS_EDITION, taxStatuses: TAX_STATUSES });
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
    await settingsRef().set({ taxPct: round2(taxPct), feePct: round2(feePct), updatedAt: ts(now()) }, { merge: true });
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
    if (!(await partnersCol().doc(partnerId).get()).exists) throw new HttpError(404, "Менеджер не найден");
    const open = (await accrualsOf(partnerId)).filter((a) => a.status !== "reversed" && !a.payoutId);
    if (!open.length) throw new HttpError(400, "Невыплаченных начислений нет");
    const amount = round2(open.reduce((s, a) => s + a.amount, 0));
    if (body.expected !== undefined && Math.abs(Number(body.expected) - amount) > 0.009) {
      throw new HttpError(409, "Сумма к выплате изменилась — обновите страницу");
    }
    const ref = col("partnerPayouts").doc();
    const note = String(body.note || "").trim().slice(0, 200);
    await ref.set({ partnerId, amount, accrualIds: open.map((a) => a.id), note, paidAt: ts(now()), by: decoded.uid });
    for (const a of open) await col("partnerAccruals").doc(a.id).set({ payoutId: ref.id }, { merge: true });
    notify(partnerId, `✅ Выплата ${fmtRub(amount)} отмечена${note ? ` (${note})` : ""}.`).catch(() => {});
    sendJson(res, 200, { ok: true, amount });
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
    if (a.payoutId) throw new HttpError(409, "Начисление уже выплачено — учтите это в следующей выплате вручную");
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
    const year = new Date(now()).getUTCFullYear();
    const number = `${p.code}-${year}`;
    const file = require("./partner-contract").buildPartnerContract({
      platform: (await platformLegal()) || {}, partner: p, settings: await settings(), number, now: new Date(now()),
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

  async function notify(partnerId, html) {
    if (!bot) return;
    const p = (await partnersCol().doc(partnerId).get()).data();
    if (p && p.tgChatId) await say(p.tgChatId, html).catch((e) => console.error(`partners: уведомление в Telegram: ${e.message || e}`));
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
      { command: "invite", description: "Пригласить заведение по почте" },
      { command: "clients", description: "Мои клиенты" },
      { command: "income", description: "Мой доход" },
      { command: "link", description: "Моя ссылка для клиентов" },
      { command: "help", description: "Что умеет бот" },
    ] }, token).catch(() => {});
    await ref.set({ tokenEnc: encrypt(secretKey(), token), username: me.username || "", hookSecret, connectedAt: ts(now()) }, { merge: true });
    bot = { token, username: me.username || "", hookSecret };
    sendJson(res, 200, { ok: true, bot: botInfo() });
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

  const HELP = [
    "Бот менеджеров ZalPOS.",
    "",
    "/invite почта@заведения.ru Название — пригласить заведение по почте",
    "/clients — ваши клиенты и их оплаты",
    "/income — начислено, к выплате и выплачено",
    "/link — ваша ссылка для клиентов",
    "",
    "Об оплатах ваших клиентов бот пишет сам.",
  ].join("\n");

  async function onMessage(msg) {
    const chatId = msg.chat.id;
    if (msg.chat.type !== "private") return;
    const text = String(msg.text || "").trim();
    const start = text.match(/^\/start(?:\s+pl_([a-f0-9]{18}))?/);
    if (start && start[1]) {
      const snap = await partnersCol().where("tgLinkCode", "==", start[1]).limit(1).get();
      const d = snap.empty ? null : snap.docs[0];
      if (!d || toMs(d.data().tgLinkUntil) < now()) return say(chatId, "Ссылка устарела. Откройте кабинет менеджера на zalpos.ru и нажмите «Подключить Telegram» ещё раз.");
      // Один Telegram — один менеджер.
      const old = await partnerByChat(chatId);
      if (old && old.id !== d.id) await partnersCol().doc(old.id).set({ tgChatId: null }, { merge: true });
      await d.ref.set({ tgChatId: chatId, tgLinkCode: null, tgLinkedAt: ts(now()) }, { merge: true });
      return say(chatId, `Готово, ${h(d.data().name || "менеджер")}! Telegram подключён.\n\n${HELP}`);
    }
    const p = await partnerByChat(chatId);
    if (!p || p.status === "removed") {
      return say(chatId, "Этот бот — для менеджеров партнёрской программы ZalPOS. Подключите его в кабинете менеджера: zalpos.ru/#/partner → «Подключить Telegram».");
    }
    const cmd = (text.match(/^\/(\w+)/) || [])[1] || "";
    if (cmd === "start" || cmd === "help") return say(chatId, HELP);
    if (cmd === "link") return say(chatId, `Ваша ссылка для клиентов:\n${linkOf(p)}\n\nКто зарегистрируется по ней в течение 30 дней после перехода, закрепится за вами.`);
    if (cmd === "income") {
      const s = await summaryOf(p);
      const st = await settings();
      return say(chatId, [
        `💼 <b>Ваш доход</b> (${p.percent}% от оплат после налога ${st.taxPct}% и комиссии платёжной системы)`,
        "",
        `Клиентов: <b>${s.clients}</b>`,
        `Начислено всего: <b>${fmtRub(s.total)}</b>`,
        `К выплате: <b>${fmtRub(s.unpaid)}</b>`,
        `Выплачено: ${fmtRub(s.paid)}`,
      ].join("\n"));
    }
    if (cmd === "clients") {
      const dsh = await dashboardOf(p);
      if (!dsh.clients.length) return say(chatId, "Пока нет закреплённых клиентов. Пригласите заведение: /invite почта@заведения.ru");
      const lines = dsh.clients.slice(0, 30).map((c) => `• <b>${h(c.venueName)}</b>${c.planName ? ` · ${h(c.planName)}` : ""} — оплачено ${fmtRub(c.paid)}, ваш доход ${fmtRub(c.income)}`);
      return say(chatId, `👥 <b>Ваши клиенты</b> (${dsh.clients.length})\n\n${lines.join("\n")}`);
    }
    if (cmd === "invite") {
      const m = text.match(/^\/invite(?:@\w+)?\s+(\S+@\S+)(?:\s+(.+))?$/);
      if (!m) return say(chatId, "Напишите так: /invite почта@заведения.ru Название заведения");
      const email = normEmail(m[1]);
      if (!EMAIL_RE.test(email)) return say(chatId, "Проверьте адрес почты.");
      awaiting.set(chatId, { email, venueName: String(m[2] || "").trim().slice(0, 80), at: now() });
      return say(chatId, `Отправить приглашение на <b>${h(email)}</b>?\n\nПисьмо можно отправить, только если владелец этой почты согласился его получить (закон о рекламе). В письме будет ваше имя и ссылка для отказа.`, {
        reply_markup: { inline_keyboard: [[{ text: "✅ Клиент согласен — отправить", callback_data: "pinv_yes" }], [{ text: "Отмена", callback_data: "pinv_no" }]] },
      });
    }
    return say(chatId, HELP);
  }

  async function onCallback(q) {
    const chatId = q.message && q.message.chat && q.message.chat.id;
    await tg("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
    if (!chatId) return;
    const pending = awaiting.get(chatId);
    awaiting.delete(chatId);
    if (q.data === "pinv_no") return say(chatId, "Отменено.");
    if (q.data !== "pinv_yes" || !pending || now() - pending.at > 30 * 60 * 1000) return say(chatId, "Приглашение устарело — отправьте /invite ещё раз.");
    const p = await partnerByChat(chatId);
    if (!p) return;
    try {
      const r = await invite(p, { email: pending.email, venueName: pending.venueName, consent: true, ip: "telegram" });
      return say(chatId, `📨 Приглашение отправлено на ${h(maskEmail(pending.email))}. Действует до ${new Date(r.expiresAt).toLocaleDateString("ru-RU")}: если заведение зарегистрируется по этой почте, оно закрепится за вами.`);
    } catch (e) {
      return say(chatId, `Не отправлено: ${h(e.message || e)}`);
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

  async function start() {
    await loadBot().catch((e) => console.error(`partners: бот: ${e.message || e}`));
    sweepInvites().catch(() => {});
    const t = setInterval(() => sweepInvites().catch((e) => console.error(`partners: приглашения: ${e.message || e}`)), 6 * 3600 * 1000);
    if (t.unref) t.unref();
  }

  return {
    start, attachOwner, onPayment, invite, dashboardOf, computeAccrual, sweepInvites,
    handleMe, handleAcceptTerms, handleInvite, handleDashboard, handleInviteInfo, handleOptOut, handleTgLink,
    handleAdminList, handleAdminPartner, handleAdminSave, handleAdminSettings, handleAdminPayout, handleAdminReverse, handleAdminBot, handleAdminContract,
    handleHook, HOOK_ID, TERMS_EDITION, _onMessage: onMessage, _onCallback: onCallback,
  };
}

module.exports = { createPartners, computeAccrual, maskEmail, cleanCode, translit, TERMS_EDITION, TAX_STATUSES, INVITE_TTL_MS };
