import 'package:flutter/material.dart';

import '../services/net_status.dart';
import '../theme/app_colors.dart';

/// Плашка «Нет интернета — касса работает»: заказы, оплата и бегунки идут
/// дальше, данные уйдут на сервер сами, когда связь вернётся.
class OfflineBanner extends StatelessWidget {
  const OfflineBanner({super.key});

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<bool>(
        valueListenable: NetStatus.online,
        builder: (context, online, _) => AnimatedSize(
          duration: const Duration(milliseconds: 220),
          child: online
              ? const SizedBox(width: double.infinity)
              : Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                  color: AppColors.warning.withValues(alpha: 0.16),
                  child: const Row(
                    children: [
                      Icon(Icons.wifi_off_rounded, size: 18, color: AppColors.warning),
                      SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          'Нет интернета — касса работает. Заказы и оплаты сохранены на устройстве '
                          'и отправятся сами, когда связь вернётся.',
                          style: TextStyle(fontSize: 13),
                        ),
                      ),
                    ],
                  ),
                ),
        ),
      );
}
