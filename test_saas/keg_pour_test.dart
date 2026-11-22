// Разливное пиво: кега на кран → продажа порций уменьшает остаток; тот же
// код второй раз не подключить; снятая кега не наливает.
//   node saas-gateway/test-data-harness.js 8787 &
//   LOCAL_DB_URL=http://127.0.0.1:8787 flutter test --dart-define=SAAS_MODE=true test_saas/keg_pour_test.dart
// ignore_for_file: invalid_use_of_visible_for_testing_member
@Timeout(Duration(minutes: 5))
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'support/harness_lock.dart';
import 'package:hookah_pos/data/app_db.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/services/app_scope.dart';
import 'package:hookah_pos/services/keg_service.dart';

class _TestAuth implements EngineAuth {
  _TestAuth(this.uid);
  @override
  final String uid;
  @override
  Future<String?> token({bool force = false}) async => 'test:$uid';
  @override
  Stream<String> get uidChanges => const Stream.empty();
}

final _url = Platform.environment['LOCAL_DB_URL'] ?? '';

void main() {
  requireSaasHarness(url: _url);
  useHarnessExclusively(_url);
  late LocalEngine engine;
  late Directory tmp;

  setUpAll(() {
    FieldValueRecorder.install();
    tmp = Directory.systemTemp.createTempSync('kegs');
    engine = LocalEngine(baseUrl: _url, storageDir: tmp, auth: _TestAuth('ownerA'));
    engine.start();
    AppDb.debugUse(LocalFirestore(engine), engine: engine);
    AppScope.enterTenant('tenantA');
  });
  tearDownAll(() => engine.dispose());

  test('кега на кране: продажа уменьшает остаток, повтор кода и снятая кега', () async {
    final code = '0104600000000000215K${DateTime.now().microsecondsSinceEpoch}\u001d93abcd';
    final s = KegService.instance;
    for (final k in await s.onTap()) {
      await s.disconnect(k.id, 'Тест');
    }
    final id = await s.connect(code: code, name: 'Светлое', volumeL: 30, portions: {'b05': 0.5}, employeeName: 'Анна');
    await expectLater(s.connect(code: code, name: 'Светлое', volumeL: 30, portions: {'b05': 0.5}, employeeName: 'Анна'),
        throwsA(isA<StateError>()));
    await expectLater(s.connect(code: 'короткий', name: 'x', volumeL: 30, portions: {'b05': 0.5}, employeeName: 'Анна'),
        throwsA(isA<StateError>()));
    await s.recordPour([OrderItem(menuItemId: 'b05', name: 'Светлое 0,5', price: 300, qty: 3), OrderItem(menuItemId: 'tea', name: 'Чай', price: 100, qty: 1)]);
    final kegs = await s.onTap();
    final k = kegs.firstWhere((x) => x.id == id);
    expect(k.pouredL, closeTo(1.5, 0.001));
    expect(k.leftL, 28.5);
    await s.disconnect(id, 'Анна');
    expect((await s.onTap()).any((x) => x.id == id), isFalse);
    await expectLater(s.connect(code: code, name: 'Светлое', volumeL: 30, portions: {'b05': 0.5}, employeeName: 'Анна'),
        throwsA(isA<StateError>()), reason: 'снятую кегу повторно не подключают');
  });
}
