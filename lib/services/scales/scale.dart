import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:shared_preferences/shared_preferences.dart';

import 'win_serial.dart';

/// Показание весов: вес в кг и «стабильно» (груз не качается).
class ScaleReading {
  final double kg;
  final bool stable;
  const ScaleReading(this.kg, this.stable);
}

/// Весы этого устройства (память устройства): нет / «Масса-К» по сети
/// (протокол 100, TCP) / COM-порт на Windows (весы шлют вес строкой —
/// CAS, «Штрих», «Масса-К» в режиме «непрерывная передача»).
class ScalePrefs {
  ScalePrefs._();
  static const _k = 'zal_scale_';
  static String type = ''; // '' | massak | com
  static String host = '';
  static int port = 5001;
  static String com = 'COM3';
  static int baud = 9600;
  static String request = ''; // '' | enq | w — что послать, чтобы весы ответили

  static Future<void> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      type = p.getString('${_k}type') ?? '';
      host = p.getString('${_k}host') ?? '';
      port = p.getInt('${_k}port') ?? 5001;
      com = p.getString('${_k}com') ?? 'COM3';
      baud = p.getInt('${_k}baud') ?? 9600;
      request = p.getString('${_k}req') ?? '';
    } catch (_) {}
  }

  static Future<void> save() async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString('${_k}type', type);
      await p.setString('${_k}host', host);
      await p.setInt('${_k}port', port);
      await p.setString('${_k}com', com);
      await p.setInt('${_k}baud', baud);
      await p.setString('${_k}req', request);
    } catch (_) {}
  }

  static bool get configured =>
      (type == 'massak' && host.isNotEmpty) || (type == 'com' && Platform.isWindows && com.isNotEmpty);
}

/// Прочитать вес с настроенных весов. Ошибка — исключение с понятным текстом.
Future<ScaleReading> readScale() async {
  switch (ScalePrefs.type) {
    case 'massak':
      return readMassaK(ScalePrefs.host, ScalePrefs.port);
    case 'com':
      if (!Platform.isWindows) throw StateError('Весы через COM-порт — только на кассе с Windows');
      final bytes = await readComPort(ScalePrefs.com, ScalePrefs.baud, request: _requestBytes(ScalePrefs.request));
      final r = parseScaleText(String.fromCharCodes(bytes));
      if (r == null) throw StateError('Весы ничего понятного не прислали — проверьте порт, скорость и режим передачи');
      return r;
    default:
      throw StateError('Весы не настроены');
  }
}

List<int> _requestBytes(String r) => switch (r) {
      'enq' => const [0x05],
      'w' => const [0x57, 0x0D],
      _ => const [],
    };

// ---------- «Масса-К», протокол 100 (TCP, порт 5001) ----------

const _header = [0xF8, 0x55, 0xCE];
const cmdGetMassa = 0x23;
const cmdAckMassa = 0x24;
const cmdError = 0x28;

/// CRC16 протокола (полином 0x1021, начальное значение 0).
int crc16(List<int> data) {
  var crc = 0;
  for (final b in data) {
    crc ^= (b & 0xFF) << 8;
    for (var i = 0; i < 8; i++) {
      crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

/// Пакет команды: заголовок, длина тела (LE), тело, CRC тела (LE).
List<int> massaKPacket(int cmd, [List<int> data = const []]) {
  final body = [cmd, ...data];
  final crc = crc16(body);
  return [..._header, body.length & 0xFF, body.length >> 8, ...body, crc & 0xFF, crc >> 8];
}

/// Разбор ответа CMD_ACK_MASSA: вес (int32 LE), цена деления, стабильность.
ScaleReading? parseMassaK(List<int> bytes) {
  for (var i = 0; i + 5 < bytes.length; i++) {
    if (bytes[i] != _header[0] || bytes[i + 1] != _header[1] || bytes[i + 2] != _header[2]) continue;
    final len = bytes[i + 3] | (bytes[i + 4] << 8);
    final start = i + 5;
    if (len < 1 || start + len > bytes.length) return null;
    final body = bytes.sublist(start, start + len);
    if (body[0] == cmdError) throw StateError('Весы ответили ошибкой ${body.length > 1 ? body[1] : ''}');
    if (body[0] != cmdAckMassa || body.length < 7) return null;
    final raw = ByteData.sublistView(Uint8List.fromList(body.sublist(1, 5))).getInt32(0, Endian.little);
    final division = body[5];
    final stable = body[6] == 1;
    const perUnit = {0: 0.0001, 1: 0.001, 2: 0.01, 3: 0.1, 4: 1.0};
    final k = perUnit[division] ?? 0.001;
    return ScaleReading(((raw * k) * 1000).roundToDouble() / 1000, stable);
  }
  return null;
}

Future<ScaleReading> readMassaK(String host, int port, {Duration timeout = const Duration(seconds: 3)}) async {
  final Socket s;
  try {
    s = await Socket.connect(host, port, timeout: timeout);
  } catch (_) {
    throw StateError('Весы $host:$port не отвечают — проверьте адрес и что весы в сети');
  }
  final buf = <int>[];
  final done = Completer<ScaleReading>();
  final sub = s.listen((d) {
    buf.addAll(d);
    try {
      final r = parseMassaK(buf);
      if (r != null && !done.isCompleted) done.complete(r);
    } catch (e) {
      if (!done.isCompleted) done.completeError(e);
    }
  }, onError: (Object e) {
    if (!done.isCompleted) done.completeError(StateError('Связь с весами оборвалась'));
  });
  try {
    s.add(massaKPacket(cmdGetMassa));
    await s.flush();
    return await done.future.timeout(timeout, onTimeout: () => throw StateError('Весы не прислали вес'));
  } finally {
    await sub.cancel();
    s.destroy();
  }
}

// ---------- Весы, которые шлют вес текстом (COM-порт) ----------

/// «ST,GS,+  0.350kg», «US,NT,  350 g», «W: 1,250 kg», «0.350» — берём
/// последнюю строку с числом. «US» — нестабильно. Без единиц — кг, если
/// есть точка, иначе граммы.
ScaleReading? parseScaleText(String text) {
  final lines = text.split(RegExp(r'[\r\n\x02\x03]+')).where((l) => l.trim().isNotEmpty).toList();
  for (final line in lines.reversed) {
    final m = RegExp(r'([-+]?)\s*(\d+(?:[.,]\d+)?)\s*(kg|кг|g|г)?', caseSensitive: false).firstMatch(line);
    if (m == null) continue;
    final v = double.parse(m.group(2)!.replaceAll(',', '.'));
    final unit = (m.group(3) ?? '').toLowerCase();
    final hasDot = m.group(2)!.contains(RegExp('[.,]'));
    final kg = unit.startsWith('k') || unit.startsWith('к') ? v : (unit.isNotEmpty ? v / 1000 : (hasDot ? v : v / 1000));
    final up = line.toUpperCase();
    final stable = !up.contains('US') && !up.contains('UNST');
    return ScaleReading(m.group(1) == '-' ? -kg : kg, stable);
  }
  return null;
}
