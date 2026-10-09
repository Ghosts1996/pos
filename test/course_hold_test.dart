import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/utils/kitchen_slips.dart';
import 'package:hookah_pos/utils/sale_kind.dart';

void main() {
  test('«подать позже»: не уходит бегунком, после «Подать» — уходит', () {
    final steak = OrderItem(
        menuItemId: 'steak', name: 'Стейк', price: 1200, qty: 2, kind: SaleKind.kitchen, since: DateTime(2026));
    final held = steak.withHold(true);
    expect(held.hold, isTrue);
    expect(held.unsent, 0);
    expect(OrderItem.fromMap(held.toMap()).hold, isTrue);
    expect(held.plus(1).hold, isTrue, reason: 'добавка к отложенной строке тоже ждёт');
    final s = SessionModel(
      id: 's',
      tableId: 't',
      tableName: 'Стол 2',
      employeeName: 'Алина',
      startTime: DateTime(2026),
      plannedEnd: DateTime(2026),
      orderItems: [held],
    );
    expect(kitchenSlipsFor(s), isEmpty);
    final fired = held.withHold(false);
    expect(fired.hold, isFalse);
    expect(fired.unsent, 2);
    expect(fired.since!.isAfter(DateTime(2026)), isTrue, reason: 'ждёт с момента подачи');
    expect(steak.toMap().containsKey('hold'), isFalse);
  });
}
