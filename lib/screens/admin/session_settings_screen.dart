import 'package:flutter/material.dart';
import '../../services/app_scope.dart';
import '../../theme/app_colors.dart';
import '../../utils/constants.dart';
import '../../utils/human_error.dart';
import '../../utils/adaptive.dart';
import '../../utils/time_cafe.dart';

/// «Тайм-кафе»: оплата за время за столом (цена часа, округление,
/// стоп-чек) и таймер стола — длительность сеанса по умолчанию (час, два,
/// без таймера). См. TimeCafe и AppConstants.sessionMinutes /
/// loadSessionDurationSettings.
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

  // Тайм-кафе — с того, что уже действует на кассе (TimeCafe), до чтения документа.
  bool _cafe = TimeCafe.enabled;
  int _round = TimeCafe.roundMinutes;
  late final TextEditingController _priceCtrl =
      TextEditingController(text: TimeCafe.pricePerHour > 0 ? _numStr(TimeCafe.pricePerHour) : '');
  late final TextEditingController _stopCtrl =
      TextEditingController(text: TimeCafe.stopCheck > 0 ? _numStr(TimeCafe.stopCheck) : '');

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
    _priceCtrl.dispose();
    _stopCtrl.dispose();
    super.dispose();
  }

  static String _numStr(double v) =>
      v == v.roundToDouble() ? v.toInt().toString() : v.toString().replaceAll('.', ',');

  int? get _currentMinutes {
    final h = double.tryParse(_hoursCtrl.text.replaceAll(',', '.').trim());
    return h == null ? null : (h * 60).round();
  }

  Future<void> _load() async {
    try {
      final snap = await _doc.get();
      final data = snap.data();
      if (data != null && mounted) {
        final unlimited = data['unlimited'] as bool? ?? false;
        final minutes = (data['minutes'] as num?)?.toInt();
        TimeCafe.apply(data['timeCafe']);
        setState(() {
          _cafe = TimeCafe.enabled;
          _round = TimeCafe.roundMinutes;
          _priceCtrl.text = TimeCafe.pricePerHour > 0 ? _numStr(TimeCafe.pricePerHour) : '';
          _stopCtrl.text = TimeCafe.stopCheck > 0 ? _numStr(TimeCafe.stopCheck) : '';
          _unlimited = unlimited;
          if (!unlimited && minutes != null && minutes > 0) {
            _hoursCtrl.text = _numStr(minutes / 60);
          }
        });
      }
    } catch (e) {
      _error = 'Не удалось загрузить: ${humanError(e, lower: true)}';
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

    double money(TextEditingController c) => double.tryParse(c.text.replaceAll(',', '.').replaceAll(' ', '').trim()) ?? 0;
    final price = money(_priceCtrl);
    final stop = money(_stopCtrl);
    if (_cafe && price <= 0) {
      setState(() => _error = 'Укажите цену часа для тайм-кафе');
      return;
    }
    if (stop < 0 || (stop > 0 && stop < price * _round / 60)) {
      setState(() => _error = 'Стоп-чек меньше цены минимального шага — проверьте сумму');
      return;
    }
    final cafe = TimeCafe.toMap(enabled: _cafe, pricePerHour: price, roundMinutes: _round, stopCheck: stop);

    setState(() => _saving = true);
    try {
      await _doc.set({'unlimited': _unlimited, 'minutes': minutes, 'timeCafe': cafe});
      TimeCafe.apply(cafe);
      // Применяем сразу — без этого касса открывала бы сеансы по старой
      // длительности вплоть до перезапуска приложения.
      AppConstants.sessionMinutes = minutes;
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Сохранено')));
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'Не удалось сохранить: ${humanError(e, lower: true)}');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Тайм-кафе')),
      body: CenteredBody(
        maxWidth: Breakpoints.form,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Тайм-кафе: оплата за время', style: TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: const Text('Гость платит за время за столом. На экране стола видно, сколько '
                        'уже набежало, а кнопка «Время в счёт» добавляет строку со временем — '
                        'за каждого гостя.'),
                    value: _cafe,
                    onChanged: (v) => setState(() => _cafe = v),
                  ),
                  if (_cafe) ...[
                    const SizedBox(height: 8),
                    TextField(
                      controller: _priceCtrl,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (_) => setState(() {}),
                      decoration: const InputDecoration(labelText: 'Цена часа за гостя, ₽', hintText: 'Например, 300'),
                    ),
                    const SizedBox(height: 12),
                    Text('Округлять время вверх до', style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final r in TimeCafe.roundChoices)
                          ChoiceChip(
                            label: Text(r == 1 ? 'минуты' : r == 60 ? 'часа' : '$r мин'),
                            selected: _round == r,
                            onSelected: (_) => setState(() => _round = r),
                          ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _stopCtrl,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (_) => setState(() {}),
                      decoration: const InputDecoration(
                        labelText: 'Стоп-чек за гостя, ₽ (необязательно)',
                        hintText: 'Больше этой суммы за визит не берём',
                      ),
                    ),
                    const SizedBox(height: 8),
                    Builder(builder: (context) {
                      final p = double.tryParse(_priceCtrl.text.replaceAll(',', '.').trim()) ?? 0;
                      final st = double.tryParse(_stopCtrl.text.replaceAll(',', '.').trim()) ?? 0;
                      if (p <= 0) return const SizedBox.shrink();
                      String c(int m) => TimeCafe.costPerGuest(Duration(minutes: m), price: p, round: _round, stop: st).toStringAsFixed(0);
                      return Text('Пример: 40 мин — ${c(40)} ₽, 1 ч 30 мин — ${c(90)} ₽, 3 ч — ${c(180)} ₽ за гостя',
                          style: TextStyle(fontSize: 13, color: AppColors.textMuted));
                    }),
                  ],
                  const Divider(height: 32),
                  const Text('Таймер стола', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                  const SizedBox(height: 6),
                  Text(
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
                    subtitle: const Text('Таймер не считает время — стол занят, пока его не закроют '
                        'вручную. Удобно ресторану, кафе и бару: если здесь ничего не '
                        'настроено, у них так и работает.'),
                    value: _unlimited,
                    onChanged: (v) => setState(() => _unlimited = v),
                  ),
                  if (!_unlimited) ...[
                    const SizedBox(height: 8),
                    // Частые варианты — одним нажатием; своё значение — в поле ниже.
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final m in const [60, 90, 120, 180])
                          ChoiceChip(
                            label: Text(AppConstants.formatSessionDuration(m)),
                            selected: _currentMinutes == m,
                            onSelected: (_) => setState(() => _hoursCtrl.text = _numStr(m / 60)),
                          ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _hoursCtrl,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (_) => setState(() {}),
                      decoration: const InputDecoration(
                        labelText: 'Своя длительность, часов',
                        hintText: 'Например, 1,5',
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
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Сохранить'),
                  ),
                ],
              ),
      ),
    );
  }
}
