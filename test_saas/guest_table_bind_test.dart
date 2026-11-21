// Приложение гостя (Android): QR стола → «Мой стол» показывает счёт.
// Против настоящего сервера данных с правилами saas/firestore.rules:
//   node saas-gateway/test-data-harness.js 8787 &
//   LOCAL_DB_URL=http://127.0.0.1:8787 flutter test --dart-define=SAAS_MODE=true test_saas/guest_table_bind_test.dart
// ignore_for_file: invalid_use_of_visible_for_testing_member — это тест (папка вне test/, её запускают отдельно)
@Timeout(Duration(minutes: 5))
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'support/harness_lock.dart';
import 'package:hookah_pos/data/app_db.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';
import 'package:hookah_pos/services/app_scope.dart';
import 'package:hookah_pos/services/guest_link_service.dart';

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
  final engines = <LocalEngine>[];
  late Directory tmp;

  LocalFirestore open(String uid) {
    final e = LocalEngine(baseUrl: _url, storageDir: Directory('${tmp.path}/${engines.length}'), auth: _TestAuth(uid));
    engines.add(e);
    e.start();
    return LocalFirestore(e);
  }

  setUpAll(() {
    FieldValueRecorder.install();
    tmp = Directory.systemTemp.createTempSync('guestbind');
  });
  tearDownAll(() {
    for (final e in engines) {
      e.dispose();
    }
  });

  test('гость с номером сканирует QR стола — «Мой стол» получает счёт', () async {
    final owner = open('ownerA');
    final stamp = DateTime.now().microsecondsSinceEpoch;
    final tableId = 'gt$stamp';
    final sid = 'gs$stamp';
    const uid = 'guestQ';
    await owner.doc('tenants/tenantA/sessions/$sid').set({
      'status': 'active', 'tableId': tableId, 'tableName': 'Стол Г',
      'orderItems': [{'name': 'Чай', 'price': 300, 'qty': 1}],
    });
    await owner.doc('tenants/tenantA/tables/$tableId').set({
      'name': 'Стол Г', 'x': 0.5, 'y': 0.5, 'status': 'occupied',
      'activeSessionIds': [sid], 'openChecks': [{'id': sid, 'label': 'Счёт 1'}],
    });
    await owner.doc('tenants/tenantA/clients/$uid').set({'name': 'Гость', 'phone': '79990002233', 'activeSessionId': ''});

    final guest = open(uid);
    AppDb.debugUse(guest, engine: engines.last);
    AppScope.enterTenant('tenantA');
    final link = GuestLinkService();
    final result = await link.bindToTable(uid, tableId);
    expect(result.sessionId, sid, reason: 'гость сел за стол');

    // Как экран «Мой стол»: профиль → активный чек → сам чек.
    final profile = await link.profileStream(uid).firstWhere((p) => (p?.activeSessionId ?? '') == sid).timeout(const Duration(seconds: 8));
    final session = await link.sessionStream(profile!.activeSessionId).firstWhere((s) => s != null).timeout(const Duration(seconds: 8));
    expect(session!.status, 'active');
    expect(session.orderItems.single.name, 'Чай');
  });
  test('сеть: гость сканирует QR стола точки — «Мой стол» получает счёт', () async {
    final owner = open('ownerA');
    final stamp = DateTime.now().microsecondsSinceEpoch;
    final tableId = 'ct$stamp';
    final sid = 'cs$stamp';
    const uid = 'guestC';
    await owner.doc('tenants/tenantC/sessions/$sid').set({
      'status': 'active', 'tableId': tableId, 'tableName': 'Стол С',
      'orderItems': [{'name': 'Кофе', 'price': 200, 'qty': 1}],
    });
    await owner.doc('tenants/tenantC/tables/$tableId').set({
      'name': 'Стол С', 'x': 0.5, 'y': 0.5, 'status': 'occupied',
      'activeSessionIds': [sid], 'openChecks': [{'id': sid, 'label': 'Счёт 1'}],
    });
    await owner.doc('chains/chainC/clients/$uid').set({'name': 'Гость сети', 'phone': '79990003344', 'activeSessionId': ''});

    final guest = open(uid);
    AppDb.debugUse(guest, engine: engines.last);
    AppScope.enterTenant('tenantC', chainId: 'chainC');
    final link = GuestLinkService();
    final result = await link.bindToTable(uid, tableId);
    expect(result.sessionId, sid);
    final profile = await link.profileStream(uid).firstWhere((p) => (p?.activeSessionId ?? '') == sid).timeout(const Duration(seconds: 8));
    final session = await link.sessionStream(profile!.activeSessionId).firstWhere((s) => s != null).timeout(const Duration(seconds: 8));
    expect(session!.orderItems.single.name, 'Кофе');
  });
  test('сеть, а приложение не знает про сеть (поставили до перевода) — счёт всё равно открывается', () async {
    final owner = open('ownerA');
    final stamp = DateTime.now().microsecondsSinceEpoch;
    final tableId = 'st$stamp';
    final sid = 'ss$stamp';
    const uid = 'guestS';
    await owner.doc('tenants/tenantC/sessions/$sid').set({
      'status': 'active', 'tableId': tableId, 'tableName': 'Стол S',
      'orderItems': [{'name': 'Сок', 'price': 150, 'qty': 1}],
    });
    await owner.doc('tenants/tenantC/tables/$tableId').set({
      'name': 'Стол S', 'x': 0.5, 'y': 0.5, 'status': 'occupied',
      'activeSessionIds': [sid], 'openChecks': [{'id': sid, 'label': 'Счёт 1'}],
    });
    await owner.doc('tenants/tenantC/clients/$uid').set({'name': 'Гость', 'phone': '79990004455', 'activeSessionId': ''});
    final guest = open(uid);
    AppDb.debugUse(guest, engine: engines.last);
    AppScope.enterTenant('tenantC'); // без chainId — как старое приложение
    final link = GuestLinkService();
    final result = await link.bindToTable(uid, tableId);
    expect(result.sessionId, sid);
    final profile = await link.profileStream(uid).firstWhere((p) => (p?.activeSessionId ?? '') == sid).timeout(const Duration(seconds: 8));
    final session = await link.sessionStream(profile!.activeSessionId).firstWhere((s) => s != null).timeout(const Duration(seconds: 8));
    expect(session!.orderItems.single.name, 'Сок');
  });
}
