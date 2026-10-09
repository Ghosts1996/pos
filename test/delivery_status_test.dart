import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/delivery_status.dart';

void main() {
  test('доставка идёт строго по шагам', () {
    var s = 'new';
    final seen = <String>[];
    while (DeliveryFlow.next('delivery', s) != null) {
      s = DeliveryFlow.next('delivery', s)!;
      seen.add(s);
    }
    expect(seen, ['accepted', 'cooking', 'courier', 'done']);
    expect(DeliveryFlow.label('delivery', 'done'), 'Доставлен');
  });

  test('с собой — без курьера, «готов к выдаче»', () {
    expect(DeliveryFlow.next('takeaway', 'cooking'), 'ready');
    expect(DeliveryFlow.canMove('takeaway', 'cooking', 'courier'), isFalse);
    expect(DeliveryFlow.label('takeaway', 'done'), 'Выдан');
  });

  test('повтор шага и прыжки не проходят', () {
    expect(DeliveryFlow.canMove('delivery', 'accepted', 'accepted'), isFalse);
    expect(DeliveryFlow.canMove('delivery', 'new', 'cooking'), isFalse);
    expect(DeliveryFlow.next('delivery', 'done'), isNull);
    expect(DeliveryFlow.normalize('delivery', null), 'new');
  });
}
