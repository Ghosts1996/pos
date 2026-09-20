/// Общие константы приложения
class AppConstants {
  // Длительность сеанса по умолчанию (в минутах) — 1.5 часа
  static const int defaultSessionMinutes = 90;

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
