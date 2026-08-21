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
                    Text(revealed ? e.pinCode : '••••'),
                    InkWell(
                      onTap: () => setState(() {
                        revealed ? _revealed.remove(e.id) : _revealed.add(e.id);
                      }),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: Icon(revealed ? Icons.visibility_off : Icons.visibility, size: 16),
                      ),
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

  Future<void> _editEmployee(BuildContext context, FirestoreService fs, Employee? emp) async {
    final nameCtrl = TextEditingController(text: emp?.name ?? '');
    final pinCtrl = TextEditingController(text: emp?.pinCode ?? '');
    String role = emp?.role ?? AppConstants.roleEmployee;

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSt) {
        return AlertDialog(
          title: Text(emp == null ? 'Новый сотрудник' : 'Редактировать'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: nameCtrl, decoration: const InputDecoration(labelText: 'Имя')),
              TextField(
                controller: pinCtrl,
                decoration: const InputDecoration(labelText: 'PIN-код (4 цифры)'),
                keyboardType: TextInputType.number,
                maxLength: 4,
                obscureText: true,
              ),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  ChoiceChip(
                    label: const Text('Сотрудник'),
                    selected: role == AppConstants.roleEmployee,
                    onSelected: (_) => setSt(() => role = AppConstants.roleEmployee),
                  ),
                  const SizedBox(width: 8),
                  ChoiceChip(
                    label: const Text('Администратор'),
                    selected: role == AppConstants.roleAdmin,
                    onSelected: (_) => setSt(() => role = AppConstants.roleAdmin),
                  ),
                ],
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Сохранить')),
          ],
        );
      }),
    );
    if (ok != true || nameCtrl.text.trim().isEmpty) return;
    final pin = pinCtrl.text.trim();
    if (pin.length != 4 || int.tryParse(pin) == null) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('PIN должен состоять ровно из 4 цифр')));
      }
      return;
    }

    final taken = await fs.isPinTaken(pin, excludeId: emp?.id);
    if (taken) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Этот PIN-код уже занят другим сотрудником')));
      }
      return;
    }

    final newEmp = Employee(
      id: emp?.id ?? '',
      name: nameCtrl.text.trim(),
      pinCode: pin,
      role: role,
    );
    if (emp == null) {
      await fs.addEmployee(newEmp);
    } else {
      await fs.updateEmployee(newEmp);
    }
  }
}
