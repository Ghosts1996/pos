import 'package:cloud_firestore/cloud_firestore.dart';
import '../services/people_directory.dart';

/// Ручная строка зарплаты: премия, штраф, аванс или выплата.
///
/// Премия и штраф меняют начисленное, аванс и выплата — сколько уже отдали:
/// «осталось выплатить» = начислено + чаевые − выдано. Запись не правится
/// и не удаляется — ошибочную отменяют ([cancelled]), она остаётся в
/// истории (как операции с наличными).
class PayrollAdjustment {
  static const bonus = 'bonus';
  static const penalty = 'penalty';
  static const advance = 'advance';
  static const payout = 'payout';

  final String id;
  final String employeeId;
  final String _employeeName;
  String get employeeName => Pd.staffName(employeeId, _employeeName);
  final String type;
  final double amount;
  final String comment;
  final DateTime at;
  final String _createdBy;
  String get createdBy => Pd.whoName(_createdBy);
  final bool cancelled;

  const PayrollAdjustment({
    this.id = '',
    required this.employeeId,
    String employeeName = '',
    required this.type,
    required this.amount,
    this.comment = '',
    required this.at,
    String createdBy = '',
    this.cancelled = false,
  }) : _createdBy = createdBy, _employeeName = employeeName;

  /// Меняет начисленное (а не выданное).
  bool get isAccrual => type == bonus || type == penalty;

  /// Знак в начисленном: премия +, штраф −; для выплат — сколько выдано.
  double get signedAccrual => type == bonus ? amount : (type == penalty ? -amount : 0);
  double get paidOut => type == advance || type == payout ? amount : 0;

  String get label => switch (type) {
        bonus => 'Премия',
        penalty => 'Штраф',
        advance => 'Аванс',
        _ => 'Выплата',
      };

  factory PayrollAdjustment.fromDoc(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>? ?? {};
    final at = d['at'];
    return PayrollAdjustment(
      id: doc.id,
      employeeId: (d['employeeId'] ?? '').toString(),
      employeeName: (d['employeeName'] ?? '').toString(),
      type: (d['type'] ?? payout).toString(),
      amount: (d['amount'] as num?)?.toDouble() ?? 0,
      comment: (d['comment'] ?? '').toString(),
      at: at is Timestamp ? at.toDate() : DateTime.now(),
      createdBy: (d['createdBy'] ?? '').toString(),
      cancelled: d['cancelled'] == true,
    );
  }

  Map<String, dynamic> toMap() => {
        'employeeId': employeeId,
        if (Pd.mirror) 'employeeName': employeeName,
        'type': type,
        'amount': amount,
        'comment': comment,
        'at': Timestamp.fromDate(at),
        'createdBy': Pd.who(_createdBy),
        'cancelled': false,
      };
}
