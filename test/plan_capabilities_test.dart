import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/plan_capabilities.dart';
import 'package:hookah_pos/widgets/plan_upsell.dart';

void main() {
  group('PlanCapabilities', () {
    test('нет документа — доступно всё (сбой синхронизации ничего не отнимает)', () {
      final c = PlanCapabilities.fromMap(null);
      expect(c.guestApp, isTrue);
      expect(c.ai, isTrue);
      expect(c.maxDevices, 0);
    });

    test('«Старт»: без приложения гостя и ИИ, касса на 2 устройствах', () {
      final c = PlanCapabilities.fromMap({'guestApp': false, 'ai': false, 'maxDevices': 2});
      expect(c.guestApp, isFalse);
      expect(c.ai, isFalse);
      expect(c.maxDevices, 2);
    });

    test('мусор в лимите не ломает кассу', () {
      expect(PlanCapabilities.fromMap({'maxDevices': 'много'}).maxDevices, 0);
      expect(PlanCapabilities.fromMap({'maxDevices': -3}).maxDevices, 0);
      expect(PlanCapabilities.fromMap({'maxDevices': 3.0}).maxDevices, 3);
    });
  });

  group('лимит устройств', () {
    final t = DateTime(2026, 10, 1);
    DeviceSlot d(String id, int day, {bool active = true}) =>
        DeviceSlot(id: id, active: active, joinedAt: t.add(Duration(days: day)));

    test('без лимита и для не-касс — всегда работает', () {
      expect(DeviceLimitGate.check([d('a', 0), d('b', 1)], 'b', 0), isNull);
      expect(DeviceLimitGate.check([d('a', 0)], 'guest', 1), isNull, reason: 'приложение гостя — не устройство кассы');
    });

    test('работают первые N по времени подключения', () {
      final list = [d('c', 2), d('a', 0), d('b', 1)];
      expect(DeviceLimitGate.check(list, 'a', 2), isNull);
      expect(DeviceLimitGate.check(list, 'b', 2), isNull);
      final over = DeviceLimitGate.check(list, 'c', 2);
      expect(over, isNotNull);
      expect(over!.max, 2);
      expect(over.active, 3);
      expect(over.disabled, isFalse);
    });

    test('отключили старое — новое открывается; отключённое не работает', () {
      final list = [d('a', 0, active: false), d('b', 1), d('c', 2)];
      expect(DeviceLimitGate.check(list, 'c', 2), isNull);
      final off = DeviceLimitGate.check(list, 'a', 2);
      expect(off!.disabled, isTrue);
      expect(DeviceLimitGate.check(list, 'a', 0)!.disabled, isTrue, reason: 'отключённое не работает и без лимита');
    });

    test('только что подключённое (без серверного времени) — последнее', () {
      final list = [const DeviceSlot(id: 'new', active: true), d('a', 0)];
      expect(DeviceLimitGate.check(list, 'a', 1), isNull);
      expect(DeviceLimitGate.check(list, 'new', 1), isNotNull);
    });
  });

  test('«до N сотрудника/сотрудников»', () {
    expect(employeesWord(1), 'сотрудника');
    expect(employeesWord(5), 'сотрудников');
    expect(employeesWord(11), 'сотрудников');
    expect(employeesWord(21), 'сотрудника');
    expect(employeesWord(15), 'сотрудников');
  });
}
