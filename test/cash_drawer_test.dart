import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/cash_op.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/screens/employee/x_report_screen.dart';

SessionModel _s({double cash = 0, double tips = 0, bool refunded = false, bool refundCashOut = false, bool unpaid = false}) =>
    SessionModel(
      id: 's',
      tableId: 't',
      tableName: 'Стол 1',
      employeeName: 'Анна',
      startTime: DateTime(2026, 9, 27, 18),
      plannedEnd: DateTime(2026, 9, 27, 20),
      status: 'closed',
      paymentCash: cash,
      tipsCash: tips,
      refunded: refunded,
      refundCashOut: refundCashOut,
      closedWithoutPayment: unpaid,
    );

CashOp _op(CashOpType type, double amount, {bool cancelled = false}) =>
    CashOp(id: 'o', shiftId: 'sh', type: type, amount: amount, createdAt: DateTime(2026, 9, 27, 21), cancelled: cancelled);

void main() {
  group('Наличные в кассе', () {
    test('размен + наличные за чеки + чаевые + внесения − инкассации − выплаты − возвраты', () {
      final sum = CashDrawerSummary.from(
        opening: 1000,
        sessions: [_s(cash: 2500, tips: 200), _s(cash: 1500)],
        ops: [
          _op(CashOpType.deposit, 500),
          _op(CashOpType.collection, 3000),
          _op(CashOpType.payout, 400),
          _op(CashOpType.refund, 300),
        ],
      );
      expect(sum.cashSales, 4000);
      expect(sum.cashTips, 200);
      expect(sum.expected, 1000 + 4000 + 200 + 500 - 3000 - 400 - 300);
    });

    test('отменённая операция не учитывается', () {
      final sum = CashDrawerSummary.from(opening: 0, sessions: [_s(cash: 1000)], ops: [
        _op(CashOpType.collection, 1000, cancelled: true),
      ]);
      expect(sum.collections, 0);
      expect(sum.expected, 1000);
    });

    test('возврат наличными: приход остаётся, расход записан операцией', () {
      final sum = CashDrawerSummary.from(opening: 0, sessions: [
        _s(cash: 1200, refunded: true, refundCashOut: true),
      ], ops: [
        _op(CashOpType.refund, 1200),
      ]);
      expect(sum.expected, 0);
    });

    test('старый возврат без операции — ни прихода, ни расхода', () {
      final sum = CashDrawerSummary.from(opening: 500, sessions: [_s(cash: 800, refunded: true)], ops: const []);
      expect(sum.expected, 500);
    });

    test('закрытая смена: после пересчёта в кассе столько, сколько оставили', () {
      final sum = CashDrawerSummary.from(opening: 0, sessions: [_s(cash: 3200, tips: 300)], ops: [
        _op(CashOpType.deposit, 1000),
        _op(CashOpType.collection, 2000),
        _op(CashOpType.collection, 1450), // при закрытии
      ], countDiff: -50);
      expect(sum.expected, 1000);
    });

    test('чек без оплаты денег в кассу не приносит', () {
      final sum = CashDrawerSummary.from(opening: 0, sessions: [_s(cash: 0, unpaid: true)], ops: const []);
      expect(sum.expected, 0);
    });
  });

  group('«Скопировать отчёт» — только итоги', () {
    test('строки в нужном порядке, без позиций', () {
      final text = xReportTotalsText(
        period: 'смена с 27.09.2026 10:02',
        orderTotal: 15430,
        revenue: 13993,
        card: 12993,
        cash: 1000,
        terminal: 0,
        comp: 0,
        collections: 3000,
        cashInDrawer: 1350,
      );
      expect(text.split('\n'), [
        'X-отчёт: смена с 27.09.2026 10:02',
        '',
        'Итого: 15 430 ₽',
        'К оплате: 13 993 ₽',
        'Оплачено картой: 12 993 ₽',
        'Оплачено наличными: 1 000 ₽',
        'Оплачено терминалом: 0 ₽',
        'За счёт заведения: 0 ₽',
        'Инкассация: 3 000 ₽',
        'Наличные в кассе: 1 350 ₽',
      ]);
    });

    test('за период по датам — без «Наличные в кассе», с официантом', () {
      final text = xReportTotalsText(
        period: '01.09.2026 — 30.09.2026',
        waiter: 'Анна',
        orderTotal: 100,
        revenue: 100,
        card: 100,
        cash: 0,
        terminal: 0,
        comp: 0,
        collections: 0,
      );
      expect(text, contains('Официант: Анна'));
      expect(text, isNot(contains('Наличные в кассе')));
    });
  });
}
