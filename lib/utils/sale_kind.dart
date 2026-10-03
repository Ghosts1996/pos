import 'promo_policy.dart';

/// Вид продажи — от него зависит, кому идёт процент: кальяны —
/// кальянщику, напитки и бар — бармену, остальное — только в «процент с
/// чеков» официанта. Он же делит печатный чек на кальянный и остальной.
class SaleKind {
  SaleKind._();

  static const hookah = 'hookah';
  static const bar = 'bar';
  static const kitchen = 'kitchen';

  static const all = [kitchen, bar, hookah];

  static String label(String kind) => switch (kind) {
        hookah => 'Кальяны',
        bar => 'Бар и напитки',
        _ => 'Кухня',
      };

  // Напитки и бар по названию категории: «Напитки», «Бар», «Коктейли»,
  // «Пиво», «Чай и кофе», «Лимонады»… Слова — с границей начала, чтобы
  // «Вино» не находилось в «Говядине».
  static final _barWords = RegExp(
    r'(^|[^а-яё])(напит|бар|коктейл|алко|пив|вин[оа]|игрист|шампан|виск|коньяк|водк|ром($|[^а-яё])|джин|текил|ликёр|ликер|настойк|сидр|чай|чаи|кофе|лимонад|сок|смузи|шот|морс|вода|воды|энергет|милкшейк|какао|глинтвейн|пунш)'
    r'|drink|bar|beer|wine|cocktail|coffee|tea($|\W)',
    caseSensitive: false,
  );

  /// Вид по названию категории, если владелец его не выбрал сам.
  static String inferFromCategoryName(String name) {
    if (PromoPolicy.looksTobacco(name)) return hookah;
    if (_barWords.hasMatch(name.toLowerCase())) return bar;
    return kitchen;
  }

  /// Вид позиции меню: табак по флагу/названию — всегда кальян; дальше —
  /// вид категории ([categoryKind] — выбранный владельцем, может быть
  /// пустым) или догадка по её названию.
  static String forMenuItem({
    required bool tobacco,
    required String itemName,
    String categoryKind = '',
    String categoryName = '',
  }) {
    if (tobacco || PromoPolicy.looksTobacco(itemName)) return hookah;
    if (all.contains(categoryKind)) return categoryKind;
    return inferFromCategoryName(categoryName);
  }

  static String normalize(String? raw) => all.contains(raw) ? raw! : '';
}
