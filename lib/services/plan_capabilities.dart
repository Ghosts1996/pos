/// Что даёт тариф заведения: приложение гостя и меню по QR, ИИ-помощник,
/// число устройств с кассой. Источник — tenants/{id}/public/features, пишет только
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

  /// 0 — без лимита. Тарифы больше не ограничивают сотрудников — поле
  /// читается для старых документов features.
  final int maxEmployees;

  /// Сколько устройств с кассой может работать в заведении (0 — без
  /// лимита), см. [DeviceLimitGate].
  final int maxDevices;

  const PlanCapabilities({this.guestApp = true, this.ai = true, this.maxEmployees = 0, this.maxDevices = 0});

  static const full = PlanCapabilities();

  factory PlanCapabilities.fromMap(Map<String, dynamic>? d) {
    if (d == null) return full;
    final max = d['maxEmployees'];
    final dev = d['maxDevices'];
    return PlanCapabilities(
      guestApp: d['guestApp'] != false,
      ai: d['ai'] != false,
      maxEmployees: max is num && max > 0 ? max.toInt() : 0,
      maxDevices: dev is num && dev > 0 ? dev.toInt() : 0,
    );
  }


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

/// Лимит устройств тарифа: касса работает, если она среди первых
/// [PlanCapabilities.maxDevices] подключённых и не отключённых устройств
/// заведения (по времени подключения). Лишняя касса показывает экран
/// «Лимит устройств» — владелец отключает старый планшет в кабинете
/// («Устройства») или переходит на тариф больше, и касса открывается сама.
///
/// Устройство без документа в devices (приложение гостя, сборка одного
/// заведения) не ограничивается никогда.
class DeviceLimitGate {
  DeviceLimitGate._();

  /// null — касса работает; иначе — лимит тарифа и сколько устройств уже
  /// работают.
  static final ValueNotifier<DeviceLimitState?> over = ValueNotifier(null);

  /// Все устройства заведения по времени подключения — для списка на
  /// экране лимита и в Админ → «Устройства».
  static final ValueNotifier<List<DeviceSlot>> devices = ValueNotifier(const []);

  /// Это устройство.
  static String get myId => _uid;

  static StreamSubscription<QuerySnapshot<Map<String, dynamic>>>? _sub;
  static List<DeviceSlot> _devices = const [];
  static String _uid = '';

  static void watch(String tenantId, String uid) {
    stop();
    if (!kSaasMode || uid.isEmpty) return;
    _uid = uid;
    PlanCapabilitiesService.current.addListener(_recompute);
    _sub = FirebaseFirestore.instance.collection('tenants').doc(tenantId).collection('devices').snapshots().listen(
      (snap) {
        _devices = [for (final d in snap.docs) DeviceSlot.fromMap(d.id, d.data())];
        devices.value = sorted(_devices);
        _recompute();
      },
      // Нет прав или связи — кассу не блокируем.
      onError: (_) {},
    );
  }

  static void stop() {
    _sub?.cancel();
    _sub = null;
    PlanCapabilitiesService.current.removeListener(_recompute);
    _devices = const [];
    devices.value = const [];
    over.value = null;
  }

  static void _recompute() {
    over.value = check(_devices, _uid, PlanCapabilitiesService.current.value.maxDevices);
  }

  /// По времени подключения; ещё без серверного времени — только что
  /// подключились, значит последние.
  static List<DeviceSlot> sorted(Iterable<DeviceSlot> list) => list.toList()
    ..sort((a, b) {
      final ta = a.joinedAt, tb = b.joinedAt;
      if (ta == null && tb == null) return a.id.compareTo(b.id);
      if (ta == null) return 1;
      if (tb == null) return -1;
      final c = ta.compareTo(tb);
      return c != 0 ? c : a.id.compareTo(b.id);
    });

  /// Работает ли касса на устройстве [id] при лимите [max].
  static bool works(List<DeviceSlot> devices, String id, int max) {
    final me = devices.where((d) => d.id == id).firstOrNull;
    if (me == null || !me.active) return false;
    if (max <= 0) return true;
    return sorted(devices.where((d) => d.active)).indexWhere((d) => d.id == id) < max;
  }

  /// null — устройству [uid] можно работать.
  @visibleForTesting
  static DeviceLimitState? check(List<DeviceSlot> devices, String uid, int max) {
    final me = devices.where((d) => d.id == uid).firstOrNull;
    if (me == null) return null;
    // Отключили в кабинете — касса на этом устройстве не работает, иначе
    // отключение освобождало бы место, а планшет продолжал бы работать.
    if (!me.active) return DeviceLimitState(max: max, active: devices.where((d) => d.active).length, disabled: true);
    if (max <= 0) return null;
    final active = sorted(devices.where((d) => d.active));
    final place = active.indexWhere((d) => d.id == uid);
    return place < max ? null : DeviceLimitState(max: max, active: active.length);
  }
}

class DeviceSlot {
  final String id;
  final bool active;
  final DateTime? joinedAt;

  /// Имя, данное при подключении или в кабинете («Планшет на баре»).
  final String name;

  /// android, windows, …
  final String platform;

  /// Для чего используют: «Экран кухни и бара», «Официант».
  final String usage;
  final DateTime? seenAt;

  const DeviceSlot({
    required this.id,
    required this.active,
    this.joinedAt,
    this.name = '',
    this.platform = '',
    this.usage = '',
    this.seenAt,
  });

  factory DeviceSlot.fromMap(String id, Map<String, dynamic> d) {
    DateTime? t(Object? v) => v is Timestamp ? v.toDate() : null;
    final seen = [t(d['seenAt']), t(d['lastSeenAt'])].whereType<DateTime>().toList()..sort();
    return DeviceSlot(
      id: id,
      active: d['status'] != 'disabled',
      joinedAt: t(d['createdAt']),
      name: '${d['deviceName'] ?? ''}'.trim(),
      platform: '${d['platform'] ?? ''}',
      usage: '${d['usage'] ?? ''}'.trim(),
      seenAt: seen.isEmpty ? null : seen.last,
    );
  }

  /// «Планшет на баре», а без имени — по платформе.
  String get title => name.isNotEmpty
      ? name
      : switch (platform) {
          'windows' => 'Компьютер с Windows',
          'android' => 'Android-устройство',
          _ => 'Устройство',
        };
}

class DeviceLimitState {
  final int max;
  final int active;

  /// Устройство отключил владелец в кабинете.
  final bool disabled;
  const DeviceLimitState({required this.max, required this.active, this.disabled = false});
}
