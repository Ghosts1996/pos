/// Подсказки номеров гостя при вводе (как в телефонной книге): кассир
/// набирает часть номера — чаще всего последние 4 цифры — и видит список
/// гостей; тот, чей номер кончается на набранные цифры, — первым.
library;

/// Цифры запроса; для имени — пусто.
String suggestDigits(String query) => query.replaceAll(RegExp(r'\D'), '');

/// Насколько номер подходит к набранным цифрам: 0 — кончается на них
/// («последние 4»), 1 — начинается с них (без кода страны 7/8),
/// 2 — где-то в середине, 3 — не совпадает.
int phoneMatchRank(String phone, String digits) {
  final p = phone.replaceAll(RegExp(r'\D'), '');
  if (digits.isEmpty || p.isEmpty) return 3;
  if (p.endsWith(digits)) return 0;
  final local = p.length == 11 && (p.startsWith('7') || p.startsWith('8')) ? p.substring(1) : p;
  if (local.startsWith(digits) || p.startsWith(digits)) return 1;
  if (p.contains(digits)) return 2;
  return 3;
}

/// Порядок подсказок: по [phoneMatchRank], при равенстве — как пришло с
/// сервера (свежие выше). Для запроса-имени порядок не меняется.
List<T> rankByPhone<T>(List<T> items, String query, String Function(T) phoneOf) {
  final d = suggestDigits(query);
  if (d.length < 3) return items;
  final indexed = [for (var i = 0; i < items.length; i++) (i, items[i])];
  indexed.sort((a, b) {
    final r = phoneMatchRank(phoneOf(a.$2), d).compareTo(phoneMatchRank(phoneOf(b.$2), d));
    return r != 0 ? r : a.$1.compareTo(b.$1);
  });
  return [for (final e in indexed) e.$2];
}

/// Какие цифры номера подсветить: индексы цифр [start, end) — при
/// совпадении в конце берём его, иначе первое совпадение. null — нет.
(int, int)? matchedDigits(String phone, String digits) {
  final p = phone.replaceAll(RegExp(r'\D'), '');
  if (digits.isEmpty) return null;
  final i = p.endsWith(digits) ? p.length - digits.length : p.indexOf(digits);
  return i < 0 ? null : (i, i + digits.length);
}
