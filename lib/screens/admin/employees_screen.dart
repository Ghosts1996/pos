import 'package:flutter/material.dart';

import '../../models/employee.dart';
import '../../services/firestore_service.dart';
import '../../services/plan_capabilities.dart';
import '../../services/tips_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/bill_split.dart';
import '../../utils/constants.dart';
import 'employee_edit_screen.dart';
import '../../utils/human_error.dart';
import '../../utils/adaptive.dart';
import '../../utils/payroll_guard.dart';
import '../../widgets/plan_upsell.dart';

class EmployeesScreen extends StatefulWidget {
  /// Кто вошёл — им подписываются правки оплаты (см. PayrollGuard).
  final Employee employee;
  const EmployeesScreen({super.key, required this.employee});

  @override
  State<EmployeesScreen> createState() => _EmployeesScreenState();
}

class _EmployeesScreenState extends State<EmployeesScreen> {
  final _fs = FirestoreService();
  late final Stream<List<Employee>> _employees = _fs.employeesStream();
  // PIN-коды по умолчанию скрыты точками — их видно только сотруднику,
  // который вводит свой PIN на входе. Чтобы посмотреть чужой PIN в
  // админке, нужно осознанно нажать на значок глаза у конкретной строки.
  // Сколько сотрудников уже есть — для лимита тарифа (см. _add).
  int _count = 0;
  // Последний список — чтобы понять, есть ли другой администратор.
  List<Employee> _all = const [];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Сотрудники')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _add,
        icon: const Icon(Icons.person_add_alt_1),
        label: const Text('Добавить'),
      ),
      body: CenteredBody(
        maxWidth: 760,
        child: StreamBuilder<List<Employee>>(
          stream: _employees,
          builder: (context, snap) {
            if (snap.hasError) {
              return const Center(child: Text('Не удалось загрузить сотрудников — проверьте интернет'));
            }
            if (!snap.hasData) return const Center(child: CircularProgressIndicator());
            _all = snap.data!;
            _count = snap.data!.length;
            final employees = [...snap.data!]
              ..sort((a, b) {
                // Сначала администраторы, дальше по имени.
                final r = (b.role == AppConstants.roleAdmin ? 1 : 0) - (a.role == AppConstants.roleAdmin ? 1 : 0);
                return r != 0 ? r : a.name.toLowerCase().compareTo(b.name.toLowerCase());
              });
            if (employees.isEmpty) {
              return const Center(
                child: Padding(
                  padding: EdgeInsets.all(32),
                  child: Text(
                    'Сотрудников пока нет.\nДобавьте первого — он будет входить по своему PIN-коду.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.textMuted),
                  ),
                ),
              );
            }
            return LayoutBuilder(builder: (context, box) {
              final side = box.maxWidth > 752 ? (box.maxWidth - 720) / 2 : 12.0;
              return ListView.separated(
                padding: EdgeInsets.fromLTRB(side, 12, side, 96),
                itemCount: employees.length,
                separatorBuilder: (_, __) => const SizedBox(height: 8),
                itemBuilder: (context, i) => _card(employees[i]),
              );
            });
          },
        ),
      ),
    );
  }

  Widget _card(Employee e) {
    final admin = e.role == AppConstants.roleAdmin;
    final pay = payrollSummary(e);
    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () => _edit(e),
        child: Container(
          padding: const EdgeInsets.fromLTRB(14, 12, 6, 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.border),
          ),
          child: Row(
            children: [
              CircleAvatar(
                radius: 22,
                backgroundColor: admin ? AppColors.selectionStrong : AppColors.selection,
                child: Text(_initials(e.name), style: const TextStyle(fontWeight: FontWeight.w700)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(e.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        _tag(admin ? 'Администратор' : AppConstants.positionShortLabel(e.position),
                            admin ? Icons.admin_panel_settings_outlined : Icons.work_outline),
                        if (admin && e.position != AppConstants.positionUniversal)
                          _tag(AppConstants.positionShortLabel(e.position), Icons.work_outline),
                        _tag(pay.isEmpty ? 'Зарплата не настроена' : pay, Icons.payments_outlined,
                            muted: pay.isEmpty),
                      ],
                    ),
                  ],
                ),
              ),
              // PIN хранится хэшем — показываем только, что он задан.
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  const Icon(Icons.lock_outline, size: 16, color: AppColors.textMuted),
                  const SizedBox(width: 4),
                  Text('•' * AppConstants.pinLengthForRole(e.role),
                      style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()], color: AppColors.textMuted)),
                ]),
              ),
              PopupMenuButton<String>(
                tooltip: 'Ещё',
                onSelected: (v) {
                  if (v == 'edit') _edit(e);
                  if (v == 'delete') _delete(e);
                },
                itemBuilder: (_) => const [
                  PopupMenuItem(value: 'edit', child: Text('Изменить')),
                  PopupMenuItem(value: 'delete', child: Text('Удалить', style: TextStyle(color: AppColors.danger))),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _tag(String text, IconData icon, {bool muted = false}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: muted ? Colors.transparent : AppColors.selection,
          borderRadius: BorderRadius.circular(999),
          border: muted ? Border.all(color: AppColors.border) : null,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 13, color: AppColors.textMuted),
          const SizedBox(width: 4),
          Flexible(
            child: Text(text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: muted ? AppColors.textMuted : AppColors.textPrimary)),
          ),
        ]),
      );

  static String _initials(String name) {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.characters.first.toUpperCase();
    return (parts[0].characters.first + parts[1].characters.first).toUpperCase();
  }

  /// Новый сотрудник — в пределах тарифа заведения.
  Future<void> _add() async {
    final caps = PlanCapabilitiesService.current.value;
    if (!caps.canAddEmployee(_count)) {
      final max = caps.maxEmployees;
      await showPlanUpsell(context,
          title: 'Достигнут лимит сотрудников',
          text: 'На тарифе заведения — до $max ${employeesWord(max)}. Чтобы добавить ещё, '
              'удалите того, кто больше не работает, или перейдите на тариф с большим лимитом.');
      return;
    }
    await _edit(null);
  }

  Future<void> _edit(Employee? emp) async {
    // Свою оплату администратор не меняет, если есть другой администратор.
    final payLock = emp == null
        ? null
        : PayrollGuard.ownRecordBlock(widget.employee, emp.id, _all, what: 'свою оплату');
    var result = await Navigator.of(context).push<Employee>(
      MaterialPageRoute(builder: (_) => EmployeeEditScreen(employee: emp, payLockedReason: payLock)),
    );
    if (result == null) return;
    if (payLock != null && emp != null) {
      // На всякий случай: оплату из закрытой формы не берём.
      result = result.copyWith(
        hourlyRateEnabled: emp.hourlyRateEnabled,
        hourlyRate: emp.hourlyRate,
        shiftRateEnabled: emp.shiftRateEnabled,
        shiftRate: emp.shiftRate,
        overtimeEnabled: emp.overtimeEnabled,
        overtimeThresholdHours: emp.overtimeThresholdHours,
        overtimeMultiplier: emp.overtimeMultiplier,
        overtimeHourRate: emp.overtimeHourRate,
        salesPercentEnabled: emp.salesPercentEnabled,
        salesPercentRate: emp.salesPercentRate,
        checkPercentExcludesHookah: emp.checkPercentExcludesHookah,
        hookahPercentRate: emp.hookahPercentRate,
        barPercentRate: emp.barPercentRate,
      );
    }
    try {
      if (emp == null) {
        await _fs.addEmployee(result, editor: widget.employee);
      } else {
        await _fs.updateEmployee(result, editor: widget.employee);
        // Если он сейчас на смене — гость сразу увидит новое имя и ссылку.
        TipsService.instance.refreshMember(result).catchError((_) {});
      }
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(emp == null ? 'Сотрудник «${result.name}» добавлен' : 'Сохранено')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось сохранить сотрудника: ${humanError(e, lower: true)}')));
      }
    }
  }

  Future<void> _delete(Employee e) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        scrollable: true,
        title: const Text('Удалить сотрудника?'),
        content: Text('«${e.name}» больше не сможет войти по своему PIN-коду. '
            'Его смены и продажи останутся в отчётах.'),
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
    if (confirm != true) return;
    try {
      await _fs.deleteEmployee(e.id);
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Не удалось удалить: ${humanError(err, lower: true)}')));
      }
    }
  }
}

/// «3 000 ₽ за смену + переработка · 5% с чеков» — коротко о зарплате
/// сотрудника для списка. Пусто — зарплата не настроена.
String payrollSummary(Employee e) {
  String rub(double v) => formatKopecks((v * 100).round());
  final parts = <String>[];
  if (e.shiftRateEnabled && e.shiftRate > 0) {
    parts.add('${rub(e.shiftRate)} за смену${e.overtimeEnabled ? ' + переработка' : ''}');
  } else if (e.hourlyRateEnabled && e.hourlyRate > 0) {
    parts.add('${rub(e.hourlyRate)} в час${e.overtimeEnabled ? ' + переработка' : ''}');
  }
  String pct(double p) => '${p == p.roundToDouble() ? p.toInt() : p.toString().replaceAll('.', ',')}%';
  if (e.salesPercentEnabled) {
    if (e.salesPercentRate > 0) parts.add('${pct(e.salesPercentRate)} с чеков');
    if (e.hookahPercentRate > 0) parts.add('${pct(e.hookahPercentRate)} с кальянов');
    if (e.barPercentRate > 0) parts.add('${pct(e.barPercentRate)} с бара');
  }
  return parts.join(' · ');
}
