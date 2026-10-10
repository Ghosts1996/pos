import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/aggregator.dart';
import 'package:hookah_pos/models/employee.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/screens/employee/x_report_screen.dart';
import 'package:hookah_pos/services/payroll_sales.dart';

SessionModel _s({
  double cash = 0,
  double card = 0,
  double aggregator = 0,
  String aggregatorId = '',
  String aggregatorName = '',
  double commission = 0,
}) =>
    SessionModel(
      id: 's1',
      tableId: 't',
      tableName: 'Доставка',
      employeeName: 'Анна',
      employeeId: 'e1',
      startTime: DateTime(2026, 10, 9, 18),
      plannedEnd: DateTime(2026, 10, 9, 20),
      closedAt: DateTime(2026, 10, 9, 19),
      status: 'closed',
      paymentCash: cash,
      paymentCard: card,
      paymentAggregator: aggregator,
      aggregator: aggregatorId,
      aggregatorName: aggregatorName,
      aggregatorCommission: commission,
      orderItems: [OrderItem(menuItemId: 'm1', name: 'Пицца', price: 1000, qty: 1)],
    );

void main() {
  tearDown(() => enabledAggregators = const []);

  group('Настройки агрегаторов', () {
    test('по умолчанию выключены, чек пробивает агрегатор', () {
      final all = AggregatorSettings.listFrom(null);
      expect(all.map((a) => a.id), ['yandex_eda', 'kuper', 'megamarket', 'custom']);
      expect(all.every((a) => !a.enabled && a.aggregatorIssuesReceipt && a.commission == 0), isTrue);
    });

    test('читаются из settings/integrations, лишнее и мусор не ломают', () {
      final all = AggregatorSettings.listFrom({
        'aggregators': {
          'yandex_eda': {'enabled': true, 'commission': 25, 'aggregatorIssuesReceipt': true},
          'kuper': {'enabled': true, 'commission': '18,5', 'aggregatorIssuesReceipt': false},
          'custom': {'enabled': true, 'name': '  Самокат ', 'commission': 300},
          'unknown': {'enabled': true},
          'megamarket': 'мусор',
        },
      });
      final byId = {for (final a in all) a.id: a};
      expect(byId['yandex_eda']!.label, 'Яндекс Еда');
      expect(byId['yandex_eda']!.commission, 25);
      expect(byId['kuper']!.aggregatorIssuesReceipt, isFalse);
      expect(byId['megamarket']!.enabled, isFalse);
      expect(byId['custom']!.label, 'Самокат');
      expect(byId['custom']!.commission, 100, reason: 'комиссия не больше 100%');
      expect(all, hasLength(4), reason: 'неизвестный агрегатор пропущен');
    });

    test('сохраняются и читаются обратно без потерь', () {
      const a = AggregatorSettings(id: 'custom', enabled: true, customName: 'Самокат', commission: 12.5);
      final back = AggregatorSettings.fromMap('custom', a.toMap());
      expect(back.enabled, isTrue);
      expect(back.label, 'Самокат');
      expect(back.commission, 12.5);
      expect(back.aggregatorIssuesReceipt, isTrue);
      expect(const AggregatorSettings(id: 'kuper').toMap().containsKey('name'), isFalse);
      expect(const AggregatorSettings(id: 'custom').label, 'Агрегатор');
    });

    test('к выплате — за вычетом комиссии', () {
      expect(const AggregatorSettings(id: 'yandex_eda', commission: 25).payout(1000), 750);
      expect(const AggregatorSettings(id: 'yandex_eda').payout(1000), 1000);
    });

    test('окно оплаты видит только подключённые', () {
      applyAggregatorSettings({
        'aggregators': {
          'yandex_eda': {'enabled': true},
          'kuper': {'enabled': false},
        },
      });
      expect(enabledAggregators.map((a) => a.id), ['yandex_eda']);
      expect(aggregatorById('yandex_eda')?.label, 'Яндекс Еда');
      expect(aggregatorById('kuper'), isNull);
      applyAggregatorSettings(const {});
      expect(enabledAggregators, isEmpty);
    });
  });

  group('Оплата через агрегатор на кассе', () {
    const yandex = AggregatorSettings(id: 'yandex_eda', enabled: true);
    const kuperOwnReceipt = AggregatorSettings(id: 'kuper', enabled: true, aggregatorIssuesReceipt: false);

    test('без суммы через агрегатор — проверять нечего', () {
      expect(aggregatorPaymentProblem(amount: 0, choice: null, otherPaid: 500), isNull);
    });

    test('сумма есть, агрегатор не выбран — просим выбрать', () {
      expect(aggregatorPaymentProblem(amount: 1000, choice: null, otherPaid: 0), contains('Выберите'));
    });

    test('чек пробивает агрегатор — весь счёт только через него', () {
      expect(aggregatorPaymentProblem(amount: 1000, choice: yandex, otherPaid: 0), isNull);
      expect(aggregatorPaymentProblem(amount: 700, choice: yandex, otherPaid: 300), contains('Яндекс Еда'));
    });

    test('чек пробивает заведение — можно вместе с другими способами', () {
      expect(aggregatorPaymentProblem(amount: 700, choice: kuperOwnReceipt, otherPaid: 300), isNull);
    });
  });

  group('Чек, оплаченный через агрегатор', () {
    test('входит в сумму оплат отдельной строкой, а не в карту или наличные', () {
      final s = _s(aggregator: 1000, aggregatorId: 'yandex_eda', aggregatorName: 'Яндекс Еда', commission: 25);
      expect(s.paymentTotal, 1000);
      expect(s.paymentCard, 0);
      expect(s.paymentCash, 0);
      expect(s.aggregatorPayout, 750);
      final m = s.toMap();
      expect(m['paymentAggregator'], 1000);
      expect(m['aggregator'], 'yandex_eda');
      expect(m['aggregatorName'], 'Яндекс Еда');
      expect(m['aggregatorCommission'], 25);
    });

    test('обычный чек — полей агрегатора в документе нет', () {
      final m = _s(cash: 1000).toMap();
      expect(m.containsKey('paymentAggregator'), isFalse);
      expect(m.containsKey('aggregator'), isFalse);
      expect(m.containsKey('aggregatorCommission'), isFalse);
    });

    test('X-отчёт текстом: агрегатор своей строкой', () {
      final text = xReportTotalsText(
        period: 'смена',
        orderTotal: 3000,
        revenue: 3000,
        card: 1000,
        cash: 0,
        terminal: 0,
        aggregators: const {'Яндекс Еда': 1500, 'Купер': 500},
        comp: 0,
        collections: 0,
      );
      final lines = text.split('\n');
      expect(lines, containsAllInOrder([
        'Оплачено терминалом: 0 ₽',
        'Агрегатор · Яндекс Еда: 1 500 ₽',
        'Агрегатор · Купер: 500 ₽',
        'За счёт заведения: 0 ₽',
      ]));
    });

    test('процент с продаж считается и с заказов агрегатора', () {
      final r = PayrollSales.attribute(
        sessions: [_s(aggregator: 1000, aggregatorId: 'yandex_eda', aggregatorName: 'Яндекс Еда')],
        employees: [Employee(id: 'e1', name: 'Анна', pinCode: '1111', role: 'employee')],
        shifts: const [],
      );
      expect(r.of('e1').where((c) => c.base == 'check').map((c) => c.amount), [1000]);
    });
  });
}
