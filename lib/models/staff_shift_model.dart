import 'package:cloud_firestore/cloud_firestore.dart';

/// Личная рабочая смена ОДНОГО сотрудника — учёт времени для расчёта
/// зарплаты. НЕ путать с ShiftModel: та смена одна на всё заведение (касса,
/// открывается/закрывается для всех сразу), а эта — у каждого сотрудника
/// своя, и одновременно может быть открыто сколько угодно (несколько
/// человек работают параллельно). Одна такая смена — это непрерывный отрезок
/// времени от "начал смену" до "закончил смену"; переходить через полночь
/// ей можно, это не календарные сутки.
class StaffShiftModel {
  final String id;
  final String employeeId;
  final String employeeName;
  final DateTime startedAt;
  final DateTime? endedAt;
  final String status; // 'open' | 'closed'
  final bool manual; // true — добавлена/исправлена админом вручную, а не через "начать/закончить смену"

  /// Начали раньше открытия заведения — время до открытия в зарплату не
  /// идёт: считаем с этого момента. Само [startedAt] ставит сервер.
  final DateTime? countFrom;

  /// Кто правил запись вручную (админ в табеле или сам сотрудник, указав
  /// время ухода) — видно в зарплате рядом с часами.
  final String editedById;
  final String editedByName;
  final DateTime? editedAt;

  /// Запись отменена. Смены не удаляются — ошибочную отменяют, и она
  /// остаётся в табеле зачёркнутой, с именем того, кто отменил.
  final bool cancelled;
  final String cancelledByName;

  StaffShiftModel({
    required this.id,
    required this.employeeId,
    required this.employeeName,
    required this.startedAt,
    this.endedAt,
    this.status = 'open',
    this.manual = false,
    this.countFrom,
    this.editedById = '',
    this.editedByName = '',
    this.editedAt,
    this.cancelled = false,
    this.cancelledByName = '',
  });

  bool get isOpen => status == 'open';

  /// Начало рабочего времени для зарплаты: не раньше открытия заведения.
  DateTime get effectiveStart {
    final c = countFrom;
    return c != null && c.isAfter(startedAt) ? c : startedAt;
  }

  /// Часы закрытой смены для зарплаты; 0 — открытая или испорченная.
  double get paidHours {
    final end = endedAt;
    if (end == null || !end.isAfter(effectiveStart)) return 0;
    return end.difference(effectiveStart).inSeconds / 3600.0;
  }

  /// Правил сам сотрудник, чьё это время.
  bool get selfEdited => manual && editedById.isNotEmpty && editedById == employeeId;

  /// Продолжительность смены. У открытой смены считается "по текущий
  /// момент" — только для превью в интерфейсе; в расчёт зарплаты идут
  /// только закрытые смены (см. PayrollCalculator).
  Duration get duration => (endedAt ?? DateTime.now()).difference(startedAt);

  /// Пересекается ли эта ЗАКРЫТАЯ смена по времени с интервалом
  /// [otherStart, otherEnd) — используется перед ручным добавлением/правкой
  /// смены (см. staff_shifts_screen.dart), чтобы не завести вторую запись
  /// поверх уже существующей: без этой проверки часы за пересечение
  /// задваиваются в расчёте зарплаты, а PayrollCalculator сам по себе
  /// пересечения не видит — он просто суммирует все переданные ему смены.
  /// Открытая смена (endedAt == null) не сравнивается — её и так не
  /// подставить в PayrollCalculator, пока она не закрыта.
  bool overlapsRange(DateTime otherStart, DateTime otherEnd) {
    final myEnd = endedAt;
    if (myEnd == null) return false;
    return startedAt.isBefore(otherEnd) && otherStart.isBefore(myEnd);
  }

  factory StaffShiftModel.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return StaffShiftModel(
      id: doc.id,
      employeeId: data['employeeId'] ?? '',
      employeeName: data['employeeName'] ?? '',
      startedAt: (data['startedAt'] as Timestamp?)?.toDate() ?? DateTime.now(),
      endedAt: (data['endedAt'] as Timestamp?)?.toDate(),
      status: data['status'] ?? 'open',
      manual: data['manual'] ?? false,
      countFrom: (data['countFrom'] as Timestamp?)?.toDate(),
      editedById: (data['editedById'] ?? '').toString(),
      editedByName: (data['editedBy'] ?? '').toString(),
      editedAt: (data['editedAt'] as Timestamp?)?.toDate(),
      cancelled: data['cancelled'] == true,
      cancelledByName: (data['cancelledBy'] ?? '').toString(),
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'employeeId': employeeId,
      'employeeName': employeeName,
      'startedAt': Timestamp.fromDate(startedAt),
      'endedAt': endedAt != null ? Timestamp.fromDate(endedAt!) : null,
      'status': status,
      'manual': manual,
    };
  }

  StaffShiftModel copyWith({
    DateTime? startedAt,
    DateTime? endedAt,
    String? status,
    bool? manual,
  }) {
    return StaffShiftModel(
      id: id,
      employeeId: employeeId,
      employeeName: employeeName,
      startedAt: startedAt ?? this.startedAt,
      endedAt: endedAt ?? this.endedAt,
      status: status ?? this.status,
      manual: manual ?? this.manual,
    );
  }
}
