import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../theme/app_colors.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../services/payment_terminal_service.dart';
import '../../services/printer_service.dart';
import '../../services/kassa_service.dart';
import '../../services/chestny_znak_service.dart';
import '../../services/venue_service.dart';
import '../../services/app_scope.dart';
import '../../models/fiscal_receipt.dart';
import '../../utils/adaptive.dart';
import '../../utils/constants.dart';
import '../../services/guest_link_service.dart';
import '../../services/referral_service.dart';
import '../../widgets/bonus_redeem_panel.dart';
import '../../services/tips_service.dart';
import '../../utils/human_error.dart';

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

  // Бонусы и сертификат уменьшают сумму к оплате ДО распределения по
  // способам оплаты: это уже оплаченные ранее деньги, а не выручка смены.
  // В чек они уходят в поле "за счёт заведения" (paymentComp), чтобы итог
  // сходился и X-отчёт не показывал недостачу.
  double _bonusPaid = 0;
  String _clientUid = '';

  /// Какие сертификаты и на какую сумму уже погашены на этом экране —
  /// нужно, чтобы вернуть деньги, если оплату так и не провели.

  /// Оплата проведена — списанные бонусы/сертификаты возврату не подлежат.
  bool _paidDone = false;

  /// Есть что возвращать, если кассир уйдёт с экрана, не оплатив.
  bool get _hasPendingRedemptions =>
      !_paidDone && _bonusPaid > 0;

  bool _closeWithoutPayment = false;
  bool _printReceipt = false;
  bool _printFiscalReceipt = false;
  bool _busy = false;
  bool _terminalBusy = false;

  /// Сумма, которую ещё нужно взять с гостя: счёт со скидкой минус
  /// списанные бонусы и сертификат.
  double get _total {
    final rest = widget.session.totalWithDiscount - _bonusPaid;
    return rest < 0 ? 0 : rest;
  }

  /// Чаевые, которые гость попросил добавить к счёту (из приложения) или
  /// которые кассир добавил здесь же. Берутся вместе с оплатой, но в
  /// выручку, фискальный чек и начисление бонусов не входят.
  List<TipModel> _tips = const [];
  StreamSubscription<List<TipModel>>? _tipsSub;
  double get _tipsTotal => _closeWithoutPayment ? 0 : _tips.fold(0.0, (a, t) => a + t.amount);

  /// Всего взять с гостя: счёт + чаевые.
  double get _due => _total + _tipsTotal;

  /// Чаевые берутся из живых денег — наличных, карты, терминала. «За счёт
  /// заведения» чаевые оплатить не может: это не деньги гостя.
  bool get _tipsCovered => _tipsSplit.uncovered < 0.005;

  /// Из каких денег взяты чаевые — см. splitTips.
  ({double cash, double card, double terminal, double uncovered}) get _tipsSplit => splitTips(
        tips: _tipsTotal,
        cash: _cashNet,
        card: _card.parse(),
        terminal: _terminal.parse(),
      );

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

    _tipsSub = TipsService.instance.sessionTipsStream(widget.session.id).listen((all) {
      if (!mounted) return;
      setState(() {
        _tips = all.where((t) => t.onBill).toList();
        // Пока кассир ничего не трогал руками, сумма «наличными» следит за
        // итогом: гость добавил чаевые из приложения — поле уже с ними.
        if (_revealed.isEmpty) {
          _cash.controller.text = _fmt(_due);
          for (final m in _methods) {
            if (m != _cash) m.controller.text = '0';
          }
        }
      });
    }, onError: (_) {});

    // Гость из «Colibri Lounge», сидящий за этим чеком, — нужен для
    // бонусов и реферальной программы. Если приложения у гостя нет,
    // панель бонусов просто предложит найти его по телефону.
    GuestLinkService().findBySession(widget.session.id).then((profile) {
      if (profile == null || !mounted) return;
      setState(() {
        _clientUid = profile.uid;
        // Телефон гостя уже известен приложению — не заставляем кассира
        // набирать его вручную ещё раз на чеке.
        if (_contactCtrl.text.isEmpty && profile.phone.isNotEmpty) {
          _contactCtrl.text = profile.phone;
        }
      });
    });
  }

  @override
  void dispose() {
    _tipsSub?.cancel();
    for (final m in _methods) {
      m.dispose();
    }
    _contactCtrl.dispose();
    super.dispose();
  }

  /// Возвращает гостю всё, что было списано на этом экране, но так и не
  /// пошло в оплату: бонусы и сертификаты.
  ///
  /// Списание происходит в момент нажатия «Списать» — это удобно кассиру
  /// (сумма к оплате сразу уменьшается), но означает, что выход с экрана
  /// без оплаты обязан вернуть деньги обратно. Раньше возврата не было:
  /// гость терял бонусы и остаток сертификата, а чек оставался открытым на
  /// полную сумму.
  Future<void> _rollbackRedemptions() async {
    final bonus = _bonusPaid;
    if (bonus <= 0) return;

    // Обнуляем локально сразу — повторный вызов (быстрый двойной «назад»)
    // не должен вернуть бонусы дважды.
    _bonusPaid = 0;

    try {
      if (bonus > 0 && _clientUid.isNotEmpty) {
        await GuestLinkService().refundBonuses(
          clientUid: _clientUid,
          sessionId: widget.session.id,
          amount: bonus,
        );
      }
    } catch (_) {
      // Сеть отвалилась — офлайн-кэш Firestore доотправит операции сам,
      // когда связь вернётся (инкременты для этого и выбраны).
    }
  }

  /// Уход с экрана без оплаты: сначала вернуть списанное, потом закрыть.
  Future<void> _leaveWithoutPaying() async {
    if (_busy) return;
    await _rollbackRedemptions();
    if (mounted) Navigator.of(context).pop(false);
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
      if (_due > 0.004) {
        method.controller.text = _fmt(_due);
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
  double get _diff => _due - _paidTotal;

  /// Сдача гостю: переплата, которую покрывают внесённые наличные (гость дал
  /// 5000 за чек 4600). Переплата картой или терминалом — это опечатка, а не
  /// сдача, и она по-прежнему не даёт провести оплату.
  double get _change {
    final over = _paidTotal - _due;
    return over > 0.004 && over <= _cash.parse() + 0.004 ? over : 0;
  }

  /// Наличные, которые остаются в кассе: внесено минус сдача. Именно эта
  /// сумма уходит в выручку, фискальный чек и начисление бонусов.
  double get _cashNet => _cash.parse() - _change;

  bool get _canPay =>
      _closeWithoutPayment || ((_diff.abs() < 0.01 || _change > 0) && _tipsCovered);

  /// Две подсказки быстрой суммы — округление вверх до сотни и до
  /// ближайшей "круглой" суммы. Удобно для приёма наличных и расчёта сдачи.
  List<double> get _quickAmounts {
    if (_due <= 0) return const [];
    final toHundred = (_due / 100).ceil() * 100.0;
    var toRound = (_due / 500).ceil() * 500.0;
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
    final amount = _diff > 0.004 ? _diff : _due;
    if (amount <= 0) return;
    setState(() => _terminalBusy = true);
    try {
      final result = await paymentTerminalService.pay(amount, context: context);
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
            .showSnackBar(SnackBar(content: Text('Не удалось связаться с терминалом: ${humanError(e, lower: true)}')));
      }
    } finally {
      if (mounted) setState(() => _terminalBusy = false);
    }
  }

  // Выручка по способам оплаты — без чаевых.
  double get _revenueCash => _cashNet - _tipsSplit.cash;
  double get _revenueCard => _card.parse() - _tipsSplit.card;
  double get _revenueTerminal => _terminal.parse() - _tipsSplit.terminal;

  Future<void> _pay() async {
    if (!_canPay || _busy) return;
    setState(() => _busy = true);
    try {
      final split = _tipsSplit;
      final tipsVia = split.cash >= _tipsTotal - 0.004
          ? 'cash'
          : split.cash < 0.004
              ? 'card'
              : 'mixed';
      await _fs.closeSessionWithPayment(
        widget.session.id,
        widget.session.tableId,
        cash: _closeWithoutPayment ? 0 : _revenueCash,
        card: _closeWithoutPayment ? 0 : _revenueCard,
        terminal: _closeWithoutPayment ? 0 : _revenueTerminal,
        comp: _closeWithoutPayment ? 0 : _comp.parse() + _bonusPaid,
        tipsPaidVia: _closeWithoutPayment ? const {} : {for (final t in _tips) t.id: tipsVia},
        tipsCancelled: _closeWithoutPayment ? [for (final t in _tips) t.id] : const [],
        tipsCash: _closeWithoutPayment ? 0 : split.cash,
        tipsCard: _closeWithoutPayment ? 0 : split.card + split.terminal,
        guestContact: _contactCtrl.text.trim(),
        closedWithoutPayment: _closeWithoutPayment,
        receiptPrinted: _printReceipt,
        fiscalReceiptPrinted: _printFiscalReceipt,
        orderItems: widget.session.orderItems,
        employeeName: widget.session.employeeName,
      );
      // Кешбэк и реферальная награда. Обе операции идемпотентны:
      // повторный вызов с тем же чеком ничего не начислит.
      if (_clientUid.isNotEmpty && !_closeWithoutPayment) {
        // Кешбэк начисляется ТОЛЬКО с реально полученных денег: наличные,
        // карта, терминал. Поле «за счёт заведения» сюда не входит — в нём
        // лежат в том числе сами бонусы и сертификат, и начисление с них
        // означало бы кешбэк с кешбэка (бонусы подпитывали сами себя, а
        // уровень лояльности рос за счёт заведения).
        final paid = _revenueCash + _revenueCard + _revenueTerminal;
        unawaited(GuestLinkService()
            .accrueBonuses(
              clientUid: _clientUid,
              sessionId: widget.session.id,
              paidAmount: paid,
              // Уровень лояльности двигает полная сумма чека, а не только
              // живые деньги: иначе гость, закрывший часть счёта бонусами,
              // поднимался бы к Золоту медленнее того, кто бонусами не
              // пользуется.
              billTotal: widget.session.totalWithDiscount,
              tableName: widget.session.tableName,
              bonusSpent: _bonusPaid,
              items: widget.session.orderItems,
            )
            .then((_) => ReferralService.instance.rewardIfFirstVisit(_clientUid)));
      }
      _paidDone = true; // списанные бонусы/сертификаты ушли в оплату
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
              if (_change > 0) 'сдача ${_change.toStringAsFixed(0)}₽',
              if (_card.parse() > 0) 'карта ${_card.parse().toStringAsFixed(0)}₽',
              if (_terminal.parse() > 0) 'терминал ${_terminal.parse().toStringAsFixed(0)}₽',
              if (_comp.parse() > 0) 'заведение ${_comp.parse().toStringAsFixed(0)}₽',
              if (_bonusPaid > 0) 'бонусы ${_bonusPaid.toStringAsFixed(0)}₽',
              if (_tipsTotal > 0) 'в т.ч. чаевые ${_tipsTotal.toStringAsFixed(0)}₽',
            ].join(', ');
      var venueName = VenueService.instance.cached.name.trim();
      if (venueName.isEmpty) {
        try {
          venueName = (await VenueService.instance.load()).name.trim();
        } catch (_) {}
      }
      if (venueName.isEmpty) venueName = AppScope.branding?.appName.trim() ?? '';
      await printer.printReceipt(ReceiptData(
        venueName: venueName.isEmpty ? 'Кальянная' : venueName,
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
            .showSnackBar(SnackBar(content: Text('Не удалось напечатать чек: ${humanError(e, lower: true)}')));
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
      final markingCodes = await cz.codesForReceiptDetailed(widget.session.id);
      // Группируем отсканированные коды по menuItemId — каждая штука
      // маркированного товара должна попасть в чек ОТДЕЛЬНОЙ строкой с
      // quantity=1 и своим кодом в теге 1162 (так требует ФФД, нельзя
      // "размазать" один код на несколько единиц в одной строке).
      final codesByMenuItem = <String, List<AttachedMarkingCode>>{};
      for (final entry in markingCodes) {
        if (entry.menuItemId.isEmpty) continue;
        codesByMenuItem.putIfAbsent(entry.menuItemId, () => []).add(entry);
      }
      // Ставка НДС и предмет расчёта — из карточки позиции меню (или
      // ставка заведения по умолчанию).
      final menu = await _fs.menuItemsByIds(
          widget.session.orderItems.map((l) => l.menuItemId).where((id) => id.isNotEmpty).toSet());
      FiscalVatRate vatOf(OrderItem line) {
        final own = menu[line.menuItemId]?.vat ?? '';
        return own.isEmpty ? kassaDefaultVat : FiscalVatRateX.fromId(own, fallback: kassaDefaultVat);
      }

      FiscalPaymentObject subjectOf(OrderItem line) =>
          FiscalPaymentObjectX.fromId(menu[line.menuItemId]?.fiscalSubject);

      // Цены позиций в фискальном чеке должны быть УЖЕ со скидкой.
      // Раньше позиции уходили по полному прайсу, а платежи — по факту
      // (то есть со скидкой), и итог чека не сходился с итогом платежей:
      // реальная касса такой чек отклоняет, а mock молча «пробивал»
      // неправильный документ. Скидка процентная, поэтому достаточно
      // умножить цену каждой позиции — сумма сойдётся копейка в копейку.
      final discountK = 1 - widget.session.discountPercent / 100;
      double priceOf(OrderItem line) =>
          double.parse((line.price * discountK).toStringAsFixed(2));

      final items = <FiscalReceiptItem>[];
      for (final line in widget.session.orderItems) {
        final codes = List<AttachedMarkingCode>.from(codesByMenuItem[line.menuItemId] ?? const []);
        // Столько единиц позиции промаркировано отсканированными кодами —
        // на них заводим отдельные строки chek'а с markingCode.
        final markedCount = codes.length.clamp(0, line.qty);
        for (var i = 0; i < markedCount; i++) {
          items.add(FiscalReceiptItem(
            name: line.name,
            price: priceOf(line),
            quantity: 1,
            vat: vatOf(line),
            paymentObject: subjectOf(line),
            markingCode: codes[i].code.raw,
            markingPermit: codes[i].permit,
          ));
        }
        // Остаток количества этой позиции (не покрытый сканированием —
        // например, официант выбрал позицию из меню тапом, а не сканером)
        // идёт обычной строкой без кода. Если для этой позиции маркировка
        // обязательна ([InventoryItem.isMarked]), такой остаток означает,
        // что часть проданного товара не была отсканирована и официально
        // не выведена из оборота — это не может починить код, только
        // организационно (обязательное сканирование каждой единицы).
        final rest = line.qty - markedCount;
        if (rest > 0) {
          items.add(FiscalReceiptItem(
            name: line.name,
            price: priceOf(line),
            quantity: rest.toDouble(),
            vat: vatOf(line),
            paymentObject: subjectOf(line),
          ));
        }
      }

      // Итог платежей обязан совпасть с итогом позиций (сумма чека со
      // скидкой). Бонусы и сертификат — это деньги, полученные заведением
      // РАНЬШЕ, поэтому по ФФД они идут отдельным видом расчёта
      // «предоплата» (тег 1215), а не теряются, как было до этого.
      final prepaid = _bonusPaid;
      final billTotal = widget.session.totalWithDiscount;
      final payments = <FiscalPayment>[
        if (_closeWithoutPayment)
          FiscalPayment('other', billTotal)
        else ...[
          // Чаевые — не выручка и в фискальный чек не входят.
          if (_revenueCash > 0.004) FiscalPayment('cash', _revenueCash),
          if (_revenueCard > 0.004) FiscalPayment('card', _revenueCard),
          if (_revenueTerminal > 0.004) FiscalPayment('card', _revenueTerminal),
          if (_comp.parse() > 0) FiscalPayment('other', _comp.parse()),
          if (prepaid > 0) FiscalPayment('prepayment', prepaid),
        ],
      ];

      final draft = FiscalReceipt(receiptId: widget.session.id, items: items, payments: const []);
      final balanced = balancePayments(payments, draft.total);
      final result = await kassaService.sendReceipt(FiscalReceipt(
        receiptId: widget.session.id,
        items: items,
        payments: balanced.isEmpty ? [FiscalPayment('cash', draft.total)] : balanced,
        buyerContact: _contactCtrl.text.trim(),
      ));

      if (!result.success) {
        _showKassaWarning('Касса отклонила чек: ${result.errorMessage}');
      } else {
        if (result.pending) {
          // Касса приняла чек, но итоговый ФД ещё не подтверждён (обычно
          // догоняет за секунды-минуты) — это не ошибка, просто кассир не
          // должен думать, что чек потерялся.
          _showKassaWarning('Чек принят кассой, номер ФД уточняется');
        }
        if (markingCodes.isNotEmpty) {
          // Успешная фискализация с кодами маркировки в чеке — именно этот
          // момент официально выводит их из оборота через ОФД → ИС МП.
          _showKassaWarning('Чек пробит, ${markingCodes.length} код(ов) маркировки списано');
        }
      }
    } catch (e) {
      _showKassaWarning('Не удалось отправить чек в кассу: ${humanError(e, lower: true)}');
    }
  }

  void _showKassaWarning(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      // Пока на экране есть списанные, но не оплаченные бонусы/сертификат,
      // выход перехватываем: сначала возвращаем деньги гостю, потом
      // закрываем экран. Работает и для системной кнопки «назад», и для
      // жеста, и для стрелки в AppBar.
      canPop: !_hasPendingRedemptions,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        unawaited(_leaveWithoutPaying());
      },
      child: _buildScaffold(context),
    );
  }

  Widget _buildScaffold(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: BackButton(onPressed: () => Navigator.of(context).maybePop(false)),
        title: const Text('Назад'),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          // На планшете — колонка по центру, а не суммы на весь экран.
          padding: centeredListPadding(context, maxWidth: 680, horizontal: 20, top: 20, bottom: 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('К оплате: ${_fmt(_due)} ${AppConstants.currencySymbol}',
                  style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w500)),
              if (_tipsTotal > 0)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    'счёт ${_fmt(_total)} + чаевые ${_fmt(_tipsTotal)}',
                    style: const TextStyle(color: AppColors.textMuted, fontSize: 14),
                  ),
                ),
              if (_bonusPaid > 0)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    [
                      if (_bonusPaid > 0) 'бонусами ${_fmt(_bonusPaid)}',
                    ].join(', '),
                    style: const TextStyle(color: AppColors.success, fontSize: 14),
                  ),
                ),
              const SizedBox(height: 16),
              if (!_closeWithoutPayment) ...[
                BonusRedeemPanel(
                  sessionId: widget.session.id,
                  billTotal: _total,
                  onApplied: (applied, profile) {
                    setState(() {
                      _bonusPaid += applied;
                      _clientUid = profile.uid;
                      // Пересобираем поле "наличными": гость доплачивает
                      // уже уменьшенную сумму.
                      _cash.controller.text = _fmt(_due);
                      for (final m in _methods) {
                        if (m != _cash) m.controller.text = '0';
                      }
                    });
                  },
                ),
                const SizedBox(height: 12),
                const Divider(height: 28),
              ],
              if (!_closeWithoutPayment) _tipsSection(),
              for (final m in _methods)
                _amountField(
                  m,
                  enabled: !_closeWithoutPayment,
                  trailing: m == _terminal ? _terminalPayButton() : null,
                ),
              if (_quickAmounts.isNotEmpty && !_closeWithoutPayment)
                Padding(
                  padding: const EdgeInsets.only(top: 4, bottom: 4),
                  child: Wrap(
                    runSpacing: 4,
                    children: _quickAmounts.map((v) {
                      return Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: OutlinedButton(
                          style: OutlinedButton.styleFrom(
                            shape: const StadiumBorder(),
                            side: const BorderSide(color: AppColors.textMuted),
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
                        : _change > 0
                            ? 'Сдача ${_fmt(_change)} ${AppConstants.currencySymbol}'
                            : 'Переплата ${_fmt(-_diff)} ${AppConstants.currencySymbol} — сдачу можно дать только из наличных',
                    style: TextStyle(
                      color: _diff > 0 || _change == 0 ? AppColors.danger : AppColors.success,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              if (!_closeWithoutPayment && !_tipsCovered && _diff.abs() < 0.01)
                const Padding(
                  padding: EdgeInsets.only(top: 4, bottom: 4),
                  child: Text(
                    'Чаевые нельзя провести «за счёт заведения» — их платит гость',
                    style: TextStyle(color: AppColors.danger, fontWeight: FontWeight.w500),
                  ),
                ),
              // Быстрые суммы и «сдача» — сразу под полями оплаты, к которым
              // относятся; контакт для электронного чека — после них.
              _contactField(),
              const Divider(height: 28),
              // Переключение в «без оплаты» обязано вернуть уже списанные
              // бонусы/сертификат: чек закрывается за счёт заведения, а не
              // деньгами гостя, и они не должны сгореть.
              _toggleRow('Закрыть без оплаты', _closeWithoutPayment, (v) async {
                if (v && _hasPendingRedemptions) await _rollbackRedemptions();
                if (mounted) setState(() => _closeWithoutPayment = v);
              }),
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

  /// Чаевые к этому счёту: что гость добавил из приложения, плюс кнопка
  /// «+ Чаевые» — гость сказал вслух «добавьте 10% официанту».
  Widget _tipsSection() {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final t in _tips)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(
                children: [
                  const Icon(Icons.volunteer_activism, size: 18, color: AppColors.success),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Чаевые ${t.isTeam ? 'всей смене' : t.recipientLabel}: ${_fmt(t.amount)} ${AppConstants.currencySymbol}'
                      '${t.source == 'guest' ? ' · из приложения' : ''}',
                      style: const TextStyle(fontSize: 15),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Убрать чаевые',
                    icon: const Icon(Icons.close, size: 20),
                    onPressed: () => TipsService.instance.cancel(t.id),
                  ),
                ],
              ),
            ),
          if (VenueService.instance.cached.tipsEnabled || _tips.isNotEmpty)
            TextButton.icon(
              style: TextButton.styleFrom(minimumSize: const Size(0, 40)),
              onPressed: _addTip,
              icon: const Icon(Icons.add),
              label: const Text('Добавить чаевые'),
            ),
        ],
      ),
    );
  }

  Future<void> _addTip() async {
    List<TipTeamMember> team;
    try {
      team = await TipsService.instance.team();
    } catch (_) {
      team = const [];
    }
    // Смену никто не отмечал — предлагаем хотя бы того, кто открыл стол.
    if (team.isEmpty && widget.session.employeeName.trim().isNotEmpty) {
      team = [TipTeamMember(id: widget.session.employeeId, name: widget.session.employeeName.trim())];
    }
    if (!mounted) return;
    final result = await showDialog<({TipTeamMember? to, double amount})>(
      context: context,
      builder: (ctx) => _AddTipDialog(team: team, bill: _total, fmt: _fmt),
    );
    if (result == null || result.amount <= 0) return;
    try {
      await TipsService.instance.leaveTip(
        amount: result.amount,
        to: result.to,
        team: result.to == null ? team.where((m) => m.id.isNotEmpty).toList() : const [],
        sessionId: widget.session.id,
        tableName: widget.session.tableName,
        source: 'pos',
      );
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Не удалось добавить чаевые — проверьте интернет')));
      }
    }
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
          borderSide: const BorderSide(color: AppColors.textMuted),
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
                // Не «0», как у сумм выше: поле необязательное и не денежное —
                // сюда касса отправит электронный чек.
                hintText: 'необязательно',
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                filled: true,
                fillColor: AppColors.surface,
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(6),
                  borderSide: const BorderSide(color: AppColors.textMuted),
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

  /// Переключается нажатием на всю строку, а не только на сам маленький
  /// переключатель — на планшете в спешке по нему легко промахнуться.
  Widget _toggleRow(String label, bool value, void Function(bool) onChanged) {
    return MergeSemantics(
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => onChanged(!value),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(child: Text(label, style: const TextStyle(fontSize: 16))),
              Switch(value: value, onChanged: onChanged),
            ],
          ),
        ),
      ),
    );
  }
}

/// Кому и сколько чаевых добавить к счёту (кассир вводит со слов гостя).
class _AddTipDialog extends StatefulWidget {
  final List<TipTeamMember> team;
  final double bill;
  final String Function(double) fmt;
  const _AddTipDialog({required this.team, required this.bill, required this.fmt});

  @override
  State<_AddTipDialog> createState() => _AddTipDialogState();
}

class _AddTipDialogState extends State<_AddTipDialog> {
  final _amount = TextEditingController();

  /// id получателя; '' — всей смене.
  late String _to = widget.team.length == 1 ? widget.team.first.id : '';

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final amount = double.tryParse(_amount.text.replaceAll(',', '.').trim()) ?? 0;
    return AlertDialog(
      scrollable: true,
      title: const Text('Чаевые к счёту'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            DropdownButtonFormField<String>(
              initialValue: _to,
              decoration: const InputDecoration(labelText: 'Кому'),
              items: [
                if (widget.team.length != 1) const DropdownMenuItem(value: '', child: Text('Всей смене (поровну)')),
                for (final m in widget.team)
                  DropdownMenuItem(
                    value: m.id,
                    child: Text([
                      m.name,
                      AppConstants.positionGuestLabel(m.position),
                    ].where((e) => e.isNotEmpty).join(' · ')),
                  ),
              ],
              onChanged: (v) => setState(() => _to = v ?? ''),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _amount,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9,.]'))],
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(labelText: 'Сумма', suffixText: '₽'),
            ),
            if (widget.bill > 0) ...[
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                children: [
                  for (final p in const [5, 10, 15])
                    ActionChip(
                      label: Text('$p% · ${widget.fmt(tipFromPercent(widget.bill, p))}'),
                      onPressed: () => setState(
                          () => _amount.text = widget.fmt(tipFromPercent(widget.bill, p))),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
        FilledButton(
          onPressed: amount <= 0
              ? null
              : () {
                  final to = widget.team.where((m) => m.id == _to && _to.isNotEmpty).firstOrNull;
                  Navigator.pop(context, (to: to, amount: amount));
                },
          child: const Text('Добавить'),
        ),
      ],
    );
  }
}
