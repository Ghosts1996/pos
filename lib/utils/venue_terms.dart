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

  /// Переключатель «Заведение с кальянами» (VenueProfile.hookahEnabled).
  /// null — не задан: как раньше, кальяны есть только у кальянной.
  final bool? _withHookah;

  const VenueTerms(this.type, {bool? withHookah}) : _withHookah = withHookah;

  /// В заведении подают кальяны: у гостя кнопки «Позвать кальянщика»,
  /// «Поменять угли» и «Перезабивка» и таймер сеанса, у персонала —
  /// перезабивка, должность «кальянщик» и напоминания про угли. Без
  /// кальянов этих кнопок нет — чтобы гость ресторана не звал кальянщика.
  bool get isHookah => _withHookah ?? type == hookah;

  /// Стол ведёт кальянщик: кальянная, где кальяны включены.
  bool get _hookahStaff => type == hookah && isHookah;

  /// Кто обслуживает стол — именительный падеж: «кальянщик подтвердит».
  String get staff => _hookahStaff ? 'кальянщик' : (type == bar ? 'бармен' : 'официант');

  /// Винительный падеж: «позовите кальянщика».
  String get staffAcc => _hookahStaff ? 'кальянщика' : (type == bar ? 'бармена' : 'официанта');

  /// Дательный падеж: «скажите кальянщику».
  String get staffDat => _hookahStaff ? 'кальянщику' : (type == bar ? 'бармену' : 'официанту');
}
