import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/theme_controller.dart';

/// Выбор темы кассы: шторка с тремя вариантами и образцом каждой палитры.
/// Тема меняется сразу, открытые экраны и чек остаются на месте.
Future<void> showThemePicker(BuildContext context) => showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => const _ThemePicker(),
    );

class _ThemePicker extends StatelessWidget {
  const _ThemePicker();

  @override
  Widget build(BuildContext context) {
    // Прокрутка — на низком экране и с крупным системным шрифтом.
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 16),
        child: ValueListenableBuilder<AppThemeMode>(
          valueListenable: ThemeController.instance.mode,
          builder: (context, current, _) => Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Тема', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: AppColors.textPrimary)),
              const SizedBox(height: 4),
              Text('Только на этом устройстве — у кухни и зала может быть своя.',
                  style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
              const SizedBox(height: 16),
              for (final m in AppThemeMode.values)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _Option(mode: m, selected: m == current),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Option extends StatelessWidget {
  final AppThemeMode mode;
  final bool selected;
  const _Option({required this.mode, required this.selected});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? AppColors.selection : AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: selected ? AppColors.primary : AppColors.border, width: selected ? 1.6 : 1),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () => ThemeController.instance.set(mode),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              _Swatch(mode: mode),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(mode.title,
                        style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600, color: AppColors.textPrimary)),
                    const SizedBox(height: 2),
                    Text(mode.hint, style: TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Icon(selected ? Icons.check_circle_rounded : Icons.circle_outlined,
                  color: selected ? AppColors.primary : AppColors.border),
            ],
          ),
        ),
      ),
    );
  }
}

/// Образец палитры: фон, карточка, медная кнопка и строка текста.
class _Swatch extends StatelessWidget {
  final AppThemeMode mode;
  const _Swatch({required this.mode});

  @override
  Widget build(BuildContext context) {
    Widget half(AppPalette p) => Container(
          color: p.background,
          padding: const EdgeInsets.all(6),
          child: Container(
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(5),
              border: Border.all(color: p.border),
            ),
            padding: const EdgeInsets.all(5),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Container(height: 3, width: 22, color: p.textPrimary),
                Container(height: 3, width: 14, color: p.textMuted),
                Container(
                  height: 8,
                  decoration: BoxDecoration(color: p.primary, borderRadius: BorderRadius.circular(3)),
                ),
              ],
            ),
          ),
        );
    final child = switch (mode) {
      AppThemeMode.dark => half(AppPalette.dark),
      AppThemeMode.light => half(AppPalette.light),
      AppThemeMode.system => Row(children: [
          Expanded(child: half(AppPalette.light)),
          Expanded(child: half(AppPalette.dark)),
        ]),
    };
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: SizedBox(width: mode == AppThemeMode.system ? 96 : 56, height: 56, child: child),
    );
  }
}
