import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/fiscal_receipt.dart';
import 'package:hookah_pos/models/inventory_models.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/services/atol_local_kassa.dart';
import 'package:hookah_pos/services/kassa_service.dart';
import 'package:hookah_pos/services/scales/scale.dart';
import 'package:hookah_pos/utils/recipe_math.dart';
import 'package:hookah_pos/utils/weighed.dart';
import 'package:hookah_pos/widgets/weigh_dialog.dart';

void main() {
  test('вес строки: подпись, разбор, цена', () {
    expect(weightLabel(0.35), '0,350 кг');
    expect(weightLabel(1.2), '1,200 кг');
    expect(weightKgOf(['Без соуса', '0,350 кг']), 0.35);
    expect(weightKgOf(['Сыр']), 0);
    expect(isWeightMod('12,005 кг'), isTrue);
    expect(weighedPrice(1290, 0.35), 451.5);
    expect(weighedPrice(999.99, 0.333), 333.0);
  });

  test('ввод веса кассиром: граммы и килограммы', () {
    expect(parseWeightInput('350'), 0.35);
    expect(parseWeightInput('0,35'), 0.35);
    expect(parseWeightInput('1.2 кг'), 1.2);
    expect(parseWeightInput('250 г'), 0.25);
    expect(parseWeightInput('0'), isNull);
    expect(parseWeightInput('200 кг'), isNull);
    expect(parseWeightInput('абв'), isNull);
  });

  test('«Масса-К», протокол 100: запрос веса и разбор ответа', () {
    final req = massaKPacket(cmdGetMassa);
    expect(req.sublist(0, 6), [0xF8, 0x55, 0xCE, 0x01, 0x00, 0x23]);
    expect(req.length, 8);
    // Ответ: 350 г при цене деления 1 г, стабильно.
    final body = [cmdAckMassa, 0x5E, 0x01, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00];
    final crc = crc16(body);
    final pkt = [0xF8, 0x55, 0xCE, body.length, 0, ...body, crc & 0xFF, crc >> 8];
    final r = parseMassaK([0x00, ...pkt])!;
    expect(r.kg, 0.35);
    expect(r.stable, isTrue);
    // Неполный пакет — ждём дальше.
    expect(parseMassaK(pkt.sublist(0, 7)), isNull);
    expect(() => parseMassaK([0xF8, 0x55, 0xCE, 2, 0, cmdError, 0x17, 0, 0]), throwsStateError);
    expect(crc16([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]), 0x31C3, reason: 'CRC-16/XMODEM');
  });

  test('весы на COM-порту: строки разных весов', () {
    var r = parseScaleText('ST,GS,+  0.350kg\r\nST,GS,+  0.352kg\r\n')!;
    expect(r.kg, 0.352);
    expect(r.stable, isTrue);
    r = parseScaleText('US,GS,+  1.205kg\r\n')!;
    expect(r.stable, isFalse);
    expect(parseScaleText('\x02  350 g\x03')!.kg, 0.35);
    expect(parseScaleText('W: 1,250 кг')!.kg, 1.25);
    expect(parseScaleText('')?.kg, isNull);
  });

  test('чек: весовой товар — количество в кг, мера «кг» у всех касс', () {
    const item = FiscalReceiptItem(name: 'Сыр (0,350 кг)', price: 1290, quantity: 0.35, unit: 'kg');
    expect(item.sum, 451.5);
    final receipt = const FiscalReceipt(receiptId: 'w1', items: [item], payments: [FiscalPayment('cash', 451.5)]);
    final atol = AtolCloudKassaService(
      apiVersion: 'v5', baseUrl: 'http://x/', groupCode: 'G', login: 'l', password: 'p',
      companyInn: '7700000000', companyEmail: 'a@b.ru', companyPaymentAddress: 'М', companySno: FiscalTaxSystem.usnIncome,
    );
    final v5 = (atol.buildReceiptBody(receipt)['receipt'] as Map)['items'] as List;
    expect((v5.single as Map)['measure'], 11);
    expect((v5.single as Map)['quantity'], 0.35);
    final od = OrangeDataKassaService(inn: '7700000000', clientCertPem: 'c', clientKeyPem: 'k');
    final pos = ((od.buildDocument(receipt)['content'] as Map)['positions'] as List).single as Map;
    expect(pos['quantityMeasurementUnit'], 11);
    final local = AtolLocalKassaService(address: '10.0.0.5', taxSystem: FiscalTaxSystem.usnIncome);
    final task = local.buildTask(receipt);
    expect(((task['items'] as List).single as Map)['measurementUnit'], 'kilogram');
    // Скидка суммой сохраняет меру.
    final spread = spreadDiscount(const [item], const [true], 50);
    expect(spread.items.every((i) => i.unit == 'kg'), isTrue);
    expect(FiscalReceiptItem.fromJson(item.toJson()).unit, 'kg');
  });

  test('склад: весовой товар списывается по весу (рецепт на 1 кг)', () {
    final cheese = InventoryItem(id: 'c', name: 'Сыр', unit: InventoryUnit.g, quantity: 5000);
    final m = MenuItem(id: 'm', categoryId: '', name: 'Сыр', price: 1290, byWeight: true, inventoryItemId: 'c', weight: 1000);
    final draws = saleDraws(
      [OrderItem(menuItemId: 'm', name: 'Сыр', price: 451.5, qty: 1, mods: const ['0,350 кг'])],
      {'m': m},
      {'c': cheese},
    );
    expect(draws['c']!.qty, closeTo(350, 0.001));
    expect(MenuItem.fromMap({...m.toMap(), 'id': 'm'}).byWeight, isTrue);
  });

  testWidgets('окно взвешивания: вес с весов, сумма, кнопка с весом', (t) async {
    var n = 0;
    await t.pumpWidget(MaterialApp(
      home: Scaffold(
        body: WeighDialog(
          name: 'Сыр',
          perKg: 1290,
          reader: () async => ++n < 2 ? const ScaleReading(0.351, false) : const ScaleReading(0.35, true),
        ),
      ),
    ));
    await t.pump();
    expect(find.text('Груз качается — подождите'), findsOneWidget);
    await t.pump(const Duration(milliseconds: 800));
    await t.pump();
    expect(find.text('Вес стабильный'), findsOneWidget);
    expect(find.text('Добавить 0,350 кг'), findsOneWidget);
    expect(find.text('Сумма: 451,50 ₽'), findsOneWidget);
    await t.enterText(find.byType(TextField), '500');
    await t.pump();
    expect(find.text('Добавить 0,500 кг'), findsOneWidget);
    await t.pumpWidget(const SizedBox());
  });
}
