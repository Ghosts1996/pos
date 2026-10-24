"use strict";

/**
 * Живая копия «статики» заведения в памяти сервера: меню, категории,
 * сотрудники, профиль заведения, документ заведения и его возможности по
 * тарифу. Сервер один раз подписывается на эти данные в Firestore и дальше
 * получает только изменения — каждое изменённое блюдо стоит одно чтение.
 *
 * Раньше кассы раз в 5 минут спрашивали tenantStaticData, а кеш сервера жил
 * те же 5 минут — почти каждый запрос заново читал всё меню целиком (сотни
 * чтений), то есть десятки тысяч чтений в сутки на одно заведение. Гости
 * читали меню напрямую из базы при каждом открытии. Теперь и кассы, и гости
 * получают меню отсюда, а лимит Firebase тратится только на изменения.
 *
 * Заведение, к которому никто не обращался IDLE_MS, отписывается — память и
 * подписки не копятся.
 */

const IDLE_MS = 6 * 3600 * 1000;
const READY_TIMEOUT_MS = 15000;
const MEMBER_TTL_MS = 10 * 60 * 1000;

function createTenantCache({ db, now = () => Date.now(), idleMs = IDLE_MS } = {}) {
  const entries = new Map(); // tenantId → запись
  const members = new Map(); // `${tenantId}_${uid}` → { member, at }

  const PARTS = {
    menuCategories: (t) => t.collection("menuCategories"),
    menuItems: (t) => t.collection("menuItems"),
    employees: (t) => t.collection("employees"),
  };
  const DOCS = {
    tenant: (t) => t,
    venueProfile: (t) => t.collection("meta").doc("venueProfile"),
    features: (t) => t.collection("public").doc("features"),
  };

  function drop(tenantId) {
    const e = entries.get(tenantId);
    if (!e) return;
    for (const u of e.unsubs) {
      try { u(); } catch (_) { /* уже отписан */ }
    }
    entries.delete(tenantId);
  }

  function open(tenantId) {
    const tenantRef = db().collection("tenants").doc(tenantId);
    const e = {
      tenantId, unsubs: [], lastUsed: now(), version: 0, failed: null,
      data: { menuCategories: null, menuItems: null, employees: null, tenant: undefined, venueProfile: undefined, features: undefined },
      json: new Map(), // вид ответа → { version, raw }
    };
    let resolveReady;
    let rejectReady;
    e.ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    e.ready.catch(() => {});
    const check = () => {
      const d = e.data;
      if (d.menuCategories && d.menuItems && d.employees && d.tenant !== undefined && d.venueProfile !== undefined && d.features !== undefined) resolveReady();
    };
    const fail = (err) => {
      // Подписка оборвалась (нет прав, исчерпан лимит, сеть) — забываем
      // запись: следующий запрос подпишется заново.
      e.failed = err;
      rejectReady(err);
      if (entries.get(tenantId) === e) drop(tenantId);
    };
    for (const [key, col] of Object.entries(PARTS)) {
      e.unsubs.push(col(tenantRef).onSnapshot((snap) => {
        e.data[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        e.version++;
        check();
      }, fail));
    }
    for (const [key, ref] of Object.entries(DOCS)) {
      e.unsubs.push(ref(tenantRef).onSnapshot((snap) => {
        e.data[key] = snap.exists ? snap.data() : null;
        e.version++;
        check();
      }, fail));
    }
    entries.set(tenantId, e);
    return e;
  }

  /** Данные заведения (ждёт первой загрузки). */
  async function get(tenantId) {
    let e = entries.get(tenantId);
    if (!e) e = open(tenantId);
    e.lastUsed = now();
    let timer;
    try {
      await Promise.race([
        e.ready,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("данные заведения не загрузились вовремя")), READY_TIMEOUT_MS); }),
      ]);
    } catch (err) {
      if (entries.get(tenantId) === e && !e.failed) drop(tenantId);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return e;
  }

  /** Готовый JSON вида [kind]; пересобирается, только когда данные изменились. */
  async function json(tenantId, kind, build) {
    const e = await get(tenantId);
    const cur = e.json.get(kind);
    if (cur && cur.version === e.version) return cur.raw;
    const raw = JSON.stringify(build(e.data));
    e.json.set(kind, { version: e.version, raw });
    return raw;
  }

  /** Участник заведения — с кешем на MEMBER_TTL_MS (одно чтение вместо каждого запроса). */
  async function member(tenantId, uid) {
    const key = `${tenantId}_${uid}`;
    const c = members.get(key);
    if (c && now() - c.at < MEMBER_TTL_MS) return c.member;
    const snap = await db().collection("tenantMembers").doc(key).get();
    const m = snap.exists ? snap.data() : null;
    if (members.size > 20000) members.clear();
    members.set(key, { member: m, at: now() });
    return m;
  }

  /** Права участника изменились (удалили устройство, сменили роль) — перечитать. */
  function forgetMember(tenantId, uid) {
    if (uid) members.delete(`${tenantId}_${uid}`);
    else for (const k of members.keys()) if (k.startsWith(`${tenantId}_`)) members.delete(k);
  }

  function sweep() {
    for (const [id, e] of entries) if (now() - e.lastUsed > idleMs) drop(id);
  }

  return { get, json, member, forgetMember, drop, sweep, size: () => entries.size };
}

/** Поля блюда, которые видит гость: без себестоимости, рецепта, склада и премий. */
const GUEST_ITEM_FIELDS = ["categoryId", "name", "price", "available", "imageUrl", "weight", "weightUnit", "vat", "fiscalSubject",
  "description", "tobacco", "popularRank", "modifierGroups", "kind"];
const GUEST_CATEGORY_FIELDS = ["name", "order", "imageUrl", "kind"];

function pick(obj, fields) {
  const out = { id: obj.id };
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

function guestMenu(data) {
  return {
    menuItems: (data.menuItems || []).filter((i) => i.available !== false).map((i) => pick(i, GUEST_ITEM_FIELDS)),
    menuCategories: (data.menuCategories || []).map((c) => pick(c, GUEST_CATEGORY_FIELDS))
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)),
  };
}

module.exports = { createTenantCache, guestMenu, GUEST_ITEM_FIELDS };
