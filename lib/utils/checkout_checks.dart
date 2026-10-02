import '../models/inventory_models.dart';
import '../models/menu_models.dart';
import '../models/session_model.dart';

/// Чего не хватает на складе, чтобы списать проданное по чеку.
class StockShortage {
  final String name;
  final InventoryUnit unit;
  final double need;
  final double have;

  const StockShortage({required this.name, required this.unit, required this.need, required this.have});

  String get text => '«$name» — нужно ${unit.formatWithLabel(need)}, на складе ${unit.formatWithLabel(have < 0 ? 0 : have)}';
}

/// Сколько каждой позиции склада уйдёт по строкам чека — тем же правилом,
/// что и списание после оплаты (FirestoreService._deductInventoryForSale):
/// граммовка позиции меню или её компонентов в единицах склада × количество.
Map<String, double> stockNeeds(
  Iterable<OrderItem> items,
  Map<String, MenuItem> menu,
  Map<String, InventoryItem> stock,
) {
  final need = <String, double>{};
  void add(String invId, double weight, InventoryUnit weightUnit, int qty) {
    final inv = stock[invId];
    if (invId.isEmpty || weight <= 0 || inv == null) return;
    need[invId] = (need[invId] ?? 0) + weightUnit.convertTo(weight, inv.unit) * qty;
  }

  for (final line in items) {
    final m = menu[line.menuItemId];
    if (m == null || !m.hasAnyInventoryLink) continue;
    if (m.isComposite) {
      for (final c in m.components) {
        add(c.inventoryItemId, c.weight, c.weightUnit, line.qty);
      }
    } else {
      add(m.inventoryItemId, m.weight, m.weightUnit, line.qty);
    }
  }
  return need;
}

/// Позиции склада, остатка которых не хватает на чек. Выключенные из учёта
/// не проверяем.
List<StockShortage> stockShortages(
  Iterable<OrderItem> items,
  Map<String, MenuItem> menu,
  Map<String, InventoryItem> stock,
) {
  final out = <StockShortage>[];
  stockNeeds(items, menu, stock).forEach((id, need) {
    final inv = stock[id]!;
    if (inv.active && need - inv.quantity > 1e-6) {
      out.add(StockShortage(name: inv.name, unit: inv.unit, need: need, have: inv.quantity));
    }
  });
  out.sort((a, b) => a.name.compareTo(b.name));
  return out;
}

String _rub(double v) {
  final s = v.toStringAsFixed(v == v.roundToDouble() ? 0 : 2);
  final parts = s.split('.');
  final whole = parts[0].replaceAllMapped(RegExp(r'(\d)(?=(\d{3})+$)'), (m) => '${m[1]} ');
  return '${parts.length > 1 ? '$whole,${parts[1]}' : whole} ₽';
}

/// Что поменялось в чеке, пока был открыт экран оплаты: кассир видит, что
/// именно добавили или убрали с другого устройства (или что его правки ещё
/// не дошли до сервера), а не просто «счёт изменился».
String describeBillChange({
  required List<OrderItem> seen,
  required double seenTotal,
  required List<OrderItem> actual,
  required double actualTotal,
  required double seenDiscount,
  required double actualDiscount,
}) {
  Map<String, ({String name, int qty})> byKey(List<OrderItem> list) {
    final m = <String, ({String name, int qty})>{};
    for (final i in list) {
      final k = i.menuItemId.isNotEmpty ? i.menuItemId : i.name;
      m[k] = (name: i.name, qty: (m[k]?.qty ?? 0) + i.qty);
    }
    return m;
  }

  final before = byKey(seen);
  final after = byKey(actual);
  final added = <String>[];
  final removed = <String>[];
  for (final k in {...before.keys, ...after.keys}) {
    final b = before[k]?.qty ?? 0;
    final a = after[k]?.qty ?? 0;
    final name = after[k]?.name ?? before[k]!.name;
    if (a > b) added.add('$name ×${a - b}');
    if (b > a) removed.add('$name ×${b - a}');
  }
  final parts = <String>[];
  if (added.isNotEmpty) parts.add('добавили ${added.join(', ')}');
  if (removed.isNotEmpty) parts.add('убрали ${removed.join(', ')}');
  if ((seenDiscount - actualDiscount).abs() > 0.001) {
    parts.add('скидка теперь ${actualDiscount.toStringAsFixed(actualDiscount == actualDiscount.roundToDouble() ? 0 : 1)}%');
  }
  final what = parts.isEmpty ? 'изменились позиции' : parts.join('; ');
  return 'Чек изменился, пока была открыта оплата: $what. '
      'Сумма теперь ${_rub(actualTotal)} вместо ${_rub(seenTotal)} — откройте оплату заново';
}
