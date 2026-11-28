import 'package:flutter/material.dart';

import '../services/subscription_gate.dart';
import '../theme/app_colors.dart';

/// Полоса в зале (SaaS): касса давно без связи с сервером и скоро
/// остановится («аренда без связи», OfflineLease). Исчезает сама, как только
/// связь появилась.
class LeaseWarningBanner extends StatelessWidget {
  const LeaseWarningBanner({super.key});

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<String?>(
        valueListenable: SubscriptionGate.leaseWarning,
        builder: (context, text, _) => text == null
            ? const SizedBox.shrink()
            : Material(
                color: AppColors.warning.withValues(alpha: 0.14),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
                  child: Row(children: [
                    Icon(Icons.wifi_off_rounded, size: 20, color: AppColors.warning),
                    const SizedBox(width: 10),
                    Expanded(child: Text(text, style: TextStyle(color: AppColors.textPrimary, fontSize: 13.5, height: 1.3))),
                  ]),
                ),
              ),
      );
}
