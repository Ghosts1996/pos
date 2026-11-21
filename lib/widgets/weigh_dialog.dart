import 'dart:async';

import 'package:flutter/material.dart';

import '../services/scales/scale.dart';
import '../theme/app_colors.dart';
import '../utils/money.dart';
import '../utils/weighed.dart';

/// Окно «Взвесить» для весового товара: вес с весов (если подключены —
/// обновляется сам) или вручную. Возвращает вес в кг.
Future<double?> showWeighDialog(BuildContext context, {required String name, required double perKg}) async {
  await ScalePrefs.load();
  if (!context.mounted) return null;
  return showDialog<double>(context: context, builder: (_) => WeighDialog(name: name, perKg: perKg));
}

class WeighDialog extends StatefulWidget {
  final String name;
  final double perKg;
  final Future<ScaleReading> Function()? reader;

  const WeighDialog({super.key, required this.name, required this.perKg, this.reader});

  @override
  State<WeighDialog> createState() => _WeighDialogState();
}

class _WeighDialogState extends State<WeighDialog> {
  final _ctrl = TextEditingController();
  Timer? _timer;
  ScaleReading? _reading;
  String? _scaleError;
  bool _busy = false;
  bool _manual = false;

  bool get _hasScale => widget.reader != null || ScalePrefs.configured;

  @override
  void initState() {
    super.initState();
    _ctrl.addListener(() => setState(() => _manual = _ctrl.text.trim().isNotEmpty));
    if (_hasScale) {
      _poll();
      _timer = Timer.periodic(const Duration(milliseconds: 700), (_) => _poll());
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _poll() async {
    if (_busy || _manual) return;
    _busy = true;
    try {
      final r = await (widget.reader ?? readScale)();
      if (mounted) {
        setState(() {
          _reading = r;
          _scaleError = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _scaleError = e is StateError ? e.message : '$e');
    } finally {
      _busy = false;
    }
  }

  double? get _kg {
    if (_manual) return parseWeightInput(_ctrl.text);
    final r = _reading;
    if (r == null || !r.stable || r.kg < 0.001 || r.kg > 100) return null;
    return (r.kg * 1000).roundToDouble() / 1000;
  }

  @override
  Widget build(BuildContext context) {
    final kg = _kg;
    final r = _reading;
    return AlertDialog(
      title: Text(widget.name),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${rub(widget.perKg)} за 1 кг', style: TextStyle(color: AppColors.textMuted)),
          const SizedBox(height: 14),
          if (_hasScale && !_manual) ...[
            Center(
              child: Text(
                r == null ? '—' : weightLabel(r.kg < 0 ? 0 : r.kg),
                style: const TextStyle(fontSize: 34, fontWeight: FontWeight.w800, fontFeatures: [FontFeature.tabularFigures()]),
              ),
            ),
            Center(
              child: Text(
                _scaleError ?? (r == null ? 'Жду весы…' : (r.stable ? 'Вес стабильный' : 'Груз качается — подождите')),
                style: TextStyle(
                  color: _scaleError != null ? AppColors.danger : (r?.stable == true ? AppColors.success : AppColors.textMuted),
                  fontSize: 13,
                ),
                textAlign: TextAlign.center,
              ),
            ),
            const SizedBox(height: 14),
          ],
          TextField(
            controller: _ctrl,
            autofocus: !_hasScale,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(
              labelText: _hasScale ? 'Или вес вручную' : 'Вес',
              hintText: '350 — граммы, 0,35 — кг',
              errorText: _manual && kg == null ? 'От 1 г до 100 кг' : null,
            ),
          ),
          const SizedBox(height: 14),
          Text(
            kg == null ? 'Сумма: —' : 'Сумма: ${rub(weighedPrice(widget.perKg, kg))}',
            style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
        FilledButton(
          onPressed: kg == null ? null : () => Navigator.pop(context, kg),
          child: Text(kg == null ? 'Добавить' : 'Добавить ${weightLabel(kg)}'),
        ),
      ],
    );
  }
}
