import 'dart:math' as math;
import 'dart:ui' show PointMode;

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

  /// Показывать область, где стоят столы (см. hallContentRect), а не весь
  /// холст: столы крупнее, без пустых полей. Схему по-прежнему можно
  /// двигать и приближать. Редактору нужен весь холст — там выключено.
  final bool fitToTables;

  /// Плашка «Схему можно двигать и приближать» поверх схемы.
  final bool showHint;

  const HallPlanView({
    super.key,
    required this.tables,
    required this.tileBuilder,
    this.canvasKey,
    this.overlay,
    this.floorColor = AppColors.surface,
    this.lineColor = AppColors.border,
    this.fitToTables = false,
    this.showHint = true,
  });

  /// Самый мелкий масштаб схемы «по столам»: плитка ~52 px — название и
  /// таймер ещё читаются, нажать пальцем удобно. Столы, которым и так не
  /// хватило места, видно прокруткой схемы.
  static const double minFitScale = 0.5;

  /// Масштаб, в котором область столов [content] помещается в [viewport]
  /// (с полями [pad]): не мельче [minFitScale] и не крупнее 1.25.
  static double fitScale(Rect content, Size viewport, {double pad = 12}) {
    final w = math.max(1.0, viewport.width - pad * 2);
    final h = math.max(1.0, viewport.height - pad * 2);
    final fit = math.min(w / content.width, h / content.height);
    return fit.clamp(minFitScale, 1.25).toDouble();
  }

  /// Масштаб, при котором схему удобно нажимать пальцем: плитка ≥ ~64 px.
  static const double comfortableScale = 0.62;

  @override
  State<HallPlanView> createState() => _HallPlanViewState();
}

class _HallPlanViewState extends State<HallPlanView> {
  final _transform = TransformationController();
  double? _appliedFor;
  String? _fittedFor;

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
        painter: _FloorPainter(widget.floorColor, widget.lineColor, framed: widget.fitToTables),
        // Таймеры на плитках тикают каждую секунду — без границы
        // перерисовки вместе с ними перерисовывался бы и «пол» с сеткой.
        child: RepaintBoundary(
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
      ),
    );
  }

  /// Схема «по столам»: область столов по центру в удобном масштабе.
  Widget _fitted(BoxConstraints box) {
    const pad = 12.0;
    final viewport = Size(box.maxWidth, box.maxHeight);
    final content = hallContentRect(widget.tables);
    final scale = HallPlanView.fitScale(content, viewport, pad: pad);
    // Начальное положение ставим, только когда поменялся экран или
    // расстановка столов, — иначе каждое обновление стола сбрасывало бы
    // то, как сотрудник подвинул и приблизил схему.
    final key = '${viewport.width.round()}x${viewport.height.round()}|${content.left.round()},${content.top.round()},'
        '${content.width.round()},${content.height.round()}';
    if (_fittedFor != key) {
      _fittedFor = key;
      final cw = content.width * scale, ch = content.height * scale;
      // Помещается — по центру; не помещается — от левого верхнего угла.
      final dx = cw <= viewport.width - pad * 2 ? (viewport.width - cw) / 2 : pad;
      final dy = ch <= viewport.height - pad * 2 ? (viewport.height - ch) / 2 : pad;
      _transform.value = Matrix4.identity()
        ..translateByDouble(dx - content.left * scale, dy - content.top * scale, 0, 1)
        ..scaleByDouble(scale, scale, 1, 1);
    }
    final whole = math.min(viewport.width / kHallCanvas.width, viewport.height / kHallCanvas.height);
    return InteractiveViewer(
      transformationController: _transform,
      constrained: false,
      minScale: math.min(scale, whole) * 0.9,
      maxScale: 2.5,
      boundaryMargin: EdgeInsets.all(math.max(viewport.width, viewport.height)),
      child: _canvas(),
    );
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      if (widget.fitToTables) return _fitted(box);
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
          if (widget.showHint)
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
                        Flexible(
                          child: Text('Схему можно двигать и приближать',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                        ),
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

  /// Схема «по столам» уже в рамке экрана — своя граница холста внутри
  /// неё выглядела бы второй рамкой, рисуем только сетку.
  final bool framed;
  _FloorPainter(this.floor, this.line, {this.framed = false});

  @override
  void paint(Canvas canvas, Size size) {
    if (!framed) {
      final rect = RRect.fromRectAndRadius(Offset.zero & size, const Radius.circular(28));
      canvas.drawRRect(rect, Paint()..color = floor.withValues(alpha: 0.35));
      canvas.drawRRect(
        rect,
        Paint()
          ..color = line
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2,
      );
    }
    final dot = Paint()..color = line.withValues(alpha: 0.9);
    const step = 40.0;
    if (framed) {
      // Схема в рамке: сетка и за краями холста — при прокрутке и на
      // широком экране «пол» не обрывается. Одной командой, а не тысячами
      // кругов по одному.
      const extra = 1600.0;
      final points = <Offset>[
        for (var x = step - extra; x < size.width + extra; x += step)
          for (var y = step - extra; y < size.height + extra; y += step) Offset(x, y),
      ];
      canvas.drawPoints(
        PointMode.points,
        points,
        dot
          ..strokeWidth = 2.8
          ..strokeCap = StrokeCap.round,
      );
      return;
    }
    for (var x = step; x < size.width; x += step) {
      for (var y = step; y < size.height; y += step) {
        canvas.drawCircle(Offset(x, y), 1.4, dot);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _FloorPainter old) => old.floor != floor || old.line != line || old.framed != framed;
}
