/// Каталог табака для кальяна: марки (как их пишут на банках латиницей и
/// по-русски) и известные банки, у которых по названию вкус не понять
/// («Pinkman», «Supernova», «Ice Baby»). По нему касса после фото полки
/// приводит марку к одному написанию и ставит банке правильные вкусы,
/// даже если ИИ ошибся или банка с выдуманным названием.
///
/// Источники: открытые каталоги табаков (SmokeDex — списки банок марок с
/// нотами вкуса), описания производителей и магазинов; спорные банки не
/// включены. Без ИИ и без сети.
library;

import 'flavors.dart';

class TobaccoBrand {
  final String name;
  final List<String> aliases;

  /// Обычная крепость линейки: light / medium / strong.
  final String strength;
  const TobaccoBrand(this.name, this.aliases, this.strength);
}

const List<TobaccoBrand> kTobaccoBrands = [
  TobaccoBrand('Darkside', ['dark side', 'дарксайд', 'дарк сайд', 'ds'], 'strong'),
  TobaccoBrand('Musthave', ['must have', 'musth', 'must h', 'маст хэв', 'мастхэв', 'маст хев', 'мастхев'], 'medium'),
  TobaccoBrand('Black Burn', ['blackburn', 'блэк бёрн', 'блэк берн', 'блек берн', 'bb'], 'strong'),
  TobaccoBrand('Element', ['элемент', 'element вода', 'element земля', 'element воздух', 'element огонь'], 'medium'),
  TobaccoBrand('Tangiers', ['танжирс', 'tangiers noir', 'tangiers birquq'], 'strong'),
  TobaccoBrand('Al Fakher', ['alfakher', 'аль факер', 'альфакер', 'аль-факер', 'аль фахер'], 'light'),
  TobaccoBrand('Adalya', ['адалия', 'адалья'], 'light'),
  TobaccoBrand('Serbetli', ['щербетли', 'шербетли'], 'light'),
  TobaccoBrand('Fumari', ['фумари'], 'light'),
  TobaccoBrand('Starbuzz', ['старбаз', 'star buzz'], 'medium'),
  TobaccoBrand('Nakhla', ['нахла'], 'light'),
  TobaccoBrand('Afzal', ['афзал'], 'light'),
  TobaccoBrand('Spectrum', ['спектрум', 'spectrum hard', 'spectrum kitchen'], 'medium'),
  TobaccoBrand('Sebero', ['себеро', 'sebero black'], 'medium'),
  TobaccoBrand('Duft', ['дуфт', 'duft pheromone', 'duft all-in'], 'medium'),
  TobaccoBrand('Satyr', ['сатир', 'satyr aroma'], 'strong'),
  TobaccoBrand('Bonche', ['бонче', 'бонш', 'бонч'], 'strong'),
  TobaccoBrand('Jent', ['джент', 'jent cigar'], 'medium'),
  TobaccoBrand('Trofimoff', ["trofimoff's", 'трофимов', 'трофимофф'], 'medium'),
  TobaccoBrand('Deus', ['деус'], 'medium'),
  TobaccoBrand('Dogma', ['догма'], 'strong'),
  TobaccoBrand('Banger', ['бангер', 'бэнгер', 'бенгер'], 'medium'),
  TobaccoBrand('Overdose', ['овердоз', 'over dose'], 'strong'),
  TobaccoBrand('Хулиган', ['hooligan', 'huligan', 'хулиган hard'], 'strong'),
  TobaccoBrand('MattPear', ['matt pear', 'мэт пир', 'мэттпир'], 'medium'),
  TobaccoBrand('Palitra', ['палитра'], 'medium'),
  TobaccoBrand('NАШ', ['nash', 'наш'], 'medium'),
  TobaccoBrand('Северный', ['severny', 'severnyi', 'северный табак'], 'strong'),
  TobaccoBrand('Kraken', ['кракен'], 'strong'),
  TobaccoBrand('Daily Hookah', ['дейли хука', 'daily'], 'medium'),
  TobaccoBrand('Burn', ['бёрн', 'берн'], 'medium'),
  TobaccoBrand('Sarma', ['сарма'], 'medium'),
  TobaccoBrand('Craftium', ['крафтиум'], 'medium'),
  TobaccoBrand('Starline', ['старлайн', 'star line'], 'medium'),
  TobaccoBrand('Morpheus', ['морфеус'], 'medium'),
  TobaccoBrand('Lastochka', ['ласточка'], 'medium'),
  TobaccoBrand('Terror', ['террор'], 'strong'),
  TobaccoBrand('Timeline', ['таймлайн'], 'medium'),
  TobaccoBrand('Chabacco', ['чабакко', 'чабако'], 'light'),
  TobaccoBrand('Brusko', ['бруско'], 'light'),
  TobaccoBrand('Zomo', ['зомо'], 'light'),
  TobaccoBrand('Dedushka', ['дедушка'], 'strong'),
  TobaccoBrand('WTO', ['вто', 'world tobacco original', 'world tobacco'], 'strong'),
  TobaccoBrand('Noir', ['нуар'], 'strong'),
  TobaccoBrand('Blanch', ['бланш', 'blansh', 'бланч'], 'medium'),
  TobaccoBrand('Timeless', ['таймлесс', 'таймлес'], 'medium'),
  TobaccoBrand('Sapphire Crown', ['сапфир кроун', 'sapphire'], 'light'),
  TobaccoBrand('Frigate', ['фригат', 'фрегат', 'frigate dry', 'фригат сухой'], 'strong'),
  TobaccoBrand('Original Virginia', ['ориджинал вирджиния', 'original virginia', 'ov'], 'strong'),
];

/// Известные банки: «Марка|Название; другое написание|вкусы (ключи flavors.dart)».
/// Сервер берёт этот же список (saas-gateway/tobacco-cans.json — после
/// правки запустить `node saas-gateway/tools/tobacco-cans-from-dart.js`).
/// Названия — как на банках (латиница) и как их называют кальянщики.
const List<String> kKnownCanLines = [
  // ---- Darkside
  'Darkside|Supernova; Ultranova; Супернова|menthol, ice',
  'Darkside|Bounty Hunter; Баунти Хантер|coconut, chocolate',
  'Darkside|Kalee Grapefruit; Kalee Grap; Кали Грейпфрут|grapefruit',
  'Darkside|Falling Star; Фоллинг Стар|mango, passionfruit',
  'Darkside|Blueberry Blast; Blue Blast|blueberry',
  'Darkside|Breaking Red|pomegranate',
  'Darkside|Goal|energy',
  'Darkside|Sweet Comet; Swit Comet|cranberry, cream, vanilla',
  'Darkside|Wild Forest|strawberry, forestberries',
  'Darkside|Cosmo Flower|blueberry, rose, jasmine',
  'Darkside|Needles; Needls|pine',
  'Darkside|Cyber Kiwi|kiwi',
  'Darkside|Bananapapa; Bnpapa|banana, cream',
  'Darkside|Admiral Acbar|cookie, fruitmix',
  'Darkside|Acot|greenapple, apricot',
  'Darkside|Guava Rebel|guava',
  'Darkside|Redberry|redcurrant',
  'Darkside|Space Lychee|lychee',
  'Darkside|Blackberry; Black B|blackberry',
  'Darkside|Blacktorrent|blackcurrant',
  'Darkside|Mango Lassi|mango, cream',
  'Darkside|Nordberry|cranberry',
  'Darkside|Space Jam|strawberry, jam',
  'Darkside|Astro Tea|tea, lemon',
  'Darkside|Desert Eagle|cactus',
  'Darkside|Generis Raspberry|raspberry',
  'Darkside|Lemon Blast; LM Blast|lemon',
  'Darkside|Barvy Orange; Barvy O|orange',
  'Darkside|Killer Milk|cream',
  'Darkside|Cosmos|cocktail, lime, cranberry',
  'Darkside|Cherry Rocks|cherry',
  'Darkside|Dark Passion|passionfruit',
  'Darkside|Honey Dust; Hny Dust|honey',
  'Darkside|Red Rush|forestberries',
  // ---- Musthave
  'Musthave|Pinkman; Pynkman; Пинкман|grapefruit, strawberry, raspberry',
  'Musthave|Cherry Cola|cherry, cola',
  'Musthave|Choco Mint|chocolate, mint',
  'Musthave|Kiwi Smoothie; Kwi Smooth|kiwi, mint, apple',
  'Musthave|Pistachio Pie; Pistace Pie|pistachio, cookie',
  'Musthave|Amalfi Lemon; Amafy|lemon',
  'Musthave|Raspberry; Raspi|raspberry',
  'Musthave|Feijoa|feijoa',
  'Musthave|Banana Mama; BananaMama|banana',
  'Musthave|Candy Cow|caramel, cream',
  'Musthave|Cinnamon|cinnamon',
  'Musthave|Tarragon; Estragon|tarragon',
  'Musthave|Cucunade|cucumber, lemonade',
  'Musthave|Blackberry; Blarry|blackberry',
  'Musthave|Mad Pear|pear',
  'Musthave|Grapefruit|grapefruit',
  'Musthave|Lemon Pie|lemon, cookie',
  'Musthave|Berry Holls|forestberries, menthol',
  'Musthave|Strawberry; Straw|strawberry',
  'Musthave|Cucu|cucumber, ginger, menthol',
  'Musthave|Tropic Juice|fruitmix',
  'Musthave|Forest Berries; Forest Berri|forestberries',
  'Musthave|Elderberry; Eldery|elderberry',
  'Musthave|Black Currant|blackcurrant',
  'Musthave|Sea Buckthorn Tea|seabuckthorn, tea',
  'Musthave|Ruby Grape|grape',
  'Musthave|Caribbean Rum|cocktail',
  'Musthave|Apple Drops|greenapple, candy',
  'Musthave|Pineapple; Pynapl|pineapple',
  'Musthave|Barberry Candy|barberry, candy',
  'Musthave|Kiwi|kiwi',
  'Musthave|Mango Sling|mango, mint',
  'Musthave|Peppermint|mint',
  'Musthave|Pistachio; Pistace|pistachio',
  'Musthave|Lemon-Lime; Leime|lemon, lime',
  'Musthave|Cherry; Cheri|cherry',
  'Musthave|Vanilla Cream|vanilla, cream',
  'Musthave|Cookie|cookie, chocolate',
  'Musthave|Ice Mint|mint, menthol',
  'Musthave|Masala Tea|tea, cardamom, cinnamon',
  'Musthave|Space Flavour; Space Flavor; Space Flvour|mango, rose, passionfruit, lychee',
  'Musthave|Violet|blueberry, melon, cream',
  'Musthave|Coconut Shake|coconut, cream',
  'Musthave|Frosty|menthol, ice',
  'Musthave|Red Bomb|strawberry, mint',
  'Musthave|Blueberry|blueberry',
  'Musthave|Cranberry|cranberry',
  'Musthave|Mulled Wine|cocktail, orange, cinnamon',
  'Musthave|Quince|quince',
  'Musthave|Sweet Melon|melon',
  'Musthave|Unicorn Treats|candy',
  'Musthave|Rocketman|kiwi, strawberry, grapefruit',
  'Musthave|Cinnamon Rolls|cookie, cinnamon',
  'Musthave|Strawberry Lychee|strawberry, lychee',
  'Musthave|Berry Mors|cherry, raspberry, cranberry',
  'Musthave|Coconut Dream|coconut',
  'Musthave|Guanapapa|papaya, guava, banana',
  // ---- Black Burn
  'Black Burn|Summer Basket|blueberry, strawberry, raspberry, watermelon',
  'Black Burn|Shock Pineapple; Shok Anans; Ананасовый шок|pineapple',
  'Black Burn|Cupper Grupper|grape',
  'Black Burn|Juicy Smoozy; Juzy Smoozy|papaya, coconut, strawberry',
  'Black Burn|Something Berry; Smth Merry|forestberries',
  'Black Burn|Ice Baby; Айс Бэйби|grapefruit, forestberries, ice',
  'Black Burn|Mango; Mamgo|mango',
  'Black Burn|Papaya Dinner; Bapai Dnner|papaya',
  'Black Burn|Melon Halls|watermelon, menthol',
  "Black Burn|It's not Black Currant; Its not Black Currant|blackcurrant",
  'Black Burn|Kiwi Stoner; Kwi Stoner|kiwi',
  'Black Burn|Lemon Shock; Shok; Шок|lemon',
  'Black Burn|Real Passion Fruit; Real P.F.|passionfruit',
  'Black Burn|Shock Apple; Shok Apl|apple',
  'Black Burn|Apple Strudel; Apl Strudl|apple, cookie, cinnamon',
  'Black Burn|Raspberry; Raserry|raspberry',
  'Black Burn|Rose Tea; Roze T|rose, tea',
  'Black Burn|Barberry Shock|barberry',
  'Black Burn|Cranberry Shock|cranberry',
  'Black Burn|Peach Killer; Pinch Killer|peach',
  'Black Burn|Yogurt Peach; Yoggi P|cream, peach',
  'Black Burn|Yogurt Blueberry; Yoggi B|cream, blueberry',
  'Black Burn|Blackberry Lemonade|blackberry, lemonade',
  'Black Burn|Give Me Guava; Give me Guva|guava, kiwi, lime',
  'Black Burn|Haribon|cola, candy',
  'Black Burn|Malibu|strawberry, cream',
  'Black Burn|Elderberry Shock; Eldgerry Shok|elderberry',
  'Black Burn|Strawberry Jam; Strobery Jham|strawberry, jam',
  'Black Burn|Pear Lemonade; Pir Lmnd|pear, lemonade, mint',
  'Black Burn|Currant Shock; Shok Kurant Shok|blackcurrant',
  'Black Burn|Lemon Sweets; Lemn Swits|lemon, candy',
  'Black Burn|Cherry Garden; Chr Garden|cherry',
  'Black Burn|Famous Apple|apple, menthol',
  'Black Burn|Iceberg|menthol, ice',
  // ---- Al Fakher
  'Al Fakher|Two Apples; The Double Crunch; Double Kick; Двойное яблоко|apple, anise',
  'Al Fakher|Big Blue|blueberry',
  'Al Fakher|White Pods|vanilla',
  'Al Fakher|Crystal Grapio|grape, menthol',
  'Al Fakher|Crystal Double Crunch|apple, anise, menthol',
  'Al Fakher|Crystal Yellow|lemon, menthol',
  'Al Fakher|Yellow|lemon',
  'Al Fakher|Red Smash|watermelon',
  'Al Fakher|Grapio|grape',
  'Al Fakher|Ivory Gold|cream',
  'Al Fakher|Cloud 92|mint, passionfruit, melon, watermelon',
  'Al Fakher|Purple Passion|blackberry, grape, blackcurrant, mint',
  'Al Fakher|Twiwi|kiwi',
  'Al Fakher|Crimson Crush|fruitmix',
  'Al Fakher|Doggs Delight|mango, passionfruit, mint',
  'Al Fakher|Fresh Mist|blueberry, fruitmix',
  'Al Fakher|Arctic Cool|menthol, ice',
  'Al Fakher|White Flash|pineapple, orange, lemon, menthol',
  'Al Fakher|Gum Mastic|candy, cardamom',
  'Al Fakher|Fun Time|kiwi, grape, watermelon',
  'Al Fakher|Ambrosia|peach, melon, watermelon, cream, mint',
  'Al Fakher|Banana Montana|banana, coconut, cookie',
  'Al Fakher|Berry Blend|blackberry, blueberry, raspberry',
  'Al Fakher|Citrus Spirit|lime, orange, lemon',
  'Al Fakher|Diamond Dust|pineapple, lime, orange, raspberry',
  'Al Fakher|Flavour Paradise|grape, peach, strawberry, lemon',
  'Al Fakher|Hookah Matata|apple, honey',
  'Al Fakher|Kiwi Garden|kiwi, orange',
  'Al Fakher|Mango Madness|mango, menthol',
  'Al Fakher|Rich Creme; Rich Crème|cream, vanilla',
  'Al Fakher|Seven Wings|blueberry, mint',
  'Al Fakher|Sparkle|lemon, mint, menthol',
  'Al Fakher|Strawberry Island|grape, strawberry',
  'Al Fakher|Sweet Drops|strawberry, watermelon',
  'Al Fakher|Lovely Cherry|apple, cherry',
  // ---- Adalya
  'Adalya|Love 66; Лав 66|passionfruit, melon, watermelon, mint',
  'Adalya|Lady Killer; Леди Киллер|mango, melon, forestberries, mint',
  'Adalya|Punk Man|blueberry, strawberry, raspberry',
  'Adalya|The Two Apples; The Two App; Two Apples; Two App|apple, anise',
  'Adalya|Tynky Wynky; Tinky Winky|passionfruit, lime, grapefruit',
  'Adalya|Cindys|passionfruit, mango, melon, watermelon, forestberries, ice',
  'Adalya|Code Dragon|cola, energy',
  'Adalya|Skyfall|peach, watermelon, menthol',
  'Adalya|Ice Kaktus; Ice Kaktü|cactus, menthol',
  'Adalya|Mango Tango|mango, passionfruit',
  'Adalya|Blue Dragon|blueberry, dragonfruit',
  'Adalya|Berlin Nights|peach, mint',
  'Adalya|Blue Ice|blueberry, menthol',
  'Adalya|Double Yellow|melon, watermelon',
  'Adalya|Ice Peach; Ice Pyc|peach, menthol',
  'Adalya|Ice Bonbon; Ice Boni|candy, ice',
  'Adalya|Sheik Money|pineapple, banana',
  'Adalya|Adalya Power|energy',
  'Adalya|English Lord; Englisch Lord|mango, peach, raspberry',
  'Adalya|Lie on the Rocks; Ice Lie on the Rocks|lime, mint, menthol',
  'Adalya|Hawaii|pineapple, peach',
  'Adalya|Desperado|grape, lime, strawberry, orange',
  "Adalya|Three Angels; Three Angel's|passionfruit, lime, lemon, menthol",
  'Adalya|Lemon Pie; Leon Pi; Lmn Pi|lemon, cookie',
  'Adalya|La Bonita|apple, passionfruit, grape, cherry, strawberry',
  'Adalya|Esmeralda|kiwi, cactus, dragonfruit',
  'Adalya|Capri|orange',
  'Adalya|Frisbie|forestberries, menthol',
  'Adalya|Rhapsody|pineapple, peach, mint',
  'Adalya|Black Voodoo|forestberries, cinnamon',
  'Adalya|Red Banana; Red Bana|cherry, banana',
  'Adalya|Bluemoon; Blue Moon|blueberry, forestberries',
  'Adalya|Ice Kyba; Ice Cuba|cherry, banana, menthol',
  "Adalya|Berr's; Berrs|forestberries, mint, ice",
  'Adalya|Horchata|coffee, hazelnut, chocolate, caramel',
  'Adalya|Lychee Blue; Lyc Blue|lychee, blueberry, menthol',
  'Adalya|Summer Nights|peach, orange, melon, menthol',
  'Adalya|Eskimo Lemon; Eskimo Leon|lemon, lime, mint',
  'Adalya|Marilyn Monroe; Merilyn M|rose, cinnamon',
  'Adalya|Endless Flirt|passionfruit, mango, blueberry, menthol',
  'Adalya|Carmen|caramel',
  'Adalya|Dulcinea|apple, peach',
  'Adalya|Gugi Rasputin|guava, raspberry',
  'Adalya|Blue Orion|blueberry, orange',
  'Adalya|Desert Sweet|cactus',
  'Adalya|Gin Mint; Gyn Mnt|cocktail, mint',
  'Adalya|Swiss Passion|passionfruit, mint, menthol',
  'Adalya|Paradiso|grapefruit',
  'Adalya|Ipanema|pear, blueberry, menthol',
  'Adalya|London Fog|rose, grapefruit, elderberry',
  'Adalya|Pink Princess|rose, menthol',
  'Adalya|Red Wood|candy, cinnamon',
  'Adalya|Side Ruj|pomegranate',
  'Adalya|Sweet Bubble|candy',
  "Adalya|Tony's Destiny; Tonys Destiny|cactus, peach, lime",
  'Adalya|Turkish Boom|candy, cardamom',
  'Adalya|Yellow|melon, watermelon',
  'Adalya|Orion|orange',
  'Adalya|Code|cola',
  // ---- Musthave (MustH) и другие
  'Sebero|Joyce|apricot',
  'Sebero|Mangolcrian|mango',
  'NАШ|Pina|pineapple',
  'NАШ|Crazy Green|kiwi',
  'NАШ|Бубльгум; Bubblegum; Бабл гам|candy',
  'Deus|Orange Tic Tac; Апельсиновый Тик Так; Апельсиновое драже|orange, candy',
  // Полка владельца 28.11.2026: банки, у которых марку часто не видно.
  'Spectrum|Мощная мята|mint',
  'Overdose|Мята|mint',
  'Timeline|Лайм|lime',
  'Banger|Жвачка арбуз-клубника; Жвачка, арбуз-клубника|candy, watermelon, strawberry',
  'Banger|Фейхоа-можжевельник|feijoa, juniper',
  'Banger|Грейпфрут, клубника и малина|grapefruit, strawberry, raspberry',
  'Burn|Мармелад с колой|candy, cola',
  'NАШ|Черника ромашка; Черника и ромашка|blueberry, chamomile',
  'Overdose|Wintergreen; Винтергрин; Винтегрин|wintergreen',
  'Black Burn|Тростниковая мята; Sugarcane Mint; Простниковая мята|sugarcane, mint',
];

class KnownCan {
  final String brand;
  final List<String> names;
  final List<String> flavors;
  const KnownCan(this.brand, this.names, this.flavors);
}

String _key(String s) => s.toLowerCase().replaceAll('ё', 'е').replaceAll(RegExp(r'[^a-zа-я0-9]'), '');

final List<KnownCan> kKnownCans = [
  for (final line in kKnownCanLines)
    (() {
      final f = line.split('|');
      return KnownCan(
        f[0],
        [for (final n in f[1].split(';')) n.trim()],
        [for (final x in f[2].split(',')) x.trim()],
      );
    })(),
];

/// Марка, как её пишут в каталоге («блэк берн», «BLACKBURN» → «Black Burn»).
/// Не узнали — как прочитали.
String canonicalBrand(String raw) {
  final k = _key(raw);
  if (k.isEmpty) return raw.trim();
  for (final b in kTobaccoBrands) {
    if (_key(b.name) == k || b.aliases.any((a) => _key(a) == k)) return b.name;
  }
  return raw.trim();
}

TobaccoBrand? brandOf(String name) {
  final c = canonicalBrand(name);
  for (final b in kTobaccoBrands) {
    if (b.name == c) return b;
  }
  return null;
}

/// Известная банка: по марке и названию (написание, регистр, пробелы не
/// важны; «Pinkman» найдётся и без марки, если название редкое).
KnownCan? knownCan(String brand, String name) {
  final b = canonicalBrand(brand);
  final n = _key(name);
  if (n.length < 3) return null;
  KnownCan? byNameOnly;
  var sameName = 0;
  for (final c in kKnownCans) {
    if (!c.names.any((x) => _key(x) == n)) continue;
    if (c.brand == b) return c;
    sameName++;
    byNameOnly = c;
  }
  // Без марки — только если такое название у одной банки каталога.
  return sameName == 1 && b.isEmpty ? byNameOnly : null;
}

/// Марка по названию, когда на банке её не видно: только если такое
/// название в каталоге у одной марки и оно не из одного короткого слова
/// («Мята» бывает у всех марок, «Мощная мята» — у Spectrum).
String brandByName(String name) {
  final n = name.trim();
  if (n.split(RegExp(r'\s+')).length < 2 && n.length < 10) return '';
  final c = knownCan('', n);
  return c?.brand ?? '';
}

/// Вкусы банки: из каталога, иначе из того, что прочитал ИИ и что видно в
/// названии.
List<String> flavorsOfCan(String brand, String name, String aiWords) {
  final known = knownCan(brand, name);
  if (known != null) return [for (final f in known.flavors) if (kFlavorByKey.containsKey(f)) f];
  final found = flavorsInText('$aiWords, $name');
  // Сухой табак (Frigate) — без аромата: «табачный», даже если название
  // ничего не говорит («Caribbean Nights»).
  if (found.isEmpty && canonicalBrand(brand) == 'Frigate') return const ['tobacco'];
  return found;
}

/// Исправить название, которое ИИ прочитал с ошибкой в одну-две буквы:
/// «Простниковая мята» → «Тростниковая мята» (известная банка той же марки).
String fixCanName(String brand, String name) {
  final b = canonicalBrand(brand);
  final n = _key(name);
  if (n.length < 5) return name;
  String? best;
  var bestD = 3;
  for (final c in kKnownCans) {
    if (c.brand != b) continue;
    for (final x in c.names) {
      final k = _key(x);
      if ((k.length - n.length).abs() > 2) continue;
      final d = _dist(k, n);
      if (d < bestD) {
        bestD = d;
        best = c.names.first;
      }
    }
  }
  // Не больше одной ошибки на 6 букв.
  return best != null && bestD <= (n.length / 6).floor().clamp(1, 2) ? best : name;
}

int _dist(String a, String b) {
  var prev = List<int>.generate(b.length + 1, (i) => i);
  for (var i = 1; i <= a.length; i++) {
    final cur = List<int>.filled(b.length + 1, 0)..[0] = i;
    for (var j = 1; j <= b.length; j++) {
      final cost = a.codeUnitAt(i - 1) == b.codeUnitAt(j - 1) ? 0 : 1;
      cur[j] = [prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost].reduce((x, y) => x < y ? x : y);
    }
    prev = cur;
  }
  return prev[b.length];
}
