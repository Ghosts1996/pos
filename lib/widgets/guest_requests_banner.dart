import 'package:flutter/material.dart';
import '../models/client_models.dart';
import '../models/employee.dart';
import '../services/guest_link_service.dart';
import '../theme/app_colors.dart';

/// Компактная полоса обращений гостей над картой зала.
///
/// Раньше здесь был развёрнутый список, который занимал пол-экрана и
/// ломал карту зала. Теперь это одна строка: «Гости зовут: 2» и кнопка
/// «Показать». Подробности открываются нижней панелью, и там у каждого
/// обращения своя кнопка «Готово» — нажал, и строка исчезла.
class GuestRequestsBanner extends StatelessWidget {
  final Employee employee;

  /// Открыть стол по обращению (обычно — переход в TableDetailScreen).
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
            final total = calls.length + orders.length;
            if (total == 0) return const SizedBox.shrink();

            // Самое давнее обращение — его и показываем в свёрнутой строке.
            final oldest = calls.isEmpty ? 0 : calls.first.waitingMinutes;
            final urgent = oldest >= 5;

            return Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: () => _openSheet(context, service, calls, orders),
                child: Container(
                  margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    color: AppColors.surfaceElevated,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: urgent ? AppColors.danger : AppColors.warning,
                    ),
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.notifications_active,
                          size: 18, color: urgent ? AppColors.danger : AppColors.warning),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          'Гости зовут: $total'
                          '${oldest > 0 ? ' · ждут $oldest мин' : ''}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: AppColors.textPrimary,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      const Text('Показать',
                          style: TextStyle(color: AppColors.primary, fontSize: 13)),
                      const Icon(Icons.chevron_right, size: 18, color: AppColors.primary),
                    ],
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }

  /// Подробности — в нижней панели: там есть место под длинные комментарии
  /// гостей, и карта зала остаётся нетронутой.
  void _openSheet(
    BuildContext context,
    GuestLinkService service,
    List<WaiterCall> calls,
    List<GuestOrder> orders,
  ) {
    showModalBottomSheet(
      context: context,
      backgroundColor: AppColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) => SafeArea(
        child: StreamBuilder<List<WaiterCall>>(
          stream: service.openCallsStream(),
          initialData: calls,
          builder: (ctx, callsSnap) => StreamBuilder<List<GuestOrder>>(
            stream: service.openGuestOrdersStream(),
            initialData: orders,
            builder: (ctx, ordersSnap) {
              final c = callsSnap.data ?? const <WaiterCall>[];
              final o = ordersSnap.data ?? const <GuestOrder>[];

              if (c.isEmpty && o.isEmpty) {
                return const Padding(
                  padding: EdgeInsets.all(32),
                  child: Center(
                    child: Text('Все обращения закрыты',
                        style: TextStyle(color: AppColors.textMuted)),
                  ),
                );
              }

              return ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                children: [
                  const Text('Обращения гостей',
                      style: TextStyle(
                          color: AppColors.textPrimary,
                          fontSize: 17,
                          fontWeight: FontWeight.w700)),
                  const SizedBox(height: 12),
                  ...c.map((call) => _callTile(ctx, service, call)),
                  ...o.map((order) => _orderTile(ctx, service, order)),
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  /// Строка вызова: что нужно сделать, сколько ждут и крестик «закрыть».
  /// Кнопок с подписями нет специально — в строке они требовали ширину и
  /// ломали текст; крестик всегда одного размера и ничего не ломает.
  Widget _callTile(BuildContext context, GuestLinkService service, WaiterCall c) {
    final late = c.waitingMinutes >= 5;

    // Одна строка: что сделать и где. Действие — иконкой справа, без
    // текстовых кнопок: они в этой теме требуют всю ширину и ломают строку.
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: late ? AppColors.danger : AppColors.border),
      ),
      child: Row(
        children: [
          Icon(_iconFor(c.type), size: 20,
              color: late ? AppColors.danger : AppColors.warning),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  c.type.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      color: AppColors.textPrimary, fontWeight: FontWeight.w600),
                ),
                Text(
                  '${c.tableName.isEmpty ? 'Стол' : c.tableName} · ${c.waitingMinutes} мин'
                  '${c.comment.isEmpty ? '' : ' · «${c.comment}»'}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: late ? AppColors.danger : AppColors.textMuted,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          if (c.tableId.isNotEmpty)
            IconButton(
              tooltip: 'Открыть стол',
              icon: const Icon(Icons.open_in_new, size: 20, color: AppColors.textMuted),
              onPressed: () {
                Navigator.pop(context);
                onOpenTable?.call(c.tableId, c.sessionId);
              },
            ),
          IconButton(
            tooltip: 'Выполнено',
            icon: const Icon(Icons.check_circle, size: 26, color: AppColors.success),
            onPressed: () => service.closeCall(c.id, employee.name),
          ),
        ],
      ),
    );
  }

  Widget _orderTile(BuildContext context, GuestLinkService service, GuestOrder o) {
    final preparing = o.status == 'preparing';

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.success.withValues(alpha: 0.5)),
      ),
      child: Row(
        children: [
          const Icon(Icons.receipt_long, size: 20, color: AppColors.success),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  preparing ? 'Готовится' : 'Новый заказ',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      color: AppColors.textPrimary, fontWeight: FontWeight.w600),
                ),
                Text(
                  '${o.tableName.isEmpty ? 'Стол' : o.tableName} · '
                  '${o.items.map((i) => '${i.name}×${i.qty}').join(', ')} · '
                  '${o.total.toStringAsFixed(0)} ₽',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                ),
              ],
            ),
          ),
          if (!preparing)
            IconButton(
              tooltip: 'Отклонить',
              icon: const Icon(Icons.close, size: 20, color: AppColors.textMuted),
              onPressed: () =>
                  service.rejectGuestOrder(o.id, employee.name, 'Нет в наличии'),
            ),
          IconButton(
            tooltip: preparing ? 'Готово' : 'В чек',
            icon: Icon(preparing ? Icons.check_circle : Icons.playlist_add,
                size: 26, color: AppColors.success),
            onPressed: () async {
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
      case GuestCallType.callWaiter:
        return Icons.room_service;
    }
  }
}
