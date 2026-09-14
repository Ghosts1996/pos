/// Приводит любой российский номер к единому формату без «+»: 79995061580.
///
/// Поддерживаемые форматы ввода:
///   +7 999 506-15-80   →  79995061580
///    7(999)506-15-80   →  79995061580
///    8 999 506 15 80   →  79995061580
///      9995061580      →  79995061580
String normalizePhone(String raw) {
  // Оставляем только цифры
  final digits = raw.replaceAll(RegExp(r'[^\d]'), '');
  if (digits.isEmpty) return raw.trim();

  if (digits.length == 11) {
    // 7xxxxxxxxxx или 8xxxxxxxxxx → 7xxxxxxxxxx
    if (digits.startsWith('8')) return '7${digits.substring(1)}';
    return digits; // уже 7xxxxxxxxxx
  }
  if (digits.length == 10 && digits.startsWith('9')) {
    // 9xxxxxxxxx → 79xxxxxxxxx
    return '7$digits';
  }
  // Не распознали — возвращаем как есть (только цифры)
  return digits;
}

/// Проверяет, что нормализованный номер выглядит как российский (11 цифр, начиная с 7).
bool isValidRuPhone(String normalized) =>
    normalized.length == 11 && normalized.startsWith('7');

/// Человекочитаемый вид номера: +7 (999) 506-15-80.
///
/// В базе телефон хранится нормализованным (11 цифр без знаков) — так его
/// удобно сравнивать и искать, но показывать сотруднику сплошную строку
/// цифр неудобно: по ней тяжело сверить номер на слух.
String formatPhone(String normalized) {
  final d = normalized.replaceAll(RegExp(r'\D'), '');
  if (d.length != 11) return normalized;
  return '+${d[0]} (${d.substring(1, 4)}) ${d.substring(4, 7)}-'
      '${d.substring(7, 9)}-${d.substring(9)}';
}
