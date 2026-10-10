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

    test('режим РФ: в тексте — данные не покидают Россию', () {
      final rf = GuestConsent.pdText(const VenueProfile(name: 'Лаунж', piiMode: 'rf')).join('\n');
      expect(rf, contains('за её пределы не передаются'));
      final mirror = GuestConsent.pdText(const VenueProfile(name: 'Лаунж')).join('\n');
      expect(mirror, isNot(contains('за её пределы не передаются')));
    });

    test('пока заведение не в режиме РФ, нужна и галочка о трансграничной передаче', () {
      final c = GuestConsent();
      expect(c.needsCrossBorder, isTrue);
      // В сборке SaaS (kSaasMode) без неё кнопка неактивна; в сборке одного
      // заведения согласия свои и считаются данными заранее.
      if (!c.given) {
        c.pd = true;
        expect(c.ready, isFalse);
        c.crossBorder = true;
        expect(c.ready, isTrue);
      }
    });
  });
}
