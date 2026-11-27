import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/hookah/flavors.dart';
import 'package:hookah_pos/services/hookah/mix_base.dart';
import 'package:hookah_pos/services/hookah/mix_engine.dart';

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
}
