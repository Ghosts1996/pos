/// Разрешение конфигурации текущего заведения для SaaS-режима (ТЗ §42/§43).
///
/// Работает ПРОТИВ НОВОГО проекта платформы (см. `saas/`) — вызывается
/// после того, как пользователь вошёл в SaaS-аккаунт (users/{uid}), и
/// отвечает на вопрос "в каком заведении этот человек/устройство работает
/// и что этому заведению можно". Пока НЕ вызывается из main.dart:
/// подключение — отдельный шаг следующей фазы, когда решится, как именно
/// сотрудник/устройство выбирает своё заведение (see saas/README.md).
library tenant_config_service;

import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/tenant_models.dart';

class TenantConfigService {
  static const _cacheConfigKey = 'saas_tenant_config_cache_v1';
  static const _cacheVerifiedAtKey = 'saas_tenant_config_verified_at_v1';

  final FirebaseFirestore _db;

  TenantConfigService({FirebaseFirestore? firestore}) : _db = firestore ?? FirebaseFirestore.instance;

  TenantConfig? _current;
  DateTime? _lastVerifiedAt;

  /// Сколько времени доверяем последней подтверждённой конфигурации при
  /// отсутствии сети, прежде чем перейти в ограниченный режим (ТЗ §44).
  /// Не константа: разные тарифы в будущем смогут задавать своё значение.
  Duration offlineGracePeriod = const Duration(hours: 24);

  TenantConfig? get current => _current;

  /// true, если последняя проверка сервера была раньше, чем допускает
  /// [offlineGracePeriod] — то есть кэшу больше нельзя доверять "на слово".
  bool get isStale {
    final verified = _lastVerifiedAt;
    if (verified == null) return true;
    return DateTime.now().difference(verified) > offlineGracePeriod;
  }

  /// Можно ли вести обычную операционную работу ПРЯМО СЕЙЧАС.
  ///
  /// Намеренно НЕ требует свежей сети: POS должен продолжать работать при
  /// временном обрыве интернета (ТЗ §43 "POS не должен мгновенно
  /// ломаться"), а не потому, что подписка магическим образом стала active
  /// без сети — просто последнее ПОДТВЕРЖДЁННОЕ состояние остаётся в силе,
  /// пока не протухнет [offlineGracePeriod]. Если оно протухло — работаем
  /// по нему всё равно (лучше разрешить лишний час, чем внезапно остановить
  /// смену без предупреждения), но [isStale] сигнализирует UI показать
  /// предупреждение "давно нет связи с сервером".
  bool get operationsAllowedNow {
    final cfg = _current;
    if (cfg == null) return false;
    return cfg.operationsAllowed;
  }

  /// Восстанавливает последнюю известную конфигурацию из локального кэша —
  /// вызывается на старте приложения ДО обращения к сети, чтобы экран не
  /// висел пустым, пока грузятся данные (ТЗ §43: Local Cache → быстрый UI
  /// → Firebase Refresh → новая конфигурация).
  Future<void> loadFromCache() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_cacheConfigKey);
    final verifiedIso = prefs.getString(_cacheVerifiedAtKey);
    if (raw == null) return;
    try {
      final map = jsonDecode(raw) as Map<String, dynamic>;
      _current = tenantConfigFromCacheMap(map);
      _lastVerifiedAt = verifiedIso != null ? DateTime.tryParse(verifiedIso) : null;
    } catch (_) {
      // Повреждённый кэш — просто игнорируем, следующий refresh() перезапишет.
    }
  }

  /// Загружает актуальную конфигурацию для пользователя [uid] — по
  /// умолчанию его первое активное членство (в будущем — выбор из
  /// нескольких заведений, если пользователь состоит в более чем одном).
  /// Обновляет и in-memory состояние, и локальный кэш.
  Future<TenantConfig?> refresh(String uid, {String? preferredTenantId}) async {
    // tenantMembers/{id} — id всегда предсказуем: "<tenantId>_<uid>" (см.
    // saas/firestore.rules). Если tenantId уже известен (явно передан сюда,
    // как сразу после присоединения/демо — см. saas_device_pairing_screen)
    // или остался в кэше с прошлого раза — читаем ОДИН конкретный документ
    // по id, а не запросом по коллекции.
    //
    // ВАЖНО: это не оптимизация, а обход реального бага. Правило чтения
    // tenantMembers — "resource.data.userId == request.auth.uid ИЛИ
    // isMember(resource.data.tenantId)" — рассчитано на то, что Firestore
    // проверит его для каждого документа результата и увидит первую же
    // ветку истинной. На практике ЗАПРОС (list) по .where('userId', ...)
    // с этим правилом на реальном устройстве падает с
    // [cloud_firestore/permission-denied], хотя одиночный get() по
    // конкретному id той же самой проверкой проходит нормально (это
    // подтверждено вручную, не теория). Поэтому list оставлен только как
    // резерв на случай, когда tenantId заранее неизвестен вообще (самый
    // первый запуск до присоединения) — и там же, где он используется
    // (main.dart), сбой уже обёрнут в try/catch с откатом на кэш.
    final knownTenantId = preferredTenantId ?? _current?.tenant.id;
    DocumentSnapshot<Map<String, dynamic>>? memberDoc;
    if (knownTenantId != null) {
      final doc = await _db.collection('tenantMembers').doc('${knownTenantId}_$uid').get();
      if (doc.exists && doc.data()?['status'] == 'active') {
        memberDoc = doc;
      }
    }

    if (memberDoc == null) {
      final membersSnap = await _db
          .collection('tenantMembers')
          .where('userId', isEqualTo: uid)
          .where('status', isEqualTo: 'active')
          .get();
      if (membersSnap.docs.isEmpty) return null;
      memberDoc = membersSnap.docs.first;
    }
    final member = TenantMember.fromDoc(memberDoc);

    final tenantRef = _db.collection('tenants').doc(member.tenantId);
    // tenant читается ПЕРВЫМ (не в общем Future.wait с остальным) — id
    // документа subscriptions зависит от того, состоит ли это заведение в
    // сети (tenant.chainId): для сети общая подписка лежит на
    // subscriptions/{chainId}, а не subscriptions/{tenantId}, и это можно
    // узнать только после чтения самого tenant. Для одиночного заведения
    // (chainId == null, подавляющее большинство) это стоит один
    // дополнительный последовательный запрос вместо распараллеленных четырёх
    // — цена, оправданная тем, что раньше ID подписки для сети было бы
    // неоткуда взять вообще.
    final tenantDoc = await tenantRef.get();
    if (!tenantDoc.exists) return null;
    final tenant = Tenant.fromDoc(tenantDoc);
    final subscriptionId = tenant.chainId ?? member.tenantId;

    // chainDoc не зависит ни от одного из трёх чтений ниже (chainId уже
    // известен из tenant, прочитанного выше) — запускаем его тем же
    // Future.wait, а не отдельным await после: раньше он ждал своей
    // очереди уже ПОСЛЕ того, как остальные три успеют выполниться
    // параллельно, добавляя лишний последовательный сетевой круг заведению
    // сети при каждом refresh() (запуск POS/гостя, обновление конфигурации).
    final results = await Future.wait([
      tenantRef.collection('settings').doc('session').get(),
      tenantRef.collection('branding').doc('config').get(),
      _db.collection('subscriptions').doc(subscriptionId).get(),
      if (tenant.chainId != null) _db.collection('chains').doc(tenant.chainId).get(),
    ]);
    final chainDoc = tenant.chainId != null ? results[3] : null;

    final config = TenantConfig(
      tenant: tenant,
      member: member,
      branding: BrandingConfig.fromMap(results[1].data()),
      session: SessionSettings.fromMap(results[0].data()),
      features: const FeatureFlags(), // TODO(features): подтянуть plans/{planId}.features, когда появится экран тарифов
      subscription: SubscriptionInfo.fromMap(results[2].data(), subscriptionId),
      chain: (chainDoc != null && chainDoc.exists) ? ChainInfo.fromDoc(chainDoc) : null,
    );

    _current = config;
    _lastVerifiedAt = DateTime.now();
    await _saveCache(config, _lastVerifiedAt!);
    return config;
  }

  Future<void> _saveCache(TenantConfig config, DateTime verifiedAt) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_cacheConfigKey, jsonEncode(tenantConfigToCacheMap(config)));
    await prefs.setString(_cacheVerifiedAtKey, verifiedAt.toIso8601String());
  }
}

/// Сериализация конфигурации в/из кэша — чистые функции без побочных
/// эффектов (не методы класса), чтобы round-trip можно было проверить
/// юнит-тестом без Firestore/SharedPreferences (см. test/logic_test.dart).
Map<String, dynamic> tenantConfigToCacheMap(TenantConfig c) => {
      'tenant': {
        'id': c.tenant.id,
        'name': c.tenant.name,
        'slug': c.tenant.slug,
        'status': c.tenant.status.id,
        'planId': c.tenant.planId,
        'ownerUserId': c.tenant.ownerUserId,
        'chainId': c.tenant.chainId,
      },
      if (c.chain != null)
        'chain': {'id': c.chain!.id, 'name': c.chain!.name, 'status': c.chain!.status.id},
      'member': {
        'tenantId': c.member.tenantId,
        'userId': c.member.userId,
        'role': c.member.role.id,
        'status': c.member.status,
      },
      'branding': {
        'appName': c.branding.appName,
        'shortName': c.branding.shortName,
        'primaryColor': c.branding.primaryColor,
        'secondaryColor': c.branding.secondaryColor,
        'accentColor': c.branding.accentColor,
        'backgroundColor': c.branding.backgroundColor,
        'textColor': c.branding.textColor,
        'buttonColor': c.branding.buttonColor,
        'darkMode': c.branding.darkMode,
        'logoUrl': c.branding.logoUrl,
      },
      'session': {
        'defaultHookahDurationMinutes': c.session.defaultHookahDurationMinutes,
        'minimumHookahDurationMinutes': c.session.minimumHookahDurationMinutes,
        'maximumHookahDurationMinutes': c.session.maximumHookahDurationMinutes,
        'quickExtensions': c.session.quickExtensions,
      },
      'subscription': {
        'tenantId': c.subscription.tenantId,
        'planId': c.subscription.planId,
        'status': c.subscription.status,
        'trialEndsAt': c.subscription.trialEndsAt?.toIso8601String(),
        'currentPeriodEnd': c.subscription.currentPeriodEnd?.toIso8601String(),
        // Без этого поля восстановленный из офлайн-кэша конфиг не смог бы
        // посчитать daysUntilDataPurge() — экран блокировки (см.
        // SaasSubscriptionBlockedScreen) остался бы без обратного отсчёта
        // именно тогда, когда сети нет и кэш — единственный источник данных.
        'pastDueSince': c.subscription.pastDueSince?.toIso8601String(),
        'cancelAtPeriodEnd': c.subscription.cancelAtPeriodEnd,
      },
    };

TenantConfig tenantConfigFromCacheMap(Map<String, dynamic> m) {
  final t = m['tenant'] as Map<String, dynamic>;
  final mem = m['member'] as Map<String, dynamic>;
  // Кэш хранит даты как ISO-строки (jsonEncode не умеет Timestamp), поэтому
  // SubscriptionInfo.fromMap (рассчитан на Timestamp из Firestore) здесь не
  // подходит — собираем SubscriptionInfo напрямую.
  final sub = m['subscription'] as Map<String, dynamic>?;
  DateTime? parseIso(String? key) {
    final raw = sub?[key] as String?;
    return raw == null ? null : DateTime.tryParse(raw);
  }
  final chain = m['chain'] as Map<String, dynamic>?;
  return TenantConfig(
    tenant: Tenant(
      id: t['id'] as String,
      name: t['name'] as String,
      slug: t['slug'] as String,
      status: TenantStatusX.fromId(t['status'] as String?),
      planId: t['planId'] as String,
      ownerUserId: t['ownerUserId'] as String,
      chainId: t['chainId'] as String?,
    ),
    member: TenantMember(
      tenantId: mem['tenantId'] as String,
      userId: mem['userId'] as String,
      role: TenantRoleX.fromId(mem['role'] as String?) ?? TenantRole.employee,
      status: mem['status'] as String,
    ),
    branding: BrandingConfig.fromMap(m['branding'] as Map<String, dynamic>?),
    session: SessionSettings.fromMap(m['session'] as Map<String, dynamic>?),
    features: const FeatureFlags(),
    subscription: SubscriptionInfo(
      tenantId: sub?['tenantId'] as String? ?? t['id'] as String,
      planId: sub?['planId'] as String? ?? 'start',
      status: sub?['status'] as String? ?? 'trial',
      trialEndsAt: parseIso('trialEndsAt'),
      currentPeriodEnd: parseIso('currentPeriodEnd'),
      pastDueSince: parseIso('pastDueSince'),
      cancelAtPeriodEnd: sub?['cancelAtPeriodEnd'] as bool? ?? false,
    ),
    chain: chain != null
        ? ChainInfo(
            id: chain['id'] as String,
            name: chain['name'] as String,
            status: TenantStatusX.fromId(chain['status'] as String?),
          )
        : null,
  );
}
