/// Живой сторож блокировки кассы при просроченной или приостановленной
/// подписке.
///
/// TenantConfigService.refresh() проверяет статус только на старте, а
/// планшет перезапускают не каждый день. [watch] держит лёгкую подписку на
/// два документа и сразу поднимает [blocked] — экран блокировки через
/// MaterialApp.builder (main.dart) перекрывает любой экран кассира.
library subscription_gate;

import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import '../build_info.dart';
import '../models/tenant_models.dart';
import '../data/app_db.dart';
import '../data/local_engine.dart' as engine show onServerContact;
import '../data/offline_lease.dart';

class SubscriptionGate {
  SubscriptionGate._();

  /// true — показывать экран блокировки вместо обычного интерфейса.
  /// В одно-арендной сборке [watch] никогда не вызывается, поэтому здесь
  /// навсегда остаётся false — поведение существующего развёртывания не
  /// меняется ни на йоту.
  static final ValueNotifier<bool> blocked = ValueNotifier<bool>(false);

  /// Касса закрыта не сервером, а «арендой без связи» (SaaS): долго без
  /// интернета или оплаченный срок прошёл, а связи не было. Текст причины —
  /// для экрана блокировки; null — блокировка обычная (или её нет).
  static final ValueNotifier<String?> leaseReason = ValueNotifier<String?>(null);

  /// Предупреждение заранее: «без связи касса остановится через N дн.».
  static final ValueNotifier<String?> leaseWarning = ValueNotifier<String?>(null);
  static Timer? _leaseTimer;

  /// До какого момента оплачено: пробный — до конца пробного, иначе — до
  /// конца оплаченного периода.
  static DateTime? paidUntilOf(SubscriptionInfo? s) {
    if (s == null) return null;
    if (s.status == 'trial') return s.trialEndsAt ?? s.currentPeriodEnd;
    return s.currentPeriodEnd ?? s.trialEndsAt;
  }

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

  /// Момент удаления данных — для отсчёта на экране блокировки.
  static DateTime? get dataPurgeAt => _subscription?.dataPurgeAt;

  @visibleForTesting
  static void debugSetSubscription(SubscriptionInfo? s) => _subscription = s;

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
    if (kSaasMode) {
      OfflineLease.load(tenantId).then((_) {
        OfflineLease.notePaidUntil(paidUntilOf(_subscription));
        _recompute();
      });
      _leaseTimer = Timer.periodic(const Duration(minutes: 5), (_) => _recompute());
      engine.onServerContact = SubscriptionGate.serverContact;
    }
    _recompute();

    final db = AppDb.instance;
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
      if (kSaasMode && snap.data() != null) OfflineLease.notePaidUntil(paidUntilOf(_subscription));
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
    final lease = kSaasMode ? OfflineLease.expiredReason() : null;
    leaseReason.value = lease;
    leaseWarning.value = kSaasMode && lease == null ? OfflineLease.warning() : null;
    blocked.value = computeBlocked(_tenantStatus, _subscription?.status, chainStatus: _chainStatus) || lease != null;
  }

  /// Ответ сервера получен (local_engine): связь есть — пересчитать сразу,
  /// чтобы экран «нет связи» исчез без ожидания таймера.
  static void serverContact() {
    if (!kSaasMode) return;
    final was = leaseReason.value != null || leaseWarning.value != null;
    OfflineLease.noteContact();
    if (was) _recompute();
  }

  /// Останавливает слежение и возвращает в незаблокированное состояние —
  /// при смене заведения (переприсоединении устройства) и в тестах.
  static void stop() {
    _leaseTimer?.cancel();
    _leaseTimer = null;
    leaseReason.value = null;
    leaseWarning.value = null;
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
/// сам по себе завязан на реальный `AppDb.instance`, которого
/// в `flutter test` нет (см. тот же приём для AppScope.scopedPath).
bool computeBlocked(TenantStatus tenantStatus, String? subscriptionStatus, {TenantStatus? chainStatus}) {
  final operationsAllowed = tenantStatus.allowsOperations &&
      (chainStatus == null || chainStatus.allowsOperations) &&
      subscriptionStatus != 'cancelled';
  return !operationsAllowed;
}

/// Отсчёт до удаления данных: целые дни и остаток меньше суток. После
/// срока — нули.
({int days, Duration rest}) purgeCountdown(DateTime deadline, DateTime now) {
  final left = deadline.difference(now);
  if (left <= Duration.zero) return (days: 0, rest: Duration.zero);
  return (days: left.inDays, rest: left - Duration(days: left.inDays));
}
