import 'dart:io';

import 'package:flutter/material.dart';

import '../../services/scales/scale.dart';
import '../../theme/app_colors.dart';
import '../../utils/weighed.dart';

/// Весы этого устройства (SaaS): «Масса-К» по сети (протокол 100) или весы
/// на COM-порту кассы с Windows (шлют вес строкой). Настройка хранится на
/// устройстве — у каждой кассы свои весы.
class ScaleSettingsScreen extends StatefulWidget {
  const ScaleSettingsScreen({super.key});

  @override
  State<ScaleSettingsScreen> createState() => _ScaleSettingsScreenState();
}

class _ScaleSettingsScreenState extends State<ScaleSettingsScreen> {
  bool _loading = true;
  String _type = '';
  String _request = '';
  int _baud = 9600;
  final _host = TextEditingController();
  final _port = TextEditingController(text: '5001');
  final _com = TextEditingController(text: 'COM3');
  String? _result;
  bool _testing = false;

  @override
  void initState() {
    super.initState();
    ScalePrefs.load().then((_) {
      if (!mounted) return;
      setState(() {
        _type = ScalePrefs.type;
        _request = ScalePrefs.request;
        _baud = ScalePrefs.baud;
        _host.text = ScalePrefs.host;
        _port.text = '${ScalePrefs.port}';
        _com.text = ScalePrefs.com;
        _loading = false;
      });
    });
  }

  @override
  void dispose() {
    _host.dispose();
    _port.dispose();
    _com.dispose();
    super.dispose();
  }

  void _apply() {
    ScalePrefs.type = _type;
    ScalePrefs.host = _host.text.trim();
    ScalePrefs.port = int.tryParse(_port.text.trim()) ?? 5001;
    ScalePrefs.com = _com.text.trim().toUpperCase();
    ScalePrefs.baud = _baud;
    ScalePrefs.request = _request;
  }

  Future<void> _test() async {
    _apply();
    setState(() {
      _testing = true;
      _result = null;
    });
    String text;
    try {
      final r = await readScale();
      text = 'Весы ответили: ${weightLabel(r.kg < 0 ? 0 : r.kg)}${r.stable ? ', вес стабильный' : ', груз качается'}';
    } catch (e) {
      text = e is StateError ? e.message : '$e';
    }
    if (mounted) {
      setState(() {
        _testing = false;
        _result = text;
      });
    }
  }

  Future<void> _save() async {
    _apply();
    await ScalePrefs.save();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Сохранено на этом устройстве')));
    Navigator.pop(context);
  }

  Widget _label(String t) => Padding(
        padding: const EdgeInsets.only(top: 16, bottom: 6),
        child: Text(t, style: TextStyle(color: AppColors.textMuted, fontSize: 13, fontWeight: FontWeight.w600)),
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Весы')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
              children: [
                Text(
                  'Для товара «на вес» (в меню — переключатель «Продаётся на вес»). Касса покажет вес с весов, '
                  'кассир нажмёт «Добавить». Без весов вес вводят вручную. Настройка — только для этого устройства.',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 13.5, height: 1.4),
                ),
                _label('Какие весы'),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  ChoiceChip(label: const Text('Нет — вручную'), selected: _type == '', onSelected: (_) => setState(() => _type = '')),
                  ChoiceChip(label: const Text('«Масса-К» по сети'), selected: _type == 'massak', onSelected: (_) => setState(() => _type = 'massak')),
                  if (Platform.isWindows)
                    ChoiceChip(label: const Text('COM-порт (Windows)'), selected: _type == 'com', onSelected: (_) => setState(() => _type = 'com')),
                ]),
                if (_type == 'massak') ...[
                  TextField(
                    controller: _host,
                    keyboardType: TextInputType.url,
                    decoration: const InputDecoration(labelText: 'IP-адрес весов', hintText: '192.168.1.60'),
                  ),
                  TextField(
                    controller: _port,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Порт', helperText: 'Обычно 5001 (протокол 100)'),
                  ),
                ],
                if (_type == 'com') ...[
                  TextField(
                    controller: _com,
                    decoration: const InputDecoration(labelText: 'Порт', hintText: 'COM3', helperText: 'Диспетчер устройств → «Порты (COM и LPT)»'),
                  ),
                  _label('Скорость'),
                  Wrap(spacing: 8, runSpacing: 8, children: [
                    for (final b in const [2400, 4800, 9600, 19200])
                      ChoiceChip(label: Text('$b'), selected: _baud == b, onSelected: (_) => setState(() => _baud = b)),
                  ]),
                  _label('Как весы отдают вес'),
                  Wrap(spacing: 8, runSpacing: 8, children: [
                    ChoiceChip(label: const Text('Сами, постоянно'), selected: _request == '', onSelected: (_) => setState(() => _request = '')),
                    ChoiceChip(label: const Text('По запросу ENQ'), selected: _request == 'enq', onSelected: (_) => setState(() => _request = 'enq')),
                    ChoiceChip(label: const Text('По запросу «W»'), selected: _request == 'w', onSelected: (_) => setState(() => _request = 'w')),
                  ]),
                ],
                if (_type.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  OutlinedButton.icon(
                    onPressed: _testing ? null : _test,
                    icon: const Icon(Icons.scale_outlined),
                    label: Text(_testing ? 'Спрашиваю весы…' : 'Проверить — положите груз'),
                  ),
                ],
                if (_result != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_result!)),
                const SizedBox(height: 20),
                FilledButton(onPressed: _save, child: const Text('Сохранить')),
              ],
            ),
    );
  }
}
