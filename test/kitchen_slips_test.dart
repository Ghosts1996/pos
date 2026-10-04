import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/services/printer_service.dart';
import 'package:hookah_pos/utils/kitchen_slips.dart';
import 'package:hookah_pos/utils/sale_kind.dart';

final _at = DateTime(2026, 10, 3, 20, 15);

SessionModel _check(List<OrderItem> items) => SessionModel(
      id: 's1',
      tableId: 't5',
      tableName: 'Стол 5',
      employeeName: 'Алина',
      guestTag: 'Марина',
      startTime: DateTime(2026, 10, 3, 19),
      plannedEnd: DateTime(2026, 10, 3, 21),
      orderItems: items,
      status: 'active',
    );

OrderItem _line(String id, String kind, int qty, {int sent = 0, int ready = 0, String note = '', bool legacy = false}) =>
    OrderItem(
      menuItemId: id,
      name: 'Позиция $id',
      price: 400,
      qty: qty,
      kind: kind,
      sent: sent,
      ready: ready,
      note: note,
      since: legacy ? null : DateTime(2026, 10, 3, 20),
    );

bool _contains(List<int> hay, List<int> needle) {
  for (var i = 0; i + needle.length <= hay.length; i++) {
    var ok = true;
    for (var j = 0; j < needle.length; j++) {
      if (hay[i + j] != needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

void main() {
  group('Бегунок: что уже ушло на кухню', () {
    test('отправленное не больше заказанного и переживает сохранение', () {
      expect(_line('a', SaleKind.kitchen, 2, sent: 5).sent, 2);
      final back = OrderItem.fromMap(_line('a', SaleKind.kitchen, 3, sent: 1).toMap());
      expect(back.sent, 1);
      expect(back.unsent, 2);
      expect(_line('b', SaleKind.kitchen, 1).toMap().containsKey('sent'), isFalse);
    });

    test('новые штуки после печати ждут следующего бегунка', () {
      final printed = _line('a', SaleKind.bar, 2).markSent(2);
      expect(printed.unsent, 0);
      final more = printed.plus(1, employeeId: 'e1');
      expect(more.sent, 2);
      expect(more.unsent, 1);
      // Убрали штуку — отправленное не больше, чем осталось.
      expect(printed.minus(1).sent, 1);
      expect(printed.copyWith(qty: 1).unsent, 0);
    });

    test('готовое на экране «Кухня и бар» печатать не нужно, старые строки — тоже', () {
      expect(_line('a', SaleKind.kitchen, 3, ready: 2).unsent, 1);
      expect(_line('b', SaleKind.kitchen, 3, sent: 1, ready: 2).unsent, 1);
      expect(_line('c', SaleKind.kitchen, 3, legacy: true).unsent, 0);
    });

    test('печать не откатывает уже отмеченное', () {
      final i = _line('a', SaleKind.kitchen, 3, sent: 3);
      expect(identical(i.markSent(2), i), isTrue);
    });

    test('разделили счёт — отправленные штуки уходят первыми', () {
      final (out, rest) = _line('a', SaleKind.kitchen, 4, sent: 3).split(2);
      expect(out.sent, 2);
      expect(rest!.sent, 1);
      expect(rest.unsent, 1);
    });
  });

  group('Бегунки по счёту', () {
    test('по листку на цех, только новое, с пожеланием и пометкой «ещё»', () {
      final s = _check([
        _line('soup', SaleKind.kitchen, 2, note: 'без лука'),
        _line('mojito', SaleKind.bar, 3, sent: 1),
        _line('tea', SaleKind.bar, 1, sent: 1),
        _line('hk', SaleKind.hookah, 1),
        _line('old', SaleKind.kitchen, 2, legacy: true),
      ]);
      expect(kitchenUnsentCount(s), 2 + 2 + 1);
      final slips = kitchenSlipsFor(s, at: _at);
      expect(slips.map((x) => x.station), [SaleKind.kitchen, SaleKind.bar, SaleKind.hookah]);
      expect(slips.map((x) => x.title), ['КУХНЯ', 'БАР', 'КАЛЬЯНЫ']);
      final kitchen = slips.first;
      expect(kitchen.tableName, 'Стол 5');
      expect(kitchen.lines.single.note, 'без лука');
      expect(kitchen.lines.single.more, isFalse);
      final bar = slips[1];
      expect(bar.lines.single.menuItemId, 'mojito');
      expect(bar.lines.single.qty, 2);
      expect(bar.lines.single.more, isTrue);
      expect(kitchenSlipsSentQty(slips), {'soup': 2, 'mojito': 3, 'hk': 1});
    });

    test('всё отправлено — бегунков нет', () {
      final s = _check([_line('a', SaleKind.kitchen, 1, sent: 1)]);
      expect(kitchenUnsentCount(s), 0);
      expect(kitchenSlipsFor(s), isEmpty);
    });

    test('печать: цех и стол крупно, позиции, пожелание, русские буквы', () async {
      TestWidgetsFlutterBinding.ensureInitialized();
      final slips = kitchenSlipsFor(
        _check([
          _line('soup', SaleKind.kitchen, 2, note: 'без лука'),
          _line('mojito', SaleKind.bar, 3, sent: 1),
        ]),
        at: _at,
      );
      final bytes = await buildKitchenSlipsBytes(slips);
      expect(_contains(bytes, [0x1B, 0x74, 17]), isTrue, reason: 'кодовая страница CP866');
      for (final text in ['КУХНЯ', 'БАР', 'Стол 5', '2 x Позиция soup', '! без лука', '2 x Позиция mojito (ещё)', '20:15']) {
        expect(_contains(bytes, Cp866Codec.encodeString(text)), isTrue, reason: text);
      }
      // Два листка — два отреза.
      expect(RegExp('\x1DV').allMatches(String.fromCharCodes(bytes)).length, 2);
    });
  });

  group('Предчек и принтеры цехов', () {
    test('деньги: тысячи через пробел, копейки только если есть', () {
      expect(precheckMoney(1200), '1 200');
      expect(precheckMoney(1234567.5), '1 234 567.50');
      expect(precheckMoney(99), '99');
    });

    test('предчек: заголовок, позиции, скидка, итог и пометка «не кассовый чек»', () async {
      TestWidgetsFlutterBinding.ensureInitialized();
      final bytes = await buildPrecheckBytes(PrecheckData(
        venueName: 'Кафе Лето',
        tableName: 'Стол 5',
        guestTag: 'Марина',
        waiter: 'Алина',
        at: DateTime(2026, 10, 4, 21, 5),
        lines: const [PrecheckLine('Паста карбонара', 2, 690), PrecheckLine('Кальян классический', 1, 1200)],
        subtotal: 2580,
        discountPercent: 10,
        total: 2442,
      ));
      for (final text in ['ПРЕДВАРИТЕЛЬНЫЙ СЧЁТ', 'Стол 5 · Марина', 'Вас обслуживает: Алина', 'Паста карбонара',
        '2 x 690', '1 380', 'Скидка 10%', '-138', '2 442 р.', 'Не является кассовым чеком.', '04.10.2026 21:05']) {
        expect(_contains(bytes, Cp866Codec.encodeString(text)), isTrue, reason: text);
      }
    });

    test('бегунок цеха — на свой принтер, иначе на чековый', () {
      activeReceiptPrinter = null;
      kitchenPrinterIp = '';
      barPrinterIp = '';
      expect(printerForStation(SaleKind.kitchen), isNull);
      kitchenPrinterIp = '192.168.1.101';
      barPrinterIp = '192.168.1.102';
      expect(printerForStation(SaleKind.kitchen)!.$2, 'ip:192.168.1.101');
      expect(printerForStation(SaleKind.bar)!.$2, 'ip:192.168.1.102');
      expect(printerForStation(SaleKind.hookah)!.$2, 'ip:192.168.1.102');
      kitchenPrinterIp = '';
      activeReceiptPrinter = NetworkReceiptPrinter(ip: '192.168.1.50');
      expect(printerForStation(SaleKind.kitchen)!.$2, 'main');
      activeReceiptPrinter = null;
      barPrinterIp = '';
    });
  });
}
