import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'app_scope.dart';
import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';
import 'package:print_bluetooth_thermal/print_bluetooth_thermal.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import '../utils/adaptive.dart';
import '../utils/kitchen_slips.dart';
import '../models/aggregator.dart';

/// Печать информационного (не фискального) чека на 58/80-мм принтере
/// командами ESC/POS: по Bluetooth (`print_bluetooth_thermal`) или по сети
/// (сырой ESC/POS на порт 9100). USB на Android потребует отдельного
/// плагина с USB Host API — подключается через тот же [ReceiptPrinter].
class ReceiptLine {
  final String left;
  final String right;
  final bool bold;
  const ReceiptLine(this.left, {this.right = '', this.bold = false});
}

/// Данные для печати одного чека — экран оплаты собирает эту структуру
/// из позиций стола и передаёт в [ReceiptPrinter.printReceipt].
class ReceiptData {
  final String venueName;

  /// Подзаголовок чека — «Кальяны» или «Кухня и бар», когда счёт
  /// печатается двумя чеками (см. [printHookahSeparately]).
  final String title;
  final String tableName;
  final String employeeName;
  final DateTime closedAt;
  final List<ReceiptLine> items;
  final double total;
  final String paymentMethod; // "Наличные" / "Карта"
  final String footerNote;

  const ReceiptData({
    required this.venueName,
    this.title = '',
    required this.tableName,
    required this.employeeName,
    required this.closedAt,
    required this.items,
    required this.total,
    required this.paymentMethod,
    this.footerNote = 'Спасибо, ждём снова!',
  });
}

abstract class ReceiptPrinter {
  bool get isConnected;
  Future<bool> connect();
  Future<void> disconnect();
  Future<void> printReceipt(ReceiptData data);

  /// Отправить готовые ESC/POS-байты — для отчётов (см. [ReportPrint]).
  Future<void> printBytes(List<int> bytes);

  /// Напечатать отчёт (X-отчёт смены и т. п.).
  Future<void> printReport(ReportPrint report) async => printBytes(await buildReportBytes(report));

  /// Напечатать предчек — счёт гостю до оплаты.
  Future<void> printPrecheck(PrecheckData data) async => printBytes(await buildPrecheckBytes(data));

  /// Напечатать бегунки — по листку на цех, каждый с отрезом.
  Future<void> printKitchenSlips(List<KitchenSlip> slips) async => printBytes(await buildKitchenSlipsBytes(slips));
}

/// Строка отчёта для печати: слева подпись, справа сумма. [separator] —
/// горизонтальная черта вместо строки.
class ReportLine {
  final String left;
  final String right;
  final bool bold;
  final bool separator;
  const ReportLine(this.left, {this.right = '', this.bold = false}) : separator = false;
  const ReportLine.separator()
      : left = '',
        right = '',
        bold = false,
        separator = true;
}

/// Отчёт для чекового принтера: заголовок, пара строк под ним и строки.
class ReportPrint {
  final String title;
  final List<String> subtitle;
  final List<ReportLine> lines;
  final String footer;
  const ReportPrint({required this.title, this.subtitle = const [], required this.lines, this.footer = ''});
}

/// ESC/POS-байты отчёта — для 58-мм бумаги (на 80-мм печатается так же,
/// просто с полями).
Future<List<int>> buildReportBytes(ReportPrint r, {PaperSize paper = PaperSize.mm58}) async {
  final profile = await CapabilityProfile.load();
  final g = Generator(paper, profile, codec: const Cp866Codec());
  final bytes = <int>[...g.setGlobalCodeTable('CP866')];
  bytes.addAll(g.text(r.title,
      styles: const PosStyles(align: PosAlign.center, bold: true, height: PosTextSize.size2, width: PosTextSize.size2)));
  for (final line in r.subtitle) {
    bytes.addAll(g.text(line, styles: const PosStyles(align: PosAlign.center, fontType: PosFontType.fontB)));
  }
  bytes.addAll(g.hr());
  for (final l in r.lines) {
    if (l.separator) {
      bytes.addAll(g.hr());
      continue;
    }
    if (l.right.isEmpty) {
      bytes.addAll(g.text(l.left, styles: PosStyles(bold: l.bold)));
      continue;
    }
    bytes.addAll(g.row([
      PosColumn(text: l.left, width: 7, styles: PosStyles(bold: l.bold)),
      PosColumn(text: l.right, width: 5, styles: PosStyles(align: PosAlign.right, bold: l.bold)),
    ]));
  }
  if (r.footer.isNotEmpty) {
    bytes.addAll(g.hr());
    bytes.addAll(g.text(r.footer, styles: const PosStyles(align: PosAlign.center, fontType: PosFontType.fontB)));
  }
  bytes.addAll(g.feed(2));
  bytes.addAll(g.cut());
  return bytes;
}

/// Предчек: счёт гостю до оплаты. Не кассовый чек — так и написано внизу;
/// кассовый чек (54-ФЗ) выдаёт онлайн-касса после оплаты.
class PrecheckLine {
  final String name;
  final int qty;
  final double price;
  const PrecheckLine(this.name, this.qty, this.price);
  double get total => price * qty;
}

class PrecheckData {
  final String venueName;
  final String tableName;
  final String guestTag;
  final String waiter;
  final DateTime at;
  final List<PrecheckLine> lines;
  final double subtotal;
  final double discountPercent;
  final double total;
  const PrecheckData({
    required this.venueName,
    required this.tableName,
    this.guestTag = '',
    this.waiter = '',
    required this.at,
    required this.lines,
    required this.subtotal,
    this.discountPercent = 0,
    required this.total,
  });
}

/// «1 200» или «1 200.50» — копейки только если они есть.
String precheckMoney(double v) {
  final cents = (v * 100).round();
  final whole = (cents ~/ 100).toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ' ');
  final rest = cents % 100;
  return rest == 0 ? whole : '$whole.${rest.toString().padLeft(2, '0')}';
}

Future<List<int>> buildPrecheckBytes(PrecheckData d, {PaperSize paper = PaperSize.mm58}) async {
  final profile = await CapabilityProfile.load();
  final g = Generator(paper, profile, codec: const Cp866Codec());
  final bytes = <int>[...g.setGlobalCodeTable('CP866')];
  String two(int v) => v.toString().padLeft(2, '0');
  if (d.venueName.isNotEmpty) {
    bytes.addAll(g.text(d.venueName,
        styles: const PosStyles(align: PosAlign.center, bold: true, height: PosTextSize.size2, width: PosTextSize.size2)));
  }
  bytes.addAll(g.text('ПРЕДВАРИТЕЛЬНЫЙ СЧЁТ', styles: const PosStyles(align: PosAlign.center, bold: true)));
  bytes.addAll(g.feed(1));
  bytes.addAll(g.text([d.tableName, if (d.guestTag.isNotEmpty) d.guestTag].join(' · '),
      styles: const PosStyles(align: PosAlign.center)));
  if (d.waiter.isNotEmpty) {
    bytes.addAll(g.text('Вас обслуживает: ${d.waiter}', styles: const PosStyles(align: PosAlign.center, fontType: PosFontType.fontB)));
  }
  bytes.addAll(g.text('${two(d.at.day)}.${two(d.at.month)}.${d.at.year} ${two(d.at.hour)}:${two(d.at.minute)}',
      styles: const PosStyles(align: PosAlign.center, fontType: PosFontType.fontB)));
  bytes.addAll(g.hr());
  for (final l in d.lines) {
    bytes.addAll(g.text(l.name, styles: const PosStyles(bold: true)));
    bytes.addAll(g.row([
      PosColumn(text: '  ${l.qty} x ${precheckMoney(l.price)}', width: 7),
      PosColumn(text: precheckMoney(l.total), width: 5, styles: const PosStyles(align: PosAlign.right)),
    ]));
  }
  bytes.addAll(g.hr());
  if (d.discountPercent > 0 && d.subtotal > d.total) {
    bytes.addAll(g.row([
      PosColumn(text: 'Сумма', width: 7),
      PosColumn(text: precheckMoney(d.subtotal), width: 5, styles: const PosStyles(align: PosAlign.right)),
    ]));
    bytes.addAll(g.row([
      PosColumn(text: 'Скидка ${d.discountPercent.toStringAsFixed(0)}%', width: 7),
      PosColumn(text: '-${precheckMoney(d.subtotal - d.total)}', width: 5, styles: const PosStyles(align: PosAlign.right)),
    ]));
  }
  bytes.addAll(g.row([
    PosColumn(text: 'К ОПЛАТЕ', width: 6, styles: const PosStyles(bold: true, height: PosTextSize.size2)),
    PosColumn(
        text: '${precheckMoney(d.total)} р.',
        width: 6,
        styles: const PosStyles(align: PosAlign.right, bold: true, height: PosTextSize.size2)),
  ]));
  bytes.addAll(g.hr());
  bytes.addAll(g.text('Не является кассовым чеком.', styles: const PosStyles(align: PosAlign.center, fontType: PosFontType.fontB)));
  bytes.addAll(g.text('Кассовый чек выдаётся после оплаты.', styles: const PosStyles(align: PosAlign.center, fontType: PosFontType.fontB)));
  bytes.addAll(g.feed(1));
  bytes.addAll(g.text('Спасибо, что пришли к нам!', styles: const PosStyles(align: PosAlign.center)));
  bytes.addAll(g.feed(2));
  bytes.addAll(g.cut());
  return bytes;
}

/// ESC/POS-байты бегунков: цех и стол крупно — чтобы повар прочитал с
/// расстояния, позиции крупно, пожелание под позицией. Без цен.
Future<List<int>> buildKitchenSlipsBytes(List<KitchenSlip> slips, {PaperSize paper = PaperSize.mm58}) async {
  final profile = await CapabilityProfile.load();
  final g = Generator(paper, profile, codec: const Cp866Codec());
  final bytes = <int>[...g.setGlobalCodeTable('CP866')];
  String two(int v) => v.toString().padLeft(2, '0');
  for (final slip in slips) {
    bytes.addAll(g.text(slip.title,
        styles: const PosStyles(align: PosAlign.center, bold: true, height: PosTextSize.size2, width: PosTextSize.size2)));
    bytes.addAll(g.text(slip.tableName,
        styles: const PosStyles(align: PosAlign.center, bold: true, height: PosTextSize.size2, width: PosTextSize.size2)));
    final who = [if (slip.guestTag.isNotEmpty) slip.guestTag, if (slip.waiter.isNotEmpty) 'официант ${slip.waiter}'];
    if (who.isNotEmpty) {
      bytes.addAll(g.text(who.join(', '), styles: const PosStyles(align: PosAlign.center, fontType: PosFontType.fontB)));
    }
    bytes.addAll(g.text('${two(slip.at.hour)}:${two(slip.at.minute)}  ${two(slip.at.day)}.${two(slip.at.month)}',
        styles: const PosStyles(align: PosAlign.center)));
    bytes.addAll(g.hr());
    for (final l in slip.lines) {
      bytes.addAll(g.text('${l.qty} x ${l.name}${l.more ? ' (ещё)' : ''}',
          styles: const PosStyles(bold: true, height: PosTextSize.size2)));
      if (l.note.isNotEmpty) bytes.addAll(g.text('   ! ${l.note}'));
    }
    bytes.addAll(g.hr());
    bytes.addAll(g.text('Всего: ${slip.pieces} шт.', styles: const PosStyles(align: PosAlign.right, fontType: PosFontType.fontB)));
    bytes.addAll(g.feed(2));
    bytes.addAll(g.cut());
  }
  return bytes;
}

/// Общая сборка ESC/POS-байтов из [ReceiptData] — не зависит от способа
/// доставки (Bluetooth/сеть), поэтому вынесена отдельно и переиспользуется
/// обеими реализациями ниже.
Future<List<int>> _buildReceiptBytes(ReceiptData data, {PaperSize paper = PaperSize.mm58}) async {
  final profile = await CapabilityProfile.load();
  // По умолчанию библиотека кодирует текст в latin1, где кириллицы нет
  // вовсе: любой русский чек падал с «Contains invalid characters» и не
  // печатался. Чековые принтеры (Xprinter/Gprinter/Rongta/Epson) печатают
  // кириллицу в кодовой странице CP866 — включаем её командой ESC t и
  // кодируем текст тем же набором.
  final generator = Generator(paper, profile, codec: const Cp866Codec());
  final bytes = <int>[];
  bytes.addAll(generator.setGlobalCodeTable('CP866'));

  bytes.addAll(generator.text(
    data.venueName,
    styles: const PosStyles(align: PosAlign.center, bold: true, height: PosTextSize.size2, width: PosTextSize.size2),
  ));
  if (data.title.isNotEmpty) {
    bytes.addAll(generator.text(data.title, styles: const PosStyles(align: PosAlign.center, bold: true)));
  }
  bytes.addAll(generator.text('Стол: ${data.tableName}', styles: const PosStyles(align: PosAlign.center)));
  bytes.addAll(generator.text(
    'Официант: ${data.employeeName}',
    styles: const PosStyles(align: PosAlign.center, fontType: PosFontType.fontB),
  ));
  bytes.addAll(generator.hr());

  for (final line in data.items) {
    bytes.addAll(generator.row([
      PosColumn(text: line.left, width: 8, styles: PosStyles(bold: line.bold)),
      PosColumn(
        text: line.right,
        width: 4,
        styles: PosStyles(align: PosAlign.right, bold: line.bold),
      ),
    ]));
  }

  bytes.addAll(generator.hr());
  bytes.addAll(generator.row([
    PosColumn(text: 'ИТОГО', width: 6, styles: const PosStyles(bold: true, height: PosTextSize.size2)),
    PosColumn(
      text: '${data.total.toStringAsFixed(0)} ₽',
      width: 6,
      styles: const PosStyles(align: PosAlign.right, bold: true, height: PosTextSize.size2),
    ),
  ]));
  bytes.addAll(generator.text('Оплата: ${data.paymentMethod}', styles: const PosStyles(align: PosAlign.center)));
  bytes.addAll(generator.text(
    '${data.closedAt.day.toString().padLeft(2, '0')}.${data.closedAt.month.toString().padLeft(2, '0')}.${data.closedAt.year} '
    '${data.closedAt.hour.toString().padLeft(2, '0')}:${data.closedAt.minute.toString().padLeft(2, '0')}',
    styles: const PosStyles(align: PosAlign.center, fontType: PosFontType.fontB),
  ));
  bytes.addAll(generator.feed(1));
  bytes.addAll(generator.text(data.footerNote, styles: const PosStyles(align: PosAlign.center)));
  bytes.addAll(generator.cut());
  return bytes;
}

/// Кодировка CP866 («DOS-кириллица») для ESC/POS-принтеров. Символы,
/// которых в CP866 нет (₽, эмодзи, «ёлочки»), заменяются похожими или «?»,
/// а не роняют печать всего чека.
class Cp866Codec extends Encoding {
  const Cp866Codec();

  @override
  String get name => 'cp866';

  @override
  Converter<List<int>, String> get decoder => const _Cp866Decoder();

  @override
  Converter<String, List<int>> get encoder => const _Cp866Encoder();

  static const _replacements = {
    '₽': 'р.', '«': '"', '»': '"', '„': '"', '“': '"', '”': '"', '—': '-', '–': '-',
    '…': '...', '×': 'x', '‘': "'", '’': "'", '•': '*', '\u00A0': ' ',
  };

  static int? _byte(int c) {
    if (c < 0x80) return c;
    if (c >= 0x0410 && c <= 0x043F) return c - 0x0410 + 0x80; // А..п
    if (c >= 0x0440 && c <= 0x044F) return c - 0x0440 + 0xE0; // р..я
    switch (c) {
      case 0x0401: return 0xF0; // Ё
      case 0x0451: return 0xF1; // ё
      case 0x00B0: return 0xF8; // °
      case 0x00B7: return 0xFA; // ·
      case 0x2116: return 0xFC; // №
    }
    return null;
  }

  static List<int> encodeString(String text) {
    var t = text;
    _replacements.forEach((from, to) => t = t.replaceAll(from, to));
    final out = <int>[];
    for (final rune in t.runes) {
      out.add(_byte(rune) ?? 0x3F); // '?'
    }
    return out;
  }
}

class _Cp866Encoder extends Converter<String, List<int>> {
  const _Cp866Encoder();
  @override
  List<int> convert(String input) => Uint8List.fromList(Cp866Codec.encodeString(input));
}

class _Cp866Decoder extends Converter<List<int>, String> {
  const _Cp866Decoder();
  @override
  String convert(List<int> input) => String.fromCharCodes(input.map((b) {
        if (b < 0x80) return b;
        if (b >= 0x80 && b <= 0xAF) return b - 0x80 + 0x0410;
        if (b >= 0xE0 && b <= 0xEF) return b - 0xE0 + 0x0440;
        if (b == 0xF0) return 0x0401;
        if (b == 0xF1) return 0x0451;
        return 0x3F;
      }));
}

/// Bluetooth-принтер (в режиме классического SPP, как у подавляющего
/// большинства недорогих 58-мм принтеров).
class BluetoothReceiptPrinter extends ReceiptPrinter {
  /// MAC-адрес принтера — выбирается пользователем один раз на экране
  /// настроек из списка сопряжённых Bluetooth-устройств
  /// ([PrintBluetoothThermal.pairedBluetooths]) и сохраняется.
  final String macAddress;

  BluetoothReceiptPrinter({required this.macAddress});

  @override
  bool get isConnected => false; // проверяется асинхронно, см. connect()

  /// На Android 12+ плагин отказывает во ВСЕХ вызовах (список устройств,
  /// подключение, печать), пока приложение не получило разрешение
  /// «Устройства поблизости» (BLUETOOTH_CONNECT/SCAN) — его запрашивает
  /// только этот вызов, поэтому он идёт первым.
  static Future<void> ensurePermission() async {
    final granted = await PrintBluetoothThermal.isPermissionBluetoothGranted;
    if (!granted) {
      throw PrinterException('Нет разрешения «Устройства поблизости» (Bluetooth) — '
          'разрешите его приложению в настройках Android и повторите.');
    }
  }

  @override
  Future<bool> connect() async {
    await ensurePermission();
    final result = await PrintBluetoothThermal.connect(macPrinterAddress: macAddress);
    return result;
  }

  @override
  Future<void> disconnect() async {
    await PrintBluetoothThermal.disconnect;
  }

  @override
  Future<void> printReceipt(ReceiptData data) async => printBytes(await _buildReceiptBytes(data));

  @override
  Future<void> printBytes(List<int> bytes) async {
    await ensurePermission();
    final connected = await PrintBluetoothThermal.connectionStatus;
    if (!connected) {
      final ok = await connect();
      if (!ok) {
        throw PrinterException('Не удалось подключиться к принтеру по Bluetooth ($macAddress)');
      }
    }
    final ok = await PrintBluetoothThermal.writeBytes(bytes);
    if (!ok) throw PrinterException('Принтер ($macAddress) не принял данные — проверьте, что он включён и рядом');
  }

  /// Список уже сопряжённых в системе Bluetooth-устройств — для экрана
  /// выбора принтера в настройках (сначала пара выполняется в системных
  /// настройках Bluetooth телефона, здесь только выбор из списка).
  static Future<List<BluetoothInfo>> pairedDevices() async {
    await ensurePermission();
    return PrintBluetoothThermal.pairedBluetooths;
  }
}

/// Сетевой принтер (Wi-Fi/LAN), сырой ESC/POS по TCP на порт 9100 —
/// стандартный "RAW/JetDirect" порт, которым пользуется большинство
/// сетевых чековых принтеров.
class NetworkReceiptPrinter extends ReceiptPrinter {
  final String ip;
  final int port;
  Socket? _socket;

  NetworkReceiptPrinter({required this.ip, this.port = 9100});

  @override
  bool get isConnected => _socket != null;

  @override
  Future<bool> connect() async {
    try {
      _socket = await Socket.connect(ip, port, timeout: const Duration(seconds: 5));
      return true;
    } catch (_) {
      _socket = null;
      return false;
    }
  }

  @override
  Future<void> disconnect() async {
    await _socket?.close();
    _socket = null;
  }

  @override
  Future<void> printReceipt(ReceiptData data) async => printBytes(await _buildReceiptBytes(data));

  @override
  Future<void> printBytes(List<int> bytes) async {
    try {
      await _send(bytes);
    } catch (_) {
      // Удержанное соединение могло умереть (принтер перезагрузили, Wi-Fi
      // моргнул) — без сброса все следующие чеки падали бы до перезапуска.
      if (_socket == null) rethrow;
      _socket?.destroy();
      _socket = null;
      await _send(bytes);
    }
  }

  Future<void> _send(List<int> bytes) async {
    try {
      final socket = _socket ?? await Socket.connect(ip, port, timeout: const Duration(seconds: 5));
      socket.add(bytes);
      await socket.flush();
      if (_socket == null) await socket.close();
    } catch (e) {
      throw PrinterException('Не удалось напечатать на сетевом принтере $ip:$port — $e');
    }
  }
}

class PrinterException implements Exception {
  final String message;
  PrinterException(this.message);
  @override
  String toString() => message;
}

/// Единая точка получения активного принтера — в настройках интеграций
/// пользователь выбирает тип подключения, здесь просто хранится текущий
/// выбор для остального приложения (аналогично [paymentTerminalService]
/// в payment_terminal_service.dart).
ReceiptPrinter? activeReceiptPrinter;

/// Кальяны печатать отдельным чеком, а кухню и бар — другим (настройка
/// settings/integrations.printSplitHookah, по умолчанию включена).
bool printHookahSeparately = true;

/// Печатать бегунки на кухню и бар: в счёте стола появляется кнопка «На
/// кухню» для новых позиций (settings/integrations.printKitchenTickets, по
/// умолчанию выключено — кому хватает экрана «Кухня и бар»).
bool printKitchenTickets = false;

/// Отправлять бегунок сам, как только официант вернулся из меню в счёт
/// (settings/integrations.printKitchenAuto).
bool printKitchenAuto = false;

/// Сетевые принтеры цехов (IP, порт 9100): бегунки кухни — на кухонный,
/// бара и кальянов — на барный. Пусто — на чековый принтер кассы.
String kitchenPrinterIp = '';
String barPrinterIp = '';

/// Принтер для бегунка цеха [station] и ключ, по которому бегунки одного
/// принтера печатаются одним заходом. null — принтера нет совсем.
(ReceiptPrinter, String)? printerForStation(String station) {
  final ip = (station == 'kitchen' ? kitchenPrinterIp : barPrinterIp).trim();
  if (ip.isNotEmpty) return (NetworkReceiptPrinter(ip: ip), 'ip:$ip');
  final main = activeReceiptPrinter;
  return main == null ? null : (main, 'main');
}

void _applyPrintFlags(Map<String, dynamic> data) {
  printHookahSeparately = data['printSplitHookah'] as bool? ?? true;
  printKitchenTickets = data['printKitchenTickets'] as bool? ?? false;
  printKitchenAuto = data['printKitchenAuto'] as bool? ?? false;
  kitchenPrinterIp = (data['kitchenPrinterIp'] as String? ?? '').trim();
  barPrinterIp = (data['barPrinterIp'] as String? ?? '').trim();
  // Агрегаторы доставки — для окна оплаты: тот же документ настроек, и
  // так же подхватываются, если админ поменял их на другом устройстве.
  applyAggregatorSettings(data);
}

DateTime? _printFlagsAt;

/// Перечитывает флаги печати (кальяны отдельно, бегунки) без пересоздания
/// принтера — админ мог переключить их в «Интеграциях» на другом
/// устройстве, а планшет официанта работает сутками. Не чаще раза в 5 минут.
Future<void> refreshPrintFlags() async {
  final now = DateTime.now();
  if (_printFlagsAt != null && now.difference(_printFlagsAt!) < const Duration(minutes: 5)) return;
  _printFlagsAt = now;
  try {
    final data = (await AppScope.col('settings').doc('integrations').get()).data();
    if (data == null) return;
    _applyPrintFlags(data);
  } catch (_) {
    // Нет сети — остаются прежние значения.
  }
}

/// Подтягивает сохранённые настройки принтера (settings/integrations) и
/// заполняет [activeReceiptPrinter] — вызывается один раз при старте
/// приложения (см. main.dart), чтобы официанту не нужно было заново
/// заходить в настройки на каждом планшете/после переустановки.
Future<void> loadSavedPrinterSettings() async {
  try {
    final doc = await AppScope.col('settings').doc('integrations').get();
    final data = doc.data();
    if (data == null) return;
    _applyPrintFlags(data);
    final type = data['printerType'] as String? ?? 'none';
    // На Windows print_bluetooth_thermal идёt через BLE (win_ble), а не
    // classic-SPP, на котором держится подавляющее большинство дешёвых
    // 58/80-мм принтеров — см. подробный комментарий в
    // integrations_settings_screen.dart._applyActivePrinter. Настройка
    // общая на все устройства заведения, поэтому Windows-планшет просто не
    // применяет её, вместо того чтобы обманчиво "подключаться".
    if (type == 'bluetooth' && !isWindowsApp && !kIsWeb) {
      final mac = data['printerBtMac'] as String? ?? '';
      if (mac.isNotEmpty) activeReceiptPrinter = BluetoothReceiptPrinter(macAddress: mac);
    } else if (type == 'network') {
      final ip = data['printerIp'] as String? ?? '';
      if (ip.isNotEmpty) activeReceiptPrinter = NetworkReceiptPrinter(ip: ip);
    }
  } catch (_) {
    // Нет сети/документа при первом запуске — не критично, принтер просто
    // останется не настроен до захода в Настройки → Интеграции.
  }
}