import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

/// Сигнал между устройствами заведения по локальной сети.
class LanMessage {
  /// [LanKind]: новый заказ цеху, «готово» официанту.
  final String kind;
  final String tenantId;

  /// Случайный id — по нему отбрасываются повторы (каждый пакет шлётся
  /// дважды: UDP в Wi‑Fi теряется).
  final String id;
  final DateTime at;
  final Map<String, dynamic> data;

  const LanMessage({required this.kind, required this.tenantId, required this.id, required this.at, this.data = const {}});

  String get sessionId => (data['s'] ?? '').toString();
  String get tableName => (data['tb'] ?? '').toString();
  String get summary => (data['x'] ?? '').toString();
  String get station => (data['st'] ?? '').toString();
  String get waiterId => (data['w'] ?? '').toString();

  /// Строки чека, о которых сигнал: id строк (новый заказ) или
  /// «строка → сколько готово» (готово).
  List<String> get lineIds => [for (final l in (data['l'] as List? ?? const [])) l.toString()];
  Map<String, int> get readyLines => {
        for (final e in ((data['r'] as Map?) ?? const {}).entries) e.key.toString(): (e.value as num).toInt(),
      };
}

class LanKind {
  LanKind._();
  static const kitchenOrder = 'order';
  static const dishReady = 'ready';
  static const ping = 'ping';
}

/// Порт сигналов ZalPOS в локальной сети.
const lanSignalPort = 47321;

/// Старше этого сигнал не принимаем: повтор записанного пакета через
/// час не должен звенеть на кухне.
const lanMaxAge = Duration(minutes: 10);

/// Пакет больше этого в Wi‑Fi может разбиться — текст укорачиваем.
const lanMaxBytes = 1200;

String newLanId([Random? rnd]) {
  final r = rnd ?? Random.secure();
  return List.generate(12, (_) => r.nextInt(36).toRadixString(36)).join();
}

/// Новый ключ подписи заведения: 32 случайных байта в hex.
String newLanKey([Random? rnd]) {
  final r = rnd ?? Random.secure();
  return List.generate(32, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}

String _sign(String key, String kind, String tenant, String id, int ts, String body) =>
    Hmac(sha256, utf8.encode(key)).convert(utf8.encode('z1|$tenant|$kind|$id|$ts|$body')).toString();

List<int> encodeLanMessage(LanMessage m, String key) {
  var data = Map<String, dynamic>.from(m.data);
  List<int> build() {
    final body = jsonEncode(data);
    final ts = m.at.millisecondsSinceEpoch;
    return utf8.encode(jsonEncode({
      'z': 1,
      't': m.tenantId,
      'k': m.kind,
      'i': m.id,
      'ts': ts,
      'd': body,
      's': _sign(key, m.kind, m.tenantId, m.id, ts, body),
    }));
  }

  var bytes = build();
  // Длинный список блюд режем, а не теряем сигнал целиком.
  while (bytes.length > lanMaxBytes && (data['x'] ?? '').toString().length > 20) {
    final x = data['x'].toString();
    data = {...data, 'x': '${x.substring(0, (x.length * 0.7).floor())}…'};
    bytes = build();
  }
  return bytes;
}

/// Разбирает и проверяет пакет. null — чужое заведение, неверная подпись,
/// старый пакет или вообще не наш формат.
LanMessage? decodeLanMessage(List<int> bytes, {required String key, required String tenantId, DateTime? now}) {
  if (key.isEmpty || bytes.length > 4096) return null;
  try {
    final j = jsonDecode(utf8.decode(bytes));
    if (j is! Map || j['z'] != 1) return null;
    final tenant = (j['t'] ?? '').toString();
    final kind = (j['k'] ?? '').toString();
    final id = (j['i'] ?? '').toString();
    final ts = j['ts'];
    final body = j['d'];
    if (tenant != tenantId || ts is! int || body is! String || id.isEmpty) return null;
    final expected = _sign(key, kind, tenant, id, ts, body);
    if (!_sameDigest(expected, (j['s'] ?? '').toString())) return null;
    final at = DateTime.fromMillisecondsSinceEpoch(ts);
    final age = (now ?? DateTime.now()).difference(at).abs();
    if (age > lanMaxAge) return null;
    final data = jsonDecode(body);
    if (data is! Map) return null;
    return LanMessage(kind: kind, tenantId: tenant, id: id, at: at, data: Map<String, dynamic>.from(data));
  } catch (_) {
    return null;
  }
}

/// Сравнение без раннего выхода — подпись не подбирается по времени ответа.
bool _sameDigest(String a, String b) {
  if (a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
  }
  return diff == 0;
}
