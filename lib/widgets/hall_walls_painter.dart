import 'package:flutter/foundation.dart' show listEquals, setEquals;
import 'package:flutter/material.dart';

import '../models/hall_label.dart';
import '../models/hall_wall.dart';
import '../utils/hall_layout.dart';

/// Стены зала «как на чертеже»: мягкая тень под стеной, светлый контур и
/// тело стены между двумя линиями контура, помещение внутри замкнутого
/// контура чуть подсвечено.
///
/// Все стены рисуются слоями разом — сначала тени, потом контуры, потом
/// тела: там, где две стены сходятся, они сливаются в одну, без линий
/// внахлёст. Поверх — подписи («Вход», «Кухня», заметки) заглавными с
/// разрядкой, как на чертеже.
class HallWallsPainter extends CustomPainter {
  final List<HallWall> walls;
  final List<HallLabel> labels;

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
    this.labels = const [],
    this.highlighted = const {},
    this.highlightColor,
    this.shadow = true,
  });

  /// Надпись подписи [text] цветом [color] — заглавными с разрядкой.
  static TextPainter labelPainter(String text, Color color) => TextPainter(
        text: TextSpan(
          text: text.toUpperCase(),
          style: TextStyle(
            color: color,
            fontSize: kHallLabelFontSize,
            fontWeight: FontWeight.w800,
            letterSpacing: kHallLabelFontSize * 0.14,
            height: 1.1,
          ),
        ),
        textDirection: TextDirection.ltr,
        maxLines: 1,
      )..layout();

  /// Место подписи на холсте — для кадра схемы и касаний в редакторе.
  static Rect labelRect(HallLabel l) {
    final tp = labelPainter(l.text, const Color(0xFF000000));
    return Rect.fromCenter(center: l.at, width: tp.width, height: tp.height);
  }

  /// Цвет подписи: приглушённый цвет стен.
  static Color labelColorFor(Color line) => line.withValues(alpha: 0.55);

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
    _paintWalls(canvas, size);
    // Подписи — поверх стен: «Вход» у проёма, «Кухня» в комнате.
    for (final l in labels) {
      if (!l.isValid) continue;
      final color = highlighted.contains(l.id) && highlightColor != null ? highlightColor! : labelColorFor(line);
      final tp = labelPainter(l.text, color);
      tp.paint(canvas, l.at - Offset(tp.width / 2, tp.height / 2));
    }
  }

  void _paintWalls(Canvas canvas, Size size) {
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
        old.walls.length != walls.length ||
        old.labels.length != labels.length) {
      return true;
    }
    for (var i = 0; i < labels.length; i++) {
      final a = old.labels[i], b = labels[i];
      if (a.id != b.id || a.text != b.text || a.at != b.at) return true;
    }
    for (var i = 0; i < walls.length; i++) {
      if (!_same(old.walls[i], walls[i])) return true;
    }
    return false;
  }
}
