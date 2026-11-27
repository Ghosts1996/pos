import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/widgets/ai_rich_text.dart';

void main() {
  const sample = '''### Главное за сутки
- 5 чеков, выручка **6430 ₽**, средний чек **1286 ₽**.
- Оплаты: наличными **2145 ₽**, картой **4285 ₽**.

### Три действия на завтра
1. Разобрать с командой причины удалений.
2. Проверять скидки при закрытии чеков.
---
| Сотрудник | Чеки |
|---|---|
| Паргев | 3 |
**Итог:**''';

  test('разметка ИИ → блоки без звёздочек и решёток', () {
    final blocks = parseAiBlocks(sample);
    expect(blocks.first.kind, AiBlockKind.heading);
    expect(blocks.first.text, 'Главное за сутки');
    expect(blocks.where((b) => b.kind == AiBlockKind.bullet).length, 2);
    expect(blocks.where((b) => b.kind == AiBlockKind.numbered).map((b) => b.number), [1, 2]);
    expect(blocks.any((b) => b.kind == AiBlockKind.divider), isTrue);
    expect(blocks.any((b) => b.text == 'Паргев · 3'), isTrue);
    expect(blocks.last.kind, AiBlockKind.heading);
    final plain = plainAiText(sample);
    expect(plain, isNot(contains('*')));
    expect(plain, isNot(contains('#')));
    expect(plain, contains('• 5 чеков, выручка 6430 ₽, средний чек 1286 ₽.'));
    expect(plain, contains('1. Разобрать с командой причины удалений.'));
  });

  test('жирное — жирным шрифтом, а не символами', () {
    final spans = aiInlineSpans('выручка **6430 ₽** за день', const TextStyle());
    expect(spans.map((s) => s.text).join(), 'выручка 6430 ₽ за день');
    expect(spans[1].style?.fontWeight, FontWeight.w700);
  });

  testWidgets('виджет показывает текст без разметки', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SingleChildScrollView(child: AiRichText(sample)))));
    final all = tester.widgetList<Text>(find.byType(Text)).map((t) => t.textSpan?.toPlainText() ?? t.data ?? '').join('\n');
    if (kSaasMode) {
      expect(all, isNot(contains('**')));
      expect(all, isNot(contains('###')));
      expect(all, contains('Главное за сутки'));
    }
    expect(tester.takeException(), isNull);
  });
}
