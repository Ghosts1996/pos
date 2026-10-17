import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'signal_settings.dart';

/// Один HTTP-запрос к реле. [after] — через сколько после предыдущего
/// (выключить Sonoff, у которого нет своего таймера).
class RelayRequest {
  final String method;
  final Uri uri;
  final String? body;
  final Duration after;
  const RelayRequest(this.method, this.uri, {this.body, this.after = Duration.zero});

  @override
  String toString() => '$method $uri${body == null ? '' : ' $body'}';
}

/// «192.168.1.50», «192.168.1.50:8080», «http://192.168.1.50/» → хост
/// с портом без схемы и слэшей.
String relayHost(String address) {
  var a = address.trim();
  a = a.replaceFirst(RegExp(r'^https?://', caseSensitive: false), '');
  final slash = a.indexOf('/');
  if (slash >= 0) a = a.substring(0, slash);
  return a;
}

Uri _http(String host, String path, [Map<String, String>? query]) {
  final hp = host.split(':');
  return Uri(
    scheme: 'http',
    host: hp.first,
    port: hp.length > 1 ? int.tryParse(hp[1]) : null,
    path: path,
    queryParameters: query,
  );
}

/// Запросы, которые включат реле [d] на [RelayDevice.pulseSeconds] и
/// выключат обратно. [vars] — для своего адреса: {event}, {table}, {text}.
List<RelayRequest> relayRequests(RelayDevice d, {Map<String, String> vars = const {}}) {
  final host = relayHost(d.address);
  final sec = d.pulseSeconds.clamp(1, 300);
  switch (d.kind) {
    case RelayKind.shellyGen1:
      // Таймер самого Shelly: реле выключится, даже если касса пропала.
      return [RelayRequest('GET', _http(host, '/relay/${d.channel}', {'turn': 'on', 'timer': '$sec'}))];
    case RelayKind.shellyGen2:
      return [
        RelayRequest('GET', _http(host, '/rpc/Switch.Set', {'id': '${d.channel}', 'on': 'true', 'toggle_after': '$sec'})),
      ];
    case RelayKind.tasmota:
      final n = d.channel + 1;
      // Delay в Tasmota — в десятых долях секунды, не больше 3600.
      final delay = (sec * 10).clamp(1, 3600);
      return [
        RelayRequest('GET', _http(host, '/cm', {'cmnd': 'Backlog Power$n On;Delay $delay;Power$n Off'})),
      ];
    case RelayKind.sonoffDiy:
      final h = host.contains(':') ? host : '$host:8081';
      String on(bool v) => d.channel == 0
          ? jsonEncode({'deviceid': '', 'data': {'switch': v ? 'on' : 'off'}})
          : jsonEncode({
              'deviceid': '',
              'data': {
                'switches': [
                  {'switch': v ? 'on' : 'off', 'outlet': d.channel},
                ],
              },
            });
      final path = d.channel == 0 ? '/zeroconf/switch' : '/zeroconf/switches';
      return [
        RelayRequest('POST', _http(h, path), body: on(true)),
        RelayRequest('POST', _http(h, path), body: on(false), after: Duration(seconds: sec)),
      ];
    case RelayKind.webhook:
    default:
      var url = d.address.trim();
      for (final e in vars.entries) {
        url = url.replaceAll('{${e.key}}', Uri.encodeComponent(e.value));
      }
      if (!url.contains('://')) url = 'http://$url';
      final uri = Uri.tryParse(url);
      return uri == null ? const [] : [RelayRequest('GET', uri)];
  }
}

/// Отправляет запросы реле. Ошибку возвращает текстом — для кнопки
/// «Проверить»; при обычных сигналах её только пишут в журнал.
class RelayClient {
  RelayClient({http.Client? client}) : _client = client ?? http.Client();
  final http.Client _client;

  static const _timeout = Duration(seconds: 4);

  Future<String?> pulse(RelayDevice d, {Map<String, String> vars = const {}}) async {
    final reqs = relayRequests(d, vars: vars);
    if (reqs.isEmpty) return 'неверный адрес';
    String? error;
    for (final r in reqs) {
      if (r.after > Duration.zero) await Future<void>.delayed(r.after);
      try {
        final resp = r.method == 'POST'
            ? await _client
                .post(r.uri, headers: const {'Content-Type': 'application/json'}, body: r.body)
                .timeout(_timeout)
            : await _client.get(r.uri).timeout(_timeout);
        if (resp.statusCode == 401) {
          error = 'реле просит пароль — отключите его в настройках реле (сигналы идут только внутри сети заведения)';
        } else if (resp.statusCode >= 400) {
          error = 'реле ответило ${resp.statusCode}';
        }
      } on TimeoutException {
        error = 'реле не отвечает — проверьте IP и что планшет в той же Wi‑Fi сети';
      } catch (e) {
        error = 'нет связи с реле: $e';
      }
      if (error != null) break;
    }
    return error;
  }
}
