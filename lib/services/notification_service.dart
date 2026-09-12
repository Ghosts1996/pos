import 'package:flutter/material.dart';
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

  Future<void> init() async {
    if (_ready) return;

    tzdata.initializeTimeZones();
    // Локальная зона устройства — иначе запланированное время уедет.
    tz.setLocalLocation(tz.getLocation(await _deviceTimeZone()));

    await _plugin.initialize(
      const InitializationSettings(
        // Монохромная иконка: системная панель рисует только силуэт, и
        // цветной ic_launcher превращался в серый квадрат.
        android: AndroidInitializationSettings('@drawable/ic_notification'),
      ),
    );

    final android =
        _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    await android?.createNotificationChannel(_channelInstant);
    await android?.createNotificationChannel(_channelTimers);
    await android?.requestNotificationsPermission();
    // Точные будильники нужны, чтобы напоминание об углях не «уехало»
    // на 10 минут из-за экономии батареи.
    await android?.requestExactAlarmsPermission();

    _ready = true;
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
          icon: '@drawable/ic_notification',
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
          icon: '@drawable/ic_notification',
          styleInformation: BigTextStyleInformation(body),
        ),
      ),
      androidScheduleMode: AndroidScheduleMode.exactAllowWhileIdle,
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

  /// Стабильный числовой id из строки: у каждого чека свои уведомления,
  /// и при закрытии стола их нужно уметь отменить.
  static int idFor(String key) => key.hashCode & 0x7FFFFFFF;
}
