import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../utils/constants.dart';

enum _Period { today, week, month, custom }

/// Отчёты по закрытым счетам — единственная замена кассовому Z-отчёту в
/// этом приложении. Считает выручку, средний чек, перезабивки, разбивку по
/// сотрудникам и по позициям меню за выбранный период. Данные берутся из
/// уже закрытых (status == 'closed') сеансов — активные счета в отчёт не
/// попадают, пока стол не закрыт. Возвращённые чеки (refunded == true) в
/// выручку не включаются и учитываются отдельной строкой "Возвраты".
class ReportsScreen extends StatefulWidget {
  const ReportsScreen({super.key});

  @override
  State<ReportsScreen> createState() => _ReportsScreenState();
}

class _ReportsScreenState extends State<ReportsScreen> {
  final _fs = FirestoreService();
  _Period _period = _Period.today;
  DateTimeRange? _customRange;
  Future<List<SessionModel>>? _future;

  @override
  void initState() {
    super.initState();
    _load();
  }

  DateTimeRange _rangeFor(_Period p) {
    final now = DateTime.now();
    final todayStart = DateTime(now.year, now.month, now.day);
    final tomorrowStart = todayStart.add(const Duration(days: 1));
    switch (p) {
      case _Period.today:
        return DateTimeRange(start: todayStart, end: tomorrowStart);
      case _Period.week:
        return DateTimeRange(start: todayStart.subtract(const Duration(days: 6)), end: tomorrowStart);
      case _Period.month:
        return DateTimeRange(start: todayStart.subtract(const Duration(days: 29)), end: tomorrowStart);
      case _Period.custom:
        if (_customRange == null) return DateTimeRange(start: todayStart, end: tomorrowStart);
        // Конец диапазона включаем целиком (до полуночи следующего дня),
        // иначе последний выбранный день не попадёт в отчёт.
        final end = DateTime(_customRange!.end.year, _customRange!.end.month, _customRange!.end.day)
            .add(const Duration(days: 1));
        return DateTimeRange(start: DateTime(_customRange!.start.year, _customRange!.start.month, _customRange!.start.day), end: end);
    }
  }

  void _load() {
    final range = _rangeFor(_period);
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
      initialDateRange: _customRange ??
          DateTimeRange(start: now.subtract(const Duration(days: 6)), end: now),
    );
    if (picked != null) {
      setState(() {
        _customRange = picked;
        _period = _Period.custom;
      });
      _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final range = _rangeFor(_period);
    return Scaffold(
      appBar: AppBar(title: const Text('Отчёты')),
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
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                _formatRange(range),
                style: const TextStyle(color: Colors.grey, fontSize: 12),
              ),
            ),
          ),
          const SizedBox(height: 4),
          Expanded(
            child: FutureBuilder<List<SessionModel>>(
              future: _future,
              builder: (context, snap) {
                if (snap.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snap.hasError) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text('Не удалось загрузить отчёт: ${snap.error}',
                          textAlign: TextAlign.center, style: const TextStyle(color: Colors.red)),
                    ),
                  );
                }
                final sessions = snap.data ?? [];
                if (sessions.isEmpty) {
                  return const Center(child: Text('За этот период закрытых счетов нет'));
                }
                final stats = _ReportStats.fromSessions(sessions);
                return RefreshIndicator(
                  onRefresh: () async => _load(),
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
                    children: [
                      _summaryGrid(stats),
                      const SizedBox(height: 8),
                      _sectionTitle('По сотрудникам'),
                      ...stats.byEmployee.entries.map((e) => Card(
                            child: ListTile(
                              leading: const Icon(Icons.person_outline),
                              title: Text(e.key),
                              subtitle: Text('${e.value.visits} визитов'),
                              trailing: Text(
                                '${e.value.revenue.toStringAsFixed(0)} ${AppConstants.currencySymbol}',
                                style: const TextStyle(fontWeight: FontWeight.bold),
                              ),
                            ),
                          )),
                      const SizedBox(height: 8),
                      _sectionTitle('Популярные позиции меню'),
                      ...stats.topItems.map((i) => Card(
                            child: ListTile(
                              leading: const Icon(Icons.local_cafe_outlined),
                              title: Text(i.name),
                              subtitle: Text('${i.qty} шт.'),
                              trailing: Text(
                                '${i.revenue.toStringAsFixed(0)} ${AppConstants.currencySymbol}',
                                style: const TextStyle(fontWeight: FontWeight.bold),
                              ),
                            ),
                          )),
                      if (stats.cardsUsed > 0) ...[
                        const SizedBox(height: 8),
                        _sectionTitle('Скидочные карты'),
                        Card(
                          child: ListTile(
                            leading: const Icon(Icons.card_giftcard),
                            title: Text('Применено ${stats.cardsUsed} раз'),
                            subtitle: Text(
                                'Скидок на сумму ${stats.totalDiscountGiven.toStringAsFixed(0)} ${AppConstants.currencySymbol}'),
                          ),
                        ),
                      ],
                      if (stats.refunds > 0) ...[
                        const SizedBox(height: 8),
                        _sectionTitle('Возвраты'),
                        Card(
                          child: ListTile(
                            leading: const Icon(Icons.undo, color: Colors.orange),
                            title: Text('${stats.refunds} возвратов'),
                            subtitle: Text(
                                'На сумму ${stats.refundedAmount.toStringAsFixed(0)} ${AppConstants.currencySymbol} (не входит в выручку)'),
                          ),
                        ),
                      ],
                      const SizedBox(height: 16),
                      Center(
                        child: OutlinedButton.icon(
                          onPressed: () => _copyReport(stats, range),
                          icon: const Icon(Icons.copy, size: 16),
                          label: const Text('Копировать отчёт текстом'),
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _sectionTitle(String text) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 12, 4, 6),
        child: Text(text, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
      );

  Widget _summaryGrid(_ReportStats stats) {
    final cards = [
      _statCard('Выручка', '${stats.revenue.toStringAsFixed(0)} ${AppConstants.currencySymbol}', Icons.payments_outlined),
      _statCard('Визитов', '${stats.visits}', Icons.event_seat_outlined),
      _statCard('Средний чек', '${stats.averageCheck.toStringAsFixed(0)} ${AppConstants.currencySymbol}', Icons.receipt_long_outlined),
      _statCard('Перезабивок', '${stats.refills}', Icons.refresh),
    ];
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 8,
      crossAxisSpacing: 8,
      childAspectRatio: 2.2,
      children: cards,
    );
  }

  Widget _statCard(String label, String value, IconData icon) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Icon(icon, color: Colors.purpleAccent),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(value, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
                  Text(label, style: const TextStyle(color: Colors.grey, fontSize: 12)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _formatRange(DateTimeRange range) {
    String two(int n) => n.toString().padLeft(2, '0');
    final lastDay = range.end.subtract(const Duration(days: 1));
    final s = range.start;
    return '${two(s.day)}.${two(s.month)}.${s.year} — ${two(lastDay.day)}.${two(lastDay.month)}.${lastDay.year}';
  }

  void _copyReport(_ReportStats stats, DateTimeRange range) {
    final buf = StringBuffer();
    buf.writeln('Отчёт: ${_formatRange(range)}');
    buf.writeln('Выручка: ${stats.revenue.toStringAsFixed(0)} ${AppConstants.currencySymbol}');
    buf.writeln('Визитов: ${stats.visits}');
    buf.writeln('Средний чек: ${stats.averageCheck.toStringAsFixed(0)} ${AppConstants.currencySymbol}');
    buf.writeln('Перезабивок: ${stats.refills}');
    if (stats.refunds > 0) {
      buf.writeln(
          'Возвратов: ${stats.refunds} на сумму ${stats.refundedAmount.toStringAsFixed(0)} ${AppConstants.currencySymbol}');
    }
    if (stats.byEmployee.isNotEmpty) {
      buf.writeln('\nПо сотрудникам:');
      for (final e in stats.byEmployee.entries) {
        buf.writeln('  ${e.key}: ${e.value.revenue.toStringAsFixed(0)} ${AppConstants.currencySymbol} (${e.value.visits} визитов)');
      }
    }
    if (stats.topItems.isNotEmpty) {
      buf.writeln('\nПопулярные позиции:');
      for (final i in stats.topItems) {
        buf.writeln('  ${i.name}: ${i.qty} шт. — ${i.revenue.toStringAsFixed(0)} ${AppConstants.currencySymbol}');
      }
    }
    Clipboard.setData(ClipboardData(text: buf.toString()));
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Отчёт скопирован в буфер обмена')));
  }
}

class _EmployeeStat {
  double revenue = 0;
  int visits = 0;
}

class _ItemStat {
  final String name;
  int qty = 0;
  double revenue = 0;
  _ItemStat(this.name);
}

class _ReportStats {
  final int visits;
  final double revenue;
  final int refills;
  final Map<String, _EmployeeStat> byEmployee;
  final List<_ItemStat> topItems;
  final int cardsUsed;
  final double totalDiscountGiven;
  final int refunds;
  final double refundedAmount;

  _ReportStats({
    required this.visits,
    required this.revenue,
    required this.refills,
    required this.byEmployee,
    required this.topItems,
    required this.cardsUsed,
    required this.totalDiscountGiven,
    required this.refunds,
    required this.refundedAmount,
  });

  double get averageCheck => visits == 0 ? 0 : revenue / visits;

  factory _ReportStats.fromSessions(List<SessionModel> sessions) {
    double revenue = 0;
    int refills = 0;
    int cardsUsed = 0;
    double discountGiven = 0;
    int refunds = 0;
    double refundedAmount = 0;
    final byEmployee = <String, _EmployeeStat>{};
    final byItem = <String, _ItemStat>{};

    for (final s in sessions) {
      // Возвращённые чеки в выручку и статистику по товарам/сотрудникам не
      // включаются — учитываются только отдельно, чтобы не искажать отчёт.
      if (s.refunded) {
        refunds++;
        refundedAmount += s.totalWithDiscount;
        continue;
      }

      revenue += s.totalWithDiscount;
      refills += s.refillCount;
      discountGiven += (s.orderTotal - s.totalWithDiscount);
      if (s.discountCardId != null && s.discountCardId!.isNotEmpty) cardsUsed++;

      final empName = s.employeeName.isEmpty ? 'Без имени' : s.employeeName;
      final empStat = byEmployee.putIfAbsent(empName, () => _EmployeeStat());
      empStat.revenue += s.totalWithDiscount;
      empStat.visits += 1;

      for (final item in s.orderItems) {
        final key = item.menuItemId.isNotEmpty ? item.menuItemId : item.name;
        final itemStat = byItem.putIfAbsent(key, () => _ItemStat(item.name));
        itemStat.qty += item.qty;
        itemStat.revenue += item.total;
      }
    }

    final employeesSorted = Map.fromEntries(
        byEmployee.entries.toList()..sort((a, b) => b.value.revenue.compareTo(a.value.revenue)));

    final itemsSorted = byItem.values.toList()..sort((a, b) => b.revenue.compareTo(a.revenue));

    return _ReportStats(
      visits: sessions.length - refunds,
      revenue: revenue,
      refills: refills,
      byEmployee: employeesSorted,
      topItems: itemsSorted.take(15).toList(),
      cardsUsed: cardsUsed,
      totalDiscountGiven: discountGiven,
      refunds: refunds,
      refundedAmount: refundedAmount,
    );
  }
}