import 'package:flutter/material.dart';
import '../../services/app_scope.dart';
import '../../theme/app_colors.dart';
import '../../utils/adaptive.dart';
import '../../utils/human_error.dart';
import '../../utils/time_cafe.dart';

/// Админ → «Тайм-кафе»: оплата за время за столом (документ
/// settings/timeCafe, см. [TimeCafe]). Таймер стола — отдельно, в
/// «Длительности сеанса».
class TimeCafeSettingsScreen extends StatefulWidget {
  const TimeCafeSettingsScreen({super.key});

  @override
  State<TimeCafeSettingsScreen> createState() => _TimeCafeSettingsScreenState();
}

class _TimeCafeSettingsScreenState extends State<TimeCafeSettingsScreen> {
  final _doc = AppScope.col('settings').doc('timeCafe');
  bool _loading = true;
  bool _saving = false;
  String? _error;

  // С того, что уже действует на кассе, до чтения документа.
  bool _enabled = TimeCafe.enabled;
  int _round = TimeCafe.roundMinutes;
  int _min = TimeCafe.minMinutes;
  late final _price = TextEditingController(text: _str(TimeCafe.pricePerHour));
  late final _first = TextEditingController(text: _str(TimeCafe.firstHourPrice));
  late final _stop = TextEditingController(text: _str(TimeCafe.stopCheck));

  static String _str(double v) => v <= 0 ? '' : (v == v.roundToDouble() ? v.toInt().toString() : v.toString().replaceAll('.', ','));
  static double _val(TextEditingController c) =>
      double.tryParse(c.text.replaceAll(',', '.').replaceAll(' ', '').trim()) ?? 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _price.dispose();
    _first.dispose();
    _stop.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final data = (await _doc.get()).data();
      if (data != null && mounted) {
        TimeCafe.apply(data);
        setState(() {
          _enabled = TimeCafe.enabled;
          _round = TimeCafe.roundMinutes;
          _min = TimeCafe.minMinutes;
          _price.text = _str(TimeCafe.pricePerHour);
          _first.text = _str(TimeCafe.firstHourPrice);
          _stop.text = _str(TimeCafe.stopCheck);
        });
      }
    } catch (e) {
      _error = 'Не удалось загрузить: ${humanError(e, lower: true)}';
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Что не так с тарифом — пустая строка, если всё в порядке.
  String _check(double price, double first, double stop) {
    if (_enabled && price <= 0) return 'Укажите цену часа за гостя';
    if (price > 100000 || first > 100000) return 'Цена часа больше 100 000 ₽ — проверьте сумму';
    if (stop > 0 && stop < TimeCafe.costPerGuest(Duration.zero, price: price, first: first, round: _round, min: _min)) {
      return 'Стоп-чек меньше минимальной оплаты — тогда гость всегда платит стоп-чек. Увеличьте его или уберите';
    }
    return '';
  }

  Future<void> _save() async {
    final price = _val(_price), first = _val(_first), stop = _val(_stop);
    final problem = _check(price, first, stop);
    setState(() => _error = problem.isEmpty ? null : problem);
    if (problem.isNotEmpty) return;
    final data = TimeCafe.toMap(
      enabled: _enabled, pricePerHour: price, firstHourPrice: first, minMinutes: _min, roundMinutes: _round, stopCheck: stop);
    setState(() => _saving = true);
    try {
      await _doc.set(data);
      // Сразу и на этой кассе; остальные получат через слежение (TimeCafe.watch).
      TimeCafe.apply(data);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Сохранено')));
    } catch (e) {
      if (mounted) setState(() => _error = 'Не удалось сохранить: ${humanError(e, lower: true)}');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Widget _chips<T>(List<T> values, T selected, String Function(T) label, void Function(T) pick) => Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final v in values)
            ChoiceChip(label: Text(label(v)), selected: v == selected, onSelected: (_) => setState(() => pick(v))),
        ],
      );

  Widget _caption(String t) => Padding(
        padding: const EdgeInsets.only(top: 14, bottom: 6),
        child: Text(t, style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
      );

  @override
  Widget build(BuildContext context) {
    final price = _val(_price), first = _val(_first), stop = _val(_stop);
    String cost(int m) => TimeCafe.costPerGuest(Duration(minutes: m), price: price, first: first, round: _round, min: _min, stop: stop)
        .toStringAsFixed(0);
    return Scaffold(
      appBar: AppBar(title: const Text('Тайм-кафе')),
      body: CenteredBody(
        maxWidth: Breakpoints.form,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  Text(
                    'Гость платит за время за столом. На экране стола видно, сколько уже набежало, '
                    'кнопка «Тайм-кафе» добавляет время в счёт за нужное число гостей, а при '
                    '«Закрыть стол» время пересчитывается на момент оплаты. Таймер стола настраивается '
                    'отдельно — в «Длительности сеанса».',
                    style: TextStyle(fontSize: 13, color: AppColors.textMuted),
                  ),
                  const SizedBox(height: 8),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Включить тайм-кафе', style: TextStyle(fontWeight: FontWeight.w700)),
                    value: _enabled,
                    onChanged: (v) => setState(() => _enabled = v),
                  ),
                  if (_enabled) ...[
                    const SizedBox(height: 4),
                    TextField(
                      controller: _price,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (_) => setState(() {}),
                      decoration: const InputDecoration(labelText: 'Цена часа за гостя, ₽', hintText: 'Например, 300'),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _first,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (_) => setState(() {}),
                      decoration: const InputDecoration(
                        labelText: 'Цена первого часа, ₽ (необязательно)',
                        hintText: 'Пусто — как остальные часы',
                      ),
                    ),
                    _caption('Округлять время вверх до'),
                    _chips<int>(TimeCafe.roundChoices, _round, (r) => r == 1 ? 'минуты' : r == 60 ? 'часа' : '$r мин',
                        (v) => _round = v),
                    _caption('Минимальная оплата'),
                    _chips<int>(TimeCafe.minChoices, _min, (m) => m == 0 ? 'нет' : TimeCafe.durationLabel(m), (v) => _min = v),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _stop,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (_) => setState(() {}),
                      decoration: const InputDecoration(
                        labelText: 'Стоп-чек за гостя, ₽ (необязательно)',
                        hintText: 'Больше этой суммы за визит не берём',
                      ),
                    ),
                    if (price > 0) ...[
                      const SizedBox(height: 14),
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: AppColors.surface,
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: AppColors.border),
                        ),
                        child: Text(
                          'Сколько заплатит один гость:\n'
                          '20 мин — ${cost(20)} ₽ · 1 ч — ${cost(60)} ₽ · 1 ч 30 мин — ${cost(90)} ₽ · 3 ч — ${cost(180)} ₽',
                          style: const TextStyle(fontSize: 14, height: 1.4),
                        ),
                      ),
                    ],
                  ],
                  const SizedBox(height: 20),
                  if (_error != null) ...[
                    Text(_error!, style: TextStyle(color: AppColors.danger)),
                    const SizedBox(height: 12),
                  ],
                  FilledButton(
                    onPressed: _saving ? null : _save,
                    child: _saving
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Сохранить'),
                  ),
                ],
              ),
      ),
    );
  }
}
