import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/widgets/table_ai_tips_bar.dart';

// «К заказу подойдёт»: подсказки видны целиком (переносом, без ленты с
// прокруткой, где название обрезалось краем), при крупном шрифте ничего не
// вылезает за край. Настоящий шрифт: тестовый квадратный даёт ложные
// «overflowed».
void main() {
  setUpAll(() async {
    final l = FontLoader('Onest');
    for (final w in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
      l.addFont(Future.value(ByteData.sublistView(File('assets/fonts/Onest-$w.ttf').readAsBytesSync())));
    }
    await l.load();
  });
  tearDown(() => TableAiTipsBar.debugTips = null);

  for (final scale in [1.0, 1.6]) {
    testWidgets('подсказки целиком, шрифт ×$scale', (t) async {
      await t.binding.setSurfaceSize(const Size(400, 800));
      addTearDown(() => t.binding.setSurfaceSize(null));
      TableAiTipsBar.debugTips = [
        MenuItem(id: 'a', categoryId: 'c', name: 'Авторский чай', price: 330),
        MenuItem(id: 'b', categoryId: 'c', name: 'Лимонад', price: 290),
        MenuItem(id: 'c', categoryId: 'c', name: 'Сырники со сметаной', price: 410),
      ];
      final s = SessionModel(
        id: 's1',
        tableId: 't',
        tableName: 'VIP 2',
        employeeName: 'Анна',
        employeeId: 'e1',
        startTime: DateTime(2026, 11, 27, 18),
        plannedEnd: DateTime(2026, 11, 27, 20),
        status: 'active',
      );
      await t.pumpWidget(MaterialApp(
        theme: ThemeData(fontFamily: 'Onest'),
        home: MediaQuery(
          data: MediaQueryData(size: const Size(400, 800), textScaler: TextScaler.linear(scale)),
          child: Scaffold(body: Padding(padding: const EdgeInsets.all(16), child: TableAiTipsBar(session: s))),
        ),
      ));
      await t.pump();
      expect(t.takeException(), isNull);
      for (final n in ['Авторский чай', 'Лимонад', 'Сырники со сметаной']) {
        expect(find.text(n), findsOneWidget);
        final r = t.getRect(find.text(n));
        expect(r.right, lessThanOrEqualTo(400 - 16), reason: '$n не обрезано краем');
      }
      expect(find.text('К ЗАКАЗУ ПОДОЙДЁТ'), findsOneWidget);
      expect(find.byType(ListView), findsNothing);
    });
  }
}
