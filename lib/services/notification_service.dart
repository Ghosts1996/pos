import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

/// Локальные уведомления на POS-планшете.
///
/// Почему локальные, а не push: push через FCM требует сервера (Cloud
/// Functions), а он доступен только на платном тарифе Firebase. Локальные
/// уведомления планируются прямо на устройстве, работают без интернета и
/// ничего не стоят — для зала это даже надёжнее.
///
/// Три сценария:
///  • новая бронь или вызов гостя — уведомление сразу;
///  • через 35 минут после открытия стола — «пора менять угли»;
///  • за 10 минут до конца сеанса — «предложить продление».
class NotificationService {
  NotificationService._();
  static final NotificationService instance = NotificationService._();

  final _plugin = FlutterLocalNotificationsPlugin();
  bool _ready = false;

  /// Каналы разнесены, чтобы кальянщик мог отключить, например, только
  /// напоминания об углях, не потеряв уведомления о бронях.
  static const _channelInstant = AndroidNotificationChannel(
    'kolibri_instant',
    'Брони и вызовы гостей',
    description: 'Новые брони из приложения и вызовы кальянщика',
    importance: Importance.high,
  );

  static const _channelTimers = AndroidNotificationChannel(
    'kolibri_timers',
    'Таймеры столов',
    description: 'Угли через 35 минут и окончание сеанса',
    importance: Importance.high,
  );

  /// Последняя ошибка инициализации — её показывает [diagnose].
  String? _initError;

  /// Какая иконка в итоге используется. Если своей нет в сборке, плагин
  /// падает при инициализации, и тогда берём иконку приложения.
  String _icon = '@drawable/ic_notification';

  Future<void> init() async {
    if (_ready) return;

    // ПОРЯДОК ВАЖЕН. Раньше init начинался с настройки часовых поясов, и
    // любая осечка там (неизвестная зона, сбой базы) обрывала init целиком
    // — вместе с созданием каналов и запросом разрешения. Мгновенные
    // уведомления о бронях и вызовах гостей часовые пояса не используют
    // вовсе, но переставали работать заодно, причём молча: исключение
    // уходило в unawaited и нигде не всплывало.
    //
    // Теперь сначала делается то, без чего уведомлений нет вообще, а
    // часовые пояса — отдельно и с собственным перехватом: не вышло —
    // не сработают только отложенные напоминания.
    try {
      var ok = await _plugin.initialize(
        InitializationSettings(
          // Монохромная иконка: системная панель рисует только силуэт, и
          // цветной ic_launcher превращался в серый квадрат.
          android: AndroidInitializationSettings(_icon),
        ),
      );
      if (ok == false) throw Exception('плагин не инициализировался');
    } catch (e) {
      // Своей иконки в сборке нет — уведомления важнее красоты.
      _icon = '@mipmap/ic_launcher';
      _initError = 'иконка $e';
      try {
        await _plugin.initialize(
          InitializationSettings(
            android: AndroidInitializationSettings(_icon),
          ),
        );
      } catch (e2) {
        _initError = '$e2';
      }
    }

    final android =
        _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    try {
      await android?.createNotificationChannel(_channelInstant);
      await android?.createNotificationChannel(_channelTimers);
      await android?.requestNotificationsPermission();
      // Точные будильники нужны, чтобы напоминание об углях не «уехало»
      // на 10 минут из-за экономии батареи.
      await android?.requestExactAlarmsPermission();
    } catch (e) {
      _initError = '$e';
    }

    _ready = true;

    // Часовые пояса — только для отложенных уведомлений.
    try {
      tzdata.initializeTimeZones();
      tz.setLocalLocation(tz.getLocation(await _deviceTimeZone()));
    } catch (_) {
      // Отложенные напоминания не встанут, мгновенные работают.
    }
  }

  /// Определяем зону по смещению устройства: полноценная база IANA тут
  /// избыточна, а для России хватает соответствия по UTC-офсету.
  Future<String> _deviceTimeZone() async {
    final offset = DateTime.now().timeZoneOffset.inHours;
    const byOffset = {
      2: 'Europe/Kaliningrad',
      3: 'Europe/Moscow',
      4: 'Europe/Samara',
      5: 'Asia/Yekaterinburg',
      6: 'Asia/Omsk',
      7: 'Asia/Krasnoyarsk',
      8: 'Asia/Irkutsk',
      9: 'Asia/Yakutsk',
      10: 'Asia/Vladivostok',
      11: 'Asia/Magadan',
      12: 'Asia/Kamchatka',
    };
    return byOffset[offset] ?? 'UTC';
  }

  // ---------- МГНОВЕННЫЕ ----------

  Future<void> show({
    required int id,
    required String title,
    required String body,
    bool timer = false,
  }) async {
    await init();
    await _plugin.show(
      id,
      title,
      body,
      NotificationDetails(
        android: AndroidNotificationDetails(
          timer ? _channelTimers.id : _channelInstant.id,
          timer ? _channelTimers.name : _channelInstant.name,
          importance: Importance.high,
          priority: Priority.high,
          icon: _icon,
          styleInformation: BigTextStyleInformation(body),
        ),
      ),
    );
  }

  // ---------- ОТЛОЖЕННЫЕ ----------

  /// Запланировать уведомление на конкретное время.
  /// Если время уже прошло — молча пропускаем, а не показываем сразу:
  /// напоминание об углях через час после открытия стола бессмысленно.
  Future<void> scheduleAt({
    required int id,
    required DateTime when,
    required String title,
    required String body,
  }) async {
    await init();
    if (when.isBefore(DateTime.now().add(const Duration(seconds: 30)))) return;

    await _plugin.zonedSchedule(
      id,
      title,
      body,
      tz.TZDateTime.from(when, tz.local),
      NotificationDetails(
        android: AndroidNotificationDetails(
          _channelTimers.id,
          _channelTimers.name,
          importance: Importance.high,
          priority: Priority.high,
          icon: _icon,
          styleInformation: BigTextStyleInformation(body),
        ),
      ),
      androidScheduleMode: AndroidScheduleMode.exactAllowWhileIdle,
      // Обязательный параметр плагина: указанное время трактуется как
      // абсолютное в локальной зоне устройства.
      uiLocalNotificationDateInterpretation:
          UILocalNotificationDateInterpretation.absoluteTime,
    );
  }

  Future<void> cancel(int id) async {
    await init();
    await _plugin.cancel(id);
  }

  Future<void> cancelAll() async {
    await init();
    await _plugin.cancelAll();
  }

  // ---------- РАЗРЕШЕНИЕ ----------

  /// Включены ли уведомления для приложения на уровне системы.
  ///
  /// Начиная с Android 13 разрешение спрашивают отдельно, и отказ ничем не
  /// проявляется: приложение продолжает «показывать» уведомления, а на
  /// экране не появляется ничего. Отличить это от «уведомления не
  /// работают» изнутри приложения нельзя — поэтому спрашиваем систему
  /// напрямую и говорим гостю прямым текстом.
  Future<bool> areEnabled() async {
    await init();
    final android = _plugin
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    if (android == null) return true;
    return await android.areNotificationsEnabled() ?? true;
  }

  /// Повторно запросить разрешение. Если гость уже отказывал, система
  /// диалог не покажет — тогда остаётся открыть настройки приложения.
  Future<bool> requestPermission() async {
    await init();
    final android = _plugin
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    final granted = await android?.requestNotificationsPermission();
    return granted ?? await areEnabled();
  }

  // ---------- ПРОВЕРКА ----------

  /// Пробует показать тестовое уведомление и рассказывает, что вышло.
  ///
  /// Уведомления — та часть приложения, которая ломается совершенно
  /// беззвучно: разрешение не выдано, канал отключён, прошивка вырезала
  /// фоновую работу — во всех случаях приложение «показывает»
  /// уведомление, а на экране не появляется ничего и нигде нет ошибки.
  /// Отсюда и берутся разборы вида «уведомления не приходят» без единой
  /// зацепки. Эта проверка превращает такую тишину в понятный текст.
  Future<String> diagnose() async {
    final lines = <String>[];
    try {
      await init();
    } catch (e) {
      return 'Не удалось подготовить уведомления: $e';
    }

    if (_initError != null) {
      lines.add('При подготовке была ошибка: $_initError');
    }

    final android = _plugin
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    final enabled = await android?.areNotificationsEnabled() ?? true;
    lines.add(enabled
        ? 'Разрешение: выдано'
        : 'Разрешение: НЕ выдано — включите уведомления для приложения '
            'в настройках телефона');

    try {
      final exact = await android?.canScheduleExactNotifications() ?? true;
      lines.add(exact
          ? 'Точные напоминания: разрешены'
          : 'Точные напоминания: запрещены — напоминание за час до брони '
              'может опоздать');
    } catch (_) {}

    try {
      await show(
        id: idFor('diagnose'),
        title: 'Проверка уведомлений',
        body: 'Если вы видите это сообщение в шторке — всё работает.',
      );
      lines.add('Тестовое уведомление отправлено.');
      if (enabled) {
        lines.add('Не видно в шторке? Значит уведомления режет прошивка: '
            'откройте настройки приложения и разрешите уведомления и '
            'автозапуск (на Xiaomi, Huawei и Honor это отдельные пункты).');
      }
    } catch (e) {
      lines.add('Показать уведомление не удалось: $e');
    }

    return lines.join('\n\n');
  }

  /// Стабильный числовой id из строки: у каждого чека свои уведомления,
  /// и при закрытии стола их нужно уметь отменить.
  static int idFor(String key) => key.hashCode & 0x7FFFFFFF;
}
