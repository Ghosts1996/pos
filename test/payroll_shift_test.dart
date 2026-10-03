import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/employee.dart';
import 'package:hookah_pos/models/staff_shift_model.dart';
import 'package:hookah_pos/screens/admin/employees_screen.dart';
import 'package:hookah_pos/services/payroll_calculator.dart';

Employee _emp({
  double shiftRate = 3000,
  bool overtime = false,
  double threshold = 12,
  double overtimeHourRate = 380,
  bool sales = false,
  double salesPercent = 0,
}) =>
    Employee(
      id: 'e1',
      name: 'Анна',
      pinCode: '1234',
      role: 'employee',
      shiftRateEnabled: true,
      shiftRate: shiftRate,
      overtimeEnabled: overtime,
      overtimeThresholdHours: threshold,
      overtimeHourRate: overtimeHourRate,
      salesPercentEnabled: sales,
      salesPercentRate: salesPercent,
    );

StaffShiftModel _shift(DateTime start, double hours, {String id = 's'}) => StaffShiftModel(
      id: id,
      employeeId: 'e1',
      employeeName: 'Анна',
      startedAt: start,
      endedAt: start.add(Duration(minutes: (hours * 60).round())),
      status: 'closed',
    );

void main() {
  group('Оклад за смену', () {
    test('фиксированная сумма за каждую смену, сколько бы она ни длилась', () {
      final r = PayrollCalculator.calculate(
        employee: _emp(),
        closedShifts: [
          _shift(DateTime(2026, 9, 1, 14), 6),
          _shift(DateTime(2026, 9, 2, 14), 12),
          _shift(DateTime(2026, 9, 3, 14), 14),
        ],
        salesRevenue: 0,
      );
      expect(r.shiftsPaid, 3);
      expect(r.shiftPay, 9000);
      expect(r.overtimePay, 0, reason: 'переработка выключена');
      expect(r.wages, 9000);
    });

    test('переработка — за каждый час сверх нормы смены', () {
      final r = PayrollCalculator.calculate(
        employee: _emp(overtime: true, threshold: 12, overtimeHourRate: 380),
        closedShifts: [
          _shift(DateTime(2026, 9, 1, 14), 14.5), // 2,5 ч переработки
          _shift(DateTime(2026, 9, 2, 14), 10), // без переработки
        ],
        salesRevenue: 0,
      );
      expect(r.shiftPay, 6000);
      expect(r.overtimeHours, 2.5);
      expect(r.overtimePay, 950);
      expect(r.overtimeHourPrice, 380);
      expect(r.wages, 6950);
    });

    test('случайно закрытая и снова открытая смена — одна смена, часы складываются', () {
      final r = PayrollCalculator.calculate(
        employee: _emp(overtime: true, threshold: 12),
        closedShifts: [
          _shift(DateTime(2026, 9, 1, 14), 8, id: 'a'), // 14:00–22:00
          _shift(DateTime(2026, 9, 1, 22, 30), 5, id: 'b'), // 22:30–03:30, перерыв 30 мин
        ],
        salesRevenue: 0,
      );
      expect(r.shiftsPaid, 1);
      expect(r.shiftPay, 3000);
      expect(r.overtimeHours, 1); // 8 + 5 = 13 ч при норме 12
    });

    test('перерыв 3 часа и больше — это уже две смены', () {
      final r = PayrollCalculator.calculate(
        employee: _emp(),
        closedShifts: [
          _shift(DateTime(2026, 9, 1, 10), 4, id: 'a'), // до 14:00
          _shift(DateTime(2026, 9, 1, 17), 6, id: 'b'), // с 17:00
        ],
        salesRevenue: 0,
      );
      expect(r.shiftsPaid, 2);
      expect(r.shiftPay, 6000);
    });

    test('открытая и испорченная смены в оклад не входят', () {
      final r = PayrollCalculator.calculate(
        employee: _emp(),
        closedShifts: [
          StaffShiftModel(id: 'open', employeeId: 'e1', employeeName: 'Анна', startedAt: DateTime(2026, 9, 1, 14), status: 'open'),
          StaffShiftModel(
              id: 'bad',
              employeeId: 'e1',
              employeeName: 'Анна',
              startedAt: DateTime(2026, 9, 2, 14),
              endedAt: DateTime(2026, 9, 2, 13),
              status: 'closed'),
        ],
        salesRevenue: 0,
      );
      expect(r.shiftsPaid, 0);
      expect(r.wages, 0);
    });

    test('оклад за смену складывается с процентом с продаж и чаевыми', () {
      final r = PayrollCalculator.calculate(
        employee: _emp(sales: true, salesPercent: 5),
        closedShifts: [_shift(DateTime(2026, 9, 1, 14), 12)],
        salesRevenue: 40000,
        tips: 700,
      );
      expect(r.wages, 3000 + 2000);
      expect(r.total, 5700);
    });

    test('отрицательные суммы из старых данных не уводят зарплату в минус', () {
      final r = PayrollCalculator.calculate(
        employee: _emp(shiftRate: -100, overtime: true, overtimeHourRate: -50, threshold: 1),
        closedShifts: [_shift(DateTime(2026, 9, 1, 14), 5)],
        salesRevenue: 0,
      );
      expect(r.wages, 0);
    });

    test('почасовая ставка по-прежнему считает переработку множителем', () {
      final e = Employee(
        id: 'e1',
        name: 'Анна',
        pinCode: '1234',
        role: 'employee',
        hourlyRateEnabled: true,
        hourlyRate: 200,
        overtimeEnabled: true,
        overtimeThresholdHours: 8,
        overtimeMultiplier: 1.5,
        overtimeHourRate: 999, // не используется при почасовой
      );
      final r = PayrollCalculator.calculate(employee: e, closedShifts: [_shift(DateTime(2026, 9, 1, 9), 10)], salesRevenue: 0);
      expect(r.hourlyPay, 1600);
      expect(r.overtimePay, 600);
      expect(r.shiftPay, 0);
    });
  });

  group('Карточка сотрудника', () {
    test('оклад за смену сохраняется и читается', () {
      final m = _emp(overtime: true).toMap();
      expect(m['shiftRateEnabled'], isTrue);
      expect(m['shiftRate'], 3000);
      expect(m['overtimeHourRate'], 380);
      expect(_emp().payrollConfigured, isTrue);
    });
    test('сводка в списке сотрудников', () {
      expect(payrollSummary(_emp(overtime: true, sales: true, salesPercent: 5)), '3 000 ₽ за смену + переработка · 5% с чеков');
      expect(payrollSummary(Employee(id: 'x', name: 'К', pinCode: '1', role: 'employee', salesPercentEnabled: true, hookahPercentRate: 10, barPercentRate: 2.5)),
          '10% с кальянов · 2,5% с бара');
      expect(payrollSummary(Employee(id: 'x', name: 'Б', pinCode: '1', role: 'employee', hourlyRateEnabled: true, hourlyRate: 250)),
          '250 ₽ в час');
      expect(payrollSummary(Employee(id: 'x', name: 'Б', pinCode: '1', role: 'employee')), '');
    });
  });
}
