import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/venue_models.dart';

// Отзывы на картах: гостю с оценкой 4–5 показываем только https-ссылки
// Яндекс Карт и 2ГИС из кабинета (meta/venueProfile.reviewLinks); в профиль,
// который пишет касса, эти поля не попадают.
void main() {
  test('ссылки на карты — только https и только адреса карт', () {
    final p = VenueProfile.fromMap({
      'reviewLinks': {'yandex': 'https://yandex.ru/maps/org/kafe/123/', 'gis': 'https://2gis.ru/spb/firm/1', 'askPublic': true},
    });
    expect(p.reviewMapLinks.map((e) => e.$1), ['Яндекс Картах', '2ГИС']);
    expect(VenueProfile.fromMap({'reviewLinks': {'yandex': 'http://yandex.ru/maps/x'}}).reviewMapLinks, isEmpty);
    expect(VenueProfile.fromMap({'reviewLinks': {'yandex': 'https://evil.ru/?yandex.ru'}}).reviewMapLinks, isEmpty);
    expect(VenueProfile.fromMap({'reviewLinks': {'gis': 'https://2gis.ru.evil.com/'}}).reviewMapLinks, isEmpty);
    expect(VenueProfile.fromMap({'reviewLinks': {'yandex': 'https://yandex.ru/maps/x', 'askPublic': false}}).reviewMapLinks, isEmpty);
    expect(VenueProfile.fromMap(null).reviewMapLinks, isEmpty);
  });

  test('касса не затирает ссылки: их нет в toMap()', () {
    final p = VenueProfile.fromMap({'reviewLinks': {'yandex': 'https://yandex.ru/maps/x'}});
    expect(p.toMap().containsKey('reviewLinks'), isFalse);
  });
}
