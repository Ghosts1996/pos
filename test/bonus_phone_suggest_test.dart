import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/data/app_db.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';
import 'package:hookah_pos/services/app_scope.dart';
import 'package:hookah_pos/services/people_directory.dart';
import 'package:hookah_pos/widgets/bonus_redeem_panel.dart';

class _NoAuth implements EngineAuth {
  @override
  String get uid => 'cashier';
  @override
  Future<String?> token({bool force = false}) async => null;
  @override
  Stream<String> get uidChanges => const Stream.empty();
}

class _FakePeople extends People {
  int calls = 0;
  @override
  Future<List<PdGuest>> searchGuests(String q) async {
    calls++;
    return const [
      PdGuest(uid: 'g1', name: 'Ира', phone: '79443312345'),
      PdGuest(uid: 'g2', name: 'Олег', phone: '79001114433'),
      PdGuest(uid: 'g3', name: '', phone: '79005554433'),
    ];
  }
}

// Экран оплаты → «Бонусы гостя»: при вводе номера — список гостей, тот, чей
// номер кончается на набранные цифры, — первым.
void main() {
  late People saved;
  setUpAll(() {
    if (!kSaasMode) return;
    // Своя база без сервера: профиль гостя по чеку не найдётся — и не надо,
    // проверяем только подсказки.
    final engine = LocalEngine(baseUrl: 'http://127.0.0.1:9', storageDir: Directory.systemTemp.createTempSync('bsug'), auth: _NoAuth());
    AppDb.debugUse(LocalFirestore(engine), engine: engine);
  });
  setUp(() {
    saved = People.instance;
    AppScope.enterTenant('t-test');
  });
  tearDown(() {
    People.instance = saved;
    AppScope.reset();
  });

  for (final scale in [1.0, 1.6]) {
    testWidgets('подсказки номеров, «4433» — Олег первым (шрифт ×$scale)', (tester) async {
      // Подсказки — только в ZalPOS (SaaS); сборка hookah-pos — без них
      // и без своей базы в тестах.
      if (!kSaasMode) return;
      final fake = _FakePeople();
      People.instance = fake;
      await tester.binding.setSurfaceSize(const Size(380, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(size: const Size(380, 900), textScaler: TextScaler.linear(scale)),
          child: Scaffold(
            body: SingleChildScrollView(
              child: BonusRedeemPanel(sessionId: 's1', billTotal: 1000, onApplied: (_, __) {}),
            ),
          ),
        ),
      ));
      await tester.pump();
      await tester.enterText(find.byType(TextField).first, '44');
      await tester.pump(const Duration(milliseconds: 300));
      expect(fake.calls, 0, reason: 'две цифры — рано искать');
      await tester.enterText(find.byType(TextField).first, '4433');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();
      expect(fake.calls, 1);
      final oleg = tester.getTopLeft(find.text('Олег'));
      final ira = tester.getTopLeft(find.text('Ира'));
      expect(oleg.dy < ira.dy, isTrue, reason: 'номер Олега кончается на 4433 — он выше');
      expect(find.text('Гость без имени'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
