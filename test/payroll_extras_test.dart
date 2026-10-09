import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/payroll_adjustment.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/services/payroll_item_bonus.dart';

SessionModel _check(List<OrderItem> items, {bool refunded = false}) => SessionModel(
      id: 's',
      tableId: 't',
      tableName: 'Стол 1',
      employeeName: 'Алина',
      startTime: DateTime(2026, 10, 9),
      plannedEnd: DateTime(2026, 10, 9),
      orderItems: items,
      status: 'closed',
      refunded: refunded,
    );

void main() {
  test('бонус за позицию — автору штук, возвраты не считаются', () {
    final menu = {
      'cake': MenuItem(id: 'cake', categoryId: 'c', name: 'Чизкейк', price: 400, staffBonus: 50),
      'tea': MenuItem(id: 'tea', categoryId: 'c', name: 'Чай', price: 300),
    };
    final sessions = [
      _check([
        OrderItem(menuItemId: 'cake', name: 'Чизкейк', price: 400, qty: 3, by: const {'alina': 2, 'oleg': 1}),
        OrderItem(menuItemId: 'tea', name: 'Чай', price: 300, qty: 1, by: const {'alina': 1}),
      ]),
      _check([OrderItem(menuItemId: 'cake', name: 'Чизкейк', price: 400, qty: 5, by: const {'alina': 5})], refunded: true),
    ];
    final b = itemBonuses(sessions, menu);
    expect(b['alina']!.amount, 100);
    expect(b['alina']!.qtyByItem, {'Чизкейк': 2});
    expect(b['oleg']!.amount, 50);
  });

  test('премия и штраф меняют начисленное, аванс и выплата — выданное', () {
    final at = DateTime(2026, 10, 9);
    const id = 'alina';
    final list = [
      PayrollAdjustment(employeeId: id, type: PayrollAdjustment.bonus, amount: 1000, at: at),
      PayrollAdjustment(employeeId: id, type: PayrollAdjustment.penalty, amount: 300, at: at),
      PayrollAdjustment(employeeId: id, type: PayrollAdjustment.advance, amount: 5000, at: at),
    ];
    expect(list.fold<double>(0, (a, x) => a + x.signedAccrual), 700);
    expect(list.fold<double>(0, (a, x) => a + x.paidOut), 5000);
    expect(list.where((a) => a.isAccrual).length, 2);
  });
}
