import '../../theme/app_colors.dart';
import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../services/firestore_service.dart';
import '../../utils/constants.dart';

class EmployeesScreen extends StatefulWidget {
  const EmployeesScreen({super.key});

  @override
  State<EmployeesScreen> createState() => _EmployeesScreenState();
}

class _EmployeesScreenState extends State<EmployeesScreen> {
  final _fs = FirestoreService();
  // PIN-коды по умолчанию скрыты звёздочками — их видно только сотруднику,
  // который вводит свой PIN на входе. Чтобы посмотреть чужой PIN в
  // админке, нужно осознанно нажать на значок глаза для конкретной строки.
  final Set<String> _revealed = {};

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Сотрудники')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _editEmployee(context, _fs, null),
        child: const Icon(Icons.add),
      ),
      body: StreamBuilder<List<Employee>>(
        stream: _fs.employeesStream(),
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final employees = snap.data!;
          if (employees.isEmpty) return const Center(child: Text('Добавьте первого сотрудника'));
          return ListView(
            children: employees.map((e) {
              final revealed = _revealed.contains(e.id);
              return ListTile(
                leading: Icon(e.role == AppConstants.roleAdmin ? Icons.admin_panel_settings : Icons.person),
                title: Text(e.name),
                subtitle: Row(
                  children: [
                    Text('${e.role == AppConstants.roleAdmin ? "Администратор" : "Сотрудник"} · PIN '),
                    Text(revealed ? e.pinCode : '•' * AppConstants.pinLengthForRole(e.role)),
                    InkWell(
                      onTap: () => setState(() {
                        revealed ? _revealed.remove(e.id) : _revealed.add(e.id);
                      }),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: Icon(revealed ? Icons.visibility_off : Icons.visibility, size: 16),
                      ),
                    ),
                    if (e.payrollConfigured)
                      const Padding(
                        padding: EdgeInsets.only(left: 4),
                        child: Icon(Icons.payments_outlined, size: 14, color: Colors.green),
                      ),
                    if (e.position != AppConstants.positionUniversal)
                      Padding(
                        padding: const EdgeInsets.only(left: 4),
                        child: Text('· ${AppConstants.positionLabel(e.position)}'),
                      ),
                  ],
                ),
                trailing: IconButton(
                  icon: const Icon(Icons.delete_outline),
                  onPressed: () async {
                    final confirm = await showDialog<bool>(
                      context: context,
                      builder: (ctx) => AlertDialog(
                        title: const Text('Удалить сотрудника?'),
                        content: Text('«${e.name}» больше не сможет войти по своему PIN-коду.'),
                        actions: [
                          TextButton(
                              onPressed: () => Navigator.pop(ctx, false),
                              child: const Text('Отмена')),
                          FilledButton(
                            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
                            onPressed: () => Navigator.pop(ctx, true),
                            child: const Text('Удалить'),
                          ),
                        ],
                      ),
                    );
                    if (confirm == true) await _fs.deleteEmployee(e.id);
                  },
                ),
                onTap: () => _editEmployee(context, _fs, e),
              );
            }).toList(),
          );
        },
      ),
    );
  }

  static String _numStr(double v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString();

  static double _parseNum(String s, double fallback) =>
      double.tryParse(s.replaceAll(',', '.').trim()) ?? fallback;

  Future<void> _editEmployee(BuildContext context, FirestoreService fs, Employee? emp) async {
    final nameCtrl = TextEditingController(text: emp?.name ?? '');
    final pinCtrl = TextEditingController(text: emp?.pinCode ?? '');
    String role = emp?.role ?? AppConstants.roleEmployee;
    String position = emp?.position ?? AppConstants.positionUniversal;

    bool hourlyRateEnabled = emp?.hourlyRateEnabled ?? false;
    final hourlyRateCtrl = TextEditingController(text: _numStr(emp?.hourlyRate ?? 0));
    bool overtimeEnabled = emp?.overtimeEnabled ?? false;
    final overtimeThresholdCtrl =
        TextEditingController(text: _numStr(emp?.overtimeThresholdHours ?? 8));
    final overtimeMultiplierCtrl =
        TextEditingController(text: _numStr(emp?.overtimeMultiplier ?? 1.5));
    bool salesPercentEnabled = emp?.salesPercentEnabled ?? false;
    final salesPercentCtrl = TextEditingController(text: _numStr(emp?.salesPercentRate ?? 0));
    String? error;
    bool saving = false;

    final newEmp = await showDialog<Employee>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSt) {
        return AlertDialog(
          title: Text(emp == null ? 'Новый сотрудник' : 'Редактировать'),
          content: SizedBox(
            width: 360,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (error != null) ...[
                    Text(error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
                    const SizedBox(height: 8),
                  ],
                  TextField(
                      controller: nameCtrl, decoration: const InputDecoration(labelText: 'Имя')),
                  TextField(
                    controller: pinCtrl,
                    decoration: InputDecoration(
                      labelText: 'PIN-код (${AppConstants.pinLengthForRole(role)} ${role == AppConstants.roleAdmin ? "цифр" : "цифры"})',
                    ),
                    keyboardType: TextInputType.number,
                    maxLength: AppConstants.pinLengthForRole(role),
                    obscureText: true,
                  ),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      ChoiceChip(
                        label: const Text('Сотрудник'),
                        selected: role == AppConstants.roleEmployee,
                        // Разная длина PIN у ролей — переключение роли чистит
                        // поле, а не оставляет, например, 6 цифр под 4-значный
                        // код: иначе сохранение упадёт на проверке длины, а
                        // владельцу будет непонятно, что именно не так.
                        onSelected: (_) => setSt(() {
                          role = AppConstants.roleEmployee;
                          pinCtrl.clear();
                        }),
                      ),
                      const SizedBox(width: 8),
                      ChoiceChip(
                        label: const Text('Администратор'),
                        selected: role == AppConstants.roleAdmin,
                        onSelected: (_) => setSt(() {
                          role = AppConstants.roleAdmin;
                          pinCtrl.clear();
                        }),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue: position,
                    decoration: const InputDecoration(labelText: 'Специализация'),
                    items: AppConstants.employeePositions
                        .map((p) => DropdownMenuItem(
                              value: p,
                              child: Text(AppConstants.positionLabel(p)),
                            ))
                        .toList(),
                    onChanged: (v) => setSt(() => position = v ?? AppConstants.positionUniversal),
                  ),
                  const Text(
                    'Определяет, какие вызовы гостя из-за стола придут этому '
                    'сотруднику (например, официант не будет получать вызов '
                    'кальянщика на угли). Универсал получает все вызовы.',
                    style: TextStyle(fontSize: 11, color: Colors.grey),
                  ),
                  const Divider(height: 24),
                  Text('Зарплата', style: Theme.of(ctx).textTheme.titleSmall),
                  const SizedBox(height: 4),
                  const Text(
                    'Можно включить несколько способов сразу — они суммируются.',
                    style: TextStyle(fontSize: 11, color: Colors.grey),
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    title: const Text('Оклад (почасовая ставка)'),
                    value: hourlyRateEnabled,
                    onChanged: (v) => setSt(() => hourlyRateEnabled = v),
                  ),
                  if (hourlyRateEnabled) ...[
                    TextField(
                      controller: hourlyRateCtrl,
                      decoration: const InputDecoration(labelText: 'Ставка, ₽/час'),
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    ),
                    const SizedBox(height: 8),
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      dense: true,
                      title: const Text('Переработка сверх нормы часов'),
                      value: overtimeEnabled,
                      onChanged: (v) => setSt(() => overtimeEnabled = v),
                    ),
                  ],
                  if (hourlyRateEnabled && overtimeEnabled) ...[
                    TextField(
                      controller: overtimeThresholdCtrl,
                      decoration:
                          const InputDecoration(labelText: 'Порог, часов за одну смену'),
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    ),
                    const SizedBox(height: 8),
                    TextField(
                      controller: overtimeMultiplierCtrl,
                      decoration:
                          const InputDecoration(labelText: 'Множитель ставки (напр. 1.5)'),
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    ),
                    const SizedBox(height: 8),
                  ],
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    title: const Text('Процент с продаж'),
                    value: salesPercentEnabled,
                    onChanged: (v) => setSt(() => salesPercentEnabled = v),
                  ),
                  if (salesPercentEnabled)
                    TextField(
                      controller: salesPercentCtrl,
                      decoration: const InputDecoration(labelText: 'Процент, %'),
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: saving ? null : () => Navigator.pop(ctx),
              child: const Text('Отмена'),
            ),
            FilledButton(
              // Раньше валидация (PIN, ставка > 0 и т.п.) шла ПОСЛЕ того, как
              // диалог уже закрывался по нажатию "Сохранить" — при ошибке
              // диалог был уже закрыт, показывался только SnackBar с причиной,
              // а весь ввод (в т.ч. настроенная зарплата) терялся. Выглядело
              // как "нажал сохранить — ничего не сохранилось". Теперь и
              // валидация, и сам PIN-запрос идут ДО закрытия диалога: при
              // ошибке диалог остаётся открытым с сообщением внутри, ввод не
              // пропадает.
              onPressed: saving
                  ? null
                  : () async {
                      final name = nameCtrl.text.trim();
                      if (name.isEmpty) {
                        setSt(() => error = 'Введите имя сотрудника');
                        return;
                      }
                      final pin = pinCtrl.text.trim();
                      final requiredLength = AppConstants.pinLengthForRole(role);
                      if (pin.length != requiredLength || int.tryParse(pin) == null) {
                        setSt(() => error = role == AppConstants.roleAdmin
                            ? 'PIN администратора должен состоять ровно из $requiredLength цифр'
                            : 'PIN сотрудника должен состоять ровно из $requiredLength цифр');
                        return;
                      }
                      final hourlyRate = _parseNum(hourlyRateCtrl.text, 0);
                      final overtimeThreshold = _parseNum(overtimeThresholdCtrl.text, 8);
                      final overtimeMultiplier = _parseNum(overtimeMultiplierCtrl.text, 1.5);
                      final salesPercentRate = _parseNum(salesPercentCtrl.text, 0);
                      if (hourlyRateEnabled && hourlyRate <= 0) {
                        setSt(() => error = 'Укажите ставку больше нуля или выключите оклад');
                        return;
                      }
                      if (hourlyRateEnabled && overtimeEnabled && overtimeThreshold <= 0) {
                        setSt(() => error = 'Порог переработки должен быть больше нуля часов');
                        return;
                      }
                      if (salesPercentEnabled && salesPercentRate <= 0) {
                        setSt(() => error = 'Укажите процент больше нуля или выключите его');
                        return;
                      }
                      setSt(() {
                        saving = true;
                        error = null;
                      });
                      final taken = await fs.isPinTaken(pin, excludeId: emp?.id);
                      if (taken) {
                        setSt(() {
                          saving = false;
                          error = 'Этот PIN-код уже занят другим сотрудником';
                        });
                        return;
                      }
                      if (ctx.mounted) {
                        Navigator.pop(
                          ctx,
                          Employee(
                            id: emp?.id ?? '',
                            name: name,
                            pinCode: pin,
                            role: role,
                            position: position,
                            hourlyRateEnabled: hourlyRateEnabled,
                            hourlyRate: hourlyRate,
                            overtimeEnabled: overtimeEnabled,
                            overtimeThresholdHours: overtimeThreshold,
                            overtimeMultiplier: overtimeMultiplier,
                            salesPercentEnabled: salesPercentEnabled,
                            salesPercentRate: salesPercentRate,
                          ),
                        );
                      }
                    },
              child: saving
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Сохранить'),
            ),
          ],
        );
      }),
    );
    if (newEmp == null) return;
    try {
      if (emp == null) {
        await fs.addEmployee(newEmp);
      } else {
        await fs.updateEmployee(newEmp);
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось сохранить сотрудника: $e')));
      }
    }
  }
}
