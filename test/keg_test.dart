import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/employee.dart';
import 'package:hookah_pos/screens/employee/kegs_screen.dart';
import 'package:hookah_pos/models/fiscal_receipt.dart';
import 'package:hookah_pos/models/inventory_models.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/services/atol_local_kassa.dart';
import 'package:hookah_pos/services/kassa_service.dart';
import 'package:hookah_pos/services/keg_service.dart';

const _code = '0104600000000000215ABCDEFGHIJKLM\u001d93dGVz';

void main() {
  // Настоящий шрифт — до экранных тестов (загрузка внутри теста оставляет кадр после него).
  setUpAll(() async {
    final l = FontLoader('Onest');
    for (final w in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
      l.addFont(Future.value(ByteData.sublistView(File('assets/fonts/Onest-$w.ttf').readAsBytesSync())));
    }
    await l.load();
  });
  final kegA = Keg(id: 'a', code: _code, name: 'Светлое', volumeL: 30, pouredL: 29.2, portions: const {'beer05': 0.5, 'beer03': 0.3}, connectedAt: DateTime(2026, 11, 20));
  final kegB = Keg(id: 'b', code: '${_code}B', name: 'Светлое', volumeL: 30, portions: const {'beer05': 0.5}, connectedAt: DateTime(2026, 11, 22));

  test('кега: остаток, своя кега для позиции (старая — первой), литры по чеку', () {
    expect(kegA.leftL, 0.8);
    expect(kegA.leftShare, closeTo(0.0267, 0.001));
    expect(kegForItem([kegB, kegA], 'beer05')!.id, 'a', reason: 'допиваем старую кегу');
    expect(kegForItem([kegB, kegA], 'tea'), isNull);
    final pour = pourByKeg([kegA, kegB], [
      OrderItem(menuItemId: 'beer05', name: 'Пиво 0,5', price: 300, qty: 2),
      OrderItem(menuItemId: 'beer03', name: 'Пиво 0,3', price: 200, qty: 1),
      OrderItem(menuItemId: 'tea', name: 'Чай', price: 100, qty: 1),
    ]);
    expect(pour, {'a': closeTo(1.3, 0.0001)});
    expect(portionLitersOf(MenuItem(id: 'x', categoryId: '', name: 'Пиво', price: 1, weight: 500, weightUnit: InventoryUnit.ml)), 0.5);
    expect(portionLitersOf(MenuItem(id: 'x', categoryId: '', name: 'Пиво', price: 1, weight: 1, weightUnit: InventoryUnit.l)), 1);
    expect(portionLitersOf(MenuItem(id: 'x', categoryId: '', name: 'Пицца', price: 1, weight: 300)), 0);
  });

  test('чек: порция из кеги — код кеги, литры, мера «литр», мерный товар', () {
    const item = FiscalReceiptItem(
      name: 'Светлое 0,5', price: 600, quantity: 1, unit: 'l', markingCode: _code, paymentObject: FiscalPaymentObject.excise);
    expect(item.sum, 600);
    expect(item.measured, isTrue);
    const receipt = FiscalReceipt(receiptId: 'k1', items: [item], payments: [FiscalPayment('cash', 600)]);
    final atol = AtolCloudKassaService(
      apiVersion: 'v5', baseUrl: 'http://x/', groupCode: 'G', login: 'l', password: 'p',
      companyInn: '7700000000', companyEmail: 'a@b.ru', companyPaymentAddress: 'М', companySno: FiscalTaxSystem.usnIncome,
    );
    final v5 = ((atol.buildReceiptBody(receipt)['receipt'] as Map)['items'] as List).single as Map;
    expect(v5['measure'], 41);
    expect(v5['payment_object'], 31, reason: 'подакцизный маркированный');
    expect((v5['mark_code'] as Map)['gs1m'], isNotEmpty);
    final od = OrangeDataKassaService(inn: '7700000000', clientCertPem: 'c', clientKeyPem: 'k');
    final pos = ((od.buildDocument(receipt)['content'] as Map)['positions'] as List).single as Map;
    expect(pos['quantityMeasurementUnit'], 41);
    expect(pos['plannedStatus'], 2);
    final local = AtolLocalKassaService(address: '10.0.0.5', taxSystem: FiscalTaxSystem.usnIncome);
    final it = (local.buildTask(receipt)['items'] as List).single as Map;
    expect(it['measurementUnit'], 'liter');
    expect((it['imcParams'] as Map)['itemEstimatedStatus'], 'itemDryForSale');
    // Штучный маркированный — как раньше.
    const piece = FiscalReceipt(receiptId: 'k2', items: [FiscalReceiptItem(name: 'Бутылка', price: 200, quantity: 1, markingCode: _code)], payments: [FiscalPayment('cash', 200)]);
    expect((((od.buildDocument(piece)['content'] as Map)['positions'] as List).single as Map)['plannedStatus'], 1);
  });

  testWidgets('карточки кег на телефоне: остаток, мало — жёлтым, без переполнения', (t) async {
    await t.binding.setSurfaceSize(const Size(412, 720));
    addTearDown(() => t.binding.setSurfaceSize(null));
    final key = GlobalKey();
    final emp = Employee(id: 'e1', name: 'Анна', pinCode: '', role: 'employee');
    await t.pumpWidget(MaterialApp(
      theme: ThemeData(fontFamily: 'Onest'),
      home: Scaffold(
        body: RepaintBoundary(
          key: key,
          child: ListView(padding: const EdgeInsets.all(16), children: [
            KegCard(keg: Keg(id: 'a', code: _code, name: 'Светлое нефильтрованное', volumeL: 30, pouredL: 26, czNotified: true), employee: emp),
            KegCard(keg: Keg(id: 'b', code: '${_code}B', name: 'Тёмное', volumeL: 20, pouredL: 6.5), employee: emp),
          ]),
        ),
      ),
    ));
    await t.pump();
    expect(find.text('4 л из 30 л'), findsOneWidget);
    expect(find.text('13,5 л из 20 л'), findsOneWidget);
    expect(find.text('Не забудьте — в течение 3 рабочих дней'), findsOneWidget);
    expect(t.takeException(), isNull);
    final dir = Platform.environment['SHOT_DIR'];
    if (dir != null) {
      await t.runAsync(() async {
        final img = await (key.currentContext!.findRenderObject() as RenderRepaintBoundary).toImage(pixelRatio: 2);
        final png = await img.toByteData(format: ui.ImageByteFormat.png);
        File('$dir/kegs.png').writeAsBytesSync(png!.buffer.asUint8List());
      });
    }
  });
}
