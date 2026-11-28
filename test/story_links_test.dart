import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/client/screens/kolibri_stories_screen.dart';
import 'package:hookah_pos/models/story_model.dart';
import 'package:hookah_pos/services/ai/ai_agents.dart' show cleanAiText;
import 'package:hookah_pos/utils/linkify_utils.dart';
import 'package:hookah_pos/utils/story_links.dart';
import 'package:hookah_pos/widgets/story_link_field.dart';

// Лента для гостей: ссылки «как в Telegram» (выделить слово → «Ссылка») и
// карточка целиком по нажатию.
void main() {
  const long = 'Розыгрыш ко дню рождения! Подпишитесь на [наш канал](https://t.me/kolibri_lounge) '
      'и получите шанс выиграть сертификат.\nИтоги — 5 декабря.';

  test('адрес администратора → рабочая ссылка; чужие схемы — нет', () {
    expect(normalizeStoryUrl('t.me/kolibri_lounge'), 'https://t.me/kolibri_lounge');
    expect(normalizeStoryUrl(' https://zalpos.ru/x?a=1 '), 'https://zalpos.ru/x?a=1');
    expect(normalizeStoryUrl('javascript:alert(1)'), isNull);
    expect(normalizeStoryUrl('просто слово'), isNull);
    expect(normalizeStoryUrl('nodot'), isNull);
  });

  test('выделенное слово становится ссылкой, пробелы по краям — снаружи', () {
    const v = TextEditingValue(
      text: 'Подпишитесь на наш канал сегодня',
      selection: TextSelection(baseOffset: 14, extentOffset: 25), // « наш канал »
    );
    final out = insertStoryLink(v, 'https://t.me/k');
    expect(out.text, 'Подпишитесь на [наш канал](https://t.me/k) сегодня');
    expect(storyPlainText(out.text), 'Подпишитесь на наш канал сегодня');
    // Без выделения — своя подпись в место курсора.
    final ins = insertStoryLink(const TextEditingValue(text: 'Канал: ', selection: TextSelection.collapsed(offset: 7)),
        'https://t.me/k',
        label: 'тут');
    expect(ins.text, 'Канал: [тут](https://t.me/k)');
  });

  test('чистка текста карточки (ZalPOS) не ломает ссылки и абзацы', () {
    final out = cleanAiText(long, maxLength: 2000, keepLinks: true, keepLines: true);
    expect(out, contains('[наш канал](https://t.me/kolibri_lounge)'));
    expect(out, contains('\nИтоги'));
    // Обрезка не режет ссылку пополам.
    final cut = cleanAiText(long, maxLength: 60, keepLinks: true, keepLines: true);
    expect(cut.contains('](') ? cut.contains('kolibri_lounge)') : true, isTrue, reason: cut);
    // Прежняя чистка (hookah-pos) — как была.
    expect(cleanAiText('**Сторис 1 — Вечер**'), 'Вечер');
  });

  test('слово-ссылка в тексте гостя показывается словом', () {
    final spans = linkifySpans(long, style: const TextStyle());
    final shown = spans.map((s) => (s as TextSpan).text).join();
    if (kSaasMode) {
      expect(shown, isNot(contains('](')));
      expect(shown, contains('наш канал'));
      expect(spans.whereType<TextSpan>().any((s) => s.text == 'наш канал' && s.recognizer != null), isTrue);
    } else {
      expect(shown, long, reason: 'hookah-pos — текст как есть');
    }
  });

  for (final scale in [1.0, 1.6]) {
    testWidgets('карточка целиком: весь текст, кнопка ведёт дальше (шрифт ×$scale)', (tester) async {
      var went = 0;
      final story = StoryCard(
        id: 's',
        title: 'Розыгрыш ко дню рождения',
        text: '$long ${'Подробности у официанта. ' * 12}',
        action: 'booking',
        actionLabel: 'Забронировать',
        createdAt: DateTime(2026, 11, 28),
      );
      await tester.binding.setSurfaceSize(const Size(380, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(size: const Size(380, 800), textScaler: TextScaler.linear(scale)),
          child: Scaffold(body: StoryDetailSheet(story: story, onGo: () => went++)),
        ),
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.textContaining('Итоги — 5 декабря', findRichText: true), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Забронировать'), 200);
      await tester.tap(find.text('Забронировать'));
      await tester.pump();
      expect(went, 1);
    });
  }

  testWidgets('редактор: выделил слово → «Ссылка» → адрес → слово-ссылка', (tester) async {
    final body = StoryTextController(text: 'Подпишитесь на наш канал');
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (ctx) => Column(children: [
            TextField(controller: body),
            TextButton(onPressed: () => addStoryLink(ctx, body), child: const Text('Добавить ссылку')),
          ]),
        ),
      ),
    ));
    body.selection = const TextSelection(baseOffset: 15, extentOffset: 24);
    await tester.tap(find.text('Добавить ссылку'));
    await tester.pumpAndSettle();
    expect(find.text('На слово: «наш канал»'), findsOneWidget);
    await tester.enterText(find.byType(TextField).last, 'javascript:alert(1)');
    await tester.tap(find.text('Готово'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Вставьте адрес'), findsOneWidget);
    await tester.enterText(find.byType(TextField).last, 't.me/kolibri_lounge');
    await tester.tap(find.text('Готово'));
    await tester.pumpAndSettle();
    expect(body.text, 'Подпишитесь на [наш канал](https://t.me/kolibri_lounge)');
  });
}
