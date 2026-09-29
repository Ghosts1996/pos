import '../models/employee.dart';
import '../models/staff_shift_model.dart';

/// Результат расчёта зарплаты одного сотрудника за период.
class PayrollResult {
  final Employee employee;
  final double normalHours;
  final double overtimeHours;
  final double hourlyPay;

  /// Оклад за смену: [shiftsPaid] смен × ставка за смену.
  final double shiftPay;
  final int shiftsPaid;
  final double overtimePay;
  final double salesRevenue;
  final double salesPercentPay;
  final int shiftsCount;

  /// Чаевые за период (оплаченные вместе со счётом, включая долю от
  /// «чаевых всей смене»). Не зарплата, но выдать их сотруднику нужно.
  final double tips;

  PayrollResult({
    required this.employee,
    required this.normalHours,
    required this.overtimeHours,
    required this.hourlyPay,
    this.shiftPay = 0,
    this.shiftsPaid = 0,
    required this.overtimePay,
    required this.salesRevenue,
    required this.salesPercentPay,
    required this.shiftsCount,
    this.tips = 0,
  });

  double get totalHours => normalHours + overtimeHours;
  double get wages => hourlyPay + shiftPay + overtimePay + salesPercentPay;

  /// Цена часа переработки — для строки «2 ч × 375 ₽» в отчёте.
  double get overtimeHourPrice => overtimeHours > 0 ? overtimePay / overtimeHours : 0;

  /// К выплате: зарплата + чаевые.
  double get total => wages + tips;
}

/// Считает зарплату сотрудника за период по его же закрытым личным сменам и
/// выручке от его продаж. Никакой работы с календарными сутками или
/// часовыми поясами: часы — это разница двух Timestamp (endedAt - startedAt)
/// в секундах, делённая на 3600. Так смена, идущая через полночь, считается
/// ровно так же, как любая другая — не теряется и не задваивается.
class PayrollCalculator {
  /// Оклад за смену: если сотрудник закрыл смену и открыл снова меньше чем
  /// через столько времени (случайно нажал «Закончить смену», отходил),
  /// это одна рабочая смена — оклад за неё один, а часы для переработки
  /// складываются. Иначе один выход на работу оплачивался бы дважды.
  static const shiftMergeGap = Duration(hours: 3);

  /// Рабочие смены для оклада за смену: закрытые, с положительной длиной,
  /// по времени начала; соседние с перерывом меньше [shiftMergeGap] —
  /// одна смена (её часы = сумма часов частей, без перерыва).
  static List<double> workedShiftHours(List<StaffShiftModel> shifts) {
    final closed = shifts
        .where((s) => s.endedAt != null && s.endedAt!.isAfter(s.startedAt))
        .toList()
      ..sort((a, b) => a.startedAt.compareTo(b.startedAt));
    final hours = <double>[];
    DateTime? lastEnd;
    for (final s in closed) {
      final h = s.endedAt!.difference(s.startedAt).inSeconds / 3600.0;
      if (lastEnd != null && s.startedAt.difference(lastEnd) < shiftMergeGap) {
        hours[hours.length - 1] += h;
      } else {
        hours.add(h);
      }
      if (lastEnd == null || s.endedAt!.isAfter(lastEnd)) lastEnd = s.endedAt;
    }
    return hours;
  }

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
    double tips = 0,
  }) {
    // Границы значений (множитель переработки не меньше 1, процент с продаж
    // 0..100, ставка и порог переработки не отрицательные) проверяются при
    // сохранении сотрудника (employees_screen.dart) — но ЗДЕСЬ, в самом
    // расчёте, подстраховываемся ещё раз теми же границами: у сотрудника,
    // заведённого до появления этой проверки, в базе мог остаться, например,
    // отрицательный множитель переработки, и без этой подстраховки его
    // зарплата продолжила бы считаться неверно (в том числе в минус) до тех
    // пор, пока кто-то не откроет и не пересохранит его карточку вручную.
    final overtimeThreshold =
        employee.overtimeThresholdHours < 0 ? 0.0 : employee.overtimeThresholdHours;
    final hourlyRate = employee.hourlyRate < 0 ? 0.0 : employee.hourlyRate;
    final overtimeMultiplier = employee.overtimeMultiplier < 1 ? 1.0 : employee.overtimeMultiplier;
    final salesPercentRate = employee.salesPercentRate.clamp(0.0, 100.0);
    final shiftRate = employee.shiftRate < 0 ? 0.0 : employee.shiftRate;
    final overtimeHourRate = employee.overtimeHourRate < 0 ? 0.0 : employee.overtimeHourRate;
    final byShift = employee.shiftRateEnabled;

    double normalHours = 0;
    double overtimeHours = 0;

    // При окладе за смену часы считаются по рабочим сменам (разорванная
    // смена — одна, см. workedShiftHours), при почасовой — по каждой записи.
    final perShiftHours = byShift
        ? workedShiftHours(closedShifts)
        : [
            for (final shift in closedShifts)
              // открытая смена в расчёт не входит; конец раньше начала —
              // испорченная ручная запись
              if (shift.endedAt != null && shift.endedAt!.isAfter(shift.startedAt))
                shift.endedAt!.difference(shift.startedAt).inSeconds / 3600.0,
          ];
    for (final hours in perShiftHours) {
      if (employee.overtimeEnabled && hours > overtimeThreshold) {
        normalHours += overtimeThreshold;
        overtimeHours += hours - overtimeThreshold;
      } else {
        normalHours += hours;
      }
    }

    final hourlyPay = employee.hourlyRateEnabled ? normalHours * hourlyRate : 0.0;
    final shiftsPaid = byShift ? perShiftHours.length : 0;
    final shiftPay = shiftsPaid * shiftRate;
    final double overtimePay;
    if (!employee.overtimeEnabled) {
      overtimePay = 0;
    } else if (byShift) {
      overtimePay = overtimeHours * overtimeHourRate;
    } else if (employee.hourlyRateEnabled) {
      overtimePay = overtimeHours * hourlyRate * overtimeMultiplier;
    } else {
      overtimePay = 0;
    }
    final salesPercentPay =
        employee.salesPercentEnabled ? salesRevenue * salesPercentRate / 100.0 : 0.0;

    return PayrollResult(
      employee: employee,
      normalHours: normalHours,
      overtimeHours: overtimeHours,
      hourlyPay: hourlyPay,
      shiftPay: shiftPay,
      shiftsPaid: shiftsPaid,
      overtimePay: overtimePay,
      salesRevenue: salesRevenue,
      salesPercentPay: salesPercentPay,
      shiftsCount: closedShifts.where((s) => s.endedAt != null).length,
      tips: tips,
    );
  }
}
