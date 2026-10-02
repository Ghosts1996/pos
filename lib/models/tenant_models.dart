/// Модели данных SaaS-платформы (мультитенантная надстройка).
///
/// Эти модели работают ПРОТИВ НОВОГО, отдельного Firebase-проекта платформы
/// (см. `saas/`), а не против текущего одно-арендного проекта, который
/// продолжает обслуживать действующее заведение без изменений. Экраны и
/// сервисы, специфичные для одного заведения (lib/services/firestore_
/// service.dart и т.д.), пока НЕ используют эти модели — переключение
/// работающего приложения на них является отдельным этапом (см. README
/// раздела saas/).
library tenant_models;

import 'package:cloud_firestore/cloud_firestore.dart';

/// Статус заведения-арендатора (ТЗ §5).
enum TenantStatus { trial, active, pastDue, suspended, cancelled, deleted }

extension TenantStatusX on TenantStatus {
  String get id {
    switch (this) {
      case TenantStatus.trial:
        return 'trial';
      case TenantStatus.active:
        return 'active';
      case TenantStatus.pastDue:
        return 'past_due';
      case TenantStatus.suspended:
        return 'suspended';
      case TenantStatus.cancelled:
        return 'cancelled';
      case TenantStatus.deleted:
        return 'deleted';
    }
  }

  static TenantStatus fromId(String? id) {
    switch (id) {
      case 'active':
        return TenantStatus.active;
      case 'past_due':
        return TenantStatus.pastDue;
      case 'suspended':
        return TenantStatus.suspended;
      case 'cancelled':
        return TenantStatus.cancelled;
      case 'deleted':
        return TenantStatus.deleted;
      case 'trial':
      default:
        return TenantStatus.trial;
    }
  }

  /// Может ли заведение вести обычную операционную работу — открывать
  /// столы, принимать заказы. ЖЁСТКАЯ блокировка при просрочке платежа:
  /// `pastDue` запрещает работу немедленно (владелец явно попросил именно
  /// так, а не "мягкую блокировку" из более ранней версии ТЗ) — касса и
  /// приложение показывают экран оплаты вместо обычного интерфейса, пока
  /// подписку не продлят (см. lib/services/subscription_gate.dart). У
  /// владельца при этом остаётся 10 дней на оплату, прежде чем данные
  /// заведения реально удалятся (saas/functions/index.js, GRACE_PERIOD_DAYS/
  /// enforceGracePeriod) — allowsOperations здесь и покрывает ровно эти
  /// 10 дней "не работает, но ещё не стёрто", а не отдельный льготный режим
  /// с частичным доступом.
  bool get allowsOperations => this == TenantStatus.trial || this == TenantStatus.active;

  /// Владелец должен видеть статус, платить и выгружать данные даже у
  /// заблокированного заведения — запрещено только удалённому (ТЗ §35).
  bool get allowsOwnerAccess => this != TenantStatus.deleted;
}

/// Роль участника заведения (ТЗ §6). Полный список ролей на будущее
/// (hookah_master/cashier/hostess/warehouse/analyst) сюда не включён — они
/// не меняют границы доступа на уровне Firestore-правил (все они внутри
/// 'employee'), а являются лишь более точной подписью в интерфейсе;
/// добавляются отдельно, когда понадобится реальное разграничение прав
/// между ними.
enum TenantRole { owner, admin, manager, employee }

extension TenantRoleX on TenantRole {
  String get id {
    switch (this) {
      case TenantRole.owner:
        return 'owner';
      case TenantRole.admin:
        return 'admin';
      case TenantRole.manager:
        return 'manager';
      case TenantRole.employee:
        return 'employee';
    }
  }

  /// Место в иерархии — больше означает больше прав. Используется, чтобы
  /// не плодить `if (role == 'admin' || role == 'owner' || ...)` по всему
  /// приложению, а сравнивать один раз: `role.atLeast(TenantRole.manager)`.
  int get rank {
    switch (this) {
      case TenantRole.owner:
        return 3;
      case TenantRole.admin:
        return 2;
      case TenantRole.manager:
        return 1;
      case TenantRole.employee:
        return 0;
    }
  }

  bool atLeast(TenantRole other) => rank >= other.rank;

  static TenantRole? fromId(String? id) {
    switch (id) {
      case 'owner':
        return TenantRole.owner;
      case 'admin':
        return TenantRole.admin;
      case 'manager':
        return TenantRole.manager;
      case 'employee':
        return TenantRole.employee;
      default:
        return null;
    }
  }
}

/// PIN-коды сотрудников демо-заведения — их подсказывают экраны входа и
/// блокировки. У двух точек демо-сети они разные (createDemoTenant в
/// saas-gateway): видно, что сотрудники у каждой точки свои.
class DemoPins {
  final String admin;
  final String hookah;
  final String waiter;
  final String bar;

  const DemoPins({this.admin = '111111', this.hookah = '1111', this.waiter = '2222', this.bar = '3333'});

  static const standard = DemoPins();

  factory DemoPins.fromMap(Object? raw) {
    if (raw is! Map) return standard;
    String pick(String key, String fallback) {
      final v = raw[key];
      return v is String && RegExp(r'^\d{4,6}$').hasMatch(v) ? v : fallback;
    }

    return DemoPins(
      admin: pick('admin', standard.admin),
      hookah: pick('hookah', standard.hookah),
      waiter: pick('waiter', standard.waiter),
      bar: pick('bar', standard.bar),
    );
  }

  Map<String, String> toMap() => {'admin': admin, 'hookah': hookah, 'waiter': waiter, 'bar': bar};

  String get adminHint => 'Демо: администратор — $admin';
  String get staffHint => 'Демо: кальянщик — $hookah, официант — $waiter, бармен — $bar';
}

class Tenant {
  final String id;
  final String name;
  final String slug;
  final TenantStatus status;
  final String planId;
  final String ownerUserId;
  // Сеть; null у одиночного заведения. Если задана — биллинг и лояльность
  // живут в chains/{chainId}.
  final String? chainId;

  /// Одноразовое демо-заведение (createDemoTenant): вход по известным PIN,
  /// через 3 дня стирается само, а касса открывает новое (DemoGate).
  final bool demo;

  /// Когда демо сбросится в исходный вид; у старых демо поля нет — тогда
  /// считается от [createdAt] (DemoGate.expiryOf).
  final DateTime? demoExpiresAt;

  /// PIN-коды сотрудников демо (см. [DemoPins]).
  final DemoPins demoPins;

  /// Код демо-сети для демо-приложения гостя (касса показывает его на
  /// экране входа); пусто у обычного заведения.
  final String demoCode;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  const Tenant({
    required this.id,
    required this.name,
    required this.slug,
    required this.status,
    required this.planId,
    required this.ownerUserId,
    this.chainId,
    this.demo = false,
    this.demoExpiresAt,
    this.demoPins = DemoPins.standard,
    this.demoCode = '',
    this.createdAt,
    this.updatedAt,
  });

  factory Tenant.fromDoc(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>? ?? {};
    final created = d['createdAt'];
    final updated = d['updatedAt'];
    final demoExpires = d['demoExpiresAt'];
    final chainId = d['chainId'] as String?;
    return Tenant(
      id: doc.id,
      name: d['name'] as String? ?? '',
      slug: d['slug'] as String? ?? '',
      status: TenantStatusX.fromId(d['status'] as String?),
      planId: d['planId'] as String? ?? 'start',
      ownerUserId: d['ownerUserId'] as String? ?? '',
      chainId: (chainId != null && chainId.isNotEmpty) ? chainId : null,
      demo: d['demo'] == true,
      demoExpiresAt: demoExpires is Timestamp ? demoExpires.toDate() : null,
      demoPins: DemoPins.fromMap(d['demoPins']),
      demoCode: d['demoCode'] is String ? d['demoCode'] as String : '',
      createdAt: created is Timestamp ? created.toDate() : null,
      updatedAt: updated is Timestamp ? updated.toDate() : null,
    );
  }
}

/// Сеть заведений (chains/{chainId}) — минимум, нужный кассе/приложению:
/// её собственный статус жизненного цикла (тот же смысл, что и у
/// [TenantStatus] заведения), которым может быть заблокирована ЛЮБАЯ точка
/// сети сразу, независимо от статуса отдельного tenants/{id} (см.
/// [TenantConfig.operationsAllowed]).
class ChainInfo {
  final String id;
  final String name;
  final TenantStatus status;

  const ChainInfo({required this.id, required this.name, required this.status});

  factory ChainInfo.fromDoc(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>? ?? {};
    return ChainInfo(
      id: doc.id,
      name: d['name'] as String? ?? '',
      status: TenantStatusX.fromId(d['status'] as String?),
    );
  }
}

class TenantMember {
  final String tenantId;
  final String userId;
  final TenantRole role;
  final String status; // 'active' | 'removed'

  const TenantMember({
    required this.tenantId,
    required this.userId,
    required this.role,
    required this.status,
  });

  bool get isActive => status == 'active';

  factory TenantMember.fromDoc(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>? ?? {};
    return TenantMember(
      tenantId: d['tenantId'] as String? ?? '',
      userId: d['userId'] as String? ?? '',
      role: TenantRoleX.fromId(d['role'] as String?) ?? TenantRole.employee,
      status: d['status'] as String? ?? 'active',
    );
  }
}

/// Настройки сеанса кальяна заведения (длительность и прочее).
class SessionSettings {
  final int defaultHookahDurationMinutes;
  final int minimumHookahDurationMinutes;
  final int maximumHookahDurationMinutes;
  final List<int> quickExtensions;

  const SessionSettings({
    this.defaultHookahDurationMinutes = 90,
    this.minimumHookahDurationMinutes = 30,
    this.maximumHookahDurationMinutes = 360,
    this.quickExtensions = const [15, 30, 60],
  });

  factory SessionSettings.fromMap(Map<String, dynamic>? d) {
    if (d == null) return const SessionSettings();
    return SessionSettings(
      defaultHookahDurationMinutes: (d['defaultHookahDurationMinutes'] as num?)?.toInt() ?? 90,
      minimumHookahDurationMinutes: (d['minimumHookahDurationMinutes'] as num?)?.toInt() ?? 30,
      maximumHookahDurationMinutes: (d['maximumHookahDurationMinutes'] as num?)?.toInt() ?? 360,
      quickExtensions: (d['quickExtensions'] as List?)?.map((e) => (e as num).toInt()).toList() ??
          const [15, 30, 60],
    );
  }

  /// Зажимает произвольную длительность в границы, заданные заведением —
  /// используется в UI ручного изменения таймера, чтобы нельзя было
  /// выставить, например, 5 минут или 8 часов, если заведение это не
  /// разрешило.
  int clampMinutes(int minutes) {
    if (minutes < minimumHookahDurationMinutes) return minimumHookahDurationMinutes;
    if (minutes > maximumHookahDurationMinutes) return maximumHookahDurationMinutes;
    return minutes;
  }
}

/// Название приложения из базы. Прежнее название платформы («Hookah POS»)
/// форма «Брендинг» сохраняла по умолчанию, когда владелец ничего не
/// вводил, — это не имя заведения, показываем текущее название платформы.
String _appNameOf(String? saved) {
  if (saved == null) return 'ZalPOS';
  const legacy = {'Hookah POS', 'Hoocah POS', 'HookahPOS'};
  if (legacy.contains(saved.trim())) return 'ZalPOS';
  if (saved.trim() == 'Hookah POS (демо)') return 'ZalPOS (демо)';
  return saved;
}

/// Брендинг заведения (ТЗ §14) — то немногое, что реально нужно на первом
/// этапе runtime-брендинга (цвета/название), полный набор (favicon/splash и
/// т.п.) расширяется по мере реализации экрана предпросмотра (ТЗ §18).
class BrandingConfig {
  final String appName;
  final String shortName;
  final String primaryColor;
  final String secondaryColor;
  final String accentColor;
  final String backgroundColor;
  final String textColor;
  final String buttonColor;
  final bool darkMode;
  final String logoUrl;

  // Значения по умолчанию — РОВНО палитра «Графит и медь» из
  // lib/theme/app_colors.dart (AppColors.primary/background/textPrimary/
  // brass), а не какие-то отдельные цвета: свежее заведение без
  // кастомного брендинга должно выглядеть БАЙТ-В-БАЙТ как проверенный
  // одно-арендный продукт, а не как случайно другая палитра. (Строковые
  // литералы, а не импорт AppColors, — эта модель намеренно не зависит от
  // слоя темы/UI, см. заголовок файла.)
  const BrandingConfig({
    this.appName = 'ZalPOS',
    this.shortName = 'ZalPOS',
    this.primaryColor = '#B35C30',
    this.secondaryColor = '#CFA567',
    this.accentColor = '#B35C30',
    this.backgroundColor = '#15120F',
    this.textColor = '#F2EADF',
    this.buttonColor = '#B35C30',
    this.darkMode = true,
    this.logoUrl = '',
  });

  factory BrandingConfig.fromMap(Map<String, dynamic>? d) {
    if (d == null) return const BrandingConfig();
    return BrandingConfig(
      appName: _appNameOf(d['appName'] as String?),
      shortName: d['shortName'] as String? ?? 'ZalPOS',
      primaryColor: d['primaryColor'] as String? ?? '#B35C30',
      secondaryColor: d['secondaryColor'] as String? ?? '#CFA567',
      accentColor: d['accentColor'] as String? ?? '#B35C30',
      backgroundColor: d['backgroundColor'] as String? ?? '#15120F',
      textColor: d['textColor'] as String? ?? '#F2EADF',
      buttonColor: d['buttonColor'] as String? ?? '#B35C30',
      darkMode: d['darkMode'] as bool? ?? true,
      logoUrl: d['logoUrl'] as String? ?? '',
    );
  }
}

/// Лимиты и включённые модули тарифа (ТЗ §32).
class PlanLimits {
  final String planId;
  final int maxEmployees;
  final int maxDevices;
  final int maxTables;
  final int maxStorageMb;
  final bool aiEnabled;
  final bool customBranding;
  final bool customDomain;

  const PlanLimits({
    required this.planId,
    required this.maxEmployees,
    required this.maxDevices,
    required this.maxTables,
    required this.maxStorageMb,
    required this.aiEnabled,
    required this.customBranding,
    required this.customDomain,
  });

  factory PlanLimits.fromMap(String planId, Map<String, dynamic> d) {
    return PlanLimits(
      planId: planId,
      maxEmployees: (d['maxEmployees'] as num?)?.toInt() ?? 1,
      maxDevices: (d['maxDevices'] as num?)?.toInt() ?? 1,
      maxTables: (d['maxTables'] as num?)?.toInt() ?? 10,
      maxStorageMb: (d['maxStorageMb'] as num?)?.toInt() ?? 500,
      aiEnabled: d['aiEnabled'] as bool? ?? false,
      customBranding: d['customBranding'] as bool? ?? false,
      customDomain: d['customDomain'] as bool? ?? false,
    );
  }

  /// Использование vs. лимит — общий предикат для всех счётчиков (ТЗ §46:
  /// "владелец не должен просто упереться в стену без объяснения").
  bool isWithinLimit(int current, int limit) => limit <= 0 || current < limit;
}

/// Флаги функциональности с приоритетом platform → plan → tenant (ТЗ §45):
/// значение, заданное на более специфичном уровне, перекрывает более общее;
/// если не задано ни на одном уровне — используется [defaultValue].
class FeatureFlags {
  final Map<String, bool> platform;
  final Map<String, bool> plan;
  final Map<String, bool> tenant;

  const FeatureFlags({
    this.platform = const {},
    this.plan = const {},
    this.tenant = const {},
  });

  bool isEnabled(String key, {bool defaultValue = false}) {
    if (tenant.containsKey(key)) return tenant[key]!;
    if (plan.containsKey(key)) return plan[key]!;
    if (platform.containsKey(key)) return platform[key]!;
    return defaultValue;
  }
}

/// Сколько дней с начала просрочки (`SubscriptionInfo.pastDueSince`) даётся
/// на продление, прежде чем операционные данные заведения реально стираются
/// (см. `saas/functions/index.js`, `GRACE_PERIOD_DAYS`/`enforceGracePeriod`
/// /`purgeTenantData`) — то же самое число, задокументировано в обоих
/// местах отдельно, поскольку это два разных рантайма (Dart и Node),
/// синхронизировать значение можно только вручную при изменении.
const int gracePeriodDays = 10;

/// Подписка заведения (ТЗ §31/§35).
class SubscriptionInfo {
  final String tenantId;
  final String planId;
  final String status; // trial | active | past_due | suspended | cancelled
  final DateTime? trialEndsAt;
  final DateTime? currentPeriodEnd;
  final DateTime? pastDueSince;
  final bool cancelAtPeriodEnd;

  const SubscriptionInfo({
    required this.tenantId,
    required this.planId,
    required this.status,
    this.trialEndsAt,
    this.currentPeriodEnd,
    this.pastDueSince,
    this.cancelAtPeriodEnd = false,
  });

  factory SubscriptionInfo.fromMap(Map<String, dynamic>? d, String tenantId) {
    if (d == null) {
      return SubscriptionInfo(tenantId: tenantId, planId: 'start', status: 'trial');
    }
    final trialEnds = d['trialEndsAt'];
    final periodEnd = d['currentPeriodEnd'];
    final pastDue = d['pastDueSince'];
    return SubscriptionInfo(
      tenantId: tenantId,
      planId: d['planId'] as String? ?? 'start',
      status: d['status'] as String? ?? 'trial',
      trialEndsAt: trialEnds is Timestamp ? trialEnds.toDate() : null,
      currentPeriodEnd: periodEnd is Timestamp ? periodEnd.toDate() : null,
      pastDueSince: pastDue is Timestamp ? pastDue.toDate() : null,
      cancelAtPeriodEnd: d['cancelAtPeriodEnd'] as bool? ?? false,
    );
  }

  bool isTrialExpiringWithin(Duration window, {DateTime? now}) {
    final end = trialEndsAt;
    if (end == null) return false;
    final n = now ?? DateTime.now();
    return end.isAfter(n) && end.difference(n) <= window;
  }

  /// Сколько дней осталось до реального удаления данных заведения — null,
  /// если подписка не в просрочке (нечего отсчитывать). 0 означает "сегодня
  /// последний день": `enforceGracePeriod` стирает данные при следующем
  /// суточном прогоне после того, как пройдут все [gracePeriodDays] дней.
  int? daysUntilDataPurge({DateTime? now}) {
    final since = pastDueSince;
    if (status != 'past_due' || since == null) return null;
    final n = now ?? DateTime.now();
    final deadline = since.add(const Duration(days: gracePeriodDays));
    final remainingHours = deadline.difference(n).inHours;
    final remainingDays = (remainingHours / 24).ceil();
    return remainingDays < 0 ? 0 : remainingDays;
  }
}

/// Единая конфигурация, которую загружает [TenantConfigService] и которой
/// пользуются все три приложения (ТЗ §41) — POS, гостевые приложения, веб.
class TenantConfig {
  final Tenant tenant;
  final TenantMember member;
  final BrandingConfig branding;
  final SessionSettings session;
  final FeatureFlags features;
  final SubscriptionInfo subscription;
  // null у одиночного заведения (tenant.chainId == null) — заполняется,
  // только когда заведение состоит в сети (см. [ChainInfo]).
  final ChainInfo? chain;

  const TenantConfig({
    required this.tenant,
    required this.member,
    required this.branding,
    required this.session,
    required this.features,
    required this.subscription,
    this.chain,
  });

  /// Обычная операционная работа доступна, если и заведение не
  /// заблокировано, и — для точки сети — сама сеть не заблокирована
  /// (владелец не платит за сеть => блокируются ВСЕ её точки разом, не
  /// только одна), и подписка не просрочена/не отменена (ТЗ §16) — но НЕ
  /// требует активной сети: см. офлайн-грейс-период в [TenantConfigService].
  bool get operationsAllowed =>
      tenant.status.allowsOperations &&
      (chain == null || chain!.status.allowsOperations) &&
      subscription.status != 'cancelled';
}
