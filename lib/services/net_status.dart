import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

/// Есть ли связь с облаком. Без связи касса продолжает работать: правки
/// чека пишутся в память устройства и уходят на сервер сами, когда
/// интернет вернётся (FirestoreService, офлайн-ветки), а бегунки печатаются
/// на принтеры в локальной сети.
///
/// Проверка — короткий запрос к серверу базы раз в 20 секунд и сразу после
/// любого сбоя ([reportFailure]). Ответ любой — связь есть.
class NetStatus {
  NetStatus._();

  static final ValueNotifier<bool> online = ValueNotifier(true);
  static Timer? _timer;
  static bool _probing = false;

  static const _probeUrl = 'https://firestore.googleapis.com/';
  static const _interval = Duration(seconds: 20);

  static void start() {
    if (_timer != null) return;
    unawaited(probe());
    _timer = Timer.periodic(_interval, (_) => probe());
  }

  static Future<bool> probe() async {
    if (_probing) return online.value;
    _probing = true;
    try {
      await http.head(Uri.parse(_probeUrl)).timeout(const Duration(seconds: 4));
      online.value = true;
    } catch (_) {
      online.value = false;
    } finally {
      _probing = false;
    }
    return online.value;
  }

  /// Запрос к базе не прошёл из-за связи — считаем, что её нет, и
  /// перепроверяем.
  static void reportFailure() {
    online.value = false;
    unawaited(probe());
  }
}
