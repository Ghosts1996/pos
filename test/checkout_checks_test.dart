import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/inventory_models.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/utils/checkout_checks.dart';

void main() {
  final tobacco = InventoryItem(id: 'inv1', name: 'Табак Мята', unit: InventoryUnit.g, quantity: 15);
  final cola = InventoryItem(id: 'inv2', name: 'Кола 0,33', unit: InventoryUnit.pcs, quantity: 5);
  final off = InventoryItem(id: 'inv3', name: 'Угли', unit: InventoryUnit.pcs, quantity: 0, active: false);
  final stock = {for (final i in [tobacco, cola, off]) i.id: i};

  MenuItem item(String id, String inv, double w, InventoryUnit u) =>
      MenuItem(id: id, name: id, price: 100, categoryId: 'c', inventoryItemId: inv, weight: w, weightUnit: u);

  final menu = {
    'hookah': item('hookah', 'inv1', 20, InventoryUnit.g),
    'cola': item('cola', 'inv2', 1, InventoryUnit.pcs),
    'coal': item('coal', 'inv3', 3, InventoryUnit.pcs),
  };

  test('не хватает табака на два кальяна, колы и углей (не учитываются) — хватает', () {
    final lines = [
      OrderItem(menuItemId: 'hookah', name: 'Кальян', price: 1500, qty: 2),
      OrderItem(menuItemId: 'cola', name: 'Кола', price: 150, qty: 3),
      OrderItem(menuItemId: 'coal', name: 'Угли', price: 0, qty: 1),
    ];
    final s = stockShortages(lines, menu, stock);
    expect(s, hasLength(1));
    expect(s.single.text, '«Табак Мята» — нужно 40 г, на складе 15 г');
  });

  test('всего хватает — пусто', () {
    expect(stockShortages([OrderItem(menuItemId: 'cola', name: 'Кола', price: 150, qty: 5)], menu, stock), isEmpty);
  });

  test('что поменялось в чеке', () {
    final msg = describeBillChange(
      seen: [OrderItem(menuItemId: 'a', name: 'Чай', price: 500, qty: 1)],
      seenTotal: 500,
      actual: [
        OrderItem(menuItemId: 'a', name: 'Чай', price: 500, qty: 2),
        OrderItem(menuItemId: 'b', name: 'Кальян', price: 2500, qty: 1),
      ],
      actualTotal: 3500,
      seenDiscount: 0,
      actualDiscount: 0,
    );
    expect(msg, contains('добавили Чай ×1, Кальян ×1'));
    expect(msg, contains('3 500 ₽ вместо 500 ₽'));
  });
}
