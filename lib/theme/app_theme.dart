import 'package:flutter/material.dart';
import 'app_colors.dart';

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
      color: AppColors.primary.withOpacity(0.35),
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
              return AppColors.primaryPressed.withOpacity(0.6);
            }
            if (states.contains(WidgetState.hovered)) {
              return Colors.white.withOpacity(0.04);
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
}