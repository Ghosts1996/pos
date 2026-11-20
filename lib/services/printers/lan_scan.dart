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

/// Интерфейс VPN (tun, ppp, WireGuard, IPsec): его адреса не локальная сеть
/// заведения, а сам VPN часто не пускает телефон к принтеру в той же Wi-Fi.
bool isVpnInterface(String name) => RegExp(r'^(tun|ppp|wg|ipsec|utun|tap)|vpn', caseSensitive: false).hasMatch(name);

/// Адреса этого устройства в локальной сети и включён ли VPN — для
/// подсказки, когда принтер не нашёлся.
Future<({List<String> own, bool vpn})> localNetworkInfo() async {
  final own = <String>[];
  var vpn = false;
  try {
    for (final ni in await NetworkInterface.list(type: InternetAddressType.IPv4)) {
      if (isVpnInterface(ni.name)) {
        vpn = true;
        continue;
      }
      for (final a in ni.addresses) {
        if (isPrivateLan(a.address)) own.add(a.address);
      }
    }
  } catch (_) {}
  return (own: own, vpn: vpn);
}

/// Подсказка, если принтер не нашёлся: адрес устройства, каким должен быть
/// адрес принтера, и про VPN.
String lanNotFoundHint(({List<String> own, bool vpn}) net) {
  final b = StringBuffer('Принтеры в сети не найдены. ');
  if (net.own.isEmpty) {
    b.write('Это устройство не подключено к Wi-Fi или сети заведения — подключите его к тому же роутеру, что и принтер. ');
  } else {
    final ip = net.own.first;
    final p = ip.split('.');
    b.write('Адрес этого устройства: $ip — у принтера адрес должен начинаться так же: ${p[0]}.${p[1]}.${p[2]}.… '
        'Узнайте адрес принтера: выключите его, зажмите FEED и включите — напечатается страница с IP. '
        'Если первые три числа другие (например, 192.168.123.100), принтеру нужно сменить адрес или подключить его по USB. ');
  }
  if (net.vpn) b.write('На устройстве включён VPN — выключите его на время поиска: он часто не пускает к принтеру в той же сети. ');
  return b.toString().trim();
}

Future<List<String>> _subnetHosts() async {
  final net = await localNetworkInfo();
  final own = net.own.toSet();
  final subnets = <String>{
    for (final a in own) a.split('.').take(3).join('.'),
  };
  return [
    for (final s in subnets.take(4))
      for (var i = 1; i < 255; i++)
        if (!own.contains('$s.$i')) '$s.$i',
  ];
}
