import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';

import '../../models/session_model.dart';
import '../app_scope.dart';
import '../printer_service.dart';
import 'lan_signal_codec.dart';
import 'lan_signals.dart';
import 'relay_client.dart';
import 'signal_settings.dart';

/// Куда уходит сигнал о событии в зале: другим планшетам по Wi‑Fi
/// заведения, на Wi‑Fi реле (звонок, лампа, пейджер официанта) и на
/// зуммер принтера цеха.
///
/// Новый заказ и «готово» сигналит устройство, где их сделали: официант
/// добавил блюдо — его планшет звонит на кухню; повар нажал «Готово» —
/// планшет кухни зовёт официанта. Всё это идёт по локальной сети и
/// работает без интернета. Вызов гостя приходит из облака сразу на все
/// кассы, поэтому реле по нему включает одна — та, что первой отметила
/// вызов ([remote]).
class SignalHub {
  SignalHub._();
  static final SignalHub instance = SignalHub._();

  RelayClient relay = RelayClient();

  /// Официант часто добавляет блюда подряд: собираем их в один сигнал.
  Duration debounce = const Duration(seconds: 4);
  final _batches = <String, _OrderBatch>{};

  /// Новые штуки в чеке [sessionId] для цеха [station].
  void itemAdded(String sessionId, {required String station, required String lineId, required String name, int qty = 1}) {
    final key = '$sessionId|$station';
    final b = _batches.putIfAbsent(key, () => _OrderBatch(sessionId, station));
    b.add(lineId, name, qty);
    b.timer?.cancel();
    b.timer = Timer(debounce, () {
      _batches.remove(key);
      unawaited(_fireOrder(b).catchError((Object e) => debugPrint('signal order: $e')));
    });
  }

  Future<void> _fireOrder(_OrderBatch b) async {
    final s = await _session(b.sessionId);
    final table = s?.tableName ?? '';
    final summary = b.summary;
    await Future.wait([
      LanSignals.instance.send(LanKind.kitchenOrder, {
        's': b.sessionId,
        'tb': table,
        'st': b.station,
        'x': summary,
        'l': b.lineIds.toList(),
      }),
      _relays(SignalEvent.orderFor(b.station), table: table, text: summary),
      if (signalSettings.printerBeepOnOrder && signalSettings.printerBeep != PrinterBeep.off)
        beepStationPrinter(b.station),
    ]);
  }

  /// Кухня отметила строки [lineIds] чека готовыми — зовём официанта.
  Future<void> dishReady(String sessionId, Set<String> lineIds) async {
    final s = await _session(sessionId);
    if (s == null) return;
    final lines = [for (final i in s.orderItems) if (lineIds.contains(i.lineId)) i];
    if (lines.isEmpty) return;
    final summary = lines.map((i) => i.qty > 1 ? '${i.displayName} ×${i.qty}' : i.displayName).join(', ');
    await Future.wait([
      LanSignals.instance.send(LanKind.dishReady, {
        's': sessionId,
        'tb': s.tableName,
        'w': s.employeeId,
        'x': summary,
        'r': {for (final i in lines) i.lineId: i.ready},
      }),
      _relays(SignalEvent.dishReady, table: s.tableName, text: summary),
    ]);
  }

  /// Событие из облака (вызов гостя, заказ из приложения): его видят все
  /// кассы сразу. Реле включает та, что первой поставит отметку
  /// `signaledBy` в документе [doc] — остальные молчат.
  Future<void> remote(String event, DocumentReference<Map<String, dynamic>> doc, {required String table, String text = ''}) async {
    if (signalSettings.relaysFor(event).isEmpty) return;
    final me = FirebaseAuth.instance.currentUser?.uid ?? '';
    if (me.isEmpty) return;
    try {
      final won = await FirebaseFirestore.instance.runTransaction<bool>((tx) async {
        final cur = await tx.get(doc);
        if (!cur.exists || (cur.data()?['signaledBy'] ?? '').toString().isNotEmpty) return false;
        tx.update(doc, {'signaledBy': me});
        return true;
      });
      if (!won) return;
    } catch (_) {
      return;
    }
    await _relays(event, table: table, text: text);
  }

  /// Повторить звонок на реле: заказ на кухне долго не принимают.
  Future<void> ring(String event, {required String table, String text = ''}) => _relays(event, table: table, text: text);

  Future<void> _relays(String event, {required String table, required String text}) async {
    final vars = {'event': event, 'table': table, 'text': text};
    await Future.wait([
      for (final r in signalSettings.relaysFor(event))
        relay.pulse(r, vars: vars).then((err) {
          if (err != null) debugPrint('реле «${r.name}»: $err');
        }),
    ]);
  }

  Future<SessionModel?> _session(String id) async {
    final ref = AppScope.col('sessions').doc(id);
    try {
      final snap = await ref.get(const GetOptions(source: Source.cache));
      if (snap.exists) return SessionModel.fromDoc(snap);
    } catch (_) {}
    try {
      final snap = await ref.get().timeout(const Duration(seconds: 3));
      return snap.exists ? SessionModel.fromDoc(snap) : null;
    } catch (_) {
      return null;
    }
  }
}

class _OrderBatch {
  _OrderBatch(this.sessionId, this.station);
  final String sessionId;
  final String station;
  final lineIds = <String>{};
  final _qty = <String, int>{};
  Timer? timer;

  void add(String lineId, String name, int qty) {
    lineIds.add(lineId);
    _qty[name] = (_qty[name] ?? 0) + qty;
  }

  String get summary => _qty.entries.map((e) => e.value > 1 ? '${e.key} ×${e.value}' : e.key).join(', ');
}
