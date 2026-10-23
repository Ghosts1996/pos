import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/plan_capabilities.dart';
import '../../theme/app_colors.dart';

/// Касса сверх лимита устройств тарифа (см. [DeviceLimitGate]). Экран
/// исчезает сам, как только владелец отключит неиспользуемое устройство в
/// кабинете или перейдёт на тариф с большим числом устройств.
class DeviceLimitScreen extends StatelessWidget {
  final DeviceLimitState state;
  const DeviceLimitScreen({super.key, required this.state});

  static const devicesUrl = 'https://zalpos.ru/#/devices';
  static const billingUrl = 'https://zalpos.ru/#/billing';

  Future<void> _open(BuildContext context, String url) async {
    final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication).catchError((_) => false);
    if (!ok && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Не удалось открыть браузер. Откройте zalpos.ru → кабинет заведения.')));
    }
  }

  @override
  Widget build(BuildContext context) {
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
                        color: AppColors.warning.withValues(alpha: 0.14),
                        border: Border.all(color: AppColors.warning.withValues(alpha: 0.45)),
                      ),
                      child: Icon(Icons.devices_other_outlined, color: AppColors.warning, size: 34),
                    ),
                  ),
                  const SizedBox(height: 18),
                  Text(state.disabled ? 'Устройство отключено' : 'Лимит устройств тарифа',
                      textAlign: TextAlign.center, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 10),
                  Text(
                    state.disabled
                        ? 'Владелец отключил кассу на этом устройстве в кабинете. Чтобы снова работать на нём, '
                            'включите его на вкладке «Устройства».'
                        : 'Тариф заведения позволяет кассу на ${state.max} '
                            '${_devices(state.max)}, а подключено ${state.active}. Это устройство подключили последним, '
                            'поэтому касса на нём пока не работает.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 15, height: 1.45, color: AppColors.textMuted),
                  ),
                  const SizedBox(height: 8),
                  if (!state.disabled) Text(
                    'Отключите планшет, которым больше не пользуетесь, в кабинете на вкладке «Устройства» или '
                    'перейдите на тариф с большим числом устройств. Касса откроется сама, перезапускать не нужно.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 14, height: 1.45, color: AppColors.textMuted),
                  ),
                  const SizedBox(height: 22),
                  FilledButton.icon(
                    style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                    onPressed: () => _open(context, devicesUrl),
                    icon: const Icon(Icons.devices_outlined),
                    label: const Text('Открыть устройства в кабинете'),
                  ),
                  const SizedBox(height: 10),
                  if (!state.disabled) OutlinedButton(
                    style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                    onPressed: () => _open(context, billingUrl),
                    child: const Text('Сменить тариф'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  static String _devices(int n) {
    final m10 = n % 10, m100 = n % 100;
    if (m10 == 1 && m100 != 11) return 'устройстве';
    return 'устройствах';
  }
}
