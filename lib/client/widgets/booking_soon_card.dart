import 'package:flutter/material.dart';

import '../../models/reservation_model.dart';
import '../../services/reservation_service.dart';
import '../theme/kolibri_theme.dart';

/// Плашка «Бронь скоро — придёте?».
///
/// Появляется за полчаса до брони, если гость ещё не ответил. Дублирует
/// уведомление, которое приходит за двадцать минут, и нужна именно как
/// дубль: уведомление могут не заметить, отключить в настройках телефона
/// или оно опоздает из-за экономии батареи. Плашка же видна всякому, кто
/// просто открыл приложение.
///
/// Ответ «Не приду» сразу отменяет бронь: заведение узнаёт о неявке за
/// двадцать минут и успевает отдать стол, а не держит его пустым час.
class BookingSoonCard extends StatelessWidget {
  final String clientUid;

  const BookingSoonCard({super.key, required this.clientUid});

  @override
  Widget build(BuildContext context) {
    if (clientUid.isEmpty) return const SizedBox.shrink();

    return StreamBuilder<List<ReservationModel>>(
      stream: ReservationService().clientStream(clientUid),
      builder: (context, snap) {
        final now = DateTime.now();
        final soon = snap.data?.where((r) {
          if (r.guestConfirmed) return false;
          if (!r.status.blocksTable) return false;
          final left = r.startTime.difference(now);
          // Полчаса до начала и не больше десяти минут после: опоздавшего
          // тоже стоит спросить, ждать ли его.
          return left.inMinutes <= 30 && left.inMinutes >= -10;
        }).toList() ?? const <ReservationModel>[];
        if (soon.isEmpty) return const SizedBox.shrink();

        final r = soon.first;
        final left = r.startTime.difference(now).inMinutes;

        return Container(
          margin: const EdgeInsets.only(bottom: 16),
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: KolibriColors.surface,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: KolibriColors.gold),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.event_available, color: KolibriColors.gold, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      left > 0 ? 'Бронь через $left ${_minutes(left)}' : 'Ваша бронь уже началась',
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                '${_time(r.startTime)}'
                '${r.tableName.isEmpty ? '' : ', стол ${r.tableName}'}'
                ' · ${r.guestsCount} чел. Подтвердите, что придёте, — или '
                'освободите стол для других.',
                style: const TextStyle(color: KolibriColors.textMuted, fontSize: 13),
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: FilledButton(
                      onPressed: () async {
                        await ReservationService().guestConfirm(r.id);
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('Спасибо, ждём вас')),
                          );
                        }
                      },
                      child: const Text('Приду'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () async {
                        await ReservationService().cancel(r.id, by: 'гость');
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(
                                content: Text('Бронь отменена. Спасибо, что предупредили')),
                          );
                        }
                      },
                      child: const Text('Не приду'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        );
      },
    );
  }

  String _minutes(int n) {
    final last = n % 10;
    final teen = n % 100 >= 11 && n % 100 <= 14;
    if (!teen && last == 1) return 'минуту';
    if (!teen && last >= 2 && last <= 4) return 'минуты';
    return 'минут';
  }

  String _time(DateTime d) =>
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}
