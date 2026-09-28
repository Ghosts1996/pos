import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/table_model.dart';
import 'package:hookah_pos/utils/hall_layout.dart';
import 'package:hookah_pos/widgets/table_shape.dart';

TableModel _t(String shape, {int rotation = 0, double x = 0, double y = 0}) =>
    TableModel(id: shape, name: 'Стол', x: x, y: y, shape: shape, rotation: rotation);

void main() {
  test('длинный стол — две клетки вдоль или поперёк', () {
    expect(hallTileSize(_t('long')), const Size(kHallTile * 2, kHallTile));
    expect(hallTileSize(_t('long', rotation: 1)), const Size(kHallTile, kHallTile * 2));
    expect(hallTileSize(_t('triangle', rotation: 3)), const Size(kHallTile, kHallTile));
  });

  test('длинный стол у правого края не уезжает за холст', () {
    final o = hallTileOffset(_t('long', x: 1, y: 1));
    expect(o.left + kHallTile * 2, kHallCanvas.width);
    expect(o.top + kHallTile, kHallCanvas.height);
  });

  test('центр → доли → центр для длинного стола', () {
    final t = _t('long', rotation: 1);
    final s = hallTileSize(t);
    final f = hallFractionForCenter(300, 320, s);
    final o = hallTileOffset(_t('long', rotation: 1, x: f.x, y: f.y));
    expect(o.left + s.width / 2, closeTo(300, 1e-9));
    expect(o.top + s.height / 2, closeTo(320, 1e-9));
  });

  test('прямой угол треугольника поворачивается по часовой', () {
    const s = Size(100, 100);
    // Точка у прямого угла внутри, у противоположного — снаружи.
    expect(trianglePath(s, 0).contains(const Offset(5, 95)), isTrue);
    expect(trianglePath(s, 0).contains(const Offset(95, 5)), isFalse);
    expect(trianglePath(s, 1).contains(const Offset(5, 5)), isTrue);
    expect(trianglePath(s, 2).contains(const Offset(95, 5)), isTrue);
    expect(trianglePath(s, 3).contains(const Offset(95, 95)), isTrue);
  });

  testWidgets('все формы рисуются без ошибок', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Wrap(children: [
        for (final shape in kTableShapes)
          for (var r = 0; r < 4; r++)
            TableShapeBox(
              table: _t(shape, rotation: r),
              size: hallTileSize(_t(shape, rotation: r)),
              fill: Colors.black,
              borderColor: Colors.white,
              child: const Text('Стол 1'),
            ),
      ]),
    ));
    expect(tester.takeException(), isNull);
    expect(find.text('Стол 1'), findsNWidgets(16));
  });
}
