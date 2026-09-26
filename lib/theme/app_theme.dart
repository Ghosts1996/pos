import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'app_colors.dart';
import '../models/tenant_models.dart';

/// Радиусы скруглений — единая шкала на всё приложение.
class AppRadius {
  AppRadius._();
  static const double sm = 8;
  static const double md = 12; // карточки, поля ввода
  static const double lg = 16; // основные кнопки, панель чека
  static const double pill = 999;
}

/// Тени — используются точечно, только для primary-действий,
/// чтобы не "зашумлять" тёмный интерфейс.
class AppShadows {
  AppShadows._();

  static List<BoxShadow> primaryButton = [
    BoxShadow(
      color: AppColors.primary.withValues(alpha: 0.35),
      blurRadius: 20,
      offset: const Offset(0, 8),
    ),
  ];

  static List<BoxShadow> card = [
    const BoxShadow(
      color: Color(0x66000000),
      blurRadius: 12,
      offset: Offset(0, 4),
    ),
  ];
}

/// Отступы и высоты тач-таргетов — эргономика для 12-часовой смены.
class AppSpacing {
  AppSpacing._();
  static const double screenPadding = 20;
  static const double gridGap = 14;

  /// Минимальная высота любого интерактивного элемента (кнопка, плитка).
  static const double minTouchTarget = 56;
  static const double primaryButtonHeight = 64;
}

class AppTheme {
  AppTheme._();

  static ThemeData get dark {
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: AppColors.background,
      colorScheme: const ColorScheme.dark(
        surface: AppColors.surface,
        primary: AppColors.primary,
        secondary: AppColors.selection,
        error: AppColors.danger,
        onSurface: AppColors.textPrimary,
        onPrimary: AppColors.textPrimary,
        outline: AppColors.border,
      ),
      fontFamily: 'Inter',
    );

    return base.copyWith(
      textTheme: base.textTheme.apply(
        bodyColor: AppColors.textPrimary,
        displayColor: AppColors.textPrimary,
      ).copyWith(
        // Суммы в чеке, цена блюда — крупно и жирно.
        headlineSmall: const TextStyle(
          color: AppColors.textPrimary,
          fontWeight: FontWeight.w700,
          fontSize: 22,
        ),
        titleMedium: const TextStyle(
          color: AppColors.textPrimary,
          fontWeight: FontWeight.w600,
          fontSize: 16,
        ),
        bodyMedium: const TextStyle(
          color: AppColors.textPrimary,
          fontSize: 14,
        ),
        // Модификаторы, вес, таймстемпы.
        bodySmall: const TextStyle(
          color: AppColors.textMuted,
          fontSize: 12,
        ),
        labelLarge: const TextStyle(
          color: AppColors.textMuted,
          fontSize: 13,
          fontWeight: FontWeight.w500,
        ),
      ),

      appBarTheme: const AppBarTheme(
        backgroundColor: AppColors.background,
        surfaceTintColor: Colors.transparent,
        foregroundColor: AppColors.textPrimary,
        elevation: 0,
        centerTitle: false,
      ),

      cardTheme: CardThemeData(
        color: AppColors.surface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          side: const BorderSide(color: AppColors.border, width: 1),
        ),
      ),

      dividerTheme: const DividerThemeData(
        color: AppColors.border,
        thickness: 1,
        space: 1,
      ),

      // Primary action: "Оплатить", "Отправить на кухню".
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.primary,
          disabledBackgroundColor: AppColors.disabled,
          disabledForegroundColor: AppColors.disabledText,
          foregroundColor: AppColors.textPrimary,
          minimumSize: const Size.fromHeight(AppSpacing.primaryButtonHeight),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.lg),
          ),
          textStyle: const TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.w700,
          ),
          elevation: 0,
        ).copyWith(
          // Явное pressed-состояние — на 12–15% темнее primary,
          // чтобы палец получал моментальный визуальный отклик.
          overlayColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.pressed)) {
              return AppColors.primaryPressed.withValues(alpha: 0.6);
            }
            if (states.contains(WidgetState.hovered)) {
              return Colors.white.withValues(alpha: 0.04);
            }
            return null;
          }),
        ),
      ),

      // Вторичные / отмена действий поверх surface.
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.textPrimary,
          side: const BorderSide(color: AppColors.border, width: 1.2),
          minimumSize: const Size.fromHeight(AppSpacing.minTouchTarget),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.md),
          ),
        ),
      ),

      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: AppColors.textMuted,
          minimumSize: const Size.fromHeight(AppSpacing.minTouchTarget),
        ),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        hintStyle: const TextStyle(color: AppColors.textMuted),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          borderSide: const BorderSide(color: AppColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          borderSide: const BorderSide(color: AppColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          borderSide: const BorderSide(color: AppColors.primary, width: 1.6),
        ),
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: AppColors.surfaceElevated,
        contentTextStyle: const TextStyle(color: AppColors.textPrimary),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
        ),
        behavior: SnackBarBehavior.floating,
      ),

      dialogTheme: DialogThemeData(
        backgroundColor: AppColors.surfaceElevated,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.lg),
        ),
      ),

      navigationDrawerTheme: const NavigationDrawerThemeData(
        backgroundColor: AppColors.background,
      ),

      iconTheme: const IconThemeData(color: AppColors.textPrimary),

      splashFactory: InkRipple.splashFactory,
    );
  }

  /// Тема заведения в SaaS-режиме — накладывает фирменную палитру поверх
  /// базовой тёмной темы (см. [dark]): основной и вторичный цвет, цвет
  /// кнопок, фон и цвет текста.
  ///
  /// Фон и текст владелец задаёт вслепую, в консоли, а не глядя на реальный
  /// экран POS в тёмном зале — случайно перепутанная или слишком похожая
  /// пара (например, тёмно-синий текст на чёрном фоне) сделает интерфейс
  /// нечитаемым посреди смены. Поэтому пара фон/текст проверяется на
  /// контраст (формула WCAG, порог 3:1 — как для крупного текста: POS и так
  /// держит крупные жирные шрифты, это не сплошной убористый текст, для
  /// которого WCAG требует 4.5:1) — и при недостаточном контрасте ЭТА ПАРА
  /// откатывается на проверенную (AppColors), а не применяется как есть.
  /// Остальные цвета (primary/secondary/button) таким образом не режутся:
  /// они не несут текста поверх себя тем же способом, что фон.
  static ThemeData branded(BrandingConfig branding) {
    final primary = _parseHexColor(branding.primaryColor) ?? AppColors.primary;
    final secondary = _parseHexColor(branding.secondaryColor) ?? AppColors.selection;
    final button = _parseHexColor(branding.buttonColor) ?? primary;

    var background = _parseHexColor(branding.backgroundColor) ?? AppColors.background;
    var text = _parseHexColor(branding.textColor) ?? AppColors.textPrimary;
    // Светлый фон (пресет «Песочный светлый» в консоли) касса тоже не
    // берёт: карточки, диалоги и поля ввода здесь остаются тёмными из базы
    // [dark], и тёмный текст бренда на них читался с контрастом ~1.1:1.
    // Касса и так задумана только тёмной (см. main.dart) — светлая пара
    // фон/текст остаётся гостевому приложению, а касса берёт у бренда
    // только акценты (primary/secondary/button).
    if (_contrastRatio(background, text) < 3.0 || _relativeLuminance(background) > 0.4) {
      background = AppColors.background;
      text = AppColors.textPrimary;
    }

    final base = dark;
    return base.copyWith(
      scaffoldBackgroundColor: background,
      colorScheme: base.colorScheme.copyWith(
        primary: primary,
        secondary: secondary,
        onSurface: text,
      ),
      textTheme: base.textTheme.apply(bodyColor: text, displayColor: text),
      appBarTheme: base.appBarTheme.copyWith(
        backgroundColor: background,
        foregroundColor: text,
      ),
      iconTheme: base.iconTheme.copyWith(color: text),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: base.elevatedButtonTheme.style?.copyWith(
          backgroundColor: WidgetStatePropertyAll(button),
        ),
      ),
      focusColor: primary,
      inputDecorationTheme: base.inputDecorationTheme.copyWith(
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          borderSide: BorderSide(color: primary, width: 1.6),
        ),
      ),
    );
  }

  static Color? _parseHexColor(String hex) {
    var h = hex.trim().replaceFirst('#', '');
    if (h.length == 6) h = 'FF$h';
    if (h.length != 8) return null;
    final value = int.tryParse(h, radix: 16);
    return value == null ? null : Color(value);
  }

  /// Контраст по формуле WCAG 2 — то же самое, что консоль владельца
  /// (saas/console/console.js, contrastRatio()) считает в браузере ДО
  /// сохранения цвета, чтобы предупредить владельца сразу. Здесь —
  /// повторная проверка на стороне приложения: консоль можно обойти
  /// (прямая запись в Firestore), а нечитаемый экран на планшете в зале
  /// нельзя показывать ни при каких обстоятельствах.
  static double _contrastRatio(Color a, Color b) {
    final la = _relativeLuminance(a) + 0.05;
    final lb = _relativeLuminance(b) + 0.05;
    return la > lb ? la / lb : lb / la;
  }

  static double _relativeLuminance(Color c) {
    return 0.2126 * _srgbChannel(c.r) + 0.7152 * _srgbChannel(c.g) + 0.0722 * _srgbChannel(c.b);
  }

  static double _srgbChannel(double c) {
    return c <= 0.03928 ? c / 12.92 : math.pow((c + 0.055) / 1.055, 2.4).toDouble();
  }
}