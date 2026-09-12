import 'package:flutter/material.dart';
import '../models/client_models.dart';
import '../models/employee.dart';
import '../services/guest_link_service.dart';
import '../theme/app_colors.dart';

/// Живая панель обращений гостей из приложения «Колибри Лаундж»:
/// вызовы («поменять угли», «счёт») и заказы, собранные гостем за столом.
///
/// Вставляется в карту зала над планом (см. floor_plan_screen.dart) —
/// схлопывается в ноль по высоте, когда обращений нет, поэтому не мешает.
class GuestRequestsBanner extends StatelessWidget {
  final Employee employee;

  /// Открыть стол по нажатию на обращение (обычно — переход в TableDetailScreen).
  final void Function(String tableId, String sessionId)? onOpenTable;

  const GuestRequestsBanner({super.key, required this.employee, this.onOpenTable});

  @override
  Widget build(BuildContext context) {
    final service = GuestLinkService();

    return StreamBuilder<List<WaiterCall>>(
      stream: service.openCallsStream(),
      builder: (context, callsSnap) {
        return StreamBuilder<List<GuestOrder>>(
          stream: service.openGuestOrdersStream(),
          builder: (context, ordersSnap) {
            final calls = callsSnap.data ?? const <WaiterCall>[];
            final orders = ordersSnap.data ?? const <GuestOrder>[];
            if (calls.isEmpty && orders.isEmpty) return const SizedBox.shrink();

            return Container(
              margin: const EdgeInsets.fromLTRB(12, 12, 12, 0),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.surfaceElevated,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AppColors.warning.withValues(alpha: 0.5)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.notifications_active, color: AppColors.warning, size: 18),
                      const SizedBox(width: 8),
                      Text(
                        'Обращения гостей: ${calls.length + orders.length}',
                        style: const TextStyle(
                            color: AppColors.textPrimary, fontWeight: FontWeight.w600),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  ...calls.map((c) => _callRow(context, service, c)),
                  ...orders.map((o) => _orderRow(context, service, o)),
                ],
              ),
            );
          },
        );
      },
    );
  }

  Widget _callRow(BuildContext context, GuestLinkService service, WaiterCall c) {
    // Чем дольше гость ждёт — тем тревожнее строка. Порог 5 минут выбран
    // как разумный SLA для зала; дальше строка становится красной.
    final late = c.waitingMinutes >= 5;
    return InkWell(
      onTap: () => onOpenTable?.call(c.tableId, c.sessionId),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            Icon(_iconFor(c.type), size: 18, color: late ? AppColors.danger : AppColors.warning),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                '${c.tableName.isEmpty ? 'Стол' : c.tableName} — ${c.type.label}'
                '${c.comment.isNotEmpty ? ' («${c.comment}»)' : ''}',
                style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
              ),
            ),
            Text('${c.waitingMinutes} мин',
                style: TextStyle(
                    color: late ? AppColors.danger : AppColors.textMuted, fontSize: 13)),
            const SizedBox(width: 8),
            TextButton(
              onPressed: () => service.closeCall(c.id, employee.name),
              child: const Text('Принял'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _orderRow(BuildContext context, GuestLinkService service, GuestOrder o) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          const Icon(Icons.receipt_long, size: 18, color: AppColors.success),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              '${o.tableName.isEmpty ? 'Стол' : o.tableName} — заказ из приложения: '
              '${o.items.map((i) => '${i.name}×${i.qty}').join(', ')} '
              '(${o.total.toStringAsFixed(0)} ₽)',
              style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
            ),
          ),
          TextButton(
            onPressed: () async {
              try {
                await service.acceptGuestOrder(o, employee.name);
                if (context.mounted) {
                  ScaffoldMessenger.of(context)
                      .showSnackBar(const SnackBar(content: Text('Заказ добавлен в чек')));
                }
              } catch (e) {
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
                }
              }
            },
            child: const Text('В чек'),
          ),
          TextButton(
            onPressed: () => service.rejectGuestOrder(o.id, employee.name, 'Позиция недоступна'),
            child: const Text('Отклонить', style: TextStyle(color: AppColors.danger)),
          ),
        ],
      ),
    );
  }

  IconData _iconFor(GuestCallType type) {
    switch (type) {
      case GuestCallType.coal:
        return Icons.local_fire_department;
      case GuestCallType.bill:
        return Icons.payments;
      case GuestCallType.refill:
        return Icons.refresh;
      case GuestCallType.waiter:
        return Icons.pan_tool_alt;
    }
  }
}
