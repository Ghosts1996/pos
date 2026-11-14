import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/widgets/shift_age_banner.dart';

void main() {
  final opened = DateTime(2026, 11, 14, 10, 0);
  test('сторож смены ККТ: до 23 ч тихо, за час — предупреждение со сроком, после суток — тревога', () {
    expect(shiftAgeOf(opened, opened.add(const Duration(hours: 22, minutes: 59))), ShiftAge.ok);
    expect(shiftAgeText(opened, opened.add(const Duration(hours: 22))), '');
    final soon = opened.add(const Duration(hours: 23, minutes: 10));
    expect(shiftAgeOf(opened, soon), ShiftAge.soon);
    expect(shiftAgeText(opened, soon), contains('до 10:00'));
    final late = opened.add(const Duration(hours: 24));
    expect(shiftAgeOf(opened, late), ShiftAge.expired);
    expect(shiftAgeText(opened, late), contains('больше 24 часов'));
  });
}
