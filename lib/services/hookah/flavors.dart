/// Словарь вкусов табака для кальяна: ключ → название, семейство и
/// синонимы (как пишут на банках по-русски и по-английски). По нему касса
/// понимает надписи «PASSION FRUIT», «Аромат маракуйи», «Маракуйя» как один
/// вкус и подбирает миксы из того, что стоит на полке. Без сети и без ИИ.
library;

/// Семейства вкусов — по ним строятся пары «основа + акцент».
enum FlavorFamily { citrus, berry, tropic, fruit, fresh, dessert, spice, drink, sour, floral, nut, herb }

class Flavor {
  final String key;
  final String name;
  final FlavorFamily family;

  /// Как вкус называют на банках и гости (строчными, без «ё»).
  final List<String> synonyms;

  /// Кислит — работает «кислым акцентом» к сладкому.
  final bool sour;

  /// Холодит или освежает — добавка 10–20 %.
  final bool cooling;
  const Flavor(this.key, this.name, this.family, this.synonyms, {this.sour = false, this.cooling = false});
}

const List<Flavor> kFlavors = [
  // Цитрусы
  Flavor('lemon', 'лимон', FlavorFamily.citrus, ['лимон', 'лимона', 'лимонный', 'lemon'], sour: true),
  Flavor('lime', 'лайм', FlavorFamily.citrus, ['лайм', 'лайма', 'lime'], sour: true),
  Flavor('grapefruit', 'грейпфрут', FlavorFamily.citrus, ['грейпфрут', 'грейпфрута', 'grapefruit', 'pomelo', 'помело'], sour: true),
  Flavor('orange', 'апельсин', FlavorFamily.citrus, ['апельсин', 'апельсина', 'orange', 'мандарин', 'мандарина', 'tangerine', 'mandarin', 'клементин']),
  Flavor('bergamot', 'бергамот', FlavorFamily.citrus, ['бергамот', 'bergamot', 'эрл грей', 'earl grey']),
  Flavor('yuzu', 'юдзу', FlavorFamily.citrus, ['юдзу', 'юзу', 'yuzu', 'каффир', 'kaffir'], sour: true),
  // Ягоды
  Flavor('strawberry', 'клубника', FlavorFamily.berry, ['клубника', 'клубники', 'клубничка', 'клубничный', 'strawberry', 'земляника', 'земляники', 'wild strawberry']),
  Flavor('raspberry', 'малина', FlavorFamily.berry, ['малина', 'малины', 'малиновый', 'raspberry', 'raspberries']),
  Flavor('blueberry', 'черника', FlavorFamily.berry, ['черника', 'черники', 'голубика', 'голубики', 'blueberry', 'bilberry', 'huckleberry', 'hurtleberry']),
  Flavor('cherry', 'вишня', FlavorFamily.berry, ['вишня', 'вишни', 'черешня', 'cherry', 'kriek', 'крик']),
  Flavor('blackcurrant', 'чёрная смородина', FlavorFamily.berry, ['черная смородина', 'черной смородины', 'смородина', 'смородины', 'blackcurrant', 'black currant', 'cassis']),
  Flavor('redcurrant', 'красная смородина', FlavorFamily.berry, ['красная смородина', 'красной смородины', 'red currant', 'redcurrant'], sour: true),
  Flavor('blackberry', 'ежевика', FlavorFamily.berry, ['ежевика', 'ежевики', 'blackberry']),
  Flavor('cranberry', 'клюква', FlavorFamily.sour, ['клюква', 'клюквы', 'брусника', 'брусники', 'cranberry', 'lingonberry'], sour: true),
  Flavor('barberry', 'барбарис', FlavorFamily.sour, ['барбарис', 'барбариса', 'barberry'], sour: true),
  Flavor('gooseberry', 'крыжовник', FlavorFamily.berry, ['крыжовник', 'крыжовника', 'gooseberry'], sour: true),
  Flavor('elderberry', 'бузина', FlavorFamily.berry, ['бузина', 'бузины', 'elderberry', 'elderflower']),
  Flavor('cloudberry', 'морошка', FlavorFamily.berry, ['морошка', 'морошки', 'княженика', 'княженики', 'cloudberry'], sour: true),
  Flavor('seabuckthorn', 'облепиха', FlavorFamily.sour, ['облепиха', 'облепихи', 'sea buckthorn'], sour: true),
  Flavor('forestberries', 'лесные ягоды', FlavorFamily.berry, ['лесные ягоды', 'лесных ягод', 'ягодный микс', 'forest berries', 'wild berries', 'berry mix', 'ягодный']),
  Flavor('grape', 'виноград', FlavorFamily.fruit, ['виноград', 'винограда', 'виноградный', 'grape', 'изабелла', 'чупа-чупс виноград']),
  // Тропики
  Flavor('mango', 'манго', FlavorFamily.tropic, ['манго', 'мангомания', 'mango']),
  Flavor('passionfruit', 'маракуйя', FlavorFamily.tropic, ['маракуйя', 'маракуйи', 'passion fruit', 'passionfruit', 'passion']),
  Flavor('pineapple', 'ананас', FlavorFamily.tropic, ['ананас', 'ананаса', 'pineapple'], sour: true),
  Flavor('banana', 'банан', FlavorFamily.tropic, ['банан', 'банана', 'banana']),
  Flavor('coconut', 'кокос', FlavorFamily.tropic, ['кокос', 'кокоса', 'coconut']),
  Flavor('lychee', 'личи', FlavorFamily.tropic, ['личи', 'lychee', 'litchi']),
  Flavor('kiwi', 'киви', FlavorFamily.tropic, ['киви', 'kiwi'], sour: true),
  Flavor('guava', 'гуава', FlavorFamily.tropic, ['гуава', 'гуавы', 'guava']),
  Flavor('papaya', 'папайя', FlavorFamily.tropic, ['папайя', 'papaya']),
  Flavor('dragonfruit', 'питахайя', FlavorFamily.tropic, ['питахайя', 'питайя', 'dragon fruit', 'pitaya']),
  Flavor('feijoa', 'фейхоа', FlavorFamily.tropic, ['фейхоа', 'feijoa']),
  Flavor('pomegranate', 'гранат', FlavorFamily.sour, ['гранат', 'граната', 'pomegranate'], sour: true),
  // Фрукты
  Flavor('apple', 'яблоко', FlavorFamily.fruit, ['яблоко', 'яблока', 'яблочный', 'apple', 'двойное яблоко', 'double apple']),
  Flavor('greenapple', 'зелёное яблоко', FlavorFamily.fruit, ['зеленое яблоко', 'кислое яблоко', 'green apple', 'sour apple'], sour: true),
  Flavor('pear', 'груша', FlavorFamily.fruit, ['груша', 'груши', 'pear', 'дюшес']),
  Flavor('peach', 'персик', FlavorFamily.fruit, ['персик', 'персика', 'peach']),
  Flavor('nectarine', 'нектарин', FlavorFamily.fruit, ['нектарин', 'нектарина', 'nectarine']),
  Flavor('apricot', 'абрикос', FlavorFamily.fruit, ['абрикос', 'абрикоса', 'абрикосовый', 'apricot']),
  Flavor('plum', 'слива', FlavorFamily.fruit, ['слива', 'сливы', 'plum', 'dark plum', 'чернослив']),
  Flavor('watermelon', 'арбуз', FlavorFamily.fruit, ['арбуз', 'арбуза', 'watermelon']),
  Flavor('melon', 'дыня', FlavorFamily.fruit, ['дыня', 'дыни', 'melon', 'медовая дыня', 'honeydew']),
  Flavor('quince', 'айва', FlavorFamily.fruit, ['айва', 'айвы', 'quince']),
  Flavor('fig', 'инжир', FlavorFamily.fruit, ['инжир', 'fig']),
  Flavor('rhubarb', 'ревень', FlavorFamily.sour, ['ревень', 'rhubarb'], sour: true),
  // Свежесть
  Flavor('mint', 'мята', FlavorFamily.fresh, ['мята', 'мяты', 'мятный', 'mint', 'перечная мята', 'peppermint', 'spearmint', 'мощная мята'], cooling: true),
  Flavor('ice', 'холодок', FlavorFamily.fresh, ['лед', 'льда', 'холодок', 'ice', 'cool', 'кулер', 'cooler', 'фрост', 'frost', 'север'], cooling: true),
  Flavor('menthol', 'ментол', FlavorFamily.fresh, ['ментол', 'menthol'], cooling: true),
  Flavor('eucalyptus', 'эвкалипт', FlavorFamily.fresh, ['эвкалипт', 'eucalyptus'], cooling: true),
  Flavor('wintergreen', 'винтергрин', FlavorFamily.fresh, ['винтергрин', 'wintergreen', 'жвачка мятная'], cooling: true),
  Flavor('pine', 'хвоя', FlavorFamily.fresh, ['хвоя', 'елка', 'ель', 'сосна', 'pine', 'fir'], cooling: true),
  Flavor('cucumber', 'огурец', FlavorFamily.fresh, ['огурец', 'огурца', 'cucumber']),
  Flavor('tarragon', 'тархун', FlavorFamily.herb, ['тархун', 'эстрагон', 'tarragon', 'лимонад тархун']),
  Flavor('basil', 'базилик', FlavorFamily.herb, ['базилик', 'basil']),
  Flavor('lemongrass', 'лемонграсс', FlavorFamily.herb, ['лемонграсс', 'мелисса', 'мелиссы', 'lemongrass', 'lemon balm'], cooling: true),
  Flavor('juniper', 'можжевельник', FlavorFamily.herb, ['можжевельник', 'можжевельника', 'juniper', 'джин', 'gin']),
  // Десерт
  Flavor('vanilla', 'ваниль', FlavorFamily.dessert, ['ваниль', 'ванили', 'ванильный', 'vanilla', 'vanila']),
  Flavor('cream', 'сливки', FlavorFamily.dessert, ['сливки', 'сливочный', 'сливочное', 'крем', 'cream', 'молоко', 'milk', 'йогурт', 'yogurt', 'мороженое', 'ice cream', 'пломбир']),
  Flavor('caramel', 'карамель', FlavorFamily.dessert, ['карамель', 'карамели', 'caramel', 'ириска', 'toffee', 'попкорн', 'popcorn']),
  Flavor('chocolate', 'шоколад', FlavorFamily.dessert, ['шоколад', 'шоколада', 'chocolate', 'какао', 'cocoa', 'брауни', 'brownie']),
  Flavor('cookie', 'печенье', FlavorFamily.dessert, ['печенье', 'печенья', 'орео', 'oreo', 'cookie', 'выпечка', 'пирог', 'пирожное', 'cake', 'cheesecake', 'чизкейк']),
  Flavor('honey', 'мёд', FlavorFamily.dessert, ['мед', 'меда', 'медовый', 'honey']),
  Flavor('candy', 'леденцы', FlavorFamily.dessert, ['леденцы', 'леденец', 'конфеты', 'candy', 'скитлз', 'skittles', 'мармелад', 'драже', 'жвачка', 'bubble gum', 'бабл гам', 'сахарная вата', 'cotton candy']),
  Flavor('jam', 'варенье', FlavorFamily.dessert, ['варенье', 'джем', 'джема', 'jam', 'конфитюр']),
  Flavor('marshmallow', 'маршмеллоу', FlavorFamily.dessert, ['маршмеллоу', 'зефир', 'marshmallow']),
  // Пряности
  Flavor('cinnamon', 'корица', FlavorFamily.spice, ['корица', 'корицы', 'cinnamon']),
  Flavor('cardamom', 'кардамон', FlavorFamily.spice, ['кардамон', 'cardamom']),
  Flavor('ginger', 'имбирь', FlavorFamily.spice, ['имбирь', 'имбиря', 'ginger']),
  Flavor('anise', 'анис', FlavorFamily.spice, ['анис', 'бадьян', 'anise', 'лакрица', 'licorice']),
  Flavor('pepper', 'перец', FlavorFamily.spice, ['перец', 'pepper', 'чили', 'chili']),
  // Напитки
  Flavor('cola', 'кола', FlavorFamily.drink, ['кола', 'колы', 'cola', 'кола-ваниль']),
  Flavor('lemonade', 'лимонад', FlavorFamily.drink, ['лимонад', 'lemonade', 'спрайт', 'sprite', 'газировка']),
  Flavor('energy', 'энергетик', FlavorFamily.drink, ['энергетик', 'energy', 'энерджи', 'red bull', 'ред булл']),
  Flavor('tea', 'чай', FlavorFamily.drink, ['чай', 'черный чай', 'зеленый чай', 'tea', 'матча', 'matcha']),
  Flavor('coffee', 'кофе', FlavorFamily.drink, ['кофе', 'капучино', 'эспрессо', 'coffee', 'latte']),
  Flavor('mojito', 'мохито', FlavorFamily.drink, ['мохито', 'mojito']),
  Flavor('pinacolada', 'пина колада', FlavorFamily.drink, ['пина колада', 'pina colada']),
  Flavor('cocktail', 'коктейль', FlavorFamily.drink, ['коктейль', 'cocktail', 'сангрия', 'sangria', 'мартини', 'бейлис', 'ром', 'виски']),
  Flavor('kvass', 'квас', FlavorFamily.drink, ['квас', 'kvass', 'тархун-квас']),
  // Цветочные
  Flavor('rose', 'роза', FlavorFamily.floral, ['роза', 'розы', 'rose']),
  Flavor('lavender', 'лаванда', FlavorFamily.floral, ['лаванда', 'лаванды', 'lavender']),
  Flavor('jasmine', 'жасмин', FlavorFamily.floral, ['жасмин', 'jasmine']),
  Flavor('lilac', 'сирень', FlavorFamily.floral, ['сирень', 'сирени', 'lilac']),
  Flavor('chamomile', 'ромашка', FlavorFamily.floral, ['ромашка', 'ромашки', 'chamomile']),
  Flavor('hibiscus', 'каркаде', FlavorFamily.floral, ['каркаде', 'гибискус', 'hibiscus'], sour: true),
  // Орехи и прочее
  Flavor('pistachio', 'фисташка', FlavorFamily.nut, ['фисташка', 'фисташки', 'pistachio']),
  Flavor('hazelnut', 'фундук', FlavorFamily.nut, ['фундук', 'лесной орех', 'hazelnut', 'нутелла', 'nutella']),
  Flavor('almond', 'миндаль', FlavorFamily.nut, ['миндаль', 'миндаля', 'almond', 'амаретто', 'amaretto', 'марципан']),
  Flavor('sesame', 'кунжут', FlavorFamily.nut, ['кунжут', 'sesame', 'халва', 'halva']),
  Flavor('peanut', 'арахис', FlavorFamily.nut, ['арахис', 'арахисовая паста', 'peanut', 'peanut butter']),
];

final Map<String, Flavor> kFlavorByKey = {for (final f in kFlavors) f.key: f};

String _norm(String s) => s.toLowerCase().replaceAll('ё', 'е').replaceAll(RegExp(r'[^a-zа-я0-9 \-]'), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();

/// Синонимы, отсортированные от длинных к коротким: «черная смородина»
/// раньше «смородина», «зеленое яблоко» раньше «яблоко».
final List<(String, String)> _synonyms = (() {
  final list = <(String, String)>[];
  for (final f in kFlavors) {
    for (final s in f.synonyms) {
      final n = _norm(s);
      list.add((n, f.key));
      // Основа слова для падежей: «малина» → «малин» («с малиной»),
      // «мята» → «мят» («без мяты», «мятой»).
      if (n.length >= 5 && RegExp(r'[аяоеыиуь]$').hasMatch(n)) list.add((n.substring(0, n.length - 1), f.key));
    }
  }
  list.sort((a, b) => b.$1.length.compareTo(a.$1.length));
  return list;
})();

/// Какие вкусы названы в тексте: надпись на банке, вопрос гостя.
/// «Дыня, мелисса, мята» → [melon, lemongrass, mint].
List<String> flavorsInText(String text) {
  var t = ' ${_norm(text)} ';
  final found = <String>[];
  for (final (syn, key) in _synonyms) {
    final i = t.indexOf(' $syn');
    if (i < 0) continue;
    // Слово целиком или с окончанием: «клубничный», «малиновый».
    if (!found.contains(key)) found.add(key);
    t = t.replaceFirst(' $syn', ' ${'_' * syn.length}');
  }
  return found;
}
