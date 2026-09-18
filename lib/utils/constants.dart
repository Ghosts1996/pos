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
}
