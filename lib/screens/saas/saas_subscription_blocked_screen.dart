import 'dart:async';
import 'package:flutter/material.dart';
import '../../services/app_scope.dart';
import '../../services/subscription_gate.dart';
import '../../theme/app_colors.dart';

/// Жёсткая блокировка — показывается ВМЕСТО любого экрана приложения,
/// пока SubscriptionGate.blocked == true (см. main.dart, MaterialApp.builder).
/// Владелец явно попросил именно так: касса и приложение полностью
/// недоступны при просроченной подписке, а не продолжают работать в
/// "мягком" режиме — единственный путь обратно отсюда — оплата в личном
/// кабинете владельца, экран сам исчезнет, как только это отразится в
/// Firestore (SubscriptionGate слушает изменения в реальном времени).
class SaasSubscriptionBlockedScreen extends StatefulWidget {
  const SaasSubscriptionBlockedScreen({super.key});

  @override
  State<SaasSubscriptionBlockedScreen> createState() => _SaasSubscriptionBlockedScreenState();
}

class _SaasSubscriptionBlockedScreenState extends State<SaasSubscriptionBlockedScreen> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    // Обратный отсчёт дней сам по себе не меняется от событий Firestore
    // (он посчитан от "сейчас"), поэтому обновляем кадр раз в минуту —
    // иначе экран показывал бы один и тот же день сутками напролёт.
    _ticker = Timer.periodic(const Duration(minutes: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final days = SubscriptionGate.daysUntilDataPurge;
    final branding = AppScope.branding;
    final appName = branding?.appName ?? 'Hookah POS';

    return Scaffold(
      backgroundColor: const Color(0xFF1B1B1F),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.lock_clock, color: AppColors.danger, size: 56),
                  const SizedBox(height: 12),
                  Text(appName,
                      style: const TextStyle(color: Colors.white70, fontSize: 14, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 8),
                  const Text(
                    'Подписка не оплачена',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 14),
                  const Text(
                    'Касса и приложение недоступны, пока подписка не будет продлена. '
                    'Обратитесь к владельцу заведения — продлить можно в личном кабинете '
                    'на сайте платформы.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.white70, fontSize: 15, height: 1.4),
                  ),
                  if (days != null) ...[
                    const SizedBox(height: 20),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                      decoration: BoxDecoration(
                        color: AppColors.danger.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppColors.danger),
                      ),
                      child: Text(
                        days > 0
                            ? 'Если подписку не продлить, данные заведения будут безвозвратно удалены через $days ${_pluralDays(days)}.'
                            : 'Льготный период закончился — данные заведения будут удалены при ближайшей проверке.',
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, height: 1.4),
                      ),
                    ),
                  ],
                  const SizedBox(height: 28),
                  SizedBox(
                    width: double.infinity,
                    height: 50,
                    child: OutlinedButton(
                      // Экран и так исчезнет сам, как только оплата отразится в
                      // Firestore (SubscriptionGate следит в реальном времени) —
                      // кнопка не запрашивает сеть отдельно, а просто
                      // перерисовывает то, что уже известно на этот момент:
                      // подтверждение для человека, который только что заплатил
                      // и хочет сразу увидеть отклик, а не ждать неизвестно чего.
                      onPressed: () => setState(() {}),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: Colors.white70,
                        side: const BorderSide(color: Colors.white24),
                      ),
                      child: const Text('Проверить снова'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  String _pluralDays(int n) {
    final last = n % 10;
    final teen = n % 100 >= 11 && n % 100 <= 14;
    if (!teen && last == 1) return 'день';
    if (!teen && last >= 2 && last <= 4) return 'дня';
    return 'дней';
  }
}
