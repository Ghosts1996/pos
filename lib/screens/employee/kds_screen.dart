import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../models/employee.dart';
import '../../services/guest_link_service.dart';
import '../../theme/app_colors.dart';

/// Экран кальянной/бара (KDS): очередь заказов гостей и вызовов из зала
/// крупными карточками — чтобы видеть с расстояния и работать в одно касание.
///
/// Держится на планшете у стойки. Карточки сортируются по времени ожидания,
/// просроченные (более [_slaMinutes]) подсвечиваются красным.
class KdsScreen extends StatelessWidget {
  final Employee employee;
  const KdsScreen({super.key, required this.employee});

  static const _slaMinutes = 5;

  @override
  Widget build(BuildContext context) {
    final service = GuestLinkService();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Очередь заказов'),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 16),
            child: Center(
              child: Text(employee.name, style: const TextStyle(color: AppColors.textMuted)),
            ),
          ),
        ],
      ),
      body: StreamBuilder<List<GuestOrder>>(
        stream: service.openGuestOrdersStream(),
        builder: (context, orderSnap) {
          return StreamBuilder<List<WaiterCall>>(
            stream: service.openCallsStream(),
            builder: (context, callSnap) {
              final orders = orderSnap.data ?? const <GuestOrder>[];
              final calls = callSnap.data ?? const <WaiterCall>[];

              if (orders.isEmpty && calls.isEmpty) {
                return const Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.check_circle_outline, size: 56, color: AppColors.success),
                      SizedBox(height: 12),
                      Text('Очередь пуста', style: TextStyle(color: AppColors.textMuted)),
                    ],
                  ),
                );
              }

              return GridView.count(
                padding: const EdgeInsets.all(16),
                crossAxisCount: MediaQuery.of(context).size.width > 900 ? 3 : 2,
                childAspectRatio: 1.35,
                mainAxisSpacing: 14,
                crossAxisSpacing: 14,
                children: [
                  ...calls.map((c) => _callCard(context, service, c)),
                  ...orders.map((o) => _orderCard(context, service, o)),
                ],
              );
            },
          );
        },
      ),
    );
  }

  Widget _callCard(BuildContext context, GuestLinkService service, WaiterCall c) {
    final late = c.waitingMinutes >= _slaMinutes;
    return _card(
      color: late ? AppColors.danger : AppColors.warning,
      title: c.tableName.isEmpty ? 'Стол' : c.tableName,
      subtitle: c.type.label,
      body: c.comment.isEmpty ? '' : '«${c.comment}»',
      minutes: c.waitingMinutes,
      actionLabel: 'Выполнено',
      onAction: () => service.closeCall(c.id, employee.name),
    );
  }

  Widget _orderCard(BuildContext context, GuestLinkService service, GuestOrder o) {
    final waiting = DateTime.now().difference(o.createdAt).inMinutes;
    // Заказ проходит две стадии: «принять в чек» (позиции уезжают в счёт)
    // и «готово» (гостю уходит push «несём к столу»).
    final preparing = o.status == 'preparing';
    return _card(
      color: waiting >= _slaMinutes ? AppColors.danger : AppColors.success,
      title: o.tableName.isEmpty ? 'Стол' : o.tableName,
      subtitle: preparing
          ? 'Готовим · ${o.total.toStringAsFixed(0)} ₽'
          : 'Заказ из приложения · ${o.total.toStringAsFixed(0)} ₽',
      body: o.items.map((i) => '${i.name} ×${i.qty}').join('\n'),
      minutes: waiting,
      actionLabel: preparing ? 'Готово' : 'Принять в чек',
      onAction: () async {
        try {
          if (preparing) {
            await service.markOrderReady(o, employee.name);
          } else {
            await service.acceptGuestOrder(o, employee.name);
          }
        } catch (e) {
          if (context.mounted) {
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
          }
        }
      },
      secondaryLabel: preparing ? null : 'Отклонить',
      onSecondary:
          preparing ? null : () => service.rejectGuestOrder(o.id, employee.name, 'Нет в наличии'),
    );
  }

  Widget _card({
    required Color color,
    required String title,
    required String subtitle,
    required String body,
    required int minutes,
    required String actionLabel,
    required VoidCallback onAction,
    String? secondaryLabel,
    VoidCallback? onSecondary,
  }) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: color, width: 2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(title,
                    style: const TextStyle(
                        fontSize: 22, fontWeight: FontWeight.w700, color: AppColors.textPrimary)),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.2),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text('$minutes мин',
                    style: TextStyle(color: color, fontWeight: FontWeight.w700)),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(subtitle, style: const TextStyle(color: AppColors.textMuted)),
          const SizedBox(height: 10),
          Expanded(
            child: SingleChildScrollView(
              child: Text(body,
                  style: const TextStyle(color: AppColors.textPrimary, height: 1.35)),
            ),
          ),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: onAction,
                  style: FilledButton.styleFrom(backgroundColor: color),
                  child: Text(actionLabel),
                ),
              ),
              if (secondaryLabel != null) ...[
                const SizedBox(width: 8),
                TextButton(
                  style: TextButton.styleFrom(minimumSize: const Size(0, 44)),
                  onPressed: onSecondary,
                  child: Text(secondaryLabel,
                      style: const TextStyle(color: AppColors.textMuted)),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
