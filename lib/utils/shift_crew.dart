import '../models/employee.dart';
import '../models/staff_shift_model.dart';
import 'constants.dart';
import 'table_label.dart';

/// Смена заведения (касса, X-отчёт) и личные смены сотрудников — разные
/// вещи. Касса одна на всех и живёт, пока в зале работает хоть кто-то;
/// личная смена у каждого своя: кальянщик закончил и ушёл домой — касса и
/// X-отчёт официанта с барменом от этого не меняются.
///
/// Смену, которую не закрыли больше суток назад, считаем «зависшей»:
/// её забыли закрыть вчера, и в неё не надо дописывать сегодняшние чеки.
const staleShiftAfter = Duration(hours: 16);

bool isStaleShift(DateTime openedAt, {DateTime? now}) =>
    (now ?? DateTime.now()).difference(openedAt) >= staleShiftAfter;

/// Кто сейчас на смене: открытые личные смены с карточками сотрудников.
///
/// Личную смену, начатую 16+ часов назад, забыли закончить вчера — такой
/// сотрудник не «на смене»: вызовы ему не идут, и уйти последним он не
/// может. Эти смены лежат отдельно в [forgotten] — их закрывают с
/// правильным временем ухода (сам сотрудник при входе или админ в табеле).
class ShiftCrew {
  final List<StaffShiftModel> shifts;
  final List<StaffShiftModel> forgotten;
  final Map<String, Employee> employees;

  factory ShiftCrew(List<StaffShiftModel> open, {Map<String, Employee> employees = const {}, DateTime? now}) {
    final fresh = <StaffShiftModel>[], old = <StaffShiftModel>[];
    for (final s in _dedupe(open)) {
      (isStaleShift(s.startedAt, now: now) ? old : fresh).add(s);
    }
    return ShiftCrew._(fresh, old, employees);
  }

  const ShiftCrew._(this.shifts, this.forgotten, this.employees);

  /// Если у сотрудника почему-то две открытые смены (сбой сети между
  /// закрытием и записью указателя), считаем его один раз — по самой
  /// свежей.
  static List<StaffShiftModel> _dedupe(List<StaffShiftModel> open) {
    final byEmployee = <String, StaffShiftModel>{};
    for (final s in open) {
      if (!s.isOpen) continue;
      final prev = byEmployee[s.employeeId];
      if (prev == null || s.startedAt.isAfter(prev.startedAt)) byEmployee[s.employeeId] = s;
    }
    return byEmployee.values.toList()..sort((a, b) => a.startedAt.compareTo(b.startedAt));
  }

  int get count => shifts.length;
  bool get isEmpty => shifts.isEmpty;

  bool has(String employeeId) => shifts.any((s) => s.employeeId == employeeId);

  /// Открытая личная смена сотрудника — и текущая, и забытая.
  StaffShiftModel? of(String employeeId) {
    for (final s in [...shifts, ...forgotten]) {
      if (s.employeeId == employeeId) return s;
    }
    return null;
  }

  /// Все, кроме [employeeId], — те, кто останется в зале, если он уйдёт.
  List<StaffShiftModel> othersThan(String employeeId) =>
      shifts.where((s) => s.employeeId != employeeId).toList();

  /// [employeeId] уходит последним: кроме него, на смене никого.
  bool isLast(String employeeId) => othersThan(employeeId).isEmpty;

  String nameOf(StaffShiftModel s) {
    final e = employees[s.employeeId];
    final name = (e?.name ?? '').trim().isNotEmpty ? e!.name.trim() : s.employeeName.trim();
    return name.isEmpty ? 'Без имени' : name;
  }

  /// «Официант», «Кальянщик»… Универсала не подписываем — это обычный
  /// сотрудник без специализации.
  String positionOf(StaffShiftModel s) {
    final p = AppConstants.normalizePosition(employees[s.employeeId]?.position);
    return p == AppConstants.positionUniversal ? '' : AppConstants.positionShortLabel(p);
  }

  /// «Аня · официант».
  String labelOf(StaffShiftModel s) {
    final pos = positionOf(s);
    return pos.isEmpty ? nameOf(s) : '${nameOf(s)} · ${pos.toLowerCase()}';
  }

  /// «Аня, Игорь и ещё 2» — коротко для строки в меню.
  static String shortNames(List<String> names, {int max = 3}) {
    if (names.isEmpty) return '';
    if (names.length <= max) return names.join(', ');
    return '${names.take(max).join(', ')} и ещё ${names.length - max}';
  }

  /// «На смене 3: Аня, Игорь, Олег» / «Никто не отметил начало смены».
  String summary({int max = 3}) {
    if (isEmpty) return 'Никто не отметил начало смены';
    return 'На смене $count: ${shortNames(shifts.map(nameOf).toList(), max: max)}';
  }

  /// «3 человека» — для фраз вроде «сейчас на смене 3 человека».
  static String peopleCount(int n) => '$n ${pluralRu(n, 'человек', 'человека', 'человек')}';
}

/// «6 ч 10 мин», «45 мин».
String workedLabel(Duration d) {
  final m = d.inMinutes < 0 ? 0 : d.inMinutes;
  final h = m ~/ 60;
  final rest = m % 60;
  if (h == 0) return '$rest мин';
  return rest == 0 ? '$h ч' : '$h ч $rest мин';
}

/// Показывать ли вызовы гостей и напоминания на этом устройстве.
///
/// Уведомления получают те, кто отметил начало своей смены (дальше делит
/// специализация); закончил смену — перестаёт получать, даже если открывал
/// смену заведения. Если начало смены никто не отмечал — тому, кто открыл
/// смену заведения. Молчим, только когда точно работает кто-то другой:
/// потерянный вызов хуже лишнего уведомления.
bool alertsForThisDevice({
  required Set<String> onShift,
  required String myId,
  required String deviceOwnerId,
  required String shiftOpenerId,
}) {
  if (myId.isEmpty) return true;
  if (onShift.isNotEmpty) {
    return onShift.contains(myId) || (deviceOwnerId.isNotEmpty && onShift.contains(deviceOwnerId));
  }
  return shiftOpenerId.isEmpty || shiftOpenerId == deviceOwnerId || shiftOpenerId == myId;
}
