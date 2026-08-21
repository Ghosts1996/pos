import 'package:flutter/material.dart';
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

enum _Field { cash, card, comp, contact }

class _PaymentScreenState extends State<PaymentScreen> {
  final _fs = FirestoreService();

  late final TextEditingController _cashCtrl;
  final _cardCtrl = TextEditingController(text: '0');
  final _compCtrl = TextEditingController(text: '0');
  final _contactCtrl = TextEditingController();

  _Field _focused = _Field.cash;
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

  TextEditingController _controllerFor(_Field f) {
    switch (f) {
      case _Field.cash:
        return _cashCtrl;
      case _Field.card:
        return _cardCtrl;
      case _Field.comp:
        return _compCtrl;
      case _Field.contact:
        return _contactCtrl;
    }
  }

  void _tapDigit(String d) {
    final ctrl = _controllerFor(_focused);
    var text = ctrl.text;
    if (_focused != _Field.contact && text == '0') text = '';
    text += d;
    ctrl.text = text;
    ctrl.selection = TextSelection.collapsed(offset: ctrl.text.length);
    setState(() {});
  }

  void _tapComma() {
    if (_focused == _Field.contact) return; // запятая имеет смысл только для сумм
    final ctrl = _controllerFor(_focused);
    if (!ctrl.text.contains(',')) {
      ctrl.text = ctrl.text.isEmpty ? '0,' : '${ctrl.text},';
      ctrl.selection = TextSelection.collapsed(offset: ctrl.text.length);
      setState(() {});
    }
  }

  void _backspace() {
    final ctrl = _controllerFor(_focused);
    if (ctrl.text.isEmpty) return;
    ctrl.text = ctrl.text.substring(0, ctrl.text.length - 1);
    ctrl.selection = TextSelection.collapsed(offset: ctrl.text.length);
    setState(() {});
  }

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
    final field = _focused == _Field.contact ? _Field.cash : _focused;
    _controllerFor(field).text = _fmt(v);
    setState(() => _focused = field);
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
        child: LayoutBuilder(builder: (context, c) {
          final narrow = c.maxWidth < 700;
          final left = _buildLeftPane();
          final right = _buildKeypad();
          if (narrow) {
            return SingleChildScrollView(child: Column(children: [left, right]));
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(flex: 3, child: left),
              const VerticalDivider(width: 1),
              Expanded(flex: 2, child: right),
            ],
          );
        }),
      ),
    );
  }

  Widget _buildLeftPane() {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('К оплате: ${_fmt(_total)} ${AppConstants.currencySymbol}',
              style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w500)),
          const SizedBox(height: 16),
          _amountRow('Наличными:', _cashCtrl, _Field.cash),
          _amountRow('Банковской картой:', _cardCtrl, _Field.card),
          _amountRow('За счёт заведения:', _compCtrl, _Field.comp),
          _contactRow(),
          if (!_closeWithoutPayment && _diff.abs() >= 0.01)
            Padding(
              padding: const EdgeInsets.only(top: 4, bottom: 4),
              child: Text(
                _diff > 0
                    ? 'Не хватает ${_fmt(_diff)} ${AppConstants.currencySymbol}'
                    : 'Сдача ${_fmt(-_diff)} ${AppConstants.currencySymbol}',
                style: TextStyle(
                  color: _diff > 0 ? Colors.red : Colors.green.shade700,
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
            child: FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: Colors.black,
                disabledBackgroundColor: Colors.grey.shade400,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              ),
              onPressed: _canPay && !_busy ? _pay : null,
              child: _busy
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                    )
                  : const Text('Оплатить', style: TextStyle(fontSize: 18, color: Colors.white)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _amountRow(String label, TextEditingController ctrl, _Field field) {
    final active = _focused == field;
    final enabled = !_closeWithoutPayment;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: InkWell(
        onTap: enabled ? () => setState(() => _focused = field) : null,
        child: Row(
          children: [
            Expanded(child: Text(label, style: const TextStyle(fontSize: 16))),
            Container(
              width: 180,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: !enabled
                    ? Colors.grey.shade200
                    : (active ? Colors.grey.shade300 : Colors.white),
                border: Border.all(color: active && enabled ? Colors.black54 : Colors.grey.shade400),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(
                ctrl.text,
                textAlign: TextAlign.right,
                style: TextStyle(fontSize: 16, color: enabled ? Colors.black : Colors.grey),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _contactRow() {
    final active = _focused == _Field.contact;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: InkWell(
        onTap: () => setState(() => _focused = _Field.contact),
        child: Row(
          children: [
            const Expanded(
                child: Text('Номер телефона / email гостя:', style: TextStyle(fontSize: 16))),
            Container(
              width: 180,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: active ? Colors.grey.shade300 : Colors.white,
                border: Border.all(color: active ? Colors.black54 : Colors.grey.shade400),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(
                _contactCtrl.text.isEmpty ? '0' : _contactCtrl.text,
                textAlign: TextAlign.right,
                style: TextStyle(
                    fontSize: 16, color: _contactCtrl.text.isEmpty ? Colors.grey : Colors.black),
              ),
            ),
          ],
        ),
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

  Widget _buildKeypad() {
    const digits = ['7', '8', '9', '4', '5', '6', '1', '2', '3', ',', '0', '<'];
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        children: [
          GridView.count(
            crossAxisCount: 3,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            mainAxisSpacing: 10,
            crossAxisSpacing: 10,
            childAspectRatio: 1.5,
            children: digits.map((d) {
              return OutlinedButton(
                style: OutlinedButton.styleFrom(
                  shape: const StadiumBorder(),
                  side: BorderSide(color: Colors.grey.shade400),
                ),
                onPressed: () {
                  if (d == '<') {
                    _backspace();
                  } else if (d == ',') {
                    _tapComma();
                  } else {
                    _tapDigit(d);
                  }
                },
                child: Text(d,
                    style: const TextStyle(fontSize: 22, color: Colors.black, fontWeight: FontWeight.w500)),
              );
            }).toList(),
          ),
          if (_quickAmounts.isNotEmpty) ...[
            const SizedBox(height: 14),
            Row(
              children: _quickAmounts.map((v) {
                return Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: OutlinedButton(
                      style: OutlinedButton.styleFrom(
                        backgroundColor: Colors.grey.shade300,
                        shape: const StadiumBorder(),
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        side: BorderSide.none,
                      ),
                      onPressed: () => _applyQuick(v),
                      child: Text(_fmt(v),
                          style: const TextStyle(fontSize: 18, color: Colors.black, fontWeight: FontWeight.w500)),
                    ),
                  ),
                );
              }).toList(),
            ),
          ],
        ],
      ),
    );
  }
}
