import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/tenant_models.dart';
import 'package:hookah_pos/services/demo_gate.dart';
import 'package:hookah_pos/services/tenant_config_service.dart';

TenantConfig _demo({DateTime? expires, DateTime? created}) => TenantConfig(
      tenant: Tenant(
        id: 'd1', name: 'Демо', slug: 'demo-1', status: TenantStatus.active, planId: 'start', ownerUserId: '',
        demo: true, demoExpiresAt: expires, createdAt: created,
      ),
      member: const TenantMember(tenantId: 'd1', userId: 'u1', role: TenantRole.employee, status: 'active'),
      branding: const BrandingConfig(),
      session: const SessionSettings(),
      features: const FeatureFlags(),
      subscription: const SubscriptionInfo(tenantId: 'd1', planId: 'start', status: 'trial'),
    );

void main() {
  group('Демо живёт 3 дня', () {
    test('срок — с сервера, у старых демо — 3 дня от создания', () {
      final created = DateTime(2026, 9, 1, 12);
      expect(DemoGate.expiryOf(_demo(created: created).tenant), DateTime(2026, 9, 4, 12));
      final expires = DateTime(2026, 9, 3, 18);
      expect(DemoGate.expiryOf(_demo(created: created, expires: expires).tenant), expires);
    });

    test('обратный отсчёт до сброса', () {
      expect(DemoGate.remainingLabel(const Duration(days: 2, hours: 5, minutes: 10)), 'через 2 дн. 5 ч');
      expect(DemoGate.remainingLabel(const Duration(days: 1)), 'через 1 дн.');
      expect(DemoGate.remainingLabel(const Duration(hours: 7, minutes: 59)), 'через 7 ч');
      expect(DemoGate.remainingLabel(const Duration(minutes: 42)), 'через 42 мин');
      expect(DemoGate.remainingLabel(const Duration(seconds: 20)), 'сейчас');
    });

    test('срок демо переживает офлайн-кэш — без сети касса тоже сбросит демо', () {
      final expires = DateTime(2026, 9, 3, 18);
      final restored = tenantConfigFromCacheMap(tenantConfigToCacheMap(_demo(expires: expires)));
      expect(restored.tenant.demo, isTrue);
      expect(restored.tenant.demoExpiresAt, expires);
      expect(DemoGate.expiryOf(restored.tenant), expires);
    });
  });
}
