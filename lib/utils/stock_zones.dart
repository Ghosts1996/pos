/// Мульти-склад (SaaS): из какого цеха списать проданное.
///
/// Общий остаток позиции склада (quantity) списывается как всегда; здесь —
/// только сколько из него убрать из цехов (`zones.bar/kitchen/hookah`),
/// куда продукты переместили в кабинете. Цех — по виду позиции меню
/// (кухня / бар / кальяны, [SaleKind]). В цехе меньше, чем продано, —
/// остальное уходит с основного склада (он = quantity − всё в цехах).
library;

import '../models/inventory_models.dart';
import '../models/menu_models.dart';
import '../models/session_model.dart';
import 'recipe_math.dart';

const List<String> kStockWorkshops = ['bar', 'kitchen', 'hookah'];

/// Есть ли у кого-то из [stock] продукты в цехах — иначе считать нечего.
bool anyZones(Iterable<InventoryItem> stock) =>
    stock.any((i) => i.zones.entries.any((e) => kStockWorkshops.contains(e.key) && e.value > 0));

/// {позиция склада: {цех: сколько убрать из цеха}} по строкам чека.
/// [kindOf] — цех позиции меню (`SaleKind.forMenuItem`).
Map<String, Map<String, double>> zoneDraws(
  List<OrderItem> orderItems,
  Map<String, MenuItem> menu,
  Map<String, InventoryItem> stock,
  String Function(MenuItem item) kindOf,
) {
  if (!anyZones(stock.values)) return const {};
  final byKind = <String, List<OrderItem>>{};
  for (final o in orderItems) {
    final m = menu[o.menuItemId];
    if (m == null) continue;
    final k = kindOf(m);
    if (!kStockWorkshops.contains(k)) continue;
    byKind.putIfAbsent(k, () => []).add(o);
  }
  final left = <String, Map<String, double>>{
    for (final i in stock.values) i.id: {for (final w in kStockWorkshops) w: (i.zones[w] ?? 0) > 0 ? i.zones[w]! : 0},
  };
  final out = <String, Map<String, double>>{};
  byKind.forEach((kind, lines) {
    for (final d in saleDraws(lines, menu, stock).values) {
      final have = left[d.inventoryItemId]?[kind] ?? 0;
      if (have <= 0) continue;
      final take = d.qty < have ? d.qty : have;
      left[d.inventoryItemId]![kind] = have - take;
      final m = out.putIfAbsent(d.inventoryItemId, () => {});
      m[kind] = double.parse(((m[kind] ?? 0) + take).toStringAsFixed(6));
    }
  });
  return out;
}

/// Поля для update/tx.update: `zones.bar: increment(-n)` — только ключи.
Map<String, double> zoneDecrements(Map<String, double> byKind) => {
      for (final e in byKind.entries)
        if (e.value > 0) 'zones.${e.key}': -e.value,
    };
