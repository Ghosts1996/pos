import '../services/app_scope.dart';

/// Общие константы приложения
class AppConstants {
  // Длительность сеанса по умолчанию (в минутах) — 1.5 часа. Используется
  // как компилируемый fallback (значение параметра по умолчанию у
  // FirestoreService.openSession/refillSession) — реальное, настраиваемое
  // владельцем значение см. в [sessionMinutes] ниже.
  static const int defaultSessionMinutes = 90;

  // Сентинель "без ограничений" — вместо nullable plannedEnd (это тронуло
  // бы SessionModel и десятки мест, которые его читают, — таймер на плитке
  // стола, предупреждение об угольках, автозакрытие и т.д. — во ВСЕЙ базе,
  // включая одноарендную версию). Вместо этого "без ограничений" — это
  // самый obычный сеанс с окончанием через 10 лет: реального предела
  // хватает с большим запасом, чтобы отличить его от любой настоящей
  // (пусть даже вручную многократно продлённой) длительности — см.
  // isUnlimitedMinutes/isUnlimitedRemaining ниже.
  static const int unlimitedSessionMinutes = 10 * 365 * 24 * 60;

  // Реальная, настраиваемая владельцем длительность сеанса — см.
  // lib/screens/admin/session_settings_screen.dart и loadSessionDurationSettings()
  // внизу файла. Мутабельное static-поле (как ClientProfile.tiers в
  // client_models.dart) — единственный код, куда пишет FirestoreService,
  // это то, что вызывающий явно передаёт как durationMinutes; сам параметр
  // остаётся с константным значением по умолчанию (так требует Dart).
  static int sessionMinutes = defaultSessionMinutes;

  static bool isUnlimitedMinutes(int minutes) => minutes >= unlimitedSessionMinutes;
  static bool get sessionUnlimited => isUnlimitedMinutes(sessionMinutes);

  /// Для живого таймера (TimerDisplay/table_tile): раз "без ограничений" —
  /// это сеанс на 10 лет вперёд, остаток в любой разумный момент (хоть
  /// через месяц работы заведения) всё ещё измеряется годами — отличить
  /// от настоящей длительности (даже многократно продлённой вручную) можно
  /// с огромным запасом.
  static bool isUnlimitedRemaining(Duration remaining) => remaining.inDays > 365;

  static void resetSessionMinutes() => sessionMinutes = defaultSessionMinutes;

  static String _pluralHours(int n) {
    final n100 = n % 100;
    final n10 = n % 10;
    if (n100 >= 11 && n100 <= 14) return 'часов';
    if (n10 == 1) return 'час';
    if (n10 >= 2 && n10 <= 4) return 'часа';
    return 'часов';
  }

  /// «1.5 часа» / «2 часа» / «45 мин» / «без ограничений» — для кнопки
  /// "Начать сеанс" и диалога перезабивки.
  static String formatSessionDuration(int minutes) {
    if (isUnlimitedMinutes(minutes)) return 'без ограничений';
    if (minutes < 60) return '$minutes мин';
    if (minutes % 60 == 0) {
      final h = minutes ~/ 60;
      return '$h ${_pluralHours(h)}';
    }
    final h = minutes / 60;
    final hStr = h == h.roundToDouble() ? h.toStringAsFixed(0) : h.toStringAsFixed(1);
    return '$hStr часа';
  }

  // Пороговое время (в минутах), после которого стол подсвечивается жёлтым
  static const int warningThresholdMinutes = 15;

  // Быстрые варианты продления таймера (в минутах)
  static const List<int> extendOptions = [15, 30, 60];

  // Роли
  static const String roleAdmin = 'admin';
  static const String roleEmployee = 'employee';

  // Длина PIN-кода входа зависит от роли: у администратора код длиннее —
  // это единственная разница между "быстрым" входом кассира и входом с
  // доступом к настройкам/деньгам заведения, и она не даёт перебрать
  // администраторский код за то же время, что и обычный (на 2 цифры
  // длиннее — в 100 раз больше комбинаций). Заодно длина сама по себе
  // отличает роли при поиске по PIN (см. FirestoreService.findByPin) —
  // 4-значная и 6-значная строки не могут случайно совпасть.
  static const int employeePinLength = 4;
  static const int adminPinLength = 6;
  static int pinLengthForRole(String role) =>
      role == roleAdmin ? adminPinLength : employeePinLength;

  // Валюта, используемая в отображении цен и отчётов
  static const String currencySymbol = '₽';

  // Специализация сотрудника внутри роли 'employee' (роль отвечает за
  // ДЛИНУ PIN/доступ к настройкам, специализация — за то, КОМУ адресуется
  // вызов гостя из-за стола, см. GuestCallTypeX.targetPosition в
  // lib/models/client_models.dart и фильтр в session_alerts_service.dart).
  // 'universal' — значение по умолчанию: и для уже существующих
  // сотрудников (заведённых до этой фичи), и для новых, пока владелец не
  // назначит специализацию явно — такой сотрудник видит и получает ВСЕ
  // вызовы, ровно как было устроено раньше. Так апдейт ничего не ломает
  // сам по себе: без единого действия владельца поведение не меняется.
  static const String positionUniversal = 'universal';
  static const String positionWaiter = 'waiter';
  static const String positionHookahMaster = 'hookah_master';
  static const String positionBartender = 'bartender';
  static const List<String> employeePositions = [
    positionUniversal,
    positionWaiter,
    positionHookahMaster,
    positionBartender,
  ];
  /// Приводит "сырое" значение позиции (из Firestore, где угодно битое —
  /// пустая строка, опечатка, поле от версии до этой фичи) к одному из
  /// известных значений. Неизвестное значение — это НЕ "своя, никому не
  /// известная специализация", а сотрудник, которого молча лишили бы всех
  /// вызовов (см. session_alerts_service.dart/push_service.dart — там
  /// сравнение точное, "!= известное" не значит "== universal"). Поэтому
  /// откат к универсалу, а не к "как есть".
  static String normalizePosition(String? raw) =>
      employeePositions.contains(raw) ? raw! : positionUniversal;

  static String positionLabel(String position) {
    switch (position) {
      case positionWaiter:
        return 'Официант';
      case positionHookahMaster:
        return 'Кальянщик';
      case positionBartender:
        return 'Бармен';
      default:
        return 'Универсал (видит все вызовы)';
    }
  }
}

/// Читает настройку длительности сеанса (settings/sessionDuration,
/// lib/screens/admin/session_settings_screen.dart) и применяет её к
/// AppConstants.sessionMinutes — без неё касса продолжает работать с
/// дефолтом (1.5 часа), пока владелец ничего не настраивал. Вызывается
/// один раз при старте кассы (см. app_bootstrap.dart) — гостевому
/// приложению это не нужно, оно сеансы не открывает.
Future<void> loadSessionDurationSettings() async {
  try {
    final doc = await AppScope.col('settings').doc('sessionDuration').get();
    final data = doc.data();
    if (data == null) return;
    final unlimited = data['unlimited'] as bool? ?? false;
    if (unlimited) {
      AppConstants.sessionMinutes = AppConstants.unlimitedSessionMinutes;
      return;
    }
    final minutes = (data['minutes'] as num?)?.toInt();
    if (minutes != null && minutes > 0) {
      AppConstants.sessionMinutes = minutes;
    }
  } catch (_) {
    // Не критично — касса продолжает работать с дефолтом.
  }
}
