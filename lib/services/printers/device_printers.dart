import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../utils/adaptive.dart';
import '../printer_service.dart';
import 'windows_spool_stub.dart' if (dart.library.ffi) 'windows_spool_ffi.dart' as spool;

/// Принтер, подключённый к САМОМУ устройству (только SaaS). Хранится в
/// памяти устройства, а не в общих настройках заведения: USB-принтер
/// воткнут в одну кассу, а телефоны официантов печатают через неё
/// (облачная печать, print_hub.dart).
///
/// * `rawbt` — Android: USB/OTG-принтер через бесплатное приложение RawBT
///   (оно держит USB-подключение и сырой ESC/POS; чек передаётся ссылкой
///   `rawbt:base64,…`).
/// * `system` — Windows: любой принтер из «Устройства и принтеры» (USB,
///   COM, общий сетевой), байты уходят сырыми в очередь печати Windows.
class DevicePrinterPrefs {
  DevicePrinterPrefs._();

  static const _kType = 'zal_print_device_type';
  static const _kName = 'zal_print_device_name';
  static const _kHub = 'zal_print_hub';

  /// '' — нет своего принтера (тогда — общий из настроек заведения).
  static String type = '';

  /// Имя принтера Windows (для `system`).
  static String name = '';

  /// Это устройство печатает за всех: принимает облачную печать.
  static bool hub = false;

  static Future<void> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      type = p.getString(_kType) ?? '';
      name = p.getString(_kName) ?? '';
      hub = p.getBool(_kHub) ?? false;
    } catch (_) {}
  }

  static Future<void> save({required String type, String name = '', required bool hub}) async {
    DevicePrinterPrefs.type = type;
    DevicePrinterPrefs.name = name;
    DevicePrinterPrefs.hub = hub;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_kType, type);
      await p.setString(_kName, name);
      await p.setBool(_kHub, hub);
    } catch (_) {}
  }

  /// Принтер этого устройства или null (не задан или не подходит к
  /// платформе: RawBT — только Android, принтер Windows — только Windows).
  static ReceiptPrinter? printer() {
    if (type == 'rawbt' && isAndroidApp) return RawBtReceiptPrinter();
    if (type == 'system' && isWindowsApp && name.trim().isNotEmpty) return WindowsSystemPrinter(name.trim());
    return null;
  }
}

/// USB/OTG на Android через приложение RawBT: оно само держит
/// USB-подключение и разрешение на устройство, мы передаём ему готовые
/// ESC/POS-байты ссылкой `rawbt:base64,<данные>`.
class RawBtReceiptPrinter extends ReceiptPrinter {
  RawBtReceiptPrinter({this.launcher});

  /// Для тестов: подмена запуска ссылки.
  final Future<bool> Function(Uri uri)? launcher;

  static Uri uriFor(List<int> bytes) => Uri.parse('rawbt:base64,${base64Encode(bytes)}');

  @override
  bool get isConnected => true;

  @override
  Future<bool> connect() async => true;

  @override
  Future<void> disconnect() async {}

  @override
  Future<void> printBytes(List<int> bytes) async {
    final uri = uriFor(bytes);
    bool ok;
    try {
      ok = launcher != null ? await launcher!(uri) : await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      throw PrinterException('Не открылось приложение RawBT. Установите «RawBT» из магазина приложений, '
          'подключите в нём принтер по USB и нажмите там «Тест».');
    }
  }
}

/// Принтер Windows по имени: байты ESC/POS уходят в очередь печати сырыми
/// (тип данных RAW), как у «Generic / Text Only». Подходит для USB-принтеров
/// с драйвером производителя и для принтера, расшаренного по сети.
class WindowsSystemPrinter extends ReceiptPrinter {
  WindowsSystemPrinter(this.name);
  final String name;

  @override
  bool get isConnected => true;

  @override
  Future<bool> connect() async => true;

  @override
  Future<void> disconnect() async {}

  @override
  Future<void> printBytes(List<int> bytes) async {
    if (!isWindowsApp) throw PrinterException('Принтер Windows доступен только в кассе для Windows');
    final err = await spool.rawPrint(name, bytes);
    if (err != null) throw PrinterException('Принтер «$name»: $err');
  }
}

/// Принтеры, установленные в Windows (пусто на других системах).
Future<List<String>> windowsPrinters() async => isWindowsApp ? await spool.listPrinters() : const <String>[];
