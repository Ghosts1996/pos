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
 *     поле района (null) — берётся базовое значение; район из списка районов
 *     города (кабинет → «Районы города») несёт ещё osm (id границы) и poly —
 *     контур [[[lng, lat], …], …]: гость отметил точку — район выбирается сам;
 *   payAtDoor {cash, card, qr} — что курьер может принять при вручении;
 *   liveInTelegram — живая точка курьера в чате (координаты уходят за рубеж);
 *   courierLink — кнопка «Ссылка курьеру» в карточке для курьеров без приложения;
 *   byKm {on, baseKm, perKm, maxKm} — цена по расстоянию (по дорогам, своя
 *     карта): в базовую цену входит baseKm км, дальше perKm ₽ за каждый
 *     начатый км; maxKm — дальше не возим (0 — без предела). Работает, когда
 *     гость отметил точку на карте; без точки — базовая цена или районы;
 *   markupPct — наценка на блюда в доставке, % (0 — цены как в зале);
 *     у позиции может быть своя цена в доставке — menuItems.deliveryPrice.
 */

/** id «позиции» доставки в строке чека: по нему касса узнаёт услугу. */
const DELIVERY_ITEM_ID = "zalpos_delivery";
const MAX_ZONES = 80; // районы города по карте: у Москвы рядом с заведением их бывает много
const MAX_MARKUP_PCT = 100;
const MAX_RUB = 100000;
const DEFAULT_ETA_MIN = 60;
/** Контур района: не больше стольких точек (их читает каждый заказ). */
const MAX_POLY_POINTS = 600;
const { whichContains } = require("./map-districts");

const DEFAULTS = Object.freeze({
  fee: 0,
  freeFrom: 0,
  minOrder: 0,
  etaMin: DEFAULT_ETA_MIN,
  zones: [],
  payAtDoor: { cash: true, card: false, qr: true },
  liveInTelegram: false,
  courierLink: true,
  markupPct: 0,
  byKm: { on: false, baseKm: 3, perKm: 30, maxKm: 0 },
});

/** Настройки «по расстоянию»: км 0…100 (шаг 0,5), ₽ за км 0…1000. */
function byKmOf(v) {
  const r = v && typeof v === "object" ? v : {};
  const km = (x, d) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? Math.min(100, Math.round(n * 2) / 2) : d; };
  const per = Number(r.perKm);
  return {
    on: r.on === true,
    baseKm: km(r.baseKm, DEFAULTS.byKm.baseKm),
    perKm: Number.isFinite(per) && per >= 0 ? Math.min(1000, Math.round(per)) : DEFAULTS.byKm.perKm,
    maxKm: km(r.maxKm, 0),
  };
}

/**
 * Ориентиры цен доставки по регионам — чтобы заведение не начинало с нуля.
 * Основа — средняя цена курьерской доставки по данным Росстата за сентябрь
 * 2026 г. (Россия 259 ₽, Москва 584 ₽, Подмосковье 440 ₽, Санкт-Петербург
 * 286 ₽, Ленинградская область 165 ₽), приведённая к доставке еды на
 * 3–5 км; города-миллионники — между Петербургом и средним по стране.
 * Это подсказка: заведение ставит свои цены. Ставки курьеру — за заказ и за км.
 */
const REGION_PRESETS = Object.freeze([
  { id: "moscow", name: "Москва", lat: 55.7558, lng: 37.6173, km: 22, fee: 349, baseKm: 3, perKm: 45, maxKm: 15, freeFrom: 3500, minOrder: 1000, etaMin: 60, ratePerTrip: 180, ratePerKm: 25 },
  { id: "spb", name: "Санкт-Петербург", lat: 59.9386, lng: 30.3141, km: 22, fee: 249, baseKm: 3, perKm: 35, maxKm: 15, freeFrom: 2500, minOrder: 800, etaMin: 60, ratePerTrip: 140, ratePerKm: 20 },
  { id: "mo", name: "Московская область", lat: 55.7558, lng: 37.6173, km: 95, fee: 299, baseKm: 3, perKm: 40, maxKm: 15, freeFrom: 3000, minOrder: 900, etaMin: 60, ratePerTrip: 160, ratePerKm: 22 },
  { id: "lo", name: "Ленинградская область", lat: 59.9386, lng: 30.3141, km: 130, fee: 179, baseKm: 3, perKm: 30, maxKm: 15, freeFrom: 2000, minOrder: 700, etaMin: 60, ratePerTrip: 110, ratePerKm: 18 },
  ...[
    ["Новосибирск", 55.0302, 82.9204], ["Екатеринбург", 56.8389, 60.6057], ["Казань", 55.7961, 49.1064],
    ["Нижний Новгород", 56.3269, 44.0059], ["Челябинск", 55.1644, 61.4368], ["Красноярск", 56.0153, 92.8932],
    ["Самара", 53.1959, 50.1002], ["Уфа", 54.7388, 55.9721], ["Ростов-на-Дону", 47.2357, 39.7015],
    ["Омск", 54.9885, 73.3242], ["Краснодар", 45.0355, 38.9753], ["Воронеж", 51.6608, 39.2003],
    ["Пермь", 58.0105, 56.2502], ["Волгоград", 48.708, 44.5133],
  ].map(([name, lat, lng]) => ({ id: "million", name, lat, lng, km: 25, fee: 199, baseKm: 3, perKm: 30, maxKm: 15, freeFrom: 2000, minOrder: 700, etaMin: 60, ratePerTrip: 110, ratePerKm: 18 })),
]);
const REGION_DEFAULT = Object.freeze({ id: "ru", name: "Россия (средние цены)", fee: 169, baseKm: 3, perKm: 25, maxKm: 12, freeFrom: 1500, minOrder: 600, etaMin: 60, ratePerTrip: 100, ratePerKm: 15 });

/** Ориентир цен для точки на карте (pos {lat, lng}); без точки — средний по стране. */
function regionPreset(pos) {
  const lat = Number(pos && pos.lat), lng = Number(pos && pos.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) {
    for (const r of REGION_PRESETS) {
      const dy = (lat - r.lat) * 111.2;
      const dx = (lng - r.lng) * 111.2 * Math.cos((lat * Math.PI) / 180);
      if (Math.hypot(dx, dy) <= r.km) {
        const { lat: _a, lng: _b, km: _c, ...rest } = r;
        return rest;
      }
    }
  }
  return { ...REGION_DEFAULT };
}

/** Наценка 0…100 % с шагом 0,5. */
function markupOf(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_MARKUP_PCT, Math.round(n * 2) / 2);
}

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

/** Контур района из кабинета → безопасный (числа, кольца ≥4 точек) или null. */
function polyOf(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 40) return null;
  const rings = [];
  let n = 0;
  for (const r of raw) {
    if (!Array.isArray(r) || r.length < 4) continue;
    const ring = [];
    for (const p of r) {
      const lng = Number(p && p[0]);
      const lat = Number(p && p[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
      ring.push([Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
    }
    n += ring.length;
    if (n > MAX_POLY_POINTS) return null;
    rings.push(ring);
  }
  return rings.length ? rings : null;
}

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
    const poly = polyOf(z.poly);
    zones.push({
      id,
      name,
      fee: zoneNum(z.fee, rub),
      minOrder: zoneNum(z.minOrder, rub),
      freeFrom: zoneNum(z.freeFrom, rub),
      etaMin: zoneNum(z.etaMin, minutes),
      ...(poly ? { poly, osm: /^[rw]\d{1,15}$/.test(String(z.osm || "")) ? String(z.osm) : "" } : {}),
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
    markupPct: markupOf(r.markupPct),
    byKm: byKmOf(r.byKm),
  };
}

/**
 * Цена одной штуки в доставке. Своя цена позиции (deliveryPrice) заменяет
 * цену из меню, добавки — с наценкой; без своей цены — вся сумма с
 * наценкой. Округление — вверх до рубля, чтобы цены были ровные.
 *  base — цена позиции из меню, mods — сумма добавок, own — deliveryPrice.
 * Та же функция — в веб-версии гостя (deliveryUnit), проверяется тестом.
 */
function deliveryUnit(base, mods, own, markupPct) {
  const pct = markupOf(markupPct);
  const up = (v) => (pct > 0 ? Math.ceil(Math.round(v * (100 + pct)) / 100 - 1e-9) : Math.round(v * 100) / 100);
  const m = Math.max(0, Number(mods) || 0);
  const o = Number(own);
  if (Number.isFinite(o) && o > 0) return Math.round((o + up(m)) * 100) / 100;
  return up(Math.max(0, Number(base) || 0) + m);
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
  const mk = r.markupPct;
  if (mk !== undefined && mk !== null && mk !== "" && !(Number.isFinite(Number(mk)) && Number(mk) >= 0 && Number(mk) <= MAX_MARKUP_PCT)) {
    return `Наценка на доставку — от 0 до ${MAX_MARKUP_PCT} %`;
  }
  const bk = r.byKm && typeof r.byKm === "object" ? r.byKm : null;
  if (bk) {
    const okKm = (v) => v === undefined || v === null || v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100);
    if (!okKm(bk.baseKm)) return "Километры в базовой цене — от 0 до 100";
    if (!okKm(bk.maxKm)) return "«Не дальше, км» — от 0 до 100";
    if (bk.perKm !== undefined && bk.perKm !== null && bk.perKm !== "" && !(Number(bk.perKm) >= 0 && Number(bk.perKm) <= 1000)) return "Цена за километр — от 0 до 1000 ₽";
  }
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
    if (z.poly !== undefined && z.poly !== null && !polyOf(z.poly)) return `Район «${name}»: граница района повреждена — выберите его из списка заново`;
  }
  return "";
}

/** Точка гостя {lat, lng} → числа или null. */
function zonePoint(p) {
  const lat = Number(p && p.lat);
  const lng = Number(p && p.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng) ? { lat, lng } : null;
}

/** Районы для гостя: без контуров (лишний трафик), с отметкой «по карте». */
function zonesForGuest(zones) {
  return (zones || []).map(({ poly, osm, ...z }) => ({ ...z, ...(poly ? { area: true } : {}) }));
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
function quote(settings, subtotal, zoneIdIn = "", { legacy = false, distM = null, point = null } = {}) {
  const s = normalizeSettings(settings);
  const sum = Math.max(0, Number(subtotal) || 0);
  let zone = null;
  // Районы города с границами: гость отметил точку — район по точке (сам
  // выбирать не должен). Точка вне всех районов — не доставляем, если
  // заведение задало только районы по карте; иначе — район вручную.
  const at = zonePoint(point);
  const mapped = s.zones.filter((z) => z.poly);
  let auto = null;
  if (at && mapped.length && !legacy) {
    const i = whichContains(mapped.map((z) => z.poly), at.lat, at.lng);
    if (i >= 0) auto = mapped[i];
    else if (mapped.length === s.zones.length && !(s.byKm.on && distM !== null && distM !== undefined)) {
      return { ok: false, outOfArea: true, error: "Сюда не доставляем: точка вне районов доставки заведения. Проверьте адрес или выберите самовывоз" };
    }
  }
  if (auto) zoneIdIn = auto.id;
  // Цена по расстоянию: гость отметил точку — район выбирать не нужно.
  const d = Number(distM);
  const far = s.byKm.on && !legacy && distM !== null && distM !== undefined && Number.isFinite(d) && d >= 0;
  const km = far ? Math.round(d / 100) / 10 : null;
  if (far && s.byKm.maxKm > 0 && km > s.byKm.maxKm) {
    return { ok: false, tooFar: true, km, error: `Сюда не доставляем: до вас ${String(km).replace(".", ",")} км, возим не дальше ${String(s.byKm.maxKm).replace(".", ",")} км. Можно оформить самовывоз` };
  }
  if (!far && s.zones.length && !legacy) {
    const id = String(zoneIdIn || "");
    if (!id) return { ok: false, error: "Выберите район доставки", zones: s.zones };
    zone = s.zones.find((z) => z.id === id) || null;
    if (!zone) return { ok: false, error: "Такого района больше нет — обновите страницу и выберите район", zones: s.zones };
  }
  const pick = (k) => (zone && zone[k] !== null && zone[k] !== undefined ? zone[k] : s[k]);
  const minOrder = pick("minOrder");
  const freeFrom = pick("freeFrom");
  const etaMin = pick("etaMin");
  const extraKm = far ? Math.max(0, Math.ceil(km - s.byKm.baseKm - 1e-9)) : 0;
  const base = pick("fee") + extraKm * s.byKm.perKm;
  const short = minOrder > 0 && sum < minOrder ? Math.ceil(minOrder - sum) : 0;
  const free = freeFrom > 0 && sum >= freeFrom;
  const fee = free ? 0 : base;
  const toFree = !free && freeFrom > 0 && base > 0 ? Math.ceil(freeFrom - sum) : 0;
  const out = {
    ok: short === 0,
    fee,
    zone: zone ? { id: zone.id, name: zone.name } : null,
    ...(auto ? { autoZone: true } : {}),
    minOrder,
    freeFrom,
    etaMin,
    toFree,
    short,
    ...(far ? { km, extraKm } : {}),
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
  DELIVERY_ITEM_ID, DEFAULTS, MAX_ZONES, MAX_MARKUP_PCT,
  REGION_PRESETS, regionPreset, byKmOf,
  normalizeSettings, settingsProblem, quote, feeLine, isFeeLine, deliveryBlock, fmtRub, deliveryUnit, markupOf, zonesForGuest, MAX_POLY_POINTS,
};
