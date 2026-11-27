"use strict";
/**
 * ИИ-разборы в фоне (касса · Админ · «ИИ-разборы»). Касса собирает данные
 * за период (продажи, склад, отзывы — как раньше) и отдаёт задание сюда;
 * сервер сам спрашивает ИИ заведения (с повторами, если провайдер занят) и
 * кладёт результат в tenants/{t}/aiReports/{id}. Кассу можно закрыть —
 * вернувшись, человек видит готовый разбор.
 *
 * POST /aiReport {tenantId, action}
 *   start {kind, title, period:{from,to}, system:[строки], user, heavy, aliases}
 *         → {id}; документ: status running → done (text) | failed (error)
 *
 * Имена сотрудников в ИИ не уходят: касса заменяет их номерами
 * («Сотрудник №1»), а соответствие (aliases) хранит в документе разбора —
 * имена подставляются уже на кассе. Всё, что уходит провайдеру, вычищается
 * от телефонов и почт (venueAiComplete → pii-scrub).
 */

const KINDS = new Set(["sales", "restock", "reviews", "marketing", "hostess", "menu", "shift"]);
const MAX_SYSTEM = 120000; // символов данных на один разбор
const PER_HOUR = 30; // разборов в час на заведение
const STALE_MS = 15 * 60 * 1000; // «готовится» дольше — сервер перезапускался

function createAiReports(deps) {
  const { db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, aiVendor, aiComplete, now = () => Date.now() } = deps;
  const hits = new Map(); // tenantId → [ms]
  const running = new Set(); // id разборов, которые сейчас считаются в этом процессе

  const col = (tenantId) => db().collection("tenants").doc(tenantId).collection("aiReports");
  const ts = (ms) => admin.firestore.Timestamp.fromMillis(ms);

  function limited(tenantId) {
    const t = now();
    const list = (hits.get(tenantId) || []).filter((x) => t - x < 3600000);
    list.push(t);
    hits.set(tenantId, list);
    return list.length > PER_HOUR;
  }

  const clean = (v, max) => String(v == null ? "" : v).slice(0, max);

  async function start(tenantId, uid, body) {
    const kind = String(body.kind || "");
    if (!KINDS.has(kind)) throw new HttpError(400, "Неизвестный разбор");
    const system = (Array.isArray(body.system) ? body.system : [body.system]).map((s) => clean(s, MAX_SYSTEM)).filter(Boolean);
    const user = clean(body.user, 4000);
    if (!user || !system.length) throw new HttpError(400, "Нет данных для разбора");
    if (system.join("\n").length > MAX_SYSTEM) throw new HttpError(413, "Слишком много данных — выберите период короче");
    if (limited(tenantId)) throw new HttpError(429, "Слишком много разборов за час — попробуйте позже");
    const vendor = await aiVendor(tenantId);
    if (!vendor) throw new HttpError(412, "ИИ не подключён — откройте «Настройки ИИ» и вставьте ключ");
    const aliases = {};
    if (body.aliases && typeof body.aliases === "object") {
      for (const [k, v] of Object.entries(body.aliases).slice(0, 300)) {
        if (/^Сотрудник №\d{1,4}$/.test(k)) aliases[k] = clean(v, 80);
      }
    }
    const period = body.period && typeof body.period === "object"
      ? { from: clean(body.period.from, 30), to: clean(body.period.to, 30) } : null;
    const ref = col(tenantId).doc();
    await ref.set({
      kind,
      title: clean(body.title, 80) || kind,
      period,
      status: "running",
      createdAt: ts(now()),
      by: uid,
      aliases,
    });
    running.add(ref.id);
    // Считаем после ответа: касса может закрыться — разбор доделается здесь.
    setImmediate(() => finish(ref, vendor, system, user, body.heavy === true).catch(() => {}));
    return { id: ref.id };
  }

  async function finish(ref, vendor, system, user, heavy) {
    try {
      const text = await aiComplete(vendor, { system: system.join("\n\n"), content: user, heavy, maxTokens: 3000 });
      await ref.update({ status: "done", text: clean(text, 60000), doneAt: ts(now()) });
    } catch (e) {
      await ref.update({ status: "failed", error: clean((e && e.message) || e, 300), doneAt: ts(now()) }).catch(() => {});
    } finally {
      running.delete(ref.id);
    }
  }

  /** Разборы, которые «готовятся» дольше 15 минут и не считаются сейчас
   *  этим процессом (сервер перезапускали), — честно помечаем неудачными. */
  async function sweep(tenantIds) {
    let fixed = 0;
    for (const t of tenantIds) {
      const snap = await col(t).where("status", "==", "running").get().catch(() => null);
      if (!snap) continue;
      for (const d of snap.docs) {
        const at = d.data().createdAt;
        const ms = at && typeof at.toMillis === "function" ? at.toMillis() : 0;
        if (running.has(d.id) || now() - ms < STALE_MS) continue;
        await d.ref.update({ status: "failed", error: "Разбор прервался (сервер перезапускался) — нажмите «Создать заново»", doneAt: ts(now()) });
        fixed++;
      }
    }
    return fixed;
  }

  async function handle(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)) throw new HttpError(400, "Не указано заведение");
    await requireTenantRole(tenantId, decoded.uid, ["owner", "admin", "manager", "employee"]);
    if (body.action === "start") return sendJson(res, 200, await start(tenantId, decoded.uid, body));
    throw new HttpError(400, "Неизвестное действие");
  }

  return { handle, start, sweep, running };
}

module.exports = { createAiReports, KINDS };
