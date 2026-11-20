import 'dart:convert';
import 'dart:io';

import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/printer_service.dart';
import 'package:hookah_pos/services/printers/device_printers.dart';
import 'package:hookah_pos/services/printers/lan_scan.dart';

class _Capture extends ReceiptPrinter {
  final sent = <List<int>>[];
  @override
  bool get isConnected => true;
  @override
  Future<bool> connect() async => true;
  @override
  Future<void> disconnect() async {}
  @override
  Future<void> printBytes(List<int> bytes) async => sent.add(bytes);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    printPaper = PaperSize.mm58;
    printEncoding = 'cp866';
    activeReceiptPrinter = null;
  });

  test('Windows-1251: русские буквы, Ё, кавычки, рубль', () {
    const c = Cp1251Codec();
    expect(c.encode('Аля'), [0xC0, 0xEB, 0xFF]);
    expect(c.encode('Ёё№'), [0xA8, 0xB8, 0xB9]);
    expect(c.encode('«чай» — 1₽'), [0xAB, 0xF7, 0xE0, 0xE9, 0xBB, 0x20, 0x97, 0x20, 0x31, 0xF0, 0x2E]);
    expect(c.decode(c.encode('Привет, Ёжик!')), 'Привет, Ёжик!');
  });

  test('кодировка — верная команда ESC t в начале документа', () async {
    final profile = await CapabilityProfile.load();
    expect(escPosGenerator(profile, encoding: 'cp866').$2, [0x1B, 0x74, 17]);
    expect(escPosGenerator(profile, encoding: 'cp1251').$2, [0x1B, 0x74, 46]);
    expect(escPosGenerator(profile, encoding: 'cp1251x').$2, [0x1B, 0x74, 73]);
    expect(escPosGenerator(profile, encoding: 'utf8').$2, isEmpty);
    // По умолчанию — как было всегда: CP866.
    final bytes = await buildPrecheckBytes(PrecheckData(
      venueName: 'Тест',
      tableName: 'Стол 1',
      at: DateTime(2026, 11, 20, 12),
      lines: const [PrecheckLine('Чай', 1, 100)],
      subtotal: 100,
      total: 100,
    ));
    expect(bytes.take(3).toList(), [0x1B, 0x74, 17]);
    printEncoding = 'cp1251';
    final w = await buildPrecheckBytes(PrecheckData(
      venueName: 'Тест',
      tableName: 'Стол 1',
      at: DateTime(2026, 11, 20, 12),
      lines: const [PrecheckLine('Чай', 1, 100)],
      subtotal: 100,
      total: 100,
    ));
    expect(w.take(3).toList(), [0x1B, 0x74, 46]);
    expect(_contains(w, const Cp1251Codec().encode('Чай')), isTrue);
  });

  test('80 мм — строка шире, чем на 58 мм', () async {
    final profile = await CapabilityProfile.load();
    final g58 = escPosGenerator(profile, paper: PaperSize.mm58).$1;
    final g80 = escPosGenerator(profile, paper: PaperSize.mm80).$1;
    final long = 'Ж' * 40;
    // На 58 мм 40 символов переносятся на вторую строку, на 80 мм — нет.
    final n58 = g58.text(long).where((b) => b == 0x0A).length;
    final n80 = g80.text(long).where((b) => b == 0x0A).length;
    expect(n80, lessThanOrEqualTo(n58));
    expect(g80.row([PosColumn(text: 'Итого', width: 6), PosColumn(text: '100', width: 6)]), isNotEmpty);
  });

  test('денежный ящик: ESC p на чековый принтер', () async {
    expect(await openCashDrawer(), isNotNull, reason: 'без принтера — понятная ошибка');
    final p = _Capture();
    activeReceiptPrinter = p;
    expect(await openCashDrawer(), isNull);
    expect(p.sent.single, [0x1B, 0x70, 0x00, 0x19, 0xFA]);
  });

  test('RawBT: чек уходит ссылкой rawbt:base64, без приложения — подсказка', () async {
    Uri? got;
    final ok = RawBtReceiptPrinter(launcher: (u) async {
      got = u;
      return true;
    });
    await ok.printBytes([0x1B, 0x40, 0xC0]);
    expect(got.toString(), 'rawbt:base64,${base64Encode([0x1B, 0x40, 0xC0])}');
    final none = RawBtReceiptPrinter(launcher: (_) async => false);
    expect(() => none.printBytes([1]), throwsA(isA<PrinterException>().having((e) => e.message, 'm', contains('RawBT'))));
  });

  test('принтер устройства: RawBT только на Android, Windows — только на Windows', () {
    try {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      DevicePrinterPrefs.type = 'rawbt';
      expect(DevicePrinterPrefs.printer(), isA<RawBtReceiptPrinter>());
      DevicePrinterPrefs.type = 'system';
      DevicePrinterPrefs.name = 'XP-58';
      expect(DevicePrinterPrefs.printer(), isNull, reason: 'принтер Windows на Android не применяется');
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      expect((DevicePrinterPrefs.printer() as WindowsSystemPrinter).name, 'XP-58');
      DevicePrinterPrefs.type = 'rawbt';
      expect(DevicePrinterPrefs.printer(), isNull, reason: 'RawBT на Windows не применяется');
    } finally {
      debugDefaultTargetPlatformOverride = null;
      DevicePrinterPrefs.type = '';
      DevicePrinterPrefs.name = '';
    }
  });

  test('«Найти в сети»: находит открытый порт и пропускает закрытый', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((s) => s.destroy());
    final closed = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final closedPort = closed.port;
    await closed.close();
    try {
      expect(await scanLanPrinters(port: server.port, hosts: ['127.0.0.1']), ['127.0.0.1']);
      expect(await scanLanPrinters(port: closedPort, hosts: ['127.0.0.1']), isEmpty);
    } finally {
      await server.close();
    }
    expect(isPrivateLan('192.168.1.5'), isTrue);
    expect(isPrivateLan('172.20.0.1'), isTrue);
    expect(isPrivateLan('8.8.8.8'), isFalse);
  });

  test('сетевой принтер не ответил: причина про принтер, а не «нет связи с сервером»', () {
    final router = networkPrinterError('192.168.0.1', 9100, const SocketException('Connection refused'));
    expect(router, contains('Принтер 192.168.0.1 не отвечает'));
    expect(router, contains('не принтер'));
    expect(router, contains('у роутера'));
    expect(router.toLowerCase(), isNot(contains('socketexception')));
    final none = networkPrinterError('192.168.0.57', 9100, const SocketException('Connection timed out'));
    expect(none, contains('никого нет'));
    expect(none, isNot(contains('роутера')));
  });

  test('не нашли принтер: подсказка с адресом устройства, про FEED и VPN', () {
    expect(isVpnInterface('tun0'), isTrue);
    expect(isVpnInterface('ppp0'), isTrue);
    expect(isVpnInterface('wlan0'), isFalse);
    final h = lanNotFoundHint((own: ['192.168.0.105'], vpn: true));
    expect(h, contains('192.168.0.105'));
    expect(h, contains('192.168.0.…'));
    expect(h, contains('FEED'));
    expect(h, contains('VPN'));
    expect(lanNotFoundHint((own: const <String>[], vpn: false)), contains('не подключено к Wi-Fi'));
    expect(lanNotFoundHint((own: ['10.0.0.5'], vpn: false)), isNot(contains('VPN')));
  });
}

bool _contains(List<int> hay, List<int> needle) {
  for (var i = 0; i + needle.length <= hay.length; i++) {
    var ok = true;
    for (var j = 0; j < needle.length; j++) {
      if (hay[i + j] != needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}
