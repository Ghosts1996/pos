import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';

import '../services/staff_device_service.dart';
import '../theme/app_colors.dart';

/// Регистрация планшета как рабочего устройства заведения.
///
/// Зачем этот экран нужен. POS и гостевое приложение «Колибри Лаундж» живут
/// в одном проекте Firebase и оба входят анонимно — по самому факту входа
/// отличить кассу от телефона гостя нельзя. Поэтому правила безопасности
/// (firestore.rules) считают «персоналом» только те устройства, у которых
/// есть документ `staffDevices/{uid}`, а создать его можно, лишь назвав
/// секрет заведения из `meta/staffSecret`.
///
/// Без этого шага касса не может прочитать даже список сотрудников, и вход
/// по PIN падает с permission-denied — который на экране входа выглядел как
/// «Нет связи с сервером» и уводил в поиск несуществующих проблем с
/// интернетом.
class StaffDeviceSetupScreen extends StatefulWidget {
  /// Вызывается после успешной регистрации.
  final VoidCallback onRegistered;

  const StaffDeviceSetupScreen({super.key, required this.onRegistered});

  @override
  State<StaffDeviceSetupScreen> createState() => _StaffDeviceSetupScreenState();
}

class _StaffDeviceSetupScreenState extends State<StaffDeviceSetupScreen> {
  final _service = StaffDeviceService();
  final _secret = TextEditingController();
  final _label = TextEditingController();

  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _secret.dispose();
    _label.dispose();
    super.dispose();
  }

  Future<void> _register() async {
    final secret = _secret.text.trim();
    if (secret.isEmpty) {
      setState(() => _error = 'Введите ключ заведения');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _service.register(secret: secret, deviceLabel: _label.text.trim());
      if (mounted) widget.onRegistered();
    } on FirebaseException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        // permission-denied прилетает и когда ключ неверный, и когда
        // документ meta/staffSecret вообще не создан — со стороны клиента
        // это неразличимо, поэтому подсказываем оба варианта.
        _error = e.code == 'permission-denied'
            ? 'Ключ не подошёл. Проверьте его в Firebase → Firestore → '
                'meta/staffSecret, поле value. Если такого документа нет — '
                'создайте его, иначе зарегистрировать устройство нельзя.'
            : 'Не удалось зарегистрировать: ${e.message ?? e.code}';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Не удалось зарегистрировать: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF1B1B1F),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(Icons.tablet_android, color: Colors.white70, size: 48),
                  const SizedBox(height: 12),
                  const Text(
                    'Рабочее устройство',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                        color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'Этот планшет ещё не отмечен как касса заведения, поэтому база '
                    'не отдаёт ему рабочие данные. Введите ключ заведения — он '
                    'вводится один раз на устройство.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.textMuted, fontSize: 14),
                  ),
                  const SizedBox(height: 24),
                  TextField(
                    controller: _secret,
                    autofocus: true,
                    obscureText: true,
                    style: const TextStyle(color: Colors.white),
                    decoration: const InputDecoration(
                      labelText: 'Ключ заведения',
                      helperText: 'Firebase → Firestore → meta/staffSecret → value',
                      helperMaxLines: 2,
                    ),
                    onSubmitted: (_) => _busy ? null : _register(),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _label,
                    style: const TextStyle(color: Colors.white),
                    decoration: const InputDecoration(
                      labelText: 'Название устройства (необязательно)',
                      hintText: 'Планшет у бара',
                    ),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    Text(_error!,
                        style: const TextStyle(color: AppColors.danger, fontSize: 13)),
                  ],
                  const SizedBox(height: 24),
                  SizedBox(
                    height: 50,
                    child: FilledButton(
                      onPressed: _busy ? null : _register,
                      child: _busy
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2))
                          : const Text('Зарегистрировать планшет'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
