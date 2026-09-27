import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/cash_op.dart';
import '../models/employee.dart';
import '../models/session_model.dart';
import '../models/shift_model.dart';
import '../services/firestore_service.dart';
import '../theme/app_colors.dart';
import '../utils/human_error.dart';
import '../utils/money.dart';

/// Закрытие кассовой смены с пересчётом наличных — одно и то же из
/// X-отчёта и из бокового меню.
///
/// Кассир видит, сколько ДОЛЖНО быть в кассе, вводит, сколько насчитал
/// (недостача/излишек видны сразу), и сколько оставляет на размен —
/// остальное уходит в инкассацию. Размен станет «размен на начало»
/// следующей смены. Всё сохраняется одной транзакцией вместе с закрытием.
///
/// Возвращает true, если смену закрыли.
Future<bool> closeShiftWithCashCount(BuildContext context, {required ShiftModel shift, required Employee employee}) async {
  final fs = FirestoreService();
  final choice = await showDialog<_CloseChoice>(
    context: context,
    builder: (_) => _CloseShiftDialog(shift: shift, fs: fs),
  );
  if (choice == null) return false;
  final cash = choice.cash;
  try {
    await fs.closeShift(shift.id, employee.name, employeeId: employee.id, cash: cash);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(cash != null && cash.collect > 0
            ? 'Смена закрыта · инкассация ${rub(cash.collect)}, на размен ${rub(cash.leave)}'
            : 'Смена закрыта'),
      ));
    }
    return true;
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Не удалось закрыть смену: ${humanError(e, lower: true)}')));
    }
    return false;
  }
}

/// Итог диалога: [cash] == null — закрыть без пересчёта кассы (когда
/// посчитать наличные не удалось); пересчёт тогда не записывается вовсе,
/// а не «насчитали 0 ₽».
class _CloseChoice {
  final ShiftCashClose? cash;
  const _CloseChoice(this.cash);
}

class _CloseShiftDialog extends StatefulWidget {
  final ShiftModel shift;
  final FirestoreService fs;
  const _CloseShiftDialog({required this.shift, required this.fs});

  @override
  State<_CloseShiftDialog> createState() => _CloseShiftDialogState();
}

class _CloseShiftDialogState extends State<_CloseShiftDialog> {
  late final Future<CashDrawerSummary> _summary = _load();
  final _counted = TextEditingController();
  final _leave = TextEditingController();
  bool _filled = false;

  Future<CashDrawerSummary> _load() async {
    final results = await Future.wait([
      widget.fs.closedSessionsForShift(widget.shift),
      widget.fs.cashOpsForShift(widget.shift.id),
    ]);
    return CashDrawerSummary.from(
      opening: widget.shift.openingCash,
      sessions: results[0] as List<SessionModel>,
      ops: results[1] as List<CashOp>,
    );
  }

  @override
  void dispose() {
    _counted.dispose();
    _leave.dispose();
    super.dispose();
  }

  static double? _parse(String s) => double.tryParse(s.replaceAll(' ', '').replaceAll(',', '.'));
  static String _plain(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(2).replaceAll('.', ',');

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<CashDrawerSummary>(
      future: _summary,
      builder: (context, snap) {
        if (snap.hasError) {
          return AlertDialog(
            scrollable: true,
            title: const Text('Закрыть смену?'),
            content: Text('Не удалось посчитать наличные: ${humanError(snap.error, lower: true)}.\n'
                'Можно закрыть смену без пересчёта кассы.'),
            actions: [
              TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
              FilledButton(
                onPressed: () => Navigator.pop(context, const _CloseChoice(null)),
                child: const Text('Закрыть без пересчёта'),
              ),
            ],
          );
        }
        if (!snap.hasData) {
          return const AlertDialog(content: SizedBox(height: 80, child: Center(child: CircularProgressIndicator())));
        }
        final sum = snap.data!;
        final expected = sum.expected < 0 ? 0.0 : sum.expected;
        if (!_filled) {
          _filled = true;
          _counted.text = _plain(expected);
          // На размен по умолчанию — столько же, сколько было на начало
          // смены, но не больше, чем есть в кассе.
          final leave = widget.shift.openingCash > expected ? expected : widget.shift.openingCash;
          _leave.text = _plain(leave);
        }
        final counted = _parse(_counted.text);
        final leave = _parse(_leave.text) ?? 0;
        final diff = counted == null ? null : counted - expected;
        final collect = counted == null ? 0.0 : counted - leave;
        final error = counted == null || counted < 0
            ? 'Введите, сколько наличных насчитали'
            : leave < 0
                ? 'Размен не может быть отрицательным'
                : leave > counted
                    ? 'На размен нельзя оставить больше, чем есть в кассе'
                    : null;

        Widget line(String label, double v, {bool bold = false, Color? color}) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(children: [
                Expanded(child: Text(label, style: TextStyle(color: color ?? AppColors.textMuted, fontSize: 13))),
                Text(rub(v),
                    style: TextStyle(fontWeight: bold ? FontWeight.w700 : FontWeight.w500, fontSize: bold ? 16 : 13, color: color)),
              ]),
            );

        return AlertDialog(
          title: const Text('Закрытие смены'),
          content: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(12)),
                    child: Column(children: [
                      line('Должно быть в кассе', expected, bold: true, color: AppColors.textPrimary),
                      const SizedBox(height: 4),
                      line('Размен на начало смены', sum.opening),
                      line('+ наличные за чеки', sum.cashSales),
                      if (sum.cashTips > 0) line('+ чаевые наличными', sum.cashTips),
                      if (sum.deposits > 0) line('+ внесения', sum.deposits),
                      if (sum.collections > 0) line('− инкассации', sum.collections),
                      if (sum.payouts > 0) line('− выплаты', sum.payouts),
                      if (sum.refunds > 0) line('− возвраты наличными', sum.refunds),
                    ]),
                  ),
                  const SizedBox(height: 14),
                  TextField(
                    controller: _counted,
                    autofocus: true,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))],
                    decoration: const InputDecoration(labelText: 'Насчитали наличных', suffixText: '₽'),
                    onChanged: (_) => setState(() {}),
                  ),
                  const SizedBox(height: 6),
                  if (diff != null)
                    Text(
                      diff.abs() < 0.01
                          ? 'Сходится'
                          : diff < 0
                              ? 'Недостача ${rub(-diff)}'
                              : 'Излишек ${rub(diff)}',
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        color: diff.abs() < 0.01 ? AppColors.success : (diff < 0 ? AppColors.danger : AppColors.warning),
                      ),
                    ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _leave,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))],
                    decoration: const InputDecoration(
                      labelText: 'Оставить на размен',
                      suffixText: '₽',
                      helperText: 'Эта сумма станет разменом на начало следующей смены',
                      helperMaxLines: 2,
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                  const SizedBox(height: 12),
                  Row(children: [
                    const Expanded(child: Text('Инкассация', style: TextStyle(fontWeight: FontWeight.w600))),
                    Text(rub(collect < 0 ? 0 : collect), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                  ]),
                  if (error != null) ...[
                    const SizedBox(height: 8),
                    Text(error, style: const TextStyle(color: AppColors.danger, fontSize: 13)),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
            FilledButton(
              onPressed: error != null
                  ? null
                  : () => Navigator.pop(
                        context,
                        _CloseChoice(ShiftCashClose(expected: expected, counted: counted!, collect: collect, leave: leave)),
                      ),
              child: const Text('Закрыть смену'),
            ),
          ],
        );
      },
    );
  }
}
