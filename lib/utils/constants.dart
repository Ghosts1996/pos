import '../services/app_scope.dart';
import '../services/venue_service.dart';

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

  /// «1,5 часа» / «2 часа» / «45 мин» / «1 ч 40 мин» / «без ограничений» —
  /// для экрана стола и диалога перезабивки. Десятичная запятая, как
  /// принято по-русски; некруглые значения — часами и минутами, а не
  /// «1.7 часа».
  static String formatSessionDuration(int minutes) {
    if (isUnlimitedMinutes(minutes)) return 'без ограничений';
    if (minutes < 60) return '$minutes мин';
    final h = minutes ~/ 60;
    if (minutes % 60 == 0) return '$h ${_pluralHours(h)}';
    if (minutes % 60 == 30) return '$h,5 часа';
    return '$h ч ${minutes % 60} мин';
  }

  // Пороговое время (в минутах), после которого стол подсвечивается жёлтым
  static const int warningThresholdMinutes = 15;

  // Быстрые варианты продления таймера (в минутах)
  /// «Время» на экране стола: на сколько минут добавить или убавить.
  static const List<int> extendOptions = [5, 10, 30];

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

  // Специализация сотрудника: роль отвечает за длину PIN и доступ к
  // настройкам, специализация — за то, кому адресован вызов гостя
  // (GuestCallTypeX.targetPosition, session_alerts_service.dart).
  // 'universal' по умолчанию — такой сотрудник получает все вызовы.
  static const String positionUniversal = 'universal';
  static const String positionWaiter = 'waiter';
  static const String positionHookahMaster = 'hookah_master';
  static const String positionBartender = 'bartender';
  // Кухня и встреча гостей: вызовов из-за стола не получают (ни один
  // GuestCallType на них не адресован), но стоят в смене — им тоже можно
  // оставить чаевые, и они входят в «чаевые всей смене».
  static const String positionCook = 'cook';
  static const String positionHost = 'host';
  static const List<String> employeePositions = [
    positionUniversal,
    positionWaiter,
    positionHookahMaster,
    positionBartender,
    positionCook,
    positionHost,
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

  /// Кальянные обязанности — кнопка «Перезабивка» на экране стола и
  /// напоминания про угли. Кальянщику — всегда (кальяны бывают и в
  /// ресторане); универсалу и администратору — если заведение кальянная.
  /// Официант, бармен, повар и хостес их не видят и не получают.
  static bool handlesHookah({
    required String position,
    String role = roleEmployee,
    required bool hookahVenue,
  }) {
    final p = normalizePosition(position);
    if (p == positionHookahMaster) return true;
    return hookahVenue && (p == positionUniversal || role == roleAdmin);
  }

  /// Кнопка «Перезабивка» на экране стола: кальянщику и универсалу —
  /// всегда (кальяны подают и в баре, и в кафе, а универсал подменяет
  /// кальянщика), администратору — в кальянной. Напоминания про угли —
  /// отдельно, см. [handlesHookah].
  static bool canRefillHookah({
    required String position,
    String role = roleEmployee,
    required bool hookahVenue,
  }) {
    final p = normalizePosition(position);
    if (p == positionHookahMaster || p == positionUniversal) return true;
    return hookahVenue && role == roleAdmin;
  }

  static String positionLabel(String position) {
    switch (position) {
      case positionWaiter:
        return 'Официант';
      case positionHookahMaster:
        return 'Кальянщик';
      case positionBartender:
        return 'Бармен';
      case positionCook:
        return 'Повар';
      case positionHost:
        return 'Хостес / администратор зала';
      default:
        return 'Универсал (видит все вызовы)';
    }
  }

  /// Короткое название — для чипов выбора и списка сотрудников.
  static String positionShortLabel(String position) {
    switch (position) {
      case positionHost:
        return 'Хостес';
      case positionUniversal:
        return 'Универсал';
      default:
        return positionLabel(position);
    }
  }

  /// Что эта специализация даёт — подсказка под выбором в карточке
  /// сотрудника. [hookahVenue] — заведение кальянная.
  static String positionHint(String position, {required bool hookahVenue}) {
    switch (normalizePosition(position)) {
      case positionWaiter:
        return 'Получает вызовы официанта, просьбы принести счёт и заказы блюд и напитков из приложения гостя.';
      case positionHookahMaster:
        return 'Получает вызовы на угли и кальян, заказы кальянов из приложения гостя, видит «Перезабивку» и напоминания про угли.';
      case positionBartender:
        return 'Получает вызовы к бару, а в баре — и заказы из приложения гостя.';
      case positionCook:
        return 'Видит экран «Кухня и бар»: что готовить по всем столам. Вызовов из-за стола не получает, но гость может оставить ему чаевые.';
      case positionHost:
        return 'Встречает гостей и ведёт брони. Вызовов из-за стола не получает, чаевые — может.';
      default:
        return hookahVenue
            ? 'Получает все вызовы гостей, видит «Перезабивку» и напоминания про угли.'
            : 'Получает все вызовы гостей.';
    }
  }

  /// Кому уходит заказ гостя из приложения: кальян — кальянщику, блюда и
  /// напитки — официанту (в баре — бармену). Универсал видит любой заказ.
  static String guestOrderTarget({required bool hookahItem, required bool hookahVenue, required bool bar}) {
    if (hookahItem && hookahVenue) return positionHookahMaster;
    return bar ? positionBartender : positionWaiter;
  }

  /// Адресат заказа для гостя: «официант», «кальянщик», «бармен».
  static String orderTargetWord(String position) {
    switch (position) {
      case positionHookahMaster:
        return 'кальянщик';
      case positionBartender:
        return 'бармен';
      default:
        return 'официант';
    }
  }

  /// Дательный падеж: «передан кальянщику».
  static String orderTargetDat(String position) {
    switch (position) {
      case positionHookahMaster:
        return 'кальянщику';
      case positionBartender:
        return 'бармену';
      default:
        return 'официанту';
    }
  }

  /// Подпись должности для гостя (в выборе, кому оставить чаевые).
  /// У универсала подписи нет — гость видит просто имя.
  static String positionGuestLabel(String position) {
    switch (position) {
      case positionWaiter:
        return 'Официант';
      case positionHookahMaster:
        return 'Кальянщик';
      case positionBartender:
        return 'Бармен';
      case positionCook:
        return 'Повар';
      case positionHost:
        return 'Хостес';
      default:
        return '';
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
    if (data == null) {
      // Владелец длительность не настраивал. Ресторану, кафе и бару таймер
      // на полтора часа не нужен — стол занят, пока его не закроют.
      final venue = await VenueService.instance.load();
      if (!venue.terms.isHookah) {
        AppConstants.sessionMinutes = AppConstants.unlimitedSessionMinutes;
      }
      return;
    }
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
