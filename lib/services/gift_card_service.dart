import 'dart:async';
import 'dart:math';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
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

  CollectionReference<Map<String, dynamic>> get _col => AppScope.col('giftCards');

  /// Код вида KLB-7F3A-92C1: читается вслух по телефону и не путается
  /// (без похожих символов O/0, I/1).
  String _generateCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    String block() =>
        List.generate(4, (_) => alphabet[_rnd.nextInt(alphabet.length)]).join();
    return 'KLB-${block()}-${block()}';
  }

  /// Выпустить сертификат. Возвращает код — его и постят в канал.
  ///
  /// [bonusAmount] — сколько бонусов получит каждый успевший гость,
  /// [maxUses] — сколько гостей успеет (0 — без ограничения).
  Future<GiftCard> issue({
    required double bonusAmount,
    int maxUses = 0,
    String comment = '',
    String issuedBy = '',
    int validDays = 30,
  }) async {
    var code = _generateCode();
    // Коллизия почти невероятна, но проверим — повтор кода смешал бы
    // активации двух разных акций.
    while ((await _col.doc(code).get()).exists) {
      code = _generateCode();
    }

    final card = GiftCard(
      code: code,
      bonusAmount: bonusAmount,
      maxUses: maxUses < 0 ? 0 : maxUses,
      comment: comment,
      issuedBy: issuedBy,
      createdAt: DateTime.now(),
      expiresAt: validDays > 0 ? DateTime.now().add(Duration(days: validDays)) : null,
    );
    await _col.doc(code).set(card.toMap());
    return card;
  }

  /// Найти сертификат по коду. Гость читает его по id — по правилам базы
  /// перебрать всю коллекцию он не может.
  Future<GiftCard?> find(String code) async {
    final normalized = code.trim().toUpperCase();
    if (normalized.isEmpty) return null;
    final doc = await _col.doc(normalized).get();
    return doc.exists ? GiftCard.fromDoc(doc) : null;
  }

  CollectionReference<Map<String, dynamic>> get _claims =>
      AppScope.col('giftCardClaims');

  /// Гость вводит код у себя в приложении.
  ///
  /// Сам себе бонусы гость начислить не может — правила базы этого не
  /// разрешают, и правильно делают. Поэтому он оставляет заявку, а
  /// начисляет её касса (см. [watchClaims]). Заявки разбираются по времени
  /// создания: кто успел, тот и получил.
  ///
  /// Возвращает текст для гостя, если активировать нельзя уже сейчас, —
  /// чтобы не плодить заведомо отказные заявки. null означает «заявка
  /// создана, ждём начисления».
  Future<String?> requestActivation({
    required String code,
    required String clientUid,
  }) async {
    final normalized = code.trim().toUpperCase();
    if (normalized.isEmpty) return 'Введите код сертификата.';

    final card = await find(normalized);
    if (card == null) return 'Такого сертификата нет. Проверьте код.';
    final problem = card.problem;
    if (problem != null) return problem;

    // Один гость — одна активация. Свои заявки гостю читать можно.
    final mine = await _claims
        .where('clientUid', isEqualTo: clientUid)
        .where('code', isEqualTo: normalized)
        .limit(1)
        .get();
    if (mine.docs.isNotEmpty) {
      final claim = GiftCardClaim.fromDoc(mine.docs.first);
      if (claim.isGranted) return 'Вы уже активировали этот сертификат.';
      if (claim.isPending) return 'Заявка уже отправлена — ждём начисления.';
      return claim.reason.isEmpty ? 'Сертификат уже использован.' : claim.reason;
    }

    await _claims.add(GiftCardClaim(
      id: '',
      code: normalized,
      clientUid: clientUid,
      createdAt: DateTime.now(),
    ).toMap());
    return null;
  }

  /// Заявки конкретного гостя — по ним приложение показывает результат.
  Stream<List<GiftCardClaim>> clientClaimsStream(String clientUid) => _claims
      .where('clientUid', isEqualTo: clientUid)
      .snapshots()
      .map((s) => s.docs.map(GiftCardClaim.fromDoc).toList()
        ..sort((a, b) => b.createdAt.compareTo(a.createdAt)));

  StreamSubscription? _claimsSub;

  /// Касса разбирает заявки гостей. Запускается на POS при старте.
  ///
  /// Обрабатываем по времени создания: активаций может быть меньше, чем
  /// желающих, и «успел» должно означать «раньше отправил», а не «чей
  /// документ Firestore отдал первым».
  void watchClaims() {
    _claimsSub?.cancel();
    _claimsSub = _claims
        .where('status', isEqualTo: 'new')
        .snapshots()
        .listen((snap) async {
      final pending = snap.docs.map(GiftCardClaim.fromDoc).toList()
        ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
      for (final claim in pending) {
        try {
          await _process(claim);
        } catch (_) {
          // Нет сети или кто-то уже обработал — вернёмся к заявке
          // следующим снапшотом.
        }
      }
    }, onError: (_) {});
  }

  Future<void> stopWatching() async {
    await _claimsSub?.cancel();
    _claimsSub = null;
  }

  /// Начислить бонусы по одной заявке.
  ///
  /// Всё в одной транзакции: счётчик активаций, баланс гостя и сама
  /// заявка. Иначе два планшета, разобрав одну заявку одновременно,
  /// начислили бы бонусы дважды, а активацию списали бы один раз.
  Future<void> _process(GiftCardClaim claim) async {
    final claimRef = _claims.doc(claim.id);
    final cardRef = _col.doc(claim.code);
    final clientRef = AppScope.loyaltyCol('clients').doc(claim.clientUid);

    double granted = 0;

    await _db.runTransaction((tx) async {
      final claimSnap = await tx.get(claimRef);
      if (!claimSnap.exists) return;
      // Уже разобрана другим устройством — не трогаем.
      if ((claimSnap.data()?['status'] as String?) != 'new') return;

      final cardSnap = await tx.get(cardRef);
      final now = Timestamp.fromDate(DateTime.now());

      void reject(String reason) {
        tx.update(claimRef, {
          'status': 'rejected',
          'reason': reason,
          'processedAt': now,
        });
      }

      if (!cardSnap.exists) {
        reject('Такого сертификата нет.');
        return;
      }
      final card = GiftCard.fromDoc(cardSnap);
      final problem = card.problem;
      if (problem != null) {
        reject(problem);
        return;
      }

      final clientSnap = await tx.get(clientRef);
      if (!clientSnap.exists) {
        reject('Профиль гостя не найден.');
        return;
      }

      granted = card.bonusAmount;
      final balance = (clientSnap.data()?['bonusBalance'] as num?)?.toDouble() ?? 0;

      tx.update(cardRef, {'usedCount': card.usedCount + 1});
      tx.set(clientRef, {'bonusBalance': balance + granted}, SetOptions(merge: true));
      tx.update(claimRef, {
        'status': 'granted',
        'amount': granted,
        'reason': '',
        'processedAt': now,
      });
    });

    if (granted <= 0) return;

    // Запись в историю бонусов — её гость видит у себя в профиле.
    await AppScope.loyaltyCol('bonusOperations').add({
      'clientUid': claim.clientUid,
      'type': 'accrual',
      'amount': granted,
      'reason': 'giftCard',
      'comment': claim.code,
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });

    await PushService.instance.enqueue(
      clientUid: claim.clientUid,
      title: 'Сертификат активирован',
      body: 'Вам начислено ${granted.toStringAsFixed(0)} бонусов. Ждём в гости!',
    );
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
    final ref = await AppScope.col('tips').add({
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
      AppScope.col('tips').doc(tipId).update({
        'status': 'paid',
        'paymentId': paymentId,
        'paidAt': Timestamp.fromDate(DateTime.now()),
      });

  /// Итоги по чаевым за период — для расчёта с сотрудниками.
  Future<Map<String, double>> totalsByEmployee({
    required DateTime from,
    required DateTime to,
  }) async {
    final snap = await AppScope.col('tips')
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

  Stream<QuerySnapshot<Map<String, dynamic>>> recentStream({int limit = 50}) => AppScope.col('tips')
      .orderBy('createdAt', descending: true)
      .limit(limit)
      .snapshots();
}
