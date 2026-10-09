import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

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
    var courier = (name: '', phone: '');
    if (to == 'courier') {
      final picked = await showDialog<({String name, String phone})>(
        context: context,
        builder: (_) => const _CourierDialog(),
      );
      if (picked == null) return;
      courier = picked;
    }
    await _run(() => FirestoreService()
        .setDeliveryStatus(s.id, to, courierName: courier.name, courierPhone: courier.phone));
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
                  ['${delivery ? 'Доставка' : 'С собой'} №${s.orderLabel}', if (name.isNotEmpty) name].join(' · '),
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

/// «Кто везёт заказ?»: имя и рабочий телефон курьера — гость увидит кнопку
/// «Позвонить курьеру», пока заказ в пути. Недавние курьеры — чипами, чтобы
/// не набирать заново (хранятся только на этом устройстве).
class _CourierDialog extends StatefulWidget {
  const _CourierDialog();

  @override
  State<_CourierDialog> createState() => _CourierDialogState();
}

class _CourierDialogState extends State<_CourierDialog> {
  static const _prefsKey = 'recent_couriers_v1';
  final _name = TextEditingController();
  final _phone = TextEditingController();
  List<({String name, String phone})> _recent = const [];
  String? _phoneError;

  @override
  void initState() {
    super.initState();
    _loadRecent();
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _loadRecent() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getStringList(_prefsKey) ?? const [];
      final list = [
        for (final r in raw)
          if (jsonDecode(r) case {'name': final String n, 'phone': final String p}) (name: n, phone: p),
      ];
      if (mounted) setState(() => _recent = list);
    } catch (_) {}
  }

  Future<void> _remember(({String name, String phone}) c) async {
    if (c.name.isEmpty && c.phone.isEmpty) return;
    try {
      final list = [c, ..._recent.where((r) => r.name != c.name || r.phone != c.phone)].take(6);
      await (await SharedPreferences.getInstance())
          .setStringList(_prefsKey, [for (final r in list) jsonEncode({'name': r.name, 'phone': r.phone})]);
    } catch (_) {}
  }

  void _submit() {
    final raw = _phone.text.trim();
    final problem = raw.isEmpty ? null : phoneProblem(raw);
    if (problem != null) {
      setState(() => _phoneError = problem);
      return;
    }
    final c = (name: _name.text.trim(), phone: raw.isEmpty ? '' : normalizePhone(raw));
    _remember(c);
    Navigator.pop(context, c);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      scrollable: true,
      title: const Text('Кто везёт заказ?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_recent.isNotEmpty) ...[
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final r in _recent)
                  ActionChip(
                    label: Text(r.name.isEmpty ? formatPhone(r.phone) : r.name),
                    onPressed: () => setState(() {
                      _name.text = r.name;
                      _phone.text = r.phone.isEmpty ? '' : formatPhone(r.phone);
                      _phoneError = null;
                    }),
                  ),
              ],
            ),
            const SizedBox(height: 14),
          ],
          TextField(
            controller: _name,
            autofocus: _recent.isEmpty,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Курьер (необязательно)'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            onChanged: (_) {
              if (_phoneError != null) setState(() => _phoneError = null);
            },
            decoration: InputDecoration(
              labelText: 'Телефон курьера (необязательно)',
              helperText: 'Гость сможет позвонить курьеру, пока заказ в пути. Укажите рабочий '
                  'номер; личный — только с письменного согласия курьера.',
              helperMaxLines: 4,
              errorText: _phoneError,
              errorMaxLines: 3,
            ),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
        FilledButton(onPressed: _submit, child: const Text('Передать')),
      ],
    );
  }
}
