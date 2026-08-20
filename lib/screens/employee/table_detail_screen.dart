import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/table_model.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../widgets/timer_display.dart';
import '../../utils/constants.dart';
import 'menu_selection_screen.dart';

class TableDetailScreen extends StatefulWidget {
  final TableModel table;
  final Employee employee;
  const TableDetailScreen({super.key, required this.table, required this.employee});

  @override
  State<TableDetailScreen> createState() => _TableDetailScreenState();
}

class _TableDetailScreenState extends State<TableDetailScreen> {
  final _fs = FirestoreService();
  bool _busy = false;

  void _showError(Object e) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(e.toString())));
  }

  Future<void> _startSession() async {
    setState(() => _busy = true);
    try {
      await _fs.openSession(table: widget.table, employeeName: widget.employee.name);
    } on TableAlreadyOccupiedException catch (e) {
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

  Future<void> _closeTable(String sessionId) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Закрыть стол'),
        content: const Text('Завершить сеанс и освободить стол? Изменить счёт после '
            'закрытия будет нельзя — он попадёт в отчёты в неизменном виде.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Закрыть')),
        ],
      ),
    );
    if (confirm == true) {
      try {
        await _fs.closeSession(sessionId, widget.table.id);
        if (mounted) Navigator.pop(context);
      } catch (e) {
        _showError('Не удалось закрыть стол — проверьте интернет');
      }
    }
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.table.name)),
      body: StreamBuilder<List<TableModel>>(
        stream: _fs.tablesStream(),
        builder: (context, tablesSnap) {
          if (tablesSnap.hasError) {
            return Center(
              child: Text('Ошибка соединения: ${tablesSnap.error}',
                  style: const TextStyle(color: Colors.red)),
            );
          }
          final t = tablesSnap.data?.firstWhere(
                (x) => x.id == widget.table.id,
                orElse: () => widget.table,
              ) ??
              widget.table;

          if (t.status != 'occupied' || t.currentSessionId == null) {
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
            stream: _fs.sessionStream(t.currentSessionId!),
            builder: (context, sessSnap) {
              if (sessSnap.hasError) {
                return Center(
                  child: Text('Ошибка соединения: ${sessSnap.error}',
                      style: const TextStyle(color: Colors.red)),
                );
              }
              final session = sessSnap.data;
              if (session == null) return const Center(child: CircularProgressIndicator());
              return SingleChildScrollView(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Center(child: TimerDisplay(plannedEnd: session.plannedEnd, fontSize: 56)),
                    const SizedBox(height: 4),
                    Center(
                        child: Text(
                            'Открыл: ${session.employeeName} · Перезабивок: ${session.refillCount}',
                            style: const TextStyle(color: Colors.grey))),
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
                      ],
                    ),
                    const Divider(height: 32),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text('Заказ', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                        TextButton.icon(
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
                        child: Text('Пока пусто', style: TextStyle(color: Colors.grey)),
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
                      style: FilledButton.styleFrom(backgroundColor: Colors.red.shade400),
                      onPressed: () => _closeTable(session.id),
                      icon: const Icon(Icons.stop_circle_outlined),
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
