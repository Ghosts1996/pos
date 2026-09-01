import 'dart:async';
import 'dart:io';
import 'package:cloud_firestore/cloud_firestore.dart';
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
library printer_service;

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
  final generator = Generator(paper, profile);
  final bytes = <int>[];

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
class BluetoothReceiptPrinter implements ReceiptPrinter {
  /// MAC-адрес принтера — выбирается пользователем один раз на экране
  /// настроек из списка сопряжённых Bluetooth-устройств
  /// ([PrintBluetoothThermal.pairedBluetooths]) и сохраняется.
  final String macAddress;

  BluetoothReceiptPrinter({required this.macAddress});

  @override
  bool get isConnected => false; // проверяется асинхронно, см. connect()

  @override
  Future<bool> connect() async {
    final result = await PrintBluetoothThermal.connect(macPrinterAddress: macAddress);
    return result;
  }

  @override
  Future<void> disconnect() async {
    await PrintBluetoothThermal.disconnect;
  }

  @override
  Future<void> printReceipt(ReceiptData data) async {
    final connected = await PrintBluetoothThermal.connectionStatus;
    if (!connected) {
      final ok = await connect();
      if (!ok) {
        throw PrinterException('Не удалось подключиться к принтеру по Bluetooth ($macAddress)');
      }
    }
    final bytes = await _buildReceiptBytes(data);
    await PrintBluetoothThermal.writeBytes(bytes);
  }

  /// Список уже сопряжённых в системе Bluetooth-устройств — для экрана
  /// выбора принтера в настройках (сначала пара выполняется в системных
  /// настройках Bluetooth телефона, здесь только выбор из списка).
  static Future<List<BluetoothInfo>> pairedDevices() {
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
    final doc = await FirebaseFirestore.instance.collection('settings').doc('integrations').get();
    final data = doc.data();
    if (data == null) return;
    final type = data['printerType'] as String? ?? 'none';
    if (type == 'bluetooth') {
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