import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/utils/bill_split.dart';

void main() {
  group('Счёт поровну', () {
    test('делится нацело — всем одинаково', () {
      expect(splitEvenlyKopecks(230000, 2), [115000, 115000]);
    });
    test('целые рубли делятся целыми рублями, остаток — первым', () {
      final s = splitEvenlyKopecks(100000, 3);
      expect(s, [33400, 33300, 33300]);
      expect(s.reduce((a, b) => a + b), 100000);
    });
    test('счёт с копейками — до копейки, сумма долей равна счёту', () {
      final s = splitEvenlyKopecks(139950, 4); // 1 399,50 ₽
      expect(s.reduce((a, b) => a + b), 139950);
      expect(s.first - s.last, lessThanOrEqualTo(1));
    });
    test('пустой счёт или ноль гостей — пусто', () {
      expect(splitEvenlyKopecks(0, 3), isEmpty);
      expect(splitEvenlyKopecks(1000, 0), isEmpty);
    });
    test('формат суммы', () {
      expect(formatKopecks(115000), '1 150 ₽');
      expect(formatKopecks(76667), '766,67 ₽');
      expect(formatKopecks(1234500), '12 345 ₽');
    });
  });
}
