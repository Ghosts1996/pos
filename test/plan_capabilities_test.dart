import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/plan_capabilities.dart';
import 'package:hookah_pos/widgets/plan_upsell.dart';

void main() {
  group('PlanCapabilities', () {
    test('нет документа — доступно всё (сбой синхронизации ничего не отнимает)', () {
      final c = PlanCapabilities.fromMap(null);
      expect(c.guestApp, isTrue);
      expect(c.ai, isTrue);
      expect(c.maxEmployees, 0);
      expect(c.canAddEmployee(1000), isTrue);
    });

    test('«Старт»: без приложения гостя и ИИ, до 5 сотрудников', () {
      final c = PlanCapabilities.fromMap({'guestApp': false, 'ai': false, 'maxEmployees': 5});
      expect(c.guestApp, isFalse);
      expect(c.ai, isFalse);
      expect(c.canAddEmployee(4), isTrue);
      expect(c.canAddEmployee(5), isFalse);
    });

    test('незаполненные поля — как «есть», лимит 0 — без лимита', () {
      final c = PlanCapabilities.fromMap({'maxEmployees': 0});
      expect(c.guestApp, isTrue);
      expect(c.ai, isTrue);
      expect(c.canAddEmployee(500), isTrue);
    });

    test('мусор в лимите не ломает кассу', () {
      expect(PlanCapabilities.fromMap({'maxEmployees': 'много'}).maxEmployees, 0);
      expect(PlanCapabilities.fromMap({'maxEmployees': -3}).maxEmployees, 0);
      expect(PlanCapabilities.fromMap({'maxEmployees': 15.0}).maxEmployees, 15);
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
