"use strict";
// Отзывы гостей: сводка и настройки для кабинета (Гости → «Отзывы»).
//
// Гость ставит оценку после закрытого счёта в приложении или веб-версии
// (tenants/{точка}/reviews, правила — firestore.rules). Здесь:
//   • сводка для владельца: средняя оценка, распределение, последние отзывы
//     со столом и официантом — без имён и телефонов гостей (из текста они
//     вычищаются, pii-scrub.js);
//   • ссылки на карточку заведения в Яндекс Картах и 2ГИС: гостю с оценкой
//     4–5 приложение предложит оставить отзыв там (meta/venueProfile.reviewLinks).
// Низкую оценку (1–3) владелец получает сразу — бот заведения (telegram.js),
// событие review.created — вебхукам (webhooks.js).

const { scrubText } = require("./pii-scrub");

const DAY = 86400000;
const LOW = 3;
const LIST = 30;
const HOST_RE = /(^|\.)(yandex\.(ru|com|by|kz|uz)|ya\.ru|2gis\.(ru|com|kz|kg|uz|ae)|go\.2gis\.com)$/i;

const toMs = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : v instanceof Date ? v.getTime() : typeof v === "number" ? v : 0);

/** Ссылка на карточку в Яндекс Картах или 2ГИС: https и только их адреса. "" — пусто, null — не подходит. */
function cleanMapLink(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== "https:" || u.username || u.password || !HOST_RE.test(u.hostname) || s.length > 400) return null;
  return u.toString();
}

/** Отзыв для кабинета и вебхука: без имени гостя, текст без телефонов и почты. */
function reviewOut(id, r, session) {
  const s = session || {};
  return {
    id,
    rating: Math.max(1, Math.min(5, Math.round(Number(r.rating) || 0))),
    text: scrubText(String(r.text || "")).slice(0, 2000),
    createdAt: toMs(r.createdAt) ? new Date(toMs(r.createdAt)).toISOString() : null,
    sessionId: r.sessionId || null,
    table: s.tableName ? String(s.tableName) : null,
    waiter: s.employeeName ? String(s.employeeName) : null,
  };
}

/** Текст сигнала владельцу о низкой оценке (или null). */
function lowReviewAlert(review, { venue = "Заведение", label = "" } = {}) {
  if (!review || review.rating > LOW) return null;
  const head = `⭐ Низкая оценка ${review.rating} из 5 — ${label || venue}`;
  const where = [review.table ? `стол «${review.table}»` : "", review.waiter ? `обслуживал ${review.waiter}` : ""].filter(Boolean).join(", ");
  return [head, where ? where[0].toUpperCase() + where.slice(1) : "", review.text ? `«${review.text.slice(0, 600)}»` : "Без комментария.",
    "Гость, возможно, ещё в зале — подойдите к нему. Все отзывы — в кабинете: «Гости» → «Отзывы»."].filter(Boolean).join("\n");
}

function createReviews(deps) {
  const { db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, now = () => Date.now() } = deps;
  const Timestamp = admin.firestore.Timestamp;
  const tenant = (tid) => db().collection("tenants").doc(tid);

  async function sessionsOf(tid, ids) {
    const out = new Map();
    await Promise.all([...new Set(ids.filter(Boolean))].map(async (sid) => {
      const d = await tenant(tid).collection("sessions").doc(String(sid)).get().catch(() => null);
      if (d && d.exists) out.set(sid, d.data());
    }));
    return out;
  }

  async function summary(tid) {
    const since = Timestamp.fromMillis(now() - 90 * DAY);
    const docs = (await tenant(tid).collection("reviews").where("createdAt", ">=", since).get()).docs
      .map((d) => ({ id: d.id, ...d.data() })).filter((r) => Number(r.rating) >= 1)
      .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
    const stat = (days) => {
      const from = now() - days * DAY;
      const list = docs.filter((r) => toMs(r.createdAt) >= from);
      const avg = list.length ? list.reduce((s, r) => s + Number(r.rating), 0) / list.length : null;
      const by = [1, 2, 3, 4, 5].map((n) => list.filter((r) => Math.round(Number(r.rating)) === n).length);
      return { days, count: list.length, avg: avg === null ? null : Math.round(avg * 10) / 10, by, low: list.filter((r) => Number(r.rating) <= LOW).length };
    };
    const last = docs.slice(0, LIST);
    const ses = await sessionsOf(tid, last.map((r) => r.sessionId));
    const profile = (await tenant(tid).collection("meta").doc("venueProfile").get()).data() || {};
    const links = profile.reviewLinks || {};
    return {
      week: stat(7), month: stat(30), quarter: stat(90),
      reviews: last.map((r) => reviewOut(r.id, r, ses.get(r.sessionId))),
      links: { askPublic: links.askPublic !== false && !!(links.yandex || links.gis), yandex: links.yandex || "", gis: links.gis || "" },
    };
  }

  async function handle(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const tid = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new HttpError(400, "Не указано заведение");
    const action = String(body.action || "summary");
    if (action === "summary") {
      await requireTenantRole(tid, decoded.uid, ["owner", "admin", "manager"]);
      return sendJson(res, 200, await summary(tid));
    }
    if (action === "links") {
      await requireTenantRole(tid, decoded.uid, ["owner", "admin"]);
      const yandex = cleanMapLink(body.yandex);
      const gis = cleanMapLink(body.gis);
      if (yandex === null) throw new HttpError(400, "Ссылка на Яндекс Карты не подходит — скопируйте её из карточки заведения (https://yandex.ru/maps/…)");
      if (gis === null) throw new HttpError(400, "Ссылка на 2ГИС не подходит — скопируйте её из карточки заведения (https://2gis.ru/…)");
      await tenant(tid).collection("meta").doc("venueProfile").set({
        reviewLinks: { yandex, gis, askPublic: body.askPublic !== false, updatedAt: Timestamp.fromMillis(now()) },
      }, { merge: true });
      return sendJson(res, 200, await summary(tid));
    }
    throw new HttpError(400, "Неизвестное действие");
  }

  return { handle, summary };
}

module.exports = { createReviews, cleanMapLink, reviewOut, lowReviewAlert, LOW };
