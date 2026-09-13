import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../utils/constants.dart';
import 'clock_ticker.dart';

/// Живой countdown-таймер. Считает от plannedEnd локально на каждом устройстве,
/// поэтому все телефоны показывают одно и то же время без доп. нагрузки на Firestore.
///
/// Тик берётся из общего [ClockTicker]: один таймер на приложение вместо
/// собственного у каждой плитки стола (см. комментарий в clock_ticker.dart).
class TimerDisplay extends StatelessWidget {
  final DateTime plannedEnd;
  final double fontSize;
  const TimerDisplay({super.key, required this.plannedEnd, this.fontSize = 40});

  /// Отформатированный остаток: «-05:12», «01:23:45».
  static String formatRemaining(Duration remaining) {
    final isOver = remaining.isNegative;
    final absDur = isOver ? -remaining : remaining;
    final h = absDur.inHours;
    final m = absDur.inMinutes % 60;
    final s = absDur.inSeconds % 60;
    return '${isOver ? "-" : ""}'
        '${h > 0 ? "${h.toString().padLeft(2, '0')}:" : ""}'
        '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }

  /// Цвет остатка: зелёный → оранжевый (< 15 мин) → красный (время вышло).
  static Color colorFor(Duration remaining) {
    if (remaining.isNegative) return AppColors.danger;
    if (remaining.inMinutes < AppConstants.warningThresholdMinutes) return Colors.orange;
    return Colors.green;
  }

  @override
  Widget build(BuildContext context) {
    return TickerBuilder(
      builder: (context, now) {
        final remaining = plannedEnd.difference(now);
        return Text(
          formatRemaining(remaining),
          style: TextStyle(
            fontSize: fontSize,
            fontWeight: FontWeight.bold,
            color: colorFor(remaining),
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        );
      },
    );
  }
}
