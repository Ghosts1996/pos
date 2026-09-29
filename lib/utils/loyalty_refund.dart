import 'dart:math' as math;

/// Лояльность гостя при возврате чека и при отмене возврата.
///
/// Возврат отменяет всё, что гость получил за этот визит: кешбэк
/// забирается, бонусы, которыми он оплатил часть счёта, возвращаются, а
/// сумма визита и сам визит снимаются со счётчиков уровня. Баланс в минус
/// не уводим: если начисленный кешбэк гость уже потратил, забираем сколько
/// есть — отрицательный баланс в приложении гостя выглядел бы как долг.
///
/// Отмена возврата возвращает ровно то, что снял возврат (поэтому возврат
/// запоминает фактические цифры), и тоже не уводит баланс в минус.
class LoyaltyRefund {
  /// Сколько кешбэка забрали с баланса.
  final double taken;

  /// Сколько бонусов, которыми платили за чек, вернули на баланс.
  final double returned;

  /// Сколько снято с суммы трат (totalSpent).
  final double spent;

  /// Сколько визитов снято (0 или 1).
  final int visits;

  const LoyaltyRefund({required this.taken, required this.returned, required this.spent, required this.visits});

  Map<String, dynamic> toMap(String uid) =>
      {'uid': uid, 'taken': taken, 'returned': returned, 'spent': spent, 'visits': visits};

  factory LoyaltyRefund.fromMap(Map<dynamic, dynamic> m) => LoyaltyRefund(
        taken: (m['taken'] as num?)?.toDouble() ?? 0,
        returned: (m['returned'] as num?)?.toDouble() ?? 0,
        spent: (m['spent'] as num?)?.toDouble() ?? 0,
        visits: (m['visits'] as num?)?.toInt() ?? 0,
      );
}

/// Новые значения профиля гостя после возврата чека.
({double balance, double totalSpent, int visits, LoyaltyRefund refund}) applyLoyaltyRefund({
  required double balance,
  required double totalSpent,
  required int visits,
  required double earned,
  required double bonusSpent,
  required double visitTotal,
}) {
  final taken = math.max(0.0, math.min(earned, balance));
  final returned = math.max(0.0, bonusSpent);
  final spent = math.max(0.0, math.min(visitTotal, totalSpent));
  final visitsRemoved = visits > 0 ? 1 : 0;
  return (
    balance: balance - taken + returned,
    totalSpent: totalSpent - spent,
    visits: visits - visitsRemoved,
    refund: LoyaltyRefund(taken: taken, returned: returned, spent: spent, visits: visitsRemoved),
  );
}

/// Новые значения профиля гостя после отмены возврата. [reclaimed] —
/// сколько возвращённых возвратом бонусов удалось снова списать.
({double balance, double totalSpent, int visits, double reclaimed}) undoLoyaltyRefund({
  required double balance,
  required double totalSpent,
  required int visits,
  required LoyaltyRefund refund,
}) {
  final available = balance + refund.taken;
  final reclaimed = math.max(0.0, math.min(refund.returned, available));
  return (
    balance: available - reclaimed,
    totalSpent: totalSpent + refund.spent,
    visits: visits + refund.visits,
    reclaimed: reclaimed,
  );
}
