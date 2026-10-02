import 'package:flutter/foundation.dart';

/// Гость сети меняет заведение, не перезапуская приложение: профиль («Другое
/// заведение сети») и бронирование («Забронировать в другом») просят об
/// этом, а точка входа сети (kolibri_main.dart) снова показывает выбор
/// заведения и открывает приложение на нужной вкладке.
class ChainVenueSwitch {
  ChainVenueSwitch._();

  /// Вкладка, на которой открыть приложение после выбора; null — запроса
  /// нет.
  static final ValueNotifier<int?> request = ValueNotifier<int?>(null);

  /// Вкладки оболочки гостя (KolibriShell).
  static const homeTab = 0;
  static const bookingTab = 2;

  static void ask({int openTab = homeTab}) {
    request.value = null;
    request.value = openTab;
  }

  /// Демо приложения гостя: «Другой код демо» — снова экран входа в демо.
  static final ValueNotifier<int> leaveDemo = ValueNotifier<int>(0);
}
