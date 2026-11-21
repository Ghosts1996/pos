import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/fiscal_receipt.dart';
import 'package:hookah_pos/services/kassa_service.dart';

// Бонусы своей программы и «за счёт заведения» в фискальном чеке — скидка в
// ценах позиций (не «предоплата» и не «встречное предоставление»): сумма
// строк до копейки равна оплате, кальяны без скидки, цена × количество = сумма.
void main() {
  int k(double v) => (v * 100).round();
  int total(List<FiscalReceiptItem> items) => items.fold<int>(0, (a, i) => a + k(i.sum));

  test('скидка делится по разрешённым строкам, кальян не трогаем', () {
    final items = [
      const FiscalReceiptItem(name: 'Латте', price: 200, quantity: 3),
      const FiscalReceiptItem(name: 'Кальян', price: 1500, quantity: 1, paymentObject: FiscalPaymentObject.service),
      const FiscalReceiptItem(name: 'Чизкейк', price: 350, quantity: 1),
    ];
    final r = spreadDiscount(items, [true, false, true], 100);
    expect(r.rest, 0);
    expect(total(r.items), k(2450 - 100));
    expect(r.items.firstWhere((i) => i.name == 'Кальян').price, 1500);
    for (final i in r.items) {
      expect(k(i.price * i.quantity), k(i.sum), reason: '${i.name}: цена × количество = сумма');
    }
  });

  test('неделимая цена — строка делится на две, копейки не теряются', () {
    final items = [const FiscalReceiptItem(name: 'Чай', price: 100, quantity: 3)];
    final r = spreadDiscount(items, [true], 10); // 290 ₽ на 3 шт.
    expect(total(r.items), 29000);
    expect(r.items.length, 2);
    expect(r.items.map((i) => i.quantity).toList(), [2, 1]);
    for (final i in r.items) {
      expect(k(i.price * i.quantity), k(i.sum));
    }
  });

  test('скидка больше разрешённых позиций — остаток отдельно', () {
    final items = [
      const FiscalReceiptItem(name: 'Вода', price: 100, quantity: 1),
      const FiscalReceiptItem(name: 'Кальян', price: 1500, quantity: 1),
    ];
    final r = spreadDiscount(items, [true, false], 300);
    expect(r.rest, 200);
    expect(r.items.firstWhere((i) => i.name == 'Вода').sum, 0);
    expect(spreadDiscount(items, [true, false], 0).items, same(items));
  });

  test('итог со скидкой сходится с оплатой', () {
    final items = [
      const FiscalReceiptItem(name: 'А', price: 33.33, quantity: 3),
      const FiscalReceiptItem(name: 'Б', price: 17.17, quantity: 2),
    ];
    final before = FiscalReceipt(receiptId: 'x', items: items, payments: const []).total;
    final r = spreadDiscount(items, [true, true], 50.55);
    final after = FiscalReceipt(receiptId: 'x', items: r.items, payments: const []).total;
    expect(k(after), k(before) - 5055);
    expect(balancePayments([const FiscalPayment('cash', 1000)], after).single.amount, after);
  });

  test('кассир уходит в чек АТОЛ Онлайн', () {
    final atol = AtolCloudKassaService(
      baseUrl: '', groupCode: 'g', login: 'l', password: 'p', companyInn: '7700000000', companyEmail: 'a@b.ru',
      companyPaymentAddress: 'Москва');
    const receipt = FiscalReceipt(
        receiptId: 's1', items: [FiscalReceiptItem(name: 'Латте', price: 200, quantity: 1)],
        payments: [FiscalPayment('cash', 200)], cashier: 'Анна');
    expect((atol.buildReceiptBody(receipt)['receipt'] as Map)['cashier'], 'Анна');
    expect(FiscalReceipt.fromJson(receipt.toJson()).cashier, 'Анна');
    expect(receipt.asRefund().cashier, 'Анна');
    const noName = FiscalReceipt(receiptId: 's2', items: [FiscalReceiptItem(name: 'Латте', price: 200, quantity: 1)], payments: []);
    expect((atol.buildReceiptBody(noName)['receipt'] as Map).containsKey('cashier'), isFalse);
  });
}
