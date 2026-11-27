import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/client/services/kolibri_auth_service.dart';
import 'package:hookah_pos/models/venue_models.dart';

void main() {
  test('«Пригласить друга»: по умолчанию включено, 300 и 200 бонусов', () {
    final p = VenueProfile.fromMap({});
    expect(p.referralEnabled, isTrue);
    expect(p.referralInviterBonus, 300);
    expect(p.referralInviteeBonus, 200);
  });

  test('«Пригласить друга»: свои бонусы и выключатель из профиля заведения', () {
    final p = VenueProfile.fromMap({'referralEnabled': false, 'referralInviterBonus': 500, 'referralInviteeBonus': '150'});
    expect(p.referralEnabled, isFalse);
    expect(p.referralInviterBonus, 500);
    expect(p.referralInviteeBonus, 150);
    // Мусор и выход за пределы — значения по умолчанию.
    final bad = VenueProfile.fromMap({'referralInviterBonus': -5, 'referralInviteeBonus': 1e9});
    expect(bad.referralInviterBonus, 300);
    expect(bad.referralInviteeBonus, 200);
    final again = VenueProfile.fromMap(p.toMap());
    if (kSaasMode) {
      expect(again.referralEnabled, isFalse);
      expect(again.referralInviterBonus, 500);
    } else {
      // hookah-pos профиль не трогает: поле не пишется.
      expect(p.toMap().containsKey('referralEnabled'), isFalse);
    }
    expect(p.copyWith(referralEnabled: true).referralEnabled, isTrue);
  });

  test('короткий код входа гостя: регистр, пробелы и дефис не важны', () {
    expect(KolibriAuthService.shortCodeOf('k7qm-4xtr'), 'K7QM4XTR');
    expect(KolibriAuthService.shortCodeOf(' K7QM 4XTR '), 'K7QM4XTR');
    expect(KolibriAuthService.shortCodeOf('K7QM-4XT'), isNull);
    // Длинный прежний код — не короткий.
    expect(KolibriAuthService.shortCodeOf('qBJH6PPB6wgYeKZEZqUcL26AjkQ2.7rn8D5NaWsXVfUIE9wSyVaMIfe'), isNull);
  });
}
