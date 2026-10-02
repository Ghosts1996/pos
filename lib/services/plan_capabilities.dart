/// Что даёт тариф заведения: приложение гостя и меню по QR, ИИ-помощник,
/// число сотрудников. Источник — tenants/{id}/public/features, пишет только
/// сервер (syncTenantCapabilities в saas-gateway). Документа нет (сборка
/// одного заведения, демо, тариф ещё не синхронизирован) — доступно всё:
/// касса не должна ничего отнимать из-за сбоя синхронизации.
library plan_capabilities;

import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';

import '../build_info.dart';

class PlanCapabilities {
  final bool guestApp;
  final bool ai;

  /// 0 — без лимита.
  final int maxEmployees;

  const PlanCapabilities({this.guestApp = true, this.ai = true, this.maxEmployees = 0});

  static const full = PlanCapabilities();

  factory PlanCapabilities.fromMap(Map<String, dynamic>? d) {
    if (d == null) return full;
    final max = d['maxEmployees'];
    return PlanCapabilities(
      guestApp: d['guestApp'] != false,
      ai: d['ai'] != false,
      maxEmployees: max is num && max > 0 ? max.toInt() : 0,
    );
  }

  /// Уже [count] сотрудников — можно ли добавить ещё одного.
  bool canAddEmployee(int count) => maxEmployees <= 0 || count < maxEmployees;
}

class PlanCapabilitiesService {
  PlanCapabilitiesService._();

  static final ValueNotifier<PlanCapabilities> current = ValueNotifier(PlanCapabilities.full);
  static StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _sub;

  static DocumentReference<Map<String, dynamic>> _doc(String tenantId) =>
      FirebaseFirestore.instance.collection('tenants').doc(tenantId).collection('public').doc('features');

  /// Следить за тарифом заведения, в котором работает касса: владелец
  /// сменил тариф в кабинете — касса узнаёт без перезапуска.
  static void watch(String tenantId) {
    stop();
    if (!kSaasMode) return;
    _sub = _doc(tenantId).snapshots().listen(
          (snap) => current.value = PlanCapabilities.fromMap(snap.data()),
          onError: (_) {},
        );
  }

  static void stop() {
    _sub?.cancel();
    _sub = null;
    current.value = PlanCapabilities.full;
  }

  /// Разово — приложению гостя перед показом меню. Нет связи — не мешаем.
  static Future<PlanCapabilities> fetch(String tenantId) async {
    if (!kSaasMode) return PlanCapabilities.full;
    try {
      final snap = await _doc(tenantId).get().timeout(const Duration(seconds: 8));
      final caps = PlanCapabilities.fromMap(snap.data());
      // Приложение гостя не следит за тарифом постоянно — разового чтения
      // при входе в заведение хватает, чтобы спрятать то, чего в нём нет.
      current.value = caps;
      return caps;
    } catch (_) {
      return PlanCapabilities.full;
    }
  }
}
