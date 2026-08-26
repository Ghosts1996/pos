import '../../theme/app_colors.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../models/employee.dart';
import '../../models/session_model.dart';
import '../../models/shift_model.dart';
import '../../services/firestore_service.dart';
import '../../utils/constants.dart';

enum _Period { shift, pastShift, custom }

/// X-отчёт — как в Restik POS: сводка продаж за смену без её закрытия.
/// Список проданных позиций, итоговая сумма и разбивка оплаты по способам
/// (наличные / карта / за счёт заведения). Считается по уже закрытым
/// (оплаченным) чекам за период; возвращённые чеки в выручку не попадают и
/// показываются отдельной строкой.
///
/// Период отчёта по умолчанию — "Текущая смена": не календарные сутки, а
/// реальный промежуток времени между открытием и закрытием кассы. Именно
/// поэтому смена может спокойно идти через полночь — раньше отчёт строился
/// по календарному дню и ровно в 00:00 "обрывался", хотя смена ещё
/// продолжалась.
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
  ShiftModel? _selectedPastShift;
  String _employeeFilter = 'Все официанты';

  Future<ShiftModel?>? _currentShiftFuture;
  Future<List<ShiftModel>>? _recentShiftsFuture;
  Future<List<SessionModel>>? _future;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _reloadShiftInfo();
  }

  /// Перечитывает текущую открытую смену и список последних смен, затем
  /// пересчитывает отчёт под актуальный выбранный период.
  void _reloadShiftInfo() {
    setState(() {
      _currentShiftFuture = _fs.currentOpenShift();
      _recentShiftsFuture = _fs.recentShifts();
    });
    _load();
  }

  void _load() {
    setState(() {
      _future = _resolveSessions();
    });
  }

  Future<List<SessionModel>> _resolveSessions() async {
    switch (_period) {
      case _Period.shift:
        final shift = await _fs.currentOpenShift();
        if (shift == null) return [];
        return _fs.closedSessionsForShift(shift);
      case _Period.pastShift:
        if (_selectedPastShift == null) return [];
        return _fs.closedSessionsForShift(_selectedPastShift!);
      case _Period.custom:
        if (_customRange == null) return [];
        final start = DateTime(
            _customRange!.start.year, _customRange!.start.month, _customRange!.start.day);
        final end = DateTime(_customRange!.end.year, _customRange!.end.month, _customRange!.end.day)
            .add(const Duration(days: 1));
        return _fs.closedSessionsInRange(start, end);
    }
  }

  Future<void> _pickCustomRange() async {
    final now = DateTime.now();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year - 2),
      lastDate: now,
      initialDateRange: _customRange ?? DateTimeRange(start: now, end: now),
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

  Future<void> _pickPastShift() async {
    final shifts = await (_recentShiftsFuture ?? _fs.recentShifts());
    final closedShifts = shifts.where((s) => !s.isOpen).toList();
    if (!mounted) return;
    if (closedShifts.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Закрытых смен пока нет')));
      return;
    }
    final chosen = await showModalBottomSheet<ShiftModel>(
      context: context,
      builder: (context) {
        return SafeArea(
          child: ListView(
            shrinkWrap: true,
            children: closedShifts.map((s) {
              return ListTile(
                leading: const Icon(Icons.event_note_outlined),
                title: Text(_formatShiftRange(s)),
                subtitle: Text('Открыл(а): ${s.openedBy}  ·  Закрыл(а): ${s.closedBy ?? '—'}'),
                onTap: () => Navigator.pop(context, s),
              );
            }).toList(),
          ),
        );
      },
    );
    if (chosen != null) {
      setState(() {
        _selectedPastShift = chosen;
        _period = _Period.pastShift;
      });
      _load();
    }
  }

  Future<void> _openShift() async {
    setState(() => _busy = true);
    try {
      await _fs.openShiftIfNeeded(widget.employee.name);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось открыть смену: $e')));
      }
    }
    if (!mounted) return;
    setState(() => _busy = false);
    _reloadShiftInfo();
  }

  Future<void> _closeShift(ShiftModel shift) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Закрыть смену?'),
        content: const Text(
            'После закрытия смены новые продажи будут учитываться уже в следующей смене. '
            'Отчёт по этой смене останется доступен в разделе "Прошлые смены".'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Отмена')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true), child: const Text('Закрыть смену')),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() => _busy = true);
    try {
      await _fs.closeShift(shift.id, widget.employee.name);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Смена закрыта')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось закрыть смену: $e')));
      }
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _period = _Period.shift;
    });
    _reloadShiftInfo();
  }

  @override
  Widget build(BuildContext context) {
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
                  label: const Text('Прошлые смены'),
                  selected: _period == _Period.pastShift,
                  onSelected: (_) => _pickPastShift(),
                ),
                ChoiceChip(
                  label: const Text('По дате и времени'),
                  selected: _period == _Period.custom,
                  onSelected: (_) => _pickCustomRange(),
                ),
              ],
            ),
          ),
          _buildShiftHeader(),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                Expanded(
                  child: Text(_formatSelectedRange(),
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
                  return ListView(
                    padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
                    children: [
                      const SizedBox(height: 40),
                      Center(child: Text(_emptyMessage())),
                      const SizedBox(height: 20),
                      _buildShiftActions(centered: true),
                    ],
                  );
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
                    _totalRow('Оплачено с терминала', data.paymentTerminal),
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
                        onPressed: paid.isEmpty
                            ? null
                            : () => _copyReport(data, refunded.length),
                        icon: const Icon(Icons.print_outlined, size: 16),
                        label: const Text('Распечатать отчёт'),
                      ),
                    ),
                    const SizedBox(height: 12),
                    _buildShiftActions(centered: true),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  /// Блок над списком: показывает состояние текущей смены (открыта/нет,
  /// кем и когда открыта) — только когда выбран период "Текущая смена".
  Widget _buildShiftHeader() {
    if (_period != _Period.shift) return const SizedBox.shrink();
    return FutureBuilder<ShiftModel?>(
      future: _currentShiftFuture,
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return const SizedBox.shrink();
        }
        final shift = snap.data;
        return Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
          child: Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: (shift == null ? AppColors.danger : AppColors.textMuted).withOpacity(0.08),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: [
                Icon(shift == null ? Icons.lock_outline : Icons.lock_open_outlined,
                    size: 18,
                    color: shift == null ? AppColors.danger : AppColors.textMuted),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    shift == null
                        ? 'Смена сейчас не открыта'
                        : 'Смена открыта ${_formatDateTime(shift.openedAt)} · ${shift.openedBy}',
                    style: const TextStyle(fontSize: 12),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  /// Кнопки "Открыть смену" / "Закрыть смену" — показываются только для
  /// периода "Текущая смена", чтобы не закрыть смену случайно, находясь в
  /// отчёте за прошлую смену или произвольный период.
  Widget _buildShiftActions({bool centered = false}) {
    if (_period != _Period.shift) return const SizedBox.shrink();
    return FutureBuilder<ShiftModel?>(
      future: _currentShiftFuture,
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return const SizedBox.shrink();
        }
        final shift = snap.data;
        final child = shift == null
            ? FilledButton.icon(
                onPressed: _busy ? null : _openShift,
                icon: const Icon(Icons.lock_open_outlined, size: 18),
                label: const Text('Открыть смену'),
              )
            : OutlinedButton.icon(
                onPressed: _busy ? null : () => _closeShift(shift),
                style: OutlinedButton.styleFrom(foregroundColor: AppColors.danger),
                icon: const Icon(Icons.lock_outline, size: 18),
                label: const Text('Закрыть смену'),
              );
        return centered ? Center(child: child) : child;
      },
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

  String _emptyMessage() {
    switch (_period) {
      case _Period.shift:
        return 'За текущую смену закрытых чеков нет';
      case _Period.pastShift:
        return 'За выбранную смену закрытых чеков нет';
      case _Period.custom:
        return 'За этот период закрытых чеков нет';
    }
  }

  String _formatDateTime(DateTime dt) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(dt.day)}.${two(dt.month)}.${dt.year} ${two(dt.hour)}:${two(dt.minute)}';
  }

  String _formatShiftRange(ShiftModel shift) {
    final start = _formatDateTime(shift.openedAt);
    final end = shift.closedAt != null ? _formatDateTime(shift.closedAt!) : 'сейчас';
    return '$start — $end';
  }

  String _formatSelectedRange() {
    switch (_period) {
      case _Period.shift:
        return 'Смена ещё не открыта';
      case _Period.pastShift:
        return _selectedPastShift == null
            ? 'Смена не выбрана'
            : _formatShiftRange(_selectedPastShift!);
      case _Period.custom:
        if (_customRange == null) return '';
        String two(int n) => n.toString().padLeft(2, '0');
        final s = _customRange!.start;
        final e = _customRange!.end;
        return '${two(s.day)}.${two(s.month)}.${s.year} — ${two(e.day)}.${two(e.month)}.${e.year}';
    }
  }

  void _copyReport(_XReportData data, int refundsCount) {
    final buf = StringBuffer();
    buf.writeln('X-отчёт: ${_formatSelectedRange()}');
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
        'Оплачено с терминала: ${data.paymentTerminal.toStringAsFixed(0)} ${AppConstants.currencySymbol}');
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
  final double paymentTerminal;
  final double paymentComp;

  _XReportData({
    required this.items,
    required this.orderTotal,
    required this.revenue,
    required this.paymentCash,
    required this.paymentCard,
    required this.paymentTerminal,
    required this.paymentComp,
  });

  factory _XReportData.fromSessions(List<SessionModel> sessions) {
    final byItem = <String, _XItemStat>{};
    double orderTotal = 0;
    double revenue = 0;
    double cash = 0;
    double card = 0;
    double terminal = 0;
    double comp = 0;
    for (final s in sessions) {
      orderTotal += s.orderTotal;
      revenue += s.totalWithDiscount;
      cash += s.paymentCash;
      card += s.paymentCard;
      terminal += s.paymentTerminal;
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
      paymentTerminal: terminal,
      paymentComp: comp,
    );
  }
}