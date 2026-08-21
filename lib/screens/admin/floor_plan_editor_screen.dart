import '../../theme/app_colors.dart';
import 'package:flutter/material.dart';
import '../../models/table_model.dart';
import '../../services/firestore_service.dart';
import '../../widgets/table_tile.dart';

/// Редактор карты зала: перетаскивание столов, добавление/удаление/переименование.
class FloorPlanEditorScreen extends StatefulWidget {
  const FloorPlanEditorScreen({super.key});

  @override
  State<FloorPlanEditorScreen> createState() => _FloorPlanEditorScreenState();
}

class _FloorPlanEditorScreenState extends State<FloorPlanEditorScreen> {
  final _fs = FirestoreService();
  // Ключ именно на области карты (Stack), чтобы верно переводить глобальные
  // координаты сброса Draggable в локальные — раньше использовался
  // findRenderObject() всего экрана, из-за чего позиция стола после
  // перетаскивания сдвигалась на высоту AppBar/паддингов.
  final _mapKey = GlobalKey();

  // Актуальный список столов из последнего StreamBuilder — нужен, чтобы
  // синхронно посчитать позицию для нового стола, без лишнего запроса.
  List<TableModel> _tables = [];

  /// БАГ (исправлено): раньше каждый новый стол всегда ставился в одну и ту
  /// же точку (x: 0.1, y: 0.1). Из-за этого второй, третий и т.д. столы
  /// добавлялись в базу нормально, но визуально оказывались ровно друг под
  /// другом и полностью перекрывали первый стол — казалось, будто
  /// "нельзя добавить больше одного стола". Теперь новый стол ставится в
  /// следующую свободную ячейку сетки, и все столы видно по отдельности.
  Offset _nextFreePosition() {
    const cols = 4;
    const stepX = 0.20;
    const stepY = 0.24;
    final index = _tables.length;
    final col = index % cols;
    final row = index ~/ cols;
    return Offset(
      (0.04 + col * stepX).clamp(0.0, 0.85),
      (0.04 + row * stepY).clamp(0.0, 0.85),
    );
  }

  Future<void> _addTable() async {
    final result = await _showTableDialog();
    if (result == null) return;
    final id = _fs.newTableId();
    final pos = _nextFreePosition();
    await _fs.addTable(TableModel(
      id: id,
      name: result['name'],
      x: pos.dx,
      y: pos.dy,
      seats: result['seats'],
      shape: result['shape'],
      maxOpenSessions: result['maxOpenSessions'],
    ));
  }

  Future<void> _editTable(TableModel table) async {
    final result = await _showTableDialog(existing: table);
    if (result == null) return;
    if (result['delete'] == true) {
      final confirm = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
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
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
        }
      }
      return;
    }
    await _fs.updateTable(table.copyWith(
      name: result['name'],
      seats: result['seats'],
      shape: result['shape'],
      maxOpenSessions: result['maxOpenSessions'],
    ));
  }

  Future<Map<String, dynamic>?> _showTableDialog({TableModel? existing}) async {
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final seatsCtrl = TextEditingController(text: (existing?.seats ?? 4).toString());
    String shape = existing?.shape ?? 'rect';
    int maxOpenSessions = existing?.maxOpenSessions ?? 2;

    return showDialog<Map<String, dynamic>>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSt) {
        return AlertDialog(
          title: Text(existing == null ? 'Новый стол' : 'Стол «${existing.name}»'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(controller: nameCtrl, decoration: const InputDecoration(labelText: 'Название')),
                TextField(
                  controller: seatsCtrl,
                  decoration: const InputDecoration(labelText: 'Количество мест'),
                  keyboardType: TextInputType.number,
                ),
                const SizedBox(height: 8),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    ChoiceChip(
                      label: const Text('Прямоугольный'),
                      selected: shape == 'rect',
                      onSelected: (_) => setSt(() => shape = 'rect'),
                    ),
                    const SizedBox(width: 8),
                    ChoiceChip(
                      label: const Text('Круглый'),
                      selected: shape == 'circle',
                      onSelected: (_) => setSt(() => shape = 'circle'),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                // Сколько отдельных чеков разрешено одновременно открывать
                // на этот стол (для раздельной оплаты гостями за одним столом).
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Expanded(
                      child: Text('Чеков одновременно на стол:', style: TextStyle(fontSize: 13)),
                    ),
                    IconButton(
                      icon: const Icon(Icons.remove_circle_outline),
                      onPressed:
                          maxOpenSessions > 1 ? () => setSt(() => maxOpenSessions -= 1) : null,
                    ),
                    Text('$maxOpenSessions',
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                    IconButton(
                      icon: const Icon(Icons.add_circle_outline),
                      onPressed:
                          maxOpenSessions < 6 ? () => setSt(() => maxOpenSessions += 1) : null,
                    ),
                  ],
                ),
              ],
            ),
          ),
          actions: [
            if (existing != null)
              TextButton(
                onPressed: () => Navigator.pop(ctx, {'delete': true}),
                child: const Text('Удалить', style: TextStyle(color: AppColors.danger)),
              ),
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
            FilledButton(
              onPressed: () {
                if (nameCtrl.text.trim().isEmpty) return;
                Navigator.pop(ctx, {
                  'name': nameCtrl.text.trim(),
                  'seats': int.tryParse(seatsCtrl.text) ?? 4,
                  'shape': shape,
                  'maxOpenSessions': maxOpenSessions,
                });
              },
              child: const Text('Сохранить'),
            ),
          ],
        );
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Карта зала'),
        actions: [IconButton(icon: const Icon(Icons.add), onPressed: _addTable)],
      ),
      body: StreamBuilder<List<TableModel>>(
        stream: _fs.tablesStream(),
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          _tables = snap.data!;
          return LayoutBuilder(builder: (context, constraints) {
            return Stack(
              key: _mapKey,
              children: _tables.map((t) {
                return Positioned(
                  key: ValueKey(t.id),
                  left: t.x * constraints.maxWidth,
                  top: t.y * constraints.maxHeight,
                  child: Draggable(
                    feedback: TableTile(table: t, isDraggablePreview: true),
                    childWhenDragging: Opacity(opacity: 0.3, child: TableTile(table: t)),
                    onDragEnd: (details) {
                      // Переводим глобальные координаты именно относительно
                      // карты зала (_mapKey), а не всего экрана.
                      final mapBox =
                          _mapKey.currentContext!.findRenderObject() as RenderBox;
                      final local = mapBox.globalToLocal(details.offset);
                      final nx = (local.dx / constraints.maxWidth).clamp(0.0, 0.85);
                      final ny = (local.dy / constraints.maxHeight).clamp(0.0, 0.85);
                      _fs.updateTablePosition(t.id, nx, ny);
                    },
                    child: TableTile(
                      table: t,
                      checkCount: t.activeSessionIds.isEmpty ? 1 : t.activeSessionIds.length,
                      onTap: () => _editTable(t),
                    ),
                  ),
                );
              }).toList(),
            );
          });
        },
      ),
    );
  }
}