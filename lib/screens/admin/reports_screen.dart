import 'dart:io';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import '../../models/inventory_models.dart';
import '../../models/menu_models.dart';
import '../../models/session_model.dart';
import '../employee/x_report_screen.dart' show terminalByBank;
import '../../services/firestore_service.dart';
import '../../services/printer_service.dart';
import '../../services/venue_service.dart';
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
                        if (stats.allItems.length >= 3) _abcCard(stats),
                        ...stats.topItems.map((i) => Card(
                              child: ListTile(
                                leading: _abcBadge(stats.abc[i] ?? 'C'),
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
                        if (stats.takeawayCount + stats.deliveryCount > 0) ...[
                          const SizedBox(height: 8),
                          _sectionTitle('С собой и доставка'),
                          Card(
                            child: Column(
                              children: [
                                if (stats.takeawayCount > 0)
                                  ListTile(
                                    leading: const Icon(Icons.shopping_bag_outlined),
                                    title: Text('С собой: ${stats.takeawayCount} '
                                        '${pluralRu(stats.takeawayCount, 'заказ', 'заказа', 'заказов')}'),
                                    trailing: Text(rub(stats.takeawayRevenue)),
                                  ),
                                if (stats.deliveryCount > 0)
                                  ListTile(
                                    leading: const Icon(Icons.delivery_dining_rounded),
                                    title: Text('Доставка: ${stats.deliveryCount} '
                                        '${pluralRu(stats.deliveryCount, 'заказ', 'заказа', 'заказов')}'),
                                    trailing: Text(rub(stats.deliveryRevenue)),
                                  ),
                              ],
                            ),
                          ),
                        ],
                        if (stats.byTerminalBank.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          _sectionTitle('Терминал по банкам'),
                          Card(
                            child: Column(
                              children: [
                                for (final e in stats.byTerminalBank.entries)
                                  ListTile(
                                    leading: const Icon(Icons.credit_card),
                                    title: Text(e.key),
                                    trailing: Text(rub(e.value), style: const TextStyle(fontWeight: FontWeight.bold)),
                                  ),
                                const Padding(
                                  padding: EdgeInsets.fromLTRB(16, 0, 16, 12),
                                  child: Text('Сверяйте с поступлениями от каждого банка.',
                                      style: TextStyle(color: AppColors.textMuted, fontSize: 12.5)),
                                ),
                              ],
                            ),
                          ),
                        ],
                        if (stats.byAggregator.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          _sectionTitle('Агрегаторы доставки'),
                          _aggregatorCard(stats),
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
                        const SizedBox(height: 8),
                        _sectionTitle('Выгрузка'),
                        _exportCard(stats, range, sessions),
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

  /// Кнопки выгрузки — одинаковой ширины, одна под другой: раньше две
  /// кнопки разной длины стояли «лесенкой» по центру.
  Widget _exportCard(_ReportStats stats, DateTimeRange range, List<SessionModel> sessions) {
    Widget button(IconData icon, String title, String hint, VoidCallback onTap) => ListTile(
          leading: Icon(icon, color: AppColors.brass),
          title: Text(title),
          subtitle: Text(hint, style: const TextStyle(fontSize: 12)),
          trailing: const Icon(Icons.chevron_right),
          onTap: onTap,
        );
    return Card(
      child: Column(
        children: [
          button(Icons.print_outlined, 'Напечатать отчёт', 'На чековом принтере заведения',
              () => _printReport(stats, range)),
          const Divider(height: 1),
          button(Icons.copy, 'Скопировать текстом', 'Для мессенджера или заметок',
              () => _copyReport(stats, range)),
          const Divider(height: 1),
          button(Icons.table_chart_outlined, 'Таблица продаж для Excel', 'Каждая позиция — строкой, для бухгалтера',
              () => _exportTable(sessions, range)),
        ],
      ),
    );
  }

  /// Продажи построчно для бухгалтера и 1С. Файлом .csv, который открывается
  /// в Excel или Google Таблицах. Скопированные в буфер строки «через точку
  /// с запятой» в заметках и мессенджерах выглядели нечитаемо.
  List<List<String>> _salesRows(List<SessionModel> sessions) {
    String num2(double v) => v.toStringAsFixed(2).replaceAll('.', ',');
    final rows = <List<String>>[
      ['Дата', 'Время', 'Стол', 'Сотрудник', 'Позиция', 'Количество', 'Цена', 'Сумма', 'Скидка %', 'Оплата'],
    ];
    for (final s in sessions) {
      if (s.refunded || s.closedWithoutPayment) continue;
      final at = s.closedAt ?? s.startTime;
      final pay = [
        if (s.paymentCash > 0) 'наличные',
        if (s.paymentCard > 0) 'карта',
        if (s.paymentTerminal > 0) s.terminalBank.isEmpty ? 'терминал' : 'терминал (${s.terminalBank})',
        if (s.paymentAggregator > 0) s.aggregatorName.isEmpty ? 'агрегатор' : s.aggregatorName,
        if (s.paymentComp > 0) 'за счёт заведения',
      ].join(' + ');
      for (final i in s.orderItems) {
        rows.add([
          _date(at),
          '${_two(at.hour)}:${_two(at.minute)}',
          s.tableName,
          s.employeeName,
          i.displayName,
          '${i.qty}',
          num2(i.price),
          num2(i.total),
          num2(s.discountPercent),
          pay,
        ]);
      }
    }
    return rows;
  }

  Future<void> _exportTable(List<SessionModel> sessions, DateTimeRange range) async {
    final rows = _salesRows(sessions);
    final messenger = ScaffoldMessenger.of(context);
    if (!kIsWeb) {
      try {
        String cell(String v) {
          final t = v.replaceAll('"', '""');
          return t.contains(';') || t.contains('"') || t.contains('\n') ? '"$t"' : t;
        }
        // BOM — чтобы Excel сразу открыл кириллицу, а не «крякозябры».
        final csv = '﻿${rows.map((r) => r.map(cell).join(';')).join('\r\n')}\r\n';
        final dir = await getTemporaryDirectory();
        final file = File('${dir.path}/Продажи ${_formatRange(range).replaceAll(' — ', '–')}.csv');
        await file.writeAsString(csv);
        final res = await OpenFilex.open(file.path, type: 'text/csv');
        if (res.type == ResultType.done) return;
      } catch (_) {
        // Нет приложения для таблиц или файл не открылся — скопируем ниже.
      }
    }
    // Табуляция: при вставке в Excel или Google Таблицы строки сами
    // разложатся по колонкам.
    await Clipboard.setData(ClipboardData(text: rows.map((r) => r.join('\t')).join('\n')));
    messenger.showSnackBar(const SnackBar(
        content: Text('Таблица скопирована — вставьте её в Excel или Google Таблицы, колонки разложатся сами')));
  }

  static String _two(int n) => n.toString().padLeft(2, '0');
  static String _date(DateTime d) => '${_two(d.day)}.${_two(d.month)}.${d.year}';

  String _periodLabel(DateTimeRange range) {
    final last = range.end.subtract(const Duration(days: 1));
    return _date(range.start) == _date(last) ? 'за ${_date(last)}' : 'за ${_formatRange(range)}';
  }

  /// Отчёт на чековом принтере (Bluetooth или Wi-Fi из «Интеграций»).
  Future<void> _printReport(_ReportStats stats, DateTimeRange range) async {
    final printer = activeReceiptPrinter;
    if (printer == null) {
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          scrollable: true,
          title: const Text('Принтер не подключён'),
          content: const Text('Чековый принтер подключается в разделе «Интеграции» (Bluetooth или Wi‑Fi). '
              'Пока отчёт можно скопировать текстом.'),
          actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Понятно'))],
        ),
      );
      return;
    }
    final now = DateTime.now();
    final lines = <ReportLine>[
      ReportLine('Выручка', right: rub(stats.revenue), bold: true),
      ReportLine('Визитов', right: '${stats.visits}'),
      ReportLine('Средний чек', right: rub(stats.averageCheck)),
      ReportLine('Перезабивок', right: '${stats.refills}'),
      if (stats.takeawayCount > 0) ReportLine('С собой: ${stats.takeawayCount}', right: rub(stats.takeawayRevenue)),
      if (stats.deliveryCount > 0) ReportLine('Доставка: ${stats.deliveryCount}', right: rub(stats.deliveryRevenue)),
      if (stats.cardsUsed > 0) ReportLine('Скидки по картам', right: rub(stats.totalDiscountGiven)),
      if (stats.unpaidClosed > 0) ReportLine('Без оплаты: ${stats.unpaidClosed}', right: rub(stats.unpaidAmount)),
      if (stats.refunds > 0) ReportLine('Возвраты: ${stats.refunds}', right: rub(stats.refundedAmount)),
      if (stats.byTerminalBank.isNotEmpty) ...[
        const ReportLine.separator(),
        const ReportLine('ТЕРМИНАЛ ПО БАНКАМ', bold: true),
        for (final e in stats.byTerminalBank.entries) ReportLine(e.key, right: rub(e.value)),
      ],
      if (stats.byAggregator.isNotEmpty) ...[
        const ReportLine.separator(),
        const ReportLine('АГРЕГАТОРЫ', bold: true),
        for (final e in stats.byAggregator.entries) ...[
          ReportLine('${e.key}: ${e.value.orders}', right: rub(e.value.sales)),
          ReportLine('  к выплате', right: rub(e.value.payout)),
        ],
      ],
      if (stats.byEmployee.isNotEmpty) ...[
        const ReportLine.separator(),
        const ReportLine('ПО СОТРУДНИКАМ', bold: true),
        for (final e in stats.byEmployee.entries) ReportLine(e.key, right: rub(e.value.revenue)),
      ],
      if (stats.topItems.isNotEmpty) ...[
        const ReportLine.separator(),
        const ReportLine('ПОЗИЦИИ', bold: true),
        for (final i in stats.topItems) ...[
          ReportLine(i.name),
          ReportLine('  ${i.qty} шт.', right: rub(i.revenue)),
        ],
      ],
    ];
    try {
      final venue = VenueService.instance.cached.name;
      await printer.printReport(ReportPrint(
        title: 'ОТЧЁТ',
        subtitle: [if (venue.isNotEmpty) venue, _periodLabel(range)],
        lines: lines,
        footer: 'Напечатано ${_date(now)} ${_two(now.hour)}:${_two(now.minute)}',
      ));
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Отчёт отправлен на принтер')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Не удалось напечатать: ${humanError(e, lower: true)}. Проверьте, что принтер включён.'),
        ));
      }
    }
  }

  /// Агрегаторы доставки: продажи, комиссия и сколько они должны перевести.
  /// Деньги приходят не в кассу и не эквайрингом, а переводом от агрегатора
  /// по его графику — сверяйте с его актом.
  Widget _aggregatorCard(_ReportStats stats) {
    return Card(
      child: Column(
        children: [
          for (final e in stats.byAggregator.entries)
            ListTile(
              leading: const Icon(Icons.delivery_dining_outlined),
              title: Text('${e.key}: ${e.value.orders} '
                  '${pluralRu(e.value.orders, 'заказ', 'заказа', 'заказов')}'),
              subtitle: Text(e.value.sales - e.value.payout > 0.004
                  ? 'Комиссия ${rub(e.value.sales - e.value.payout)} · к выплате ${rub(e.value.payout)}'
                  : 'К выплате ${rub(e.value.payout)} (комиссия не указана в «Интеграциях»)'),
              trailing: Text(rub(e.value.sales), style: const TextStyle(fontWeight: FontWeight.bold)),
            ),
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: Text(
              'Входит в выручку. Деньги переводит агрегатор по своему графику — сверяйте с его актом.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 12.5),
            ),
          ),
        ],
      ),
    );
  }

  /// ABC-анализ: A — позиции, дающие 80% выручки, B — следующие 15%, C — 5%.
  Widget _abcCard(_ReportStats stats) {
    int count(String c) => stats.abc.values.where((v) => v == c).length;
    return Card(
      child: ListTile(
        leading: const Icon(Icons.insights_outlined),
        title: Text('ABC: ${count('A')} позиций дают 80% выручки'),
        subtitle: Text('B — ${count('B')} поз. (15%), C — ${count('C')} поз. (5%). '
            'Позиции C — кандидаты убрать из меню или переделать'),
      ),
    );
  }

  Widget _abcBadge(String c) => CircleAvatar(
        radius: 15,
        backgroundColor: (c == 'A'
                ? AppColors.success
                : c == 'B'
                    ? AppColors.brass
                    : AppColors.textMuted)
            .withValues(alpha: 0.18),
        child: Text(c, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
      );

  /// Отчёт текстом для мессенджера: короткие строки, разделы с пустой
  /// строкой между ними — читается и в заметках, и в Telegram.
  void _copyReport(_ReportStats stats, DateTimeRange range) {
    String visits(int n) => '$n ${pluralRu(n, 'визит', 'визита', 'визитов')}';
    String orders(int n) => '$n ${pluralRu(n, 'заказ', 'заказа', 'заказов')}';
    final venue = VenueService.instance.cached.name;
    final buf = StringBuffer()
      ..writeln('Отчёт ${_periodLabel(range)}${venue.isEmpty ? '' : ' · $venue'}')
      ..writeln()
      ..writeln('Выручка: ${rub(stats.revenue)}')
      ..writeln('Визитов: ${stats.visits}, средний чек ${rub(stats.averageCheck)}')
      ..writeln('Перезабивок: ${stats.refills}');
    if (stats.takeawayCount > 0) buf.writeln('С собой: ${orders(stats.takeawayCount)}, ${rub(stats.takeawayRevenue)}');
    if (stats.deliveryCount > 0) buf.writeln('Доставка: ${orders(stats.deliveryCount)}, ${rub(stats.deliveryRevenue)}');
    if (stats.cardsUsed > 0) buf.writeln('Скидки по картам: ${rub(stats.totalDiscountGiven)}');
    if (stats.unpaidClosed > 0) {
      buf.writeln('Закрыто без оплаты: ${stats.unpaidClosed}, ${rub(stats.unpaidAmount)}');
    }
    if (stats.refunds > 0) buf.writeln('Возвраты: ${stats.refunds}, ${rub(stats.refundedAmount)}');
    if (stats.byTerminalBank.isNotEmpty) {
      buf
        ..writeln()
        ..writeln('Терминал по банкам:');
      for (final e in stats.byTerminalBank.entries) {
        buf.writeln('• ${e.key} — ${rub(e.value)}');
      }
    }
    if (stats.byAggregator.isNotEmpty) {
      buf
        ..writeln()
        ..writeln('Агрегаторы доставки:');
      for (final e in stats.byAggregator.entries) {
        final a = e.value;
        buf.writeln('• ${e.key} — ${orders(a.orders)}, ${rub(a.sales)}, '
            'комиссия ${rub(a.sales - a.payout)}, к выплате ${rub(a.payout)}');
      }
    }
    if (stats.byEmployee.isNotEmpty) {
      buf
        ..writeln()
        ..writeln('По сотрудникам:');
      for (final e in stats.byEmployee.entries) {
        buf.writeln('• ${e.key} — ${rub(e.value.revenue)}, ${visits(e.value.visits)}');
      }
    }
    if (stats.topItems.isNotEmpty) {
      buf
        ..writeln()
        ..writeln('Популярные позиции:');
      for (final i in stats.topItems) {
        buf.writeln('• ${i.name} — ${i.qty} шт., ${rub(i.revenue)}');
      }
    }
    Clipboard.setData(ClipboardData(text: buf.toString().trimRight()));
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Отчёт скопирован — вставьте его в мессенджер')));
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

/// Продажи через один агрегатор доставки.
class _AggregatorStat {
  int orders = 0;
  double sales = 0;
  double payout = 0;
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

  /// Класс ABC каждой позиции по доле в выручке.
  late final Map<_ItemStat, String> abc = () {
    final total = allItems.fold<double>(0, (a, i) => a + i.revenue);
    final out = <_ItemStat, String>{};
    var acc = 0.0;
    for (final i in allItems) {
      final before = total <= 0 ? 1.0 : acc / total;
      out[i] = before < 0.8 ? 'A' : (before < 0.95 ? 'B' : 'C');
      acc += i.revenue;
    }
    return out;
  }();
  final int cardsUsed;
  final double totalDiscountGiven;
  final int refunds;
  final double refundedAmount;

  /// Чеки, закрытые кнопкой «Закрыть без оплаты» — гость не заплатил
  /// ничего. В выручку не входят, показываются отдельной строкой.
  final int unpaidClosed;
  final double unpaidAmount;

  /// Заказы с собой и доставка — сколько и на какую сумму.
  final int takeawayCount;
  final double takeawayRevenue;
  final int deliveryCount;
  final double deliveryRevenue;

  /// Оплачено через агрегаторы доставки — по названию агрегатора.
  final Map<String, _AggregatorStat> byAggregator;

  /// Оплата терминалом по банкам — для сверки поступлений (terminalByBank).
  final Map<String, double> byTerminalBank;

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
    this.takeawayCount = 0,
    this.takeawayRevenue = 0,
    this.deliveryCount = 0,
    this.deliveryRevenue = 0,
    this.byAggregator = const {},
    this.byTerminalBank = const {},
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
    int takeawayCount = 0, deliveryCount = 0;
    double takeawayRevenue = 0, deliveryRevenue = 0;
    final byEmployee = <String, _EmployeeStat>{};
    final byItem = <String, _ItemStat>{};
    final byAggregator = <String, _AggregatorStat>{};

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
      if (s.orderType == 'delivery') {
        deliveryCount++;
        deliveryRevenue += s.totalWithDiscount;
      } else if (s.orderType == 'takeaway') {
        takeawayCount++;
        takeawayRevenue += s.totalWithDiscount;
      }
      if (s.paymentAggregator > 0) {
        final a = byAggregator.putIfAbsent(
            s.aggregatorName.isEmpty ? 'Агрегатор' : s.aggregatorName, () => _AggregatorStat());
        a.orders++;
        a.sales += s.paymentAggregator;
        a.payout += s.aggregatorPayout;
      }
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
      takeawayCount: takeawayCount,
      takeawayRevenue: takeawayRevenue,
      deliveryCount: deliveryCount,
      deliveryRevenue: deliveryRevenue,
      byAggregator: byAggregator,
      byTerminalBank: terminalByBank(sessions.where((s) => !s.refunded)),
    );
  }
}