import 'package:flutter/material.dart';

import '../models/reservation_model.dart';
import '../models/table_model.dart';
import '../theme/app_colors.dart';
import '../utils/constants.dart';
import '../utils/hall_layout.dart';
import '../utils/table_label.dart';
import 'table_tile.dart' show TableStateColors;

/// SaaS: выбор стола при пересадке гостя.
///
/// Столы разложены по группам — «Свободны», «Можно подсадить» (ещё один чек
/// за занятым столом), «Заняты полностью» — и по-человечески отсортированы
/// («Стол 3» раньше «Стол 10»). У каждого стола видно брони на ближайшие
/// часы: время, имя, сколько человек. Бронь, которая начнётся раньше, чем
/// гость уйдёт, подсвечена, и пересадить туда можно только после
/// подтверждения — чтобы через час не пришлось пересаживать снова.

/// До какого времени гость пробудет за столом: до конца оплаченного времени,
/// а если время не ограничено — берём ближайшие 2 часа.
DateTime moveStayUntil(DateTime? plannedEnd, DateTime now) {
  if (plannedEnd != null &&
      plannedEnd.isAfter(now) &&
      !AppConstants.isUnlimitedRemaining(plannedEnd.difference(now))) {
    return plannedEnd;
  }
  return now.add(const Duration(hours: 2));
}

/// Брони стола, которые ещё впереди (или гость опаздывает не больше чем на
/// 30 минут), по времени.
List<ReservationModel> upcomingTableReservations(
    List<ReservationModel> all, String tableId, DateTime now) {
  final out = all
      .where((r) =>
          r.tableId == tableId &&
          r.status.blocksTable &&
          r.endTime.isAfter(now) &&
          !r.startTime.isBefore(now.subtract(const Duration(minutes: 30))))
      .toList()
    ..sort((a, b) => a.startTime.compareTo(b.startTime));
  return out;
}

/// Первая бронь, которая начнётся, пока гость ещё сидит.
ReservationModel? moveClash(List<ReservationModel> tableRes, DateTime until) {
  for (final r in tableRes) {
    if (r.startTime.isBefore(until)) return r;
  }
  return null;
}

String _inMinutes(int mins) {
  if (mins <= 0) return 'гость уже должен прийти';
  if (mins < 60) return 'через $mins мин';
  final h = mins ~/ 60, m = mins % 60;
  return m == 0 ? 'через $h ч' : 'через $h ч $m мин';
}

class MoveTablePicker extends StatefulWidget {
  final TableModel currentTable;
  final List<TableModel> tables;
  final List<ReservationModel> reservations;
  final DateTime stayUntil;

  /// Время гостя ограничено (тайм-кафе, кальян): [stayUntil] — его конец.
  final bool timeKnown;
  final DateTime now;
  final ValueChanged<TableModel> onPick;

  const MoveTablePicker({
    super.key,
    required this.currentTable,
    required this.tables,
    required this.reservations,
    required this.stayUntil,
    this.timeKnown = false,
    required this.now,
    required this.onPick,
  });

  @override
  State<MoveTablePicker> createState() => _MoveTablePickerState();
}

class _MoveTablePickerState extends State<MoveTablePicker> {
  String? _zone; // null — все зоны

  Future<void> _tap(TableModel t, ReservationModel? clash) async {
    if (clash == null) {
      widget.onPick(t);
      return;
    }
    final who = clash.guestName.isEmpty ? 'гость' : clash.guestName;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: Icon(Icons.event_busy_outlined, color: AppColors.warning),
        title: Text('На «${t.name}» бронь в ${hhmm(clash.startTime)}'),
        content: Text(
          '${who[0].toUpperCase()}${who.substring(1)}, ${clash.guestsCount} чел. — '
          '${_inMinutes(clash.startTime.difference(widget.now).inMinutes)}.\n'
          '${widget.timeKnown ? 'Время гостя — до ${hhmm(widget.stayUntil)}' : 'Гость, скорее всего, ещё будет сидеть'}, '
          'и к приходу брони стол может быть занят.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Выбрать другой')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Всё равно пересадить')),
        ],
      ),
    );
    if (ok == true) widget.onPick(t);
  }

  @override
  Widget build(BuildContext context) {
    final now = widget.now;
    final others = widget.tables
        .where((t) => t.id != widget.currentTable.id && !t.isTakeaway)
        .toList()
      ..sort(compareTables);
    final zones = hallZones(others);
    final zone = _zone != null && (zones.contains(_zone) || _zone == '') ? _zone : null;
    final shown = zone == null ? others : others.where((t) => t.zone == zone).toList();

    final res = {for (final t in shown) t.id: upcomingTableReservations(widget.reservations, t.id, now)};
    final clash = {for (final t in shown) t.id: moveClash(res[t.id]!, widget.stayUntil)};

    // Свободные без брони на время гостя — первыми.
    final free = shown.where((t) => t.activeSessionIds.isEmpty).toList()
      ..sort((a, b) {
        final ca = clash[a.id] == null ? 0 : 1, cb = clash[b.id] == null ? 0 : 1;
        return ca != cb ? ca - cb : compareTables(a, b);
      });
    final addable = shown.where((t) => t.activeSessionIds.isNotEmpty && !t.isFull).toList();
    final full = shown.where((t) => t.activeSessionIds.isNotEmpty && t.isFull).toList();

    final children = <Widget>[
      _header(),
      if (zones.isNotEmpty) _zoneChips(zones, others, zone),
      if (shown.isEmpty)
        Padding(
          padding: const EdgeInsets.all(32),
          child: Text('Других столов в зале нет',
              textAlign: TextAlign.center, style: TextStyle(color: AppColors.textMuted)),
        ),
      if (free.isNotEmpty) ...[
        _section('Свободны', free.length, TableStateColors.free),
        for (final t in free) _row(t, res[t.id]!, clash[t.id]),
      ],
      if (addable.isNotEmpty) ...[
        _section('Можно подсадить — ещё один чек', addable.length, TableStateColors.occupied),
        for (final t in addable) _row(t, res[t.id]!, clash[t.id]),
      ],
      if (full.isNotEmpty) ...[
        _section('Заняты полностью', full.length, AppColors.textMuted),
        for (final t in full) _row(t, res[t.id]!, null, disabled: true),
      ],
      const SizedBox(height: 24),
    ];
    return ListView(padding: const EdgeInsets.fromLTRB(12, 8, 12, 12), children: children);
  }

  Widget _header() {
    final unlimited = !widget.timeKnown;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(children: [
        Icon(Icons.swap_horiz_rounded, color: AppColors.primary),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Сейчас: ${widget.currentTable.name}',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: AppColors.textPrimary)),
            const SizedBox(height: 2),
            Text(
              unlimited
                  ? 'Чек и заказ переедут вместе с гостем. Время не ограничено — жёлтым отмечены брони в ближайшие 2 часа.'
                  : 'Чек, заказ и время переедут вместе с гостем. Гость до ${hhmm(widget.stayUntil)} — жёлтым отмечены брони раньше.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 12.5),
            ),
          ]),
        ),
      ]),
    );
  }

  Widget _zoneChips(List<String> zones, List<TableModel> all, String? zone) {
    final keys = [...zones, if (all.any((t) => t.zone.isEmpty)) ''];
    Widget chip(String? z, String label) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: ChoiceChip(
            label: Text(label),
            selected: zone == z,
            onSelected: (_) => setState(() => _zone = z),
          ),
        );
    return SizedBox(
      height: 48,
      child: ListView(scrollDirection: Axis.horizontal, children: [
        chip(null, 'Все зоны'),
        for (final z in keys) chip(z, z.isEmpty ? kNoZoneLabel : z),
      ]),
    );
  }

  Widget _section(String title, int count, Color color) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 14, 4, 8),
        child: Row(children: [
          Container(width: 8, height: 8, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(title,
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.textMuted, letterSpacing: 0.2)),
          ),
          Text('$count', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.textMuted)),
        ]),
      );

  Widget _row(TableModel t, List<ReservationModel> res, ReservationModel? clash, {bool disabled = false}) {
    final busy = t.activeSessionIds.isNotEmpty;
    final color = busy ? TableStateColors.occupied : TableStateColors.free;
    final checks = t.activeSessionIds.length;
    final status = !busy
        ? 'Свободен'
        : disabled
            ? 'Занят · чеков $checks из ${t.maxOpenSessions}, больше нельзя'
            : 'Занят · $checks ${pluralRu(checks, 'чек', 'чека', 'чеков')} из ${t.maxOpenSessions}';
    final showZone = _zone == null && t.zone.isNotEmpty;

    Widget resChip(ReservationModel r) {
      final hit = identical(r, clash);
      final c = hit ? AppColors.warning : TableStateColors.reserved;
      final who = r.guestName.isEmpty ? 'гость' : r.guestName;
      return Container(
        margin: const EdgeInsets.only(top: 6),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: c.withValues(alpha: AppColors.isLight ? 0.10 : 0.14),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(hit ? Icons.warning_amber_rounded : Icons.event_outlined, size: 15, color: c),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              hit
                  ? 'Бронь ${hhmm(r.startTime)} · $who · ${r.guestsCount} чел. — ${_inMinutes(r.startTime.difference(widget.now).inMinutes)}'
                  : 'Бронь ${hhmm(r.startTime)} · $who · ${r.guestsCount} чел.',
              style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                  color: hit ? c : AppColors.textPrimary.withValues(alpha: 0.85),
                  fontFeatures: const [FontFeature.tabularFigures()]),
            ),
          ),
        ]),
      );
    }

    final shownRes = res.take(3).toList();
    final card = Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(18),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: disabled ? null : () => _tap(t, clash),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            border: Border.all(
                color: clash != null ? AppColors.warning.withValues(alpha: 0.6) : AppColors.border),
          ),
          child: IntrinsicHeight(
            child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Container(width: 4, color: disabled ? AppColors.border : color),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(
                        child: Text(t.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                                fontSize: 17, fontWeight: FontWeight.w700, color: AppColors.textPrimary, letterSpacing: -0.2)),
                      ),
                      Icon(Icons.people_alt_outlined, size: 16, color: AppColors.textMuted),
                      const SizedBox(width: 4),
                      Text(seatsLabel(t.seats),
                          style: TextStyle(color: AppColors.textMuted, fontSize: 13, fontWeight: FontWeight.w600)),
                    ]),
                    const SizedBox(height: 3),
                    Text(
                      [status, if (showZone) t.zone].join(' · '),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          color: busy && !disabled ? color : AppColors.textMuted,
                          fontSize: 13,
                          fontWeight: busy && !disabled ? FontWeight.w600 : FontWeight.w500),
                    ),
                    if (shownRes.isEmpty && !busy)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text('Броней нет',
                            style: TextStyle(color: AppColors.textMuted.withValues(alpha: 0.8), fontSize: 12)),
                      ),
                    for (final r in shownRes) resChip(r),
                    if (res.length > shownRes.length)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text('и ещё ${res.length - shownRes.length}',
                            style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
                      ),
                  ]),
                ),
              ),
              if (!disabled)
                Padding(
                  padding: const EdgeInsets.only(right: 10),
                  child: Icon(Icons.chevron_right_rounded, color: AppColors.textMuted),
                ),
            ]),
          ),
        ),
      ),
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Opacity(opacity: disabled ? 0.55 : 1, child: Semantics(button: !disabled, child: card)),
    );
  }
}
