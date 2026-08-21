import '../../theme/app_colors.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../models/employee.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../utils/constants.dart';

enum _Period { shift, custom }

/// X-отчёт — как в Restik POS: сводка продаж за текущую смену без её
/// закрытия. Список проданных позиций, итоговая сумма и разбивка оплаты по
/// способам (наличные / карта / за счёт заведения). Считается по уже
/// закрытым (оплаченным) чекам за период; возвращённые чеки в выручку не
/// попадают и показываются отдельной строкой.
class XReportScreen extends StatefulWidget {
  final Employee employee;
  const XReportScreen({super.key, required this.employee});

  @override
  State<XReportScreen> createState() => _XReportScreenState();
}

class _XReportScreenState extends State<XReportScreen> {
  final _fs = FirestoreService();
  _Period _period = _Period.shift;
  DateTimeRange? _customRange;
  String _employeeFilter = 'Все официанты';
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
    if (_period == _Period.custom && _customRange != null) {
      final end =
          DateTime(_customRange!.end.year, _customRange!.end.month, _customRange!.end.day)
              .add(const Duration(days: 1));
      return DateTimeRange(
        start: DateTime(
            _customRange!.start.year, _customRange!.start.month, _customRange!.start.day),
        end: end,
      );
    }
    return DateTimeRange(start: todayStart, end: tomorrowStart);
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
      initialDateRange: _customRange ?? DateTimeRange(start: now, end: now),
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
    final range = _rangeFor();
    return Scaffold(
      appBar: AppBar(title: const Text('X-отчёт')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                ChoiceChip(
                  label: const Text('Текущая смена'),
                  selected: _period == _Period.shift,
                  onSelected: (_) {
                    setState(() => _period = _Period.shift);
                    _load();
                  },
                ),
                ChoiceChip(
                  label: const Text('По дате и времени'),
                  selected: _period == _Period.custom,
                  onSelected: (_) => _pickCustomRange(),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                Expanded(
                  child: Text(_formatRange(range),
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
                ),
                StreamBuilder<List<Employee>>(
                  stream: _fs.employeesStream(),
                  builder: (context, snap) {
                    final names = <String>[
                      'Все официанты',
                      ...(snap.data ?? [])
                          .where((e) => e.role == AppConstants.roleEmployee)
                          .map((e) => e.name),
                    ];
                    if (!names.contains(_employeeFilter)) _employeeFilter = 'Все официанты';
                    return DropdownButton<String>(
                      value: _employeeFilter,
                      underline: const SizedBox.shrink(),
                      items: names
                          .map((n) => DropdownMenuItem(
                              value: n, child: Text(n, style: const TextStyle(fontSize: 13))))
                          .toList(),
                      onChanged: (v) => setState(() => _employeeFilter = v ?? 'Все официанты'),
                    );
                  },
                ),
              ],
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
                          textAlign: TextAlign.center, style: const TextStyle(color: AppColors.danger)),
                    ),
                  );
                }
                var sessions = snap.data ?? [];
                if (_employeeFilter != 'Все официанты') {
                  sessions = sessions.where((s) => s.employeeName == _employeeFilter).toList();
                }
                final paid = sessions.where((s) => !s.refunded).toList();
                final refunded = sessions.where((s) => s.refunded).toList();
                if (paid.isEmpty && refunded.isEmpty) {
                  return const Center(child: Text('За этот период закрытых чеков нет'));
                }
                final data = _XReportData.fromSessions(paid);
                return ListView(
                  padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
                  children: [
                    if (paid.isEmpty)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 12),
                        child: Text('Оплаченных чеков за период нет',
                            style: TextStyle(color: AppColors.textMuted)),
                      ),
                    if (data.items.isNotEmpty) ...[
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 4),
                        child: Row(
                          children: [
                            Expanded(
                                flex: 3,
                                child: Text('Позиция', style: TextStyle(color: AppColors.textMuted, fontSize: 12))),
                            Expanded(
                                flex: 1,
                                child: Text('Кол-во',
                                    textAlign: TextAlign.right,
                                    style: TextStyle(color: AppColors.textMuted, fontSize: 12))),
                            Expanded(
                                flex: 2,
                                child: Text('Цена',
                                    textAlign: TextAlign.right,
                                    style: TextStyle(color: AppColors.textMuted, fontSize: 12))),
                            Expanded(
                                flex: 2,
                                child: Text('Сумма',
                                    textAlign: TextAlign.right,
                                    style: TextStyle(color: AppColors.textMuted, fontSize: 12))),
                          ],
                        ),
                      ),
                      const Divider(height: 8),
                      ...data.items.map((i) => Padding(
                            padding: const EdgeInsets.symmetric(vertical: 4),
                            child: Row(
                              children: [
                                Expanded(flex: 3, child: Text(i.name)),
                                Expanded(
                                    flex: 1,
                                    child: Text('${i.qty} шт.', textAlign: TextAlign.right)),
                                Expanded(
                                    flex: 2,
                                    child: Text(
                                        '${i.price.toStringAsFixed(0)} ${AppConstants.currencySymbol}',
                                        textAlign: TextAlign.right)),
                                Expanded(
                                    flex: 2,
                                    child: Text(
                                        '${i.revenue.toStringAsFixed(0)} ${AppConstants.currencySymbol}',
                                        textAlign: TextAlign.right,
                                        style: const TextStyle(fontWeight: FontWeight.bold))),
                              ],
                            ),
                          )),
                    ],
                    const Divider(height: 24),
                    _totalRow('Итого', data.orderTotal),
                    _totalRow('К оплате', data.revenue, bold: true),
                    const SizedBox(height: 8),
                    _totalRow('Оплачено картой', data.paymentCard),
                    _totalRow('Оплачено наличными', data.paymentCash),
                    _totalRow('За счёт заведения', data.paymentComp),
                    if (refunded.isNotEmpty) ...[
                      const Divider(height: 24),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Text('Возвратов за период'),
                          Text('${refunded.length}',
                              style: const TextStyle(fontWeight: FontWeight.bold)),
                        ],
                      ),
                      _totalRow('Сумма возвратов',
                          refunded.fold(0.0, (s, e) => s + e.totalWithDiscount)),
                    ],
                    const SizedBox(height: 20),
                    Center(
                      child: OutlinedButton.icon(
                        onPressed:
                            paid.isEmpty ? null : () => _copyReport(data, range, refunded.length),
                        icon: const Icon(Icons.print_outlined, size: 16),
                        label: const Text('Распечатать отчёт'),
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _totalRow(String label, double value, {bool bold = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: TextStyle(fontWeight: bold ? FontWeight.bold : FontWeight.normal)),
          Text(
            '${value.toStringAsFixed(0)} ${AppConstants.currencySymbol}',
            style: TextStyle(
                fontWeight: bold ? FontWeight.bold : FontWeight.normal,
                fontSize: bold ? 18 : 14),
          ),
        ],
      ),
    );
  }

  String _formatRange(DateTimeRange range) {
    String two(int n) => n.toString().padLeft(2, '0');
    final lastDay = range.end.subtract(const Duration(days: 1));
    final s = range.start;
    return '${two(s.day)}.${two(s.month)}.${s.year} — ${two(lastDay.day)}.${two(lastDay.month)}.${lastDay.year}';
  }

  void _copyReport(_XReportData data, DateTimeRange range, int refundsCount) {
    final buf = StringBuffer();
    buf.writeln('X-отчёт: ${_formatRange(range)}');
    if (_employeeFilter != 'Все официанты') buf.writeln('Официант: $_employeeFilter');
    buf.writeln('');
    for (final i in data.items) {
      buf.writeln(
          '${i.name}  —  ${i.qty} шт. × ${i.price.toStringAsFixed(0)} = ${i.revenue.toStringAsFixed(0)} ${AppConstants.currencySymbol}');
    }
    buf.writeln('');
    buf.writeln('Итого: ${data.orderTotal.toStringAsFixed(0)} ${AppConstants.currencySymbol}');
    buf.writeln('К оплате: ${data.revenue.toStringAsFixed(0)} ${AppConstants.currencySymbol}');
    buf.writeln(
        'Оплачено картой: ${data.paymentCard.toStringAsFixed(0)} ${AppConstants.currencySymbol}');
    buf.writeln(
        'Оплачено наличными: ${data.paymentCash.toStringAsFixed(0)} ${AppConstants.currencySymbol}');
    buf.writeln(
        'За счёт заведения: ${data.paymentComp.toStringAsFixed(0)} ${AppConstants.currencySymbol}');
    if (refundsCount > 0) buf.writeln('Возвратов: $refundsCount');
    Clipboard.setData(ClipboardData(text: buf.toString()));
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Отчёт скопирован в буфер обмена')));
  }
}

class _XItemStat {
  final String name;
  final double price;
  int qty = 0;
  double revenue = 0;
  _XItemStat(this.name, this.price);
}

class _XReportData {
  final List<_XItemStat> items;
  final double orderTotal;
  final double revenue;
  final double paymentCash;
  final double paymentCard;
  final double paymentComp;

  _XReportData({
    required this.items,
    required this.orderTotal,
    required this.revenue,
    required this.paymentCash,
    required this.paymentCard,
    required this.paymentComp,
  });

  factory _XReportData.fromSessions(List<SessionModel> sessions) {
    final byItem = <String, _XItemStat>{};
    double orderTotal = 0;
    double revenue = 0;
    double cash = 0;
    double card = 0;
    double comp = 0;
    for (final s in sessions) {
      orderTotal += s.orderTotal;
      revenue += s.totalWithDiscount;
      cash += s.paymentCash;
      card += s.paymentCard;
      comp += s.paymentComp;
      for (final item in s.orderItems) {
        final key = '${item.menuItemId.isNotEmpty ? item.menuItemId : item.name}_${item.price}';
        final stat = byItem.putIfAbsent(key, () => _XItemStat(item.name, item.price));
        stat.qty += item.qty;
        stat.revenue += item.total;
      }
    }
    return _XReportData(
      items: byItem.values.toList(),
      orderTotal: orderTotal,
      revenue: revenue,
      paymentCash: cash,
      paymentCard: card,
      paymentComp: comp,
    );
  }
}