import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../services/app_lock.dart';

/// Приводит любой российский номер к единому формату без «+»: 79001234567.
///
/// Поддерживаемые форматы ввода:
///   +7 900 123-45-67   →  79001234567
///    7(900)123-45-67   →  79001234567
///    8 900 123 45 67   →  79001234567
///      9001234567      →  79001234567
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

/// Что не так с номером — подсказка гостю простыми словами; null — номер
/// в порядке. Образец в подсказке — маска, а не чей-то настоящий номер.
String? phoneProblem(String raw) {
  final digits = raw.replaceAll(RegExp(r'\D'), '');
  if (digits.isEmpty) return 'Введите номер телефона';
  if (isValidRuPhone(normalizePhone(raw))) return null;
  // Без кода страны: «+7», «7» или «8» перед номером не считаем.
  final hasCode = raw.trim().startsWith('+7') ||
      ((digits.startsWith('7') || digits.startsWith('8')) && (digits.length > 10 || digits.startsWith('9', 1)));
  final national = hasCode ? digits.substring(1) : digits;
  const sample = 'например, +7 9XX XXX-XX-XX';
  if (national.length < 10) {
    final miss = 10 - national.length;
    return 'Не хватает $miss ${_digitsWord(miss)}: после +7 нужно 10 цифр ($sample)';
  }
  if (national.length > 10) return 'Лишние цифры: после +7 нужно ровно 10 цифр ($sample)';
  return 'Нужен российский номер: +7 и 10 цифр ($sample)';
}

String _digitsWord(int n) {
  final m10 = n % 10, m100 = n % 100;
  if (m10 == 1 && m100 != 11) return 'цифры';
  return 'цифр';
}

/// Человекочитаемый вид номера: +7 (900) 123-45-67.
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

/// Звонок гостю: копирует номер в буфер и открывает набор с уже вставленным
/// номером. Использует ACTION_VIEW, а не ACTION_CALL — вызов не уходит
/// сам, сотрудник нажимает трубку на телефоне вручную. Список открытия
/// набора для `tel:` объявлен в манифесте (см. build-apk.yml), иначе
/// Android 11+ прячет телефонное приложение по правилам package visibility
/// и `canLaunchUrl` всегда возвращает false.
///
/// Номер также кладётся в буфер обмена — пригодится, если набор не
/// откроется, или номер нужно вставить куда-то ещё (SMS, мессенджер).
Future<void> callGuest(BuildContext context, String phone) async {
  final normalized = normalizePhone(phone);
  if (!isValidRuPhone(normalized)) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Некорректный номер: $phone')),
    );
    return;
  }

  final e164 = '+$normalized';
  await Clipboard.setData(ClipboardData(text: e164));

  // Строим URI из готовой строки: Uri(scheme: 'tel', path: ...) кодирует
  // path как обычный сегмент и может потерять ведущий «+».
  bool opened = false;
  try {
    // Звонок — дело кассы: вернувшись, сотрудник продолжает без PIN.
    opened = await AppLock.instance.whileAway(() => launchUrl(Uri.parse('tel:$e164')));
  } catch (_) {
    opened = false;
  }

  if (!context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(opened
          ? '$e164 скопирован, набор открыт — нажмите вызов на телефоне'
          : '$e164 скопирован. Набор не открылся — вставьте номер вручную'),
    ),
  );
}
