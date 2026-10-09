import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/fiscal_receipt.dart';
import 'package:hookah_pos/services/atol_local_kassa.dart';
import 'package:hookah_pos/services/kassa_service.dart';

void main() {
  test('адрес веб-сервера АТОЛ: IP без порта получает 16732', () {
    expect(AtolLocalKassaService.normalizeAddress('192.168.1.50'), 'http://192.168.1.50:16732');
    expect(AtolLocalKassaService.normalizeAddress('192.168.1.50:8080/'), 'http://192.168.1.50:8080');
    expect(AtolLocalKassaService.normalizeAddress('http://kassa.local'), 'http://kassa.local:16732');
    expect(AtolLocalKassaService.normalizeAddress('  '), '');
  });

  test('задание sell для регистратора: позиции, оплаты, налог, кассир', () {
    final svc = AtolLocalKassaService(
      address: '10.0.0.5',
      taxSystem: FiscalTaxSystem.usnIncome,
      cashierName: 'Иванова А.',
    );
    final task = svc.buildTask(const FiscalReceipt(
      receiptId: 's1',
      items: [
        FiscalReceiptItem(name: 'Чай', price: 333.33, quantity: 3, vat: FiscalVatRate.vat22),
        FiscalReceiptItem(name: 'Кальян', price: 1500, quantity: 1, paymentObject: FiscalPaymentObject.service),
      ],
      payments: [FiscalPayment('card', 2000), FiscalPayment('cash', 499.99)],
      buyerContact: '8 (900) 111-22-33',
    ));
    expect(task['type'], 'sell');
    expect(task['taxationType'], 'usnIncome');
    expect(task['operator'], {'name': 'Иванова А.'});
    expect(task['clientInfo'], {'emailOrPhone': '+79001112233'});
    final items = task['items'] as List;
    expect(items[0]['amount'], 999.99);
    expect(items[0]['tax'], {'type': 'vat22'});
    expect(items[0]['measurementUnit'], 'piece');
    expect(items[1]['paymentObject'], 'service');
    expect(task['payments'], [
      {'type': 'electronically', 'sum': 2000.0},
      {'type': 'cash', 'sum': 499.99},
    ]);
    expect(task['total'], 2499.99);
  });

  test('маркированный товар уходит с кодом в imcParams', () {
    final svc = AtolLocalKassaService(address: '10.0.0.5');
    final task = svc.buildTask(const FiscalReceipt(
      receiptId: 's2',
      items: [
        FiscalReceiptItem(
          name: 'Вода',
          price: 100,
          quantity: 1,
          paymentObject: FiscalPaymentObject.markedGood,
          markingCode: '0104600000000000215abc',
        ),
      ],
      payments: [FiscalPayment('cash', 100)],
    ));
    final item = (task['items'] as List).single as Map;
    expect(item['paymentObject'], 'commodityWithMarking');
    expect((item['imcParams'] as Map)['imcType'], 'auto');
  });

  test('без адреса регистратор недоступен', () {
    expect(AtolLocalKassaService(address: '').isAvailable, isFalse);
  });

  test('чек для очереди переживает сохранение и чтение', () {
    const r = FiscalReceipt(
      receiptId: 's3',
      items: [
        FiscalReceiptItem(
          name: 'Пиво',
          price: 250,
          quantity: 2,
          vat: FiscalVatRate.vat20,
          paymentObject: FiscalPaymentObject.excise,
          markingCode: 'X',
          markingPermit: MarkingPermit(reqId: 'u', reqTimestamp: '1'),
        ),
      ],
      payments: [FiscalPayment('card', 500)],
      buyerContact: 'a@b.ru',
    );
    final back = FiscalReceipt.fromJson(r.toJson());
    expect(back.receiptId, 's3');
    expect(back.total, 500);
    expect(back.items.single.vat, FiscalVatRate.vat20);
    expect(back.items.single.paymentObject, FiscalPaymentObject.excise);
    expect(back.items.single.markingPermit?.value, 'UUID=u&Time=1');
    expect(back.payments.single.type, 'card');
    expect(back.buyerContact, 'a@b.ru');
  });
}
