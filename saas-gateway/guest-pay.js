"use strict";
const { requisitesProblem } = require("./requisites");
/**
 * Онлайн-оплата гостем — счёт за столом и заказ доставки/с собой — через
 * банк заведения:
 *  • Т-Банк — СБП (QR) или страница банка (карта, СБП, T-Pay);
 *  • Сбербанк, Альфа-Банк, ВТБ, МТС Банк — интернет-эквайринг на платёжном
 *    шлюзе RBS (страница банка: карта и СБП, если её включил банк);
 *  • другой банк на шлюзе RBS — по адресу API, который выдал банк;
 *  • Райффайзенбанк — СБП (динамический QR);
 *  • Робокасса — СБП и карты.
 * Тот же банк показывает QR на экране кассы (handleKassa*): гость у стойки
 * платит телефоном, без терминала.
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
const dns = require("dns");
const fs = require("fs");
const https = require("https");
const net = require("net");
const path = require("path");
const tls = require("tls");

const TBANK_URL = "https://securepay.tinkoff.ru/v2";
const ROBOKASSA_PAY_URL = "https://auth.robokassa.ru/Merchant/Index.aspx";
const ROBOKASSA_STATE_URL = "https://auth.robokassa.ru/Merchant/WebService/Service.asmx/OpStateExt";
const RBS_URLS = {
  sber: { prod: "https://securepayments.sberbank.ru/payment/rest", test: "https://3dsec.sberbank.ru/payment/rest" },
  alfa: { prod: "https://payment.alfabank.ru/payment/rest", test: "https://alfa.rbsuat.com/payment/rest" },
  vtb: { prod: "https://platezh.vtb24.ru/payment/rest", test: "https://vtb.rbsuat.com/payment/rest" },
  mts: { prod: "https://oplata.mtsbank.ru/payment/rest", test: "https://mts.rbsuat.com/payment/rest" },
};
const RAIF_URLS = { prod: "https://e-commerce.raiffeisen.ru/api", test: "https://test.ecom.raiffeisen.ru/api" };
const ROBOKASSA_HASHES = ["md5", "sha1", "sha256", "sha384", "sha512"];

/** Банки, через которые гость платит онлайн. id хранится в настройках. */
const PROVIDERS = {
  tinkoff: "Т-Банк",
  tinkoff_form: "Т-Банк",
  sber: "Сбербанк",
  alfa: "Альфа-Банк",
  vtb: "ВТБ",
  mts: "МТС Банк",
  raiffeisen: "Райффайзенбанк",
  rbs_custom: "Банк",
  robokassa: "Робокасса",
};

/** Банки на платёжном шлюзе RBS: register.do / getOrderStatusExtended.do. */
const RBS = new Set(["sber", "alfa", "vtb", "mts", "rbs_custom"]);
/** Где гость платит именно по СБП (QR / ссылка НСПК), а не на странице банка. */
const SBP_ONLY = new Set(["tinkoff", "raiffeisen"]);
/** У кого есть тестовый контур, включаемый флажком «Тестовый режим». */
const HAS_TEST = new Set(["robokassa", "sber", "alfa", "vtb", "mts", "raiffeisen"]);

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

/** Адрес из внутренней сети (localhost, 10/8, 192.168/16, fc00::/7 …). */
function privateIp(ip) {
  const v = String(ip || "").toLowerCase();
  if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
  if (net.isIPv4(v)) {
    const [a, b] = v.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(v)) return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  return true;
}

/**
 * Адрес API «другого банка на шлюзе RBS» — его вписывает владелец, поэтому
 * сервер ходит туда только по https, по доменному имени (не IP) и в путь
 * …/payment/rest. Чужие адреса вроде http://localhost:5432 отсекаются здесь,
 * а домен, который указывает во внутреннюю сеть, — при соединении
 * (publicLookup). null — адрес не годится.
 */
function rbsCustomUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch (_) {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || u.search || u.hash) return null;
  const host = u.hostname.toLowerCase();
  if (!/^([a-z0-9-]+\.)+([a-z]{2,}|xn--[a-z0-9-]+)$/.test(host)) return null;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host)) return null;
  const p = u.pathname.replace(/\/+$/, "");
  if (!/^(\/[A-Za-z0-9._~-]+)*\/payment\/rest$/.test(p)) return null;
  return `https://${host}${p}`;
}

/** DNS для адресов, которые вписал владелец: внутренние IP — отказ. */
function publicLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address }];
    if (list.some((a) => privateIp(a.address))) return cb(new Error(`${hostname}: адрес во внутренней сети`));
    cb(null, address, family);
  });
}

const MAX_BANK_REPLY = 1024 * 1024;

/** HTTPS-запрос к банку с корнем Минцифры. → { status, text }. */
function bankHttp(url, { method = "GET", headers = {}, body = null, timeoutMs = 15000, publicOnly = false } = {}) {
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
      ...(publicOnly ? { lookup: publicLookup } : {}),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_BANK_REPLY) return req.destroy(new Error("слишком длинный ответ"));
        chunks.push(c);
      });
      res.on("error", (e) => reject(new BankUnreachable(e.message || String(e))));
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
 * Реквизиты продавца в профиле заведения (meta/venueProfile): без них заказ
 * и оплата из приложения недоступны — гость должен видеть, у кого покупает
 * (ст. 9 и 26.1 закона «О защите прав потребителей»). Как sellerReady в
 * lib/models/venue_models.dart.
 */
function sellerReady(v) {
  v = v || {};
  // Не просто длина: контрольные цифры и тип (организация/ИП) — см. requisites.js.
  return String(v.sellerName || "").trim().length >= 3 &&
    /^(\d{10}|\d{12})$/.test(String(v.sellerInn || "")) &&
    /^(\d{13}|\d{15})$/.test(String(v.sellerOgrn || "")) &&
    requisitesProblem(v.sellerInn, v.sellerOgrn) === null &&
    String(v.sellerAddress || "").trim().length >= 5;
}

/**
 * Отпечаток реквизитов банка: им шлюз помечает реквизиты, которые банк
 * подтвердил при «Сохранить и проверить подключение». Поменяли реквизиты —
 * отпечаток другой, и до новой проверки гость оплатить не сможет.
 */
function credsPrint(c) {
  if (!c) return "";
  const parts = [c.provider, c.login, c.password, c.password2, c.test ? 1 : 0, c.hash];
  // Адрес API — только у «другого банка»: у остальных отпечаток прежний,
  // и уже проверенные подключения не слетают.
  if (c.url) parts.push(c.url);
  return crypto.createHash("sha256").update(parts.join("\u0001")).digest("hex");
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
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider) || !login || !password) return null;
  const password2 = String(s.onlinePayPassword2 || "").trim();
  if (provider === "robokassa" && !password2) return null;
  let url = "";
  if (provider === "rbs_custom") {
    url = rbsCustomUrl(s.onlinePayUrl) || "";
    if (!url) return null;
  }
  const hash = String(s.onlinePayHash || "md5").toLowerCase();
  return {
    provider,
    login,
    password,
    password2,
    // Флажок хранится как есть (он входит в отпечаток проверки); у банков
    // без тестового контура ни на что не влияет.
    test: s.onlinePayTest === true,
    hash: ROBOKASSA_HASHES.includes(hash) ? hash : "md5",
    ...(url ? { url } : {}),
  };
}

function rbsBase(c) {
  if (c.provider === "rbs_custom") return c.url;
  const urls = RBS_URLS[c.provider];
  return c.test ? urls.test : urls.prod;
}

/** Как банк назвать гостю и в ошибках: у «другого банка» — по домену. */
function bankName(c) {
  if (c && c.provider === "rbs_custom" && c.url) return `Банк (${new URL(c.url).hostname})`;
  return PROVIDERS[c && c.provider] || "Банк";
}

/** Время по Москве в виде 2026-10-09T15:04:05+03:00 — так его ждёт Райффайзен. */
function moscowIso(ms) {
  return `${new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 19)}+03:00`;
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

  async function rbs(c, method, params) {
    const r = await call(`${rbsBase(c)}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ userName: c.login, password: c.password, ...params }),
      publicOnly: c.provider === "rbs_custom",
    }, bankName(c));
    return parseJson(r.text);
  }

  /** СБП Райффайзенбанка: регистрация QR без ключа, статус и отмена — с секретным ключом. */
  async function raif(c, method, apiPath, body) {
    const headers = { "Content-Type": "application/json" };
    if (method !== "POST") headers.Authorization = `Bearer ${c.password}`;
    const r = await call(`${c.test ? RAIF_URLS.test : RAIF_URLS.prod}${apiPath}`, {
      method,
      headers,
      body: body == null ? null : JSON.stringify(body),
    }, "Райффайзенбанк");
    return { status: r.status, data: parseJson(r.text) };
  }

  async function raifRegister(c, { amount, orderId, description, ttlMs }) {
    const { data } = await raif(c, "POST", "/sbp/v1/qr/register", {
      amount: Number(amount.toFixed(2)),
      currency: "RUB",
      order: orderId,
      paymentDetails: description.slice(0, 140),
      qrType: "QRDynamic",
      qrExpirationDate: moscowIso(Date.now() + ttlMs),
      sbpMerchantId: c.login,
    });
    if (data.code !== "SUCCESS" || !data.qrId || !data.payload) {
      const why = data.code === "ERROR.MERCHANT_NOT_REGISTERED"
        ? `нет партнёра СБП с ID ${c.login}${c.test ? " в тестовом контуре" : ""}`
        : data.message || data.code || "запрос отклонён";
      throw new HttpError(502, `Райффайзенбанк: ${why}`);
    }
    return data;
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

  /**
   * Заводит платёж. → { docId, providerId, url } (url — ссылка СБП или
   * страница банка). ttlMs — сколько ссылка живёт: гостю в приложении
   * 15 минут, на экране кассы — 5.
   */
  async function createPayment(c, { tenantId, amount, orderId, description, ttlMs = LINK_TTL_MS }) {
    const kopecks = Math.round(amount * 100);
    switch (c.provider) {
      case "tinkoff":
      case "tinkoff_form": {
        const due = new Date(Date.now() + ttlMs);
        const init = await tbank(c, "Init", {
          Amount: kopecks,
          OrderId: orderId,
          Description: description.slice(0, 140),
          NotificationURL: `${publicUrl}/guestPayNotify?t=${encodeURIComponent(tenantId)}`,
          RedirectDueDate: due.toISOString().replace(/\.\d{3}Z$/, "+00:00"),
          ...(c.provider === "tinkoff_form" ? { SuccessURL: doneUrl, FailURL: doneUrl } : {}),
        });
        const id = String(init.PaymentId);
        if (c.provider === "tinkoff_form") {
          if (!init.PaymentURL) throw new HttpError(502, "Т-Банк не вернул ссылку на оплату");
          return { docId: id, providerId: id, url: String(init.PaymentURL) };
        }
        const qr = await tbank(c, "GetQr", { PaymentId: id, DataType: "PAYLOAD" });
        return { docId: id, providerId: id, url: String(qr.Data || "") };
      }
      case "raiffeisen": {
        const qr = await raifRegister(c, { amount, orderId, description, ttlMs });
        return { docId: null, providerId: String(qr.qrId), url: String(qr.payload) };
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
      case "alfa":
      case "vtb":
      case "mts":
      case "rbs_custom": {
        const data = await rbs(c, "register.do", {
          orderNumber: orderId,
          amount: kopecks,
          returnUrl: doneUrl,
          failUrl: doneUrl,
          description: description.slice(0, 99),
          language: "ru",
          sessionTimeoutSecs: Math.round(ttlMs / 1000) + 300,
        });
        if (!data.orderId || !data.formUrl) {
          throw new HttpError(502, `${bankName(c)}: ${data.errorMessage || "запрос отклонён"}`);
        }
        return { docId: null, providerId: String(data.orderId), url: String(data.formUrl) };
      }
    }
    throw new HttpError(409, "Банк для онлайн-оплаты не выбран");
  }

  /** Статус платежа в банке: 'paid' | 'failed' | 'pending'. */
  async function bankStatus(c, providerId) {
    switch (c.provider) {
      case "tinkoff":
      case "tinkoff_form": {
        const st = await tbank(c, "GetState", { PaymentId: providerId });
        if (st.Status === "CONFIRMED") return "paid";
        if (["REJECTED", "DEADLINE_EXPIRED", "CANCELED", "AUTH_FAIL", "REVERSED", "REFUNDED"].includes(st.Status)) return "failed";
        return "pending";
      }
      case "raiffeisen": {
        const { status, data } = await raif(c, "GET", `/sbp/v1/qr/${encodeURIComponent(providerId)}/payment-info`);
        if (status !== 200) return "pending";
        if (data.paymentStatus === "SUCCESS") return "paid";
        if (data.paymentStatus === "DECLINED") return "failed";
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
      case "alfa":
      case "vtb":
      case "mts":
      case "rbs_custom": {
        const data = await rbs(c, "getOrderStatusExtended.do", { orderId: providerId });
        const s = Number(data.orderStatus);
        if (s === 2) return "paid";
        if (s === 3 || s === 4 || s === 6) return "failed";
        return "pending";
      }
    }
    return "pending";
  }

  /**
   * Отменяет неоплаченный платёж, чтобы по закрытой ссылке уже нельзя было
   * заплатить мимо чека. Получилось ли — неважно: итог всё равно решает
   * статус в банке, а брошенный платёж досматривает фоновая проверка.
   */
  async function cancelPayment(c, providerId) {
    try {
      if (c.provider === "tinkoff" || c.provider === "tinkoff_form") {
        await tbank(c, "Cancel", { PaymentId: providerId });
      } else if (c.provider === "raiffeisen") {
        await raif(c, "DELETE", `/sbp/v2/qrs/${encodeURIComponent(providerId)}`);
      } else if (RBS.has(c.provider)) {
        await rbs(c, "decline.do", { orderId: providerId });
      }
    } catch (_) { /* уже отменён, истёк или банк не умеет — не страшно */ }
  }

  // ------------------------------------------------------------ заведение

  /**
   * Онлайн-оплата заведения: включена ли владельцем (enabled), реквизиты
   * банка (creds), подтвердил ли их банк (verified) и указан ли продавец.
   * Гость платит, только когда верно всё (ready).
   */
  async function venueSettings(tenantId) {
    const [integ, venue] = await Promise.all([
      tenantRef(tenantId).collection("settings").doc("integrations").get(),
      tenantRef(tenantId).collection("meta").doc("venueProfile").get(),
    ]);
    const v = venue.data() || {};
    const i = integ.data() || {};
    const enabled = v.guestSbpPay === true;
    const c = onlinePaySettings(i);
    const verified = !!c && i.onlinePayVerified === credsPrint(c);
    const seller = sellerReady(v);
    return { enabled, creds: c, verified, seller, ready: enabled && verified && seller };
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
    const { enabled, creds, verified, seller } = await venueSettings(tenantId);
    if (!enabled || !creds) throw new HttpError(409, "Онлайн-оплата в этом заведении не включена");
    if (!verified) throw new HttpError(409, "Заведение ещё не проверило подключение банка — оплатите на месте");
    if (!seller) throw new HttpError(409, "Заведение не указало реквизиты продавца — оплатите на месте");

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
      test: HAS_TEST.has(creds.provider) && creds.test === true,
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
    if (!creds || !["tinkoff", "tinkoff_form"].includes(creds.provider) || !body || !tokenValid(body, creds.password)) {
      throw new HttpError(403, "bad token");
    }
    if (body.Status === "CONFIRMED" && body.Success !== false) {
      const id = String(body.PaymentId);
      await markPaid(tenantId, id);
      await kassaSettle(tenantId, id, "paid");
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
    const kassa = (await tenantRef(tenantId).collection("kassaPayments")
      .where("providerId", "==", invId).limit(5).get()).docs.find((d) => d.data().provider === "robokassa");
    if (kassa) await kassaSettle(tenantId, kassa.id, "paid");
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
    const bank = bankName(c);
    const contour = c.test && HAS_TEST.has(c.provider) ? " (тестовый контур)" : "";
    switch (c.provider) {
      case "tinkoff":
      case "tinkoff_form": {
        try {
          const init = await tbank(c, "Init", { Amount: 100, OrderId: `check${Date.now().toString(36)}`, Description: "Проверка подключения" });
          await tbank(c, "Cancel", { PaymentId: String(init.PaymentId) }).catch(() => {});
          return { ok: true, message: `${bank} принял реквизиты` };
        } catch (e) {
          return { ok: false, message: e.message || `${bank} отклонил реквизиты` };
        }
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
      case "alfa":
      case "vtb":
      case "mts":
      case "rbs_custom": {
        let data;
        try {
          data = await rbs(c, "getOrderStatusExtended.do", { orderId: "00000000-0000-0000-0000-000000000000" });
        } catch (e) {
          if (c.provider !== "rbs_custom") throw e;
          return { ok: false, message: `${bank} не отвечает по этому адресу — проверьте адрес API у банка` };
        }
        if (String(data.errorCode) === "5") return { ok: false, message: `${bank}: неверный логин или пароль API${contour ? " тестового контура" : ""}` };
        // Чужой сервер ответил не как шлюз RBS — не считаем это подтверждением.
        if (c.provider === "rbs_custom" && data.errorCode === undefined && data.orderStatus === undefined) {
          return { ok: false, message: `${bank}: по этому адресу не платёжный шлюз RBS — уточните адрес API у банка` };
        }
        return { ok: true, message: `${bank} принял логин и пароль${contour}` };
      }
      case "raiffeisen": {
        // Регистрация QR проверяет ID партнёра СБП, статус — секретный ключ.
        let qr;
        try {
          qr = await raifRegister(c, { amount: 1, orderId: `check${Date.now().toString(36)}`, description: "Проверка подключения", ttlMs: 2 * 60 * 1000 });
        } catch (e) {
          return { ok: false, message: e.message || `${bank} отклонил ID партнёра СБП` };
        }
        const { status } = await raif(c, "GET", `/sbp/v1/qr/${encodeURIComponent(qr.qrId)}/payment-info`);
        await raif(c, "DELETE", `/sbp/v2/qrs/${encodeURIComponent(qr.qrId)}`).catch(() => {});
        if (status === 401 || status === 403) return { ok: false, message: `${bank}: неверный секретный ключ${contour ? " тестового контура" : ""}` };
        if (status !== 200) return { ok: false, message: `${bank} ответил кодом ${status} — попробуйте ещё раз через минуту` };
        return { ok: true, message: `${bank} принял ID партнёра СБП и секретный ключ${contour}` };
      }
    }
    return { ok: false, message: "Банк не выбран" };
  }

  async function handleCheck(req, res) {
    const decoded = await verifyAuth(req);
    const { tenantId } = await parseJsonBody(req);
    checkTenantId(tenantId);
    await requireTenantRole(tenantId, decoded.uid, ["owner", "admin", "manager", "employee"]);
    const { enabled, creds, seller } = await venueSettings(tenantId);
    const t = tenantRef(tenantId);
    const publish = (provider, print) => Promise.all([
      t.collection("settings").doc("integrations").set({ onlinePayVerified: print }, { merge: true }),
      // Гостю — только id банка: по нему приложение показывает кнопку оплаты.
      t.collection("meta").doc("venueProfile").set({ onlinePay: provider }, { merge: true }),
    ]);
    if (!creds) {
      await publish("", "");
      return sendJson(res, 200, { ok: false, enabled, sellerReady: seller, message: "Заполните реквизиты банка и сохраните" });
    }
    const r = await checkCreds(creds);
    // Кнопка оплаты у гостей — только с реквизитами, которые банк подтвердил.
    await publish(r.ok ? creds.provider : "", r.ok ? credsPrint(creds) : "");
    sendJson(res, 200, { ...r, enabled, sellerReady: seller });
  }

  // ------------------------------------------------------------ касса

  /*
   * QR на экране кассы через тот же банк, что и онлайн-оплата гостей:
   * гость у стойки сканирует код телефоном и платит (СБП или страница
   * банка). Касса работает с ним как с терминалом — итог идёт в оплату
   * счёта, поэтому в счёт (guestPaidTotal) платёж не пишется: иначе сумма
   * засчиталась бы дважды. Платежи — в kassaPayments, пишет только шлюз.
   */
  const KASSA_TTL_MS = 5 * 60 * 1000;
  // Пока окно с QR открыто, касса сама спрашивает статус; фоновая
  // проверка берётся за платёж только после этого запаса.
  const KASSA_GRACE_MS = KASSA_TTL_MS + 3 * 60 * 1000;
  const STAFF = ["owner", "admin", "manager", "employee"];
  const kassaRef = (tenantId, id) => tenantRef(tenantId).collection("kassaPayments").doc(id);

  function checkPaymentId(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, "Не указан платёж");
  }

  /** Подключённый и проверенный банк заведения — для QR на кассе. */
  async function kassaCreds(tenantId) {
    const integ = (await tenantRef(tenantId).collection("settings").doc("integrations").get()).data() || {};
    const c = onlinePaySettings(integ);
    if (!c) throw new HttpError(409, "Банк не подключён: Настройки → Интеграции → «Онлайн-оплата гостей»");
    if (integ.onlinePayVerified !== credsPrint(c)) {
      throw new HttpError(409, "Банк ещё не подтвердил реквизиты: Интеграции → «Сохранить и проверить подключение»");
    }
    return c;
  }

  /** Итог платежа на кассе — один раз; «пришло после закрытия окна» — персоналу. */
  async function kassaSettle(tenantId, id, status) {
    const ref = kassaRef(tenantId, id);
    let late = null;
    await db().runTransaction(async (tx) => {
      const p = (await tx.get(ref)).data();
      if (!p || !["pending", "cancelled"].includes(p.status)) return;
      const now = admin.firestore.Timestamp.now();
      if (status === "paid" && p.status === "cancelled") {
        tx.update(ref, { status: "paid_late", paidAt: now });
        late = { amount: p.amount, provider: p.provider, now };
        return;
      }
      if (status === "paid") tx.update(ref, { status: "paid", paidAt: now });
      else if (p.status === "pending") tx.update(ref, { status });
    });
    if (late) {
      await tenantRef(tenantId).collection("waiterCalls").add({
        tableId: "",
        tableName: "Касса",
        sessionId: "",
        clientUid: "",
        guestName: "",
        type: "paid",
        comment: `Оплата по QR на кассе пришла после закрытия окна: ${late.amount} ₽ (${PROVIDERS[late.provider] || "банк"}) — найдите гостя и пробейте чек или верните деньги в кабинете банка`,
        status: "new",
        createdAt: late.now,
      });
    }
    if (status !== "pending") await pendingCol().doc(`${tenantId}__${id}`).delete().catch(() => {});
  }

  async function handleKassaStart(req, res) {
    const decoded = await verifyAuth(req);
    const { tenantId, amount } = await parseJsonBody(req);
    checkTenantId(tenantId);
    await requireTenantRole(tenantId, decoded.uid, STAFF);
    const sum = round2(Number(amount));
    if (!Number.isFinite(sum) || sum < 1 || sum > 1000000) throw new HttpError(400, "Сумма — от 1 до 1 000 000 ₽");
    const c = await kassaCreds(tenantId);
    const orderId = `k${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
    const made = await createPayment(c, { tenantId, amount: sum, orderId, description: "Оплата на кассе", ttlMs: KASSA_TTL_MS });
    const paymentId = made.docId || `k_${orderId}`;
    const now = admin.firestore.Timestamp.now();
    await kassaRef(tenantId, paymentId).set({
      amount: sum,
      orderId,
      provider: c.provider,
      providerId: made.providerId,
      url: made.url,
      test: HAS_TEST.has(c.provider) && c.test === true,
      status: "pending",
      createdBy: decoded.uid,
      createdAt: now,
    });
    await pendingCol().doc(`${tenantId}__${paymentId}`).set({ tenantId, paymentId, kind: "kassa", createdAt: now });
    sendJson(res, 200, {
      paymentId,
      url: made.url,
      amount: sum,
      provider: c.provider,
      bank: bankName(c),
      sbp: SBP_ONLY.has(c.provider),
      test: HAS_TEST.has(c.provider) && c.test === true,
      ttlSec: KASSA_TTL_MS / 1000,
    });
  }

  /** Статус в банке для платежа на кассе. → 'paid' | 'failed' | 'pending'. */
  async function kassaResolve(tenantId, id, p) {
    const c = onlinePaySettings((await tenantRef(tenantId).collection("settings").doc("integrations").get()).data());
    if (!c || c.provider !== p.provider) return "pending";
    const st = await bankStatus(c, p.providerId);
    if (st !== "pending") await kassaSettle(tenantId, id, st);
    return st;
  }

  async function kassaLoad(req) {
    const decoded = await verifyAuth(req);
    const { tenantId, paymentId } = await parseJsonBody(req);
    checkTenantId(tenantId);
    checkPaymentId(paymentId);
    await requireTenantRole(tenantId, decoded.uid, STAFF);
    const p = (await kassaRef(tenantId, paymentId).get()).data();
    if (!p) throw new HttpError(404, "Платёж не найден");
    return { tenantId, paymentId, p };
  }

  const kassaFinal = (s) => (s === "paid" || s === "paid_late" ? "paid" : "failed");

  async function handleKassaStatus(req, res) {
    const { tenantId, paymentId, p } = await kassaLoad(req);
    if (p.status !== "pending") return sendJson(res, 200, { status: kassaFinal(p.status) });
    const st = await kassaResolve(tenantId, paymentId, p).catch(() => "pending");
    sendJson(res, 200, { status: st });
  }

  /**
   * Кассир закрыл окно с QR (или оно истекло): сперва — не успел ли гость
   * заплатить; нет — отменяем платёж в банке. Если деньги всё же придут,
   * фоновая проверка позовёт персонал.
   */
  async function handleKassaCancel(req, res) {
    const { tenantId, paymentId, p } = await kassaLoad(req);
    if (p.status !== "pending") return sendJson(res, 200, { status: kassaFinal(p.status) });
    const c = onlinePaySettings((await tenantRef(tenantId).collection("settings").doc("integrations").get()).data());
    if (c && c.provider === p.provider) {
      if (await bankStatus(c, p.providerId).catch(() => "pending") === "paid") {
        await kassaSettle(tenantId, paymentId, "paid");
        return sendJson(res, 200, { status: "paid" });
      }
      await cancelPayment(c, p.providerId);
      if (await bankStatus(c, p.providerId).catch(() => "pending") === "paid") {
        await kassaSettle(tenantId, paymentId, "paid");
        return sendJson(res, 200, { status: "paid" });
      }
    }
    await db().runTransaction(async (tx) => {
      const cur = (await tx.get(kassaRef(tenantId, paymentId))).data();
      if (cur && cur.status === "pending") tx.update(kassaRef(tenantId, paymentId), { status: "cancelled", cancelledAt: admin.firestore.Timestamp.now() });
    });
    const now = (await kassaRef(tenantId, paymentId).get()).data();
    sendJson(res, 200, { status: now && now.status === "paid" ? "paid" : "cancelled" });
  }

  /** Фоновая проверка платежа на кассе: брошенное окно, деньги пришли позже. */
  async function sweepKassa(tenantId, paymentId, createdAt) {
    const p = (await kassaRef(tenantId, paymentId).get()).data();
    if (!p || !["pending", "cancelled"].includes(p.status)) {
      await pendingCol().doc(`${tenantId}__${paymentId}`).delete().catch(() => {});
      return;
    }
    const age = Date.now() - (createdAt?.toMillis?.() || 0);
    if (p.status === "pending" && age < KASSA_GRACE_MS) return;
    // Окно уже закрыто (или касса пропала) — дальше это «отменённый» платёж.
    if (p.status === "pending") {
      await kassaRef(tenantId, paymentId).update({ status: "cancelled", cancelledAt: admin.firestore.Timestamp.now() });
      p.status = "cancelled";
    }
    const st = await kassaResolve(tenantId, paymentId, p);
    if (st === "pending" && age > PENDING_TTL_MS) {
      await kassaRef(tenantId, paymentId).update({ status: "expired" });
      await pendingCol().doc(`${tenantId}__${paymentId}`).delete().catch(() => {});
    }
  }

  // ------------------------------------------------------------ фон

  /** Раз в минуту — платежи, о которых банк ещё не сообщил (гость мог закрыть приложение). */
  async function sweep() {
    const snap = await pendingCol().limit(200).get();
    for (const d of snap.docs) {
      const { tenantId, paymentId, createdAt, kind } = d.data();
      try {
        if (kind === "kassa") {
          await sweepKassa(tenantId, paymentId, createdAt);
          continue;
        }
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
    handleKassaStart, handleKassaStatus, handleKassaCancel,
    markPaid, sweep, startSweeper, createPayment, bankStatus, cancelPayment, checkCreds,
  };
}

module.exports = {
  createGuestPay, tbankToken, tokenValid, sessionBill, amountDue, onlinePaySettings, robokassaSig, xmlCode,
  sellerReady, credsPrint, rbsCustomUrl, privateIp, moscowIso,
  PROVIDERS, RBS_URLS, RAIF_URLS, SBP_ONLY, BankUnreachable,
};
