import '../../theme/app_colors.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../models/employee.dart';
import '../../models/session_model.dart';
import '../../models/shift_model.dart';
import '../../services/audit_log_service.dart';
import '../../services/firestore_service.dart';
import '../../utils/constants.dart';
import '../../widgets/shift_open_dialog.dart';
import '../../utils/human_error.dart';
import '../../utils/money.dart';
import '../../models/cash_op.dart';
import '../../services/printer_service.dart';
import '../../services/venue_service.dart';
import 'cash_screen.dart';
import '../../widgets/shift_flow.dart';
import '../../utils/adaptive.dart';

enum _Period { shift, pastShift, custom }

/// X-отчёт: сводка продаж за смену без её закрытия — позиции, итог и
/// разбивка по способам оплаты по закрытым чекам. Возвраты в выручку не
/// входят и показаны отдельно.
///
/// По умолчанию период — текущая смена, а не календарные сутки: смена
/// может идти через полночь.
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

  /// Операции с наличными для прошлой смены или периода (для текущей
  /// смены — живой поток, см. _cashScope).
  Future<List<CashOp>>? _opsFuture;
  bool _busy = false;
  // Одна подписка на экран: смена периода/фильтра делает setState.
  late final Stream<List<Employee>> _employees = _fs.employeesStream();

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
      _opsFuture = _resolveOps();
    });
  }

  Future<List<CashOp>> _resolveOps() async {
    switch (_period) {
      case _Period.shift:
        return const [];
      case _Period.pastShift:
        if (_selectedPastShift == null) return const [];
        return _fs.cashOpsForShift(_selectedPastShift!.id);
      case _Period.custom:
        if (_customRange == null) return const [];
        final r = _customRange!;
        return _fs.cashOpsInRange(DateTime(r.start.year, r.start.month, r.start.day),
            DateTime(r.end.year, r.end.month, r.end.day).add(const Duration(days: 1)));
    }
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
      if (mounted) await ensureShiftOpen(context, me: widget.employee);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось открыть смену: ${humanError(e, lower: true)}')));
      }
    }
    if (!mounted) return;
    setState(() => _busy = false);
    _reloadShiftInfo();
  }

  /// Закрытие смены заведения: предупреждение, если в зале ещё кто-то
  /// работает, и пересчёт кассы (см. closeVenueShift).
  Future<void> _closeShift(ShiftModel shift) async {
    setState(() => _busy = true);
    await closeVenueShift(context, shift: shift, me: widget.employee);
    if (!mounted) return;
    // Смену закрыли — показываем её итоговый отчёт (его можно напечатать).
    ShiftModel? closed;
    try {
      closed = (await _fs.recentShifts()).where((s) => s.id == shift.id && !s.isOpen).firstOrNull;
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (closed != null) {
        _selectedPastShift = closed;
        _period = _Period.pastShift;
      } else {
        _period = _Period.shift;
      }
    });
    _reloadShiftInfo();
    if (closed != null) {
      _load();
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Смена закрыта — отчёт о закрытии можно распечатать')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('X-отчёт')),
      body: CenteredBody(
        maxWidth: 760,
        child: Column(
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
                    stream: _employees,
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
                        child: Text('Не удалось загрузить отчёт: ${humanError(snap.error, lower: true)}',
                            textAlign: TextAlign.center, style: const TextStyle(color: AppColors.danger)),
                      ),
                    );
                  }
                  final all = snap.data ?? [];
                  var sessions = all;
                  if (_employeeFilter != 'Все официанты') {
                    sessions = sessions.where((s) => s.employeeName == _employeeFilter).toList();
                  }
                  final paid = sessions.where((s) => !s.refunded).toList();
                  final refunded = sessions.where((s) => s.refunded).toList();
                  final data = _XReportData.fromSessions(paid);
                  return _cashScope(
                    sessions: all,
                    builder: (cash) {
                      if (paid.isEmpty && refunded.isEmpty && (cash == null || cash.ops.isEmpty) && _period != _Period.shift) {
                        return ListView(
                          padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
                          children: [
                            const SizedBox(height: 40),
                            Center(child: Text(_emptyMessage())),
                          ],
                        );
                      }
                      return ListView(
                        padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
                        children: [
                          if (paid.isEmpty)
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 12),
                              child: Text(_emptyMessage(), style: const TextStyle(color: AppColors.textMuted)),
                            ),
                          if (data.items.isNotEmpty) ..._itemsTable(data),
                          const Divider(height: 24),
                          _totalRow('Итого', data.orderTotal),
                          _totalRow('К оплате', data.revenue, bold: true),
                          const SizedBox(height: 8),
                          _totalRow('Оплачено картой', data.paymentCard),
                          _totalRow('Оплачено наличными', data.paymentCash),
                          _totalRow('Оплачено терминалом', data.paymentTerminal),
                          // Агрегаторы доставки: деньги придут от них позже,
                          // не в кассу и не эквайрингом.
                          if (data.byAggregator.length > 1)
                            _totalRow('Через агрегаторы', data.paymentAggregator),
                          for (final e in data.byAggregator.entries) _totalRow('Агрегатор · ${e.key}', e.value),
                          _totalRow('За счёт заведения', data.paymentComp),
                          if (cash != null) ...[
                            _totalRow('Инкассация', cash.summary.collections),
                            if (!cash.rangeOnly) _totalRow('Наличные в кассе', cash.summary.expected, bold: true),
                          ],
                          if (data.tipsCash + data.tipsCard > 0) ...[
                            const Divider(height: 24),
                            // Не выручка: деньги сотрудников. Наличные чаевые
                            // лежат в той же кассе и входят в «Наличные в кассе».
                            _totalRow('Чаевые наличными (в кассе)', data.tipsCash),
                            _totalRow('Чаевые картой', data.tipsCard),
                          ],
                          if (data.unpaidCount > 0) ...[
                            const Divider(height: 24),
                            _countRow('Закрыто без оплаты', data.unpaidCount),
                            _totalRow('На сумму (вне выручки)', data.unpaidAmount),
                          ],
                          if (refunded.isNotEmpty) ...[
                            const Divider(height: 24),
                            _countRow('Возвратов за период', refunded.length),
                            _totalRow('Сумма возвратов', refunded.fold(0.0, (s, e) => s + e.totalWithDiscount)),
                          ],
                          // Сама касса — инкассация, внесение, выплата,
                          // операции и пересчёты — на отдельном экране «Касса».
                          if (cash != null && !cash.rangeOnly && cash.live)
                            Align(
                              alignment: Alignment.centerLeft,
                              child: TextButton.icon(
                                onPressed: () => Navigator.of(context).push(
                                    MaterialPageRoute(builder: (_) => CashScreen(employee: widget.employee))),
                                icon: const Icon(Icons.point_of_sale_outlined, size: 18),
                                label: const Text('Касса: инкассация, внесение, выплата'),
                              ),
                            ),
                          const SizedBox(height: 20),
                          Row(children: [
                            Expanded(
                              child: SizedBox(
                                height: 52,
                                child: OutlinedButton.icon(
                                  onPressed: () => _printReport(data, refunded.length, cash),
                                  icon: const Icon(Icons.print_outlined, size: 20),
                                  label: const Text('Распечатать'),
                                ),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: SizedBox(
                                height: 52,
                                child: FilledButton.tonalIcon(
                                  onPressed: () => _copyTotals(data, cash),
                                  icon: const Icon(Icons.copy_rounded, size: 20),
                                  label: const Text('Скопировать'),
                                ),
                              ),
                            ),
                          ]),
                          const SizedBox(height: 12),
                          _buildShiftActions(centered: true),
                        ],
                      );
                    },
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Наличные: для текущей смены — живые смена и операции (провели
  /// инкассацию — сумма в кассе меняется сразу), для прошлой смены и
  /// периода — загруженные один раз.
  Widget _cashScope({required List<SessionModel> sessions, required Widget Function(_Cash? cash) builder}) {
    switch (_period) {
      case _Period.shift:
        return StreamBuilder<ShiftModel?>(
          stream: _fs.openShiftStream(),
          builder: (context, shiftSnap) {
            final shift = shiftSnap.data;
            if (shift == null) return builder(null);
            return StreamBuilder<List<CashOp>>(
              stream: _fs.cashOpsStream(shift.id),
              builder: (context, opsSnap) {
                final ops = opsSnap.data ?? const <CashOp>[];
                return builder(_Cash(
                  summary: CashDrawerSummary.from(opening: shift.openingCash, sessions: sessions, ops: ops),
                  ops: ops,
                  shift: shift,
                  live: true,
                ));
              },
            );
          },
        );
      case _Period.pastShift:
      case _Period.custom:
        return FutureBuilder<List<CashOp>>(
          future: _opsFuture,
          builder: (context, opsSnap) {
            final ops = opsSnap.data ?? const <CashOp>[];
            final shift = _period == _Period.pastShift ? _selectedPastShift : null;
            return builder(_Cash(
              summary: CashDrawerSummary.from(
                  opening: shift?.openingCash ?? 0, sessions: sessions, ops: ops, countDiff: shift?.closingDiff ?? 0),
              ops: ops,
              shift: shift,
              live: false,
              rangeOnly: _period == _Period.custom,
            ));
          },
        );
    }
  }

  List<Widget> _itemsTable(_XReportData data) => [
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 4),
          child: Row(
            children: [
              Expanded(flex: 3, child: Text('Позиция', style: TextStyle(color: AppColors.textMuted, fontSize: 12))),
              Expanded(
                  flex: 1,
                  child: Text('Кол-во',
                      textAlign: TextAlign.right, style: TextStyle(color: AppColors.textMuted, fontSize: 12))),
              Expanded(
                  flex: 2,
                  child: Text('Цена',
                      textAlign: TextAlign.right, style: TextStyle(color: AppColors.textMuted, fontSize: 12))),
              Expanded(
                  flex: 2,
                  child: Text('Сумма',
                      textAlign: TextAlign.right, style: TextStyle(color: AppColors.textMuted, fontSize: 12))),
            ],
          ),
        ),
        const Divider(height: 8),
        ...data.items.map((i) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                children: [
                  Expanded(flex: 3, child: Text(i.name)),
                  Expanded(flex: 1, child: Text('${i.qty} шт.', textAlign: TextAlign.right)),
                  Expanded(flex: 2, child: Text(rub(i.price), textAlign: TextAlign.right)),
                  Expanded(
                      flex: 2,
                      child: Text(rub(i.revenue),
                          textAlign: TextAlign.right, style: const TextStyle(fontWeight: FontWeight.bold))),
                ],
              ),
            )),
      ];

  Widget _countRow(String label, int n) => Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [Text(label), Text('$n', style: const TextStyle(fontWeight: FontWeight.bold))],
      );

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
              color: (shift == null ? AppColors.danger : AppColors.textMuted).withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: [
                Icon(shift == null ? Icons.lock_outline : Icons.lock_open_outlined,
                    size: 18,
                    color: shift == null ? AppColors.danger : AppColors.textMuted),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        shift == null
                            ? 'Смена заведения сейчас не открыта'
                            : 'Смена заведения открыта ${_formatDateTime(shift.openedAt)} · ${shift.openedBy}',
                        style: const TextStyle(fontSize: 12),
                      ),
                      // Кто сейчас работает: ушёл кальянщик — смена и этот
                      // отчёт продолжаются у остальных.
                      if (shift != null)
                        ShiftCrewBuilder(
                          builder: (context, crew) => crew == null
                              ? const SizedBox.shrink()
                              : Padding(
                                  padding: const EdgeInsets.only(top: 2),
                                  child: Text(
                                    crew.isEmpty
                                        ? 'Никто не отметил начало своей смены'
                                        : 'Сейчас на смене: ${crew.shifts.map(crew.labelOf).join(', ')}',
                                    style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                                  ),
                                ),
                        ),
                    ],
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
                label: const Text('Закрыть смену заведения'),
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
            rub(value),
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
        // Открыта ли смена, сказано в плашке над списком (_buildShiftHeader).
        return '';
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

  /// Заголовок периода для копии и печати: «смена с 27.09.2026 10:02»,
  /// «смена 26.09.2026 04:29 — 27.09.2026 03:10», «01.09.2026 — 30.09.2026».
  String _periodTitle(_Cash? cash) {
    switch (_period) {
      case _Period.shift:
        final shift = cash?.shift;
        return shift == null ? 'смена не открыта' : 'смена с ${_formatDateTime(shift.openedAt)}';
      case _Period.pastShift:
        return _selectedPastShift == null ? '' : 'смена ${_formatShiftRange(_selectedPastShift!)}';
      case _Period.custom:
        return _formatSelectedRange();
    }
  }

  /// «Скопировать» — только итоги, без списка позиций: удобно отправить в
  /// чат владельцу.
  void _copyTotals(_XReportData data, _Cash? cash) {
    final text = xReportTotalsText(
      period: _periodTitle(cash),
      waiter: _employeeFilter == 'Все официанты' ? null : _employeeFilter,
      orderTotal: data.orderTotal,
      revenue: data.revenue,
      card: data.paymentCard,
      cash: data.paymentCash,
      terminal: data.paymentTerminal,
      aggregators: data.byAggregator,
      comp: data.paymentComp,
      collections: cash?.summary.collections ?? 0,
      cashInDrawer: cash == null || cash.rangeOnly ? null : cash.summary.expected,
    );
    Clipboard.setData(ClipboardData(text: text));
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Итоги отчёта скопированы')));
  }


  /// «Распечатать» — на чековом принтере заведения (Bluetooth или Wi‑Fi,
  /// Настройки → Интеграции). Нет принтера — только подсказка: скопировать
  /// отчёт можно соседней кнопкой.
  Future<void> _printReport(_XReportData data, int refundsCount, _Cash? cash) async {
    final printer = activeReceiptPrinter;
    if (printer == null) {
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          scrollable: true,
          title: const Text('Принтер не подключён'),
          content: const Text('Чековый принтер подключается в разделе «Интеграции» (Bluetooth или Wi‑Fi). '
              'Пока отчёт можно отправить в мессенджер кнопкой «Скопировать».'),
          actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Понятно'))],
        ),
      );
      return;
    }
    final lines = <ReportLine>[
      for (final i in data.items) ...[
        ReportLine(i.name),
        ReportLine('  ${i.qty} x ${rub(i.price)}', right: rub(i.revenue)),
      ],
      if (data.items.isNotEmpty) const ReportLine.separator(),
      ReportLine('Итого', right: rub(data.orderTotal)),
      ReportLine('К оплате', right: rub(data.revenue), bold: true),
      ReportLine('Картой', right: rub(data.paymentCard)),
      ReportLine('Наличными', right: rub(data.paymentCash)),
      ReportLine('Терминалом', right: rub(data.paymentTerminal)),
      for (final e in data.byAggregator.entries) ReportLine('Агрегатор · ${e.key}', right: rub(e.value)),
      ReportLine('За счёт заведения', right: rub(data.paymentComp)),
      if (cash != null) ...[
        ReportLine('Инкассация', right: rub(cash.summary.collections)),
        if (!cash.rangeOnly) ReportLine('Наличные в кассе', right: rub(cash.summary.expected), bold: true),
      ],
      if (data.tipsCash + data.tipsCard > 0) ...[
        const ReportLine.separator(),
        ReportLine('Чаевые наличными', right: rub(data.tipsCash)),
        ReportLine('Чаевые картой', right: rub(data.tipsCard)),
      ],
      if (data.unpaidCount > 0) ReportLine('Без оплаты: ${data.unpaidCount}', right: rub(data.unpaidAmount)),
      if (refundsCount > 0) ReportLine('Возвратов: $refundsCount'),
    ];
    // Закрытая смена — отчёт о закрытии: пересчёт кассы и отмены.
    final closed = cash?.shift != null && !cash!.shift!.isOpen ? cash.shift : null;
    if (closed != null) {
      final diff = closed.closingDiff;
      lines.addAll([
        const ReportLine.separator(),
        if (closed.closingExpectedCash != null) ReportLine('Должно быть в кассе', right: rub(closed.closingExpectedCash!)),
        if (closed.closingCountedCash != null) ReportLine('Пересчитано', right: rub(closed.closingCountedCash!)),
        if (diff != null)
          ReportLine(diff == 0 ? 'Расхождение' : (diff < 0 ? 'Недостача' : 'Излишек'),
              right: rub(diff.abs()), bold: true),
        if (closed.closingCollected != null) ReportLine('Инкассировано', right: rub(closed.closingCollected!)),
        if (closed.closingLeftCash != null) ReportLine('Оставлено на размен', right: rub(closed.closingLeftCash!)),
      ]);
      final voids = await AuditLogService.instance.voidsBetween(closed.openedAt, closed.closedAt ?? DateTime.now());
      if (voids != null && voids.$1 > 0) lines.add(ReportLine('Отмен позиций: ${voids.$1}', right: rub(voids.$2)));
    }
    final now = DateTime.now();
    final venue = VenueService.instance.cached.name;
    try {
      await printer.printReport(ReportPrint(
        title: closed != null ? 'ЗАКРЫТИЕ СМЕНЫ' : 'X-ОТЧЁТ',
        subtitle: [
          if (venue.isNotEmpty) venue,
          _periodTitle(cash),
          if (_employeeFilter != 'Все официанты') 'Официант: $_employeeFilter',
        ],
        lines: lines,
        footer: 'Печать: ${widget.employee.name}, ${_formatDateTime(now)}',
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
}

/// Наличные для отчёта: итог по кассе, операции и смена (для периода по
/// датам смены нет — там только сумма инкассаций).
class _Cash {
  final CashDrawerSummary summary;
  final List<CashOp> ops;
  final ShiftModel? shift;
  final bool live;
  final bool rangeOnly;
  const _Cash({required this.summary, required this.ops, required this.shift, required this.live, this.rangeOnly = false});
}

/// Итоги X-отчёта текстом — ровно те строки, что нужны в чат: без списка
/// проданных позиций. [cashInDrawer] — null для отчёта за период по
/// датам (там нет одной кассы, и строки нет).
String xReportTotalsText({
  required String period,
  String? waiter,
  required double orderTotal,
  required double revenue,
  required double card,
  required double cash,
  required double terminal,
  Map<String, double> aggregators = const {},
  required double comp,
  required double collections,
  double? cashInDrawer,
}) {
  final b = StringBuffer();
  b.writeln('X-отчёт: $period');
  if (waiter != null) b.writeln('Официант: $waiter');
  b.writeln();
  b.writeln('Итого: ${rub(orderTotal)}');
  b.writeln('К оплате: ${rub(revenue)}');
  b.writeln('Оплачено картой: ${rub(card)}');
  b.writeln('Оплачено наличными: ${rub(cash)}');
  b.writeln('Оплачено терминалом: ${rub(terminal)}');
  // Агрегатор доставки — каждый своей строкой: деньги придут от него позже.
  for (final e in aggregators.entries) {
    b.writeln('Агрегатор · ${e.key}: ${rub(e.value)}');
  }
  b.writeln('За счёт заведения: ${rub(comp)}');
  b.writeln('Инкассация: ${rub(collections)}');
  if (cashInDrawer != null) b.writeln('Наличные в кассе: ${rub(cashInDrawer)}');
  return b.toString().trimRight();
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

  /// Оплачено через агрегаторы доставки — всего и по каждому.
  final double paymentAggregator;
  final Map<String, double> byAggregator;
  final double tipsCash;
  final double tipsCard;

  /// Сумма чеков, закрытых «без оплаты» — денег по ним не поступало.
  final double unpaidAmount;
  final int unpaidCount;

  _XReportData({
    required this.items,
    required this.orderTotal,
    required this.revenue,
    required this.paymentCash,
    required this.paymentCard,
    required this.paymentTerminal,
    required this.paymentComp,
    required this.paymentAggregator,
    required this.byAggregator,
    required this.tipsCash,
    required this.tipsCard,
    required this.unpaidAmount,
    required this.unpaidCount,
  });

  factory _XReportData.fromSessions(List<SessionModel> sessions) {
    final byItem = <String, _XItemStat>{};
    double orderTotal = 0;
    double revenue = 0;
    double cash = 0;
    double card = 0;
    double terminal = 0;
    double comp = 0;
    double aggregator = 0;
    final byAggregator = <String, double>{};
    double tipsCash = 0;
    double tipsCard = 0;
    double unpaidAmount = 0;
    var unpaidCount = 0;
    for (final s in sessions) {
      // Чек «закрыт без оплаты» не даёт выручки — в «К оплате» не идёт,
      // иначе итог не сошёлся бы со способами оплаты.
      if (s.closedWithoutPayment) {
        unpaidCount++;
        unpaidAmount += s.totalWithDiscount;
        continue;
      }
      orderTotal += s.orderTotal;
      revenue += s.totalWithDiscount;
      cash += s.paymentCash;
      card += s.paymentCard;
      terminal += s.paymentTerminal;
      comp += s.paymentComp;
      if (s.paymentAggregator > 0) {
        aggregator += s.paymentAggregator;
        final name = s.aggregatorName.isEmpty ? 'агрегатор' : s.aggregatorName;
        byAggregator[name] = (byAggregator[name] ?? 0) + s.paymentAggregator;
      }
      tipsCash += s.tipsCash;
      tipsCard += s.tipsCard;
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
      paymentAggregator: aggregator,
      byAggregator: byAggregator,
      tipsCash: tipsCash,
      tipsCard: tipsCard,
      unpaidAmount: unpaidAmount,
      unpaidCount: unpaidCount,
    );
  }
}