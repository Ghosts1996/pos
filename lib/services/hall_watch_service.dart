import 'package:firebase_core/firebase_core.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter/painting.dart' show Color;

import '../build_info.dart';
import '../firebase_options.dart';
import 'app_scope.dart';
import 'auth_service.dart';
import 'notification_service.dart';
import 'people_directory.dart';
import 'session_alerts_service.dart';
import 'tenant_config_service.dart';

/// Держит кассу «живой», пока приложение свёрнуто.
///
/// Уведомления о вызовах и бронях показывает само приложение, слушая базу.
/// Свёрнутое приложение Android рано или поздно выгружает, и подписки
/// обрываются. Push без Cloud Functions не отправить, поэтому держим
/// foreground-службу: пока она работает, процесс живёт — в том числе при
/// выключенном экране и после смахивания из списка задач.
///
/// Уведомление службы незаметное (канал с важностью NONE): совсем без
/// уведомления Android фоновую работу не разрешает. Только для кассы.
class HallWatchService {
  HallWatchService._();
  static final HallWatchService instance = HallWatchService._();

  bool _started = false;

  /// На этом устройстве вошёл другой сотрудник — пусть фоновая служба
  /// перечитает, кто это, и переставит напоминания (угли — только тем,
  /// кто ведёт кальяны). Если служба не запущена и за залом следит само
  /// приложение — обновляем его напрямую.
  Future<void> identityChanged() async {
    try {
      FlutterForegroundTask.sendDataToTask('identity');
    } catch (_) {}
    await SessionAlertsService.instance.refreshIdentity();
  }

  /// Возвращает true, если служба поднялась. Вызывающий по ответу решает,
  /// вести ли слежение самому: если служба не запустилась, за залом
  /// придётся следить основному приложению — хуже, но лучше, чем ничего.
  Future<bool> start() async {
    if (_started) return true;
    _started = true;
    await _dropOldChannels();
    // Сначала пробуем совсем беззвучный вариант, а если система откажется
    // с ним запускать службу — обычный тихий. Подробности у _tryStart.
    if (await _tryStart(NotificationChannelImportance.NONE, 'silent')) return true;
    if (await _tryStart(NotificationChannelImportance.MIN, 'min')) return true;
    _started = false;
    return false;
  }

  /// Убирает каналы прошлых версий: важность канала задаётся при создании,
  /// поэтому у каждого варианта свой канал, и старые висели в настройках
  /// под одинаковыми названиями.
  Future<void> _dropOldChannels() async {
    for (final id in const ['colibri_hall_watch', 'colibri_hall_watch_min']) {
      try {
        await NotificationService.instance.deleteChannel(id);
      } catch (_) {}
    }
  }

  /// Запускает службу с заданной «заметностью» уведомления. Канал с
  /// важностью NONE в шторке не виден, служба при этом работает. Важность
  /// канала потом меняет только владелец телефона, поэтому у каждого
  /// варианта свой id канала.
  Future<bool> _tryStart(
      NotificationChannelImportance importance, String suffix) async {
    try {
      FlutterForegroundTask.init(
        androidNotificationOptions: AndroidNotificationOptions(
          channelId: 'colibri_hall_watch_$suffix',
          channelName: 'Работа в фоне',
          channelDescription:
              'Служебная запись. Пока она есть, касса получает вызовы гостей '
              'и новые брони со свёрнутым приложением.',
          channelImportance: importance,
          priority: NotificationPriority.MIN,
          // На заблокированном экране не показывать вовсе.
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
          // Своя периодическая работа не нужна: задача сервиса — просто не
          // дать системе выгрузить процесс, а слушает базу основной изолят.
          eventAction: ForegroundTaskEventAction.nothing(),
          autoRunOnBoot: true,
          autoRunOnMyPackageReplaced: true,
          // Без вейклоков. Они держат процессор и Wi-Fi включёнными
          // постоянно и съедают батарею за часы — а нужны только для
          // непрерывных задач вроде записи трека. Здесь задача другая: не
          // дать системе выгрузить приложение. Соединение с базой система
          // сама поднимает, когда устройство просыпается, поэтому вызов
          // гостя доходит и без круглосуточно включённого процессора.
          allowWakeLock: false,
          allowWifiLock: false,
        ),
      );

      // Служба, запущенная прежней версией, после обновления поднимается
      // сама (autoRunOnMyPackageReplaced) со старым заголовком и значком —
      // поэтому уже запущенную тоже обновляем.
      if (await FlutterForegroundTask.isRunningService) {
        await FlutterForegroundTask.updateService(
          notificationTitle: _title,
          notificationText: _text,
          notificationIcon: _icon,
        );
        return true;
      }

      await FlutterForegroundTask.startService(
        notificationTitle: _title,
        notificationText: _text,
        notificationIcon: _icon,
        callback: hallWatchCallback,
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  static const _title = 'ZalPOS';
  static const _text = 'Касса на связи — вызовы гостей приходят и в фоне';

  /// Белый силуэт терминала (drawable/ic_notification, meta-data
  /// com.zalpos.notification_icon — добавляет сборка APK). Без него служба
  /// брала цветную иконку приложения, и в шторке было мутное пятно.
  static const _icon = NotificationIcon(
    metaDataName: 'com.zalpos.notification_icon',
    backgroundColor: Color(0xFFB35C30),
  );

  Future<void> stop() async {
    _started = false;
    try {
      await FlutterForegroundTask.stopService();
    } catch (_) {}
  }
}

/// Точка входа сервиса. Обязана быть функцией верхнего уровня с этой
/// пометкой — иначе её вырежет компилятор релизной сборки.
@pragma('vm:entry-point')
void hallWatchCallback() {
  FlutterForegroundTask.setTaskHandler(_HallWatchHandler());
}

/// Здесь ведётся слежение за залом.
///
/// Когда приложение смахивают, основной изолят Dart умирает вместе с
/// подписками, а служба продолжает работать в своём изоляте, который
/// запускает эта функция. Поэтому подписки живут здесь, и всё поднимаем
/// заново: Firebase, вход устройства, уведомления.
class _HallWatchHandler extends TaskHandler {
  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
    try {
      if (Firebase.apps.isEmpty) {
        await Firebase.initializeApp(
            options: DefaultFirebaseOptions.currentPlatform);
      }
      // Вход берётся сохранённый — тот же uid, что у приложения. Иначе
      // правила базы не признают устройство рабочим и молча не отдадут
      // ни вызовов, ни броней.
      await AuthService().ensureSignedIn();
      // Изолят службы не видит памяти приложения: AppScope здесь пустой, и в
      // SaaS-сборке подписки ушли бы в корневые коллекции вместо
      // tenants/{id}/… — уведомления в фоне молча не приходили. Заведение
      // берём из того же кэша, что и приложение при старте.
      if (kSaasMode) {
        final config = TenantConfigService();
        await config.loadFromCache();
        final c = config.current;
        if (c == null) return; // устройство ещё не присоединено — слушать нечего
        AppScope.enterTenant(c.tenant.id,
            branding: c.branding, slug: c.tenant.slug, chainId: c.tenant.chainId, demo: c.tenant.demo, demoPins: c.tenant.demoPins, demoCode: c.tenant.demoCode);
        // Имена для уведомлений — из копии справочника, которую ведёт касса.
        await People.instance.ensureReady();
      }
      await NotificationService.instance.init();
      await SessionAlertsService.instance.start();
    } catch (_) {
      // Не вышло — уведомлений в фоне не будет, но приложение цело.
    }
  }

  @override
  void onRepeatEvent(DateTime timestamp) {}

  @override
  void onReceiveData(Object data) {
    if (data == 'identity') SessionAlertsService.instance.refreshIdentity();
  }

  @override
  Future<void> onDestroy(DateTime timestamp) async {
    await SessionAlertsService.instance.stop();
  }
}
