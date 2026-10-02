import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../models/tenant_models.dart';

/// Палитра приложения гостя. По умолчанию «Графит и медь» (как у кассы и
/// веб-версии гостя), но отдельными полями: брендинг заведения меняет
/// только гостевое приложение, касса остаётся в фирменных цветах.
///
/// Поля не `const`: экраны гостя берут цвета напрямую из KolibriColors, а
/// не из Theme, и [applyBranding] подменяет их до первого runApp(). В
/// процессе всегда одно заведение, так что это безопасно.
class KolibriColors {
  KolibriColors._();

  static const _defaultBackground = Color(0xFF15120F);
  static const _defaultPrimary = Color(0xFFB35C30);
  static const _defaultPrimaryPressed = Color(0xFF974B26);
  static const _defaultGold = Color(0xFFCFA567);
  static const _defaultAccent = Color(0xFFB35C30);
  static const _defaultTextPrimary = Color(0xFFF2EADF);
  /// Название, когда у заведения нет своего: в SaaS — бренд платформы (не
  /// имя чужого заведения), в одно-арендной сборке — само заведение.
  static String get _defaultAppName => 'ZalPOS';

  static Color background = _defaultBackground;
  static Color surface = _mix(_defaultBackground, Colors.white, 0.06);
  static Color surfaceElevated = _mix(_defaultBackground, Colors.white, 0.10);
  static Color border = _mix(_defaultBackground, Colors.white, 0.16);

  /// Медь — основной акцент по умолчанию, branding.primaryColor у заведения с брендингом.
  static Color primary = _defaultPrimary;
  static Color primaryPressed = _defaultPrimaryPressed;

  /// Латунь — бонусы, уровни лояльности, «премиальные» акценты по
  /// умолчанию; branding.secondaryColor у заведения с брендингом.
  static Color gold = _defaultGold;

  /// Акцент кнопок вызова («позвать» и т.п.) — по умолчанию та же медь;
  /// branding.accentColor у заведения с брендингом.
  static Color accent = _defaultAccent;

  static Color textPrimary = _defaultTextPrimary;

  /// Приглушённый текст (подписи, вторичные строки). НЕ `const`, как и всё
  /// выше: на светлом фоне заведения (пресет «Песочный светлый» в консоли)
  /// прежняя константа под тёмную тему читалась с контрастом ~2.3:1 —
  /// [applyBranding] выводит его из пары фон/текст владельца.
  static Color textMuted = _defaultTextMuted;
  static const _defaultTextMuted = Color(0xFFA39A8E);

  /// Текст и иконки поверх [primary] — белый или почти чёрный, что
  /// контрастнее на фирменном цвете.
  static Color onPrimary = Colors.white;

  /// Подложка «врезок» внутри карточки (ID устройства в профиле) — тёмная
  /// полупрозрачная на тёмной теме, еле заметная на светлой.
  static Color inset = Colors.black26;

  /// Фон заведения светлый — тема строится от ThemeData.light (см.
  /// [KolibriTheme.dark]), чтобы системные виджеты (диалоги, строка
  /// состояния) не остались тёмными на светлом приложении.
  static bool isLight = false;

  /// Название заведения из брендинга (раздел «Брендинг», поле «Имя
  /// приложения») — как и цвета выше, это НЕ то же самое, что заголовок окна
  /// (MaterialApp.title в kolibri_main.dart): тот виден только в диспетчере
  /// задач Android, а этот текст читают прямо на главном экране и в профиле
  /// (см. applyBranding). Без него после ребрендинга шапка экрана продолжала
  /// бы показывать название по умолчанию, даже когда заголовок окна уже сменился.
  static String appName = _defaultAppName;

  /// Накладывает фирменную палитру заведения (см. saas/console/console.js,
  /// раздел «Брендинг») поверх дефолтной — вызывается ОДИН раз при старте
  /// (см. kolibri_main.dart), до runApp(). Защита от нечитаемой пары
  /// фон/текст — WCAG, порог 3:1: если владелец в консоли выбрал слишком
  /// похожие фон и текст, откатываемся на дефолтную пару целиком, а не
  /// показываем нечитаемый экран гостю.
  static void applyBranding(BrandingConfig branding) {
    // branding.appName по умолчанию (когда документ пуст/не найден) — общий
    // для всего приложения дефолт BrandingConfig ("ZalPOS", бренд
    // кассы) — гостю его показывать нельзя, поэтому здесь свой дефолт, а не
    // прямое присваивание.
    final name = branding.appName.trim();
    appName = name.isEmpty ? _defaultAppName : name;

    primary = _parseHexColor(branding.primaryColor) ?? _defaultPrimary;
    primaryPressed = Color.lerp(primary, Colors.black, 0.18) ?? _defaultPrimaryPressed;
    accent = _parseHexColor(branding.accentColor) ?? _defaultAccent;

    var bg = _parseHexColor(branding.backgroundColor) ?? _defaultBackground;
    var text = _parseHexColor(branding.textColor) ?? _defaultTextPrimary;
    if (_contrastRatio(bg, text) < 3.0) {
      bg = _defaultBackground;
      text = _defaultTextPrimary;
    }
    background = bg;
    textPrimary = text;

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

    // «Золото» — бонусы и уровни. Во всех тёмных пресетах консоли
    // второстепенный цвет — тёмный тон (#162A4A и т.п.), и баланс бонусов
    // читался с контрастом ~1.2:1. Берём его, только если он читается,
    // иначе основной, и лишь в крайнем случае — основной, подтянутый к
    // цвету текста.
    final secondary = _parseHexColor(branding.secondaryColor);
    bool readsOnAll(Color c) => surfaces.every((s) => _contrastRatio(c, s) >= 3.0);
    if (secondary != null && readsOnAll(secondary)) {
      gold = secondary;
    } else if (readsOnAll(primary)) {
      gold = primary;
    } else {
      gold = _readable(primary, surfaces, text, 3.0);
    }

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

  // Приглушённые, а не «светофор»: читаются и на тёмном, и на светлом фоне.
  static const success = Color(0xFF5E9E74);
  static const warning = Color(0xFFD39A3A);
  static const danger = Color(0xFFD4553F);

  // ---- Уровни программы лояльности ----
  // Металлы, а не неон: бронза, сталь, платина, холодный лёд.
  static const tierBronze = Color(0xFFC08552);
  static const tierSilver = Color(0xFFB7B9BD);
  static const tierPlatinum = Color(0xFFDAD4C8);
  static const tierDiamond = Color(0xFFA9C3DA);

  /// Цвет карточки/акцента под текущий уровень гостя (см. ClientProfile.tier).
  /// Уровень «Золото» намеренно ссылается на живое поле [gold], а не на
  /// отдельную константу — он и есть тот самый фирменный акцент лояльности,
  /// который меняет [applyBranding].
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
