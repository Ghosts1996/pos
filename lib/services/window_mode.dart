import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../utils/adaptive.dart';

/// Касса на Windows: на весь экран без рамки (как у кассовых моноблоков)
/// или обычным окном. По умолчанию — на весь экран; выбор запоминается.
/// Переключение — F11 или пункт «Во весь экран» в меню ☰.
///
/// Само окно меняет Windows-обвязка (канал zalpos/window, см.
/// .github/scripts/patch-windows-runner.js). В старой сборке без неё
/// вызовы просто ничего не делают.
class WindowMode {
  WindowMode._();

  static const _channel = MethodChannel('zalpos/window');
  static const _pref = 'win_fullscreen';

  static final ValueNotifier<bool> fullscreen = ValueNotifier(false);
  static bool _ready = false;

  static bool get supported => isWindowsApp;

  static Future<void> init() async {
    if (!supported || _ready) return;
    _ready = true;
    var on = true;
    try {
      on = (await SharedPreferences.getInstance()).getBool(_pref) ?? true;
    } catch (_) {}
    await set(on, save: false);
    HardwareKeyboard.instance.addHandler(_onKey);
  }

  static Future<void> set(bool on, {bool save = true}) async {
    if (!supported) return;
    try {
      await _channel.invokeMethod<void>('setFullscreen', on);
      fullscreen.value = on;
    } catch (_) {
      return;
    }
    if (!save) return;
    try {
      await (await SharedPreferences.getInstance()).setBool(_pref, on);
    } catch (_) {}
  }

  static Future<void> toggle() => set(!fullscreen.value);

  static bool _onKey(KeyEvent e) {
    if (e is KeyDownEvent && e.logicalKey == LogicalKeyboardKey.f11) {
      toggle();
      return true;
    }
    return false;
  }
}
