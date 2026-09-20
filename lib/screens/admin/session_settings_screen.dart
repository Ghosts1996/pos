import 'package:flutter/material.dart';
import '../../services/app_scope.dart';
import '../../theme/app_colors.dart';
import '../../utils/constants.dart';

/// Настройка длительности сеанса кальяна — у каждого заведения на платформе
/// своё правило (где-то 1 час, где-то 2, где-то вообще без таймера), а
/// раньше это было общим хардкодом на 1.5 часа (AppConstants.defaultSessionMinutes)
/// одинаковым для всех. См. AppConstants.sessionMinutes/loadSessionDurationSettings.
class SessionSettingsScreen extends StatefulWidget {
  const SessionSettingsScreen({super.key});

  @override
  State<SessionSettingsScreen> createState() => _SessionSettingsScreenState();
}

class _SessionSettingsScreenState extends State<SessionSettingsScreen> {
  final _doc = AppScope.col('settings').doc('sessionDuration');
  bool _loading = true;
  bool _saving = false;
  String? _error;

  late bool _unlimited;
  late final TextEditingController _hoursCtrl;

  @override
  void initState() {
    super.initState();
    // Стартуем с того, что уже загружено в памяти (см.
    // loadSessionDurationSettings в app_bootstrap.dart) — экран сразу
    // показывает то же значение, что уже действует на кассе, а не дефолт,
    // который может быть уже переопределён. _load() ниже перечитает
    // документ явно — это только мгновенная стартовая картинка.
    _unlimited = AppConstants.sessionUnlimited;
    _hoursCtrl = TextEditingController(
      text: _unlimited ? _numStr(AppConstants.defaultSessionMinutes / 60) : _numStr(AppConstants.sessionMinutes / 60),
    );
    _load();
  }

  @override
  void dispose() {
    _hoursCtrl.dispose();
    super.dispose();
  }

  static String _numStr(double v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString();

  Future<void> _load() async {
    try {
      final snap = await _doc.get();
      final data = snap.data();
      if (data != null) {
        final unlimited = data['unlimited'] as bool? ?? false;
        final minutes = (data['minutes'] as num?)?.toInt();
        setState(() {
          _unlimited = unlimited;
          if (!unlimited && minutes != null && minutes > 0) {
            _hoursCtrl.text = _numStr(minutes / 60);
          }
        });
      }
    } catch (e) {
      _error = 'Не удалось загрузить: $e';
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    setState(() => _error = null);
    int minutes;
    if (_unlimited) {
      minutes = AppConstants.unlimitedSessionMinutes;
    } else {
      final hours = double.tryParse(_hoursCtrl.text.replaceAll(',', '.').trim());
      if (hours == null || hours <= 0) {
        setState(() => _error = 'Укажите длительность больше нуля часов');
        return;
      }
      if (hours > 24) {
        setState(() => _error = 'Больше 24 часов — включите «Без ограничений» вместо этого');
        return;
      }
      minutes = (hours * 60).round();
    }

    setState(() => _saving = true);
    try {
      await _doc.set({'unlimited': _unlimited, 'minutes': minutes});
      // Применяем сразу — без этого касса открывала бы сеансы по старой
      // длительности вплоть до перезапуска приложения.
      AppConstants.sessionMinutes = minutes;
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Сохранено')));
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'Не удалось сохранить: $e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Длительность сеанса')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                const Text(
                  'Это время ставится таймером при нажатии «Начать сеанс» и '
                  'при «Перезабивке». Сотрудник в любой момент может вручную '
                  'продлить или сократить таймер конкретного стола — эта '
                  'настройка влияет только на значение по умолчанию.',
                  style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                ),
                const SizedBox(height: 16),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Без ограничений'),
                  subtitle: const Text('Таймер не считает время — стол занят, пока его не закроют вручную'),
                  value: _unlimited,
                  onChanged: (v) => setState(() => _unlimited = v),
                ),
                if (!_unlimited) ...[
                  const SizedBox(height: 8),
                  TextField(
                    controller: _hoursCtrl,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                      labelText: 'Длительность, часов',
                      hintText: 'Например, 1.5',
                    ),
                  ),
                ],
                const SizedBox(height: 20),
                if (_error != null) ...[
                  Text(_error!, style: const TextStyle(color: AppColors.danger)),
                  const SizedBox(height: 12),
                ],
                FilledButton(
                  onPressed: _saving ? null : _save,
                  child: _saving
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Сохранить'),
                ),
              ],
            ),
    );
  }
}
