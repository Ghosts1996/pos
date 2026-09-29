import 'dart:async';

import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/material.dart';

import '../../models/table_model.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/hall_layout.dart';
import '../../utils/table_label.dart';
import '../../widgets/hall_plan_view.dart';
import '../../widgets/table_shape.dart';
import '../../widgets/table_tile.dart';
import '../../utils/human_error.dart';

/// Редактор карты зала: зоны, расстановка столов перетаскиванием,
/// добавление, переименование и удаление.
///
/// Схема — та же, что видят сотрудники (логический холст, см.
/// hall_layout.dart): как расставили здесь, так и будет в зале на любом
/// телефоне или планшете.
class FloorPlanEditorScreen extends StatefulWidget {
  const FloorPlanEditorScreen({super.key});

  @override
  State<FloorPlanEditorScreen> createState() => _FloorPlanEditorScreenState();
}

class _FloorPlanEditorScreenState extends State<FloorPlanEditorScreen> {
  final _fs = FirestoreService();
  late final Stream<List<TableModel>> _stream = _fs.tablesStream();
  final _canvasKey = GlobalKey();
  final _viewportKey = GlobalKey();
  final _transform = TransformationController();

  /// Выбранный стол: под схемой — стрелки для точного сдвига, поворот и
  /// настройки. Перетаскивать пальцем на телефоне неточно.
  String? _selectedId;

  /// Стол, который сейчас тащат, где палец и куда стол встанет.
  TableModel? _dragging;
  Offset? _pointer;
  ({Rect rect, double x, double y, bool blocked})? _drop;

  /// Тащат мышью — стол держим под курсором; пальцем — чуть выше пальца,
  /// иначе палец закрывает и стол, и место, куда он встанет.
  bool _mouse = false;
  static const double _lift = 36;

  /// Прокрутка схемы, пока стол держат у края экрана.
  Timer? _panTimer;
  Offset _panSpeed = Offset.zero;

  @override
  void dispose() {
    _panTimer?.cancel();
    _transform.dispose();
    super.dispose();
  }

  List<TableModel> _tables = [];

  /// Зона, которую сейчас расставляем ('' — столы без зоны).
  String _zone = '';

  /// Только что перетащенный стол — показываем на новом месте сразу, не
  /// дожидаясь ответа базы (иначе плитка на миг прыгала обратно).
  final Map<String, ({double x, double y, int rotation})> _moved = {};

  List<TableModel> get _inZone => _tables.where((t) => t.zone == _zone).toList();

  /// Стол с учётом сдвигов, которые база ещё не подтвердила: две стрелки
  /// подряд должны сдвинуть стол на два шага, а не дважды на один.
  /// Панель под схемой могла получить стол до ответа базы — берём свежий
  /// из списка по id.
  TableModel _live(TableModel table) {
    final t = _tables.where((x) => x.id == table.id).firstOrNull ?? table;
    final m = _moved[t.id];
    return m == null ? t : t.copyWith(x: m.x, y: m.y, rotation: m.rotation);
  }

  /// Новый стол — в первую свободную ячейку сетки своей зоны, а не всегда
  /// в одну точку: иначе столы ложились друг на друга, и казалось, что
  /// «больше одного стола не добавить».
  ({double x, double y}) _nextFreePosition(String zone, Size size) {
    final taken = [
      for (final t in _tables.where((t) => t.zone == zone))
        Rect.fromLTWH(hallTileOffset(t).left, hallTileOffset(t).top, hallTileSize(t).width, hallTileSize(t).height)
            .inflate(12),
    ];
    const step = kHallTile / 2;
    for (var top = 16.0; top + size.height <= kHallCanvas.height; top += step) {
      for (var left = 16.0; left + size.width <= kHallCanvas.width; left += step) {
        final r = Rect.fromLTWH(left, top, size.width, size.height);
        if (!taken.any((o) => o.overlaps(r))) return hallFractionForTopLeft(left, top, size);
      }
    }
    return (x: 0.5, y: 0.5);
  }

  /// Кнопка «Повернуть» на плитке: четверть оборота по часовой, на месте.
  Future<void> _rotate(TableModel table) async {
    final t = _live(table);
    final r = hallRotated(t);
    // Стол, который уже наехал на соседа (старая расстановка), крутить можно.
    if (_collides(r) && !_collides(t)) {
      _snack('Повернуть не получится — мешает соседний стол');
      return;
    }
    setState(() => _moved[t.id] = (x: r.x, y: r.y, rotation: r.rotation));
    try {
      await _fs.updateTableLayout(t.id, rotation: r.rotation, x: r.x, y: r.y);
    } catch (e) {
      _snack('Не удалось повернуть стол: ${humanError(e, lower: true)}');
    }
  }

  String _suggestName() {
    final numbers = _tables
        .map((t) => RegExp(r'(\d+)\s*$').firstMatch(t.name)?.group(1))
        .whereType<String>()
        .map(int.parse)
        .toList();
    final next = numbers.isEmpty ? _tables.length + 1 : numbers.reduce((a, b) => a > b ? a : b) + 1;
    return 'Стол $next';
  }

  Future<void> _addTable() async {
    final result = await _showTableDialog();
    if (result == null) return;
    final pos = _nextFreePosition(
      result.zone,
      hallTileSize(TableModel(id: '', name: '', x: 0, y: 0, shape: result.shape, rotation: result.rotation)),
    );
    try {
      await _fs.addTable(TableModel(
        id: _fs.newTableId(),
        name: result.name,
        x: pos.x,
        y: pos.y,
        seats: result.seats,
        shape: result.shape,
        rotation: result.rotation,
        maxOpenSessions: result.maxOpenSessions,
        zone: result.zone,
      ));
      if (result.zone != _zone) setState(() => _zone = result.zone);
    } catch (e) {
      _snack('Не удалось добавить стол: ${humanError(e, lower: true)}');
    }
  }

  Future<void> _editTable(TableModel table) async {
    final result = await _showTableDialog(existing: table);
    if (result == null || !mounted) return;
    if (result.delete) {
      final confirm = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          scrollable: true,
          title: const Text('Удалить стол?'),
          content: Text('Стол «${table.name}» будет удалён без возможности отмены.'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Удалить'),
            ),
          ],
        ),
      );
      if (confirm != true) return;
      try {
        await _fs.deleteTableSafe(table.id);
      } on TableOccupiedDeleteException catch (e) {
        _snack(e.toString());
      } catch (e) {
        _snack('Не удалось удалить стол: ${humanError(e, lower: true)}');
      }
      return;
    }
    try {
      await _fs.updateTableSettings(
        table.id,
        name: result.name,
        seats: result.seats,
        shape: result.shape,
        rotation: result.rotation,
        maxOpenSessions: result.maxOpenSessions,
        zone: result.zone,
      );
      // Поменялась форма или поворот — у плитки другой размер. Центр
      // оставляем на месте, чтобы стол не «уехал» от соседних.
      final updated = table.copyWith(shape: result.shape, rotation: result.rotation);
      if (hallTileSize(table) != hallTileSize(updated) && mounted) {
        final f = hallRefit(table, updated);
        setState(() => _moved[table.id] = (x: f.x, y: f.y, rotation: f.rotation));
        await _fs.updateTablePosition(table.id, f.x, f.y);
      }
      if (result.zone != _zone) {
        _snack('«${result.name}» перенесён в зону «${result.zone.isEmpty ? kNoZoneLabel : result.zone}»');
      }
    } catch (e) {
      _snack('Не удалось сохранить стол: ${humanError(e, lower: true)}');
    }
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<_TableForm?> _showTableDialog({TableModel? existing}) async {
    final nameCtrl = TextEditingController(text: existing?.name ?? _suggestName());
    var seats = existing?.seats ?? 4;
    var shape = kTableShapes.contains(existing?.shape) ? existing!.shape : 'rect';
    var rotation = existing?.rotation ?? 0;
    var maxOpenSessions = existing?.maxOpenSessions ?? 2;
    final zoneCtrl = TextEditingController(text: existing?.zone ?? _zone);
    final zones = hallZones(_tables);
    String? error;

    final result = await showDialog<_TableForm>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSt) {
        Widget stepper(String label, int value, int min, int max, ValueChanged<int> onChanged) => Row(
              children: [
                Expanded(child: Text(label)),
                IconButton(
                  tooltip: 'Меньше',
                  icon: const Icon(Icons.remove_circle_outline),
                  onPressed: value > min ? () => setSt(() => onChanged(value - 1)) : null,
                ),
                SizedBox(
                  width: 32,
                  child: Text('$value',
                      textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 17)),
                ),
                IconButton(
                  tooltip: 'Больше',
                  icon: const Icon(Icons.add_circle_outline),
                  onPressed: value < max ? () => setSt(() => onChanged(value + 1)) : null,
                ),
              ],
            );
        return AlertDialog(
          title: Text(existing == null ? 'Новый стол' : 'Стол «${existing.name}»'),
          content: SizedBox(
            width: 380,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  TextField(
                    controller: nameCtrl,
                    autofocus: existing == null,
                    decoration: InputDecoration(labelText: 'Название', errorText: error),
                  ),
                  const SizedBox(height: 8),
                  stepper('Мест за столом', seats, 1, 99, (v) => seats = v),
                  stepper('Чеков одновременно', maxOpenSessions, 1, 6, (v) => maxOpenSessions = v),
                  const Padding(
                    padding: EdgeInsets.only(bottom: 8),
                    child: Text('Несколько чеков — когда компания платит раздельно.',
                        style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                  ),
                  const Text('Форма', style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
                  const SizedBox(height: 6),
                  Wrap(spacing: 6, runSpacing: 6, children: [
                    for (final s in kTableShapes)
                      ChoiceChip(
                        avatar: Icon(_shapeIcon(s), size: 18),
                        label: Text(tableShapeLabel(s)),
                        selected: shape == s,
                        onSelected: (_) => setSt(() => shape = s),
                      ),
                  ]),
                  if (tableShapeRotates(shape)) ...[
                    const SizedBox(height: 10),
                    Row(children: [
                      _ShapePreview(shape: shape, rotation: rotation),
                      const SizedBox(width: 12),
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: () => setSt(() => rotation = (rotation + 1) % 4),
                          icon: const Icon(Icons.rotate_right),
                          label: const Text('Повернуть'),
                        ),
                      ),
                    ]),
                    const Padding(
                      padding: EdgeInsets.only(top: 6),
                      child: Text(
                          'Повернуть можно и прямо на схеме кнопкой ⟳. Ставьте столы вплотную — '
                          'из длинных и угловых собираются столы буквой Г и П.',
                          style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                    ),
                  ],
                  const SizedBox(height: 16),
                  TextField(
                    controller: zoneCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Зона (необязательно)',
                      hintText: 'Например, Терраса или VIP',
                    ),
                    onChanged: (_) => setSt(() {}),
                  ),
                  if (zones.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(spacing: 6, runSpacing: 6, children: [
                      for (final z in zones)
                        ChoiceChip(
                          label: Text(z),
                          selected: zoneCtrl.text.trim() == z,
                          onSelected: (_) => setSt(() => zoneCtrl.text = z),
                        ),
                      ChoiceChip(
                        label: const Text(kNoZoneLabel),
                        selected: zoneCtrl.text.trim().isEmpty,
                        onSelected: (_) => setSt(() => zoneCtrl.clear()),
                      ),
                    ]),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            if (existing != null)
              TextButton(
                onPressed: () => Navigator.pop(ctx, const _TableForm.delete()),
                child: const Text('Удалить', style: TextStyle(color: AppColors.danger)),
              ),
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
            FilledButton(
              onPressed: () {
                final name = nameCtrl.text.trim();
                if (name.isEmpty) {
                  setSt(() => error = 'Введите название');
                  return;
                }
                final clash = _tables.any((t) => t.id != existing?.id && t.name.trim().toLowerCase() == name.toLowerCase());
                if (clash) {
                  setSt(() => error = 'Стол с таким названием уже есть');
                  return;
                }
                Navigator.pop(
                  ctx,
                  _TableForm(
                    name: name,
                    seats: seats,
                    shape: shape,
                    rotation: tableShapeRotates(shape) ? rotation : 0,
                    maxOpenSessions: maxOpenSessions,
                    zone: zoneCtrl.text.trim(),
                  ),
                );
              },
              child: const Text('Сохранить'),
            ),
          ],
        );
      }),
    );
    nameCtrl.dispose();
    zoneCtrl.dispose();
    return result;
  }

  RenderBox? get _canvasBox => _canvasKey.currentContext?.findRenderObject() as RenderBox?;

  /// Сколько экранных точек в точке холста сейчас (схему приближают).
  double _canvasScale() {
    final box = _canvasBox;
    if (box == null || !box.hasSize) return 1;
    return (box.localToGlobal(Offset(kHallCanvas.width, 0)) - box.localToGlobal(Offset.zero)).dx / kHallCanvas.width;
  }

  /// Стол наезжает на другой стол своей зоны.
  bool _collides(TableModel moved) =>
      _tables.any((o) => o.id != moved.id && o.zone == moved.zone && hallTablesOverlap(moved, o));

  void _dragStarted(TableModel t) {
    setState(() {
      _dragging = t;
      _selectedId = null;
      _drop = null;
    });
    _panTimer ??= Timer.periodic(const Duration(milliseconds: 16), (_) => _autoPan());
  }

  void _dragUpdated(Offset globalPointer) {
    _pointer = globalPointer;
    _updateDrop();
    _updatePanSpeed();
  }

  /// Куда встанет стол, если отпустить сейчас: с привязкой к сетке, как
  /// при сохранении. Сам стол рисуется прямо там, на схеме, в зелёной рамке
  /// (красная — место занято): отдельная плитка «в руке» закрывала бы это
  /// место. Пальцем стол держим чуть выше пальца, чтобы его было видно.
  void _updateDrop() {
    final t = _dragging, p = _pointer, box = _canvasBox;
    if (t == null || p == null || box == null) return;
    final scale = _canvasScale();
    final size = hallTileSize(t);
    final centre = box.globalToLocal(_mouse ? p : p - Offset(0, _lift + size.height * scale / 2));
    final f = hallFractionForTopLeft(centre.dx - size.width / 2, centre.dy - size.height / 2, size);
    final moved = t.copyWith(x: f.x, y: f.y);
    final o = hallTileOffset(moved);
    final rect = Rect.fromLTWH(o.left, o.top, size.width, size.height);
    final blocked = _collides(moved);
    if (_drop?.rect != rect || _drop?.blocked != blocked) {
      setState(() => _drop = (rect: rect, x: f.x, y: f.y, blocked: blocked));
    }
  }

  /// Палец у края видимой части схемы — прокручиваем туда. Только когда
  /// схема не помещается целиком (телефон); чем ближе к краю, тем быстрее.
  void _updatePanSpeed() {
    final view = _viewportKey.currentContext?.findRenderObject() as RenderBox?;
    final p = _pointer;
    if (view == null || p == null || !view.hasSize) return;
    final local = view.globalToLocal(p);
    const edge = 56.0, maxStep = 14.0;
    double axis(double pos, double len) {
      if (pos < edge) return -maxStep * (1 - pos.clamp(0.0, edge) / edge);
      if (pos > len - edge) return maxStep * (1 - (len - pos).clamp(0.0, edge) / edge);
      return 0;
    }

    _panSpeed = Offset(axis(local.dx, view.size.width), axis(local.dy, view.size.height));
  }

  void _autoPan() {
    if (_dragging == null || _panSpeed == Offset.zero) return;
    final view = _viewportKey.currentContext?.findRenderObject() as RenderBox?;
    if (view == null || !view.hasSize) return;
    // Масштаб — фактический: на планшете схема вписана целиком без
    // прокрутки, и тогда крутить нечего.
    final scale = _canvasScale();
    final t = _transform.value.getTranslation();
    const pad = 12.0;
    double shift(double current, double speed, double canvas, double viewLen) {
      final w = canvas * scale;
      if (w <= viewLen - pad * 2) return current; // помещается — крутить некуда
      return (current - speed).clamp(viewLen - pad - w, pad).toDouble();
    }

    final nx = shift(t.x, _panSpeed.dx, kHallCanvas.width, view.size.width);
    final ny = shift(t.y, _panSpeed.dy, kHallCanvas.height, view.size.height);
    if (nx == t.x && ny == t.y) return;
    _transform.value = Matrix4.identity()
      ..translateByDouble(nx, ny, 0, 1)
      ..scaleByDouble(scale, scale, 1, 1);
    _updateDrop();
  }

  void _dragEnded() {
    final t = _dragging, drop = _drop;
    _panTimer?.cancel();
    _panTimer = null;
    _panSpeed = Offset.zero;
    setState(() {
      _dragging = null;
      _drop = null;
      _pointer = null;
    });
    if (t == null || drop == null) return;
    if (drop.blocked) {
      _snack('Здесь уже стоит другой стол — поставьте на свободное место');
      return;
    }
    _place(t, drop.x, drop.y);
  }

  void _place(TableModel t, double x, double y) {
    setState(() => _moved[t.id] = (x: x, y: y, rotation: t.rotation));
    _fs.updateTablePosition(t.id, x, y).catchError((e) => _snack('Не удалось переставить стол: ${humanError(e, lower: true)}'));
  }

  /// Стрелки под схемой: сдвиг выбранного стола на шаг сетки.
  void _nudge(TableModel table, double dx, double dy) {
    final t = _live(table);
    final o = hallTileOffset(t);
    final size = hallTileSize(t);
    final f = hallFractionForTopLeft(o.left + dx * kHallGridStep, o.top + dy * kHallGridStep, size);
    if ((f.x - t.x).abs() < 1e-6 && (f.y - t.y).abs() < 1e-6) {
      _snack('Дальше край схемы');
      return;
    }
    final moved = t.copyWith(x: f.x, y: f.y);
    if (_collides(moved) && !_collides(t)) {
      _snack('Там другой стол');
      return;
    }
    _place(t, f.x, f.y);
  }

  /// Рамки поверх схемы: выбранный стол и место, куда встанет перетаскиваемый.
  Widget _overlay() {
    Widget frame(TableModel t, Rect r, Color color, {double fillAlpha = 0.18}) => Positioned(
          left: r.left,
          top: r.top,
          child: TableShapeBox(
            table: t,
            size: r.size,
            fill: color.withValues(alpha: fillAlpha),
            borderColor: color,
            borderWidth: 3,
            child: const SizedBox.shrink(),
          ),
        );
    final selected = _selectedId == null ? null : _inZone.where((t) => t.id == _selectedId).firstOrNull;
    final dragging = _dragging, drop = _drop;
    return IgnorePointer(
      child: Stack(clipBehavior: Clip.none, children: [
        if (selected != null && dragging == null)
          frame(
            selected,
            Rect.fromLTWH(hallTileOffset(selected).left, hallTileOffset(selected).top, hallTileSize(selected).width,
                    hallTileSize(selected).height)
                .inflate(6),
            AppColors.primary,
            fillAlpha: 0,
          ),
        if (dragging != null && drop != null) ...[
          frame(dragging, drop.rect.inflate(5), drop.blocked ? AppColors.danger : AppColors.success, fillAlpha: 0.22),
          Positioned(
            left: drop.rect.left,
            top: drop.rect.top,
            child: Opacity(
              opacity: 0.92,
              child: TableTile(table: dragging.copyWith(x: drop.x, y: drop.y), editorMode: true),
            ),
          ),
        ],
      ]),
    );
  }

  /// Панель выбранного стола: стрелки, поворот, настройки.
  Widget _selectionBar(TableModel t) {
    Widget arrow(IconData icon, String tip, double dx, double dy) => IconButton.filledTonal(
          tooltip: tip,
          icon: Icon(icon),
          onPressed: () => _nudge(t, dx, dy),
        );
    return Material(
      color: AppColors.surfaceElevated,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Row(children: [
              Expanded(
                child: Text('${t.name} · ${seatsLabel(t.seats)}',
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
              ),
              TextButton.icon(
                onPressed: () => _editTable(t),
                icon: const Icon(Icons.edit_outlined, size: 18),
                label: const Text('Изменить'),
              ),
              IconButton(
                tooltip: 'Готово',
                icon: const Icon(Icons.close),
                onPressed: () => setState(() => _selectedId = null),
              ),
            ]),
            Wrap(spacing: 6, runSpacing: 6, alignment: WrapAlignment.center, children: [
              arrow(Icons.arrow_back, 'Влево', -1, 0),
              arrow(Icons.arrow_upward, 'Вверх', 0, -1),
              arrow(Icons.arrow_downward, 'Вниз', 0, 1),
              arrow(Icons.arrow_forward, 'Вправо', 1, 0),
              if (tableShapeRotates(t.shape))
                IconButton.filledTonal(tooltip: 'Повернуть', icon: const Icon(Icons.rotate_right), onPressed: () => _rotate(t)),
            ]),
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final selected = _selectedId == null ? null : _tables.where((t) => t.id == _selectedId).firstOrNull;
    return Scaffold(
      appBar: AppBar(title: const Text('Карта зала')),
      floatingActionButton: selected != null
          ? null
          : FloatingActionButton.extended(
              onPressed: _addTable,
              icon: const Icon(Icons.add),
              label: const Text('Стол'),
            ),
      bottomNavigationBar: selected != null && selected.zone == _zone ? _selectionBar(selected) : null,
      body: StreamBuilder<List<TableModel>>(
        stream: _stream,
        builder: (context, snap) {
          if (snap.hasError) {
            return const Center(child: Text('Не удалось загрузить столы — проверьте интернет'));
          }
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          _tables = snap.data!.map((t) {
            final m = _moved[t.id];
            if (m == null) return t;
            // База догнала — локальная поправка больше не нужна.
            if ((t.x - m.x).abs() < 0.001 && (t.y - m.y).abs() < 0.001 && t.rotation == m.rotation) {
              _moved.remove(t.id);
              return t;
            }
            return t.copyWith(x: m.x, y: m.y, rotation: m.rotation);
          }).toList();
          final zones = hallZones(_tables);
          final hasNoZone = _tables.any((t) => t.zone.isEmpty);
          final zoneKeys = [...zones, if (hasNoZone || zones.isEmpty) ''];
          if (!zoneKeys.contains(_zone)) _zone = zoneKeys.first;
          final narrow = MediaQuery.sizeOf(context).width < 600;

          return Column(
            children: [
              if (zones.isNotEmpty)
                SizedBox(
                  height: 50,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                    children: [
                      for (final z in zoneKeys)
                        Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: ChoiceChip(
                            label: Text('${z.isEmpty ? kNoZoneLabel : z} · ${_tables.where((t) => t.zone == z).length}'),
                            selected: _zone == z,
                            onSelected: (_) => setState(() {
                              _zone = z;
                              _selectedId = null;
                            }),
                          ),
                        ),
                    ],
                  ),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: Row(children: [
                  const Icon(Icons.pan_tool_alt_outlined, size: 16, color: AppColors.textMuted),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      _tables.isEmpty
                          ? 'Добавьте первый стол кнопкой «Стол» внизу.'
                          : 'Нажмите на стол — появятся стрелки, поворот и настройки. '
                              '${narrow ? 'Или удерживайте' : 'Или перетащите'} его: зелёная рамка покажет, куда он встанет. '
                              'Зоны (терраса, 2 этаж) задаются в настройках стола.',
                      style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted),
                    ),
                  ),
                ]),
              ),
              Expanded(
                child: Listener(
                  onPointerDown: (e) => _mouse = e.kind == PointerDeviceKind.mouse,
                  child: KeyedSubtree(
                    key: _viewportKey,
                    child: HallPlanView(
                      canvasKey: _canvasKey,
                      tables: _inZone,
                      transformationController: _transform,
                      frameKey: _zone,
                      fitWidth: true,
                      overlay: _overlay(),
                      tileBuilder: (t) {
                        final tile = TableTile(
                          table: t,
                          editorMode: true,
                          onTap: () => setState(() => _selectedId = _selectedId == t.id ? null : t.id),
                          onRotate: () => _rotate(t),
                        );
                        final ghost = Opacity(opacity: 0.3, child: TableTile(table: t, editorMode: true));
                        // На узком экране схему двигают пальцем, поэтому стол
                        // берётся долгим нажатием; на планшете — сразу.
                        return narrow
                            ? LongPressDraggable<String>(
                                data: t.id,
                                dragAnchorStrategy: pointerDragAnchorStrategy,
                                feedback: const SizedBox.shrink(),
                                childWhenDragging: ghost,
                                onDragStarted: () => _dragStarted(t),
                                onDragUpdate: (d) => _dragUpdated(d.globalPosition),
                                onDragEnd: (_) => _dragEnded(),
                                child: tile,
                              )
                            : Draggable<String>(
                                data: t.id,
                                dragAnchorStrategy: pointerDragAnchorStrategy,
                                feedback: const SizedBox.shrink(),
                                childWhenDragging: ghost,
                                onDragStarted: () => _dragStarted(t),
                                onDragUpdate: (d) => _dragUpdated(d.globalPosition),
                                onDragEnd: (_) => _dragEnded(),
                                child: tile,
                              );
                      },
                    ),
                  ),
                ),
              ),
              if (_inZone.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 96, 16),
                  child: Text(
                    '${_inZone.length} ${pluralRu(_inZone.length, 'стол', 'стола', 'столов')} · '
                    '${seatsLabel(_inZone.fold<int>(0, (a, t) => a + t.seats))}',
                    style: const TextStyle(color: AppColors.textMuted, fontSize: 12.5),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

IconData _shapeIcon(String shape) {
  switch (shape) {
    case 'circle':
      return Icons.circle_outlined;
    case 'long':
      return Icons.crop_16_9;
    case 'oval':
      return Icons.panorama_wide_angle_outlined;
    case 'corner':
      return Icons.rounded_corner;
    case 'bar':
      return Icons.local_bar_outlined;
    default:
      return Icons.crop_square_rounded;
  }
}

/// Маленький образец формы в диалоге — видно, куда смотрит стол после
/// поворота.
class _ShapePreview extends StatelessWidget {
  final String shape;
  final int rotation;
  const _ShapePreview({required this.shape, required this.rotation});

  @override
  Widget build(BuildContext context) {
    final t = TableModel(id: '', name: '', x: 0, y: 0, shape: shape, rotation: rotation);
    final cell = (72 / tableShapeCells(shape)).clamp(0.0, 36.0);
    final s = hallTileSize(t) * (cell / kHallTile);
    return SizedBox(
      width: 72,
      height: 72,
      child: Center(
        child: TableShapeBox(
          table: t,
          size: s,
          fill: AppColors.surface,
          borderColor: AppColors.textMuted,
          cornerRadius: 6,
          child: const SizedBox.shrink(),
        ),
      ),
    );
  }
}

class _TableForm {
  final String name;
  final int seats;
  final String shape;
  final int rotation;
  final int maxOpenSessions;
  final String zone;
  final bool delete;

  const _TableForm({
    required this.name,
    required this.seats,
    required this.shape,
    required this.rotation,
    required this.maxOpenSessions,
    required this.zone,
  }) : delete = false;

  const _TableForm.delete()
      : name = '',
        seats = 0,
        shape = '',
        rotation = 0,
        maxOpenSessions = 0,
        zone = '',
        delete = true;
}
