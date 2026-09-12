import 'package:flutter/material.dart';
import '../../models/reservation_model.dart';
import '../../models/session_model.dart';
import '../../services/guest_link_service.dart';
import '../../services/reservation_service.dart';
import '../services/kolibri_auth_service.dart';
import '../theme/kolibri_theme.dart';
import 'kolibri_menu_screen.dart';

/// Бронирование стола гостем. Слоты считаются по реальной занятости:
/// учитываются и другие брони, и открытые прямо сейчас чеки на POS,
/// поэтому «двойной посадки» не происходит.
class KolibriBookingScreen extends StatefulWidget {
  const KolibriBookingScreen({super.key});

  @override
  State<KolibriBookingScreen> createState() => _KolibriBookingScreenState();
}

class _KolibriBookingScreenState extends State<KolibriBookingScreen> {
  final _service = ReservationService();
  final _link = GuestLinkService();
  final _auth = KolibriAuthService();

  final _nameCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _commentCtrl = TextEditingController();

  DateTime _day = DateTime.now();
  int _guests = 2;
  int _duration = 90;
  DateTime? _slot;
  List<DateTime> _slots = const [];
  List<OrderItem> _preOrder = const [];

  bool _loadingSlots = false;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _prefill();
    _loadSlots();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _phoneCtrl.dispose();
    _commentCtrl.dispose();
    super.dispose();
  }

  Future<void> _prefill() async {
    final p = await _link.profileStream(_auth.uid).first;
    if (p != null && mounted) {
      _nameCtrl.text = p.name;
      _phoneCtrl.text = p.phone;
      setState(() {});
    }
  }

  Future<void> _loadSlots() async {
    setState(() {
      _loadingSlots = true;
      _slot = null;
    });
    try {
      final slots = await _service.availableSlots(
        day: _day,
        durationMinutes: _duration,
        guestsCount: _guests,
      );
      if (mounted) setState(() => _slots = slots);
    } catch (_) {
      if (mounted) setState(() => _slots = const []);
    }
    if (mounted) setState(() => _loadingSlots = false);
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 120),
      children: [
        const Text('Бронь стола',
            style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        const Text('Подтверждение придёт в приложение — обычно в течение 15 минут',
            style: TextStyle(color: KolibriColors.textMuted, fontSize: 13)),
        const SizedBox(height: 20),

        _label('Дата'),
        SizedBox(
          height: 84,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: 14,
            separatorBuilder: (_, __) => const SizedBox(width: 10),
            itemBuilder: (_, i) {
              final d = DateTime.now().add(Duration(days: i));
              final selected = d.day == _day.day && d.month == _day.month;
              return InkWell(
                onTap: () {
                  setState(() => _day = d);
                  _loadSlots();
                },
                borderRadius: BorderRadius.circular(14),
                child: Container(
                  width: 64,
                  decoration: BoxDecoration(
                    color: selected ? KolibriColors.primary : KolibriColors.surface,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: KolibriColors.border),
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(_weekday(d),
                          style: TextStyle(
                              fontSize: 12,
                              color: selected ? Colors.white70 : KolibriColors.textMuted)),
                      const SizedBox(height: 4),
                      Text('${d.day}',
                          style: TextStyle(
                              fontSize: 20,
                              fontWeight: FontWeight.w700,
                              color: selected ? Colors.white : KolibriColors.textPrimary)),
                    ],
                  ),
                ),
              );
            },
          ),
        ),

        const SizedBox(height: 20),
        _label('Гостей'),
        Wrap(
          spacing: 8,
          children: [1, 2, 3, 4, 5, 6, 8, 10]
              .map((n) => ChoiceChip(
                    label: Text('$n'),
                    selected: _guests == n,
                    onSelected: (_) {
                      setState(() => _guests = n);
                      _loadSlots();
                    },
                    backgroundColor: KolibriColors.surface,
                    selectedColor: KolibriColors.primary.withValues(alpha: 0.22),
                    side: const BorderSide(color: KolibriColors.border),
                  ))
              .toList(),
        ),

        const SizedBox(height: 20),
        _label('Продолжительность'),
        Wrap(
          spacing: 8,
          children: [60, 90, 120, 180]
              .map((m) => ChoiceChip(
                    label: Text(m >= 60 ? '${m ~/ 60} ч${m % 60 == 0 ? '' : ' 30 м'}' : '$m мин'),
                    selected: _duration == m,
                    onSelected: (_) {
                      setState(() => _duration = m);
                      _loadSlots();
                    },
                    backgroundColor: KolibriColors.surface,
                    selectedColor: KolibriColors.primary.withValues(alpha: 0.22),
                    side: const BorderSide(color: KolibriColors.border),
                  ))
              .toList(),
        ),

        const SizedBox(height: 20),
        _label('Свободное время'),
        if (_loadingSlots)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 16),
            child: LinearProgressIndicator(),
          )
        else if (_slots.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: Text('На этот день свободных столов нет — выберите другую дату',
                style: TextStyle(color: KolibriColors.warning)),
          )
        else
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: _slots
                .map((s) => ChoiceChip(
                      label: Text(_fmtTime(s)),
                      selected: _slot == s,
                      onSelected: (_) => setState(() => _slot = s),
                      backgroundColor: KolibriColors.surface,
                      selectedColor: KolibriColors.primary.withValues(alpha: 0.22),
                      side: const BorderSide(color: KolibriColors.border),
                    ))
                .toList(),
          ),

        const SizedBox(height: 24),
        _label('Контакты'),
        TextField(
          controller: _nameCtrl,
          decoration: const InputDecoration(labelText: 'Имя'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _phoneCtrl,
          keyboardType: TextInputType.phone,
          decoration: const InputDecoration(labelText: 'Телефон'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _commentCtrl,
          maxLines: 2,
          decoration: const InputDecoration(
            labelText: 'Пожелания',
            hintText: 'Диван у окна, день рождения, без музыки…',
          ),
        ),

        const SizedBox(height: 20),
        OutlinedButton.icon(
          onPressed: () async {
            final items = await pickPreOrder(context);
            if (items != null) setState(() => _preOrder = items);
          },
          icon: const Icon(Icons.restaurant_menu),
          label: Text(_preOrder.isEmpty
              ? 'Добавить предзаказ (необязательно)'
              : 'Предзаказ: ${_preOrder.length} поз. на '
                  '${_preOrder.fold<double>(0, (s, i) => s + i.total).toStringAsFixed(0)} ₽'),
        ),

        const SizedBox(height: 24),
        FilledButton(
          onPressed: _slot == null || _sending ? null : _submit,
          child: _sending
              ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
              : Text(_slot == null
                  ? 'Выберите время'
                  : 'Забронировать на ${_fmtTime(_slot!)}'),
        ),

        const SizedBox(height: 32),
        const Text('Мои брони', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        const SizedBox(height: 12),
        StreamBuilder<List<ReservationModel>>(
          stream: _service.clientStream(_auth.uid),
          builder: (context, snap) {
            final list = snap.data ?? const <ReservationModel>[];
            if (list.isEmpty) {
              return const Text('Пока броней нет',
                  style: TextStyle(color: KolibriColors.textMuted));
            }
            return Column(
              children: list.take(10).map(_reservationTile).toList(),
            );
          },
        ),
      ],
    );
  }

  Widget _reservationTile(ReservationModel r) {
    final active = r.status.blocksTable && r.endTime.isAfter(DateTime.now());
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        leading: Icon(
          active ? Icons.event_available : Icons.history,
          color: active ? KolibriColors.primary : KolibriColors.textMuted,
        ),
        title: Text('${_fmtDate(r.startTime)} в ${_fmtTime(r.startTime)}'),
        subtitle: Text(
          '${r.guestsCount} чел · ${r.tableName.isEmpty ? 'стол подберём' : r.tableName} · '
          '${r.status.label}',
          style: const TextStyle(fontSize: 12),
        ),
        trailing: active
            ? TextButton(
                onPressed: () => _cancel(r),
                child: const Text('Отменить',
                    style: TextStyle(color: KolibriColors.danger)),
              )
            : null,
      ),
    );
  }

  Future<void> _cancel(ReservationModel r) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Отменить бронь?'),
        content: Text('${_fmtDate(r.startTime)} в ${_fmtTime(r.startTime)}'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Нет')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Отменить')),
        ],
      ),
    );
    if (ok == true) {
      await _service.cancel(r.id, by: 'guest');
      _loadSlots();
    }
  }

  Future<void> _submit() async {
    if (_slot == null) return;
    setState(() => _sending = true);

    try {
      final profile = await _link.ensureProfile(_auth.uid);
      await _link.updateProfile(_auth.uid, {
        'name': _nameCtrl.text.trim(),
        'phone': _phoneCtrl.text.trim(),
      });

      await _service.create(ReservationModel(
        id: '',
        clientUid: profile.uid,
        guestName: _nameCtrl.text.trim().isEmpty ? 'Гость' : _nameCtrl.text.trim(),
        phone: _phoneCtrl.text.trim(),
        guestsCount: _guests,
        startTime: _slot!,
        durationMinutes: _duration,
        comment: _commentCtrl.text.trim(),
        preOrder: _preOrder,
        source: 'kolibri',
        createdAt: DateTime.now(),
      ));

      if (!mounted) return;
      setState(() {
        _preOrder = const [];
        _commentCtrl.clear();
      });
      await _loadSlots();
      if (!mounted) return;
      showDialog(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Бронь отправлена'),
          content: const Text(
              'Мы придержим стол и подтвердим бронь в приложении. '
              'Если планы поменяются — отмените её здесь же.'),
          actions: [
            FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Хорошо')),
          ],
        ),
      );
    } on NoTablesAvailableException {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Это время только что заняли — выберите другое')),
        );
        _loadSlots();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
    if (mounted) setState(() => _sending = false);
  }

  Widget _label(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Text(text,
            style: const TextStyle(
                fontSize: 15, fontWeight: FontWeight.w600, color: KolibriColors.textPrimary)),
      );

  String _weekday(DateTime d) =>
      const ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][d.weekday - 1];

  String _fmtDate(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}';

  String _fmtTime(DateTime d) =>
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}
