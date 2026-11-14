import 'dart:async';

import 'package:flutter/material.dart';

import '../models/shift_model.dart';
import '../services/firestore_service.dart';
import '../theme/app_colors.dart';

/// Сторож 24-часовой смены ККТ (54-ФЗ, только SaaS): фискальная смена
/// длится не больше суток, потом регистратор перестаёт пробивать чеки.
/// За час до срока на экране зала — жёлтая плашка, после — красная.
/// Владельцу в бот уходит то же (telegram.js longShiftAlert).
enum ShiftAge { ok, soon, expired }

ShiftAge shiftAgeOf(DateTime openedAt, DateTime now) {
  final age = now.difference(openedAt);
  if (age >= const Duration(hours: 24)) return ShiftAge.expired;
  if (age >= const Duration(hours: 23)) return ShiftAge.soon;
  return ShiftAge.ok;
}

String shiftAgeText(DateTime openedAt, DateTime now) {
  String hm(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  return switch (shiftAgeOf(openedAt, now)) {
    ShiftAge.expired => 'Смена открыта больше 24 часов (с ${hm(openedAt)}): регистратор не пробивает чеки. '
        'Закройте смену Z-отчётом: меню → «Касса».',
    ShiftAge.soon => 'Смена открыта ${now.difference(openedAt).inHours} ч. Закройте её Z-отчётом до '
        '${hm(openedAt.add(const Duration(hours: 24)))} — иначе регистратор перестанет пробивать чеки.',
    ShiftAge.ok => '',
  };
}

class ShiftAgeBanner extends StatefulWidget {
  const ShiftAgeBanner({super.key});

  @override
  State<ShiftAgeBanner> createState() => _ShiftAgeBannerState();
}

class _ShiftAgeBannerState extends State<ShiftAgeBanner> {
  late final Stream<ShiftModel?> _shift = FirestoreService().openShiftStream();
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    // Смена «стареет» и без событий в базе — пересчитываем раз в минуту.
    _tick = Timer.periodic(const Duration(minutes: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<ShiftModel?>(
      stream: _shift,
      builder: (context, snap) {
        final shift = snap.data;
        if (shift == null) return const SizedBox.shrink();
        final now = DateTime.now();
        final level = shiftAgeOf(shift.openedAt, now);
        if (level == ShiftAge.ok) return const SizedBox.shrink();
        final color = level == ShiftAge.expired ? AppColors.danger : AppColors.warning;
        return Container(
          key: const ValueKey('shift-age-banner'),
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          color: color.withValues(alpha: 0.15),
          child: Row(children: [
            Icon(level == ShiftAge.expired ? Icons.error_outline : Icons.schedule, color: color),
            const SizedBox(width: 10),
            Expanded(child: Text(shiftAgeText(shift.openedAt, now), style: TextStyle(color: color, fontWeight: FontWeight.w600))),
          ]),
        );
      },
    );
  }
}
