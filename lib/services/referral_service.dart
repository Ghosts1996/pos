import 'package:cloud_firestore/cloud_firestore.dart';
import 'push_service.dart';

/// Реферальная программа «приведи друга».
///
/// У каждого гостя есть короткий код (KLB-XXXX). Новый гость вводит его при
/// первом визите; когда он закрывает первый чек, бонусы получают оба.
/// Начисление приглашающему происходит один раз на приглашённого.
class ReferralService {
  ReferralService._();
  static final ReferralService instance = ReferralService._();

  final _db = FirebaseFirestore.instance;

  /// Сколько бонусов получает каждая сторона.
  static const double inviterBonus = 300;
  static const double inviteeBonus = 200;

  /// Код гостя. Генерируется один раз и живёт в профиле.
  Future<String> ensureCode(String uid) async {
    final ref = _db.collection('clients').doc(uid);
    final snap = await ref.get();
    final existing = snap.data()?['referralCode'] as String?;
    if (existing != null && existing.isNotEmpty) return existing;

    // Код из uid: коротко, стабильно и без обращения к счётчикам.
    final tail = uid.replaceAll(RegExp(r'[^A-Za-z0-9]'), '').toUpperCase();
    final code = 'KLB-${tail.substring(0, tail.length.clamp(0, 4)).padRight(4, '0')}';

    // Коллизии редки, но проверим и добавим цифру, если код занят.
    var finalCode = code;
    var attempt = 0;
    while (await _codeTaken(finalCode, uid) && attempt < 5) {
      attempt++;
      finalCode = '$code$attempt';
    }

    await ref.set({'referralCode': finalCode}, SetOptions(merge: true));
    return finalCode;
  }

  Future<bool> _codeTaken(String code, String uid) async {
    final snap =
        await _db.collection('clients').where('referralCode', isEqualTo: code).limit(1).get();
    return snap.docs.isNotEmpty && snap.docs.first.id != uid;
  }

  /// Гость вводит код пригласившего. Начисление — не сразу, а после первого
  /// оплаченного визита, иначе код можно фармить без посещения.
  /// Возвращает текст результата для показа гостю.
  Future<String> applyCode({required String uid, required String code}) async {
    final normalized = code.trim().toUpperCase();
    if (normalized.isEmpty) return 'Введите код.';

    final me = await _db.collection('clients').doc(uid).get();
    if ((me.data()?['referredBy'] as String?)?.isNotEmpty == true) {
      return 'Код уже применён раньше.';
    }
    if ((me.data()?['referralCode'] as String?) == normalized) {
      return 'Это ваш собственный код.';
    }
    if (((me.data()?['visits'] as num?)?.toInt() ?? 0) > 0) {
      return 'Код можно применить только до первого визита.';
    }

    final inviter =
        await _db.collection('clients').where('referralCode', isEqualTo: normalized).limit(1).get();
    if (inviter.docs.isEmpty) return 'Такого кода нет.';

    await _db.collection('clients').doc(uid).set({
      'referredBy': inviter.docs.first.id,
      'referralCodeUsed': normalized,
    }, SetOptions(merge: true));

    return 'Код принят: после первого визита вам начислим '
        '${inviteeBonus.toStringAsFixed(0)} бонусов, другу — '
        '${inviterBonus.toStringAsFixed(0)}.';
  }

  /// Вызывается с POS после закрытия первого чека гостя.
  /// Идемпотентна: повторный вызов ничего не начислит.
  Future<void> rewardIfFirstVisit(String uid) async {
    final ref = _db.collection('clients').doc(uid);
    final snap = await ref.get();
    final data = snap.data();
    if (data == null) return;

    final inviterId = data['referredBy'] as String?;
    if (inviterId == null || inviterId.isEmpty) return;
    if (data['referralRewarded'] == true) return;
    if (((data['visits'] as num?)?.toInt() ?? 0) < 1) return;

    final batch = _db.batch();
    batch.set(ref, {
      'bonusBalance': FieldValue.increment(inviteeBonus),
      'referralRewarded': true,
    }, SetOptions(merge: true));
    batch.set(_db.collection('clients').doc(inviterId), {
      'bonusBalance': FieldValue.increment(inviterBonus),
      'referralsCount': FieldValue.increment(1),
    }, SetOptions(merge: true));

    batch.set(_db.collection('bonusOperations').doc(), {
      'clientUid': uid,
      'type': 'accrual',
      'amount': inviteeBonus,
      'reason': 'referral_invitee',
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });
    batch.set(_db.collection('bonusOperations').doc(), {
      'clientUid': inviterId,
      'type': 'accrual',
      'amount': inviterBonus,
      'reason': 'referral_inviter',
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });

    await batch.commit();

    // Без Cloud Functions push не уйдёт, но приглашающий увидит рост
    // баланса — его приложение уведомит об этом само.
    await PushService.instance.enqueue(
      clientUid: inviterId,
      title: 'Друг дошёл до нас',
      body: 'Вам начислено ${inviterBonus.toStringAsFixed(0)} бонусов. Спасибо!',
    );
  }

  /// Сколько гостей пришло по коду — для экрана профиля.
  Stream<int> invitedCount(String uid) => _db
      .collection('clients')
      .where('referredBy', isEqualTo: uid)
      .snapshots()
      .map((s) => s.docs.length);
}
