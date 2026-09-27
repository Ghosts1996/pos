import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/utils/shift_time.dart';

void main() {
  // 2026-09-27 — воскресенье (7), накануне суббота (6).
  const overnight = {6: '12:00-02:00', 7: '12:00-02:00'};

  group('Начало личной смены относительно открытия заведения', () {
    test('пришёл за час до открытия — часы идут от открытия', () {
      final t = clampShiftStartToOpening(DateTime(2026, 9, 27, 11, 0), overnight);
      expect(t, DateTime(2026, 9, 27, 12, 0));
    });

    test('после открытия — время не трогаем', () {
      final now = DateTime(2026, 9, 27, 15, 30);
      expect(clampShiftStartToOpening(now, overnight), now);
    });

    test('после полуночи в ночную смену — это ещё вчерашний вечер, не будущее', () {
      final now = DateTime(2026, 9, 27, 1, 23);
      expect(clampShiftStartToOpening(now, overnight), now);
    });

    test('задолго до открытия (больше трёх часов) — время не трогаем', () {
      final now = DateTime(2026, 9, 27, 6, 0);
      expect(clampShiftStartToOpening(now, overnight), now);
    });

    test('часы не заданы или выходной — время не трогаем', () {
      final now = DateTime(2026, 9, 27, 11, 0);
      expect(clampShiftStartToOpening(now, const {}), now);
      expect(clampShiftStartToOpening(now, const {7: ''}), now);
      expect(clampShiftStartToOpening(now, const {7: 'круглосуточно'}), now);
    });

    test('вчера закрылись до полуночи — утро перед открытием подтягивается', () {
      final t = clampShiftStartToOpening(
          DateTime(2026, 9, 27, 10, 30), const {6: '12:00-23:00', 7: '12:00-23:00'});
      expect(t, DateTime(2026, 9, 27, 12, 0));
    });
  });
}
