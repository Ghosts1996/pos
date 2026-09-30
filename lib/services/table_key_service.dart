import 'dart:math';

import 'package:cloud_firestore/cloud_firestore.dart';

import 'app_scope.dart';

/// Секреты столов для QR-наклеек (только SaaS).
///
/// Номера столов гостю видны (карта зала, приложение), поэтому по одному
/// номеру кто угодно с приложением заведения мог занять чужой открытый чек
/// удалённо: видеть счёт, заказывать на него и получать кешбэк за чужой
/// визит. Теперь в QR на столе есть ещё секрет стола — он лежит в
/// tenants/{id}/tableKeys/{tableId}, читает его только касса, и без него
/// правила базы не дают занять чек (saas/firestore.rules, tableKeyOk).
///
/// Новый секрет (новый стол, «Новый код» на экране QR) означает, что
/// наклейку надо распечатать заново: отметка в settings/tableQr, по ней
/// администратор видит напоминание.
class TableKeyService {
  TableKeyService._();
  static final TableKeyService instance = TableKeyService._();

  static const _alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

  bool get enabled => AppScope.isSaasMode;

  CollectionReference<Map<String, dynamic>> get _keys => AppScope.col('tableKeys');
  DocumentReference<Map<String, dynamic>> get _state => AppScope.col('settings').doc('tableQr');

  /// 18 знаков (~100 бит): не подобрать, и QR остаётся некрупным.
  static String newKey() {
    final rng = Random.secure();
    return List.generate(18, (_) => _alphabet[rng.nextInt(_alphabet.length)]).join();
  }

  /// Секреты столов по id стола.
  Stream<Map<String, String>> keysStream() => _keys.snapshots().map((s) => {
        for (final d in s.docs)
          if ((d.data()['key'] as String? ?? '').isNotEmpty) d.id: d.data()['key'] as String,
      });

  /// Выпустить секрет каждому столу, у которого его ещё нет. Транзакция на
  /// стол: две кассы, запустившиеся одновременно, не перепишут секрет
  /// друг другу. Возвращает, сколько выпущено.
  Future<int> ensureKeys() async {
    if (!enabled) return 0;
    final tables = await AppScope.col('tables').get();
    final have = (await _keys.get()).docs.map((d) => d.id).toSet();
    var issued = 0;
    for (final t in tables.docs.where((d) => !have.contains(d.id))) {
      if (await _createIfMissing(t.id)) issued++;
    }
    if (issued > 0) await _markIssued();
    return issued;
  }

  /// Секрет новому столу.
  Future<void> ensureKey(String tableId) async {
    if (!enabled) return;
    if (await _createIfMissing(tableId)) await _markIssued();
  }

  /// Новый секрет стола: старая наклейка перестаёт открывать счёт.
  Future<void> rotate(String tableId) async {
    await _keys.doc(tableId).set({'key': newKey(), 'issuedAt': FieldValue.serverTimestamp()});
    await _markIssued();
  }

  /// Стол удалён — секрет больше не нужен.
  Future<void> remove(String tableId) async {
    if (!enabled) return;
    try {
      await _keys.doc(tableId).delete();
    } catch (_) {}
  }

  /// Администратор распечатал и наклеил новые коды.
  Future<void> markPrinted() =>
      _state.set({'printedAt': FieldValue.serverTimestamp()}, SetOptions(merge: true));

  /// Есть коды, которые ещё не распечатаны.
  Stream<bool> reprintNeededStream() {
    if (!enabled) return Stream.value(false);
    return _state.snapshots().map((d) {
      final issued = d.data()?['keysIssuedAt'];
      final printed = d.data()?['printedAt'];
      if (issued is! Timestamp) return false;
      return printed is! Timestamp || printed.compareTo(issued) < 0;
    }).handleError((_) {});
  }

  Future<bool> _createIfMissing(String tableId) async {
    final ref = _keys.doc(tableId);
    return FirebaseFirestore.instance.runTransaction<bool>((tx) async {
      if ((await tx.get(ref)).exists) return false;
      tx.set(ref, {'key': newKey(), 'issuedAt': FieldValue.serverTimestamp()});
      return true;
    });
  }

  Future<void> _markIssued() =>
      _state.set({'keysIssuedAt': FieldValue.serverTimestamp()}, SetOptions(merge: true));
}
