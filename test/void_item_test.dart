import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/widgets/void_item_dialog.dart';

OrderItem _line({int qty = 2, int sent = 0, int ready = 0}) =>
    OrderItem(menuItemId: 'a', name: 'Паста', price: 600, qty: qty, sent: sent, ready: ready, since: DateTime(2026));

void main() {
  test('новое убирается свободно, ушедшее на кухню — только отменой', () {
    expect(voidNeedsApproval(_line()), isFalse, reason: 'ничего не отправлено');
    expect(voidNeedsApproval(_line(qty: 3, sent: 2)), isFalse, reason: 'третья штука ещё не ушла');
    expect(voidNeedsApproval(_line(qty: 2, sent: 2)), isTrue);
    expect(voidNeedsApproval(_line(qty: 1, ready: 1)), isTrue, reason: 'уже готово');
  });
}
