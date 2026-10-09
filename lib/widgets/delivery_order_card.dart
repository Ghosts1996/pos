import 'package:flutter/material.dart';

import '../models/delivery_status.dart';
import '../models/employee.dart';
import '../models/session_model.dart';
import '../services/firestore_service.dart';
import '../theme/app_colors.dart';
import '../utils/human_error.dart';
import '../utils/money.dart';
import '../utils/phone_utils.dart';

/// Заказ с собой или доставка: кто, куда, как платит, статус и следующий
/// шаг. Заказ из приложения гостя ждёт звонка — сотрудник звонит, сверяет
/// адрес и состав и подтверждает (или отклоняет с причиной: её увидит гость).
class DeliveryOrderCard extends StatefulWidget {
  final SessionModel session;
  final Employee employee;

  /// В списке «С собой и доставка» — короче, без лишних подсказок.
  final bool compact;

  const DeliveryOrderCard({super.key, required this.session, required this.employee, this.compact = false});

  @override
  State<DeliveryOrderCard> createState() => _DeliveryOrderCardState();
}

class _DeliveryOrderCardState extends State<DeliveryOrderCard> {
  bool _busy = false;

  SessionModel get s => widget.session;

  Future<void> _run(Future<void> Function() job, {String? done}) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await job();
      if (done != null && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done)));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanError(e))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _accept() => _run(
        () => FirestoreService().acceptAppOrder(s, employeeName: widget.employee.name, employeeId: widget.employee.id),
        done: 'Заказ подтверждён — позиции в чеке, кухня видит заказ',
      );

  Future<void> _cancel() async {
    final reason = await showDialog<String>(context: context, builder: (_) => _CancelDialog(paid: s.guestPaidTotal));
    if (reason == null || !mounted) return;
    await _run(
      () => FirestoreService().cancelDeliveryOrder(s.id, reason: reason, employeeName: widget.employee.name),
      done: s.guestPaidTotal > 0
          ? 'Заказ отменён. Верните гостю ${rub(s.guestPaidTotal)} в кабинете банка'
          : 'Заказ отменён — гость увидит причину',
    );
  }

  Future<void> _advance() async {
    final to = DeliveryFlow.next(s.orderType, s.deliveryStatus);
    if (to == null) return;
    var courier = '';
    if (to == 'courier') {
      final ctrl = TextEditingController();
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Кто везёт заказ?'),
          content: TextField(
            controller: ctrl,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Курьер (необязательно)'),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Передать')),
          ],
        ),
      );
      courier = ctrl.text.trim();
      ctrl.dispose();
      if (ok != true) return;
    }
    await _run(() => FirestoreService().setDeliveryStatus(s.id, to, courierName: courier));
  }

  @override
  Widget build(BuildContext context) {
    final delivery = s.orderType == 'delivery';
    final status = DeliveryFlow.normalize(s.orderType, s.deliveryStatus);
    final awaitingCall = s.fromApp && status == 'new';
    final waited = DateTime.now().difference(s.startTime).inMinutes;
    final name = s.customerName.isNotEmpty ? s.customerName : s.guestTag;
    final muted = TextStyle(color: AppColors.textMuted, fontSize: widget.compact ? 12 : 13);

    final payment = s.guestPaidTotal > 0
        ? ('Оплачено онлайн: ${rub(s.guestPaidTotal)}', Colors.green)
        : s.payMethod == 'online'
            ? ('Оплатит онлайн после подтверждения', AppColors.textMuted)
            : s.payMethod == 'on_receipt'
                ? ('Оплата при получении', AppColors.textMuted)
                : null;

    return Container(
      padding: EdgeInsets.all(widget.compact ? 12 : 16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: awaitingCall ? AppColors.primary : AppColors.border, width: awaitingCall ? 1.5 : 1),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(delivery ? Icons.delivery_dining_rounded : Icons.shopping_bag_outlined,
                  size: widget.compact ? 24 : 30, color: AppColors.primary),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  [delivery ? 'Доставка' : 'С собой', if (name.isNotEmpty) name].join(' · '),
                  style: TextStyle(fontSize: widget.compact ? 16 : 18, fontWeight: FontWeight.w700),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (s.fromApp)
                const Padding(
                  padding: EdgeInsets.only(left: 6),
                  child: Chip(
                    visualDensity: VisualDensity.compact,
                    avatar: Icon(Icons.phone_iphone, size: 16),
                    label: Text('Приложение'),
                  ),
                ),
            ],
          ),
          if (s.customerPhone.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: InkWell(
                onTap: () => callGuest(context, s.customerPhone),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.call, size: 18, color: AppColors.primary),
                    const SizedBox(width: 6),
                    Text(formatPhone(s.customerPhone),
                        style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.primary)),
                  ],
                ),
              ),
            ),
          if (s.deliveryAddress.isNotEmpty)
            Padding(padding: const EdgeInsets.only(top: 4), child: Text(s.deliveryAddress)),
          if (s.deliveryComment.isNotEmpty)
            Padding(padding: const EdgeInsets.only(top: 4), child: Text('«${s.deliveryComment}»', style: muted)),
          if (payment != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(payment.$1,
                  style: TextStyle(color: payment.$2, fontWeight: FontWeight.w600, fontSize: widget.compact ? 12 : 13)),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              [
                waited < 1 ? 'только что' : '$waited мин назад',
                if (s.status == 'closed') 'чек закрыт',
                if (s.totalWithDiscount > 0) rub(s.totalWithDiscount),
              ].join(' · '),
              style: muted,
            ),
          ),
          if (awaitingCall && !widget.compact)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                'Позвоните гостю: сверьте состав, адрес и время. После подтверждения позиции встанут в чек, '
                'гость увидит «Принят». Если гость выбрал оплату онлайн — кнопка оплаты появится у него сразу.',
                style: TextStyle(fontSize: 13),
              ),
            ),
          if (s.guestPaidTotal > 0 && s.status == 'active' && !widget.compact)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                'Заказ оплачен заранее — закройте чек кнопкой «Оплата» сейчас: чек уйдёт гостю на телефон '
                '(54-ФЗ), а заказ останется в «С собой и доставка» до выдачи.',
                style: TextStyle(fontSize: 13),
              ),
            ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Chip(
                visualDensity: VisualDensity.compact,
                label: Text(DeliveryFlow.label(s.orderType, s.deliveryStatus) +
                    (s.courierName.isNotEmpty ? ' · ${s.courierName}' : '')),
              ),
              if (awaitingCall) ...[
                FilledButton.icon(
                  onPressed: _busy ? null : _accept,
                  icon: const Icon(Icons.check),
                  label: const Text('Подтвердить'),
                ),
                OutlinedButton(onPressed: _busy ? null : _cancel, child: const Text('Отклонить')),
              ] else ...[
                if (DeliveryFlow.actionLabel(s.orderType, s.deliveryStatus) != null)
                  FilledButton.tonal(
                    onPressed: _busy ? null : _advance,
                    child: Text(DeliveryFlow.actionLabel(s.orderType, s.deliveryStatus)!),
                  ),
                if (DeliveryFlow.canCancel(s.orderType, s.deliveryStatus))
                  TextButton(onPressed: _busy ? null : _cancel, child: const Text('Отменить')),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

/// Причина отмены — её увидит гость в приложении.
class _CancelDialog extends StatefulWidget {
  final double paid;
  const _CancelDialog({required this.paid});

  @override
  State<_CancelDialog> createState() => _CancelDialogState();
}

class _CancelDialogState extends State<_CancelDialog> {
  static const _reasons = [
    'Не дозвонились до гостя',
    'Гость передумал',
    'Нет части позиций',
    'Не доставляем по этому адресу',
    'Заведение скоро закрывается',
  ];
  String _reason = _reasons.first;
  final _other = TextEditingController();

  @override
  void dispose() {
    _other.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      scrollable: true,
      title: const Text('Отменить заказ?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (widget.paid > 0)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                'Гость уже оплатил ${rub(widget.paid)} онлайн. После отмены верните деньги в личном кабинете '
                'банка (возврат платежа) и пробейте чек возврата, если чек прихода уже был.',
                style: const TextStyle(color: Colors.orange),
              ),
            ),
          RadioGroup<String>(
            groupValue: _reason,
            onChanged: (v) => setState(() => _reason = v ?? _reason),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final r in _reasons) RadioListTile<String>(dense: true, title: Text(r), value: r),
                const RadioListTile<String>(dense: true, title: Text('Другая причина'), value: ''),
              ],
            ),
          ),
          if (_reason.isEmpty)
            TextField(
              controller: _other,
              autofocus: true,
              maxLength: 120,
              decoration: const InputDecoration(labelText: 'Причина — её увидит гость'),
            ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Не отменять')),
        FilledButton(
          onPressed: () {
            final r = _reason.isEmpty ? _other.text.trim() : _reason;
            if (r.isEmpty) return;
            Navigator.pop(context, r);
          },
          child: const Text('Отменить заказ'),
        ),
      ],
    );
  }
}
