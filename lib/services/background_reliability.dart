import 'package:flutter/foundation.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

/// Работа кассы в фоне без ограничений батареи.
///
/// Фоновая служба (HallWatchService) не даёт Android выгрузить кассу, но
/// режим экономии (Doze) через несколько минут после выключения экрана
/// всё равно обрывает ей сеть — «Готово» и вызовы гостей сначала приходят,
/// потом перестают, и часы молчат. Особенно на Huawei, Honor и Xiaomi.
/// Исключение из оптимизации батареи это снимает. Включает его владелец
/// телефона на системном экране — мы только открываем его.
class BackgroundReliability {
  BackgroundReliability._();

  static bool get supported => !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  /// true — система может усыплять кассу в фоне.
  static Future<bool> isRestricted() async {
    if (!supported) return false;
    try {
      return !await FlutterForegroundTask.isIgnoringBatteryOptimizations;
    } catch (_) {
      return false;
    }
  }

  /// Системный экран «Без ограничений» для батареи.
  static Future<void> openSettings() async {
    if (!supported) return;
    try {
      await FlutterForegroundTask.openIgnoreBatteryOptimizationSettings();
    } catch (_) {}
  }
}
