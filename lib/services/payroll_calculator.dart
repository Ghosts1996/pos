import '../models/employee.dart';
import '../models/pay_terms.dart';
import '../models/staff_shift_model.dart';
import 'payroll_sales.dart';

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

  /// Все базы процентов вместе и весь процент — для итогов.
  final double salesRevenue;
  final double salesPercentPay;
  final int shiftsCount;

  // Процент по видам продаж (см. PayrollSales).
  final double checkRevenue;
  final double checkPay;
  final double hookahRevenue;
  final double hookahPersonal; // из [hookahRevenue] — кальяны, которые добавил сам
  final double hookahPay;
  final double barRevenue;
  final double barPersonal;
  final double barPay;

  /// Чаевые за период (оплаченные вместе со счётом, включая долю от
  /// «чаевых всей смене»). Не зарплата, но выдать их сотруднику нужно.
  final double tips;

  // Что стоит проверить владельцу: ручные правки часов и подозрительно
  // длинные смены. Не ошибка, но без этих пометок их не заметить.
  final int manualShifts;
  final double manualHours;
  final int selfEditedShifts;
  final Set<String> editors;
  final int longShifts;

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
    this.checkRevenue = 0,
    this.checkPay = 0,
    this.hookahRevenue = 0,
    this.hookahPersonal = 0,
    this.hookahPay = 0,
    this.barRevenue = 0,
    this.barPersonal = 0,
    this.barPay = 0,
    this.tips = 0,
    this.manualShifts = 0,
    this.manualHours = 0,
    this.selfEditedShifts = 0,
    this.editors = const {},
    this.longShifts = 0,
  });

  double get totalHours => normalHours + overtimeHours;
  double get wages => hourlyPay + shiftPay + overtimePay + salesPercentPay;

  /// Цена часа переработки — для строки «2 ч × 375 ₽» в отчёте.
  double get overtimeHourPrice => overtimeHours > 0 ? overtimePay / overtimeHours : 0;

  /// К выплате: зарплата + чаевые.
  double get total => wages + tips;

  /// Есть что проверить: ручные правки или очень длинные смены.
  bool get needsReview => manualShifts > 0 || longShifts > 0;
}

/// Считает зарплату сотрудника за период по его же личным сменам и
/// продажам. Ставки — те, что действовали в момент смены или продажи
/// (история в карточке, см. PayTerms): поднять ставку в конце месяца и
/// пересчитать весь месяц нельзя.
///
/// Никакой работы с календарными сутками или часовыми поясами: часы — это
/// разница двух моментов (конец − начало) в секундах, делённая на 3600.
/// Смена через полночь считается так же, как любая другая.
class PayrollCalculator {
  /// Оклад за смену: если сотрудник закрыл смену и открыл снова меньше чем
  /// через столько времени (случайно нажал «Закончить смену», отходил),
  /// это одна рабочая смена — оклад за неё один, а часы для переработки
  /// складываются. Иначе один выход на работу оплачивался бы дважды.
  static const shiftMergeGap = Duration(hours: 3);

  /// Смена длиннее — пометка «проверьте» в отчёте.
  static const longShiftHours = 14.0;

  /// Рабочие смены для оклада за смену: закрытые, с положительной длиной,
  /// по времени начала; соседние с перерывом меньше [shiftMergeGap] —
  /// одна смена (её часы = сумма часов частей, без перерыва).
  static List<double> workedShiftHours(List<StaffShiftModel> shifts) =>
      _group(shifts, (_) => true).map((g) => g.hours).toList();

  /// Переработка считается ОТДЕЛЬНО ПО КАЖДОЙ смене, а не суммарно за
  /// календарный день или весь период: если порог у сотрудника — 8 часов, а
  /// он отработал две смены по 6 часов в один день, переработки не будет.
  ///
  /// [salesRevenue] — старый вход «выручка по его чекам», процент с неё — по
  /// текущей ставке. Новый — [credits] из PayrollSales.
  static PayrollResult calculate({
    required Employee employee,
    required List<StaffShiftModel> closedShifts,
    double salesRevenue = 0,
    List<SaleCredit> credits = const [],
    double tips = 0,
  }) {
    final live = closedShifts.where((s) => !s.cancelled).toList();
    final groups = _group(live, (s) => employee.termsAt(s.effectiveStart).shiftRateEnabled,
        termsOf: (s) => employee.termsAt(s.effectiveStart));

    double normalHours = 0;
    double overtimeHours = 0;
    double hourlyPay = 0;
    double shiftPay = 0;
    double overtimePay = 0;
    var shiftsPaid = 0;
    for (final g in groups) {
      final t = g.terms ?? employee.payTerms;
      final threshold = t.safeOvertimeThreshold;
      final over = t.overtimeEnabled && g.hours > threshold ? g.hours - threshold : 0.0;
      final normal = g.hours - over;
      normalHours += normal;
      overtimeHours += over;
      if (t.hourlyRateEnabled) hourlyPay += normal * t.safeHourlyRate;
      if (t.shiftRateEnabled) {
        shiftPay += t.safeShiftRate;
        shiftsPaid++;
      }
      if (t.overtimeEnabled && over > 0) {
        if (t.shiftRateEnabled) {
          overtimePay += over * t.safeOvertimeHourRate;
        } else if (t.hourlyRateEnabled) {
          overtimePay += over * t.safeHourlyRate * t.safeOvertimeMultiplier;
        }
      }
    }

    double checkRevenue = 0, checkPay = 0;
    double hookahRevenue = 0, hookahPersonal = 0, hookahPay = 0;
    double barRevenue = 0, barPersonal = 0, barPay = 0;
    if (credits.isEmpty && salesRevenue > 0) {
      checkRevenue = salesRevenue;
      checkPay = salesRevenue * employee.payTerms.percentFor('check') / 100;
    }
    for (final c in credits) {
      final t = employee.termsAt(c.at);
      switch (c.base) {
        case 'hookah':
          hookahRevenue += c.amount;
          if (c.personal) hookahPersonal += c.amount;
          hookahPay += c.amount * t.percentFor('hookah') / 100;
        case 'bar':
          barRevenue += c.amount;
          if (c.personal) barPersonal += c.amount;
          barPay += c.amount * t.percentFor('bar') / 100;
        default:
          final base = t.checkPercentExcludesHookah ? c.amount - c.hookahAmount : c.amount;
          checkRevenue += base;
          checkPay += base * t.percentFor('check') / 100;
      }
    }

    final closed = live.where((s) => s.endedAt != null).toList();
    final manual = closed.where((s) => s.manual).toList();
    return PayrollResult(
      employee: employee,
      normalHours: normalHours,
      overtimeHours: overtimeHours,
      hourlyPay: hourlyPay,
      shiftPay: shiftPay,
      shiftsPaid: shiftsPaid,
      overtimePay: overtimePay,
      salesRevenue: checkRevenue + hookahRevenue + barRevenue,
      salesPercentPay: checkPay + hookahPay + barPay,
      shiftsCount: closed.length,
      checkRevenue: checkRevenue,
      checkPay: checkPay,
      hookahRevenue: hookahRevenue,
      hookahPersonal: hookahPersonal,
      hookahPay: hookahPay,
      barRevenue: barRevenue,
      barPersonal: barPersonal,
      barPay: barPay,
      tips: tips,
      manualShifts: manual.length,
      manualHours: manual.fold<double>(0, (a, s) => a + s.paidHours),
      selfEditedShifts: manual.where((s) => s.selfEdited).length,
      editors: {for (final s in manual) if (s.editedByName.isNotEmpty) s.editedByName},
      longShifts: closed.where((s) => s.paidHours > longShiftHours).length,
    );
  }

  /// Закрытые смены с положительной длиной по времени начала. Соседние
  /// склеиваются в одну рабочую смену, если [mergeable] для обеих (оклад
  /// за смену) и перерыв меньше [shiftMergeGap].
  static List<_WorkedShift> _group(
    List<StaffShiftModel> shifts,
    bool Function(StaffShiftModel) mergeable, {
    PayTerms Function(StaffShiftModel)? termsOf,
  }) {
    final closed = shifts.where((s) => !s.cancelled && s.paidHours > 0).toList()
      ..sort((a, b) => a.effectiveStart.compareTo(b.effectiveStart));
    final out = <_WorkedShift>[];
    DateTime? lastEnd;
    var lastMergeable = false;
    for (final s in closed) {
      final m = mergeable(s);
      if (lastEnd != null && m && lastMergeable && s.effectiveStart.difference(lastEnd) < shiftMergeGap) {
        out.last.hours += s.paidHours;
      } else {
        out.add(_WorkedShift(s.paidHours, termsOf?.call(s)));
        lastMergeable = m;
      }
      if (lastEnd == null || s.endedAt!.isAfter(lastEnd)) lastEnd = s.endedAt;
    }
    return out;
  }
}

class _WorkedShift {
  double hours;
  final PayTerms? terms;
  _WorkedShift(this.hours, this.terms);
}
