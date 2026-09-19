import '../models/employee.dart';
import '../models/staff_shift_model.dart';

/// Результат расчёта зарплаты одного сотрудника за период.
class PayrollResult {
  final Employee employee;
  final double normalHours;
  final double overtimeHours;
  final double hourlyPay;
  final double overtimePay;
  final double salesRevenue;
  final double salesPercentPay;
  final int shiftsCount;

  PayrollResult({
    required this.employee,
    required this.normalHours,
    required this.overtimeHours,
    required this.hourlyPay,
    required this.overtimePay,
    required this.salesRevenue,
    required this.salesPercentPay,
    required this.shiftsCount,
  });

  double get totalHours => normalHours + overtimeHours;
  double get total => hourlyPay + overtimePay + salesPercentPay;
}

/// Считает зарплату сотрудника за период по его же закрытым личным сменам и
/// выручке от его продаж. Никакой работы с календарными сутками или
/// часовыми поясами: часы — это разница двух Timestamp (endedAt - startedAt)
/// в секундах, делённая на 3600. Так смена, идущая через полночь, считается
/// ровно так же, как любая другая — не теряется и не задваивается.
class PayrollCalculator {
  /// Переработка считается ОТДЕЛЬНО ПО КАЖДОЙ смене, а не суммарно за
  /// календарный день или весь период: если порог у сотрудника — 8 часов, а
  /// он отработал две смены по 6 часов в один день, переработки не будет
  /// (в каждой смене меньше порога), даже если суммарно за день 12 часов.
  /// Это осознанный выбор: рабочее время всегда привязано к факту открытия
  /// и закрытия ИМЕННО ЭТОЙ смены сотрудником, без попытки сгруппировать
  /// смены по календарным суткам — группировка была бы неоднозначной для
  /// смен через полночь и создавала бы ровно тот риск ошибки в днях/часах,
  /// которого нужно избежать.
  static PayrollResult calculate({
    required Employee employee,
    required List<StaffShiftModel> closedShifts,
    required double salesRevenue,
  }) {
    double normalHours = 0;
    double overtimeHours = 0;

    for (final shift in closedShifts) {
      final endedAt = shift.endedAt;
      if (endedAt == null) continue; // открытая смена в расчёт не входит
      final hours = endedAt.difference(shift.startedAt).inSeconds / 3600.0;
      if (hours <= 0) continue; // защита от испорченной ручной записи (конец раньше начала)

      if (employee.overtimeEnabled && hours > employee.overtimeThresholdHours) {
        normalHours += employee.overtimeThresholdHours;
        overtimeHours += hours - employee.overtimeThresholdHours;
      } else {
        normalHours += hours;
      }
    }

    final hourlyPay = employee.hourlyRateEnabled ? normalHours * employee.hourlyRate : 0.0;
    final overtimePay = employee.hourlyRateEnabled && employee.overtimeEnabled
        ? overtimeHours * employee.hourlyRate * employee.overtimeMultiplier
        : 0.0;
    final salesPercentPay =
        employee.salesPercentEnabled ? salesRevenue * employee.salesPercentRate / 100.0 : 0.0;

    return PayrollResult(
      employee: employee,
      normalHours: normalHours,
      overtimeHours: overtimeHours,
      hourlyPay: hourlyPay,
      overtimePay: overtimePay,
      salesRevenue: salesRevenue,
      salesPercentPay: salesPercentPay,
      shiftsCount: closedShifts.where((s) => s.endedAt != null).length,
    );
  }
}
