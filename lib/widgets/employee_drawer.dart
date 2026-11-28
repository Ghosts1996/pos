import 'package:flutter/material.dart';
import '../services/staff_session_store.dart';
import '../models/employee.dart';
import '../models/shift_model.dart';
import '../models/session_model.dart';
import 'shift_open_dialog.dart';
import '../screens/login_screen.dart';
import '../screens/employee/floor_plan_screen.dart';
import '../screens/employee/x_report_screen.dart';
import '../screens/employee/cash_screen.dart';
import '../screens/employee/receipts_history_screen.dart';
import '../screens/employee/inventory_count_entry_screen.dart';
import '../screens/employee/kegs_screen.dart';
import '../screens/employee/tobacco_shelf_screen.dart';
import '../build_info.dart';
import '../services/venue_service.dart';
import '../screens/employee/stock_view_screen.dart';
import '../screens/employee/reservations_screen.dart';
import '../screens/employee/kds_screen.dart';
import '../screens/employee/kitchen_screen.dart';
import '../screens/employee/waitlist_screen.dart';
import '../services/firestore_service.dart';
import '../services/window_mode.dart';
import '../models/staff_shift_model.dart';
import '../services/guest_link_service.dart';
import '../services/ai/ai_agents.dart';
import '../models/client_models.dart';
import 'ai_assistant_sheet.dart';
import '../utils/human_error.dart';
import '../theme/app_colors.dart';
import '../theme/theme_controller.dart';
import 'theme_picker.dart';
import '../theme/app_theme.dart';
import '../utils/constants.dart';
import '../utils/shift_crew.dart';
import 'shift_flow.dart';
import 'about_app_dialog.dart';
import 'staff_nav.dart';

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
                  style: TextStyle(color: AppColors.textMuted),
                ),
                const SizedBox(height: 16),
                if (crew == null)
                  const Center(child: Padding(padding: EdgeInsets.all(12), child: CircularProgressIndicator()))
                else if (crew.isEmpty)
                  Text('Никто не отметил начало своей смены.', style: TextStyle(color: AppColors.textMuted))
                else ...[
                  Text('Сейчас на смене · ${crew.count}', style: const TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 6),
                  crewList(crew, crew.shifts),
                ],
                const SizedBox(height: 12),
                if (DateTime.now().difference(shift.openedAt) > const Duration(hours: 24)) ...[
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.warning.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      'Смена открыта больше суток. Закройте её Z-отчётом: кассовая смена по закону '
                      'длится не больше 24 часов, а чеки разных дней не должны смешиваться.',
                      style: TextStyle(fontSize: 13, color: AppColors.warning),
                    ),
                  ),
                  const SizedBox(height: 12),
                ],
                Text(
                  'X-отчёт — промежуточный итог: смотреть можно сколько угодно, смена не закрывается. '
                  'Z-отчёт закрывает смену: пересчёт кассы, итог дня, номер Z. Закрывает последний, кто уходит; '
                  'остальные просто заканчивают «Мою смену».',
                  style: TextStyle(fontSize: 13, color: AppColors.textMuted),
                ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: () => Navigator.pop(ctx, 'report'),
                  icon: const Icon(Icons.receipt_long_outlined),
                  label: const Text('X-отчёт — промежуточный'),
                ),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(foregroundColor: AppColors.danger),
                  onPressed: () => Navigator.pop(ctx, 'close'),
                  icon: const Icon(Icons.lock_outline),
                  label: const Text('Закрыть смену · Z-отчёт'),
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

  /// Пункт меню: в SaaS — новый вид (StaffNavItem), в hookah-pos — прежний ListTile.
  Widget _item({
    required IconData icon,
    required String title,
    String? subtitle,
    Color? tint,
    int badge = 0,
    Color? badgeColor,
    Color? badgeText,
    required VoidCallback onTap,
  }) {
    if (kSaasMode) {
      return StaffNavItem(
        icon: icon,
        title: title,
        subtitle: subtitle,
        tint: tint,
        trailing: badge == 0 ? null : StaffNavBadge(badge, color: badgeColor ?? AppColors.danger),
        onTap: onTap,
      );
    }
    return ListTile(
      leading: Icon(icon, color: tint == AppColors.brass ? tint : null),
      title: Text(title),
      subtitle: subtitle == null ? null : Text(subtitle, style: const TextStyle(fontSize: 11)),
      trailing: badge == 0
          ? null
          : CircleAvatar(
              radius: 12,
              backgroundColor: badgeColor ?? AppColors.danger,
              child: Text('$badge', style: TextStyle(fontSize: 12, color: badgeText ?? AppColors.onAccent)),
            ),
      onTap: onTap,
    );
  }

  /// Начало группы пунктов: в SaaS — подпись раздела, в hookah-pos — черта.
  Widget _section(String label) => kSaasMode ? StaffNavSection(label) : const Divider(height: 1);

  /// Строка смены: в SaaS — карточка состояния, в hookah-pos — ListTile.
  Widget _shiftTile({
    required IconData icon,
    required Color color,
    required String title,
    required String subtitle,
    required bool busy,
    required bool stale,
    bool chevron = false,
    required VoidCallback onTap,
  }) {
    if (kSaasMode) {
      return StaffStatusCard(
        icon: icon,
        color: color,
        title: title,
        subtitle: subtitle,
        busy: busy,
        chevron: chevron,
        onTap: onTap,
      );
    }
    return ListTile(
      enabled: !busy,
      leading: Icon(icon, color: color),
      title: Text(title),
      subtitle: Text(subtitle, style: TextStyle(fontSize: 11, color: stale ? AppColors.warning : null)),
      trailing: busy
          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
          : (chevron ? const Icon(Icons.chevron_right) : null),
      onTap: busy ? null : onTap,
    );
  }

  void _openAssistant() {
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
  }

  Future<void> _switchEmployee() async {
    // Забываем сохранённый вход: вызовы гостей больше не адресуются
    // ушедшему сотруднику, а вход спросит PIN следующего.
    await StaffSessionStore.instance.forget();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const LoginScreen()),
      (_) => false,
    );
  }

  /// Подвал меню hookah-pos — как было.
  List<Widget> _classicFooter() => [
        const Divider(height: 1),
        // Тема этого устройства: тёмная, светлая или как в системе.
        ValueListenableBuilder<AppThemeMode>(
          valueListenable: ThemeController.instance.mode,
          builder: (context, mode, _) => ListTile(
            dense: true,
            leading: Icon(AppColors.isLight ? Icons.light_mode_outlined : Icons.dark_mode_outlined),
            title: const Text('Тема'),
            subtitle: Text(mode.title, style: const TextStyle(fontSize: 11)),
            onTap: () => showThemePicker(context),
          ),
        ),
        ListTile(
          dense: true,
          leading: const Icon(Icons.system_update_alt),
          title: const Text('Обновления'),
          subtitle: Text('$appBuildLabel · проверить', style: const TextStyle(fontSize: 11)),
          onTap: () => showAboutAppDialog(context),
        ),
        // Касса на Windows: на весь экран без рамки или обычным окном (F11).
        if (WindowMode.supported)
          ValueListenableBuilder<bool>(
            valueListenable: WindowMode.fullscreen,
            builder: (context, full, _) => ListTile(
              dense: true,
              leading: Icon(full ? Icons.fullscreen_exit : Icons.fullscreen),
              title: Text(full ? 'Обычное окно' : 'Во весь экран'),
              subtitle: const Text('или клавиша F11', style: TextStyle(fontSize: 11)),
              onTap: WindowMode.toggle,
            ),
          ),
        ListTile(
          leading: const Icon(Icons.logout),
          title: const Text('Сменить сотрудника'),
          onTap: _switchEmployee,
        ),
        const SizedBox(height: 8),
      ];

  /// Подвал SaaS: тема, обновления и окно — тремя маленькими кнопками в
  /// ряд, «Сменить сотрудника» — отдельной кнопкой, номер версии — мелко.
  List<Widget> _saasFooter() => [
        Divider(height: 1, color: AppColors.border),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 0),
          child: Row(children: [
            Expanded(
              child: ValueListenableBuilder<AppThemeMode>(
                valueListenable: ThemeController.instance.mode,
                builder: (context, mode, _) => StaffFooterButton(
                  icon: AppColors.isLight ? Icons.light_mode_outlined : Icons.dark_mode_outlined,
                  label: 'Тема',
                  onTap: () => showThemePicker(context),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: StaffFooterButton(
                icon: Icons.system_update_alt,
                label: 'Обновления',
                onTap: () => showAboutAppDialog(context),
              ),
            ),
            if (WindowMode.supported) ...[
              const SizedBox(width: 8),
              Expanded(
                child: ValueListenableBuilder<bool>(
                  valueListenable: WindowMode.fullscreen,
                  builder: (context, full, _) => StaffFooterButton(
                    icon: full ? Icons.fullscreen_exit : Icons.fullscreen,
                    label: full ? 'Окно' : 'Весь экран',
                    onTap: WindowMode.toggle,
                  ),
                ),
              ),
            ],
          ]),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
          child: OutlinedButton.icon(
            style: OutlinedButton.styleFrom(
              minimumSize: const Size.fromHeight(44),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            onPressed: _switchEmployee,
            icon: const Icon(Icons.logout, size: 18),
            label: const Text('Сменить сотрудника'),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 6, 14, 10),
          child: Text(appBuildLabel,
              textAlign: TextAlign.center, style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
        ),
      ];

  @override
  Widget build(BuildContext context) {
    final profile = VenueService.instance.cached;
    // Значки всех разделов (SaaS) — одной латунью: спокойнее и дороже, чем
    // разноцветные; разделы различаются подписями.
    final hallTint = AppColors.brass;
    final cashTint = AppColors.brass;
    final stockTint = AppColors.brass;
    final top = <Widget>[
      _StaffHeader(employee: widget.employee),
      if (kSaasMode) const SizedBox(height: 6),

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
          return _shiftTile(
            icon: isOpen ? Icons.timer_outlined : Icons.timer_off_outlined,
            color: stale ? AppColors.warning : (isOpen ? AppColors.success : (kSaasMode ? AppColors.textMuted : Colors.grey)),
            title: isOpen ? 'Моя смена идёт' : 'Моя смена не начата',
            subtitle: subtitle,
            busy: _myShiftBusy,
            stale: stale,
            onTap: () => isOpen ? _endMine(mine) : _startMine(),
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
            return _shiftTile(
              icon: isOpen ? Icons.storefront_outlined : Icons.lock_outline,
              color: stale ? AppColors.warning : (isOpen ? AppColors.success : AppColors.danger),
              title: isOpen ? 'Смена заведения открыта' : 'Смена заведения закрыта',
              subtitle: subtitle,
              busy: _busy,
              stale: stale,
              chevron: true,
              onTap: () => isOpen ? _venueSheet(shift) : _openShift(),
            );
          });
        },
      ),
      _section('Зал'),

      _item(
        icon: Icons.table_bar_outlined,
        title: 'Зал',
        subtitle: kSaasMode ? 'Столы и счета' : null,
        tint: hallTint,
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
            return _item(
              icon: Icons.room_service_outlined,
              title: 'Очередь заказов',
              subtitle: 'Заказы и вызовы из приложения гостей',
              tint: hallTint,
              badge: count,
              badgeColor: AppColors.danger,
              onTap: () => _go(KdsScreen(employee: widget.employee)),
            );
          },
        ),
      ),

      // Кухня и бар: что готовить по всем столам — со счётчиком столов,
      // которые ждут свой цех (повар — кухня, бармен — бар, кальянщик — кальяны).
      StreamBuilder<List<SessionModel>>(
        stream: FirestoreService().openChecksStream(),
        builder: (context, snap) {
          final station = KitchenScreen.stationFor(widget.employee.position);
          // Счётчик — тем, кто готовит: повару, бармену, кальянщику.
          final cooks = const [AppConstants.positionCook, AppConstants.positionBartender, AppConstants.positionHookahMaster]
              .contains(AppConstants.normalizePosition(widget.employee.position));
          final count = cooks ? KitchenScreen.ticketsFor(snap.data ?? const [], station).length : 0;
          return _item(
            icon: Icons.soup_kitchen_outlined,
            title: 'Кухня и бар',
            subtitle: 'Что готовить по всем столам',
            tint: hallTint,
            badge: count,
            badgeColor: AppColors.warning,
            badgeText: AppColors.isLight ? AppColors.onAccent : AppColors.background,
            onTap: () => _go(KitchenScreen(employee: widget.employee)),
          );
        },
      ),

      _item(
        icon: Icons.event_seat_outlined,
        title: 'Брони',
        subtitle: 'Подтверждение и посадка гостей',
        tint: hallTint,
        onTap: () => _go(ReservationsScreen(employee: widget.employee)),
      ),
      _item(
        icon: Icons.hourglass_bottom,
        title: 'Лист ожидания',
        subtitle: 'Когда все столы заняты',
        tint: hallTint,
        onTap: () => _go(WaitlistScreen(employee: widget.employee)),
      ),
      _section('Касса'),

      _item(
        icon: Icons.receipt_long_outlined,
        title: kSaasMode ? 'X-отчёт' : 'X-отчёт (текущая смена)',
        subtitle: 'Продажи и оплаты без закрытия смены',
        tint: cashTint,
        onTap: () => _go(XReportScreen(employee: widget.employee)),
      ),
      _item(
        icon: Icons.point_of_sale_outlined,
        title: 'Касса',
        subtitle: 'Наличные, инкассация, внесение и выплата',
        tint: cashTint,
        onTap: () => _go(CashScreen(employee: widget.employee)),
      ),
      _item(
        icon: Icons.history,
        title: 'История чеков',
        subtitle: 'Просмотр и возврат закрытых чеков',
        tint: cashTint,
        onTap: () => _go(ReceiptsHistoryScreen(employee: widget.employee)),
      ),
      _section('Склад'),

      _item(
        icon: Icons.inventory_2_outlined,
        title: 'Остатки склада',
        subtitle: 'Просмотр текущих количеств',
        tint: stockTint,
        onTap: () => _go(const StockViewScreen()),
      ),
      _item(
        icon: Icons.fact_check_outlined,
        title: 'Инвентаризация',
        subtitle: 'Пересчёт фактических остатков склада',
        tint: stockTint,
        onTap: () => _go(InventoryCountEntryScreen(employee: widget.employee)),
      ),
      // Кальянная: табак на полке и подбор миксов (без ИИ). Выключается в
      // «Профиле заведения».
      if (kSaasMode && profile.showTobaccoShelf)
        _item(
          icon: Icons.local_fire_department_outlined,
          title: 'Табак и миксы',
          subtitle: 'Полка табака по фото, подбор микса под гостя',
          tint: stockTint,
          onTap: () => _go(const TobaccoShelfScreen()),
        ),
      // Разливное пиво — только если владелец включил в «Профиле заведения»
      // (у бара — по умолчанию).
      if (kSaasMode && profile.showKegs)
        _item(
          icon: Icons.sports_bar_outlined,
          title: 'Кеги на кране',
          subtitle: 'Разливное пиво: код кеги в чеке, остаток литров',
          tint: stockTint,
          onTap: () => _go(KegsScreen(employee: widget.employee)),
        ),

      if (kSaasMode)
        StaffAccentCard(
          icon: Icons.auto_awesome,
          title: 'Ассистент зала',
          subtitle: 'Спросить про столы, брони, остатки и миксы',
          onTap: _openAssistant,
        )
      else ...[
        const Divider(height: 1),
        ListTile(
          leading: Icon(Icons.auto_awesome, color: AppColors.brass),
          title: const Text('Ассистент зала'),
          subtitle: const Text('Спросить про столы, брони и остатки', style: TextStyle(fontSize: 11)),
          onTap: _openAssistant,
        ),
      ],
    ];
    final bottom = kSaasMode ? _saasFooter() : _classicFooter();

    return Drawer(
      child: SafeArea(
        child: LayoutBuilder(
          builder: (context, box) {
            // SaaS: меню — одна лента, подвал в её конце. Прижатый к низу
            // подвал на телефоне занимал пятую часть экрана, не листался
            // пальцем и обрезал последний пункт («Ассистент зала») —
            // казалось, что меню зависло (видео владельца 28.11.2026).
            // Низкий экран в hookah-pos — тоже одной лентой; высокий —
            // «Обновления» и «Сменить сотрудника» прижаты к низу, как было.
            if (kSaasMode) {
              return ListView(
                padding: EdgeInsets.zero,
                physics: const AlwaysScrollableScrollPhysics(),
                children: [...top, const SizedBox(height: 8), ...bottom],
              );
            }
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

/// Шапка меню: монограмма, имя антиквой и должность капителью — на той же
/// графитовой поверхности, что и меню. Без медной заливки: медь в кассе —
/// только кнопки действий.
class _StaffHeader extends StatelessWidget {
  final Employee employee;
  const _StaffHeader({required this.employee});

  static String _initials(String name) {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '·';
    final first = parts.first.characters.first;
    final second = parts.length > 1 ? parts[1].characters.first : '';
    return (first + second).toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final position = employee.role == AppConstants.roleAdmin
        ? 'Администратор'
        : AppConstants.positionShortLabel(AppConstants.normalizePosition(employee.position));
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 28, 20, 22),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border(bottom: BorderSide(color: AppColors.border)),
      ),
      child: Row(
        children: [
          Container(
            width: 56,
            height: 56,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: AppColors.background,
              border: Border.all(color: AppColors.brass.withValues(alpha: 0.7)),
            ),
            child: Text(_initials(employee.name), style: AppFonts.display(22, color: AppColors.brass)),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  employee.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppFonts.display(26),
                ),
                const SizedBox(height: 6),
                Text(position.toUpperCase(), style: AppFonts.overline),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
