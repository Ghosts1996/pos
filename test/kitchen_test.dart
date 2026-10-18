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

  group('Принято → готовится → готово → подано', () {
    test('статусы считаются по штукам и переживают сохранение', () {
      final i = _food('a', 3, since: DateTime(2026, 10, 3, 19));
      expect(i.fresh, 3);
      expect(i.cooking, 0);
      final taken = i.markAccepted();
      expect(taken.fresh, 0);
      expect(taken.cooking, 3);
      expect(taken.toServe, 0);
      final done = taken.markReady();
      expect(done.cooking, 0);
      expect(done.toServe, 3);
      expect(done.readyAt, isNotNull);
      final back = OrderItem.fromMap(done.toMap());
      expect(back.accepted, 3);
      expect(back.toServe, 3);
      expect(back.readyAt!.millisecondsSinceEpoch, done.readyAt!.millisecondsSinceEpoch);
      final out = back.markServed();
      expect(out.toServe, 0);
      expect(OrderItem.fromMap(out.toMap()).served, 3);
    });

    test('старые строки без отметки времени на раздаче не висят', () {
      final old = _food('a', 2, ready: 2);
      expect(old.toServe, 0);
      expect(old.fresh, 0);
    });

    test('добавили к поданной строке — новые штуки снова новые', () {
      final out = _food('a', 1, since: DateTime(2026, 10, 3, 19)).markAccepted().markReady().markServed();
      final more = out.plus(1);
      expect(more.fresh, 1);
      expect(more.toServe, 0);
      final again = more.markReady();
      expect(again.toServe, 1);
      expect(again.served, 1);
    });

    test('повторные отметки ничего не меняют', () {
      final i = _food('a', 1, since: DateTime(2026, 10, 3, 19)).markReady();
      expect(identical(i.markReady(), i), isTrue);
      expect(identical(i.markAccepted(), i), isTrue);
      expect(_food('b', 1).markServed().served, 0);
    });

    test('раздел счёта делит принятые и поданные штуки', () {
      final i = OrderItem(
          menuItemId: 'a', name: 'Блюдо', price: 500, qty: 3, kind: SaleKind.kitchen,
          ready: 2, accepted: 3, served: 1, readyAt: DateTime(2026, 10, 3, 19, 30));
      final (out, rest) = i.split(2);
      expect(out.accepted + rest!.accepted, 3);
      expect(out.served + rest.served, 1);
      expect(out.served <= out.ready && rest.served <= rest.ready, isTrue);
    });

    test('«Ждут выдачи»: готовое и не поданное, давнее сверху, без забытого', () {
      final now = DateTime(2026, 10, 3, 20);
      OrderItem ready(String id, DateTime at, {int served = 0}) => OrderItem(
          menuItemId: id, name: 'Блюдо $id', price: 500, qty: 2, kind: SaleKind.kitchen,
          ready: 2, accepted: 2, served: served, readyAt: at, since: DateTime(2026, 10, 3, 19));
      final checks = [
        _check('1', [ready('a', DateTime(2026, 10, 3, 19, 55))]),
        _check('2', [ready('b', DateTime(2026, 10, 3, 19, 50))]),
        _check('3', [ready('c', DateTime(2026, 10, 3, 19, 40), served: 2)]),
        _check('4', [ready('d', DateTime(2026, 10, 3, 16))]),
        _check('5', [_drink('e', 1)]),
      ];
      final list = KitchenScreen.servingFor(checks, SaleKind.kitchen, now: now);
      expect(list.map((t) => t.session.id), ['2', '1']);
      expect(KitchenScreen.servingFor(checks, SaleKind.bar, now: now), isEmpty);
      // На кухне билетов нет: всё уже готово.
      expect(KitchenScreen.ticketsFor(checks, SaleKind.kitchen), isEmpty);
    });
  });
}
