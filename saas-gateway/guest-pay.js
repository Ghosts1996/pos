"use strict";
/**
 * Онлайн-оплата гостем — счёт за столом и заказ доставки/с собой — через
 * банк заведения: Т-Банк (QR СБП), ЮKassa (СБП), Робокасса, Сбербанк и
 * Альфа-Банк (интернет-эквайринг).
 *
 * Гость нажимает «Оплатить» → шлюз сам считает сумму по счёту (цифре с
 * телефона не доверяем), заводит платёж в банке и отдаёт ссылку → гость
 * платит в своём банке → шлюз узнаёт об оплате (уведомление банка, опрос
 * гостя или фоновая проверка раз в минуту) → отмечает оплату в счёте и
 * зовёт персонал: «Оплачено онлайн». Касса подставляет сумму в оплату и
 * пробивает чек с контактом гостя.
 *
 * Реквизиты банка живут в settings/integrations заведения (читает только
 * персонал) и на телефон гостя не попадают; гостю виден только признак
 * meta/venueProfile.onlinePay — какой банк подключён.
 *
 * Сертификаты API Т-Банка, Сбера и Альфы выпущены Минцифры (Russian
 * Trusted Root CA), которого нет в стандартном наборе Node. Ему доверяем
 * только в запросах к банкам (certs/russian_trusted_root_ca.pem), а не во
 * всём процессе.
 */
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const tls = require("tls");

const TBANK_URL = "https://securepay.tinkoff.ru/v2";
const YOOKASSA_URL = "https://api.yookassa.ru/v3";
const ROBOKASSA_PAY_URL = "https://auth.robokassa.ru/Merchant/Index.aspx";
const ROBOKASSA_STATE_URL = "https://auth.robokassa.ru/Merchant/WebService/Service.asmx/OpStateExt";
const RBS_URLS = {
  sber: { prod: "https://securepayments.sberbank.ru/payment/rest", test: "https://3dsec.sberbank.ru/payment/rest" },
  alfa: { prod: "https://payment.alfabank.ru/payment/rest", test: "https://alfa.rbsuat.com/payment/rest" },
};
const ROBOKASSA_HASHES = ["md5", "sha1", "sha256", "sha384", "sha512"];

/** Банки, через которые гость платит онлайн. id хранится в настройках. */
const PROVIDERS = {
  tinkoff: "Т-Банк",
  yookassa: "ЮKassa",
  robokassa: "Робокасса",
  sber: "Сбербанк",
  alfa: "Альфа-Банк",
};

const TOBACCO = /кальян|табак|никотин|hookah|shisha|снюс|вейп|сигар/i;
const LINK_TTL_MS = 15 * 60 * 1000;
// Платёж без ответа банка дольше этого — считаем брошенным.
const PENDING_TTL_MS = 40 * 60 * 1000;

const round2 = (v) => Math.round(v * 100) / 100;

let RU_ROOT = "";
try {
  RU_ROOT = fs.readFileSync(path.join(__dirname, "certs", "russian_trusted_root_ca.pem"), "utf8");
} catch (_) { /* без файла — только стандартные корни */ }
const BANK_CA = RU_ROOT ? [...tls.rootCertificates, RU_ROOT] : undefined;

class BankUnreachable extends Error {}

/** HTTPS-запрос к банку с корнем Минцифры. → { status, text }. */
function bankHttp(url, { method = "GET", headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : Buffer.from(body, "utf8");
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: { ...headers, ...(payload ? { "Content-Length": payload.length } : {}) },
      ca: BANK_CA,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject(new BankUnreachable(e.message || String(e))));
    if (payload) req.write(payload);
    req.end();
  });
}

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

/** Подпись Робокассы: выбранный в магазине алгоритм (по умолчанию MD5). */
function robokassaSig(algo, parts) {
  return crypto.createHash(algo).update(parts.join(":"), "utf8").digest("hex");
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

/** Сколько гостю платить сейчас: счёт + чаевые «к счёту» − уже оплаченное онлайн. */
function amountDue({ bill, tips, paid }) {
  return Math.max(0, round2(bill + tips - paid));
}

/**
 * Реквизиты онлайн-оплаты из settings/integrations. Раньше Т-Банк QR СБП
 * выбирался как «терминал» — такие настройки работают и дальше.
 */
function onlinePaySettings(s) {
  s = s || {};
  let provider = String(s.onlinePayProvider || "").trim();
  let login = String(s.onlinePayLogin || "").trim();
  let password = String(s.onlinePayPassword || "").trim();
  if (!provider && s.terminalProvider === "tinkoff_sbp") {
    provider = "tinkoff";
    login = String(s.terminalLogin || "").trim();
    password = String(s.terminalPassword || "").trim();
  }
  if (!PROVIDERS[provider] || !login || !password) return null;
  const password2 = String(s.onlinePayPassword2 || "").trim();
  if (provider === "robokassa" && !password2) return null;
  const hash = String(s.onlinePayHash || "md5").toLowerCase();
  return {
    provider,
    login,
    password,
    password2,
    test: s.onlinePayTest === true,
    hash: ROBOKASSA_HASHES.includes(hash) ? hash : "md5",
  };
}

function rbsBase(c) {
  const urls = RBS_URLS[c.provider];
  return c.test ? urls.test : urls.prod;
}

function form(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return {};
  }
}

/** Код из XML Робокассы: <Result><Code>0</Code>…<State><Code>100</Code>. */
function xmlCode(xml, block) {
  const m = new RegExp(`<${block}>\\s*<Code>(\\d+)</Code>`, "i").exec(String(xml || ""));
  return m ? Number(m[1]) : null;
}

function createGuestPay({ db, admin, verifyAuth, parseJsonBody, readBody, sendJson, HttpError, requireTenantRole, publicUrl, httpImpl }) {
  const http = httpImpl || bankHttp;
  const tenantRef = (t) => db().collection("tenants").doc(t);
  const pendingCol = () => db().collection("pendingGuestPayments");
  const doneUrl = `${publicUrl}/guestPayDone`;

  async function call(url, opts, bankName) {
    try {
      return await http(url, opts);
    } catch (e) {
      if (e instanceof BankUnreachable || /timeout|ECONN|ENOTFOUND|EAI_AGAIN|certificate/i.test(String(e && e.message))) {
        throw new HttpError(502, `${bankName} сейчас не отвечает — попробуйте через минуту`);
      }
      throw e;
    }
  }

  // ------------------------------------------------------------ банки

  async function tbank(c, method, params) {
    const body = { TerminalKey: c.login, ...params };
    body.Token = tbankToken(body, c.password);
    const r = await call(`${TBANK_URL}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, "Т-Банк");
    const data = parseJson(r.text);
    if (data.Success !== true) throw new HttpError(502, `Т-Банк: ${data.Message || data.Details || "запрос отклонён"}`);
    return data;
  }

  function yookassaHeaders(c, idempotenceKey) {
    return {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${c.login}:${c.password}`).toString("base64")}`,
      ...(idempotenceKey ? { "Idempotence-Key": idempotenceKey } : {}),
    };
  }

  async function rbs(c, method, params) {
    const r = await call(`${rbsBase(c)}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ userName: c.login, password: c.password, ...params }),
    }, PROVIDERS[c.provider]);
    return parseJson(r.text);
  }

  async function nextRobokassaInvId(tenantId) {
    const ref = tenantRef(tenantId).collection("meta").doc("onlinePayCounter");
    return db().runTransaction(async (tx) => {
      // С большого числа — чтобы не встретиться с номерами счетов сайта
      // заведения в том же магазине Робокассы.
      const next = (Number((await tx.get(ref)).data()?.robokassaInvId) || 700000000) + 1;
      tx.set(ref, { robokassaInvId: next }, { merge: true });
      return next;
    });
  }

  /** Заводит платёж. → { docId, providerId, url } (url — ссылка СБП или страница банка). */
  async function createPayment(c, { tenantId, amount, orderId, description }) {
    const kopecks = Math.round(amount * 100);
    switch (c.provider) {
      case "tinkoff": {
        const due = new Date(Date.now() + LINK_TTL_MS);
        const init = await tbank(c, "Init", {
          Amount: kopecks,
          OrderId: orderId,
          Description: description.slice(0, 140),
          NotificationURL: `${publicUrl}/guestPayNotify?t=${encodeURIComponent(tenantId)}`,
          RedirectDueDate: due.toISOString().replace(/\.\d{3}Z$/, "+00:00"),
        });
        const id = String(init.PaymentId);
        const qr = await tbank(c, "GetQr", { PaymentId: id, DataType: "PAYLOAD" });
        return { docId: id, providerId: id, url: String(qr.Data || "") };
      }
      case "yookassa": {
        const r = await call(`${YOOKASSA_URL}/payments`, {
          method: "POST",
          headers: yookassaHeaders(c, orderId),
          body: JSON.stringify({
            amount: { value: amount.toFixed(2), currency: "RUB" },
            capture: true,
            payment_method_data: { type: "sbp" },
            confirmation: { type: "redirect", return_url: doneUrl },
            description: description.slice(0, 128),
            metadata: { orderId, tenantId },
          }),
        }, "ЮKassa");
        const data = parseJson(r.text);
        if (r.status >= 300 || !data.id) {
          const d = String(data.description || "");
          if (/receipt/i.test(d)) {
            throw new HttpError(502, "ЮKassa требует чек от ЮKassa — в личном кабинете ЮKassa отключите «Чеки от ЮKassa»: чек пробивает касса заведения");
          }
          if (/sbp|payment_method/i.test(d)) {
            throw new HttpError(502, "В магазине ЮKassa не подключена оплата через СБП — включите её в личном кабинете ЮKassa");
          }
          throw new HttpError(502, `ЮKassa: ${d || `ошибка ${r.status}`}`);
        }
        return { docId: null, providerId: String(data.id), url: String(data.confirmation?.confirmation_url || "") };
      }
      case "robokassa": {
        const invId = await nextRobokassaInvId(tenantId);
        const outSum = amount.toFixed(2);
        const shp = `Shp_t=${tenantId}`;
        const params = new URLSearchParams({
          MerchantLogin: c.login,
          OutSum: outSum,
          InvId: String(invId),
          Description: description.slice(0, 100),
          SignatureValue: robokassaSig(c.hash, [c.login, outSum, String(invId), c.password, shp]),
          Culture: "ru",
          Encoding: "utf-8",
          Shp_t: tenantId,
        });
        if (c.test) params.set("IsTest", "1");
        return { docId: null, providerId: String(invId), url: `${ROBOKASSA_PAY_URL}?${params.toString()}` };
      }
      case "sber":
      case "alfa": {
        const data = await rbs(c, "register.do", {
          orderNumber: orderId,
          amount: kopecks,
          returnUrl: doneUrl,
          failUrl: doneUrl,
          description: description.slice(0, 99),
          language: "ru",
          sessionTimeoutSecs: 1200,
        });
        if (!data.orderId || !data.formUrl) {
          throw new HttpError(502, `${PROVIDERS[c.provider]}: ${data.errorMessage || "запрос отклонён"}`);
        }
        return { docId: null, providerId: String(data.orderId), url: String(data.formUrl) };
      }
    }
    throw new HttpError(409, "Банк для онлайн-оплаты не выбран");
  }

  /** Статус платежа в банке: 'paid' | 'failed' | 'pending'. */
  async function bankStatus(c, providerId) {
    switch (c.provider) {
      case "tinkoff": {
        const st = await tbank(c, "GetState", { PaymentId: providerId });
        if (st.Status === "CONFIRMED") return "paid";
        if (["REJECTED", "DEADLINE_EXPIRED", "CANCELED", "AUTH_FAIL", "REVERSED", "REFUNDED"].includes(st.Status)) return "failed";
        return "pending";
      }
      case "yookassa": {
        const r = await call(`${YOOKASSA_URL}/payments/${encodeURIComponent(providerId)}`, { headers: yookassaHeaders(c) }, "ЮKassa");
        const data = parseJson(r.text);
        if (data.status === "succeeded") return "paid";
        if (data.status === "canceled") return "failed";
        return "pending";
      }
      case "robokassa": {
        const q = new URLSearchParams({
          MerchantLogin: c.login,
          InvoiceID: providerId,
          Signature: robokassaSig(c.hash, [c.login, providerId, c.password2]),
        });
        const r = await call(`${ROBOKASSA_STATE_URL}?${q.toString()}`, {}, "Робокасса");
        if (xmlCode(r.text, "Result") !== 0) return "pending";
        const state = xmlCode(r.text, "State");
        if (state === 100) return "paid";
        if (state === 10 || state === 60) return "failed";
        return "pending";
      }
      case "sber":
      case "alfa": {
        const data = await rbs(c, "getOrderStatusExtended.do", { orderId: providerId });
        const s = Number(data.orderStatus);
        if (s === 2) return "paid";
        if (s === 3 || s === 4 || s === 6) return "failed";
        return "pending";
      }
    }
    return "pending";
  }

  // ------------------------------------------------------------ заведение

  async function venueSettings(tenantId) {
    const [integ, venue] = await Promise.all([
      tenantRef(tenantId).collection("settings").doc("integrations").get(),
      tenantRef(tenantId).collection("meta").doc("venueProfile").get(),
    ]);
    const enabled = (venue.data() || {}).guestSbpPay === true;
    const c = onlinePaySettings(integ.data());
    return { enabled, creds: c };
  }

  function checkTenantId(tenantId) {
    if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new HttpError(400, "Не указано заведение");
  }

  /** Отмечает платёж оплаченным один раз — по уведомлению банка, опросу гостя или фоновой проверке. */
  async function markPaid(tenantId, paymentId) {
    const t = tenantRef(tenantId);
    const payRef = t.collection("guestPayments").doc(paymentId);
    let notice = null;
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
      const where = ses?.orderType ? " — пробейте чек: заказ оплачен заранее" : "";
      notice = {
        tableId: p.tableId || "",
        tableName: p.tableName || "",
        sessionId: p.sessionId,
        clientUid: p.clientUid || "",
        guestName: "",
        type: "paid",
        comment: `Оплачено онлайн (${PROVIDERS[p.provider] || "банк"}): ${p.amount} ₽${ses?.status === "active" ? where : " — счёт уже был закрыт, проверьте"}`,
        status: "new",
        createdAt: now,
      };
    });
    if (notice) await t.collection("waiterCalls").add(notice);
    await pendingCol().doc(`${tenantId}__${paymentId}`).delete().catch(() => {});
  }

  async function markFailed(tenantId, paymentId, reason) {
    const ref = tenantRef(tenantId).collection("guestPayments").doc(paymentId);
    await db().runTransaction(async (tx) => {
      const p = (await tx.get(ref)).data();
      if (p && p.status === "pending") tx.update(ref, { status: reason });
    });
    await pendingCol().doc(`${tenantId}__${paymentId}`).delete().catch(() => {});
  }

  /** Проверяет платёж в банке и записывает итог. → 'paid' | 'failed' | 'pending'. */
  async function resolvePayment(tenantId, paymentId, p) {
    const { creds } = await venueSettings(tenantId);
    if (!creds || creds.provider !== (p.provider || "tinkoff")) return "pending";
    const st = await bankStatus(creds, p.providerId || paymentId);
    if (st === "paid") await markPaid(tenantId, paymentId);
    if (st === "failed") await markFailed(tenantId, paymentId, "failed");
    return st;
  }

  // ------------------------------------------------------------ гость

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
    if (session.orderType && ["new", "cancelled"].includes(session.deliveryStatus || "new")) {
      throw new HttpError(409, session.deliveryStatus === "cancelled"
        ? "Заказ отменён — оплачивать его не нужно"
        : "Оплатить можно после подтверждения заказа — заведение вам позвонит");
    }
    const { enabled, creds } = await venueSettings(tenantId);
    if (!enabled || !creds) throw new HttpError(409, "Онлайн-оплата в этом заведении не включена");

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

    // Повторное нажатие — та же ссылка, а не второй платёж на ту же сумму.
    const fresh = Date.now() - 10 * 60 * 1000;
    const prev = (await t.collection("guestPayments").where("sessionId", "==", sessionId).get()).docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .find((p) => p.status === "pending" && p.clientUid === decoded.uid && Math.abs((p.amount || 0) - due) < 0.005 &&
        p.provider === creds.provider && p.url && (p.createdAt?.toMillis?.() || 0) > fresh);
    if (prev) return sendJson(res, 200, { paymentId: prev.id, payload: prev.url, url: prev.url, amount: due, provider: creds.provider });

    const orderId = `g${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
    const what = session.orderType === "delivery" ? "Доставка" : session.orderType === "takeaway" ? "Заказ с собой" : "Счёт";
    const description = `${what}${session.tableName && !session.orderType ? `: ${session.tableName}` : ""}`;
    const made = await createPayment(creds, { tenantId, amount: due, orderId, description });
    const paymentId = made.docId || `p_${orderId}`;
    const now = admin.firestore.Timestamp.now();
    await t.collection("guestPayments").doc(paymentId).set({
      sessionId,
      tableId: session.tableId || "",
      tableName: session.tableName || "",
      orderType: session.orderType || "",
      clientUid: decoded.uid,
      amount: due,
      bill,
      tips: round2(tips),
      orderId,
      provider: creds.provider,
      providerId: made.providerId,
      url: made.url,
      test: creds.test === true,
      status: "pending",
      createdAt: now,
    });
    await pendingCol().doc(`${tenantId}__${paymentId}`).set({ tenantId, paymentId, createdAt: now });
    sendJson(res, 200, { paymentId, payload: made.url, url: made.url, amount: due, provider: creds.provider });
  }

  async function handleStatus(req, res) {
    const decoded = await verifyAuth(req);
    const { tenantId, paymentId } = await parseJsonBody(req);
    checkTenantId(tenantId);
    if (typeof paymentId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(paymentId)) throw new HttpError(400, "Не указан платёж");
    const ref = tenantRef(tenantId).collection("guestPayments").doc(paymentId);
    const p = (await ref.get()).data();
    if (!p || p.clientUid !== decoded.uid) throw new HttpError(404, "Платёж не найден");
    if (p.status !== "pending") return sendJson(res, 200, { status: p.status === "paid" ? "paid" : "failed" });
    const st = await resolvePayment(tenantId, paymentId, p).catch(() => "pending");
    sendJson(res, 200, { status: st });
  }

  // ------------------------------------------------------------ банк → шлюз

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
    const { creds } = await venueSettings(tenantId);
    if (!creds || creds.provider !== "tinkoff" || !body || !tokenValid(body, creds.password)) throw new HttpError(403, "bad token");
    if (body.Status === "CONFIRMED" && body.Success !== false) {
      await markPaid(tenantId, String(body.PaymentId));
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  }

  /**
   * Result URL Робокассы (задаётся в «Технических настройках» магазина):
   * подпись паролем №2 с Shp_t — номер заведения. Ответ «OK<InvId>».
   */
  async function handleRobokassaResult(req, res) {
    const url = new URL(req.url, "http://x");
    const p = Object.fromEntries(url.searchParams);
    if (req.method === "POST") {
      Object.assign(p, Object.fromEntries(new URLSearchParams(await readBody(req))));
    }
    const tenantId = p.Shp_t || "";
    checkTenantId(tenantId);
    const invId = String(p.InvId || "");
    if (!/^\d{1,12}$/.test(invId)) throw new HttpError(400, "bad InvId");
    const { creds } = await venueSettings(tenantId);
    if (!creds || creds.provider !== "robokassa") throw new HttpError(403, "bad signature");
    const expected = robokassaSig(creds.hash, [String(p.OutSum || ""), invId, creds.password2, `Shp_t=${tenantId}`]);
    const given = String(p.SignatureValue || "").toLowerCase();
    if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      throw new HttpError(403, "bad signature");
    }
    const snap = await tenantRef(tenantId).collection("guestPayments")
      .where("providerId", "==", invId).limit(5).get();
    const doc = snap.docs.find((d) => d.data().provider === "robokassa");
    if (doc) await markPaid(tenantId, doc.id);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`OK${invId}`);
  }

  /** Куда банк возвращает гостя после оплаты: просто «вернитесь в приложение». */
  async function handleDone(req, res) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Оплата</title><style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center}main{max-width:420px}h1{font-size:22px}p{color:#aaa;line-height:1.5}</style></head>
<body><main><h1>Готово</h1><p>Вернитесь в приложение заведения — статус оплаты обновится сам через несколько секунд.</p><p>Если оплата не прошла, там же можно оплатить заново.</p></main></body></html>`);
  }

  /**
   * Проверка реквизитов без денег: запрос статуса несуществующего платежа
   * (банк отвечает «не найден» на верные реквизиты и «доступ запрещён» на
   * неверные). У Т-Банка подпись проверяет только Init — заводим платёж
   * на 1 ₽ и сразу отменяем.
   */
  async function checkCreds(c) {
    const bank = PROVIDERS[c.provider];
    switch (c.provider) {
      case "tinkoff": {
        try {
          const init = await tbank(c, "Init", { Amount: 100, OrderId: `check${Date.now().toString(36)}`, Description: "Проверка подключения" });
          await tbank(c, "Cancel", { PaymentId: String(init.PaymentId) }).catch(() => {});
          return { ok: true, message: `${bank} принял реквизиты` };
        } catch (e) {
          return { ok: false, message: e.message || `${bank} отклонил реквизиты` };
        }
      }
      case "yookassa": {
        const r = await call(`${YOOKASSA_URL}/payments/00000000-0000-0000-0000-000000000000`, { headers: yookassaHeaders(c) }, bank);
        if (r.status === 401 || r.status === 403) return { ok: false, message: "ЮKassa не приняла shopId или секретный ключ" };
        if (r.status === 404 || r.status === 400 || r.status === 200) return { ok: true, message: "ЮKassa приняла реквизиты" };
        return { ok: false, message: `ЮKassa ответила ${r.status}` };
      }
      case "robokassa": {
        const q = new URLSearchParams({ MerchantLogin: c.login, InvoiceID: "1", Signature: robokassaSig(c.hash, [c.login, "1", c.password2]) });
        const r = await call(`${ROBOKASSA_STATE_URL}?${q.toString()}`, {}, bank);
        const code = xmlCode(r.text, "Result");
        if (code === 0 || code === 3) return { ok: true, message: "Робокасса приняла идентификатор и пароль №2. Пароль №1 проверится при первой оплате" };
        if (code === 1) return { ok: false, message: "Робокасса: неверный пароль №2 или алгоритм подписи (по умолчанию MD5)" };
        if (code === 2) return { ok: false, message: "Робокасса: магазин с таким идентификатором не найден или не активирован" };
        return { ok: false, message: `Робокасса ответила кодом ${code ?? "?"}` };
      }
      case "sber":
      case "alfa": {
        const data = await rbs(c, "getOrderStatusExtended.do", { orderId: "00000000-0000-0000-0000-000000000000" });
        if (String(data.errorCode) === "5") return { ok: false, message: `${bank}: неверный логин или пароль API${c.test ? " тестового контура" : ""}` };
        return { ok: true, message: `${bank} принял логин и пароль${c.test ? " (тестовый контур)" : ""}` };
      }
    }
    return { ok: false, message: "Банк не выбран" };
  }

  async function handleCheck(req, res) {
    const decoded = await verifyAuth(req);
    const { tenantId } = await parseJsonBody(req);
    checkTenantId(tenantId);
    await requireTenantRole(tenantId, decoded.uid, ["owner", "admin", "manager", "employee"]);
    const { enabled, creds } = await venueSettings(tenantId);
    if (!creds) return sendJson(res, 200, { ok: false, enabled, message: "Заполните реквизиты банка и сохраните" });
    const r = await checkCreds(creds);
    sendJson(res, 200, { ...r, enabled });
  }

  // ------------------------------------------------------------ фон

  /** Раз в минуту — платежи, о которых банк ещё не сообщил (гость мог закрыть приложение). */
  async function sweep() {
    const snap = await pendingCol().limit(200).get();
    for (const d of snap.docs) {
      const { tenantId, paymentId, createdAt } = d.data();
      try {
        const ref = tenantRef(tenantId).collection("guestPayments").doc(paymentId);
        const p = (await ref.get()).data();
        if (!p || p.status !== "pending") {
          await d.ref.delete();
          continue;
        }
        const st = await resolvePayment(tenantId, paymentId, p);
        const age = Date.now() - (createdAt?.toMillis?.() || 0);
        if (st === "pending" && age > PENDING_TTL_MS) await markFailed(tenantId, paymentId, "expired");
      } catch (e) {
        console.error(`guest-pay sweep (${tenantId}/${paymentId}):`, e.message || e);
      }
    }
  }

  function startSweeper() {
    setInterval(() => sweep().catch((e) => console.error("guest-pay sweep:", e.message || e)), 60 * 1000);
  }

  return {
    handleStart, handleStatus, handleNotify, handleRobokassaResult, handleDone, handleCheck,
    markPaid, sweep, startSweeper, createPayment, bankStatus, checkCreds,
  };
}

module.exports = {
  createGuestPay, tbankToken, tokenValid, sessionBill, amountDue, onlinePaySettings, robokassaSig, xmlCode,
  PROVIDERS, RBS_URLS, BankUnreachable,
};
