import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/staff_shift_model.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';

/// Табель личных смен сотрудников — учёт отработанного времени для расчёта
/// зарплаты (см. PayrollScreen и PayrollCalculator). Это НЕ кассовая смена
/// (Отчёты → там она одна на всё заведение): здесь у каждого сотрудника
/// свои записи, начатые и законченные им самим через "Мою смену" в меню, а
/// админ может добавить/поправить запись вручную — например, если человек
/// забыл нажать "Закончить смену".
class StaffShiftsScreen extends StatefulWidget {
  const StaffShiftsScreen({super.key});

  @override
  State<StaffShiftsScreen> createState() => _StaffShiftsScreenState();
}

class _StaffShiftsScreenState extends State<StaffShiftsScreen> {
  final _fs = FirestoreService();
  late DateTime _rangeStart;
  late DateTime _rangeEnd; // граница исключающая, как в closedStaffShiftsInRange
  String? _employeeFilter;
  List<Employee> _employees = [];
  List<StaffShiftModel> _shifts = [];
  bool _loading = true;
  String? _error;

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
      if (!mounted) return;
      setState(() {
        _employees = employees;
        _shifts = shifts;
        _loading = false;
      });
    } catch (e) {
      // Раньше необработанная ошибка (например permission-denied) оставляла
      // спиннер крутиться вечно без единого объяснения.
      if (!mounted) return;
      setState(() {
        _error = 'Не удалось загрузить: $e';
        _loading = false;
      });
    }
  }

  void _setToday() {
    final now = DateTime.now();
    final day = DateTime(now.year, now.month, now.day);
    setState(() {
      _rangeStart = day;
      _rangeEnd = day.add(const Duration(days: 1));
    });
    _load();
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

  Future<DateTime?> _pickDateTime(BuildContext ctx, DateTime initial) async {
    final date = await showDatePicker(
      context: ctx,
      initialDate: initial,
      firstDate: DateTime.now().subtract(const Duration(days: 730)),
      lastDate: DateTime.now().add(const Duration(days: 1)),
    );
    if (date == null || !ctx.mounted) return null;
    final time = await showTimePicker(context: ctx, initialTime: TimeOfDay.fromDateTime(initial));
    if (time == null) return null;
    return DateTime(date.year, date.month, date.day, time.hour, time.minute);
  }

  Future<void> _forceClose(StaffShiftModel shift) async {
    final picked = await _pickDateTime(context, DateTime.now());
    if (picked == null) return;
    if (!picked.isAfter(shift.startedAt)) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Время окончания должно быть позже начала смены')));
      }
      return;
    }
    await _fs.clockOut(shift.id, shift.employeeId, endedAt: picked, manual: true);
    _load();
  }

  Future<void> _editShift(StaffShiftModel? shift) async {
    if (_employees.isEmpty) return;
    Employee selected = shift == null
        ? _employees.first
        : _employees.firstWhere((e) => e.id == shift.employeeId, orElse: () => _employees.first);
    DateTime start = shift?.startedAt ?? DateTime.now().subtract(const Duration(hours: 8));
    DateTime end = shift?.endedAt ?? DateTime.now();

    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSt) {
        return AlertDialog(
          title: Text(shift == null ? 'Добавить смену' : 'Редактировать смену'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DropdownButtonFormField<Employee>(
                  initialValue: selected,
                  decoration: const InputDecoration(labelText: 'Сотрудник'),
                  items: _employees
                      .map((e) => DropdownMenuItem(value: e, child: Text(e.name)))
                      .toList(),
                  onChanged: (e) => setSt(() => selected = e ?? selected),
                ),
                const SizedBox(height: 12),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Начало'),
                  subtitle: Text(_fmtDateTime(start)),
                  trailing: const Icon(Icons.edit_calendar_outlined),
                  onTap: () async {
                    final picked = await _pickDateTime(ctx, start);
                    if (picked != null) setSt(() => start = picked);
                  },
                ),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Конец'),
                  subtitle: Text(_fmtDateTime(end)),
                  trailing: const Icon(Icons.edit_calendar_outlined),
                  onTap: () async {
                    final picked = await _pickDateTime(ctx, end);
                    if (picked != null) setSt(() => end = picked);
                  },
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Сохранить')),
          ],
        );
      }),
    );

    if (saved != true) return;
    if (!end.isAfter(start)) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Конец смены должен быть позже начала')));
      }
      return;
    }

    final result = StaffShiftModel(
      id: shift?.id ?? '',
      employeeId: selected.id,
      employeeName: selected.name,
      startedAt: start,
      endedAt: end,
      status: 'closed',
      manual: true,
    );
    if (shift == null) {
      await _fs.addStaffShift(result);
    } else {
      await _fs.updateStaffShift(result);
    }
    _load();
  }

  Future<void> _deleteShift(StaffShiftModel shift) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Удалить запись?'),
        content: Text(
            'Смена «${shift.employeeName}» ${_fmtDateTime(shift.startedAt)} будет удалена без возможности восстановить.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Удалить'),
          ),
        ],
      ),
    );
    if (confirm == true) {
      await _fs.deleteStaffShift(shift.id);
      _load();
    }
  }

  String _fmtDay(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}.${d.year}';

  String _fmtDateTime(DateTime d) =>
      '${_fmtDay(d)} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Смены сотрудников')),
      floatingActionButton: FloatingActionButton(
        onPressed: _employees.isEmpty ? null : () => _editShift(null),
        child: const Icon(Icons.add),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(8),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                ActionChip(label: const Text('Сегодня'), onPressed: _setToday),
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
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Не закрыто смен: ${open.length} — их часы не войдут в зарплату, пока не закрыть',
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12),
                    ),
                    ...open.map((s) => ListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          title: Text(s.employeeName),
                          subtitle: Text('Начата ${_fmtDateTime(s.startedAt)}'),
                          trailing: TextButton(
                            onPressed: () => _forceClose(s),
                            child: const Text('Закрыть'),
                          ),
                        )),
                  ],
                ),
              );
            },
          ),
          if (_employees.length > 1)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              child: Row(
                children: [
                  const Text('Сотрудник: '),
                  DropdownButton<String?>(
                    value: _employeeFilter,
                    hint: const Text('Все'),
                    items: [
                      const DropdownMenuItem<String?>(value: null, child: Text('Все')),
                      ..._employees
                          .map((e) => DropdownMenuItem<String?>(value: e.id, child: Text(e.name))),
                    ],
                    onChanged: (v) => setState(() => _employeeFilter = v),
                  ),
                ],
              ),
            ),
          const Divider(height: 1),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                    ? Center(child: Text(_error!, textAlign: TextAlign.center))
                    : _buildList(),
          ),
        ],
      ),
    );
  }

  Widget _buildList() {
    final filtered = _employeeFilter == null
        ? _shifts
        : _shifts.where((s) => s.employeeId == _employeeFilter).toList();
    if (filtered.isEmpty) {
      return const Center(child: Text('За этот период смен нет'));
    }
    var totalHours = 0.0;
    for (final s in filtered) {
      totalHours += s.duration.inSeconds / 3600.0;
    }
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Text('Всего: ${filtered.length} смен, ${totalHours.toStringAsFixed(1)} ч',
              style: const TextStyle(fontWeight: FontWeight.bold)),
        ),
        Expanded(
          child: ListView.builder(
            itemCount: filtered.length,
            itemBuilder: (context, i) {
              final s = filtered[i];
              final hours = s.duration.inSeconds / 3600.0;
              return ListTile(
                leading: const Icon(Icons.timer_outlined),
                title: Text(s.employeeName),
                subtitle: Text(
                  '${_fmtDateTime(s.startedAt)} — ${s.endedAt != null ? _fmtDateTime(s.endedAt!) : "…"}'
                  ' · ${hours.toStringAsFixed(1)} ч${s.manual ? " · вручную" : ""}',
                ),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                        icon: const Icon(Icons.edit_outlined), onPressed: () => _editShift(s)),
                    IconButton(
                        icon: const Icon(Icons.delete_outline), onPressed: () => _deleteShift(s)),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}
