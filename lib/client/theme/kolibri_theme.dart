import 'package:flutter/material.dart';

/// Палитра клиентского приложения «Colibri Lounge».
///
/// Она намеренно отличается от POS («Midnight Blue»): гость видит тёплый
/// изумрудно-золотой лаунж, а не рабочий интерфейс кассы. Общего кода
/// с AppColors нет, чтобы правки в POS-теме не «поехали» у гостей.
class KolibriColors {
  KolibriColors._();

  static const background = Color(0xFF07100D);
  static const surface = Color(0xFF0E1A16);
  static const surfaceElevated = Color(0xFF14241E);
  static const border = Color(0xFF1F3830);

  /// Изумруд — основной акцент (оперение колибри).
  static const primary = Color(0xFF12B981);
  static const primaryPressed = Color(0xFF0E9A6B);

  /// Золото — бонусы, уровни лояльности, «премиальные» акценты.
  static const gold = Color(0xFFE0B354);

  /// Фуксия — живой акцент для кнопок «позвать кальянщика».
  static const accent = Color(0xFFE0559B);

  static const textPrimary = Color(0xFFF2F7F4);
  static const textMuted = Color(0xFF8FA79C);

  static const success = Color(0xFF22C55E);
  static const warning = Color(0xFFF59E0B);
  static const danger = Color(0xFFEF4444);

  // ---- Уровни программы лояльности ----
  static const tierBronze = Color(0xFFCD7F32);
  static const tierSilver = Color(0xFFB4C4CC);
  static const tierGold = gold;
  static const tierPlatinum = Color(0xFFAEEFE6);
  static const tierDiamond = Color(0xFFB388FF);

  /// Цвет карточки/акцента под текущий уровень гостя (см. ClientProfile.tier).
  static Color tierColor(String tier) {
    switch (tier) {
      case 'Алмаз':
        return tierDiamond;
      case 'Платина':
        return tierPlatinum;
      case 'Золото':
        return tierGold;
      case 'Серебро':
        return tierSilver;
      default:
        return tierBronze;
    }
  }
}

class KolibriTheme {
  KolibriTheme._();

  static ThemeData get dark {
    final base = ThemeData.dark(useMaterial3: true);
    return base.copyWith(
      scaffoldBackgroundColor: KolibriColors.background,
      colorScheme: base.colorScheme.copyWith(
        primary: KolibriColors.primary,
        secondary: KolibriColors.gold,
        surface: KolibriColors.surface,
        error: KolibriColors.danger,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: KolibriColors.background,
        foregroundColor: KolibriColors.textPrimary,
        elevation: 0,
        centerTitle: false,
      ),
      cardTheme: CardThemeData(
        color: KolibriColors.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(18),
          side: const BorderSide(color: KolibriColors.border),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: KolibriColors.primary,
          foregroundColor: Colors.white,
          minimumSize: const Size(0, 52),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: KolibriColors.textPrimary,
          side: const BorderSide(color: KolibriColors.border),
          minimumSize: const Size(0, 48),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: KolibriColors.surface,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: KolibriColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: KolibriColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: KolibriColors.primary),
        ),
        labelStyle: const TextStyle(color: KolibriColors.textMuted),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: KolibriColors.surface,
        indicatorColor: KolibriColors.primary.withValues(alpha: 0.18),
        labelTextStyle: WidgetStateProperty.all(
          const TextStyle(fontSize: 12, color: KolibriColors.textMuted),
        ),
      ),
      dividerColor: KolibriColors.border,
      textTheme: base.textTheme.apply(
        bodyColor: KolibriColors.textPrimary,
        displayColor: KolibriColors.textPrimary,
      ),
    );
  }
}
