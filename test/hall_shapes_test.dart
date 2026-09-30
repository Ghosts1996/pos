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
    expect(hallTileSize(_t('corner', rotation: 3)), const Size(kHallTile * 2, kHallTile * 2));
  });

  test('овальный — две клетки, барная стойка — три', () {
    expect(hallTileSize(_t('oval', rotation: 2)), const Size(kHallTile * 2, kHallTile));
    expect(hallTileSize(_t('bar')), const Size(kHallTile * 3, kHallTile));
    expect(hallTileSize(_t('bar', rotation: 3)), const Size(kHallTile, kHallTile * 3));
    expect(tableShapeRotates('rect'), isFalse);
    expect(tableShapeRotates('circle'), isFalse);
    expect(tableShapeRotates('bar'), isTrue);
  });

  test('поворот на месте: центр не сдвигается, края остаются на сетке', () {
    // Стойка у левого верхнего угла сетки: 4-я и 3-я клетки сетки.
    final f = hallFractionForTopLeft(kHallGridStep * 4, kHallGridStep * 8, hallTileSize(_t('bar')));
    final bar = _t('bar', x: f.x, y: f.y);
    final r = hallRotated(bar);
    expect(r.rotation, 1);
    final o0 = hallTileOffset(bar), s0 = hallTileSize(bar);
    final o1 = hallTileOffset(r), s1 = hallTileSize(r);
    expect(o1.left + s1.width / 2, closeTo(o0.left + s0.width / 2, 1e-6));
    expect(o1.top + s1.height / 2, closeTo(o0.top + s0.height / 2, 1e-6));
    expect(o1.left % kHallGridStep, closeTo(0, 1e-6));
    expect(o1.top % kHallGridStep, closeTo(0, 1e-6));
    // Четыре поворота — снова исходное положение.
    final back = hallRotated(hallRotated(hallRotated(r)));
    expect(back.rotation, 0);
    expect(back.x, closeTo(bar.x, 1e-9));
    expect(back.y, closeTo(bar.y, 1e-9));
  });

  test('у края холста повёрнутый стол не вылезает наружу', () {
    final r = hallRotated(_t('bar', x: 0, y: 0));
    final o = hallTileOffset(r);
    expect(o.left, greaterThanOrEqualTo(0));
    expect(o.top, greaterThanOrEqualTo(0));
    expect(o.top + hallTileSize(r).height, lessThanOrEqualTo(kHallCanvas.height));
  });

  test('длинный стол у правого края не уезжает за холст', () {
    final o = hallTileOffset(_t('long', x: 99, y: 99));
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

  test('угловой стол — буква «Г»: сгиб поворачивается по часовой, напротив пусто', () {
    const s = Size(100, 100);
    const lb = Offset(25, 75), lt = Offset(25, 25), rt = Offset(75, 25), rb = Offset(75, 75);
    // Поворот 0: сгиб слева внизу, пусто справа вверху.
    expect([lb, lt, rb].every(cornerPath(s, 0).contains), isTrue);
    expect(cornerPath(s, 0).contains(rt), isFalse);
    expect(cornerPath(s, 1).contains(rb), isFalse);
    expect(cornerPath(s, 2).contains(lb), isFalse);
    expect(cornerPath(s, 3).contains(lt), isFalse);
    expect(cornerElbowRect(s, 2), const Rect.fromLTWH(50, 0, 50, 50));
  });

  test('угловой стол поворачивается на месте и остаётся 2×2', () {
    expect(hallRotated(_t('corner')).rotation, 1);
    expect(hallTileSize(hallRotated(_t('corner'))), const Size(kHallTile * 2, kHallTile * 2));
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
    expect(find.text('Стол 1'), findsNWidgets(kTableShapes.length * 4));
  });

  testWidgets('пустая клетка углового стола не перехватывает нажатия', (tester) async {
    var taps = 0;
    await tester.pumpWidget(MaterialApp(
      home: Align(
        alignment: Alignment.topLeft,
        child: GestureDetector(
          onTap: () => taps++,
          child: TableShapeBox(
            table: _t('corner'),
            size: const Size(100, 100),
            fill: Colors.black,
            borderColor: Colors.white,
            child: const Text('Стол 1'),
          ),
        ),
      ),
    ));
    await tester.tapAt(const Offset(80, 20)); // пустая клетка напротив сгиба
    expect(taps, 0);
    await tester.tapAt(const Offset(25, 75)); // клетка на сгибе
    expect(taps, 1);
  });

  test('столкновение столов: вплотную можно, внахлёст — нет', () {
    TableModel at(String shape, double left, double top, {int rotation = 0}) {
      final probe = _t(shape, rotation: rotation);
      final f = hallFractionForTopLeft(left, top, hallTileSize(probe));
      return _t(shape, rotation: rotation, x: f.x, y: f.y);
    }

    final a = at('rect', 104, 104);
    expect(hallTablesOverlap(a, at('rect', 208, 104)), isFalse, reason: 'касаются краем');
    expect(hallTablesOverlap(a, at('rect', 182, 104)), isTrue);
    expect(hallTablesOverlap(a, at('long', 52, 156)), isTrue);
    // Угловой со сгибом слева снизу: клетка справа сверху пустая — туда
    // можно поставить квадратный стол, а в клетку на сгибе — нельзя.
    final corner = at('corner', 104, 104);
    expect(hallTileCells(corner), hasLength(3));
    expect(hallTablesOverlap(corner, at('rect', 208, 104)), isFalse);
    expect(hallTablesOverlap(corner, at('rect', 104, 208)), isTrue);
    // Поворот переносит пустую клетку по часовой стрелке.
    expect(hallTablesOverlap(at('corner', 104, 104, rotation: 1), at('rect', 208, 208)), isFalse);
    expect(hallTablesOverlap(at('corner', 104, 104, rotation: 2), at('rect', 104, 208)), isFalse);
    expect(hallTablesOverlap(at('corner', 104, 104, rotation: 3), at('rect', 104, 104)), isFalse);
  });
}
