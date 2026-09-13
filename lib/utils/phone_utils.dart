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
