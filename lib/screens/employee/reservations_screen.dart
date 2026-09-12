import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/reservation_model.dart';
import '../../models/table_model.dart';
import '../../services/firestore_service.dart';
import '../../services/reservation_service.dart';
import '../../services/ai/ai_agents.dart';
import '../../theme/app_colors.dart';
import '../../widgets/ai_assistant_sheet.dart';
import 'table_detail_screen.dart';

/// Экран хостес: брони на выбранный день в реальном времени.
/// Сюда мгновенно прилетают брони из клиентского приложения
/// «Колибри Лаундж» — подтверждение, назначение стола, посадка.
class ReservationsScreen extends StatefulWidget {
  final Employee employee;
  const ReservationsScreen({super.key, required this.employee});

  @override
  State<ReservationsScreen> createState() => _ReservationsScreenState();
}

class _ReservationsScreenState extends State<ReservationsScreen> {
  final _service = ReservationService();
  final _fs = FirestoreService();
  DateTime _day = DateTime.now();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Брони — ${_fmtDay(_day)}'),
        actions: [
          IconButton(
            tooltip: 'ИИ: разбор броней',
            icon: const Icon(Icons.auto_awesome),
            onPressed: () => AiAssistantSheet.show(
              context,
              agent: AiAgents.hostess,
              initialQuestion: 'Разбери брони на ближайшую смену.',
              asyncContextBuilder: () async => '',
              quickPrompts: const [
                'Где конфликты по столам?',
                'Кого лучше пересадить?',
                'Какие брони рискуют не прийти?',
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.calendar_month),
            onPressed: _pickDay,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _createManual,
        icon: const Icon(Icons.add),
        label: const Text('Бронь по телефону'),
      ),
      body: StreamBuilder<List<ReservationModel>>(
        stream: _service.dayStream(_day),
        builder: (context, snap) {
          if (snap.hasError) {
            return Center(child: Text('Ошибка: ${snap.error}'));
          }
          if (!snap.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          final list = snap.data!;
          if (list.isEmpty) {
            return const Center(
              child: Text('На этот день броней нет',
                  style: TextStyle(color: AppColors.textMuted)),
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.all(12),
            itemCount: list.length,
            separatorBuilder: (_, __) => const SizedBox(height: 10),
            itemBuilder: (_, i) => _tile(list[i]),
          );
        },
      ),
    );
  }

  Widget _tile(ReservationModel r) {
    final color = switch (r.status) {
      ReservationStatus.newRequest => AppColors.warning,
      ReservationStatus.confirmed => AppColors.primary,
      ReservationStatus.seated => AppColors.success,
      _ => AppColors.disabled,
    };

    return Container(
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withValues(alpha: 0.6)),
      ),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(_fmtTime(r.startTime),
                    style: TextStyle(color: color, fontWeight: FontWeight.w700, fontSize: 16)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${r.guestName} · ${r.guestsCount} чел.',
                        style: const TextStyle(
                            color: AppColors.textPrimary,
                            fontSize: 16,
                            fontWeight: FontWeight.w600)),
                    Text(
                      '${r.tableName.isEmpty ? 'стол не назначен' : r.tableName} · '
                      '${r.durationMinutes} мин · ${r.status.label}'
                      '${r.source == 'kolibri' ? ' · Колибри' : ''}',
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
                    ),
                  ],
                ),
              ),
              if (r.phone.isNotEmpty)
                IconButton(
                  icon: const Icon(Icons.phone, color: AppColors.textMuted),
                  onPressed: () => _showPhone(r.phone),
                ),
            ],
          ),
          if (r.comment.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('«${r.comment}»',
                style: const TextStyle(color: AppColors.textMuted, fontStyle: FontStyle.italic)),
          ],
          if (r.preOrder.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              'Предзаказ: ${r.preOrder.map((i) => '${i.name} ×${i.qty}').join(', ')} '
              '— ${r.preOrderTotal.toStringAsFixed(0)} ₽',
              style: const TextStyle(color: AppColors.success, fontSize: 13),
            ),
          ],
          if (r.aiNote.isNotEmpty) ...[
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.auto_awesome, size: 14, color: AppColors.primary),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(r.aiNote,
                      style: const TextStyle(color: AppColors.primary, fontSize: 12)),
                ),
              ],
            ),
          ],
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (r.status == ReservationStatus.newRequest)
                FilledButton.tonal(
                  onPressed: () => _guard(() => _service.confirm(r.id, widget.employee.name)),
                  child: const Text('Подтвердить'),
                ),
              if (r.status.blocksTable)
                OutlinedButton(
                  onPressed: () => _assignTable(r),
                  child: Text(r.tableId.isEmpty ? 'Назначить стол' : 'Сменить стол'),
                ),
              if (r.status.blocksTable && r.tableId.isNotEmpty)
                FilledButton(
                  onPressed: () => _seat(r),
                  child: const Text('Посадить'),
                ),
              if (r.status == ReservationStatus.seated && r.sessionId.isNotEmpty)
                TextButton(
                  onPressed: () => _openSession(r),
                  child: const Text('Открыть чек'),
                ),
              if (r.status.blocksTable) ...[
                TextButton(
                  onPressed: () => _guard(() => _service.markNoShow(r.id, widget.employee.name)),
                  child: const Text('Не пришёл'),
                ),
                TextButton(
                  onPressed: () => _guard(() => _service.cancel(r.id, by: widget.employee.name)),
                  child: const Text('Отменить',
                      style: TextStyle(color: AppColors.danger)),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }

  // ---------- ДЕЙСТВИЯ ----------

  Future<void> _guard(Future<void> Function() action) async {
    try {
      await action();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }

  Future<void> _seat(ReservationModel r) async {
    try {
      final sessionId = await _service.seat(reservation: r, employeeName: widget.employee.name);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Гость посажен, чек открыт')));
      final table = await _fs.tableStream(r.tableId).first;
      if (table != null && mounted) {
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (_) => TableDetailScreen(
              table: table,
              sessionId: sessionId,
              employee: widget.employee,
            ),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }

  Future<void> _openSession(ReservationModel r) async {
    final table = await _fs.tableStream(r.tableId).first;
    if (table == null || !mounted) return;
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => TableDetailScreen(
          table: table,
          sessionId: r.sessionId,
          employee: widget.employee,
        ),
      ),
    );
  }

  Future<void> _assignTable(ReservationModel r) async {
    final free = await _service.availableTables(
      start: r.startTime,
      durationMinutes: r.durationMinutes,
      guestsCount: r.guestsCount,
    );
    if (!mounted) return;

    final picked = await showModalBottomSheet<TableModel>(
      context: context,
      backgroundColor: AppColors.surface,
      builder: (_) => SafeArea(
        child: free.isEmpty
            ? const Padding(
                padding: EdgeInsets.all(24),
                child: Text('Свободных столов на это время нет'),
              )
            : ListView(
                shrinkWrap: true,
                children: free
                    .map((t) => ListTile(
                          leading: const Icon(Icons.table_restaurant),
                          title: Text(t.name),
                          subtitle: Text('${t.seats} мест'),
                          onTap: () => Navigator.pop(context, t),
                        ))
                    .toList(),
              ),
      ),
    );
    if (picked != null) {
      await _guard(() => _service.assignTable(r.id, picked));
    }
  }

  Future<void> _createManual() async {
    final nameCtrl = TextEditingController();
    final phoneCtrl = TextEditingController();
    var guests = 2;
    var time = TimeOfDay.fromDateTime(DateTime.now().add(const Duration(hours: 1)));

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: const Text('Новая бронь'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: nameCtrl,
                decoration: const InputDecoration(labelText: 'Имя гостя'),
              ),
              TextField(
                controller: phoneCtrl,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(labelText: 'Телефон'),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  const Text('Гостей:'),
                  const SizedBox(width: 12),
                  IconButton(
                    onPressed: () => setLocal(() => guests = (guests - 1).clamp(1, 20)),
                    icon: const Icon(Icons.remove_circle_outline),
                  ),
                  Text('$guests', style: const TextStyle(fontSize: 16)),
                  IconButton(
                    onPressed: () => setLocal(() => guests = (guests + 1).clamp(1, 20)),
                    icon: const Icon(Icons.add_circle_outline),
                  ),
                ],
              ),
              TextButton.icon(
                onPressed: () async {
                  final picked = await showTimePicker(context: ctx, initialTime: time);
                  if (picked != null) setLocal(() => time = picked);
                },
                icon: const Icon(Icons.schedule),
                label: Text('Время: ${time.format(ctx)}'),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Создать')),
          ],
        ),
      ),
    );

    if (ok != true) return;
    final start = DateTime(_day.year, _day.month, _day.day, time.hour, time.minute);
    await _guard(() async {
      await _service.create(ReservationModel(
        id: '',
        guestName: nameCtrl.text.trim().isEmpty ? 'Гость' : nameCtrl.text.trim(),
        phone: phoneCtrl.text.trim(),
        guestsCount: guests,
        startTime: start,
        status: ReservationStatus.confirmed,
        source: 'phone',
        handledBy: widget.employee.name,
        createdAt: DateTime.now(),
      ));
    });
  }

  Future<void> _pickDay() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _day,
      firstDate: DateTime.now().subtract(const Duration(days: 30)),
      lastDate: DateTime.now().add(const Duration(days: 120)),
    );
    if (picked != null) setState(() => _day = picked);
  }

  void _showPhone(String phone) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(phone)));
  }

  String _fmtDay(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}';

  String _fmtTime(DateTime d) =>
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}
