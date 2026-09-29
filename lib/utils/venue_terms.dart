/// Слова, которые зависят от типа заведения (VenueProfile.venueType):
/// в ресторане «позовите кальянщика» выглядело бы чужим.
class VenueTerms {
  static const hookah = 'hookah';
  static const restaurant = 'restaurant';
  static const cafe = 'cafe';
  static const bar = 'bar';

  static const types = [hookah, restaurant, cafe, bar];

  /// Неизвестное или пустое значение — кальянная: так работали все
  /// заведения до появления настройки, и их тексты не должны поменяться.
  static String normalize(String? raw) => types.contains(raw) ? raw! : hookah;

  static String typeLabel(String type) {
    switch (type) {
      case restaurant:
        return 'Ресторан';
      case cafe:
        return 'Кафе / кофейня';
      case bar:
        return 'Бар';
      default:
        return 'Кальянная / лаунж';
    }
  }

  final String type;
  const VenueTerms(this.type);

  bool get isHookah => type == hookah;

  /// Кто обслуживает стол — именительный падеж: «кальянщик подтвердит».
  String get staff => switch (type) {
        hookah => 'кальянщик',
        bar => 'бармен',
        _ => 'официант',
      };

  /// Винительный падеж: «позовите кальянщика».
  String get staffAcc => switch (type) {
        hookah => 'кальянщика',
        bar => 'бармена',
        _ => 'официанта',
      };

  /// Дательный падеж: «скажите кальянщику».
  String get staffDat => switch (type) {
        hookah => 'кальянщику',
        bar => 'бармену',
        _ => 'официанту',
      };
}
