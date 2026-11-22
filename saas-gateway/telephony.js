"use strict";
// Телефония для доставки: АТС заведения сообщает о входящем звонке, касса
// сразу показывает «Звонит +7 900 …» — постоянный ли это гость, сколько у
// него визитов и бонусов — и одной кнопкой открывает заказ доставки или
// с собой с уже вписанным номером.
//
// Владелец в кабинете (Настройки → «Телефония») получает адрес
// https://pii.zalpos.ru/saas/tel/<ключ> и вписывает его в своей АТС:
//  • «Манго Офис» — «API-коннектор» → «Адрес внешней системы» (Манго шлёт
//    события на <адрес>/events/call; подпись sha256(ключ + json + соль)
//    проверяется, если владелец вписал соль);
//  • «Новофон», «Телфин», «Сипуни», UIS, «Билайн», «МТС Exolve», Asterisk и
//    любая АТС, которая умеет «вызвать адрес при входящем звонке» (GET или
//    POST, номер звонящего — в phone / from / caller / caller_id / numa …).
//
// Номер звонящего — персональные данные: он уходит в справочник в РФ
// (pii-gateway, вид записи «call»), в базе — только отметка звонка и
// последние 4 цифры. Звонки старше 2 суток удаляются (и из справочника).
// Ничего о звонке не уходит в мессенджер.

const crypto = require("crypto");

const KEY_RE = /^[A-Za-z0-9]{24}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const PER_MINUTE = 60;
const SAME_CALL_MS = 90 * 1000;
const KEEP_MS = 2 * 24 * 3600 * 1000;
const PHONE_KEYS = ["phone", "from", "caller", "caller_id", "callerid", "callerIdNum", "CallerIDNum", "calleridnum", "numa", "src", "src_num",
  "from_number", "fromNumber", "client_phone", "clientPhone", "number", "ani", "msisdn", "contact_phone_number"];
const EVENT_KEYS = ["event", "state", "call_state", "callState", "type", "status", "direction", "event_type", "eventType", "cmd"];

function randomKey(n = 24) {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < n) for (const b of crypto.randomBytes(n * 2)) if (b < limit && out.length < n) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Российский номер → 7XXXXXXXXXX; иначе — цифры как есть (≥ 5) или "". */
function normalizePhone(raw) {
  let d = String(raw == null ? "" : typeof raw === "object" ? raw.number || "" : raw).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("8")) d = `7${d.slice(1)}`;
  if (d.length === 10 && d.startsWith("9")) d = `7${d}`;
  return d.length >= 5 && d.length <= 15 ? d : "";
}

/** +7 900 123-45-67 */
function prettyPhone(d) {
  return /^7\d{10}$/.test(d) ? `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : (d ? `+${d}` : "");
}

/** Тело запроса АТС: JSON, форма или ничего. */
function parseBody(raw, type) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
  if (!text.trim()) return {};
  if (/json/i.test(type || "") || /^\s*[{[]/.test(text)) {
    try {
      const j = JSON.parse(text);
      return j && typeof j === "object" && !Array.isArray(j) ? j : {};
    } catch (_) { /* не JSON — разберём как форму */ }
  }
  const out = {};
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}

/**
 * Разбор события АТС. → { incoming: true, phone, callId, line, provider }
 * или { incoming: false, reason }. Чистая функция (тест — test.telephony.js).
 */
function parseCallEvent({ query = {}, body = {}, path = "", salt = "" }) {
  // «Манго Офис»: form-поля vpbx_api_key, sign, json.
  if (body.vpbx_api_key && typeof body.json === "string") {
    if (salt) {
      const want = crypto.createHash("sha256").update(`${body.vpbx_api_key}${body.json}${salt}`).digest("hex");
      if (String(body.sign || "").toLowerCase() !== want) return { incoming: false, reason: "подпись Манго не сошлась", bad: true };
    }
    let j;
    try { j = JSON.parse(body.json); } catch (_) { return { incoming: false, reason: "json Манго не разобрался" }; }
    if (path && !/events\/call/.test(path)) return { incoming: false, reason: "не событие звонка" };
    const from = j.from || {};
    if (j.call_state !== "Appeared") return { incoming: false, reason: "не начало звонка" };
    if (from.extension) return { incoming: false, reason: "исходящий звонок" };
    const phone = normalizePhone(from.number);
    if (!phone || phone.length < 10) return { incoming: false, reason: "нет номера звонящего" };
    return { incoming: true, phone, callId: String(j.entry_id || j.call_id || ""), line: normalizePhone((j.to || {}).line_number || (j.to || {}).number), provider: "mango" };
  }
  const all = { ...query, ...body };
  // Общий случай: любая АТС с «вызовом адреса». Событие, если оно есть, —
  // только начало входящего; завершение, ответ и исходящие пропускаем.
  for (const k of EVENT_KEYS) {
    if (all[k] == null || typeof all[k] === "object") continue;
    const v = String(all[k]).toLowerCase();
    if (/out|end|hang|finish|disconnect|answer|complete|missed|record|summary|cancel/.test(v)) return { incoming: false, reason: `событие ${v}` };
  }
  let phone = "";
  for (const k of PHONE_KEYS) {
    if (all[k] == null) continue;
    phone = normalizePhone(all[k]);
    if (phone) break;
  }
  if (!phone) return { incoming: false, reason: "нет номера звонящего" };
  const callId = String(all.call_id || all.callId || all.pbx_call_id || all.entry_id || all.uniqueid || all.session_id || all.id || "").slice(0, 80);
  const line = normalizePhone(all.to || all.called || all.called_did || all.did || all.numb || all.line || "");
  return { incoming: true, phone, callId, line, provider: String(all.provider || "").slice(0, 20) || "pbx" };
}

function createTelephony(deps) {
  const { db, admin, verifyAuth, parseJsonBody, readBody, sendJson, HttpError, requireTenantRole, pii, encrypt, decrypt,
    now = () => Date.now(), publicUrl = (process.env.SAAS_GATEWAY_PUBLIC_URL || "https://pii.zalpos.ru/saas").replace(/\/+$/, "") } = deps;
  const Timestamp = admin.firestore.Timestamp;
  const keys = () => db().collection("telephonyKeys");
  const tenant = (tid) => db().collection("tenants").doc(tid);
  const settingsRef = (tid) => tenant(tid).collection("settings").doc("telephony");
  const hits = new Map();
  const recent = new Map(); // tid:phone → ms

  async function current(tid) {
    const d = (await settingsRef(tid).get()).data() || {};
    return { key: KEY_RE.test(d.key || "") ? d.key : "", enabled: d.enabled !== false, hasSalt: !!d.mangoSalt, saltEnc: d.mangoSalt || "" };
  }

  /** Кабинет: get | rotate | settings { enabled, mangoSalt } | test. */
  async function handleLink(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const tid = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new HttpError(400, "Не указано заведение");
    await requireTenantRole(tid, decoded.uid, ["owner", "admin"]);
    const action = String(body.action || "get");
    if (!["get", "rotate", "settings", "test"].includes(action)) throw new HttpError(400, "Неизвестное действие");
    let cur = await current(tid);
    if (action === "rotate" || !cur.key) {
      const key = randomKey();
      await keys().doc(key).set({ tenantId: tid, createdAt: Timestamp.fromMillis(now()), createdBy: decoded.uid });
      if (cur.key) await keys().doc(cur.key).delete().catch(() => {});
      await settingsRef(tid).set({ key }, { merge: true });
      cur = { ...cur, key };
    }
    if (action === "settings") {
      const patch = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.mangoSalt === "string") {
        const s = body.mangoSalt.trim();
        if (s.length > 200) throw new HttpError(400, "Слишком длинная соль");
        patch.mangoSalt = s ? encrypt(s) : admin.firestore.FieldValue.delete();
      }
      await settingsRef(tid).set(patch, { merge: true });
      cur = await current(tid);
    }
    if (action === "test") {
      await recordCall(tid, { incoming: true, phone: "79000000000", callId: `test-${now()}`, line: "", provider: "test" }, { test: true });
    }
    sendJson(res, 200, {
      url: `${publicUrl}/tel/${cur.key}`,
      enabled: cur.enabled,
      hasSalt: cur.hasSalt,
    });
  }

  async function venueByKey(key) {
    if (!KEY_RE.test(key)) return null;
    const k = await keys().doc(key).get();
    if (!k.exists) return null;
    const tid = k.data().tenantId;
    const [t, cfg] = await Promise.all([tenant(tid).get(), current(tid)]);
    if (!t.exists || cfg.key !== key || ["deleted", "suspended", "past_due"].includes((t.data() || {}).status)) return null;
    return { tid, t: t.data() || {}, cfg };
  }

  /** Постоянный гость по номеру: визиты, бонусы, последний визит. */
  async function guestOf(tid, t, phone) {
    const root = t.chainId ? db().collection("chains").doc(t.chainId) : tenant(tid);
    let uid = "";
    try {
      const idx = await root.collection("phoneIndex").doc(phone).get();
      if (idx.exists) uid = String(idx.data().uid || "");
    } catch (_) { /* нет индекса — спросим справочник */ }
    if (!uid && pii && pii.enabled()) {
      try {
        const store = t.chainId ? `chain:${t.chainId}` : tid;
        const r = await pii.call({ kind: "guest_find_phone", phone });
        const m = (r.matches || []).find((x) => String(x.store || "") === store);
        if (m && /^[A-Za-z0-9_-]{1,128}$/.test(String(m.uid || ""))) uid = String(m.uid);
      } catch (_) { /* справочник недоступен — звонок всё равно покажем */ }
    }
    if (!uid) return null;
    const c = (await root.collection("clients").doc(uid).get()).data();
    if (!c || c.anonymized === true) return null;
    const ms = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : 0);
    return {
      uid,
      visits: Number(c.visits) || 0,
      bonus: Math.round(Number(c.bonusBalance) || 0),
      totalSpent: Math.round(Number(c.totalSpent) || 0),
      ...(ms(c.lastVisitAt) ? { lastVisitAt: c.lastVisitAt } : {}),
      ...(c.tierName ? { tier: String(c.tierName).slice(0, 40) } : {}),
    };
  }

  async function recordCall(tid, ev, { test = false } = {}) {
    const t = (await tenant(tid).get()).data() || {};
    const col = tenant(tid).collection("incomingCalls");
    const id = col.doc().id;
    const rf = pii && pii.enabled();
    const guest = test ? null : await guestOf(tid, t, ev.phone).catch(() => null);
    if (rf) {
      await pii.put(tid, [{ k: "call", id, fields: { phone: ev.phone } }]);
    }
    await col.doc(id).set({
      at: Timestamp.fromMillis(now()),
      status: "ringing",
      provider: ev.provider || "pbx",
      tail: ev.phone.slice(-4),
      ...(rf ? {} : { phone: ev.phone }),
      ...(ev.line ? { line: ev.line.slice(-4) } : {}),
      ...(ev.callId ? { callId: ev.callId } : {}),
      ...(guest ? { guest } : {}),
      ...(test ? { test: true } : {}),
    });
    cleanup(tid).catch(() => {});
    return id;
  }

  /** Звонки старше 2 суток — из базы и из справочника. */
  async function cleanup(tid) {
    const cut = Timestamp.fromMillis(now() - KEEP_MS);
    const old = await tenant(tid).collection("incomingCalls").where("at", "<", cut).limit(100).get();
    for (const d of old.docs) {
      if (pii && pii.enabled()) await pii.erase(tid, "call", d.id).catch(() => {});
      await d.ref.delete();
    }
  }

  /** Адрес для АТС: GET/POST /tel/<ключ>[/что-угодно]. */
  async function handleHook(req, res, rest) {
    const parts = String(rest || "").split("/").filter(Boolean);
    const key = parts[0] || "";
    const sub = parts.slice(1).join("/");
    const url = new URL(`http://x${req.url}`);
    const query = Object.fromEntries(url.searchParams);
    const ok = (text = "ok") => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(text);
    };
    // «Новофон»/Zadarma проверяют адрес: вернуть zd_echo как есть.
    if (typeof query.zd_echo === "string") return ok(query.zd_echo.slice(0, 64));
    const venue = await venueByKey(key);
    if (!venue) throw new HttpError(404, "Адрес не найден");
    const minute = Math.floor(now() / 60000);
    const h = hits.get(key);
    const n = h && h.minute === minute ? h.n + 1 : 1;
    hits.set(key, { minute, n });
    if (hits.size > 5000) hits.clear();
    if (n > PER_MINUTE) throw new HttpError(429, "Слишком много событий");
    const body = req.method === "POST" ? parseBody(await readBody(req, 65536), req.headers["content-type"]) : {};
    if (!venue.cfg.enabled) return ok();
    const salt = venue.cfg.saltEnc ? (() => { try { return decrypt(venue.cfg.saltEnc); } catch (_) { return ""; } })() : "";
    const ev = parseCallEvent({ query, body, path: sub, salt });
    if (ev.bad) throw new HttpError(403, ev.reason);
    if (!ev.incoming) return ok();
    // Один звонок — одна карточка: АТС шлёт несколько событий, иногда
    // на разные номера сотрудников.
    const rk = `${venue.tid}:${ev.phone}`;
    const last = recent.get(rk) || 0;
    if (now() - last < SAME_CALL_MS) return ok();
    recent.set(rk, now());
    if (recent.size > 5000) recent.clear();
    await recordCall(venue.tid, ev);
    return ok();
  }

  return { handleLink, handleHook, recordCall, cleanup };
}

module.exports = { createTelephony, parseCallEvent, normalizePhone, prettyPhone, parseBody };
