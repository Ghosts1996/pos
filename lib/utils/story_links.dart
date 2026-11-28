/// Ссылки в тексте карточек ленты «как в Telegram»: администратор выделяет
/// слово, нажимает «Ссылка» — в тексте сохраняется `[слово](https://…)`,
/// гость видит только «слово», нажимает — открывается адрес.
library;

import 'package:flutter/services.dart';

/// `[слово](адрес)`: слово — до 120 знаков без скобок и переноса строки,
/// адрес — только http/https или «www.…» (без «javascript:» и прочего).
final RegExp storyLinkPattern = RegExp(
  r'\[([^\[\]\n]{1,120})\]\((https?://[^\s()]+|www\.[^\s()]+)\)',
  caseSensitive: false,
);

/// Адрес, который ввёл администратор, — в рабочую ссылку: «t.me/abc» →
/// «https://t.me/abc». Не ссылка (пробелы, нет точки, чужая схема) — null.
String? normalizeStoryUrl(String raw) {
  var v = raw.trim();
  if (v.isEmpty || RegExp(r'\s').hasMatch(v)) return null;
  final scheme = RegExp(r'^([a-z][a-z0-9+.-]*):', caseSensitive: false).firstMatch(v);
  if (scheme != null) {
    final s = scheme.group(1)!.toLowerCase();
    if (s != 'http' && s != 'https') return null;
    if (!v.contains('://')) return null;
  } else {
    v = 'https://$v';
  }
  final uri = Uri.tryParse(v);
  if (uri == null || !uri.host.contains('.') || v.contains('(') || v.contains(')')) return null;
  return v;
}

/// Текст для коротких мест (список в редакторе, уведомления): вместо
/// `[слово](адрес)` — просто «слово».
String storyPlainText(String text) => text.replaceAllMapped(storyLinkPattern, (m) => m.group(1)!);

/// Ставит ссылку на выделенный текст: выделение «слово» → `[слово](url)`.
/// Без выделения вставляет `[label](url)` в место курсора (или в конец).
/// Курсор — сразу после ссылки.
TextEditingValue insertStoryLink(TextEditingValue v, String url, {String? label}) {
  final text = v.text;
  final sel = v.selection;
  final valid = sel.isValid && sel.start >= 0 && sel.end <= text.length;
  var start = valid ? sel.start : text.length;
  var end = valid ? sel.end : text.length;
  var word = (label ?? text.substring(start, end)).replaceAll(RegExp(r'[\[\]\n]'), ' ').trim();
  // Пробел по краям выделения оставляем снаружи ссылки.
  if (label == null) {
    final raw = text.substring(start, end);
    start += raw.length - raw.trimLeft().length;
    end -= raw.length - raw.trimRight().length;
  }
  if (word.isEmpty) word = url.replaceFirst(RegExp(r'^https?://', caseSensitive: false), '');
  if (word.length > 120) word = word.substring(0, 120);
  final link = '[$word]($url)';
  final out = text.replaceRange(start, end, link);
  return TextEditingValue(
    text: out,
    selection: TextSelection.collapsed(offset: start + link.length),
  );
}
