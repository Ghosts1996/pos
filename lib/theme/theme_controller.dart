import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app_colors.dart';

/// Какую тему показывать кассе.
enum AppThemeMode {
  /// «Графит и медь» — для вечернего зала (по умолчанию).
  dark('Тёмная', 'Графит и медь — для вечернего зала'),

  /// «Слоновая кость и медь» — для дня и светлых залов.
  light('Светлая', 'Слоновая кость и медь — для дня и светлых залов'),

  /// Как в настройках устройства: днём светлая, вечером тёмная, если так
  /// настроен телефон или планшет.
  system('Как на устройстве', 'Следует за настройкой телефона или планшета');

  final String title;
  final String hint;
  const AppThemeMode(this.title, this.hint);
}

/// Выбор темы на этом устройстве: хранится локально (у каждого планшета
/// свой — кухне может быть удобнее светлая, залу тёмная) и применяется
/// сразу, без перезапуска и без потери открытого чека.
class ThemeController with WidgetsBindingObserver {
  ThemeController._();
  static final ThemeController instance = ThemeController._();

  static const _key = 'app_theme_mode_v1';

  final ValueNotifier<AppThemeMode> mode = ValueNotifier(AppThemeMode.dark);

  /// Меняется при каждой смене палитры — по нему перестраивается MaterialApp.
  final ValueNotifier<int> revision = ValueNotifier(0);

  bool _observing = false;

  /// До runApp: прочитать выбор и поставить палитру.
  Future<void> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString(_key);
      mode.value = AppThemeMode.values.firstWhere((m) => m.name == saved, orElse: () => AppThemeMode.dark);
    } catch (_) {}
    _apply(rebuild: false);
    if (!_observing) {
      WidgetsBinding.instance.addObserver(this);
      _observing = true;
    }
  }

  Future<void> set(AppThemeMode m) async {
    if (mode.value == m) return;
    mode.value = m;
    _apply();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, m.name);
    } catch (_) {}
  }

  @override
  void didChangePlatformBrightness() {
    if (mode.value == AppThemeMode.system) _apply();
  }

  void _apply({bool rebuild = true}) {
    final light = switch (mode.value) {
      AppThemeMode.light => true,
      AppThemeMode.dark => false,
      AppThemeMode.system =>
        WidgetsBinding.instance.platformDispatcher.platformBrightness == Brightness.light,
    };
    final next = light ? AppPalette.light : AppPalette.dark;
    if (identical(next, AppColors.palette)) return;
    AppColors.palette = next;
    revision.value++;
    if (rebuild) _rebuildAll();
  }

  /// Цвета берутся из AppColors прямо в build, поэтому после смены палитры
  /// перестраиваем всё дерево. Состояние экранов (открытый чек, введённый
  /// текст, позиция прокрутки) при этом сохраняется.
  static void _rebuildAll() {
    void mark(Element e) {
      e.markNeedsBuild();
      e.visitChildren(mark);
    }

    WidgetsBinding.instance.rootElement?.visitChildren(mark);
  }
}
