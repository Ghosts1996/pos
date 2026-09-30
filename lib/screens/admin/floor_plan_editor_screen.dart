import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/gestures.dart' show PointerDeviceKind, PointerHoverEvent;
import 'package:flutter/material.dart';

import '../../models/hall_label.dart';
import '../../models/hall_wall.dart';
import '../../models/table_model.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/hall_layout.dart';
import '../../utils/table_label.dart';
import '../../widgets/hall_plan_view.dart';
import '../../widgets/hall_walls_painter.dart';
import '../../widgets/table_shape.dart';
import '../../widgets/table_tile.dart';
import '../../utils/human_error.dart';

/// Редактор карты зала: зоны, расстановка столов перетаскиванием,
/// добавление, переименование и удаление, стены помещения.
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

  /// Где коснулись схемы (экранные координаты) и в какой точке стола его
  /// взяли (координаты холста): стол едет за пальцем, оставаясь под ним
  /// той же точкой, а не прыгает.
  Offset? _downAt;
  Offset _grab = Offset.zero;

  /// Прокрутка схемы, пока стол держат у края экрана.
  Timer? _panTimer;
  Offset _panSpeed = Offset.zero;

  /// Стены всех зон (см. HallWall).
  List<HallWall> _walls = [];
  StreamSubscription<List<HallWall>>? _wallsSub;

  /// Подписи всех зон (см. HallLabel).
  List<HallLabel> _labels = [];
  StreamSubscription<List<HallLabel>>? _labelsSub;

  /// Что делает палец в режиме рисования: стены или подписи.
  _DrawTool _tool = _DrawTool.wall;

  /// Подпись, которую тащат, и где она сейчас (на холсте).
  String? _dragLabelId;
  Offset? _dragLabelAt;

  // ---- Рисование стен ----
  /// Режим «Стены»: палец рисует стены, столы не трогаются.
  bool _wallMode = false;

  /// Углы стены, которую сейчас рисуют (ещё не сохранена).
  List<Offset> _draft = [];

  /// Куда встанет следующий угол: палец ведут по схеме или мышь над ней.
  Offset? _preview;

  /// Стены ровно по горизонтали, вертикали или под 45°.
  bool _straight = true;

  /// Выбранная стена — её можно удалить.
  String? _selectedWallId;

  /// Стены, нарисованные за этот заход, — для «Отменить».
  final List<String> _drawnIds = [];

  /// Пальцы на схеме: двумя схему двигают и приближают, а не рисуют.
  final Set<int> _pointers = {};
  bool _multiTouch = false;
  Offset? _wallDownGlobal;
  Offset? _wallDownLocal;
  bool _stroking = false;

  @override
  void initState() {
    super.initState();
    _wallsSub = _fs.hallWallsStream().listen((w) {
      if (mounted) setState(() => _walls = w);
    });
    _labelsSub = _fs.hallLabelsStream().listen((l) {
      if (mounted) setState(() => _labels = l);
    });
  }

  @override
  void dispose() {
    _panTimer?.cancel();
    _wallsSub?.cancel();
    _labelsSub?.cancel();
    _transform.dispose();
    super.dispose();
  }

  List<TableModel> _tables = [];

  /// Зона, которую сейчас расставляем ('' — столы без зоны).
  String _zone = '';

  /// Зоны, заведённые кнопкой «+ Зона», в которых ещё нет столов: зона
  /// хранится в самих столах, поэтому до первого стола она живёт здесь.
  final List<String> _newZones = [];

  /// Вкладки зон — чтобы прокрутить к выбранной (новая зона оказывается в
  /// конце списка и на телефоне уходила за край экрана).
  final Map<String, GlobalKey> _zoneKeys = {};

  void _showZone(String zone) {
    // Недорисованная стена остаётся в своей зоне.
    if (zone != _zone) unawaited(_finishDraft());
    setState(() {
      _zone = zone;
      _selectedId = null;
      _selectedWallId = null;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final ctx = _zoneKeys[zone]?.currentContext;
      if (ctx != null) Scrollable.ensureVisible(ctx, alignment: 0.5, duration: const Duration(milliseconds: 250));
    });
  }

  /// Все зоны: из столов, из стен (зона, где пока только стены) и только
  /// что заведённые.
  List<String> get _allZones {
    final zones = hallZones(_tables);
    for (final z in [..._walls.map((w) => w.zone), ..._labels.map((l) => l.zone)]) {
      if (z.isNotEmpty && !zones.contains(z)) zones.add(z);
    }
    _newZones.removeWhere(zones.contains);
    return [...zones, ..._newZones];
  }

  List<HallWall> get _zoneWalls => _walls.where((w) => w.zone == _zone).toList();

  /// Подписи зоны; перетаскиваемая — там, где сейчас палец.
  List<HallLabel> get _zoneLabels => [
        for (final l in _labels)
          if (l.zone == _zone) l.id == _dragLabelId && _dragLabelAt != null ? l.copyWith(at: _dragLabelAt) : l,
      ];

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
      if (mounted && result.zone != _zone) setState(() => _zone = result.zone);
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

  /// Ответ диалога зоны «удалить» — не может совпасть с названием.
  static const _deleteZone = '\u0000delete';

  /// «+ Зона» ([zone] == null) или переименование зоны [zone] ('' — столы
  /// без зоны: так им дают имя, например «Основной зал»). Имя уже
  /// существующей зоны — столы переезжают в неё.
  Future<void> _editZone(String? zone) async {
    final isNew = zone == null;
    final ctrl = TextEditingController(text: zone ?? '');
    final existing = _allZones;
    final inZone = isNew ? <TableModel>[] : _tables.where((t) => t.zone == zone).toList();
    final wallCount = isNew
        ? 0
        : _walls.where((w) => w.zone == zone).length + _labels.where((l) => l.zone == zone).length;
    String? error;
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSt) {
        final suggestions =
            ['Основной зал', 'Терраса', '2 этаж', 'VIP', 'Веранда', 'Бар'].where((s) => !existing.contains(s)).toList();
        void save() {
          final name = ctrl.text.trim();
          if (name.isEmpty) return setSt(() => error = 'Введите название зоны');
          if (name.length > 30) return setSt(() => error = 'Не длиннее 30 символов');
          if (name == kNoZoneLabel) return setSt(() => error = 'Выберите другое название');
          if (isNew && existing.contains(name)) return setSt(() => error = 'Такая зона уже есть');
          Navigator.pop(ctx, name);
        }

        return AlertDialog(
          title: Text(isNew ? 'Новая зона' : 'Зона «${zone.isEmpty ? kNoZoneLabel : zone}»'),
          content: SizedBox(
            width: 380,
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              TextField(
                controller: ctrl,
                autofocus: true,
                textCapitalization: TextCapitalization.sentences,
                decoration: InputDecoration(labelText: 'Название', hintText: 'Например, Терраса', errorText: error),
                onSubmitted: (_) => save(),
              ),
              if (suggestions.isNotEmpty) ...[
                const SizedBox(height: 10),
                Wrap(spacing: 6, runSpacing: 6, children: [
                  for (final s in suggestions) ActionChip(label: Text(s), onPressed: () => setSt(() => ctrl.text = s)),
                ]),
              ],
              const SizedBox(height: 10),
              Text(
                isNew
                    ? 'У каждой зоны своя схема. Новые столы кнопкой «Стол» добавятся в неё.'
                    : inZone.isEmpty && wallCount > 0
                        ? 'Столов в зоне нет. «Удалить» уберёт зону вместе с её стенами и подписями.'
                        : 'Новое имя получат все столы этой зоны (${inZone.length}). Если такая зона уже есть — столы переедут в неё.',
                style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
              ),
            ]),
          ),
          actions: [
            if (!isNew && inZone.isEmpty)
              TextButton(
                onPressed: () => Navigator.pop(ctx, _deleteZone),
                child: const Text('Удалить', style: TextStyle(color: AppColors.danger)),
              ),
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
            FilledButton(onPressed: save, child: Text(isNew ? 'Добавить' : 'Сохранить')),
          ],
        );
      }),
    );
    ctrl.dispose();
    if (result == null || !mounted) return;
    if (result == _deleteZone) {
      if (wallCount > 0) {
        try {
          await _fs.moveHallDrawing(zone!, null);
        } catch (e) {
          _snack('Не удалось удалить стены зоны: ${humanError(e, lower: true)}');
          return;
        }
      }
      if (!mounted) return;
      unawaited(_finishDraft(save: false));
      setState(() {
        _newZones.remove(zone);
        _zone = '';
        _selectedWallId = null;
      });
      return;
    }
    if (isNew) {
      _newZones.add(result);
      _showZone(result);
      return;
    }
    if (result == zone) return;
    // Стены зоны переезжают вместе с ней — и недорисованная тоже.
    await _finishDraft().timeout(const Duration(seconds: 5), onTimeout: () {});
    if (inZone.isEmpty) {
      if (wallCount > 0) {
        try {
          await _fs.moveHallDrawing(zone, result);
        } catch (e) {
          _snack('Не удалось переименовать зону: ${humanError(e, lower: true)}');
          return;
        }
      }
      final i = _newZones.indexOf(zone);
      if (i >= 0) _newZones[i] = result;
      if (mounted) _showZone(result);
      return;
    }
    try {
      await _fs.setTablesZone([for (final t in inZone) t.id], result);
      if (wallCount > 0) await _fs.moveHallDrawing(zone, result);
      if (mounted) _showZone(result);
    } catch (e) {
      _snack('Не удалось переименовать зону: ${humanError(e, lower: true)}');
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
    final zones = _allZones;
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
                final clash =
                    _tables.any((t) => t.id != existing?.id && t.name.trim().toLowerCase() == name.toLowerCase());
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
    final box = _canvasBox;
    final o = hallTileOffset(t);
    final size = hallTileSize(t);
    final down = _downAt;
    _grab = box != null && down != null
        ? box.globalToLocal(down) - Offset(o.left, o.top)
        : Offset(size.width / 2, size.height / 2);
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
  /// место.
  void _updateDrop() {
    final t = _dragging, p = _pointer, box = _canvasBox;
    if (t == null || p == null || box == null) return;
    final size = hallTileSize(t);
    final topLeft = box.globalToLocal(p) - _grab;
    final f = hallFractionForTopLeft(topLeft.dx, topLeft.dy, size);
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
    _fs
        .updateTablePosition(t.id, x, y)
        .catchError((e) => _snack('Не удалось переставить стол: ${humanError(e, lower: true)}'));
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

  // ---------- Стены ----------

  void _enterWallMode() {
    setState(() {
      _wallMode = true;
      _selectedId = null;
      _selectedWallId = null;
      _drawnIds.clear();
    });
  }

  void _exitWallMode() {
    unawaited(_finishDraft());
    setState(() {
      _wallMode = false;
      _selectedWallId = null;
      _drawnIds.clear();
    });
  }

  /// Радиус «примагничивания» к углам — ~24 экранных точки при любом
  /// масштабе схемы.
  double get _magnet => math.max(14.0, 24 / _canvasScale());

  /// Углы стен зоны и нарисованной стены — к ним примагничивается палец,
  /// чтобы стены сходились точно.
  List<Offset> get _corners => [for (final w in _zoneWalls) ...w.points, ..._draft];

  /// Начало стены: угол рядом или узел сетки.
  Offset _snapStart(Offset raw) => hallNearestCorner(raw, _corners, _magnet) ?? hallSnapToGrid(raw);

  /// Следующий угол от [from]: первый угол контура (замкнуть), угол другой
  /// стены рядом или ровное продолжение по сетке.
  Offset _snapNext(Offset from, Offset raw) {
    final near = hallNearestCorner(raw, [if (_draft.length >= 3) _draft.first, ..._corners], _magnet);
    if (near != null && near != from) return near;
    return hallWallEnd(from, raw, straight: _straight);
  }

  /// Сохранить нарисованную стену ([closed] — контур замкнут) и начать
  /// следующую с чистого листа.
  Future<void> _finishDraft({bool closed = false, bool save = true}) async {
    final points = _draft;
    if (points.isEmpty && _preview == null) return;
    setState(() {
      _draft = [];
      _preview = null;
      _stroking = false;
    });
    if (!save || points.length < 2) return;
    final id = _fs.newHallWallId();
    final wall = HallWall(id: id, zone: _zone, points: points, closed: closed && points.length >= 3);
    _drawnIds.add(id);
    try {
      await _fs.saveHallWall(id, wall);
    } catch (e) {
      _drawnIds.remove(id);
      _snack('Не удалось сохранить стену: ${humanError(e, lower: true)}');
    }
  }

  void _addCorner(Offset p) {
    if (_draft.isEmpty) {
      setState(() => _draft = [p]);
      return;
    }
    if ((p - _draft.last).distance < 1) return;
    if (_draft.length >= 3 && (p - _draft.first).distance < 1) {
      unawaited(_finishDraft(closed: true));
      return;
    }
    setState(() => _draft = [..._draft, p]);
    // Очень длинный контур — сохраняем кусок и продолжаем из его конца.
    if (_draft.length >= HallWall.maxPoints) {
      final last = _draft.last;
      unawaited(_finishDraft());
      setState(() => _draft = [last]);
    }
  }

  /// Касание без движения: угол стены, а если стена ещё не начата — выбор
  /// существующей стены (чтобы удалить) или начало новой.
  void _wallTap(Offset local) {
    if (_draft.isNotEmpty) {
      _addCorner(_snapNext(_draft.last, local));
      return;
    }
    HallWall? hit;
    var best = math.max(kHallWallWidth, _magnet * 0.8);
    for (final w in _zoneWalls) {
      final d = w.distanceTo(local);
      if (d <= best) {
        hit = w;
        best = d;
      }
    }
    if (hit != null) {
      setState(() => _selectedWallId = _selectedWallId == hit!.id ? null : hit.id);
      return;
    }
    if (_selectedWallId != null) {
      setState(() => _selectedWallId = null);
      return;
    }
    _addCorner(_snapStart(local));
  }

  /// Подпись под пальцем (с запасом — подписи мелкие).
  HallLabel? _labelAt(Offset local) {
    final pad = math.max(8.0, 14 / _canvasScale());
    for (final l in _zoneLabels.reversed) {
      if (HallWallsPainter.labelRect(l).inflate(pad).contains(local)) return l;
    }
    return null;
  }

  void _wallPointerDown(PointerDownEvent e) {
    _pointers.add(e.pointer);
    if (_pointers.length > 1) {
      // Второй палец — схему двигают и приближают, начатый штрих отменяем.
      _multiTouch = true;
      _stroking = false;
      _wallDownLocal = null;
      if (_dragLabelId != null) {
        setState(() {
          _dragLabelId = null;
          _dragLabelAt = null;
        });
      }
      if (_preview != null) setState(() => _preview = null);
      return;
    }
    _multiTouch = false;
    _wallDownGlobal = e.position;
    _wallDownLocal = e.localPosition;
    if (_tool == _DrawTool.label) _dragLabelId = _labelAt(e.localPosition)?.id;
  }

  void _wallPointerMove(PointerMoveEvent e) {
    final downLocal = _wallDownLocal, downGlobal = _wallDownGlobal;
    if (_multiTouch || downLocal == null || downGlobal == null) return;
    if (_tool == _DrawTool.label) {
      // Подпись едет за пальцем; схема под ней не двигается.
      if (_dragLabelId == null || ((e.position - downGlobal).distance < 8 && _dragLabelAt == null)) return;
      setState(() => _dragLabelAt = _labelSnap(e.localPosition));
      return;
    }
    if (!_stroking) {
      if ((e.position - downGlobal).distance < 8) return;
      // Повели пальцем — рисуем стену. Из конца нарисованной — продолжаем
      // её, из другого места — начинаем новую.
      final start = _snapStart(downLocal);
      if (_draft.isNotEmpty && (start - _draft.last).distance > 0.5) unawaited(_finishDraft());
      if (_draft.isEmpty) _draft = [start];
      _stroking = true;
      _selectedWallId = null;
    }
    setState(() => _preview = _snapNext(_draft.last, e.localPosition));
  }

  void _wallPointerUp(PointerUpEvent e) {
    _pointers.remove(e.pointer);
    if (_multiTouch) {
      if (_pointers.isEmpty) _multiTouch = false;
      return;
    }
    final local = _wallDownLocal;
    final tapped = _wallDownGlobal != null && (e.position - _wallDownGlobal!).distance < 8;
    _wallDownLocal = null;
    _wallDownGlobal = null;
    if (_tool == _DrawTool.label) {
      final id = _dragLabelId, to = _dragLabelAt;
      final label = _labels.where((l) => l.id == id).firstOrNull;
      if (label != null && to != null) {
        // Перетащили — сохраняем новое место; до ответа базы подпись
        // остаётся там, где её отпустили.
        final moved = label.copyWith(at: to);
        setState(() => _labels = [for (final l in _labels) l.id == id ? moved : l]);
        _fs.saveHallLabel(moved).catchError((e) => _snack('Не удалось переставить подпись: ${humanError(e, lower: true)}'));
      } else if (local != null && tapped) {
        unawaited(label != null ? _editLabel(existing: label) : _editLabel(at: _labelSnap(local)));
      }
      setState(() {
        _dragLabelId = null;
        _dragLabelAt = null;
      });
      return;
    }
    if (_stroking) {
      final end = _preview;
      _stroking = false;
      setState(() => _preview = null);
      if (end != null) _addCorner(end);
    } else if (local != null) {
      _wallTap(local);
    }
  }

  void _wallPointerCancel(PointerCancelEvent e) {
    _pointers.remove(e.pointer);
    if (_pointers.isEmpty) _multiTouch = false;
    _wallDownLocal = null;
    _stroking = false;
    _dragLabelId = null;
    _dragLabelAt = null;
    if (_preview != null) setState(() => _preview = null);
  }

  /// Мышь: следующая стена тянется за курсором. От пальца «наведение»
  /// тоже приходит — сразу после того, как его убрали, — и подсказка
  /// повисала бы там, где палец оторвался.
  void _wallHover(PointerHoverEvent e) {
    if (_tool != _DrawTool.wall || _draft.isEmpty || e.kind == PointerDeviceKind.touch) return;
    setState(() => _preview = _snapNext(_draft.last, e.localPosition));
  }

  /// «Отменить»: последний угол; если стена уже сохранена — она снова
  /// становится черновиком без последнего отрезка.
  Future<void> _undoWall() async {
    if (_draft.isNotEmpty) {
      setState(() {
        _draft = _draft.sublist(0, _draft.length - 1);
        _preview = null;
      });
      return;
    }
    if (_drawnIds.isEmpty) return;
    final id = _drawnIds.removeLast();
    final wall = _walls.where((w) => w.id == id).firstOrNull;
    setState(() {
      _selectedWallId = null;
      if (wall != null && wall.zone == _zone) {
        _draft = wall.closed ? [...wall.points] : wall.points.sublist(0, wall.points.length - 1);
        if (_draft.length < 2) _draft = [];
      }
    });
    try {
      await _fs.deleteHallWall(id);
    } catch (e) {
      _snack('Не удалось отменить: ${humanError(e, lower: true)}');
    }
  }

  Future<void> _deleteSelectedWall() async {
    final wall = _walls.where((w) => w.id == _selectedWallId).firstOrNull;
    if (wall == null) return;
    setState(() => _selectedWallId = null);
    try {
      await _fs.deleteHallWall(wall.id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: const Text('Стена удалена'),
        action: SnackBarAction(label: 'Вернуть', onPressed: () => _fs.saveHallWall(wall.id, wall)),
      ));
    } catch (e) {
      _snack('Не удалось удалить стену: ${humanError(e, lower: true)}');
    }
  }

  /// Подписи встают на полшага сетки — ровно с углами стен и столами.
  Offset _labelSnap(Offset p) {
    const step = kHallGridStep / 2;
    double snap(double v, double max) => ((v / step).round() * step).clamp(0.0, max).toDouble();
    return Offset(snap(p.dx, kHallCanvas.width), snap(p.dy, kHallCanvas.height));
  }

  /// Новая подпись в точке [at] или правка [existing] (там же — удалить).
  Future<void> _editLabel({HallLabel? existing, Offset? at}) async {
    final ctrl = TextEditingController(text: existing?.text ?? '');
    String? error;
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSt) {
        void save() {
          final text = ctrl.text.trim().replaceAll(RegExp(r'\s+'), ' ');
          if (text.isEmpty) return setSt(() => error = 'Введите подпись');
          if (text.length > HallLabel.maxLength) return setSt(() => error = 'Не длиннее ${HallLabel.maxLength} символов');
          Navigator.pop(ctx, text);
        }

        return AlertDialog(
          title: Text(existing == null ? 'Подпись на схеме' : 'Подпись «${existing.text}»'),
          content: SizedBox(
            width: 380,
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              TextField(
                controller: ctrl,
                autofocus: true,
                maxLength: HallLabel.maxLength,
                textCapitalization: TextCapitalization.sentences,
                decoration: InputDecoration(
                  labelText: 'Текст',
                  hintText: 'Например, Вход или Курящая зона',
                  errorText: error,
                ),
                onSubmitted: (_) => save(),
              ),
              Wrap(spacing: 6, runSpacing: 6, children: [
                for (final t in kHallLabelSuggestions)
                  ActionChip(label: Text(t), onPressed: () => setSt(() => ctrl.text = t)),
              ]),
              const SizedBox(height: 10),
              const Text(
                'Подпись видна на схеме в зале, у гостя в приложении и на сайте — заглавными, как на чертеже. '
                'Её можно перетащить пальцем.',
                style: TextStyle(fontSize: 12, color: AppColors.textMuted),
              ),
            ]),
          ),
          actions: [
            if (existing != null)
              TextButton(
                onPressed: () => Navigator.pop(ctx, _deleteLabel),
                child: const Text('Удалить', style: TextStyle(color: AppColors.danger)),
              ),
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
            FilledButton(onPressed: save, child: Text(existing == null ? 'Добавить' : 'Сохранить')),
          ],
        );
      }),
    );
    ctrl.dispose();
    if (result == null || !mounted) return;
    try {
      if (result == _deleteLabel && existing != null) {
        await _fs.deleteHallLabel(existing.id);
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: const Text('Подпись удалена'),
          action: SnackBarAction(label: 'Вернуть', onPressed: () => _fs.saveHallLabel(existing)),
        ));
      } else if (existing != null) {
        await _fs.saveHallLabel(existing.copyWith(text: result));
      } else {
        await _fs.saveHallLabel(HallLabel(id: _fs.newHallLabelId(), zone: _zone, text: result, at: at ?? Offset.zero));
      }
    } catch (e) {
      _snack('Не удалось сохранить подпись: ${humanError(e, lower: true)}');
    }
  }

  /// Ответ диалога подписи «удалить» — не может совпасть с текстом.
  static const _deleteLabel = '\u0000delete';

  Future<void> _clearZoneWalls() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Убрать стены и подписи зоны?'),
        content: const Text('Столы останутся на местах, стены и подписи можно будет нарисовать заново.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Убрать'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    unawaited(_finishDraft(save: false));
    setState(() {
      _selectedWallId = null;
      _drawnIds.clear();
    });
    try {
      await _fs.moveHallDrawing(_zone, null);
    } catch (e) {
      _snack('Не удалось убрать стены и подписи: ${humanError(e, lower: true)}');
    }
  }

  /// Слой рисования стен поверх схемы: ловит пальцы и мышь, рисует
  /// черновик стены, углы и направляющие.
  Widget _wallOverlay() => MouseRegion(
        cursor: _tool == _DrawTool.label ? SystemMouseCursors.text : SystemMouseCursors.precise,
        child: Listener(
          behavior: HitTestBehavior.opaque,
          onPointerDown: _wallPointerDown,
          onPointerMove: _wallPointerMove,
          onPointerUp: _wallPointerUp,
          onPointerCancel: _wallPointerCancel,
          onPointerHover: _wallHover,
          child: CustomPaint(
            size: Size.infinite,
            painter: _WallDraftPainter(
              draft: _draft,
              preview: _preview,
              guides: [for (final w in _zoneWalls) ...w.points, ..._draft],
              color: AppColors.primary,
              floor: AppColors.surface,
            ),
          ),
        ),
      );

  /// Панель рисования стен.
  Widget _wallBar() {
    final selected = _selectedWallId != null && _tool == _DrawTool.wall;
    final labelTool = _tool == _DrawTool.label;
    final String hint;
    if (labelTool) {
      hint = 'Коснитесь схемы — появится подпись: вход, выход, кухня или заметка. '
          'Подпись можно перетащить, коснитесь её, чтобы изменить или удалить.';
    } else if (selected) {
      hint = 'Стена выбрана — её можно удалить. Коснитесь пустого места, чтобы снять выбор.';
    } else if (_draft.isEmpty) {
      hint = 'Ведите пальцем по схеме — стена ляжет ровно по сетке. Или касайтесь углов помещения по очереди. '
          'Схему двигайте двумя пальцами.';
    } else if (_draft.length >= 3) {
      hint = 'Продолжайте из синей точки или коснитесь первой точки — контур замкнётся.';
    } else {
      hint = 'Ведите дальше из синей точки — стены соединятся. Из другого места начнётся новая стена.';
    }
    return Material(
      color: AppColors.surfaceElevated,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Padding(
                padding: EdgeInsets.only(top: 2),
                child: Icon(Icons.architecture, color: AppColors.primary, size: 20),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(hint, style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
              ),
            ]),
            const SizedBox(height: 8),
            Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.end, crossAxisAlignment: WrapCrossAlignment.center, children: [
              SegmentedButton<_DrawTool>(
                showSelectedIcon: false,
                segments: const [
                  ButtonSegment(value: _DrawTool.wall, icon: Icon(Icons.architecture, size: 18), label: Text('Стена')),
                  ButtonSegment(value: _DrawTool.label, icon: Icon(Icons.title, size: 18), label: Text('Надпись')),
                ],
                selected: {_tool},
                onSelectionChanged: (v) {
                  unawaited(_finishDraft());
                  setState(() {
                    _tool = v.first;
                    _selectedWallId = null;
                  });
                },
              ),
              if (!labelTool)
                FilterChip(
                  avatar: const Icon(Icons.straighten, size: 16),
                  label: const Text('Ровные углы'),
                  tooltip: 'Стены строго по горизонтали, вертикали или под 45°',
                  selected: _straight,
                  onSelected: (v) => setState(() => _straight = v),
                ),
              if (selected)
                OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(foregroundColor: AppColors.danger),
                  onPressed: _deleteSelectedWall,
                  icon: const Icon(Icons.delete_outline, size: 18),
                  label: const Text('Удалить стену'),
                ),
              if (!selected && _draft.isEmpty && (_zoneWalls.isNotEmpty || _zoneLabels.isNotEmpty))
                TextButton(onPressed: _clearZoneWalls, child: const Text('Убрать все')),
              if (!labelTool)
                OutlinedButton.icon(
                  onPressed: _draft.isNotEmpty || _drawnIds.isNotEmpty ? _undoWall : null,
                  icon: const Icon(Icons.undo, size: 18),
                  label: const Text('Отменить'),
                ),
              if (_draft.length >= 3)
                OutlinedButton.icon(
                  onPressed: () => _finishDraft(closed: true),
                  icon: const Icon(Icons.crop_square, size: 18),
                  label: const Text('Замкнуть'),
                ),
              FilledButton.icon(
                onPressed: _exitWallMode,
                icon: const Icon(Icons.check, size: 18),
                label: const Text('Готово'),
              ),
            ]),
          ]),
        ),
      ),
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
                IconButton.filledTonal(
                    tooltip: 'Повернуть', icon: const Icon(Icons.rotate_right), onPressed: () => _rotate(t)),
            ]),
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // «Назад» в режиме стен — выход из рисования (стена сохраняется), а не
    // из редактора.
    return PopScope(
      canPop: !_wallMode,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _exitWallMode();
      },
      child: _scaffold(context),
    );
  }

  Widget _scaffold(BuildContext context) {
    final selected = _selectedId == null ? null : _tables.where((t) => t.id == _selectedId).firstOrNull;
    return Scaffold(
      appBar: AppBar(title: Text(_wallMode ? 'Стены и подписи' : 'Карта зала')),
      floatingActionButton: selected != null || _wallMode
          ? null
          : Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
              FloatingActionButton.extended(
                heroTag: 'walls',
                tooltip: 'Нарисовать стены помещения и подписать вход, кухню, заметки',
                backgroundColor: AppColors.surfaceElevated,
                foregroundColor: AppColors.textPrimary,
                onPressed: _enterWallMode,
                icon: const Icon(Icons.architecture),
                label: const Text('Стены'),
              ),
              const SizedBox(height: 12),
              FloatingActionButton.extended(
                heroTag: 'table',
                onPressed: _addTable,
                icon: const Icon(Icons.add),
                label: const Text('Стол'),
              ),
            ]),
      bottomNavigationBar: _wallMode
          ? _wallBar()
          : selected != null && selected.zone == _zone
              ? _selectionBar(selected)
              : null,
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
          final zones = _allZones;
          final hasNoZone = _tables.any((t) => t.zone.isEmpty) ||
              _walls.any((w) => w.zone.isEmpty) ||
              _labels.any((l) => l.zone.isEmpty);
          final zoneKeys = [...zones, if (hasNoZone || zones.isEmpty) ''];
          // Пока зон нет, все столы — один зал.
          String zoneLabel(String z) => z.isNotEmpty ? z : (zones.isEmpty ? 'Весь зал' : kNoZoneLabel);
          if (!zoneKeys.contains(_zone)) _zone = zoneKeys.first;
          final narrow = MediaQuery.sizeOf(context).width < 600;

          return Column(
            children: [
              // Зоны — вкладки: «+ Зона» заводит новую (терраса, 2 этаж…),
              // нажатие на выбранную — переименовать.
              SizedBox(
                height: 50,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                  children: [
                    for (final z in zoneKeys)
                      Padding(
                        key: _zoneKeys.putIfAbsent(z, GlobalKey.new),
                        padding: const EdgeInsets.only(right: 8),
                        child: ChoiceChip(
                          showCheckmark: false,
                          avatar: _zone == z ? const Icon(Icons.edit_outlined, size: 16) : null,
                          tooltip: _zone == z ? 'Переименовать зону' : null,
                          label: Text('${zoneLabel(z)} · ${_tables.where((t) => t.zone == z).length}'),
                          selected: _zone == z,
                          onSelected: (_) {
                            if (_zone == z) {
                              _editZone(z);
                              return;
                            }
                            _showZone(z);
                          },
                        ),
                      ),
                    ActionChip(
                      avatar: const Icon(Icons.add, size: 18),
                      label: const Text('Зона'),
                      tooltip: 'Новая зона: терраса, 2 этаж, VIP…',
                      onPressed: () => _editZone(null),
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
                      _wallMode
                          ? 'Стены и подписи зоны «${zoneLabel(_zone)}» увидят сотрудники в зале и гости на карте.'
                          : _tables.isEmpty
                              ? 'Добавьте первый стол кнопкой «Стол» внизу. Зоны (терраса, 2 этаж) — кнопкой «+ Зона».'
                              : _inZone.isEmpty
                                  ? 'В зоне «${zoneLabel(_zone)}» пока нет столов — добавьте их кнопкой «Стол» внизу.'
                                  : 'Нажмите на стол — появятся стрелки, поворот и настройки. '
                                      '${narrow ? 'Или удерживайте' : 'Или перетащите'} его: зелёная рамка покажет, куда он встанет. '
                                      'Контур помещения и подписи (вход, кухня, заметки) — кнопкой «Стены». '
                                      'Зоны — вкладки сверху: «+ Зона» добавит новую, нажмите на выбранную — переименовать.',
                      style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted),
                    ),
                  ),
                ]),
              ),
              Expanded(
                child: Listener(
                  onPointerDown: (e) => _downAt = e.position,
                  child: KeyedSubtree(
                    key: _viewportKey,
                    child: HallPlanView(
                      canvasKey: _canvasKey,
                      tables: _inZone,
                      walls: _zoneWalls,
                      labels: _zoneLabels,
                      highlightedWallId: _dragLabelId ?? _selectedWallId,
                      panEnabled: !_wallMode,
                      showHint: !_wallMode,
                      transformationController: _transform,
                      frameKey: _zone,
                      fitWidth: true,
                      overlay: _wallMode ? _wallOverlay() : _overlay(),
                      tileBuilder: (t) {
                        // Рисуют стены — столы приглушены и не мешают пальцу.
                        if (_wallMode) {
                          return Opacity(opacity: 0.4, child: TableTile(table: t, editorMode: true));
                        }
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

/// Черновик стены в редакторе: нарисованные отрезки, следующий отрезок за
/// пальцем, точки углов (первая — крупнее, в неё замыкают контур) и
/// пунктирные направляющие, когда угол встаёт вровень с другим углом.
class _WallDraftPainter extends CustomPainter {
  final List<Offset> draft;
  final Offset? preview;
  final List<Offset> guides;
  final Color color;
  final Color floor;

  _WallDraftPainter({
    required this.draft,
    required this.preview,
    required this.guides,
    required this.color,
    required this.floor,
  });

  void _dashed(Canvas canvas, Offset a, Offset b, Paint paint) {
    const dash = 9.0, gap = 7.0;
    final total = (b - a).distance;
    if (total < 1) return;
    final dir = (b - a) / total;
    for (var d = 0.0; d < total; d += dash + gap) {
      canvas.drawLine(a + dir * d, a + dir * math.min(d + dash, total), paint);
    }
  }

  @override
  void paint(Canvas canvas, Size size) {
    final p = preview;
    if (p != null) {
      // Направляющие: угол вровень с другим углом по вертикали или
      // горизонтали — видно, что стены встанут ровно.
      final guide = Paint()
        ..color = color.withValues(alpha: 0.55)
        ..strokeWidth = 1.6;
      var vertical = false, horizontal = false;
      for (final c in guides) {
        if (c == p || (draft.isNotEmpty && c == draft.last)) continue;
        if (!vertical && (c.dx - p.dx).abs() < 0.5) {
          _dashed(canvas, c, p, guide);
          vertical = true;
        }
        if (!horizontal && (c.dy - p.dy).abs() < 0.5) {
          _dashed(canvas, c, p, guide);
          horizontal = true;
        }
      }
    }
    if (draft.length >= 2) {
      HallWallsPainter(
        walls: [HallWall(id: 'draft', zone: '', points: draft)],
        line: color,
        floor: floor,
        shadow: false,
      ).paint(canvas, size);
    }
    if (p != null && draft.isNotEmpty && p != draft.last) {
      canvas.drawLine(
        draft.last,
        p,
        Paint()
          ..color = color.withValues(alpha: 0.5)
          ..strokeWidth = kHallWallWidth
          ..strokeCap = StrokeCap.square,
      );
    }
    if (draft.length >= 3) {
      // Первая точка: сюда — и контур замкнётся.
      canvas.drawCircle(draft.first, 18, Paint()..color = color.withValues(alpha: 0.2));
      canvas.drawCircle(
        draft.first,
        18,
        Paint()
          ..color = color.withValues(alpha: 0.7)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2,
      );
    }
    final ring = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3;
    for (final c in draft) {
      canvas.drawCircle(c, 7, Paint()..color = Colors.white);
      canvas.drawCircle(c, 7, ring);
    }
    if (draft.isNotEmpty) canvas.drawCircle(draft.last, 4, Paint()..color = color);
    if (p != null) {
      canvas.drawCircle(p, 9, Paint()..color = color.withValues(alpha: 0.35));
      canvas.drawCircle(p, 5, Paint()..color = Colors.white);
    }
  }

  @override
  bool shouldRepaint(covariant _WallDraftPainter old) =>
      old.preview != preview || !listEquals(old.draft, draft) || old.color != color || old.guides.length != guides.length;
}

/// Инструмент режима рисования.
enum _DrawTool { wall, label }
