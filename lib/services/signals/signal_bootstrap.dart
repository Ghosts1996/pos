import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';

import '../app_scope.dart';
import 'lan_signal_codec.dart';
import 'lan_signals.dart';
import 'signal_settings.dart';
import '../../data/app_db.dart';

/// Держит настройки сигналов свежими на устройстве и включает приём по
/// Wi‑Fi заведения. Документ settings/integrations лежит и в памяти
/// устройства, поэтому без интернета работают последние настройки.
///
/// Ключ подписи локальной сети создаётся сам при первом запуске с
/// интернетом — администратору ничего вводить не нужно. Читают его только
/// сотрудники (правила settings), у гостей его нет.
class SignalBootstrap {
  SignalBootstrap._();

  static StreamSubscription? _sub;

  static void start() {
    if (_sub != null) return;
    final ref = AppScope.col('settings').doc('integrations');
    _sub = ref.snapshots().listen((snap) {
      applySignalSettings(snap.data());
      final s = signalSettings;
      if (s.lanEnabled && s.lanKey.isEmpty && !snap.metadata.isFromCache) unawaited(_createKey(ref));
      if (s.lanEnabled) unawaited(LanSignals.instance.start());
    }, onError: (Object e) => debugPrint('сигналы: $e'));
  }

  static Future<void> _createKey(DocumentReference<Map<String, dynamic>> ref) async {
    try {
      await AppDb.instance.runTransaction((tx) async {
        final cur = (await tx.get(ref)).data();
        if ((cur?['lanSignalKey'] ?? '').toString().isNotEmpty) return;
        tx.set(ref, {'lanSignalKey': newLanKey()}, SetOptions(merge: true));
      });
    } catch (_) {
      // Без прав или без сети — создаст другое устройство или следующий запуск.
    }
  }

  @visibleForTesting
  static Future<void> stop() async {
    await _sub?.cancel();
    _sub = null;
  }
}
