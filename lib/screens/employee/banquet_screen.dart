import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../models/menu_models.dart';
import '../../models/reservation_model.dart';
import '../../models/session_model.dart';
import '../../models/table_model.dart';
import '../../services/banquet_service.dart';
import '../../services/firestore_service.dart';
import '../../services/reservation_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/human_error.dart';
import '../../utils/money.dart';

/// Выбор стола: (начало, длительность) → стол или null.
typedef BanquetTablePicker = Future<TableModel?> Function(DateTime start, int durationMinutes);

/// Банкет (SaaS): гости, дата и время, длительность, главный стол, меню на
/// всех заранее, сумма предоплаты. При посадке меню уходит в чек, внесённая
/// предоплата — в счёт (как у брони с предоплатой). Бронь `kind: 'banquet'`.
class BanquetScreen extends StatefulWidget {
  final ReservationModel? existing;
  final DateTime day;
  final String employeeName;
  final BanquetTablePicker pickTable;

  const BanquetScreen({
    super.key,
    this.existing,
    required this.day,
    required this.employeeName,
    required this.pickTable,
  });

  @override
  State<BanquetScreen> createState() => _BanquetScreenState();
}

class _BanquetScreenState extends State<BanquetScreen> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _guests = TextEditingController(text: '10');
  final _comment = TextEditingController();
  final _prepay = TextEditingController();
  late DateTime _date;
  TimeOfDay _time = const TimeOfDay(hour: 18, minute: 0);
  int _hours = 4;
  String _tableId = '';
  String _tableName = '';
  final List<OrderItem> _menu = [];
  bool _saving = false;
  String? _error;

  ReservationModel? get _ex => widget.existing;

  @override
  void initState() {
    super.initState();
    _date = widget.day;
    final r = _ex;
    if (r != null) {
      _name.text = r.guestName;
      _phone.text = r.phone;
      _guests.text = '${r.guestsCount}';
      _comment.text = r.comment;
      _prepay.text = r.banquetPrepay > 0 ? _plain(r.banquetPrepay) : '';
      _date = DateTime(r.startTime.year, r.startTime.month, r.startTime.day);
      _time = TimeOfDay.fromDateTime(r.startTime);
      _hours = (r.durationMinutes / 60).round().clamp(1, 24);
      _tableId = r.tableId;
      _tableName = r.tableName;
      _menu.addAll(r.preOrder);
    }
    _guests.addListener(() => setState(() {}));
    _prepay.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    for (final c in [_name, _phone, _guests, _comment, _prepay]) {
      c.dispose();
    }
    super.dispose();
  }

  static String _plain(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(2);

  int get _guestCount => (int.tryParse(_guests.text.trim()) ?? 0).clamp(0, 1000);
  double get _menuTotal => _menu.fold(0.0, (s, i) => s + i.total);
  double get _prepaySum => double.tryParse(_prepay.text.trim().replaceAll(',', '.').replaceAll(' ', '')) ?? 0;
  DateTime get _start => DateTime(_date.year, _date.month, _date.day, _time.hour, _time.minute);

  void _setQty(int i, int qty) => setState(() {
        if (qty <= 0) {
          _menu.removeAt(i);
        } else {
          final x = _menu[i];
          _menu[i] = OrderItem(menuItemId: x.menuItemId, name: x.name, price: x.price, qty: qty, kind: x.kind, noPromo: x.noPromo);
        }
      });

  Future<void> _addFromMenu() async {
    final picked = await showModalBottomSheet<MenuItem>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surface,
      builder: (_) => const _MenuPickerSheet(),
    );
    if (picked == null) return;
    final guests = _guestCount < 1 ? 1 : _guestCount;
    setState(() {
      final i = _menu.indexWhere((x) => x.menuItemId == picked.id);
      if (i >= 0) {
        final x = _menu[i];
        _menu[i] = OrderItem(menuItemId: x.menuItemId, name: x.name, price: x.price, qty: x.qty + 1);
      } else {
        // Чаще всего позиция банкета — «на каждого гостя».
        _menu.add(OrderItem(menuItemId: picked.id, name: picked.name, price: picked.price, qty: guests));
      }
    });
  }

  Future<void> _pickTable() async {
    final t = await widget.pickTable(_start, _hours * 60);
    if (t != null) {
      setState(() {
        _tableId = t.id;
        _tableName = t.name;
      });
    }
  }

  Future<void> _save() async {
    final guests = _guestCount;
    if (!ReservationService.phoneLooksValid(_phone.text)) {
      setState(() => _error = 'Укажите телефон гостя — по нему подтверждают банкет');
      return;
    }
    if (guests < 1) {
      setState(() => _error = 'Сколько гостей?');
      return;
    }
    if (_tableId.isEmpty) {
      setState(() => _error = 'Выберите стол (или главный стол банкета)');
      return;
    }
    if (_prepaySum < 0) {
      setState(() => _error = 'Предоплата не может быть меньше нуля');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final base = (_ex ??
              ReservationModel(
                id: '',
                guestName: '',
                phone: '',
                startTime: _start,
                status: ReservationStatus.confirmed,
                source: 'phone',
                kind: 'banquet',
                createdAt: DateTime.now(),
              ))
          .copyWith(
        guestName: _name.text.trim().isEmpty ? 'Банкет' : _name.text.trim(),
        phone: _phone.text.trim(),
        guestsCount: guests,
        tableId: _tableId,
        tableName: _tableName,
        startTime: _start,
        durationMinutes: _hours * 60,
        comment: _comment.text.trim(),
        preOrder: List.of(_menu),
        handledBy: widget.employeeName,
        kind: 'banquet',
        banquetPrepay: (_prepaySum * 100).roundToDouble() / 100,
      );
      if (_ex == null) {
        await ReservationService().create(base, autoAssignTable: false);
      } else {
        await ReservationService().updateBanquet(base);
      }
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => _error = humanError(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Widget _section(String t) => Padding(
        padding: const EdgeInsets.only(top: 20, bottom: 8),
        child: Text(t, style: TextStyle(color: AppColors.textMuted, fontSize: 13, fontWeight: FontWeight.w700, letterSpacing: .3)),
      );

  @override
  Widget build(BuildContext context) {
    final guests = _guestCount < 1 ? 1 : _guestCount;
    final perGuest = _menuTotal / guests;
    final dd = '${_date.day.toString().padLeft(2, '0')}.${_date.month.toString().padLeft(2, '0')}.${_date.year}';
    return Scaffold(
      appBar: AppBar(title: Text(_ex == null ? 'Новый банкет' : 'Банкет')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          children: [
            _section('ГОСТЬ'),
            TextField(controller: _name, decoration: const InputDecoration(labelText: 'Имя или повод', hintText: 'Юбилей Анны')),
            const SizedBox(height: 8),
            TextField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(labelText: 'Телефон (обязательно)'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _guests,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
              decoration: const InputDecoration(labelText: 'Гостей'),
            ),
            _section('КОГДА И ГДЕ'),
            Wrap(spacing: 8, runSpacing: 8, children: [
              OutlinedButton.icon(
                icon: const Icon(Icons.event),
                label: Text(dd),
                onPressed: () async {
                  final d = await showDatePicker(
                    context: context,
                    initialDate: _date,
                    firstDate: DateTime.now().subtract(const Duration(days: 1)),
                    lastDate: DateTime.now().add(const Duration(days: 366)),
                  );
                  if (d != null) setState(() => _date = d);
                },
              ),
              OutlinedButton.icon(
                icon: const Icon(Icons.schedule),
                label: Text(_time.format(context)),
                onPressed: () async {
                  final t = await showTimePicker(context: context, initialTime: _time);
                  if (t != null) setState(() => _time = t);
                },
              ),
            ]),
            const SizedBox(height: 10),
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final h in const [3, 4, 5, 6, 8, 12])
                ChoiceChip(label: Text('$h ч'), selected: _hours == h, onSelected: (_) => setState(() => _hours = h)),
            ]),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              icon: const Icon(Icons.table_restaurant),
              label: Text(_tableId.isEmpty ? 'Выбрать стол' : 'Стол: $_tableName'),
              onPressed: _pickTable,
            ),
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('Гостей может быть больше, чем мест за столом: это главный стол банкета, на него откроется чек.',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 12.5)),
            ),
            _section('МЕНЮ БАНКЕТА'),
            if (_menu.isEmpty)
              Text('Добавьте блюда и напитки — при посадке они сразу будут в чеке.',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 13.5)),
            for (var i = 0; i < _menu.length; i++)
              _MenuLine(
                item: _menu[i],
                guests: guests,
                onQty: (q) => _setQty(i, q),
              ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(onPressed: _addFromMenu, icon: const Icon(Icons.add), label: const Text('Добавить из меню')),
            ),
            if (_menu.isNotEmpty)
              Container(
                margin: const EdgeInsets.only(top: 6),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(children: [
                  Expanded(child: Text('Меню на $guests гостей', style: const TextStyle(fontWeight: FontWeight.w600))),
                  Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                    Text(rub(_menuTotal), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
                    Text('${rub(perGuest)} на гостя', style: TextStyle(color: AppColors.textMuted, fontSize: 12.5)),
                  ]),
                ]),
              ),
            _section('ПРЕДОПЛАТА'),
            TextField(
              controller: _prepay,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Сколько внести заранее, ₽', hintText: '0 — без предоплаты'),
            ),
            if (_menuTotal > 0)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final p in const [30, 50, 100])
                    ActionChip(
                      label: Text('$p% меню'),
                      onPressed: () => _prepay.text = _plain(prepayShare(_menuTotal, p)),
                    ),
                ]),
              ),
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                'Гость вносит онлайн (в «Моих бронях» веб-версии, если он вошёл тем же номером) или на кассе — кнопка «Принять предоплату» в карточке банкета. Чек «аванс» пробивается сразу, при посадке предоплата уже в счёте.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 12.5, height: 1.35),
              ),
            ),
            _section('ПОЖЕЛАНИЯ'),
            TextField(
              controller: _comment,
              maxLines: 3,
              maxLength: 500,
              decoration: const InputDecoration(hintText: 'Торт свой, оформление шарами, детский стул…'),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: TextStyle(color: AppColors.danger)),
              ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _saving ? null : _save,
              child: Text(_saving ? 'Сохраняю…' : (_ex == null ? 'Создать банкет' : 'Сохранить')),
            ),
          ],
        ),
      ),
    );
  }
}

class _MenuLine extends StatelessWidget {
  final OrderItem item;
  final int guests;
  final ValueChanged<int> onQty;

  const _MenuLine({required this.item, required this.guests, required this.onQty});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(item.name, style: const TextStyle(fontWeight: FontWeight.w600)),
              Text('${rub(item.price)} × ${item.qty} = ${rub(item.total)}',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 12.5)),
            ]),
          ),
          IconButton(onPressed: () => onQty(item.qty - 1), icon: const Icon(Icons.remove_circle_outline), tooltip: 'Меньше'),
          SizedBox(
            width: 34,
            child: Text('${item.qty}', textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.w700)),
          ),
          IconButton(onPressed: () => onQty(item.qty + 1), icon: const Icon(Icons.add_circle_outline), tooltip: 'Больше'),
          if (item.qty != guests)
            TextButton(onPressed: () => onQty(guests), child: Text('×$guests')),
        ],
      ),
    );
  }
}

/// Поиск позиции меню для банкета.
class _MenuPickerSheet extends StatefulWidget {
  const _MenuPickerSheet();

  @override
  State<_MenuPickerSheet> createState() => _MenuPickerSheetState();
}

class _MenuPickerSheetState extends State<_MenuPickerSheet> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.8,
      maxChildSize: 0.95,
      builder: (ctx, scroll) => Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: TextField(
              autofocus: true,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Найти в меню'),
              onChanged: (v) => setState(() => _q = v.trim().toLowerCase()),
            ),
          ),
          Expanded(
            child: StreamBuilder<List<MenuItem>>(
              stream: FirestoreService().menuItemsStream(),
              builder: (ctx, snap) {
                if (snap.hasError) return Center(child: Text(humanError(snap.error)));
                if (!snap.hasData) return const Center(child: CircularProgressIndicator());
                final list = snap.data!
                    .where((m) => m.available && (_q.isEmpty || m.name.toLowerCase().contains(_q)))
                    .toList()
                  ..sort((a, b) => a.name.compareTo(b.name));
                if (list.isEmpty) return Center(child: Text('Ничего не нашлось', style: TextStyle(color: AppColors.textMuted)));
                return ListView.builder(
                  controller: scroll,
                  itemCount: list.length,
                  itemBuilder: (_, i) => ListTile(
                    title: Text(list[i].name),
                    trailing: Text(rub(list[i].price)),
                    onTap: () => Navigator.pop(context, list[i]),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
