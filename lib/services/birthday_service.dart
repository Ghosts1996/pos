import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import 'push_service.dart';

/// Дни рождения гостей.
///
/// Гость указывает дату в профиле (год не обязателен). За [daysBefore] дней
/// уходит push с подарком — это самый дешёвый и самый работающий повод
/// вернуть гостя, но только один раз в год на человека.
class BirthdayService {
  BirthdayService._();
  static final BirthdayService instance = BirthdayService._();

  final _db = FirebaseFirestore.instance;

  /// Подарок имениннику: бонусы, которые сгорают через неделю.
  static const double giftBonus = 500;
  static const int daysBefore = 3;

  // loyaltyCol, а не col — профиль гостя в сети заведений общий на все точки
  // (chains/{chainId}/clients), а не свой на каждой; собственный
  // (tenant-scoped) документ гостя сети не существует вовсе.
  Future<void> setBirthday(String uid, DateTime date) => AppScope.loyaltyCol('clients').doc(uid).set({
        // Храним день и месяц отдельно: так поиск именинников — обычный
        // запрос по двум полям, без возни с годами.
        'birthdayDay': date.day,
        'birthdayMonth': date.month,
      }, SetOptions(merge: true));

  /// Именинники на ближайшие дни. Вызывается планировщиком на POS раз в сутки.
  Future<List<({String uid, String name, String token})>> upcoming() async {
    final target = DateTime.now().add(const Duration(days: daysBefore));
    final snap = await AppScope.loyaltyCol('clients')
        .where('birthdayMonth', isEqualTo: target.month)
        .where('birthdayDay', isEqualTo: target.day)
        .get();

    final year = DateTime.now().year;
    return snap.docs
        .where((d) => (d.data()['birthdayGreetedYear'] as num?)?.toInt() != year)
        .map((d) => (
              uid: d.id,
              name: (d.data()['name'] as String?) ?? 'Гость',
              token: (d.data()['pushToken'] as String?) ?? '',
            ))
        .toList();
  }

  /// Поздравить и начислить подарок. Помечает год, чтобы не поздравить дважды
  /// — в транзакции: у сети заведений список именинников общий на все точки
  /// (loyaltyCol), а у каждой точки свой независимый суточный планшет-
  /// планировщик, так что без транзакции два планшета разных точек одной
  /// сети, сработав почти одновременно, оба прошли бы проверку в [upcoming]
  /// до того, как второй увидит отметку первого, и начислили бы подарок дважды.
  Future<void> greet({
    required String uid,
    required String name,
    required String token,
  }) async {
    final year = DateTime.now().year;
    final clientRef = AppScope.loyaltyCol('clients').doc(uid);

    final alreadyGreeted = await _db.runTransaction((tx) async {
      final snap = await tx.get(clientRef);
      if ((snap.data()?['birthdayGreetedYear'] as num?)?.toInt() == year) return true;
      tx.set(clientRef, {
        'bonusBalance': FieldValue.increment(giftBonus),
        'birthdayGreetedYear': year,
      }, SetOptions(merge: true));
      return false;
    });
    if (alreadyGreeted) return;

    await AppScope.loyaltyCol('bonusOperations').add({
      'clientUid': uid,
      'type': 'accrual',
      'amount': giftBonus,
      'reason': 'birthday',
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });

    if (token.isNotEmpty) {
      await PushService.instance.enqueue(
        token: token,
        clientUid: uid,
        title: 'С наступающим днём рождения!',
        body: '${giftBonus.toStringAsFixed(0)} бонусов уже на счету — ждём вас отметить.',
      );
    }
  }

  /// Обработать всех именинников разом — одна строка в планировщике.
  /// Возвращает количество поздравленных.
  Future<int> runDailyGreetings() async {
    final list = await upcoming();
    for (final g in list) {
      await greet(uid: g.uid, name: g.name, token: g.token);
    }
    if (list.isNotEmpty) {
      await AppScope.col('staffNotes').add({
        'title': 'Именинники',
        'text': 'Через $daysBefore дня отмечают: ${list.map((e) => e.name).join(', ')}. '
            'Подарочные бонусы начислены.',
        'priority': 'info',
        'source': 'birthday',
        'read': false,
        'createdAt': Timestamp.fromDate(DateTime.now()),
      });
    }
    return list.length;
  }
}
