"use strict";
/**
 * Цена доставки точки: настройки, расчёт, строка «Доставка» в чеке.
 * Чистые функции — без базы: их зовут заказ гостя (guest-delivery.js),
 * подсказка цены гостю, кабинет и приложение курьера. Описание —
 * docs/delivery.md, раздел 3.
 *
 * Настройки — tenants/{t}/settings/delivery (пишет только шлюз из кабинета):
 *   fee, freeFrom, minOrder, etaMin — базовые цены, ₽ и минуты;
 *   zones[] — районы {id, name, fee, minOrder, freeFrom, etaMin}; пустое
 *     поле района (null) — берётся базовое значение;
 *   payAtDoor {cash, card, qr} — что курьер может принять при вручении;
 *   liveInTelegram — живая точка курьера в чате (координаты уходят за рубеж);
 *   courierLink — кнопка «Ссылка курьеру» в карточке для курьеров без приложения.
 */

/** id «позиции» доставки в строке чека: по нему касса узнаёт услугу. */
const DELIVERY_ITEM_ID = "zalpos_delivery";
const MAX_ZONES = 30;
const MAX_RUB = 100000;
const DEFAULT_ETA_MIN = 60;

const DEFAULTS = Object.freeze({
  fee: 0,
  freeFrom: 0,
  minOrder: 0,
  etaMin: DEFAULT_ETA_MIN,
  zones: [],
  payAtDoor: { cash: true, card: false, qr: true },
  liveInTelegram: false,
  courierLink: true,
});

const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Целые рубли 0…100 000; мусор → fallback. */
function rub(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_RUB) : fallback;
}

/** Минуты доставки 10…600; мусор → fallback. */
function minutes(v, fallback = DEFAULT_ETA_MIN) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.max(10, Math.min(n, 600)) : fallback;
}

/** Поле района: число или null («как базовое»). */
const zoneNum = (v, fn) => (v === null || v === undefined || v === "" ? null : fn(v, null));

/** id района: из названия латиницей нельзя — берём то, что пришло, или порядковый. */
function zoneId(raw, i) {
  const s = String(raw || "").trim();
  return /^[A-Za-z0-9_-]{1,32}$/.test(s) ? s : `z${i + 1}`;
}

/** Настройки из базы → полные и безопасные (недостающее — по умолчанию). */
function normalizeSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const pay = r.payAtDoor && typeof r.payAtDoor === "object" ? r.payAtDoor : {};
  const seen = new Set();
  const zones = [];
  for (const [i, z] of (Array.isArray(r.zones) ? r.zones : []).entries()) {
    if (!z || typeof z !== "object") continue;
    const name = clean(z.name, 40);
    if (!name) continue;
    let id = zoneId(z.id, i);
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    zones.push({
      id,
      name,
      fee: zoneNum(z.fee, rub),
      minOrder: zoneNum(z.minOrder, rub),
      freeFrom: zoneNum(z.freeFrom, rub),
      etaMin: zoneNum(z.etaMin, minutes),
    });
    if (zones.length >= MAX_ZONES) break;
  }
  return {
    fee: rub(r.fee, DEFAULTS.fee),
    freeFrom: rub(r.freeFrom, DEFAULTS.freeFrom),
    minOrder: rub(r.minOrder, DEFAULTS.minOrder),
    etaMin: minutes(r.etaMin, DEFAULTS.etaMin),
    zones,
    payAtDoor: {
      cash: typeof pay.cash === "boolean" ? pay.cash : DEFAULTS.payAtDoor.cash,
      card: typeof pay.card === "boolean" ? pay.card : DEFAULTS.payAtDoor.card,
      qr: typeof pay.qr === "boolean" ? pay.qr : DEFAULTS.payAtDoor.qr,
    },
    liveInTelegram: r.liveInTelegram === true,
    courierLink: r.courierLink !== false,
  };
}

/**
 * Проверка того, что владелец ввёл в кабинете: понятная ошибка вместо
 * молчаливой подмены. → текст ошибки или "".
 */
function settingsProblem(input) {
  const r = input && typeof input === "object" ? input : {};
  const bad = (v) => v !== null && v !== undefined && v !== "" && !(Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= MAX_RUB);
  if (bad(r.fee)) return "Стоимость доставки — от 0 до 100 000 ₽";
  if (bad(r.freeFrom)) return "«Бесплатно от» — от 0 до 100 000 ₽";
  if (bad(r.minOrder)) return "Минимальный заказ — от 0 до 100 000 ₽";
  const eta = r.etaMin;
  if (eta !== undefined && eta !== null && eta !== "" && !(Number(eta) >= 10 && Number(eta) <= 600)) return "Время доставки — от 10 до 600 минут";
  const zones = Array.isArray(r.zones) ? r.zones : [];
  if (zones.length > MAX_ZONES) return `Районов — не больше ${MAX_ZONES}`;
  const names = new Set();
  for (const z of zones) {
    const name = clean(z && z.name, 40);
    if (!name) return "У каждого района должно быть название";
    const key = name.toLowerCase();
    if (names.has(key)) return `Район «${name}» указан дважды`;
    names.add(key);
    if (bad(z.fee) || bad(z.minOrder) || bad(z.freeFrom)) return `Район «${name}»: суммы — от 0 до 100 000 ₽`;
    if (z.etaMin !== undefined && z.etaMin !== null && z.etaMin !== "" && !(Number(z.etaMin) >= 10 && Number(z.etaMin) <= 600)) {
      return `Район «${name}»: время — от 10 до 600 минут`;
    }
  }
  return "";
}

const fmtRub = (n) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₽`;

/**
 * Цена доставки для суммы блюд [subtotal].
 *  zoneId — выбранный гостем район; legacy — клиент районов не знает
 *  (старое приложение, заказ по телефону): берутся базовые цены.
 * → { ok, fee, zone, minOrder, freeFrom, etaMin, toFree, short, error }
 *   toFree — сколько добавить до бесплатной доставки (0 — не нужно/нельзя);
 *   short — сколько не хватает до минимального заказа.
 */
function quote(settings, subtotal, zoneIdIn = "", { legacy = false } = {}) {
  const s = normalizeSettings(settings);
  const sum = Math.max(0, Number(subtotal) || 0);
  let zone = null;
  if (s.zones.length && !legacy) {
    const id = String(zoneIdIn || "");
    if (!id) return { ok: false, error: "Выберите район доставки", zones: s.zones };
    zone = s.zones.find((z) => z.id === id) || null;
    if (!zone) return { ok: false, error: "Такого района больше нет — обновите страницу и выберите район", zones: s.zones };
  }
  const pick = (k) => (zone && zone[k] !== null && zone[k] !== undefined ? zone[k] : s[k]);
  const minOrder = pick("minOrder");
  const freeFrom = pick("freeFrom");
  const etaMin = pick("etaMin");
  const base = pick("fee");
  const short = minOrder > 0 && sum < minOrder ? Math.ceil(minOrder - sum) : 0;
  const free = freeFrom > 0 && sum >= freeFrom;
  const fee = free ? 0 : base;
  const toFree = !free && freeFrom > 0 && base > 0 ? Math.ceil(freeFrom - sum) : 0;
  const out = {
    ok: short === 0,
    fee,
    zone: zone ? { id: zone.id, name: zone.name } : null,
    minOrder,
    freeFrom,
    etaMin,
    toFree,
    short,
  };
  if (short) out.error = `Минимальный заказ на доставку — ${fmtRub(minOrder)}: добавьте ещё на ${fmtRub(short)}`;
  return out;
}

/**
 * Строка «Доставка» для orderItems — как её пишет касса (OrderItem.toMap):
 *  kind kitchen — иначе касса по noPromo сочтёт её кальяном;
 *  noPromo — скидки и бонусы на доставку не действуют;
 *  ready = accepted = served = qty — не ждёт цех и не просится «отдать».
 * Бесплатная доставка строки не даёт.
 */
function feeLine(fee, zoneName = "") {
  const price = rub(fee, 0);
  if (price <= 0) return null;
  return {
    menuItemId: DELIVERY_ITEM_ID,
    name: zoneName ? `Доставка · ${clean(zoneName, 40)}` : "Доставка",
    price,
    qty: 1,
    noPromo: true,
    kind: "kitchen",
    ready: 1,
    accepted: 1,
    served: 1,
    sent: 1,
  };
}

const isFeeLine = (i) => !!i && i.menuItemId === DELIVERY_ITEM_ID;

/**
 * Доставляет ли точка позицию: закон (banned — remoteSaleBanned) и выбор
 * заведения (галочка у позиции или у её категории).
 * → "" — можно; "law" — нельзя по закону; "venue" — заведение не доставляет.
 */
function deliveryBlock(item, category, banned) {
  if (banned) return "law";
  if (item && item.deliveryOff === true) return "venue";
  if (category && category.deliveryOff === true) return "venue";
  return "";
}

module.exports = {
  DELIVERY_ITEM_ID, DEFAULTS, MAX_ZONES,
  normalizeSettings, settingsProblem, quote, feeLine, isFeeLine, deliveryBlock, fmtRub,
};
