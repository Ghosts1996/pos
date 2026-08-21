import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/table_model.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../widgets/table_tile.dart';
import '../../widgets/employee_drawer.dart';
import 'table_detail_screen.dart';

/// Карта зала для сотрудника — просмотр столов, переход к столу и доступ
/// к меню сотрудника (X-отчёт, история чеков и возврат, смена сотрудника)
/// через боковую панель.
class FloorPlanScreen extends StatelessWidget {
  final Employee employee;
  const FloorPlanScreen({super.key, required this.employee});

  @override
  Widget build(BuildContext context) {
    final fs = FirestoreService();
    return Scaffold(
      appBar: AppBar(
        title: Text('Зал · ${employee.name}'),
      ),
      drawer: EmployeeDrawer(employee: employee),
      body: StreamBuilder<List<TableModel>>(
        stream: fs.tablesStream(),
        builder: (context, snap) {
          if (snap.hasError) {
            return Center(
              child: Text('Ошибка загрузки зала: ${snap.error}',
                  textAlign: TextAlign.center, style: const TextStyle(color: Colors.red)),
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
                    onTap: () => Navigator.of(context).push(MaterialPageRoute(
                        builder: (_) => TableDetailScreen(
                              table: t,
                              employee: employee,
                              // Если на столе уже есть открытые чеки — сразу
                              // открываем первый из них; переключиться на
                              // другой чек или открыть новый можно уже внутри
                              // самого экрана стола.
                              sessionId:
                                  t.activeSessionIds.isNotEmpty ? t.activeSessionIds.first : null,
                            ))),
                  ),
                );
              }).toList(),
            );
          });
        },
      ),
    );
  }
}

/// Подписывается на первый открытый чек стола, чтобы показать живой таймер
/// и бейдж количества чеков прямо на плитке.
class _TableWithTimer extends StatelessWidget {
  final TableModel table;
  final VoidCallback onTap;
  const _TableWithTimer({required this.table, required this.onTap});

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
          onTap: onTap,
        );
      },
    );
  }
}