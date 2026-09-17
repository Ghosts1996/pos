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

/// Позвонить гостю: копирует номер и открывает набор — везде одинаково.
///
/// Раньше кнопка звонка просто пыталась `launchUrl('tel:...')`, и на
/// Android 11+ это тихо проваливалось: `canLaunchUrl` для `tel:` спрашивает
/// систему через `ACTION_VIEW`, а в манифесте было объявлено видимым
/// только `ACTION_DIAL` — из-за несовпадения действия Android скрывал
/// телефонное приложение (package visibility), и код падал в запасную
/// ветку «просто показать номер». Со стороны это выглядело как «нажал на
/// значок звонка — снизу выскочил номер, и всё». Правило в манифесте
/// поправлено на `ACTION_VIEW` (см. build-apk.yml), поэтому набор теперь
/// открывается по-настоящему.
///
/// Сам звонок не запускается — это `tel:` (ACTION_VIEW), а не `ACTION_CALL`:
/// набор откроется с уже вставленным номером, а нажать зелёную трубку
/// должен сам сотрудник. Так и задумано: список входящих/исходящих на
/// телефоне не должен пополняться звонками, которые кассир не совершал.
///
/// Номер дополнительно копируется в буфер — пригодится, если набор не
/// откроется (нет приложения «Телефон», рабочий профиль и т.п.) или
/// номер нужно вставить куда-то ещё (SMS, мессенджер).
Future<void> callGuest(BuildContext context, String phone) async {
  final normalized = normalizePhone(phone);
  if (!isValidRuPhone(normalized)) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Некорректный номер: $phone')),
    );
    return;
  }

  final e164 = '+$normalized'; // +79995061580 — «формат +7» из просьбы
  await Clipboard.setData(ClipboardData(text: e164));

  bool opened = false;
  try {
    opened = await launchUrl(Uri(scheme: 'tel', path: normalized));
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
