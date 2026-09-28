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

  List<TableModel> _tables = [];

  /// Зона, которую сейчас расставляем ('' — столы без зоны).
  String _zone = '';

  /// Только что перетащенный стол — показываем на новом месте сразу, не
  /// дожидаясь ответа базы (иначе плитка на миг прыгала обратно).
  final Map<String, ({double x, double y, int rotation})> _moved = {};

  List<TableModel> get _inZone => _tables.where((t) => t.zone == _zone).toList();

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
  Future<void> _rotate(TableModel t) async {
    final r = hallRotated(t);
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
                          'из длинных и треугольных собираются большие и угловые.',
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

  void _onDrop(TableModel t, Offset globalPointer) {
    final box = _canvasKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null) return;
    final local = box.globalToLocal(globalPointer);
    // Привязка края стола к сетке в четверть плитки: столы встают ровными
    // рядами и вплотную друг к другу — так из длинных и треугольных
    // собираются большие и угловые столы.
    final s = hallTileSize(t);
    final f = hallFractionForTopLeft(local.dx - s.width / 2, local.dy - s.height / 2, s);
    setState(() => _moved[t.id] = (x: f.x, y: f.y, rotation: t.rotation));
    _fs.updateTablePosition(t.id, f.x, f.y).catchError((e) => _snack('Не удалось переставить стол: ${humanError(e, lower: true)}'));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Карта зала')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _addTable,
        icon: const Icon(Icons.add),
        label: const Text('Стол'),
      ),
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
                            onSelected: (_) => setState(() => _zone = z),
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
                          : '${narrow ? 'Удерживайте' : 'Перетащите'} стол, чтобы переставить; ⟳ — повернуть; '
                              'нажмите — изменить. Зоны (терраса, VIP) задаются в настройках стола.',
                      style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted),
                    ),
                  ),
                ]),
              ),
              Expanded(
                child: HallPlanView(
                  canvasKey: _canvasKey,
                  tables: _inZone,
                  tileBuilder: (t) {
                    final tile = TableTile(
                      table: t,
                      editorMode: true,
                      onTap: () => _editTable(t),
                      onRotate: () => _rotate(t),
                    );
                    Widget feedback() => Material(
                          color: Colors.transparent,
                          child: FractionalTranslation(
                            translation: const Offset(-0.5, -0.5),
                            child: TableTile(table: t, editorMode: true, isDraggablePreview: true),
                          ),
                        );
                    final ghost = Opacity(opacity: 0.3, child: TableTile(table: t, editorMode: true));
                    // На узком экране схему двигают пальцем, поэтому стол
                    // берётся долгим нажатием; на планшете — сразу.
                    return narrow
                        ? LongPressDraggable<String>(
                            data: t.id,
                            dragAnchorStrategy: pointerDragAnchorStrategy,
                            feedback: feedback(),
                            childWhenDragging: ghost,
                            onDragEnd: (d) => _onDrop(t, d.offset),
                            child: tile,
                          )
                        : Draggable<String>(
                            data: t.id,
                            dragAnchorStrategy: pointerDragAnchorStrategy,
                            feedback: feedback(),
                            childWhenDragging: ghost,
                            onDragEnd: (d) => _onDrop(t, d.offset),
                            child: tile,
                          );
                  },
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
    case 'triangle':
      return Icons.change_history;
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
