import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/models/table_model.dart';

void main() {
  test('служебный стол «с собой» узнаётся по id', () {
    expect(TableModel(id: TableModel.takeawayId, name: 'С собой', x: 0, y: 0).isTakeaway, isTrue);
    expect(TableModel(id: 't1', name: 'Стол 1', x: 0, y: 0).isTakeaway, isFalse);
  });

  test('заказ доставки хранит тип, телефон и адрес', () {
    final s = SessionModel(
      id: 's1',
      tableId: TableModel.takeawayId,
      tableName: 'Доставка · Иван',
      employeeName: 'Анна',
      startTime: DateTime(2026, 10, 9, 12),
      plannedEnd: DateTime(2026, 10, 9, 14),
      orderType: 'delivery',
      customerPhone: '+79001112233',
      deliveryAddress: 'ул. Ленина, 1',
    );
    final m = s.toMap();
    expect(m['orderType'], 'delivery');
    expect(m['customerPhone'], '+79001112233');
    expect(m['deliveryAddress'], 'ул. Ленина, 1');
    expect(s.isTakeaway, isTrue);
  });

  test('заказ за столом не пишет лишних полей', () {
    final m = SessionModel(
      id: 's2',
      tableId: 't1',
      tableName: 'Стол 1',
      employeeName: 'Анна',
      startTime: DateTime(2026, 10, 9, 12),
      plannedEnd: DateTime(2026, 10, 9, 14),
    ).toMap();
    expect(m.containsKey('orderType'), isFalse);
    expect(m.containsKey('deliveryAddress'), isFalse);
  });
}
