import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../build_info.dart';
import '../data/app_db.dart';

/// Есть ли связь с облаком. Без связи касса продолжает работать: правки
/// чека пишутся в память устройства и уходят на сервер сами, когда
/// интернет вернётся (FirestoreService, офлайн-ветки), а бегунки печатаются
/// на принтеры в локальной сети.
///
/// Проверка — короткий запрос к серверу базы раз в 20 секунд и сразу после
/// любого сбоя ([reportFailure]). Ответ любой — связь есть. Данные на своём
/// сервере платформы — проверяем его (Google может быть недоступен, а наш
/// сервер — работать), и поток подписок сервера сам сообщает о связи.
class NetStatus {
  NetStatus._();

  static final ValueNotifier<bool> online = ValueNotifier(true);
  static Timer? _timer;
  static bool _probing = false;

  static const _firestoreProbe = 'https://firestore.googleapis.com/';
  static String get _probeUrl => AppDb.isLocal && kSaasGatewayUrl.isNotEmpty ? '$kSaasGatewayUrl/db/status' : _firestoreProbe;
  static const _interval = Duration(seconds: 20);

  static void start() {
    if (_timer != null) return;
    // Поток подписок своего сервера открылся — связь точно есть.
    AppDb.engine?.online.addListener(() {
      if (AppDb.engine?.online.value == true) online.value = true;
    });
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
