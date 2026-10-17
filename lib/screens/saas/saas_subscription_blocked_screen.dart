import 'dart:async';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../models/tenant_models.dart';
import '../../services/app_scope.dart';
import '../../services/subscription_gate.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_theme.dart';

/// Жёсткая блокировка — показывается ВМЕСТО любого экрана приложения,
/// пока SubscriptionGate.blocked == true (см. main.dart, MaterialApp.builder).
/// Касса недоступна, пока подписку не продлят: экран исчезнет сам, как
/// только оплата отразится в Firestore (SubscriptionGate слушает изменения).
/// При просрочке — отсчёт до удаления данных и кнопка оплаты на сайте.
class SaasSubscriptionBlockedScreen extends StatefulWidget {
  const SaasSubscriptionBlockedScreen({super.key});

  /// Кабинет на вкладке «Оплата»: без входа сначала откроется вход.
  static const billingUrl = 'https://zalpos.ru/#/billing';

  @override
  State<SaasSubscriptionBlockedScreen> createState() => _SaasSubscriptionBlockedScreenState();
}

class _SaasSubscriptionBlockedScreenState extends State<SaasSubscriptionBlockedScreen> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  Future<void> _pay() async {
    final ok = await launchUrl(Uri.parse(SaasSubscriptionBlockedScreen.billingUrl), mode: LaunchMode.externalApplication)
        .catchError((_) => false);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Не удалось открыть браузер. Оплатить можно на zalpos.ru → «Оплата».'),
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final appName = AppScope.branding?.appName ?? 'ZalPOS';
    final deadline = SubscriptionGate.dataPurgeAt;

    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Center(
                    child: Container(
                      width: 72,
                      height: 72,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: AppColors.danger.withValues(alpha: 0.14),
                        border: Border.all(color: AppColors.danger.withValues(alpha: 0.45)),
                      ),
                      child: const Icon(Icons.credit_card_off_outlined, color: AppColors.danger, size: 34),
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text(appName.toUpperCase(),
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: AppColors.brass, fontSize: 12, fontWeight: FontWeight.w600, letterSpacing: 2)),
                  const SizedBox(height: 10),
                  const Text(
                    'Вы не оплатили подписку',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontFamily: AppFonts.serif,
                      color: AppColors.textPrimary,
                      fontSize: 34,
                      fontWeight: FontWeight.w600,
                      height: 1.1,
                    ),
                  ),
                  const SizedBox(height: 10),
                  const Text(
                    'Оплатите подписку, и касса снова заработает. После оплаты экран исчезнет сам, перезапускать ничего не нужно.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.textMuted, fontSize: 15, height: 1.45),
                  ),
                  const SizedBox(height: 22),
                  if (deadline != null) _PurgeCountdown(deadline: deadline) else const _BlockedNote(),
                  const SizedBox(height: 22),
                  SizedBox(
                    height: 56,
                    child: FilledButton.icon(
                      onPressed: _pay,
                      icon: const Icon(Icons.open_in_new, size: 20),
                      label: const Text('Оплатить подписку', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                      style: FilledButton.styleFrom(
                        backgroundColor: AppColors.primary,
                        foregroundColor: const Color(0xFFFFF7F0),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  const Text(
                    'Откроется личный кабинет на zalpos.ru, раздел «Оплата». Оплачивает владелец заведения.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.textMuted, fontSize: 12.5, height: 1.4),
                  ),
                  const SizedBox(height: 6),
                  TextButton(
                    // Экран и так исчезнет сам после оплаты; кнопка — отклик
                    // для того, кто только что заплатил и ждёт.
                    onPressed: () => setState(() {}),
                    style: TextButton.styleFrom(foregroundColor: AppColors.textMuted),
                    child: const Text('Я уже оплатил — проверить'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// «Данные удалятся через 9 дней 23:41:07» и шкала из [gracePeriodDays]
/// делений: каждое прошедшее сутки гасят одно деление.
class _PurgeCountdown extends StatelessWidget {
  final DateTime deadline;
  const _PurgeCountdown({required this.deadline});

  @override
  Widget build(BuildContext context) {
    final c = purgeCountdown(deadline, DateTime.now());
    final over = c.days == 0 && c.rest == Duration.zero;
    final lit = over ? 0 : (c.days + (c.rest > Duration.zero ? 1 : 0)).clamp(0, gracePeriodDays);
    String two(int n) => n.toString().padLeft(2, '0');
    final clock = '${two(c.rest.inHours)}:${two(c.rest.inMinutes % 60)}:${two(c.rest.inSeconds % 60)}';

    return Container(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.danger.withValues(alpha: 0.5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            over ? 'Срок хранения данных истёк' : 'Данные заведения удалятся через',
            textAlign: TextAlign.center,
            style: const TextStyle(color: AppColors.textMuted, fontSize: 14, fontWeight: FontWeight.w500),
          ),
          const SizedBox(height: 6),
          if (!over)
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text('${c.days}',
                    style: const TextStyle(
                      color: AppColors.danger,
                      fontSize: 64,
                      fontWeight: FontWeight.w700,
                      height: 1,
                      fontFeatures: [FontFeature.tabularFigures()],
                    )),
                const SizedBox(width: 8),
                Text(_pluralDays(c.days),
                    style: const TextStyle(color: AppColors.textPrimary, fontSize: 22, fontWeight: FontWeight.w600)),
                const SizedBox(width: 12),
                Text(clock,
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 22,
                      fontWeight: FontWeight.w500,
                      fontFeatures: [FontFeature.tabularFigures()],
                    )),
              ],
            )
          else
            const Text(
              'Данные удалятся при ближайшей проверке. Если оплатить сейчас, они сохранятся.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColors.textPrimary, fontSize: 15, fontWeight: FontWeight.w600, height: 1.4),
            ),
          const SizedBox(height: 14),
          Row(
            children: [
              for (var i = 0; i < gracePeriodDays; i++) ...[
                if (i > 0) const SizedBox(width: 4),
                Expanded(
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 400),
                    height: 6,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(3),
                      color: i < lit ? AppColors.danger : AppColors.border,
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 10),
          const Text(
            'Меню, зал, чеки, сотрудники и бонусы гостей хранятся $gracePeriodDays дней после окончания подписки. '
            'Потом удаляются безвозвратно.',
            textAlign: TextAlign.center,
            style: TextStyle(color: AppColors.textMuted, fontSize: 12.5, height: 1.4),
          ),
        ],
      ),
    );
  }
}

/// Подписка приостановлена или отменена без отсчёта (не просрочка).
class _BlockedNote extends StatelessWidget {
  const _BlockedNote();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.border),
      ),
      child: const Text(
        'Доступ к кассе приостановлен. Чтобы вернуть его, оплатите подписку в личном кабинете.',
        textAlign: TextAlign.center,
        style: TextStyle(color: AppColors.textPrimary, fontSize: 15, height: 1.4),
      ),
    );
  }
}

String _pluralDays(int n) {
  final last = n % 10;
  final teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last == 1) return 'день';
  if (!teen && last >= 2 && last <= 4) return 'дня';
  return 'дней';
}
