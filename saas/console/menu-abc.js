// ABC-анализ меню — кабинет · «Обзор». Та же логика, что в отчётах кассы
// (lib/screens/admin/reports_screen.dart, _ReportStats.abc): позиции по
// выручке за период от большей к меньшей; A — пока накопленная доля до
// позиции меньше 80%, B — меньше 95%, остальное — C. Выручка позиции — цена ×
// количество в чеке (как на кассе). Возвращённые, закрытые без оплаты и
// учебные чеки не считаются.

/** @returns {{items: Array<{key,name,menuItemId,qty,revenue,share,cls}>, total:number, checks:number, unsold:Array<{id,name}>}} */
export function menuAbc(sessions, menuItems = []) {
  const byItem = new Map();
  let checks = 0;
  for (const s of sessions || []) {
    if (!s || s.refunded === true || s.closedWithoutPayment === true || s.training === true) continue;
    checks++;
    for (const it of Array.isArray(s.orderItems) ? s.orderItems : []) {
      const qty = Number(it.qty) || 0;
      if (qty <= 0) continue;
      const name = String(it.name || '').trim() || 'Без названия';
      const id = String(it.menuItemId || '');
      const key = id || name;
      const row = byItem.get(key) || { key, name, menuItemId: id, qty: 0, revenue: 0 };
      row.qty += qty;
      row.revenue += (Number(it.price) || 0) * qty;
      byItem.set(key, row);
    }
  }
  const items = [...byItem.values()].sort((a, b) => b.revenue - a.revenue || b.qty - a.qty || a.name.localeCompare(b.name, 'ru'));
  const total = items.reduce((a, i) => a + i.revenue, 0);
  let acc = 0;
  for (const i of items) {
    const before = total <= 0 ? 1 : acc / total;
    i.cls = before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C';
    i.share = total > 0 ? i.revenue / total : 0;
    i.revenue = Math.round(i.revenue * 100) / 100;
    acc += i.revenue;
  }
  // Позиции меню, которые за период не продались ни разу (выключенные и
  // служебные — не в счёт).
  const soldIds = new Set(items.map((i) => i.menuItemId).filter(Boolean));
  const soldNames = new Set(items.map((i) => i.name.toLowerCase()));
  const unsold = (menuItems || [])
    .filter((m) => m && m.id && m.available !== false && !String(m.id).startsWith('zalpos_'))
    .filter((m) => !soldIds.has(m.id) && !soldNames.has(String(m.name || '').trim().toLowerCase()))
    .map((m) => ({ id: m.id, name: String(m.name || '').trim() || 'Без названия' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { items, total: Math.round(total * 100) / 100, checks, unsold };
}

/** Сводка по классам: сколько позиций и какая доля выручки. */
export function abcSummary(items) {
  const out = { A: { count: 0, revenue: 0 }, B: { count: 0, revenue: 0 }, C: { count: 0, revenue: 0 } };
  for (const i of items) { out[i.cls].count++; out[i.cls].revenue += i.revenue; }
  return out;
}
