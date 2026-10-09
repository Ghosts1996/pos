import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/client/theme/kolibri_theme.dart';
import 'package:hookah_pos/theme/app_theme.dart';

/// Поднятая подпись поля не должна вылезать над полем: иначе при крупном
/// шрифте она ложится на текст или подсказку поля выше (скриншот с
/// «Реквизитами продавца»).
void main() {
  Future<void> check(WidgetTester t, ThemeData theme) async {
    final c = TextEditingController(text: 'ООО «Ромашка»');
    await t.pumpWidget(MediaQuery(
      data: const MediaQueryData(textScaler: TextScaler.linear(1.3)),
      child: MaterialApp(
        theme: theme,
        home: Scaffold(
          body: Column(children: [
            const SizedBox(height: 100),
            TextField(
              key: const Key('f'),
              controller: c,
              decoration: const InputDecoration(labelText: 'Продавец', helperText: 'подсказка'),
            ),
          ]),
        ),
      ),
    ));
    final field = t.getRect(find.byKey(const Key('f')));
    final label = t.getRect(find.text('Продавец'));
    expect(label.top, greaterThanOrEqualTo(field.top), reason: 'подпись торчит над полем: $label / $field');
  }

  testWidgets('касса: подпись внутри поля', (t) => check(t, AppTheme.dark));
  testWidgets('приложение гостя: подпись внутри поля', (t) => check(t, KolibriTheme.dark));
}
