import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../theme/app_colors.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../services/payment_terminal_service.dart';
import '../../services/printer_service.dart';
import '../../services/kassa_service.dart';
import '../../services/chestny_znak_service.dart';
import '../../models/fiscal_receipt.dart';
import '../../utils/constants.dart';

/// Экран оплаты гостя — открывается по кнопке "Закрыть стол". Позволяет
/// разбить сумму на наличные / карту / терминал / за счёт заведения,
/// указать контакт гостя и отметить печать чека. Сама печать физически не
/// подключена (в проекте нет драйвера принтера/фискального регистратора) —
/// переключатели только сохраняются в чек как флаги для отчётности.
class PaymentScreen extends StatefulWidget {
  final SessionModel session;
  const PaymentScreen({super.key, required this.session});

  @override
  State<PaymentScreen> createState() => _PaymentScreenState();
}

/// Один способ оплаты на экране: подпись, контроллер суммы и фокус-нода,
/// нужная, чтобы отследить первое нажатие на поле.
class _PaymentMethod {
  final String label;
  final TextEditingController controller;
  final FocusNode focusNode;
  _PaymentMethod(this.label)
      : controller = TextEditingController(text: '0'),
        focusNode = FocusNode();

  double parse() => double.tryParse(
        controller.text.replaceAll(',', '.').replaceAll(' ', ''),
      ) ??
      0;

  void dispose() {
    controller.dispose();
    focusNode.dispose();
  }
}

class _PaymentScreenState extends State<PaymentScreen> {
  final _fs = FirestoreService();

  late final _PaymentMethod _cash;
  late final _PaymentMethod _card;
  late final _PaymentMethod _terminal;
  late final _PaymentMethod _comp;
  late final List<_PaymentMethod> _methods;

  // Поля, в которые уже перенесена сумма первым тапом (после этого поле
  // становится редактируемым — второй тап откроет клавиатуру).
  final Set<_PaymentMethod> _revealed = {};

  // Поля, в которых уже открывалась клавиатура хотя бы раз — чтобы
  // выделение текста (для замены одной цифрой) срабатывало только при
  // самом первом открытии клавиатуры, а не при каждом повторном тапе.
  final Set<_PaymentMethod> _editingStarted = {};

  final _contactCtrl = TextEditingController();

  bool _closeWithoutPayment = false;
  bool _printReceipt = false;
  bool _printFiscalReceipt = false;
  bool _busy = false;
  bool _terminalBusy = false;

  double get _total => widget.session.totalWithDiscount;

  @override
  void initState() {
    super.initState();
    _cash = _PaymentMethod('Наличными:');
    _card = _PaymentMethod('Банковской картой:');
    _terminal = _PaymentMethod('Оплата с терминала:');
    _comp = _PaymentMethod('За счёт заведения:');
    _methods = [_cash, _card, _terminal, _comp];

    // По умолчанию вся сумма — наличными: сотрудник просто переносит часть
    // на другой способ оплаты, если гость платит смешанно (как на кассе Restik).
    _cash.controller.text = _fmt(_total);

    for (final m in _methods) {
      m.controller.addListener(() => setState(() {}));
    }
  }

  @override
  void dispose() {
    for (final m in _methods) {
      m.dispose();
    }
    _contactCtrl.dispose();
    super.dispose();
  }

  /// Первый тап по полю: сумма к оплате переносится в поле, остальные
  /// способы оплаты обнуляются (иначе сумма задваивалась бы — была бы
  /// видна и в старом поле, и в новом), но клавиатура НЕ открывается и
  /// ничего не выделяется — поле в этот момент ещё доступно только на
  /// чтение (см. AbsorbPointer в _amountField).
  void _revealAmount(_PaymentMethod method) {
    setState(() {
      _revealed.add(method);
      for (final other in _methods) {
        if (other != method) other.controller.text = '0';
      }
      if (_total > 0.004) {
        method.controller.text = _fmt(_total);
      }
    });
  }

  /// Второй тап (и все последующие, пока не поменяли способ оплаты) —
  /// поле уже редактируемое, стандартный тап по TextField сам открывает
  /// клавиатуру. Отдельно нужно только один раз выделить текст целиком —
  /// при самом первом открытии клавиатуры для этого поля — так, чтобы
  /// первая же введённая цифра заменяла сумму, а не дописывалась к ней.
  /// Дальнейшие повторные тапы выделение уже не трогают — иначе было бы
  /// невозможно поправить сумму, кликнув в середину числа.
  void _onEditingTap(_PaymentMethod method) {
    if (_editingStarted.contains(method)) return;
    _editingStarted.add(method);
    method.controller.selection = TextSelection(
      baseOffset: 0,
      extentOffset: method.controller.text.length,
    );
  }

  String _fmt(double v) {
    if (v == v.roundToDouble()) return v.toStringAsFixed(0);
    return v.toStringAsFixed(2).replaceAll('.', ',');
  }

  double get _paidTotal => _methods.fold(0.0, (sum, m) => sum + m.parse());
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
    // Кнопка быстрой суммы сама выступает как "первый тап" — сумма уже
    // переносится в поле, поэтому дальнейший тап по полю "Наличными"
    // должен сразу открывать клавиатуру, а не заново сбрасывать сумму.
    _revealed.add(_cash);
    _cash.controller.text = _fmt(v);
  }

  /// Отправляет недостающую сумму на физический терминал (через
  /// [paymentTerminalService] — см. описание там про подключение
  /// реального банковского SDK) и, при успехе, подставляет сумму в поле
  /// "Оплата с терминала" сама — сотруднику останется только нажать
  /// "Оплатить" ниже, как обычно.
  Future<void> _payViaTerminal() async {
    if (_terminalBusy || _busy) return;
    final amount = _diff > 0.004 ? _diff : _total;
    if (amount <= 0) return;
    setState(() => _terminalBusy = true);
    try {
      final result = await paymentTerminalService.pay(amount);
      if (!mounted) return;
      if (result.success) {
        setState(() {
          _revealed.add(_terminal);
          _terminal.controller.text = _fmt(_terminal.parse() + amount);
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Оплата на терминале прошла успешно${result.maskedCardNumber != null ? ' · карта ${result.maskedCardNumber}' : ''}')),
        );
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Терминал отклонил операцию: ${result.errorMessage ?? 'неизвестная ошибка'}')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось связаться с терминалом: $e')));
      }
    } finally {
      if (mounted) setState(() => _terminalBusy = false);
    }
  }

  Future<void> _pay() async {
    if (!_canPay || _busy) return;
    setState(() => _busy = true);
    try {
      await _fs.closeSessionWithPayment(
        widget.session.id,
        widget.session.tableId,
        cash: _closeWithoutPayment ? 0 : _cash.parse(),
        card: _closeWithoutPayment ? 0 : _card.parse(),
        terminal: _closeWithoutPayment ? 0 : _terminal.parse(),
        comp: _closeWithoutPayment ? 0 : _comp.parse(),
        guestContact: _contactCtrl.text.trim(),
        closedWithoutPayment: _closeWithoutPayment,
        receiptPrinted: _printReceipt,
        fiscalReceiptPrinted: _printFiscalReceipt,
        orderItems: widget.session.orderItems,
        employeeName: widget.session.employeeName,
      );
      if (_printReceipt) await _printOnThermalPrinter();
      if (_printFiscalReceipt) await _sendToKassa();
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

  /// Печать информационного чека на маленьком чековом принтере (не
  /// фискальный — фискальный чек по-прежнему требует отдельной онлайн-кассы,
  /// см. переключатель "Распечатать фискальный чек" выше и README).
  /// Ошибка печати не должна мешать закрыть стол — гость и так уже
  /// оплатил, поэтому здесь только предупреждение, а не блокировка.
  Future<void> _printOnThermalPrinter() async {
    final printer = activeReceiptPrinter;
    if (printer == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Принтер не настроен — выберите его в Настройках → Интеграции'),
        ));
      }
      return;
    }
    try {
      final paidVia = _closeWithoutPayment
          ? 'Без оплаты'
          : [
              if (_cash.parse() > 0) 'наличные ${_cash.parse().toStringAsFixed(0)}₽',
              if (_card.parse() > 0) 'карта ${_card.parse().toStringAsFixed(0)}₽',
              if (_terminal.parse() > 0) 'терминал ${_terminal.parse().toStringAsFixed(0)}₽',
              if (_comp.parse() > 0) 'заведение ${_comp.parse().toStringAsFixed(0)}₽',
            ].join(', ');
      await printer.printReceipt(ReceiptData(
        venueName: 'Кальянная',
        tableName: widget.session.tableName,
        employeeName: widget.session.employeeName,
        closedAt: DateTime.now(),
        items: widget.session.orderItems
            .map((i) => ReceiptLine('${i.name} x${i.qty}', right: i.total.toStringAsFixed(0)))
            .toList(),
        total: _total,
        paymentMethod: paidVia.isEmpty ? 'Наличные' : paidVia,
      ));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось напечатать чек: $e')));
      }
    }
  }

  /// Отправка фискального чека в онлайн-кассу (54-ФЗ) — реальная
  /// фискализация происходит только тут; сам тумблер "Распечатать чек"
  /// выше печатает лишь информационную копию на маленьком принтере и не
  /// имеет отношения к 54-ФЗ. Пока не подключён реальный провайдер
  /// (см. Настройки → Интеграции), используется [MockKassaService] — чек
  /// нигде фактически не регистрируется, только имитируется успех, чтобы
  /// UI-поток можно было проверить целиком уже сейчас.
  Future<void> _sendToKassa() async {
    if (!kassaService.isAvailable) {
      _showKassaWarning('Касса не настроена — откройте Настройки → Интеграции');
      return;
    }
    try {
      final cz = ChestnyZnakService();
      final markingCodes = await cz.codesForReceipt(widget.session.id);
      // Лучшее сопоставление кода с позицией чека, какое возможно без
      // отдельного хранения "код -> позиция" на самой сессии: по названию
      // позиции меню, для которой этот код сканировался при добавлении
      // (см. menu_selection_screen._onScan). Если сопоставить не удалось —
      // код всё равно попадёт в чек отдельной строкой ниже, чтобы не
      // потерять его молча.
      final items = <FiscalReceiptItem>[];
      for (final line in widget.session.orderItems) {
        items.add(FiscalReceiptItem(
          name: line.name,
          price: line.price,
          quantity: line.qty.toDouble(),
        ));
      }

      final payments = <FiscalPayment>[
        if (!_closeWithoutPayment && _cash.parse() > 0) FiscalPayment('cash', _cash.parse()),
        if (!_closeWithoutPayment && _card.parse() > 0) FiscalPayment('card', _card.parse()),
        if (!_closeWithoutPayment && _terminal.parse() > 0) FiscalPayment('card', _terminal.parse()),
        if (!_closeWithoutPayment && _comp.parse() > 0) FiscalPayment('other', _comp.parse()),
        if (_closeWithoutPayment) FiscalPayment('other', _total),
      ];

      final result = await kassaService.sendReceipt(FiscalReceipt(
        receiptId: widget.session.id,
        items: items,
        payments: payments.isEmpty ? [FiscalPayment('cash', _total)] : payments,
        buyerContact: _contactCtrl.text.trim(),
      ));

      if (!result.success) {
        _showKassaWarning('Касса отклонила чек: ${result.errorMessage}');
      } else if (markingCodes.isNotEmpty) {
        // Успешная фискализация с кодами маркировки в чеке — именно этот
        // момент официально выводит их из оборота через ОФД → ИС МП.
        _showKassaWarning('Чек пробит, ${markingCodes.length} код(ов) маркировки списано');
      }
    } catch (e) {
      _showKassaWarning('Не удалось отправить чек в кассу: $e');
    }
  }

  void _showKassaWarning(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
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
              for (final m in _methods)
                _amountField(
                  m,
                  enabled: !_closeWithoutPayment,
                  trailing: m == _terminal ? _terminalPayButton() : null,
                ),
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

  /// Кнопка "Оплатить с терминала" — рядом с полем суммы способа
  /// "Оплата с терминала". Пока подключён [MockPaymentTerminalService],
  /// нажатие просто имитирует поход к терминалу с задержкой; после
  /// подключения реального банковского SDK поведение изменится само,
  /// без правок этого экрана.
  Widget _terminalPayButton() {
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: SizedBox(
        height: 40,
        width: 40,
        child: _terminalBusy
            ? const Padding(
                padding: EdgeInsets.all(8),
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : IconButton(
                onPressed: _closeWithoutPayment ? null : _payViaTerminal,
                tooltip: 'Оплатить с терминала',
                icon: const Icon(Icons.point_of_sale_outlined),
                style: IconButton.styleFrom(
                  backgroundColor: AppColors.surfaceElevated,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                ),
              ),
      ),
    );
  }

  Widget _amountField(_PaymentMethod method, {required bool enabled, Widget? trailing}) {
    final revealed = _revealed.contains(method);
    final field = TextField(
      controller: method.controller,
      focusNode: method.focusNode,
      enabled: enabled,
      // Пока сумма ещё не перенесена первым тапом, поле только на чтение —
      // это не даёт системе показать клавиатуру, даже если поле получит
      // фокус. После первого тапа (revealed == true) поле становится
      // обычным редактируемым.
      readOnly: !revealed,
      showCursor: revealed,
      onTap: revealed ? () => _onEditingTap(method) : null,
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
    );

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Expanded(child: Text(method.label, style: const TextStyle(fontSize: 16))),
          SizedBox(
            width: 180,
            child: GestureDetector(
              // Перехватываем самый первый тап поверх поля, пока оно ещё
              // read-only: AbsorbPointer ниже не даёт этому тапу дойти до
              // самого TextField (а значит — не даёт ему поймать фокус и
              // открыть клавиатуру), а этот обработчик просто переносит
              // сумму в поле. Как только сумма перенесена (revealed),
              // GestureDetector.onTap отключается и тапы идут напрямую в
              // TextField как обычно.
              behavior: HitTestBehavior.translucent,
              onTap: (!enabled || revealed) ? null : () => _revealAmount(method),
              child: AbsorbPointer(
                absorbing: enabled && !revealed,
                child: field,
              ),
            ),
          ),
          if (trailing != null) trailing,
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