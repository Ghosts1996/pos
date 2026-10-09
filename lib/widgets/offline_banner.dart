import 'package:flutter/material.dart';

import '../services/fiscal_queue.dart';
import '../services/net_status.dart';
import '../theme/app_colors.dart';

/// Плашка «Нет интернета — касса работает»: заказы, оплата и бегунки идут
/// дальше, данные уйдут на сервер сами, когда связь вернётся. Если есть
/// чеки, которые ждут кассу, — показывает и их.
class OfflineBanner extends StatelessWidget {
  const OfflineBanner({super.key});

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: Listenable.merge([NetStatus.online, FiscalQueue.pending]),
        builder: (context, _) {
          final online = NetStatus.online.value;
          final receipts = FiscalQueue.pending.value;
          final String? text;
          if (!online) {
            text = 'Нет интернета — касса работает. Заказы и оплаты сохранены на устройстве '
                'и отправятся сами, когда связь вернётся.'
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
