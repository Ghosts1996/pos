"use strict";
/**
 * Оплата счёта гостем по СБП прямо со стола (Т-Банк, интернет-эквайринг).
 *
 * Гость в приложении нажимает «Оплатить по СБП» → шлюз считает сумму по
 * счёту сам (гостю цифру не доверяем), заводит платёж в Т-Банке и отдаёт
 * ссылку СБП → гость платит в своём банке → Т-Банк присылает уведомление
 * (или гость сам спрашивает статус) → шлюз отмечает оплату в счёте и зовёт
 * официанта: «Стол N оплатил по СБП». Касса подставляет эту сумму в оплату.
 *
 * Пароль терминала Т-Банка живёт в settings/integrations заведения и на
 * телефон гостя не попадает.
 */
const crypto = require("crypto");

const TBANK_URL = "https://securepay.tinkoff.ru/v2";
const TOBACCO = /кальян|табак|никотин|hookah|shisha|снюс|вейп|сигар/i;
const LINK_TTL_MS = 15 * 60 * 1000;

const round2 = (v) => Math.round(v * 100) / 100;

/** Токен Т-Банка: значения простых полей + Password, по алфавиту ключей, SHA-256. */
function tbankToken(params, password) {
  const all = { ...params, Password: password };
  delete all.Token;
  const keys = Object.keys(all)
    .filter((k) => all[k] !== null && all[k] !== undefined && typeof all[k] !== "object")
    .sort();
  return crypto.createHash("sha256").update(keys.map((k) => String(all[k])).join(""), "utf8").digest("hex");
}

function tokenValid(body, password) {
  const given = String(body.Token || "");
  const expected = tbankToken(body, password);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Счёт так же, как его считает касса: позиции минус скидка на то, что можно удешевлять. */
function sessionBill(session, excludeTobacco = true) {
  const items = Array.isArray(session.orderItems) ? session.orderItems : [];
  let total = 0;
  let promoBase = 0;
  for (const i of items) {
    const sum = (Number(i.price) || 0) * (Number(i.qty) || 0);
    total += sum;
    const restricted = excludeTobacco && (i.noPromo === true || TOBACCO.test(String(i.name || "")));
    if (!restricted) promoBase += sum;
  }
  const discount = Number(session.discountPercent) || 0;
  return round2(total - (promoBase * discount) / 100);
}

/** Сколько гостю платить сейчас: счёт + чаевые «к счёту» − уже оплаченное со стола. */
function amountDue({ bill, tips, paid }) {
  return Math.max(0, round2(bill + tips - paid));
}

function createGuestPay({ db, admin, verifyAuth, parseJsonBody, readBody, sendJson, HttpError, publicUrl, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const tenantRef = (t) => db().collection("tenants").doc(t);

  async function tbank(method, params, creds) {
    const body = { TerminalKey: creds.key, ...params };
    body.Token = tbankToken(body, creds.password);
    const resp = await doFetch(`${TBANK_URL}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (data.Success !== true) {
      throw new HttpError(502, `Т-Банк: ${data.Message || data.Details || "запрос отклонён"}`);
    }
    return data;
  }

  async function venueCreds(tenantId) {
    const [integ, venue] = await Promise.all([
      tenantRef(tenantId).collection("settings").doc("integrations").get(),
      tenantRef(tenantId).collection("meta").doc("venueProfile").get(),
    ]);
    const s = integ.data() || {};
    const enabled = (venue.data() || {}).guestSbpPay === true;
    const key = String(s.terminalLogin || "").trim();
    const password = String(s.terminalPassword || "").trim();
    if (!enabled || s.terminalProvider !== "tinkoff_sbp" || !key || !password) return null;
    return { key, password };
  }

  function checkTenantId(tenantId) {
    if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new HttpError(400, "Не указано заведение");
  }

  /** Отмечает платёж оплаченным один раз — и по уведомлению банка, и по опросу гостя. */
  async function markPaid(tenantId, paymentId) {
    const t = tenantRef(tenantId);
    const payRef = t.collection("guestPayments").doc(paymentId);
    let call = null;
    await db().runTransaction(async (tx) => {
      const pay = await tx.get(payRef);
      const p = pay.data();
      if (!p || p.status !== "pending") return;
      const sesRef = t.collection("sessions").doc(p.sessionId);
      const ses = (await tx.get(sesRef)).data();
      const now = admin.firestore.Timestamp.now();
      tx.update(payRef, { status: "paid", paidAt: now, sessionWasOpen: ses?.status === "active" });
      if (ses) {
        tx.update(sesRef, {
          guestPaidTotal: admin.firestore.FieldValue.increment(p.amount),
          guestPaymentIds: admin.firestore.FieldValue.arrayUnion(paymentId),
        });
      }
      call = {
        tableId: p.tableId || "",
        tableName: p.tableName || "",
        sessionId: p.sessionId,
        clientUid: p.clientUid || "",
        guestName: "",
        type: "paid",
        comment: `Оплачено по СБП: ${p.amount} ₽${ses?.status === "active" ? "" : " — счёт уже был закрыт, проверьте"}`,
        status: "new",
        createdAt: now,
      };
    });
    if (call) await t.collection("waiterCalls").add(call);
  }

  async function handleStart(req, res) {
    const decoded = await verifyAuth(req);
    const { tenantId, sessionId } = await parseJsonBody(req);
    checkTenantId(tenantId);
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new HttpError(400, "Не указан счёт");
    const t = tenantRef(tenantId);
    const claim = (await t.collection("sessionClaims").doc(sessionId).get()).data();
    if (!claim || claim.uid !== decoded.uid) throw new HttpError(403, "Это не ваш счёт");
    const session = (await t.collection("sessions").doc(sessionId).get()).data();
    if (!session || session.status !== "active") throw new HttpError(409, "Счёт уже закрыт");
    const creds = await venueCreds(tenantId);
    if (!creds) throw new HttpError(409, "Оплата со стола в этом заведении не включена");

    const loyalty = (await t.collection("settings").doc("loyalty").get()).data() || {};
    const excludeTobacco = typeof loyalty.excludeTobaccoFromPromo === "boolean" ? loyalty.excludeTobaccoFromPromo : true;
    const tipsSnap = await t.collection("tips").where("sessionId", "==", sessionId).get();
    const tips = tipsSnap.docs
      .map((d) => d.data())
      .filter((x) => x.status === "pending" && x.method !== "link")
      .reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const bill = sessionBill(session, excludeTobacco);
    const due = amountDue({ bill, tips, paid: Number(session.guestPaidTotal) || 0 });
    if (due < 1) throw new HttpError(409, "По счёту нечего оплачивать");

    const orderId = `g-${sessionId}-${Date.now()}`.slice(0, 50);
    const due15 = new Date(Date.now() + LINK_TTL_MS);
    const init = await tbank("Init", {
      Amount: String(Math.round(due * 100)),
      OrderId: orderId,
      Description: `Счёт${session.tableName ? `: ${session.tableName}` : ""}`.slice(0, 140),
      NotificationURL: `${publicUrl}/guestPayNotify?t=${encodeURIComponent(tenantId)}`,
      RedirectDueDate: due15.toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    }, creds);
    const paymentId = String(init.PaymentId);
    const qr = await tbank("GetQr", { PaymentId: paymentId, DataType: "PAYLOAD" }, creds);
    await t.collection("guestPayments").doc(paymentId).set({
      sessionId,
      tableId: session.tableId || "",
      tableName: session.tableName || "",
      clientUid: decoded.uid,
      amount: due,
      bill,
      tips: round2(tips),
      orderId,
      status: "pending",
      createdAt: admin.firestore.Timestamp.now(),
    });
    sendJson(res, 200, { paymentId, payload: qr.Data || "", amount: due });
  }

  async function handleStatus(req, res) {
    const decoded = await verifyAuth(req);
    const { tenantId, paymentId } = await parseJsonBody(req);
    checkTenantId(tenantId);
    if (typeof paymentId !== "string" || !/^[0-9]{1,30}$/.test(paymentId)) throw new HttpError(400, "Не указан платёж");
    const ref = tenantRef(tenantId).collection("guestPayments").doc(paymentId);
    const p = (await ref.get()).data();
    if (!p || p.clientUid !== decoded.uid) throw new HttpError(404, "Платёж не найден");
    if (p.status !== "pending") return sendJson(res, 200, { status: p.status });
    const creds = await venueCreds(tenantId);
    if (!creds) return sendJson(res, 200, { status: "pending" });
    const st = await tbank("GetState", { PaymentId: paymentId }, creds).catch(() => null);
    if (st?.Status === "CONFIRMED") {
      await markPaid(tenantId, paymentId);
      return sendJson(res, 200, { status: "paid" });
    }
    if (["REJECTED", "DEADLINE_EXPIRED", "CANCELED", "AUTH_FAIL", "REVERSED"].includes(st?.Status)) {
      await ref.update({ status: "failed", bankStatus: st.Status });
      return sendJson(res, 200, { status: "failed" });
    }
    sendJson(res, 200, { status: "pending" });
  }

  /** Уведомление Т-Банка. Ответ «OK» — иначе банк будет повторять. */
  async function handleNotify(req, res) {
    const url = new URL(req.url, "http://x");
    const tenantId = url.searchParams.get("t") || "";
    checkTenantId(tenantId);
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (_) {
      throw new HttpError(400, "bad body");
    }
    const creds = await venueCreds(tenantId);
    if (!creds || !body || !tokenValid(body, creds.password)) throw new HttpError(403, "bad token");
    if (body.Status === "CONFIRMED" && body.Success !== false) {
      await markPaid(tenantId, String(body.PaymentId));
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  }

  return { handleStart, handleStatus, handleNotify, markPaid };
}

module.exports = { createGuestPay, tbankToken, tokenValid, sessionBill, amountDue };
