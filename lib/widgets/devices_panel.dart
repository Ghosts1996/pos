import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/gateway_api.dart';
import '../services/plan_capabilities.dart';
import '../theme/app_colors.dart';
import '../utils/human_error.dart';

/// Устройства заведения с кассой: каждое физическое устройство — планшет на
/// кухне, планшет на баре, телефон официанта, компьютер — считается
/// отдельно. Здесь видно, сколько подключено и сколько разрешает тариф, на
/// каких касса работает, и можно удалить ненужное (PIN администратора).
///
/// Используется на экране «Лимит устройств тарифа» и в Админ → «Устройства».
class DevicesPanel extends StatelessWidget {
  const DevicesPanel({super.key});

  static String _plural(int n, String one, String few, String many) {
    final m10 = n % 10, m100 = n % 100;
    if (m10 == 1 && m100 != 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  static String _when(DateTime d) {
    String two(int n) => n.toString().padLeft(2, '0');
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(d.year, d.month, d.day);
    final hm = '${two(d.hour)}:${two(d.minute)}';
    if (day == today) return 'сегодня в $hm';
    if (day == today.subtract(const Duration(days: 1))) return 'вчера в $hm';
    return '${two(d.day)}.${two(d.month)}.${d.year}';
  }

  IconData _icon(DeviceSlot d) {
    if (d.usage.contains('кухн')) return Icons.soup_kitchen_outlined;
    if (d.platform == 'windows') return Icons.desktop_windows_outlined;
    return Icons.tablet_android_outlined;
  }

  Future<void> _remove(BuildContext context, DeviceSlot d) async {
    final pin = TextEditingController();
    String? error;
    var busy = false;
    final done = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) {
          Future<void> go() async {
            set(() {
              busy = true;
              error = null;
            });
            try {
              await GatewayApi.post('removeDevice', {'uid': d.id, 'adminPin': pin.text.trim()});
              if (ctx.mounted) Navigator.pop(ctx, true);
            } catch (e) {
              set(() {
                busy = false;
                error = humanError(e);
              });
            }
          }

          return AlertDialog(
            scrollable: true,
            title: Text('Удалить «${d.title}»?'),
            content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const Text('Касса на этом устройстве перестанет работать, место по тарифу освободится. '
                  'Понадобится снова — подключите его заново, оно встанет последним.'),
              const SizedBox(height: 14),
              TextField(
                controller: pin,
                autofocus: true,
                obscureText: true,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(8)],
                decoration: const InputDecoration(labelText: 'PIN администратора'),
                onSubmitted: (_) => busy ? null : go(),
              ),
              if (error != null) ...[
                const SizedBox(height: 8),
                Text(error!, style: TextStyle(color: AppColors.danger)),
              ],
            ]),
            actions: [
              TextButton(onPressed: busy ? null : () => Navigator.pop(ctx, false), child: const Text('Отмена')),
              FilledButton(
                style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
                onPressed: busy ? null : go,
                child: busy
                    ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Удалить'),
              ),
            ],
          );
        },
      ),
    );
    pin.dispose();
    if (done == true && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Устройство «${d.title}» удалено')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<PlanCapabilities>(
      valueListenable: PlanCapabilitiesService.current,
      builder: (context, caps, _) => ValueListenableBuilder<List<DeviceSlot>>(
        valueListenable: DeviceLimitGate.devices,
        builder: (context, list, _) {
          final max = caps.maxDevices;
          final active = list.where((d) => d.active).length;
          final me = DeviceLimitGate.myId;
          return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(
              max > 0
                  ? 'Подключено $active ${_plural(active, 'устройство', 'устройства', 'устройств')} из $max по тарифу'
                  : 'Подключено $active ${_plural(active, 'устройство', 'устройства', 'устройств')}, по тарифу без ограничений',
              style: TextStyle(
                  fontSize: 15, fontWeight: FontWeight.w700, color: max > 0 && active > max ? AppColors.warning : null),
            ),
            const SizedBox(height: 4),
            Text('Каждое устройство с кассой считается отдельно: планшет на кухне, планшет на баре, телефон официанта, компьютер.',
                style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
            const SizedBox(height: 8),
            for (final d in list)
              _row(context, d, mine: d.id == me, works: DeviceLimitGate.works(list, d.id, max)),
          ]);
        },
      ),
    );
  }

  Widget _row(BuildContext context, DeviceSlot d, {required bool mine, required bool works}) {
    final status = !d.active
        ? 'отключено в кабинете'
        : works
            ? ''
            : 'сверх лимита — касса не работает';
    final sub = [
      if (d.usage.isNotEmpty) d.usage,
      if (d.seenAt != null) 'на связи ${_when(d.seenAt!)}' else if (d.joinedAt != null) 'подключено ${_when(d.joinedAt!)}',
    ].join(' · ');
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: mine ? AppColors.primary : AppColors.border),
      ),
      child: Row(children: [
        Icon(_icon(d), color: works ? AppColors.textPrimary : AppColors.textMuted),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(mine ? '${d.title} · это устройство' : d.title,
                style: const TextStyle(fontWeight: FontWeight.w600), maxLines: 2, overflow: TextOverflow.ellipsis),
            if (sub.isNotEmpty) Text(sub, style: TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
            if (status.isNotEmpty) Text(status, style: TextStyle(fontSize: 12.5, color: AppColors.warning)),
          ]),
        ),
        if (!mine)
          TextButton(
            onPressed: () => _remove(context, d),
            style: TextButton.styleFrom(foregroundColor: AppColors.danger, minimumSize: const Size(0, 40)),
            child: const Text('Удалить'),
          ),
      ]),
    );
  }
}
