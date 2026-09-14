import 'package:flutter_foreground_task/flutter_foreground_task.dart';

/// Держит POS «живым», пока приложение свёрнуто.
///
/// Зачем. Уведомления о вызовах гостей и новых бронях показывает само
/// приложение: оно слушает базу и реагирует. Пока приложение на экране —
/// всё работает. Стоит его свернуть, и Android рано или поздно выгружает
/// процесс, чтобы освободить память: подписки обрываются, и кальянщик
/// перестаёт получать вызовы, ничего об этом не зная.
///
/// Настоящий push решил бы это раз и навсегда, но для него нужен сервер, а
/// Cloud Functions доступны только на платном тарифе Firebase. Бесплатный
/// способ дать тот же результат один: постоянное («foreground») уведомление
/// «Colibri POS следит за залом». Пока оно висит, Android обязан держать
/// процесс живым — и подписки продолжают работать при свёрнутом
/// приложении, при выключенном экране и после того, как приложение
/// смахнули из списка задач.
///
/// Уведомление намеренно тихое и без звука: это метка в шторке, а не
/// сообщение.
///
/// Только для кассы. В приложении гостя постоянное уведомление было бы
/// назойливым и неуместным — гостю важны уведомления, пока он за столом и
/// с телефоном в руках.
class HallWatchService {
  HallWatchService._();
  static final HallWatchService instance = HallWatchService._();

  bool _started = false;

  Future<void> start() async {
    if (_started) return;
    _started = true;
    try {
      FlutterForegroundTask.init(
        androidNotificationOptions: AndroidNotificationOptions(
          channelId: 'colibri_hall_watch',
          channelName: 'Работа в фоне',
          channelDescription:
              'Пока это уведомление висит, касса получает вызовы гостей и '
              'новые брони даже со свёрнутым приложением.',
          channelImportance: NotificationChannelImportance.LOW,
          priority: NotificationPriority.LOW,
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

      if (await FlutterForegroundTask.isRunningService) return;

      await FlutterForegroundTask.startService(
        notificationTitle: 'Colibri POS следит за залом',
        notificationText: 'Вызовы гостей и брони приходят даже в фоне',
        callback: hallWatchCallback,
      );
    } catch (_) {
      // Не вышло — приложение работает как раньше, только уведомления
      // перестанут приходить после выгрузки из памяти.
      _started = false;
    }
  }

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

/// Пустой обработчик: вся работа идёт в основном изоляте, сервису нужно
/// лишь существовать.
class _HallWatchHandler extends TaskHandler {
  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {}

  @override
  void onRepeatEvent(DateTime timestamp) {}

  @override
  Future<void> onDestroy(DateTime timestamp) async {}
}
