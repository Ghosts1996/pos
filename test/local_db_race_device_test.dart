// Несколько касс одновременно: этот файл запускают сразу в нескольких
// процессах (у каждого свой движок и своя память устройства), все они
// жмут кнопки в одну и ту же миллисекунду. Оркестратор — tool/race_devices.sh:
//   node saas-gateway/test-data-harness.js 8787 &
//   bash tool/race_devices.sh
//   (и node tool/race_proxy.js — «интернет» одной кассы)
// Без RACE_ROLE тест пропускается (в обычном flutter test его нет).

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/data/app_db.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';
import 'package:hookah_pos/models/inventory_models.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/models/table_model.dart';
import 'package:hookah_pos/services/app_scope.dart';
import 'package:hookah_pos/services/firestore_service.dart';
import 'package:hookah_pos/services/net_status.dart';
import 'package:http/http.dart' as http;

class _Auth implements EngineAuth {
  _Auth(this.uid);
  @override
  String uid;
  @override
  Future<String?> token({bool force = false}) async => 'test:$uid';
  @override
  Stream<String> get uidChanges => const Stream.empty();
}

final _env = Platform.environment;
final _url = _env['LOCAL_DB_URL'] ?? '';
final _role = _env['RACE_ROLE'] ?? '';
final _dir = _env['RACE_DIR'] ?? '';
final _dev = int.tryParse(_env['RACE_DEV'] ?? '') ?? 0;
final _startAt = int.tryParse(_env['RACE_START'] ?? '') ?? 0;
const _tenant = 'tenantA';

Map<String, dynamic> _state() => jsonDecode(File('$_dir/state.json').readAsStringSync()) as Map<String, dynamic>;
void _out(String name, Object? v) => File('$_dir/$name').writeAsStringSync(jsonEncode(v));

/// Ждёт общий для всех процессов момент [_startAt] + [offsetMs].
Future<void> _at(int offsetMs) async {
  final wait = _startAt + offsetMs - DateTime.now().millisecondsSinceEpoch;
  if (wait > 0) await Future<void>.delayed(Duration(milliseconds: wait));
}

Future<Map<String, Object?>> _try(Future<Object?> Function() f) async {
  final t = DateTime.now();
  try {
    final r = await f();
    return {'ok': true, 'result': r, 'ms': DateTime.now().difference(t).inMilliseconds};
  } catch (e) {
    return {'ok': false, 'error': '$e', 'ms': DateTime.now().difference(t).inMilliseconds};
  }
}

void main() {
  final skip = _url.isEmpty || _role.isEmpty ? 'нет RACE_ROLE/LOCAL_DB_URL' : null;
  late LocalEngine engine;
  late LocalFirestore db;

  setUpAll(() {
    if (skip != null) return;
    FieldValueRecorder.install();
    final dir = Directory.systemTemp.createTempSync('race$_dev');
    engine = LocalEngine(baseUrl: _url, storageDir: dir, auth: _Auth('ownerA'));
    engine.start();
    db = LocalFirestore(engine);
    AppDb.debugUse(db, engine: engine);
    AppScope.enterTenant(_tenant);
  });
  tearDownAll(() {
    if (skip == null) engine.dispose();
  });

  Future<DocumentSnapshot<Map<String, dynamic>>> snap(String path) =>
      db.doc('tenants/$_tenant/$path').get(const GetOptions(source: Source.server));
  Future<Map<String, dynamic>?> server(String path) async => (await snap(path)).data();

  test('роль $_role, устройство $_dev', () async {
    final fs = FirestoreService();
    final beer = MenuItem(id: 'raceBeer', categoryId: 'c1', name: 'Пиво', price: 200, inventoryItemId: 'raceInv', weight: 1, weightUnit: InventoryUnit.pcs);
    final tag = DateTime.now().millisecondsSinceEpoch.toString();

    if (_role == 'seed') {
      await db.doc('tenants/$_tenant/inventoryItems/raceInv').set({'name': 'Пиво кега', 'unit': 'pcs', 'quantity': 100, 'active': true, 'category': ''});
      await db.doc('tenants/$_tenant/menuItems/raceBeer').set(beer.toMap());
      final ids = <String, Object>{};
      for (final n in ['close', 'adds', 'mixed', 'open', 'off']) {
        final t = TableModel(id: 'race_${n}_$tag', name: 'Гонка $n', x: 0.5, y: 0.5);
        await fs.addTable(t);
        ids['table_$n'] = t.id;
        if (n == 'open') continue;
        final s = await fs.openSession(table: t, employeeName: 'Сид');
        ids['session_$n'] = s;
        await fs.addOrderItem(s, beer, qty: 3);
      }
      _out('state.json', {...ids, 'seedAt': DateTime.now().millisecondsSinceEpoch});
      return;
    }

    if (_role == 'device') {
      final st = _state();
      final close = st['session_close'] as String;
      final adds = st['session_adds'] as String;
      final mixed = st['session_mixed'] as String;
      // Прогрев: чеки в памяти устройства, как у кассы с открытым залом.
      for (final s in [close, adds, mixed]) {
        await fs.sessionStream(s).firstWhere((x) => x != null).timeout(const Duration(seconds: 10));
      }
      final res = <String, Object?>{};

      // 1. Все устройства жмут «Оплатить» по одному чеку в одну миллисекунду.
      final seen = (await fs.sessionStream(close).firstWhere((x) => x != null))!;
      await _at(0);
      res['close'] = await _try(() => fs.closeSessionWithPayment(close, st['table_close'] as String,
          cash: seen.totalWithDiscount, card: 0, comp: 0,
          orderItems: seen.orderItems, employeeName: 'Кассир $_dev', expectedTotal: seen.totalWithDiscount));

      // 2. Все устройства одновременно добавляют свои позиции в один чек.
      await _at(4000);
      final mine = MenuItem(id: 'dev$_dev', categoryId: 'c1', name: 'Позиция устройства $_dev', price: 10);
      res['adds'] = await _try(() async {
        for (var i = 0; i < 5; i++) {
          await fs.addOrderItem(adds, mine);
        }
        return 5;
      });

      // 3. Устройство 0 закрывает чек, остальные в ту же секунду добавляют в него позиции.
      final seenMixed = (await fs.sessionStream(mixed).firstWhere((x) => x != null))!;
      await _at(8000);
      if (_dev == 0) {
        res['mixed'] = await _try(() => fs.closeSessionWithPayment(mixed, st['table_mixed'] as String,
            cash: seenMixed.totalWithDiscount, card: 0, comp: 0,
            orderItems: seenMixed.orderItems, employeeName: 'Кассир 0', expectedTotal: seenMixed.totalWithDiscount));
      } else {
        res['mixed'] = await _try(() => fs.addOrderItem(mixed, MenuItem(id: 'late$_dev', categoryId: 'c1', name: 'Поздняя $_dev', price: 50)));
      }

      // 4. Все устройства одновременно открывают чек на свободном столе.
      final openTable = TableModel(id: st['table_open'] as String, name: 'Гонка open', x: 0.5, y: 0.5);
      await _at(12000);
      res['open'] = await _try(() => fs.openSession(table: openTable, employeeName: 'Официант $_dev'));
      _out('device$_dev.json', res);
      return;
    }

    if (_role == 'offline') {
      // Касса 0 ходит через посредника (RACE_CUT — его выключатель), касса 1 — напрямую.
      final st = _state();
      final off = st['session_off'] as String;
      final seen = (await fs.sessionStream(off).firstWhere((x) => x != null).timeout(const Duration(seconds: 10)))!;
      final res = <String, Object?>{};
      // Зал открыт — столы в памяти устройства, как у настоящей кассы.
      await fs.tablesStream().firstWhere((l) => l.any((t) => t.id == st['table_off'])).timeout(const Duration(seconds: 10));
      Future<void> cut(bool on) => http.post(Uri.parse(_env['RACE_CUT']!), body: jsonEncode({'on': on}));
      if (_dev == 0) {
        await _at(0);
        await cut(true);
        NetStatus.online.value = false; // касса заметила, что связи нет
        await _at(3000); // касса 1 уже закрыла этот чек онлайн
        res['close'] = await _try(() => fs.closeSessionWithPayment(off, st['table_off'] as String,
            cash: 0, card: seen.totalWithDiscount, comp: 0,
            orderItems: seen.orderItems, employeeName: 'Кассир без связи', expectedTotal: seen.totalWithDiscount));
        await _at(5000);
        await cut(false);
        NetStatus.online.value = true;
        await db.waitForPendingWrites().timeout(const Duration(seconds: 40));
        await Future<void>.delayed(const Duration(seconds: 2));
        res['rejected'] = engine.lastRejected.value;
      } else {
        await _at(1500);
        res['close'] = await _try(() => fs.closeSessionWithPayment(off, st['table_off'] as String,
            cash: seen.totalWithDiscount, card: 0, comp: 0,
            orderItems: seen.orderItems, employeeName: 'Кассир онлайн', expectedTotal: seen.totalWithDiscount));
      }
      _out('offline$_dev.json', res);
      return;
    }

    if (_role == 'verify') {
      final st = _state();
      final report = <String, Object?>{};
      final fails = <String>[];
      void check(bool ok, String what) {
        if (!ok) fails.add(what);
      }

      final devs = [
        for (final f in Directory(_dir).listSync().whereType<File>().where((f) => f.path.contains('/device')))
          jsonDecode(f.readAsStringSync()) as Map<String, dynamic>
      ];
      report['devices'] = devs.length;

      // 1. Закрытие одного чека с нескольких касс.
      final wins = devs.where((d) => d['close']['ok'] == true && d['close']['result'] == true).length;
      final close = (await server('sessions/${st['session_close']}'))!;
      final inv = (await server('inventoryItems/raceInv'))!;
      // Движения склада только этого прогона (стенд хранит прошлые).
      final moves = (await db.collection('tenants/$_tenant/inventoryMovements').where('itemId', isEqualTo: 'raceInv').get(const GetOptions(source: Source.server)))
          .docs
          .where((d) => ((d.data()['createdAt'] as Timestamp?)?.millisecondsSinceEpoch ?? 0) >= (st['seedAt'] as num))
          .toList();
      final table = (await server('tables/${st['table_close']}'))!;
      report['close'] = {
        'победителей': wins,
        'ответы': [for (final d in devs) d['close']],
        'статус': close['status'],
        'наличные': close['paymentCash'],
        'склад': inv['quantity'],
        'движений склада': moves.length,
        'стол': table['status'],
        'чеков на столе': (table['activeSessionIds'] as List?)?.length ?? 0,
      };
      check(wins == 1, 'оплату принял ровно один');
      check(close['status'] == 'closed', 'чек закрыт');
      // Пиво ×3 продаётся в двух чеках: «close» и «mixed» (если тот закрылся).
      final mixedClosed = (await server('sessions/${st['session_mixed']}'))?['status'] == 'closed';
      final offRan = File('$_dir/offline0.json').existsSync();
      final sold = (mixedClosed ? 2 : 1) + (offRan ? 1 : 0);
      check(moves.length == sold, 'склад списан по разу на закрытый чек');
      check(inv['quantity'] == 100 - 3 * sold, 'остаток ${100 - 3 * sold}');
      check(table['status'] == 'free', 'стол свободен');

      // 2. Позиции с нескольких устройств не теряются.
      final adds = SessionModel.fromDoc(await snap('sessions/${st['session_adds']}'));
      final perDev = {for (final i in adds.orderItems) i.menuItemId: i.qty};
      report['adds'] = {'позиции': perDev, 'ответы': [for (final d in devs) d['adds']]};
      for (var d = 0; d < devs.length; d++) {
        check(perDev['dev$d'] == 5, 'все 5 нажатий устройства $d в чеке');
      }

      // 3. Закрытие против добавления: оплаченная сумма = сумма закрытого чека.
      final mixedSnap = await snap('sessions/${st['session_mixed']}');
      final mixedDoc = mixedSnap.data()!;
      final mixed = SessionModel.fromDoc(mixedSnap);
      report['mixed'] = {
        'статус': mixedDoc['status'],
        'оплачено': mixedDoc['paymentCash'],
        'сумма чека': mixed.totalWithDiscount,
        'ответы': [for (final d in devs) d['mixed']],
      };
      if (mixedDoc['status'] == 'closed') {
        check((mixedDoc['paymentCash'] as num).toDouble() == mixed.totalWithDiscount, 'в закрытый чек ничего не дописалось');
      }

      // 4. Одновременное открытие чека на свободном столе: стол знает все открытые чеки.
      final openT = (await server('tables/${st['table_open']}'))!;
      final opened = [for (final d in devs) if (d['open']['ok'] == true) d['open']['result']];
      final ids = ((openT['activeSessionIds'] as List?) ?? const []).map((e) => '$e').toSet();
      report['open'] = {'открыто': opened.length, 'на столе': ids.length, 'статус': openT['status'], 'ответы': [for (final d in devs) d['open']]};
      for (final s in opened) {
        final doc = await server('sessions/$s');
        if (doc?['status'] == 'active') check(ids.contains(s), 'открытый чек $s числится на столе');
      }
      // 5. Касса без связи закрыла чек, который другая касса уже закрыла онлайн.
      if (File('$_dir/offline0.json').existsSync()) {
        final o0 = jsonDecode(File('$_dir/offline0.json').readAsStringSync());
        final o1 = jsonDecode(File('$_dir/offline1.json').readAsStringSync());
        final offDoc = (await server('sessions/${st['session_off']}'))!;
        final offTable = (await server('tables/${st['table_off']}'))!;
        final allMoves = moves.length;
        report['offline'] = {
          'без связи': o0, 'онлайн': o1,
          'наличные': offDoc['paymentCash'], 'карта': offDoc['paymentCard'], 'кто закрыл': offDoc['closedBy'] ?? offDoc['employeeName'],
          'стол': offTable['status'], 'движений склада всего': allMoves,
        };
        check(offDoc['status'] == 'closed', 'чек «off» закрыт');
        check((offDoc['paymentCash'] as num?) == 600 && (offDoc['paymentCard'] as num?) == 0, 'оплата онлайн-кассы не затёрта кассой без связи');
        check(offTable['status'] == 'free', 'стол «off» свободен');
        check('${o0['rejected']}'.contains('уже закрыли на другой кассе'), 'касса без связи узнала, что её оплату не записали');
        check(o0['close']['ok'] == true, 'касса без связи закрыла чек без ошибки');
      }
      _out('report.json', report);
      // ignore: avoid_print
      print(const JsonEncoder.withIndent('  ').convert(report));
      expect(fails, isEmpty);
    }
  }, skip: skip, timeout: const Timeout(Duration(minutes: 3)));
}
