import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/inventory_models.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/adaptive.dart';
import '../../utils/recipe_math.dart';
import '../../utils/table_label.dart';
import '../../widgets/recipe_editor.dart';

/// Карточка одной позиции склада: текущий остаток, быстрые действия
/// (приход / списание / ручная корректировка на точное значение),
/// редактирование описания, включение/отключение отслеживания, удаление
/// и полная история движений по этой позиции.
class InventoryItemDetailScreen extends StatelessWidget {
  final String itemId;
  final Employee employee;
  const InventoryItemDetailScreen({super.key, required this.itemId, required this.employee});

  @override
  Widget build(BuildContext context) {
    final fs = FirestoreService();
    return Scaffold(
      body: CenteredBody(
        maxWidth: 900,
        child: StreamBuilder<InventoryItem?>(
          stream: fs.inventoryItemStream(itemId),
          builder: (context, snap) {
            if (!snap.hasData) return const Center(child: CircularProgressIndicator());
            final item = snap.data;
            if (item == null) {
              return const Center(child: Text('Позиция удалена'));
            }
            return CustomScrollView(
              slivers: [
                SliverAppBar(
                  title: Text(item.name),
                  floating: true,
                  actions: [
                    IconButton(
                      icon: const Icon(Icons.edit_outlined),
                      tooltip: 'Редактировать',
                      onPressed: () => _editItem(context, fs, item),
                    ),
                    IconButton(
                      icon: const Icon(Icons.delete_outline),
                      tooltip: 'Удалить',
                      onPressed: () => _confirmDelete(context, fs, item),
                    ),
                  ],
                ),
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Card(
                          child: Padding(
                            padding: const EdgeInsets.all(20),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        item.category.isEmpty ? 'Без категории' : item.category,
                                        style: TextStyle(color: AppColors.textMuted),
                                      ),
                                    ),
                                    Row(
                                      children: [
                                        Text(
                                          item.active ? 'Отслеживается' : 'Отключена',
                                          style: TextStyle(color: AppColors.textMuted, fontSize: 13),
                                        ),
                                        Switch(
                                          value: item.active,
                                          onChanged: (v) => fs.setInventoryItemActive(item.id, v),
                                        ),
                                      ],
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  item.unit.formatWithLabel(item.quantity),
                                  style: TextStyle(
                                    fontSize: 36,
                                    fontWeight: FontWeight.w800,
                                    color: item.isLow ? AppColors.danger : AppColors.textPrimary,
                                  ),
                                ),
                                if (item.isLow)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 4),
                                    child: Row(
                                      children: [
                                        Icon(Icons.warning_amber_rounded, size: 16, color: AppColors.warning),
                                        const SizedBox(width: 6),
                                        Text('Мало на складе (порог ${item.unit.formatWithLabel(item.minQuantity)})',
                                            style: TextStyle(color: AppColors.warning, fontSize: 13)),
                                      ],
                                    ),
                                  ),
                                if (item.note.isNotEmpty) ...[
                                  const SizedBox(height: 12),
                                  Text(item.note, style: TextStyle(color: AppColors.textMuted)),
                                ],
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(height: 16),
                        Row(
                          children: [
                            Expanded(
                              child: OutlinedButton.icon(
                                icon: Icon(Icons.add, color: AppColors.success),
                                label: const Text('Приход'),
                                onPressed: () => _adjustDialog(context, fs, item, type: 'receipt'),
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: OutlinedButton.icon(
                                icon: Icon(Icons.remove, color: AppColors.danger),
                                label: const Text('Списание'),
                                onPressed: () => _adjustDialog(context, fs, item, type: 'writeoff'),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        SizedBox(
                          width: double.infinity,
                          child: TextButton.icon(
                            icon: const Icon(Icons.tune),
                            label: const Text('Скорректировать остаток вручную'),
                            onPressed: () => _correctionDialog(context, fs, item),
                          ),
                        ),
                        const SizedBox(height: 8),
                        _PreparedCard(item: item, employee: employee),
                        const SizedBox(height: 24),
                        Text('История движений',
                            style: TextStyle(color: AppColors.textMuted, fontWeight: FontWeight.w600)),
                      ],
                    ),
                  ),
                ),
                StreamBuilder<List<InventoryMovement>>(
                  stream: fs.inventoryMovementsStream(item.id),
                  builder: (context, moveSnap) {
                    final moves = moveSnap.data ?? [];
                    if (!moveSnap.hasData) {
                      return const SliverToBoxAdapter(
                        child: Padding(
                          padding: EdgeInsets.all(24),
                          child: Center(child: CircularProgressIndicator()),
                        ),
                      );
                    }
                    if (moves.isEmpty) {
                      return SliverToBoxAdapter(
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                          child: Text('Движений пока не было', style: TextStyle(color: AppColors.textMuted)),
                        ),
                      );
                    }
                    return SliverPadding(
                      padding: const EdgeInsets.only(bottom: 24),
                      sliver: SliverList(
                        delegate: SliverChildBuilderDelegate(
                          (context, i) => _MovementTile(move: moves[i]),
                          childCount: moves.length,
                        ),
                      ),
                    );
                  },
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Future<void> _adjustDialog(
    BuildContext context,
    FirestoreService fs,
    InventoryItem item, {
    required String type, // receipt | writeoff
  }) async {
    final amountCtrl = TextEditingController();
    final reasonCtrl = TextEditingController();
    final costCtrl = TextEditingController();
    final isReceipt = type == 'receipt';
    const reasons = ['Порча / истёк срок', 'Бой / брак', 'Питание персонала', 'Угощение гостю', 'Проработка блюда'];
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSt) => AlertDialog(
          scrollable: true,
          title: Text(isReceipt ? 'Приход: ${item.name}' : 'Списание: ${item.name}'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: amountCtrl,
                autofocus: true,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: InputDecoration(labelText: 'Количество, ${item.unit.label}'),
              ),
              const SizedBox(height: 12),
              if (isReceipt)
                TextField(
                  controller: costCtrl,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: InputDecoration(
                    labelText: 'Цена закупки, ₽ за ${item.unit.priceUnit.label} (если изменилась)',
                    helperText: item.costPrice > 0
                        ? 'Сейчас ${item.costPrice.toStringAsFixed(item.costPrice % 1 == 0 ? 0 : 2)} ₽ — по ней считается себестоимость'
                        : 'По ней считается себестоимость и фудкост блюд',
                  ),
                )
              else
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final r in reasons)
                      ChoiceChip(
                        label: Text(r, style: const TextStyle(fontSize: 12)),
                        selected: reasonCtrl.text == r,
                        onSelected: (_) => setSt(() => reasonCtrl.text = r),
                      ),
                  ],
                ),
              const SizedBox(height: 12),
              TextField(
                controller: reasonCtrl,
                onChanged: (_) => setSt(() {}),
                decoration: InputDecoration(
                  labelText: isReceipt ? 'Комментарий (необязательно)' : 'Причина',
                  hintText: isReceipt ? 'Например, поставка от 12.05, накладная №' : 'Или своя причина',
                ),
              ),
              if (!isReceipt)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text('Продажи списываются сами по рецептам — здесь только то, что ушло мимо кассы.',
                      style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
                ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Сохранить')),
          ],
        ),
      ),
    );
    if (ok != true) return;
    final amount = double.tryParse(amountCtrl.text.trim().replaceAll(',', '.'));
    if (amount == null || amount <= 0) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Введите количество больше нуля')));
      }
      return;
    }
    await fs.adjustInventoryQuantity(
      itemId: item.id,
      itemName: item.name,
      unit: item.unit,
      delta: isReceipt ? amount : -amount,
      type: type,
      employeeName: employee.name,
      reason: reasonCtrl.text.trim(),
    );
    final cost = double.tryParse(costCtrl.text.trim().replaceAll(',', '.'));
    if (isReceipt && cost != null && cost > 0 && (cost - item.costPrice).abs() > 0.004) {
      await fs.updateInventoryItem(item.copyWith(costPrice: cost));
    }
  }

  Future<void> _correctionDialog(BuildContext context, FirestoreService fs, InventoryItem item) async {
    final valueCtrl = TextEditingController(text: item.unit.format(item.quantity));
    final reasonCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        scrollable: true,
        title: Text('Скорректировать остаток: ${item.name}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Сейчас: ${item.unit.formatWithLabel(item.quantity)}',
                style: TextStyle(color: AppColors.textMuted)),
            const SizedBox(height: 12),
            TextField(
              controller: valueCtrl,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: InputDecoration(labelText: 'Новый остаток, ${item.unit.label}'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: reasonCtrl,
              decoration: const InputDecoration(labelText: 'Причина (необязательно)'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Сохранить')),
        ],
      ),
    );
    if (ok != true) return;
    final newValue = double.tryParse(valueCtrl.text.trim().replaceAll(',', '.'));
    if (newValue == null || newValue < 0) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Введите корректное число')));
      }
      return;
    }
    final delta = newValue - item.quantity;
    if (delta == 0) return;
    await fs.adjustInventoryQuantity(
      itemId: item.id,
      itemName: item.name,
      unit: item.unit,
      delta: delta,
      type: 'correction',
      employeeName: employee.name,
      reason: reasonCtrl.text.trim(),
    );
  }

  Future<void> _editItem(BuildContext context, FirestoreService fs, InventoryItem item) async {
    final nameCtrl = TextEditingController(text: item.name);
    final categoryCtrl = TextEditingController(text: item.category);
    final minCtrl =
        TextEditingController(text: item.minQuantity > 0 ? item.unit.format(item.minQuantity) : '');
    final noteCtrl = TextEditingController(text: item.note);
    InventoryUnit unit = item.unit;

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSt) {
        return AlertDialog(
          title: const Text('Редактировать позицию'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(controller: nameCtrl, decoration: const InputDecoration(labelText: 'Название')),
                const SizedBox(height: 12),
                TextField(controller: categoryCtrl, decoration: const InputDecoration(labelText: 'Категория')),
                const SizedBox(height: 12),
                DropdownButtonFormField<InventoryUnit>(
                  initialValue: unit,
                  decoration: const InputDecoration(labelText: 'Единица измерения'),
                  items: InventoryUnit.values
                      .map((u) => DropdownMenuItem(value: u, child: Text(u.fullLabel)))
                      .toList(),
                  onChanged: (v) {
                    if (v == null || v == unit) return;
                    // Порог введён в старой единице — при смене единицы
                    // пересчитываем и его, иначе то же число молча стало бы
                    // означать другую величину (например, порог "200" (г)
                    // превратился бы в порог "200" (кг)). Сам остаток
                    // пересчитывает FirestoreService.updateInventoryItem.
                    final oldMin = double.tryParse(minCtrl.text.trim().replaceAll(',', '.'));
                    setSt(() {
                      if (oldMin != null && oldMin > 0) {
                        minCtrl.text = v.format(unit.convertTo(oldMin, v));
                      }
                      unit = v;
                    });
                  },
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: minCtrl,
                  decoration: const InputDecoration(labelText: 'Порог «мало на складе» (необязательно)'),
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                ),
                const SizedBox(height: 12),
                TextField(controller: noteCtrl, decoration: const InputDecoration(labelText: 'Заметка')),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Сохранить')),
          ],
        );
      }),
    );
    if (ok != true || nameCtrl.text.trim().isEmpty) return;
    final minQty = double.tryParse(minCtrl.text.trim().replaceAll(',', '.')) ?? 0;
    await fs.updateInventoryItem(item.copyWith(
      name: nameCtrl.text.trim(),
      category: categoryCtrl.text.trim(),
      unit: unit,
      minQuantity: minQty,
      note: noteCtrl.text.trim(),
    ));
  }

  Future<void> _confirmDelete(BuildContext context, FirestoreService fs, InventoryItem item) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        scrollable: true,
        title: const Text('Удалить позицию?'),
        content: Text(
            '«${item.name}» и её остаток будут удалены. История движений останется в базе, но больше не будет привязана к позиции. Это действие нельзя отменить.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Удалить'),
          ),
        ],
      ),
    );
    if (confirm == true) {
      await fs.deleteInventoryItem(item.id);
      if (context.mounted) Navigator.of(context).pop();
    }
  }
}

class _MovementTile extends StatelessWidget {
  final InventoryMovement move;
  const _MovementTile({required this.move});

  @override
  Widget build(BuildContext context) {
    final positive = move.delta > 0;
    final color = move.delta == 0
        ? AppColors.textMuted
        : (positive ? AppColors.success : AppColors.danger);
    final sign = positive ? '+' : '';
    return ListTile(
      leading: Icon(
        switch (move.type) {
          'receipt' => Icons.call_received,
          'writeoff' => Icons.call_made,
          'count' => Icons.fact_check_outlined,
          'production' => Icons.soup_kitchen_outlined,
          'refund' => Icons.undo,
          _ => Icons.tune,
        },
        color: color,
      ),
      title: Text('${move.typeLabel} · $sign${move.unit.formatWithLabel(move.delta)}'),
      subtitle: Text(
        [
          _fmtDate(move.createdAt),
          move.employeeName,
          if (move.reason.isNotEmpty) move.reason,
        ].join(' · '),
      ),
      trailing: Text('= ${move.unit.formatWithLabel(move.resultingQty)}',
          style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
    );
  }

  String _fmtDate(DateTime d) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(d.day)}.${two(d.month)} ${two(d.hour)}:${two(d.minute)}';
  }
}
/// Заготовка (полуфабрикат): свой рецепт и кнопка «Приготовить». У обычного
/// продукта — предложение сделать его заготовкой.
class _PreparedCard extends StatelessWidget {
  final InventoryItem item;
  final Employee employee;
  const _PreparedCard({required this.item, required this.employee});

  @override
  Widget build(BuildContext context) {
    if (!item.isPrepared) {
      return SizedBox(
        width: double.infinity,
        child: TextButton.icon(
          icon: const Icon(Icons.soup_kitchen_outlined),
          label: const Text('Сделать заготовкой — готовим сами по рецепту'),
          onPressed: () => _editRecipe(context),
        ),
      );
    }
    final n = item.recipe.length;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Icon(Icons.soup_kitchen_outlined, color: AppColors.primary),
              const SizedBox(width: 10),
              const Expanded(child: Text('Заготовка', style: TextStyle(fontWeight: FontWeight.w700))),
            ]),
            const SizedBox(height: 6),
            Text('Рецепт: $n ${pluralRu(n, 'продукт', 'продукта', 'продуктов')} '
                'на ${item.unit.formatWithLabel(item.recipeOutput)}',
                style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(
                child: OutlinedButton.icon(
                  icon: const Icon(Icons.receipt_long_outlined, size: 18),
                  label: const Text('Рецепт'),
                  onPressed: () => _editRecipe(context),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton.icon(
                  icon: const Icon(Icons.local_fire_department_outlined, size: 18),
                  label: const Text('Приготовить'),
                  onPressed: () => _produce(context),
                ),
              ),
            ]),
          ],
        ),
      ),
    );
  }

  Future<void> _editRecipe(BuildContext context) async {
    final r = await openRecipeEditor(context, title: 'Заготовка: ${item.name}', lines: item.recipe, prepared: item);
    if (r == null) return;
    await FirestoreService().updatePreparedRecipe(item.id, r.lines, r.lines.isEmpty ? 0 : r.output);
  }

  Future<void> _produce(BuildContext context) async {
    final fs = FirestoreService();
    final all = await fs.inventoryItemsStream().first;
    if (!context.mounted) return;
    final stock = {for (final i in all) i.id: i};
    final ctrl = TextEditingController(text: item.unit.format(item.recipeOutput));
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSt) {
        final out = double.tryParse(ctrl.text.trim().replaceAll(',', '.')) ?? 0;
        final draws = productionDraws(item, out, stock);
        return AlertDialog(
          scrollable: true,
          title: Text('Приготовить: ${item.name}'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: ctrl,
                autofocus: true,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: InputDecoration(labelText: 'Сколько приготовили, ${item.unit.label}'),
                onChanged: (_) => setSt(() {}),
              ),
              const SizedBox(height: 12),
              if (draws.isNotEmpty) ...[
                const Text('Спишется со склада:', style: TextStyle(fontWeight: FontWeight.w600)),
                for (final e in draws.entries)
                  Text(
                    '• ${stock[e.key]!.name} — ${stock[e.key]!.unit.formatWithLabel(e.value)}'
                    '${stock[e.key]!.quantity < e.value ? ' (на складе ${stock[e.key]!.unit.formatWithLabel(stock[e.key]!.quantity)})' : ''}',
                    style: TextStyle(
                        fontSize: 13, color: stock[e.key]!.quantity < e.value ? AppColors.warning : null),
                  ),
              ],
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
            FilledButton(onPressed: out > 0 ? () => Navigator.pop(ctx, true) : null, child: const Text('Приготовили')),
          ],
        );
      }),
    );
    final out = double.tryParse(ctrl.text.trim().replaceAll(',', '.')) ?? 0;
    if (ok != true || out <= 0) return;
    await fs.producePrepared(item, out, employeeName: employee.name);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('${item.name}: +${item.unit.formatWithLabel(out)}, продукты списаны')));
    }
  }
}
