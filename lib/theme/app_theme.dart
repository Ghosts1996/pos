import 'package:flutter/material.dart';
import 'app_colors.dart';
import 'boxed_input_border.dart';

/// Шрифты (assets/fonts, OFL): Onest — интерфейс и суммы,
/// Cormorant Garamond — крупные заголовки (экран входа, PIN, названия
/// разделов). Суммы и номера столов — только гротеском: у антиквы «1»
/// похожа на римскую «I», а кассир читает цифры на бегу.
class AppFonts {
  AppFonts._();
  static const String sans = 'Onest';
  static const String serif = 'CormorantGaramond';

  /// Крупный заголовок антиквой.
  static TextStyle display(double size, {Color color = AppColors.textPrimary, FontStyle? style}) => TextStyle(
        fontFamily: serif,
        fontSize: size,
        fontWeight: FontWeight.w600,
        fontStyle: style,
        height: 1.08,
        letterSpacing: -0.2,
        color: color,
        fontFeatures: const [FontFeature.liningFigures()],
      );

  /// Подпись капителью над блоком («ИТОГО», «ЗАЛ»).
  static const TextStyle overline = TextStyle(
    fontFamily: sans,
    fontSize: 11,
    fontWeight: FontWeight.w600,
    letterSpacing: 1.8,
    color: AppColors.textMuted,
  );

  /// Цифры одной ширины — суммы в чеке не «пляшут» при пересчёте.
  static const List<FontFeature> tabular = [FontFeature.tabularFigures()];
}

/// Радиусы скруглений — единая шкала на всё приложение.
class AppRadius {
  AppRadius._();
  static const double sm = 8;
  static const double md = 12; // карточки, поля ввода
  static const double lg = 14; // основные кнопки, панель чека
  static const double pill = 999;
}

/// Тени — почти без них: глубину дают тон поверхности и тонкая линия.
class AppShadows {
  AppShadows._();

  static List<BoxShadow> primaryButton = [
    const BoxShadow(
      color: Color(0x40000000),
      blurRadius: 10,
      offset: Offset(0, 3),
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
        // Без этого ColorScheme.dark берёт контейнером саму медь, и
        // карточки/шапки на primaryContainer заливались оранжевым.
        primaryContainer: AppColors.selectionStrong,
        onPrimaryContainer: AppColors.textPrimary,
        tertiaryContainer: AppColors.surfaceElevated,
        onTertiaryContainer: AppColors.brass,
        secondary: AppColors.selection,
        // Без этих трёх ColorScheme.dark подставляет чёрный текст на
        // «вторичном» фоне: выбранный ChoiceChip (вкладки X-отчёта, фильтры)
        // и FilledButton.tonal («Подтвердить» в бронях) выглядели тусклыми,
        // будто недоступными.
        onSecondary: AppColors.textPrimary,
        secondaryContainer: AppColors.selectionStrong,
        onSecondaryContainer: AppColors.textPrimary,
        error: AppColors.danger,
        onSurface: AppColors.textPrimary,
        onPrimary: AppColors.textPrimary,
        tertiary: AppColors.brass,
        outline: AppColors.border,
        outlineVariant: AppColors.border,
        surfaceContainerHighest: AppColors.surfaceElevated,
        surfaceContainerHigh: AppColors.surfaceElevated,
        surfaceContainer: AppColors.surface,
        surfaceContainerLow: AppColors.surface,
        surfaceContainerLowest: AppColors.background,
        onSurfaceVariant: AppColors.textMuted,
      ),
      fontFamily: AppFonts.sans,
    );

    return base.copyWith(
      textTheme: base.textTheme.apply(
        bodyColor: AppColors.textPrimary,
        displayColor: AppColors.textPrimary,
      ).copyWith(
        // Крупные заголовки — антиквой (экран входа, PIN, пустые состояния).
        displayLarge: AppFonts.display(52),
        displayMedium: AppFonts.display(44),
        displaySmall: AppFonts.display(36),
        headlineLarge: AppFonts.display(32),
        headlineMedium: AppFonts.display(28),
        // Суммы в чеке, цена блюда — крупно, гротеском, цифры одной ширины.
        headlineSmall: const TextStyle(
          fontFamily: AppFonts.sans,
          color: AppColors.textPrimary,
          fontWeight: FontWeight.w700,
          fontSize: 22,
          letterSpacing: -0.3,
          fontFeatures: AppFonts.tabular,
        ),
        titleLarge: const TextStyle(
          fontFamily: AppFonts.sans,
          color: AppColors.textPrimary,
          fontWeight: FontWeight.w600,
          fontSize: 20,
          letterSpacing: -0.2,
        ),
        titleMedium: const TextStyle(
          fontFamily: AppFonts.sans,
          color: AppColors.textPrimary,
          fontWeight: FontWeight.w600,
          fontSize: 16,
        ),
        bodyMedium: const TextStyle(
          fontFamily: AppFonts.sans,
          color: AppColors.textPrimary,
          fontSize: 14,
        ),
        // Модификаторы, вес, таймстемпы.
        bodySmall: const TextStyle(
          fontFamily: AppFonts.sans,
          color: AppColors.textMuted,
          fontSize: 12,
        ),
        labelLarge: const TextStyle(
          fontFamily: AppFonts.sans,
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
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          fontFamily: AppFonts.sans,
          color: AppColors.textPrimary,
          fontSize: 19,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.2,
        ),
        shape: Border(bottom: BorderSide(color: AppColors.border, width: 1)),
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
            fontFamily: AppFonts.sans,
            fontSize: 16,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.1,
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
      //
      // Минимальная ширина — обычная (64), а не бесконечная, как было
      // (Size.fromHeight): кнопка с бесконечной минимальной шириной внутри
      // Row не может разложиться и в релизной сборке просто не рисуется
      // (так пропадали кнопки быстрых сумм на экране оплаты), в Wrap
      // занимает целую строку, а в диалоге растягивается во всю ширину.
      // Где вторичная кнопка должна быть во всю ширину, её растягивает
      // родитель (Column со stretch или SizedBox(width: double.infinity)).
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.textPrimary,
          side: const BorderSide(color: AppColors.border, width: 1.2),
          minimumSize: const Size(64, AppSpacing.minTouchTarget),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.md),
          ),
        ),
      ),

      // FilledButton — то же основное действие, что ElevatedButton, но
      // обычной высоты (диалоги, формы).
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AppColors.primary,
          foregroundColor: AppColors.textPrimary,
          disabledBackgroundColor: AppColors.disabled,
          disabledForegroundColor: AppColors.disabledText,
          minimumSize: const Size(64, 48),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.md)),
          textStyle: const TextStyle(fontFamily: AppFonts.sans, fontSize: 15, fontWeight: FontWeight.w600),
        ),
      ),

      // Та же причина, что у outlinedButtonTheme: «Отмена» в диалогах
      // растягивалась во всю ширину и выталкивала основную кнопку вниз.
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: AppColors.textMuted,
          minimumSize: const Size(64, AppSpacing.minTouchTarget),
        ),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        hintStyle: const TextStyle(color: AppColors.textMuted),
        border: BoxedInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          borderSide: const BorderSide(color: AppColors.border),
        ),
        enabledBorder: BoxedInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          borderSide: const BorderSide(color: AppColors.border),
        ),
        focusedBorder: BoxedInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          borderSide: const BorderSide(color: AppColors.primary, width: 1.6),
        ),
      ),

      floatingActionButtonTheme: const FloatingActionButtonThemeData(
        backgroundColor: AppColors.primary,
        foregroundColor: AppColors.textPrimary,
        elevation: 0,
        focusElevation: 0,
        hoverElevation: 0,
        highlightElevation: 0,
        shape: StadiumBorder(),
      ),

      chipTheme: ChipThemeData(
        backgroundColor: AppColors.surface,
        selectedColor: AppColors.selectionStrong,
        side: const BorderSide(color: AppColors.border),
        labelStyle: const TextStyle(fontFamily: AppFonts.sans, color: AppColors.textPrimary, fontSize: 13.5),
        checkmarkColor: AppColors.brass,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.pill)),
      ),

      tabBarTheme: const TabBarThemeData(
        labelColor: AppColors.textPrimary,
        unselectedLabelColor: AppColors.textMuted,
        indicatorColor: AppColors.primary,
        dividerColor: AppColors.border,
        indicatorSize: TabBarIndicatorSize.label,
        labelStyle: TextStyle(fontFamily: AppFonts.sans, fontWeight: FontWeight.w600, fontSize: 14),
        unselectedLabelStyle: TextStyle(fontFamily: AppFonts.sans, fontWeight: FontWeight.w500, fontSize: 14),
      ),

      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.selected) ? AppColors.textPrimary : AppColors.textMuted),
        trackColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.selected) ? AppColors.primary : AppColors.surfaceElevated),
        trackOutlineColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.selected) ? AppColors.primary : AppColors.border),
      ),

      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.selected) ? AppColors.primary : Colors.transparent),
        checkColor: const WidgetStatePropertyAll(AppColors.textPrimary),
        side: const BorderSide(color: AppColors.textMuted, width: 1.4),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(4)),
      ),

      radioTheme: RadioThemeData(
        fillColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.selected) ? AppColors.primary : AppColors.textMuted),
      ),

      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: AppColors.brass,
        linearTrackColor: AppColors.border,
        circularTrackColor: Colors.transparent,
      ),

      listTileTheme: const ListTileThemeData(
        iconColor: AppColors.textMuted,
        textColor: AppColors.textPrimary,
        titleTextStyle: TextStyle(fontFamily: AppFonts.sans, fontSize: 15, fontWeight: FontWeight.w500, color: AppColors.textPrimary),
        subtitleTextStyle: TextStyle(fontFamily: AppFonts.sans, fontSize: 12.5, color: AppColors.textMuted),
      ),

      popupMenuTheme: PopupMenuThemeData(
        color: AppColors.surfaceElevated,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          side: const BorderSide(color: AppColors.border),
        ),
      ),

      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: AppColors.surfaceElevated,
        surfaceTintColor: Colors.transparent,
        showDragHandle: false,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      ),

      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: AppColors.textPrimary,
          borderRadius: BorderRadius.circular(6),
        ),
        textStyle: const TextStyle(fontFamily: AppFonts.sans, color: AppColors.background, fontSize: 12),
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
        surfaceTintColor: Colors.transparent,
        titleTextStyle: const TextStyle(fontFamily: AppFonts.sans, fontSize: 20, fontWeight: FontWeight.w600, letterSpacing: -0.2, color: AppColors.textPrimary),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(18),
          side: const BorderSide(color: AppColors.border),
        ),
        // Поля по бокам 20 вместо 40: на узком телефоне (320–360 dp) окну
        // с формой не хватало ширины. Планшет не меняется — ширину диалога
        // там задаёт его содержимое.
        insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
      ),

      navigationDrawerTheme: const NavigationDrawerThemeData(
        backgroundColor: AppColors.background,
        indicatorColor: AppColors.selection,
      ),
      drawerTheme: const DrawerThemeData(
        backgroundColor: AppColors.background,
        surfaceTintColor: Colors.transparent,
      ),

      iconTheme: const IconThemeData(color: AppColors.textPrimary),

      splashFactory: InkRipple.splashFactory,
    );
  }
}
