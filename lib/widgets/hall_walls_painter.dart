import 'package:flutter/foundation.dart' show listEquals, setEquals;
import 'package:flutter/material.dart';

import '../models/hall_wall.dart';
import '../utils/hall_layout.dart';

/// Стены зала «как на чертеже»: мягкая тень под стеной, светлый контур и
/// тело стены между двумя линиями контура, помещение внутри замкнутого
/// контура чуть подсвечено.
///
/// Все стены рисуются слоями разом — сначала тени, потом контуры, потом
/// тела: там, где две стены сходятся, они сливаются в одну, без линий
/// внахлёст.
class HallWallsPainter extends CustomPainter {
  final List<HallWall> walls;

  /// Цвет контура стены.
  final Color line;

  /// Цвет пола: тело стены — между полом и контуром.
  final Color floor;

  /// Стены, выделенные цветом [highlightColor] (выбранная в редакторе).
  final Set<String> highlighted;
  final Color? highlightColor;

  /// Без тени — для черновика в редакторе, который рисуется поверх столов.
  final bool shadow;

  HallWallsPainter({
    required this.walls,
    required this.line,
    required this.floor,
    this.highlighted = const {},
    this.highlightColor,
    this.shadow = true,
  });

  static Path pathOf(HallWall w) {
    final p = Path()..moveTo(w.points.first.dx, w.points.first.dy);
    for (final pt in w.points.skip(1)) {
      p.lineTo(pt.dx, pt.dy);
    }
    if (w.closed) p.close();
    return p;
  }

  /// Помещение: замкнутый контур или почти замкнутый — с проёмом входа не
  /// шире трёх столов.
  static bool enclosesRoom(HallWall w) =>
      w.points.length >= 3 && (w.closed || (w.points.first - w.points.last).distance <= kHallTile * 3);

  Paint _stroke(Color color, double width) => Paint()
    ..color = color
    ..style = PaintingStyle.stroke
    ..strokeWidth = width
    ..strokeJoin = StrokeJoin.miter
    ..strokeMiterLimit = 4
    ..strokeCap = StrokeCap.square;

  @override
  void paint(Canvas canvas, Size size) {
    final shown = [
      for (final w in walls)
        if (w.isValid) w
    ];
    if (shown.isEmpty) return;
    final paths = {for (final w in shown) w.id: pathOf(w)};
    Color edgeOf(HallWall w) => highlighted.contains(w.id) && highlightColor != null ? highlightColor! : line;

    // Пол помещения — лёгкий отсвет от края к центру.
    for (final w in shown.where(enclosesRoom)) {
      final b = w.bounds;
      final room = Path()..addPolygon(w.points, true);
      canvas.drawPath(
        room,
        Paint()
          ..shader = LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [edgeOf(w).withValues(alpha: 0.075), edgeOf(w).withValues(alpha: 0.025)],
          ).createShader(b),
      );
    }

    if (shadow) {
      final soft = _stroke(Colors.black.withValues(alpha: 0.38), kHallWallWidth + 6)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 7);
      for (final p in paths.values) {
        canvas.drawPath(p.shift(const Offset(0, 5)), soft);
      }
    }

    // Контур: полная толщина стены цветом линии.
    for (final w in shown) {
      canvas.drawPath(paths[w.id]!, _stroke(edgeOf(w), kHallWallWidth));
    }

    // Тело стены поверх контура: от контура остаются две тонкие линии по
    // краям, как на чертеже. Перелив — чтобы стена не была плоской. Концы
    // — встык (см. hallWallBodyPoints): перегородка сливается со стеной,
    // в которую упирается, без засечки на её контуре.
    const body = kHallWallWidth - 4.5;
    final bounds = Offset.zero & size;
    for (final w in shown) {
      final edge = edgeOf(w);
      final bodyPath = w.closed
          ? paths[w.id]!
          : pathOf(HallWall(id: w.id, zone: w.zone, points: hallWallBodyPoints(w, shown, body / 2)));
      canvas.drawPath(
        bodyPath,
        _stroke(Colors.white, body)
          ..strokeCap = StrokeCap.butt
          ..shader = LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Color.lerp(floor, edge, 0.34)!, Color.lerp(floor, edge, 0.18)!],
          ).createShader(bounds),
      );
    }
  }

  static bool _same(HallWall a, HallWall b) =>
      identical(a, b) || (a.id == b.id && a.closed == b.closed && listEquals(a.points, b.points));

  @override
  bool shouldRepaint(covariant HallWallsPainter old) {
    if (old.line != line ||
        old.floor != floor ||
        old.highlightColor != highlightColor ||
        old.shadow != shadow ||
        !setEquals(old.highlighted, highlighted) ||
        old.walls.length != walls.length) {
      return true;
    }
    for (var i = 0; i < walls.length; i++) {
      if (!_same(old.walls[i], walls[i])) return true;
    }
    return false;
  }
}
