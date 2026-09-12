import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/venue_models.dart';
import '../../services/waitlist_service.dart';
import '../../theme/app_colors.dart';

/// Лист ожидания: очередь гостей, когда все столы заняты.
///
/// Показывает, сколько человек ждёт и как долго, даёт пригласить гостя
/// (уходит push «стол готов»), посадить, отметить ушедшим или перевести
/// ожидание в бронь на конкретное время.
class WaitlistScreen extends StatefulWidget {
  final Employee employee;
  const WaitlistScreen({super.key, required this.employee});

  @override
  State<WaitlistScreen> createState() => _WaitlistScreenState();
}

class _WaitlistScreenState extends State<WaitlistScreen> {
  final _service = WaitlistService.instance;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Лист ожидания')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _add,
        icon: const Icon(Icons.person_add_alt),
        label: const Text('Записать гостя'),
      ),
      body: StreamBuilder<List<WaitlistEntry>>(
        stream: _service.openStream(),
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final list = snap.data!;
          if (list.isEmpty) {
            return const Center(
              child: Text('Очереди нет — столы есть',
                  style: TextStyle(color: AppColors.textMuted)),
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: list.length,
            separatorBuilder: (_, __) => const SizedBox(height: 10),
            itemBuilder: (_, i) => _tile(list[i], i + 1),
          );
        },
      ),
    );
  }

  Widget _tile(WaitlistEntry e, int position) {
    final invited = e.status == 'invited';
    // Ждёт дольше обещанного — повод подойти и извиниться раньше, чем гость
    // уйдёт сам.
    final overdue = e.promisedMinutes > 0 && e.waitingMinutes > e.promisedMinutes;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: overdue
              ? AppColors.danger
              : invited
                  ? AppColors.success
                  : AppColors.border,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 16,
                backgroundColor: AppColors.selection,
                child: Text('$position', style: const TextStyle(color: AppColors.textPrimary)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${e.guestName} · ${e.guestsCount} чел.',
                        style: const TextStyle(
                            color: AppColors.textPrimary,
                            fontSize: 16,
                            fontWeight: FontWeight.w600)),
                    Text(
                      'ждёт ${e.waitingMinutes} мин'
                      '${e.promisedMinutes > 0 ? ' · обещали ~${e.promisedMinutes}' : ''}'
                      '${invited ? ' · приглашён' : ''}'
                      '${e.source == 'kolibri' ? ' · Колибри' : ''}',
                      style: TextStyle(
                        color: overdue ? AppColors.danger : AppColors.textMuted,
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (e.comment.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('«${e.comment}»',
                style: const TextStyle(color: AppColors.textMuted, fontStyle: FontStyle.italic)),
          ],
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            children: [
              if (!invited)
                FilledButton(
                  onPressed: () => _service.invite(e),
                  child: const Text('Стол готов'),
                ),
              FilledButton.tonal(
                onPressed: () => _service.markSeated(e.id),
                child: const Text('Посадили'),
              ),
              TextButton(
                onPressed: () => _toReservation(e),
                child: const Text('В бронь'),
              ),
              TextButton(
                onPressed: () => _service.markLeft(e.id),
                child: const Text('Ушёл', style: TextStyle(color: AppColors.danger)),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _toReservation(WaitlistEntry e) async {
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(DateTime.now().add(const Duration(hours: 2))),
    );
    if (time == null) return;
    final now = DateTime.now();
    final start = DateTime(now.year, now.month, now.day, time.hour, time.minute);
    try {
      await _service.convertToReservation(
        e,
        start.isBefore(now) ? start.add(const Duration(days: 1)) : start,
        employeeName: widget.employee.name,
      );
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Гость переведён в бронь')));
      }
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$err')));
      }
    }
  }

  Future<void> _add() async {
    final name = TextEditingController();
    final phone = TextEditingController();
    var guests = 2;

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: const Text('Записать в очередь'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: name, decoration: const InputDecoration(labelText: 'Имя')),
              TextField(
                controller: phone,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(labelText: 'Телефон'),
              ),
              const SizedBox(height: 12),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  IconButton(
                    onPressed: () => setLocal(() => guests = (guests - 1).clamp(1, 20)),
                    icon: const Icon(Icons.remove_circle_outline),
                  ),
                  Text('$guests чел.', style: const TextStyle(fontSize: 16)),
                  IconButton(
                    onPressed: () => setLocal(() => guests = (guests + 1).clamp(1, 20)),
                    icon: const Icon(Icons.add_circle_outline),
                  ),
                ],
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Записать')),
          ],
        ),
      ),
    );
    if (ok != true) return;

    final result = await _service.join(
      guestName: name.text.trim(),
      guestsCount: guests,
      phone: phone.text.trim(),
      source: 'pos',
    );
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('В очереди ${result.position}-й, ожидание ~${result.minutes} мин')),
      );
    }
  }
}
