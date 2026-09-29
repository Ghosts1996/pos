import 'package:flutter/material.dart';
import '../../services/venue_service.dart';
import '../../models/table_model.dart';
import '../../services/firestore_service.dart';
import '../theme/kolibri_theme.dart';
import '../../utils/hall_layout.dart';
import '../../utils/table_label.dart';
import '../../widgets/hall_plan_view.dart';
import '../../widgets/table_shape.dart';

/// Карта зала для гостя: схема столов с кассы в реальном времени, только
/// просмотр. Свободный стол — вместимость, занятый — подсказка про QR.
/// Сесть за стол можно только по QR на самом столе, чтобы счёт не
/// занимали удалённо.
class KolibriHallMapScreen extends StatefulWidget {
  /// true — режим выбора стола (для брони): возвращает выбранный стол.
  final bool pickMode;

  const KolibriHallMapScreen({super.key, this.pickMode = false});

  @override
  State<KolibriHallMapScreen> createState() => _KolibriHallMapScreenState();
}

class _KolibriHallMapScreenState extends State<KolibriHallMapScreen> {
  late final Stream<List<TableModel>> _tables = FirestoreService().tablesStream();

  /// Выбранная зона зала (терраса, VIP…): у каждой зоны своя схема.
  String? _zone;

  bool get pickMode => widget.pickMode;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(pickMode ? 'Выберите стол' : 'Карта зала')),
      body: StreamBuilder<List<TableModel>>(
        stream: _tables,
        builder: (context, snap) {
          if (snap.hasError) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Text('Не удалось загрузить карту зала',
                    style: TextStyle(color: KolibriColors.textMuted)),
              ),
            );
          }
          if (!snap.hasData) {
            return const Center(child: CircularProgressIndicator());
          }

          final all = snap.data!;
          if (all.isEmpty) {
            return Center(
              child: Text('Столы ещё не добавлены',
                  style: TextStyle(color: KolibriColors.textMuted)),
            );
          }

          final zones = hallZones(all);
          final zoneKeys = [...zones, if (zones.isNotEmpty && all.any((t) => t.zone.isEmpty)) ''];
          final zone = zoneKeys.isEmpty ? null : (zoneKeys.contains(_zone) ? _zone! : zoneKeys.first);
          final tables = zone == null ? all : all.where((t) => t.zone == zone).toList();
          final free = tables.where((t) => t.activeSessionIds.isEmpty).length;

          return Column(
            children: [
              if (zoneKeys.isNotEmpty)
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
                            label: Text(z.isEmpty ? kNoZoneLabel : z),
                            selected: z == zone,
                            onSelected: (_) => setState(() => _zone = z),
                          ),
                        ),
                    ],
                  ),
                ),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(14),
                color: KolibriColors.surface,
                child: Row(
                  children: [
                    _legend(KolibriColors.primary, 'Свободно: $free'),
                    const SizedBox(width: 20),
                    _legend(KolibriColors.accent, 'Занято: ${tables.length - free}'),
                  ],
                ),
              ),
              Expanded(
                // Та же схема, что расставил администратор на кассе, — на
                // одном логическом холсте для всех экранов (см.
                // hall_layout.dart): на телефоне её можно двигать пальцем.
                child: HallPlanView(
                  tables: tables,
                  floorColor: KolibriColors.surface,
                  lineColor: KolibriColors.border,
                  tileBuilder: (t) => _tableTile(context, t),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _legend(Color color, String text) => Row(
        children: [
          Container(
            width: 12,
            height: 12,
            decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(3)),
          ),
          const SizedBox(width: 8),
          Text(text, style: TextStyle(color: KolibriColors.textMuted, fontSize: 13)),
        ],
      );

  Widget _tableTile(BuildContext context, TableModel table) {
    final busy = table.activeSessionIds.isNotEmpty;
    final color = busy ? KolibriColors.accent : KolibriColors.primary;
    // Форма и поворот — как в редакторе зала на кассе (см. TableShapeBox):
    // длинные и треугольные столы гость видит так же, как их собрали.
    return GestureDetector(
      onTap: () => _onTap(context, table, busy),
      child: TableShapeBox(
        table: table,
        size: hallTileSize(table),
        fill: color.withValues(alpha: 0.15),
        borderColor: color,
        borderWidth: 2,
        cornerRadius: 16,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
                busy
                    ? (VenueService.instance.terms.isHookah ? Icons.local_fire_department : Icons.people)
                    : Icons.table_restaurant,
                color: color, size: 22),
            const SizedBox(height: 6),
            Text(
              table.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
            ),
            Text(seatsLabel(table.seats),
                style: TextStyle(color: KolibriColors.textMuted, fontSize: 11)),
          ],
        ),
      ),
    );
  }

  /// Только просмотр: открыть счёт можно лишь по QR на самом столе.
  void _onTap(BuildContext context, TableModel table, bool busy) {
    if (pickMode) {
      Navigator.pop(context, table);
      return;
    }

    if (!busy) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${table.name} свободен — забронируйте его на вкладке «Бронь»')),
      );
      return;
    }

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(
          'Это ваш стол? Отсканируйте QR-код на столе «${table.name}», чтобы открыть свой счёт.')),
    );
  }
}
