import 'package:flutter/material.dart';

import '../models/hall_label.dart';
import '../models/hall_wall.dart';
import '../services/firestore_service.dart';

/// Стены и подписи зоны [zone] ('' — без зоны) для схемы зала: как их
/// нарисовал администратор в редакторе. Подписки общие (SharedStreams), так
/// что несколько схем на экране не множат запросы.
class HallDrawingBuilder extends StatefulWidget {
  final String zone;
  final Widget Function(BuildContext context, List<HallWall> walls, List<HallLabel> labels) builder;

  const HallDrawingBuilder({super.key, required this.zone, required this.builder});

  @override
  State<HallDrawingBuilder> createState() => _HallDrawingBuilderState();
}

class _HallDrawingBuilderState extends State<HallDrawingBuilder> {
  late final Stream<List<HallWall>> _walls = FirestoreService().hallWallsStream();
  late final Stream<List<HallLabel>> _labels = FirestoreService().hallLabelsStream();

  @override
  Widget build(BuildContext context) => StreamBuilder<List<HallWall>>(
        stream: _walls,
        builder: (context, walls) => StreamBuilder<List<HallLabel>>(
          stream: _labels,
          builder: (context, labels) => widget.builder(
            context,
            [
              for (final w in walls.data ?? const <HallWall>[])
                if (w.zone == widget.zone) w,
            ],
            [
              for (final l in labels.data ?? const <HallLabel>[])
                if (l.zone == widget.zone) l,
            ],
          ),
        ),
      );
}
