import 'package:flutter/material.dart';
import '../services/staff_session_store.dart';
import '../models/employee.dart';
import '../models/shift_model.dart';
import 'shift_open_dialog.dart';
import '../screens/login_screen.dart';
import '../screens/employee/floor_plan_screen.dart';
import '../screens/employee/x_report_screen.dart';
import '../screens/employee/cash_screen.dart';
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
import '../utils/human_error.dart';
import '../theme/app_colors.dart';
import '../utils/shift_crew.dart';
import 'shift_flow.dart';
import 'about_app_dialog.dart';

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
            .showSnackBar(SnackBar(content: Text('Не удалось открыть смену: ${humanError(e, lower: true)}')));
      }
    }
    if (mounted) setState(() => _busy = false);
  }

  /// Смена заведения открыта — показываем, кто на смене, и даём закрыть
  /// её (с предупреждением, если в зале ещё кто-то работает).
  Future<void> _venueSheet(ShiftModel shift) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (ctx) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
          child: ShiftCrewBuilder(
            builder: (ctx, crew) => Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Смена заведения', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                Text(
                  'Открыта ${shiftTimeLabel(shift.openedAt)}'
                  '${shift.openedBy.isNotEmpty ? ' · открыл(а) ${shift.openedBy}' : ''}',
                  style: const TextStyle(color: AppColors.textMuted),
                ),
                const SizedBox(height: 16),
                if (crew == null)
                  const Center(child: Padding(padding: EdgeInsets.all(12), child: CircularProgressIndicator()))
                else if (crew.isEmpty)
                  const Text('Никто не отметил начало своей смены.', style: TextStyle(color: AppColors.textMuted))
                else ...[
                  Text('Сейчас на смене · ${crew.count}', style: const TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 6),
                  crewList(crew, crew.shifts),
                ],
                const SizedBox(height: 12),
                const Text(
                  'Уходите домой — нажмите «Моя смена» в меню: смена заведения продолжится у остальных. '
                  'Закрывает смену заведения последний, с пересчётом кассы.',
                  style: TextStyle(fontSize: 13, color: AppColors.textMuted),
                ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: () => Navigator.pop(ctx, 'report'),
                  icon: const Icon(Icons.receipt_long_outlined),
                  label: const Text('X-отчёт'),
                ),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(foregroundColor: AppColors.danger),
                  onPressed: () => Navigator.pop(ctx, 'close'),
                  icon: const Icon(Icons.lock_outline),
                  label: const Text('Закрыть смену заведения'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    if (!mounted || action == null) return;
    if (action == 'report') {
      _go(XReportScreen(employee: widget.employee));
      return;
    }
    setState(() => _busy = true);
    await closeVenueShift(context, shift: shift, me: widget.employee);
    if (mounted) setState(() => _busy = false);
  }

  bool _myShiftBusy = false;

  // «Моя смена» — начал и закончил работу. Смена заведения (касса, X-отчёт)
  // от этого не закрывается, пока в зале кто-то есть: кальянщик ушёл домой
  // — официант и бармен продолжают работать в той же смене. См. shift_flow.
  Future<void> _startMine() async {
    setState(() => _myShiftBusy = true);
    await startMyShift(context, widget.employee);
    if (mounted) setState(() => _myShiftBusy = false);
  }

  Future<void> _endMine(StaffShiftModel shift) async {
    setState(() => _myShiftBusy = true);
    await endMyShift(context, widget.employee, shift);
    if (mounted) setState(() => _myShiftBusy = false);
  }

  void _go(Widget screen) {
    Navigator.pop(context);
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => screen));
  }

  static String _lowerFirst(String s) => s.isEmpty ? s : s[0].toLowerCase() + s.substring(1);

  String _formatTime(DateTime dt) => '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final top = <Widget>[
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
            Text(widget.employee.name, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
            const Text('Сотрудник', style: TextStyle(fontSize: 12)),
          ],
        ),
      ),

      // «Моя смена» — первой: это то, что нужно каждому сотруднику
      // (пришёл — начал, уходит домой — закончил).
      StreamBuilder<StaffShiftModel?>(
        stream: _fs.openStaffShiftStream(widget.employee.id),
        builder: (context, snapshot) {
          final mine = snapshot.data;
          final isOpen = mine != null && mine.isOpen;
          final stale = isOpen && isStaleShift(mine.startedAt);
          final subtitle = !isOpen
              ? 'Нажмите, когда пришли на работу'
              : stale
                  ? 'Идёт ${shiftTimeLabel(mine.startedAt)} — вы не закончили прошлую смену'
                  : 'С ${_formatTime(mine.startedAt)} · нажмите, когда уходите';
          return ListTile(
            enabled: !_myShiftBusy,
            leading: Icon(isOpen ? Icons.timer_outlined : Icons.timer_off_outlined,
                color: stale ? AppColors.warning : (isOpen ? Colors.green : Colors.grey)),
            title: Text(isOpen ? 'Моя смена идёт' : 'Моя смена не начата'),
            subtitle: Text(subtitle, style: TextStyle(fontSize: 11, color: stale ? AppColors.warning : null)),
            trailing: _myShiftBusy
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : null,
            onTap: _myShiftBusy ? null : () => isOpen ? _endMine(mine) : _startMine(),
          );
        },
      ),

      // Смена заведения — касса и X-отчёт, одна на всех. Видно, кто
      // сейчас работает; закрыть — через карточку, с предупреждением.
      StreamBuilder<ShiftModel?>(
        stream: _fs.openShiftStream(),
        builder: (context, snapshot) {
          final shift = snapshot.data;
          final isOpen = shift != null && shift.isOpen;
          return ShiftCrewBuilder(builder: (context, crew) {
            final stale = isOpen && isStaleShift(shift.openedAt);
            final subtitle = !isOpen
                ? 'Нажмите, чтобы открыть смену'
                : [
                    stale
                        ? 'Открыта ${shiftTimeLabel(shift.openedAt)} — не закрыта с прошлого раза'
                        : 'С ${_formatTime(shift.openedAt)}',
                    if (crew != null) _lowerFirst(crew.summary()),
                  ].join(' · ');
            return ListTile(
              enabled: !_busy,
              leading: Icon(isOpen ? Icons.storefront_outlined : Icons.lock_outline,
                  color: stale ? AppColors.warning : (isOpen ? Colors.green : Colors.redAccent)),
              title: Text(isOpen ? 'Смена заведения открыта' : 'Смена заведения закрыта'),
              subtitle: Text(subtitle, style: TextStyle(fontSize: 11, color: stale ? AppColors.warning : null)),
              trailing: _busy
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.chevron_right),
              onTap: _busy ? null : () => isOpen ? _venueSheet(shift) : _openShift(),
            );
          });
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

      // Очередь заказов и вызовов — со счётчиком обращений.
      StreamBuilder<List<GuestOrder>>(
        stream: _link.openGuestOrdersStream(),
        builder: (context, orders) => StreamBuilder<List<WaiterCall>>(
          stream: _link.openCallsStream(),
          builder: (context, calls) {
            final count = (orders.data?.length ?? 0) + (calls.data?.length ?? 0);
            return ListTile(
              leading: const Icon(Icons.room_service_outlined),
              title: const Text('Очередь заказов'),
              subtitle: const Text('Заказы и вызовы из приложения гостей', style: TextStyle(fontSize: 11)),
              trailing: count == 0
                  ? null
                  : CircleAvatar(
                      radius: 12,
                      backgroundColor: Colors.redAccent,
                      child: Text('$count', style: const TextStyle(fontSize: 12, color: Colors.white)),
                    ),
              onTap: () => _go(KdsScreen(employee: widget.employee)),
            );
          },
        ),
      ),

      ListTile(
        leading: const Icon(Icons.event_seat_outlined),
        title: const Text('Брони'),
        subtitle: const Text('Подтверждение и посадка гостей', style: TextStyle(fontSize: 11)),
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
        subtitle: const Text('Продажи и оплаты без закрытия смены', style: TextStyle(fontSize: 11)),
        onTap: () => _go(XReportScreen(employee: widget.employee)),
      ),
      ListTile(
        leading: const Icon(Icons.point_of_sale_outlined),
        title: const Text('Касса'),
        subtitle: const Text('Наличные, инкассация, внесение и выплата'),
        onTap: () => _go(CashScreen(employee: widget.employee)),
      ),
      ListTile(
        leading: const Icon(Icons.history),
        title: const Text('История чеков'),
        subtitle: const Text('Просмотр и возврат закрытых чеков', style: TextStyle(fontSize: 11)),
        onTap: () => _go(ReceiptsHistoryScreen(employee: widget.employee)),
      ),
      const Divider(height: 1),

      ListTile(
        leading: const Icon(Icons.inventory_2_outlined),
        title: const Text('Остатки склада'),
        subtitle: const Text('Просмотр текущих количеств', style: TextStyle(fontSize: 11)),
        onTap: () => _go(const StockViewScreen()),
      ),
      ListTile(
        leading: const Icon(Icons.fact_check_outlined),
        title: const Text('Инвентаризация'),
        subtitle: const Text('Пересчёт фактических остатков склада', style: TextStyle(fontSize: 11)),
        onTap: () => _go(InventoryCountEntryScreen(employee: widget.employee)),
      ),
      const Divider(height: 1),

      ListTile(
        leading: const Icon(Icons.auto_awesome, color: Colors.lightBlueAccent),
        title: const Text('Ассистент зала'),
        subtitle: const Text('Спросить про столы, брони и остатки', style: TextStyle(fontSize: 11)),
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
    ];
    final bottom = <Widget>[
      const Divider(height: 1),
      ListTile(
        dense: true,
        leading: const Icon(Icons.system_update_alt),
        title: const Text('Обновления'),
        subtitle: Text('$appBuildLabel · проверить', style: const TextStyle(fontSize: 11)),
        onTap: () => showAboutAppDialog(context),
      ),
      ListTile(
        leading: const Icon(Icons.logout),
        title: const Text('Сменить сотрудника'),
        // Забываем сохранённый вход: вызовы гостей больше не адресуются
        // ушедшему сотруднику, а вход спросит PIN следующего.
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
    ];

    return Drawer(
      child: SafeArea(
        child: LayoutBuilder(
          builder: (context, box) {
            // Низкий экран (телефон на боку, крупный шрифт) — меню
            // прокручивается целиком, иначе шапка и смены вытесняли пункты.
            // Высокий — «Обновления» и «Сменить сотрудника» прижаты к низу.
            if (box.maxHeight < 560) {
              return ListView(padding: EdgeInsets.zero, children: [...top, ...bottom]);
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(child: ListView(padding: EdgeInsets.zero, children: top)),
                ...bottom,
              ],
            );
          },
        ),
      ),
    );
  }
}
