import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/models/table_model.dart';
import 'package:hookah_pos/widgets/table_shape.dart';
import 'package:hookah_pos/widgets/table_tile.dart';
import 'package:hookah_pos/widgets/timer_display.dart';

void main() {
  // Слабый моноблок на Windows подтормаживал на карте зала: каждая занятая
  // плитка целиком (тень, рамка, подписи) перестраивалась каждую секунду.
  // В SaaS плитка перестраивается только при смене состояния, а секунды
  // таймера — в своём слое фиксированного размера.
  testWidgets('секунды таймера не перестраивают плитку стола', (tester) async {
    final table = TableModel(id: 't1', name: 'Стол 1', x: 0.2, y: 0.2, activeSessionIds: const ['s1']);
    final end = DateTime.now().add(const Duration(hours: 1));
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: Center(child: TableTile(table: table, plannedEnd: end))),
    ));
    final before = tester.widget<TableShapeBox>(find.byType(TableShapeBox));
    await tester.pump(const Duration(seconds: 3)); // три тика общего секундомера
    final after = tester.widget<TableShapeBox>(find.byType(TableShapeBox));
    expect(find.byType(TimerDisplay), findsOneWidget);
    if (kSaasMode) {
      expect(identical(before, after), isTrue, reason: 'плитка не перестраивалась');
      final slot = find.ancestor(of: find.byType(TimerDisplay), matching: find.byType(RepaintBoundary));
      expect(slot, findsWidgets, reason: 'таймер — в своём слое');
    }

    // Время вышло (новые данные стола) — плитка перестраивается и краснеет.
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: Center(child: TableTile(table: table, plannedEnd: DateTime.now().subtract(const Duration(minutes: 1))))),
    ));
    final overdue = tester.widget<TableShapeBox>(find.byType(TableShapeBox));
    expect(identical(overdue, after), isFalse);
    expect(overdue.borderColor, isNot(after.borderColor));
    await tester.pumpWidget(const SizedBox()); // отписаться от секундомера
  });
}
