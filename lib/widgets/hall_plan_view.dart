import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../models/table_model.dart';
import '../theme/app_colors.dart';
import '../utils/hall_layout.dart';

/// Схема зала на логическом холсте [kHallCanvas] (см. hall_layout.dart),
/// вписанная в доступное место.
///
/// На планшете и компьютере схема просто вписывается в экран. На телефоне
/// вписанная целиком она мелкая, поэтому там её можно двигать и
/// приближать пальцами (начальный масштаб — чтобы плитки было удобно
/// нажимать).
class HallPlanView extends StatefulWidget {
  final List<TableModel> tables;

  /// Плитка стола (размер — [kHallTile] на холсте).
  final Widget Function(TableModel table) tileBuilder;

  /// Ключ самого холста (без масштаба) — редактору, чтобы переводить
  /// координаты пальца в координаты холста.
  final GlobalKey? canvasKey;

  /// Необязательный слой поверх холста (например, цели перетаскивания).
  final Widget? overlay;

  /// Цвета «пола» — у приложения гостя своя палитра.
  final Color floorColor;
  final Color lineColor;

  const HallPlanView({
    super.key,
    required this.tables,
    required this.tileBuilder,
    this.canvasKey,
    this.overlay,
    this.floorColor = AppColors.surface,
    this.lineColor = AppColors.border,
  });

  /// Масштаб, при котором схему удобно нажимать пальцем: плитка ≥ ~64 px.
  static const double comfortableScale = 0.62;

  @override
  State<HallPlanView> createState() => _HallPlanViewState();
}

class _HallPlanViewState extends State<HallPlanView> {
  final _transform = TransformationController();
  double? _appliedFor;

  @override
  void dispose() {
    _transform.dispose();
    super.dispose();
  }

  Widget _canvas() {
    final sorted = [...widget.tables]..sort(compareTables);
    return SizedBox(
      key: widget.canvasKey,
      width: kHallCanvas.width,
      height: kHallCanvas.height,
      child: CustomPaint(
        painter: _FloorPainter(widget.floorColor, widget.lineColor),
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            for (final t in sorted)
              Positioned(
                key: ValueKey(t.id),
                left: hallTileOffset(t).left,
                top: hallTileOffset(t).top,
                child: widget.tileBuilder(t),
              ),
            if (widget.overlay != null) Positioned.fill(child: widget.overlay!),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      const pad = 12.0;
      final w = math.max(0.0, box.maxWidth - pad * 2);
      final h = math.max(0.0, box.maxHeight - pad * 2);
      final fit = math.min(w / kHallCanvas.width, h / kHallCanvas.height);
      if (fit >= HallPlanView.comfortableScale || fit <= 0) {
        return Center(
          child: SizedBox(
            width: kHallCanvas.width * fit,
            height: kHallCanvas.height * fit,
            child: FittedBox(child: _canvas()),
          ),
        );
      }
      // Узкий экран: схему можно двигать и приближать. Начальный масштаб —
      // удобный для пальца, схема прижата к левому верхнему углу.
      final start = math.min(HallPlanView.comfortableScale, math.max(fit, h / kHallCanvas.height));
      if (_appliedFor != box.maxWidth) {
        _appliedFor = box.maxWidth;
        _transform.value = Matrix4.identity()
          ..translateByDouble(pad, pad, 0, 1)
          ..scaleByDouble(start, start, 1, 1);
      }
      return Stack(
        children: [
          Positioned.fill(
            child: InteractiveViewer(
              transformationController: _transform,
              constrained: false,
              minScale: fit,
              maxScale: 2.5,
              boundaryMargin: const EdgeInsets.all(pad),
              child: _canvas(),
            ),
          ),
          const Positioned(
            left: 0,
            right: 0,
            bottom: 12,
            child: IgnorePointer(
              child: Center(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: Color(0xCC0C1424),
                    borderRadius: BorderRadius.all(Radius.circular(999)),
                  ),
                  child: Padding(
                    padding: EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(Icons.pinch_outlined, size: 16, color: AppColors.textMuted),
                      SizedBox(width: 6),
                      Text('Схему можно двигать и приближать',
                          style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                    ]),
                  ),
                ),
              ),
            ),
          ),
        ],
      );
    });
  }
}

/// «Пол» зала: скруглённая площадка с редкой сеткой точек — чтобы схема
/// читалась как помещение, а не как столы, висящие в пустоте.
class _FloorPainter extends CustomPainter {
  final Color floor;
  final Color line;
  _FloorPainter(this.floor, this.line);

  @override
  void paint(Canvas canvas, Size size) {
    final rect = RRect.fromRectAndRadius(Offset.zero & size, const Radius.circular(28));
    canvas.drawRRect(rect, Paint()..color = floor.withValues(alpha: 0.35));
    canvas.drawRRect(
      rect,
      Paint()
        ..color = line
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
    final dot = Paint()..color = line.withValues(alpha: 0.9);
    const step = 40.0;
    for (var x = step; x < size.width; x += step) {
      for (var y = step; y < size.height; y += step) {
        canvas.drawCircle(Offset(x, y), 1.4, dot);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _FloorPainter old) => old.floor != floor || old.line != line;
}
