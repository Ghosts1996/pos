import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../models/employee.dart';
import '../../models/reservation_model.dart';
import '../../models/table_model.dart';
import '../../services/firestore_service.dart';
import '../../services/guest_link_service.dart';
import '../../services/notification_service.dart';
import '../../services/reservation_service.dart';
import '../../services/ai/ai_agents.dart';
import '../../theme/app_colors.dart';
import '../../widgets/ai_assistant_sheet.dart';
import '../../widgets/table_picker_map.dart';
import 'table_detail_screen.dart';

/// Экран хостес: брони на выбранный день в реальном времени.
/// Сюда мгновенно прилетают брони из клиентского приложения
/// «Colibri Lounge» — подтверждение, назначение стола, посадка.
class ReservationsScreen extends StatefulWidget {
  final Employee employee;
  const ReservationsScreen({super.key, required this.employee});

  @override
  State<ReservationsScreen> createState() => _ReservationsScreenState();
}

class _ReservationsScreenState extends State<ReservationsScreen> {
  final _service = ReservationService();
  final _fs = FirestoreService();
  final _guestLink = GuestLinkService();
  DateTime _day = DateTime.now();

  /// Разрешены ли уведомления на планшете.
  ///
  /// Если на Android 13+ сотрудник один раз отказал в разрешении, новые
  /// брони и вызовы гостей перестают всплывать — молча, без единого следа
  /// в приложении. Проверяем и говорим об этом прямо на экране броней:
  /// именно здесь замечают, что «уведомления не приходят».
  bool _notificationsOn = true;

  @override
  void initState() {
    super.initState();
    _checkNotifications();
  }

  Future<void> _checkNotifications() async {
    final on = await NotificationService.instance.areEnabled();
    if (mounted) setState(() => _notificationsOn = on);
  }

  Future<void> _enableNotifications() async {
    await NotificationService.instance.requestPermission();
    await _checkNotifications();
  }

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
      body: Column(
        children: [
          if (!_notificationsOn)
            Material(
              color: AppColors.warning.withValues(alpha: 0.15),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                child: Row(
                  children: [
                    const Icon(Icons.notifications_off,
                        color: AppColors.warning, size: 20),
                    const SizedBox(width: 10),
                    const Expanded(
                      child: Text(
                        'Уведомления на планшете выключены — новые брони и '
                        'вызовы гостей не всплывают',
                        style: TextStyle(fontSize: 13),
                      ),
                    ),
                    TextButton(
                      onPressed: _enableNotifications,
                      child: const Text('Включить'),
                    ),
                  ],
                ),
              ),
            ),
          Expanded(
            child: _list(),
          ),
        ],
      ),
    );
  }

  Widget _list() {
    return StreamBuilder<List<ReservationModel>>(
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
                      '${r.source == 'kolibri' ? ' · Colibri' : ''}',
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
    final picked = await _pickTableOnMap(
      start: r.startTime,
      durationMinutes: r.durationMinutes,
      guestsCount: r.guestsCount,
    );
    if (picked != null) {
      await _guard(() => _service.assignTable(r.id, picked));
    }
  }

  /// Открывает карту зала и возвращает выбранный (свободный на этот
  /// интервал) стол — используется и при смене стола у существующей брони,
  /// и при выборе стола для новой брони по телефону.
  Future<TableModel?> _pickTableOnMap({
    required DateTime start,
    required int durationMinutes,
    required int guestsCount,
  }) async {
    final results = await Future.wait([
      _fs.tablesStream().first,
      _service.availableTables(
        start: start,
        durationMinutes: durationMinutes,
        guestsCount: guestsCount,
      ),
      _service.dayStream(start).first,
    ]);
    if (!mounted) return null;

    final allTables = results[0] as List<TableModel>;
    final freeIds = (results[1] as List<TableModel>).map((t) => t.id).toSet();
    // На POS подпись занятости полная — сотрудник вправе видеть, кто и на
    // сколько человек держит стол.
    final busyIntervals = (results[2] as List<ReservationModel>)
        .where((r) => r.status.blocksTable || r.status == ReservationStatus.seated)
        .map((r) => TableBusyInterval(
              tableId: r.tableId,
              startTime: r.startTime,
              endTime: r.endTime,
              description: '${r.guestName} · ${r.guestsCount} чел · ${r.status.label}',
            ))
        .toList();

    if (allTables.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Столы ещё не добавлены администратором')));
      return null;
    }

    return showModalBottomSheet<TableModel>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surface,
      builder: (ctx) => DraggableScrollableSheet(
        initialChildSize: 0.75,
        minChildSize: 0.5,
        maxChildSize: 0.95,
        expand: false,
        builder: (ctx, scrollController) => Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            children: [
              const Padding(
                padding: EdgeInsets.only(bottom: 8),
                child: Text('Выберите стол на карте',
                    style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
              ),
              Expanded(
                child: TablePickerMap(
                  tables: allTables,
                  freeTableIds: freeIds,
                  busyIntervals: busyIntervals,
                  start: start,
                  durationMinutes: durationMinutes,
                  onSelect: (t) => Navigator.pop(ctx, t),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _createManual() async {
    final nameCtrl = TextEditingController();
    final phoneCtrl = TextEditingController();
    var guests = 2;
    var time = TimeOfDay.fromDateTime(DateTime.now().add(const Duration(hours: 1)));
    TableModel? pickedTable;

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
                    onPressed: () => setLocal(() {
                      guests = (guests - 1).clamp(1, 20);
                      pickedTable = null; // вместимость изменилась — выбор стола сбрасываем
                    }),
                    icon: const Icon(Icons.remove_circle_outline),
                  ),
                  Text('$guests', style: const TextStyle(fontSize: 16)),
                  IconButton(
                    onPressed: () => setLocal(() {
                      guests = (guests + 1).clamp(1, 20);
                      pickedTable = null;
                    }),
                    icon: const Icon(Icons.add_circle_outline),
                  ),
                ],
              ),
              TextButton.icon(
                onPressed: () async {
                  final picked = await showTimePicker(context: ctx, initialTime: time);
                  if (picked != null) {
                    setLocal(() {
                      time = picked;
                      pickedTable = null; // время изменилось — стол мог освободиться/занят
                    });
                  }
                },
                icon: const Icon(Icons.schedule),
                label: Text('Время: ${time.format(ctx)}'),
              ),
              TextButton.icon(
                onPressed: () async {
                  final start = DateTime(_day.year, _day.month, _day.day, time.hour, time.minute);
                  final t = await _pickTableOnMap(
                    start: start,
                    durationMinutes: 90,
                    guestsCount: guests,
                  );
                  if (t != null) setLocal(() => pickedTable = t);
                },
                icon: const Icon(Icons.table_restaurant),
                label: Text(pickedTable == null
                    ? 'Стол: подберём автоматически'
                    : 'Стол: ${pickedTable!.name}'),
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
    final phone = _normalizePhone(phoneCtrl.text.trim());

    // Если гость уже ставил себе телефон в «Colibri Lounge» — находим его
    // профиль и привязываем бронь к нему: тогда она сразу появится в его
    // приложении и придёт пуш о подтверждении. Если профиля ещё нет —
    // бронь всё равно создаётся, просто без привязки (гость не увидит её
    // в приложении, пока не зарегистрируется тем же номером).
    final existingClient = phone.isEmpty ? null : await _guestLink.findByPhone(phone);

    await _guard(() async {
      await _service.create(ReservationModel(
        id: '',
        clientUid: existingClient?.uid ?? '',
        guestName: nameCtrl.text.trim().isEmpty ? 'Гость' : nameCtrl.text.trim(),
        phone: phone,
        guestsCount: guests,
        tableId: pickedTable?.id ?? '',
        tableName: pickedTable?.name ?? '',
        startTime: start,
        status: ReservationStatus.confirmed,
        source: 'phone',
        handledBy: widget.employee.name,
        createdAt: DateTime.now(),
      ));
    });

    if (existingClient == null && phone.isNotEmpty && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Бронь создана. Гость не найден в приложении — '
            'уведомление не отправлено, покажется только при входе тем же номером.'),
      ));
    }
  }

  /// Приводит номер к формату, в котором он хранится в профиле гостя
  /// («Colibri Lounge» использует Firebase Phone Auth — там номер всегда
  /// в E.164: +7XXXXXXXXXX). Без этого поиск по строке findByPhone почти
  /// никогда не совпадёт с тем, что ввёл сотрудник.
  String _normalizePhone(String raw) {
    var digits = raw.replaceAll(RegExp(r'[^0-9+]'), '');
    if (digits.isEmpty) return '';
    if (digits.startsWith('+7')) return digits;
    if (digits.startsWith('8') && digits.length == 11) return '+7${digits.substring(1)}';
    if (digits.startsWith('7') && digits.length == 11) return '+$digits';
    if (digits.startsWith('9') && digits.length == 10) return '+7$digits';
    return digits.startsWith('+') ? digits : '+$digits';
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

  Future<void> _showPhone(String phone) async {
    final uri = Uri(scheme: 'tel', path: phone);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
    } else if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(phone)));
    }
  }

  String _fmtDay(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}';

  String _fmtTime(DateTime d) =>
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}
