import 'package:flutter/material.dart';

import '../services/plan_capabilities.dart';
import '../theme/app_colors.dart';

/// Устройства заведения с кассой: каждое физическое устройство — планшет на
/// кухне, планшет на баре, телефон официанта, компьютер — считается
/// отдельно. Здесь видно, сколько подключено и сколько разрешает тариф и на
/// каких касса работает. Удаляет и восстанавливает устройства только
/// владелец заведения — в кабинете («Устройства»).
///
/// Используется на экране «Лимит устройств тарифа».
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
        ? 'удалено владельцем'
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
      ]),
    );
  }
}
