import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/staff_shift_model.dart';
import '../../services/firestore_service.dart';
import '../../services/payroll_calculator.dart';
import '../../utils/constants.dart';

/// Расчёт зарплаты сотрудников за выбранный период: часы (оклад +
/// переработка) — из "Смены сотрудников", выручка для процента с продаж —
/// из закрытых чеков (та же выручка, что и в "Отчётах", те же исключения:
/// возвраты и чеки, закрытые без оплаты, в неё не входят).
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
      final employees = await _fs.employeesStream().first;
      final shifts = await _fs.closedStaffShiftsInRange(_rangeStart, _rangeEnd);
      final sessions = await _fs.closedSessionsInRange(_rangeStart, _rangeEnd);

      // Та же выручка, что в "Отчётах": возвраты и чеки, закрытые без оплаты,
      // в неё не входят (иначе процент с продаж начислялся бы на деньги,
      // которых заведение фактически не получило).
      final revenueByName = <String, double>{};
      for (final s in sessions) {
        if (s.refunded || s.closedWithoutPayment) continue;
        final name = s.employeeName.isEmpty ? 'Без имени' : s.employeeName;
        revenueByName[name] = (revenueByName[name] ?? 0) + s.totalWithDiscount;
      }

      final results = <PayrollResult>[];
      final unconfigured = <Employee>[];
      for (final emp in employees) {
        if (!emp.payrollConfigured) {
          unconfigured.add(emp);
          continue;
        }
        final empShifts = shifts.where((s) => s.employeeId == emp.id).toList();
        final revenue = revenueByName[emp.name] ?? 0;
        results.add(PayrollCalculator.calculate(
            employee: emp, closedShifts: empShifts, salesRevenue: revenue));
      }
      results.sort((a, b) => b.total.compareTo(a.total));

      if (!mounted) return;
      setState(() {
        _results = results;
        _unconfigured = unconfigured;
        _loading = false;
      });
    } catch (e) {
      // Раньше необработанная ошибка (например permission-denied) оставляла
      // спиннер крутиться вечно — сотрудник видел "загрузку", которая
      // никогда не заканчивается, без единого объяснения.
      if (!mounted) return;
      setState(() {
        _error = 'Не удалось загрузить: $e';
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

  static String _numStr(double v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Зарплата')),
      body: Column(
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
              final open = snap.data ?? [];
              if (open.isEmpty) return const SizedBox.shrink();
              return Container(
                width: double.infinity,
                color: Colors.orange.withValues(alpha: 0.12),
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
            Text('${totalHours.toStringAsFixed(1)} ч · Итого: ${totalPay.toStringAsFixed(0)} ${AppConstants.currencySymbol}',
                style: const TextStyle(fontWeight: FontWeight.bold)),
          ],
        ),
      ),
    );
  }

  Widget _employeeCard(PayrollResult r) {
    final emp = r.employee;
    final rows = <Widget>[];
    if (emp.hourlyRateEnabled) {
      rows.add(_row('Обычные часы',
          '${r.normalHours.toStringAsFixed(1)} ч × ${_numStr(emp.hourlyRate)} ${AppConstants.currencySymbol}',
          '${r.hourlyPay.toStringAsFixed(0)} ${AppConstants.currencySymbol}'));
    }
    if (emp.hourlyRateEnabled && emp.overtimeEnabled && r.overtimeHours > 0) {
      rows.add(_row(
          'Переработка',
          '${r.overtimeHours.toStringAsFixed(1)} ч × ${_numStr(emp.hourlyRate * emp.overtimeMultiplier)} ${AppConstants.currencySymbol}',
          '${r.overtimePay.toStringAsFixed(0)} ${AppConstants.currencySymbol}'));
    }
    if (emp.salesPercentEnabled) {
      rows.add(_row(
          'Процент с продаж',
          '${_numStr(emp.salesPercentRate)}% от ${r.salesRevenue.toStringAsFixed(0)} ${AppConstants.currencySymbol}',
          '${r.salesPercentPay.toStringAsFixed(0)} ${AppConstants.currencySymbol}'));
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
                Text('${r.shiftsCount} смен', style: const TextStyle(fontSize: 12, color: Colors.grey)),
              ],
            ),
            const SizedBox(height: 6),
            ...rows,
            const Divider(),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Итого', style: TextStyle(fontWeight: FontWeight.bold)),
                Text('${r.total.toStringAsFixed(0)} ${AppConstants.currencySymbol}',
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              ],
            ),
          ],
        ),
      ),
    );
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
