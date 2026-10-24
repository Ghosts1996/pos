// Настоящая логика кассы (FirestoreService) на собственном сервере данных:
// те же правила saas/firestore.rules, что и в бою. Запуск вручную:
//   node saas-gateway/test-data-harness.js 8787 &
//   LOCAL_DB_URL=http://127.0.0.1:8787 flutter test test/local_db_cashier_flow_test.dart
// Без LOCAL_DB_URL тест пропускается.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/data/app_db.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';
import 'package:hookah_pos/models/cash_op.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/table_model.dart';
import 'package:hookah_pos/services/app_scope.dart';
import 'package:hookah_pos/services/firestore_service.dart';
import 'package:hookah_pos/services/net_status.dart';
import 'package:http/http.dart' as http;

/// Вход: подставной токен стенда (test-data-harness.js) или настоящий вход
/// в эмулятор Firebase Auth (AUTH_EMU=127.0.0.1:9099, AUTH_EMAIL, AUTH_PASSWORD)
/// — тогда проверяется сам saas-gateway (server.js).
class _TestAuth implements EngineAuth {
  _TestAuth(this.uid);
  @override
  String uid;
  String? _idToken;
  @override
  Future<String?> token({bool force = false}) async {
    final emu = Platform.environment['AUTH_EMU'];
    if (emu == null) return 'test:$uid';
    if (_idToken != null && !force) return _idToken;
    final r = await http.post(Uri.parse('http://$emu/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'email': Platform.environment['AUTH_EMAIL'], 'password': Platform.environment['AUTH_PASSWORD'], 'returnSecureToken': true}));
    final j = jsonDecode(r.body) as Map;
    uid = j['localId'] as String;
    return _idToken = j['idToken'] as String;
  }

  @override
  Stream<String> get uidChanges => const Stream.empty();
}

final _url = Platform.environment['LOCAL_DB_URL'] ?? '';
final _tenant = Platform.environment['LOCAL_DB_TENANT'] ?? 'tenantA';

void main() {
  final skip = _url.isEmpty ? 'нет LOCAL_DB_URL' : null;
  late LocalEngine engine;
  late LocalFirestore db;

  setUpAll(() {
    FieldValueRecorder.install();
    final dir = Directory.systemTemp.createTempSync('cashier');
    engine = LocalEngine(baseUrl: _url, storageDir: dir, auth: _TestAuth(Platform.environment['AUTH_EMU'] != null ? 'ownerE2E' : 'ownerA'));
    engine.start();
    db = LocalFirestore(engine);
    AppDb.debugUse(db, engine: engine);
    AppScope.enterTenant(_tenant);
  });
  tearDownAll(() async {
    engine.dispose();
    if (_url.isNotEmpty && Platform.environment['AUTH_EMU'] == null) {
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
  }, skip: skip, timeout: const Timeout(Duration(minutes: 2)));

  final harnessOnly = Platform.environment['AUTH_EMU'] != null ? 'обрыв связи — только на стенде' : skip;
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

    await http.post(Uri.parse('$_url/__offline'), body: jsonEncode({'on': false}));
    engine.reconnectNow();
    await engine.waitForPendingWrites().timeout(const Duration(seconds: 30));
    final server = await db.doc('tenants/$_tenant/sessions/$sessionId').get(const GetOptions(source: Source.server));
    expect(server.data()!['status'], isNot('active'));
    await fs.closeShift(shiftId, 'Тест Кассир');
  }, skip: harnessOnly, timeout: const Timeout(Duration(minutes: 2)));

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
  }, skip: skip, timeout: const Timeout(Duration(minutes: 2)));
}
