"use strict";

/**
 * Реквизиты продавца (ИНН, ОГРН/ОГРНИП) — гость видит их перед заказом и
 * оплатой (закон «О защите прав потребителей»), поэтому выдуманные цифры
 * не пропускаем:
 *  1) контрольные цифры — случайный номер почти никогда их не проходит;
 *  2) тип — у организации ИНН из 10 цифр и ОГРН из 13 (начинается с 1
 *     или 5), у ИП — 12 и 15 (начинается с 3);
 *  3) сверка с ЕГРЮЛ/ЕГРИП на egrul.nalog.ru (сервис ФНС): такой ИНН есть,
 *     ОГРН совпадает, деятельность не прекращена. ФНС не ответила —
 *     не мешаем, хватает пунктов 1–2.
 * Те же правила — lib/utils/ru_requisites.dart.
 */

const digits = (v) => String(v == null ? "" : v).replace(/\D/g, "");

function checksum(d, weights) {
  let s = 0;
  for (let i = 0; i < weights.length; i++) s += Number(d[i]) * weights[i];
  return (s % 11) % 10;
}

function innValid(value) {
  const d = digits(value);
  if (d.length === 10) {
    return checksum(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[9]);
  }
  if (d.length === 12) {
    return checksum(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[10]) &&
      checksum(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[11]);
  }
  return false;
}

/** Остаток большого числа (до 14 цифр — в пределах точности Number нет, считаем столбиком). */
function mod(d, m) {
  let r = 0;
  for (const c of d) r = (r * 10 + Number(c)) % m;
  return r;
}

function ogrnValid(value) {
  const d = digits(value);
  if (d.length === 13) return (d[0] === "1" || d[0] === "5") && mod(d.slice(0, 12), 11) % 10 === Number(d[12]);
  if (d.length === 15) return d[0] === "3" && mod(d.slice(0, 14), 13) % 10 === Number(d[14]);
  return false;
}

/** Что не так с парой ИНН/ОГРН, по-человечески; null — всё сходится. */
function requisitesProblem(inn, ogrn) {
  const i = digits(inn);
  const o = digits(ogrn);
  if (i.length !== 10 && i.length !== 12) return "ИНН — 10 цифр у организации или 12 у ИП";
  if (!innValid(i)) return "ИНН с ошибкой: не сходится контрольная цифра — проверьте по выписке";
  if (o.length !== 13 && o.length !== 15) return "ОГРН — 13 цифр у организации, ОГРНИП — 15 у ИП";
  if (!ogrnValid(o)) return "ОГРН с ошибкой: не сходится контрольная цифра — проверьте по выписке";
  if (i.length === 10 && o.length !== 13) return "ИНН организации, а номер — ОГРНИП: у организации ОГРН из 13 цифр";
  if (i.length === 12 && o.length !== 15) return "ИНН индивидуального предпринимателя: нужен ОГРНИП из 15 цифр";
  return null;
}

const UA = "Mozilla/5.0 (compatible; ZalPOS requisites check)";

/**
 * Поиск по ИНН на egrul.nalog.ru: POST с запросом даёт токен, по нему
 * GET отдаёт строки выписки. null — сервис не ответил как обычно
 * (капча, сбой, сеть): тогда о реквизитах ничего не утверждаем.
 */
async function egrulLookup(inn, fetchImpl = fetch) {
  const opts = (extra) => ({ ...extra, signal: AbortSignal.timeout(8000) });
  let token;
  try {
    const r = await fetchImpl("https://egrul.nalog.ru/", opts({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: new URLSearchParams({ vyp3CaptchaToken: "", page: "", query: inn, region: "", PreventChromeAutocomplete: "" }).toString(),
    }));
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || j.captchaRequired || typeof j.t !== "string" || !j.t) return null;
    token = j.t;
  } catch (_) {
    return null;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetchImpl(`https://egrul.nalog.ru/search-result/${encodeURIComponent(token)}?r=${Date.now()}`, opts({
        headers: { "User-Agent": UA },
      }));
      if (!r.ok) return null;
      const j = await r.json();
      if (j && Array.isArray(j.rows)) return j.rows;
      if (!j || j.status !== "wait") return null;
    } catch (_) {
      return null;
    }
    await new Promise((res) => setTimeout(res, 600));
  }
  return null;
}

/**
 * Итог проверки: ok — найдено и сходится; problem — точно не так
 * (сообщение для владельца); unavailable — ФНС не ответила, проверили
 * только контрольные цифры.
 */
async function checkSeller({ inn, ogrn }, fetchImpl = fetch) {
  const i = digits(inn);
  const o = digits(ogrn);
  const local = requisitesProblem(i, o);
  if (local) return { status: "problem", message: local };
  const rows = await egrulLookup(i, fetchImpl);
  if (rows === null) {
    return { status: "unavailable", message: "Контрольные цифры верные. Сервис ФНС сейчас не ответил — сверим с ЕГРЮЛ в следующий раз." };
  }
  if (rows.length === 0) {
    return { status: "problem", message: `В ЕГРЮЛ и ЕГРИП нет записи с ИНН ${i} — проверьте номер` };
  }
  const row = rows.find((r) => digits(r && r.i) === i);
  // Ответ пришёл, но не в том виде, что мы ждём (поменяли формат) —
  // ничего не утверждаем, чтобы не отказать настоящему продавцу.
  if (!row) return { status: "unavailable", message: "Контрольные цифры верные. Ответ ФНС не удалось разобрать." };
  const name = String(row.c || row.n || "").trim();
  const foundOgrn = digits(row.o);
  if (foundOgrn && foundOgrn !== o) {
    return { status: "problem", name, ogrn: foundOgrn, message: `У ИНН ${i} в реестре другой ${foundOgrn.length === 15 ? "ОГРНИП" : "ОГРН"}: ${foundOgrn}` };
  }
  if (row.e) {
    return { status: "problem", name, message: `${name || "Продавец"}: деятельность прекращена ${row.e} — укажите действующие реквизиты` };
  }
  return { status: "ok", name, fullName: String(row.n || "").trim(), message: `Найдено в реестре ФНС: ${name}` };
}

/** /checkSeller — касса проверяет реквизиты перед сохранением профиля. */
function createHandler({ verifyAuth, parseJsonBody, requireTenantRole, sendJson, HttpError, fetchImpl }) {
  const hits = new Map(); // uid -> [ms]
  const checkTenantId = (id) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, "Некорректный tenantId");
  };
  return async function handleCheckSeller(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    checkTenantId(body.tenantId);
    await requireTenantRole(body.tenantId, decoded.uid, ["owner", "admin"]);
    const now = Date.now();
    const list = (hits.get(decoded.uid) || []).filter((t) => now - t < 3600000);
    list.push(now);
    hits.set(decoded.uid, list);
    if (hits.size > 5000) hits.clear();
    if (list.length > 30) throw new HttpError(429, "Слишком много проверок — попробуйте через час");
    sendJson(res, 200, await checkSeller({ inn: body.inn, ogrn: body.ogrn }, fetchImpl || fetch));
  };
}

module.exports = { innValid, ogrnValid, requisitesProblem, egrulLookup, checkSeller, createHandler };
