import 'package:flutter/material.dart';

import '../models/table_model.dart';

/// Контур стола нужной формы: квадрат, круг, длинный, овальный, угловой
/// (буквой «Г») или барная стойка — общий для схемы зала на кассе,
/// редактора администратора, выбора стола при брони и карты в приложении
/// гостя. [child] — подписи стола; у углового они стоят в клетке на сгибе.
class TableShapeBox extends StatelessWidget {
  final TableModel table;
  final Size size;
  final Color fill;
  final Color borderColor;
  final double borderWidth;
  final List<BoxShadow> shadows;
  final double cornerRadius;
  final Widget child;

  const TableShapeBox({
    super.key,
    required this.table,
    required this.size,
    required this.fill,
    required this.borderColor,
    this.borderWidth = 1.6,
    this.shadows = const [],
    this.cornerRadius = 18,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    if (table.shape == 'corner') {
      final radius = (cornerRadius * size.shortestSide / 208).clamp(4.0, cornerRadius);
      return CustomPaint(
        painter: _CornerPainter(
          rotation: table.rotation,
          size: size,
          radius: radius,
          fill: fill,
          border: borderColor,
          borderWidth: borderWidth,
          shadow: shadows.isEmpty ? null : shadows.first,
        ),
        child: SizedBox(
          width: size.width,
          height: size.height,
          child: Stack(children: [
            Positioned.fromRect(
              rect: cornerElbowRect(size, table.rotation).deflate(size.shortestSide * 0.04),
              child: Center(child: child),
            ),
          ]),
        ),
      );
    }
    final round = table.shape == 'circle' || table.shape == 'oval';
    final bar = table.shape == 'bar';
    return Container(
      width: size.width,
      height: size.height,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(round ? size.shortestSide / 2 : (bar ? cornerRadius * 0.5 : cornerRadius)),
        border: Border.all(color: borderColor, width: borderWidth),
        boxShadow: shadows,
      ),
      // Барная стойка: полоса столешницы вдоль стороны бармена (поворот
      // выбирает сторону) — отличается от длинного стола с первого взгляда.
      foregroundDecoration: bar ? _BarCounterDecoration(table.rotation, borderColor) : null,
      padding: bar
          ? EdgeInsets.fromLTRB(
              table.rotation % 4 == 3 ? 16 : 8,
              table.rotation % 4 == 0 ? 16 : 8,
              table.rotation % 4 == 1 ? 16 : 8,
              table.rotation % 4 == 2 ? 16 : 8,
            )
          : EdgeInsets.all(table.shape == 'circle' ? 14 : 8),
      child: child,
    );
  }
}

/// Клетка на сгибе углового стола: при повороте 0 — левая нижняя, дальше по
/// часовой стрелке. Стол занимает 2×2 клетки без одной — напротив сгиба.
Rect cornerElbowRect(Size s, int rotation) {
  final w = s.width / 2, h = s.height / 2;
  switch (rotation % 4) {
    case 1:
      return Rect.fromLTWH(0, 0, w, h);
    case 2:
      return Rect.fromLTWH(w, 0, w, h);
    case 3:
      return Rect.fromLTWH(w, h, w, h);
    default:
      return Rect.fromLTWH(0, h, w, h);
  }
}

/// Контур углового стола буквой «Г»: две полосы толщиной в клетку со
/// скруглёнными внешними углами, встречаются в клетке на сгибе.
Path cornerPath(Size s, int rotation, {double radius = 0}) {
  final w = s.width, h = s.height;
  final elbow = cornerElbowRect(s, rotation);
  // Вертикальная полоса — через сгиб на всю высоту, горизонтальная — на всю ширину.
  final column = Rect.fromLTWH(elbow.left, 0, w / 2, h);
  final row = Rect.fromLTWH(0, elbow.top, w, h / 2);
  final r = Radius.circular(radius);
  return Path.combine(
    PathOperation.union,
    Path()..addRRect(RRect.fromRectAndRadius(column, r)),
    Path()..addRRect(RRect.fromRectAndRadius(row, r)),
  );
}

/// Угол плитки, где у углового стола пустая клетка (напротив сгиба), — туда
/// удобно поставить кнопку. Для остальных форм — правый верхний.
Alignment tableFreeCorner(TableModel t) {
  if (t.shape != 'corner') return Alignment.topRight;
  switch (t.rotation % 4) {
    case 1:
      return Alignment.bottomRight;
    case 2:
      return Alignment.bottomLeft;
    case 3:
      return Alignment.topLeft;
    default:
      return Alignment.topRight;
  }
}

class _CornerPainter extends CustomPainter {
  final int rotation;
  final Size size;
  final double radius;
  final Color fill;
  final Color border;
  final double borderWidth;
  final BoxShadow? shadow;

  _CornerPainter({
    required this.rotation,
    required this.size,
    required this.radius,
    required this.fill,
    required this.border,
    required this.borderWidth,
    this.shadow,
  });

  @override
  void paint(Canvas canvas, Size size) {
    // Контур чуть внутри, чтобы рамка не обрезалась краем плитки.
    final inset = borderWidth / 2;
    final path = cornerPath(Size(size.width - inset * 2, size.height - inset * 2), rotation, radius: radius)
        .shift(Offset(inset, inset));
    if (shadow != null) {
      canvas.drawPath(
        path.shift(shadow!.offset),
        Paint()
          ..color = shadow!.color
          ..maskFilter = MaskFilter.blur(BlurStyle.normal, shadow!.blurRadius / 2),
      );
    }
    canvas.drawPath(path, Paint()..color = fill);
    canvas.drawPath(
      path,
      Paint()
        ..color = border
        ..style = PaintingStyle.stroke
        ..strokeWidth = borderWidth
        ..strokeJoin = StrokeJoin.round,
    );
  }

  /// Нажатие считается только по самому столу: пустая клетка не
  /// перехватывает касания у стола, который стоит в ней.
  @override
  bool? hitTest(Offset position) => cornerPath(size, rotation).contains(position);

  @override
  bool shouldRepaint(_CornerPainter old) =>
      old.rotation != rotation ||
      old.size != size ||
      old.radius != radius ||
      old.fill != fill ||
      old.border != border ||
      old.borderWidth != borderWidth ||
      old.shadow != shadow;
}

/// Полоса столешницы барной стойки у стороны бармена: 0 — сверху, дальше по
/// часовой стрелке.
class _BarCounterDecoration extends Decoration {
  final int rotation;
  final Color color;
  const _BarCounterDecoration(this.rotation, this.color);

  @override
  BoxPainter createBoxPainter([VoidCallback? onChanged]) => _BarCounterPainter(rotation, color);

  @override
  bool operator ==(Object other) =>
      other is _BarCounterDecoration && other.rotation == rotation && other.color == color;

  @override
  int get hashCode => Object.hash(rotation, color);
}

class _BarCounterPainter extends BoxPainter {
  final int rotation;
  final Color color;
  _BarCounterPainter(this.rotation, this.color);

  @override
  void paint(Canvas canvas, Offset offset, ImageConfiguration configuration) {
    final s = configuration.size;
    if (s == null) return;
    const inset = 7.0, thick = 5.0;
    final r = offset & s;
    final Rect stripe;
    switch (rotation % 4) {
      case 1:
        stripe = Rect.fromLTWH(r.right - inset - thick, r.top + inset, thick, r.height - inset * 2);
        break;
      case 2:
        stripe = Rect.fromLTWH(r.left + inset, r.bottom - inset - thick, r.width - inset * 2, thick);
        break;
      case 3:
        stripe = Rect.fromLTWH(r.left + inset, r.top + inset, thick, r.height - inset * 2);
        break;
      default:
        stripe = Rect.fromLTWH(r.left + inset, r.top + inset, r.width - inset * 2, thick);
    }
    canvas.drawRRect(
      RRect.fromRectAndRadius(stripe, const Radius.circular(thick / 2)),
      Paint()..color = color.withValues(alpha: 0.45),
    );
  }
}

/// Подпись формы стола для редактора.
String tableShapeLabel(String shape) {
  switch (shape) {
    case 'circle':
      return 'Круглый';
    case 'long':
      return 'Длинный';
    case 'oval':
      return 'Овальный';
    case 'corner':
      return 'Угловой';
    case 'bar':
      return 'Барная стойка';
    default:
      return 'Квадратный';
  }
}
