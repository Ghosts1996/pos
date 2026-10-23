import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/widgets/device_name_field.dart';

void main() {
  test('без названия устройство не подключить', () {
    expect(DeviceNameField.validate('  '), isNotNull);
    expect(DeviceNameField.validate('Планшет у бара'), isNull);
  });

  testWidgets('быстрый вариант подставляет название', (tester) async {
    final c = TextEditingController();
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: DeviceNameField(controller: c))));
    await tester.tap(find.text('Экран кухни'));
    expect(c.text, 'Экран кухни');
  });

  testWidgets('окно названия не закрывается без названия и сохраняет его', (tester) async {
    String? saved;
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => TextButton(
          onPressed: () => askDeviceName(context, (n) async => saved = n),
          child: const Text('открыть'),
        ),
      ),
    ));
    await tester.tap(find.text('открыть'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Сохранить'));
    await tester.pumpAndSettle();
    expect(find.text('Как назвать это устройство?'), findsOneWidget);
    expect(find.textContaining('Назовите устройство'), findsOneWidget);
    await tester.tap(find.text('Планшет у бара'));
    await tester.tap(find.text('Сохранить'));
    await tester.pumpAndSettle();
    expect(saved, 'Планшет у бара');
    expect(find.text('Как назвать это устройство?'), findsNothing);
  });
}
