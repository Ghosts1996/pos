"use strict";
// «Приведи коллегу»: заведение делится ссылкой zalpos.ru/?v=КОД, новое
// заведение регистрируется по ней, и после ПЕРВОЙ настоящей оплаты подписки
// приглашённым пригласивший получает 30 бесплатных дней. Не больше 12 таких
// месяцев на одного пригласившего; себя пригласить нельзя (тот же владелец).
//
// Хранение (клиенты писать не могут — правила tenants/chains/subscriptions):
//   venueReferralCodes/{КОД} → { billingId, isChain, ownerUid, createdAt }
//   tenants|chains/{id}.vrefCode — код этого заведения или сети;
//   tenants|chains/{id}.referredBy — { code, billingId, isChain, at } у приглашённого;
//   .referralRewardedAt — бонус за это приглашение уже выдан;
//   .referralMonths — сколько месяцев уже получил пригласивший.
// Бонус: пробный период — trialEndsAt +30 дней; оплаченный — currentPeriodEnd
// +30 дней и freeUntil +30 дней (это бесплатные дни, а не оплаченные: их не
// возвращают и не пересчитывают при смене тарифа — periodCarry); подписка не
// действует — referralCreditDays +30, их добавит следующая оплата.

const DAY = 86400000;
const BONUS_DAYS = 30;
const MAX_MONTHS = 12;
const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-Z2-9]{8}$/;

function cleanCode(v) {
  const c = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return CODE_RE.test(c) ? c : "";
}

const msOf = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : Number(t) || 0);

/** Что поменять в подписке пригласившего: +30 бесплатных дней. */
function bonusUpdate(sub, now, admin) {
  const s = sub || {};
  const ts = (ms) => admin.firestore.Timestamp.fromMillis(ms);
  if (s.status === "trial" && msOf(s.trialEndsAt) > now) {
    return { trialEndsAt: ts(msOf(s.trialEndsAt) + BONUS_DAYS * DAY) };
  }
  const end = msOf(s.currentPeriodEnd);
  if (s.status === "active" && end > now) {
    const freeFrom = Math.max(now, msOf(s.freeUntil));
    return {
      currentPeriodEnd: ts(end + BONUS_DAYS * DAY),
      freeUntil: ts(Math.min(end + BONUS_DAYS * DAY, freeFrom + BONUS_DAYS * DAY)),
    };
  }
  return { referralCreditDays: (Number(s.referralCreditDays) || 0) + BONUS_DAYS };
}

function createVenueReferral(deps) {
  const { db, admin, HttpError, verifyAuth, parseJsonBody, sendJson, requireTenantRole, requireChainRole, writeAuditLog,
    siteUrl = "https://zalpos.ru", random = () => require("crypto").randomInt(CODE_ABC.length) } = deps;

  const codes = () => db().collection("venueReferralCodes");
  const billingDoc = (isChain, id) => db().collection(isChain ? "chains" : "tenants").doc(id);

  async function ensureCode(isChain, billingId, ownerUid) {
    const ref = billingDoc(isChain, billingId);
    const cur = (await ref.get()).data() || {};
    if (cleanCode(cur.vrefCode)) return cur.vrefCode;
    for (let i = 0; i < 8; i++) {
      let code = "";
      for (let k = 0; k < 8; k++) code += CODE_ABC[random()];
      const made = await db().runTransaction(async (tx) => {
        const c = codes().doc(code);
        const [seen, again] = await Promise.all([tx.get(c), tx.get(ref)]);
        if (cleanCode((again.data() || {}).vrefCode)) return again.data().vrefCode;
        if (seen.exists) return "";
        tx.set(c, { billingId, isChain, ownerUid: ownerUid || null, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        tx.set(ref, { vrefCode: code }, { merge: true });
        return code;
      });
      if (made) return made;
    }
    throw new HttpError(503, "Не удалось выдать код приглашения — попробуйте ещё раз");
  }

  /** Кабинет → «Оплата»: ссылка и итоги приглашений. Только владелец. */
  async function handleGet(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!tenantId) throw new HttpError(400, "Не указано заведение");
    const tenant = (await billingDoc(false, tenantId).get()).data();
    if (!tenant || tenant.status === "deleted") throw new HttpError(404, "Заведение не найдено");
    const isChain = !!tenant.chainId;
    const billingId = isChain ? tenant.chainId : tenantId;
    if (isChain) await requireChainRole(billingId, decoded.uid, ["owner"]);
    else await requireTenantRole(tenantId, decoded.uid, ["owner"]);
    const owner = (await billingDoc(isChain, billingId).get()).data() || {};
    if (tenant.isDemo || owner.isDemo) throw new HttpError(409, "В демо-заведении приглашений нет");
    const code = await ensureCode(isChain, billingId, decoded.uid);
    const [t, c] = await Promise.all([
      db().collection("tenants").where("referredBy.code", "==", code).get(),
      db().collection("chains").where("referredBy.code", "==", code).get(),
    ]);
    const all = [...t.docs, ...c.docs].map((d) => d.data() || {}).filter((d) => d.status !== "deleted");
    sendJson(res, 200, {
      code,
      link: `${siteUrl}/?v=${code}`,
      invited: all.length,
      paid: all.filter((d) => d.referralRewardedAt).length,
      monthsEarned: Number(owner.referralMonths) || 0,
      maxMonths: MAX_MONTHS,
      bonusDays: BONUS_DAYS,
    });
  }

  /** createTenant/createChain: кто пригласил (или null). Себя — нельзя. */
  async function referredByFrom(decoded, body) {
    const code = cleanCode(body && body.venueRef);
    if (!code) return null;
    const snap = await codes().doc(code).get();
    if (!snap.exists) return null;
    const r = snap.data() || {};
    if (!r.billingId || (r.ownerUid && r.ownerUid === decoded.uid)) return null;
    const owner = (await billingDoc(!!r.isChain, r.billingId).get()).data() || {};
    if (owner.ownerUserId && owner.ownerUserId === decoded.uid) return null;
    if (owner.status === "deleted") return null;
    return { code, billingId: r.billingId, isChain: !!r.isChain, at: admin.firestore.FieldValue.serverTimestamp() };
  }

  /** После первой настоящей оплаты приглашённого — бонус пригласившему.
   *  Повторные оплаты и повторная доставка уведомления ничего не добавляют. */
  async function reward({ billingId, isChain, now = Date.now() }) {
    const invitedRef = billingDoc(isChain, billingId);
    const result = await db().runTransaction(async (tx) => {
      const invited = (await tx.get(invitedRef)).data() || {};
      const rb = invited.referredBy;
      if (!rb || !rb.billingId || invited.referralRewardedAt) return null;
      const referrerRef = billingDoc(!!rb.isChain, rb.billingId);
      const subRef = db().collection("subscriptions").doc(rb.billingId);
      const [referrerSnap, subSnap] = await Promise.all([tx.get(referrerRef), tx.get(subRef)]);
      const referrer = referrerSnap.data() || {};
      const months = Number(referrer.referralMonths) || 0;
      const stamp = admin.firestore.FieldValue.serverTimestamp();
      if (!referrerSnap.exists || referrer.status === "deleted" || months >= MAX_MONTHS) {
        tx.set(invitedRef, { referralRewardedAt: stamp, referralRewardSkipped: months >= MAX_MONTHS ? "limit" : "referrer-gone" }, { merge: true });
        return null;
      }
      const upd = bonusUpdate(subSnap.data(), now, admin);
      tx.set(subRef, upd, { merge: true });
      tx.set(referrerRef, { referralMonths: months + 1 }, { merge: true });
      tx.set(invitedRef, { referralRewardedAt: stamp }, { merge: true });
      return { referrer: rb.billingId, referrerIsChain: !!rb.isChain, how: Object.keys(upd).join(",") };
    });
    if (result) {
      await writeAuditLog({ tenantId: result.referrerIsChain ? null : result.referrer, actorId: null, action: "venueReferralBonus",
        metadata: { invited: billingId, invitedIsChain: isChain, chainId: result.referrerIsChain ? result.referrer : null, days: BONUS_DAYS, how: result.how } })
        .catch(() => {});
    }
    return result;
  }

  return { handleGet, referredByFrom, reward, ensureCode };
}

module.exports = { createVenueReferral, bonusUpdate, cleanCode, BONUS_DAYS, MAX_MONTHS };
