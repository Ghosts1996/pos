import 'dart:convert';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../models/tenant_models.dart';

/// Палитра приложения гостя — только цвета заведения (раздел «Брендинг»
/// в личном кабинете). Цветов ZalPOS здесь нет: пока брендинг не
/// загружен или владелец какой-то цвет не задал, палитра нейтральная
/// (графитово-серая), а недостающие цвета выводятся из основного цвета
/// заведения. Касса остаётся в своих фирменных цветах (AppColors).
///
/// Поля не `const`: экраны гостя берут цвета напрямую из KolibriColors, а
/// не из Theme, и [applyBranding] подменяет их до первого runApp(). В
/// процессе всегда одно заведение, так что это безопасно.
class KolibriColors {
  KolibriColors._();

  // Нейтральная палитра: без оттенка — ни меди, ни синего.
  static const _defaultBackground = Color(0xFF141414);
  static const _defaultPrimary = Color(0xFFE8E6E3);
  static const _defaultTextPrimary = Color(0xFFF2F2F2);
  /// Название, когда у заведения нет своего: в SaaS — бренд платформы (не
  /// имя чужого заведения), в одно-арендной сборке — само заведение.
  static String get _defaultAppName => 'ZalPOS';

  static Color background = _defaultBackground;
  static Color surface = _mix(_defaultBackground, Colors.white, 0.06);
  static Color surfaceElevated = _mix(_defaultBackground, Colors.white, 0.10);
  static Color border = _mix(_defaultBackground, Colors.white, 0.16);

  /// Основной цвет заведения (branding.primaryColor): кнопки, выбранное.
  static Color primary = _defaultPrimary;
  static Color primaryPressed = _mix(_defaultPrimary, Colors.black, 0.18);

  /// Цвет бонусов и уровней лояльности — второстепенный цвет заведения,
  /// если он читается, иначе основной.
  static Color gold = _defaultPrimary;

  /// Акцент кнопок вызова («позвать» и т.п.) — цвет «Кнопки» (buttonColor).
  static Color accent = _defaultPrimary;

  static Color textPrimary = _defaultTextPrimary;

  /// Приглушённый текст (подписи, вторичные строки). НЕ `const`, как и всё
  /// выше: на светлом фоне заведения прежняя константа под тёмную тему
  /// читалась бы плохо — [applyBranding] выводит его из пары фон/текст.
  static Color textMuted = const Color(0xFF9E9E9E);

  /// Текст и иконки поверх [primary] — белый или почти чёрный, что
  /// контрастнее на фирменном цвете.
  static Color onPrimary = const Color(0xFF141414);

  /// Подложка «врезок» внутри карточки (ID устройства в профиле) — тёмная
  /// полупрозрачная на тёмной теме, еле заметная на светлой.
  static Color inset = Colors.black26;

  /// Фон заведения светлый — тема строится от ThemeData.light (см.
  /// [KolibriTheme.dark]), чтобы системные виджеты (диалоги, строка
  /// состояния) не остались тёмными на светлом приложении.
  static bool isLight = false;

  /// Название заведения из брендинга (раздел «Брендинг», поле «Имя
  /// приложения») — его читают прямо на главном экране и в профиле.
  static String appName = _defaultAppName;

  // ---- Состояния ----
  // Успех и предупреждение — тоже из цветов заведения (основной и
  // второстепенный), чтобы в приложении не было чужих оттенков. Красный
  // остаётся только у ошибок и отмены: его гость должен узнать сразу.
  static Color success = _defaultPrimary;
  static Color warning = _defaultPrimary;
  static const danger = Color(0xFFE5484D);

  // ---- Уровни программы лояльности ----
  // Ступени одного фирменного цвета: от приглушённого к самому яркому.
  static Color tierBronze = _defaultPrimary;
  static Color tierSilver = _defaultPrimary;
  static Color tierPlatinum = _defaultPrimary;
  static Color tierDiamond = _defaultPrimary;

  /// Цвет карточки/акцента под текущий уровень гостя (см. ClientProfile.tier).
  static Color tierColor(String tier) {
    switch (tier) {
      case 'Алмаз':
        return tierDiamond;
      case 'Платина':
        return tierPlatinum;
      case 'Золото':
        return gold;
      case 'Серебро':
        return tierSilver;
      default:
        return tierBronze;
    }
  }

  static const _cacheKey = 'kolibri.branding.v1';

  /// Последний брендинг заведения с диска — до первого кадра, пока сеть
  /// ещё не ответила: экран загрузки сразу в цветах заведения, а не в
  /// нейтральных. Первый запуск — нейтральная палитра.
  static Future<void> restoreCachedBranding() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_cacheKey);
      if (raw == null) return;
      final map = jsonDecode(raw);
      if (map is Map<String, dynamic>) applyBranding(BrandingConfig.fromMap(map));
    } catch (_) {}
  }

  static Future<void> cacheBranding(BrandingConfig branding) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_cacheKey, jsonEncode(branding.toMap()));
    } catch (_) {}
  }

  /// Накладывает фирменную палитру заведения (см. saas/console/console.js,
  /// раздел «Брендинг»). Защита от нечитаемой пары фон/текст — WCAG,
  /// порог 3:1: если владелец выбрал слишком похожие фон и текст, берём
  /// нейтральную пару, а не показываем нечитаемый экран гостю.
  static void applyBranding(BrandingConfig branding) {
    // branding.appName по умолчанию — общий для всего приложения дефолт
    // BrandingConfig ("ZalPOS", бренд кассы) — гостю его показывать нельзя,
    // поэтому здесь свой дефолт, а не прямое присваивание.
    final name = branding.appName.trim();
    appName = name.isEmpty ? _defaultAppName : name;

    var bg = _parseHexColor(branding.backgroundColor) ?? _defaultBackground;
    var text = _parseHexColor(branding.textColor) ??
        (_relativeLuminance(bg) > 0.4 ? const Color(0xFF1A1A1A) : _defaultTextPrimary);
    if (_contrastRatio(bg, text) < 3.0) {
      bg = _defaultBackground;
      text = _defaultTextPrimary;
    }
    background = bg;
    textPrimary = text;

    // Нет основного цвета — нейтральный: цвет текста заведения.
    primary = _parseHexColor(branding.primaryColor) ?? text;
    primaryPressed = Color.lerp(primary, Colors.black, 0.18) ?? primary;
    // Кнопки вызова — цвет «Кнопки» из «Брендинга». accentColor в кабинете
    // не настраивается и остаётся от значений по умолчанию (у старых
    // заведений — синий) — его не берём, иначе в приложении чужой цвет.
    accent = _parseHexColor(branding.buttonColor) ?? primary;

    // Дальше — ровно тот же расчёт, что и в saas/guest-web/app/palette.js
    // (см. его шапку: почему нельзя просто подставить цвета владельца).
    isLight = _relativeLuminance(bg) > 0.4;
    if (isLight) {
      // Осветлять и без того светлый фон — значит получить невидимые рамки:
      // карточки белее фона, а рамки и «приподнятые» поверхности — темнее.
      surface = _mix(bg, Colors.white, 0.55);
      surfaceElevated = _mix(bg, text, 0.05);
      border = _mix(bg, text, 0.16);
      inset = Colors.black.withValues(alpha: 0.05);
    } else {
      surface = _mix(bg, Colors.white, 0.06);
      surfaceElevated = _mix(bg, Colors.white, 0.10);
      border = _mix(bg, Colors.white, 0.16);
      inset = Colors.black26;
    }
    final surfaces = [bg, surface, surfaceElevated];
    textMuted = _readable(_mix(text, bg, 0.42), surfaces, text, 4.5);

    // «Золото» — бонусы и уровни. Во многих тёмных пресетах второстепенный
    // цвет — тёмный тон (#162A4A и т.п.), и баланс бонусов читался бы с
    // контрастом ~1.2:1. Берём его, только если он читается, иначе
    // основной, и лишь в крайнем случае — основной, подтянутый к тексту.
    final secondary = _parseHexColor(branding.secondaryColor);
    bool readsOnAll(Color c) => surfaces.every((s) => _contrastRatio(c, s) >= 3.0);
    final primaryReadable = readsOnAll(primary) ? primary : _readable(primary, surfaces, text, 3.0);
    gold = secondary != null && readsOnAll(secondary) ? secondary : primaryReadable;

    success = primaryReadable;
    warning = gold;
    tierBronze = _readable(_mix(gold, textMuted, 0.55), surfaces, text, 3.0);
    tierSilver = _readable(_mix(gold, text, 0.45), surfaces, text, 3.0);
    tierPlatinum = _readable(_mix(primaryReadable, text, 0.30), surfaces, text, 3.0);
    tierDiamond = primaryReadable;

    const darkOnPrimary = Color(0xFF17110C);
    onPrimary = _contrastRatio(primary, Colors.white) >= _contrastRatio(primary, darkOnPrimary)
        ? Colors.white
        : darkOnPrimary;
  }

  static Color _mix(Color a, Color b, double t) => Color.lerp(a, b, t) ?? a;

  /// Тот же оттенок, но читаемый на всех [backgrounds] не хуже [minRatio]:
  /// сам [color], если он уже подходит, иначе шаг за шагом смешанный с [text].
  static Color _readable(Color color, List<Color> backgrounds, Color text, double minRatio) {
    for (var step = 0; step <= 10; step++) {
      final c = step == 0 ? color : _mix(color, text, step / 10);
      if (backgrounds.every((bg) => _contrastRatio(c, bg) >= minRatio)) return c;
    }
    return text;
  }

  static Color? _parseHexColor(String hex) {
    var h = hex.trim().replaceFirst('#', '');
    if (h.length == 6) h = 'FF$h';
    if (h.length != 8) return null;
    final value = int.tryParse(h, radix: 16);
    return value == null ? null : Color(value);
  }

  /// Контраст по формуле WCAG 2 — та же, что и в lib/theme/app_theme.dart
  /// (см. её же комментарий: почему именно 3:1 и почему проверка нужна и
  /// на стороне приложения, а не только в консоли-браузере). Не общий код
  /// с app_theme.dart (см. docstring класса) — 8 строк дешевле держать
  /// продублированными, чем тянуть межтемовую зависимость ради них.
  static double _contrastRatio(Color a, Color b) {
    final la = _relativeLuminance(a) + 0.05;
    final lb = _relativeLuminance(b) + 0.05;
    return la > lb ? la / lb : lb / la;
  }

  static double _relativeLuminance(Color c) =>
      0.2126 * _srgbChannel(c.r) + 0.7152 * _srgbChannel(c.g) + 0.0722 * _srgbChannel(c.b);

  static double _srgbChannel(double c) =>
      c <= 0.03928 ? c / 12.92 : math.pow((c + 0.055) / 1.055, 2.4).toDouble();

}

class KolibriTheme {
  KolibriTheme._();

  /// Тема гостевого приложения. Имя историческое: у заведения со светлым
  /// фоном (KolibriColors.isLight) она строится от ThemeData.light.
  static ThemeData get dark {
    final light = KolibriColors.isLight;
    final base = ThemeData(
      useMaterial3: true,
      brightness: light ? Brightness.light : Brightness.dark,
      fontFamily: KolibriFonts.sans,
    );
    return base.copyWith(
      scaffoldBackgroundColor: KolibriColors.background,
      colorScheme: base.colorScheme.copyWith(
        primary: KolibriColors.primary,
        onPrimary: KolibriColors.onPrimary,
        secondary: KolibriColors.gold,
        surface: KolibriColors.surface,
        onSurface: KolibriColors.textPrimary,
        onSurfaceVariant: KolibriColors.textMuted,
        outline: KolibriColors.border,
        outlineVariant: KolibriColors.border,
        surfaceContainerHighest: KolibriColors.surfaceElevated,
        surfaceContainerHigh: KolibriColors.surfaceElevated,
        surfaceContainer: KolibriColors.surface,
        error: KolibriColors.danger,
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: KolibriColors.background,
        foregroundColor: KolibriColors.textPrimary,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          fontFamily: KolibriFonts.sans,
          fontSize: 19,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.2,
          color: KolibriColors.textPrimary,
        ),
        systemOverlayStyle: light ? SystemUiOverlayStyle.dark : SystemUiOverlayStyle.light,
      ),
      cardTheme: CardThemeData(
        color: KolibriColors.surface,
        elevation: 0,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: KolibriColors.border),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: KolibriColors.primary,
          foregroundColor: KolibriColors.onPrimary,
          minimumSize: const Size(0, 52),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: const TextStyle(fontFamily: KolibriFonts.sans, fontSize: 15.5, fontWeight: FontWeight.w600),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: KolibriColors.textPrimary,
          side: BorderSide(color: KolibriColors.border),
          minimumSize: const Size(0, 48),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: const TextStyle(fontFamily: KolibriFonts.sans, fontSize: 15, fontWeight: FontWeight.w500),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: KolibriColors.primary,
          textStyle: const TextStyle(fontFamily: KolibriFonts.sans, fontWeight: FontWeight.w600),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: KolibriColors.surfaceElevated,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: KolibriColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: KolibriColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: KolibriColors.primary, width: 1.4),
        ),
        labelStyle: TextStyle(color: KolibriColors.textMuted),
        hintStyle: TextStyle(color: KolibriColors.textMuted),
      ),
      // Нижние вкладки — тонкая линия сверху и цвет вместо «таблетки»
      // подсветки.
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: KolibriColors.background,
        surfaceTintColor: Colors.transparent,
        indicatorColor: Colors.transparent,
        elevation: 0,
        height: 68,
        iconTheme: WidgetStateProperty.resolveWith((states) => IconThemeData(
              size: 24,
              color: states.contains(WidgetState.selected) ? KolibriColors.primary : KolibriColors.textMuted,
            )),
        labelTextStyle: WidgetStateProperty.resolveWith((states) => TextStyle(
              fontFamily: KolibriFonts.sans,
              fontSize: 11,
              fontWeight: states.contains(WidgetState.selected) ? FontWeight.w600 : FontWeight.w500,
              letterSpacing: 0.2,
              color: states.contains(WidgetState.selected) ? KolibriColors.textPrimary : KolibriColors.textMuted,
            )),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: Colors.transparent,
        selectedColor: KolibriColors.primary,
        side: BorderSide(color: KolibriColors.border),
        labelStyle: TextStyle(fontFamily: KolibriFonts.sans, color: KolibriColors.textPrimary, fontSize: 14),
        secondaryLabelStyle: TextStyle(fontFamily: KolibriFonts.sans, color: KolibriColors.onPrimary, fontSize: 14),
        checkmarkColor: KolibriColors.onPrimary,
        shape: const StadiumBorder(),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: KolibriColors.gold,
        linearTrackColor: KolibriColors.border,
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: KolibriColors.surface,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: KolibriColors.surfaceElevated,
        contentTextStyle: TextStyle(fontFamily: KolibriFonts.sans, color: KolibriColors.textPrimary),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: KolibriColors.border),
        ),
      ),
      // Поля по бокам 20 вместо 40 — на узком телефоне окнам не хватало ширины.
      dialogTheme: DialogThemeData(
        backgroundColor: KolibriColors.surface,
        surfaceTintColor: Colors.transparent,
        insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: BorderSide(color: KolibriColors.border),
        ),
        titleTextStyle: TextStyle(
          fontFamily: KolibriFonts.sans,
          fontSize: 20,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.2,
          color: KolibriColors.textPrimary,
        ),
      ),
      dividerColor: KolibriColors.border,
      dividerTheme: DividerThemeData(color: KolibriColors.border, thickness: 1, space: 1),
      textTheme: base.textTheme
          .apply(
            bodyColor: KolibriColors.textPrimary,
            displayColor: KolibriColors.textPrimary,
          )
          .copyWith(
            // Крупные заголовки (приветствие, баланс) — антиквой.
            displayLarge: KolibriFonts.display(52),
            displayMedium: KolibriFonts.display(44),
            displaySmall: KolibriFonts.display(36),
            headlineLarge: KolibriFonts.display(32),
          ),
    );
  }
}

/// Шрифты приложения гостя — те же, что у кассы и веб-версии (assets/fonts):
/// Onest — текст, Cormorant Garamond — крупные заголовки и баланс. Номера
/// столов и суммы в чеке — гротеском: у антиквы «1» похожа на «I».
class KolibriFonts {
  KolibriFonts._();
  static const String sans = 'Onest';
  static const String serif = 'CormorantGaramond';

  static TextStyle display(double size, {Color? color, FontStyle? style}) => TextStyle(
        fontFamily: serif,
        fontSize: size,
        fontWeight: FontWeight.w600,
        fontStyle: style,
        height: 1.06,
        letterSpacing: -0.2,
        color: color ?? KolibriColors.textPrimary,
        fontFeatures: const [FontFeature.liningFigures()],
      );

  /// Подпись капителью над блоком («БОНУСНЫЙ СЧЁТ»).
  static TextStyle overline({Color? color}) => TextStyle(
        fontFamily: sans,
        fontSize: 11,
        fontWeight: FontWeight.w600,
        letterSpacing: 2,
        color: color ?? KolibriColors.gold,
      );
}

/// Заголовок раздела — капитель с тонкой линией до края (как на сайте
/// гостя, h2 в saas/guest-web/app/app.css).
class KolibriSectionLabel extends StatelessWidget {
  const KolibriSectionLabel(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) => Row(children: [
        Text(text.toUpperCase(), style: KolibriFonts.overline(color: KolibriColors.textMuted)),
        const SizedBox(width: 12),
        Expanded(child: Container(height: 1, color: KolibriColors.border)),
      ]);
}
