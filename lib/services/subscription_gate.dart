/// Живой сторож жёсткой блокировки кассы при просроченной/приостановленной
/// подписке SaaS-заведения.
///
/// TenantConfigService.refresh() проверяет статус только один раз — на
/// старте приложения или сразу после присоединения устройства. Без
/// отдельного постоянного слушателя смена, начавшаяся ДО того, как
/// подписка стала past_due (или платформа заблокировала заведение через
/// disableTenant), продолжала бы работать до следующего перезапуска
/// планшета — а перезапускают его не каждый день. [watch] держит лёгкую
/// (два документа) реалтайм-подписку на всё время работы приложения и
/// немедленно поднимает [blocked], откуда экран блокировки
/// (SaasDevicePairingScreen соседствует с SaasSubscriptionBlockedScreen)
/// подхватывается через MaterialApp.builder в main.dart — то есть
/// перекрывает ЛЮБОЙ экран, на котором в этот момент находится кассир, а
/// не только специально подготовленные места.
library subscription_gate;

import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import '../models/tenant_models.dart';

class SubscriptionGate {
  SubscriptionGate._();

  /// true — показывать экран блокировки вместо обычного интерфейса.
  /// В одно-арендной сборке [watch] никогда не вызывается, поэтому здесь
  /// навсегда остаётся false — поведение существующего развёртывания не
  /// меняется ни на йоту.
  static final ValueNotifier<bool> blocked = ValueNotifier<bool>(false);

  static TenantStatus _tenantStatus = TenantStatus.active;
  // null у одиночного заведения — статус сети (см. ChainInfo), которой
  // может быть заблокирована сразу ВСЯ сеть, а не одна точка.
  static TenantStatus? _chainStatus;
  static SubscriptionInfo? _subscription;

  static StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _tenantSub;
  static StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _subscriptionSub;
  static StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _chainSub;

  /// Сколько дней осталось до реального удаления данных заведения — null,
  /// если подписка не в просрочке. Источник — последний известный
  /// subscriptions-документ (тот же расчёт, что и в консоли/Cloud Function,
  /// см. SubscriptionInfo.daysUntilDataPurge).
  static int? get daysUntilDataPurge => _subscription?.daysUntilDataPurge();

  /// Начинает следить за tenants/{tenantId} и subscriptions/{tenantId} —
  /// вызывается один раз сразу после AppScope.enterTenant (main.dart,
  /// экран присоединения устройства). [initialConfig] задаёт состояние
  /// СИНХРОННО, до первого ответа Firestore: без этого первый кадр
  /// приложения на просроченном заведении на долю секунды показал бы
  /// обычный интерфейс, прежде чем подписка успела бы прийти по сети.
  static void watch(String tenantId, TenantConfig initialConfig) {
    stop();
    _tenantStatus = initialConfig.tenant.status;
    _chainStatus = initialConfig.chain?.status;
    _subscription = initialConfig.subscription;
    _recompute();

    final db = FirebaseFirestore.instance;
    _tenantSub = db.collection('tenants').doc(tenantId).snapshots().listen((snap) {
      _tenantStatus = TenantStatusX.fromId(snap.data()?['status'] as String?);
      _recompute();
    }, onError: (_) {});

    // Для точки сети общая подписка лежит на subscriptions/{chainId}, а не
    // subscriptions/{tenantId} (см. AppScope.loyaltyCol/handleCreateChain в
    // saas-gateway) — id самого заведения тут не подходит.
    final chainId = initialConfig.tenant.chainId;
    final subscriptionId = chainId ?? tenantId;
    _subscriptionSub = db.collection('subscriptions').doc(subscriptionId).snapshots().listen((snap) {
      _subscription = SubscriptionInfo.fromMap(snap.data(), subscriptionId);
      _recompute();
    }, onError: (_) {});

    if (chainId != null) {
      _chainSub = db.collection('chains').doc(chainId).snapshots().listen((snap) {
        _chainStatus = TenantStatusX.fromId(snap.data()?['status'] as String?);
        _recompute();
      }, onError: (_) {});
    }
  }

  static void _recompute() {
    blocked.value = computeBlocked(_tenantStatus, _subscription?.status, chainStatus: _chainStatus);
  }

  /// Останавливает слежение и возвращает в незаблокированное состояние —
  /// при смене заведения (переприсоединении устройства) и в тестах.
  static void stop() {
    _tenantSub?.cancel();
    _subscriptionSub?.cancel();
    _chainSub?.cancel();
    _tenantSub = null;
    _subscriptionSub = null;
    _chainSub = null;
    _subscription = null;
    _chainStatus = null;
    _tenantStatus = TenantStatus.active;
    blocked.value = false;
  }
}

/// Та же формула, что и [TenantConfig.operationsAllowed] (лежит рядом,
/// в tenant_models.dart) — здесь выделена в отдельную чистую функцию, не
/// зависящую от Firestore, специально для юнит-теста: [SubscriptionGate]
/// сам по себе завязан на реальный `FirebaseFirestore.instance`, которого
/// в `flutter test` нет (см. тот же приём для AppScope.scopedPath).
bool computeBlocked(TenantStatus tenantStatus, String? subscriptionStatus, {TenantStatus? chainStatus}) {
  final operationsAllowed = tenantStatus.allowsOperations &&
      (chainStatus == null || chainStatus.allowsOperations) &&
      subscriptionStatus != 'cancelled';
  return !operationsAllowed;
}
