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
}
