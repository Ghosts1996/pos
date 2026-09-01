/// Разбор и модель кода маркировки «Честный ЗНАК».
///
/// Код печатается на упаковке в виде DataMatrix и, если его прочитать как
/// текст, представляет собой строку GS1 с идентификаторами применения (AI):
///
///   01 + GTIN (14 цифр)            — код товара
///   21 + серийный номер (до 20)    — уникальный экземпляр
///   \x1D (GS, код 29) — разделитель полей переменной длины
///   93 + 4 символа                 — криптохвост (проверочный код)
///
/// Пример «сырого» скана (␝ — непечатаемый разделитель GS):
///   010460043952693621SPecu2/hSFxWq93zPHt
///
/// Российские 2D-сканеры и телефон с камерой отдают ровно эту строку целиком
/// (либо в GS1-режиме с настоящим байтом 0x1D, либо реже — с "человеческими"
/// разделителями). Разбор ниже терпим к обоим вариантам.
library marking_code;

/// Идентификатор AI93 — криптохвост — используется, чтобы отличить код
/// «Честного знака» от обычного EAN/QR и не пытаться завести кальян по
/// коду сигаретной пачки.
class MarkingCode {
  /// Исходная строка, как её отдал сканер/камера — нужна для отправки в
  /// чек (тег ОФД 1162) и для показа в истории движений склада.
  final String raw;

  /// GTIN товара (14 цифр) — им сверяем код с позицией номенклатуры.
  final String gtin;

  /// Индивидуальный серийный номер экземпляра — по нему код одноразовый:
  /// один и тот же экземпляр нельзя продать дважды.
  final String serial;

  /// Криптохвост (проверочный код, обычно 4 символа) — присутствие этого
  /// поля отличает настоящий код «Честного знака» от простого штрихкода.
  final String? cryptoTail;

  const MarkingCode({
    required this.raw,
    required this.gtin,
    required this.serial,
    this.cryptoTail,
  });

  /// Похоже ли это вообще на код маркировки (а не на обычный EAN-13/QR
  /// меню) — по наличию AI 01 и 21 в начале строки.
  static bool looksLikeMarkingCode(String data) {
    final cleaned = data.trim();
    return cleaned.startsWith('01') && cleaned.length >= 16 + 2;
  }

  /// Парсит сырой скан. Возвращает null, если строка вообще не похожа на
  /// код маркировки (тогда вызывающий код должен попробовать обработать
  /// её как обычный штрихкод меню/склада).
  static MarkingCode? tryParse(String data) {
    var s = data.trim();
    if (!looksLikeMarkingCode(s)) return null;

    // AI 01: следующие 14 символов — GTIN, длина фиксированная.
    if (s.length < 2 + 14) return null;
    final gtin = s.substring(2, 16);
    if (!RegExp(r'^\d{14}$').hasMatch(gtin)) return null;
    var rest = s.substring(16);

    if (!rest.startsWith('21')) return null;
    rest = rest.substring(2);

    // Серийный номер — переменной длины, обрывается на разделителе GS
    // (0x1D), либо на следующем AI (93), либо на конце строки.
    const gs = '\u001D';
    String serial;
    String? cryptoTail;

    final gsIndex = rest.indexOf(gs);
    if (gsIndex != -1) {
      serial = rest.substring(0, gsIndex);
      final afterGs = rest.substring(gsIndex + 1);
      cryptoTail = _extractAi93(afterGs);
    } else {
      // Разделителя нет (частая ситуация при вводе с HID-сканера, который
      // не всегда передаёт непечатаемые байты 1:1) — ищем AI "93" как
      // границу серийного номера и криптохвоста.
      final ai93Index = rest.indexOf('93');
      if (ai93Index > 0) {
        serial = rest.substring(0, ai93Index);
        cryptoTail = rest.substring(ai93Index + 2);
      } else {
        serial = rest;
      }
    }

    if (serial.isEmpty) return null;
    return MarkingCode(raw: data, gtin: gtin, serial: serial, cryptoTail: cryptoTail);
  }

  static String? _extractAi93(String s) {
    if (s.startsWith('93') && s.length > 2) return s.substring(2);
    return s.isEmpty ? null : s;
  }

  /// Ключ для дедупликации/учёта уже списанных кодов за смену — весь код
  /// целиком одноразовый, поэтому используем raw, а не только серийник.
  String get uniqueKey => raw;

  @override
  String toString() => 'MarkingCode(gtin: $gtin, serial: $serial)';
}