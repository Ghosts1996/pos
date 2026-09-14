import 'dart:async';

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
class BookingSoonCard extends StatefulWidget {
  final String clientUid;

  const BookingSoonCard({super.key, required this.clientUid});

  @override
  State<BookingSoonCard> createState() => _BookingSoonCardState();
}

class _BookingSoonCardState extends State<BookingSoonCard> {
  Timer? _tick;
  bool _busy = false;
  // Поток создаётся один раз. Если собирать его прямо в build(), каждый
  // тик таймера давал бы StreamBuilder новый объект: подписка на Firestore
  // пересоздавалась бы раз в полминуты, а плашка на мгновение пропадала
  // бы с экрана, пока не придут данные.
  late Stream<List<ReservationModel>> _stream;

  @override
  void initState() {
    super.initState();
    _stream = ReservationService().clientStream(widget.clientUid);
    // Плашка зависит не только от данных, но и от текущего времени: гость
    // может открыть приложение за час до брони и держать его открытым.
    // Без этого таймера StreamBuilder пересчитывался бы только при
    // изменении брони в базе — то есть плашка не появлялась бы вовсе, а
    // «через N минут» показывало время открытия экрана.
    _tick = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void didUpdateWidget(BookingSoonCard old) {
    super.didUpdateWidget(old);
    // Экран могли построить до того, как завершился анонимный вход: тогда
    // uid приходит позже, и поток надо пересобрать — иначе плашка на этом
    // запуске приложения не появится уже никогда.
    if (old.clientUid != widget.clientUid) {
      _stream = ReservationService().clientStream(widget.clientUid);
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _answer(Future<void> Function() action, String ok) async {
    if (_busy) return; // защита от второго нажатия, пока идёт запись
    setState(() => _busy = true);
    try {
      await action();
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(ok)));
      }
    } catch (_) {
      // Молчать нельзя: гость нажал кнопку и должен понимать, что ответ
      // не ушёл, — иначе он будет уверен, что бронь отменена.
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Не удалось отправить ответ. Проверьте связь')),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.clientUid.isEmpty) return const SizedBox.shrink();

    return StreamBuilder<List<ReservationModel>>(
      stream: _stream,
      builder: (context, snap) {
        final now = DateTime.now();
        final soon = (snap.data ?? const <ReservationModel>[]).where((r) {
          if (r.guestConfirmed) return false;
          if (!r.status.blocksTable) return false;
          final left = r.startTime.difference(now);
          // Полчаса до начала и не больше десяти минут после: опоздавшего
          // тоже стоит спросить, ждать ли его.
          return left.inMinutes <= 30 && left.inMinutes >= -10;
        }).toList()
          // Поток отсортирован от поздних к ранним, а спрашивать надо про
          // ближайшую бронь — иначе при двух бронях подряд гость отвечал бы
          // про вечернюю, а вот-вот начиналась утренняя.
          ..sort((a, b) => a.startTime.compareTo(b.startTime));
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
                      onPressed: _busy
                          ? null
                          : () => _answer(() => ReservationService().guestConfirm(r.id),
                              'Спасибо, ждём вас'),
                      child: const Text('Приду'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _busy
                          ? null
                          : () => _answer(
                              () => ReservationService().cancel(r.id, by: 'гость'),
                              'Бронь отменена. Спасибо, что предупредили'),
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
