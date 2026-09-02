import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/inventory_models.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';
import 'inventory_item_detail_screen.dart';
import 'inventory_count_screen.dart';

/// Склад — отдельный от меню раздел админки. Позиции полностью
/// произвольные (заводит и убирает сам админ) и покрывают что угодно:
/// граммовку табака, литры/мл сиропов и алкоголя, штуки банок пива, угли,
/// расходники и т.д. Два раздела: "Остатки" (справочник + история
/// движений по каждой позиции) и "Инвентаризация" (периодическая сверка
/// фактических остатков со системными).
class InventoryScreen extends StatelessWidget {
  final Employee employee;
  const InventoryScreen({super.key, required this.employee});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Склад'),
          bottom: const TabBar(
            tabs: [
              Tab(text: 'Остатки'),
              Tab(text: 'Инвентаризация'),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            _StockTab(employee: employee),
            _CountTab(employee: employee),
          ],
        ),
      ),
    );
  }
}

// ==================== ОСТАТКИ ====================

class _StockTab extends StatefulWidget {
  final Employee employee;
  const _StockTab({required this.employee});

  @override
  State<_StockTab> createState() => _StockTabState();
}

class _StockTabState extends State<_StockTab> {
  final _fs = FirestoreService();
  bool _showInactive = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      floatingActionButton: FloatingActionButton(
        onPressed: () => _editItem(context, null),
        child: const Icon(Icons.add),
      ),
      body: StreamBuilder<List<InventoryItem>>(
        stream: _fs.inventoryItemsStream(),
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final all = snap.data!;
          if (all.isEmpty) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  'Позиций склада пока нет.\nНажмите «+», чтобы добавить первую — '
                  'например, сорт табака в граммах или пиво в банках.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: AppColors.textMuted),
                ),
              ),
            );
          }

          final inactiveCount = all.where((i) => !i.active).length;
          final visible = all.where((i) => i.active || _showInactive).toList();
          final categories = visible.map((i) => i.category).toSet().toList()
            ..sort((a, b) => a.compareTo(b));

          return ListView(
            padding: const EdgeInsets.only(bottom: 96),
            children: [
              if (inactiveCount > 0)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                  child: InkWell(
                    onTap: () => setState(() => _showInactive = !_showInactive),
                    child: Row(
                      children: [
                        Icon(
                          _showInactive ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                          size: 16,
                          color: AppColors.textMuted,
                        ),
                        const SizedBox(width: 6),
                        Text(
                          _showInactive
                              ? 'Скрыть отключённые ($inactiveCount)'
                              : 'Показать отключённые ($inactiveCount)',
                          style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
                        ),
                      ],
                    ),
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
                ...visible.where((i) => i.category == cat).map((item) => _ItemTile(
                      item: item,
                      onTap: () => Navigator.of(context).push(MaterialPageRoute(
                        builder: (_) => InventoryItemDetailScreen(itemId: item.id, employee: widget.employee),
                      )),
                    )),
              ],
            ],
          );
        },
      ),
    );
  }

  Future<void> _editItem(BuildContext context, InventoryItem? item) async {
    final existingCategories = await _fs.inventoryItemsStream().first.then(
        (items) => items.map((i) => i.category).where((c) => c.isNotEmpty).toSet().toList());

    final nameCtrl = TextEditingController(text: item?.name ?? '');
    final categoryCtrl = TextEditingController(text: item?.category ?? '');
    final minCtrl = TextEditingController(
        text: item != null && item.minQuantity > 0 ? item.unit.format(item.minQuantity) : '');
    final noteCtrl = TextEditingController(text: item?.note ?? '');
    InventoryUnit unit = item?.unit ?? InventoryUnit.pcs;

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSt) {
        return AlertDialog(
          title: Text(item == null ? 'Новая позиция склада' : 'Редактировать позицию'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                TextField(
                  controller: nameCtrl,
                  autofocus: true,
                  decoration: const InputDecoration(labelText: 'Название'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: categoryCtrl,
                  decoration: const InputDecoration(
                      labelText: 'Категория', hintText: 'Табак, Пиво, Бар…'),
                ),
                if (existingCategories.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: existingCategories
                          .map((c) => ActionChip(
                                label: Text(c, style: const TextStyle(fontSize: 12)),
                                onPressed: () => categoryCtrl.text = c,
                              ))
                          .toList(),
                    ),
                  ),
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
                    // превратился бы в порог "200" (кг)).
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
                  decoration: const InputDecoration(
                    labelText: 'Порог «мало на складе» (необязательно)',
                    hintText: 'Например, 200',
                  ),
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: noteCtrl,
                  decoration: const InputDecoration(labelText: 'Заметка (необязательно)'),
                ),
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

    if (item == null) {
      final newItem = InventoryItem(
        id: '',
        name: nameCtrl.text.trim(),
        category: categoryCtrl.text.trim(),
        unit: unit,
        quantity: 0,
        minQuantity: minQty,
        note: noteCtrl.text.trim(),
      );
      final id = await _fs.addInventoryItem(newItem);
      // Сразу предлагаем оприходовать стартовый остаток, чтобы не пришлось
      // отдельно заходить в карточку позиции ради первого прихода.
      if (context.mounted) {
        await Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => InventoryItemDetailScreen(itemId: id, employee: widget.employee),
        ));
      }
    } else {
      await _fs.updateInventoryItem(item.copyWith(
        name: nameCtrl.text.trim(),
        category: categoryCtrl.text.trim(),
        unit: unit,
        minQuantity: minQty,
        note: noteCtrl.text.trim(),
      ));
    }
  }
}

class _ItemTile extends StatelessWidget {
  final InventoryItem item;
  final VoidCallback onTap;
  const _ItemTile({required this.item, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final dimmed = !item.active;
    final qtyColor = dimmed
        ? AppColors.textMuted
        : (item.isLow ? AppColors.danger : AppColors.textPrimary);
    return ListTile(
      leading: Icon(
        item.isLow && !dimmed ? Icons.warning_amber_rounded : Icons.inventory_2_outlined,
        color: item.isLow && !dimmed ? AppColors.warning : AppColors.textMuted,
      ),
      title: Text(item.name, style: TextStyle(color: dimmed ? AppColors.textMuted : null)),
      subtitle: Text(
        [
          if (item.minQuantity > 0) 'мин. ${item.unit.formatWithLabel(item.minQuantity)}',
          if (dimmed) 'отключена',
        ].join(' · '),
      ),
      trailing: Text(
        item.unit.formatWithLabel(item.quantity),
        style: TextStyle(color: qtyColor, fontWeight: FontWeight.w700, fontSize: 15),
      ),
      onTap: onTap,
    );
  }
}

// ==================== ИНВЕНТАРИЗАЦИЯ ====================

class _CountTab extends StatelessWidget {
  final Employee employee;
  const _CountTab({required this.employee});

  @override
  Widget build(BuildContext context) {
    final fs = FirestoreService();
    return StreamBuilder<InventoryCount?>(
      stream: fs.openInventoryCountStream(),
      builder: (context, snap) {
        final open = snap.data;
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (open != null)
              Card(
                child: ListTile(
                  contentPadding: const EdgeInsets.all(16),
                  leading: const Icon(Icons.fact_check_outlined, color: AppColors.primary),
                  title: const Text('Инвентаризация в процессе'),
                  subtitle: Text(
                      'Посчитано ${open.countedCount} из ${open.totalCount} · начата ${_fmtDate(open.startedAt)} · ${open.startedBy}'),
                  trailing: FilledButton(
                    onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                      builder: (_) => InventoryCountScreen(countId: open.id, employee: employee),
                    )),
                    child: const Text('Продолжить'),
                  ),
                ),
              )
            else
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Новая инвентаризация', style: TextStyle(fontWeight: FontWeight.w700)),
                      const SizedBox(height: 6),
                      const Text(
                        'Зафиксирует текущие системные остатки всех активных позиций склада, '
                        'а дальше вы вводите фактически посчитанное количество по каждой — '
                        'расхождения применятся к остаткам после завершения.',
                        style: TextStyle(color: AppColors.textMuted, fontSize: 13),
                      ),
                      const SizedBox(height: 16),
                      FilledButton.icon(
                        onPressed: () async {
                          final id = await fs.startInventoryCount(employee.name);
                          if (context.mounted) {
                            Navigator.of(context).push(MaterialPageRoute(
                              builder: (_) => InventoryCountScreen(countId: id, employee: employee),
                            ));
                          }
                        },
                        icon: const Icon(Icons.playlist_add_check),
                        label: const Text('Начать инвентаризацию'),
                      ),
                    ],
                  ),
                ),
              ),
            const Padding(
              padding: EdgeInsets.fromLTRB(4, 24, 4, 8),
              child: Text('История', style: TextStyle(color: AppColors.textMuted, fontWeight: FontWeight.w600)),
            ),
            FutureBuilder<List<InventoryCount>>(
              future: fs.recentInventoryCounts(),
              builder: (context, histSnap) {
                if (!histSnap.hasData) {
                  return const Padding(
                    padding: EdgeInsets.all(16),
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                final history = histSnap.data!.where((c) => c.status != 'in_progress').toList();
                if (history.isEmpty) {
                  return const Padding(
                    padding: EdgeInsets.all(8),
                    child: Text('Завершённых инвентаризаций пока нет', style: TextStyle(color: AppColors.textMuted)),
                  );
                }
                return Column(
                  children: history
                      .map((c) => Card(
                            child: ListTile(
                              leading: Icon(
                                c.status == 'completed' ? Icons.check_circle_outline : Icons.cancel_outlined,
                                color: c.status == 'completed' ? AppColors.success : AppColors.textMuted,
                              ),
                              title: Text(_fmtDate(c.startedAt)),
                              subtitle: Text(c.status == 'completed'
                                  ? 'Посчитано ${c.countedCount}/${c.totalCount} · расхождений: ${c.discrepancyCount} · ${c.startedBy}'
                                  : 'Отменена · ${c.startedBy}'),
                              onTap: () => Navigator.of(context).push(MaterialPageRoute(
                                builder: (_) => InventoryCountScreen(
                                  countId: c.id,
                                  employee: employee,
                                  readOnly: true,
                                ),
                              )),
                            ),
                          ))
                      .toList(),
                );
              },
            ),
          ],
        );
      },
    );
  }

  String _fmtDate(DateTime d) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(d.day)}.${two(d.month)}.${d.year} ${two(d.hour)}:${two(d.minute)}';
  }
}