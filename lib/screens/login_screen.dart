import 'dart:async';
import 'package:flutter/material.dart';
import '../models/employee.dart';
import '../services/firestore_service.dart';
import '../utils/constants.dart';
import 'admin/admin_home_screen.dart';
import 'employee/floor_plan_screen.dart';

/// Вход по 4-значному PIN-коду сотрудника. Роль (админ/сотрудник) определяется
/// автоматически по коду — отдельного экрана выбора роли не требуется.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _fs = FirestoreService();
  String _pin = '';
  bool _loading = false;
  String? _error;

  Future<void> _submit() async {
    if (_pin.length < 4 || _loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    Employee? employee;
    try {
      employee = await _fs.findByPin(_pin);
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Нет связи с сервером. Проверьте интернет и попробуйте снова';
        _pin = '';
      });
      return;
    }
    if (!mounted) return;
    setState(() => _loading = false);
    if (employee == null) {
      setState(() {
        _error = 'Неверный PIN-код';
        _pin = '';
      });
      return;
    }
    final loggedInEmployee = employee;
    // Открываем кассовую смену при входе, если сейчас нет открытой — это
    // источник данных для X-отчёта. Делаем в фоне и не блокируем вход даже
    // при сетевой ошибке: сотрудник всё равно должен попасть в приложение,
    // а открыть смену можно будет вручную из X-отчёта.
    unawaited(_fs.openShiftIfNeeded(loggedInEmployee.name));
    if (loggedInEmployee.role == AppConstants.roleAdmin) {
      Navigator.of(context).pushReplacement(
          MaterialPageRoute(builder: (_) => AdminHomeScreen(employee: loggedInEmployee)));
    } else {
      Navigator.of(context).pushReplacement(
          MaterialPageRoute(builder: (_) => FloorPlanScreen(employee: loggedInEmployee)));
    }
  }

  void _tap(String digit) {
    if (_pin.length >= 4) return;
    setState(() => _pin += digit);
    if (_pin.length == 4) _submit();
  }

  void _backspace() {
    if (_pin.isEmpty) return;
    setState(() => _pin = _pin.substring(0, _pin.length - 1));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF1B1B1F),
      body: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.smoking_rooms, color: Colors.white70, size: 56),
              const SizedBox(height: 12),
              const Text('Hookah POS',
                  style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold)),
              const SizedBox(height: 24),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(4, (i) {
                  final filled = i < _pin.length;
                  return Container(
                    margin: const EdgeInsets.all(6),
                    width: 16,
                    height: 16,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: filled ? Colors.purpleAccent : Colors.white24,
                    ),
                  );
                }),
              ),
              if (_error != null) ...[
                const SizedBox(height: 8),
                Text(_error!, style: const TextStyle(color: Colors.redAccent)),
              ],
              const SizedBox(height: 24),
              if (_loading) const CircularProgressIndicator(),
              if (!_loading) _buildKeypad(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildKeypad() {
    final keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    return SizedBox(
      width: 260,
      child: GridView.count(
        crossAxisCount: 3,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        children: keys.map((k) {
          if (k.isEmpty) return const SizedBox.shrink();
          return Padding(
            padding: const EdgeInsets.all(4),
            child: Material(
              color: Colors.white10,
              shape: const CircleBorder(),
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: () => k == '⌫' ? _backspace() : _tap(k),
                child: Center(
                  child: Text(k, style: const TextStyle(color: Colors.white, fontSize: 20)),
                ),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}