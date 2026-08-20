import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/table_model.dart';
import '../../services/firestore_service.dart';
import '../../widgets/table_tile.dart';
import '../login_screen.dart';
import 'table_detail_screen.dart';

/// Карта зала для сотрудника — только просмотр и переход к столу.
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
            icon: const Icon(Icons.logout),
            tooltip: 'Сменить сотрудника',
            onPressed: () => Navigator.of(context).pushAndRemoveUntil(
                MaterialPageRoute(builder: (_) => const LoginScreen()), (_) => false),
          ),
        ],
      ),
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
                        builder: (_) => TableDetailScreen(table: t, employee: employee))),
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

/// Подписывается на сеанс стола, чтобы показать живой таймер на плитке
class _TableWithTimer extends StatelessWidget {
  final TableModel table;
  final VoidCallback onTap;
  const _TableWithTimer({required this.table, required this.onTap});

  @override
  Widget build(BuildContext context) {
    if (table.status != 'occupied' || table.currentSessionId == null) {
      return TableTile(table: table, onTap: onTap);
    }
    final fs = FirestoreService();
    return StreamBuilder(
      stream: fs.sessionStream(table.currentSessionId!),
      builder: (context, snap) {
        final session = snap.data;
        return TableTile(
          table: table,
          plannedEnd: session?.plannedEnd,
          onTap: onTap,
        );
      },
    );
  }
}
