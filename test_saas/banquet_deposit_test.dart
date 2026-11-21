// Банкет: предоплата на кассе → «Внесение» в кассу смены и сумма в брони;
// при посадке меню банкета — в чеке, предоплата — в счёте.
//   node saas-gateway/test-data-harness.js 8787 &
//   LOCAL_DB_URL=http://127.0.0.1:8787 flutter test --dart-define=SAAS_MODE=true test_saas/banquet_deposit_test.dart
// ignore_for_file: invalid_use_of_visible_for_testing_member
@Timeout(Duration(minutes: 5))
library;

import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart' show Timestamp, GetOptions, Source;
import 'package:flutter_test/flutter_test.dart';

import 'support/harness_lock.dart';
import 'package:hookah_pos/data/app_db.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';
import 'package:hookah_pos/models/reservation_model.dart';
import 'package:hookah_pos/services/app_scope.dart';
import 'package:hookah_pos/services/banquet_service.dart';
import 'package:hookah_pos/services/reservation_service.dart';

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
    tmp = Directory.systemTemp.createTempSync('banquet');
    engine = LocalEngine(baseUrl: _url, storageDir: tmp, auth: _TestAuth('ownerA'));
    engine.start();
    db = LocalFirestore(engine);
    AppDb.debugUse(db, engine: engine);
    AppScope.enterTenant('tenantA');
  });
  tearDownAll(() => engine.dispose());

  test('предоплата наличными → внесение в смену, при посадке — в счёте с меню', () async {
    final stamp = DateTime.now().microsecondsSinceEpoch;
    final rid = 'bq$stamp';
    final tid = 'bt$stamp';
    final mid = 'bm$stamp';
    await db.doc('tenants/tenantA/meta/shiftState').set({'openShiftId': ''});
    await db.doc('tenants/tenantA/menuItems/$mid').set({'name': 'Сет банкетный', 'price': 1500, 'categoryId': '', 'available': true});
    await db.doc('tenants/tenantA/tables/$tid').set({'name': 'Зал', 'status': 'free', 'activeSessionIds': [], 'maxOpenSessions': 2, 'seats': 4});
    await db.doc('tenants/tenantA/reservations/$rid').set({
      'guestsCount': 10, 'tableId': tid, 'tableName': 'Зал', 'status': 'confirmed',
      'startTime': Timestamp.fromDate(DateTime.now().add(const Duration(days: 3))), 'durationMinutes': 240,
      'kind': 'banquet', 'banquetPrepay': 5000, 'source': 'phone',
      'preOrder': [{'menuItemId': mid, 'name': 'Сет банкетный', 'price': 1500, 'qty': 10}],
      'createdAt': Timestamp.now(),
    });
    Future<ReservationModel> load() async =>
        ReservationModel.fromDoc(await AppScope.col('reservations').doc(rid).get(const GetOptions(source: Source.server)));

    // Смена не открыта — наличные не принимаем.
    await expectLater(
      BanquetService.instance.acceptDeposit(reservation: await load(), amount: 3000, method: 'cash', employeeName: 'Анна'),
      throwsA(isA<StateError>()),
    );

    final shiftId = 'sh$stamp';
    await db.doc('tenants/tenantA/meta/shiftState').set({'openShiftId': shiftId});
    final note = await BanquetService.instance.acceptDeposit(
        reservation: await load(), amount: 3000, method: 'cash', employeeName: 'Анна', employeeId: 'e1');
    expect(note, contains('не подключена'));
    await BanquetService.instance.acceptDeposit(reservation: await load(), amount: 2000, method: 'card', employeeName: 'Анна');

    final r = await load();
    expect(r.prepaidTotal, 5000);
    expect(r.depositKassa, 5000);
    final s = banquetSummary(r);
    expect(s.prepayLeft, 0);
    expect(s.menuTotal, 15000);
    expect(s.balance, 10000);

    final ops = await AppScope.col('cashOps').where('shiftId', isEqualTo: shiftId).get(const GetOptions(source: Source.server));
    expect(ops.docs.length, 1, reason: 'только наличные — «Внесение»');
    expect(ops.docs.single.data()['type'], 'deposit');
    expect(ops.docs.single.data()['amount'], 3000);

    final sid = await ReservationService().seat(reservation: r, employeeName: 'Анна', employeeId: 'e1');
    final ses = (await AppScope.col('sessions').doc(sid).get(const GetOptions(source: Source.server))).data()!;
    expect(ses['guestPaidTotal'], 5000);
    expect(ses['reservationId'], rid);
    expect((ses['orderItems'] as List).single['qty'], 10);
  });
}
