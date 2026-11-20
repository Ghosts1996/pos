// Облачная печать через настоящий сервер данных (правила saas/firestore.rules):
// телефон без принтера → printJobs → касса «Печатать за всех» печатает.
//   node saas-gateway/test-data-harness.js 8787 &
//   LOCAL_DB_URL=http://127.0.0.1:8787 flutter test --dart-define=SAAS_MODE=true test_saas/print_hub_test.dart

// ignore_for_file: invalid_use_of_visible_for_testing_member — это тест
@Timeout(Duration(minutes: 5))
library;

import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/data/app_db.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';
import 'package:hookah_pos/services/app_scope.dart';
import 'package:hookah_pos/services/print_hub.dart';
import 'package:hookah_pos/services/printer_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/harness_lock.dart';

class _TestAuth implements EngineAuth {
  _TestAuth(this.uid);
  @override
  final String uid;
  @override
  Future<String?> token({bool force = false}) async => 'test:$uid';
  @override
  Stream<String> get uidChanges => const Stream.empty();
}

class _Printer extends ReceiptPrinter {
  _Printer({this.fail});
  final String? fail;
  final sent = <List<int>>[];
  @override
  bool get isConnected => true;
  @override
  Future<bool> connect() async => true;
  @override
  Future<void> disconnect() async {}
  @override
  Future<void> printBytes(List<int> bytes) async {
    if (fail != null) throw PrinterException(fail!);
    sent.add(bytes);
  }
}

final _url = Platform.environment['LOCAL_DB_URL'] ?? '';
final _tenant = Platform.environment['LOCAL_DB_TENANT'] ?? 'tenantA';

void main() {
  requireSaasHarness(url: _url);
  useHarnessExclusively(_url);
  late LocalEngine engine;

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    FieldValueRecorder.install();
    final dir = Directory.systemTemp.createTempSync('printhub');
    engine = LocalEngine(baseUrl: _url, storageDir: dir, auth: _TestAuth('ownerA'));
    engine.start();
    AppDb.debugUse(LocalFirestore(engine), engine: engine);
    AppScope.enterTenant(_tenant);
    // Прошлый запуск мог оставить отметку кассы.
    await AppScope.col(PrintHub.collection).doc(PrintHub.beatDoc).delete();
  });
  tearDownAll(() {
    PrintHub.stop();
    engine.dispose();
  });

  Future<bool> jobsLeft() async {
    final q = await AppScope.col(PrintHub.collection).get(const GetOptions(source: Source.server));
    return q.docs.any((d) => d.id != PrintHub.beatDoc);
  }

  test('кассы с принтером нет на связи — телефон говорит сразу', () async {
    await expectLater(HubReceiptPrinter().printBytes([1, 2, 3]),
        throwsA(isA<PrinterException>().having((e) => e.message, 'm', contains('не на связи'))));
    expect(await jobsLeft(), isFalse, reason: 'задание даже не создаётся');
  });

  test('телефон → сервер → касса печатает, задание удаляется', () async {
    final hub = _Printer();
    await PrintHub.start(hub, label: 'Касса 1');
    await HubReceiptPrinter(from: 'Официант').printBytes([0x1B, 0x40, 0xC0, 0xFF]);
    expect(hub.sent, [
      [0x1B, 0x40, 0xC0, 0xFF]
    ]);
    // Второй и третий чек подряд — по порядку, без потерь.
    await Future.wait([HubReceiptPrinter().printBytes([1]), HubReceiptPrinter().printBytes([2])]);
    expect(hub.sent.length, 3);
    expect(await jobsLeft(), isFalse);
  });

  test('у кассы кончилась бумага — телефон видит причину', () async {
    await PrintHub.start(_Printer(fail: 'кончилась бумага'));
    await expectLater(HubReceiptPrinter().printBytes([1]),
        throwsA(isA<PrinterException>().having((e) => e.message, 'm', contains('кончилась бумага'))));
    expect(await jobsLeft(), isFalse);
  });

  test('старое задание (касса была выключена) не печатается через час', () async {
    PrintHub.stop();
    await AppScope.col(PrintHub.collection).doc('old').set({'status': 'new', 'data': 'AQ==', 'createdAt': 1});
    final hub = _Printer();
    await PrintHub.start(hub);
    for (var i = 0; i < 40 && await jobsLeft(); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    await PrintHub.idle();
    expect(hub.sent, isEmpty);
    expect(await jobsLeft(), isFalse);
  });

  test('касса не ответила — телефон не ждёт вечно, задание убирается', () async {
    await PrintHub.start(_Printer());
    PrintHub.stop(); // отметка свежая, но касса уже не слушает
    PrintHub.waitFor = const Duration(seconds: 2);
    try {
      await expectLater(HubReceiptPrinter().printBytes([1]),
          throwsA(isA<PrinterException>().having((e) => e.message, 'm', contains('не ответила'))));
    } finally {
      PrintHub.waitFor = const Duration(seconds: 25);
    }
    expect(await jobsLeft(), isFalse);
  });
}
