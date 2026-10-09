import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/inventory_models.dart';
import 'package:hookah_pos/models/menu_models.dart';

void main() {
  final stock = {
    'pasta': InventoryItem(id: 'pasta', name: 'Паста', unit: InventoryUnit.g, costPrice: 300), // 300 ₽/кг
    'cream': InventoryItem(id: 'cream', name: 'Сливки', unit: InventoryUnit.ml, costPrice: 400), // 400 ₽/л
    'cola': InventoryItem(id: 'cola', name: 'Кола', unit: InventoryUnit.pcs, costPrice: 55),
    'salt': InventoryItem(id: 'salt', name: 'Соль', unit: InventoryUnit.g),
  };

  test('цена закупки за кг/л/шт, себестоимость порции', () {
    expect(InventoryUnit.g.priceUnit, InventoryUnit.kg);
    expect(stock['pasta']!.costOf(120, InventoryUnit.g), closeTo(36, 1e-9));
    final carbonara = MenuItem(id: 'c', categoryId: 'x', name: 'Карбонара', price: 600, components: [
      MenuItemComponent(inventoryItemId: 'pasta', weight: 120),
      MenuItemComponent(inventoryItemId: 'cream', weight: 100, weightUnit: InventoryUnit.ml),
    ]);
    expect(carbonara.costPrice(stock), closeTo(76, 1e-9));
    expect(carbonara.foodCostPercent(stock), closeTo(76 / 600 * 100, 1e-9));
    final cola = MenuItem(id: 'k', categoryId: 'x', name: 'Кола', price: 200, inventoryItemId: 'cola', weight: 1, weightUnit: InventoryUnit.pcs);
    expect(cola.costPrice(stock), 55);
  });

  test('нет цены закупки или привязки — себестоимость не считается', () {
    final noLink = MenuItem(id: 'n', categoryId: 'x', name: 'Чай', price: 300);
    expect(noLink.costPrice(stock), isNull);
    final withSalt = MenuItem(id: 's', categoryId: 'x', name: 'Суп', price: 400, components: [
      MenuItemComponent(inventoryItemId: 'pasta', weight: 50),
      MenuItemComponent(inventoryItemId: 'salt', weight: 5),
    ]);
    expect(withSalt.costPrice(stock), isNull);
  });
}
