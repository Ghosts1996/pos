import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/table_key_service.dart';

void main() {
  test('секрет стола: 18 знаков без похожих символов, каждый раз новый', () {
    final keys = {for (var i = 0; i < 200; i++) TableKeyService.newKey()};
    expect(keys.length, 200);
    for (final k in keys) {
      expect(k, matches(RegExp(r'^[A-HJ-NP-Za-km-z2-9]{18}$')));
      // Годится в ссылку без экранирования.
      expect(Uri.encodeQueryComponent(k), k);
    }
  });
}
