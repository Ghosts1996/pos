import '../theme/app_colors.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import '../utils/constants.dart';

/// Живой countdown-таймер. Считает от plannedEnd локально на каждом устройстве,
/// поэтому все телефоны показывают одно и то же время без доп. нагрузки на Firestore.
class TimerDisplay extends StatefulWidget {
  final DateTime plannedEnd;
  final double fontSize;
  const TimerDisplay({super.key, required this.plannedEnd, this.fontSize = 40});

  @override
  State<TimerDisplay> createState() => _TimerDisplayState();
}

class _TimerDisplayState extends State<TimerDisplay> {
  late Timer _ticker;
  Duration _remaining = Duration.zero;

  @override
  void initState() {
    super.initState();
    _update();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) => _update());
  }

  @override
  void didUpdateWidget(covariant TimerDisplay oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.plannedEnd != widget.plannedEnd) {
      _update();
    }
  }

  void _update() {
    setState(() {
      _remaining = widget.plannedEnd.difference(DateTime.now());
    });
  }

  @override
  void dispose() {
    _ticker.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isOver = _remaining.isNegative;
    final absDur = isOver ? -_remaining : _remaining;
    final h = absDur.inHours;
    final m = absDur.inMinutes % 60;
    final s = absDur.inSeconds % 60;
    final text =
        '${isOver ? "-" : ""}${h > 0 ? "${h.toString().padLeft(2, '0')}:" : ""}${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';

    Color color;
    if (isOver) {
      color = AppColors.danger;
    } else if (_remaining.inMinutes < AppConstants.warningThresholdMinutes) {
      color = Colors.orange;
    } else {
      color = Colors.green;
    }

    return Text(
      text,
      style: TextStyle(
        fontSize: widget.fontSize,
        fontWeight: FontWeight.bold,
        color: color,
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
    );
  }
}
