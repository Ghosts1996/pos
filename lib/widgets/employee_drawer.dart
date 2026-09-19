import 'package:flutter/material.dart';
import '../services/staff_session_store.dart';
import '../models/employee.dart';
import '../models/shift_model.dart';
import 'shift_open_dialog.dart';
import '../screens/login_screen.dart';
import '../screens/employee/floor_plan_screen.dart';
import '../screens/employee/x_report_screen.dart';
import '../screens/employee/receipts_history_screen.dart';
import '../screens/employee/inventory_count_entry_screen.dart';
import '../screens/employee/stock_view_screen.dart';
import '../screens/employee/reservations_screen.dart';
import '../screens/employee/kds_screen.dart';
import '../screens/employee/waitlist_screen.dart';
import '../services/firestore_service.dart';
import '../models/staff_shift_model.dart';
import '../services/guest_link_service.dart';
import '../services/ai/ai_agents.dart';
import '../models/client_models.dart';
import 'ai_assistant_sheet.dart';

/// Меню сотрудника — боковая панель: зал, брони, очередь заказов, лист
/// ожидания, смена, X-отчёт, история чеков, склад и ассистент зала.
///
/// На пунктах «Очередь заказов» и «Брони» висят живые счётчики: кальянщик
/// видит, что его ждут, не открывая экран.
class EmployeeDrawer extends StatefulWidget {
  final Employee employee;
  const EmployeeDrawer({super.key, required this.employee});

  @override
  State<EmployeeDrawer> createState() => _EmployeeDrawerState();
}

class _EmployeeDrawerState extends State<EmployeeDrawer> {
  final _fs = FirestoreService();
  final _link = GuestLinkService();
  bool _busy = false;

  Future<void> _openShift() async {
    setState(() => _busy = true);
    try {
      // Спрашиваем, кто выходит в зал: смену нередко открывает админ или
      // сменщик с чужого планшета, а уведомления должны идти работающему.
      // Сообщение об успехе показывает сам диалог.
      if (mounted) await ensureShiftOpen(context, me: widget.employee);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось открыть смену: $e')));
      }
    }
    if (mounted) setState(() => _busy = false);
  }

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

  bool _myShiftBusy = false;

  // "Моя смена" — личный учёт рабочего времени для расчёта зарплаты. Не
  // путать с кассовой сменой выше: та одна на всё заведение, эта — только
  // у этого сотрудника, и не связана с кассовой ни открытием, ни закрытием
  // (иначе случайный повторный вход по PIN дробил бы одну смену на
  // несколько, а зарплата считалась бы неверно).
  Future<void> _clockIn() async {
    setState(() => _myShiftBusy = true);
    try {
      await _fs.clockIn(widget.employee);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Смена начата')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось начать смену: $e')));
      }
    }
    if (mounted) setState(() => _myShiftBusy = false);
  }

  Future<void> _clockOut(StaffShiftModel shift) async {
    setState(() => _myShiftBusy = true);
    try {
      await _fs.clockOut(shift.id, widget.employee.id);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Смена закончена')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось закончить смену: $e')));
      }
    }
    if (mounted) setState(() => _myShiftBusy = false);
  }

  void _go(Widget screen) {
    Navigator.pop(context);
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => screen));
  }

  String _formatTime(DateTime dt) =>
      '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';

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
                  Text(widget.employee.name,
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
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
                  leading: Icon(isOpen ? Icons.lock_open : Icons.lock_outline,
                      color: isOpen ? Colors.green : Colors.redAccent),
                  title: Text(isOpen ? 'Смена открыта' : 'Смена закрыта'),
                  subtitle: Text(
                    isOpen ? 'Нажмите, чтобы закрыть смену' : 'Нажмите, чтобы открыть смену',
                    style: const TextStyle(fontSize: 11),
                  ),
                  trailing: _busy
                      ? const SizedBox(
                          width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : null,
                  onTap: _busy ? null : () => isOpen ? _closeShift(shift) : _openShift(),
                );
              },
            ),

            // Личная смена сотрудника (для зарплаты) — отдельно от кассовой
            // выше: кассовая смена одна на всё заведение, эта — только его.
            StreamBuilder<StaffShiftModel?>(
              stream: _fs.openStaffShiftStream(widget.employee.id),
              builder: (context, snapshot) {
                final myShift = snapshot.data;
                final isOpen = myShift != null && myShift.isOpen;
                final subtitle = isOpen
                    ? 'Началась в ${_formatTime(myShift.startedAt)} · нажмите, чтобы закончить'
                    : 'Нажмите, чтобы начать учёт рабочего времени';
                return ListTile(
                  enabled: !_myShiftBusy,
                  leading: Icon(isOpen ? Icons.timer_outlined : Icons.timer_off_outlined,
                      color: isOpen ? Colors.green : Colors.grey),
                  title: Text(isOpen ? 'Моя смена идёт' : 'Моя смена не начата'),
                  subtitle: Text(subtitle, style: const TextStyle(fontSize: 11)),
                  trailing: _myShiftBusy
                      ? const SizedBox(
                          width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : null,
                  onTap: _myShiftBusy ? null : () => isOpen ? _clockOut(myShift) : _clockIn(),
                );
              },
            ),
            const Divider(height: 1),

            Expanded(
              child: ListView(
                padding: EdgeInsets.zero,
                children: [
                  ListTile(
                    leading: const Icon(Icons.table_bar_outlined),
                    title: const Text('Зал'),
                    onTap: () {
                      Navigator.pop(context);
                      Navigator.of(context).pushAndRemoveUntil(
                        MaterialPageRoute(
                            builder: (_) => FloorPlanScreen(employee: widget.employee)),
                        (route) => false,
                      );
                    },
                  ),

                  // Очередь заказов и вызовов — со счётчиком обращений.
                  StreamBuilder<List<GuestOrder>>(
                    stream: _link.openGuestOrdersStream(),
                    builder: (context, orders) => StreamBuilder<List<WaiterCall>>(
                      stream: _link.openCallsStream(),
                      builder: (context, calls) {
                        final count =
                            (orders.data?.length ?? 0) + (calls.data?.length ?? 0);
                        return ListTile(
                          leading: const Icon(Icons.room_service_outlined),
                          title: const Text('Очередь заказов'),
                          subtitle: const Text('Заказы и вызовы из приложения гостей',
                              style: TextStyle(fontSize: 11)),
                          trailing: count == 0
                              ? null
                              : CircleAvatar(
                                  radius: 12,
                                  backgroundColor: Colors.redAccent,
                                  child: Text('$count',
                                      style: const TextStyle(fontSize: 12, color: Colors.white)),
                                ),
                          onTap: () => _go(KdsScreen(employee: widget.employee)),
                        );
                      },
                    ),
                  ),

                  ListTile(
                    leading: const Icon(Icons.event_seat_outlined),
                    title: const Text('Брони'),
                    subtitle: const Text('Подтверждение и посадка гостей',
                        style: TextStyle(fontSize: 11)),
                    onTap: () => _go(ReservationsScreen(employee: widget.employee)),
                  ),
                  ListTile(
                    leading: const Icon(Icons.hourglass_bottom),
                    title: const Text('Лист ожидания'),
                    subtitle: const Text('Когда все столы заняты', style: TextStyle(fontSize: 11)),
                    onTap: () => _go(WaitlistScreen(employee: widget.employee)),
                  ),
                  const Divider(height: 1),

                  ListTile(
                    leading: const Icon(Icons.receipt_long_outlined),
                    title: const Text('X-отчёт (текущая смена)'),
                    subtitle: const Text('Продажи и оплаты без закрытия смены',
                        style: TextStyle(fontSize: 11)),
                    onTap: () => _go(XReportScreen(employee: widget.employee)),
                  ),
                  ListTile(
                    leading: const Icon(Icons.history),
                    title: const Text('История чеков'),
                    subtitle: const Text('Просмотр и возврат закрытых чеков',
                        style: TextStyle(fontSize: 11)),
                    onTap: () => _go(ReceiptsHistoryScreen(employee: widget.employee)),
                  ),
                  const Divider(height: 1),

                  ListTile(
                    leading: const Icon(Icons.inventory_2_outlined),
                    title: const Text('Остатки склада'),
                    subtitle:
                        const Text('Просмотр текущих количеств', style: TextStyle(fontSize: 11)),
                    onTap: () => _go(const StockViewScreen()),
                  ),
                  ListTile(
                    leading: const Icon(Icons.fact_check_outlined),
                    title: const Text('Инвентаризация'),
                    subtitle: const Text('Пересчёт фактических остатков склада',
                        style: TextStyle(fontSize: 11)),
                    onTap: () => _go(InventoryCountEntryScreen(employee: widget.employee)),
                  ),
                  const Divider(height: 1),

                  ListTile(
                    leading: const Icon(Icons.auto_awesome, color: Colors.lightBlueAccent),
                    title: const Text('Ассистент зала'),
                    subtitle: const Text('Спросить про столы, брони и остатки',
                        style: TextStyle(fontSize: 11)),
                    onTap: () {
                      Navigator.pop(context);
                      AiAssistantSheet.show(
                        context,
                        agent: AiAgents.hall,
                        // Данные зала кладём в промпт заранее: иначе ассистент
                        // отвечает «данных нет», если шлюз не умеет инструменты.
                        asyncContextBuilder: AiService.instance.hallContext,
                        quickPrompts: const [
                          'Какие столы освободятся через час?',
                          'Что предложить гостям сегодня?',
                          'Что заканчивается на складе?',
                        ],
                      );
                    },
                  ),
                ],
              ),
            ),

            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.logout),
              title: const Text('Сменить сотрудника'),
              // Забываем сохранённый вход — иначе экран PIN тут же
              // вернул бы в приложение того же сотрудника.
              onTap: () async {
                await StaffSessionStore.instance.forget();
                if (!context.mounted) return;
                Navigator.of(context).pushAndRemoveUntil(
                  MaterialPageRoute(builder: (_) => const LoginScreen()),
                  (_) => false,
                );
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}
