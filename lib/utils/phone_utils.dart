import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

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
    opened = await launchUrl(Uri.parse('tel:$e164'));
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
