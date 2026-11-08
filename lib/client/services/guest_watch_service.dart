import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart' show Color;
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../build_info.dart';
import '../../services/app_auth.dart';
import '../../services/app_scope.dart';
import '../../services/background_boot.dart';
import '../../services/notification_service.dart';
import 'kolibri_notifications.dart';

/// Держит приложение гостя на связи в фоне — как HallWatchService у кассы.
///
/// Уведомления гостя (бронь подтвердили, заказ готов, курьер в пути,
/// начислены бонусы, подарок от заведения) показывает само приложение,
/// слушая свои документы на сервере в РФ: push-сервисов Google и Apple у
/// платформы нет (152-ФЗ). Смахнутое приложение Android выгружает, поэтому
/// держим foreground-службу: пока она работает, слушает её изолят, — в том
/// числе с выключенным экраном, после смахивания и после перезагрузки.
///
/// Уведомление самой службы — в беззвучном канале (важность NONE), в шторке
/// его не видно. Только Android и только SaaS-сборка.
class GuestWatchService {
  GuestWatchService._();
  static final GuestWatchService instance = GuestWatchService._();

  static const tenantKey = 'kolibri_watch_tenant_v1';
  static const chainKey = 'kolibri_watch_chain_v1';
  static const titleKey = 'kolibri_watch_title_v1';

  bool _started = false;

  static bool get supported => kSaasMode && !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  /// Запускает службу для заведения [tenantId] (у сети — и [chainId]).
  /// Сменилось заведение — служба переключается на него. true — работает.
  Future<bool> start({required String tenantId, String? chainId, String venueName = ''}) async {
    if (!supported || tenantId.isEmpty) return false;
    var changed = false;
    try {
      final prefs = await SharedPreferences.getInstance();
      changed = prefs.getString(tenantKey) != tenantId || (prefs.getString(chainKey) ?? '') != (chainId ?? '');
      await prefs.setString(tenantKey, tenantId);
      if (chainId == null || chainId.isEmpty) {
        await prefs.remove(chainKey);
      } else {
        await prefs.setString(chainKey, chainId);
      }
      if (venueName.isNotEmpty) await prefs.setString(titleKey, venueName);
    } catch (_) {
      return false;
    }
    if (_started) {
      if (changed) _send('tenant');
      return true;
    }
    _started = true;
    if (await _tryStart(NotificationChannelImportance.NONE, 'silent', venueName)) return true;
    if (await _tryStart(NotificationChannelImportance.MIN, 'min', venueName)) return true;
    _started = false;
    return false;
  }

  /// Гость вышел или удалил свои данные — служба больше не нужна.
  Future<void> stop() async {
    _started = false;
    if (!supported) return;
    try {
      await FlutterForegroundTask.stopService();
    } catch (_) {}
  }

  void _send(String message) {
    try {
      FlutterForegroundTask.sendDataToTask(message);
    } catch (_) {}
  }

  Future<bool> _tryStart(NotificationChannelImportance importance, String suffix, String venueName) async {
    try {
      FlutterForegroundTask.init(
        androidNotificationOptions: AndroidNotificationOptions(
          channelId: 'guest_watch_$suffix',
          channelName: 'Работа в фоне',
          channelDescription: 'Служебная запись. Пока она есть, приложение сообщает о брони, '
              'заказе, бонусах и подарках, даже когда оно закрыто.',
          channelImportance: importance,
          priority: NotificationPriority.MIN,
          visibility: NotificationVisibility.VISIBILITY_SECRET,
          enableVibration: false,
          playSound: false,
          showWhen: false,
          showBadge: false,
          onlyAlertOnce: true,
        ),
        iosNotificationOptions: const IOSNotificationOptions(
          showNotification: false,
          playSound: false,
        ),
        foregroundTaskOptions: ForegroundTaskOptions(
          // Своя периодическая работа не нужна: служба держит процесс, а
          // документы гостя слушает её изолят.
          eventAction: ForegroundTaskEventAction.nothing(),
          autoRunOnBoot: true,
          autoRunOnMyPackageReplaced: true,
          // Без вейклоков: они держат процессор включённым и съедают батарею.
          allowWakeLock: false,
          allowWifiLock: false,
        ),
      );
      final title = venueName.isEmpty ? 'Уведомления заведения' : venueName;
      if (await FlutterForegroundTask.isRunningService) {
        await FlutterForegroundTask.updateService(
          notificationTitle: title,
          notificationText: _text,
          notificationIcon: _icon,
        );
        _send('tenant');
        return true;
      }
      await FlutterForegroundTask.startService(
        notificationTitle: title,
        notificationText: _text,
        notificationIcon: _icon,
        callback: guestWatchCallback,
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  static const _text = 'Сообщим о брони, заказе, бонусах и подарках';

  /// Белый силуэт (drawable/ic_notification, meta-data
  /// com.zalpos.notification_icon — добавляет сборка APK).
  static const _icon = NotificationIcon(
    metaDataName: 'com.zalpos.notification_icon',
    backgroundColor: Color(0xFFB35C30),
  );
}

/// Точка входа службы. Функция верхнего уровня с этой пометкой — иначе её
/// вырежет компилятор релизной сборки.
@pragma('vm:entry-point')
void guestWatchCallback() {
  FlutterForegroundTask.setTaskHandler(_GuestWatchHandler());
}

/// Здесь слушаются документы гостя, когда приложение закрыто: изолят
/// службы живёт отдельно от приложения, поэтому всё поднимаем заново.
class _GuestWatchHandler extends TaskHandler {
  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) => _enter();

  Future<void> _enter() async {
    try {
      // Свежие записи приложения (вход, заведение) — с диска: у изолята своя
      // копия, и после смены входа или заведения она устарела.
      final prefs = await SharedPreferences.getInstance();
      await prefs.reload();
      // Вход — только сохранённый: создавать гостю новый вход в фоне нельзя,
      // иначе бонусы остались бы на прежнем.
      if (!await bootBackgroundIsolate()) return;
      final tenantId = prefs.getString(GuestWatchService.tenantKey) ?? '';
      if (tenantId.isEmpty) return;
      final chainId = prefs.getString(GuestWatchService.chainKey);
      AppScope.enterTenant(tenantId, chainId: (chainId ?? '').isEmpty ? null : chainId);
      final uid = AppAuth.instance.currentUser?.uid ?? '';
      if (uid.isEmpty) return;
      await NotificationService.instance.init();
      await KolibriNotifications.instance.start(uid);
    } catch (_) {
      // Не вышло — уведомлений в фоне не будет, но приложение цело.
    }
  }

  @override
  void onRepeatEvent(DateTime timestamp) {}

  @override
  void onReceiveData(Object data) {
    if (data != 'tenant') return;
    // Гость сменил заведение сети или вошёл заново — слушаем нового.
    unawaited(KolibriNotifications.instance.stop().then((_) => _enter()));
  }

  @override
  Future<void> onDestroy(DateTime timestamp) async {
    await KolibriNotifications.instance.stop();
  }
}
