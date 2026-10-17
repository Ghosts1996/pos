import 'dart:async';

import '../app_scope.dart';
import 'lan_signal_codec.dart';
import 'lan_transport.dart';
import 'signal_settings.dart';

/// Сигналы между планшетами по Wi‑Fi заведения — без интернета.
///
/// Облако разносит заказы по устройствам, пока есть интернет. Пропал —
/// каждый планшет продолжает работать со своей копией базы, но кухня не
/// узнаёт о новом заказе, а официант — о готовом блюде. Этот канал
/// закрывает именно сигналы: «новый заказ в цех» и «готово», с номером
/// стола и списком блюд. Пакеты подписаны ключом заведения
/// ([SignalSettings.lanKey]), чужие и поддельные отбрасываются.
class LanSignals {
  LanSignals._();
  static final LanSignals instance = LanSignals._();

  final _transport = LanTransport();
  final _ctrl = StreamController<LanMessage>.broadcast();

  /// Последние id: свои (не принимать собственный пакет) и чужие (каждый
  /// пакет приходит дважды).
  final _seen = <String>[];
  bool _open = false;

  /// Подпись этого устройства в проверке связи: «Кухня · Анна».
  String deviceLabel = 'Устройство';

  DateTime? lastReceivedAt;

  Stream<LanMessage> get messages => _ctrl.stream;

  bool get supported => _transport.supported;
  bool get active => supported && signalSettings.lanEnabled && signalSettings.lanKey.isNotEmpty;
  bool get listening => _open;

  String get _tenant => AppScope.tenantId ?? 'local';

  Future<void> start() async {
    if (_open || !supported) return;
    _open = await _transport.open(_onData);
  }

  void _onData(List<int> bytes) {
    final m = decodeLanMessage(bytes, key: signalSettings.lanKey, tenantId: _tenant);
    if (m == null || !_remember(m.id)) return;
    lastReceivedAt = DateTime.now();
    if (m.kind == LanKind.ping && m.data['pong'] == null) {
      unawaited(send(LanKind.ping, {'pong': m.id, 'n': deviceLabel}));
      return;
    }
    _ctrl.add(m);
  }

  bool _remember(String id) {
    if (_seen.contains(id)) return false;
    _seen.add(id);
    if (_seen.length > 300) _seen.removeRange(0, 100);
    return true;
  }

  Future<bool> send(String kind, Map<String, dynamic> data) async {
    if (!active) return false;
    await start();
    final m = LanMessage(kind: kind, tenantId: _tenant, id: newLanId(), at: DateTime.now(), data: data);
    _remember(m.id);
    await _transport.broadcast(encodeLanMessage(m, signalSettings.lanKey));
    return true;
  }

  /// Проверка связи из настроек: кто в сети откликнулся за [wait].
  Future<List<String>> ping({Duration wait = const Duration(seconds: 3)}) async {
    if (!active) return const [];
    await start();
    final answers = <String>{};
    final sub = messages.listen((m) {
      if (m.kind == LanKind.ping && m.data['pong'] != null) answers.add((m.data['n'] ?? 'устройство').toString());
    });
    await send(LanKind.ping, const {});
    await Future<void>.delayed(wait);
    await sub.cancel();
    return answers.toList()..sort();
  }
}
