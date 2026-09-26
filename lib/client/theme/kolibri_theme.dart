import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../models/tenant_models.dart';

/// Палитра клиентского приложения «Colibri Lounge».
///
/// Она намеренно отличается от POS («Midnight Blue»): гость видит тёплый
/// изумрудно-золотой лаунж по умолчанию, а не рабочий интерфейс кассы.
/// Общего кода с AppColors нет, чтобы правки в POS-теме не «поехали» у
/// гостей.
///
/// ВАЖНО: поля ниже НЕ `const` (как раньше), а обычные изменяемые `static`
/// — это единственная причина, почему [applyBranding] вообще работает.
/// Ни один из ~13 экранов гостевого приложения не читает цвета через
/// `Theme.of(context)` (в отличие от POS) — все они напрямую ссылаются на
/// `KolibriColors.primary`/`.gold`/`.accent` и т.д. Переписывать десятки
/// мест ради темизации было бы намного рискованнее, чем один раз
/// подменить сами константы ДО первого `runApp()` — раз APK и так
/// собирается отдельно на каждое заведение (kolibri_main.dart,
/// SAAS_MODE), внутри одного запущенного процесса всегда ровно один
/// арендатор, так что мутация "констант" здесь безопасна.
class KolibriColors {
  KolibriColors._();

  static const _defaultBackground = Color(0xFF07100D);
  static const _defaultPrimary = Color(0xFF12B981);
  static const _defaultPrimaryPressed = Color(0xFF0E9A6B);
  static const _defaultGold = Color(0xFFE0B354);
  static const _defaultAccent = Color(0xFFE0559B);
  static const _defaultTextPrimary = Color(0xFFF2F7F4);
  static const _defaultAppName = 'Colibri Lounge';

  static Color background = _defaultBackground;
  static Color surface = _mix(_defaultBackground, Colors.white, 0.06);
  static Color surfaceElevated = _mix(_defaultBackground, Colors.white, 0.10);
  static Color border = _mix(_defaultBackground, Colors.white, 0.16);

  /// Изумруд — основной акцент (оперение колибри) по умолчанию, branding.primaryColor у заведения с брендингом.
  static Color primary = _defaultPrimary;
  static Color primaryPressed = _defaultPrimaryPressed;

  /// Золото — бонусы, уровни лояльности, «премиальные» акценты по
  /// умолчанию; branding.secondaryColor у заведения с брендингом.
  static Color gold = _defaultGold;

  /// Фуксия — живой акцент для кнопок «позвать кальянщика» по умолчанию;
  /// branding.accentColor у заведения с брендингом.
  static Color accent = _defaultAccent;

  static Color textPrimary = _defaultTextPrimary;

  /// Приглушённый текст (подписи, вторичные строки). НЕ `const`, как и всё
  /// выше: на светлом фоне заведения (пресет «Песочный светлый» в консоли)
  /// прежняя константа под тёмную тему читалась с контрастом ~2.3:1 —
  /// [applyBranding] выводит его из пары фон/текст владельца.
  static Color textMuted = _defaultTextMuted;
  static const _defaultTextMuted = Color(0xFF8FA79C);

  /// Цвет текста/иконок поверх [primary] (кнопки, выбранный день брони,
  /// свои сообщения в чате) — белый или почти чёрный, смотря что
  /// контрастнее на фирменном цвете. Раньше всегда был белым.
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
  /// бы показывать "Colibri Lounge", даже когда заголовок окна уже сменился.
  static String appName = _defaultAppName;

  /// Накладывает фирменную палитру заведения (см. saas/console/console.js,
  /// раздел «Брендинг») поверх дефолтной — вызывается ОДИН раз при старте
  /// (см. kolibri_main.dart), до runApp(). Та же защита от нечитаемой пары
  /// фон/текст, что и в lib/theme/app_theme.dart (AppTheme.branded) — WCAG,
  /// порог 3:1: если владелец в консоли выбрал слишком похожие фон и текст,
  /// откатываемся на дефолтную пару целиком, а не показываем нечитаемый
  /// экран гостю.
  static void applyBranding(BrandingConfig branding) {
    // branding.appName по умолчанию (когда документ пуст/не найден) — общий
    // для всего приложения дефолт BrandingConfig ("Hookah POS", бренд
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

    const darkOnPrimary = Color(0xFF04140E);
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

  static const success = Color(0xFF22C55E);
  static const warning = Color(0xFFF59E0B);
  static const danger = Color(0xFFEF4444);

  // ---- Уровни программы лояльности ----
  static const tierBronze = Color(0xFFCD7F32);
  static const tierSilver = Color(0xFFB4C4CC);
  static const tierPlatinum = Color(0xFFAEEFE6);
  static const tierDiamond = Color(0xFFB388FF);

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
    final base = light ? ThemeData.light(useMaterial3: true) : ThemeData.dark(useMaterial3: true);
    return base.copyWith(
      scaffoldBackgroundColor: KolibriColors.background,
      colorScheme: base.colorScheme.copyWith(
        primary: KolibriColors.primary,
        onPrimary: KolibriColors.onPrimary,
        secondary: KolibriColors.gold,
        surface: KolibriColors.surface,
        onSurface: KolibriColors.textPrimary,
        error: KolibriColors.danger,
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: KolibriColors.background,
        foregroundColor: KolibriColors.textPrimary,
        elevation: 0,
        centerTitle: false,
        systemOverlayStyle: light ? SystemUiOverlayStyle.dark : SystemUiOverlayStyle.light,
      ),
      cardTheme: CardThemeData(
        color: KolibriColors.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(18),
          side: BorderSide(color: KolibriColors.border),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: KolibriColors.primary,
          foregroundColor: KolibriColors.onPrimary,
          minimumSize: const Size(0, 52),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: KolibriColors.textPrimary,
          side: BorderSide(color: KolibriColors.border),
          minimumSize: const Size(0, 48),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: KolibriColors.surface,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: KolibriColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: KolibriColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: KolibriColors.primary),
        ),
        labelStyle: TextStyle(color: KolibriColors.textMuted),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: KolibriColors.surface,
        indicatorColor: KolibriColors.primary.withValues(alpha: 0.18),
        labelTextStyle: WidgetStateProperty.all(
          TextStyle(fontSize: 12, color: KolibriColors.textMuted),
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
