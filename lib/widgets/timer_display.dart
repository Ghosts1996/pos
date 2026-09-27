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

  /// Начало сеанса. Если задано, стол «без ограничений» показывает не
  /// бессмысленное «∞», а сколько гости уже сидят.
  final DateTime? startTime;
  const TimerDisplay({super.key, required this.plannedEnd, this.fontSize = 40, this.startTime});

  /// «23 мин», «1 ч 05 мин» — сколько гости за столом.
  static String formatSat(Duration d) {
    final m = d.inMinutes < 0 ? 0 : d.inMinutes;
    if (m < 60) return '$m мин';
    return '${m ~/ 60} ч ${(m % 60).toString().padLeft(2, '0')} мин';
  }

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
        // "Без ограничений" (см. AppConstants.unlimitedSessionMinutes) —
        // сеанс на 10 лет вперёд вместо nullable plannedEnd, поэтому здесь
        // просто показываем текст вместо отсчёта, а не "-3650:00:00". На
        // маленькой плитке зала (fontSize: 13) полная фраза не влезает —
        // там компактный "∞", полный текст только на крупном экране стола.
        if (AppConstants.isUnlimitedRemaining(remaining)) {
          if (startTime != null) {
            return Text(
              formatSat(now.difference(startTime!)),
              style: TextStyle(
                fontSize: fontSize,
                fontWeight: FontWeight.w600,
                color: Colors.white,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            );
          }
          final compact = fontSize <= 20;
          return Text(
            compact ? '∞' : 'Без ограничений',
            style: TextStyle(
              fontSize: compact ? fontSize : fontSize * 0.5,
              fontWeight: FontWeight.bold,
              color: Colors.green,
            ),
          );
        }
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
