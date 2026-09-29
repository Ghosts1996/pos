import 'dart:async';
import 'dart:math';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import '../models/venue_models.dart';
import 'push_service.dart';
import '../utils/shared_stream.dart';

/// Бонусные сертификаты: код, по которому гость получает бонусы на счёт.
/// Заведение выпускает код (например, для поста в канале), гость вводит
/// его в приложении, касса начисляет бонусы по заявке — см. [watchClaims].
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

  /// Гость вводит код сертификата. Начислить бонусы сам он не может —
  /// оставляет заявку, а начисляет касса ([watchClaims]) в порядке очереди.
  ///
  /// Возвращает текст для гостя, если активировать нельзя уже сейчас;
  /// null — заявка создана.
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
  static final _clientClaimsS = SharedStreams<List<GiftCardClaim>>();

  Stream<List<GiftCardClaim>> clientClaimsStream(String clientUid) => _clientClaimsS.get(
      '${AppScope.tenantId ?? '-'}|${AppScope.chainId ?? '-'}|$clientUid',
      () => _claims.where('clientUid', isEqualTo: clientUid).snapshots().map(
          (s) => s.docs.map(GiftCardClaim.fromDoc).toList()..sort((a, b) => b.createdAt.compareTo(a.createdAt))));

  StreamSubscription? _claimsSub;

  /// Касса разбирает заявки гостей по времени создания: активаций может
  /// быть меньше, чем желающих, и первым получает тот, кто раньше отправил.
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
