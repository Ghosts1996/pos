import 'package:flutter/material.dart';
import '../models/employee.dart';
import '../models/shift_model.dart';
import '../screens/login_screen.dart';
import '../screens/employee/floor_plan_screen.dart';
import '../screens/employee/x_report_screen.dart';
import '../screens/employee/receipts_history_screen.dart';
import '../screens/employee/inventory_count_entry_screen.dart';
import '../screens/employee/stock_view_screen.dart';
import '../services/firestore_service.dart';

/// Меню сотрудника — боковая панель с функциями, как в Restik POS:
/// зал, открытие/закрытие смены, X-отчёт по текущей смене, история чеков
/// с возможностью возврата и смена сотрудника. Открывается свайпом
/// справа/слева или иконкой "☰" в шапке экранов, где подключён этот Drawer.
class EmployeeDrawer extends StatefulWidget {
  final Employee employee;
  const EmployeeDrawer({super.key, required this.employee});

  @override
  State<EmployeeDrawer> createState() => _EmployeeDrawerState();
}

class _EmployeeDrawerState extends State<EmployeeDrawer> {
  final _fs = FirestoreService();
  bool _busy = false;

  /// Открывает смену, если она сейчас закрыта.
  Future<void> _openShift() async {
    setState(() => _busy = true);
    try {
      await _fs.openShiftIfNeeded(widget.employee.name);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Смена открыта')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось открыть смену: $e')));
      }
    }
    if (mounted) setState(() => _busy = false);
  }

  /// Закрывает текущую открытую смену — с подтверждением, как на экране X-отчёта.
  Future<void> _closeShift(ShiftModel shift) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Закрыть смену?'),
        content: const Text(
            'После закрытия смены новые продажи будут учитываться уже в следующей смене. '
            'Отчёт по этой смене останется доступен в разделе "Прошлые смены".'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Отмена')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true), child: const Text('Закрыть смену')),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() => _busy = true);
    try {
      await _fs.closeShift(shift.id, widget.employee.name);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Смена закрыта')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось закрыть смену: $e')));
      }
    }
    if (mounted) setState(() => _busy = false);
  }

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
                    widget.employee.name,
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18),
                  ),
                  const Text('Сотрудник', style: TextStyle(fontSize: 12)),
                ],
              ),
            ),
            // Кнопка "Открыть смену" / "Закрыть смену" — сама определяет,
            // открыта сейчас смена или нет, и подписывает себя по-русски.
            StreamBuilder<ShiftModel?>(
              stream: _fs.openShiftStream(),
              builder: (context, snapshot) {
                final shift = snapshot.data;
                final isOpen = shift != null && shift.isOpen;
                return ListTile(
                  enabled: !_busy,
                  leading: Icon(
                    isOpen ? Icons.lock_open : Icons.lock_outline,
                    color: isOpen ? Colors.green : Colors.redAccent,
                  ),
                  title: Text(isOpen ? 'Смена открыта' : 'Смена закрыта'),
                  subtitle: Text(
                    isOpen ? 'Нажмите, чтобы закрыть смену' : 'Нажмите, чтобы открыть смену',
                    style: const TextStyle(fontSize: 11),
                  ),
                  trailing: _busy
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : null,
                  onTap: _busy
                      ? null
                      : () => isOpen ? _closeShift(shift) : _openShift(),
                );
              },
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.table_bar_outlined),
              title: const Text('Зал'),
              onTap: () {
                Navigator.pop(context);
                Navigator.of(context).pushAndRemoveUntil(
                  MaterialPageRoute(builder: (_) => FloorPlanScreen(employee: widget.employee)),
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
                  MaterialPageRoute(builder: (_) => XReportScreen(employee: widget.employee)),
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
                  MaterialPageRoute(builder: (_) => ReceiptsHistoryScreen(employee: widget.employee)),
                );
              },
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.inventory_2_outlined),
              title: const Text('Остатки склада'),
              subtitle: const Text('Просмотр текущих количеств', style: TextStyle(fontSize: 11)),
              onTap: () {
                Navigator.pop(context);
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const StockViewScreen()),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.fact_check_outlined),
              title: const Text('Инвентаризация'),
              subtitle: const Text('Пересчёт фактических остатков склада', style: TextStyle(fontSize: 11)),
              onTap: () {
                Navigator.pop(context);
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => InventoryCountEntryScreen(employee: widget.employee)),
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