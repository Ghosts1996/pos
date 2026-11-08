"use strict";
// Гости заведения: сегменты, согласие на рекламные сообщения и авторассылка
// «Вернуть гостя».
//
//  • Согласие (POST /guestAdsConsent) гость даёт сам отдельной галочкой в
//    профиле приложения или веб-версии — ст. 18 Федерального закона
//    «О рекламе» и ст. 15 152-ФЗ (прямые контакты). Не отмечена по
//    умолчанию, отключается там же в одно нажатие. Доказательство — запись
//    adsConsents/{корень}__{uid} на сервере в РФ (дата, редакция текста,
//    откуда, IP и браузер; после отказа IP и браузер стираются), в профиле
//    гостя — только отметка adsConsent для приложений. Отметку в профиле
//    пишет только сервер: правила базы не дают гостю её поставить.
//  • Сегменты (POST /guestSegments): сколько новых, постоянных, «давно не
//    были», ушедших; сколько согласны на сообщения; что принесли гости,
//    вернувшиеся после подарка. Только цифры — без имён и телефонов.
//  • «Вернуть гостя» (POST /guestCampaign + задача раз в час): гостю с
//    согласием, который был у нас и не приходит N дней, — сообщение в
//    приложении заведения и (по желанию) бонусы. Раз в день, днём по
//    часовому поясу заведения, не чаще одного раза в 30, 60 или 90 дней на гостя и не
//    больше двух подарков подряд тому, кто так и не пришёл.
//
// Канал — само приложение гостя (уведомление и карточка на главной), без
// SMS и без push-сервисов Google и Apple: данные гостей не покидают Россию.
// У сети гости, бонусы и рассылка общие на все точки (chains/{chainId}).

const DAY = 24 * 3600 * 1000;
const ADS_EDITION = "2026-11-09";
const SEND_FROM_HOUR = 12; // с 12:00 до 20:00 по времени заведения
const SEND_TO_HOUR = 20;
const MAX_PER_DAY = 300;
const MAX_TRIES = 2; // подарков подряд гостю, который так и не пришёл
const MAX_SILENCE_DAYS = 365; // кто не был дольше года — не беспокоим
const SHOW_DAYS = 30; // сколько дней карточка с подарком видна в приложении
const STATS_DAYS = 90;
const DEFAULT_TZ = "Europe/Moscow";
const SEGMENTS_CACHE_MS = 60 * 1000;

const DEFAULTS = Object.freeze({
  enabled: false,
  afterDays: 30,
  repeatDays: 60,
  bonus: 300,
  title: "Скучаем по вам!",
  text: "Давно не виделись. Дарим бонусы к следующему визиту — ждём вас!",
});
const AFTER_DAYS = [21, 30, 45, 60, 90, 120];
const REPEAT_DAYS = [30, 60, 90];
const MAX_BONUS = 5000;

// --------------------------------------------------------- проверка текста

// Реклама табака, кальянов и курительных принадлежностей запрещена (ст. 16
// 15-ФЗ, п. 8 ст. 7 38-ФЗ) — те же слова, что в PromoPolicy кассы. Алкоголь
// через сети связи рекламировать тоже нельзя (ст. 21 38-ФЗ).
const TOBACCO_STEMS = ["кальян", "табак", "табач", "никотин", "hookah", "shisha", "снюс", "вейп", "сигар", "электронк"];
const ALCOHOL_STEMS = ["алкогол", "пивн", "пивк", "пивас", "винн", "винишк", "водк", "водоч", "коньяк", "виски", "текил", "ликёр", "ликер", "шампанск", "игрист", "сидр", "настойк", "наливк",
  "абсент", "бренди", "вермут", "мартини", "шнапс", "самогон", "медовух", "глинтвейн", "просекко", "бурбон", "кальвадос", "граппа",
  "beer", "wine", "vodka", "whisky", "whiskey", "tequila"];
// Короткие слова — только целиком: «вино», но не «виноград»; «ром», но не «ромашка».
const ALCOHOL_WORDS = new Set(["пиво", "пива", "пиву", "пивом", "вино", "вина", "вину", "вином", "винцо", "ром", "рома", "рому",
  "ромом", "джин", "джина", "джину", "саке", "эль", "сангрия", "rum", "gin"]);

const words = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").split(/[^a-zа-я0-9№]+/i).filter(Boolean);

/** Почему текст нельзя отправить гостям; null — можно. */
function textProblem(raw) {
  const s = String(raw || "");
  const list = words(s);
  const hit = (stems) => list.find((w) => stems.some((st) => w.startsWith(st.replace(/ё/g, "е"))));
  const tob = hit(TOBACCO_STEMS);
  if (tob) return `Уберите «${tob}»: реклама табака, кальянов и курительных принадлежностей запрещена (ст. 16 закона № 15-ФЗ)`;
  const alc = list.find((w) => ALCOHOL_WORDS.has(w)) || hit(ALCOHOL_STEMS);
  if (alc) return `Уберите «${alc}»: алкоголь в таких сообщениях рекламировать нельзя (ст. 21 закона «О рекламе»)`;
  if (list.some((w) => w.startsWith("лучш")) || /№\s*1(?!\d)|номер\s+один/i.test(s)) {
    return "Уберите «лучший» и «№ 1»: такие слова в рекламе нужно доказывать (ст. 5 закона «О рекламе»)";
  }
  if (/(https?:\/\/|www\.|t\.me\/|\.(ru|рф|com|net|org|su|me)\b)/i.test(s)) {
    return "Ссылки не нужны: сообщение и так придёт в приложение заведения";
  }
  return null;
}

/** Настройки кампании: всё, что пришло, приводим к допустимому. */
function normalizeSettings(raw = {}) {
  const pick = (v, allowed, def) => (allowed.includes(Number(v)) ? Number(v) : def);
  const clean = (v) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const bonus = Math.round(Number(raw.bonus));
  return {
    enabled: raw.enabled === true,
    afterDays: pick(raw.afterDays, AFTER_DAYS, DEFAULTS.afterDays),
    repeatDays: pick(raw.repeatDays, REPEAT_DAYS, DEFAULTS.repeatDays),
    bonus: Number.isFinite(bonus) ? Math.max(0, Math.min(MAX_BONUS, bonus)) : DEFAULTS.bonus,
    title: raw.title == null ? DEFAULTS.title : clean(raw.title).slice(0, 60),
    text: raw.text == null ? DEFAULTS.text : clean(raw.text).slice(0, 300),
  };
}

/** Ошибка в настройках, которые хотят сохранить; null — всё хорошо. */
function settingsProblem(s) {
  if (s.title.length < 2) return "Напишите заголовок сообщения";
  if (s.text.length < 5) return "Напишите текст сообщения";
  return textProblem(`${s.title}\n${s.text}`);
}

// ------------------------------------------------------------ время и даты

function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "object" && typeof v._seconds === "number") return v._seconds * 1000;
  return null;
}

/** Дата и час в поясе [tz]: { ymd: "2026-11-08", hour: 14, month: 11 }. */
function localParts(tz, ms) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    }).formatToParts(new Date(ms));
  } catch (_) {
    return localParts(DEFAULT_TZ, ms);
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), month: Number(p.month) };
}

// ------------------------------------------------------------- сегменты

/** Когда гость был последний раз: lastVisitAt, у старых профилей — дата создания. */
function lastVisitMs(d) {
  return toMs(d.lastVisitAt) ?? ((Number(d.visits) || 0) > 0 ? toMs(d.createdAt) : null);
}

/** Сегмент гостя по визитам и давности: noVisits | new | regular | lapsing | lost. */
function segmentOf(d, t) {
  const visits = Number(d.visits) || 0;
  if (visits < 1) return "noVisits";
  const last = lastVisitMs(d);
  const days = last == null ? Infinity : (t - last) / DAY;
  if (days <= 30) return visits === 1 ? "new" : "regular";
  if (days <= 90) return "lapsing";
  return "lost";
}

/** Гостю сейчас положен подарок «Вернуть гостя» по настройкам [c]. */
function isEligible(d, c, t) {
  if (!d || d.anonymized === true || d.adsConsent !== true) return false;
  if ((Number(d.visits) || 0) < 1) return false;
  const last = toMs(d.lastVisitAt);
  if (last == null) return false;
  const silent = t - last;
  if (silent < c.afterDays * DAY || silent > MAX_SILENCE_DAYS * DAY) return false;
  const prev = toMs(d.winbackAt);
  if (prev != null) {
    if (t - prev < c.repeatDays * DAY) return false;
    if (last <= prev && (Number(d.winbackTries) || 0) >= MAX_TRIES) return false;
  }
  return true;
}

/** Сводка по гостям: сегменты, согласия, итоги подарков — без персональных данных. */
function computeStats(docs, c, t, month) {
  const seg = { new: 0, regular: 0, lapsing: 0, lost: 0, noVisits: 0 };
  const segAds = { new: 0, regular: 0, lapsing: 0, lost: 0, noVisits: 0 };
  let total = 0;
  let ads = 0;
  let spentSum = 0;
  let visitsSum = 0;
  let birthdays = 0;
  let eligible = 0;
  const spent = [];
  const camp = { sent: 0, returned: 0, revenue: 0 };
  for (const d of docs) {
    if (!d || d.anonymized === true) continue;
    total += 1;
    const s = segmentOf(d, t);
    seg[s] += 1;
    if (d.adsConsent === true) { ads += 1; segAds[s] += 1; }
    const sp = Math.max(0, Number(d.totalSpent) || 0);
    spentSum += sp;
    visitsSum += Math.max(0, Number(d.visits) || 0);
    if (sp > 0) spent.push(sp);
    if (Number(d.birthdayMonth) === month) birthdays += 1;
    if (isEligible(d, c, t)) eligible += 1;
    const w = toMs(d.winbackAt);
    if (w != null && t - w <= STATS_DAYS * DAY) {
      camp.sent += 1;
      const last = toMs(d.lastVisitAt);
      if (last != null && last > w) {
        camp.returned += 1;
        camp.revenue += Math.max(0, sp - (Number(d.winbackSpent) || 0));
      }
    }
  }
  spent.sort((a, b) => b - a);
  const topN = Math.ceil(spent.length * 0.2);
  const topShare = spent.length >= 5 && spentSum > 0
    ? Math.round((spent.slice(0, topN).reduce((a, b) => a + b, 0) / spentSum) * 100) : null;
  return {
    total, ads, segments: seg, segmentsAds: segAds, birthdays, eligible,
    avgCheck: visitsSum > 0 ? Math.round(spentSum / visitsSum) : 0,
    topShare,
    campaign: { ...camp, revenue: Math.round(camp.revenue), days: STATS_DAYS },
  };
}

// ---------------------------------------------------------------- модуль

const rootKeyOf = (scope, rootId) => `${scope === "chain" ? "c" : "t"}_${rootId}`;
const consentDocId = (scope, rootId, uid) => `${rootKeyOf(scope, rootId)}__${uid}`;

function createGuestMarketing(deps) {
  const {
    db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, requireChainRole,
    writeAuditLog = async () => {}, clientIp = () => "", now = () => Date.now(), log = console,
  } = deps;
  const { Timestamp } = admin.firestore;
  const ts = (ms) => Timestamp.fromMillis(ms);
  const statsCache = new Map(); // rootKey → { at, stats }
  const consentHits = new Map(); // uid → { count, resetAt }

  /** Заведение, его сеть и корень гостей (у сети — общий). */
  async function venueOf(tenantId) {
    if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)) throw new HttpError(400, "Не указано заведение");
    const snap = await db().collection("tenants").doc(tenantId).get();
    if (!snap.exists || snap.data().status === "deleted") throw new HttpError(404, "Заведение не найдено");
    const t = snap.data();
    const chainId = t.chainId || null;
    const scope = chainId ? "chain" : "tenant";
    const rootId = chainId || tenantId;
    const root = db().collection(chainId ? "chains" : "tenants").doc(rootId);
    return { tenantId, tenant: t, chainId, scope, rootId, root, key: rootKeyOf(scope, rootId) };
  }

  async function venueTz(tenantId) {
    try {
      const s = await db().collection("tenants").doc(tenantId).collection("settings").doc("general").get();
      const tz = s.exists ? String(s.data().timezone || "") : "";
      if (tz) { new Intl.DateTimeFormat("ru", { timeZone: tz }); return tz; }
    } catch (_) { /* неизвестный пояс — по Москве */ }
    return DEFAULT_TZ;
  }

  async function venueName(v) {
    try {
      const b = await v.root.collection("branding").doc("config").get();
      const name = b.exists ? String(b.data().appName || "").trim() : "";
      if (name) return name.slice(0, 60);
    } catch (_) { /* ниже — название заведения */ }
    return String(v.tenant.name || "").trim().slice(0, 60);
  }

  async function isHookahVenue(v) {
    try {
      const p = await db().collection("tenants").doc(v.tenantId).collection("meta").doc("venueProfile").get();
      const d = p.exists ? p.data() : {};
      return (d.venueType || "hookah") === "hookah" || d.hookahEnabled === true;
    } catch (_) {
      return true;
    }
  }

  const campaignRef = (key) => db().collection("guestCampaigns").doc(key);

  async function loadCampaign(v) {
    const snap = await campaignRef(v.key).get();
    const raw = snap.exists ? snap.data() : {};
    return { settings: normalizeSettings(raw), state: snap.exists ? raw : {} };
  }

  // ------------------------------------------------- согласие (гость)

  async function handleConsent(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const t = now();
    const e = consentHits.get(decoded.uid);
    if (!e || e.resetAt <= t) {
      consentHits.set(decoded.uid, { count: 1, resetAt: t + 3600 * 1000 });
      if (consentHits.size > 20000) for (const [k, x] of consentHits) if (x.resetAt <= t) consentHits.delete(k);
    } else if (++e.count > 30) {
      throw new HttpError(429, "Слишком часто — попробуйте через час");
    }
    if (typeof body.on !== "boolean") throw new HttpError(400, "Нужно on: true или false");
    const v = await venueOf(body.tenantId);
    const clientRef = v.root.collection("clients").doc(decoded.uid);
    const client = await clientRef.get();
    if (!client.exists || client.data().anonymized === true) {
      throw new HttpError(404, "Сначала сохраните профиль — имя и номер");
    }
    const edition = /^[0-9A-Za-z._-]{1,40}$/.test(String(body.edition || "")) ? String(body.edition) : ADS_EDITION;
    const source = ["app", "web"].includes(body.source) ? body.source : "app";
    const ref = db().collection("adsConsents").doc(consentDocId(v.scope, v.rootId, decoded.uid));
    const prev = (await ref.get()).data() || {};
    let events = Array.isArray(prev.events) ? prev.events.slice(-19) : [];
    const ev = { on: body.on, at: t, edition, source };
    if (body.on) {
      ev.ip = String(clientIp(req) || "").slice(0, 64);
      ev.ua = String((req.headers || {})["user-agent"] || "").slice(0, 300);
    } else {
      // Отказ: адрес и браузер больше не нужны — остаются даты и редакции.
      events = events.map(({ ip, ua, ...rest }) => { void ip; void ua; return rest; });
    }
    events.push(ev);
    await ref.set({
      rootKey: v.key, scope: v.scope, rootId: v.rootId, uid: decoded.uid,
      on: body.on, edition, updatedAt: ts(t), events,
    });
    await clientRef.set({ adsConsent: body.on, adsConsentAt: ts(t), adsConsentEdition: edition }, { merge: true });
    statsCache.delete(v.key);
    sendJson(res, 200, { ok: true, on: body.on });
  }

  /** Гость удалил свои данные: отказ от сообщений, без адреса и браузера. */
  async function forgetConsent(scope, rootId, uid) {
    const ref = db().collection("adsConsents").doc(consentDocId(scope, rootId, uid));
    const snap = await ref.get();
    if (!snap.exists) return;
    const events = (Array.isArray(snap.data().events) ? snap.data().events : [])
      .map(({ ip, ua, ...rest }) => { void ip; void ua; return rest; });
    events.push({ on: false, at: now(), source: "deleted" });
    await ref.set({ on: false, updatedAt: ts(now()), events: events.slice(-20) }, { merge: true });
  }

  // --------------------------------------------- сегменты и настройки (кабинет)

  async function stats(v, c, t) {
    const hit = statsCache.get(v.key);
    if (hit && hit.at + SEGMENTS_CACHE_MS > t && JSON.stringify(hit.c) === JSON.stringify(c)) return hit.stats;
    const tz = await venueTz(v.tenantId);
    const snap = await v.root.collection("clients").get();
    const s = computeStats(snap.docs.map((d) => d.data()), c, t, localParts(tz, t).month);
    if (statsCache.size > 2000) statsCache.clear();
    statsCache.set(v.key, { at: t, c, stats: s });
    return s;
  }

  async function canEdit(v, uid) {
    try {
      if (v.scope === "chain") await requireChainRole(v.chainId, uid, ["owner", "admin"]);
      else await requireTenantRole(v.tenantId, uid, ["owner", "admin"]);
      return true;
    } catch (e) {
      if (e && e.status === 403) return false;
      throw e;
    }
  }

  async function handleSegments(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const v = await venueOf(body.tenantId);
    await requireTenantRole(v.tenantId, decoded.uid, ["owner", "admin", "manager"]);
    const { settings, state } = await loadCampaign(v);
    const t = now();
    sendJson(res, 200, {
      ok: true,
      scope: v.scope,
      stats: await stats(v, settings, t),
      campaign: settings,
      lastRun: state.lastRunAt ? { at: toMs(state.lastRunAt), sent: Number(state.lastRunSent) || 0 } : null,
      totalSent: Number(state.totalSent) || 0,
      canEdit: await canEdit(v, decoded.uid),
      limits: { afterDays: AFTER_DAYS, repeatDays: REPEAT_DAYS, maxBonus: MAX_BONUS, perDay: MAX_PER_DAY, hours: [SEND_FROM_HOUR, SEND_TO_HOUR], showDays: SHOW_DAYS },
      hookah: await isHookahVenue(v),
      textProblem: settingsProblem(settings),
    });
  }

  async function handleCampaign(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const v = await venueOf(body.tenantId);
    if (!(await canEdit(v, decoded.uid))) {
      throw new HttpError(403, v.scope === "chain"
        ? "Рассылку сети настраивает владелец или администратор сети"
        : "Рассылку настраивает владелец или администратор заведения");
    }
    const next = normalizeSettings({ ...(body.settings || {}) });
    // Выключенную рассылку можно сохранить черновиком; включить — только с допустимым текстом.
    const problem = settingsProblem(next);
    if (problem && next.enabled) throw new HttpError(400, problem);
    const t = now();
    await campaignRef(v.key).set({
      ...next, scope: v.scope, rootId: v.rootId, tenantId: v.tenantId,
      updatedAt: ts(t), updatedBy: decoded.uid,
    }, { merge: true });
    await writeAuditLog({
      tenantId: v.tenantId, actorId: decoded.uid, action: "guestCampaignSaved",
      metadata: { enabled: next.enabled, afterDays: next.afterDays, repeatDays: next.repeatDays, bonus: next.bonus, scope: v.scope },
    });
    statsCache.delete(v.key);
    sendJson(res, 200, { ok: true, campaign: next, stats: await stats(v, next, t) });
  }

  // ------------------------------------------------------ рассылка (задача)

  /** Подарок одному гостю: всё в одной транзакции, условия — ещё раз внутри. */
  async function gift(v, uid, c, t, from) {
    const ref = v.root.collection("clients").doc(uid);
    return db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const d = snap.data();
      if (!isEligible(d, c, t)) return false;
      const prev = toMs(d.winbackAt);
      const last = toMs(d.lastVisitAt);
      const tries = prev != null && last != null && last <= prev ? (Number(d.winbackTries) || 0) + 1 : 1;
      const patch = {
        winbackAt: ts(t),
        winbackSpent: Number(d.totalSpent) || 0,
        winbackTries: tries,
        promo: {
          id: `winback-${t}`, kind: "winback", title: c.title, text: c.text, bonus: c.bonus, from,
          at: ts(t), until: ts(t + SHOW_DAYS * DAY),
        },
      };
      if (c.bonus > 0) {
        patch.bonusBalance = (Number(d.bonusBalance) || 0) + c.bonus;
        tx.set(v.root.collection("bonusOperations").doc(), {
          clientUid: uid, type: "accrual", amount: c.bonus, reason: "winback", createdAt: ts(t),
        });
      }
      tx.set(ref, patch, { merge: true });
      return true;
    });
  }

  /** Одна кампания: проверки, отбор гостей, подарки. { sent } или { skipped }. */
  async function runCampaign(doc, { force = false } = {}) {
    const raw = doc.data();
    const c = normalizeSettings(raw);
    if (!c.enabled) return { skipped: "off" };
    if (settingsProblem(c)) return { skipped: "text" };
    const v = await venueOf(String(raw.tenantId || "")).catch(() => null);
    if (!v || v.key !== doc.id) return { skipped: "venue" };
    if (["suspended", "deleted"].includes(v.tenant.status)) return { skipped: "venue" };
    const sub = await db().collection("subscriptions").doc(v.chainId || v.tenantId).get();
    if (!sub.exists || !["trial", "active"].includes(sub.data().status)) return { skipped: "subscription" };
    const t = now();
    const lp = localParts(await venueTz(v.tenantId), t);
    if (!force && (lp.hour < SEND_FROM_HOUR || lp.hour >= SEND_TO_HOUR)) return { skipped: "hour" };
    if (!force && raw.lastRunDay === lp.ymd) return { skipped: "today" };
    // День занят сразу: перезапуск сервера посреди рассылки не начнёт её заново.
    await doc.ref.set({ lastRunDay: lp.ymd, lastRunAt: ts(t) }, { merge: true });

    const snap = await v.root.collection("clients").where("adsConsent", "==", true).get();
    const pool = snap.docs
      .filter((d) => isEligible(d.data(), c, t))
      .sort((a, b) => (toMs(b.data().lastVisitAt) || 0) - (toMs(a.data().lastVisitAt) || 0));
    const from = await venueName(v);
    let sent = 0;
    for (const d of pool.slice(0, MAX_PER_DAY)) {
      // Согласие сверяем с записью на сервере, а не только с отметкой в профиле.
      const ev = await db().collection("adsConsents").doc(consentDocId(v.scope, v.rootId, d.id)).get();
      if (!ev.exists || ev.data().on !== true) continue;
      try {
        if (await gift(v, d.id, c, t, from)) sent += 1;
      } catch (e) {
        log.error(`guest-marketing ${v.key}: ${e.message || e}`);
      }
    }
    await doc.ref.set({
      lastRunSent: sent,
      totalSent: admin.firestore.FieldValue.increment(sent),
    }, { merge: true });
    statsCache.delete(v.key);
    return { sent, left: Math.max(0, pool.length - MAX_PER_DAY) };
  }

  async function runAll(opts = {}) {
    const snap = await db().collection("guestCampaigns").where("enabled", "==", true).get();
    const out = {};
    for (const doc of snap.docs) {
      try {
        out[doc.id] = await runCampaign(doc, opts);
        if (out[doc.id].sent) log.log(`guest-marketing ${doc.id}: подарков ${out[doc.id].sent}`);
      } catch (e) {
        out[doc.id] = { error: e.message || String(e) };
        log.error(`guest-marketing ${doc.id}: ${e.message || e}`);
      }
    }
    return out;
  }

  return { handleConsent, handleSegments, handleCampaign, runAll, runCampaign, forgetConsent, _caches: { statsCache, consentHits } };
}

module.exports = {
  createGuestMarketing, textProblem, normalizeSettings, settingsProblem, segmentOf, isEligible, computeStats,
  localParts, consentDocId, rootKeyOf, ADS_EDITION, DEFAULTS, MAX_PER_DAY, MAX_TRIES, SHOW_DAYS, AFTER_DAYS, REPEAT_DAYS,
};
