import 'package:flutter/material.dart';
import '../models/employee.dart';
import '../screens/login_screen.dart';
import '../screens/employee/floor_plan_screen.dart';
import '../screens/employee/x_report_screen.dart';
import '../screens/employee/receipts_history_screen.dart';

/// Меню сотрудника — боковая панель с функциями, как в Restik POS:
/// зал, X-отчёт по текущей смене, история чеков с возможностью возврата и
/// смена сотрудника. Открывается свайпом справа/слева или иконкой "☰"
/// в шапке экранов, где подключён этот Drawer.
class EmployeeDrawer extends StatelessWidget {
  final Employee employee;
  const EmployeeDrawer({super.key, required this.employee});

  @override
  Widget build(BuildContext context) {
    return Drawer(
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DrawerHeader(
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.primaryContainer,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  const Icon(Icons.person, size: 36),
                  const SizedBox(height: 8),
                  Text(
                    employee.name,
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18),
                  ),
                  const Text('Сотрудник', style: TextStyle(fontSize: 12)),
                ],
              ),
            ),
            ListTile(
              leading: const Icon(Icons.table_bar_outlined),
              title: const Text('Зал'),
              onTap: () {
                Navigator.pop(context);
                Navigator.of(context).pushAndRemoveUntil(
                  MaterialPageRoute(builder: (_) => FloorPlanScreen(employee: employee)),
                  (route) => false,
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.receipt_long_outlined),
              title: const Text('X-отчёт (текущая смена)'),
              subtitle: const Text('Продажи и оплаты без закрытия смены', style: TextStyle(fontSize: 11)),
              onTap: () {
                Navigator.pop(context);
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => XReportScreen(employee: employee)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.history),
              title: const Text('История чеков'),
              subtitle: const Text('Просмотр и возврат закрытых чеков', style: TextStyle(fontSize: 11)),
              onTap: () {
                Navigator.pop(context);
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => ReceiptsHistoryScreen(employee: employee)),
                );
              },
            ),
            const Spacer(),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.logout),
              title: const Text('Сменить сотрудника'),
              onTap: () => Navigator.of(context).pushAndRemoveUntil(
                MaterialPageRoute(builder: (_) => const LoginScreen()),
                (_) => false,
              ),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}