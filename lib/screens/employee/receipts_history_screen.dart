import '../../theme/app_colors.dart';
import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../utils/constants.dart';

enum _Period { today, week, month, custom }

/// История закрытых чеков с возможностью сделать возврат — аналог раздела
/// "Возврат чеков" в Restik POS. Список фильтруется по периоду; по нажатию
/// на чек открывается его состав с кнопкой оформления возврата.
class ReceiptsHistoryScreen extends StatefulWidget {
  final Employee employee;
  const ReceiptsHistoryScreen({super.key, required this.employee});

  @override
  State<ReceiptsHistoryScreen> createState() => _ReceiptsHistoryScreenState();
}

class _ReceiptsHistoryScreenState extends State<ReceiptsHistoryScreen> {
  final _fs = FirestoreService();
  _Period _period = _Period.today;
  DateTimeRange? _customRange;
  Future<List<SessionModel>>? _future;

  @override
  void initState() {
    super.initState();
    _load();
  }

  DateTimeRange _rangeFor() {
    final now = DateTime.now();
    final todayStart = DateTime(now.year, now.month, now.day);
    final tomorrowStart = todayStart.add(const Duration(days: 1));
    switch (_period) {
      case _Period.today:
        return DateTimeRange(start: todayStart, end: tomorrowStart);
      case _Period.week:
        return DateTimeRange(start: todayStart.subtract(const Duration(days: 6)), end: tomorrowStart);
      case _Period.month:
        return DateTimeRange(start: todayStart.subtract(const Duration(days: 29)), end: tomorrowStart);
      case _Period.custom:
        if (_customRange == null) return DateTimeRange(start: todayStart, end: tomorrowStart);
        final end =
            DateTime(_customRange!.end.year, _customRange!.end.month, _customRange!.end.day)
                .add(const Duration(days: 1));
        return DateTimeRange(
          start: DateTime(
              _customRange!.start.year, _customRange!.start.month, _customRange!.start.day),
          end: end,
        );
    }
  }

  void _load() {
    final range = _rangeFor();
    setState(() {
      _future = _fs.closedSessionsInRange(range.start, range.end);
    });
  }

  Future<void> _pickCustomRange() async {
    final now = DateTime.now();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year - 2),
      lastDate: now,
      initialDateRange:
          _customRange ?? DateTimeRange(start: now.subtract(const Duration(days: 6)), end: now),
    );
    if (picked != null) {
      setState(() {
        _customRange = picked;
        _period = _Period.custom;
      });
      _load();
    }
  }

  Future<void> _confirmRefund(SessionModel s) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Возврат чека'),
        content: Text(
            'Оформить возврат чека на ${s.totalWithDiscount.toStringAsFixed(0)} ${AppConstants.currencySymbol} '
            '(${s.tableName})?\nЧек больше не будет учитываться в выручке отчётов.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Отмена')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Оформить возврат'),
          ),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await _fs.refundSession(s.id);
      _load();
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Возврат оформлен')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось оформить возврат: $e')));
      }
    }
  }

  void _openDetails(SessionModel s) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (_) => DraggableScrollableSheet(
        initialChildSize: 0.6,
        maxChildSize: 0.9,
        expand: false,
        builder: (context, scrollController) => Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('${s.tableName} · ${s.employeeName}',
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              Text(
                '${_formatDateTime(s.startTime)} — ${s.closedAt != null ? _formatDateTime(s.closedAt!) : ''}',
                style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
              ),
              const Divider(),
              Expanded(
                child: ListView(
                  controller: scrollController,
                  children: s.orderItems
                      .map((i) => ListTile(
                            dense: true,
                            title: Text(i.name),
                            trailing: Text(
                                '${i.qty} × ${i.price.toStringAsFixed(0)} = ${i.total.toStringAsFixed(0)} ${AppConstants.currencySymbol}'),
                          ))
                      .toList(),
                ),
              ),
              const Divider(),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('К оплате', style: TextStyle(fontWeight: FontWeight.bold)),
                  Text('${s.totalWithDiscount.toStringAsFixed(0)} ${AppConstants.currencySymbol}',
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
                ],
              ),
              Text(
                'Карта: ${s.paymentCard.toStringAsFixed(0)} · Наличные: ${s.paymentCash.toStringAsFixed(0)} · Терминал: ${s.paymentTerminal.toStringAsFixed(0)} · За счёт заведения: ${s.paymentComp.toStringAsFixed(0)}',
                style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
              ),
              const SizedBox(height: 12),
              if (s.refunded)
                const Chip(
                  label: Text('Возврат оформлен'),
                  avatar: Icon(Icons.undo, size: 16),
                )
              else
                FilledButton.icon(
                  style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
                  onPressed: () {
                    Navigator.pop(context);
                    _confirmRefund(s);
                  },
                  icon: const Icon(Icons.undo),
                  label: const Text('Оформить возврат'),
                ),
            ],
          ),
        ),
      ),
    );
  }

  String _formatDateTime(DateTime d) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(d.day)}.${two(d.month)} ${two(d.hour)}:${two(d.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('История чеков')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                ChoiceChip(
                  label: const Text('Сегодня'),
                  selected: _period == _Period.today,
                  onSelected: (_) {
                    setState(() => _period = _Period.today);
                    _load();
                  },
                ),
                ChoiceChip(
                  label: const Text('7 дней'),
                  selected: _period == _Period.week,
                  onSelected: (_) {
                    setState(() => _period = _Period.week);
                    _load();
                  },
                ),
                ChoiceChip(
                  label: const Text('30 дней'),
                  selected: _period == _Period.month,
                  onSelected: (_) {
                    setState(() => _period = _Period.month);
                    _load();
                  },
                ),
                ChoiceChip(
                  label: const Text('Свой период'),
                  selected: _period == _Period.custom,
                  onSelected: (_) => _pickCustomRange(),
                ),
              ],
            ),
          ),
          Expanded(
            child: FutureBuilder<List<SessionModel>>(
              future: _future,
              builder: (context, snap) {
                if (snap.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snap.hasError) {
                  return Center(
                      child: Text('Ошибка загрузки: ${snap.error}',
                          style: const TextStyle(color: AppColors.danger)));
                }
                final sessions = snap.data ?? [];
                if (sessions.isEmpty) {
                  return const Center(child: Text('За этот период закрытых чеков нет'));
                }
                return RefreshIndicator(
                  onRefresh: () async => _load(),
                  child: ListView.builder(
                    padding: const EdgeInsets.only(bottom: 24),
                    itemCount: sessions.length,
                    itemBuilder: (context, index) {
                      final s = sessions[index];
                      return ListTile(
                        leading: Icon(s.refunded ? Icons.undo : Icons.receipt_long,
                            color: s.refunded ? Colors.orange : null),
                        title: Text('${s.tableName} · ${s.employeeName}'),
                        subtitle: Text(
                          '${_formatDateTime(s.startTime)} — ${s.closedAt != null ? _formatDateTime(s.closedAt!) : ''}'
                          '${s.refunded ? '  ·  возврат оформлен' : ''}',
                        ),
                        trailing: Text(
                          '${s.totalWithDiscount.toStringAsFixed(0)} ${AppConstants.currencySymbol}',
                          style: TextStyle(
                            fontWeight: FontWeight.bold,
                            decoration: s.refunded ? TextDecoration.lineThrough : null,
                            color: s.refunded ? AppColors.textMuted : null,
                          ),
                        ),
                        onTap: () => _openDetails(s),
                      );
                    },
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}