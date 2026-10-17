import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/widgets/open_source_licenses.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('лицензии шрифтов читаются из assets', () async {
    final entries = await fontLicenses().toList();
    expect(entries.expand((e) => e.packages), containsAll(['Onest', 'Cormorant Garamond']));
    for (final e in entries) {
      expect(e.paragraphs.map((p) => p.text).join(' '), contains('SIL Open Font License'));
    }
  });

  testWidgets('кнопка открывает экран лицензий', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => TextButton(
          onPressed: () => showOpenSourceLicenses(context, appName: 'ZalPOS'),
          child: const Text('Лицензии'),
        ),
      ),
    ));
    await tester.tap(find.text('Лицензии'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.byType(LicensePage), findsOneWidget);
  });
}
