import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../services/app_scope.dart';
import '../../theme/app_colors.dart';

/// Настройка порогов и процента кешбека программы лояльности гостя —
/// те же 5 уровней (Бронза/Серебро/Золото/Платина/Алмаз), что показаны
/// гостю в профиле (см. ClientProfile.tiers) и по которым касса начисляет
/// бонусы при закрытии чека (см. GuestLinkService.accrueBonuses).
///
/// Названия уровней зафиксированы: на них завязана раскраска в других
/// местах (KolibriColors.tierColor, GuestsScreen._tierColor — оба
/// переключаются по названию уровня). Редактируются только порог по сумме
/// визитов и сам процент кешбека.
class LoyaltySettingsScreen extends StatefulWidget {
  const LoyaltySettingsScreen({super.key});

  @override
  State<LoyaltySettingsScreen> createState() => _LoyaltySettingsScreenState();
}

class _LoyaltySettingsScreenState extends State<LoyaltySettingsScreen> {
  final _doc = AppScope.col('settings').doc('loyalty');
  bool _loading = true;
  bool _saving = false;
  String? _error;

  late final List<({String name, TextEditingController from, TextEditingController cashback})>
      _rows;

  @override
  void initState() {
    super.initState();
    // Стартуем с того, что уже загружено в памяти (см. loadLoyaltyTierSettings
    // в app_bootstrap.dart) — на экране сразу видно то же самое, что кассир
    // видит в профиле гостя, а не дефолт, который сейчас может быть уже
    // переопределён. _load() ниже всё равно перечитает документ явно —
    // это просто мгновенная стартовая картинка, не финальная.
    _rows = ClientProfile.tiers
        .map((t) => (
              name: t.name,
              from: TextEditingController(text: _numStr(t.from)),
              cashback: TextEditingController(text: _numStr(t.cashback)),
            ))
        .toList();
    _load();
  }

  @override
  void dispose() {
    for (final r in _rows) {
      r.from.dispose();
      r.cashback.dispose();
    }
    super.dispose();
  }

  static String _numStr(double v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString();

  Future<void> _load() async {
    try {
      final snap = await _doc.get();
      final raw = snap.data()?['tiers'];
      if (raw is List) {
        for (final item in raw) {
          if (item is! Map) continue;
          final name = item['name'] as String?;
          final rowIndex = _rows.indexWhere((r) => r.name == name);
          if (rowIndex == -1) continue;
          final row = _rows[rowIndex];
          row.from.text = _numStr((item['from'] as num?)?.toDouble() ?? 0);
          row.cashback.text = _numStr((item['cashback'] as num?)?.toDouble() ?? 0);
        }
      }
    } catch (e) {
      _error = 'Не удалось загрузить: $e';
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    setState(() => _error = null);
    final parsed = <({String name, double from, double cashback})>[];
    for (final r in _rows) {
      final from = double.tryParse(r.from.text.replaceAll(',', '.').trim());
      if (from == null || from < 0) {
        setState(() => _error = 'Порог уровня «${r.name}» должен быть числом от 0');
        return;
      }
      final cashback = double.tryParse(r.cashback.text.replaceAll(',', '.').trim());
      if (cashback == null || cashback < 0 || cashback > 100) {
        setState(() => _error = 'Кешбек уровня «${r.name}» должен быть от 0 до 100%');
        return;
      }
      parsed.add((name: r.name, from: from, cashback: cashback));
    }
    // Пороги растут от уровня к уровню — иначе прогресс-бар в профиле
    // гостя и подсказка "сколько осталось до следующего уровня" считались
    // бы неправильно (см. ClientProfile.tierProgress/toNextTier).
    for (var i = 1; i < parsed.length; i++) {
      if (parsed[i].from <= parsed[i - 1].from) {
        setState(() => _error =
            'Порог уровня «${parsed[i].name}» должен быть больше порога «${parsed[i - 1].name}»');
        return;
      }
    }

    setState(() => _saving = true);
    try {
      final tiersMap = parsed
          .map((t) => {'name': t.name, 'from': t.from, 'cashback': t.cashback})
          .toList();
      await _doc.set({'tiers': tiersMap});
      // Применяем сразу — без этого касса начислила бы бонус по старым
      // цифрам вплоть до перезапуска приложения.
      ClientProfile.applyTiers(tiersMap);
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
      appBar: AppBar(title: const Text('Программа лояльности')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                const Text(
                  'Уровень гостя считается по сумме ВСЕХ его закрытых чеков за всё '
                  'время. Процент кешбека начисляется бонусами при оплате — '
                  '1 бонус = 1 ₽.',
                  style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                ),
                const SizedBox(height: 16),
                for (final r in _rows) ...[
                  Text(r.name, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: r.from,
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          decoration: const InputDecoration(labelText: 'От, ₽'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: TextField(
                          controller: r.cashback,
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          decoration: const InputDecoration(labelText: 'Кешбек, %'),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),
                ],
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
