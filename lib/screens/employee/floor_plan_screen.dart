import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/table_model.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../services/ai/ai_agents.dart';
import '../../theme/app_colors.dart';
import '../../widgets/table_tile.dart';
import '../../widgets/employee_drawer.dart';
import '../../widgets/guest_requests_banner.dart';
import '../../widgets/ai_assistant_sheet.dart';
import 'table_detail_screen.dart';

/// Карта зала для сотрудника.
///
/// Сверху — живая панель обращений гостей из «Колибри Лаундж» (вызовы и
/// заказы). Панель схлопывается в ноль, когда обращений нет, поэтому в
/// спокойное время карта зала занимает весь экран, как раньше.
class FloorPlanScreen extends StatelessWidget {
  final Employee employee;
  const FloorPlanScreen({super.key, required this.employee});

  @override
  Widget build(BuildContext context) {
    final fs = FirestoreService();

    return Scaffold(
      appBar: AppBar(
        title: Text('Зал · ${employee.name}'),
        actions: [
          IconButton(
            tooltip: 'Ассистент зала',
            icon: const Icon(Icons.auto_awesome),
            onPressed: () => AiAssistantSheet.show(
              context,
              agent: AiAgents.hall,
              quickPrompts: const [
                'Какие столы освободятся через час?',
                'Куда посадить компанию из шести человек?',
                'Что заканчивается на складе?',
              ],
            ),
          ),
        ],
      ),
      drawer: EmployeeDrawer(employee: employee),
      body: Column(
        children: [
          GuestRequestsBanner(
            employee: employee,
            onOpenTable: (tableId, sessionId) async {
              final table = await fs.tableStream(tableId).first;
              if (table == null || !context.mounted) return;
              Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => TableDetailScreen(
                  table: table,
                  employee: employee,
                  sessionId: sessionId.isEmpty ? null : sessionId,
                ),
              ));
            },
          ),
          Expanded(
            child: StreamBuilder<List<TableModel>>(
              stream: fs.tablesStream(),
              builder: (context, snap) {
                if (snap.hasError) {
                  return Center(
                    child: Text('Ошибка загрузки зала: ${snap.error}',
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: AppColors.danger)),
                  );
                }
                if (!snap.hasData) return const Center(child: CircularProgressIndicator());
                final tables = snap.data!;
                if (tables.isEmpty) {
                  return const Center(child: Text('Столы ещё не добавлены администратором'));
                }
                return LayoutBuilder(builder: (context, constraints) {
                  return Stack(
                    children: tables.map((t) {
                      return Positioned(
                        key: ValueKey(t.id),
                        left: t.x * constraints.maxWidth,
                        top: t.y * constraints.maxHeight,
                        child: _TableWithTimer(
                          table: t,
                          employee: employee,
                          onTap: () => Navigator.of(context).push(MaterialPageRoute(
                              builder: (_) => TableDetailScreen(
                                    table: t,
                                    employee: employee,
                                    // Если на столе уже есть открытые чеки —
                                    // сразу открываем первый; переключиться
                                    // можно внутри самого экрана стола.
                                    sessionId: t.activeSessionIds.isNotEmpty
                                        ? t.activeSessionIds.first
                                        : null,
                                  ))),
                        ),
                      );
                    }).toList(),
                  );
                });
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// Подписывается на первый открытый чек стола, чтобы показать живой таймер
/// и бейдж количества чеков прямо на плитке. Дополнительно подсвечивает
/// стол, от которого поступил вызов гостя.
class _TableWithTimer extends StatelessWidget {
  final TableModel table;
  final Employee employee;
  final VoidCallback onTap;

  const _TableWithTimer({
    required this.table,
    required this.employee,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    if (table.activeSessionIds.isEmpty) {
      return TableTile(table: table, onTap: onTap);
    }
    final fs = FirestoreService();
    return StreamBuilder<SessionModel?>(
      stream: fs.sessionStream(table.activeSessionIds.first),
      builder: (context, snap) {
        final session = snap.data;
        return TableTile(
          table: table,
          plannedEnd: session?.plannedEnd,
          checkCount: table.activeSessionIds.length,
          guestTag: session?.guestTag,
          onTap: onTap,
        );
      },
    );
  }
}
