/// Разбор полей документов Firestore, которые пишет гость.
///
/// Профиль, заказы, вызовы, брони, отзывы и чаевые пишет приложение гостя
/// и веб-версия — её можно подправить прямо в браузере. Число вместо имени
/// или строка вместо списка раньше роняли разбор всего списка на кассе:
/// одна такая запись — и пропадала вся очередь заказов или справочник
/// гостей. Эти функции не бросают исключений.
library;

/// Текст поля; не строка — её текстовое представление, нет поля — [fallback].
String asText(Object? v, [String fallback = '']) => v == null ? fallback : (v is String ? v : v.toString());

/// Текст поля или null, если там не строка.
String? asTextOrNull(Object? v) => v is String ? v : null;

/// Число поля или null, если там не число.
num? asNum(Object? v) => v is num ? v : null;

/// Список поля; не список — пустой.
List<Object?> asList(Object? v) => v is List ? v : const [];

/// Дата из Timestamp, из JSON сервера ({_seconds, _nanoseconds} или
/// {seconds, nanoseconds}), из миллисекунд или ISO-строки. Не дата — null.
DateTime? asDate(Object? v) {
  if (v == null) return null;
  if (v is DateTime) return v;
  if (v is int) return DateTime.fromMillisecondsSinceEpoch(v);
  if (v is String) return DateTime.tryParse(v);
  if (v is Map) {
    final s = v['_seconds'] ?? v['seconds'];
    final n = v['_nanoseconds'] ?? v['nanoseconds'] ?? 0;
    if (s is num) return DateTime.fromMillisecondsSinceEpoch((s * 1000).round() + ((n is num ? n : 0) / 1e6).round());
    return null;
  }
  try {
    // Timestamp из cloud_firestore — без импорта пакета в утилиты.
    return (v as dynamic).toDate() as DateTime;
  } catch (_) {
    return null;
  }
}
