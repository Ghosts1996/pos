// Списание склада по чеку в сборке платформы: все продукты — одной записью,
// стоп-лист — одним чтением меню сразу по всем продуктам.
// Запуск: flutter test --dart-define=SAAS_MODE=true test/inventory_batch_test.dart

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/data/app_db.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';
import 'package:hookah_pos/models/inventory_models.dart';
import 'package:hookah_pos/services/app_scope.dart';
import 'package:hookah_pos/services/firestore_service.dart';
import 'package:hookah_pos/services/net_status.dart';

class _OfflineAuth implements EngineAuth {
  @override
  String get uid => 'owner1';
  @override
  Future<String?> token({bool force = false}) async => 'test:owner1';
  @override
  Stream<String> get uidChanges => const Stream.empty();
}

void main() {
  late LocalEngine engine;
  late LocalFirestore db;

  setUp(() {
    FieldValueRecorder.install();
    engine = LocalEngine(baseUrl: 'http://127.0.0.1:9', storageDir: Directory.systemTemp.createTempSync('inv'), auth: _OfflineAuth());
    db = LocalFirestore(engine);
    AppDb.debugUse(db, engine: engine);
    AppScope.enterTenant('t1');
  });
  tearDown(() {
    NetStatus.online.value = true;
    engine.dispose();
  });

  Future<double> qty(String id) async => ((await db.doc('tenants/t1/inventoryItems/$id').get()).data()!['quantity'] as num).toDouble();

  test('без связи: продукты чека — одной пачкой, остатки и журнал верны', () async {
    await db.doc('tenants/t1/inventoryItems/milk').set({'name': 'Молоко', 'unit': 'l', 'quantity': 2});
    await db.doc('tenants/t1/inventoryItems/beans').set({'name': 'Зерно', 'unit': 'kg', 'quantity': 1});
    NetStatus.online.value = false;
    final before = engine.pending.length;
    await FirestoreService().adjustInventoryMany([
      (item: InventoryItem(id: 'milk', name: 'Молоко', unit: InventoryUnit.l), delta: -0.4, reason: 'Продажа: Капучино ×2'),
      (item: InventoryItem(id: 'beans', name: 'Зерно', unit: InventoryUnit.kg), delta: -0.036, reason: 'Продажа: Капучино ×2'),
    ], type: 'writeoff', employeeName: 'Анна');
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(engine.pending.length, before + 1, reason: 'одна запись на чек');
    expect(await qty('milk'), closeTo(1.6, 1e-9));
    expect(await qty('beans'), closeTo(0.964, 1e-9));
    final moves = await db.collection('tenants/t1/inventoryMovements').get();
    expect(moves.docs.length, 2);
    final milk = moves.docs.firstWhere((d) => d.data()['itemId'] == 'milk').data();
    expect(milk['resultingQty'], closeTo(1.6, 1e-9));
    expect(milk['type'], 'writeoff');
    expect(milk['employeeName'], 'Анна');
  });

  test('стоп-лист по нескольким продуктам: одно чтение меню, верная причина', () async {
    final menu = {
      // Капучино: молоко 0,2 л и зерно 18 г.
      'cap': {'name': 'Капучино', 'available': true, 'components': [
        {'inventoryItemId': 'milk', 'weight': 200, 'weightUnit': 'ml'},
        {'inventoryItemId': 'beans', 'weight': 18, 'weightUnit': 'g'},
      ]},
      // Эспрессо: только зерно; было в стопе из-за зерна.
      'esp': {'name': 'Эспрессо', 'available': false, 'autoStoppedBy': 'beans', 'inventoryItemId': 'beans', 'weight': 18, 'weightUnit': 'g'},
      // Чай — не из этих продуктов, остаётся как есть.
      'tea': {'name': 'Чай', 'available': false, 'autoStoppedBy': 'tea', 'inventoryItemId': 'tea', 'weight': 5, 'weightUnit': 'g'},
      // Латте в стопе из-за зерна, теперь зерна хватает, но нет молока.
      'lat': {'name': 'Латте', 'available': false, 'autoStoppedBy': 'beans', 'components': [
        {'inventoryItemId': 'milk', 'weight': 300, 'weightUnit': 'ml'},
        {'inventoryItemId': 'beans', 'weight': 18, 'weightUnit': 'g'},
      ]},
    };
    for (final e in menu.entries) {
      await db.doc('tenants/t1/menuItems/${e.key}').set(e.value);
    }
    final before = engine.pending.length;
    final done = FirestoreService().syncStopLists({
      'milk': (0.1, InventoryUnit.l), // меньше порции капучино и латте
      'beans': (0.5, InventoryUnit.kg), // зерна хватает
    });
    await done.timeout(const Duration(seconds: 2), onTimeout: () {});
    Future<Map<String, dynamic>> m(String id) async => (await db.doc('tenants/t1/menuItems/$id').get()).data()!;
    expect((await m('cap'))['available'], isFalse);
    expect((await m('cap'))['autoStoppedBy'], 'milk');
    expect((await m('esp'))['available'], isTrue, reason: 'зерна снова хватает');
    expect((await m('esp')).containsKey('autoStoppedBy'), isFalse);
    expect((await m('tea'))['available'], isFalse);
    expect((await m('lat'))['available'], isFalse);
    expect((await m('lat'))['autoStoppedBy'], 'milk', reason: 'теперь не хватает молока');
    expect(engine.pending.length, before + 1, reason: 'все изменения стоп-листа — одной записью');
  });

  test('один продукт — как раньше', () async {
    await db.doc('tenants/t1/menuItems/esp').set({'name': 'Эспрессо', 'available': true, 'inventoryItemId': 'beans', 'weight': 18, 'weightUnit': 'g'});
    await FirestoreService().syncStopList('beans', 10, InventoryUnit.g).timeout(const Duration(seconds: 2), onTimeout: () {});
    final esp = (await db.doc('tenants/t1/menuItems/esp').get()).data()!;
    expect(esp['available'], isFalse);
    expect(esp['autoStoppedBy'], 'beans');
  });

  final url = Platform.environment['LOCAL_DB_URL'] ?? '';
  test('со связью: одна транзакция, остатки, журнал и стоп-лист', () async {
    final e = LocalEngine(baseUrl: url, storageDir: Directory.systemTemp.createTempSync('inv2'), auth: _OwnerA());
    e.start();
    final live = LocalFirestore(e);
    AppDb.debugUse(live, engine: e);
    AppScope.enterTenant('tenantA');
    final tag = DateTime.now().microsecondsSinceEpoch;
    final milk = 'milk$tag', beans = 'beans$tag';
    await live.doc('tenants/tenantA/inventoryItems/$milk').set({'name': 'Молоко', 'unit': 'l', 'quantity': 0.5});
    await live.doc('tenants/tenantA/inventoryItems/$beans').set({'name': 'Зерно', 'unit': 'kg', 'quantity': 1});
    await live.doc('tenants/tenantA/menuItems/cap$tag').set({'name': 'Капучино', 'available': true, 'components': [
      {'inventoryItemId': milk, 'weight': 200, 'weightUnit': 'ml'},
      {'inventoryItemId': beans, 'weight': 18, 'weightUnit': 'g'},
    ]});
    await FirestoreService().adjustInventoryMany([
      (item: InventoryItem(id: milk, name: 'Молоко', unit: InventoryUnit.l), delta: -0.4, reason: 'Продажа: Капучино ×2'),
      (item: InventoryItem(id: beans, name: 'Зерно', unit: InventoryUnit.kg), delta: -0.036, reason: 'Продажа: Капучино ×2'),
    ], type: 'writeoff', employeeName: 'Анна');
    double q(Map<String, dynamic>? d) => (d!['quantity'] as num).toDouble();
    expect(q((await live.doc('tenants/tenantA/inventoryItems/$milk').get()).data()), closeTo(0.1, 1e-9));
    expect(q((await live.doc('tenants/tenantA/inventoryItems/$beans').get()).data()), closeTo(0.964, 1e-9));
    final cap = (await live.doc('tenants/tenantA/menuItems/cap$tag').get()).data()!;
    expect(cap['available'], isFalse, reason: 'молока меньше порции');
    expect(cap['autoStoppedBy'], milk);
    // Продукта уже нет — вся транзакция отклонена, ничего не списано.
    await expectLater(
        FirestoreService().adjustInventoryMany([
          (item: InventoryItem(id: beans, name: 'Зерно', unit: InventoryUnit.kg), delta: -0.5, reason: 'x'),
          (item: InventoryItem(id: 'gone$tag', name: 'Нет', unit: InventoryUnit.kg), delta: -1, reason: 'x'),
        ], type: 'writeoff', employeeName: 'Анна'),
        throwsA(anything));
    expect(q((await live.doc('tenants/tenantA/inventoryItems/$beans').get()).data()), closeTo(0.964, 1e-9));
    e.dispose();
  }, skip: url.isEmpty ? 'нет LOCAL_DB_URL' : null);
}

class _OwnerA implements EngineAuth {
  @override
  String get uid => 'ownerA';
  @override
  Future<String?> token({bool force = false}) async => 'test:ownerA';
  @override
  Stream<String> get uidChanges => const Stream.empty();
}
