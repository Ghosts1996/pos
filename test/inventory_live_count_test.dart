import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/inventory_models.dart';

void main() {
  test('продажи после подсчёта не теряются', () {
    // Посчитали 10 при системных 12, потом продали 1 (система 11).
    expect(inventoryCountFinalQty(counted: 10, systemAtCount: 12, currentQty: 11), 9);
  });

  test('приход после подсчёта тоже учитывается', () {
    expect(inventoryCountFinalQty(counted: 5, systemAtCount: 5, currentQty: 25), 25);
  });

  test('старые записи без отметки — как раньше: остаток = посчитанному', () {
    expect(inventoryCountFinalQty(counted: 7, currentQty: 3), 7);
  });

  test('расхождение считается от системы в момент подсчёта', () {
    final e = InventoryCountEntry(
      itemId: 'a',
      name: 'Молоко',
      unit: InventoryUnit.values.first,
      expectedQty: 20,
      countedQty: 10,
      systemAtCount: 12,
    );
    expect(e.diff, -2);
    final back = InventoryCountEntry.fromMap(e.toMap());
    expect(back.systemAtCount, 12);
    expect(back.copyWith(clear: true).systemAtCount, isNull);
  });
}
