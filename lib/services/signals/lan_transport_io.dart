import 'dart:async';
import 'dart:io';

import 'lan_signal_codec.dart';

/// UDP-широковещание в Wi‑Fi заведения. Роутер и интернет не нужны:
/// пакет доходит до всех устройств той же сети напрямую.
class LanTransport {
  LanTransport({this.port = lanSignalPort});

  final int port;
  RawDatagramSocket? _socket;

  bool get supported => true;

  /// Слушать порт. Касса и её фоновая служба могут слушать одновременно —
  /// отсюда reuseAddress.
  Future<bool> open(void Function(List<int> bytes) onData) async {
    if (_socket != null) return true;
    RawDatagramSocket? s;
    try {
      s = await RawDatagramSocket.bind(InternetAddress.anyIPv4, port, reuseAddress: true, reusePort: !Platform.isWindows);
    } catch (_) {
      try {
        s = await RawDatagramSocket.bind(InternetAddress.anyIPv4, port, reuseAddress: true);
      } catch (_) {
        return false;
      }
    }
    s.broadcastEnabled = true;
    s.listen((event) {
      if (event != RawSocketEvent.read) return;
      final d = s?.receive();
      if (d != null) onData(d.data);
    }, onError: (_) {});
    _socket = s;
    return true;
  }

  /// Адреса рассылки: общий 255.255.255.255 и широковещательный своей
  /// подсети (x.y.z.255) — часть роутеров первый не пропускает.
  Future<List<InternetAddress>> _targets() async {
    final out = <String>{'255.255.255.255'};
    try {
      for (final i in await NetworkInterface.list(type: InternetAddressType.IPv4)) {
        for (final a in i.addresses) {
          if (a.isLoopback) continue;
          final p = a.address.split('.');
          if (p.length == 4) out.add('${p[0]}.${p[1]}.${p[2]}.255');
        }
      }
    } catch (_) {}
    return [for (final a in out) InternetAddress(a)];
  }

  Future<void> broadcast(List<int> bytes) async {
    var s = _socket;
    var temp = false;
    if (s == null) {
      try {
        s = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
        s.broadcastEnabled = true;
        temp = true;
      } catch (_) {
        return;
      }
    }
    final targets = await _targets();
    // Дважды с паузой: в загруженном Wi‑Fi одиночный пакет теряется.
    for (var round = 0; round < 2; round++) {
      for (final t in targets) {
        try {
          s.send(bytes, t, port);
        } catch (_) {}
      }
      if (round == 0) await Future<void>.delayed(const Duration(milliseconds: 150));
    }
    if (temp) s.close();
  }

  Future<void> close() async {
    _socket?.close();
    _socket = null;
  }
}
