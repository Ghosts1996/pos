import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/employee.dart';
import 'package:hookah_pos/models/pay_terms.dart';
import 'package:hookah_pos/services/payroll_calculator.dart';

void main() {
  const step = RevenueStep(threshold: 100000, isFixed: true, value: 3000);
  const pct = RevenueStep(threshold: 200000, isFixed: false, value: 1);

  test('шаги: фиксированная сумма и процент, каждый пройденный — отдельно', () {
    expect(step.bonusFor(99999), 0);
    expect(step.bonusFor(100000), 3000);
    expect(pct.bonusFor(250000), 2500);
  });

  test('удалённый последний шаг записывается пустым списком', () {
    final e = Employee(id: 'e', name: 'Алина', pinCode: '', role: 'employee');
    expect(e.toMap()['revenueSteps'], isEmpty);
    expect(e.toMap().containsKey('revenueSteps'), isTrue);
  });

  test('бонус считается по условиям на конец периода, а не по текущим', () {
    final t0 = DateTime(2026, 9, 1);
    final t1 = DateTime(2026, 10, 1);
    final e = Employee(
      id: 'e', name: 'Алина', pinCode: '', role: 'employee',
      payHistory: [
        PayChange(at: t0, terms: const PayTerms(revenueSteps: [step])),
        PayChange(at: t1, terms: const PayTerms()),
      ],
    );
    final sept = PayrollCalculator.calculate(employee: e, closedShifts: const [], venueRevenue: 150000,
        periodEnd: DateTime(2026, 9, 30, 23, 59));
    final oct = PayrollCalculator.calculate(employee: e, closedShifts: const [], venueRevenue: 150000,
        periodEnd: DateTime(2026, 10, 31, 23, 59));
    expect(sept.revenueStepBonus, 3000);
    expect(oct.revenueStepBonus, 0);
  });
}
