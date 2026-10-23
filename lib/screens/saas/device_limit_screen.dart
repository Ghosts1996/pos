import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/plan_capabilities.dart';
import '../../theme/app_colors.dart';
import '../../widgets/devices_panel.dart';

/// Касса на устройстве сверх лимита тарифа или отключённом в кабинете
/// (см. [DeviceLimitGate]). Здесь же — все устройства заведения и два
/// выхода: удалить ненужное (PIN администратора) или перейти на тариф с
/// большим числом устройств. Экран исчезает сам, как только место
/// освободится, — перезапускать кассу не нужно.
/// Экран лимита показывается поверх кассы из MaterialApp.builder — выше
/// навигатора приложения, поэтому у него свой навигатор: из него
/// открывается окно ввода PIN администратора.
class DeviceLimitHost extends StatelessWidget {
  const DeviceLimitHost({super.key});

  @override
  Widget build(BuildContext context) => Navigator(
        onGenerateRoute: (_) => MaterialPageRoute(
          builder: (_) => ValueListenableBuilder<DeviceLimitState?>(
            valueListenable: DeviceLimitGate.over,
            builder: (context, s, _) => s == null ? const SizedBox.shrink() : DeviceLimitScreen(state: s),
          ),
        ),
      );
}

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

  static String _devices(int n) => n % 10 == 1 && n % 100 != 11 ? 'устройстве' : 'устройствах';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
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
                        ? 'Владелец отключил кассу на этом устройстве в кабинете. Включить его снова можно в кабинете '
                            'на вкладке «Устройства».'
                        : 'По тарифу касса работает на ${state.max} ${_devices(state.max)}, а подключено ${state.active}. '
                            'Это устройство подключили последним, поэтому касса на нём пока не работает.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 15, height: 1.45, color: AppColors.textMuted),
                  ),
                  if (!state.disabled) ...[
                    const SizedBox(height: 6),
                    Text(
                      'Удалите устройство, которым больше не пользуетесь (нужен PIN администратора), или перейдите на '
                      'тариф с большим числом устройств. Касса откроется сама.',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 14, height: 1.45, color: AppColors.textMuted),
                    ),
                    const SizedBox(height: 18),
                    const DevicesPanel(),
                    const SizedBox(height: 20),
                    FilledButton.icon(
                      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                      onPressed: () => _open(context, billingUrl),
                      icon: const Icon(Icons.trending_up_rounded),
                      label: const Text('Перейти на тариф с большим числом устройств'),
                    ),
                    const SizedBox(height: 10),
                  ] else
                    const SizedBox(height: 22),
                  OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                    onPressed: () => _open(context, devicesUrl),
                    icon: const Icon(Icons.devices_outlined),
                    label: const Text('Устройства в кабинете'),
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
