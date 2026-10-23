import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/screens/saas/device_limit_screen.dart';
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

  test('каждое устройство считается отдельно: кухня, бар, телефон официанта', () {
    final t = DateTime(2026, 10, 1);
    final list = [
      DeviceSlot.fromMap('kitchen', {'usage': 'Экран кухни и бара', 'platform': 'android', 'status': 'active'}),
      DeviceSlot(id: 'bar', active: true, joinedAt: t, name: 'Планшет на баре'),
      DeviceSlot(id: 'phone', active: true, joinedAt: t.add(const Duration(days: 1)), platform: 'android'),
    ];
    expect(DeviceLimitGate.works(list, 'bar', 2), isTrue);
    expect(DeviceLimitGate.works(list, 'phone', 2), isTrue);
    expect(DeviceLimitGate.works(list, 'kitchen', 2), isFalse, reason: 'подключилось последним');
    expect(DeviceLimitGate.works(list, 'kitchen', 0), isTrue);
    expect(list[0].title, 'Android-устройство');
    expect(list[1].title, 'Планшет на баре');
  });

  testWidgets('экран лимита: список устройств и удаление по PIN администратора', (tester) async {
    DeviceLimitGate.devices.value = [
      DeviceSlot(id: 'a', active: true, joinedAt: DateTime(2026), name: 'Планшет на баре', usage: 'Бармен'),
      DeviceSlot(id: 'b', active: true, joinedAt: DateTime(2026, 2), name: 'Планшет на кухне'),
    ];
    DeviceLimitGate.over.value = const DeviceLimitState(max: 1, active: 2);
    PlanCapabilitiesService.current.value = const PlanCapabilities(maxDevices: 1);
    await tester.binding.setSurfaceSize(const Size(500, 1400));
    await tester.pumpWidget(const MaterialApp(home: DeviceLimitHost()));
    await tester.pump();
    expect(find.text('Лимит устройств тарифа'), findsOneWidget);
    expect(find.text('Планшет на баре'), findsOneWidget);
    expect(find.textContaining('сверх лимита'), findsOneWidget);
    await tester.tap(find.text('Удалить').first);
    await tester.pumpAndSettle();
    expect(find.text('PIN администратора'), findsOneWidget, reason: 'окно открывается — у экрана свой навигатор');
    DeviceLimitGate.over.value = null;
    DeviceLimitGate.devices.value = const [];
    PlanCapabilitiesService.current.value = PlanCapabilities.full;
    await tester.binding.setSurfaceSize(null);
  });

  test('«до N сотрудника/сотрудников»', () {
    expect(employeesWord(1), 'сотрудника');
    expect(employeesWord(5), 'сотрудников');
    expect(employeesWord(11), 'сотрудников');
    expect(employeesWord(21), 'сотрудника');
    expect(employeesWord(15), 'сотрудников');
  });
}
