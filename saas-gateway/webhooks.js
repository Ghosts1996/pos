"use strict";
// Вебхуки заведения: события ZalPOS уходят POST-запросом на адрес владельца —
// его CRM, сайт, 1С или сервис-связку (Albato, n8n, ApiX-Drive и т. п.).
//
// Владелец в кабинете (Настройки → «Вебхуки») добавляет адрес и выбирает
// события; секрет подписи показывается один раз. Сервер сам следит за
// данными точки и отправляет события, при сбое повторяет (1 мин, 5 мин,
// 30 мин, 2 ч, 6 ч). 20 неудачных отправок подряд — вебхук выключается,
// владельцу сигнал в бот заведения.
//
// Как и в открытом API, персональных данных гостей и сотрудников в событиях
// нет: ни имён, ни телефонов, ни адресов доставки, ни комментариев.
//
// Подпись: X-ZalPOS-Signature: t=<unix>,v1=<hex HMAC-SHA256(секрет, "<t>.<тело>")>.
// Адрес — только внешний (https; внутренние сети, localhost и адреса самого
// сервера запрещены, проверка — при каждой отправке, соединение — на
// проверенный IP).

const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const http = require("http");
const https = require("https");
const { checkOut, shiftOut } = require("./open-api");

const MAX_HOOKS = 5;
const RECENT = 20;
const MAX_FAILS = 20;
const TIMEOUT_MS = 10000;
const RETRY_MS = [60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3, 6 * 3600e3];
const LOOKBACK_MS = 36 * 3600e3;
const SECRET_RE = /^whsec_[A-Za-z0-9]{32}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

const EVENTS = {
  "order.closed": "Чек закрыт (оплата)",
  "order.refunded": "Возврат по чеку",
  "shift.closed": "Смена кассы закрыта (Z-отчёт)",
  "reservation.created": "Новая бронь",
  "reservation.updated": "Бронь изменилась (подтверждена, гости пришли, отмена)",
  "delivery.status": "Статус доставки",
  "stoplist.changed": "Стоп-лист: блюдо снято или вернулось",
  "stock.low": "Склад: остаток ниже минимума",
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const toMs = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : typeof v === "number" ? v : v instanceof Date ? v.getTime() : 0);
const iso = (v) => { const ms = toMs(v); return ms ? new Date(ms).toISOString() : null; };

function randomToken(n) {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < n) {
    for (const b of crypto.randomBytes(n * 2)) if (b < limit && out.length < n) out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

/** Подпись тела: t=<unix>,v1=<hex>. Получатель сверяет и отбрасывает старые (повтор). */
function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/** Внутренние, служебные и зарезервированные адреса — туда не отправляем. */
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  const s = ip.toLowerCase();
  if (s.startsWith("::ffff:")) return privateIp(s.slice(7));
  return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith("64:ff9b:") || s.startsWith("2001:db8");
}

/** Адрес вебхука: https, без логина в адресе, не длиннее 500. → URL или ошибка-строка. */
function checkUrl(raw, { allowHttp = false } = {}) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch (_) { return "Адрес не похож на ссылку — начните с https://"; }
  if (String(raw).length > 500) return "Слишком длинный адрес";
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) return "Нужен адрес с https:// — так данные идут зашифрованными";
  if (u.username || u.password) return "Логин и пароль в адресе не поддерживаются — используйте секрет подписи";
  if (!u.hostname || /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(u.hostname)) return "Нужен внешний адрес, а не внутренний";
  return u;
}

/** Куда реально подключаться: все адреса имени должны быть внешними. */
async function resolvePublic(host, { allowPrivate = false } = {}) {
  const h = host.replace(/^\[|\]$/g, "");
  const list = net.isIP(h) ? [{ address: h, family: net.isIP(h) }] : await dns.lookup(h, { all: true, verbatim: true });
  if (!list.length) throw new Error("адрес не найден");
  if (!allowPrivate && list.some((a) => privateIp(a.address))) throw new Error("он ведёт во внутреннюю сеть");
  return list[0];
}

/** Один POST: соединение на проверенный IP (без повторного DNS — защита от подмены). */
async function post(urlStr, body, headers, { allowPrivate = false, timeoutMs = TIMEOUT_MS } = {}) {
  const u = new URL(urlStr);
  const addr = await resolvePublic(u.hostname, { allowPrivate });
  const mod = u.protocol === "http:" ? http : https;
  const started = Date.now();
  return new Promise((resolve) => {
    const req = mod.request({
      method: "POST", hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: `${u.pathname}${u.search}`,
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "User-Agent": "ZalPOS-Webhooks/1", ...headers },
      lookup: (_h, _o, cb) => cb(null, addr.address, addr.family),
      timeout: timeoutMs,
    }, (res) => {
      let n = 0;
      res.on("data", (c) => { n += c.length; if (n > 65536) res.destroy(); });
      res.on("end", () => resolve({ status: res.statusCode, ms: Date.now() - started }));
      res.on("error", () => resolve({ status: res.statusCode, ms: Date.now() - started }));
    });
    req.on("timeout", () => req.destroy(new Error(`нет ответа за ${Math.round(timeoutMs / 1000)} с`)));
    req.on("error", (e) => resolve({ status: 0, error: e.message || String(e), ms: Date.now() - started }));
    req.end(body);
  });
}

// ---------------------------------------------------------------- события без ПДн

function reservationOut(id, d) {
  return {
    id, status: d.status || null, startAt: iso(d.startTime), durationMinutes: Number(d.durationMinutes) || null,
    guests: Number(d.guestsCount) || null, tableId: d.tableId || null, table: d.tableName ? String(d.tableName) : null,
    source: d.source ? String(d.source) : null, guestConfirmed: d.guestConfirmed === true, createdAt: iso(d.createdAt),
  };
}

function deliveryOut(id, d) {
  const items = Array.isArray(d.orderItems) ? d.orderItems : [];
  return {
    id, status: d.deliveryStatus || null, courierStage: d.courierStage || null, courierNo: Number(d.courierNo) || null,
    total: round2(items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 0), 0)),
    paidOnline: d.paidOnline === true || d.guestPayStatus === "paid", createdAt: iso(d.startTime),
  };
}

const stockOut = (id, d) => ({ id, name: String(d.name || ""), unit: d.unit || null, quantity: round2(d.quantity), minQuantity: round2(d.minQuantity) });
const lowStock = (d) => d.active !== false && Number(d.minQuantity) > 0 && Number(d.quantity) < Number(d.minQuantity);

// ---------------------------------------------------------------- модуль

function createWebhooks(deps) {
  const {
    db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, secretKey, encrypt, decrypt,
    writeAuditLog = async () => {}, ownerAlert = async () => false, now = () => Date.now(),
    allowHttp = process.env.WEBHOOKS_ALLOW_HTTP === "1", allowPrivate = process.env.WEBHOOKS_ALLOW_PRIVATE === "1",
    retryMs = process.env.WEBHOOKS_RETRY_MS ? process.env.WEBHOOKS_RETRY_MS.split(",").map(Number) : RETRY_MS,
    timeoutMs = TIMEOUT_MS,
  } = deps;
  const Timestamp = admin.firestore.Timestamp;
  const col = () => db().collection("webhooks");
  const stateCol = () => db().collection("webhookState");

  const hooks = new Map(); // id → doc
  const watchers = new Map(); // tenantId → [unsub]
  const timers = new Set();
  let stopped = false;

  const hooksOf = (tid) => [...hooks.values()].filter((h) => h.tenantId === tid && h.active !== false);

  async function deliver(hook, event, attempt = 0) {
    if (stopped) return;
    const cur = hooks.get(hook.id);
    if (!cur || cur.active === false) return;
    let secret;
    try { secret = decrypt(secretKey(), cur.secretEnc); } catch (_) { return; }
    const body = JSON.stringify(event);
    const r = await post(cur.url, body, {
      "X-ZalPOS-Event": event.type, "X-ZalPOS-Delivery": event.id, "X-ZalPOS-Signature": sign(secret, body),
    }, { allowPrivate, timeoutMs }).catch((e) => ({ status: 0, error: e.message || String(e), ms: 0 }));
    const ok = r.status >= 200 && r.status < 300;
    const rec = { at: now(), event: event.type, id: event.id, status: r.status || 0, ms: r.ms || 0, attempt: attempt + 1,
      ...(r.error ? { error: String(r.error).slice(0, 160) } : {}) };
    const fails = ok ? 0 : (Number(cur.fails) || 0) + 1;
    const recent = [rec, ...(cur.recent || [])].slice(0, RECENT);
    const patch = { recent, fails, lastAt: Timestamp.fromMillis(rec.at), lastStatus: rec.status };
    if (!ok && fails >= MAX_FAILS) {
      patch.active = false;
      patch.disabledReason = `${MAX_FAILS} неудачных отправок подряд`;
      patch.disabledAt = Timestamp.fromMillis(now());
    }
    Object.assign(cur, patch);
    await col().doc(hook.id).set(patch, { merge: true }).catch(() => {});
    if (patch.active === false) {
      await ownerAlert(cur.tenantId, `⚠️ Вебхук ${new URL(cur.url).hostname} выключен: ${MAX_FAILS} неудачных отправок подряд (последний ответ: ${rec.status || rec.error || "нет связи"}). Проверьте адрес и включите его снова в Кабинет · «Настройки» → «Вебхуки».`).catch(() => {});
      return;
    }
    if (!ok && event.type !== "ping" && attempt < retryMs.length) {
      const t = setTimeout(() => { timers.delete(t); deliver(hook, event, attempt + 1); }, retryMs[attempt]);
      if (t.unref) t.unref();
      timers.add(t);
    }
    return rec;
  }

  async function emit(tid, type, data, at = now()) {
    const list = hooksOf(tid).filter((h) => (h.events || []).includes(type));
    if (!list.length) return 0;
    const event = { id: `evt_${randomToken(20)}`, type, createdAt: new Date(at).toISOString(), venueId: tid, data };
    await Promise.all(list.map((h) => deliver(h, event)));
    return list.length;
  }

  // ---- слежение за данными точки (только у точек с вебхуками)

  async function cursorOf(tid) {
    const d = (await stateCol().doc(tid).get().catch(() => null))?.data?.() || {};
    return { orders: Number(d.orders) || now(), shifts: Number(d.shifts) || now() };
  }
  const saveCursor = (tid, patch) => stateCol().doc(tid).set(patch, { merge: true }).catch(() => {});

  async function watchTenant(tid) {
    if (watchers.has(tid)) return;
    const unsubs = [];
    watchers.set(tid, unsubs);
    const t = db().collection("tenants").doc(tid);
    const cur = await cursorOf(tid);
    const since = Timestamp.fromMillis(now() - LOOKBACK_MS);
    const sent = new Set();
    const onErr = (what) => (e) => console.error(`webhooks ${what} (${tid}):`, e.message || e);

    // Чеки: закрыт / возврат. Курсор — время события: после перезапуска не повторяем.
    unsubs.push(t.collection("sessions").where("closedAt", ">=", since).onSnapshot((snap) => {
      let maxAt = cur.orders;
      for (const ch of snap.docChanges()) {
        if (ch.type === "removed") continue;
        const d = ch.doc.data() || {};
        if (d.training === true) continue;
        const closedAt = toMs(d.closedAt);
        if (closedAt > cur.orders && !sent.has(`c:${ch.doc.id}`)) {
          sent.add(`c:${ch.doc.id}`);
          maxAt = Math.max(maxAt, closedAt);
          emit(tid, "order.closed", checkOut(ch.doc.id, d), closedAt);
        }
        const refAt = toMs(d.refundedAt);
        if (d.refunded === true && refAt > cur.orders && !sent.has(`r:${ch.doc.id}`)) {
          sent.add(`r:${ch.doc.id}`);
          maxAt = Math.max(maxAt, refAt);
          emit(tid, "order.refunded", checkOut(ch.doc.id, d), refAt);
        }
      }
      if (maxAt > cur.orders) { cur.orders = maxAt; saveCursor(tid, { orders: maxAt }); }
    }, onErr("sessions")));

    unsubs.push(t.collection("shifts").where("closedAt", ">=", since).onSnapshot((snap) => {
      let maxAt = cur.shifts;
      for (const ch of snap.docChanges()) {
        if (ch.type === "removed") continue;
        const d = ch.doc.data() || {};
        const at = toMs(d.closedAt);
        if (d.status === "closed" && at > cur.shifts && !sent.has(`s:${ch.doc.id}`)) {
          sent.add(`s:${ch.doc.id}`);
          maxAt = Math.max(maxAt, at);
          emit(tid, "shift.closed", shiftOut(ch.doc.id, d), at);
        }
      }
      if (maxAt > cur.shifts) { cur.shifts = maxAt; saveCursor(tid, { shifts: maxAt }); }
    }, onErr("shifts")));

    // Остальное — изменения после подключения (первый снимок только запоминаем).
    const watchChanges = (query, keyOf, onChange, what) => {
      let primed = false;
      const last = new Map();
      unsubs.push(query.onSnapshot((snap) => {
        for (const ch of snap.docChanges()) {
          if (ch.type === "removed") { last.delete(ch.doc.id); continue; }
          const d = ch.doc.data() || {};
          const k = keyOf(d);
          const was = last.get(ch.doc.id);
          last.set(ch.doc.id, k);
          if (primed && was !== k) onChange(ch.doc.id, d, was, ch.type);
        }
        primed = true;
      }, onErr(what)));
    };
    watchChanges(t.collection("reservations").where("startTime", ">=", Timestamp.fromMillis(now() - 12 * 3600e3)),
      (d) => `${d.status}|${toMs(d.startTime)}|${d.guestsCount}|${d.tableId}`,
      (id, d, was) => emit(tid, was === undefined ? "reservation.created" : "reservation.updated", reservationOut(id, d)), "reservations");
    watchChanges(t.collection("sessions").where("orderType", "==", "delivery"),
      (d) => `${d.deliveryStatus}|${d.courierStage || ""}`,
      (id, d, was) => { if (was !== undefined || d.deliveryStatus) emit(tid, "delivery.status", deliveryOut(id, d)); }, "delivery");
    watchChanges(t.collection("menuItems"), (d) => String(d.available !== false),
      (id, d, was) => { if (was !== undefined) emit(tid, "stoplist.changed", { id, name: String(d.name || ""), available: d.available !== false }); }, "menu");
    watchChanges(t.collection("inventoryItems"), (d) => String(lowStock(d)),
      (id, d, was) => { if (lowStock(d) && was !== undefined) emit(tid, "stock.low", stockOut(id, d)); }, "stock");
  }

  function unwatchTenant(tid) {
    for (const u of watchers.get(tid) || []) { try { u(); } catch (_) {} }
    watchers.delete(tid);
  }

  function syncWatchers() {
    const need = new Set([...hooks.values()].filter((h) => h.active !== false).map((h) => h.tenantId));
    for (const tid of need) watchTenant(tid).catch((e) => console.error(`webhooks watch ${tid}:`, e.message || e));
    for (const tid of [...watchers.keys()]) if (!need.has(tid)) unwatchTenant(tid);
  }

  let unsubHooks = null;
  function start() {
    stopped = false;
    unsubHooks = col().onSnapshot((snap) => {
      for (const ch of snap.docChanges()) {
        if (ch.type === "removed") hooks.delete(ch.doc.id);
        else hooks.set(ch.doc.id, { ...(hooks.get(ch.doc.id) || {}), ...ch.doc.data(), id: ch.doc.id });
      }
      syncWatchers();
    }, (e) => console.error("webhooks:", e.message || e));
  }
  function stop() {
    stopped = true;
    if (unsubHooks) unsubHooks();
    for (const tid of [...watchers.keys()]) unwatchTenant(tid);
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  // ---- кабинет: Настройки → «Вебхуки» (только владелец)

  const hookOut = (id, d) => ({
    id, url: d.url, events: d.events || [], active: d.active !== false, preview: d.preview || "",
    createdAt: iso(d.createdAt), lastAt: iso(d.lastAt), lastStatus: d.lastStatus ?? null, fails: Number(d.fails) || 0,
    disabledReason: d.active === false ? d.disabledReason || null : null,
    recent: (d.recent || []).slice(0, 10).map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
  });

  async function own(tenantId, hookId) {
    const snap = await col().doc(String(hookId || "")).get();
    if (!snap.exists || snap.data().tenantId !== tenantId) throw new HttpError(404, "Вебхук не найден");
    return snap;
  }

  async function handle(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new HttpError(400, "Не указано заведение");
    await requireTenantRole(tenantId, decoded.uid, ["owner"]);
    const action = String(body.action || "list");
    const list = async () => (await col().where("tenantId", "==", tenantId).get()).docs
      .map((d) => hookOut(d.id, d.data())).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    if (action === "list") return sendJson(res, 200, { hooks: await list(), events: EVENTS, max: MAX_HOOKS });

    if (action === "create") {
      const u = checkUrl(body.url, { allowHttp });
      if (typeof u === "string") throw new HttpError(400, u);
      const events = [...new Set((Array.isArray(body.events) ? body.events : []).map(String))].filter((e) => EVENTS[e]);
      if (!events.length) throw new HttpError(400, "Отметьте хотя бы одно событие");
      const existing = await list();
      if (existing.length >= MAX_HOOKS) throw new HttpError(409, `Не больше ${MAX_HOOKS} вебхуков — удалите ненужный`);
      if (existing.some((h) => h.url === u.toString())) throw new HttpError(409, "Такой адрес уже добавлен");
      try { await resolvePublic(u.hostname, { allowPrivate }); } catch (e) { throw new HttpError(400, `Адрес не подходит: ${e.message}`); }
      const secret = `whsec_${randomToken(32)}`;
      const ref = col().doc();
      await ref.set({
        tenantId, url: u.toString(), events, secretEnc: encrypt(secretKey(), secret), preview: `${secret.slice(0, 10)}…`,
        active: true, fails: 0, recent: [], createdAt: Timestamp.fromMillis(now()), createdBy: decoded.uid,
      });
      await writeAuditLog({ tenantId, actorId: decoded.uid, action: "webhookCreated", metadata: { hookId: ref.id, host: u.hostname, events } }).catch(() => {});
      return sendJson(res, 200, { id: ref.id, secret, hooks: await list() });
    }

    const snap = await own(tenantId, body.hookId);
    if (action === "delete") {
      await snap.ref.delete();
      hooks.delete(snap.id);
      syncWatchers();
      await writeAuditLog({ tenantId, actorId: decoded.uid, action: "webhookDeleted", metadata: { hookId: snap.id } }).catch(() => {});
      return sendJson(res, 200, { ok: true, hooks: await list() });
    }
    if (action === "update") {
      const patch = {};
      if (typeof body.active === "boolean") Object.assign(patch, { active: body.active, ...(body.active ? { fails: 0, disabledReason: null } : {}) });
      if (Array.isArray(body.events)) {
        const events = [...new Set(body.events.map(String))].filter((e) => EVENTS[e]);
        if (!events.length) throw new HttpError(400, "Отметьте хотя бы одно событие");
        patch.events = events;
      }
      await snap.ref.set(patch, { merge: true });
      hooks.set(snap.id, { ...(hooks.get(snap.id) || snap.data()), ...patch, id: snap.id });
      syncWatchers();
      return sendJson(res, 200, { ok: true, hooks: await list() });
    }
    if (action === "test") {
      hooks.set(snap.id, { ...snap.data(), ...(hooks.get(snap.id) || {}), id: snap.id, active: true });
      const rec = await deliver({ id: snap.id }, {
        id: `evt_${randomToken(20)}`, type: "ping", createdAt: new Date(now()).toISOString(), venueId: tenantId,
        data: { message: "Проверка вебхука ZalPOS" },
      });
      if (snap.data().active === false) hooks.set(snap.id, { ...hooks.get(snap.id), active: false });
      return sendJson(res, 200, { result: rec || null, hooks: await list() });
    }
    throw new HttpError(400, "Неизвестное действие");
  }

  return { handle, start, stop, emit, deliver, EVENTS, _hooks: hooks, _watchers: watchers };
}

module.exports = { createWebhooks, sign, checkUrl, privateIp, resolvePublic, reservationOut, deliveryOut, EVENTS, SECRET_RE, MAX_HOOKS };
