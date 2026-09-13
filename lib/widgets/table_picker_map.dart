import 'package:flutter/material.dart';
import '../models/table_model.dart';

/// Занятый интервал стола для подписи на карте выбора.
///
/// Специально не завязан на [ReservationModel]: на POS подпись собирается
/// из брони вместе с именем гостя, а в «Colibri Lounge» — из обезличенного
/// зеркала занятости (reservationSlots), где чужих имён и телефонов нет и
/// быть не может. Раньше гостю передавали сами брони, и экран падал на
/// запросе к чужим документам.
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

/// Карта зала для выбора стола при создании брони.
///
/// Один и тот же виджет используется и на POS (сотрудник видит имя гостя
/// в каждой брони), и в «Colibri Lounge» (гость видит только время занятости
/// чужих столов). Что именно подписать — решает вызывающий экран через
/// [TableBusyInterval.description], поэтому имена и телефоны других гостей
/// физически не попадают в клиентское приложение.
///
/// Свободность стола считается по уже загруженному списку [freeTableIds]
/// (обычно результат ReservationService.availableTables на нужный интервал —
/// там же учтены и живые сеансы, а не только брони), а подписи на плитках —
/// по [busyIntervals] (занятость на выбранный день).
class TablePickerMap extends StatelessWidget {
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
  static const _tileSize = 84.0;

  @override
  Widget build(BuildContext context) {
    if (tables.isEmpty) {
      return const Center(child: Text('Столы ещё не добавлены'));
    }
    return LayoutBuilder(
      builder: (context, constraints) {
        final w = constraints.maxWidth;
        final h = constraints.hasBoundedHeight ? constraints.maxHeight : 360.0;
        return SizedBox(
          width: w,
          height: h,
          child: Stack(
            children: tables.map((t) {
              final free = freeTableIds.contains(t.id);
              final selected = t.id == selectedTableId;
              final color = selected ? _selectedColor : (free ? _freeColor : _busyColor);
              return Positioned(
                left: (t.x * (w - _tileSize)).clamp(0, w - _tileSize),
                top: (t.y * (h - _tileSize)).clamp(0, h - _tileSize),
                child: GestureDetector(
                  onTap: () => _openInfo(context, t, free),
                  child: Container(
                    width: _tileSize,
                    height: _tileSize,
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: 0.18),
                      border: Border.all(color: color, width: selected ? 3 : 2),
                      borderRadius: t.shape == 'circle'
                          ? BorderRadius.circular(_tileSize)
                          : BorderRadius.circular(14),
                    ),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          selected ? Icons.check_circle : Icons.table_restaurant,
                          color: color,
                          size: 20,
                        ),
                        const SizedBox(height: 4),
                        Text(t.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
                        Text('${t.seats} мест', style: const TextStyle(fontSize: 10)),
                      ],
                    ),
                  ),
                ),
              );
            }).toList(),
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
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(table.name, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              Text('${table.seats} мест', style: const TextStyle(color: Colors.grey)),
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
