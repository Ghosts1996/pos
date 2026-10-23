import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/theme/app_colors.dart';
import 'package:hookah_pos/theme/app_theme.dart';
import 'package:hookah_pos/theme/theme_controller.dart';
import 'package:hookah_pos/widgets/theme_picker.dart';
import 'package:shared_preferences/shared_preferences.dart';

double _contrast(Color a, Color b) {
  final la = a.computeLuminance(), lb = b.computeLuminance();
  final hi = la > lb ? la : lb, lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  tearDown(() => AppColors.palette = AppPalette.dark);

  for (final (name, p) in [('тёмная', AppPalette.dark), ('светлая', AppPalette.light)]) {
    group('Палитра $name: текст читается', () {
      test('основной текст на всех поверхностях', () {
        for (final bg in [p.background, p.surface, p.surfaceElevated]) {
          expect(_contrast(p.textPrimary, bg), greaterThanOrEqualTo(7));
        }
      });
      test('приглушённый текст', () {
        for (final bg in [p.background, p.surface, p.surfaceElevated]) {
          expect(_contrast(p.textMuted, bg), greaterThanOrEqualTo(4.5));
        }
      });
      test('надпись на медной кнопке', () {
        expect(_contrast(AppColors.onAccent, p.primary), greaterThanOrEqualTo(p.brightness == Brightness.light ? 4.5 : 4.0));
      });
      test('статусы и деньги заметны на карточке', () {
        for (final c in [p.danger, p.success, p.warning, p.brass, p.tableFree, p.tableOccupied, p.tableReserved]) {
          expect(_contrast(c, p.surface), greaterThanOrEqualTo(3));
        }
      });
    });
  }

  // Светлая тема не «выцветает» на дневном свету: подсказки и неактивное
  // читаются, карточки и границы отделяются от фона.
  test('светлая палитра: неактивный текст, границы и фон различимы', () {
    const p = AppPalette.light;
    for (final bg in [p.background, p.surface, p.surfaceElevated]) {
      expect(_contrast(p.disabledText, bg), greaterThanOrEqualTo(3.4));
      expect(_contrast(p.textMuted, bg), greaterThanOrEqualTo(6.5));
    }
    expect(_contrast(p.border, p.surface), greaterThanOrEqualTo(1.5));
    expect(_contrast(p.background, p.surface), greaterThanOrEqualTo(1.15));
  });

  test('тема собирается по текущей палитре', () {
    AppColors.palette = AppPalette.light;
    final light = AppTheme.current;
    expect(light.brightness, Brightness.light);
    expect(light.scaffoldBackgroundColor, AppPalette.light.background);
    expect(light.colorScheme.onPrimary, AppColors.onAccent);
    AppColors.palette = AppPalette.dark;
    expect(AppTheme.current.brightness, Brightness.dark);
    expect(AppTheme.current.scaffoldBackgroundColor, AppPalette.dark.background);
  });

  testWidgets('выбор темы: помещается на узком телефоне и меняет палитру сразу', (t) async {
    SharedPreferences.setMockInitialValues({});
    await ThemeController.instance.load();
    t.view.physicalSize = const Size(320, 640);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await t.pumpWidget(ValueListenableBuilder<int>(
      valueListenable: ThemeController.instance.revision,
      builder: (context, _, __) => MaterialApp(
        theme: AppTheme.current,
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(child: ElevatedButton(onPressed: () => showThemePicker(context), child: const Text('Тема'))),
          ),
        ),
      ),
    ));
    await t.tap(find.text('Тема'));
    await t.pumpAndSettle();
    expect(find.text('Как на устройстве'), findsOneWidget);
    await t.tap(find.text('Светлая'));
    await t.pumpAndSettle();
    expect(AppColors.isLight, isTrue);
    expect(ThemeController.instance.mode.value, AppThemeMode.light);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('app_theme_mode_v1'), 'light');
    await t.tap(find.text('Тёмная'));
    await t.pumpAndSettle();
    expect(AppColors.isLight, isFalse);
    expect(t.takeException(), isNull);
  });
}
