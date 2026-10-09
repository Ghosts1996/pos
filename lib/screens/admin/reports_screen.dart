import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../models/inventory_models.dart';
import '../../models/menu_models.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../utils/adaptive.dart';
import '../../utils/table_label.dart';
import '../../utils/human_error.dart';
import '../../utils/money.dart';
import '../../theme/app_colors.dart';

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
  Map<String, MenuItem> _menu = const {};
  Map<String, InventoryItem> _stock = const {};
  final _fs = FirestoreService();
  _Period _period = _Period.today;
  DateTimeRange? _customRange;
  Future<List<SessionModel>>? _future;

  @override
  void initState() {
    super.initState();
    _load();
    // Себестоимость в отчёте — по текущим техкартам и ценам закупки.
    Future.wait([_fs.menuItemsStream().first, _fs.inventoryItemsStream().first]).then((r) {
      if (!mounted) return;
      setState(() {
        _menu = {for (final m in r[0] as List<MenuItem>) m.id: m};
        _stock = {for (final i in r[1] as List<InventoryItem>) i.id: i};
      });
    }).catchError((_) {});
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
      // Глобальная тема задаёт TextButton'ам минимальную высоту 56 (под тач-таргеты
      // кассы), из-за чего кнопка "Save" в аппбаре пикера дат перестаёт помещаться
      // и визуально пропадает. Здесь возвращаем стандартный размер только для диалога.
      builder: (context, child) {
        return Theme(
          data: Theme.of(context).copyWith(
            textButtonTheme: const TextButtonThemeData(
              style: ButtonStyle(),
            ),
          ),
          child: child!,
        );
      },
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
      body: CenteredBody(
        maxWidth: 900,
        child: Column(
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
                        child: Text('Не удалось загрузить отчёт: ${humanError(snap.error, lower: true)}',
                            textAlign: TextAlign.center, style: const TextStyle(color: AppColors.danger)),
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
                                subtitle: Text('${e.value.visits} ${pluralRu(e.value.visits, 'визит', 'визита', 'визитов')}'),
                                trailing: Text(
                                  rub(e.value.revenue),
                                  style: const TextStyle(fontWeight: FontWeight.bold),
                                ),
                              ),
                            )),
                        const SizedBox(height: 8),
                        _sectionTitle('Популярные позиции меню'),
                        if (_grossProfit(stats) case final gp?)
                          Card(
                            child: ListTile(
                              leading: const Icon(Icons.trending_up),
                              title: const Text('Валовая прибыль по позициям с себестоимостью'),
                              subtitle: Text('выручка ${rub(gp.$1)} − себестоимость ${rub(gp.$2)}'),
                              trailing: Text(rub(gp.$1 - gp.$2),
                                  style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.success)),
                            ),
                          ),
                        ...stats.topItems.map((i) => Card(
                              child: ListTile(
                                leading: const Icon(Icons.local_cafe_outlined),
                                title: Text(i.name),
                                subtitle: Text('${i.qty} шт.${_itemCostLine(i)}'),
                                trailing: Text(
                                  rub(i.revenue),
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
                                  'Скидок на сумму ${rub(stats.totalDiscountGiven)}'),
                            ),
                          ),
                        ],
                        if (stats.unpaidClosed > 0) ...[
                          const SizedBox(height: 8),
                          _sectionTitle('Закрыто без оплаты'),
                          Card(
                            child: ListTile(
                              leading: const Icon(Icons.money_off, color: AppColors.warning),
                              title: Text('${stats.unpaidClosed} ${pluralRu(stats.unpaidClosed, 'чек', 'чека', 'чеков')}'),
                              subtitle: Text(
                                  'На сумму ${rub(stats.unpaidAmount)} (не входит в выручку)'),
                            ),
                          ),
                        ],
                        if (stats.refunds > 0) ...[
                          const SizedBox(height: 8),
                          _sectionTitle('Возвраты'),
                          Card(
                            child: ListTile(
                              leading: const Icon(Icons.undo, color: AppColors.warning),
                              title: Text('${stats.refunds} возвратов'),
                              subtitle: Text(
                                  'На сумму ${rub(stats.refundedAmount)} (не входит в выручку)'),
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
      ),
    );
  }

  Widget _sectionTitle(String text) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 12, 4, 6),
        child: Text(text, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
      );

  Widget _summaryGrid(_ReportStats stats) {
    final cards = [
      _statCard('Выручка', rub(stats.revenue), Icons.payments_outlined),
      _statCard('Визитов', '${stats.visits}', Icons.event_seat_outlined),
      _statCard('Средний чек', rub(stats.averageCheck), Icons.receipt_long_outlined),
      _statCard('Перезабивок', '${stats.refills}', Icons.refresh),
    ];
    // По ширине карточки, а не по числу колонок: на телефоне две, на
    // планшете — все четыре в ряд; высота растёт с системным шрифтом.
    return GridView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      gridDelegate: SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 280,
        mainAxisExtent: context.scaledExtent(72, textPart: 38),
        mainAxisSpacing: 8,
        crossAxisSpacing: 8,
      ),
      children: cards,
    );
  }

  Widget _statCard(String label, String value, IconData icon) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Icon(icon, color: AppColors.brass),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(value, maxLines: 1, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
                  ),
                  Text(label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: Colors.grey, fontSize: 12)),
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
    buf.writeln('Выручка: ${rub(stats.revenue)}');
    buf.writeln('Визитов: ${stats.visits}');
    buf.writeln('Средний чек: ${rub(stats.averageCheck)}');
    buf.writeln('Перезабивок: ${stats.refills}');
    if (stats.refunds > 0) {
      buf.writeln(
          'Возвратов: ${stats.refunds} на сумму ${rub(stats.refundedAmount)}');
    }
    if (stats.unpaidClosed > 0) {
      buf.writeln('Закрыто без оплаты: ${stats.unpaidClosed} на сумму '
          '${rub(stats.unpaidAmount)}');
    }
    if (stats.byEmployee.isNotEmpty) {
      buf.writeln('\nПо сотрудникам:');
      for (final e in stats.byEmployee.entries) {
        buf.writeln('  ${e.key}: ${rub(e.value.revenue)} (${e.value.visits} ${pluralRu(e.value.visits, 'визит', 'визита', 'визитов')})');
      }
    }
    if (stats.topItems.isNotEmpty) {
      buf.writeln('\nПопулярные позиции:');
      for (final i in stats.topItems) {
        buf.writeln('  ${i.name}: ${i.qty} шт. — ${rub(i.revenue)}');
      }
    }
    Clipboard.setData(ClipboardData(text: buf.toString()));
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Отчёт скопирован в буфер обмена')));
  }
}

extension on _ReportsScreenState {
  double? _unitCost(_ItemStat i) => _menu[i.menuItemId]?.costPrice(_stock);

  /// « · себест. 1 340 ₽ · маржа 68%» — если у позиции есть техкарта с ценами.
  String _itemCostLine(_ItemStat i) {
    final unit = _unitCost(i);
    if (unit == null || i.revenue <= 0) return '';
    final cost = unit * i.qty;
    return ' · себест. ${rub(cost)} · маржа ${((i.revenue - cost) / i.revenue * 100).toStringAsFixed(0)}%';
  }

  /// (выручка, себестоимость) по позициям, где себестоимость известна.
  (double, double)? _grossProfit(_ReportStats stats) {
    var revenue = 0.0, cost = 0.0;
    for (final i in stats.allItems) {
      final unit = _unitCost(i);
      if (unit == null) continue;
      revenue += i.revenue;
      cost += unit * i.qty;
    }
    return revenue > 0 ? (revenue, cost) : null;
  }
}

class _EmployeeStat {
  double revenue = 0;
  int visits = 0;
}

class _ItemStat {
  final String name;
  final String menuItemId;
  int qty = 0;
  double revenue = 0;
  _ItemStat(this.name, [this.menuItemId = '']);
}

class _ReportStats {
  final int visits;
  final double revenue;
  final int refills;
  final Map<String, _EmployeeStat> byEmployee;
  final List<_ItemStat> topItems;
  final List<_ItemStat> allItems;
  final int cardsUsed;
  final double totalDiscountGiven;
  final int refunds;
  final double refundedAmount;

  /// Чеки, закрытые кнопкой «Закрыть без оплаты» — гость не заплатил
  /// ничего. В выручку не входят, показываются отдельной строкой.
  final int unpaidClosed;
  final double unpaidAmount;

  _ReportStats({
    required this.visits,
    required this.revenue,
    required this.refills,
    required this.byEmployee,
    required this.topItems,
    this.allItems = const [],
    required this.cardsUsed,
    required this.totalDiscountGiven,
    required this.refunds,
    required this.refundedAmount,
    required this.unpaidClosed,
    required this.unpaidAmount,
  });

  double get averageCheck => visits == 0 ? 0 : revenue / visits;

  factory _ReportStats.fromSessions(List<SessionModel> sessions) {
    double revenue = 0;
    int refills = 0;
    int cardsUsed = 0;
    double discountGiven = 0;
    int refunds = 0;
    double refundedAmount = 0;
    int unpaidClosed = 0;
    double unpaidAmount = 0;
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

      // Чек «закрыт без оплаты» — денег нет, все поля оплаты нулевые. В
      // выручку не идёт, считаем отдельно, иначе итог не сойдётся со
      // способами оплаты.
      if (s.closedWithoutPayment) {
        unpaidClosed++;
        unpaidAmount += s.totalWithDiscount;
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
        final itemStat = byItem.putIfAbsent(key, () => _ItemStat(item.name, item.menuItemId));
        itemStat.qty += item.qty;
        itemStat.revenue += item.total;
      }
    }

    final employeesSorted = Map.fromEntries(
        byEmployee.entries.toList()..sort((a, b) => b.value.revenue.compareTo(a.value.revenue)));

    final itemsSorted = byItem.values.toList()..sort((a, b) => b.revenue.compareTo(a.revenue));

    return _ReportStats(
      visits: sessions.length - refunds - unpaidClosed,
      revenue: revenue,
      refills: refills,
      byEmployee: employeesSorted,
      topItems: itemsSorted.take(15).toList(),
      allItems: itemsSorted,
      cardsUsed: cardsUsed,
      totalDiscountGiven: discountGiven,
      refunds: refunds,
      refundedAmount: refundedAmount,
      unpaidClosed: unpaidClosed,
      unpaidAmount: unpaidAmount,
    );
  }
}