"use strict";
/**
 * Службы доставки: курьер Яндекс Доставки или Достависты вместо своего.
 * Описание — docs/delivery.md, раздел 13.
 *
 * Как устроено:
 *  • ключ службы заведение вставляет в Кабинет → «Доставка» → «Службы
 *    доставки». Хранится только зашифрованным (AES-256-GCM, как реквизиты
 *    менеджеров) в deliveryServices/{root}: root = "t_<точка>" (ключ точки)
 *    или "c_<сеть>" (один ключ на всю сеть, адрес забора — у каждой точки свой);
 *  • в заказе: «Сколько стоит» → цена службы → «Вызвать» → заявка;
 *    Яндекс сначала оценивает заявку, мы подтверждаем её сами, если цена
 *    не выросла больше чем на 20 % от показанной, иначе ждём «Подтвердить»;
 *  • сторож раз в 20 с спрашивает у службы статус и где курьер: статус и
 *    точка ложатся в заказ (ext, courierPos) — их видят касса, кабинет,
 *    чат-бот и гость на карте, как у своего курьера;
 *  • отмена — по правилам службы (бесплатно, пока курьер не выехал, или
 *    платно — показываем перед отменой).
 *
 * Деньги за еду курьер службы не берёт: вызвать для неоплаченного заказа
 * можно только с явным «гость оплатит заведению сам».
 *
 * Персональные данные гостя (имя, телефон, адрес) уходят службе — она в
 * России и везёт заказ по договору с заведением; в политике ПД это указано.
 */
const crypto = require("crypto");

const PROVIDERS = {
  yandex: { name: "Яндекс Доставка", short: "Яндекс" },
  dostavista: { name: "Достависта", short: "Достависта" },
};
const YANDEX_API = "https://b2b.taxi.yandex.net/b2b/cargo/integration/v2";
const DOSTAVISTA_API = "https://robot.dostavista.ru/api/business/1.6";
const YANDEX_CLASSES = ["courier", "express"];
const POLL_MS = 20000;
const PRICE_DRIFT = 1.2;
const POS_FRESH_MS = 10 * 60 * 1000;

/** Статусы Яндекс Доставки → наш шаг и подпись. */
const YANDEX_STATUS = {
  new: ["estimating", "Считаем цену"],
  estimating: ["estimating", "Считаем цену"],
  ready_for_approval: ["approve", "Ждёт подтверждения цены"],
  accepted: ["search", "Ищем курьера"],
  performer_lookup: ["search", "Ищем курьера"],
  performer_draft: ["search", "Ищем курьера"],
  performer_found: ["toVenue", "Курьер едет в заведение"],
  pickup_arrived: ["toVenue", "Курьер в заведении"],
  ready_for_pickup_confirmation: ["toVenue", "Курьер в заведении"],
  pickuped: ["onWay", "Курьер везёт гостю"],
  delivery_arrived: ["arrived", "Курьер у гостя"],
  ready_for_delivery_confirmation: ["arrived", "Курьер у гостя"],
  pay_waiting: ["arrived", "Курьер у гостя"],
  delivered: ["done", "Доставлен"],
  delivered_finish: ["done", "Доставлен"],
  returning: ["return", "Курьер везёт заказ обратно"],
  return_arrived: ["return", "Курьер вернулся в заведение"],
  ready_for_return_confirmation: ["return", "Курьер вернулся в заведение"],
  returned: ["failed", "Заказ вернули в заведение"],
  returned_finish: ["failed", "Заказ вернули в заведение"],
  cancelled: ["cancelled", "Вызов отменён"],
  cancelled_with_payment: ["cancelled", "Вызов отменён (платно)"],
  cancelled_by_taxi: ["cancelled", "Служба отменила вызов"],
  cancelled_with_items_on_hands: ["cancelled", "Вызов отменён, заказ у курьера"],
  failed: ["failed", "Служба не смогла доставить"],
  estimating_failed: ["failed", "Служба не смогла посчитать цену"],
  performer_not_found: ["failed", "Курьер не найден"],
};
/** Статусы Достависты. */
const DV_STATUS = {
  new: ["search", "Ищем курьера"],
  available: ["search", "Ищем курьера"],
  draft: ["search", "Ищем курьера"],
  reactivated: ["search", "Ищем курьера"],
  delayed: ["search", "Ищем курьера"],
  active: ["toVenue", "Курьер назначен"],
  completed: ["done", "Доставлен"],
  canceled: ["cancelled", "Вызов отменён"],
};
const FINAL = new Set(["done", "cancelled", "failed"]);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const rubText = (n) => `${String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₽`;
const digits = (p) => {
  const d = String(p || "").replace(/\D/g, "").replace(/^8(\d{10})$/, "7$1");
  return d.length === 10 ? `7${d}` : d;
};
const maskToken = (t) => (t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : "••••");

/** Адрес гостя: улица и дом отдельно от квартиры, подъезда, этажа, домофона. */
function splitAddress(address) {
  const a = String(address || "");
  // Слово — только целиком (после начала, пробела или запятой): «кв» внутри «Москва» не квартира.
  const pick = (re) => { const m = re.exec(a); return m ? clean(m[1], 20) : ""; };
  return {
    street: a.split(/,\s*(?=кв\.\/офис|кв\.?\s|квартира|офис|оф\.|подъезд|под\.|этаж|эт\.|домофон|код\s)/i)[0].trim(),
    flat: pick(/(?:^|[\s,])(?:кв\.\/офис|кв\.|кв(?=\s)|квартира|офис|оф\.)\s*([^,]+)/i),
    porch: pick(/(?:^|[\s,])(?:подъезд|под\.)\s*([^,]+)/i),
    floor: pick(/(?:^|[\s,])(?:этаж|эт\.)\s*([^,]+)/i),
    door: pick(/(?:^|[\s,])(?:домофон|код(?=\s))\s*([^,]+)/i),
  };
}

function createDeliveryServices({
  db, admin, HttpError, verifyAuth, parseJsonBody, sendJson, requireTenantRole, requireChainRole,
  encrypt, decrypt, secretKey, pii = null, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), hooks = {},
}) {
  const FieldValue = admin.firestore.FieldValue;
  const Timestamp = admin.firestore.Timestamp;
  const ts = () => Timestamp.fromMillis(now());
  const ms = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : Number(v) || 0);
  const tenantRef = (t) => db().collection("tenants").doc(t);
  const servicesRef = (root) => db().collection("deliveryServices").doc(root);
  // Заказ поменялся — кабинет и приложение курьера сразу видят новое (без старого кэша).
  const changed = (t) => { try { if (hooks.changed) hooks.changed(t); } catch (_) { /* не главное */ } };
  const event = (t, s, text) => (hooks.event ? hooks.event(t, s, text).catch(() => {}) : Promise.resolve());

  // ------------------------------------------------------------ ключи

  async function rootsOf(tenantId) {
    const t = (await tenantRef(tenantId).get()).data();
    if (!t) throw new HttpError(404, "Заведение не найдено");
    return { tenant: t, roots: [`t_${tenantId}`, ...(t.chainId ? [`c_${t.chainId}`] : [])] };
  }

  /** Ключ службы для точки: свой ключ точки важнее ключа сети. */
  async function credsOf(tenantId, provider) {
    const { roots } = await rootsOf(tenantId);
    for (const root of roots) {
      const p = ((await servicesRef(root).get()).data() || {})[provider];
      if (p && p.enabled !== false && p.tokenEnc) {
        let token = "";
        try { token = decrypt(secretKey(), p.tokenEnc); } catch (_) { token = ""; }
        if (token) return { root, token, taxiClass: YANDEX_CLASSES.includes(p.taxiClass) ? p.taxiClass : "courier" };
      }
    }
    return null;
  }

  // ------------------------------------------------------------ вызовы служб

  async function http(url, { method = "POST", headers = {}, body } = {}) {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { "Content-Type": "application/json", "Accept-Language": "ru", ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
      });
    } catch (e) {
      throw new HttpError(502, "Служба доставки не отвечает — попробуйте через минуту");
    }
    let json = {};
    try { json = await res.json(); } catch (_) { json = {}; }
    if (res.status === 401 || res.status === 403) throw new HttpError(409, "Служба не приняла ключ — проверьте его в Кабинете → «Доставка» → «Службы доставки»");
    if (!res.ok) {
      const msg = clean(json.message || (json.errors && JSON.stringify(json.errors)) || json.code || "", 200);
      throw new HttpError(502, `Служба доставки ответила ошибкой${msg ? `: ${msg}` : ` (${res.status})`}`);
    }
    return json;
  }

  const Y = {
    call: (token, path, body, method = "POST") => http(`${YANDEX_API}/${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body }),
    point: (pos, fullname) => ({ ...(pos ? { coordinates: [pos.lng, pos.lat] } : {}), fullname }),
  };
  const D = {
    call: async (token, path, body, method = "POST") => {
      const j = await http(`${DOSTAVISTA_API}/${path}`, { method, headers: { "X-DV-Auth-Token": token }, body });
      if (j.is_successful === false) {
        const why = [].concat(j.errors || [], ...Object.values(j.parameter_errors || {}).map((x) => [].concat(x))).join(", ");
        throw new HttpError(409, `Достависта: ${why || "заказ не принят"}`);
      }
      return j;
    },
  };

  /** Всё, что нужно службе о заказе: откуда, куда, кому, сколько. */
  async function orderOf(tenantId, sessionId) {
    const t = tenantRef(tenantId);
    const sRef = t.collection("sessions").doc(sessionId);
    const [sDoc, vDoc, dDoc] = await Promise.all([sRef.get(), t.collection("meta").doc("venueProfile").get(), t.collection("settings").doc("delivery").get()]);
    const s = sDoc.data();
    if (!s || s.orderType !== "delivery") throw new HttpError(404, "Заказ доставки не найден");
    const v = vDoc.data() || {};
    const d = dDoc.data() || {};
    let r = {};
    if (pii && (await pii.mode(tenantId).catch(() => "mirror")) === "rf") {
      r = (await pii.lookup(tenantId, [{ k: "delivery", id: sessionId }]).catch(() => new Map())).get(`delivery:${sessionId}`) || {};
    }
    const extra = r.extra && typeof r.extra === "object" ? r.extra : {};
    const g = extra.geo || s.deliveryGeo;
    const contact = {
      name: clean(r.name || s.customerName || "Гость", 60) || "Гость",
      phone: digits(r.phone || s.customerPhone || extra.guestContact || s.guestContact),
      address: clean(r.address || s.deliveryAddress, 300),
      comment: clean(extra.comment || s.deliveryComment, 300),
      geo: g && Number.isFinite(Number(g.lat)) && Number.isFinite(Number(g.lng)) ? { lat: Number(g.lat), lng: Number(g.lng) } : null,
    };
    const venue = {
      name: clean(v.name || "Заведение", 80),
      address: clean(v.address, 300),
      phone: digits(v.phone),
      pos: d.venuePos && Number.isFinite(Number(d.venuePos.lat)) ? { lat: Number(d.venuePos.lat), lng: Number(d.venuePos.lng) } : null,
    };
    const items = (s.orderItems || []).filter((i) => i.menuItemId !== "zalpos_delivery");
    const total = round2(items.reduce((a, i) => a + (Number(i.price) || 0) * (Number(i.qty) || 0), 0)) || round2(Number(s.appTotal) || 0);
    const paid = round2(Number(s.guestPaidTotal) || 0);
    return { ref: sRef, s, venue, contact, items, total, paid, unpaid: s.status !== "closed" && paid + 0.009 < total, no: String(s.orderNo || sessionId.slice(-4)) };
  }

  function needAddresses(o) {
    if (!o.venue.address) throw new HttpError(409, "Укажите адрес заведения: Настройки → «Заведение»");
    if (!o.venue.phone || o.venue.phone.length < 11) throw new HttpError(409, "Укажите телефон заведения: Настройки → «Заведение» — по нему служба звонит при заборе");
    if (!o.contact.address) throw new HttpError(409, "В заказе нет адреса гостя");
    if (!o.contact.phone || o.contact.phone.length < 11) throw new HttpError(409, "В заказе нет телефона гостя — курьеру службы он нужен");
  }

  async function quoteOf(provider, creds, o) {
    if (provider === "yandex") {
      const j = await Y.call(creds.token, "check-price", {
        items: [{ quantity: 1, size: { length: 0.35, width: 0.3, height: 0.25 }, weight: 3 }],
        route_points: [Y.point(o.venue.pos, o.venue.address), Y.point(o.contact.geo, splitAddress(o.contact.address).street)],
        requirements: { taxi_class: creds.taxiClass },
        skip_door_to_door: false,
      });
      const price = round2(j.price);
      if (!(price > 0)) throw new HttpError(502, "Яндекс Доставка не назвала цену — проверьте адреса");
      return { price, etaMin: Number(j.eta) > 0 ? Math.round(Number(j.eta)) : null, distanceM: Number(j.distance_meters) || null };
    }
    const j = await D.call(creds.token, "calculate-order", dvBody(o));
    const price = round2((j.order && (j.order.payment_amount || j.order.delivery_fee_amount)) || 0);
    if (!(price > 0)) throw new HttpError(502, "Достависта не назвала цену — проверьте адреса");
    return { price, etaMin: null, distanceM: null };
  }

  function dvBody(o) {
    const a = splitAddress(o.contact.address);
    const pt = (address, pos, phone, name, note, extra = {}) => ({
      address, ...(pos ? { latitude: pos.lat, longitude: pos.lng } : {}),
      contact_person: { phone, name }, ...(note ? { note: clean(note, 300) } : {}), ...extra,
    });
    return {
      matter: `Еда, заказ №${o.no}`,
      total_weight_kg: 3,
      points: [
        pt(o.venue.address, o.venue.pos, o.venue.phone, o.venue.name, `Заберите заказ №${o.no}`),
        pt(a.street || o.contact.address, o.contact.geo, o.contact.phone, o.contact.name,
          [a.flat && `кв./офис ${a.flat}`, a.porch && `подъезд ${a.porch}`, a.floor && `этаж ${a.floor}`, a.door && `домофон ${a.door}`, o.contact.comment].filter(Boolean).join(", "),
          { client_order_id: o.no }),
      ],
    };
  }

  async function createClaim(provider, creds, o) {
    if (provider === "yandex") {
      const a = splitAddress(o.contact.address);
      const j = await Y.call(creds.token, `claims/create?request_id=${crypto.randomUUID()}`, {
        items: [{
          extra_id: o.no, pickup_point: 1, dropoff_point: 2, title: `Заказ №${o.no}`,
          cost_value: o.total.toFixed(2), cost_currency: "RUB", quantity: 1,
          size: { length: 0.35, width: 0.3, height: 0.25 }, weight: 3,
        }],
        route_points: [
          {
            point_id: 1, visit_order: 1, type: "source", skip_confirmation: true,
            contact: { name: o.venue.name, phone: `+${o.venue.phone}` },
            address: { ...Y.point(o.venue.pos, o.venue.address), comment: `Заказ №${o.no}` },
          },
          {
            point_id: 2, visit_order: 2, type: "destination", skip_confirmation: true, external_order_id: o.no,
            contact: { name: o.contact.name, phone: `+${o.contact.phone}` },
            address: {
              ...Y.point(o.contact.geo, a.street || o.contact.address),
              ...(a.flat ? { sflat: a.flat } : {}), ...(a.porch ? { porch: a.porch } : {}),
              ...(a.floor ? { sfloor: a.floor } : {}), ...(a.door ? { door_code: a.door } : {}),
              ...(o.contact.comment ? { comment: o.contact.comment } : {}),
            },
          },
        ],
        client_requirements: { taxi_class: creds.taxiClass },
        emergency_contact: { name: o.venue.name, phone: `+${o.venue.phone}` },
        comment: `Еда, заказ №${o.no}. Хрупкое, не переворачивать.`,
        skip_door_to_door: false,
      });
      if (!j.id) throw new HttpError(502, "Яндекс Доставка не создала заявку");
      return { id: String(j.id), version: Number(j.version) || 1, status: String(j.status || "new") };
    }
    const j = await D.call(creds.token, "create-order", dvBody(o));
    const order = j.order || {};
    if (!order.order_id) throw new HttpError(502, "Достависта не создала заказ");
    const track = (order.points || []).map((p) => p.tracking_url).filter(Boolean).pop() || "";
    return { id: String(order.order_id), version: 1, status: String(order.status || "new"), price: round2(order.payment_amount), track };
  }

  /** Свежее состояние заявки у службы → { status, step, label, price, courier, pos, version }. */
  async function infoOf(provider, creds, ext) {
    if (provider === "yandex") {
      const j = await Y.call(creds.token, `claims/info?claim_id=${encodeURIComponent(ext.id)}`, {});
      const [step, label] = YANDEX_STATUS[j.status] || ["search", "В работе у службы"];
      const p = j.performer_info || {};
      const price = round2((j.pricing && (j.pricing.final_price || (j.pricing.offer && j.pricing.offer.price))) || 0);
      const out = {
        status: String(j.status || ""), step, label, version: Number(j.version) || ext.version || 1,
        ...(price > 0 ? { price } : {}),
        courier: p.courier_name ? { name: clean(p.courier_name, 60), car: clean([p.car_color, p.car_model, p.car_number].filter(Boolean).join(" "), 80) } : null,
      };
      if (["toVenue", "onWay", "arrived"].includes(step)) {
        const pp = await Y.call(creds.token, `claims/performer-position?claim_id=${encodeURIComponent(ext.id)}`, undefined, "GET").catch(() => null);
        const pos = pp && pp.position;
        if (pos && Number.isFinite(Number(pos.lat)) && Number.isFinite(Number(pos.lon))) {
          out.pos = { lat: Number(pos.lat), lng: Number(pos.lon), at: pos.timestamp ? Number(pos.timestamp) * (Number(pos.timestamp) < 1e12 ? 1000 : 1) : now() };
        }
      }
      return out;
    }
    const j = await D.call(creds.token, `orders?order_id=${encodeURIComponent(ext.id)}`, undefined, "GET");
    const order = (j.orders || [])[0] || {};
    let [step, label] = DV_STATUS[order.status] || ["search", "В работе у службы"];
    // У «active» шаги точек: курьер забрал (первая точка выполнена) → везёт.
    const pts = order.points || [];
    if (step === "toVenue" && pts[0] && pts[0].courier_visit_datetime) [step, label] = ["onWay", "Курьер везёт гостю"];
    const out = { status: String(order.status || ""), step, label, version: 1, ...(round2(order.payment_amount) > 0 ? { price: round2(order.payment_amount) } : {}) };
    if (["toVenue", "onWay", "arrived"].includes(step)) {
      const c = await D.call(creds.token, `courier?order_id=${encodeURIComponent(ext.id)}`, undefined, "GET").catch(() => null);
      const k = c && c.courier;
      if (k) {
        out.courier = { name: clean([k.name, k.surname].filter(Boolean).join(" "), 60), car: "" };
        if (Number.isFinite(Number(k.latitude)) && Number.isFinite(Number(k.longitude)) && Number(k.latitude)) {
          out.pos = { lat: Number(k.latitude), lng: Number(k.longitude), at: now() };
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------ заказ ← состояние службы

  /** Шаг службы → поля заказа: их уже понимают касса, кабинет, бот и гость. */
  async function applyInfo(tenantId, ref, ext, info) {
    let changedStep = "";
    await db().runTransaction(async (tx) => {
      const s = (await tx.get(ref)).data();
      if (!s || !s.ext || s.ext.id !== ext.id) return;
      const prev = s.ext.step;
      const next = { ...s.ext, status: info.status, step: info.step, label: info.label, version: info.version, updatedAt: now() };
      if (info.price) next.price = info.price;
      if (info.courier) next.courier = info.courier;
      if (info.pos) next.pos = info.pos;
      const patch = { ext: next, extActive: !FINAL.has(info.step) };
      const st = String(s.deliveryStatus || "");
      if (info.step !== prev) {
        changedStep = info.step;
        if (["toVenue", "onWay", "arrived"].includes(info.step)) patch.courierStage = info.step;
        if (["onWay", "arrived"].includes(info.step) && (st === "accepted" || st === "cooking")) {
          patch.deliveryStatus = "courier";
          patch.deliveryStatusAt = ts();
        }
        if (info.step === "done") {
          patch.courierStage = "done";
          if (st !== "cancelled") Object.assign(patch, { deliveryStatus: "done", deliveryStatusAt: ts(), deliveryOpen: false });
        }
        if (info.step === "cancelled" || info.step === "failed") {
          // Вызов не состоялся — заказ снова ждёт курьера (своего или новую службу).
          Object.assign(patch, { courierSet: false, courierStage: FieldValue.delete(), courierPos: FieldValue.delete() });
        }
      }
      if (info.pos && ["toVenue", "onWay", "arrived"].includes(info.step)) patch.courierPos = { lat: info.pos.lat, lng: info.pos.lng, at: Timestamp.fromMillis(info.pos.at || now()) };
      tx.update(ref, patch);
    });
    if (changedStep) {
      const who = PROVIDERS[ext.provider].short;
      const text = {
        toVenue: `🚕 ${who}: ${info.courier ? `курьер ${info.courier.name}${info.courier.car ? `, ${info.courier.car}` : ""} — ` : ""}едет в заведение`,
        onWay: `🚕 ${who}: курьер забрал заказ — везёт гостю`,
        arrived: `🚕 ${who}: курьер у гостя`,
        done: `✅ ${who}: заказ доставлен`,
        failed: `⚠️ ${who}: ${info.label.toLowerCase()} — назначьте другого курьера`,
        cancelled: `↩️ ${who}: ${info.label.toLowerCase()}`,
        approve: `💬 ${who}: цена выросла до ${rubText(info.price)} — подтвердите вызов в кабинете`,
      }[changedStep];
      if (text) await event(tenantId, ref.id, text);
    }
  }

  // ------------------------------------------------------------ сторож

  let polling = null;
  /** Один проход сторожа; второй вызов во время прохода ждёт его же. */
  function sweep() {
    if (!polling) polling = sweepOnce().finally(() => { polling = null; });
    return polling;
  }
  async function sweepOnce() {
    try {
      const snap = await db().collectionGroup("sessions").where("extActive", "==", true).get();
      for (const d of snap.docs) {
        const s = d.data();
        const tenantId = d.ref.parent.parent.id;
        const ext = s.ext;
        if (!ext || !PROVIDERS[ext.provider]) continue;
        try {
          const creds = await credsOf(tenantId, ext.provider);
          if (!creds) continue;
          const info = await infoOf(ext.provider, creds, ext);
          // Яндекс посчитал заявку: подтверждаем сами, если цена не выросла заметно.
          if (ext.provider === "yandex" && info.status === "ready_for_approval" && !ext.approveAsked) {
            const limit = (Number(ext.quoted) || 0) * PRICE_DRIFT;
            if (!ext.quoted || !info.price || info.price <= limit) {
              await Y.call(creds.token, `claims/accept?claim_id=${encodeURIComponent(ext.id)}`, { version: info.version });
              Object.assign(info, { status: "accepted", step: "search", label: "Ищем курьера" });
            } else {
              await d.ref.update({ "ext.approveAsked": true });
            }
          }
          await applyInfo(tenantId, d.ref, ext, info);
        } catch (e) {
          await d.ref.update({ "ext.error": clean(e.message, 200), "ext.errorAt": now() }).catch(() => {});
        }
      }
    } catch (e) {
      console.error("delivery-services sweep:", e.message || e);
    }
  }
  function start() {
    const t = setInterval(() => sweep().catch(() => {}), POLL_MS);
    if (t.unref) t.unref();
  }

  // ------------------------------------------------------------ кабинет

  const MANAGE = ["owner", "admin", "manager"];
  async function ctxOf(req, body) {
    const decoded = await verifyAuth(req);
    const tenantId = String(body.tenantId || "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new HttpError(400, "Не указано заведение");
    await requireTenantRole(tenantId, decoded.uid, MANAGE);
    return { uid: decoded.uid, tenantId };
  }

  /** Что подключено: для точки и (если точка в сети) для сети. */
  async function handleGet(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await ctxOf(req, body);
    const { tenant, roots } = await rootsOf(ctx.tenantId);
    const view = async (root) => {
      const d = (await servicesRef(root).get()).data() || {};
      return Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, d[p] && d[p].tokenEnc
        ? { connected: true, enabled: d[p].enabled !== false, mask: d[p].mask || "", taxiClass: d[p].taxiClass || "courier" }
        : { connected: false }]));
    };
    sendJson(res, 200, {
      providers: PROVIDERS,
      point: await view(roots[0]),
      ...(tenant.chainId ? { chain: await view(roots[1]) } : {}),
    });
  }

  /** Подключить, выключить или удалить ключ. forChain — ключ на всю сеть (владелец/админ сети). */
  async function handleSave(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await ctxOf(req, body);
    const provider = String(body.provider || "");
    if (!PROVIDERS[provider]) throw new HttpError(400, "Неизвестная служба доставки");
    const { tenant } = await rootsOf(ctx.tenantId);
    let root = `t_${ctx.tenantId}`;
    if (body.forChain) {
      if (!tenant.chainId) throw new HttpError(400, "Заведение не в сети");
      await requireChainRole(tenant.chainId, ctx.uid, ["owner", "admin"]);
      root = `c_${tenant.chainId}`;
    }
    const ref = servicesRef(root);
    if (body.remove === true) {
      await ref.set({ [provider]: FieldValue.delete() }, { merge: true });
      return sendJson(res, 200, { ok: true });
    }
    const patch = { enabled: body.enabled !== false, updatedAt: ts(), updatedBy: ctx.uid };
    if (provider === "yandex") patch.taxiClass = YANDEX_CLASSES.includes(body.taxiClass) ? body.taxiClass : "courier";
    const token = clean(body.token, 400);
    if (token) {
      if (token.length < 16 || /\s/.test(token)) throw new HttpError(400, "Ключ выглядит неверно — скопируйте его целиком из кабинета службы");
      // Проверка ключа: служба отвечает — ключ подходит.
      if (provider === "yandex") await Y.call(token, "claims/search", { offset: 0, limit: 1 });
      else await D.call(token, "orders?limit=1", undefined, "GET");
      patch.tokenEnc = encrypt(secretKey(), token);
      patch.mask = maskToken(token);
    } else {
      const cur = ((await ref.get()).data() || {})[provider];
      if (!cur || !cur.tokenEnc) throw new HttpError(400, "Вставьте ключ службы");
    }
    await ref.set({ [provider]: patch }, { merge: true });
    sendJson(res, 200, { ok: true });
  }

  /** Цена вызова сейчас: по каждой подключённой службе. */
  async function handleQuote(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await ctxOf(req, body);
    const o = await orderOf(ctx.tenantId, String(body.sessionId || ""));
    needAddresses(o);
    const out = [];
    for (const provider of Object.keys(PROVIDERS)) {
      const creds = await credsOf(ctx.tenantId, provider);
      if (!creds) continue;
      try {
        out.push({ provider, name: PROVIDERS[provider].name, ...(await quoteOf(provider, creds, o)) });
      } catch (e) {
        out.push({ provider, name: PROVIDERS[provider].name, error: e.message });
      }
    }
    if (!out.length) throw new HttpError(409, "Службы доставки не подключены: Кабинет → «Доставка» → «Службы доставки»");
    sendJson(res, 200, { quotes: out, unpaid: o.unpaid, toCollect: round2(Math.max(0, o.total - o.paid)) });
  }

  /** Вызвать курьера службы. */
  async function handleCall(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await ctxOf(req, body);
    const provider = String(body.provider || "");
    if (!PROVIDERS[provider]) throw new HttpError(400, "Неизвестная служба доставки");
    const creds = await credsOf(ctx.tenantId, provider);
    if (!creds) throw new HttpError(409, `${PROVIDERS[provider].name} не подключена: Кабинет → «Доставка» → «Службы доставки»`);
    const o = await orderOf(ctx.tenantId, String(body.sessionId || ""));
    needAddresses(o);
    if (o.s.ext && !FINAL.has(o.s.ext.step)) throw new HttpError(409, "К заказу уже вызван курьер службы");
    if (o.s.courierId) throw new HttpError(409, "Заказ уже у своего курьера — сначала снимите его");
    const st = String(o.s.deliveryStatus || "");
    if (["new", "done", "cancelled"].includes(st)) throw new HttpError(409, st === "new" ? "Сначала подтвердите заказ" : "Заказ уже закрыт");
    if (o.unpaid && body.unpaidOk !== true) {
      throw new HttpError(409, "Заказ не оплачен, а курьер службы деньги за еду не берёт. Попросите гостя оплатить онлайн или отметьте «гость оплатит сам»");
    }
    // Отметка «вызываем» — в транзакции: двойное нажатие не создаст двух заявок.
    await db().runTransaction(async (tx) => {
      const x = (await tx.get(o.ref)).data() || {};
      if (x.courierId || (x.ext && !FINAL.has(x.ext.step))) throw new HttpError(409, "К заказу уже назначен курьер");
      tx.update(o.ref, { ext: { provider, id: "", step: "creating", label: "Вызываем курьера", createdAt: now(), by: ctx.uid }, courierSet: true });
    });
    let claim;
    try {
      claim = await createClaim(provider, creds, o);
    } catch (e) {
      await o.ref.update({ ext: FieldValue.delete(), courierSet: false }).catch(() => {});
      throw e;
    }
    const quoted = Number(body.quoted) > 0 ? round2(body.quoted) : claim.price || null;
    const ext = {
      provider, id: claim.id, version: claim.version, status: claim.status,
      step: provider === "yandex" ? "estimating" : "search", label: provider === "yandex" ? "Считаем цену" : "Ищем курьера",
      createdAt: now(), by: ctx.uid, ...(quoted ? { quoted } : {}), ...(claim.price ? { price: claim.price } : {}),
      ...(claim.track ? { track: claim.track } : {}), ...(o.unpaid ? { unpaidOk: true } : {}),
    };
    await o.ref.update({ ext, extActive: true, courierSet: true });
    await event(ctx.tenantId, o.ref.id, `🚕 Вызван курьер: ${PROVIDERS[provider].name}${quoted ? ` · ~${rubText(quoted)}` : ""}`);
    // Яндекс считает заявку несколько секунд — первый опрос чуть позже.
    const t = setTimeout(() => sweep().catch(() => {}), 4000);
    if (t.unref) t.unref();
    changed(ctx.tenantId);
    sendJson(res, 200, { ok: true, ext });
  }

  /** Цена выросла — заведение подтверждает вызов само. */
  async function handleApprove(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await ctxOf(req, body);
    const o = await orderOf(ctx.tenantId, String(body.sessionId || ""));
    const ext = o.s.ext;
    if (!ext || ext.provider !== "yandex" || ext.status !== "ready_for_approval") throw new HttpError(409, "Подтверждать нечего");
    const creds = await credsOf(ctx.tenantId, ext.provider);
    if (!creds) throw new HttpError(409, "Ключ службы отключён");
    await Y.call(creds.token, `claims/accept?claim_id=${encodeURIComponent(ext.id)}`, { version: ext.version || 1 });
    await o.ref.update({ "ext.status": "accepted", "ext.step": "search", "ext.label": "Ищем курьера", "ext.approveAsked": FieldValue.delete() });
    changed(ctx.tenantId);
    sendJson(res, 200, { ok: true });
  }

  /** Отменить вызов. Платная отмена — только с confirmPaid. */
  async function handleCancel(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await ctxOf(req, body);
    const o = await orderOf(ctx.tenantId, String(body.sessionId || ""));
    const ext = o.s.ext;
    if (!ext || FINAL.has(ext.step)) throw new HttpError(409, "Вызова службы нет");
    const creds = await credsOf(ctx.tenantId, ext.provider);
    if (!creds) throw new HttpError(409, "Ключ службы отключён — отмените вызов в кабинете службы");
    if (ext.provider === "yandex") {
      const ci = await Y.call(creds.token, `claims/cancel-info?claim_id=${encodeURIComponent(ext.id)}`, {});
      const state = String(ci.cancel_state || "");
      if (state === "unavailable" || !state) throw new HttpError(409, "Яндекс уже не даёт отменить: курьер забрал заказ. Позвоните в поддержку службы");
      if (state === "paid" && body.confirmPaid !== true) {
        return sendJson(res, 200, { ok: false, paid: true, message: "Курьер уже в пути — отмена будет платной по тарифу службы. Отменить всё равно?" });
      }
      await Y.call(creds.token, `claims/cancel?claim_id=${encodeURIComponent(ext.id)}`, { cancel_state: state, version: ext.version || 1 });
    } else {
      await D.call(creds.token, "cancel-order", { order_id: Number(ext.id) || ext.id });
    }
    await applyInfo(ctx.tenantId, o.ref, ext, { status: "cancelled", step: "cancelled", label: "Вызов отменён", version: ext.version || 1 });
    await o.ref.update({ extActive: false });
    changed(ctx.tenantId);
    sendJson(res, 200, { ok: true });
  }

  /** Есть ли у точки подключённые службы — для кнопок в кабинете и боте. */
  async function connected(tenantId) {
    const out = [];
    for (const p of Object.keys(PROVIDERS)) if (await credsOf(tenantId, p).catch(() => null)) out.push(p);
    return out;
  }

  return { handleGet, handleSave, handleQuote, handleCall, handleApprove, handleCancel, sweep, start, connected, credsOf, infoOf, applyInfo };
}

module.exports = { createDeliveryServices, PROVIDERS, YANDEX_STATUS, DV_STATUS, splitAddress };
