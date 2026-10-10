import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/client/services/guest_consent.dart';
import 'package:hookah_pos/models/venue_models.dart';

void main() {
  group('Согласие гостя: оператор — ZalPOS', () {
    test('ИП из выписки заглавными — в нормальном виде, с ИНН, ОГРНИП и адресом', () {
      final line = GuestConsent.operatorLine({
        'fullName': 'ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ ИВАНОВ ИВАН ИВАНОВИЧ',
        'inn': '770000000000',
        'ogrnip': '312770000000000',
        'address': 'г. Москва',
      });
      expect(line, 'сервис ZalPOS — индивидуальный предприниматель Иванов Иван Иванович '
          '(ИНН 770000000000, ОГРНИП 312770000000000, адрес: г. Москва)');
    });

    test('реквизиты ещё не заполнены — ссылка на политику, а не пустые скобки', () {
      expect(GuestConsent.operatorLine(const {}), contains('реквизиты — в политике конфиденциальности'));
    });

    test('текст согласия называет оператором ZalPOS, заведение — обработчиком по поручению', () {
      GuestConsent.platformForTest = const {};
      final text = GuestConsent.pdText(const VenueProfile(name: 'Лаунж')).join('\n');
      expect(text, contains('оператору — сервис ZalPOS'));
      expect(text, contains('По поручению оператора мои данные обрабатывают работники заведения «Лаунж»'));
    });

    test('данные не покидают Россию — у любого заведения, без второй галочки', () {
      for (final v in const [VenueProfile(name: 'Лаунж', piiMode: 'rf'), VenueProfile(name: 'Лаунж')]) {
        final text = GuestConsent.pdText(v).join('\n');
        expect(text, contains('за её пределы не передаются'));
        expect(text, isNot(contains('трансгранич')));
        expect(text, isNot(contains('Google')));
      }
      final c = GuestConsent();
      // В сборке SaaS (kSaasMode) кнопка ждёт одной галочки; в сборке одного
      // заведения согласия свои и считаются данными заранее.
      if (!c.given) {
        expect(c.ready, isFalse);
        c.pd = true;
        expect(c.ready, isTrue);
      }
    });
  });
}
