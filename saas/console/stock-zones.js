// Мульти-склад: где лежит остаток позиции — основной склад, бар, кухня,
// кальянная. Общий остаток (quantity) не делится и не меняется: в позиции
// хранится только сколько из него выдано в цеха — zones: {bar, kitchen,
// hookah}. Основной склад = quantity − всё, что в цехах. Поэтому кассы,
// отчёты, приходы и инвентаризация работают как раньше, а перемещение —
// это только перестановка внутри позиции (+ запись в журнале движений).
// Продажа на кассе (SaaS) списывает сначала из своего цеха (вид категории:
// кухня/бар/кальяны), не хватило — остальное с основного склада.

export const STOCK_ZONES = [
  { id: 'main', label: 'Основной склад' },
  { id: 'bar', label: 'Бар' },
  { id: 'kitchen', label: 'Кухня' },
  { id: 'hookah', label: 'Кальянная' },
];
export const WORKSHOP_ZONES = ['bar', 'kitchen', 'hookah'];

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

export function zoneLabel(id) {
  return (STOCK_ZONES.find((z) => z.id === id) || { label: id }).label;
}

/** Остатки по местам: {main, bar, kitchen, hookah}. Цеха не уходят в минус на экране. */
export function zoneBalances(item) {
  const zones = item && typeof item.zones === 'object' && item.zones ? item.zones : {};
  const out = { main: 0 };
  let inWorkshops = 0;
  for (const z of WORKSHOP_ZONES) {
    const v = Math.max(0, r3(zones[z]));
    out[z] = v;
    inWorkshops += v;
  }
  out.main = r3((Number(item && item.quantity) || 0) - inWorkshops);
  return out;
}

/** Есть ли у позиции что-то в цехах (показывать раскладку). */
export function hasZones(item) {
  const b = zoneBalances(item);
  return WORKSHOP_ZONES.some((z) => b[z] > 0);
}

/**
 * Перемещение qty из from в to. Возвращает изменения полей для записи
 * приращениями ({'zones.bar': +2, 'zones.kitchen': -2}) — так две записи
 * подряд с разных устройств не затирают друг друга.
 */
export function planTransfer(item, from, to, qty) {
  const ids = STOCK_ZONES.map((z) => z.id);
  if (!ids.includes(from) || !ids.includes(to)) throw new Error('Выберите, откуда и куда');
  if (from === to) throw new Error('Откуда и куда — одно и то же место');
  const q = r3(qty);
  if (!(q > 0)) throw new Error('Укажите количество больше нуля');
  const have = zoneBalances(item)[from];
  if (q > have + 1e-9) throw new Error(`В месте «${zoneLabel(from)}» только ${have.toLocaleString('ru-RU')}`);
  const inc = {};
  if (from !== 'main') inc[`zones.${from}`] = -q;
  if (to !== 'main') inc[`zones.${to}`] = q;
  return { qty: q, inc };
}
