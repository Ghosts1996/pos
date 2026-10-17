import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/screens/saas/saas_subscription_blocked_screen.dart';
import 'package:hookah_pos/models/tenant_models.dart';
import 'package:hookah_pos/services/subscription_gate.dart';

void main() {
  final since = DateTime(2026, 10, 1, 12);

  SubscriptionInfo sub(String status) =>
      SubscriptionInfo(tenantId: 't', planId: 'start', status: status, pastDueSince: since);

  test('данные удаляются через 10 дней после начала просрочки', () {
    expect(sub('past_due').dataPurgeAt, since.add(const Duration(days: 10)));
    expect(sub('active').dataPurgeAt, isNull);
  });

  test('отсчёт идёт по дням: 9, 8, 7…', () {
    final deadline = since.add(const Duration(days: 10));
    final c = purgeCountdown(deadline, since.add(const Duration(seconds: 1)));
    expect(c.days, 9);
    expect(c.rest, const Duration(hours: 23, minutes: 59, seconds: 59));
    expect(purgeCountdown(deadline, since.add(const Duration(days: 2, hours: 1))).days, 7);
  });

  test('после срока — нули', () {
    final deadline = since.add(const Duration(days: 10));
    final c = purgeCountdown(deadline, deadline.add(const Duration(minutes: 5)));
    expect(c.days, 0);
    expect(c.rest, Duration.zero);
  });

  testWidgets('экран блокировки: призыв оплатить, отсчёт и кнопка', (tester) async {
    SubscriptionGate.debugSetSubscription(SubscriptionInfo(
      tenantId: 't', planId: 'start', status: 'past_due',
      pastDueSince: DateTime.now().subtract(const Duration(days: 1, hours: 2)),
    ));
    await tester.pumpWidget(const MaterialApp(home: SaasSubscriptionBlockedScreen()));
    expect(find.text('Вы не оплатили подписку'), findsOneWidget);
    expect(find.text('Данные заведения удалятся через'), findsOneWidget);
    expect(find.text('8'), findsOneWidget);
    expect(find.text('Оплатить подписку'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    SubscriptionGate.debugSetSubscription(null);
  });

  testWidgets('без просрочки — без отсчёта, но с кнопкой оплаты', (tester) async {
    SubscriptionGate.debugSetSubscription(null);
    await tester.pumpWidget(const MaterialApp(home: SaasSubscriptionBlockedScreen()));
    expect(find.text('Данные заведения удалятся через'), findsNothing);
    expect(find.text('Оплатить подписку'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
