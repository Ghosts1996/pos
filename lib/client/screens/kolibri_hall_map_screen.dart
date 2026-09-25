import 'package:flutter/material.dart';
import '../../models/table_model.dart';
import '../../services/firestore_service.dart';
import '../theme/kolibri_theme.dart';

/// Карта зала для гостя — та же схема столов, что видит кальянщик на POS,
/// в реальном времени. Только просмотр занятости.
///
/// Что можно сделать:
///  • свободный стол — посмотреть вместимость (бронировать через «Бронь»);
///  • занятый стол — подсказка отсканировать QR на нём.
///
/// Открыть свой счёт с карты нельзя специально: раньше нажатие на занятый
/// стол сразу привязывало гостя к чужому счёту без физического
/// присутствия — счёт можно было «занять» удалённо. Единственный способ
/// сесть за стол — отсканировать QR-код, наклеенный физически на столе.
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
    // Круглый/квадратный — как в редакторе зала на кассе (см. TableTile и
    // TablePickerMap): radius = размер плитки даёт идеальный круг, Flutter
    // сам ограничивает его половиной стороны.
    final radius = table.shape == 'circle' ? BorderRadius.circular(92) : BorderRadius.circular(16);

    return InkWell(
      borderRadius: radius,
      onTap: () => _onTap(context, table, busy),
      child: Container(
        width: 92,
        height: 92,
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.15),
          borderRadius: radius,
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

  /// Карта — только просмотр занятости. Открыть свой счёт можно исключительно
  /// сканированием QR на самом столе: раньше нажатие на занятый стол на карте
  /// само привязывало гостя к чужому счёту без физического присутствия —
  /// этим можно было «сесть» за стол удалённо, просто открыв карту из дома.
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
