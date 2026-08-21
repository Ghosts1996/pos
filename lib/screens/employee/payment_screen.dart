import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../theme/app_colors.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../utils/constants.dart';

/// Экран оплаты гостя — открывается по кнопке "Закрыть стол". Позволяет
/// разбить сумму на наличные / карту / за счёт заведения, указать контакт
/// гостя и отметить печать чека. Сама печать физически не подключена (в
/// проекте нет драйвера принтера/фискального регистратора) — переключатели
/// только сохраняются в чек как флаги для отчётности.
class PaymentScreen extends StatefulWidget {
  final SessionModel session;
  const PaymentScreen({super.key, required this.session});

  @override
  State<PaymentScreen> createState() => _PaymentScreenState();
}

class _PaymentScreenState extends State<PaymentScreen> {
  final _fs = FirestoreService();

  late final TextEditingController _cashCtrl;
  final _cardCtrl = TextEditingController(text: '0');
  final _compCtrl = TextEditingController(text: '0');
  final _contactCtrl = TextEditingController();

  bool _closeWithoutPayment = false;
  bool _printReceipt = false;
  bool _printFiscalReceipt = false;
  bool _busy = false;

  double get _total => widget.session.totalWithDiscount;

  @override
  void initState() {
    super.initState();
    // По умолчанию вся сумма — наличными: сотрудник просто переносит часть
    // на карту, если гость платит смешанно (как на кассе Restik).
    _cashCtrl = TextEditingController(text: _fmt(_total));
    for (final c in [_cashCtrl, _cardCtrl, _compCtrl]) {
      c.addListener(() => setState(() {}));
    }
  }

  @override
  void dispose() {
    _cashCtrl.dispose();
    _cardCtrl.dispose();
    _compCtrl.dispose();
    _contactCtrl.dispose();
    super.dispose();
  }

  String _fmt(double v) {
    if (v == v.roundToDouble()) return v.toStringAsFixed(0);
    return v.toStringAsFixed(2).replaceAll('.', ',');
  }

  double _parse(String s) => double.tryParse(s.replaceAll(',', '.').replaceAll(' ', '')) ?? 0;

  double get _cash => _parse(_cashCtrl.text);
  double get _card => _parse(_cardCtrl.text);
  double get _comp => _parse(_compCtrl.text);
  double get _paidTotal => _cash + _card + _comp;
  double get _diff => _total - _paidTotal;

  bool get _canPay => _closeWithoutPayment || _diff.abs() < 0.01;

  /// Две подсказки быстрой суммы — округление вверх до сотни и до
  /// ближайшей "круглой" суммы. Удобно для приёма наличных и расчёта сдачи.
  List<double> get _quickAmounts {
    if (_total <= 0) return const [];
    final toHundred = (_total / 100).ceil() * 100.0;
    var toRound = (_total / 500).ceil() * 500.0;
    if (toRound <= toHundred) toRound += 500;
    return [toHundred, toRound];
  }

  void _applyQuick(double v) {
    _cashCtrl.text = _fmt(v);
  }

  Future<void> _pay() async {
    if (!_canPay || _busy) return;
    setState(() => _busy = true);
    try {
      await _fs.closeSessionWithPayment(
        widget.session.id,
        widget.session.tableId,
        cash: _closeWithoutPayment ? 0 : _cash,
        card: _closeWithoutPayment ? 0 : _card,
        comp: _closeWithoutPayment ? 0 : _comp,
        guestContact: _contactCtrl.text.trim(),
        closedWithoutPayment: _closeWithoutPayment,
        receiptPrinted: _printReceipt,
        fiscalReceiptPrinted: _printFiscalReceipt,
      );
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Не удалось провести оплату — проверьте интернет')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: BackButton(onPressed: () => Navigator.of(context).pop(false)),
        title: const Text('Назад'),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('К оплате: ${_fmt(_total)} ${AppConstants.currencySymbol}',
                  style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w500)),
              const SizedBox(height: 16),
              _amountField('Наличными:', _cashCtrl, enabled: !_closeWithoutPayment),
              _amountField('Банковской картой:', _cardCtrl, enabled: !_closeWithoutPayment),
              _amountField('За счёт заведения:', _compCtrl, enabled: !_closeWithoutPayment),
              _contactField(),
              if (_quickAmounts.isNotEmpty && !_closeWithoutPayment)
                Padding(
                  padding: const EdgeInsets.only(top: 4, bottom: 4),
                  child: Row(
                    children: _quickAmounts.map((v) {
                      return Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: OutlinedButton(
                          style: OutlinedButton.styleFrom(
                            shape: const StadiumBorder(),
                            side: BorderSide(color: AppColors.textMuted),
                          ),
                          onPressed: () => _applyQuick(v),
                          child: Text(_fmt(v)),
                        ),
                      );
                    }).toList(),
                  ),
                ),
              if (!_closeWithoutPayment && _diff.abs() >= 0.01)
                Padding(
                  padding: const EdgeInsets.only(top: 4, bottom: 4),
                  child: Text(
                    _diff > 0
                        ? 'Не хватает ${_fmt(_diff)} ${AppConstants.currencySymbol}'
                        : 'Сдача ${_fmt(-_diff)} ${AppConstants.currencySymbol}',
                    style: TextStyle(
                      color: _diff > 0 ? AppColors.danger : AppColors.success,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              const Divider(height: 28),
              _toggleRow('Закрыть без оплаты', _closeWithoutPayment,
                  (v) => setState(() => _closeWithoutPayment = v)),
              _toggleRow('Распечатать чек', _printReceipt, (v) => setState(() => _printReceipt = v)),
              _toggleRow('Распечатать фискальный чек', _printFiscalReceipt,
                  (v) => setState(() => _printFiscalReceipt = v)),
              const SizedBox(height: 20),
              SizedBox(
                height: 52,
                width: double.infinity,
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    disabledBackgroundColor: AppColors.disabled,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                  ),
                  onPressed: _canPay && !_busy ? _pay : null,
                  child: _busy
                      ? const SizedBox(
                          width: 22,
                          height: 22,
                          child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.textPrimary),
                        )
                      : const Text('Оплатить', style: TextStyle(fontSize: 18, color: AppColors.textPrimary)),
                ),
              ),
              const SizedBox(height: 20),
            ],
          ),
        ),
      ),
    );
  }

  Widget _amountField(String label, TextEditingController ctrl, {required bool enabled}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Expanded(child: Text(label, style: const TextStyle(fontSize: 16))),
          SizedBox(
            width: 180,
            child: TextField(
              controller: ctrl,
              enabled: enabled,
              textAlign: TextAlign.right,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [
                FilteringTextInputFormatter.allow(RegExp(r'[0-9,.]')),
              ],
              style: TextStyle(fontSize: 16, color: enabled ? AppColors.textPrimary : AppColors.textMuted),
              decoration: InputDecoration(
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                filled: true,
                fillColor: enabled ? AppColors.surface : AppColors.surfaceElevated,
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(6),
                  borderSide: BorderSide(color: AppColors.textMuted),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(6),
                  borderSide: const BorderSide(color: AppColors.primary, width: 1.6),
                ),
                disabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(6),
                  borderSide: const BorderSide(color: AppColors.border),
                ),
              ),
              onTap: () {
                // Удобно, если поле ещё содержит значение "0" по умолчанию —
                // выделяем весь текст, чтобы первое нажатие цифры сразу его
                // заменило, а не дописывалось к нулю.
                if (ctrl.text == '0') {
                  ctrl.selection = TextSelection(baseOffset: 0, extentOffset: ctrl.text.length);
                }
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _contactField() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          const Expanded(
              child: Text('Номер телефона / email гостя:', style: TextStyle(fontSize: 16))),
          SizedBox(
            width: 180,
            child: TextField(
              controller: _contactCtrl,
              textAlign: TextAlign.right,
              keyboardType: TextInputType.emailAddress,
              style: const TextStyle(fontSize: 16, color: AppColors.textPrimary),
              decoration: InputDecoration(
                isDense: true,
                hintText: '0',
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                filled: true,
                fillColor: AppColors.surface,
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(6),
                  borderSide: BorderSide(color: AppColors.textMuted),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(6),
                  borderSide: const BorderSide(color: AppColors.primary, width: 1.6),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _toggleRow(String label, bool value, ValueChanged<bool> onChanged) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(fontSize: 16)),
          Switch(value: value, onChanged: onChanged),
        ],
      ),
    );
  }
}