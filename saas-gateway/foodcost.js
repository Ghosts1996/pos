"use strict";
// Фудкост-сторож и заявка на закупку (Кабинет · «Склад»).
//
// Себестоимость порции считается так же, как в кассе (lib/models/menu_models.dart
// MenuItem.perPortion / portionCost, lib/models/inventory_models.dart costOf):
// техкарта (брутто с отходом, делённое на число порций рецепта) или простая
// привязка к товару × цена закупки продукта (₽ за кг, литр или штуку).
//
//   • Сторож (раз в час): блюдо, у которого себестоимость выросла и стала
//     выше порога от цены (по умолчанию 35%), — владельцу в бот заведения:
//     было → стало и какой продукт подорожал. По одному разу на повышение.
//   • Заявка на закупку: средний расход за 14 дней (списания по продажам и
//     заготовкам) и остаток → чего не хватит на N дней (по умолчанию 3) и
//     что ниже минимума; сколько заказать. В кабинете — по кнопке, в бот —
//     по настройке раз в день вечером.
//
// Только цифры склада и меню: персональных данных здесь нет.

const DAY = 86400000;
const HISTORY_DAYS = 14;
const DEFAULTS = { alerts: true, threshold: 35, coverDays: 3, orderDaily: false, orderHour: 16 };

const UNITS = new Set(["g", "kg", "ml", "l", "pcs"]);
const unitOf = (u) => (UNITS.has(u) ? u : "g");
const priceUnit = (u) => (u === "g" ? "kg" : u === "ml" ? "l" : u);

function convert(v, from, to) {
  const f = unitOf(from);
  const t = unitOf(to);
  if (f === t) return v;
  if (f === "g" && t === "kg") return v / 1000;
  if (f === "kg" && t === "g") return v * 1000;
  if (f === "ml" && t === "l") return v / 1000;
  if (f === "l" && t === "ml") return v * 1000;
  return v; // несовместимые единицы — как в кассе: число как есть
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const round2 = (x) => Math.round(num(x) * 100) / 100;

/** Стоимость amount (в единицах unit) продукта склада, ₽. */
function costOf(inv, amount, unit) {
  const price = num(inv && inv.costPrice);
  return price <= 0 ? 0 : convert(amount, unit, priceUnit(unitOf(inv.unit))) * price;
}

const gross = (c) => {
  const loss = Math.max(0, Math.min(95, num(c.lossPercent)));
  return loss <= 0 ? num(c.weight) : num(c.weight) / (1 - loss / 100);
};

/** Строки списания на одну порцию: [{id, weight, unit}]. */
function perPortion(m) {
  const comps = Array.isArray(m.components) ? m.components : [];
  if (comps.length) {
    const n = Math.max(1, Math.round(num(m.recipePortions) || 1));
    return comps.filter((c) => c && c.inventoryItemId && num(c.weight) > 0)
      .map((c) => ({ id: String(c.inventoryItemId), weight: gross(c) / n, unit: unitOf(c.weightUnit) }));
  }
  if (m.inventoryItemId && num(m.weight) > 0) return [{ id: String(m.inventoryItemId), weight: num(m.weight), unit: unitOf(m.weightUnit) }];
  return [];
}

/** Себестоимость порции, ₽, и вклад каждого продукта. null — не всё посчитать (нет цены). */
function portionCost(m, stock) {
  const lines = perPortion(m);
  if (!lines.length) return null;
  let sum = 0;
  const parts = {};
  for (const l of lines) {
    const inv = stock[l.id];
    if (!inv || num(inv.costPrice) <= 0) return null;
    const c = costOf(inv, l.weight, l.unit);
    parts[l.id] = (parts[l.id] || 0) + c;
    sum += c;
  }
  return { cost: sum, parts };
}

/** Фудкост всех блюд: [{id, name, price, cost, pct, parts}]. */
function menuCosts(menu, stock) {
  const out = [];
  for (const [id, m] of Object.entries(menu)) {
    const price = num(m.price);
    if (price <= 0 || m.archived === true) continue;
    const pc = portionCost(m, stock);
    if (!pc) continue;
    out.push({ id, name: String(m.name || ""), price, cost: round2(pc.cost), pct: Math.round((pc.cost / price) * 1000) / 10, parts: pc.parts });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

/**
 * Что сообщить: блюда выше порога, у которых себестоимость выросла с прошлой
 * проверки (≥ 3% и ≥ 1 ₽). prev — { dishes: {id: {cost, pct}}, prices: {id: costPrice} }.
 */
function costAlerts(costs, prev, stock, { threshold = DEFAULTS.threshold } = {}) {
  const was = (prev && prev.dishes) || {};
  const wasPrice = (prev && prev.prices) || {};
  const out = [];
  for (const d of costs) {
    const p = was[d.id];
    if (!p || d.pct < threshold) continue;
    if (!(d.cost >= p.cost * 1.03 && d.cost - p.cost >= 1)) continue;
    // Главная причина — продукт, чья доля подорожала сильнее всего.
    let reason = null;
    for (const id of Object.keys(d.parts)) {
      const inv = stock[id] || {};
      const before = num(wasPrice[id]);
      const now = num(inv.costPrice);
      if (before > 0 && now > before && (!reason || now / before > reason.now / reason.before)) {
        reason = { name: String(inv.name || ""), before, now, unit: priceUnit(unitOf(inv.unit)) };
      }
    }
    out.push({ ...d, wasCost: p.cost, wasPct: p.pct, reason });
  }
  return out;
}

const UNIT_LABEL = { g: "г", kg: "кг", ml: "мл", l: "л", pcs: "шт" };
const rub = (n) => `${Math.round(num(n)).toLocaleString("ru-RU")} ₽`;
const pctText = (x) => `${String(Math.round(num(x) * 10) / 10).replace(".", ",")}%`;

function alertText(list, { venue = "Заведение", label = "" } = {}) {
  if (!list.length) return null;
  const lines = [`📈 Себестоимость выросла — ${label || venue}`];
  for (const d of list.slice(0, 8)) {
    lines.push(`• ${d.name}: ${pctText(d.wasPct)} → ${pctText(d.pct)} от цены (${rub(d.wasCost)} → ${rub(d.cost)} при цене ${rub(d.price)})`
      + (d.reason ? `\n  подорожал продукт «${d.reason.name}»: ${rub(d.reason.before)} → ${rub(d.reason.now)} за ${UNIT_LABEL[d.reason.unit] || d.reason.unit}` : ""));
  }
  if (list.length > 8) lines.push(`…и ещё ${list.length - 8}`);
  lines.push("", "Поднимите цену или поправьте техкарту. Все блюда — Кабинет · «Склад» → «Фудкост».");
  return lines.join("\n");
}

/**
 * Заявка на закупку. stock — {id: item}, used — {id: расход за HISTORY_DAYS
 * дней, в единицах позиции}. → [{id, name, unit, quantity, perDay, daysLeft, order, why}]
 */
function purchaseList(stock, used, { coverDays = DEFAULTS.coverDays, days = HISTORY_DAYS } = {}) {
  const out = [];
  for (const [id, it] of Object.entries(stock)) {
    if (it.active === false) continue;
    const q = Math.max(0, num(it.quantity));
    const perDay = num(used[id]) / days;
    const min = num(it.minQuantity);
    const need = Math.max(perDay * coverDays, min);
    if (need <= 0 || q >= need) continue;
    const unit = unitOf(it.unit);
    // Округляем заказ вверх до удобного: штуки — до целых, г/мл — до 100, кг/л — до 0,5.
    const raw = Math.max(need - q, 0);
    const step = unit === "pcs" ? 1 : unit === "g" || unit === "ml" ? 100 : 0.5;
    const order = Math.ceil(raw / step) * step;
    if (order <= 0) continue;
    out.push({
      id, name: String(it.name || ""), unit, quantity: round2(q), perDay: round2(perDay),
      daysLeft: perDay > 0 ? Math.floor(q / perDay) : null, order: round2(order),
      cost: num(it.costPrice) > 0 ? round2(costOf(it, order, unit)) : null,
      why: q <= min && min > 0 ? "ниже минимума" : `хватит на ${perDay > 0 ? Math.floor(q / perDay) : 0} дн.`,
    });
  }
  return out.sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99) || a.name.localeCompare(b.name, "ru"));
}

function orderText(list, { venue = "Заведение", label = "", coverDays = DEFAULTS.coverDays } = {}) {
  if (!list.length) return null;
  const total = list.reduce((s, x) => s + (x.cost || 0), 0);
  return [
    `🛒 Заявка на закупку — ${label || venue} (запас на ${coverDays} дн.)`,
    ...list.slice(0, 25).map((x) => `• ${x.name} — ${String(x.order).replace(".", ",")} ${UNIT_LABEL[x.unit] || x.unit} (осталось ${String(x.quantity).replace(".", ",")}, ${x.why})`),
    list.length > 25 ? `…и ещё ${list.length - 25}` : "",
    total > 0 ? `Примерно на ${rub(total)} по последним ценам закупки.` : "",
  ].filter(Boolean).join("\n");
}

function createFoodcost(deps) {
  const { db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, ownerAlert = async () => false, now = () => Date.now() } = deps;
  const Timestamp = admin.firestore.Timestamp;
  const tenant = (tid) => db().collection("tenants").doc(tid);
  const stateRef = (tid) => db().collection("foodcostState").doc(tid);

  async function settingsOf(tid) {
    const d = (await tenant(tid).collection("settings").doc("foodcost").get().catch(() => null))?.data?.() || {};
    return {
      alerts: d.alerts !== false,
      threshold: Math.max(10, Math.min(90, Math.round(num(d.threshold) || DEFAULTS.threshold))),
      coverDays: Math.max(1, Math.min(14, Math.round(num(d.coverDays) || DEFAULTS.coverDays))),
      orderDaily: d.orderDaily === true,
      orderHour: Math.max(0, Math.min(23, Number.isInteger(d.orderHour) ? d.orderHour : DEFAULTS.orderHour)),
    };
  }

  async function load(tid) {
    const [menuSnap, stockSnap] = await Promise.all([tenant(tid).collection("menuItems").get(), tenant(tid).collection("inventoryItems").get()]);
    const menu = {};
    menuSnap.docs.forEach((d) => { menu[d.id] = d.data() || {}; });
    const stock = {};
    stockSnap.docs.forEach((d) => { stock[d.id] = d.data() || {}; });
    return { menu, stock };
  }

  async function usage(tid) {
    const since = Timestamp.fromMillis(now() - HISTORY_DAYS * DAY);
    const snap = await tenant(tid).collection("inventoryMovements").where("createdAt", ">=", since).get();
    const used = {};
    for (const d of snap.docs) {
      const m = d.data() || {};
      if (!["writeoff", "production"].includes(m.type) || !(num(m.delta) < 0) || !m.itemId) continue;
      used[m.itemId] = (used[m.itemId] || 0) - num(m.delta);
    }
    return used;
  }

  /** Проверка одной точки: сигналы о подорожании. Возвращает число блюд в сигнале. */
  async function checkTenant(tid, { venue, label } = {}) {
    const cfg = await settingsOf(tid);
    const { menu, stock } = await load(tid);
    const costs = menuCosts(menu, stock);
    const prev = (await stateRef(tid).get()).data() || null;
    const alerts = prev && cfg.alerts ? costAlerts(costs, prev, stock, cfg) : [];
    const dishes = {};
    for (const d of costs) dishes[d.id] = { cost: d.cost, pct: d.pct };
    const prices = {};
    for (const [id, it] of Object.entries(stock)) if (num(it.costPrice) > 0) prices[id] = num(it.costPrice);
    await stateRef(tid).set({ dishes, prices, at: Timestamp.fromMillis(now()) });
    const text = alertText(alerts, { venue, label });
    if (text) await ownerAlert(tid, text);
    return alerts.length;
  }

  /** Вечерняя заявка в бот — по настройке, раз в день в выбранный час заведения. */
  async function dailyOrder(tid, { tz = "Europe/Moscow", venue, label } = {}) {
    const cfg = await settingsOf(tid);
    if (!cfg.orderDaily) return false;
    const parts = new Intl.DateTimeFormat("ru-RU", { timeZone: tz, hour: "numeric", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now()));
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    const day = `${get("year")}-${get("month")}-${get("day")}`;
    if (Number(get("hour")) !== cfg.orderHour) return false;
    const st = (await stateRef(tid).get()).data() || {};
    if (st.orderDay === day) return false;
    await stateRef(tid).set({ orderDay: day }, { merge: true });
    const { stock } = await load(tid);
    const text = orderText(purchaseList(stock, await usage(tid), cfg), { venue, label, coverDays: cfg.coverDays });
    if (text) await ownerAlert(tid, text);
    return !!text;
  }

  /** Все точки со складом: раз в час. */
  async function runAll() {
    const snap = await db().collection("tenants").where("status", "in", ["active", "trial"]).get();
    let n = 0;
    for (const d of snap.docs) {
      const t = d.data() || {};
      if (t.demo === true || t.isDemo === true) continue;
      try {
        await checkTenant(d.id, { venue: t.name || "Заведение" });
        await dailyOrder(d.id, { tz: t.timezone || "Europe/Moscow", venue: t.name || "Заведение" });
        n++;
      } catch (e) {
        console.error(`foodcost ${d.id}:`, e.message || e);
      }
    }
    return n;
  }

  async function handle(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const tid = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new HttpError(400, "Не указано заведение");
    const action = String(body.action || "summary");
    if (action === "settings") {
      await requireTenantRole(tid, decoded.uid, ["owner", "admin"]);
      const s = body.settings || {};
      const patch = {
        alerts: s.alerts !== false,
        threshold: Math.max(10, Math.min(90, Math.round(num(s.threshold) || DEFAULTS.threshold))),
        coverDays: Math.max(1, Math.min(14, Math.round(num(s.coverDays) || DEFAULTS.coverDays))),
        orderDaily: s.orderDaily === true,
        orderHour: Math.max(0, Math.min(23, Math.round(num(s.orderHour) || DEFAULTS.orderHour))),
      };
      await tenant(tid).collection("settings").doc("foodcost").set(patch, { merge: true });
    } else if (action !== "summary") {
      throw new HttpError(400, "Неизвестное действие");
    } else {
      await requireTenantRole(tid, decoded.uid, ["owner", "admin", "manager"]);
    }
    const cfg = await settingsOf(tid);
    const { menu, stock } = await load(tid);
    const costs = menuCosts(menu, stock).map(({ parts, ...d }) => { void parts; return d; });
    const withRecipe = Object.values(menu).filter((m) => perPortion(m).length).length;
    const order = purchaseList(stock, await usage(tid), cfg);
    sendJson(res, 200, {
      settings: cfg, dishes: costs, withRecipe, uncosted: withRecipe - costs.length,
      over: costs.filter((d) => d.pct >= cfg.threshold).length, order,
      orderTotal: round2(order.reduce((s, x) => s + (x.cost || 0), 0)),
    });
  }

  return { handle, checkTenant, dailyOrder, runAll, settingsOf };
}

module.exports = { createFoodcost, convert, costOf, perPortion, portionCost, menuCosts, costAlerts, alertText, purchaseList, orderText, DEFAULTS };
