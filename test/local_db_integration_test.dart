// Клиент собственного сервера данных против настоящего сервера (data-server.js
// с правилами saas/firestore.rules). Запуск вручную:
//   node saas-gateway/test-data-harness.js 8787 &
//   LOCAL_DB_URL=http://127.0.0.1:8787 flutter test test/local_db_integration_test.dart
// Без LOCAL_DB_URL тесты пропускаются.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';

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

Future<void> _offline(bool on) => http.post(Uri.parse('$_url/__offline'), body: jsonEncode({'on': on}));

Future<T> _until<T>(Stream<T> s, bool Function(T) ok, {Duration timeout = const Duration(seconds: 8)}) =>
    s.firstWhere(ok).timeout(timeout);

void main() {
  final skip = _url.isEmpty ? 'нет LOCAL_DB_URL' : null;
  late Directory tmp;
  final engines = <LocalEngine>[];

  LocalFirestore open(String uid, {Directory? dir}) {
    final e = LocalEngine(baseUrl: _url, storageDir: dir ?? Directory('${tmp.path}/${engines.length}'), auth: _TestAuth(uid));
    engines.add(e);
    e.start();
    return LocalFirestore(e);
  }

  setUpAll(() {
    FieldValueRecorder.install();
    tmp = Directory.systemTemp.createTempSync('localdb');
  });
  tearDownAll(() async {
    for (final e in engines) {
      e.dispose();
    }
    if (_url.isNotEmpty) await _offline(false);
  });

  test('чтение, запрос, отказ в чужих данных', () async {
    final db = open('ownerA');
    final t1 = await db.doc('tenants/tenantA/tables/t1').get();
    expect(t1.exists, isTrue);
    expect(t1.data()!['name'], 'Стол 1');
    expect(t1.metadata.isFromCache, isFalse);
    final all = await db.collection('tenants/tenantA/tables').get();
    expect(all.docs.map((d) => d.id).toSet(), containsAll(['t1', 't2']));
    final filtered = await db.collection('tenants/tenantA/tables').where('x', isGreaterThan: 0.2).get();
    expect(filtered.docs.map((d) => d.id), contains('t2'));
    expect(filtered.docs.map((d) => d.id), isNot(contains('t1')));
    await expectLater(db.doc('tenants/tenantB/tables/t1').get(),
        throwsA(isA<FirebaseException>().having((e) => e.code, 'code', 'permission-denied')));
  }, skip: skip);

  test('живая подписка: запись с другого устройства, своя запись видна сразу', () async {
    final a = open('ownerA');
    final b = open('ownerA');
    final col = a.collection('tenants/tenantA/tables');
    final events = col.snapshots().asBroadcastStream();
    final first = await _until(events, (s) => !s.metadata.isFromCache);
    expect(first.docs.length, greaterThanOrEqualTo(2));
    final sw = Stopwatch()..start();
    unawaited(b.doc('tenants/tenantA/tables/t3').set({'name': 'Стол 3', 'x': 0.9}));
    final got = await _until(events, (s) => s.docs.any((d) => d.id == 't3'));
    expect(got.docChanges.any((c) => c.type == DocumentChangeType.added && c.doc.id == 't3'), isTrue);
    // ignore: avoid_print
    print('запись другого устройства пришла за ${sw.elapsedMilliseconds} мс');
    // Своя запись — в снимке до ответа сервера.
    final local = _until(events, (s) => s.docs.any((d) => d.id == 't1' && d.data()['name'] == 'Стол 1*'), timeout: const Duration(milliseconds: 300));
    final write = a.doc('tenants/tenantA/tables/t1').update({'name': 'Стол 1*'});
    final snap = await local;
    expect(snap.docs.firstWhere((d) => d.id == 't1').metadata.hasPendingWrites, isTrue);
    await write;
    final fromB = await b.doc('tenants/tenantA/tables/t1').get();
    expect(fromB.data()!['name'], 'Стол 1*');
  }, skip: skip);

  test('служебные значения: время сервера, увеличение, массивы, удаление поля', () async {
    final db = open('ownerA');
    final ref = db.doc('tenants/tenantA/tables/fv');
    final events = ref.snapshots().asBroadcastStream();
    await ref.set({'n': 1, 'tags': ['a'], 'tmp': true, 'at': FieldValue.serverTimestamp()});
    await ref.update({'n': FieldValue.increment(2), 'tags': FieldValue.arrayUnion(['b']), 'tmp': FieldValue.delete()});
    final s = await _until(events, (s) => s.exists && s.data()!['n'] == 3 && !s.metadata.hasPendingWrites);
    expect(s.data()!['tags'], ['a', 'b']);
    expect(s.data()!.containsKey('tmp'), isFalse);
    expect(s.data()!['at'], isA<Timestamp>());
    await ref.set({'when': DateTime.fromMillisecondsSinceEpoch(5000)}, SetOptions(merge: true));
    expect((await ref.get()).data()!['when'], Timestamp.fromMillisecondsSinceEpoch(5000));
  }, skip: skip);

  test('транзакции с двух устройств не теряют увеличений', () async {
    final a = open('ownerA');
    final b = open('ownerA');
    await a.doc('tenants/tenantA/tables/cnt').set({'n': 0});
    Future<void> inc(LocalFirestore db) => db.runTransaction((tx) async {
          final ref = db.doc('tenants/tenantA/tables/cnt');
          final cur = await tx.get(ref);
          await Future<void>.delayed(const Duration(milliseconds: 30));
          tx.update(ref, {'n': (cur.data()!['n'] as num) + 1});
        });
    await Future.wait([inc(a), inc(b), inc(a), inc(b)]);
    expect((await a.doc('tenants/tenantA/tables/cnt').get(const GetOptions(source: Source.server))).data()!['n'], 4);
  }, skip: skip);

  test('без интернета: запись в очередь, чтение из памяти, транзакция — unavailable', () async {
    final a = open('ownerA');
    final b = open('ownerA');
    await a.collection('tenants/tenantA/tables').get(); // в память устройства
    await _offline(true);
    final write = a.doc('tenants/tenantA/tables/off').set({'name': 'Офлайн', 'x': 0.5});
    final cached = await a.doc('tenants/tenantA/tables/off').get(const GetOptions(source: Source.cache));
    expect(cached.data()!['name'], 'Офлайн');
    final q = await a.collection('tenants/tenantA/tables').get();
    expect(q.metadata.isFromCache, isTrue);
    expect(q.docs.map((d) => d.id), containsAll(['t1', 'off']));
    await expectLater(a.runTransaction((tx) async => tx.get(a.doc('tenants/tenantA/tables/t1'))),
        throwsA(isA<FirebaseException>().having((e) => e.code, 'code', 'unavailable')));
    await _offline(false);
    a.engine.reconnectNow();
    await write.timeout(const Duration(seconds: 20));
    expect((await b.doc('tenants/tenantA/tables/off').get()).data()!['name'], 'Офлайн');
  }, skip: skip);

  test('память устройства и очередь записей переживают перезапуск', () async {
    final dir = Directory('${tmp.path}/restart')..createSync();
    final a = open('ownerA', dir: dir);
    await a.doc('tenants/tenantA/tables/t2').get();
    await _offline(true);
    unawaited(a.doc('tenants/tenantA/tables/later').set({'name': 'После перезапуска'}).catchError((Object _) {}));
    await Future<void>.delayed(const Duration(milliseconds: 50));
    await a.engine.flushToDisk();
    a.engine.dispose();
    final again = LocalEngine(baseUrl: _url, storageDir: dir, auth: _TestAuth('ownerA'));
    engines.add(again);
    await again.load();
    final db2 = LocalFirestore(again);
    final cached = await db2.doc('tenants/tenantA/tables/t2').get(const GetOptions(source: Source.cache));
    expect(cached.data()!['name'], 'Стол 2');
    expect(again.pending.length, 1);
    await _offline(false);
    again.start();
    await again.waitForPendingWrites().timeout(const Duration(seconds: 20));
    final check = open('ownerA');
    expect((await check.doc('tenants/tenantA/tables/later').get()).data()!['name'], 'После перезапуска');
  }, skip: skip);

  test('отказ сервера снимает запись и возвращает ошибку', () async {
    final a = open('ownerA');
    await expectLater(a.doc('tenants/tenantB/tables/x').set({'name': 'чужое'}),
        throwsA(isA<FirebaseException>().having((e) => e.code, 'code', 'permission-denied')));
    expect(a.engine.pending, isEmpty);
    expect(a.engine.view('tenants/tenantB/tables/x').exists, isFalse);
  }, skip: skip);
}
