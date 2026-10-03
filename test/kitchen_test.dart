import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/screens/employee/kitchen_screen.dart';
import 'package:hookah_pos/utils/sale_kind.dart';

SessionModel _check(String id, List<OrderItem> items, {DateTime? start}) => SessionModel(
      id: id,
      tableId: 't$id',
      tableName: 'Стол $id',
      employeeName: 'Алина',
      startTime: start ?? DateTime(2026, 10, 3, 19),
      plannedEnd: DateTime(2026, 10, 3, 21),
      orderItems: items,
      status: 'active',
    );

OrderItem _food(String id, int qty, {int ready = 0, DateTime? since}) =>
    OrderItem(menuItemId: id, name: 'Блюдо $id', price: 500, qty: qty, kind: SaleKind.kitchen, ready: ready, since: since);
OrderItem _drink(String id, int qty) =>
    OrderItem(menuItemId: id, name: 'Напиток $id', price: 300, qty: qty, kind: SaleKind.bar, since: DateTime(2026, 10, 3, 19, 10));

void main() {
  group('Готово на кухне', () {
    test('готовые штуки не больше заказанных и переживают сохранение', () {
      final i = _food('a', 2, ready: 5);
      expect(i.ready, 2);
      expect(i.pending, 0);
      final back = OrderItem.fromMap(_food('a', 3, ready: 1, since: DateTime(2026, 10, 3, 19, 5)).toMap());
      expect(back.ready, 1);
      expect(back.pending, 2);
      expect(back.since, DateTime(2026, 10, 3, 19, 5));
    });

    test('добавили к готовой строке — новые штуки ждут с этой минуты', () {
      final done = _food('a', 1, ready: 1, since: DateTime(2026, 10, 3, 18));
      final more = done.plus(1);
      expect(more.pending, 1);
      expect(more.since!.isAfter(DateTime(2026, 10, 3, 18)), isTrue);
      // Пока ещё ждут — время не сбрасывается.
      final waiting = _food('b', 1, since: DateTime(2026, 10, 3, 18));
      expect(waiting.plus(1).since, DateTime(2026, 10, 3, 18));
    });

    test('минус убирает сначала неготовое, «всё готово» закрывает строку', () {
      final i = _food('a', 3, ready: 2);
      expect(i.minus(1).pending, 0);
      expect(i.minus(2).ready, 1);
      expect(_food('a', 3).markReady().pending, 0);
    });

    test('раздел счёта уносит готовые штуки первыми', () {
      final (out, rest) = _food('a', 3, ready: 2).split(2);
      expect(out.ready, 2);
      expect(rest!.ready, 0);
      expect(rest.pending, 1);
    });

    test('билеты по цехам, давние сверху', () {
      final early = _check('1', [_food('a', 1, since: DateTime(2026, 10, 3, 19, 0)), _drink('d', 2)]);
      final late = _check('2', [_food('b', 2, since: DateTime(2026, 10, 3, 19, 20))]);
      final done = _check('3', [_food('c', 1, ready: 1, since: DateTime(2026, 10, 3, 18))]);
      // Строка из старого чека (без «ждёт с») на кухню не попадает.
      final legacy = _check('4', [_food('e', 2)]);
      final kitchen = KitchenScreen.ticketsFor([late, done, early, legacy], SaleKind.kitchen);
      expect(kitchen.map((t) => t.session.id), ['1', '2']);
      expect(kitchen.first.lines.single.menuItemId, 'a');
      final bar = KitchenScreen.ticketsFor([late, done, early], SaleKind.bar);
      expect(bar.single.lines.single.pending, 2);
    });

    test('цех по специализации', () {
      expect(KitchenScreen.stationFor('bartender'), SaleKind.bar);
      expect(KitchenScreen.stationFor('hookah_master'), SaleKind.hookah);
      expect(KitchenScreen.stationFor('cook'), SaleKind.kitchen);
      expect(KitchenScreen.stationFor('waiter'), SaleKind.kitchen);
    });
  });
}
