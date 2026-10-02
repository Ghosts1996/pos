import 'dart:io';

import 'package:flutter/foundation.dart';

import '../build_info.dart';

/// Журнал запуска кассы на Windows: %LOCALAPPDATA%\ZalPOS\startup.log.
///
/// Касса на Windows работает поверх нативного Firebase C++ SDK, и его сбой
/// закрывает окно без сообщения и без следа в Dart. Шаги запуска пишутся в
/// файл синхронно, ещё до опасного вызова, — последняя строка показывает,
/// на чём касса остановилась. Ошибки Dart тоже попадают сюда. Файл
/// небольшой: при старте больше [_maxBytes] — начинаем заново.
///
/// На других платформах ничего не делает. Персональных данных в журнал не
/// пишем — только названия шагов и тексты ошибок.
class StartupLog {
  StartupLog._();

  static const _maxBytes = 256 * 1024;
  static File? _file;
  static bool _tried = false;

  static bool get _enabled => !kIsWeb && Platform.isWindows;

  /// Путь к журналу (для подсказки владельцу) или null, если журнала нет.
  static String? get path => _file?.path;

  static File? _open() {
    if (_tried) return _file;
    _tried = true;
    if (!_enabled) return null;
    try {
      final base = Platform.environment['LOCALAPPDATA'] ?? Platform.environment['APPDATA'];
      if (base == null || base.isEmpty) return null;
      final dir = Directory('$base\\ZalPOS');
      dir.createSync(recursive: true);
      final f = File('${dir.path}\\startup.log');
      if (f.existsSync() && f.lengthSync() > _maxBytes) f.deleteSync();
      _file = f;
    } catch (_) {
      _file = null;
    }
    return _file;
  }

  /// Записать шаг. Синхронно и с flush: если следующий вызов уронит
  /// процесс, строка уже на диске.
  static void step(String message) {
    final f = _open();
    if (f == null) return;
    try {
      f.writeAsStringSync('${DateTime.now().toIso8601String()} [$pid] $message\n',
          mode: FileMode.append, flush: true);
    } catch (_) {}
  }

  /// Ошибки Dart (и необработанные асинхронные) — в журнал, не теряя
  /// прежних обработчиков.
  static void installErrorHooks() {
    if (!_enabled) return;
    step('--- запуск, сборка $kBuildNumber, ${Platform.operatingSystemVersion}');
    final prevFlutter = FlutterError.onError;
    FlutterError.onError = (details) {
      step('FlutterError: ${details.exceptionAsString()}\n${details.stack ?? ''}');
      prevFlutter?.call(details);
    };
    final prevPlatform = PlatformDispatcher.instance.onError;
    PlatformDispatcher.instance.onError = (error, stack) {
      step('Необработанная ошибка: $error\n$stack');
      return prevPlatform?.call(error, stack) ?? false;
    };
  }
}
