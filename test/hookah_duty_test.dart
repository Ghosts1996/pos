import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/utils/constants.dart';

void main() {
  group('Кто ведёт кальяны: «Перезабивка» и напоминания про угли', () {
    bool duty(String position, {String role = AppConstants.roleEmployee, bool hookah = true}) =>
        AppConstants.handlesHookah(position: position, role: role, hookahVenue: hookah);

    test('в кальянной — кальянщик и универсал да, остальные нет', () {
      expect(duty(AppConstants.positionHookahMaster), isTrue);
      expect(duty(AppConstants.positionUniversal), isTrue);
      expect(duty(AppConstants.positionWaiter), isFalse);
      expect(duty(AppConstants.positionBartender), isFalse);
      expect(duty(AppConstants.positionCook), isFalse);
      expect(duty(AppConstants.positionHost), isFalse);
    });

    test('в ресторане с кальянами — только кальянщик', () {
      expect(duty(AppConstants.positionHookahMaster, hookah: false), isTrue);
      expect(duty(AppConstants.positionUniversal, hookah: false), isFalse);
      expect(duty(AppConstants.positionWaiter, hookah: false), isFalse);
    });

    test('администратор в кальянной — как универсал', () {
      expect(duty(AppConstants.positionWaiter, role: AppConstants.roleAdmin), isTrue);
      expect(duty(AppConstants.positionWaiter, role: AppConstants.roleAdmin, hookah: false), isFalse);
    });

    test('битое значение специализации — как универсал', () {
      expect(duty('???'), isTrue);
      expect(duty(''), isTrue);
    });
  });
}
