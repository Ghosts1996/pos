import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/data/offline_lease.dart';
import 'package:hookah_pos/models/tenant_models.dart';
import 'package:hookah_pos/services/subscription_gate.dart';

// «Аренда без связи» кассы: подписку нельзя «продлить» авиарежимом.
void main() {
  final d0 = DateTime.utc(2026, 12, 1, 12);

  test('оплачено и связь недавно была — касса работает, без предупреждений', () {
    OfflineLease.debugSet(lastContact: d0, paidUntil: d0.add(const Duration(days: 20)));
    expect(OfflineLease.expiredReason(d0.add(const Duration(days: 2))), isNull);
    expect(OfflineLease.warning(d0.add(const Duration(days: 2))), isNull);
  });

  test('авиарежим до конца оплаты: через 3 дня после срока касса закрыта и без интернета', () {
    final paid = d0.add(const Duration(days: 2));
    OfflineLease.debugSet(lastContact: d0, paidUntil: paid);
    expect(OfflineLease.expiredReason(paid.add(const Duration(days: 2))), isNull, reason: 'запас 3 дня');
    expect(OfflineLease.warning(paid.add(const Duration(days: 2))), contains('остановится'));
    final r = OfflineLease.expiredReason(paid.add(const Duration(days: 3, hours: 1)));
    expect(r, contains('Оплаченный срок закончился'));
  });

  test('после конца срока касса выходила на связь — решает сервер, а не аренда', () {
    final paid = d0;
    OfflineLease.debugSet(lastContact: paid.add(const Duration(days: 1)), paidUntil: paid);
    expect(OfflineLease.expiredReason(paid.add(const Duration(days: 5))), isNull);
  });

  test('больше 14 дней без связи — касса просит интернет даже при оплате на год', () {
    OfflineLease.debugSet(lastContact: d0, paidUntil: d0.add(const Duration(days: 365)));
    expect(OfflineLease.expiredReason(d0.add(const Duration(days: 13))), isNull);
    expect(OfflineLease.warning(d0.add(const Duration(days: 12))), isNotNull);
    expect(OfflineLease.expiredReason(d0.add(const Duration(days: 15))), contains('не была на связи'));
  });

  test('перевод часов назад не помогает: «сейчас» не раньше уже виденного', () {
    final paid = d0;
    OfflineLease.debugSet(lastContact: d0.subtract(const Duration(days: 1)), paidUntil: paid,
        maxSeen: paid.add(const Duration(days: 10)));
    // Часы устройства показывают «давно» — касса всё равно считает от виденного.
    expect(OfflineLease.now().isBefore(paid.add(const Duration(days: 10))), isFalse);
    expect(OfflineLease.expiredReason(), isNotNull);
  });

  test('связь появилась — аренда продлевается сама', () {
    OfflineLease.debugSet(lastContact: d0, paidUntil: d0.add(const Duration(days: 365)), maxSeen: d0);
    final later = d0.add(const Duration(days: 20));
    expect(OfflineLease.expiredReason(later), isNotNull);
    OfflineLease.noteContact(later);
    expect(OfflineLease.expiredReason(later), isNull);
  });

  test('дата из будущего на планшете не запирает кассу навсегда: ответ сервера всё сбрасывает', () {
    OfflineLease.debugSet(lastContact: d0, paidUntil: d0.add(const Duration(days: 365)), maxSeen: DateTime.utc(2030));
    expect(OfflineLease.expiredReason(DateTime.utc(2030)), isNotNull);
    OfflineLease.noteContact(d0.add(const Duration(days: 1)));
    expect(OfflineLease.expiredReason(d0.add(const Duration(days: 1))), isNull);
  });

  test('оплачено до: пробный — конец пробного, иначе — конец периода', () {
    final trial = SubscriptionInfo(tenantId: 't', planId: 'start', status: 'trial', trialEndsAt: d0);
    final paid = SubscriptionInfo(tenantId: 't', planId: 'pro', status: 'active', currentPeriodEnd: d0.add(const Duration(days: 30)));
    expect(SubscriptionGate.paidUntilOf(trial), d0);
    expect(SubscriptionGate.paidUntilOf(paid), d0.add(const Duration(days: 30)));
    expect(SubscriptionGate.paidUntilOf(null), isNull);
  });
}
