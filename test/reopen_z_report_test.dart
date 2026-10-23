import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/cash_op.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/models/shift_model.dart';
import 'package:hookah_pos/utils/reopen_check.dart';
import 'package:hookah_pos/utils/time_cafe.dart';
import 'package:hookah_pos/utils/z_report.dart';

final _open = DateTime(2026, 10, 23, 10);
final _shift = ShiftModel(id: 'sh1', openedAt: _open, openedBy: 'Ольга', openingCash: 1000);

SessionModel _check({
  String id = 's1',
  List<OrderItem>? items,
  double cash = 0,
  double card = 0,
  double terminal = 0,
  double discount = 0,
  bool refunded = false,
  bool refundCashOut = false,
  String reopenedTo = '',
  String orderType = '',
  double guestPaid = 0,
  bool unpaid = false,
  DateTime? closedAt,
  String status = 'closed',
  String employee = 'Аня',
  double tipsCash = 0,
}) =>
    SessionModel(
      id: id,
      tableId: 't1',
      tableName: 'Стол 1',
      employeeName: employee,
      startTime: _open.add(const Duration(hours: 1)),
      plannedEnd: _open.add(const Duration(hours: 3)),
      orderItems: items ?? [OrderItem(menuItemId: 'm1', name: 'Чай', price: 500, qty: 2, kind: 'bar')],
      discountPercent: discount,
      status: status,
      closedAt: closedAt ?? _open.add(const Duration(hours: 2)),
      paymentCash: cash,
      paymentCard: card,
      paymentTerminal: terminal,
      refunded: refunded,
      refundCashOut: refundCashOut,
      reopenedTo: reopenedTo,
      orderType: orderType,
      guestPaidTotal: guestPaid,
      closedWithoutPayment: unpaid,
      tipsCash: tipsCash,
    );

void main() {
  group('переоткрытие чека', () {
    test('чек текущей смены переоткрыть можно', () {
      expect(ReopenCheck.problem(_check(cash: 1000), openShift: _shift), isNull);
      expect(ReopenCheck.problem(_check(unpaid: true), openShift: _shift), isNull,
          reason: 'закрыли без оплаты по ошибке — тоже исправляется');
    });

    test('когда нельзя', () {
      expect(ReopenCheck.problem(_check(refunded: true), openShift: _shift), contains('возврат'));
      expect(ReopenCheck.problem(_check(status: 'active'), openShift: _shift), isNotNull);
      expect(ReopenCheck.problem(_check(orderType: 'delivery'), openShift: _shift), contains('доставка'));
      expect(ReopenCheck.problem(_check(guestPaid: 1000), openShift: _shift), contains('онлайн'));
      expect(ReopenCheck.problem(_check(), openShift: null), contains('Смена'));
      expect(ReopenCheck.problem(_check(closedAt: _open.subtract(const Duration(hours: 1))), openShift: _shift),
          contains('прошлой смены'));
    });

    test('позиции: не уходят на кухню, авторы сохраняются, время тайм-кафе фиксируется', () {
      final items = ReopenCheck.items([
        OrderItem(menuItemId: 'm1', name: 'Борщ', price: 300, qty: 2, by: const {'e1': 2}, since: DateTime(2026)),
        OrderItem(menuItemId: TimeCafe.lineId, name: 'Время в тайм-кафе · 1 ч', price: 300, qty: 2),
      ]);
      expect(items[0].pending, 0);
      expect(items[0].unsent, 0);
      expect(items[0].fresh, 0);
      expect(items[0].toServe, 0);
      expect(items[0].by, {'e1': 2});
      expect(items[0].total, 600);
      expect(items[1].name, endsWith(' · вручную'));
      expect(ReopenCheck.items(items)[1].name.split('вручную').length, 2, reason: 'не дописывается дважды');
    });
  });

  group('Z-отчёт', () {
    test('продажи, возвраты, выручка, касса и необнуляемый итог', () {
      final sold = [
        _check(id: 'a', cash: 1000, tipsCash: 100),
        _check(id: 'b', card: 900, discount: 10), // 1000 − 10 %
        _check(id: 'c', cash: 1000, refunded: true, refundCashOut: true, reopenedTo: 'd'),
        _check(id: 'u', unpaid: true),
        _check(id: 'x', status: 'cancelled', cash: 500),
      ];
      final refunds = [sold[2]];
      final ops = [
        CashOp(id: 'o1', shiftId: 'sh1', type: CashOpType.refund, amount: 1000, createdAt: _open),
        CashOp(id: 'o2', shiftId: 'sh1', type: CashOpType.payout, amount: 200, createdAt: _open),
      ];
      final z = ZReport.build(
        number: 7,
        shift: _shift,
        closedAt: _open.add(const Duration(hours: 12)),
        closedBy: 'Ольга',
        sold: sold,
        refunds: refunds,
        ops: ops,
        grandTotalBefore: 50000,
        countedCash: 2900,
        leftCash: 1000,
      );
      expect(z.salesCount, 3);
      expect(z.salesTotal, 2900);
      expect(z.discounts, 100);
      expect(z.refundsCount, 1);
      expect(z.reopenedCount, 1);
      expect(z.refundsTotal, 1000);
      expect(z.revenue, 1900);
      expect(z.unpaidCount, 1);
      expect(z.grandTotal, 51900);
      // 1000 размен + 2000 продажи наличными + 100 чаевые − 1000 возврат − 200 выплата
      expect(z.expectedCash, 1900);
      expect(z.cashDiff, 1000);
      expect(z.byStaff['Аня']!.checks, 3);
      expect(z.byKind['Бар и напитки'], 2900);
      expect(z.title, 'Z-отчёт №7');
      // Снимок переживает запись в базу и чтение обратно.
      final back = ZReport.fromMap(z.toMap());
      expect(back.toMap(), z.toMap());
      expect(z.copyText(), contains('Выручка: '));
    });
  });
}
