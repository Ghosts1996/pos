import 'package:flutter/material.dart';
import '../../services/app_scope.dart';
import '../../theme/app_colors.dart';
import '../../utils/adaptive.dart';
import '../../utils/human_error.dart';
import '../../utils/service_charge.dart';

/// Админ → «Обслуживание»: процент за обслуживание в счёте зала (только
/// SaaS, документ settings/serviceCharge, см. [ServiceCharge]).
class ServiceChargeSettingsScreen extends StatefulWidget {
  const ServiceChargeSettingsScreen({super.key});

  @override
  State<ServiceChargeSettingsScreen> createState() => _ServiceChargeSettingsScreenState();
}

class _ServiceChargeSettingsScreenState extends State<ServiceChargeSettingsScreen> {
  final _doc = AppScope.col('settings').doc('serviceCharge');
  bool _loading = true;
  bool _saving = false;
  String? _error;

  bool _enabled = ServiceCharge.enabled;
  int _minGuests = ServiceCharge.minGuests;
  late final _percent = TextEditingController(text: _str(ServiceCharge.percent));
  late final _title = TextEditingController(text: ServiceCharge.title);

  static const _guestChoices = [0, 2, 4, 6, 8, 10];
  static const _quick = [5.0, 7.0, 10.0, 12.0, 15.0];

  static String _str(double v) =>
      v <= 0 ? '' : (v == v.roundToDouble() ? v.toInt().toString() : v.toStringAsFixed(1).replaceAll('.', ','));

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _percent.dispose();
    _title.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final data = (await _doc.get()).data();
      if (data != null && mounted) {
        ServiceCharge.apply(data);
        setState(() {
          _enabled = ServiceCharge.enabled;
          _minGuests = ServiceCharge.minGuests;
          _percent.text = _str(ServiceCharge.percent);
          _title.text = ServiceCharge.title;
        });
      }
    } catch (e) {
      _error = 'Не удалось загрузить: ${humanError(e, lower: true)}';
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    final pct = ServiceCharge.cleanPercent(_percent.text);
    if (_enabled && pct <= 0) {
      setState(() => _error = 'Укажите процент от 0,5 до ${ServiceCharge.maxPercent.toStringAsFixed(0)}');
      return;
    }
    final title = _title.text.replaceAll(RegExp(r'\s+'), ' ').trim();
    final data = ServiceCharge.toMap(
      enabled: _enabled,
      percent: pct,
      minGuests: _minGuests,
      title: title.isEmpty ? 'Обслуживание' : title,
    );
    setState(() {
      _error = null;
      _saving = true;
    });
    try {
      await _doc.set(data);
      // Сразу и на этой кассе; остальные получат через слежение.
      ServiceCharge.apply(data);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Сохранено')));
    } catch (e) {
      if (mounted) setState(() => _error = 'Не удалось сохранить: ${humanError(e, lower: true)}');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Widget _caption(String t) => Padding(
        padding: const EdgeInsets.only(top: 16, bottom: 6),
        child: Text(t, style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
      );

  @override
  Widget build(BuildContext context) {
    final pct = ServiceCharge.cleanPercent(_percent.text);
    final title = _title.text.trim().isEmpty ? 'Обслуживание' : _title.text.trim();
    String ex(double sum) => ServiceCharge.amountOf(sum, pct).toStringAsFixed(0);
    return Scaffold(
      appBar: AppBar(title: const Text('Обслуживание')),
      body: CenteredBody(
        maxWidth: Breakpoints.form,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  Text(
                    'Процент за обслуживание добавляется отдельной строкой в счёт зала и пересчитывается сам, '
                    'когда меняется заказ или скидка. На заказы с собой и доставку не начисляется. '
                    'В фискальном чеке — услуга, скидки и бонусы на неё не действуют.',
                    style: TextStyle(fontSize: 13, color: AppColors.textMuted),
                  ),
                  const SizedBox(height: 8),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title:
                        const Text('Начислять процент за обслуживание', style: TextStyle(fontWeight: FontWeight.w700)),
                    value: _enabled,
                    onChanged: (v) => setState(() => _enabled = v),
                  ),
                  if (_enabled) ...[
                    const SizedBox(height: 4),
                    TextField(
                      controller: _percent,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (_) => setState(() {}),
                      decoration:
                          const InputDecoration(labelText: 'Процент', hintText: 'Например, 10', suffixText: '%'),
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final q in _quick)
                          ChoiceChip(
                            label: Text(ServiceCharge.percentLabel(q)),
                            selected: pct == q,
                            onSelected: (_) => setState(() => _percent.text = _str(q)),
                          ),
                      ],
                    ),
                    _caption('Начислять, когда за столом гостей'),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final g in _guestChoices)
                          ChoiceChip(
                            label: Text(g == 0 ? 'всегда' : 'от $g'),
                            selected: _minGuests == g,
                            onSelected: (_) => setState(() => _minGuests = g),
                          ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    TextField(
                      controller: _title,
                      maxLength: 30,
                      onChanged: (_) => setState(() {}),
                      decoration:
                          const InputDecoration(labelText: 'Как назвать строку в счёте', hintText: 'Обслуживание'),
                    ),
                    if (pct > 0) ...[
                      const SizedBox(height: 6),
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: AppColors.surface,
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: AppColors.border),
                        ),
                        child: Text(
                          'В счёте: «$title ${ServiceCharge.percentLabel(pct)}»\n'
                          'Счёт 1 000 ₽ → +${ex(1000)} ₽ · 3 500 ₽ → +${ex(3500)} ₽ · 8 000 ₽ → +${ex(8000)} ₽',
                          style: const TextStyle(fontSize: 14, height: 1.4),
                        ),
                      ),
                    ],
                    const SizedBox(height: 14),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: AppColors.warning.withValues(alpha: 0.10),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppColors.warning.withValues(alpha: 0.45)),
                      ),
                      child: const Text(
                        'По закону гость должен знать о проценте заранее и может от него отказаться. '
                        'Укажите его в меню и на входе. Гость видит процент в меню и в счёте приложения. '
                        'Если гость отказался, нажмите на строку в счёте стола и выберите «Гость отказался».',
                        style: TextStyle(fontSize: 13, height: 1.4),
                      ),
                    ),
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
