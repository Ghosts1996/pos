import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../models/table_model.dart';

/// Контур стола нужной формы: квадрат, круг, длинный, овальный,
/// прямоугольный треугольник или барная стойка — общий для схемы зала на
/// кассе, редактора администратора, выбора стола при брони и карты в
/// приложении гостя.
/// [child] — подписи стола; у треугольника они стоят у прямого угла и
/// уменьшаются ровно настолько, чтобы не вылезти за наклонную сторону.
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
          size: size,
          fill: fill,
          border: borderColor,
          borderWidth: borderWidth,
          shadow: shadows.isEmpty ? null : shadows.first,
        ),
        child: SizedBox(
          width: size.width,
          height: size.height,
          child: _TriangleContent(rotation: table.rotation, child: child),
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

/// Угол плитки напротив прямого угла треугольника — там пусто, туда
/// удобно поставить кнопку. Для остальных форм — правый верхний.
Alignment tableFreeCorner(TableModel t) {
  if (t.shape != 'triangle') return Alignment.topRight;
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

class _TrianglePainter extends CustomPainter {
  final int rotation;
  final Size size;
  final Color fill;
  final Color border;
  final double borderWidth;
  final BoxShadow? shadow;

  _TrianglePainter({
    required this.rotation,
    required this.size,
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

  /// Нажатие считается только внутри треугольника: пустая половина плитки
  /// не перехватывает касания у соседнего стола.
  @override
  bool? hitTest(Offset position) => trianglePath(size, rotation).contains(position);

  @override
  bool shouldRepaint(_TrianglePainter old) =>
      old.rotation != rotation ||
      old.size != size ||
      old.fill != fill ||
      old.border != border ||
      old.borderWidth != borderWidth ||
      old.shadow != shadow;
}

/// Подписи треугольного стола: у прямого угла, в прямоугольнике, который
/// целиком помещается внутри треугольника (уменьшаем, только если нужно).
class _TriangleContent extends SingleChildRenderObjectWidget {
  final int rotation;
  const _TriangleContent({required this.rotation, super.child});

  @override
  RenderObject createRenderObject(BuildContext context) => _RenderTriangleContent(rotation);

  @override
  void updateRenderObject(BuildContext context, _RenderTriangleContent renderObject) {
    renderObject.rotation = rotation;
  }
}

class _RenderTriangleContent extends RenderProxyBox {
  _RenderTriangleContent(this._rotation);

  int _rotation;
  set rotation(int v) {
    if (v == _rotation) return;
    _rotation = v;
    markNeedsLayout();
  }

  double _scale = 1;
  Offset _offset = Offset.zero;

  /// Отступ подписи от катетов.
  static const double _inset = 7;

  @override
  Size computeDryLayout(BoxConstraints constraints) => constraints.biggest;

  @override
  void performLayout() {
    size = constraints.biggest;
    final c = child;
    if (c == null) return;
    c.layout(BoxConstraints.loose(size), parentUsesSize: true);
    final cs = c.size;
    // Прямоугольник w×h у прямого угла лежит внутри треугольника, пока
    // w/W + h/H ≤ 1 (доли катетов). Катеты берём с запасом на отступы.
    final legW = math.max(1.0, size.width - _inset * 3);
    final legH = math.max(1.0, size.height - _inset * 3);
    final k = cs.width / legW + cs.height / legH;
    _scale = k <= 1 ? 1 : 1 / k;
    final w = cs.width * _scale, h = cs.height * _scale;
    switch (_rotation % 4) {
      case 1:
        _offset = const Offset(_inset, _inset);
        break;
      case 2:
        _offset = Offset(size.width - _inset - w, _inset);
        break;
      case 3:
        _offset = Offset(size.width - _inset - w, size.height - _inset - h);
        break;
      default:
        _offset = Offset(_inset, size.height - _inset - h);
    }
  }

  Matrix4 get _transform =>
      Matrix4.translationValues(_offset.dx, _offset.dy, 0)..scaleByDouble(_scale, _scale, 1, 1);

  @override
  void paint(PaintingContext context, Offset offset) {
    final c = child;
    if (c == null) return;
    layer = context.pushTransform(
      needsCompositing,
      offset,
      _transform,
      (ctx, o) => ctx.paintChild(c, o),
      oldLayer: layer is TransformLayer ? layer as TransformLayer : null,
    );
  }

  @override
  void applyPaintTransform(RenderBox child, Matrix4 transform) => transform.multiply(_transform);

  /// Подписи не нажимаются — касание обрабатывает сам стол.
  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) => false;
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
    case 'triangle':
      return 'Треугольный';
    case 'bar':
      return 'Барная стойка';
    default:
      return 'Квадратный';
  }
}
