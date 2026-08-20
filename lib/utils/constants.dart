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

  // Валюта, используемая в отображении цен и отчётов
  static const String currencySymbol = '₽';
}
