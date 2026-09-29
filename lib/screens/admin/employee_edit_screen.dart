import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../models/employee.dart';
import '../../models/staff_shift_model.dart';
import '../../services/firestore_service.dart';
import '../../services/payroll_calculator.dart';
import '../../services/venue_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/bill_split.dart';
import '../../utils/constants.dart';

/// Как платим за время: не платим, почасовая ставка или оклад за смену.
enum _TimePay { none, hourly, shift }

/// Карточка сотрудника: имя, PIN, роль, специализация, чаевые, зарплата.
/// Возвращает готового [Employee] (PIN уже проверен), сохраняет вызывающий.
class EmployeeEditScreen extends StatefulWidget {
  final Employee? employee;
  const EmployeeEditScreen({super.key, this.employee});

  @override
  State<EmployeeEditScreen> createState() => _EmployeeEditScreenState();
}

class _EmployeeEditScreenState extends State<EmployeeEditScreen> {
  final _fs = FirestoreService();
  Employee? get _emp => widget.employee;

  late final _name = TextEditingController(text: _emp?.name ?? '');
  late final _pin = TextEditingController(text: _emp?.pinCode ?? '');
  late final _tipsLink = TextEditingController(text: _emp?.tipsLink ?? '');
  late final _hourlyRate = TextEditingController(text: _numOrEmpty(_emp?.hourlyRate ?? 0));
  late final _shiftRate = TextEditingController(text: _numOrEmpty(_emp?.shiftRate ?? 0));
  late final _threshold = TextEditingController(text: _num(_emp?.overtimeThresholdHours ?? 12));
  late final _multiplier = TextEditingController(text: _num(_emp?.overtimeMultiplier ?? 1.5));
  late final _overtimeHourRate = TextEditingController(text: _numOrEmpty(_emp?.overtimeHourRate ?? 0));
  late final _salesPercent = TextEditingController(text: _numOrEmpty(_emp?.salesPercentRate ?? 0));

  late String _role = _emp?.role ?? AppConstants.roleEmployee;
  late String _position = _emp?.position ?? AppConstants.positionUniversal;
  late _TimePay _timePay = _emp == null
      ? _TimePay.none
      : _emp!.shiftRateEnabled
          ? _TimePay.shift
          : _emp!.hourlyRateEnabled
              ? _TimePay.hourly
              : _TimePay.none;
  late bool _overtime = _emp?.overtimeEnabled ?? false;
  late bool _salesPercentOn = _emp?.salesPercentEnabled ?? false;
  bool _showPin = false;
  bool _saving = false;
  String? _error;

  bool get _hookahVenue => VenueService.instance.terms.isHookah;

  /// «Кальянщик» в списке нужен только кальянной — в ресторане он лишь
  /// путает. Но если он уже назначен, пункт оставляем, чтобы не потерять.
  late final List<String> _positions = AppConstants.employeePositions
      .where((p) => p != AppConstants.positionHookahMaster || _hookahVenue || _emp?.position == p)
      .toList();

  @override
  void initState() {
    super.initState();
    // Пример расчёта под зарплатой пересчитывается на каждый ввод.
    for (final c in [_hourlyRate, _shiftRate, _threshold, _multiplier, _overtimeHourRate, _salesPercent]) {
      c.addListener(_refresh);
    }
    // У сотрудников до появления оклада за смену норма стояла 8 ч по
    // умолчанию; новому — 12 ч, обычная смена в заведении.
    if (_emp != null && !_emp!.overtimeEnabled && _emp!.overtimeThresholdHours == 8) _threshold.text = '12';
  }

  void _refresh() => setState(() {});

  @override
  void dispose() {
    for (final c in [
      _name,
      _pin,
      _tipsLink,
      _hourlyRate,
      _shiftRate,
      _threshold,
      _multiplier,
      _overtimeHourRate,
      _salesPercent
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  /// Ноль в пустом поле — лишний символ, который надо стирать.
  static String _numOrEmpty(double v) => v == 0 ? '' : _num(v);
  static String _num(double v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString().replaceAll('.', ',');
  static double _parse(TextEditingController c, [double fallback = 0]) =>
      double.tryParse(c.text.replaceAll(',', '.').replaceAll(' ', '').trim()) ?? fallback;
  static String _rub(double v) => formatKopecks((v * 100).round());

  int get _pinLength => AppConstants.pinLengthForRole(_role);

  /// Цена часа переработки при окладе за смену, если её не задали: оклад
  /// делим на норму часов и ×1,5 — как принято по ТК, округляем до 10 ₽.
  double get _suggestedOvertimeHour {
    final rate = _parse(_shiftRate);
    final hours = _parse(_threshold, 12);
    if (rate <= 0 || hours <= 0) return 0;
    return ((rate / hours * 1.5) / 10).round() * 10.0;
  }

  Employee _build() => Employee(
        id: _emp?.id ?? '',
        name: _name.text.trim(),
        pinCode: _pin.text.trim(),
        role: _role,
        position: _position,
        hourlyRateEnabled: _timePay == _TimePay.hourly,
        hourlyRate: _parse(_hourlyRate),
        shiftRateEnabled: _timePay == _TimePay.shift,
        shiftRate: _parse(_shiftRate),
        overtimeEnabled: _timePay != _TimePay.none && _overtime,
        overtimeThresholdHours: _parse(_threshold, 12),
        overtimeMultiplier: _parse(_multiplier, 1.5),
        overtimeHourRate: _parse(_overtimeHourRate),
        salesPercentEnabled: _salesPercentOn,
        salesPercentRate: _parse(_salesPercent),
        tipsLink: _tipsLink.text.trim(),
      );

  String? _validate(Employee e) {
    if (e.name.isEmpty) return 'Введите имя сотрудника';
    if (e.pinCode.length != _pinLength || int.tryParse(e.pinCode) == null) {
      return _role == AppConstants.roleAdmin
          ? 'PIN администратора — ровно $_pinLength цифр'
          : 'PIN сотрудника — ровно $_pinLength цифры';
    }
    if (e.hourlyRate < 0 || e.shiftRate < 0 || e.overtimeHourRate < 0) return 'Суммы не могут быть отрицательными';
    if (e.hourlyRateEnabled && e.hourlyRate <= 0) return 'Укажите ставку за час больше нуля';
    if (e.shiftRateEnabled && e.shiftRate <= 0) return 'Укажите оклад за смену больше нуля';
    if (e.overtimeEnabled) {
      if (e.overtimeThresholdHours <= 0 || e.overtimeThresholdHours > 24) {
        return 'Норма смены — от 1 до 24 часов';
      }
      if (e.hourlyRateEnabled && e.overtimeMultiplier < 1) {
        return 'Множитель переработки не меньше 1 — иначе час переработки стоит дешевле обычного';
      }
      if (e.shiftRateEnabled && e.overtimeHourRate <= 0) return 'Укажите, сколько платить за час переработки';
    }
    if (e.salesPercentRate < 0 || e.salesPercentRate > 100) return 'Процент с продаж — число от 0 до 100';
    if (e.salesPercentEnabled && e.salesPercentRate <= 0) return 'Укажите процент больше нуля или выключите его';
    if (e.tipsLink.isNotEmpty && !(Uri.tryParse(e.tipsLink)?.isAbsolute == true && e.tipsLink.startsWith('https://'))) {
      return 'Ссылка для чаевых должна начинаться с https://';
    }
    return null;
  }

  Future<void> _save() async {
    if (_timePay == _TimePay.shift && _overtime && _parse(_overtimeHourRate) <= 0 && _suggestedOvertimeHour > 0) {
      _overtimeHourRate.text = _num(_suggestedOvertimeHour);
    }
    final e = _build();
    final problem = _validate(e);
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      if (await _fs.isPinTaken(e.pinCode, excludeId: _emp?.id)) {
        setState(() {
          _saving = false;
          _error = 'Этот PIN-код уже занят другим сотрудником';
        });
        return;
      }
    } catch (_) {
      setState(() {
        _saving = false;
        _error = 'Не удалось проверить PIN — проверьте интернет';
      });
      return;
    }
    if (mounted) Navigator.of(context).pop(e);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_emp == null ? 'Новый сотрудник' : _emp!.name)),
      body: LayoutBuilder(builder: (context, box) {
        final side = box.maxWidth > 672 ? (box.maxWidth - 640) / 2 : 16.0;
        return ListView(
          padding: EdgeInsets.fromLTRB(side, 12, side, 24),
          children: [
            _section('Основное', Icons.badge_outlined, [
              TextField(
                controller: _name,
                textCapitalization: TextCapitalization.words,
                decoration:
                    const InputDecoration(labelText: 'Имя', helperText: 'Как в кассе — достаточно имени, без фамилии'),
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: SegmentedButton<String>(
                  segments: const [
                    ButtonSegment(
                        value: AppConstants.roleEmployee, icon: Icon(Icons.person_outline), label: Text('Сотрудник')),
                    ButtonSegment(
                        value: AppConstants.roleAdmin,
                        icon: Icon(Icons.admin_panel_settings_outlined),
                        label: Text('Администратор')),
                  ],
                  selected: {_role},
                  // Разная длина PIN у ролей — при смене роли поле чистится,
                  // иначе сохранение упрётся в проверку длины.
                  onSelectionChanged: (v) => setState(() {
                    _role = v.first;
                    _pin.clear();
                  }),
                ),
              ),
              const SizedBox(height: 6),
              Text(
                _role == AppConstants.roleAdmin
                    ? 'Администратор открывает настройки, отчёты и зарплату.'
                    : 'Сотрудник работает с залом: столы, заказы, оплата.',
                style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: _pin,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                maxLength: _pinLength,
                obscureText: !_showPin,
                decoration: InputDecoration(
                  labelText: 'PIN-код для входа',
                  helperText: '$_pinLength ${_pinLength == 4 ? 'цифры' : 'цифр'}',
                  suffixIcon: IconButton(
                    tooltip: _showPin ? 'Скрыть' : 'Показать',
                    icon: Icon(_showPin ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                    onPressed: () => setState(() => _showPin = !_showPin),
                  ),
                ),
              ),
            ]),
            _section('Специализация', Icons.work_outline, [
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final p in _positions)
                    ChoiceChip(
                      label: Text(AppConstants.positionShortLabel(p)),
                      selected: _position == p,
                      onSelected: (_) => setState(() => _position = p),
                    ),
                ],
              ),
              const SizedBox(height: 10),
              _hint(Icons.info_outline, AppConstants.positionHint(_position, hookahVenue: _hookahVenue)),
            ]),
            _section('Чаевые', Icons.volunteer_activism_outlined, [
              TextField(
                controller: _tipsLink,
                keyboardType: TextInputType.url,
                decoration: const InputDecoration(
                  labelText: 'Ссылка для чаевых',
                  hintText: 'https://… (необязательно)',
                  helperText: 'Нетмонет, CloudTips или банк — гость переведёт напрямую. '
                      'Без ссылки чаевые идут в счёт и в зарплату.',
                  helperMaxLines: 4,
                ),
              ),
            ]),
            _salarySection(),
            if (_error != null) ...[
              const SizedBox(height: 4),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.danger.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.danger.withValues(alpha: 0.5)),
                ),
                child: Row(children: [
                  const Icon(Icons.error_outline, color: AppColors.danger),
                  const SizedBox(width: 10),
                  Expanded(child: Text(_error!)),
                ]),
              ),
            ],
          ],
        );
      }),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: Center(
            heightFactor: 1,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: SizedBox(
                width: double.infinity,
                height: 52,
                child: FilledButton.icon(
                  onPressed: _saving ? null : _save,
                  icon: _saving
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.check_rounded),
                  label: const Text('Сохранить'),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _salarySection() {
    final timeFields = <Widget>[];
    if (_timePay == _TimePay.hourly) {
      timeFields.add(_money(_hourlyRate, 'Ставка', '₽ в час'));
    } else if (_timePay == _TimePay.shift) {
      timeFields.add(_money(_shiftRate, 'Оклад за смену', '₽ за смену'));
      timeFields.add(const SizedBox(height: 6));
      timeFields.add(_hint(
          Icons.info_outline,
          'Платится за каждую отработанную смену, сколько бы она ни длилась. '
          'Если смену закрыли и снова открыли меньше чем через 3 часа — это одна смена.'));
    }

    final overtime = <Widget>[];
    if (_timePay != _TimePay.none) {
      overtime.add(const Divider(height: 28, color: AppColors.border));
      overtime.add(_switch(
        'Переработка',
        _timePay == _TimePay.shift
            ? 'Доплата за каждый час сверх нормы смены'
            : 'Час сверх нормы смены дороже обычного',
        _overtime,
        (v) => setState(() {
          _overtime = v;
          if (v && _timePay == _TimePay.shift && _parse(_overtimeHourRate) <= 0 && _suggestedOvertimeHour > 0) {
            _overtimeHourRate.text = _num(_suggestedOvertimeHour);
          }
        }),
      ));
      if (_overtime) {
        overtime.add(const SizedBox(height: 10));
        overtime.add(Row(children: [
          Expanded(child: _money(_threshold, 'Норма смены', 'часов', decimal: true)),
          const SizedBox(width: 12),
          Expanded(
            child: _timePay == _TimePay.shift
                ? _money(_overtimeHourRate, 'Час переработки', '₽ в час',
                    helper: _suggestedOvertimeHour > 0 ? 'обычно ≈ ${_rub(_suggestedOvertimeHour)}' : null)
                : _money(_multiplier, 'Множитель ставки', '× к ставке', decimal: true),
          ),
        ]));
        if (_timePay == _TimePay.hourly) {
          overtime.add(const SizedBox(height: 8));
          overtime.add(Wrap(spacing: 8, children: [
            for (final m in const [1.25, 1.5, 2.0])
              ChoiceChip(
                label: Text('×${_num(m)}'),
                selected: _parse(_multiplier, 1.5) == m,
                onSelected: (_) => _multiplier.text = _num(m),
              ),
          ]));
        }
      }
    }

    return _section('Зарплата', Icons.payments_outlined, [
      const Text('Оплата времени', style: TextStyle(fontWeight: FontWeight.w600)),
      const SizedBox(height: 8),
      SizedBox(
        width: double.infinity,
        child: SegmentedButton<_TimePay>(
          showSelectedIcon: false,
          segments: const [
            ButtonSegment(value: _TimePay.none, label: Text('Нет')),
            ButtonSegment(value: _TimePay.hourly, label: Text('За час')),
            ButtonSegment(value: _TimePay.shift, label: Text('За смену')),
          ],
          selected: {_timePay},
          onSelectionChanged: (v) => setState(() => _timePay = v.first),
        ),
      ),
      if (timeFields.isNotEmpty) const SizedBox(height: 14),
      ...timeFields,
      ...overtime,
      const Divider(height: 28, color: AppColors.border),
      _switch('Процент с продаж', 'От выручки по его чекам, без возвратов', _salesPercentOn,
          (v) => setState(() => _salesPercentOn = v)),
      if (_salesPercentOn) ...[
        const SizedBox(height: 10),
        _money(_salesPercent, 'Процент', '%', decimal: true),
      ],
      ..._example(),
    ]);
  }

  /// «Пример: смена 14 ч → 3 000 ₽ + 2 ч переработки × 380 ₽ = 3 760 ₽»
  /// — чтобы владелец сразу видел, во что выльются его цифры.
  List<Widget> _example() {
    if (_timePay == _TimePay.none) return const [];
    final e = _build();
    if ((e.hourlyRateEnabled && e.hourlyRate <= 0) || (e.shiftRateEnabled && e.shiftRate <= 0)) return const [];
    final norm = e.overtimeThresholdHours > 0 ? e.overtimeThresholdHours : 12;
    final hours = e.overtimeEnabled ? norm + 2 : norm;
    final start = DateTime(2026, 1, 1, 12);
    final r = PayrollCalculator.calculate(
      employee: e,
      closedShifts: [
        StaffShiftModel(
          id: 'example',
          employeeId: e.id,
          employeeName: e.name,
          startedAt: start,
          endedAt: start.add(Duration(minutes: (hours * 60).round())),
          status: 'closed',
        ),
      ],
      salesRevenue: 0,
    );
    final parts = <String>[
      if (e.shiftRateEnabled) _rub(r.shiftPay),
      if (e.hourlyRateEnabled) '${_num(r.normalHours)} ч × ${_rub(e.hourlyRate)}',
      if (r.overtimeHours > 0) '${_num(r.overtimeHours)} ч переработки × ${_rub(r.overtimeHourPrice)}',
    ];
    return [
      const SizedBox(height: 14),
      Container(
        width: double.infinity,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppColors.selection,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text.rich(TextSpan(children: [
          TextSpan(
              text: 'Пример: смена ${_num(hours.toDouble())} ч → ', style: const TextStyle(color: AppColors.textMuted)),
          TextSpan(text: parts.join(' + ')),
          if (parts.length > 1)
            TextSpan(text: ' = ${_rub(r.wages)}', style: const TextStyle(fontWeight: FontWeight.w700)),
          if (_salesPercentOn)
            const TextSpan(text: ' + процент с продаж', style: TextStyle(color: AppColors.textMuted)),
        ])),
      ),
    ];
  }

  // ---------- общие кирпичики ----------

  Widget _section(String title, IconData icon, List<Widget> children) => Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Icon(icon, size: 20, color: AppColors.textMuted),
              const SizedBox(width: 8),
              Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            ]),
            const SizedBox(height: 14),
            ...children,
          ],
        ),
      );

  Widget _hint(IconData icon, String text) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: AppColors.textMuted),
          const SizedBox(width: 6),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted, height: 1.3))),
        ],
      );

  Widget _switch(String title, String subtitle, bool value, ValueChanged<bool> onChanged) => Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
                Text(subtitle, style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
              ],
            ),
          ),
          Switch(value: value, onChanged: onChanged),
        ],
      );

  Widget _money(TextEditingController c, String label, String suffix, {bool decimal = false, String? helper}) =>
      TextField(
        controller: c,
        keyboardType: TextInputType.numberWithOptions(decimal: decimal),
        inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))],
        decoration: InputDecoration(labelText: label, suffixText: suffix, helperText: helper),
      );
}
