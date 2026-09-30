import 'dart:math' as math;
import 'dart:ui' show Offset, Rect;

import 'package:cloud_firestore/cloud_firestore.dart';

import '../utils/hall_layout.dart';
import '../utils/parse.dart';

/// Стена на схеме зала: ломаная по углам на холсте [kHallCanvas] — как
/// контур помещения на чертеже. У каждой зоны свои стены ([zone], '' —
/// без зоны), как и свои столы.
///
/// Хранится в коллекции hallWalls; точки — плоский список чисел
/// [x0, y0, x1, y1, …] (в Firestore нет вложенных списков).
class HallWall {
  final String id;
  final String zone;
  final List<Offset> points;

  /// Контур замкнут: последний угол соединён с первым, помещение
  /// подсвечивается изнутри.
  final bool closed;

  /// Углов в одной стене не больше — длинный контур режется на несколько.
  static const int maxPoints = 200;

  const HallWall({required this.id, required this.zone, required this.points, this.closed = false});

  factory HallWall.fromMap(String id, Map<String, dynamic> d) {
    final raw = asList(d['points']);
    final points = <Offset>[];
    for (var i = 0; i + 1 < raw.length && points.length < maxPoints; i += 2) {
      final x = asNum(raw[i]), y = asNum(raw[i + 1]);
      if (x == null || y == null || !x.isFinite || !y.isFinite) continue;
      points.add(Offset(
        x.toDouble().clamp(0.0, kHallCanvas.width),
        y.toDouble().clamp(0.0, kHallCanvas.height),
      ));
    }
    return HallWall(
      id: id,
      zone: asText(d['zone']).trim(),
      points: points,
      closed: d['closed'] == true && points.length >= 3,
    );
  }

  factory HallWall.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) =>
      HallWall.fromMap(doc.id, doc.data() ?? const {});

  /// Стену есть что рисовать: хотя бы один отрезок.
  bool get isValid => points.length >= 2;

  Map<String, dynamic> toMap() => {
        'zone': zone,
        'points': [
          for (final p in points) ...[_round(p.dx), _round(p.dy)],
        ],
        'closed': closed,
      };

  static double _round(double v) => (v * 10).roundToDouble() / 10;

  /// Отрезки стены (у замкнутой — и последний к первому).
  List<(Offset, Offset)> get segments => [
        for (var i = 0; i + 1 < points.length; i++) (points[i], points[i + 1]),
        if (closed && points.length >= 3) (points.last, points.first),
      ];

  /// Прямоугольник, в который помещается стена.
  Rect get bounds {
    if (points.isEmpty) return Rect.zero;
    var l = points.first.dx, t = points.first.dy, r = l, b = t;
    for (final p in points) {
      l = math.min(l, p.dx);
      t = math.min(t, p.dy);
      r = math.max(r, p.dx);
      b = math.max(b, p.dy);
    }
    return Rect.fromLTRB(l, t, r, b);
  }

  /// Расстояние от точки [p] до ближайшего отрезка стены.
  double distanceTo(Offset p) {
    if (points.length == 1) return (points.first - p).distance;
    var best = double.infinity;
    for (final (a, b) in segments) {
      best = math.min(best, distanceToSegment(p, a, b));
    }
    return best;
  }
}

/// Толщина стены на холсте (плитка стола — [kHallTile]).
const double kHallWallWidth = 14;

/// Расстояние от точки [p] до отрезка [a]–[b].
double distanceToSegment(Offset p, Offset a, Offset b) {
  final ab = b - a;
  final len2 = ab.dx * ab.dx + ab.dy * ab.dy;
  if (len2 == 0) return (p - a).distance;
  final t = (((p.dx - a.dx) * ab.dx + (p.dy - a.dy) * ab.dy) / len2).clamp(0.0, 1.0);
  return (p - (a + ab * t)).distance;
}

/// Точка на сетке редактора, в пределах холста.
Offset hallSnapToGrid(Offset p) {
  double snap(double v, double max) => ((v / kHallGridStep).round() * kHallGridStep).clamp(0.0, max).toDouble();
  return Offset(snap(p.dx, kHallCanvas.width), snap(p.dy, kHallCanvas.height));
}

/// Конец стены от угла [from] к пальцу [to]. С [straight] — строго
/// по горизонтали, вертикали или под 45°, как на чертеже; без него —
/// в ближайший узел сетки. [from] уже на сетке, поэтому и конец на ней.
Offset hallWallEnd(Offset from, Offset to, {bool straight = true}) {
  if (!straight) return hallSnapToGrid(to);
  final d = to - from;
  if (d.distance < 1) return from;
  const step = kHallGridStep;
  double snapLen(double v) => (v / step).round() * step;
  // Направление — ближайшее из восьми.
  final sector = ((math.atan2(d.dy, d.dx) / (math.pi / 4)).round() + 8) % 8;
  final sx = const [1, 1, 0, -1, -1, -1, 0, 1][sector];
  final sy = const [0, 1, 1, 1, 0, -1, -1, -1][sector];
  if (sy == 0) return hallSnapToGrid(Offset(to.dx, from.dy));
  if (sx == 0) return hallSnapToGrid(Offset(from.dx, to.dy));
  // Диагональ: одинаковый шаг по обеим осям, не дальше края холста.
  var k = snapLen((d.dx.abs() + d.dy.abs()) / 2);
  final roomX = sx > 0 ? kHallCanvas.width - from.dx : from.dx;
  final roomY = sy > 0 ? kHallCanvas.height - from.dy : from.dy;
  k = math.min(k, (math.min(roomX, roomY) / step).floor() * step);
  return Offset(from.dx + sx * k, from.dy + sy * k);
}

/// Углы других стен рядом с [p] (ближе [radius]) — чтобы стены сходились
/// точно, а не «почти». Ближайший или null.
Offset? hallNearestCorner(Offset p, Iterable<Offset> corners, double radius) {
  Offset? best;
  var bestDist = radius;
  for (final c in corners) {
    final d = (c - p).distance;
    if (d <= bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

/// Углы тела стены (заливки между линиями контура) для рисования встык.
/// Свободный конец продлён на [extend] — тело доходит до торцевой линии,
/// как у квадратного края. Конец, упёршийся в другую стену посередине или
/// в её угол, не продлевается: иначе тело залезло бы на контур той стены и
/// на стыке осталась бы тёмная засечка. Концы двух стен, сходящихся углом,
/// продлеваются оба — угол заполнен.
List<Offset> hallWallBodyPoints(HallWall w, Iterable<HallWall> all, double extend) {
  final pts = w.points;
  if (w.closed || pts.length < 2) return pts;
  bool abuts(Offset end) => all.any((o) {
        if (identical(o, w) || o.id == w.id || !o.isValid || o.distanceTo(end) > 0.5) return false;
        // Конец другой открытой стены — это угол, а не упор в стену.
        final isEnd = !o.closed && ((o.points.first - end).distance < 0.5 || (o.points.last - end).distance < 0.5);
        return !isEnd;
      });
  Offset extended(Offset end, Offset neighbor) {
    final d = end - neighbor;
    final len = d.distance;
    if (len == 0 || abuts(end)) return end;
    return end + d / len * extend;
  }

  return [
    extended(pts.first, pts[1]),
    ...pts.sublist(1, pts.length - 1),
    extended(pts.last, pts[pts.length - 2]),
  ];
}

/// Рамка вокруг стен — для [hallContentRect] (стены могут выходить за
/// столы: гость должен видеть помещение целиком).
List<Rect> hallWallBounds(Iterable<HallWall> walls) => [
      for (final w in walls)
        if (w.isValid) w.bounds.inflate(kHallWallWidth / 2),
    ];
