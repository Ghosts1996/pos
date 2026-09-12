import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';

/// Журнал действий на кассе.
///
/// Пишем то, что потом спрашивают при разборе смены: удаление позиции из
/// чека, закрытие без оплаты, возврат, ручная скидка, изменение таймера,
/// правка склада. Читает только админ (см. firestore.rules).
///
/// Журнал не заменяет фискальные документы — он про «кто и когда»,
/// а не про налоговую отчётность.
class AuditLogService {
  AuditLogService._();
  static final AuditLogService instance = AuditLogService._();

  final _db = FirebaseFirestore.instance;

  /// Универсальная запись. [action] — короткий код, [details] — что именно.
  Future<void> log({
    required String action,
    required String employeeName,
    String sessionId = '',
    String tableName = '',
    double amount = 0,
    Map<String, dynamic> details = const {},
  }) async {
    try {
      await _db.collection('auditLog').add({
        'action': action,
        'employeeName': employeeName,
        'sessionId': sessionId,
        'tableName': tableName,
        'amount': amount,
        'details': details,
        'createdAt': Timestamp.fromDate(DateTime.now()),
      });
    } catch (_) {
      // Журнал не должен ломать основную операцию кассира.
    }
  }

  // ---- Готовые обёртки под конкретные события ----

  Future<void> orderItemRemoved({
    required String employeeName,
    required String sessionId,
    required String itemName,
    required int qty,
    required double sum,
  }) =>
      log(
        action: 'order_item_removed',
        employeeName: employeeName,
        sessionId: sessionId,
        amount: sum,
        details: {'item': itemName, 'qty': qty},
      );

  Future<void> closedWithoutPayment({
    required String employeeName,
    required String sessionId,
    required String tableName,
    required double sum,
    String reason = '',
  }) =>
      log(
        action: 'closed_without_payment',
        employeeName: employeeName,
        sessionId: sessionId,
        tableName: tableName,
        amount: sum,
        details: {'reason': reason},
      );

  Future<void> discountApplied({
    required String employeeName,
    required String sessionId,
    required double percent,
    String cardNumber = '',
  }) =>
      log(
        action: 'discount_applied',
        employeeName: employeeName,
        sessionId: sessionId,
        details: {'percent': percent, 'card': cardNumber},
      );

  Future<void> refunded({
    required String employeeName,
    required String sessionId,
    required double sum,
  }) =>
      log(
        action: 'refund',
        employeeName: employeeName,
        sessionId: sessionId,
        amount: sum,
      );

  Future<void> timerChanged({
    required String employeeName,
    required String sessionId,
    required int minutes,
  }) =>
      log(
        action: 'timer_changed',
        employeeName: employeeName,
        sessionId: sessionId,
        details: {'minutes': minutes},
      );

  Future<void> inventoryAdjusted({
    required String employeeName,
    required String itemName,
    required double delta,
    String reason = '',
  }) =>
      log(
        action: 'inventory_adjusted',
        employeeName: employeeName,
        amount: delta,
        details: {'item': itemName, 'reason': reason},
      );

  /// Лента журнала за период — для экрана админа и для ИИ-контролёра.
  Stream<QuerySnapshot<Map<String, dynamic>>> stream({int limit = 200}) => _db
      .collection('auditLog')
      .orderBy('createdAt', descending: true)
      .limit(limit)
      .snapshots();

  Future<String> snapshotForAi({int days = 7}) async {
    final from = DateTime.now().subtract(Duration(days: days));
    final snap = await _db
        .collection('auditLog')
        .where('createdAt', isGreaterThan: Timestamp.fromDate(from))
        .get();
    if (snap.docs.isEmpty) return 'Событий в журнале нет.';

    final byAction = <String, int>{};
    final bySum = <String, double>{};
    for (final d in snap.docs) {
      final data = d.data();
      final key = '${data['action']} / ${data['employeeName']}';
      byAction[key] = (byAction[key] ?? 0) + 1;
      bySum[key] = (bySum[key] ?? 0) + ((data['amount'] ?? 0) as num).toDouble();
    }
    return byAction.entries
        .map((e) => '- ${e.key}: ${e.value} раз, на ${bySum[e.key]!.toStringAsFixed(0)} ₽')
        .join('\n');
  }
}
