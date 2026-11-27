// Ручное начисление и списание бонусов из «Гостей»: баланс меняется, списать
// больше остатка нельзя, в истории гостя — «Начислено/Списано заведением» с
// причиной. С настоящим сервером данных и правилами.
//   node saas-gateway/test-data-harness.js 8787 &
//   LOCAL_DB_URL=http://127.0.0.1:8787 flutter test --dart-define=SAAS_MODE=true test_saas/guest_bonus_adjust_test.dart
// ignore_for_file: invalid_use_of_visible_for_testing_member
@Timeout(Duration(minutes: 5))
library;

import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart' show GetOptions, Source;
import 'package:flutter_test/flutter_test.dart';

import 'support/harness_lock.dart';
import 'package:hookah_pos/data/app_db.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';
import 'package:hookah_pos/models/client_models.dart';
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
  late LocalEngine engine;
  late LocalFirestore db;
  late Directory tmp;

  setUpAll(() {
    FieldValueRecorder.install();
    tmp = Directory.systemTemp.createTempSync('bonusadj');
    engine = LocalEngine(baseUrl: _url, storageDir: tmp, auth: _TestAuth('ownerA'));
    engine.start();
    db = LocalFirestore(engine);
    AppDb.debugUse(db, engine: engine);
    AppScope.enterTenant('tenantA');
  });
  tearDownAll(() => engine.dispose());

  test('начислить, списать, не больше остатка, причина в истории', () async {
    final uid = 'g${DateTime.now().microsecondsSinceEpoch}';
    await db.doc('tenants/tenantA/clients/$uid').set({'name': 'Гость', 'bonusBalance': 50});
    final link = GuestLinkService();

    expect(await link.adjustBonuses(clientUid: uid, delta: 300, note: 'извинение за ожидание'), 300);
    expect(await link.adjustBonuses(clientUid: uid, delta: -100), -100);
    // На счёте 250 — списать 1000 нельзя, списывается остаток.
    expect(await link.adjustBonuses(clientUid: uid, delta: -1000), -250);
    expect(await link.adjustBonuses(clientUid: uid, delta: -10), 0);

    final snap = await db.doc('tenants/tenantA/clients/$uid').get(const GetOptions(source: Source.server));
    expect((snap.data()!['bonusBalance'] as num).toDouble(), 0);

    final ops = await db.collection('tenants/tenantA/bonusOperations').where('clientUid', isEqualTo: uid)
        .get(const GetOptions(source: Source.server));
    final views = ops.docs.map((d) => BonusOpView.fromMap(d.data())).toList();
    expect(views.length, 3);
    expect(views.where((v) => v.plus).single.title, 'Начислено заведением: извинение за ожидание');
    expect(views.where((v) => !v.plus).map((v) => v.bonuses).toList()..sort(), [100, 250]);
    expect(views.where((v) => !v.plus).every((v) => v.title == 'Списано заведением'), isTrue);
  });
}
