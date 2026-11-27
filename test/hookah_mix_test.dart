import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/ai/staff_brain.dart';
import 'package:hookah_pos/services/hookah/brand_profiles.dart';
import 'package:hookah_pos/services/hookah/flavors.dart';
import 'package:hookah_pos/services/hookah/mix_base.dart';
import 'package:hookah_pos/services/hookah/mix_engine.dart';
import 'package:hookah_pos/services/hookah/tobacco_catalog.dart';
import 'package:hookah_pos/services/hookah/tobacco_shelf.dart';

void main() {
  test('вкусы с банок понимаются по-русски и по-английски', () {
    expect(flavorsInText('PASSION FRUIT Аромат маракуйи'), ['passionfruit']);
    expect(flavorsInText('Дыня, мелисса, мята'), containsAll(['melon', 'lemongrass', 'mint']));
    expect(flavorsInText('с ароматом клубники, малины и грейпфрута'), containsAll(['strawberry', 'raspberry', 'grapefruit']));
    expect(flavorsInText('Кислая черная смородина'), ['blackcurrant']);
    expect(flavorsInText('Кислое зеленое яблоко').first, 'greenapple');
    expect(flavorsInText('Печенье Орео'), ['cookie']);
  });

  test('база миксов: все вкусы известны, доли — 10 частей', () {
    expect(kMixes.length, greaterThan(120));
    for (final m in kMixes) {
      expect(m.parts.fold<int>(0, (a, p) => a + p.share), 10, reason: m.name);
      for (final p in m.parts) {
        expect(kFlavorByKey.containsKey(p.flavor), isTrue, reason: '${m.name}: ${p.flavor}');
      }
      expect(m.note.toLowerCase(), isNot(contains('как у')), reason: 'без марок табака: ${m.name}');
    }
  });

  test('просьба гостя: теги, желаемые и нежеланные вкусы', () {
    final r = MixRequest.parse('Хочу что-нибудь кислое и свежее, с малиной, только без мяты');
    expect(r.tags, containsAll(['кислый', 'свежий']));
    expect(r.want, contains('raspberry'));
    expect(r.avoid, contains('mint'));
  });

  final shelf = [
    const TobaccoCan(id: '1', brand: 'Blackburn', name: 'Спелая лесная малина', flavors: ['raspberry']),
    const TobaccoCan(id: '2', brand: 'Deus', name: 'Strawberry', flavors: ['strawberry']),
    const TobaccoCan(id: '3', brand: 'Spectrum', name: 'Мощная мята', flavors: ['mint']),
    const TobaccoCan(id: '4', brand: 'Banger', name: 'Нектарин', flavors: ['nectarine']),
    const TobaccoCan(id: '5', brand: 'Blackburn', name: 'Кислый ананас', flavors: ['pineapple']),
    const TobaccoCan(id: '6', brand: 'Must Have', name: 'Пинкман', flavors: ['strawberry', 'raspberry', 'grapefruit']),
    const TobaccoCan(id: '7', brand: 'Darkside', name: 'Нет в наличии', flavors: ['lime'], inStock: false),
  ];

  test('подбор только из того, что на полке, с банками', () {
    final e = MixEngine(shelf);
    final picks = e.pick(MixRequest.parse('сладкое ягодное'));
    expect(picks, isNotEmpty);
    for (final p in picks) {
      for (final x in p.parts) {
        expect(x.can, isNotNull, reason: '${p.mix.name}: ${x.flavor}');
        expect(x.can!.inStock, isTrue);
      }
    }
    expect(picks.first.mix.name, 'Летний сад');
    final text = e.render(picks);
    expect(text, contains('Blackburn «Спелая лесная малина»'));
    expect(text, isNot(contains('*')));
    expect(text, isNot(contains('#')));
    // Гостю — без марок.
    expect(e.render(picks, forGuest: true), isNot(contains('Blackburn')));
  });

  test('без мяты — миксов с мятой нет; лайма нет в наличии — не предлагаем', () {
    final e = MixEngine(shelf);
    for (final p in e.pick(MixRequest.parse('свежее, но без мяты'), limit: 5)) {
      expect(p.parts.any((x) => x.flavor == 'mint'), isFalse);
    }
    expect(e.available.contains('lime'), isFalse);
  });

  test('полка пустая — подбор по общей базе с подсказкой', () {
    final e = MixEngine(const []);
    final picks = e.pick(MixRequest.parse('что-нибудь тропическое'));
    expect(picks, isNotEmpty);
    expect(e.render(picks), contains('Полка табака не заполнена'));
  });

  test('ничего из базы не подходит — свой микс из полки', () {
    final e = MixEngine([const TobaccoCan(id: 'a', brand: 'X', name: 'Фейхоа', flavors: ['feijoa']), const TobaccoCan(id: 'b', brand: 'Y', name: 'Барбарис', flavors: ['barberry'])]);
    final picks = e.pick(MixRequest.parse('кислое с фейхоа'));
    expect(picks, isNotEmpty);
    expect(picks.first.parts.first.flavor, 'feijoa');
  });

  test('каталог: марка к одному написанию, «придуманные» банки — по каталогу', () {
    expect(canonicalBrand('BLACKBURN'), 'Black Burn');
    expect(canonicalBrand('блэк берн'), 'Black Burn');
    expect(canonicalBrand('Дарксайд'), 'Darkside');
    expect(canonicalBrand('БЛАНШ'), 'Blanch');
    expect(canonicalBrand('Неизвестная марка'), 'Неизвестная марка');
    expect(knownCan('Musthave', 'Pinkman')?.flavors, ['grapefruit', 'strawberry', 'raspberry']);
    expect(flavorsOfCan('Darkside', 'Supernova', ''), containsAll(['menthol', 'ice']));
    expect(flavorsOfCan('Adalya', 'Love 66', ''), containsAll(['passionfruit', 'melon', 'watermelon', 'mint']));
    // Неизвестная банка — по словам ИИ и названию.
    expect(flavorsOfCan('Black Burn', 'Спелая лесная малина', 'малина'), ['raspberry']);
    final can = TobaccoShelf.fromScan({'brand': 'blackburn', 'name': 'Ice Baby', 'flavors': ['что-то']});
    expect(can.brand, 'Black Burn');
    expect(can.flavors, containsAll(['grapefruit', 'ice']));
    expect(can.strength, 'strong');
  });

  test('каталог: все вкусы банок есть в словаре', () {
    for (final c in kKnownCans) {
      for (final f in c.flavors) {
        expect(kFlavorByKey.containsKey(f), isTrue, reason: '${c.brand} ${c.names.first}: $f');
      }
      expect(kTobaccoBrands.any((b) => b.name == c.brand), isTrue, reason: c.brand);
    }
    expect(kMixes.length, greaterThan(300));
    expect(kMixes.map((m) => m.name).toSet().length, kMixes.length, reason: 'названия миксов не повторяются');
  });

  group('справочник марок', () {
    TobaccoCan can(String id, String brand, List<String> flavors) =>
        TobaccoCan(id: id, brand: brand, name: id, flavors: flavors);

    test('у каждой марки из каталога, кроме редких, есть профиль; цифры в пределах', () {
      for (final b in ['Darkside', 'Musthave', 'Black Burn', 'Bonche', 'Dogma', 'Северный', 'Banger', 'Spectrum', 'Sarma',
        'Overdose', 'Blanch', 'Noir', 'WTO', 'Trofimoff', 'Deus', 'Element']) {
        final p = profileOf(b);
        expect(p, isNotNull, reason: b);
        expect(p!.strength, inInclusiveRange(1, 10));
        expect(p.heat, inInclusiveRange(1, 5));
        expect(p.gramsMin, lessThanOrEqualTo(p.gramsMax));
      }
      expect(profileOf('дарксайд')!.leaf, Leaf.dark);
      expect(profileOf('Al Fakher')!.mixable, isFalse);
      expect(profileOf('Adalya')!.mixable, isFalse);
    });

    test('марка в просьбе: «на бонче», «Нуар», но не «второй стол»', () {
      expect(brandInText('собери что-то ягодное на бонче'), 'Bonche');
      expect(brandInText('есть Нуар?'), 'Tangiers', reason: 'Noir — линейка Tangiers');
      expect(brandInText('ВТО крепкий?'), 'WTO');
      expect(brandInText('второй стол просит кислое'), isNull);
      expect(brandInText('Мастхев с холодком'), 'Musthave');
    });

    test('Adalya и Al Fakher в миксы не идут', () {
      final e = MixEngine([can('af', 'Al Fakher', ['grape']), can('ad', 'Adalya', ['mint'])]);
      expect(e.noShelf, isTrue);
    });

    test('лёгкое — светлый лист, крепкое — тёмный, «на дарксайде» — Darkside', () {
      final shelf = [
        can('ds', 'Darkside', ['raspberry']),
        can('bl', 'Blanch', ['raspberry']),
        can('mh', 'Musthave', ['lemon']),
      ];
      final e = MixEngine(shelf);
      expect(e.cansFor('raspberry', MixRequest.parse('что-нибудь лёгкое')).first.id, 'bl');
      expect(e.cansFor('raspberry', MixRequest.parse('покрепче')).first.id, 'ds');
      expect(e.cansFor('raspberry', MixRequest.parse('на дарксайде')).first.id, 'ds');
    });

    test('забивка: тёмный + светлый лист — слоями, угли и крепость', () {
      final parts = [
        (part: const MixPart('raspberry', 5), flavor: 'raspberry', can: can('ds', 'Darkside', ['raspberry'])),
        (part: const MixPart('lemon', 5), flavor: 'lemon', can: can('bl', 'Blanch', ['lemon'])),
      ];
      final how = howToPack(parts);
      expect(how, contains('слоями: сверху Darkside'));
      expect(how, contains('снизу Blanch'));
      expect(how, contains('внакидку'));
      expect(how, contains('Крепость ≈ 6/10'));
      expect(guestStrength(parts), 'Крепость: средний.');
    });

    test('ассистент: про марку и правила — без ИИ; просьба о миксе — не карточка марки', () {
      expect(StaffBrain.tobaccoAnswer('как забивать бонч?'), contains('Bonche'));
      expect(StaffBrain.tobaccoAnswer('какая жаростойкость у дарксайда'), contains('жаростойкость очень высокая'));
      expect(StaffBrain.tobaccoAnswer('как правильно миксовать'), kMixRules);
      expect(StaffBrain.tobaccoAnswer('забей микс на дарксайде с малиной'), isNull);
      expect(StaffBrain.tobaccoAnswer('какой стол свободен'), isNull);
    });

    test('миксов больше 500, названия не повторяются', () {
      expect(kMixes.length, greaterThan(500));
      expect(kMixes.map((m) => m.name).toSet().length, kMixes.length);
    });
  });

  group('вкусы с полки владельца, сухой табак, другие варианты', () {
    TobaccoCan c(String id, String brand, List<String> f) => TobaccoCan(id: id, brand: brand, name: id, flavors: f);

    test('Бубльгум, Винтегрин, Тростниковая мята, салями, плов — вкусы узнаются', () {
      expect(flavorsInText('Бубльгум'), ['candy']);
      expect(flavorsInText('Винтегрин'), ['wintergreen']);
      expect(flavorsInText('WINTERGREEN'), ['wintergreen']);
      expect(flavorsInText('Тростниковая мята'), containsAll(['sugarcane', 'mint']));
      expect(flavorsInText('SALAMI'), ['savory']);
      expect(flavorsInText('Плов'), ['savory']);
      expect(flavorsOfCan('NАШ', 'Бубльгум', ''), ['candy']);
    });

    test('Deus «Orange Tic Tac»: название с крышки, «аромат апельсинового драже» сбоку', () {
      expect(flavorsInText('аромат апельсинового драже'), containsAll(['orange', 'candy']));
      final can = TobaccoShelf.fromScan({'brand': 'DEUS', 'name': 'ORANGE TIC TAC'});
      expect(can.brand, 'Deus');
      expect(can.flavors, containsAll(['orange', 'candy']));
      final byWords = TobaccoShelf.fromScan({'brand': 'Deus', 'name': 'Orange Tic Tac', 'flavors': ['апельсин', 'драже']});
      expect(byWords.flavors, containsAll(['orange', 'candy']));
    });

    test('все марки из списка владельца: узнаются, у каждой лист, крепость и жар', () {
      for (final b in ['Morpheus', 'Bliss', 'JOY', 'Fake', 'Молодость', 'Total Flame', 'База', 'Rustpunk', 'Табабка', 'Azure',
        'Zaghloul', 'Kahn El Khalili', '187 Strassenbande', 'Kismet', 'Soex', 'Hydro Herbal', 'Endorphin', 'Кобра', 'HLGN',
        'Blansh', 'Сарма 360', 'Nakhla Mizo', 'Darkside Shot', 'Blackburn Shock', 'Adalya Black', 'Duft All-In', 'Brusko Bit']) {
        final p = profileOf(b);
        expect(p, isNotNull, reason: b);
        expect(canProfileLine(b), isNotEmpty, reason: b);
      }
      expect(canonicalBrand('Эндорфин'), 'Endorphin');
      expect(canonicalBrand('NOIR'), 'Tangiers');
      expect(profileOf('Zaghloul')!.mixable, isFalse, reason: 'арабская классика — не в миксы');
      expect(profileOf('Soex')!.leaf, Leaf.tea);
      expect(profileOf('Kismet')!.leaf, Leaf.dark);
      expect(TobaccoShelf.fromScan({'brand': 'NOIR', 'name': 'Cane Mint'}).line, 'Noir');
      expect(TobaccoShelf.fromScan({'brand': 'Darkside Shot', 'name': 'X'}).line, 'Shot');
      expect(TobaccoShelf.fromScan({'brand': 'Сарма 360', 'name': 'Y'}).line, '360');
      expect(TobaccoShelf.fromScan({'brand': 'Tangiers', 'name': 'Cane Mint'}).flavors, containsAll(['mint', 'sugarcane']));
      expect(canStrength('Tangiers', '', line: 'Noir'), 9);
      expect(brandInText('второй стол просит кислое'), isNull);
    });

    test('линейка меняет крепость; строка «лист · крепость · жар» для банки', () {
      expect(lineStrength('Darkside', 'Base'), 8);
      expect(lineStrength('Spectrum', 'Hard Line'), 7);
      expect(lineStrength('Element', 'Земля'), 6);
      expect(lineStrength('Musthave', ''), isNull);
      expect(canStrength('Spectrum', '', line: 'Classic'), 4);
      expect(canProfileLine('Overdose'), contains('крепость 7/10'));
      expect(canProfileLine('Spectrum', line: 'Hard'), contains('крепость 7/10'));
      expect(canProfileLine('Frigate'), contains('сухой табак'));
      expect(canProfileLine('Неизвестная'), isEmpty);
    });

    test('марку не видно: «Мощная мята» — Spectrum, а просто «Мята» — без марки', () {
      expect(TobaccoShelf.fromScan({'brand': '', 'name': 'Мощная мята'}).brand, 'Spectrum');
      expect(TobaccoShelf.fromScan({'brand': '', 'name': 'Мармелад с колой'}).brand, 'Burn');
      expect(TobaccoShelf.fromScan({'brand': '', 'name': 'Мята'}).brand, '');
      expect(TobaccoShelf.fromScan({'brand': 'Overdose', 'name': 'Мята'}).brand, 'Overdose');
    });

    test('ошибка ИИ в букве: «Простниковая мята» → «Тростниковая мята»', () {
      expect(fixCanName('Black Burn', 'Простниковая мята'), 'Тростниковая мята');
      expect(fixCanName('Black Burn', 'Тросниковая мята'), 'Тростниковая мята');
      expect(fixCanName('Black Burn', 'Ice Baby'), 'Ice Baby');
      final can = TobaccoShelf.fromScan({'brand': 'BLACK BURN', 'name': 'Простниковая мята'});
      expect(can.name, 'Тростниковая мята');
      expect(can.flavors, containsAll(['sugarcane', 'mint']));
    });

    test('Frigate — сухой табак: не вкус, а добавка для крепости', () {
      expect(canonicalBrand('ФРИГАТ'), 'Frigate');
      expect(profileOf('Frigate')!.booster, isTrue);
      expect(flavorsOfCan('Frigate', 'Caribbean Nights', ''), ['tobacco']);
      final e = MixEngine([
        c('rb', 'Darkside', ['raspberry']),
        c('lm', 'Musthave', ['lemon']),
        c('mt', 'Musthave', ['mint']),
        c('fr', 'Frigate', ['tobacco']),
      ]);
      expect(e.shelf.any((x) => x.id == 'fr'), isFalse, reason: 'в миксы как вкус не идёт');
      expect(e.boosters.single.id, 'fr');
      final req = MixRequest.parse('что-нибудь крепкое с малиной');
      final text = e.render(e.pick(req), req: req);
      expect(text, contains('сухого табака Frigate'));
      expect(StaffBrain.tobaccoAnswer('что такое сухой табак?'), contains('крепость'));
      expect(StaffBrain.tobaccoAnswer('как забивать фригат'), contains('сухой табак'));
    });

    test('та же просьба ещё раз и «ещё» — другие миксы, потом по кругу', () {
      final e = MixEngine(const []);
      final s = MixSession();
      final a = s.answer(e, 'кислое');
      final b = s.answer(e, 'кислое');
      final d = s.answer(e, 'ещё');
      String first(String t) => t.split('\n').first;
      expect(first(a), isNot(first(b)));
      expect(first(b), isNot(first(d)));
      expect(MixRequest.parse('другое').more, isTrue);
      expect(MixRequest.parse('что-нибудь интереснее').tags, contains('необычный'));
      expect(MixRequest.parse('парфюмное').tags, contains('цветочный'));
      // Новая просьба — память сбрасывается.
      final x = s.answer(e, 'сладкое');
      expect(x, isNot(contains('закончились')));
    });

    test('табачный и солёный вкус не подменяют фрукт', () {
      final e = MixEngine([c('sal', 'Bonche', ['savory']), c('tb', 'WTO', ['tobacco'])]);
      expect(e.substitute('basil', const {}, const {}), isNull);
      expect(e.substitute('raspberry', const {}, const {}), isNull);
    });
  });
}
