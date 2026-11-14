import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/utils/voice_order.dart';
import 'package:hookah_pos/widgets/voice_order_sheet.dart';

void main() {
  const menu = [
    'Латте',
    'Капучино',
    'Кола 0,5 л',
    'Кола Зеро',
    'Пицца Маргарита',
    'Пицца Пепперони',
    'Чай чёрный',
    'Сырники со сметаной',
    'Соус сырный',
    'Сок апельсиновый',
  ];
  VoiceOrderResult<String> parse(String s) => parseVoiceOrder<String>(s, menu, (x) => x);
  Map<String, int> lines(VoiceOrderResult<String> r) => {for (final l in r.lines) l.item: l.qty};

  test('числа словами и цифрами, окончания', () {
    final r = parse('Два латте, одну колу и 3 пиццы маргарита');
    expect(lines(r), {'Латте': 2, 'Кола 0,5 л': 1, 'Пицца Маргарита': 3});
    expect(r.choices, isEmpty);
    expect(r.unknown, isEmpty);
  });

  test('без запятых: число начинает новую позицию', () {
    final r = parse('две пиццы пепперони три капучино пару сырников');
    expect(lines(r), {'Пицца Пепперони': 2, 'Капучино': 3, 'Сырники со сметаной': 2});
  });

  test('неоднозначное слово — кассир выбирает', () {
    final r = parse('пиццу');
    expect(r.lines, isEmpty);
    expect(r.choices.single.options, ['Пицца Маргарита', 'Пицца Пепперони']);
    expect(r.choices.single.qty, 1);
  });

  test('полное название важнее частичного', () {
    expect(lines(parse('кола зеро')), {'Кола Зеро': 1});
    expect(lines(parse('чая')), {'Чай чёрный': 1});
  });

  test('похожие короткие слова не путаются', () {
    expect(voiceWordsMatch('сок', 'соус'), isFalse);
    expect(voiceWordsMatch('колу', 'кола'), isTrue);
    expect(voiceWordsMatch('пиццы', 'пицца'), isTrue);
    expect(lines(parse('сырный соус и апельсиновый сок')), {'Соус сырный': 1, 'Сок апельсиновый': 1});
  });

  test('повтор складывается, лишнее — в «не понял», лимит количества', () {
    final r = parse('латте, ещё латте, борщ, 900 капучино');
    expect(lines(r)['Латте'], 2);
    expect(r.unknown, contains('борщ'));
    expect(lines(r)['Капучино'], kVoiceMaxQty);
  });

  test('пустая фраза или одни служебные слова', () {
    expect(parse('').isEmpty, isTrue);
    expect(parse('добавьте пожалуйста').isEmpty, isTrue);
  });

  // Окно подтверждения: правка количества, выбор из похожих, снятие строки —
  // в чек уходит только то, что кассир оставил.
  testWidgets('окно подтверждения голосового заказа', (tester) async {
    final items = [
      MenuItem(id: 'l', categoryId: 'c', name: 'Латте', price: 200),
      MenuItem(id: 'm', categoryId: 'p', name: 'Пицца Маргарита', price: 590),
      MenuItem(id: 'p', categoryId: 'p', name: 'Пицца Пепперони', price: 650),
      MenuItem(id: 'k', categoryId: 'd', name: 'Кола', price: 150),
    ];
    final parsed = parseVoiceOrder<MenuItem>('два латте пиццу и колу и борщ', items, (i) => i.name);
    List<VoiceOrderLine<MenuItem>>? result;
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () async {
                result = await showModalBottomSheet<List<VoiceOrderLine<MenuItem>>>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => VoiceOrderSheet(heard: 'два латте пиццу и колу и борщ', parsed: parsed),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Добавить в чек (3)'), findsOneWidget);
    expect(find.textContaining('Не нашёл в меню: борщ'), findsOneWidget);
    expect(find.textContaining('— какую позицию?'), findsOneWidget);
    // Выбрали пиццу из похожих, латте стало три, колу сняли.
    await tester.tap(find.widgetWithText(ActionChip, 'Пицца Пепперони'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Больше').first);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(Checkbox).at(1));
    await tester.pumpAndSettle();
    expect(find.text('Добавить в чек (4)'), findsOneWidget);
    await tester.tap(find.text('Добавить в чек (4)'));
    await tester.pumpAndSettle();
    expect({for (final l in result!) l.item.name: l.qty}, {'Латте': 3, 'Пицца Пепперони': 1});
  });
}
