import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/fiscal_receipt.dart';
import 'package:hookah_pos/services/booking_fiscal_service.dart';
import 'package:hookah_pos/services/kassa_service.dart';

// Предоплата брони: чек «аванс» (способ расчёта 3, предмет «платёж»),
// только на ещё не пробитую сумму, постоянный номер для повторов.
void main() {
  test('сумма без чека и сам чек «аванс»', () {
    expect(advanceToFiscalize(2000, 0), 2000);
    expect(advanceToFiscalize(2000, 2000), 0);
    expect(advanceToFiscalize(3000, 2000), 1000, reason: 'доплатили — чек только на доплату');
    final r = bookingAdvanceReceipt(reservationId: 'r1', amount: 1000, alreadyFiscalized: 2000, banquet: true);
    expect(r.advance, isTrue);
    expect(r.receiptId, 'res-r1-adv200000');
    expect(r.items.single.paymentObject, FiscalPaymentObject.payment);
    expect(r.items.single.name, 'Предоплата банкета');
    expect(r.total, 1000);
    expect(atolPaymentMethod(r), 'advance');
    expect(orangeDataPaymentMethod(r), 3);
    expect(FiscalPaymentObject.payment.ffd12Code(marked: false), 10);
    final back = FiscalReceipt.fromJson(r.toJson());
    expect(back.advance, isTrue, reason: 'очередь без связи помнит, что это аванс');
  });
}
