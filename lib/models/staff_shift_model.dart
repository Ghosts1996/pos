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

  StaffShiftModel({
    required this.id,
    required this.employeeId,
    required this.employeeName,
    required this.startedAt,
    this.endedAt,
    this.status = 'open',
    this.manual = false,
  });

  bool get isOpen => status == 'open';

  /// Продолжительность смены. У открытой смены считается "по текущий
  /// момент" — только для превью в интерфейсе; в расчёт зарплаты идут
  /// только закрытые смены (см. PayrollCalculator).
  Duration get duration => (endedAt ?? DateTime.now()).difference(startedAt);

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
