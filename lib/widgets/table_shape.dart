import 'package:flutter/material.dart';

import '../models/table_model.dart';

/// Контур стола нужной формы: квадрат, круг, длинный (2×1) или
/// прямоугольный треугольник — общий для схемы зала на кассе, редактора
/// администратора, выбора стола при брони и карты в приложении гостя.
/// [child] — подписи стола; у треугольника они стоят ближе к прямому углу,
/// где больше места.
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
    if (table.shape == 'triangle') {
      return CustomPaint(
        painter: _TrianglePainter(
          rotation: table.rotation,
          fill: fill,
          border: borderColor,
          borderWidth: borderWidth,
          shadow: shadows.isEmpty ? null : shadows.first,
        ),
        child: SizedBox(
          width: size.width,
          height: size.height,
          child: Align(
            alignment: triangleContentAlignment(table.rotation),
            child: SizedBox(width: size.width * 0.56, height: size.height * 0.56, child: FittedBox(child: child)),
          ),
        ),
      );
    }
    final circle = table.shape == 'circle';
    return Container(
      width: size.width,
      height: size.height,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(circle ? size.shortestSide / 2 : cornerRadius),
        border: Border.all(color: borderColor, width: borderWidth),
        boxShadow: shadows,
      ),
      padding: EdgeInsets.all(circle ? 14 : 8),
      child: child,
    );
  }
}

/// Где у треугольного стола место под подписи — у прямого угла.
Alignment triangleContentAlignment(int rotation) {
  switch (rotation % 4) {
    case 1:
      return const Alignment(-0.5, -0.5);
    case 2:
      return const Alignment(0.5, -0.5);
    case 3:
      return const Alignment(0.5, 0.5);
    default:
      return const Alignment(-0.5, 0.5);
  }
}

/// Прямоугольный треугольник: прямой угол в левом нижнем углу при повороте
/// 0, дальше по часовой стрелке.
Path trianglePath(Size s, int rotation) {
  final w = s.width, h = s.height;
  final p = Path();
  switch (rotation % 4) {
    case 1:
      p
        ..moveTo(0, 0)
        ..lineTo(w, 0)
        ..lineTo(0, h);
      break;
    case 2:
      p
        ..moveTo(0, 0)
        ..lineTo(w, 0)
        ..lineTo(w, h);
      break;
    case 3:
      p
        ..moveTo(w, 0)
        ..lineTo(w, h)
        ..lineTo(0, h);
      break;
    default:
      p
        ..moveTo(0, 0)
        ..lineTo(0, h)
        ..lineTo(w, h);
  }
  return p..close();
}

class _TrianglePainter extends CustomPainter {
  final int rotation;
  final Color fill;
  final Color border;
  final double borderWidth;
  final BoxShadow? shadow;

  _TrianglePainter({
    required this.rotation,
    required this.fill,
    required this.border,
    required this.borderWidth,
    this.shadow,
  });

  @override
  void paint(Canvas canvas, Size size) {
    // Контур чуть внутри, чтобы рамка не обрезалась краем плитки.
    final inset = borderWidth / 2 + 1;
    final path = trianglePath(Size(size.width - inset * 2, size.height - inset * 2), rotation)
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

  @override
  bool shouldRepaint(_TrianglePainter old) =>
      old.rotation != rotation ||
      old.fill != fill ||
      old.border != border ||
      old.borderWidth != borderWidth ||
      old.shadow != shadow;
}

/// Подпись формы стола для редактора.
String tableShapeLabel(String shape) {
  switch (shape) {
    case 'circle':
      return 'Круглый';
    case 'long':
      return 'Длинный';
    case 'triangle':
      return 'Треугольный';
    default:
      return 'Квадратный';
  }
}
