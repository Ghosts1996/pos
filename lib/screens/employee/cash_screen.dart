import 'dart:async';

import 'package:flutter/material.dart';

import '../../models/cash_op.dart';
import '../../models/employee.dart';
import '../../models/session_model.dart';
import '../../models/shift_model.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/human_error.dart';
import '../../utils/money.dart';
import '../../widgets/cash_drawer_card.dart';
import '../../widgets/shift_flow.dart';
import '../../widgets/shift_open_dialog.dart';
import '../../utils/adaptive.dart';

/// «Касса» — наличные в ящике отдельно от X-отчёта: сколько должно лежать
/// сейчас и из чего это складывается, инкассация, внесение и выплата,
/// операции смены, закрытие смены с пересчётом и история пересчётов
/// прошлых смен (где была недостача, сколько забрали, сколько оставили).
class CashScreen extends StatefulWidget {
  final Employee employee;
  const CashScreen({super.key, required this.employee});

  @override
  State<CashScreen> createState() => _CashScreenState();
}

class _CashScreenState extends State<CashScreen> {
  final _fs = FirestoreService();

  /// Чеки текущей смены: наличные за них — часть суммы в кассе. Операции
  /// кассы приходят живым потоком, а чеки перечитываем раз в минуту и по
  /// «потянуть вниз» — чтобы не держать лишнюю подписку на все чеки.
  String? _sessionsShiftId;
  Future<List<SessionModel>>? _sessions;
  Future<List<ShiftModel>>? _history;
  Timer? _refresh;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _history = _loadHistory();
    _refresh = Timer.periodic(const Duration(minutes: 1), (_) => _reloadSessions());
  }

  @override
  void dispose() {
    _refresh?.cancel();
    super.dispose();
  }

  Future<List<ShiftModel>> _loadHistory() async =>
      (await _fs.recentShifts(limit: 20)).where((s) => !s.isOpen).toList();

  ShiftModel? _shift;

  void _reloadSessions() {
    final shift = _shift;
    if (!mounted || shift == null) return;
    setState(() {
      _sessionsShiftId = shift.id;
      _sessions = _fs.closedSessionsForShift(shift);
    });
  }

  Future<void> _pullToRefresh() async {
    _reloadSessions();
    setState(() => _history = _loadHistory());
    try {
      await Future.wait<Object>([if (_sessions != null) _sessions!, _history!]);
    } catch (_) {
      // Ошибку покажут сами блоки экрана.
    }
  }

  Future<void> _open() async {
    setState(() => _busy = true);
    try {
      await ensureShiftOpen(context, me: widget.employee);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось открыть смену: ${humanError(e, lower: true)}')));
      }
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _close(ShiftModel shift) async {
    setState(() => _busy = true);
    final closed = await closeVenueShift(context, shift: shift, me: widget.employee);
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (closed) _history = _loadHistory();
    });
  }

  static String _dt(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')} '
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Касса')),
      body: CenteredBody(
        maxWidth: 760,
        child: RefreshIndicator(
          onRefresh: _pullToRefresh,
          child: StreamBuilder<ShiftModel?>(
            stream: _fs.openShiftStream(),
            builder: (context, shiftSnap) {
              if (shiftSnap.connectionState == ConnectionState.waiting && !shiftSnap.hasData) {
                return const Center(child: CircularProgressIndicator());
              }
              final shift = shiftSnap.data;
              _shift = shift;
              if (shift != null && _sessionsShiftId != shift.id) {
                _sessionsShiftId = shift.id;
                _sessions = _fs.closedSessionsForShift(shift);
              }
              return ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
                children: [
                  if (shift == null) _closedCard() else _currentCash(shift),
                  const SizedBox(height: 24),
                  _historySection(),
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  Widget _closedCard() => Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Row(children: [
              Icon(Icons.lock_outline, color: AppColors.textMuted),
              SizedBox(width: 10),
              Expanded(
                child: Text('Смена заведения закрыта',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
              ),
            ]),
            const SizedBox(height: 8),
            const Text(
              'Касса работает в открытой смене: откройте её — размен, оставленный при закрытии прошлой смены, '
              'станет разменом на начало.',
              style: TextStyle(color: AppColors.textMuted),
            ),
            const SizedBox(height: 14),
            FilledButton.icon(
              onPressed: _busy ? null : _open,
              icon: const Icon(Icons.lock_open_outlined),
              label: const Text('Открыть смену'),
            ),
          ],
        ),
      );

  Widget _currentCash(ShiftModel shift) => FutureBuilder<List<SessionModel>>(
        future: _sessions,
        builder: (context, sessSnap) {
          if (sessSnap.hasError) {
            return Text('Не удалось посчитать наличные: ${humanError(sessSnap.error, lower: true)}',
                style: const TextStyle(color: AppColors.danger));
          }
          final sessions = sessSnap.data;
          return StreamBuilder<List<CashOp>>(
            stream: _fs.cashOpsStream(shift.id),
            builder: (context, opsSnap) {
              if (sessions == null || (!opsSnap.hasData && !opsSnap.hasError)) {
                return const Padding(
                  padding: EdgeInsets.all(40),
                  child: Center(child: CircularProgressIndicator()),
                );
              }
              final ops = opsSnap.data ?? const <CashOp>[];
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
                    child: Text(
                      'Смена заведения открыта ${_dt(shift.openedAt)}'
                      '${shift.openedBy.isNotEmpty ? ' · ${shift.openedBy}' : ''}',
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
                    ),
                  ),
                  CashDrawerCard(
                    summary: CashDrawerSummary.from(opening: shift.openingCash, sessions: sessions, ops: ops),
                    ops: ops,
                    shift: shift,
                    employee: widget.employee,
                    live: true,
                  ),
                  const SizedBox(height: 16),
                  OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(
                      foregroundColor: AppColors.danger,
                      minimumSize: const Size.fromHeight(52),
                    ),
                    onPressed: _busy ? null : () => _close(shift),
                    icon: const Icon(Icons.lock_outline, size: 20),
                    label: const Text('Закрыть смену заведения'),
                  ),
                ],
              );
            },
          );
        },
      );

  Widget _historySection() => FutureBuilder<List<ShiftModel>>(
        future: _history,
        builder: (context, snap) {
          final shifts = snap.data ?? const <ShiftModel>[];
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(4, 0, 4, 8),
                child: Text('Прошлые смены', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
              ),
              if (snap.connectionState == ConnectionState.waiting)
                const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()))
              else if (snap.hasError)
                Text('Не удалось загрузить: ${humanError(snap.error, lower: true)}',
                    style: const TextStyle(color: AppColors.danger))
              else if (shifts.isEmpty)
                const Text('Закрытых смен пока нет.', style: TextStyle(color: AppColors.textMuted))
              else
                for (final s in shifts) _historyTile(s),
            ],
          );
        },
      );

  Widget _historyTile(ShiftModel s) {
    final counted = s.closingCountedCash;
    final diff = s.closingDiff ?? 0;
    final String line;
    Color? color;
    if (counted == null) {
      line = 'Закрыта без пересчёта кассы';
    } else if (diff.abs() < 0.01) {
      line = 'Сходится · инкассация ${rub(s.closingCollected ?? 0)} · размен ${rub(s.closingLeftCash ?? 0)}';
      color = AppColors.success;
    } else {
      line = '${diff < 0 ? 'Недостача' : 'Излишек'} ${rub(diff.abs())} · инкассация ${rub(s.closingCollected ?? 0)}';
      color = diff < 0 ? AppColors.danger : AppColors.warning;
    }
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        title: Text('${_dt(s.openedAt)} — ${s.closedAt != null ? _dt(s.closedAt!) : '…'}'),
        subtitle: Text(
          '${s.closedBy != null && s.closedBy!.isNotEmpty ? 'Закрыл(а) ${s.closedBy} · ' : ''}$line',
          style: TextStyle(color: color, fontSize: 13),
        ),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => _showPast(s),
      ),
    );
  }

  /// Касса прошлой смены: что было в ящике, операции и пересчёт — как в
  /// текущей, только без кнопок.
  Future<void> _showPast(ShiftModel s) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.85,
        maxChildSize: 0.95,
        builder: (ctx, scroll) => FutureBuilder<List<Object>>(
          future: Future.wait([_fs.closedSessionsForShift(s), _fs.cashOpsForShift(s.id)]),
          builder: (ctx, snap) {
            if (snap.hasError) {
              return Padding(
                padding: const EdgeInsets.all(24),
                child: Text('Не удалось загрузить: ${humanError(snap.error, lower: true)}',
                    style: const TextStyle(color: AppColors.danger)),
              );
            }
            if (!snap.hasData) return const Center(child: CircularProgressIndicator());
            final sessions = snap.data![0] as List<SessionModel>;
            final ops = snap.data![1] as List<CashOp>;
            return ListView(
              controller: scroll,
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 24),
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
                  child: Text('Смена ${_dt(s.openedAt)} — ${s.closedAt != null ? _dt(s.closedAt!) : '…'}',
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                ),
                CashDrawerCard(
                  summary: CashDrawerSummary.from(
                      opening: s.openingCash, sessions: sessions, ops: ops, countDiff: s.closingDiff ?? 0),
                  ops: ops,
                  shift: s,
                  employee: widget.employee,
                  live: false,
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
