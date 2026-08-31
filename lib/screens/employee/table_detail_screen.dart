import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/table_model.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../widgets/timer_display.dart';
import '../../theme/app_colors.dart';
import '../../utils/constants.dart';
import 'menu_selection_screen.dart';
import 'payment_screen.dart';

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
    setState(() => _busy = true);
    try {
      final id =
          await _fs.openSession(table: widget.table, employeeName: widget.employee.name);
      if (mounted) setState(() => _sessionId = id);
    } on TableFullException catch (e) {
      _showError(e);
    } catch (e) {
      _showError('Не удалось начать сеанс — проверьте интернет');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refill(String sessionId) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Перезабивка'),
        content: const Text('Сбросить таймер и начать новые 1.5 часа?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Перезабить')),
        ],
      ),
    );
    if (confirm == true) {
      try {
        await _fs.refillSession(sessionId);
      } catch (e) {
        _showError('Не удалось обновить таймер — проверьте интернет');
      }
    }
  }

  Future<void> _extend(String sessionId, DateTime plannedEnd) async {
    final choice = await showModalBottomSheet<int>(
      context: context,
      builder: (_) => SafeArea(
        child: Wrap(
          children: [
            const Padding(
              padding: EdgeInsets.all(12),
              child: Text('Обновить таймер', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
            ...AppConstants.extendOptions.map((m) => ListTile(
                  leading: const Icon(Icons.add_alarm),
                  title: Text('+ $m мин'),
                  onTap: () => Navigator.pop(context, m),
                )),
            ListTile(
              leading: const Icon(Icons.remove_circle_outline),
              title: const Text('- 15 мин'),
              onTap: () => Navigator.pop(context, -15),
            ),
          ],
        ),
      ),
    );
    if (choice != null) {
      try {
        await _fs.extendSession(sessionId, plannedEnd, choice);
      } catch (e) {
        _showError('Не удалось обновить таймер — проверьте интернет');
      }
    }
  }

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
      await _fs.setGuestTag(session.id, tag);
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
      appBar: AppBar(title: Text(widget.table.name)),
      // Подписываемся только на ЭТОТ стол (а не на всю коллекцию столов,
      // как было раньше) — так изменение любого другого стола в зале не
      // грузит сеть и не перестраивает этот экран лишний раз.
      body: StreamBuilder<TableModel?>(
        stream: _fs.tableStream(widget.table.id),
        builder: (context, tablesSnap) {
          if (tablesSnap.hasError) {
            return Center(
              child: Text('Ошибка соединения: ${tablesSnap.error}',
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
          if (_sessionId == null) {
            return Center(
              child: _busy
                  ? const CircularProgressIndicator()
                  : ElevatedButton.icon(
                      onPressed: _startSession,
                      icon: const Icon(Icons.play_arrow),
                      label: const Text('Начать сеанс (1.5 часа)'),
                    ),
            );
          }

          return StreamBuilder<SessionModel?>(
            stream: _fs.sessionStream(_sessionId!),
            builder: (context, sessSnap) {
              if (sessSnap.hasError) {
                return Center(
                  child: Text('Ошибка соединения: ${sessSnap.error}',
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

              final hasOtherChecks = t.activeSessionIds.length > 1;
              final canAddMore = t.activeSessionIds.length < t.maxOpenSessions;

              return SingleChildScrollView(
                // Обычный EdgeInsets.all(16) не учитывал системную зону снизу
                // (жестовая навигация на части устройств) — кнопка "Закрыть
                // стол", последняя в списке, обрезалась/перекрывалась
                // системными иконками. Добавляем нижний safe-area отступ
                // поверх обычного паддинга.
                padding: EdgeInsets.fromLTRB(
                  16,
                  16,
                  16,
                  16 + MediaQuery.of(context).padding.bottom,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (hasOtherChecks || canAddMore)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: OutlinedButton.icon(
                          onPressed: () => _pickAnotherCheck(t),
                          icon: const Icon(Icons.receipt_long),
                          label: Text(hasOtherChecks
                              ? 'Чеки за столом (${t.activeSessionIds.length}/${t.maxOpenSessions})'
                              : 'Открыть ещё один чек'),
                        ),
                      ),
                    Center(child: TimerDisplay(plannedEnd: session.plannedEnd, fontSize: 56)),
                    const SizedBox(height: 4),
                    Center(
                        child: Text(
                            'Открыл: ${session.employeeName} · Перезабивок: ${session.refillCount}',
                            style: const TextStyle(color: AppColors.textMuted))),
                    const SizedBox(height: 8),
                    Center(
                      child: OutlinedButton.icon(
                        onPressed: () => _editGuestTag(session),
                        icon: const Icon(Icons.local_offer_outlined, size: 18),
                        label: Text(session.guestTag.isEmpty
                            ? 'Подписать стол'
                            : 'Подпись: ${session.guestTag}'),
                      ),
                    ),
                    const SizedBox(height: 20),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      alignment: WrapAlignment.center,
                      children: [
                        ElevatedButton.icon(
                          onPressed: () => _refill(session.id),
                          icon: const Icon(Icons.refresh),
                          label: const Text('Перезабивка'),
                        ),
                        ElevatedButton.icon(
                          onPressed: () => _extend(session.id, session.plannedEnd),
                          icon: const Icon(Icons.timer),
                          label: const Text('Обновить таймер'),
                        ),
                        OutlinedButton.icon(
                          onPressed: () => session.discountPercent > 0
                              ? _removeCard(session.id)
                              : _applyCard(session.id),
                          icon: Icon(session.discountPercent > 0
                              ? Icons.remove_circle_outline
                              : Icons.card_giftcard),
                          label: Text(session.discountPercent > 0
                              ? 'Скидка ${session.discountPercent.toStringAsFixed(0)}% (убрать)'
                              : 'Скидочная карта'),
                        ),
                        OutlinedButton.icon(
                          onPressed: () => _moveTable(session, t),
                          icon: const Icon(Icons.sync_alt),
                          label: const Text('Пересадить стол'),
                        ),
                      ],
                    ),
                    const Divider(height: 32),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text('Заказ', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                        FilledButton.tonalIcon(
                          style: FilledButton.styleFrom(
                            backgroundColor: AppColors.primary,
                            foregroundColor: AppColors.textPrimary,
                            minimumSize: const Size(0, 40),
                            padding: const EdgeInsets.symmetric(horizontal: 16),
                          ),
                          onPressed: () async {
                            await Navigator.of(context).push(MaterialPageRoute(
                                builder: (_) => MenuSelectionScreen(session: session)));
                          },
                          icon: const Icon(Icons.add),
                          label: const Text('Добавить'),
                        ),
                      ],
                    ),
                    if (session.orderItems.isEmpty)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 8),
                        child: Text('Пока пусто', style: TextStyle(color: AppColors.textMuted)),
                      ),
                    ...session.orderItems.map((i) => ListTile(
                          dense: true,
                          title: Text(i.name),
                          subtitle: Text(
                              '${i.price.toStringAsFixed(0)} ${AppConstants.currencySymbol} × ${i.qty} = ${i.total.toStringAsFixed(0)} ${AppConstants.currencySymbol}'),
                          trailing: i.menuItemId.isEmpty
                              ? null
                              : Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    IconButton(
                                      icon: const Icon(Icons.remove_circle_outline),
                                      onPressed: () => _changeQty(session.id, i.menuItemId, -1),
                                    ),
                                    Text('${i.qty}'),
                                    IconButton(
                                      icon: const Icon(Icons.add_circle_outline),
                                      onPressed: () => _changeQty(session.id, i.menuItemId, 1),
                                    ),
                                  ],
                                ),
                        )),
                    const Divider(),
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Text('Итого', style: TextStyle(fontWeight: FontWeight.bold)),
                          Text('${session.totalWithDiscount.toStringAsFixed(0)} ${AppConstants.currencySymbol}',
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    FilledButton.icon(
                      style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
                      onPressed: () => _openPayment(session),
                      icon: const Icon(Icons.payment),
                      label: const Text('Закрыть стол'),
                    ),
                  ],
                ),
              );
            },
          );
        },
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
                      : 'Свободен · ${t.seats} мест'),
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
                      '${s.employeeName} · ${s.totalWithDiscount.toStringAsFixed(0)} ${AppConstants.currencySymbol}'),
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