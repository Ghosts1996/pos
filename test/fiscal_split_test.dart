import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/fiscal_receipt.dart';

// Два юрлица в заведении: чек делится по позициям, оплата — в той же
// пропорции, суммы сходятся до копейки, возврат — по каждому чеку.
void main() {
  FiscalReceiptItem it(String n, double p, {double q = 1, String e = ''}) =>
      FiscalReceiptItem(name: n, price: p, quantity: q, entity: e);
  double sum(List<FiscalPayment> ps) => (ps.fold<double>(0, (a, p) => a + p.amount) * 100).roundToDouble() / 100;

  test('кальяны — отдельным чеком на второе юрлицо, оплата пропорционально', () {
    final r = FiscalReceipt(
      receiptId: 's1',
      items: [it('Кальян', 1350, e: '2'), it('Чай', 450), it('Пицца', 700.33)],
      payments: const [FiscalPayment('card', 1000), FiscalPayment('cash', 1500.33)],
      cashier: 'Анна',
    );
    final parts = splitReceiptByEntity(r);
    expect(parts.length, 2);
    expect(parts[0].entity, '');
    expect(parts[0].receiptId, 's1');
    expect(parts[0].items.map((i) => i.name), ['Чай', 'Пицца']);
    expect(parts[1].entity, '2');
    expect(parts[1].receiptId, 's1-2');
    expect(parts[1].items.single.name, 'Кальян');
    for (final p in parts) {
      expect(sum(p.payments), p.total, reason: 'оплата чека = сумма позиций');
      expect(p.cashier, 'Анна');
    }
    // Каждая форма оплаты разделилась целиком: картой 1000 = 1000 в сумме.
    double byType(String t) => parts.expand((p) => p.payments).where((p) => p.type == t).fold(0.0, (a, p) => a + p.amount);
    expect((byType('card') * 100).round(), 100000);
    expect((byType('cash') * 100).round(), 150033);
    // Возврат — тем же номером с -refund, на ту же кассу.
    final back = FiscalReceipt.fromJson(parts[1].toJson()).asRefund();
    expect(back.entity, '2');
    expect(back.receiptId, 's1-2-refund');
    expect(back.refund, isTrue);
  });

  test('все позиции одного юрлица — один чек', () {
    final main = FiscalReceipt(receiptId: 'a', items: [it('Чай', 100)], payments: const [FiscalPayment('cash', 100)]);
    expect(splitReceiptByEntity(main).single.entity, '');
    final second = FiscalReceipt(receiptId: 'b', items: [it('Кальян', 900, e: '2')], payments: const [FiscalPayment('card', 900)]);
    final only = splitReceiptByEntity(second).single;
    expect(only.entity, '2');
    expect(only.receiptId, 'b');
  });

  test('скидка бонусами не теряет юрлицо строки', () {
    final out = spreadDiscount([it('Чай', 333.33, q: 3, e: '2'), it('Кальян', 1000)], [true, false], 100);
    expect(out.items.where((i) => i.name == 'Чай').every((i) => i.entity == '2'), isTrue);
    expect(out.items.firstWhere((i) => i.name == 'Кальян').entity, '');
  });
}
