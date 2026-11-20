// Экран «Интеграции» → «Чековый принтер» (SaaS) строится на настоящем
// сервере данных и сохраняет ленту, кодировку, ящик и облачную печать.
// ignore_for_file: invalid_use_of_visible_for_testing_member — это тест
@Timeout(Duration(minutes: 5))
library;

import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/data/app_db.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';
import 'package:hookah_pos/screens/admin/integrations_settings_screen.dart';
import 'package:hookah_pos/services/app_scope.dart';
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

final _url = Platform.environment['LOCAL_DB_URL'] ?? '';
final _tenant = Platform.environment['LOCAL_DB_TENANT'] ?? 'tenantA';

void main() {
  // testWidgets подменяет HTTP заглушкой (всё — 400); здесь нужен настоящий
  // сервер данных.
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  requireSaasHarness(url: _url);
  useHarnessExclusively(_url);
  late LocalEngine engine;

  setUpAll(() {
    SharedPreferences.setMockInitialValues({});
    FieldValueRecorder.install();
    engine = LocalEngine(baseUrl: _url, storageDir: Directory.systemTemp.createTempSync('prnscr'), auth: _TestAuth('ownerA'));
    engine.start();
    AppDb.debugUse(LocalFirestore(engine), engine: engine);
    AppScope.enterTenant(_tenant);
  });
  tearDownAll(() => engine.dispose());

  testWidgets('настройки принтера: лента 80 мм, кодировка, ящик, облачная печать', (tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.runAsync(() => AppScope.col('settings').doc('integrations').set({'printerType': 'network', 'printerIp': '192.168.1.50'}));
    await tester.pumpWidget(const MaterialApp(home: IntegrationsSettingsScreen()));
    for (var i = 0; i < 40 && find.text('Чековый принтер').evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump();
    }
    await tester.tap(find.text('Чековый принтер'));
    await tester.pumpAndSettle();
    expect(find.text('Ширина ленты'), findsOneWidget);
    expect(find.byTooltip('Найти в сети'), findsOneWidget);
    expect(find.text('Облачная печать'), findsOneWidget);
    expect(find.text('Принтер этого устройства'), findsOneWidget, reason: 'тесты идут как Android: есть USB через RawBT');
    expect(find.text('USB-принтер (OTG)'), findsOneWidget);

    await tester.ensureVisible(find.text('80 мм'));
    await tester.tap(find.text('80 мм'));
    await tester.ensureVisible(find.text('Открывать денежный ящик при оплате наличными'));
    await tester.tap(find.text('Открывать денежный ящик при оплате наличными'));
    await tester.ensureVisible(find.text('Облачная печать'));
    await tester.tap(find.text('Облачная печать'));
    await tester.pumpAndSettle();
    expect(find.text('Открыть ящик (проверка)'), findsOneWidget);
    expect(find.text('Это устройство печатает за всех'), findsOneWidget);
    expect(tester.takeException(), isNull);

    final save = find.widgetWithText(FilledButton, 'Сохранить');
    await tester.ensureVisible(save.first);
    await tester.tap(save.first);
    for (var i = 0; i < 30; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump();
    }
    final data = (await tester.runAsync(() => AppScope.col('settings').doc('integrations').get(const GetOptions(source: Source.server))))!.data()!;
    expect(data['printerPaper'], '80');
    expect(data['printerEncoding'], 'cp866');
    expect(data['printerDrawerOnCash'], isTrue);
    expect(data['printHub'], isTrue);
    expect(drawerOnCash, isTrue);
    expect(activeReceiptPrinter, isA<NetworkReceiptPrinter>(), reason: 'свой сетевой принтер главнее облачной печати');
    // Снекбар «Сохранено» держит таймер — дожидаемся его.
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 5));
  });
}
