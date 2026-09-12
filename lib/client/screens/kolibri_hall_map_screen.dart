import 'package:flutter/material.dart';
import '../../models/table_model.dart';
import '../../services/firestore_service.dart';
import '../../services/guest_link_service.dart';
import '../services/kolibri_auth_service.dart';
import '../theme/kolibri_theme.dart';

/// Карта зала для гостя — та же схема столов, что видит кальянщик на POS,
/// в реальном времени.
///
/// Что можно сделать:
///  • свободный стол — посмотреть вместимость (бронировать через «Бронь»);
///  • занятый стол — открыть свой счёт, если это ваш стол.
///
/// Гость не может «занять» стол сам: чек открывает кальянщик. Поэтому
/// нажатие на занятый стол только привязывает гостя к уже открытому чеку.
class KolibriHallMapScreen extends StatelessWidget {
  /// true — режим выбора стола (для брони): возвращает выбранный стол.
  final bool pickMode;

  const KolibriHallMapScreen({super.key, this.pickMode = false});

  @override
  Widget build(BuildContext context) {
    final fs = FirestoreService();

    return Scaffold(
      appBar: AppBar(title: Text(pickMode ? 'Выберите стол' : 'Карта зала')),
      body: StreamBuilder<List<TableModel>>(
        stream: fs.tablesStream(),
        builder: (context, snap) {
          if (snap.hasError) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(32),
                child: Text('Не удалось загрузить карту зала',
                    style: TextStyle(color: KolibriColors.textMuted)),
              ),
            );
          }
          if (!snap.hasData) {
            return const Center(child: CircularProgressIndicator());
          }

          final tables = snap.data!;
          if (tables.isEmpty) {
            return const Center(
              child: Text('Столы ещё не добавлены',
                  style: TextStyle(color: KolibriColors.textMuted)),
            );
          }

          final free = tables.where((t) => t.activeSessionIds.isEmpty).length;

          return Column(
            children: [
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
                child: LayoutBuilder(
                  builder: (context, constraints) {
                    // Координаты столов хранятся долями от 0 до 1 — та же
                    // раскладка, что в редакторе зала на POS, поэтому карта
                    // совпадает с реальным залом на любом размере экрана.
                    return Stack(
                      children: tables
                          .map((t) => Positioned(
                                left: t.x * (constraints.maxWidth - 96),
                                top: t.y * (constraints.maxHeight - 96),
                                child: _tableTile(context, t),
                              ))
                          .toList(),
                    );
                  },
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
          Text(text, style: const TextStyle(color: KolibriColors.textMuted, fontSize: 13)),
        ],
      );

  Widget _tableTile(BuildContext context, TableModel table) {
    final busy = table.activeSessionIds.isNotEmpty;
    final color = busy ? KolibriColors.accent : KolibriColors.primary;

    return InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: () => _onTap(context, table, busy),
      child: Container(
        width: 92,
        height: 92,
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: color, width: 2),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(busy ? Icons.local_fire_department : Icons.table_restaurant,
                color: color, size: 22),
            const SizedBox(height: 6),
            Text(
              table.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
            ),
            Text('${table.seats} мест',
                style: const TextStyle(color: KolibriColors.textMuted, fontSize: 11)),
          ],
        ),
      ),
    );
  }

  Future<void> _onTap(BuildContext context, TableModel table, bool busy) async {
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

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: KolibriColors.surface,
        title: Text('Это ваш стол?'),
        content: Text(
          'За столом ${table.name} открыт счёт. Если вы сидите за ним, '
          'откроем ваш счёт и кнопки вызова кальянщика.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Нет')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Да, мой')),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;

    final auth = KolibriAuthService();
    final sessionId = await GuestLinkService().bindToTable(auth.uid, table.id);
    if (!context.mounted) return;

    if (sessionId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Стол уже освободился — обновите карту')),
      );
      return;
    }
    Navigator.pop(context, table);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Готово! Ваш счёт открыт на вкладке «Мой стол»')),
    );
  }
}
