import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';

void main() {
  test('номер сборки как версия: тысячи — второе число, остаток — три цифры', () {
    expect(versionOf(469), '1.0.469');
    expect(versionOf(7), '1.0.007');
    expect(versionOf(999), '1.0.999');
    expect(versionOf(1000), '1.1.000');
    expect(versionOf(1020), '1.1.020');
    expect(versionOf(12345), '1.12.345');
  });
}
