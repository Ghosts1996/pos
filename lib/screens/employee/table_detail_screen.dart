import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/table_model.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../widgets/timer_display.dart';
import '../../widgets/clock_ticker.dart';
import '../../theme/app_colors.dart';
import '../../utils/constants.dart';
import 'menu_selection_screen.dart';
import 'payment_screen.dart';
import 'split_bill_screen.dart';
import '../../utils/table_label.dart';
import '../../services/venue_service.dart';
import '../../utils/human_error.dart';
import '../../utils/money.dart';

class TableDetailScreen extends StatefulWidget {
  final TableModel table;
  final Employee employee;

  /// Конкретный чек за столом, который нужно открыть. Если null (и на
  /// столе есть открытые чеки), экран сам выберет первый из них — но
  /// сотрудник сможет переключиться на другой через кнопку "Чеки за столом".
  final String? sessionId;

  const TableDetailScreen({
    super.key,
    required this.table,
    required this.employee,
    this.sessionId,
  });

  @override
  State<TableDetailScreen> createState() => _TableDetailScreenState();
}

class _TableDetailScreenState extends State<TableDetailScreen> {
  /// «Начать сеанс» — про кальян; в ресторане и кафе стол просто открывают.
  String get _startLabel => VenueService.instance.terms.isHookah ? 'Начать сеанс' : 'Открыть стол';
  final _fs = FirestoreService();
  bool _busy = false;
  String? _sessionId;

  @override
  void initState() {
    super.initState();
    _sessionId = widget.sessionId;
  }

  void _showError(Object e) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(e.toString())));
  }

  Future<void> _startSession() async {
    final guestTag = await _askGuestTag();
    if (guestTag == null) return; // отменили диалог

    setState(() => _busy = true);
    try {
      final id = await _fs.openSession(
        table: widget.table,
        employeeName: widget.employee.name,
        employeeId: widget.employee.id,
        guestTag: guestTag,
        durationMinutes: AppConstants.sessionMinutes,
      );
      if (mounted) setState(() => _sessionId = id);
    } on TableFullException catch (e) {
      _showError(e);
    } catch (e) {
      _showError('Не удалось начать сеанс — проверьте интернет');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Имя гостя, чтобы на плитке зала было видно, кто сидит за столом —
  /// не только таймер. Поле необязательное: подтвердить можно и пустым.
  /// Возвращает null, если сотрудник закрыл диалог кнопкой «Отмена».
  Future<String?> _askGuestTag() async {
    final ctrl = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Кто за столом?'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(
            labelText: 'Имя гостя (необязательно)',
            hintText: 'Например, Константин',
          ),
          onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Отмена'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: Text(_startLabel),
          ),
        ],
      ),
    );
    ctrl.dispose();
    return result;
  }

  Future<void> _refill(SessionModel session, bool unlimited) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Перезабивка'),
        content: Text(unlimited
            // Стол без ограничения времени: таймер не трогаем — только
            // отмечаем перезабивку и заново запускаем напоминание про угли.
            ? 'Отметить перезабивку? Напоминание про угли начнётся заново, '
                'время стола не ограничивается.'
            : 'Сбросить таймер и начать новые '
                '${AppConstants.formatSessionDuration(AppConstants.sessionMinutes)}?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Перезабить')),
        ],
      ),
    );
    if (confirm == true) {
      try {
        await _fs.refillSession(session.id,
            tableId: session.tableId,
            durationMinutes: unlimited ? AppConstants.unlimitedSessionMinutes : AppConstants.sessionMinutes);
      } catch (e) {
        _showError('Не удалось отметить перезабивку — проверьте интернет');
      }
    }
  }

  /// Разделить счёт — см. SplitBillScreen. Перенесли позиции в новый чек —
  /// предлагаем сразу к нему перейти.
  Future<void> _splitBill(TableModel t, SessionModel session) async {
    if (session.orderItems.isEmpty) {
      _showError('Сначала добавьте позиции в заказ');
      return;
    }
    final newId = await Navigator.of(context).push<String>(MaterialPageRoute(
      builder: (_) => SplitBillScreen(session: session, table: t, employee: widget.employee),
    ));
    if (newId == null || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: const Text('Счёт разделён — создан отдельный чек'),
      action: SnackBarAction(label: 'Открыть', onPressed: () {
        if (mounted) setState(() => _sessionId = newId);
      }),
    ));
  }

  /// «Время»: добавить или убавить минуты к сеансу. Одно нажатие —
  /// сразу применяется, в подсказке видно, до скольки теперь стол.
  Future<void> _extend(SessionModel session) async {
    final choice = await showModalBottomSheet<int>(
      context: context,
      showDragHandle: true,
      builder: (_) => _TimeAdjustSheet(plannedEnd: session.plannedEnd, startTime: session.startTime),
    );
    if (choice == null) return;
    try {
      await _fs.extendSession(session.id, session.plannedEnd, choice, tableId: session.tableId);
      if (!mounted) return;
      final end = session.plannedEnd.add(Duration(minutes: choice));
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('${choice > 0 ? '+$choice' : '−${-choice}'} мин · стол до ${_hhmm(end)}'),
        duration: const Duration(seconds: 2),
      ));
    } catch (e) {
      _showError('Не удалось изменить время — проверьте интернет');
    }
  }

  static String _hhmm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

  /// Раньше здесь стол закрывался напрямую, без экрана оплаты гостя. Теперь
  /// нажатие "Закрыть стол" открывает PaymentScreen (наличные/карта/за счёт
  /// заведения, контакт гостя, печать чеков) — закрытие происходит уже там.
  Future<void> _openPayment(SessionModel session) async {
    final done = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => PaymentScreen(session: session)),
    );
    if (done == true && mounted) Navigator.pop(context);
  }

  Future<void> _applyCard(String sessionId) async {
    final controller = TextEditingController();
    final number = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Скидочная карта'),
        content: TextField(
          controller: controller,
          decoration: const InputDecoration(hintText: 'Номер карты'),
          autofocus: true,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
          FilledButton(
              onPressed: () => Navigator.pop(context, controller.text.trim()),
              child: const Text('Применить')),
        ],
      ),
    );
    if (number == null || number.isEmpty) return;
    try {
      final card = await _fs.findCardByNumber(number);
      if (card == null) {
        _showError('Карта не найдена или деактивирована');
        return;
      }
      await _fs.applyDiscountCard(sessionId, card);
    } catch (e) {
      _showError('Не удалось применить карту — проверьте интернет');
    }
  }

  /// Открывает диалог для установки/смены подписи чека (кто сидит за
  /// столом) — показывается затем прямо на плитке стола на карте зала.
  Future<void> _editGuestTag(SessionModel session) async {
    final controller = TextEditingController(text: session.guestTag);
    final tag = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Кто сидит за столом'),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLength: 24,
          decoration: const InputDecoration(hintText: 'Например: Аня, Компания у окна'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
          FilledButton(
              onPressed: () => Navigator.pop(context, controller.text.trim()),
              child: const Text('Сохранить')),
        ],
      ),
    );
    if (tag == null) return;
    try {
      await _fs.setGuestTag(session.id, tag, tableId: session.tableId);
    } catch (e) {
      _showError('Не удалось сохранить подпись — проверьте интернет');
    }
  }

  /// Пересадка гостя за другой стол: показывает карту зала со свободными
  /// (и не заполненными до лимита) столами, переносит открытый чек на
  /// выбранный стол вместе со всем заказом, таймером и историей.
  Future<void> _moveTable(SessionModel session, TableModel currentTable) async {
    final target = await Navigator.of(context).push<TableModel>(
      MaterialPageRoute(
        builder: (_) => _MoveTableScreen(currentTable: currentTable, fs: _fs),
      ),
    );
    if (target == null) return;
    try {
      await _fs.moveSessionToTable(
        sessionId: session.id,
        fromTableId: currentTable.id,
        toTableId: target.id,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Гость пересажен за стол «${target.name}»')),
        );
        Navigator.pop(context);
      }
    } on TableFullException catch (e) {
      _showError(e);
    } catch (e) {
      _showError('Не удалось пересадить — проверьте интернет');
    }
  }

  Future<void> _removeCard(String sessionId) async {
    try {
      await _fs.applyDiscountCard(sessionId, null);
    } catch (e) {
      _showError('Не удалось убрать скидку — проверьте интернет');
    }
  }

  Future<void> _changeQty(String sessionId, String menuItemId, int delta) async {
    try {
      await _fs.changeOrderItemQty(sessionId, menuItemId, delta);
    } catch (e) {
      _showError('Не удалось изменить заказ — проверьте интернет');
    }
  }

  /// Показывает список всех открытых чеков стола: можно переключиться на
  /// другой чек или открыть новый (если позволяет лимит maxOpenSessions).
  Future<void> _pickAnotherCheck(TableModel t) async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (_) => _CheckPickerSheet(table: t, fs: _fs, currentId: _sessionId),
    );
    if (choice == null) return;
    if (choice == '__new__') {
      await _startSession();
    } else {
      setState(() => _sessionId = choice);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(tableLabel(widget.table.name))),
      // Подписываемся только на ЭТОТ стол (а не на всю коллекцию столов,
      // как было раньше) — так изменение любого другого стола в зале не
      // грузит сеть и не перестраивает этот экран лишний раз.
      body: StreamBuilder<TableModel?>(
        stream: _fs.tableStream(widget.table.id),
        builder: (context, tablesSnap) {
          if (tablesSnap.hasError) {
            return Center(
              child: Text('Ошибка соединения: ${humanError(tablesSnap.error, lower: true)}',
                  style: const TextStyle(color: AppColors.danger)),
            );
          }
          final t = tablesSnap.data ?? widget.table;

          // ВАЖНО: здесь намеренно НЕ сверяем _sessionId со списком
          // t.activeSessionIds стола. tablesStream — это отдельный, более
          // "медленный" стрим (коллекция tables), и сразу после создания
          // чека транзакцией openSession() он ещё какое-то время отдаёт
          // старый снимок без нового id. Если сверяться с ним прямо тут,
          // только что созданный чек на мгновение "не находится" в
          // activeSessionIds, экран сбрасывает _sessionId и снова
          // показывает кнопку "Начать сеанс" — а повторное нажатие создаёт
          // второй (и третий) чек. Поэтому единственный источник истины
          // для текущего чека — локальный _sessionId, а закрытие чека с
          // другого устройства отслеживается ниже напрямую по статусу
          // документа самой сессии (см. sessSnap/session.status).
          if (_sessionId == null) return _freeTable(t);

          return StreamBuilder<SessionModel?>(
            stream: _fs.sessionStream(_sessionId!),
            builder: (context, sessSnap) {
              if (sessSnap.hasError) {
                return Center(
                  child: Text('Ошибка соединения: ${humanError(sessSnap.error, lower: true)}',
                      style: const TextStyle(color: AppColors.danger)),
                );
              }
              final session = sessSnap.data;
              if (session == null) return const Center(child: CircularProgressIndicator());

              // Чек закрыли (в т.ч. с другого устройства через оплату) —
              // переключаемся на другой открытый чек этого стола или на
              // экран "Начать сеанс". Проверяем по статусу самого документа
              // чека, а не по activeSessionIds стола: это тот же документ,
              // что уже отображается на экране, поэтому здесь нет той
              // задержки, что была бы при сверке с отдельным стримом столов.
              if (session.status != 'active') {
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (!mounted) return;
                  final others =
                      t.activeSessionIds.where((id) => id != _sessionId).toList();
                  setState(() => _sessionId = others.isEmpty ? null : others.first);
                });
                return const Center(child: CircularProgressIndicator());
              }

              return _activeSession(t, session);
            },
          );
        },
      ),
    );
  }

  /// Свободный стол: одна понятная кнопка вместо голой кнопки посреди экрана.
  Widget _freeTable(TableModel t) {
    final duration = AppConstants.sessionUnlimited
        ? 'без ограничения времени'
        : 'сеанс ${AppConstants.formatSessionDuration(AppConstants.sessionMinutes)}';
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 88,
                height: 88,
                decoration: BoxDecoration(
                  color: AppColors.surface,
                  shape: BoxShape.circle,
                  border: Border.all(color: AppColors.border),
                ),
                child: const Icon(Icons.table_restaurant, size: 40, color: AppColors.success),
              ),
              const SizedBox(height: 16),
              const Text('Стол свободен', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
              const SizedBox(height: 6),
              Text('${seatsLabel(t.seats)} · $duration',
                  textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textMuted)),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                height: 56,
                child: FilledButton.icon(
                  onPressed: _busy ? null : _startSession,
                  icon: _busy
                      ? const SizedBox(
                          width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.play_arrow_rounded),
                  label: Text(_startLabel, style: const TextStyle(fontSize: 18)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Открытый чек: статус стола, действия плитками, заказ и закреплённая
  /// снизу панель с итогом — итог и «Закрыть стол» видны всегда, даже
  /// при длинном заказе.
  Widget _activeSession(TableModel t, SessionModel session) {
    final hookah = VenueService.instance.terms.isHookah;
    // «Перезабивка» — у того, кто отвечает за кальяны (кальянщик, а в
    // кальянной ещё универсал и админ), см. AppConstants.handlesHookah.
    final canRefill = widget.employee.handlesHookah(hookahVenue: hookah);
    // Стол «без ограничений» (см. AppConstants.unlimitedSessionMinutes):
    // таймер и кнопка «Время» ему не нужны — вместо отсчёта показываем,
    // сколько гости уже сидят.
    final unlimited = AppConstants.isUnlimitedRemaining(session.remaining);
    final hasOtherChecks = t.activeSessionIds.length > 1;
    final canAddMore = t.activeSessionIds.length < t.maxOpenSessions;
    final discounted = session.discountPercent > 0;

    final split = _TableAction(
      icon: Icons.call_split_rounded,
      label: 'Разделить',
      hint: 'счёт на части',
      // Кто кальяны не ведёт, у того «Перезабивки» нет — главное место
      // занимает раздел счёта.
      accent: !canRefill,
      onTap: () => _splitBill(t, session),
    );
    final actions = <_TableAction>[
      if (canRefill)
        _TableAction(
          icon: Icons.refresh_rounded,
          label: 'Перезабивка',
          hint: unlimited ? 'угли заново' : null,
          accent: true,
          onTap: () => _refill(session, unlimited),
        ),
      if (!canRefill) split,
      if (!unlimited)
        _TableAction(
          icon: Icons.more_time_rounded,
          label: 'Время',
          hint: '± 5 · 10 · 30 мин',
          onTap: () => _extend(session),
        ),
      _TableAction(
        icon: Icons.local_offer_outlined,
        label: session.guestTag.isEmpty ? 'Подписать' : 'Подпись',
        hint: session.guestTag.isEmpty ? 'кто за столом' : session.guestTag,
        onTap: () => _editGuestTag(session),
      ),
      _TableAction(
        icon: discounted ? Icons.percent_rounded : Icons.card_giftcard,
        label: discounted ? 'Скидка ${session.discountPercent.toStringAsFixed(0)}%' : 'Скидка',
        hint: discounted ? 'убрать' : 'по карте',
        onTap: () => discounted ? _removeCard(session.id) : _applyCard(session.id),
      ),
      _TableAction(
        icon: Icons.swap_horiz_rounded,
        label: 'Пересадить',
        hint: 'за другой стол',
        onTap: () => _moveTable(session, t),
      ),
      if (canRefill) split,
      if (hasOtherChecks || canAddMore)
        _TableAction(
          icon: Icons.receipt_long_outlined,
          label: hasOtherChecks ? 'Чеки' : 'Ещё чек',
          hint: hasOtherChecks
              ? '${t.activeSessionIds.length} из ${t.maxOpenSessions}'
              : 'отдельный счёт',
          onTap: () => _pickAnotherCheck(t),
        ),
    ];

    return LayoutBuilder(builder: (context, box) {
      // На планшете содержимое не растягивается на всю ширину — так его
      // удобнее читать; на телефоне — стандартные поля 16.
      final side = box.maxWidth > 792 ? (box.maxWidth - 760) / 2 : 16.0;
      return Column(
        children: [
          Expanded(
            child: ListView(
              padding: EdgeInsets.fromLTRB(side, 12, side, 24),
              children: [
                _SessionStatusCard(session: session, showRefills: canRefill, unlimited: unlimited),
                const SizedBox(height: 12),
                _ActionGrid(actions: actions),
                const SizedBox(height: 24),
                _orderHeader(session),
                const SizedBox(height: 10),
                if (session.orderItems.isEmpty)
                  _emptyOrder(session)
                else
                  _orderList(session),
              ],
            ),
          ),
          _TotalBar(session: session, side: side, onPay: () => _openPayment(session)),
        ],
      );
    });
  }

  Future<void> _openMenu(SessionModel session) => Navigator.of(context)
      .push(MaterialPageRoute(builder: (_) => MenuSelectionScreen(session: session)));

  Widget _orderHeader(SessionModel session) {
    final count = session.orderItems.fold<int>(0, (a, i) => a + i.qty);
    return Row(
      children: [
        const Text('Заказ', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
        if (count > 0)
          Text('  ·  $count ${pluralRu(count, 'позиция', 'позиции', 'позиций')}',
              style: const TextStyle(color: AppColors.textMuted)),
        const Spacer(),
        FilledButton.icon(
          style: FilledButton.styleFrom(
            minimumSize: const Size(0, 44),
            padding: const EdgeInsets.symmetric(horizontal: 16),
          ),
          onPressed: () => _openMenu(session),
          icon: const Icon(Icons.add),
          label: const Text('Добавить'),
        ),
      ],
    );
  }

  Widget _emptyOrder(SessionModel session) => Material(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () => _openMenu(session),
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 28, horizontal: 16),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.border),
            ),
            child: const Column(
              children: [
                Icon(Icons.restaurant_menu, size: 34, color: AppColors.textMuted),
                SizedBox(height: 10),
                Text('Заказ пока пуст', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                SizedBox(height: 4),
                Text('Нажмите, чтобы открыть меню', style: TextStyle(color: AppColors.textMuted)),
              ],
            ),
          ),
        ),
      );

  Widget _orderList(SessionModel session) {
    final rows = <Widget>[];
    for (var k = 0; k < session.orderItems.length; k++) {
      final i = session.orderItems[k];
      if (k > 0) rows.add(const Divider(height: 1, color: AppColors.border));
      rows.add(Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(i.name,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text('${_money(i.price)} × ${i.qty}',
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
                ],
              ),
            ),
            if (i.menuItemId.isNotEmpty)
              _QtyStepper(
                qty: i.qty,
                onMinus: () => _changeQty(session.id, i.menuItemId, -1),
                onPlus: () => _changeQty(session.id, i.menuItemId, 1),
              ),
            SizedBox(
              width: 76,
              child: Text(_money(i.total),
                  textAlign: TextAlign.right,
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            ),
          ],
        ),
      ));
    }
    if (session.discountPercent > 0) {
      rows.add(const Divider(height: 1, color: AppColors.border));
      rows.add(Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(
          children: [
            Expanded(
              child: Text('Скидка ${session.discountPercent.toStringAsFixed(0)}%',
                  style: const TextStyle(color: AppColors.success)),
            ),
            Text('−${_money(session.orderTotal - session.totalWithDiscount)}',
                style: const TextStyle(color: AppColors.success, fontWeight: FontWeight.w600)),
          ],
        ),
      ));
    }
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(children: rows),
    );
  }
}

String _money(double v) => rub(v);

String _hhmm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

String _sat(Duration d) => TimerDisplay.formatSat(d);

/// Главная карточка стола: сколько осталось (или сколько уже сидят, если
/// время не ограничено), кто открыл, подпись, перезабивки, скидка.
class _SessionStatusCard extends StatelessWidget {
  final SessionModel session;
  final bool showRefills;
  final bool unlimited;
  const _SessionStatusCard({required this.session, required this.showRefills, required this.unlimited});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TickerBuilder(builder: (context, now) {
            final left = session.plannedEnd.difference(now);
            final sat = now.difference(session.startTime);
            final String caption;
            final String big;
            final String sub;
            final Color color;
            if (unlimited) {
              caption = 'За столом';
              big = _sat(sat);
              sub = 'с ${_hhmm(session.startTime)}';
              color = AppColors.textPrimary;
            } else if (left.isNegative) {
              caption = 'Время вышло';
              big = '+${TimerDisplay.formatRemaining(-left)}';
              sub = 'закончилось в ${_hhmm(session.plannedEnd)} · за столом ${_sat(sat)}';
              color = AppColors.danger;
            } else {
              caption = 'Осталось';
              big = TimerDisplay.formatRemaining(left);
              sub = 'до ${_hhmm(session.plannedEnd)} · за столом ${_sat(sat)}';
              color = TimerDisplay.colorFor(left);
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(caption, style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
                const SizedBox(height: 2),
                Text(big,
                    style: TextStyle(
                      fontSize: 36,
                      fontWeight: FontWeight.w700,
                      color: color,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    )),
                Text(sub, style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
              ],
            );
          }),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _InfoChip(icon: Icons.person_outline, text: session.employeeName.isEmpty ? '—' : session.employeeName),
              if (showRefills)
                _InfoChip(
                  icon: Icons.refresh_rounded,
                  text: session.refillCount == 0
                      ? 'без перезабивок'
                      : '${session.refillCount} ${pluralRu(session.refillCount, 'перезабивка', 'перезабивки', 'перезабивок')}',
                ),
              if (session.discountPercent > 0)
                _InfoChip(
                  icon: Icons.percent_rounded,
                  text: 'скидка ${session.discountPercent.toStringAsFixed(0)}%',
                  color: AppColors.success,
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _InfoChip extends StatelessWidget {
  final IconData icon;
  final String text;
  final Color color;
  const _InfoChip({required this.icon, required this.text, this.color = AppColors.textMuted});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: AppColors.surfaceElevated,
          borderRadius: BorderRadius.circular(999),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 16, color: color),
            const SizedBox(width: 6),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 180),
              child: Text(text,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: color == AppColors.textMuted ? AppColors.textPrimary : color, fontSize: 13)),
            ),
          ],
        ),
      );
}

class _TableAction {
  final IconData icon;
  final String label;
  final String? hint;
  final bool accent;
  final VoidCallback onTap;
  const _TableAction({required this.icon, required this.label, this.hint, this.accent = false, required this.onTap});
}

/// Действия со столом — ровной сеткой плиток: 3 в ряд на телефоне, больше
/// на планшете. Раньше это были кнопки разной ширины во всю строку.
class _ActionGrid extends StatelessWidget {
  final List<_TableAction> actions;
  const _ActionGrid({required this.actions});

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      const gap = 10.0;
      final cols = box.maxWidth < 440 ? 3 : (box.maxWidth < 640 ? 4 : 6);
      final w = (box.maxWidth - gap * (cols - 1)) / cols;
      return Wrap(
        spacing: gap,
        runSpacing: gap,
        children: [
          for (final a in actions)
            SizedBox(
              width: w,
              child: Material(
                color: a.accent ? AppColors.primary : AppColors.surface,
                borderRadius: BorderRadius.circular(16),
                child: InkWell(
                  borderRadius: BorderRadius.circular(16),
                  onTap: a.onTap,
                  child: Container(
                    constraints: const BoxConstraints(minHeight: 88),
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: a.accent ? AppColors.primary : AppColors.border),
                    ),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(a.icon, size: 26, color: AppColors.textPrimary),
                        const SizedBox(height: 6),
                        Text(a.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            textAlign: TextAlign.center,
                            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                        if (a.hint != null)
                          Text(a.hint!,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                  fontSize: 11,
                                  color: a.accent ? AppColors.textPrimary.withValues(alpha: 0.8) : AppColors.textMuted)),
                      ],
                    ),
                  ),
                ),
              ),
            ),
        ],
      );
    });
  }
}

/// − 2 + — количество позиции прямо в строке заказа.
class _QtyStepper extends StatelessWidget {
  final int qty;
  final VoidCallback onMinus;
  final VoidCallback onPlus;
  const _QtyStepper({required this.qty, required this.onMinus, required this.onPlus});

  @override
  Widget build(BuildContext context) {
    Widget btn(IconData icon, VoidCallback onTap, String tip) => SizedBox(
          width: 36,
          height: 36,
          child: IconButton(
            tooltip: tip,
            padding: EdgeInsets.zero,
            iconSize: 18,
            onPressed: onTap,
            icon: Icon(icon),
          ),
        );
    return Container(
      margin: const EdgeInsets.only(left: 8),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          btn(Icons.remove, onMinus, 'Меньше'),
          SizedBox(
            width: 24,
            child: Text('$qty',
                textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.w600)),
          ),
          btn(Icons.add, onPlus, 'Больше'),
        ],
      ),
    );
  }
}

/// Итог и «Закрыть стол» — закреплены внизу экрана.
class _TotalBar extends StatelessWidget {
  final SessionModel session;
  final double side;
  final VoidCallback onPay;
  const _TotalBar({required this.session, required this.side, required this.onPay});

  @override
  Widget build(BuildContext context) {
    final discounted = session.discountPercent > 0;
    return Container(
      decoration: const BoxDecoration(
        color: AppColors.surfaceElevated,
        border: Border(top: BorderSide(color: AppColors.border)),
      ),
      padding: EdgeInsets.fromLTRB(side, 12, side, 12 + MediaQuery.of(context).padding.bottom),
      child: Row(
        children: [
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Итого', style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Text(_money(session.totalWithDiscount),
                        style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
                    if (discounted) ...[
                      const SizedBox(width: 8),
                      Text(_money(session.orderTotal),
                          style: const TextStyle(
                            color: AppColors.textMuted,
                            decoration: TextDecoration.lineThrough,
                          )),
                    ],
                  ],
                ),
              ],
            ),
          ),
          SizedBox(
            height: 56,
            child: FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.success,
                foregroundColor: Colors.black,
                padding: const EdgeInsets.symmetric(horizontal: 22),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              ),
              onPressed: onPay,
              icon: const Icon(Icons.payments_outlined),
              label: const Text('Закрыть стол', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            ),
          ),
        ],
      ),
    );
  }
}

/// Карта зала для выбора стола, на который переносится гость. Показывает
/// все столы; занятые до предела столы отмечены и недоступны для выбора —
/// пересадить на уже полностью занятый стол нельзя.
class _MoveTableScreen extends StatelessWidget {
  final TableModel currentTable;
  final FirestoreService fs;
  const _MoveTableScreen({required this.currentTable, required this.fs});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Пересадить на стол')),
      body: StreamBuilder<List<TableModel>>(
        stream: fs.tablesStream(),
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final tables = snap.data!.where((t) => t.id != currentTable.id).toList()
            ..sort((a, b) => a.name.compareTo(b.name));
          if (tables.isEmpty) {
            return const Center(child: Text('Других столов в зале нет'));
          }
          return ListView.separated(
            padding: const EdgeInsets.all(12),
            itemCount: tables.length,
            separatorBuilder: (_, __) => const SizedBox(height: 8),
            itemBuilder: (context, index) {
              final t = tables[index];
              final full = t.isFull;
              return Material(
                color: AppColors.surface,
                borderRadius: BorderRadius.circular(10),
                child: ListTile(
                  enabled: !full,
                  leading: Icon(
                    t.status == 'occupied' ? Icons.event_seat : Icons.chair_outlined,
                    color: t.status == 'occupied' ? AppColors.danger : Colors.green,
                  ),
                  title: Text(t.name),
                  subtitle: Text(t.status == 'occupied'
                      ? full
                          ? 'Занят, чеков: ${t.activeSessionIds.length}/${t.maxOpenSessions} — уже максимум'
                          : 'Занят, но можно открыть ещё чек (${t.activeSessionIds.length}/${t.maxOpenSessions})'
                      : 'Свободен · ${seatsLabel(t.seats)}'),
                  onTap: full ? null : () => Navigator.pop(context, t),
                ),
              );
            },
          );
        },
      ),
    );
  }
}

/// Нижний лист со списком открытых чеков стола + возможность открыть новый.
class _CheckPickerSheet extends StatelessWidget {
  final TableModel table;
  final FirestoreService fs;
  final String? currentId;

  const _CheckPickerSheet({required this.table, required this.fs, required this.currentId});

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: StreamBuilder<List<SessionModel>>(
        stream: fs.activeSessionsStream(table.id),
        builder: (context, snap) {
          final sessions = snap.data ?? [];
          return Wrap(
            children: [
              const Padding(
                padding: EdgeInsets.all(12),
                child: Text('Чеки за столом', style: TextStyle(fontWeight: FontWeight.bold)),
              ),
              if (!snap.hasData)
                const Padding(
                  padding: EdgeInsets.all(24),
                  child: Center(child: CircularProgressIndicator()),
                ),
              ...sessions.asMap().entries.map((e) {
                final index = e.key;
                final s = e.value;
                final isCurrent = s.id == currentId;
                final title = s.guestTag.isEmpty
                    ? 'Чек ${index + 1} · ${s.employeeName}'
                    : 'Чек ${index + 1} · ${s.guestTag}';
                return ListTile(
                  leading: Icon(isCurrent ? Icons.radio_button_checked : Icons.receipt_outlined),
                  title: Text(title),
                  subtitle: Text(
                      '${s.employeeName} · ${rub(s.totalWithDiscount)}'),
                  onTap: () => Navigator.pop(context, s.id),
                );
              }),
              if (table.activeSessionIds.length < table.maxOpenSessions)
                ListTile(
                  leading: const Icon(Icons.add_circle_outline),
                  title: const Text('Открыть новый чек'),
                  onTap: () => Navigator.pop(context, '__new__'),
                ),
            ],
          );
        },
      ),
    );
  }
}

/// Нижняя панель «Время»: +5/+10/+30 и −5/−10/−30 минут. Убавить так,
/// чтобы конец сеанса оказался раньше его начала, нельзя — такие кнопки
/// неактивны.
class _TimeAdjustSheet extends StatelessWidget {
  final DateTime plannedEnd;
  final DateTime startTime;
  const _TimeAdjustSheet({required this.plannedEnd, required this.startTime});

  static String _hhmm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

  /// «+10» крупно и «мин» под ним — в узкой кнопке на телефоне не
  /// переносится на две строки.
  static Widget _label(String value) => Column(mainAxisSize: MainAxisSize.min, children: [
        Text(value, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, height: 1.1)),
        const Text('мин', style: TextStyle(fontSize: 12, height: 1.1)),
      ]);

  @override
  Widget build(BuildContext context) {
    final left = plannedEnd.difference(DateTime.now());
    final leftText = left.isNegative
        ? 'время вышло ${TimerDisplay.formatSat(-left)} назад'
        : 'осталось ${TimerDisplay.formatSat(left)}';
    Widget row(String title, IconData icon, bool add) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Icon(icon, size: 18, color: add ? AppColors.success : AppColors.warning),
              const SizedBox(width: 6),
              Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
            ]),
            const SizedBox(height: 10),
            Row(children: [
              for (final m in AppConstants.extendOptions) ...[
                if (m != AppConstants.extendOptions.first) const SizedBox(width: 10),
                Expanded(
                  child: SizedBox(
                    height: 64,
                    child: add
                        ? FilledButton.tonal(
                            style: FilledButton.styleFrom(
                                padding: EdgeInsets.zero,
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16))),
                            onPressed: () => Navigator.pop(context, m),
                            child: _label('+$m'),
                          )
                        : OutlinedButton(
                            style: OutlinedButton.styleFrom(
                                padding: EdgeInsets.zero,
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16))),
                            onPressed: plannedEnd.subtract(Duration(minutes: m)).isAfter(startTime)
                                ? () => Navigator.pop(context, -m)
                                : null,
                            child: _label('−$m'),
                          ),
                  ),
                ),
              ],
            ]),
          ],
        );
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Время стола', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text('Сейчас до ${_hhmm(plannedEnd)} · $leftText',
                style: const TextStyle(color: AppColors.textMuted)),
            const SizedBox(height: 20),
            row('Добавить', Icons.add_circle_outline, true),
            const SizedBox(height: 18),
            row('Убавить', Icons.remove_circle_outline, false),
          ],
        ),
      ),
    );
  }
}
