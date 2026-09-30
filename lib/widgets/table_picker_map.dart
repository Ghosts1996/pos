import 'package:flutter/material.dart';
import '../models/hall_label.dart';
import '../models/hall_wall.dart';
import '../models/table_model.dart';
import '../utils/hall_layout.dart';
import '../utils/table_label.dart';
import 'hall_drawing_builder.dart';
import 'hall_plan_view.dart';
import 'table_shape.dart';

/// Занятый интервал стола для подписи на карте выбора. Не привязан к
/// [ReservationModel]: на кассе подпись — из брони с именем гостя, в
/// приложении гостя — из обезличенного reservationSlots.
class TableBusyInterval {
  final String tableId;
  final DateTime startTime;
  final DateTime endTime;

  /// Что показать после времени: «Аня · 4 чел · Подтверждена» на POS или
  /// просто «занято» у гостя. Пусто — только интервал.
  final String description;

  const TableBusyInterval({
    required this.tableId,
    required this.startTime,
    required this.endTime,
    this.description = '',
  });
}

/// Карта зала для выбора стола при брони — на кассе и в приложении гостя.
/// Подпись решает вызывающий через [TableBusyInterval.description], так
/// что чужие имена в приложение гостя не попадают.
///
/// Свободность — по [freeTableIds] (обычно
/// ReservationService.availableTables, с учётом живых сеансов), подписи —
/// по [busyIntervals] на выбранный день.
class TablePickerMap extends StatefulWidget {
  final List<TableModel> tables;
  final Set<String> freeTableIds;
  final List<TableBusyInterval> busyIntervals;
  final DateTime start;
  final int durationMinutes;
  final String? selectedTableId;
  final ValueChanged<TableModel> onSelect;

  const TablePickerMap({
    super.key,
    required this.tables,
    required this.freeTableIds,
    required this.busyIntervals,
    required this.start,
    required this.durationMinutes,
    required this.onSelect,
    this.selectedTableId,
  });

  static const _freeColor = Color(0xFF22C55E);
  static const _busyColor = Color(0xFFEF4444);
  static const _selectedColor = Color(0xFF0B5ED7);

  @override
  State<TablePickerMap> createState() => _TablePickerMapState();
}

class _TablePickerMapState extends State<TablePickerMap> {
  /// Зона зала — у каждой своя схема (см. TableModel.zone).
  String? _zone;

  List<TableModel> get tables => widget.tables;
  List<TableBusyInterval> get busyIntervals => widget.busyIntervals;
  ValueChanged<TableModel> get onSelect => widget.onSelect;
  static const _busyColor = TablePickerMap._busyColor;

  @override
  Widget build(BuildContext context) {
    if (tables.isEmpty) {
      return const Center(child: Text('Столы ещё не добавлены'));
    }
    final zones = hallZones(tables);
    final zoneKeys = [...zones, if (zones.isNotEmpty && tables.any((t) => t.zone.isEmpty)) ''];
    final zone = zoneKeys.isEmpty ? null : (zoneKeys.contains(_zone) ? _zone! : zoneKeys.first);
    final shown = zone == null ? tables : tables.where((t) => t.zone == zone).toList();
    return Column(
      children: [
        if (zoneKeys.isNotEmpty)
          SizedBox(
            height: 46,
            child: ListView(
              scrollDirection: Axis.horizontal,
              children: [
                for (final z in zoneKeys)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(
                      label: Text(z.isEmpty ? kNoZoneLabel : z),
                      selected: z == zone,
                      onSelected: (_) => setState(() => _zone = z),
                    ),
                  ),
              ],
            ),
          ),
        Expanded(
          // Та же схема, что у администратора (логический холст, см.
          // hall_layout.dart), — на телефоне её можно двигать пальцем.
          // Стены и подписи зала — как нарисовал администратор.
          child: HallDrawingBuilder(
            zone: zone ?? '',
            builder: (context, walls, labels) => _plan(context, shown, walls, labels),
          ),
        ),
      ],
    );
  }

  /// Схема зоны: её стены, подписи и столы цветом свободности.
  Widget _plan(BuildContext context, List<TableModel> shown, List<HallWall> walls, List<HallLabel> labels) {
    return HallPlanView(
      tables: shown,
      walls: walls,
      labels: labels,
      wallColor: Color.lerp(Theme.of(context).colorScheme.onSurface, Theme.of(context).colorScheme.surface, 0.2)!,
      floorColor: Theme.of(context).colorScheme.surface,
      lineColor: Theme.of(context).dividerColor,
      tileBuilder: (t) {
        final free = widget.freeTableIds.contains(t.id);
        final selected = t.id == widget.selectedTableId;
        final color = selected
            ? TablePickerMap._selectedColor
            : (free ? TablePickerMap._freeColor : TablePickerMap._busyColor);
        return GestureDetector(
          onTap: () => _openInfo(context, t, free),
          child: TableShapeBox(
            table: t,
            size: hallTileSize(t),
            fill: color.withValues(alpha: 0.18),
            borderColor: color,
            borderWidth: selected ? 3 : 2,
            cornerRadius: 16,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(selected ? Icons.check_circle : Icons.table_restaurant, color: color, size: 22),
                const SizedBox(height: 4),
                Text(t.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                Text(seatsLabel(t.seats), style: const TextStyle(fontSize: 11.5)),
              ],
            ),
          ),
        );
      },
    );
  }

  void _openInfo(BuildContext context, TableModel table, bool free) {
    final todays = busyIntervals.where((r) => r.tableId == table.id).toList()
      ..sort((a, b) => a.startTime.compareTo(b.startTime));

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(table.name, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              Text(seatsLabel(table.seats), style: const TextStyle(color: Colors.grey)),
              const SizedBox(height: 14),
              if (todays.isEmpty)
                const Text('На этот день стол свободен')
              else ...[
                const Text('Занятость на этот день:',
                    style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                ...todays.map((r) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 3),
                      child: Text('${_fmt(r.startTime)}–${_fmt(r.endTime)} · '
                          '${r.description.isEmpty ? 'занято' : r.description}'),
                    )),
              ],
              const SizedBox(height: 18),
              if (free)
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: () {
                      Navigator.pop(ctx);
                      onSelect(table);
                    },
                    child: const Text('Выбрать этот стол'),
                  ),
                )
              else
                const Text('Занят на выбранное время',
                    style: TextStyle(color: _busyColor, fontWeight: FontWeight.w600)),
            ],
          ),
        ),
      ),
    );
  }

  String _fmt(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}
