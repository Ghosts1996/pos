// Заказ гостя в сборке платформы: части (официанту, кальянщику) — одной
// записью, повтор той же корзины (ответ потерялся, второе нажатие) — не
// второй заказ. Запуск: flutter test --dart-define=SAAS_MODE=true test/guest_order_once_test.dart

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/data/app_db.dart';
import 'package:hookah_pos/data/local_engine.dart';
import 'package:hookah_pos/data/local_firestore.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/services/app_scope.dart';
import 'package:hookah_pos/services/guest_link_service.dart';

class _OfflineAuth implements EngineAuth {
  @override
  String get uid => 'guest1';
  @override
  Future<String?> token({bool force = false}) async => 'test:guest1';
  @override
  Stream<String> get uidChanges => const Stream.empty();
}

void main() {
  test('повтор той же корзины — тот же заказ, части одной записью', () async {
    FieldValueRecorder.install();
    final engine = LocalEngine(baseUrl: 'http://127.0.0.1:9', storageDir: Directory.systemTemp.createTempSync('go'), auth: _OfflineAuth());
    final db = LocalFirestore(engine);
    AppDb.debugUse(db, engine: engine);
    AppScope.enterTenant('t1');
    final link = GuestLinkService();
    final items = [
      OrderItem(menuItemId: 'm1', name: 'Капучино', price: 200, qty: 2),
      OrderItem(menuItemId: 'm2', name: 'Кальян классика', price: 1500, qty: 1, noPromo: true),
    ];
    Future<List<String>> send() => link.placeRoutedGuestOrder(sessionId: 's1', tableId: 'tb1', items: items, clientUid: 'guest1');
    if (kSaasMode) {
      // Запись прошла, ответ потерялся — гостю показали ошибку.
      GuestLinkService.debugLoseReply = true;
      await expectLater(send(), throwsA(isA<StateError>()));
      final orders1 = await db.collection('tenants/t1/guestOrders').get();
      expect(engine.pending.length, 1, reason: 'обе части — одной пачкой');
      expect(orders1.docs.length, 2, reason: 'официанту и кальянщику');
      // Гость нажал «Отправить» ещё раз — второго заказа нет.
      final again = await send();
      expect(again.length, 2);
      final orders2 = await db.collection('tenants/t1/guestOrders').get();
      expect(orders2.docs.length, 2, reason: 'повтор не создал второй заказ');
      expect(engine.pending.length, 1);
      // Новый заказ после успешного — уже отдельный.
      await send();
      expect((await db.collection('tenants/t1/guestOrders').get()).docs.length, 4);
    } else {
      await send();
      expect((await db.collection('tenants/t1/guestOrders').get()).docs, isNotEmpty);
    }
    engine.dispose();
  }, skip: kSaasMode ? null : 'только для сборки платформы (--dart-define=SAAS_MODE=true)');
}
