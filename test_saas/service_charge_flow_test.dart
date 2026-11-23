// Процент за обслуживание на сервере данных: строка ставится и
// пересчитывается при правке счёта, со скидкой, по отказу гостя уходит;
// оплата закрывает чек с этой строкой.
//   node saas-gateway/test-data-harness.js 8787 &
//   LOCAL_DB_URL=http://127.0.0.1:8787 flutter test --dart-define=SAAS_MODE=true test_saas/service_charge_flow_test.dart
// ignore_for_file: invalid_use_of_visible_for_testing_member
@Timeout(Duration(minutes: 5))
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'support/harness_lock.dart';
import 'package:hookah_pos/data/app_db.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';
import 'package:hookah_pos/models/discount_card.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/models/table_model.dart';
import 'package:hookah_pos/services/app_scope.dart';
import 'package:hookah_pos/services/firestore_service.dart';
import 'package:hookah_pos/utils/service_charge.dart';

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

  setUpAll(() {
    FieldValueRecorder.install();
    final dir = Directory.systemTemp.createTempSync('svc');
    engine = LocalEngine(baseUrl: _url, storageDir: dir, auth: _TestAuth('ownerA'));
    engine.start();
    AppDb.debugUse(LocalFirestore(engine), engine: engine);
    AppScope.enterTenant('tenantA');
  });
  tearDownAll(() {
    ServiceCharge.apply(null);
    engine.dispose();
  });

  Future<SessionModel> waitFor(FirestoreService fs, String id, bool Function(SessionModel) ok) =>
      fs.sessionStream(id).where((s) => s != null && ok(s)).map((s) => s!).first.timeout(const Duration(seconds: 10));

  double svc(SessionModel s) => s.orderItems.where(ServiceCharge.isLine).fold(0.0, (a, i) => a + i.total);

  test('строка обслуживания: ставится, пересчитывается, уходит по отказу, оплачивается', () async {
    ServiceCharge.apply({'enabled': true, 'percent': 10, 'minGuests': 0});
    final fs = FirestoreService();
    final table = TableModel(id: 'svc1', name: 'Стол О', x: 0.4, y: 0.4);
    await fs.addTable(table);
    final id = await fs.openSession(table: table, employeeName: 'Тест Кассир', guests: 2);

    await fs.addOrderItem(id, MenuItem(id: 'svc-m1', categoryId: 'c1', name: 'Стейк', price: 1500));
    var s = await waitFor(fs, id, (s) => svc(s) == 150);
    expect(ServiceCharge.isLine(s.orderItems.last), isTrue);

    await fs.addOrderItem(id, MenuItem(id: 'svc-m2', categoryId: 'c1', name: 'Морс', price: 250), qty: 2);
    s = await waitFor(fs, id, (s) => svc(s) == 200);
    expect(s.orderItems.where(ServiceCharge.isLine).length, 1);

    // Скидка 10 % — процент со счёта со скидкой: 2 000 − 200 = 1 800 → 180.
    await fs.applyDiscountCard(id, DiscountCard(id: 'dc1', cardNumber: '0001', guestName: '', discountPercent: 10));
    s = await waitFor(fs, id, (s) => svc(s) == 180);
    expect(s.totalWithDiscount, 1800 + 180);

    // Гость отказался — строки нет и при следующих правках тоже.
    await fs.setServiceOff(id, true);
    s = await waitFor(fs, id, (s) => s.serviceOff && svc(s) == 0);
    await fs.addOrderItem(id, MenuItem(id: 'svc-m3', categoryId: 'c1', name: 'Десерт', price: 400));
    s = await waitFor(fs, id, (s) => s.orderItems.any((i) => i.menuItemId == 'svc-m3'));
    expect(svc(s), 0);

    // Вернули — 10 % от (2 400 − 240) = 216.
    await fs.setServiceOff(id, false);
    s = await waitFor(fs, id, (s) => !s.serviceOff && svc(s) == 216);

    final total = s.totalWithDiscount;
    final closed = await fs.closeSessionWithPayment(id, table.id,
        cash: total, card: 0, comp: 0, orderItems: s.orderItems, expectedTotal: total, seenDiscountPercent: s.discountPercent);
    expect(closed, isTrue);
    s = await waitFor(fs, id, (s) => s.status == 'closed');
    expect(svc(s), 216);
    expect(s.paymentTotal, closeTo(total, 0.001));
  });

  test('«с собой» и функция выключена — строки нет', () async {
    final fs = FirestoreService();
    ServiceCharge.apply({'enabled': false, 'percent': 10});
    final table = TableModel(id: 'svc2', name: 'Стол П', x: 0.6, y: 0.6);
    await fs.addTable(table);
    final id = await fs.openSession(table: table, employeeName: 'Тест Кассир', guests: 2);
    await fs.addOrderItem(id, MenuItem(id: 'svc-m4', categoryId: 'c1', name: 'Салат', price: 600));
    final s = await waitFor(fs, id, (s) => s.orderItems.isNotEmpty);
    expect(svc(s), 0);
    await fs.syncServiceLine(id);
    expect(svc(await waitFor(fs, id, (s) => true)), 0);
  });
}
