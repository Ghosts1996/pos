import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../models/client_models.dart';
import '../../models/delivery_status.dart';
import '../../models/session_model.dart';
import '../../models/venue_models.dart';
import '../../services/venue_service.dart';
import '../../utils/money.dart';
import '../services/delivery_order_service.dart';
import '../services/kolibri_auth_service.dart';
import '../theme/kolibri_theme.dart';
import '../widgets/guest_sbp_pay_card.dart';

/// Заказ доставки или с собой глазами гостя: статус шаг за шагом, состав,
/// оплата онлайн после подтверждения, отмена, пока заказ ещё не приняли.
class KolibriOrderScreen extends StatelessWidget {
  final String sessionId;
  const KolibriOrderScreen({super.key, required this.sessionId});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Заказ №${orderNumber(sessionId)}')),
      body: StreamBuilder<SessionModel?>(
        stream: DeliveryOrderService.instance.order(sessionId),
        builder: (context, snap) {
          final s = snap.data;
          if (s == null) {
            return Center(
              child: snap.connectionState == ConnectionState.waiting
                  ? const CircularProgressIndicator()
                  : Text('Заказ не найден', style: TextStyle(color: KolibriColors.textMuted)),
            );
          }
          return ValueListenableBuilder<VenueProfile>(
            valueListenable: VenueService.instance.notifier,
            builder: (context, venue, _) => _OrderBody(order: s, venue: venue),
          );
        },
      ),
    );
  }
}

class _OrderBody extends StatelessWidget {
  final SessionModel order;
  final VenueProfile venue;
  const _OrderBody({required this.order, required this.venue});

  String _hint(String status) {
    final delivery = order.orderType == 'delivery';
    switch (status) {
      case 'new':
        return 'Заказ получен. Заведение позвонит вам, чтобы подтвердить состав'
            '${delivery ? ' и адрес' : ''} — держите телефон рядом.';
      case 'accepted':
        return 'Заказ подтверждён и скоро начнут готовить.';
      case 'cooking':
        return 'Готовим ваш заказ.';
      case 'courier':
        return 'Курьер ${order.courierName.isNotEmpty ? '${order.courierName} ' : ''}в пути.';
      case 'ready':
        return 'Заказ готов — можно забирать${venue.address.isNotEmpty ? ': ${venue.address}' : ''}.';
      case 'done':
        return delivery ? 'Заказ доставлен. Приятного аппетита!' : 'Заказ выдан. Приятного аппетита!';
      case 'cancelled':
        return 'Заказ отменён${order.cancelReason.isNotEmpty ? ': ${order.cancelReason}' : ''}.';
    }
    return '';
  }

  Future<void> _cancel(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Отменить заказ?'),
        content: const Text('Заведение ещё не подтвердило заказ — его можно отменить без звонка.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Нет')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Отменить')),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    try {
      await DeliveryOrderService.instance.cancel(order.id);
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  @override
  Widget build(BuildContext context) {
    final type = order.orderType;
    final status = DeliveryFlow.normalize(type, order.deliveryStatus);
    final path = DeliveryFlow.path(type);
    final current = path.indexOf(status);
    final cancelled = status == 'cancelled';
    final paidOnline = order.guestPaidTotal > 0;

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 40),
      children: [
        Text(type == 'delivery' ? 'Доставка' : 'С собой', style: KolibriFonts.display(30)),
        const SizedBox(height: 6),
        Text(_hint(status), style: TextStyle(color: cancelled ? Colors.redAccent : KolibriColors.textMuted, height: 1.4)),
        const SizedBox(height: 18),
        if (!cancelled)
          for (var i = 0; i < path.length; i++)
            _Step(
              label: i == 0 ? 'Ждёт подтверждения' : DeliveryFlow.label(type, path[i]),
              done: i < current || status == 'done',
              active: i == current && status != 'done',
              last: i == path.length - 1,
            ),
        const SizedBox(height: 12),
        _Items(order: order),
        const SizedBox(height: 16),
        if (!cancelled && order.payMethod == 'online' && status != 'done') ...[
          if (status == 'new')
            const _Note('Оплата онлайн станет доступна сразу после подтверждения заказа.')
          else if (paidOnline && order.totalWithDiscount > 0 && order.guestPaidTotal + 0.01 >= order.totalWithDiscount)
            _Note('Оплачено онлайн: ${rub(order.guestPaidTotal)}. Чек — от заведения.')
          else if (venue.onlinePayReady)
            GuestSbpPayCard(sessionId: order.id, paidAlready: order.guestPaidTotal, provider: venue.onlinePay, takeaway: true)
          else
            const _Note('Онлайн-оплата сейчас недоступна — оплатите при получении.'),
        ],
        if (!cancelled && order.payMethod != 'online' && status != 'done')
          _Note(type == 'delivery'
              ? 'Оплата при получении — наличными или картой курьеру.'
              : 'Оплата при получении — на кассе заведения.'),
        const SizedBox(height: 12),
        if (status == 'new' && !paidOnline)
          OutlinedButton.icon(
            onPressed: () => _cancel(context),
            icon: const Icon(Icons.close),
            label: const Text('Отменить заказ'),
          ),
        if (venue.phone.isNotEmpty) ...[
          const SizedBox(height: 8),
          TextButton.icon(
            onPressed: () => launchUrl(Uri.parse('tel:${venue.phone.replaceAll(RegExp(r'[^\d+]'), '')}')),
            icon: const Icon(Icons.call),
            label: Text('Позвонить в заведение · ${venue.phone}'),
          ),
        ],
      ],
    );
  }
}

class _Items extends StatelessWidget {
  final SessionModel order;
  const _Items({required this.order});

  @override
  Widget build(BuildContext context) {
    if (order.orderItems.isNotEmpty) {
      return _list(order.orderItems, order.totalWithDiscount);
    }
    // До подтверждения позиции лежат в заявке, а не в чеке.
    return StreamBuilder<List<GuestOrder>>(
      stream: DeliveryOrderService.instance.pending(KolibriAuthService().uid, order.id),
      builder: (context, snap) {
        final items = (snap.data ?? const <GuestOrder>[])
            .where((o) => o.status != 'rejected')
            .expand((o) => o.items)
            .toList();
        return _list(items, items.fold<double>(0, (a, i) => a + i.total));
      },
    );
  }

  Widget _list(List<OrderItem> items, double total) => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: KolibriColors.surface,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: KolibriColors.border),
        ),
        child: Column(
          children: [
            for (final i in items)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    Expanded(child: Text('${i.displayName} ×${i.qty}')),
                    Text(rub(i.total), style: TextStyle(color: KolibriColors.textMuted)),
                  ],
                ),
              ),
            const Divider(height: 20),
            Row(
              children: [
                const Expanded(child: Text('Итого', style: TextStyle(fontWeight: FontWeight.w700))),
                Text(rub(total), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
              ],
            ),
          ],
        ),
      );
}

class _Step extends StatelessWidget {
  final String label;
  final bool done;
  final bool active;
  final bool last;
  const _Step({required this.label, required this.done, required this.active, required this.last});

  @override
  Widget build(BuildContext context) {
    final color = done || active ? KolibriColors.primary : KolibriColors.border;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Column(
          children: [
            AnimatedContainer(
              duration: const Duration(milliseconds: 300),
              width: 22,
              height: 22,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: done ? color : Colors.transparent,
                border: Border.all(color: color, width: 2),
              ),
              child: done ? Icon(Icons.check, size: 14, color: KolibriColors.onPrimary) : null,
            ),
            if (!last) Container(width: 2, height: 22, color: done ? color : KolibriColors.border),
          ],
        ),
        const SizedBox(width: 12),
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: Text(label,
              style: TextStyle(
                fontWeight: active ? FontWeight.w700 : FontWeight.w400,
                color: done || active ? KolibriColors.textPrimary : KolibriColors.textMuted,
              )),
        ),
      ],
    );
  }
}

class _Note extends StatelessWidget {
  final String text;
  const _Note(this.text);

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: KolibriColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: KolibriColors.border),
        ),
        child: Text(text, style: TextStyle(color: KolibriColors.textMuted, height: 1.4)),
      );
}

/// Карточка «Ваш заказ» на экране «Мой стол»: заказы в работе — со статусом.
class MyDeliveryOrders extends StatelessWidget {
  const MyDeliveryOrders({super.key});

  @override
  Widget build(BuildContext context) {
    final uid = KolibriAuthService().uid;
    if (uid.isEmpty) return const SizedBox.shrink();
    return StreamBuilder<List<SessionModel>>(
      stream: DeliveryOrderService.instance.myOrders(uid),
      builder: (context, snap) {
        final recent = DateTime.now().subtract(const Duration(hours: 3));
        final list = (snap.data ?? const <SessionModel>[])
            .where((o) => !DeliveryFlow.isFinal(o.orderType, o.deliveryStatus) || o.startTime.isAfter(recent))
            .take(3)
            .toList();
        if (list.isEmpty) return const SizedBox.shrink();
        return Column(
          children: [
            for (final o in list)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Material(
                  color: KolibriColors.surface,
                  borderRadius: BorderRadius.circular(18),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(18),
                    onTap: () => Navigator.of(context)
                        .push(MaterialPageRoute(builder: (_) => KolibriOrderScreen(sessionId: o.id))),
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Row(
                        children: [
                          Icon(o.orderType == 'delivery' ? Icons.delivery_dining_rounded : Icons.shopping_bag_outlined,
                              color: KolibriColors.primary, size: 30),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('${o.orderType == 'delivery' ? 'Доставка' : 'С собой'} №${orderNumber(o.id)}',
                                    style: const TextStyle(fontWeight: FontWeight.w700)),
                                Text(
                                  DeliveryFlow.normalize(o.orderType, o.deliveryStatus) == 'new'
                                      ? 'Ждёт подтверждения'
                                      : DeliveryFlow.label(o.orderType, o.deliveryStatus),
                                  style: TextStyle(color: KolibriColors.textMuted),
                                ),
                              ],
                            ),
                          ),
                          const Icon(Icons.chevron_right),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}
