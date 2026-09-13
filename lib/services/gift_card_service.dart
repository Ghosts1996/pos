import 'dart:math';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/venue_models.dart';
import 'push_service.dart';

/// Подарочные сертификаты и чаевые.
///
/// Сертификат — это отдельный «кошелёк» с кодом: его продают на кассе или
/// покупают в приложении, а гасят частями при оплате. Чаевые — адресный
/// перевод конкретному сотруднику, они не попадают в выручку заведения и
/// не участвуют в X-отчёте.
class GiftCardService {
  GiftCardService._();
  static final GiftCardService instance = GiftCardService._();

  final _db = FirebaseFirestore.instance;
  final _rnd = Random.secure();

  CollectionReference<Map<String, dynamic>> get _col => _db.collection('giftCards');

  /// Код вида KLB-7F3A-92C1: читается вслух по телефону и не путается
  /// (без похожих символов O/0, I/1).
  String _generateCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    String block() =>
        List.generate(4, (_) => alphabet[_rnd.nextInt(alphabet.length)]).join();
    return 'KLB-${block()}-${block()}';
  }

  /// Выпустить сертификат. Возвращает код, который печатается гостю.
  Future<GiftCard> issue({
    required double faceValue,
    String issuedTo = '',
    String issuedBy = '',
    String purchasedByUid = '',
    int validMonths = 12,
  }) async {
    var code = _generateCode();
    // Коллизия почти невероятна, но проверим — повтор кода испортил бы
    // баланс чужого сертификата.
    while ((await _col.doc(code).get()).exists) {
      code = _generateCode();
    }

    final card = GiftCard(
      code: code,
      faceValue: faceValue,
      balance: faceValue,
      issuedTo: issuedTo,
      issuedBy: issuedBy,
      purchasedByUid: purchasedByUid,
      createdAt: DateTime.now(),
      expiresAt: DateTime.now().add(Duration(days: 30 * validMonths)),
    );
    await _col.doc(code).set(card.toMap());
    return card;
  }

  Future<GiftCard?> find(String code) async {
    final doc = await _col.doc(code.trim().toUpperCase()).get();
    return doc.exists ? GiftCard.fromDoc(doc) : null;
  }

  /// Списать с сертификата. Возвращает фактически списанную сумму —
  /// не больше остатка и не больше запрошенного.
  Future<double> redeem({
    required String code,
    required double amount,
    required String sessionId,
    String employeeName = '',
  }) async {
    final ref = _col.doc(code.trim().toUpperCase());
    double applied = 0;

    await _db.runTransaction((tx) async {
      final snap = await tx.get(ref);
      if (!snap.exists) throw StateError('Сертификат не найден');
      final card = GiftCard.fromDoc(snap);
      if (!card.isUsable) throw StateError('Сертификат неактивен или истёк');

      applied = amount > card.balance ? card.balance : amount;
      if (applied <= 0) throw StateError('На сертификате нет средств');
      tx.update(ref, {'balance': card.balance - applied});
    });

    await _db.collection('giftCardOperations').add({
      'code': code.trim().toUpperCase(),
      'sessionId': sessionId,
      'amount': applied,
      'employeeName': employeeName,
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });
    return applied;
  }

  /// Вернуть на сертификат сумму, списанную при незавершённой оплате.
  /// Симметрично [redeem]: если кассир вышел с экрана оплаты, не проведя
  /// её, деньги сертификата не должны сгорать.
  Future<void> refund({
    required String code,
    required double amount,
    required String sessionId,
    String employeeName = '',
  }) async {
    if (amount <= 0) return;
    final normalized = code.trim().toUpperCase();
    await _col.doc(normalized).update({'balance': FieldValue.increment(amount)});
    await _db.collection('giftCardOperations').add({
      'code': normalized,
      'sessionId': sessionId,
      'amount': -amount,
      'reason': 'redeem_cancelled',
      'employeeName': employeeName,
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });
  }

  Stream<List<GiftCard>> activeCardsStream() => _col
      .where('active', isEqualTo: true)
      .snapshots()
      .map((s) => s.docs.map(GiftCard.fromDoc).toList()
        ..sort((a, b) => b.createdAt.compareTo(a.createdAt)));

  Future<void> deactivate(String code) => _col.doc(code).update({'active': false});
}

/// Чаевые сотруднику из приложения гостя.
///
/// Само списание денег делает платёжный провайдер (СБП/эквайринг) — здесь
/// фиксируется намерение и результат, чтобы у кальянщика была честная
/// статистика, а у заведения — отчёт по выплатам.
class TipsService {
  TipsService._();
  static final TipsService instance = TipsService._();

  final _db = FirebaseFirestore.instance;

  /// Создать запись о чаевых. [paymentId] заполняется после подтверждения
  /// оплаты провайдером (или вручную кассиром, если чаевые наличными).
  Future<String> leaveTip({
    required double amount,
    required String employeeName,
    String employeeId = '',
    String sessionId = '',
    String clientUid = '',
    String comment = '',
    String method = 'app',
  }) async {
    final ref = await _db.collection('tips').add({
      'amount': amount,
      'employeeId': employeeId,
      'employeeName': employeeName,
      'sessionId': sessionId,
      'clientUid': clientUid,
      'comment': comment,
      'method': method,
      'status': 'pending',
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });

    await PushService.instance.enqueue(
      topic: 'staff',
      title: 'Чаевые',
      body: '$employeeName — ${amount.toStringAsFixed(0)} ₽'
          '${comment.isEmpty ? '' : ' · «$comment»'}',
    );
    return ref.id;
  }

  Future<void> confirm(String tipId, {String paymentId = ''}) =>
      _db.collection('tips').doc(tipId).update({
        'status': 'paid',
        'paymentId': paymentId,
        'paidAt': Timestamp.fromDate(DateTime.now()),
      });

  /// Итоги по чаевым за период — для расчёта с сотрудниками.
  Future<Map<String, double>> totalsByEmployee({
    required DateTime from,
    required DateTime to,
  }) async {
    final snap = await _db
        .collection('tips')
        .where('createdAt', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('createdAt', isLessThan: Timestamp.fromDate(to))
        .get();

    final totals = <String, double>{};
    for (final d in snap.docs) {
      final data = d.data();
      if (data['status'] != 'paid') continue;
      final name = data['employeeName']?.toString() ?? '—';
      totals[name] = (totals[name] ?? 0) + (data['amount'] ?? 0).toDouble();
    }
    return totals;
  }

  Stream<QuerySnapshot<Map<String, dynamic>>> recentStream({int limit = 50}) => _db
      .collection('tips')
      .orderBy('createdAt', descending: true)
      .limit(limit)
      .snapshots();
}
