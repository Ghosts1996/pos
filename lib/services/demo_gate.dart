import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/widgets.dart';

import '../models/tenant_models.dart';

/// Навигатор кассы — чтобы после сброса демо открыть вход в новое демо с
/// любого экрана (см. DemoResetScreen, main.dart).
final GlobalKey<NavigatorState> appNavigatorKey = GlobalKey<NavigatorState>();

/// Срок жизни демо-заведения: 3 дня с запуска демо на телефоне. Потом всё
/// введённое стирается, а касса сама открывает новое демо в исходном виде
/// (DemoResetScreen) — демо нельзя превратить в бесплатную рабочую кассу.
///
/// Сервер удаляет демо по своим часам (saas-gateway, DEMO_TTL_MS). Здесь —
/// обратный отсчёт и сброс по часам телефона; если сервер удалил демо
/// раньше (часы телефона отстают или их перевели назад), сброс тоже
/// происходит — по пропаже заведения.
class DemoGate {
  DemoGate._();

  static const Duration lifetime = Duration(days: 3);

  /// true — показать DemoResetScreen поверх кассы и открыть новое демо.
  static final ValueNotifier<bool> expired = ValueNotifier<bool>(false);

  static DateTime? _expiresAt;
  static DateTime? get expiresAt => _expiresAt;

  static Timer? _timer;
  static StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _sub;

  /// Когда демо сбросится: срок с сервера, у старых демо — от создания.
  static DateTime expiryOf(Tenant t) =>
      t.demoExpiresAt ?? (t.createdAt ?? DateTime.now()).add(lifetime);

  /// Следить за сроком демо [config] (у обычного заведения — ничего).
  static void watch(TenantConfig config) {
    stop();
    if (!config.tenant.demo) return;
    _expiresAt = expiryOf(config.tenant);
    _check();
    _timer = Timer.periodic(const Duration(minutes: 1), (_) => _check());
    _sub = FirebaseFirestore.instance.collection('tenants').doc(config.tenant.id).snapshots().listen(
      (snap) {
        // Демо удалено на сервере — сбрасываемся, даже если по часам
        // телефона срок ещё не вышел. Пустой ответ из кэша не в счёт.
        if (!snap.exists && !snap.metadata.isFromCache) expired.value = true;
      },
      onError: (Object e) {
        if (e is FirebaseException && e.code == 'permission-denied') expired.value = true;
      },
    );
  }

  static void _check() {
    final at = _expiresAt;
    if (at != null && !DateTime.now().isBefore(at)) expired.value = true;
  }

  /// Перестать следить (другое заведение). Флаг [expired] не трогает: его
  /// снимает экран сброса, когда откроет новое демо.
  static void stop() {
    _timer?.cancel();
    _timer = null;
    _sub?.cancel();
    _sub = null;
    _expiresAt = null;
  }

  /// «через 2 дн. 5 ч» — сколько осталось до сброса демо; null — не демо.
  static String? remainingText([DateTime? now]) {
    final at = _expiresAt;
    if (at == null) return null;
    return remainingLabel(at.difference(now ?? DateTime.now()));
  }

  static String remainingLabel(Duration left) {
    if (left.inMinutes < 1) return 'сейчас';
    if (left.inHours < 1) return 'через ${left.inMinutes} мин';
    final days = left.inDays, hours = left.inHours % 24;
    if (days == 0) return 'через $hours ч';
    return hours == 0 ? 'через $days дн.' : 'через $days дн. $hours ч';
  }
}
