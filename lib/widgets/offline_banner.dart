import 'package:flutter/material.dart';

import '../data/app_db.dart';
import '../services/fiscal_queue.dart';
import '../services/net_status.dart';
import '../theme/app_colors.dart';

/// Плашка «Нет интернета — касса работает»: заказы, оплата и бегунки идут
/// дальше, данные уйдут на сервер сами, когда связь вернётся. Если есть
/// чеки, которые ждут кассу, — показывает и их. Сервер не принял изменение,
/// сделанное без связи, — красная плашка с причиной (закрывается крестиком).
class OfflineBanner extends StatelessWidget {
  const OfflineBanner({super.key});

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: Listenable.merge([
          NetStatus.online,
          FiscalQueue.pending,
          if (AppDb.engine != null) AppDb.engine!.unsent,
          if (AppDb.engine != null) AppDb.engine!.lastRejected,
        ]),
        builder: (context, _) {
          final online = NetStatus.online.value;
          final receipts = FiscalQueue.pending.value;
          final unsent = AppDb.engine?.unsent.value ?? 0;
          final rejected = AppDb.engine?.lastRejected.value;
          if (rejected != null) return _RejectedBar(rejected);
          final String? text;
          if (!online) {
            text = 'Нет интернета — касса работает. Заказы и оплаты сохранены на устройстве '
                'и отправятся сами, когда связь вернётся.'
                '${unsent > 0 ? ' Ждут отправки: $unsent.' : ''}'
                '${receipts > 0 ? ' Чеков ждут кассу: $receipts.' : ''}';
          } else if (receipts > 0) {
            text = 'Чеков ждут кассу: $receipts — отправляются автоматически.';
          } else {
            text = null;
          }
          return AnimatedSize(
            duration: const Duration(milliseconds: 220),
            child: text == null
                ? const SizedBox(width: double.infinity)
                : Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                    color: AppColors.warning.withValues(alpha: 0.16),
                    child: Row(
                      children: [
                        Icon(online ? Icons.receipt_long_rounded : Icons.wifi_off_rounded,
                            size: 18, color: AppColors.warning),
                        const SizedBox(width: 10),
                        Expanded(child: Text(text, style: const TextStyle(fontSize: 13))),
                      ],
                    ),
                  ),
          );
        },
      );
}

class _RejectedBar extends StatelessWidget {
  const _RejectedBar(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(14, 6, 4, 6),
        color: AppColors.danger.withValues(alpha: 0.14),
        child: Row(
          children: [
            Icon(Icons.error_outline_rounded, size: 18, color: AppColors.danger),
            const SizedBox(width: 10),
            Expanded(child: Text(text, style: const TextStyle(fontSize: 13))),
            IconButton(
              tooltip: 'Понятно',
              icon: const Icon(Icons.close_rounded, size: 18),
              onPressed: () => AppDb.engine?.lastRejected.value = null,
            ),
          ],
        ),
      );
}
