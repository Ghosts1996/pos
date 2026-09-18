import 'package:firebase_core/firebase_core.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import '../firebase_options.dart';
import 'auth_service.dart';
import 'notification_service.dart';
import 'session_alerts_service.dart';

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
/// «Hoocah POS следит за залом». Пока оно висит, Android обязан держать
/// процесс живым — и подписки продолжают работать при свёрнутом
/// приложении, при выключенном экране и после того, как приложение
/// смахнули из списка задач.
///
/// Уведомление намеренно незаметное: канал создаётся с важностью NONE, и
/// система его в шторке не показывает — приложение просто попадает в
/// общую системную строку «приложения работают в фоне». Совсем без
/// уведомления Android держать приложение в фоне не разрешает никому: это
/// защита от программ, которые тихо работают за спиной у владельца
/// телефона.
///
/// Только для кассы. В приложении гостя постоянное уведомление было бы
/// назойливым и неуместным — гостю важны уведомления, пока он за столом и
/// с телефоном в руках.
class HallWatchService {
  HallWatchService._();
  static final HallWatchService instance = HallWatchService._();

  bool _started = false;

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

  /// Убирает каналы прошлых версий из настроек телефона.
  ///
  /// Важность канала задаётся один раз, при создании, поэтому каждый новый
  /// вариант заводит свой канал — а старые остаются висеть в списке
  /// категорий. У пользователя их набралось два с одинаковым названием
  /// «Работа в фоне», и какой из них что делает, понять невозможно.
  Future<void> _dropOldChannels() async {
    for (final id in const ['colibri_hall_watch', 'colibri_hall_watch_min']) {
      try {
        await NotificationService.instance.deleteChannel(id);
      } catch (_) {}
    }
  }

  /// Запускает службу с заданной «заметностью» уведомления.
  ///
  /// Android не разрешает держать приложение живым в фоне вообще без
  /// уведомления — это защита от программ, которые тихо работают за спиной
  /// у владельца телефона. Обойти это нельзя, но можно сделать уведомление
  /// таким, что его не видно: канал с важностью NONE система в шторке не
  /// показывает, а само приложение просто попадает в системную строку
  /// «приложения работают в фоне». Служба при этом работает как работала,
  /// и вызовы гостей приходят.
  ///
  /// Важность канала задаётся ОДИН раз, при его создании: дальше ею
  /// распоряжается владелец телефона, и менять её из кода Android не даёт.
  /// Поэтому у каждого варианта свой id канала — иначе у тех, у кого канал
  /// уже создан, ничего бы не изменилось.
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

      if (await FlutterForegroundTask.isRunningService) return true;

      await FlutterForegroundTask.startService(
        notificationTitle: 'Hoocah POS',
        notificationText: 'Служебная запись — не выключайте',
        callback: hallWatchCallback,
      );
      return true;
    } catch (_) {
      return false;
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

/// Здесь и ведётся слежение за залом.
///
/// Это ключевой момент, и он не очевиден. Когда приложение смахивают из
/// списка задач, Android уничтожает его экран — а вместе с экраном умирает
/// и весь основной изолят Dart со всеми подписками на базу. Служба при
/// этом продолжает работать, но в СВОЁМ отдельном изоляте, который
/// запускается вот этой функцией.
///
/// Раньше обработчик был пустым: служба держала процесс живым, а следить
/// за вызовами гостей было уже некому — подписки жили в изоляте, которого
/// больше нет. Со стороны это выглядело как «уведомления не приходят после
/// смахивания», хотя служба честно работала.
///
/// Теперь подписки живут здесь. Изолят свой, поэтому всё нужно поднять
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
      await NotificationService.instance.init();
      await SessionAlertsService.instance.start();
    } catch (_) {
      // Не вышло — уведомлений в фоне не будет, но приложение цело.
    }
  }

  @override
  void onRepeatEvent(DateTime timestamp) {}

  @override
  Future<void> onDestroy(DateTime timestamp) async {
    await SessionAlertsService.instance.stop();
  }
}
