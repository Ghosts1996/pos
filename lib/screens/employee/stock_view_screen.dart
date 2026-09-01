import 'package:flutter/material.dart';
import '../../models/inventory_models.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';

/// Остатки склада — только для просмотра. Сотрудник видит те же позиции
/// и количества, что и админ на вкладке «Остатки», но без возможности
/// заводить, редактировать, удалять позиции или проводить приход/списание
/// вручную — эти действия остаются в админке ([InventoryScreen]) и в
/// процессе инвентаризации ([InventoryCountEntryScreen]), чтобы остатки
/// менялись только контролируемо.
class StockViewScreen extends StatefulWidget {
  const StockViewScreen({super.key});

  @override
  State<StockViewScreen> createState() => _StockViewScreenState();
}

class _StockViewScreenState extends State<StockViewScreen> {
  final _fs = FirestoreService();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Остатки склада')),
      body: StreamBuilder<List<InventoryItem>>(
        stream: _fs.inventoryItemsStream(),
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final all = snap.data!.where((i) => i.active).toList();
          if (all.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  'Позиций склада пока нет.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: AppColors.textMuted),
                ),
              ),
            );
          }

          final lowCount = all.where((i) => i.isLow).length;
          final categories = all.map((i) => i.category).toSet().toList()
            ..sort((a, b) => a.compareTo(b));

          return ListView(
            padding: const EdgeInsets.only(bottom: 24),
            children: [
              if (lowCount > 0)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                  child: Row(
                    children: [
                      const Icon(Icons.warning_amber_rounded, size: 16, color: AppColors.warning),
                      const SizedBox(width: 6),
                      Text(
                        'Мало на складе: $lowCount',
                        style: const TextStyle(color: AppColors.warning, fontSize: 13, fontWeight: FontWeight.w600),
                      ),
                    ],
                  ),
                ),
              for (final cat in categories) ...[
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
                  child: Text(
                    cat.isEmpty ? 'Без категории' : cat,
                    style: const TextStyle(
                      color: AppColors.textMuted,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.4,
                    ),
                  ),
                ),
                ...all.where((i) => i.category == cat).map((item) => _ItemTile(item: item)),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _ItemTile extends StatelessWidget {
  final InventoryItem item;
  const _ItemTile({required this.item});

  @override
  Widget build(BuildContext context) {
    final qtyColor = item.isLow ? AppColors.danger : AppColors.textPrimary;
    return ListTile(
      leading: Icon(
        item.isLow ? Icons.warning_amber_rounded : Icons.inventory_2_outlined,
        color: item.isLow ? AppColors.warning : AppColors.textMuted,
      ),
      title: Text(item.name),
      subtitle: item.minQuantity > 0 ? Text('мин. ${item.unit.formatWithLabel(item.minQuantity)}') : null,
      trailing: Text(
        item.unit.formatWithLabel(item.quantity),
        style: TextStyle(color: qtyColor, fontWeight: FontWeight.w700, fontSize: 15),
      ),
    );
  }
}