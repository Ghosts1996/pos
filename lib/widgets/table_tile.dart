import '../theme/app_colors.dart';
import 'package:flutter/material.dart';
import '../models/table_model.dart';
import 'timer_display.dart';
import '../utils/constants.dart';

/// Плитка стола на карте зала (используется и в админке, и у сотрудника)
class TableTile extends StatelessWidget {
  final TableModel table;
  final DateTime? plannedEnd; // если стол занят — время окончания ближайшего чека
  final VoidCallback? onTap;
  final bool isDraggablePreview;
  final int checkCount; // сколько чеков сейчас открыто на столе

  const TableTile({
    super.key,
    required this.table,
    this.plannedEnd,
    this.onTap,
    this.isDraggablePreview = false,
    this.checkCount = 1,
  });

  @override
  Widget build(BuildContext context) {
    final occupied = table.status == 'occupied';
    final bool nearEnd = occupied &&
        plannedEnd != null &&
        plannedEnd!.difference(DateTime.now()).inMinutes < AppConstants.warningThresholdMinutes;
    final bool overdue = occupied && plannedEnd != null && plannedEnd!.isBefore(DateTime.now());

    Color bg;
    if (!occupied) {
      bg = Colors.green.shade400;
    } else if (overdue) {
      bg = AppColors.danger;
    } else if (nearEnd) {
      bg = Colors.orange.shade400;
    } else {
      bg = AppColors.selection;
    }

    final tile = Container(
      width: 96,
      height: 96,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: table.shape == 'circle'
            ? BorderRadius.circular(48)
            : BorderRadius.circular(12),
        boxShadow: [
          BoxShadow(color: Colors.black.withOpacity(0.25), blurRadius: 4, offset: const Offset(0, 2)),
        ],
        border: isDraggablePreview ? Border.all(color: Colors.white, width: 2) : null,
      ),
      padding: const EdgeInsets.all(6),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            table.name,
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 14),
          ),
          Text('${table.seats} мест', style: const TextStyle(color: Colors.white70, fontSize: 10)),
          if (occupied && plannedEnd != null) ...[
            const SizedBox(height: 4),
            TimerDisplay(plannedEnd: plannedEnd!, fontSize: 13),
          ],
        ],
      ),
    );

    return GestureDetector(
      onTap: onTap,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          tile,
          // Бейдж числа открытых чеков — виден только когда на столе больше
          // одного одновременного счёта (см. TableModel.maxOpenSessions).
          if (occupied && checkCount > 1)
            Positioned(
              right: -4,
              top: -4,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: AppColors.background,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Colors.white, width: 1.5),
                ),
                child: Text(
                  '$checkCount',
                  style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.bold),
                ),
              ),
            ),
        ],
      ),
    );
  }
}