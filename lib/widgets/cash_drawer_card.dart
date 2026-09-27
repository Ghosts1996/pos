import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/cash_op.dart';
import '../models/employee.dart';
import '../models/shift_model.dart';
import '../services/firestore_service.dart';
import '../theme/app_colors.dart';
import '../utils/constants.dart';
import '../utils/human_error.dart';
import '../utils/money.dart';

/// «Наличные в кассе» на экране «Касса»: сколько должно лежать в ящике и из чего
/// это складывается, кнопки «Инкассация / Внесение / Выплата» и история
/// операций смены.
///
/// [live] — текущая смена: можно проводить и отменять операции, править
/// размен. Для прошлой смены карточка только показывает, что было, и
/// пересчёт кассы при закрытии.
class CashDrawerCard extends StatelessWidget {
  final CashDrawerSummary summary;
  final List<CashOp> ops;
  final ShiftModel shift;
  final Employee employee;
  final bool live;

  const CashDrawerCard({
    super.key,
    required this.summary,
    required this.ops,
    required this.shift,
    required this.employee,
    required this.live,
  });

  static String _hhmm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final expected = summary.expected;
    Widget line(String label, double v, {String sign = '', bool edit = false}) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(children: [
            Expanded(child: Text(label, style: const TextStyle(color: AppColors.textMuted))),
            if (edit && live)
              InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: () => _editOpening(context),
                child: const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  child: Icon(Icons.edit_outlined, size: 16, color: AppColors.textMuted),
                ),
              ),
            Text(v.abs() < 0.005 ? rub(0) : '$sign${rub(v)}'),
          ]),
        );

    final closing = shift.closingCountedCash != null;
    final diff = shift.closingDiff;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: expected < 0 ? AppColors.danger : AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(children: [
            const Icon(Icons.point_of_sale_rounded, color: AppColors.success),
            const SizedBox(width: 8),
            const Expanded(
              child: Text('Наличные в кассе', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            ),
            Text(rub(expected),
                style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w800,
                    color: expected < 0 ? AppColors.danger : AppColors.textPrimary)),
          ]),
          if (expected < 0)
            const Padding(
              padding: EdgeInsets.only(top: 6),
              child: Text('Забрали больше, чем было по учёту — проверьте операции ниже.',
                  style: TextStyle(color: AppColors.danger, fontSize: 12.5)),
            ),
          const SizedBox(height: 10),
          line('Размен на начало смены', summary.opening, edit: true),
          line('Наличные за чеки', summary.cashSales, sign: '+ '),
          if (summary.cashTips > 0) line('Чаевые наличными', summary.cashTips, sign: '+ '),
          if (summary.deposits > 0) line('Внесения', summary.deposits, sign: '+ '),
          if (summary.collections > 0) line('Инкассации', summary.collections, sign: '− '),
          if (summary.payouts > 0) line('Выплаты', summary.payouts, sign: '− '),
          if (summary.refunds > 0) line('Возвраты наличными', summary.refunds, sign: '− '),
          if (summary.countDiff.abs() >= 0.01)
            line(summary.countDiff < 0 ? 'Недостача при пересчёте' : 'Излишек при пересчёте', summary.countDiff.abs(),
                sign: summary.countDiff < 0 ? '− ' : '+ '),
          if (closing) ...[
            const Divider(height: 20),
            Text(
              'Пересчёт при закрытии: насчитали ${rub(shift.closingCountedCash!)}'
              '${diff == null || diff.abs() < 0.01 ? ' — сходится' : diff < 0 ? ' — недостача ${rub(-diff)}' : ' — излишек ${rub(diff)}'}'
              '${shift.closingLeftCash != null ? '. Оставили на размен ${rub(shift.closingLeftCash!)}' : ''}.',
              style: TextStyle(
                  fontSize: 13,
                  color: diff != null && diff < -0.01 ? AppColors.danger : AppColors.textMuted),
            ),
          ],
          if (live) ...[
            const SizedBox(height: 12),
            Row(children: [
              Expanded(child: _opButton(context, CashOpType.collection, Icons.outbox_rounded, expected)),
              const SizedBox(width: 8),
              Expanded(child: _opButton(context, CashOpType.deposit, Icons.move_to_inbox_rounded, expected)),
              const SizedBox(width: 8),
              Expanded(child: _opButton(context, CashOpType.payout, Icons.payments_outlined, expected)),
            ]),
          ],
          if (ops.isNotEmpty) ...[
            const Divider(height: 24),
            const Text('Операции за смену', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            for (final op in ops.reversed) _opRow(context, op),
          ],
        ],
      ),
    );
  }

  Widget _opButton(BuildContext context, CashOpType type, IconData icon, double expected) => OutlinedButton(
        style: OutlinedButton.styleFrom(
          padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
        onPressed: () => _addOp(context, type, expected),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 20),
          const SizedBox(height: 2),
          FittedBox(child: Text(type.label, style: const TextStyle(fontSize: 13))),
        ]),
      );

  Widget _opRow(BuildContext context, CashOp op) {
    final canCancel = live &&
        !op.cancelled &&
        op.type != CashOpType.refund &&
        (employee.role == AppConstants.roleAdmin ||
            (op.employeeId == employee.id && DateTime.now().difference(op.createdAt).inMinutes < 15));
    final style = TextStyle(
      decoration: op.cancelled ? TextDecoration.lineThrough : null,
      color: op.cancelled ? AppColors.textMuted : null,
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(children: [
        SizedBox(width: 44, child: Text(_hhmm(op.createdAt), style: const TextStyle(color: AppColors.textMuted, fontSize: 13))),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(op.type.label, style: style.copyWith(fontWeight: FontWeight.w600)),
            Text(
              [
                if (op.employeeName.isNotEmpty) op.employeeName,
                if (op.comment.isNotEmpty) op.comment,
                if (op.cancelled) 'отменена${op.cancelledBy.isNotEmpty ? ' · ${op.cancelledBy}' : ''}',
              ].join(' · '),
              style: const TextStyle(color: AppColors.textMuted, fontSize: 12.5),
            ),
          ]),
        ),
        Text('${op.type.isIncome ? '+' : '−'}${rub(op.amount)}',
            style: style.copyWith(
                fontWeight: FontWeight.w700,
                color: op.cancelled ? AppColors.textMuted : (op.type.isIncome ? AppColors.success : null))),
        if (canCancel)
          IconButton(
            tooltip: 'Отменить операцию',
            icon: const Icon(Icons.undo_rounded, size: 20),
            onPressed: () => _cancel(context, op),
          ),
      ]),
    );
  }

  Future<void> _addOp(BuildContext context, CashOpType type, double expected) async {
    final result = await showDialog<({double amount, String comment})>(
      context: context,
      builder: (_) => _CashOpDialog(type: type, expected: expected, opening: summary.opening),
    );
    if (result == null) return;
    try {
      await FirestoreService().addCashOp(CashOp(
        id: '',
        shiftId: shift.id,
        type: type,
        amount: result.amount,
        comment: result.comment,
        employeeName: employee.name,
        employeeId: employee.id,
        createdAt: DateTime.now(),
      ));
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('${type.label}: ${rub(result.amount)} — записано'),
        ));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось записать: ${humanError(e, lower: true)}')));
      }
    }
  }

  Future<void> _cancel(BuildContext context, CashOp op) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        scrollable: true,
        title: const Text('Отменить операцию?'),
        content: Text('${op.type.label} на ${rub(op.amount)} в ${_hhmm(op.createdAt)}. '
            'Она останется в истории зачёркнутой и перестанет учитываться в кассе.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Нет')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Отменить')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await FirestoreService().cancelCashOp(op.id, employee.name);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось отменить: ${humanError(e, lower: true)}')));
      }
    }
  }

  Future<void> _editOpening(BuildContext context) async {
    final ctrl = TextEditingController(text: summary.opening == summary.opening.roundToDouble()
        ? summary.opening.toStringAsFixed(0)
        : summary.opening.toString());
    final value = await showDialog<double>(
      context: context,
      builder: (ctx) => AlertDialog(
        scrollable: true,
        title: const Text('Размен на начало смены'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))],
          decoration: const InputDecoration(
            suffixText: '₽',
            helperText: 'Сколько наличных было в кассе, когда открыли смену',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, double.tryParse(ctrl.text.replaceAll(',', '.').replaceAll(' ', ''))),
            child: const Text('Сохранить'),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (value == null || value < 0) return;
    try {
      await FirestoreService().setOpeningCash(shift.id, value);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось сохранить: ${humanError(e, lower: true)}')));
      }
    }
  }
}

/// Сумма и комментарий операции. Для инкассации — быстрые кнопки «Всё» и
/// «Оставить размен»; если забирают больше, чем по учёту есть в кассе,
/// спрашиваем подтверждение.
class _CashOpDialog extends StatefulWidget {
  final CashOpType type;
  final double expected;
  final double opening;
  const _CashOpDialog({required this.type, required this.expected, required this.opening});

  @override
  State<_CashOpDialog> createState() => _CashOpDialogState();
}

class _CashOpDialogState extends State<_CashOpDialog> {
  final _amount = TextEditingController();
  final _comment = TextEditingController();
  String? _error;
  bool _confirmOver = false;

  @override
  void dispose() {
    _amount.dispose();
    _comment.dispose();
    super.dispose();
  }

  String get _hint {
    switch (widget.type) {
      case CashOpType.collection:
        return 'Например, в сейф или владельцу';
      case CashOpType.deposit:
        return 'Например, размен из сейфа';
      case CashOpType.payout:
        return 'Кому и за что: поставщик, курьер, аванс';
      case CashOpType.refund:
        return '';
    }
  }

  void _set(double v) => setState(() {
        _amount.text = v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(2).replaceAll('.', ',');
        _confirmOver = false;
      });

  void _submit() {
    final v = double.tryParse(_amount.text.replaceAll(' ', '').replaceAll(',', '.'));
    if (v == null || v <= 0) {
      setState(() => _error = 'Введите сумму больше нуля');
      return;
    }
    if (widget.type == CashOpType.payout && _comment.text.trim().isEmpty) {
      setState(() => _error = 'Напишите, кому и за что выдали — иначе потом не разобраться');
      return;
    }
    final outgoing = widget.type != CashOpType.deposit;
    if (outgoing && v > widget.expected + 0.009 && !_confirmOver) {
      setState(() {
        _confirmOver = true;
        _error = 'По учёту в кассе ${rub(widget.expected)} — это больше. Нажмите ещё раз, если всё верно.';
      });
      return;
    }
    Navigator.pop(context, (amount: v, comment: _comment.text.trim()));
  }

  @override
  Widget build(BuildContext context) {
    final collect = widget.type == CashOpType.collection;
    final keep = widget.expected - widget.opening;
    return AlertDialog(
      scrollable: true,
      title: Text(widget.type.label),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('В кассе по учёту: ${rub(widget.expected)}', style: const TextStyle(color: AppColors.textMuted)),
            const SizedBox(height: 12),
            TextField(
              controller: _amount,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))],
              decoration: const InputDecoration(labelText: 'Сумма', suffixText: '₽'),
              onChanged: (_) => setState(() {
                _error = null;
                _confirmOver = false;
              }),
              onSubmitted: (_) => _submit(),
            ),
            if (collect && widget.expected > 0) ...[
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                ActionChip(label: Text('Всё · ${rub(widget.expected)}'), onPressed: () => _set(widget.expected)),
                if (widget.opening > 0 && keep > 0)
                  ActionChip(label: Text('Оставить размен · ${rub(keep)}'), onPressed: () => _set(keep)),
              ]),
            ],
            const SizedBox(height: 12),
            TextField(
              controller: _comment,
              maxLength: 80,
              decoration: InputDecoration(
                labelText: widget.type == CashOpType.payout ? 'Кому и за что' : 'Комментарий (необязательно)',
                hintText: _hint,
              ),
            ),
            if (_error != null)
              Text(_error!, style: TextStyle(color: _confirmOver ? AppColors.warning : AppColors.danger, fontSize: 13)),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
        FilledButton(onPressed: _submit, child: Text(_confirmOver ? 'Всё верно, провести' : 'Провести')),
      ],
    );
  }
}
