import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/client/services/guest_consent.dart';
import 'package:hookah_pos/models/client_models.dart';
import 'package:hookah_pos/models/venue_models.dart';

void main() {
  group('Подарок «Вернуть гостя» в профиле гостя', () {
    final now = DateTime(2026, 11, 9, 14);

    test('полный подарок разбирается, текст уведомления — сообщение и бонусы', () {
      final promo = GuestPromo.fromMap({
        'id': 'winback-1',
        'kind': 'winback',
        'title': 'Скучаем по вам!',
        'text': 'Ждём вас снова.',
        'bonus': 300,
        'from': 'Кафе у дома',
        'until': Timestamp.fromDate(now.add(const Duration(days: 30))),
      }, now: now);
      expect(promo, isNotNull);
      expect(promo!.title, 'Скучаем по вам!');
      expect(promo.bonus, 300);
      expect(promo.from, 'Кафе у дома');
      expect(promo.body, 'Ждём вас снова. +300 бонусов уже на счету.');
    });

    test('без бонусов — только сообщение', () {
      final promo = GuestPromo.fromMap({'id': 'w', 'title': 'Привет', 'text': 'Заходите'}, now: now);
      expect(promo!.body, 'Заходите');
    });

    test('срок показа прошёл, нет id или заголовка, не карта — подарка нет', () {
      expect(
          GuestPromo.fromMap({
            'id': 'w',
            'title': 'Т',
            'until': Timestamp.fromDate(now.subtract(const Duration(minutes: 1))),
          }, now: now),
          isNull);
      expect(GuestPromo.fromMap({'title': 'Т'}, now: now), isNull);
      expect(GuestPromo.fromMap({'id': 'w', 'title': '  '}, now: now), isNull);
      expect(GuestPromo.fromMap('мусор', now: now), isNull);
      expect(GuestPromo.fromMap(null, now: now), isNull);
    });

    test('приложение не записывает согласие и подарок в профиль — это делает только сервер', () {
      final profile = ClientProfile(
        uid: 'g1',
        createdAt: now,
        adsConsent: true,
        promo: const GuestPromo(id: 'w', title: 'Т', bonus: 300),
      );
      final map = profile.toMap();
      for (final key in ['adsConsent', 'adsConsentAt', 'adsConsentEdition', 'promo', 'winbackAt', 'winbackSpent', 'winbackTries']) {
        expect(map.containsKey(key), isFalse, reason: key);
      }
    });
  });

  group('Согласие на подарки и предложения', () {
    test('отдельный текст: заведение, не чаще раза в два месяца, отказ в профиле', () {
      GuestConsent.platformForTest = const {};
      final text = GuestConsent.adsText(const VenueProfile(name: 'Лаунж')).join('\n');
      expect(text, contains('в приложении заведения «Лаунж»'));
      expect(text, contains('не чаще одного раза в два месяца'));
      expect(text, contains('снимите отметку в профиле'));
      expect(text, contains('сервис ZalPOS'));
      expect(text, isNot(contains('Telegram')));
      expect(GuestConsent.adsEdition, isNot(GuestConsent.edition));
    });
  });
}
