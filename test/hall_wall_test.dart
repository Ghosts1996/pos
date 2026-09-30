import 'dart:ui' show Offset, Rect;

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/hall_wall.dart';
import 'package:hookah_pos/models/table_model.dart';
import 'package:hookah_pos/utils/hall_layout.dart';

void main() {
  group('HallWall из базы', () {
    test('плоский список чисел — углы стены', () {
      final w = HallWall.fromMap('w1', {
        'zone': ' Терраса ',
        'points': [26, 26, 520, 26.0, 520, 390],
        'closed': true,
      });
      expect(w.zone, 'Терраса');
      expect(w.points, const [Offset(26, 26), Offset(520, 26), Offset(520, 390)]);
      expect(w.closed, isTrue);
      expect(w.segments.length, 3);
      expect(w.toMap()['points'], [26.0, 26.0, 520.0, 26.0, 520.0, 390.0]);
    });

    test('мусор в точках не роняет разбор, точки — в пределах холста', () {
      final w = HallWall.fromMap('w2', {
        'points': [10, 'x', 20, 30, -50, 99999, 7],
        'closed': 'yes',
      });
      expect(w.points, [const Offset(20, 30), Offset(0, kHallCanvas.height)]);
      expect(w.closed, isFalse);
      expect(HallWall.fromMap('w3', {'points': 'nope'}).isValid, isFalse);
    });

    test('замкнутым считается только контур из трёх и больше углов', () {
      final w = HallWall.fromMap('w4', {
        'points': [0, 0, 100, 0],
        'closed': true,
      });
      expect(w.closed, isFalse);
    });
  });

  group('Рисование стен', () {
    test('ровные углы: горизонталь, вертикаль и 45° по сетке', () {
      const from = Offset(104, 104);
      expect(hallWallEnd(from, const Offset(300, 112)), const Offset(312, 104));
      expect(hallWallEnd(from, const Offset(98, 400)), const Offset(104, 390));
      final diag = hallWallEnd(from, const Offset(260, 250));
      expect(diag.dx - from.dx, diag.dy - from.dy);
      expect(diag.dx % kHallGridStep, 0);
    });

    test('без ровных углов — просто ближайший узел сетки', () {
      expect(hallWallEnd(const Offset(0, 0), const Offset(140, 60), straight: false), const Offset(130, 52));
    });

    test('диагональ не уходит за край холста', () {
      final end = hallWallEnd(Offset(kHallCanvas.width - 52, 52), Offset(kHallCanvas.width + 400, 500));
      expect(end.dx, lessThanOrEqualTo(kHallCanvas.width));
      expect(end.dx - (kHallCanvas.width - 52), end.dy - 52);
    });

    test('палец рядом с углом другой стены примагничивается к нему', () {
      const corners = [Offset(26, 26), Offset(520, 26)];
      expect(hallNearestCorner(const Offset(515, 30), corners, 14), const Offset(520, 26));
      expect(hallNearestCorner(const Offset(480, 30), corners, 14), isNull);
    });

    test('касание рядом со стеной её находит', () {
      const w = HallWall(id: 'w', zone: '', points: [Offset(0, 0), Offset(200, 0), Offset(200, 200)]);
      expect(w.distanceTo(const Offset(100, 6)), closeTo(6, 1e-9));
      expect(w.distanceTo(const Offset(206, 150)), closeTo(6, 1e-9));
      expect(w.distanceTo(const Offset(100, 100)), greaterThan(50));
    });
  });

  group('Стыки стен', () {
    const outer = HallWall(id: 'o', zone: '', points: [Offset(26, 26), Offset(598, 26), Offset(598, 390)]);
    test('перегородка, упёршаяся в стену, не залезает на её контур', () {
      const partition = HallWall(id: 'p', zone: '', points: [Offset(312, 26), Offset(312, 286)]);
      final body = hallWallBodyPoints(partition, [outer, partition], 4.75);
      expect(body.first, const Offset(312, 26));
      expect(body.last, const Offset(312, 290.75));
    });

    test('две стены, сходящиеся углом, и свободные концы — с торцом', () {
      const next = HallWall(id: 'n', zone: '', points: [Offset(598, 390), Offset(26, 390)]);
      final body = hallWallBodyPoints(next, [outer, next], 4.75);
      expect(body.first, const Offset(602.75, 390));
      expect(body.last, const Offset(21.25, 390));
      const closed = HallWall(id: 'c', zone: '', points: [Offset(0, 0), Offset(100, 0), Offset(100, 100)], closed: true);
      expect(hallWallBodyPoints(closed, [closed], 4.75), closed.points);
    });
  });

  test('схема «по столам» захватывает и стены', () {
    final table = TableModel(id: 't', name: 'Стол', x: 0.5, y: 0.5);
    const wall = HallWall(id: 'w', zone: '', points: [Offset(26, 26), Offset(1100, 26), Offset(1100, 900)]);
    final withWalls = hallContentRect([table], extra: hallWallBounds([wall]));
    final onlyTable = hallContentRect([table]);
    expect(withWalls.contains(const Offset(26, 26)), isTrue);
    expect(withWalls.right, greaterThanOrEqualTo(1100));
    expect(withWalls.width, greaterThan(onlyTable.width));
    // Только стены, столов ещё нет, — тоже не весь холст.
    final wallsOnly = hallContentRect(const [], extra: [const Rect.fromLTRB(100, 100, 400, 300)]);
    expect(wallsOnly.width, lessThan(kHallCanvas.width));
  });
}
