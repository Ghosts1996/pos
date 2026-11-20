import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

import '../data/app_db.dart';
import '../data/server_clock.dart';
import 'app_scope.dart';
import 'printer_service.dart';

/// Облачная печать (только SaaS): у официанта на телефоне принтера нет —
/// чек уходит через сервер на кассу с принтером («Печатать за всех» в
/// «Интеграциях»), и она его печатает.
///
/// Задания — `printJobs/{id}` заведения: `{status: new|printing|error,
/// data: ESC/POS в base64, createdAt, from}`. Касса-принт-сервер слушает
/// новые, забирает задание транзакцией (две такие кассы не напечатают
/// дважды), печатает своим принтером и удаляет задание — по удалению
/// отправитель понимает, что чек вышел. Раз в минуту касса отмечается в
/// `printJobs/_hub` (seenAt): если её нет на связи дольше 3 минут,
/// телефон сразу говорит об этом, а не ждёт впустую.
class PrintHub {
  PrintHub._();

  static const collection = 'printJobs';
  static const beatDoc = '_hub';
  static const beatEvery = Duration(seconds: 60);
  static const staleAfter = Duration(minutes: 3);
  static const jobTtl = Duration(minutes: 15);

  /// Сколько отправитель ждёт, пока касса напечатает.
  static Duration waitFor = const Duration(seconds: 25);

  static int nowMs() => (ServerClock.now() ?? DateTime.now()).millisecondsSinceEpoch;

  static StreamSubscription? _sub;
  static Timer? _beat;
  static ReceiptPrinter? _printer;
  static final _busy = <String>{};
  static Future<void> _chain = Future.value();
  static String _hubId = '';
  static String _label = '';

  static bool get running => _sub != null;

  /// Запустить приём заданий: печатать их принтером [printer].
  static Future<void> start(ReceiptPrinter printer, {String label = 'Касса'}) async {
    stop();
    _printer = printer;
    _label = label;
    _hubId = await _id();
    final col = AppScope.col(collection);
    await _heartbeat();
    _beat = Timer.periodic(beatEvery, (_) => unawaited(_heartbeat()));
    _sub = col.where('status', isEqualTo: 'new').snapshots().listen((snap) {
      for (final d in snap.docs) {
        if (d.id == beatDoc || _busy.contains(d.id)) continue;
        _busy.add(d.id);
        _chain = _chain.then((_) => _handle(d.id)).whenComplete(() => _busy.remove(d.id));
      }
    }, onError: (_) {});
  }

  static void stop() {
    _sub?.cancel();
    _sub = null;
    _beat?.cancel();
    _beat = null;
    _printer = null;
    _busy.clear();
  }

  /// Дождаться, пока касса допечатает всё, что уже забрала (для тестов).
  static Future<void> idle() => _chain;

  static Future<String> _id() async {
    try {
      final p = await SharedPreferences.getInstance();
      var id = p.getString('zal_print_hub_id') ?? '';
      if (id.isEmpty) {
        id = List.generate(12, (_) => Random.secure().nextInt(36).toRadixString(36)).join();
        await p.setString('zal_print_hub_id', id);
      }
      return id;
    } catch (_) {
      return 'hub${Random().nextInt(1 << 30)}';
    }
  }

  static Future<void> _heartbeat() async {
    try {
      await AppScope.col(collection).doc(beatDoc).set({'seenAt': nowMs(), 'hubId': _hubId, 'label': _label});
    } catch (_) {}
  }

  static Future<void> _handle(String id) async {
    final printer = _printer;
    if (printer == null) return;
    final ref = AppScope.col(collection).doc(id);
    String? data;
    try {
      data = await AppDb.instance.runTransaction<String?>((tx) async {
        final s = await tx.get(ref);
        final d = s.data();
        if (d == null || d['status'] != 'new') return null;
        final at = (d['createdAt'] as num?)?.toInt() ?? 0;
        if (nowMs() - at > jobTtl.inMilliseconds) {
          // Старое задание (касса была выключена) — не печатаем через час
          // чек, который уже никому не нужен.
          tx.delete(ref);
          return null;
        }
        tx.update(ref, {'status': 'printing', 'hubId': _hubId});
        return d['data'] as String? ?? '';
      });
    } catch (_) {
      return; // нет связи — заберём при следующем обновлении
    }
    if (data == null) return;
    try {
      await printer.printBytes(base64Decode(data));
      await ref.delete();
    } catch (e) {
      try {
        await ref.update({'status': 'error', 'error': '$e'});
      } catch (_) {}
    }
  }
}

/// «Принтер» телефона без своего принтера: отправляет печать на кассу —
/// принт-сервер (см. [PrintHub]).
class HubReceiptPrinter extends ReceiptPrinter {
  HubReceiptPrinter({this.from = ''});
  final String from;

  @override
  bool get isConnected => true;

  @override
  Future<bool> connect() async => true;

  @override
  Future<void> disconnect() async {}

  @override
  Future<void> printBytes(List<int> bytes) async {
    final col = AppScope.col(PrintHub.collection);
    Map<String, dynamic>? beat;
    try {
      beat = (await col.doc(PrintHub.beatDoc).get()).data();
    } catch (_) {}
    final seen = (beat?['seenAt'] as num?)?.toInt();
    if (seen == null || PrintHub.nowMs() - seen > PrintHub.staleAfter.inMilliseconds) {
      throw PrinterException('Касса с принтером не на связи. Откройте ZalPOS на кассе, где подключён принтер '
          '(там в «Интеграциях» включено «Печатать за всех»).');
    }
    final ref = col.doc();
    await ref.set({
      'status': 'new',
      'data': base64Encode(bytes),
      'createdAt': PrintHub.nowMs(),
      if (from.isNotEmpty) 'from': from,
    });
    Map<String, dynamic>? last;
    try {
      final s = await ref
          .snapshots()
          .firstWhere((s) => !s.exists || s.data()?['status'] == 'error')
          .timeout(PrintHub.waitFor);
      if (!s.exists) return; // напечатано
      last = s.data();
    } on TimeoutException {
      // Касса не взяла задание — убираем его, чтобы чек не вышел через
      // десять минут, когда о нём уже забыли. Взяла, но печатает долго —
      // оставляем: выйдет.
      try {
        final s = await ref.get();
        if (!s.exists || s.data()?['status'] == 'printing') return;
        await ref.delete();
      } catch (_) {}
      throw PrinterException('Касса с принтером не ответила за ${PrintHub.waitFor.inSeconds} с — '
          'проверьте, что она включена и в сети.');
    }
    try {
      await ref.delete();
    } catch (_) {}
    throw PrinterException('Касса с принтером не напечатала: ${last?['error'] ?? 'ошибка принтера'}');
  }
}
