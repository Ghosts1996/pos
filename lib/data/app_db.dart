import 'dart:async';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:path_provider/path_provider.dart';

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
  ///
  /// [background] — фоновая служба кассы или приложения гостя (свой
  /// изолят): данные в памяти, без папки на устройстве — её ведёт основное
  /// приложение, и два движка в одной папке отправили бы одни и те же
  /// записи дважды. Без слушателя жизненного цикла: в изоляте службы нет
  /// окон, к которым он привязан.
  static Future<void> init({bool background = false}) async {
    if (_inited) return;
    _inited = true;
    if (!kSaasMode || kSaasGatewayUrl.isEmpty || kIsWeb) return;
    FieldValueRecorder.install();
    // SaaS: данные — только свой сервер платформы в РФ, всегда. Firestore
    // (Google, США) не запускается даже при первом запуске без связи:
    // трансграничной передачи нет (уведомление РКН от 14.11.2026).
    Directory? dir;
    if (!background) {
      try {
        dir = Directory('${(await getApplicationSupportDirectory()).path}/zal_data');
      } catch (e) {
        debugPrint('local-db: нет папки для данных, работаем без памяти устройства: $e');
      }
    }
    final engine = LocalEngine(baseUrl: kSaasGatewayUrl, storageDir: dir);
    await engine.load();
    engine.start();
    _engine = engine;
    _local = LocalFirestore(engine);
    if (background) return;
    AppLifecycleListener(
      onResume: engine.reconnectNow,
      onHide: () => unawaited(engine.flushToDisk()),
      onDetach: () => unawaited(engine.flushToDisk()),
    );
  }
}
