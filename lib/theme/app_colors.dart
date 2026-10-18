import 'package:flutter/material.dart';

/// Строгие токены дизайн-системы «Графит и медь».
///
/// Тёплый графит вместо холодного синего: касса работает вечером в
/// приглушённом свете зала, и холодный экран там «светит» на весь стол.
/// Медь — единственный акцент действия, латунь — деньги и бонусы. Цвета
/// подобраны по контрасту WCAG: текст на поверхностях ≥ 6:1, приглушённый
/// ≥ 4.5:1, текст на медной кнопке ≈ 4:1 (крупный полужирный).
///
/// Это единственное место, где должны жить hex-значения цветов.
/// Экраны и виджеты обращаются только к AppColors — палитра меняется
/// одним переключателем: тёмная «Графит и медь» или светлая «Слоновая
/// кость и медь» (см. [AppPalette], тема выбирается в ThemeController).
/// Та же палитра — по умолчанию у приложения гостя (BrandingConfig),
/// в веб-версии гостя (saas/guest-web) и в кабинете владельца.
/// Набор цветов одной темы. Названия и смысл — как у [AppColors].
class AppPalette {
  final Brightness brightness;
  final Color background, surface, surfaceElevated, border;
  final Color primary, primaryPressed, brass, selection, selectionStrong;
  final Color textPrimary, textMuted;
  final Color warning, danger, success, disabled, disabledText;
  final Color tableFree, tableReserved, tableOccupied;

  const AppPalette({
    required this.brightness,
    required this.background,
    required this.surface,
    required this.surfaceElevated,
    required this.border,
    required this.primary,
    required this.primaryPressed,
    required this.brass,
    required this.selection,
    required this.selectionStrong,
    required this.textPrimary,
    required this.textMuted,
    required this.warning,
    required this.danger,
    required this.success,
    required this.disabled,
    required this.disabledText,
    required this.tableFree,
    required this.tableReserved,
    required this.tableOccupied,
  });

  /// «Графит и медь» — для вечернего зала с приглушённым светом.
  static const dark = AppPalette(
    brightness: Brightness.dark,
    background: Color(0xFF15120F),
    surface: Color(0xFF1E1A16),
    surfaceElevated: Color(0xFF26211C),
    border: Color(0xFF36302A),
    primary: Color(0xFFB35C30),
    primaryPressed: Color(0xFF974B26),
    brass: Color(0xFFCFA567),
    selection: Color(0xFF36251A),
    selectionStrong: Color(0xFF4B2E1E),
    textPrimary: Color(0xFFF2EADF),
    textMuted: Color(0xFFA39A8E),
    warning: Color(0xFFD9A84E),
    danger: Color(0xFFD4553F),
    success: Color(0xFF4E9A6A),
    disabled: Color(0xFF2E2924),
    disabledText: Color(0xFF6E665C),
    // Приглушённые тона одной светлоты: шалфей, сирень, васильковый —
    // «занят» остаётся синим, как привыкли сотрудники.
    tableFree: Color(0xFF7FB894),
    tableReserved: Color(0xFFAA9BCB),
    tableOccupied: Color(0xFF7FA2D1),
  );

  /// «Слоновая кость и медь» — для дневного света и светлых залов: тёплая
  /// бумага вместо белого листа, графитовый текст, та же медь и латунь,
  /// только глубже — чтобы держать контраст на светлом (текст ≥ 7:1,
  /// приглушённый ≥ 4.5:1, белый на медной кнопке ≥ 4.5:1).
  static const light = AppPalette(
    brightness: Brightness.light,
    background: Color(0xFFF4EEE6),
    surface: Color(0xFFFCF9F4),
    surfaceElevated: Color(0xFFFFFFFF),
    border: Color(0xFFE2D7C9),
    primary: Color(0xFFA2512A),
    primaryPressed: Color(0xFF85421F),
    brass: Color(0xFF8C6A2F),
    selection: Color(0xFFF3E4D7),
    selectionStrong: Color(0xFFEBD2BE),
    textPrimary: Color(0xFF1F1A15),
    textMuted: Color(0xFF6B6055),
    warning: Color(0xFF9A6A12),
    danger: Color(0xFFB23C28),
    success: Color(0xFF2E7548),
    disabled: Color(0xFFEAE3D9),
    disabledText: Color(0xFFA09586),
    tableFree: Color(0xFF3E8A5B),
    tableReserved: Color(0xFF7760AC),
    tableOccupied: Color(0xFF3D6CAE),
  );
}

class AppColors {
  AppColors._();

  /// Текущая палитра. Меняет её только ThemeController — и сразу
  /// перестраивает всё приложение.
  static AppPalette palette = AppPalette.dark;
  static AppPalette get _p => palette;

  /// Светлая тема включена — для мест, где цвет выбирается не из палитры
  /// (тени, полупрозрачные подложки поверх фото).
  static bool get isLight => _p.brightness == Brightness.light;

  // ---- Base surfaces ----------------------------------------------------

  /// Глобальный фон приложения (Scaffold).
  static Color get background => _p.background;

  /// Поверхности: карточки, панели, сетка блюд, плитки столов.
  static Color get surface => _p.surface;

  /// Чуть приподнятая поверхность (второй уровень) — шапки, подвал чека,
  /// модальные листы.
  static Color get surfaceElevated => _p.surfaceElevated;

  /// Разделители, тонкие бордеры карточек и полей ввода.
  static Color get border => _p.border;

  // ---- Accents ------------------------------------------------------------

  /// Основной акцент действия: "Оплатить", "Отправить на кухню", FAB.
  static Color get primary => _p.primary;

  /// Hover/pressed-состояние primary (на ~15% темнее для контраста нажатия).
  static Color get primaryPressed => _p.primaryPressed;

  /// Латунь — деньги и бонусы: итог чека в акценте, баланс гостя, уровни.
  static Color get brass => _p.brass;

  /// Состояние выбора/активности: выбранный стол, выделенная позиция чека.
  static Color get selection => _p.selection;

  /// Выбранный чип / тональная кнопка — заметнее [selection], чтобы
  /// выбранное состояние не путалось с невыбранным на фоне surface.
  static Color get selectionStrong => _p.selectionStrong;

  // ---- Text -----------------------------------------------------------

  /// Основной текст: названия блюд, суммы, итог чека. В тёмной теме —
  /// тёплая слоновая кость, а не чисто белый: меньше слепит в тёмном зале.
  static Color get textPrimary => _p.textPrimary;

  /// Второстепенный текст: модификаторы, вес, время, статус стола.
  static Color get textMuted => _p.textMuted;

  /// Текст на медной кнопке и других насыщенных заливках — в обеих темах
  /// светлый.
  static const Color onAccent = Color(0xFFFFF8F0);

  // ---- Semantic (не входят в строгий бриф, но нужны для POS-логики) -----

  /// Предупреждение — стол приближается к порогу времени (см. AppConstants).
  static Color get warning => _p.warning;

  /// Ошибка / отмена / "стоп-лист".
  static Color get danger => _p.danger;

  /// Успех — оплачено, чек закрыт. Приглушённый шалфей, не «светофор».
  static Color get success => _p.success;

  /// Цвет для disabled-состояния элементов управления.
  static Color get disabled => _p.disabled;
  static Color get disabledText => _p.disabledText;
}
