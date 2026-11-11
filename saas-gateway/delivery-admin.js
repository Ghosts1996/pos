"use strict";
/**
 * Кабинет → «Доставка»: цена и районы, оплата при получении, Telegram, что
 * доставляем (docs/delivery.md, разделы 3–5, 8). Пишет только шлюз — после
 * проверки прав и значений; правила базы клиентам эти поля менять не мешают
 * (меню правит и касса), но цена доставки и районы — только через шлюз.
 */
const pricing = require("./delivery-pricing");
const { remoteSaleBanned } = require("./guest-delivery");

const MANAGE_ROLES = ["owner", "admin", "manager"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function createDeliveryAdmin({ db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, requireChainRole, onSaved = () => {} }) {
  const tenantRef = (t) => db().collection("tenants").doc(t);

  async function ctxOf(req, body) {
    const decoded = await verifyAuth(req);
    const tenantId = String(body.tenantId || "");
    if (!ID_RE.test(tenantId)) throw new HttpError(400, "Не указано заведение");
    await requireTenantRole(tenantId, decoded.uid, MANAGE_ROLES).catch(async (e) => {
      // Владелец сети управляет доставкой любой своей точки.
      const tenant = (await tenantRef(tenantId).get()).data() || {};
      if (!tenant.chainId) throw e;
      await requireChainRole(tenant.chainId, decoded.uid, ["owner", "admin"]);
    });
    const tenant = (await tenantRef(tenantId).get()).data() || {};
    return { uid: decoded.uid, tenantId, chainId: tenant.chainId || "" };
  }

  /** Меню глазами доставки: категории и позиции, почему нельзя. */
  async function menuOf(tenantId) {
    const t = tenantRef(tenantId);
    const [cats, items] = await Promise.all([t.collection("menuCategories").get(), t.collection("menuItems").get()]);
    const catById = Object.fromEntries(cats.docs.map((c) => [c.id, c.data() || {}]));
    const categories = cats.docs
      .map((c) => ({ id: c.id, name: String((c.data() || {}).name || "Без названия"), off: (c.data() || {}).deliveryOff === true, order: Number((c.data() || {}).sortOrder) || 0 }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "ru"));
    const list = items.docs
      .map((d) => {
        const m = d.data() || {};
        const cat = catById[m.categoryId] || {};
        const law = remoteSaleBanned(m, String(cat.name || ""));
        return {
          id: d.id, name: String(m.name || ""), categoryId: String(m.categoryId || ""), price: Number(m.price) || 0,
          off: m.deliveryOff === true, law, stop: m.available === false,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return { categories, items: list };
  }

  async function handleGet(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await ctxOf(req, body);
    const t = tenantRef(ctx.tenantId);
    const [settingsDoc, integ, venue, menu] = await Promise.all([
      t.collection("settings").doc("delivery").get(),
      t.collection("settings").doc("integrations").get(),
      t.collection("meta").doc("venueProfile").get(),
      menuOf(ctx.tenantId),
    ]);
    const raw = settingsDoc.data() || {};
    const v = venue.data() || {};
    sendJson(res, 200, {
      settings: pricing.normalizeSettings(raw),
      venuePos: raw.venuePos || null,
      deliveryEnabled: v.deliveryEnabled === true,
      // QR у двери — через банк онлайн-оплаты; без него способ не сработает.
      bankConnected: !!(integ.data() || {}).onlinePayVerified,
      chain: !!ctx.chainId,
      menu,
    });
  }

  /** Сохранить цену, районы и способы оплаты; сеть — по желанию на все точки. */
  async function handleSave(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await ctxOf(req, body);
    const input = body.settings && typeof body.settings === "object" ? body.settings : {};
    const problem = pricing.settingsProblem(input);
    if (problem) throw new HttpError(400, problem);
    const clean = pricing.normalizeSettings(input);
    const data = { ...clean, updatedAt: admin.firestore.Timestamp.now(), updatedBy: ctx.uid };
    let targets = [ctx.tenantId];
    if (body.applyToChain === true) {
      if (!ctx.chainId) throw new HttpError(400, "Заведение не в сети");
      await requireChainRole(ctx.chainId, ctx.uid, ["owner", "admin"]).catch(() => {
        throw new HttpError(403, "Применить ко всем точкам может владелец или администратор сети");
      });
      targets = (await db().collection("tenants").where("chainId", "==", ctx.chainId).get()).docs
        .filter((d) => (d.data() || {}).status !== "deleted")
        .map((d) => d.id);
    }
    // merge: координаты точки (venuePos, pickupPoints) — свои у каждой точки.
    for (const id of targets) await tenantRef(id).collection("settings").doc("delivery").set(data, { merge: true });
    try { onSaved(targets); } catch (_) { /* кэш бота — не главное */ }
    if (typeof body.deliveryEnabled === "boolean") {
      await tenantRef(ctx.tenantId).collection("meta").doc("venueProfile").set({ deliveryEnabled: body.deliveryEnabled }, { merge: true });
    }
    sendJson(res, 200, { ok: true, points: targets.length, settings: clean });
  }

  /**
   * Что доставляем: { items: {id: off}, categories: {id: off} }. Позиции,
   * запрещённые законом, включить нельзя — их флаг просто не пишем.
   */
  async function handleMenuSave(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await ctxOf(req, body);
    const t = tenantRef(ctx.tenantId);
    const items = body.items && typeof body.items === "object" ? body.items : {};
    const cats = body.categories && typeof body.categories === "object" ? body.categories : {};
    const ids = Object.keys(items).filter((id) => ID_RE.test(id)).slice(0, 2000);
    const catIds = Object.keys(cats).filter((id) => ID_RE.test(id)).slice(0, 500);
    let changed = 0;
    for (const id of catIds) {
      const ref = t.collection("menuCategories").doc(id);
      const cur = await ref.get();
      if (!cur.exists) continue;
      const off = cats[id] === true;
      if (((cur.data() || {}).deliveryOff === true) === off) continue;
      await ref.update({ deliveryOff: off });
      changed++;
    }
    for (const id of ids) {
      const ref = t.collection("menuItems").doc(id);
      const cur = await ref.get();
      if (!cur.exists) continue;
      const off = items[id] === true;
      if (((cur.data() || {}).deliveryOff === true) === off) continue;
      await ref.update({ deliveryOff: off });
      changed++;
    }
    sendJson(res, 200, { ok: true, changed, menu: await menuOf(ctx.tenantId) });
  }

  return { handleGet, handleSave, handleMenuSave, menuOf };
}

module.exports = { createDeliveryAdmin };
