import 'dart:math' as math;
import 'dart:ui' show PointMode;

import 'package:flutter/material.dart';

import '../models/hall_label.dart';
import '../models/hall_wall.dart';
import '../models/table_model.dart';
import '../theme/app_colors.dart';
import '../utils/hall_layout.dart';
import 'hall_walls_painter.dart';

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

  /// Стены зоны (см. HallWall) — рисуются под столами.
  final List<HallWall> walls;

  /// Подписи зоны («Вход», «Кухня», заметки) — см. HallLabel.
  final List<HallLabel> labels;

  /// Цвет контура стен.
  final Color wallColor;

  /// Выбранная в редакторе стена или подпись — цветом [AppColors.primary].
  final String? highlightedWallId;

  /// Схему двигают одним пальцем. В редакторе при рисовании стен палец
  /// рисует, а схему двигают и приближают двумя.
  final bool panEnabled;

  /// Показывать область, где стоят столы (см. hallContentRect), а не весь
  /// холст: столы крупнее, без пустых полей. Схему по-прежнему можно
  /// двигать и приближать. Редактору нужен весь холст — там выключено.
  final bool fitToTables;

  /// Плашка «Схему можно двигать и приближать» поверх схемы.
  final bool showHint;

  /// Масштаб и сдвиг схемы — редактору, чтобы прокручивать её, пока стол
  /// тащат к краю экрана. Без него у схемы свой.
  final TransformationController? transformationController;

  /// Сменился — схема заново показывает, где стоят столы (например, при
  /// переключении зоны), а не остаётся там, куда её сдвинули.
  final Object? frameKey;

  /// Телефон: сразу видны все столы по ширине (если плитки при этом не
  /// мельче схемы целиком), а не удобный для пальца масштаб с обрезанным
  /// краем. Редактору важнее видеть, куда ставить.
  final bool fitWidth;

  const HallPlanView({
    super.key,
    required this.tables,
    required this.tileBuilder,
    this.canvasKey,
    this.overlay,
    this.floorColor = AppColors.surface,
    this.lineColor = AppColors.border,
    this.walls = const [],
    this.labels = const [],
    this.wallColor = HallPlanView.kHallWallColor,
    this.highlightedWallId,
    this.panEnabled = true,
    this.fitToTables = false,
    this.showHint = true,
    this.transformationController,
    this.frameKey,
    this.fitWidth = false,
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

  /// Цвет стен на кассе: тёплый светлый камень на тёмном полу.
  static const Color kHallWallColor = Color(0xFFD8CFC2);

  @override
  State<HallPlanView> createState() => _HallPlanViewState();
}

class _HallPlanViewState extends State<HallPlanView> {
  final _own = TransformationController();
  TransformationController get _transform => widget.transformationController ?? _own;
  String? _appliedFor;
  String? _fittedFor;

  @override
  void dispose() {
    _own.dispose();
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
        // Стены — под столами, на одном слое с полом.
        child: CustomPaint(
          painter: HallWallsPainter(
            walls: widget.walls,
            labels: widget.labels,
            line: widget.wallColor,
            floor: widget.floorColor,
            highlighted: {if (widget.highlightedWallId != null) widget.highlightedWallId!},
            highlightColor: AppColors.primary,
          ),
          // Таймеры на плитках тикают каждую секунду — без границы
          // перерисовки вместе с ними перерисовывались бы и «пол» с сеткой,
          // и стены.
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
      ),
    );
  }

  /// Часть холста со столами, стенами и подписями.
  Rect _content() => hallContentRect(widget.tables, extra: [
        ...hallWallBounds(widget.walls),
        for (final l in widget.labels)
          if (l.isValid) HallWallsPainter.labelRect(l),
      ]);

  /// Схема «по столам»: область столов по центру в удобном масштабе.
  Widget _fitted(BoxConstraints box) {
    const pad = 8.0;
    final viewport = Size(box.maxWidth, box.maxHeight);
    final content = _content();
    final start = HallPlanView.fitScale(content, viewport, pad: pad);
    // Отдалить можно до всех столов на экране, если в удобном масштабе
    // они не поместились.
    final whole = math.min((viewport.width - pad * 2) / content.width, (viewport.height - pad * 2) / content.height);
    return _zoomable(
      viewport: viewport,
      area: content,
      focus: content,
      minScale: math.min(start, whole),
      start: start,
      pad: pad,
      // Начальное положение ставим, только когда поменялся экран или
      // расстановка столов, — иначе каждое обновление стола сбрасывало бы
      // то, как сотрудник подвинул и приблизил схему.
      fitKey: '${viewport.width.round()}x${viewport.height.round()}|${content.left.round()},${content.top.round()},'
          '${content.width.round()},${content.height.round()}|${widget.frameKey}',
    );
  }

  /// Схема, которую двигают и приближают пальцами, без «прыжков».
  ///
  /// InteractiveViewer не даёт уйти за край своего содержимого, а если
  /// содержимое меньше экрана — прижимает его к левому верхнему углу: при
  /// отдалении схема скакала в угол и обратно. Поэтому под схемой лежит
  /// поле ровно в экран при самом мелком масштабе [minScale], а [area]
  /// (столы или весь холст) — по его центру: отдалили до конца — схема
  /// по центру экрана, приблизили — двигается в пределах поля.
  Widget _zoomable({
    required Size viewport,
    required Rect area,
    required Rect focus,
    required double minScale,
    required double start,
    required double pad,
    required String fitKey,
  }) {
    if (!(viewport.width > 0 && viewport.height > 0) || !viewport.isFinite) return const SizedBox.shrink();
    final low = math.max(0.05, math.min(minScale, start));
    final w = math.max(viewport.width / low, area.width);
    final h = math.max(viewport.height / low, area.height);
    final ox = (w - area.width) / 2 - area.left;
    final oy = (h - area.height) / 2 - area.top;
    if (_fittedFor != fitKey) {
      _fittedFor = fitKey;
      // Поле крупнее экрана — показываем [focus]: целиком по центру, а не
      // помещается — от его левого верхнего угла.
      double place(double field, double view, double focusStart, double focusSize) {
        final size = field * start;
        if (size <= view + 0.5) return (view - size) / 2;
        final f = focusSize * start;
        final want = f <= view - pad * 2 ? (view - f) / 2 - focusStart * start : pad - focusStart * start;
        return want.clamp(view - size, 0.0).toDouble();
      }

      _transform.value = Matrix4.identity()
        ..translateByDouble(place(w, viewport.width, focus.left + ox, focus.width),
            place(h, viewport.height, focus.top + oy, focus.height), 0, 1)
        ..scaleByDouble(start, start, 1, 1);
    }
    return InteractiveViewer(
      transformationController: _transform,
      constrained: false,
      minScale: low,
      maxScale: math.max(2.5, start * 2),
      panEnabled: widget.panEnabled,
      boundaryMargin: EdgeInsets.zero,
      child: SizedBox(
        width: w,
        height: h,
        child: Stack(clipBehavior: Clip.hardEdge, children: [
          Positioned(left: ox, top: oy, child: _canvas()),
        ]),
      ),
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
      // удобный для пальца; видно угол, где начинаются столы, а не пустой
      // левый верхний угол холста.
      final content = _content();
      final start = widget.fitWidth
          ? math.max(fit, math.min(HallPlanView.comfortableScale, math.min(w / content.width, h / content.height)))
          : math.min(HallPlanView.comfortableScale, math.max(fit, h / kHallCanvas.height));
      final Widget viewer;
      if (widget.transformationController == null) {
        viewer = _zoomable(
          viewport: Size(box.maxWidth, box.maxHeight),
          area: Offset.zero & kHallCanvas,
          focus: content,
          minScale: fit,
          start: start,
          pad: pad,
          fitKey: '${box.maxWidth.round()}x${box.maxHeight.round()}|${widget.frameKey}',
        );
      } else {
        viewer = _editorViewer(box, content, fit, start, pad);
      }
      return Stack(
        children: [
          Positioned.fill(child: viewer),
          if (widget.showHint)
            const Positioned(
              left: 0,
              right: 0,
              bottom: 12,
              child: IgnorePointer(
                child: Center(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: Color(0xCC1E1A16),
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

  /// Редактор зала: холст в начале координат — его автопрокрутка у края
  /// экрана (floor_plan_editor_screen.dart) считает сдвиг от холста.
  Widget _editorViewer(BoxConstraints box, Rect content, double fit, double start, double pad) {
    final applyKey = '${box.maxWidth}|${widget.frameKey}';
    if (_appliedFor != applyKey) {
      _appliedFor = applyKey;
      double place(double from, double canvas, double view) =>
          (pad - from * start).clamp(math.min(pad, view - pad - canvas * start), pad).toDouble();
      _transform.value = Matrix4.identity()
        ..translateByDouble(place(content.left, kHallCanvas.width, box.maxWidth),
            place(content.top, kHallCanvas.height, box.maxHeight), 0, 1)
        ..scaleByDouble(start, start, 1, 1);
    }
    return InteractiveViewer(
      transformationController: _transform,
      constrained: false,
      minScale: fit,
      maxScale: 2.5,
      panEnabled: widget.panEnabled,
      boundaryMargin: EdgeInsets.all(pad),
      child: _canvas(),
    );
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
