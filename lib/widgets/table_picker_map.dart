import 'package:flutter/material.dart';
import '../models/reservation_model.dart';
import '../models/table_model.dart';

/// Карта зала для выбора стола при создании брони.
///
/// Один и тот же виджет используется и на POS (сотрудник видит имя гостя
/// в каждой брони), и в «Колибри Лаундж» (гость видит только время занятости
/// чужих столов — [showGuestNames] = false, имена и телефоны других гостей
/// клиенту не показываем).
///
/// Свободность стола считается по уже загруженному списку [freeTableIds]
/// (обычно результат ReservationService.availableTables на нужный интервал —
/// там же учтены и живые сеансы, а не только брони), а подписи на плитках —
/// по [dayReservations] (брони на выбранный день, для показа «когда занят»).
class TablePickerMap extends StatelessWidget {
  final List<TableModel> tables;
  final Set<String> freeTableIds;
  final List<ReservationModel> dayReservations;
  final DateTime start;
  final int durationMinutes;
  final String? selectedTableId;
  final bool showGuestNames;
  final ValueChanged<TableModel> onSelect;

  const TablePickerMap({
    super.key,
    required this.tables,
    required this.freeTableIds,
    required this.dayReservations,
    required this.start,
    required this.durationMinutes,
    required this.onSelect,
    this.selectedTableId,
    this.showGuestNames = false,
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
    final todays = dayReservations.where((r) => r.tableId == table.id).toList()
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
                const Text('На этот день броней нет')
              else ...[
                const Text('Занятость на этот день:',
                    style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                ...todays.map((r) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 3),
                      child: Text(
                        showGuestNames
                            ? '${_fmt(r.startTime)}–${_fmt(r.endTime)} · ${r.guestName} · '
                                '${r.guestsCount} чел · ${r.status.label}'
                            : '${_fmt(r.startTime)}–${_fmt(r.endTime)} занято',
                      ),
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
