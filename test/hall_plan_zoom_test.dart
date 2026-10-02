import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/table_model.dart';
import 'package:hookah_pos/widgets/hall_plan_view.dart';

void main() {
  final tables = [
    for (var i = 0; i < 9; i++)
      TableModel(id: 't$i', name: 'Стол ${i + 1}', x: 0.1 + (i % 3) * 0.3, y: 0.1 + (i ~/ 3) * 0.3),
  ];

  Future<TransformationController> pump(WidgetTester tester, Size view) async {
    tester.view.physicalSize = view;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final ctrl = TransformationController();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: HallPlanView(
          tables: tables,
          fitToTables: true,
          showHint: false,
          transformationController: ctrl,
          tileBuilder: (t) => SizedBox(width: 104, height: 104, child: Text(t.name)),
        ),
      ),
    ));
    return ctrl;
  }

  var pointer = 10;
  Future<void> pinch(WidgetTester tester, double factor) async {
    final c = tester.getCenter(find.byType(InteractiveViewer));
    final a = await tester.startGesture(c - const Offset(120, 0), pointer: pointer++);
    final b = await tester.startGesture(c + const Offset(120, 0), pointer: pointer++);
    for (var i = 1; i <= 10; i++) {
      final d = 120 * (1 + (factor - 1) * i / 10);
      await a.moveTo(c - Offset(d, 0));
      await b.moveTo(c + Offset(d, 0));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await a.up();
    await b.up();
    await tester.pumpAndSettle();
  }

  testWidgets('телефон: отдалили до конца — схема по центру, а не в углу', (tester) async {
    final ctrl = await pump(tester, const Size(400, 700));
    await pinch(tester, 0.2);
    final m = ctrl.value;
    final scale = m.getMaxScaleOnAxis();
    final viewer = tester.getSize(find.byType(InteractiveViewer));
    final field = tester.getSize(find.descendant(of: find.byType(InteractiveViewer), matching: find.byType(SizedBox)).first);
    // Поле в самом мелком масштабе — ровно экран, сдвига нет.
    expect(field.width * scale, closeTo(viewer.width, 1));
    expect(field.height * scale, closeTo(viewer.height, 1));
    expect(m.getTranslation().x, closeTo(0, 1));
    expect(m.getTranslation().y, closeTo(0, 1));
  });

  testWidgets('приблизили и отдалили — масштаб в пределах, схема не уходит за край', (tester) async {
    final ctrl = await pump(tester, const Size(400, 700));
    await pinch(tester, 2.2);
    await pinch(tester, 0.6);
    final m = ctrl.value;
    final s = m.getMaxScaleOnAxis();
    final viewer = tester.getSize(find.byType(InteractiveViewer));
    final field = tester.getSize(find.descendant(of: find.byType(InteractiveViewer), matching: find.byType(SizedBox)).first);
    final t = m.getTranslation();
    expect(t.x, lessThanOrEqualTo(0.5));
    expect(t.y, lessThanOrEqualTo(0.5));
    expect(t.x + field.width * s, greaterThanOrEqualTo(viewer.width - 0.5));
    expect(t.y + field.height * s, greaterThanOrEqualTo(viewer.height - 0.5));
  });
}
