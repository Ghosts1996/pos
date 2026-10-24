import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../build_info.dart';
import 'local_engine.dart';
import 'local_firestore.dart';

/// База данных приложения: Cloud Firestore или собственный сервер данных
/// платформы (saas-gateway, /db/*). Где сейчас данные, решает сервер
/// (GET /db/status) — переключение без новой сборки приложения. Код
/// приложения работает с привычными классами cloud_firestore, просто берёт
/// базу отсюда вместо FirebaseFirestore.instance.
class AppDb {
  AppDb._();

  static FirebaseFirestore? _local;
  static LocalEngine? _engine;
  static bool _inited = false;
  static const _prefKey = 'data_backend_v1';

  static FirebaseFirestore get instance => _local ?? FirebaseFirestore.instance;

  /// Данные на собственном сервере.
  static bool get isLocal => _local != null;

  static LocalEngine? get engine => _engine;

  /// Тесты: база вместо выбранной сервером.
  @visibleForTesting
  static void debugUse(FirebaseFirestore? db, {LocalEngine? engine}) {
    _local = db;
    _engine = engine;
    _inited = true;
  }

  /// Сразу после Firebase.initializeApp и до первого обращения к данным.
  static Future<void> init() async {
    if (_inited) return;
    _inited = true;
    if (!kSaasMode || kSaasGatewayUrl.isEmpty || kIsWeb) return;
    FieldValueRecorder.install();
    String? cached;
    SharedPreferences? prefs;
    try {
      prefs = await SharedPreferences.getInstance();
      cached = prefs.getString(_prefKey);
    } catch (_) {}
    var backend = cached ?? 'firestore';
    // Ответ сервера ждём недолго: без сети касса стартует по прошлому ответу.
    final fresh = await _fetchBackend(cached == null ? const Duration(seconds: 4) : const Duration(milliseconds: 1500));
    if (fresh != null) {
      backend = fresh;
      try {
        await prefs?.setString(_prefKey, fresh);
      } catch (_) {}
    }
    if (backend != 'local') {
      _watchSwitch(prefs);
      return;
    }
    Directory? dir;
    try {
      dir = Directory('${(await getApplicationSupportDirectory()).path}/zal_data');
    } catch (e) {
      debugPrint('local-db: нет папки для данных, работаем без памяти устройства: $e');
    }
    final engine = LocalEngine(baseUrl: kSaasGatewayUrl, storageDir: dir);
    await engine.load();
    engine.start();
    _engine = engine;
    _local = LocalFirestore(engine);
    AppLifecycleListener(
      onResume: engine.reconnectNow,
      onHide: () => unawaited(engine.flushToDisk()),
      onDetach: () => unawaited(engine.flushToDisk()),
    );
    _watchSwitch(prefs);
  }

  static Future<String?> _fetchBackend([Duration timeout = const Duration(seconds: 10)]) async {
    try {
      final r = await http.get(Uri.parse('$kSaasGatewayUrl/db/status')).timeout(timeout);
      if (r.statusCode != 200) return null;
      final b = (jsonDecode(r.body) as Map)['backend'];
      return b == 'local' || b == 'firestore' ? b as String : null;
    } catch (_) {
      return null;
    }
  }

  /// Сервер переключил хранилище — запомним; применится при следующем запуске.
  static void _watchSwitch(SharedPreferences? prefs) {
    Timer.periodic(const Duration(minutes: 15), (_) async {
      final b = await _fetchBackend();
      if (b != null) {
        try {
          await prefs?.setString(_prefKey, b);
        } catch (_) {}
      }
    });
  }
}
