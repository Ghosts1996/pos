import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/inventory_models.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/utils/stock_zones.dart';

OrderItem _line(String id, int qty) => OrderItem(menuItemId: id, name: '', price: 100, qty: qty, since: DateTime(2026));

void main() {
  // Молоко: всего 10 л, на баре 1,5 л, на кухне 2 л (перемещено в кабинете).
  final stock = {
    'milk': InventoryItem(id: 'milk', name: 'Молоко', unit: InventoryUnit.l, quantity: 10, zones: const {'bar': 1.5, 'kitchen': 2}),
    'egg': InventoryItem(id: 'egg', name: 'Яйцо', unit: InventoryUnit.pcs, quantity: 30),
  };
  final latte = MenuItem(id: 'latte', categoryId: 'b', name: 'Латте', price: 250, components: [
    MenuItemComponent(inventoryItemId: 'milk', weight: 200, weightUnit: InventoryUnit.ml),
  ]);
  final omelette = MenuItem(id: 'om', categoryId: 'k', name: 'Омлет', price: 300, components: [
    MenuItemComponent(inventoryItemId: 'milk', weight: 100, weightUnit: InventoryUnit.ml),
    MenuItemComponent(inventoryItemId: 'egg', weight: 3, weightUnit: InventoryUnit.pcs),
  ]);
  final menu = {'latte': latte, 'om': omelette};
  String kindOf(MenuItem m) => m.categoryId == 'b' ? 'bar' : 'kitchen';

  test('латте — из бара, омлет — из кухни, яйца без цехов не трогаем', () {
    final d = zoneDraws([_line('latte', 2), _line('om', 1)], menu, stock, kindOf);
    expect(d['milk'], {'bar': 0.4, 'kitchen': 0.1});
    expect(d.containsKey('egg'), isFalse);
    expect(zoneDecrements(d['milk']!), {'zones.bar': -0.4, 'zones.kitchen': -0.1});
  });

  test('в цехе меньше, чем продано, — остальное с основного склада', () {
    final d = zoneDraws([_line('latte', 10)], menu, stock, kindOf); // 2 л, на баре 1,5
    expect(d['milk'], {'bar': 1.5});
  });

  test('цехов нет ни у одной позиции — ничего не считаем', () {
    final plain = {'milk': InventoryItem(id: 'milk', name: 'Молоко', unit: InventoryUnit.l, quantity: 10)};
    expect(zoneDraws([_line('latte', 2)], menu, plain, kindOf), isEmpty);
    expect(anyZones(plain.values), isFalse);
  });

  test('раскладка читается из базы и не пишется обычным сохранением карточки', () {
    final item = InventoryItem(id: 'x', name: 'X', unit: InventoryUnit.l, quantity: 3, zones: const {'bar': 1});
    expect(item.toMap().containsKey('zones'), isFalse);
    expect(item.copyWith(quantity: 4).zones, {'bar': 1});
  });
}
