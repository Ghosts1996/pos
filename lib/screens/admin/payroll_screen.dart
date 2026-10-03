import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/staff_shift_model.dart';
import '../../services/firestore_service.dart';
import '../../services/payroll_calculator.dart';
import '../../services/payroll_sales.dart';
import '../../utils/sale_kind.dart';
import '../../services/tips_service.dart';
import '../../utils/bill_split.dart';
import '../../utils/table_label.dart';
import '../../utils/human_error.dart';
import '../../utils/adaptive.dart';
import '../../theme/app_colors.dart';

/// Расчёт зарплаты сотрудников за выбранный период: часы и смены (ставка
/// за час или оклад за смену + переработка) — из «Смены сотрудников»,
/// проценты — с закрытых чеков (PayrollSales): официанту с чеков, которые
/// он вёл, кальянщику с кальянов, бармену с бара. Только реально
/// полученные деньги: возвраты, «за счёт заведения», бонусы и закрытие
/// без оплаты процента не дают. Ставки — действовавшие в момент смены.
///
/// Всё, что стоит проверить глазами, помечено в карточке: ручные правки
/// часов (и кто их сделал), правки самому себе, очень длинные смены,
/// изменение ставок в этом периоде.
class PayrollScreen extends StatefulWidget {
  const PayrollScreen({super.key});

  @override
  State<PayrollScreen> createState() => _PayrollScreenState();
}

class _PayrollScreenState extends State<PayrollScreen> {
  final _fs = FirestoreService();
  late DateTime _rangeStart;
  late DateTime _rangeEnd;
  bool _loading = true;
  String? _error;
  List<PayrollResult> _results = [];
  List<Employee> _unconfigured = [];

  /// Чаевые «всей смене», которые не на кого было поделить (никто не
  /// отмечал начало смены), и чаевые по именам, которых больше нет.
  double _unassignedTips = 0;

  /// Кальяны и бар, с которых процент некому было начислить.
  Map<String, double> _unassignedSales = const {};

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _rangeStart = DateTime(now.year, now.month, 1);
    _rangeEnd = DateTime(now.year, now.month + 1, 1);
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final employees = await _fs.employeesOnce();
      // Смены с запасом в сутки по краям и открытые — чтобы понять, кто был
      // на смене, когда закрыли чек (общий котёл кальянов и бара). Платим
      // только за смены, закончившиеся в периоде.
      final around = await _fs.closedStaffShiftsInRange(
          _rangeStart.subtract(const Duration(days: 1)), _rangeEnd.add(const Duration(days: 1)));
      final open = await _fs.openStaffShiftsOnce();
      final shifts = around
          .where((s) => s.endedAt != null && !s.endedAt!.isBefore(_rangeStart) && s.endedAt!.isBefore(_rangeEnd))
          .toList();
      final sessions = await _fs.closedSessionsInRange(_rangeStart, _rangeEnd);
      final sales = PayrollSales.attribute(sessions: sessions, employees: employees, shifts: [...around, ...open]);
      // Чаевые не должны ронять весь отчёт: если их не удалось загрузить,
      // зарплата всё равно посчитается.
      var tips = const <TipModel>[];
      try {
        tips = await TipsService.instance.paidInRange(_rangeStart, _rangeEnd);
      } catch (_) {}
      final tipShares = TipsService.sharesByEmployee(tips);
      final usedTipKeys = <String>{};

      final results = <PayrollResult>[];
      final unconfigured = <Employee>[];
      for (final emp in employees) {
        final empTips = (tipShares[emp.id] ?? 0) + (tipShares['name:${emp.name}'] ?? 0);
        usedTipKeys.addAll([emp.id, 'name:${emp.name}']);
        final empShifts = shifts.where((s) => s.employeeId == emp.id).toList();
        if (!emp.payrollConfigured) {
          // Зарплата не настроена, но чаевые ему оставили — их всё равно
          // нужно выдать, поэтому карточка нужна.
          if (empTips > 0) {
            results.add(PayrollCalculator.calculate(employee: emp, closedShifts: empShifts, tips: empTips));
          } else {
            unconfigured.add(emp);
          }
          continue;
        }
        results.add(PayrollCalculator.calculate(
            employee: emp, closedShifts: empShifts, credits: sales.of(emp.id), tips: empTips));
      }
      final unassignedTips = tipShares.entries
          .where((e) => !usedTipKeys.contains(e.key))
          .fold<double>(0, (a, e) => a + e.value);
      results.sort((a, b) => b.total.compareTo(a.total));

      if (!mounted) return;
      setState(() {
        _results = results;
        _unconfigured = unconfigured;
        _unassignedTips = unassignedTips;
        _unassignedSales = sales.unassigned;
        _loading = false;
      });
    } catch (e) {
      // Ошибку показываем, а не оставляем вечный спиннер.
      if (!mounted) return;
      setState(() {
        _error = 'Не удалось загрузить: ${humanError(e, lower: true)}';
        _loading = false;
      });
    }
  }

  void _setThisMonth() {
    final now = DateTime.now();
    setState(() {
      _rangeStart = DateTime(now.year, now.month, 1);
      _rangeEnd = DateTime(now.year, now.month + 1, 1);
    });
    _load();
  }

  void _setLastMonth() {
    final now = DateTime.now();
    setState(() {
      _rangeStart = DateTime(now.year, now.month - 1, 1);
      _rangeEnd = DateTime(now.year, now.month, 1);
    });
    _load();
  }

  void _setHalfMonth() {
    // Частый формат оплаты — аванс/получка два раза в месяц.
    final now = DateTime.now();
    if (now.day <= 15) {
      setState(() {
        _rangeStart = DateTime(now.year, now.month, 1);
        _rangeEnd = DateTime(now.year, now.month, 16);
      });
    } else {
      setState(() {
        _rangeStart = DateTime(now.year, now.month, 16);
        _rangeEnd = DateTime(now.year, now.month + 1, 1);
      });
    }
    _load();
  }

  Future<void> _pickCustomRange() async {
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime.now().subtract(const Duration(days: 730)),
      lastDate: DateTime.now().add(const Duration(days: 1)),
      initialDateRange:
          DateTimeRange(start: _rangeStart, end: _rangeEnd.subtract(const Duration(days: 1))),
    );
    if (picked == null) return;
    setState(() {
      _rangeStart = DateTime(picked.start.year, picked.start.month, picked.start.day);
      _rangeEnd =
          DateTime(picked.end.year, picked.end.month, picked.end.day).add(const Duration(days: 1));
    });
    _load();
  }

  String _fmtDay(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}.${d.year}';

  static String _numStr(double v) =>
      v == v.roundToDouble() ? v.toInt().toString() : v.toString().replaceAll('.', ',');

  /// «3 000 ₽», «766,50 ₽».
  static String _rub(double v) => formatKopecks((v * 100).round());

  /// «7,5» — часы с десятичной запятой, как принято в русском тексте.
  static String _hours(double v) => v.toStringAsFixed(1).replaceAll('.', ',');

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Зарплата')),
      body: CenteredBody(
        maxWidth: 900,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(8),
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  ActionChip(label: const Text('Пол-месяца'), onPressed: _setHalfMonth),
                  ActionChip(label: const Text('Этот месяц'), onPressed: _setThisMonth),
                  ActionChip(label: const Text('Прошлый месяц'), onPressed: _setLastMonth),
                  ActionChip(
                    avatar: const Icon(Icons.date_range, size: 16),
                    label: Text(
                        '${_fmtDay(_rangeStart)} – ${_fmtDay(_rangeEnd.subtract(const Duration(days: 1)))}'),
                    onPressed: _pickCustomRange,
                  ),
                ],
              ),
            ),
            StreamBuilder<List<StaffShiftModel>>(
              stream: _fs.openStaffShiftsStream(),
              builder: (context, snap) {
                // Только смены, начавшиеся до конца ВЫБРАННОГО периода — иначе
                // баннер пугал бы "не закрыто смен" из-за открытой смены,
                // которая к этому отчёту вообще не относится (например, смена
                // началась сегодня, а отчёт строится за прошлый месяц).
                final open = (snap.data ?? [])
                    .where((s) => s.startedAt.isBefore(_rangeEnd))
                    .toList();
                if (open.isEmpty) return const SizedBox.shrink();
                return Container(
                  width: double.infinity,
                  color: AppColors.warning.withValues(alpha: 0.12),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  child: Text(
                    'Не закрыто смен: ${open.length} (${open.map((s) => s.employeeName).toSet().join(", ")}) — '
                    'их часы не войдут в расчёт, пока смена не закрыта. Закрыть можно в "Смены сотрудников".',
                    style: const TextStyle(fontSize: 12),
                  ),
                );
              },
            ),
            const Divider(height: 1),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                      ? Center(child: Text(_error!, textAlign: TextAlign.center))
                      : _results.isEmpty
                      ? Center(
                          child: Text(_unconfigured.isEmpty
                              ? 'Нет сотрудников'
                              : 'Ни у одного сотрудника не настроена зарплата.\n'
                                  'Откройте карточку сотрудника → «Зарплата».'),
                        )
                      : ListView(
                          children: [
                            _totalsCard(),
                            if (_unassignedTips > 0.5)
                              Padding(
                                padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
                                child: Text(
                                  'Чаевые без получателя: ${_rub(_unassignedTips)}'
                                  ' — «всей смене», когда никто не отмечал '
                                  'начало смены, или сотрудникам, которых уже нет в списке. '
                                  'Поделите их вручную.',
                                  style: const TextStyle(fontSize: 12),
                                ),
                              ),
                            for (final kind in [SaleKind.hookah, SaleKind.bar])
                              if ((_unassignedSales[kind] ?? 0) > 0.5)
                                Padding(
                                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
                                  child: Text(
                                    '${kind == SaleKind.hookah ? 'Кальяны' : 'Бар'} на ${_rub(_unassignedSales[kind]!)} — '
                                    'процент никому не начислен: на смене не было никого с процентом '
                                    '${kind == SaleKind.hookah ? 'с кальянов' : 'с бара'}.',
                                    style: const TextStyle(fontSize: 12),
                                  ),
                                ),
                            ..._results.map(_employeeCard),
                            if (_unconfigured.isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.all(16),
                                child: Text(
                                  'Без настроенной зарплаты: ${_unconfigured.map((e) => e.name).join(", ")}',
                                  style: const TextStyle(fontSize: 12, color: Colors.grey),
                                ),
                              ),
                          ],
                        ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _totalsCard() {
    final totalPay = _results.fold<double>(0, (sum, r) => sum + r.total);
    final totalHours = _results.fold<double>(0, (sum, r) => sum + r.totalHours);
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 6),
      color: Theme.of(context).colorScheme.primaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('${_fmtDay(_rangeStart)} – ${_fmtDay(_rangeEnd.subtract(const Duration(days: 1)))}'),
            Text('${_hours(totalHours)} ч · Итого: ${_rub(totalPay)}',
                style: const TextStyle(fontWeight: FontWeight.bold)),
          ],
        ),
      ),
    );
  }

  Widget _employeeCard(PayrollResult r) {
    final emp = r.employee;
    final rows = <Widget>[];
    if (emp.shiftRateEnabled) {
      rows.add(_row('Оклад за смену',
          '${r.shiftsPaid} × ${_rub(emp.shiftRate)}',
          _rub(r.shiftPay)));
    }
    if (emp.hourlyRateEnabled) {
      rows.add(_row('Обычные часы',
          '${_hours(r.normalHours)} ч × ${_rub(emp.hourlyRate)}',
          _rub(r.hourlyPay)));
    }
    if (emp.overtimeEnabled && r.overtimeHours > 0 && r.overtimePay > 0) {
      rows.add(_row(
          'Переработка',
          '${_hours(r.overtimeHours)} ч × ${_rub(r.overtimeHourPrice)}',
          _rub(r.overtimePay)));
    }
    String pct(double pay, double base) => base > 0 ? '${_numStr(((pay / base) * 1000).round() / 10)}%' : '';
    if (r.checkPay > 0 || (emp.salesPercentEnabled && emp.salesPercentRate > 0)) {
      rows.add(_row('С чеков', '${pct(r.checkPay, r.checkRevenue)} от ${_rub(r.checkRevenue)}', _rub(r.checkPay)));
    }
    if (r.hookahPay > 0 || (emp.salesPercentEnabled && emp.hookahPercentRate > 0)) {
      rows.add(_row(
          'С кальянов',
          '${pct(r.hookahPay, r.hookahRevenue)} от ${_rub(r.hookahRevenue)}'
              '${r.hookahRevenue > r.hookahPersonal + 0.5 ? ' (свои ${_rub(r.hookahPersonal)}, доля смены ${_rub(r.hookahRevenue - r.hookahPersonal)})' : ''}',
          _rub(r.hookahPay)));
    }
    if (r.barPay > 0 || (emp.salesPercentEnabled && emp.barPercentRate > 0)) {
      rows.add(_row(
          'С бара',
          '${pct(r.barPay, r.barRevenue)} от ${_rub(r.barRevenue)}'
              '${r.barRevenue > r.barPersonal + 0.5 ? ' (свои ${_rub(r.barPersonal)}, доля смены ${_rub(r.barRevenue - r.barPersonal)})' : ''}',
          _rub(r.barPay)));
    }
    if (r.tips > 0) {
      rows.add(_row('Чаевые', 'от гостей, не зарплата',
          _rub(r.tips)));
    }

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(emp.name, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                Text(
                    '${r.shiftsCount} ${pluralRu(r.shiftsCount, 'смена', 'смены', 'смен')} · '
                    '${_hours(r.totalHours)} ч',
                    style: const TextStyle(fontSize: 12, color: Colors.grey)),
              ],
            ),
            const SizedBox(height: 6),
            ...rows,
            ..._checks(r),
            const Divider(),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(r.tips > 0 ? 'К выплате' : 'Итого',
                    style: const TextStyle(fontWeight: FontWeight.bold)),
                Text(_rub(r.total),
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// Что стоит проверить: ручные правки часов, правки самому себе, очень
  /// длинные смены, изменение ставок в этом периоде.
  List<Widget> _checks(PayrollResult r) {
    final notes = <String>[];
    if (r.manualShifts > 0) {
      final who = r.editors.isEmpty ? '' : ' — ${r.editors.join(', ')}';
      notes.add('Часы правили вручную: ${r.manualShifts} ${pluralRu(r.manualShifts, 'смена', 'смены', 'смен')}, '
          '${_hours(r.manualHours)} ч$who');
    }
    if (r.selfEditedShifts > 0) {
      notes.add('Сам себе указал время: ${r.selfEditedShifts} ${pluralRu(r.selfEditedShifts, 'раз', 'раза', 'раз')}');
    }
    if (r.longShifts > 0) {
      notes.add('Смены длиннее ${PayrollCalculator.longShiftHours.round()} ч: ${r.longShifts}');
    }
    final changes = r.employee.payHistory
        .where((c) => !c.at.isBefore(_rangeStart) && c.at.isBefore(_rangeEnd))
        .toList();
    for (final c in changes) {
      notes.add('Оплату изменили ${_fmtDay(c.at)}${c.byName.isNotEmpty ? ' (${c.byName == r.employee.name ? 'сам' : c.byName})' : ''}: '
          '${c.terms.summary()}');
    }
    if (notes.isEmpty) return const [];
    return [
      const SizedBox(height: 6),
      Container(
        width: double.infinity,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: AppColors.warning.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Проверьте', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 12.5)),
            const SizedBox(height: 2),
            for (final n in notes) Text('• $n', style: const TextStyle(fontSize: 12.5)),
          ],
        ),
      ),
    ];
  }

  Widget _row(String label, String detail, String amount) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Expanded(child: Text('$label: $detail', style: const TextStyle(fontSize: 13))),
          Text(amount, style: const TextStyle(fontSize: 13)),
        ],
      ),
    );
  }
}
