import 'package:flutter/material.dart';

/// Строгие токены дизайн-системы "Midnight Blue".
///
/// Это единственное место, где должны жить hex-значения цветов.
/// Экраны и виджеты обращаются только к этим константам —
/// это даёт возможность в будущем сменить палитру одним файлом.
class AppColors {
  AppColors._();

  // ---- Base surfaces ----------------------------------------------------

  /// Глобальный фон приложения (Scaffold).
  static const Color background = Color(0xFF02050B);

  /// Поверхности: карточки, панели, сетка блюд, плитки столов.
  static const Color surface = Color(0xFF0C1424);

  /// Чуть приподнятая поверхность (второй уровень) — шапки, подвал чека,
  /// модальные листы. На 2–3% светлее surface, чтобы не выглядеть плоско.
  static const Color surfaceElevated = Color(0xFF101B30);

  /// Разделители, тонкие бордеры карточек и полей ввода.
  static const Color border = Color(0xFF1E293B);

  // ---- Accents ------------------------------------------------------------

  /// Основной акцент действия: "Оплатить", "Отправить на кухню", FAB.
  static const Color primary = Color(0xFF0B5ED7);

  /// Hover/pressed-состояние primary (на ~12% темнее для контраста нажатия).
  static const Color primaryPressed = Color(0xFF0949AC);

  /// Состояние выбора/активности: выбранный стол, выделенная позиция чека.
  static const Color selection = Color(0xFF162A4A);

  // ---- Text -----------------------------------------------------------

  /// Основной текст: названия блюд, суммы, итог чека.
  static const Color textPrimary = Color(0xFFF8FAFC);

  /// Второстепенный текст: модификаторы, вес, время, статус стола.
  static const Color textMuted = Color(0xFF94A3B8);

  // ---- Semantic (не входят в строгий бриф, но нужны для POS-логики) -----

  /// Предупреждение — стол приближается к порогу времени (см. AppConstants).
  static const Color warning = Color(0xFFF59E0B);

  /// Ошибка / отмена / "стоп-лист".
  static const Color danger = Color(0xFFEF4444);

  /// Успех — оплачено, чек закрыт.
  static const Color success = Color(0xFF22C55E);

  /// Цвет для disabled-состояния элементов управления.
  static const Color disabled = Color(0xFF334155);
  static const Color disabledText = Color(0xFF64748B);
}
