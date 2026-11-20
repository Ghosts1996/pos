import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/widgets/load_failed_view.dart';

void main() {
  testWidgets('настройки не загрузились: понятный текст, «Назад» и «Повторить»', (tester) async {
    var retries = 0;
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (_) => LoadFailedScaffold(title: 'Интеграции', error: Exception('нет связи'), onRetry: () => retries++),
            )),
            child: const Text('открыть'),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('открыть'));
    await tester.pumpAndSettle();
    expect(find.text('Настройки не загрузились'), findsOneWidget);
    expect(find.text('Интеграции'), findsOneWidget);
    expect(find.byType(BackButton), findsOneWidget, reason: 'с экрана можно уйти и на Windows');
    await tester.tap(find.text('Повторить'));
    expect(retries, 1);
  });
}
