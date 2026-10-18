import '../models/inventory_models.dart';
import '../models/menu_models.dart';
import '../models/session_model.dart';

/// Сколько одной позиции склада уходит по чеку и за что — для одной строки
/// в журнале склада: «Продажа: Борщ ×2, Бизнес-ланч ×1».
class StockDraw {
  final String inventoryItemId;

  /// Количество в единицах позиции склада.
  final double qty;

  /// Откуда списание: названия блюд с количеством, без повторов.
  final List<String> sources;

  const StockDraw({required this.inventoryItemId, required this.qty, this.sources = const []});

  /// «Борщ ×2, Солянка ×1» — коротко, чтобы строка журнала не разрасталась.
  String get sourceText {
    const max = 6;
    final shown = sources.take(max).join(', ');
    return sources.length > max ? '$shown и ещё ${sources.length - max}' : shown;
  }
}

/// Блюда меню, которые нужны для расчёта чека: сами позиции и блюда-
/// варианты комбо («Первое: Борщ»).
Set<String> comboDishIds(Iterable<OrderItem> items, Map<String, MenuItem> menu) => {
      for (final line in items)
        if (menu[line.menuItemId] != null)
          for (final o in menu[line.menuItemId]!.optionsNamed(line.mods))
            if (o.menuItemId.isNotEmpty) o.menuItemId,
    };

/// Позиции склада, которые могут понадобиться для блюд [menu].
Set<String> stockIdsFor(Iterable<MenuItem> menu) => {
      for (final m in menu) ...[
        for (final c in m.perPortion) c.inventoryItemId,
        for (final g in m.modifierGroups)
          for (final o in g.options)
            if (o.hasInventoryLink) o.inventoryItemId,
      ],
    };

/// Что уйдёт со склада по строкам чека — одно правило для списания после
/// оплаты, проверки «хватит ли» до оплаты, возврата на склад и списания
/// отменённой позиции. Учитывает:
///  • рецепт блюда (брутто с отходом, делённое на число порций рецепта)
///    или простую привязку к одному товару;
///  • модификаторы со своим продуктом (сироп 20 мл, доп. сыр 30 г);
///  • комбо: вариант-блюдо списывает свой рецепт.
/// Количество переводится в единицу склада (г ↔ кг, мл ↔ л). Позиции
/// склада, которых нет в [stock], пропускаются.
Map<String, StockDraw> saleDraws(
  Iterable<OrderItem> items,
  Map<String, MenuItem> menu,
  Map<String, InventoryItem> stock,
) {
  final qty = <String, double>{};
  final src = <String, List<String>>{};
  void add(String invId, double amount, InventoryUnit unit, int count, String label) {
    final inv = stock[invId];
    if (invId.isEmpty || amount <= 0 || count <= 0 || inv == null) return;
    qty[invId] = (qty[invId] ?? 0) + unit.convertTo(amount, inv.unit) * count;
    final list = src.putIfAbsent(invId, () => []);
    if (!list.contains(label)) list.add(label);
  }

  for (final line in items) {
    final m = menu[line.menuItemId];
    if (m == null || line.qty <= 0) continue;
    final label = '${line.name.isEmpty ? m.name : line.name} ×${line.qty}';
    for (final c in m.perPortion) {
      add(c.inventoryItemId, c.weight, c.weightUnit, line.qty, label);
    }
    for (final o in m.optionsNamed(line.mods)) {
      if (o.hasInventoryLink) add(o.inventoryItemId, o.weight, o.weightUnit, line.qty, '$label (${o.name})');
      final dish = o.menuItemId.isEmpty ? null : menu[o.menuItemId];
      if (dish != null) {
        for (final c in dish.perPortion) {
          add(c.inventoryItemId, c.weight, c.weightUnit, line.qty, '$label: ${dish.name}');
        }
      }
    }
  }
  return {
    for (final e in qty.entries)
      e.key: StockDraw(inventoryItemId: e.key, qty: e.value, sources: src[e.key] ?? const []),
  };
}

/// Сколько порций блюда можно продать из текущих остатков. null — блюдо
/// не списывает склад. Отрицательный остаток считается нулём.
int? portionsAvailable(MenuItem item, Map<String, InventoryItem> stock) {
  final lines = item.perPortion;
  if (lines.isEmpty) return null;
  int? best;
  for (final c in lines) {
    final inv = stock[c.inventoryItemId];
    if (inv == null) return 0;
    final need = c.weightUnit.convertTo(c.weight, inv.unit);
    if (need <= 0) continue;
    final have = inv.quantity < 0 ? 0.0 : inv.quantity;
    final n = (have / need + 1e-9).floor();
    if (best == null || n < best) best = n;
  }
  return best;
}

/// Ошибки настройки рецепта, из-за которых склад посчитается неверно.
List<String> recipeProblems(List<MenuItemComponent> lines, Map<String, InventoryItem> stock) {
  final out = <String>[];
  for (final c in lines) {
    final inv = stock[c.inventoryItemId];
    if (inv == null) {
      out.add('продукт удалён со склада — строку нужно заменить');
      continue;
    }
    if (!c.weightUnit.compatibleWith(inv.unit)) {
      out.add('«${inv.name}»: в рецепте ${c.weightUnit.label}, на складе ${inv.unit.label} — '
          'спишется ${c.weightUnit.format(c.weight)} ${inv.unit.label}');
    }
    if (!inv.active) out.add('«${inv.name}» отключён на складе — не учитывается в остатках');
  }
  return out;
}

/// Чего не хватает в цене: продукты без цены закупки.
List<String> missingCosts(List<MenuItemComponent> lines, Map<String, InventoryItem> stock) => [
      for (final c in lines)
        if (stock[c.inventoryItemId] != null && stock[c.inventoryItemId]!.costPrice <= 0)
          stock[c.inventoryItemId]!.name,
    ];

/// Сколько продуктов спишет приготовление [output] (в единицах заготовки)
/// по рецепту заготовки [prepared]: рецепт × output / выход рецепта.
Map<String, double> productionDraws(
  InventoryItem prepared,
  double output,
  Map<String, InventoryItem> stock,
) {
  if (!prepared.isPrepared || output <= 0) return const {};
  final k = output / prepared.recipeOutput;
  final out = <String, double>{};
  for (final c in prepared.recipe) {
    final inv = stock[c.inventoryItemId];
    if (inv == null || c.inventoryItemId == prepared.id) continue;
    out[c.inventoryItemId] = (out[c.inventoryItemId] ?? 0) + c.weightUnit.convertTo(c.grossWeight, inv.unit) * k;
  }
  return out;
}

/// Себестоимость заготовки, ₽ за её единицу цены (за кг, литр, штуку) по
/// ценам продуктов рецепта. null — у какого-то продукта нет цены закупки.
double? preparedCostPrice(InventoryItem prepared, Map<String, InventoryItem> stock) {
  if (!prepared.isPrepared) return null;
  var sum = 0.0;
  for (final c in prepared.recipe) {
    final inv = stock[c.inventoryItemId];
    if (inv == null || inv.costPrice <= 0 || inv.id == prepared.id) return null;
    sum += inv.costOf(c.grossWeight, c.weightUnit);
  }
  final outputInPriceUnit = prepared.unit.convertTo(prepared.recipeOutput, prepared.unit.priceUnit);
  if (outputInPriceUnit <= 0) return null;
  return sum / outputInPriceUnit;
}
