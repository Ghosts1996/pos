import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/fiscal_receipt.dart';
import 'package:hookah_pos/models/reservation_model.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/screens/employee/banquet_screen.dart';
import 'package:hookah_pos/services/banquet_service.dart';
import 'package:hookah_pos/services/booking_fiscal_service.dart';

ReservationModel _r({double prepay = 0, double paid = 0, int guests = 12}) => ReservationModel(
      id: 'r1',
      guestName: 'Юбилей',
      phone: '+79990001122',
      guestsCount: guests,
      startTime: DateTime(2026, 12, 5, 18),
      durationMinutes: 300,
      kind: 'banquet',
      banquetPrepay: prepay,
      prepaidTotal: paid,
      preOrder: [
        OrderItem(menuItemId: 'a', name: 'Салат', price: 450, qty: 12),
        OrderItem(menuItemId: 'b', name: 'Горячее', price: 900, qty: 12),
      ],
      createdAt: DateTime(2026, 11, 22),
    );

void main() {
  test('итоги банкета: меню, на гостя, предоплата, доплата', () {
    final s = banquetSummary(_r(prepay: 5000, paid: 3000));
    expect(s.menuTotal, 16200);
    expect(s.perGuest, 1350);
    expect(s.prepayLeft, 2000);
    expect(s.balance, 13200);
    expect(banquetSummary(_r(prepay: 5000, paid: 6000)).prepayLeft, 0);
    expect(banquetSummary(_r(guests: 0)).perGuest, 16200, reason: 'ноль гостей не делит на ноль');
  });

  test('доля меню для предоплаты — до 100 ₽ вверх, 100% — как есть', () {
    expect(prepayShare(16200, 30), 4900);
    expect(prepayShare(16200, 50), 8100);
    expect(prepayShare(16250.5, 100), 16250.5);
    expect(prepayShare(0, 30), 0);
  });

  test('бронь-банкет пишет вид и сумму предоплаты', () {
    final m = _r(prepay: 5000).toMap();
    expect(m['kind'], 'banquet');
    expect(m['banquetPrepay'], 5000);
    final plain = ReservationModel(id: 'x', guestName: '', phone: '', startTime: DateTime(2026), createdAt: DateTime(2026)).toMap();
    expect(plain.containsKey('kind'), isFalse);
    expect(plain.containsKey('banquetPrepay'), isFalse);
    final copy = _r(prepay: 5000, paid: 1000).copyWith(guestsCount: 20);
    expect(copy.isBanquet, isTrue);
    expect(copy.banquetPrepay, 5000);
    expect(copy.prepaidTotal, 1000);
  });

  test('чек «аванс» за банкет наличными', () {
    final r = bookingAdvanceReceipt(reservationId: 'r1', amount: 3000, banquet: true, pay: 'cash');
    expect(r.advance, isTrue);
    expect(r.items.single.name, 'Предоплата банкета');
    expect(r.items.single.paymentObject, FiscalPaymentObject.payment);
    expect(r.payments.single.type, 'cash');
    expect(bookingAdvanceReceipt(reservationId: 'r1', amount: 10).payments.single.type, 'card');
  });

  testWidgets('экран банкета на телефоне — без переполнений, итоги меню', (t) async {
    t.view.physicalSize = const Size(360 * 3, 760 * 3);
    t.view.devicePixelRatio = 3;
    addTearDown(t.view.reset);
    await t.pumpWidget(MaterialApp(
      home: MediaQuery(
        data: const MediaQueryData(size: Size(360, 760), textScaler: TextScaler.linear(1.3)),
        child: BanquetScreen(existing: _r(prepay: 5000), day: DateTime(2026, 12, 5), employeeName: 'Анна', pickTable: (_, __) async => null),
      ),
    ));
    await t.pump();
    await t.scrollUntilVisible(find.text('Салат'), 300, scrollable: find.byType(Scrollable).first);
    await t.scrollUntilVisible(find.text('Меню на 12 гостей'), 300, scrollable: find.byType(Scrollable).first);
    expect(find.text('Меню на 12 гостей'), findsOneWidget);
    await t.scrollUntilVisible(find.text('30% меню'), 300, scrollable: find.byType(Scrollable).first);
    await t.tap(find.text('30% меню'));
    await t.pump();
    expect(t.widgetList<TextField>(find.byType(TextField, skipOffstage: false)).any((f) => f.controller?.text == '4900'), isTrue);
    expect(t.takeException(), isNull);
  });
}
