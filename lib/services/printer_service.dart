import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'app_scope.dart';
import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';
import 'package:print_bluetooth_thermal/print_bluetooth_thermal.dart';

/// Печать простого информационного чека (не фискального — этот проект
/// работает без кассы, см. README) на маленьком 58/80-мм чековом принтере.
///
/// Такие принтеры почти всегда понимают набор команд ESC/POS — он тут и
/// используется. Поддержаны два самых распространённых способа подключения
/// для мобильного приложения:
///   • Bluetooth (пакет `print_bluetooth_thermal`, Android/iOS);
///   • Wi-Fi/LAN — принтер слушает сырой ESC/POS на TCP-порту 9100
///     (стандарт для сетевых чековых принтеров, включая большинство
///     Xprinter/Gprinter/Rongta с Wi-Fi-модулем).
/// USB-принтер (провод в планшет) на Android тоже реализуем, но требует
/// отдельного платформенного плагина с доступом к USB Host API
/// (например, `flutter_usb_printer`) — сюда специально не включён, чтобы
/// не тащить лишнюю нативную интеграцию, пока не известна конкретная
/// модель принтера; подключается тем же способом, что и два ниже — через
/// интерфейс [ReceiptPrinter].
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
  final String tableName;
  final String employeeName;
  final DateTime closedAt;
  final List<ReceiptLine> items;
  final double total;
  final String paymentMethod; // "Наличные" / "Карта"
  final String footerNote;

  const ReceiptData({
    required this.venueName,
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

/// Bluetooth-принтер (в режиме классического SPP, как у подавляющего
/// большинства недорогих 58-мм принтеров).
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

class BluetoothReceiptPrinter implements ReceiptPrinter {
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
  Future<void> printReceipt(ReceiptData data) async {
    await ensurePermission();
    final connected = await PrintBluetoothThermal.connectionStatus;
    if (!connected) {
      final ok = await connect();
      if (!ok) {
        throw PrinterException('Не удалось подключиться к принтеру по Bluetooth ($macAddress)');
      }
    }
    final bytes = await _buildReceiptBytes(data);
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
class NetworkReceiptPrinter implements ReceiptPrinter {
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
  Future<void> printReceipt(ReceiptData data) async {
    final bytes = await _buildReceiptBytes(data);
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

/// Подтягивает сохранённые настройки принтера (settings/integrations) и
/// заполняет [activeReceiptPrinter] — вызывается один раз при старте
/// приложения (см. main.dart), чтобы официанту не нужно было заново
/// заходить в настройки на каждом планшете/после переустановки.
Future<void> loadSavedPrinterSettings() async {
  try {
    final doc = await AppScope.col('settings').doc('integrations').get();
    final data = doc.data();
    if (data == null) return;
    final type = data['printerType'] as String? ?? 'none';
    // На Windows print_bluetooth_thermal идёt через BLE (win_ble), а не
    // classic-SPP, на котором держится подавляющее большинство дешёвых
    // 58/80-мм принтеров — см. подробный комментарий в
    // integrations_settings_screen.dart._applyActivePrinter. Настройка
    // общая на все устройства заведения, поэтому Windows-планшет просто не
    // применяет её, вместо того чтобы обманчиво "подключаться".
    if (type == 'bluetooth' && !Platform.isWindows) {
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