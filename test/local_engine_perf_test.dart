// Скорость движка данных кассы в час пик без интернета: очередь записей
// растёт, экраны подписаны на запросы. Время ответа не должно расти
// квадратично от длины очереди.

import 'dart:async';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';

class _OfflineAuth implements EngineAuth {
  @override
  String get uid => 'dev1';
  @override
  Future<String?> token({bool force = false}) async => 'test:dev1';
  @override
  Stream<String> get uidChanges => const Stream.empty();
}

void main() {
  test('час пик без интернета: 1500 чеков в очереди, 10 подписок, 200 изменений', timeout: const Timeout(Duration(minutes: 5)), () async {
    final t0 = Stopwatch()..start();
    FieldValueRecorder.install();
    final dir = Directory.systemTemp.createTempSync('perf');
    // Сервер недоступен — все записи копятся в очереди на устройстве.
    final engine = LocalEngine(baseUrl: 'http://127.0.0.1:9', storageDir: dir, auth: _OfflineAuth());
    final db = LocalFirestore(engine);
    final col = db.collection('tenants/t1/sessions');
    for (var i = 0; i < 1500; i++) {
      unawaited(col.doc('s$i').set({'status': i % 3 == 0 ? 'active' : 'closed', 'tableId': 't${i % 40}', 'total': i}));
    }
    await Future<void>.delayed(Duration.zero);
    // ignore: avoid_print
    print('1500 записей в очередь: ${t0.elapsedMilliseconds} мс');
    var events = 0;
    final subs = <StreamSubscription<Object?>>[
      for (var k = 0; k < 10; k++)
        col.where('tableId', isEqualTo: 't$k').snapshots().listen((_) => events++),
    ];
    await Future<void>.delayed(const Duration(milliseconds: 50));
    // ignore: avoid_print
    print('подписки: ${t0.elapsedMilliseconds} мс');
    final sw = Stopwatch()..start();
    for (var i = 0; i < 200; i++) {
      unawaited(col.doc('s${i * 7}').update({'total': FieldValue.increment(1)}));
      await Future<void>.delayed(Duration.zero);
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
    sw.stop();
    // ignore: avoid_print
    print('200 изменений при очереди ${engine.pending.length}: ${sw.elapsedMilliseconds} мс, событий $events');
    expect(events, greaterThan(0));
    // Порог с запасом для медленных машин CI: до ускорения было несколько секунд.
    expect(sw.elapsedMilliseconds, lessThan(1500));
    final r = await col.where('tableId', isEqualTo: 't3').get(const GetOptions(source: Source.cache));
    expect(r.docs.length, 38, reason: 'запрос по кэшу с очередью — верный результат');
    expect(r.docs.every((d) => d.data()['tableId'] == 't3'), isTrue);
    for (final s in subs) {
      await s.cancel();
    }
    engine.dispose();
  });
}
