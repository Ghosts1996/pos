import 'dart:async';
import 'dart:io';

/// «Найти в сети»: ищет чековые принтеры в локальной сети — устройства, у
/// которых открыт порт 9100 (RAW/JetDirect, им печатают почти все сетевые
/// чековые принтеры). Перебираются адреса своих подсетей /24 (до 4 штук),
/// по 64 соединения разом, так что поиск занимает пару секунд.
Future<List<String>> scanLanPrinters({
  int port = 9100,
  Duration timeout = const Duration(milliseconds: 450),
  List<String>? hosts,
  int parallel = 64,
}) async {
  final targets = hosts ?? await _subnetHosts();
  final found = <String>[];
  var next = 0;
  Future<void> worker() async {
    while (next < targets.length) {
      final host = targets[next++];
      try {
        final s = await Socket.connect(host, port, timeout: timeout);
        s.destroy();
        found.add(host);
      } catch (_) {}
    }
  }

  await Future.wait([for (var i = 0; i < parallel && i < targets.length; i++) worker()]);
  found.sort(_byAddress);
  return found;
}

int _byAddress(String a, String b) {
  final pa = a.split('.').map((e) => int.tryParse(e) ?? 0).toList();
  final pb = b.split('.').map((e) => int.tryParse(e) ?? 0).toList();
  for (var i = 0; i < pa.length && i < pb.length; i++) {
    if (pa[i] != pb[i]) return pa[i] - pb[i];
  }
  return pa.length - pb.length;
}

/// Частный адрес локальной сети (10.x, 172.16–31.x, 192.168.x).
bool isPrivateLan(String ip) {
  final p = ip.split('.').map((e) => int.tryParse(e) ?? -1).toList();
  if (p.length != 4) return false;
  return p[0] == 10 || (p[0] == 172 && p[1] >= 16 && p[1] <= 31) || (p[0] == 192 && p[1] == 168);
}

Future<List<String>> _subnetHosts() async {
  final own = <String>{};
  final subnets = <String>{};
  try {
    for (final ni in await NetworkInterface.list(type: InternetAddressType.IPv4)) {
      for (final a in ni.addresses) {
        if (!isPrivateLan(a.address)) continue;
        own.add(a.address);
        final p = a.address.split('.');
        subnets.add('${p[0]}.${p[1]}.${p[2]}');
      }
    }
  } catch (_) {}
  return [
    for (final s in subnets.take(4))
      for (var i = 1; i < 255; i++)
        if (!own.contains('$s.$i')) '$s.$i',
  ];
}
