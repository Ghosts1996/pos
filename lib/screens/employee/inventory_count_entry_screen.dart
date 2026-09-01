import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/inventory_models.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';
import '../admin/inventory_count_screen.dart';

/// Инвентаризация для сотрудника — тот же процесс пересчёта, что и в
/// админке (см. [InventoryCountScreen]), но без вкладки «Остатки»:
/// заводить/редактировать позиции склада может только админ, а вот
/// участвовать в самом пересчёте — любой сотрудник со сменой. Экран
/// показывает текущую незавершённую инвентаризацию (если есть), кнопку
/// начать новую и историю прошлых проходов только для просмотра.
class InventoryCountEntryScreen extends StatelessWidget {
  final Employee employee;
  const InventoryCountEntryScreen({super.key, required this.employee});

  @override
  Widget build(BuildContext context) {
    final fs = FirestoreService();
    return Scaffold(
      appBar: AppBar(title: const Text('Инвентаризация')),
      body: StreamBuilder<InventoryCount?>(
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
      ),
    );
  }

  String _fmtDate(DateTime d) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(d.day)}.${two(d.month)}.${d.year} ${two(d.hour)}:${two(d.minute)}';
  }
}