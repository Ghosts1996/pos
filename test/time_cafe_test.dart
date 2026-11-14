import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/utils/time_cafe.dart';

void main() {
  tearDown(() => TimeCafe.apply(null));

  test('выключено по умолчанию и без цены', () {
    TimeCafe.apply(null);
    expect(TimeCafe.ready, isFalse);
    TimeCafe.apply({'enabled': true});
    expect(TimeCafe.ready, isFalse, reason: 'без цены часа время не считаем');
  });

  test('поминутно, с округлением вверх и стоп-чеком', () {
    TimeCafe.apply({'enabled': true, 'pricePerHour': 300, 'roundMinutes': 1});
    expect(TimeCafe.billedMinutes(const Duration(minutes: 40, seconds: 1)), 41);
    expect(TimeCafe.costPerGuest(const Duration(minutes: 40)), 200);
    TimeCafe.apply({'enabled': true, 'pricePerHour': 300, 'roundMinutes': 15});
    expect(TimeCafe.billedMinutes(const Duration(minutes: 31)), 45);
    expect(TimeCafe.costPerGuest(const Duration(minutes: 31)), 225);
    expect(TimeCafe.billedMinutes(Duration.zero), 15, reason: 'минимум — один шаг');
    TimeCafe.apply({'enabled': true, 'pricePerHour': 300, 'roundMinutes': 1, 'stopCheck': 900});
    expect(TimeCafe.costPerGuest(const Duration(hours: 5)), 900);
  });

  test('строка счёта: за каждого гостя, сразу подана, без сотрудника', () {
    TimeCafe.apply({'enabled': true, 'pricePerHour': 240, 'roundMinutes': 5, 'stopCheck': 0});
    final l = TimeCafe.line(const Duration(minutes: 83), 3);
    expect(l.menuItemId, TimeCafe.lineId);
    expect(l.qty, 3);
    expect(l.price, 340); // 85 мин × 4 ₽
    expect(l.total, 1020);
    expect(l.pending, 0, reason: 'на кухню не уходит');
    expect(l.by, isEmpty);
    expect(l.name, 'Время в тайм-кафе · 1 ч 25 мин');
  });

  test('первый час по своей цене, минимальная оплата', () {
    TimeCafe.apply({'enabled': true, 'pricePerHour': 200, 'firstHourPrice': 400, 'minMinutes': 60, 'roundMinutes': 1});
    expect(TimeCafe.costPerGuest(const Duration(minutes: 20)), 400, reason: 'минимум — час');
    expect(TimeCafe.costPerGuest(const Duration(minutes: 90)), 500, reason: '400 за первый час + 100 за полчаса');
  });

  test('всё вместе: первый час, минимум, округление, стоп-чек, несколько гостей', () {
    TimeCafe.apply({'enabled': true, 'pricePerHour': 300, 'firstHourPrice': 400, 'minMinutes': 60, 'roundMinutes': 15, 'stopCheck': 1500});
    final cases = <Duration, double>{
      const Duration(minutes: 10): 400, // минимум — час, по цене первого
      const Duration(minutes: 61): 475, // 75 мин: 400 + 15 мин × 5 ₽
      const Duration(hours: 2, minutes: 5): 775, // 135 мин: 400 + 75 мин × 5 ₽
      const Duration(hours: 8): 1500, // 2 500 по тарифу — упёрлись в стоп-чек
    };
    cases.forEach((sat, cost) => expect(TimeCafe.costPerGuest(sat), cost, reason: '$sat'));
    final l = TimeCafe.line(const Duration(minutes: 61), 3);
    expect(l.total, 1425, reason: '3 гостя × 475');
  });

  test('сумму поправили вручную — строка помечена, при оплате не пересчитывается', () {
    TimeCafe.apply({'enabled': true, 'pricePerHour': 300});
    final l = TimeCafe.line(const Duration(minutes: 60), 2, perGuest: 250);
    expect(l.price, 250);
    expect(l.name.endsWith(' · вручную'), isTrue);
    expect(TimeCafe.line(const Duration(minutes: 60), 2).name.contains('вручную'), isFalse);
  });

  test('неверные значения настроек — безопасные', () {
    TimeCafe.apply({'enabled': true, 'pricePerHour': '-5', 'roundMinutes': 7, 'stopCheck': 'abc'});
    expect(TimeCafe.pricePerHour, 0);
    expect(TimeCafe.roundMinutes, 1);
    expect(TimeCafe.stopCheck, 0);
  });

  test('крайние значения: 0, 1, 59, 60, 61 мин, 25 ч, часы планшета «убежали»', () {
    // Поминутно, 300 ₽/ч, первый час 400 ₽, без минимума и стоп-чека.
    TimeCafe.apply({'enabled': true, 'pricePerHour': 300, 'firstHourPrice': 400, 'roundMinutes': 1});
    final perMinute = <Duration, double>{
      Duration.zero: 7, // одна минута — меньше шага не бывает: 400/60 ≈ 6,67 → 7
      const Duration(seconds: 1): 7,
      const Duration(minutes: 1): 7,
      const Duration(minutes: 59): 393, // 59 × 6,67 = 393,3 → 393
      const Duration(minutes: 60): 400,
      const Duration(minutes: 60, seconds: 1): 405, // 61-я минута уже по 5 ₽
      const Duration(minutes: 61): 405,
      const Duration(hours: 25): 7600, // 400 + 24 × 300 — через полночь и смену кассы
      const Duration(minutes: -5): 7, // начало «в будущем» — минимум, а не минус
    };
    perMinute.forEach((sat, cost) => expect(TimeCafe.costPerGuest(sat), cost, reason: '$sat'));
    // Шаг 60 минут: 61 минута — уже два часа.
    TimeCafe.apply({'enabled': true, 'pricePerHour': 300, 'roundMinutes': 60});
    expect(TimeCafe.billedMinutes(const Duration(minutes: 60)), 60);
    expect(TimeCafe.billedMinutes(const Duration(minutes: 61)), 120);
    expect(TimeCafe.costPerGuest(const Duration(minutes: 61)), 600);
    // Шаг 5 минут, минимум 30, стоп-чек 1000: 25 часов упираются в стоп-чек.
    TimeCafe.apply({'enabled': true, 'pricePerHour': 250, 'roundMinutes': 5, 'minMinutes': 30, 'stopCheck': 1000});
    expect(TimeCafe.costPerGuest(const Duration(minutes: 1)), 125, reason: 'минимум 30 мин');
    expect(TimeCafe.costPerGuest(const Duration(minutes: 59)), 250, reason: '59 → 60 мин');
    expect(TimeCafe.costPerGuest(const Duration(hours: 25)), 1000);
    final l = TimeCafe.line(const Duration(hours: 25), 2);
    expect(l.total, 2000);
    expect(l.name, contains('стоп-чек'));
    // Суммы — целые рубли, без копеечных хвостов при любом времени.
    for (var m = 0; m <= 26 * 60; m += 7) {
      final c = TimeCafe.costPerGuest(Duration(minutes: m));
      expect(c, c.roundToDouble(), reason: '$m мин');
      expect(c >= 0, isTrue);
    }
  });
}
