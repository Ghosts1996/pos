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

    test('демо-сеть: PIN-подсказки точки и код демо для гостя переживают офлайн-кэш', () {
      const river = TenantConfig(
        tenant: Tenant(
          id: 'd2', name: 'Демо · Набережная', slug: 'demo-x-river', status: TenantStatus.active,
          planId: 'start', ownerUserId: '', chainId: 'c1', demo: true, demoCode: 'demo-x',
          demoPins: DemoPins(admin: '222222', hookah: '4444', waiter: '5555', bar: '6666'),
        ),
        member: TenantMember(tenantId: 'd2', userId: 'u1', role: TenantRole.employee, status: 'active'),
        branding: BrandingConfig(),
        session: SessionSettings(),
        features: FeatureFlags(),
        subscription: SubscriptionInfo(tenantId: 'c1', planId: 'chain', status: 'trial'),
      );
      final restored = tenantConfigFromCacheMap(tenantConfigToCacheMap(river));
      expect(restored.tenant.demoCode, 'demo-x');
      expect(restored.tenant.demoPins.staffHint, 'Демо: кальянщик — 4444, официант — 5555, бармен — 6666');
      expect(restored.tenant.demoPins.adminHint, 'Демо: администратор — 222222');
      // У старых демо подсказок нет — стандартные PIN первой точки.
      expect(DemoPins.fromMap(null).adminHint, 'Демо: администратор — 111111');
      expect(DemoPins.fromMap({'admin': 'x'}).admin, '111111');
    });
  });
}
