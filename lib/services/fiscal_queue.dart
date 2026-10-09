import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/fiscal_receipt.dart';
import 'atol_local_kassa.dart';
import 'kassa_service.dart';
import 'net_status.dart';

/// Очередь чеков, которые не дошли до кассы (нет интернета у облачной
/// кассы, выключен регистратор). Чек хранится на устройстве и уходит сам:
/// при возврате связи и раз в минуту. Номер чека — id стола, касса по нему
/// отличает повтор от нового чека.
class FiscalQueue {
  FiscalQueue._();

  static const _key = 'fiscal_queue_v1';
  static const _failedKey = 'fiscal_failed_v1';

  /// Сколько чеков ждут отправки — для плашки на экране зала.
  static final ValueNotifier<int> pending = ValueNotifier(0);

  static Timer? _timer;
  static bool _flushing = false;

  static void start() {
    if (_timer != null) return;
    unawaited(_load().then((q) => pending.value = q.length));
    NetStatus.online.addListener(() {
      if (NetStatus.online.value) unawaited(flush());
    });
    _timer = Timer.periodic(const Duration(minutes: 1), (_) => flush());
  }

  /// Отправить чек сейчас, а если касса недоступна — поставить в очередь.
  static Future<FiscalReceiptResult> send(FiscalReceipt receipt) async {
    // Регистратор в зале доступен и без интернета — его пробуем всегда.
    final cloud = kassaService is! AtolLocalKassaService;
    if (cloud && !NetStatus.online.value) {
      await enqueue(receipt);
      return const FiscalReceiptResult.queued();
    }
    final result = await kassaService.sendReceipt(receipt);
    if (result.unreachable) {
      await enqueue(receipt);
      return const FiscalReceiptResult.queued();
    }
    return result;
  }

  static Future<List<Map<String, dynamic>>> _load([String key = _key]) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(key);
      if (raw == null) return [];
      return [for (final e in jsonDecode(raw) as List) Map<String, dynamic>.from(e as Map)];
    } catch (_) {
      return [];
    }
  }

  static Future<void> _save(List<Map<String, dynamic>> q, [String key = _key]) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(key, jsonEncode(q));
    if (key == _key) pending.value = q.length;
  }

  static Future<void> enqueue(FiscalReceipt receipt) async {
    final q = await _load();
    q.removeWhere((e) => (e['receipt'] as Map?)?['receiptId'] == receipt.receiptId);
    q.add({'receipt': receipt.toJson(), 'queuedAt': DateTime.now().toIso8601String()});
    await _save(q);
  }

  /// Чеки, которые касса отклонила при повторной отправке (ошибка в данных,
  /// а не связь) — их нужно пробить вручную.
  static Future<List<Map<String, dynamic>>> failed() => _load(_failedKey);

  static Future<void> flush() async {
    if (_flushing) return;
    _flushing = true;
    try {
      var q = await _load();
      while (q.isNotEmpty) {
        final entry = q.first;
        final receipt = FiscalReceipt.fromJson(Map<String, dynamic>.from(entry['receipt'] as Map));
        final result = await kassaService.sendReceipt(receipt);
        if (result.unreachable) break;
        q = await _load();
        q.removeWhere((e) => (e['receipt'] as Map?)?['receiptId'] == receipt.receiptId);
        await _save(q);
        if (!result.success) {
          final f = await _load(_failedKey);
          f.add({...entry, 'error': result.errorMessage, 'failedAt': DateTime.now().toIso8601String()});
          await _save(f.length > 50 ? f.sublist(f.length - 50) : f, _failedKey);
        }
      }
    } catch (_) {
      // Следующая попытка — по таймеру или при возврате связи.
    } finally {
      _flushing = false;
    }
  }
}
