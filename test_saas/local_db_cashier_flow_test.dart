// Настоящая логика кассы (FirestoreService) на собственном сервере данных:
// те же правила saas/firestore.rules, что и в бою. Запуск вручную:
//   node saas-gateway/test-data-harness.js 8787 &
//   LOCAL_DB_URL=http://127.0.0.1:8787 flutter test test/local_db_cashier_flow_test.dart
// Без LOCAL_DB_URL тест пропускается.

// ignore_for_file: invalid_use_of_visible_for_testing_member — это тест (папка вне test/, её запускают отдельно)
@Timeout(Duration(minutes: 15))
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness_lock.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/data/app_db.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';
import 'package:hookah_pos/models/cash_op.dart';
import 'package:hookah_pos/models/employee.dart';
import 'package:hookah_pos/models/inventory_models.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/table_model.dart';
import 'package:hookah_pos/services/app_scope.dart';
import 'package:hookah_pos/services/firestore_service.dart';
import 'package:hookah_pos/services/net_status.dart';
import 'package:http/http.dart' as http;

/// Вход: подставной токен стенда (test-data-harness.js).
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
final _tenant = Platform.environment['LOCAL_DB_TENANT'] ?? 'tenantA';

void main() {
  // Стенд общий — занимаем целиком, пока идут тесты этого файла.
  requireSaasHarness(url: _url);
  useHarnessExclusively(_url);
  late LocalEngine engine;
  late LocalFirestore db;

  setUpAll(() {
    FieldValueRecorder.install();
    final dir = Directory.systemTemp.createTempSync('cashier');
    engine = LocalEngine(baseUrl: _url, storageDir: dir, auth: _TestAuth('ownerA'));
    engine.start();
    db = LocalFirestore(engine);
    AppDb.debugUse(db, engine: engine);
    AppScope.enterTenant(_tenant);
  });
  tearDownAll(() async {
    engine.dispose();
    if (_url.isNotEmpty) {
      await http.post(Uri.parse('$_url/__offline'), body: jsonEncode({'on': false}));
    }
  });

  test('смена → стол → чек → позиции → оплата → возврат → закрытие смены', () async {
    final fs = FirestoreService();
    final shiftId = await fs.openShiftIfNeeded('Тест Кассир');
    expect(shiftId, isNotEmpty);
    expect(await fs.openShiftIfNeeded('Тест Кассир'), shiftId, reason: 'вторая смена не открывается');

    final table = TableModel(id: 'flow1', name: 'Стол Ф', x: 0.5, y: 0.5);
    await fs.addTable(table);
    final tables = await fs.tablesStream().firstWhere((l) => l.any((t) => t.id == 'flow1')).timeout(const Duration(seconds: 8));
    expect(tables.firstWhere((t) => t.id == 'flow1').name, 'Стол Ф');

    final sessionId = await fs.openSession(table: table, employeeName: 'Тест Кассир', guests: 2);
    final coffee = MenuItem(id: 'm1', categoryId: 'c1', name: 'Кофе', price: 150);
    final tea = MenuItem(id: 'm2', categoryId: 'c1', name: 'Чай', price: 100);
    await fs.addOrderItem(sessionId, coffee, qty: 2);
    await fs.addOrderItem(sessionId, tea);
    final s1 = await fs.sessionStream(sessionId).firstWhere((s) => s != null && s.orderItems.length == 2).timeout(const Duration(seconds: 8));
    final teaLine = s1!.orderItems.firstWhere((i) => i.name == 'Чай');
    await fs.changeOrderItemQty(sessionId, teaLine.lineId, 1);
    final s2 = await fs.sessionStream(sessionId)
        .firstWhere((s) => s != null && s.orderItems.firstWhere((i) => i.name == 'Чай').qty == 2)
        .timeout(const Duration(seconds: 8));
    final total = s2!.orderItems.fold<double>(0, (a, i) => a + i.price * i.qty);
    expect(total, 500);

    final ok = await fs.closeSessionWithPayment(sessionId, 'flow1',
        cash: 200, card: 300, comp: 0, orderItems: s2.orderItems, employeeName: 'Тест Кассир', expectedTotal: 500);
    expect(ok, isTrue);
    final closed = await db.doc('tenants/$_tenant/sessions/$sessionId').get(const GetOptions(source: Source.server));
    expect(closed.data()!['status'], isNot('active'));
    // Повторная оплата того же чека (сбой сети, двойное нажатие) — не проходит.
    expect(
        await fs.closeSessionWithPayment(sessionId, 'flow1',
            cash: 200, card: 300, comp: 0, orderItems: s2.orderItems, employeeName: 'Тест Кассир', expectedTotal: 500),
        isFalse);

    expect(await fs.refundSession(sessionId, employeeName: 'Тест Кассир'), isTrue);
    final refunded = await db.doc('tenants/$_tenant/sessions/$sessionId').get(const GetOptions(source: Source.server));
    expect(refunded.data()!['refunded'], isTrue);
    expect(refunded.data()!['status'], 'closed');

    await fs.closeShift(shiftId, 'Тест Кассир');
    final shift = await db.doc('tenants/$_tenant/shifts/$shiftId').get(const GetOptions(source: Source.server));
    expect(shift.data()!['status'], 'closed');
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('без интернета чек закрывается по памяти устройства и уходит на сервер потом', () async {
    final fs = FirestoreService();
    final shiftId = await fs.openShiftIfNeeded('Тест Кассир');
    final table = TableModel(id: 'flow2', name: 'Стол О', x: 0.2, y: 0.2);
    await fs.addTable(table);
    final sessionId = await fs.openSession(table: table, employeeName: 'Тест Кассир');
    await fs.addOrderItem(sessionId, MenuItem(id: 'm3', categoryId: 'c1', name: 'Сок', price: 120));
    final s = await fs.sessionStream(sessionId).firstWhere((s) => s != null && s.orderItems.isNotEmpty).timeout(const Duration(seconds: 8));
    await engine.waitForPendingWrites();

    await http.post(Uri.parse('$_url/__offline'), body: jsonEncode({'on': true}));
    await Future<void>.delayed(const Duration(milliseconds: 300));
    final ok = await fs
        .closeSessionWithPayment(sessionId, 'flow2', cash: 120, card: 0, comp: 0, orderItems: s!.orderItems, employeeName: 'Тест Кассир')
        .timeout(const Duration(seconds: 30));
    expect(ok, isTrue);
    final local = await db.doc('tenants/$_tenant/sessions/$sessionId').get(const GetOptions(source: Source.cache));
    expect(local.data()!['status'], isNot('active'));
    // Без интернета работают и пересадка, и разделение счёта (раньше — «когда вернётся интернет»).
    final t3 = TableModel(id: 'flow3', name: 'Стол Т', x: 0.4, y: 0.4);
    await fs.addTable(t3);
    final s2 = await fs.openSession(table: table, employeeName: 'Тест Кассир');
    await fs.addOrderItem(s2, MenuItem(id: 'm4', categoryId: 'c1', name: 'Чай', price: 90), qty: 2);
    final open2 = await fs.sessionStream(s2).firstWhere((x) => x != null && x.orderItems.isNotEmpty).timeout(const Duration(seconds: 8));
    final part = await fs.splitOffItems(sessionId: s2, tableId: 'flow2', moveQty: {FirestoreService.splitKey(open2!.orderItems.first): 1}, employeeName: 'Тест Кассир');
    await fs.moveSessionToTable(sessionId: s2, fromTableId: 'flow2', toTableId: 'flow3');

    await http.post(Uri.parse('$_url/__offline'), body: jsonEncode({'on': false}));
    engine.reconnectNow();
    await engine.waitForPendingWrites().timeout(const Duration(seconds: 30));
    final server = await db.doc('tenants/$_tenant/sessions/$sessionId').get(const GetOptions(source: Source.server));
    expect(server.data()!['status'], isNot('active'));
    expect((await db.doc('tenants/$_tenant/sessions/$s2').get(const GetOptions(source: Source.server))).data()!['tableId'], 'flow3');
    expect((await db.doc('tenants/$_tenant/sessions/$part').get(const GetOptions(source: Source.server))).exists, isTrue);
    await fs.closeShift(shiftId, 'Тест Кассир');
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('касса знает, что связи нет: чек со складом закрывается и после связи записан один раз (SaaS)', () async {
    final fs = FirestoreService();
    // Свои номера на каждый прогон: стенд хранит прошлые движения склада.
    final inv = 'offInv${DateTime.now().millisecondsSinceEpoch}';
    await db.doc('tenants/$_tenant/inventoryItems/$inv').set({'name': 'Лимонад', 'unit': 'pcs', 'quantity': 10, 'active': true, 'category': ''});
    final lemon = MenuItem(id: 'offLemon', categoryId: 'c1', name: 'Лимонад', price: 150, inventoryItemId: inv, weight: 1, weightUnit: InventoryUnit.pcs);
    await db.doc('tenants/$_tenant/menuItems/offLemon').set(lemon.toMap());
    final table = TableModel(id: 'flowOff', name: 'Стол Н', x: 0.3, y: 0.3);
    await fs.addTable(table);
    await fs.tablesStream().firstWhere((l) => l.any((t) => t.id == 'flowOff')).timeout(const Duration(seconds: 8));
    final sessionId = await fs.openSession(table: table, employeeName: 'Тест Кассир');
    await fs.addOrderItem(sessionId, lemon, qty: 2);
    final s = await fs.sessionStream(sessionId).firstWhere((s) => s != null && s.orderItems.isNotEmpty).timeout(const Duration(seconds: 8));
    // Меню и склад — в памяти устройства, как у кассы с открытым залом.
    await db.doc('tenants/$_tenant/menuItems/offLemon').get();
    await db.doc('tenants/$_tenant/inventoryItems/$inv').get();
    await engine.waitForPendingWrites();

    await http.post(Uri.parse('$_url/__offline'), body: jsonEncode({'on': true}));
    NetStatus.online.value = false;
    final ok = await fs
        .closeSessionWithPayment(sessionId, 'flowOff', cash: 0, card: 300, comp: 0, orderItems: s!.orderItems, employeeName: 'Тест Кассир', expectedTotal: 300)
        .timeout(const Duration(seconds: 5), onTimeout: () => throw StateError('касса без связи ждёт сервер'));
    expect(ok, isTrue);
    expect((await db.doc('tenants/$_tenant/sessions/$sessionId').get(const GetOptions(source: Source.cache))).data()!['status'], 'closed');

    await http.post(Uri.parse('$_url/__offline'), body: jsonEncode({'on': false}));
    NetStatus.online.value = true;
    engine.reconnectNow();
    await engine.waitForPendingWrites().timeout(const Duration(seconds: 30));
    final server = (await db.doc('tenants/$_tenant/sessions/$sessionId').get(const GetOptions(source: Source.server))).data()!;
    expect(server['status'], 'closed');
    expect(server['paymentCard'], 300);
    expect((await db.doc('tenants/$_tenant/inventoryItems/$inv').get(const GetOptions(source: Source.server))).data()!['quantity'], 8);
    final moves = await db.collection('tenants/$_tenant/inventoryMovements').where('itemId', isEqualTo: inv).get(const GetOptions(source: Source.server));
    expect(moves.docs.length, 1, reason: 'склад списан один раз');
    final t = (await db.doc('tenants/$_tenant/tables/flowOff').get(const GetOptions(source: Source.server))).data()!;
    expect(t['status'], 'free');
    expect(engine.lastRejected.value, isNull);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('смена сотрудника без интернета: в табель — время нажатия, не время возврата связи (SaaS)', () async {
    final fs = FirestoreService();
    final emp = Employee(id: 'offEmp', name: 'Курьер Смены', pinCode: '9999', role: 'employee');
    // Свежая сверка часов с сервером — касса только что была на связи.
    await db.doc('tenants/$_tenant/tables/flow1').get(const GetOptions(source: Source.server));
    // Касса уже видела указатель открытых смен (как после входа сотрудника).
    await db.doc('tenants/$_tenant/meta/staffShiftState').get(const GetOptions(source: Source.server));
    await engine.waitForPendingWrites();
    addTearDown(() async {
      NetStatus.online.value = true;
      await http.post(Uri.parse('$_url/__offline'), body: jsonEncode({'on': false}));
    });
    await http.post(Uri.parse('$_url/__offline'), body: jsonEncode({'on': true}));
    NetStatus.online.value = false;
    final tappedIn = DateTime.now();
    final shiftId = await fs.clockIn(emp).timeout(const Duration(seconds: 5));
    await Future<void>.delayed(const Duration(seconds: 2));
    final tappedOut = DateTime.now();
    await fs.clockOut(shiftId, emp.id).timeout(const Duration(seconds: 5));
    // Связь вернулась через 4 секунды после нажатия «Закончить смену».
    await Future<void>.delayed(const Duration(seconds: 4));
    await http.post(Uri.parse('$_url/__offline'), body: jsonEncode({'on': false}));
    NetStatus.online.value = true;
    engine.reconnectNow();
    await engine.waitForPendingWrites().timeout(const Duration(seconds: 30));
    final d = (await db.doc('tenants/$_tenant/staffShifts/$shiftId').get(const GetOptions(source: Source.server))).data()!;
    expect(d['status'], 'closed');
    final start = (d['startedAt'] as Timestamp).toDate();
    final end = (d['endedAt'] as Timestamp).toDate();
    expect(start.difference(tappedIn).inSeconds.abs(), lessThan(2), reason: 'начало — момент нажатия');
    expect(end.difference(tappedOut).inSeconds.abs(), lessThan(2), reason: 'уход — момент нажатия, а не возврата связи');
    expect((d['endSyncedAt'] as Timestamp).toDate().isAfter(end.add(const Duration(seconds: 3))), isTrue);
    expect(engine.lastRejected.value, isNull);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('кухня, разделение и пересадка, повторное открытие, касса, Z-отчёт', () async {
    // Прошлый тест обрывал связь; в приложении её восстановит NetStatus.start().
    NetStatus.online.value = true;
    final fs = FirestoreService();
    final shiftId = await fs.openShiftIfNeeded('Тест Кассир');
    final t1 = TableModel(id: 'k1', name: 'Стол К1', x: 0.1, y: 0.1);
    final t2 = TableModel(id: 'k2', name: 'Стол К2', x: 0.2, y: 0.2);
    await fs.addTable(t1);
    await fs.addTable(t2);
    final sid = await fs.openSession(table: t1, employeeName: 'Тест Кассир');
    await fs.addOrderItem(sid, MenuItem(id: 'p1', categoryId: 'c1', name: 'Плов', price: 300), qty: 2);
    await fs.addOrderItem(sid, MenuItem(id: 'p2', categoryId: 'c1', name: 'Лимонад', price: 150));
    var s = await fs.sessionStream(sid).firstWhere((x) => x != null && x.orderItems.length == 2).timeout(const Duration(seconds: 8));
    final plov = s!.orderItems.firstWhere((i) => i.name == 'Плов');
    final lemon = s.orderItems.firstWhere((i) => i.name == 'Лимонад');

    // Кухня: отправлено → принято → готово → выдано.
    await fs.markItemsSent(sid, {plov.lineId: plov.qty});
    await fs.markItemsAccepted(sid, {plov.lineId});
    await fs.markItemsReady(sid, {plov.lineId});
    await fs.markItemsServed(sid, {plov.lineId});
    await fs.setOrderItemNote(sid, lemon.lineId, 'без льда');
    s = await fs.sessionStream(sid)
        .firstWhere((x) => x != null && x.orderItems.any((i) => i.name == 'Лимонад' && i.note == 'без льда'))
        .timeout(const Duration(seconds: 8));

    // Разделить: лимонад — в отдельный чек; пересадить основной чек за другой стол.
    final splitId = await fs.splitOffItems(sessionId: sid, tableId: 'k1', moveQty: {FirestoreService.splitKey(lemon): 1}, employeeName: 'Тест Кассир');
    final split = await fs.sessionStream(splitId).firstWhere((x) => x != null && x.orderItems.isNotEmpty).timeout(const Duration(seconds: 8));
    expect(split!.orderItems.single.name, 'Лимонад');
    s = await fs.sessionStream(sid).firstWhere((x) => x != null && x.orderItems.every((i) => i.name != 'Лимонад')).timeout(const Duration(seconds: 8));
    await fs.moveSessionToTable(sessionId: sid, fromTableId: 'k1', toTableId: 'k2');
    final moved = await db.doc('tenants/$_tenant/sessions/$sid').get(const GetOptions(source: Source.server));
    expect(moved.data()!['tableId'], 'k2');

    // Оплата обоих чеков, повторное открытие и закрытие заново.
    expect(await fs.closeSessionWithPayment(sid, 'k2', cash: 600, card: 0, comp: 0, orderItems: s!.orderItems, employeeName: 'Тест Кассир', expectedTotal: 600), isTrue);
    expect(await fs.closeSessionWithPayment(splitId, 'k1', cash: 0, card: 150, comp: 0, orderItems: split.orderItems, employeeName: 'Тест Кассир', expectedTotal: 150), isTrue);
    final closedS = await fs.sessionStream(sid).firstWhere((x) => x != null && x.status != 'active').timeout(const Duration(seconds: 8));
    final reopened = await fs.reopenSession(closedS!, employeeName: 'Тест Кассир');
    final again = await fs.sessionStream(reopened).firstWhere((x) => x != null && x.status == 'active').timeout(const Duration(seconds: 8));
    expect(await fs.closeSessionWithPayment(reopened, again!.tableId, cash: 600, card: 0, comp: 0, orderItems: again.orderItems, employeeName: 'Тест Кассир'), isTrue);

    // Касса: внесение и инкассация; Z-отчёт по смене.
    await fs.addCashOp(CashOp(id: '', shiftId: shiftId, type: CashOpType.values.first, amount: 100, comment: 'тест', employeeName: 'Тест Кассир', createdAt: DateTime.now()));
    final shift = await fs.currentOpenShift();
    expect(shift?.id, shiftId);
    final z = await fs.zReportOf(shift!);
    expect(z, isNotNull);
    await fs.closeShift(shiftId, 'Тест Кассир');
    expect(await fs.currentOpenShift(), isNull);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('стол, «зависший» на закрытом чеке, освобождается и открывает новый чек (SaaS)', () async {
    NetStatus.online.value = true;
    final fs = FirestoreService();
    await fs.openShiftIfNeeded('Тест Кассир');
    final table = TableModel(id: 'stale1', name: 'Стол З', x: 0.3, y: 0.3, maxOpenSessions: 1);
    await fs.addTable(table);
    final sid = await fs.openSession(table: table, employeeName: 'Тест Кассир');
    await fs.addOrderItem(sid, MenuItem(id: 'z1', categoryId: 'c1', name: 'Морс', price: 90));
    await engine.waitForPendingWrites();
    // Чек закрыли, а стол его не отпустил (закрытие без связи / две кассы).
    await db.doc('tenants/$_tenant/sessions/$sid').update({'status': 'closed', 'closedAt': Timestamp.now()});
    await db.doc('tenants/$_tenant/tables/stale1').update({'activeSessionIds': [sid], 'status': 'occupied'});
    await engine.waitForPendingWrites();
    if (!kSaasMode) {
      // В обычной кассе (не SaaS) поведение прежнее: стол числит чек.
      expect(() => fs.openSession(table: table, employeeName: 'Тест Кассир'), throwsA(isA<TableFullException>()));
      return;
    }
    // Новый чек открывается: закрытый чек больше не считается.
    final sid2 = await fs.openSession(table: table, employeeName: 'Тест Кассир');
    final t1 = await db.doc('tenants/$_tenant/tables/stale1').get(const GetOptions(source: Source.server));
    expect(List<String>.from(t1.data()!['activeSessionIds'] as List), [sid2]);
    // Самовосстановление зала: чек снова «завис» — стол освобождается.
    expect(await fs.closeSessionWithPayment(sid2, 'stale1', cash: 0, card: 0, comp: 0, closedWithoutPayment: true), isTrue);
    await db.doc('tenants/$_tenant/tables/stale1').update({'activeSessionIds': [sid2, 'nope-${DateTime.now().millisecondsSinceEpoch}'], 'status': 'occupied'});
    await engine.waitForPendingWrites();
    expect(await fs.repairStaleTables(), greaterThanOrEqualTo(1));
    final t2 = await db.doc('tenants/$_tenant/tables/stale1').get(const GetOptions(source: Source.server));
    expect(t2.data()!['activeSessionIds'], isEmpty);
    expect(t2.data()!['status'], 'free');
    // Открытый чек самовосстановление не трогает.
    final sid3 = await fs.openSession(table: table, employeeName: 'Тест Кассир');
    expect(await fs.repairStaleTables(tableId: 'stale1'), 0);
    final t3 = await db.doc('tenants/$_tenant/tables/stale1').get(const GetOptions(source: Source.server));
    expect(List<String>.from(t3.data()!['activeSessionIds'] as List), [sid3]);
    expect(await fs.closeSessionWithPayment(sid3, 'stale1', cash: 0, card: 0, comp: 0, closedWithoutPayment: true), isTrue);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('офлайн-апокалипсис: часы без связи, 20 чеков, отмены, склад; тем временем тариф истёк — ничего не теряется (SaaS)', () async {
    final fs = FirestoreService();
    final run = DateTime.now().millisecondsSinceEpoch;
    final inv = 'apoInv$run';
    await db.doc('tenants/$_tenant/inventoryItems/$inv').set({'name': 'Чай', 'unit': 'pcs', 'quantity': 100, 'active': true, 'category': ''});
    final tea = MenuItem(id: 'apoTea$run', categoryId: 'c1', name: 'Чай', price: 200, inventoryItemId: inv, weight: 1, weightUnit: InventoryUnit.pcs);
    final cake = MenuItem(id: 'apoCake$run', categoryId: 'c1', name: 'Торт с очень длинным названием для проверки чеков и бегунков кухни на узком экране', price: 350);
    await db.doc('tenants/$_tenant/menuItems/${tea.id}').set(tea.toMap());
    await db.doc('tenants/$_tenant/menuItems/${cake.id}').set(cake.toMap());
    final tables = [for (var i = 0; i < 20; i++) TableModel(id: 'apo${run}_$i', name: 'А$i', x: 0.05 * i, y: 0.5)];
    for (final t in tables) {
      await fs.addTable(t);
    }
    await fs.tablesStream().firstWhere((l) => tables.every((t) => l.any((x) => x.id == t.id))).timeout(const Duration(seconds: 15));
    // Всё нужное — в памяти устройства, как у кассы, которая работала с утра.
    await db.doc('tenants/$_tenant/menuItems/${tea.id}').get();
    await db.doc('tenants/$_tenant/menuItems/${cake.id}').get();
    await db.doc('tenants/$_tenant/inventoryItems/$inv').get();
    await db.doc('tenants/$_tenant/meta/shiftState').get(const GetOptions(source: Source.server));
    await engine.waitForPendingWrites();
    addTearDown(() async {
      NetStatus.online.value = true;
      await http.post(Uri.parse('$_url/__offline'), body: jsonEncode({'on': false}));
      await http.post(Uri.parse('$_url/__gate'), body: jsonEncode({}));
    });

    // Интернет пропал.
    await http.post(Uri.parse('$_url/__offline'), body: jsonEncode({'on': true}));
    NetStatus.online.value = false;
    final ids = <String>[];
    for (var i = 0; i < 20; i++) {
      final sid = await fs.openSession(table: tables[i], employeeName: 'Офлайн Кассир').timeout(const Duration(seconds: 5));
      await fs.addOrderItem(sid, tea, qty: 1).timeout(const Duration(seconds: 5));
      await fs.addOrderItem(sid, cake, qty: 1).timeout(const Duration(seconds: 5));
      ids.add(sid);
    }
    // Двум столам торт отменили до оплаты.
    for (final sid in ids.take(2)) {
      final s = await fs.sessionStream(sid).firstWhere((x) => x != null && x.orderItems.length == 2).timeout(const Duration(seconds: 5));
      await fs.removeOrderItem(sid, s!.orderItems.firstWhere((i) => i.menuItemId == cake.id).lineId).timeout(const Duration(seconds: 5));
    }
    // Трём столам счёт разделили без связи (своя база: отложенная транзакция) — чай отдельным чеком.
    final splits = <int, String>{};
    for (final i in [3, 4, 5]) {
      final s = await fs.sessionStream(ids[i]).firstWhere((x) => x != null && x.orderItems.length == 2).timeout(const Duration(seconds: 5));
      final teaLine = s!.orderItems.firstWhere((x) => x.menuItemId == tea.id);
      splits[i] = await fs
          .splitOffItems(sessionId: ids[i], tableId: tables[i].id, moveQty: {FirestoreService.splitKey(teaLine): 1}, employeeName: 'Офлайн Кассир')
          .timeout(const Duration(seconds: 5), onTimeout: () => throw StateError('разделение без связи ждёт сервер'));
    }
    // Все чеки закрыли: наличные и карта вперемешку.
    for (final e in splits.entries) {
      final s = await fs.sessionStream(e.value).firstWhere((x) => x != null && x.orderItems.isNotEmpty).timeout(const Duration(seconds: 5));
      expect(await fs.closeSessionWithPayment(e.value, tables[e.key].id, cash: 200, card: 0, comp: 0, orderItems: s!.orderItems, employeeName: 'Офлайн Кассир', expectedTotal: 200)
          .timeout(const Duration(seconds: 5)), isTrue);
    }
    for (var i = 0; i < 20; i++) {
      final split = splits.containsKey(i);
      final lines = i < 2 || split ? 1 : 2;
      final s = await fs.sessionStream(ids[i]).firstWhere((x) => x != null && x.orderItems.length == lines).timeout(const Duration(seconds: 5));
      final total = i < 2 ? 200.0 : split ? 350.0 : 550.0;
      final ok = await fs
          .closeSessionWithPayment(ids[i], tables[i].id, cash: i.isEven ? total : 0, card: i.isEven ? 0 : total, comp: 0, orderItems: s!.orderItems, employeeName: 'Офлайн Кассир', expectedTotal: total)
          .timeout(const Duration(seconds: 5), onTimeout: () => throw StateError('касса без связи ждёт сервер'));
      expect(ok, isTrue);
    }

    // Пока касса была без связи, у заведения кончился оплаченный период.
    await http.post(Uri.parse('$_url/__gate'), body: jsonEncode({'code': 'subscription-blocked'}));
    await http.post(Uri.parse('$_url/__offline'), body: jsonEncode({'on': false}));
    NetStatus.online.value = true;
    engine.reconnectNow();
    await Future<void>.delayed(const Duration(seconds: 3));
    expect(engine.pending, isNotEmpty, reason: 'сервер не принял — записи ждут в очереди, а не выброшены');
    expect(engine.lastRejected.value, isNull, reason: 'кассе не показываем «не принял»: это ожидание оплаты');
    for (final sid in [...ids, ...splits.values]) {
      expect((await db.doc('tenants/$_tenant/sessions/$sid').get(const GetOptions(source: Source.cache))).data()!['status'], 'closed');
    }

    // Владелец оплатил — очередь уходит сама.
    await http.post(Uri.parse('$_url/__gate'), body: jsonEncode({}));
    engine.reconnectNow();
    await engine.waitForPendingWrites().timeout(const Duration(seconds: 120));
    var cash = 0.0, card = 0.0;
    for (final sid in [...ids, ...splits.values]) {
      final d = (await db.doc('tenants/$_tenant/sessions/$sid').get(const GetOptions(source: Source.server))).data()!;
      expect(d['status'], 'closed', reason: sid);
      cash += (d['paymentCash'] as num?)?.toDouble() ?? 0;
      card += (d['paymentCard'] as num?)?.toDouble() ?? 0;
    }
    expect(cash + card, 2 * 200 + 18 * 550, reason: 'все 23 чека (20 + 3 разделённых) на сервере, без потерь и дублей');
    expect((await db.doc('tenants/$_tenant/inventoryItems/$inv').get(const GetOptions(source: Source.server))).data()!['quantity'], 80);
    final moves = await db.collection('tenants/$_tenant/inventoryMovements').where('itemId', isEqualTo: inv).get(const GetOptions(source: Source.server));
    expect(moves.docs.length, 20, reason: 'по строке журнала склада на чек с чаем, без задвоения');
    for (final t in tables) {
      expect((await db.doc('tenants/$_tenant/tables/${t.id}').get(const GetOptions(source: Source.server))).data()!['status'], 'free');
    }
    expect(engine.lastRejected.value, isNull);
  }, timeout: const Timeout(Duration(minutes: 4)));

  test('Z-отчёты: сквозные номера, необнуляемый итог; открытие смены их не сбрасывает', () async {
    NetStatus.online.value = true;
    final fs = FirestoreService();
    Future<Map<String, dynamic>> closeWithSale(int price) async {
      final shiftId = await fs.openShiftIfNeeded('Тест Кассир');
      final state = (await db.doc('tenants/$_tenant/meta/shiftState').get(const GetOptions(source: Source.server))).data()!;
      final t = TableModel(id: 'z$price', name: 'Стол Z', x: 0.3, y: 0.3);
      await fs.addTable(t);
      final sid = await fs.openSession(table: t, employeeName: 'Тест Кассир');
      await fs.addOrderItem(sid, MenuItem(id: 'zm$price', categoryId: 'c1', name: 'Позиция', price: price.toDouble()));
      final s = await fs.sessionStream(sid).firstWhere((x) => x != null && x.orderItems.isNotEmpty).timeout(const Duration(seconds: 8));
      await fs.closeSessionWithPayment(sid, t.id, cash: price.toDouble(), card: 0, comp: 0, orderItems: s!.orderItems, employeeName: 'Тест Кассир');
      await fs.closeShift(shiftId, 'Тест Кассир');
      final shift = (await db.doc('tenants/$_tenant/shifts/$shiftId').get(const GetOptions(source: Source.server))).data()!;
      return {'state': state, 'z': shift['z'] as Map, 'zNumber': shift['zNumber']};
    }
    final a = await closeWithSale(100);
    final b = await closeWithSale(250);
    expect(b['zNumber'], (a['zNumber'] as int) + 1, reason: 'номер Z продолжается, а не начинается с №1');
    expect((b['state'] as Map)['lastZ'], a['zNumber'], reason: 'открытие смены не стёрло счётчик');
    expect(((b['z'] as Map)['salesTotal'] as num) - ((b['z'] as Map)['refundsTotal'] as num? ?? 0), 250, reason: 'в Z только чеки этой смены');
    expect(((b['z'] as Map)['grandTotal'] as num) - ((a['z'] as Map)['grandTotal'] as num), 250);
  }, timeout: const Timeout(Duration(minutes: 2)));
}
