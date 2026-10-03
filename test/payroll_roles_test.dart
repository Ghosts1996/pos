import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/employee.dart';
import 'package:hookah_pos/models/pay_terms.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/models/staff_shift_model.dart';
import 'package:hookah_pos/services/payroll_calculator.dart';
import 'package:hookah_pos/services/payroll_sales.dart';
import 'package:hookah_pos/utils/sale_kind.dart';

Employee _emp(String id, {double check = 0, double hookah = 0, double bar = 0, bool exclHookah = false,
    List<PayChange> history = const []}) =>
    Employee(
      id: id,
      name: id,
      pinCode: '1111',
      role: 'employee',
      salesPercentEnabled: true,
      salesPercentRate: check,
      hookahPercentRate: hookah,
      barPercentRate: bar,
      checkPercentExcludesHookah: exclHookah,
      payHistory: history,
    );

final _t0 = DateTime(2026, 10, 1, 20);

SessionModel _check({
  required String waiter,
  required List<OrderItem> items,
  double cash = -1,
  double card = 0,
  double comp = 0,
  double discount = 0,
  bool refunded = false,
  DateTime? closedAt,
}) {
  final total = items.fold<double>(0, (a, i) => a + i.total);
  return SessionModel(
    id: 's',
    tableId: 't',
    tableName: 'Стол 1',
    employeeName: waiter,
    employeeId: waiter,
    startTime: _t0.subtract(const Duration(hours: 2)),
    plannedEnd: _t0,
    orderItems: items,
    discountPercent: discount,
    status: 'closed',
    closedAt: closedAt ?? _t0,
    paymentCash: cash < 0 ? total : cash,
    paymentCard: card,
    paymentComp: comp,
    refunded: refunded,
  );
}

OrderItem _hookah(int qty, {Map<String, int> by = const {}}) =>
    OrderItem(menuItemId: 'h', name: 'Кальян классический', price: 2000, qty: qty, noPromo: true, kind: SaleKind.hookah, by: by);
OrderItem _drink(int qty, {Map<String, int> by = const {}}) =>
    OrderItem(menuItemId: 'd', name: 'Мохито', price: 500, qty: qty, kind: SaleKind.bar, by: by);
OrderItem _food(int qty) => OrderItem(menuItemId: 'f', name: 'Паста', price: 700, qty: qty, kind: SaleKind.kitchen);

StaffShiftModel _shift(String emp, DateTime start, DateTime? end) => StaffShiftModel(
    id: '$emp-${start.millisecondsSinceEpoch}', employeeId: emp, employeeName: emp, startedAt: start, endedAt: end,
    status: end == null ? 'open' : 'closed');

void main() {
  group('Вид продажи', () {
    test('по названию категории: бар, кальян, кухня', () {
      expect(SaleKind.inferFromCategoryName('Напитки'), SaleKind.bar);
      expect(SaleKind.inferFromCategoryName('Чай и кофе'), SaleKind.bar);
      expect(SaleKind.inferFromCategoryName('Коктейли'), SaleKind.bar);
      expect(SaleKind.inferFromCategoryName('Табак и кальяны'), SaleKind.hookah);
      expect(SaleKind.inferFromCategoryName('Горячее'), SaleKind.kitchen);
      expect(SaleKind.inferFromCategoryName('Говядина'), SaleKind.kitchen); // не «вин»
    });
    test('выбор владельца важнее названия, табак — всегда кальян', () {
      expect(SaleKind.forMenuItem(tobacco: false, itemName: 'Чизкейк', categoryKind: SaleKind.bar, categoryName: 'Десерты'),
          SaleKind.bar);
      expect(SaleKind.forMenuItem(tobacco: true, itemName: 'Чаша', categoryKind: SaleKind.bar), SaleKind.hookah);
    });
    test('старые строки без вида: кальян по признаку табака, иначе кухня', () {
      expect(OrderItem(name: 'Кальян', price: 1, qty: 1).effectiveKind, SaleKind.hookah);
      expect(OrderItem(name: 'Паста', price: 1, qty: 1).effectiveKind, SaleKind.kitchen);
    });
  });

  group('Кто добавил позицию', () {
    test('плюс копит штуки по сотрудникам, минус сначала убирает свои', () {
      var item = _drink(1, by: {'bar1': 1}).plus(2, employeeId: 'bar2');
      expect(item.qty, 3);
      expect(item.by, {'bar1': 1, 'bar2': 2});
      item = item.minus(1, employeeId: 'bar1');
      expect(item.by, {'bar2': 2});
      // Чужое «переписать на себя» нельзя: минус от bar3 убирает с крупной доли.
      item = item.minus(1, employeeId: 'bar3');
      expect(item.qty, 1);
      expect(item.by, {'bar2': 1});
    });
    test('разделить счёт: авторы уходят вместе со штуками', () {
      final (out, rest) = _hookah(3, by: {'h1': 2, 'h2': 1}).split(2);
      expect(out.qty, 2);
      expect(rest!.qty, 1);
      final total = {...out.by}..updateAll((k, v) => v + (rest.by[k] ?? 0));
      for (final k in rest.by.keys) {
        total.putIfAbsent(k, () => rest.by[k]!);
      }
      expect(total, {'h1': 2, 'h2': 1});
      expect(out.by.values.fold<int>(0, (a, b) => a + b), 2);
    });
    test('сохраняется и читается', () {
      final back = OrderItem.fromMap(_hookah(2, by: {'h1': 2}).toMap());
      expect(back.by, {'h1': 2});
      expect(back.kind, SaleKind.hookah);
    });
  });

  group('Проценты по ролям', () {
    final waiter = _emp('w', check: 5, exclHookah: true);
    final hm1 = _emp('h1', hookah: 10);
    final hm2 = _emp('h2', hookah: 10);
    final bartender = _emp('b', bar: 5);

    test('кальянщик — свои кальяны, бармен — свои напитки, официант — чек без кальянов', () {
      final s = _check(waiter: 'w', items: [
        _hookah(2, by: {'h1': 2}),
        _drink(2, by: {'b': 2}),
        _food(1),
      ]);
      final r = PayrollSales.attribute(sessions: [s], employees: [waiter, hm1, hm2, bartender], shifts: []);
      final pw = PayrollCalculator.calculate(employee: waiter, closedShifts: [], credits: r.of('w'));
      final ph = PayrollCalculator.calculate(employee: hm1, closedShifts: [], credits: r.of('h1'));
      final pb = PayrollCalculator.calculate(employee: bartender, closedShifts: [], credits: r.of('b'));
      expect(ph.hookahRevenue, 4000);
      expect(ph.hookahPay, 400);
      expect(pb.barPay, 50);
      expect(pw.checkRevenue, 1700); // 1000 напитки + 700 еда, кальяны не считаются
      expect(pw.checkPay, 85);
      expect(PayrollCalculator.calculate(employee: hm2, closedShifts: [], credits: r.of('h2')).hookahPay, 0);
    });

    test('кальян добавил официант — поровну всем кальянщикам на смене', () {
      final s = _check(waiter: 'w', items: [_hookah(1, by: {'w': 1})]);
      final shifts = [
        _shift('h1', _t0.subtract(const Duration(hours: 5)), null),
        _shift('h2', _t0.subtract(const Duration(hours: 1)), _t0.add(const Duration(hours: 3))),
      ];
      final r = PayrollSales.attribute(sessions: [s], employees: [waiter, hm1, hm2], shifts: shifts);
      expect(PayrollCalculator.calculate(employee: hm1, closedShifts: [], credits: r.of('h1')).hookahPay, 100);
      expect(PayrollCalculator.calculate(employee: hm2, closedShifts: [], credits: r.of('h2')).hookahPay, 100);
    });

    test('никого с процентом на смене — сумма видна как «не начислено»', () {
      final s = _check(waiter: 'w', items: [_hookah(1)]);
      final r = PayrollSales.attribute(sessions: [s], employees: [waiter, hm1], shifts: []);
      expect(r.unassigned[SaleKind.hookah], 2000);
    });

    test('процент только с реально полученных денег', () {
      // Половину оплатили «за счёт заведения» или бонусами.
      final s = _check(waiter: 'w', items: [_food(2)], cash: 700, comp: 700);
      final r = PayrollSales.attribute(sessions: [s], employees: [waiter], shifts: []);
      expect(PayrollCalculator.calculate(employee: waiter, closedShifts: [], credits: r.of('w')).checkRevenue, 700);
      // Возврат и чек без денег — ничего.
      final refunded = _check(waiter: 'w', items: [_food(2)], refunded: true);
      final free = _check(waiter: 'w', items: [_food(2)], cash: 0, comp: 1400);
      final r2 = PayrollSales.attribute(sessions: [refunded, free], employees: [waiter], shifts: []);
      expect(r2.of('w'), isEmpty);
    });
  });

  group('Ставки задним числом не пересчитываются', () {
    test('смены до повышения — по старой ставке', () {
      final e = Employee(
        id: 'e',
        name: 'e',
        pinCode: '1111',
        role: 'employee',
        shiftRateEnabled: true,
        shiftRate: 5000,
        payHistory: [
          PayChange(at: PayChange.since, terms: const PayTerms(shiftRateEnabled: true, shiftRate: 2000)),
          PayChange(at: DateTime(2026, 10, 20), terms: const PayTerms(shiftRateEnabled: true, shiftRate: 5000)),
        ],
      );
      final r = PayrollCalculator.calculate(employee: e, closedShifts: [
        _shift('e', DateTime(2026, 10, 5, 12), DateTime(2026, 10, 5, 22)),
        _shift('e', DateTime(2026, 10, 21, 12), DateTime(2026, 10, 21, 22)),
      ]);
      expect(r.shiftPay, 7000); // 2000 + 5000, а не 5000 × 2
    });

    test('процент — по ставке на момент закрытия чека', () {
      final e = _emp('w', check: 10, history: [
        PayChange(at: PayChange.since, terms: const PayTerms(salesPercentEnabled: true, salesPercentRate: 5)),
        PayChange(at: DateTime(2026, 10, 20), terms: const PayTerms(salesPercentEnabled: true, salesPercentRate: 10)),
      ]);
      final early = _check(waiter: 'w', items: [_food(1)], closedAt: DateTime(2026, 10, 2));
      final late = _check(waiter: 'w', items: [_food(1)], closedAt: DateTime(2026, 10, 22));
      final r = PayrollSales.attribute(sessions: [early, late], employees: [e], shifts: []);
      expect(PayrollCalculator.calculate(employee: e, closedShifts: [], credits: r.of('w')).checkPay, 35 + 70);
    });
  });

  group('Смены', () {
    final e = Employee(id: 'e', name: 'e', pinCode: '1111', role: 'employee', hourlyRateEnabled: true, hourlyRate: 100);
    test('отменённая запись в зарплату не идёт', () {
      final s = StaffShiftModel(
          id: 'x', employeeId: 'e', employeeName: 'e', startedAt: DateTime(2026, 10, 1, 10),
          endedAt: DateTime(2026, 10, 1, 20), status: 'closed', cancelled: true);
      expect(PayrollCalculator.calculate(employee: e, closedShifts: [s]).hourlyPay, 0);
    });
    test('до открытия заведения время не считается', () {
      final s = StaffShiftModel(
          id: 'x', employeeId: 'e', employeeName: 'e', startedAt: DateTime(2026, 10, 1, 10),
          countFrom: DateTime(2026, 10, 1, 12), endedAt: DateTime(2026, 10, 1, 20), status: 'closed');
      expect(PayrollCalculator.calculate(employee: e, closedShifts: [s]).normalHours, 8);
    });
    test('ручные правки и длинные смены попадают в «Проверьте»', () {
      final manual = StaffShiftModel(
          id: 'm', employeeId: 'e', employeeName: 'e', startedAt: DateTime(2026, 10, 2, 10),
          endedAt: DateTime(2026, 10, 3, 2), status: 'closed', manual: true, editedById: 'e', editedByName: 'e');
      final r = PayrollCalculator.calculate(employee: e, closedShifts: [manual]);
      expect(r.manualShifts, 1);
      expect(r.selfEditedShifts, 1);
      expect(r.longShifts, 1);
      expect(r.needsReview, isTrue);
    });
  });
}
