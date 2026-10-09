import '../models/menu_models.dart';
import '../models/session_model.dart';

/// Бонусы за продажу позиций одного сотрудника: сумма и сколько каких
/// позиций продал.
class ItemBonus {
  double amount = 0;
  final Map<String, int> qtyByItem = {};
}

/// Бонусы «за каждую проданную штуку» (MenuItem.staffBonus) по сотрудникам:
/// начисляется автору штук в счёте (OrderItem.by). Возвраты и чеки без
/// оплаты не считаются; ставка — текущая из меню.
Map<String, ItemBonus> itemBonuses(Iterable<SessionModel> sessions, Map<String, MenuItem> menu) {
  final out = <String, ItemBonus>{};
  for (final s in sessions) {
    if (s.refunded || s.closedWithoutPayment) continue;
    for (final line in s.orderItems) {
      final m = menu[line.menuItemId];
      if (m == null || m.staffBonus <= 0) continue;
      line.by.forEach((employeeId, qty) {
        if (qty <= 0) return;
        final b = out.putIfAbsent(employeeId, ItemBonus.new);
        b.amount += m.staffBonus * qty;
        b.qtyByItem[m.name] = (b.qtyByItem[m.name] ?? 0) + qty;
      });
    }
  }
  return out;
}
