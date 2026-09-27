import 'package:cloud_firestore/cloud_firestore.dart';

import 'session_model.dart';

/// Движение наличных в кассе, кроме продаж: сколько забрали, внесли,
/// выдали и вернули гостям.
enum CashOpType {
  /// Инкассация — выручку забрали из кассы (в сейф, владельцу, в банк).
  collection,

  /// Внесение — положили в кассу (размен, докинули мелочь).
  deposit,

  /// Выплата — выдали из кассы (поставщику, курьеру, аванс, чаевые).
  payout,

  /// Возврат гостю наличными — создаётся сам при возврате чека.
  refund,
}

extension CashOpTypeX on CashOpType {
  String get code => name;

  String get label {
    switch (this) {
      case CashOpType.collection:
        return 'Инкассация';
      case CashOpType.deposit:
        return 'Внесение';
      case CashOpType.payout:
        return 'Выплата';
      case CashOpType.refund:
        return 'Возврат наличными';
    }
  }

  /// Деньги приходят в кассу (+) или уходят (−).
  bool get isIncome => this == CashOpType.deposit;

  static CashOpType fromCode(String? code) =>
      CashOpType.values.firstWhere((t) => t.name == code, orElse: () => CashOpType.payout);
}

/// Операция с наличными — документ cashOps/{id}.
///
/// Операции не удаляются и не правятся: ошибочную отменяют (флаг
/// [cancelled]), и она остаётся в истории зачёркнутой — владелец видит,
/// кто, когда и что отменил. Сумма всегда положительная, направление
/// задаёт [type].
class CashOp {
  final String id;
  final String shiftId;
  final CashOpType type;
  final double amount;
  final String comment;
  final String employeeName;
  final String employeeId;
  final DateTime createdAt;
  final bool cancelled;
  final String cancelledBy;

  /// Для возврата — чек, по которому вернули деньги.
  final String sessionId;

  const CashOp({
    required this.id,
    required this.shiftId,
    required this.type,
    required this.amount,
    this.comment = '',
    this.employeeName = '',
    this.employeeId = '',
    required this.createdAt,
    this.cancelled = false,
    this.cancelledBy = '',
    this.sessionId = '',
  });

  /// Со знаком: + для внесения, − для остального.
  double get signedAmount => type.isIncome ? amount : -amount;

  factory CashOp.fromDoc(DocumentSnapshot doc) {
    final m = doc.data() as Map<String, dynamic>? ?? {};
    return CashOp(
      id: doc.id,
      shiftId: (m['shiftId'] ?? '').toString(),
      type: CashOpTypeX.fromCode(m['type'] as String?),
      amount: ((m['amount'] ?? 0) as num).toDouble(),
      comment: (m['comment'] ?? '').toString(),
      employeeName: (m['employeeName'] ?? '').toString(),
      employeeId: (m['employeeId'] ?? '').toString(),
      createdAt: (m['createdAt'] as Timestamp?)?.toDate() ?? DateTime.now(),
      cancelled: m['cancelled'] == true,
      cancelledBy: (m['cancelledBy'] ?? '').toString(),
      sessionId: (m['sessionId'] ?? '').toString(),
    );
  }

  Map<String, dynamic> toMap() => {
        'shiftId': shiftId,
        'type': type.code,
        'amount': amount,
        'comment': comment,
        'employeeName': employeeName,
        'employeeId': employeeId,
        'createdAt': Timestamp.fromDate(createdAt),
        'cancelled': cancelled,
        'sessionId': sessionId,
      };
}

/// «Наличные в кассе» за смену — сколько денег должно лежать в ящике.
///
///   размен на начало смены
/// + наличные за чеки (включая позже возвращённые — деньги-то приходили)
/// + наличные чаевые (лежат в той же кассе, пока их не выдали)
/// + внесения
/// − инкассации − выплаты − возвраты гостям наличными
///
/// Возвращённый чек старого образца (до учёта возвратов наличными) не
/// считается ни в приход, ни в расход — как и раньше в X-отчёте.
class CashDrawerSummary {
  final double opening;
  final double cashSales;
  final double cashTips;
  final double deposits;
  final double collections;
  final double payouts;
  final double refunds;

  /// Разница пересчёта при закрытии смены: недостача (<0) или излишек
  /// (>0). После пересчёта в кассе фактически столько, сколько насчитали.
  final double countDiff;

  const CashDrawerSummary({
    this.opening = 0,
    this.cashSales = 0,
    this.cashTips = 0,
    this.deposits = 0,
    this.collections = 0,
    this.payouts = 0,
    this.refunds = 0,
    this.countDiff = 0,
  });

  double get expected =>
      opening + cashSales + cashTips + deposits - collections - payouts - refunds + countDiff;

  factory CashDrawerSummary.from({
    required double opening,
    required List<SessionModel> sessions,
    required List<CashOp> ops,
    double countDiff = 0,
  }) {
    var sales = 0.0, tips = 0.0;
    for (final s in sessions) {
      if (s.closedWithoutPayment) continue;
      if (s.refunded && !s.refundCashOut) continue;
      sales += s.paymentCash;
      tips += s.tipsCash;
    }
    var deposits = 0.0, collections = 0.0, payouts = 0.0, refunds = 0.0;
    for (final op in ops) {
      if (op.cancelled) continue;
      switch (op.type) {
        case CashOpType.deposit:
          deposits += op.amount;
          break;
        case CashOpType.collection:
          collections += op.amount;
          break;
        case CashOpType.payout:
          payouts += op.amount;
          break;
        case CashOpType.refund:
          refunds += op.amount;
          break;
      }
    }
    return CashDrawerSummary(
      opening: opening,
      cashSales: sales,
      cashTips: tips,
      deposits: deposits,
      collections: collections,
      payouts: payouts,
      refunds: refunds,
      countDiff: countDiff,
    );
  }
}
