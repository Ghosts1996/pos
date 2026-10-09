import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../models/employee.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../services/notification_service.dart';
import '../../services/venue_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/adaptive.dart';
import '../../utils/constants.dart';
import '../../utils/human_error.dart';
import '../../utils/sale_kind.dart';
import '../../widgets/clock_ticker.dart';

/// Что готовить: позиции открытых чеков всех столов по цехам — кухня, бар,
/// кальяны. Повар, бармен и кальянщик видят свои, отмечают «Готово», а
/// официант в счёте стола видит, что можно выносить.
///
/// Билет — один стол (чек): сверху те, что ждут дольше всех.
class KitchenScreen extends StatefulWidget {
  final Employee employee;
  const KitchenScreen({super.key, required this.employee});

  /// Цех по специализации: повар — кухня, бармен — бар, кальянщик —
  /// кальяны, остальным — кухня.
  static String stationFor(String position) {
    switch (AppConstants.normalizePosition(position)) {
      case AppConstants.positionBartender:
        return SaleKind.bar;
      case AppConstants.positionHookahMaster:
        return SaleKind.hookah;
      default:
        return SaleKind.kitchen;
    }
  }

  /// Билеты цеха [station]: столы с неготовыми позициями этого вида,
  /// сверху самые давние.
  static List<KitchenTicket> ticketsFor(List<SessionModel> checks, String station) {
    final out = <KitchenTicket>[];
    for (final s in checks) {
      // Строки без «ждёт с» — из чеков до появления этого экрана: их
      // давно вынесли, на кухне им не место.
      final lines = s.orderItems.where((i) => i.pending > 0 && i.since != null && !i.hold && i.effectiveKind == station).toList();
      if (lines.isEmpty) continue;
      final oldest = lines.map((i) => i.since!).reduce((a, b) => a.isBefore(b) ? a : b);
      out.add(KitchenTicket(session: s, lines: lines, since: oldest));
    }
    out.sort((a, b) => a.since.compareTo(b.since));
    return out;
  }

  @override
  State<KitchenScreen> createState() => _KitchenScreenState();
}

class KitchenTicket {
  final SessionModel session;
  final List<OrderItem> lines;
  final DateTime since;
  const KitchenTicket({required this.session, required this.lines, required this.since});
}

class _KitchenScreenState extends State<KitchenScreen> {
  final _fs = FirestoreService();
  late String _station = KitchenScreen.stationFor(widget.employee.position);
  final _busy = <String>{};

  // Сигнал о новом билете своего цеха: звук и вибрация, чтобы повар
  // заметил заказ, не глядя на планшет. Первый снимок — без сигнала.
  StreamSubscription<List<SessionModel>>? _alertSub;
  Set<String>? _knownLines;
  bool _sound = true;
  static const _soundKey = 'kitchen_sound_v1';

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((p) {
      if (mounted) setState(() => _sound = p.getBool(_soundKey) ?? true);
    }).catchError((Object _) {});
    _alertSub = _fs.openChecksStream().listen(_checkNew, onError: (_) {});
  }

  @override
  void dispose() {
    _alertSub?.cancel();
    super.dispose();
  }

  void _checkNew(List<SessionModel> checks) {
    final lines = <String>{};
    var label = '';
    for (final t in KitchenScreen.ticketsFor(checks, _station)) {
      for (final l in t.lines) {
        final key = '${t.session.id}|${l.lineId}|${l.since?.millisecondsSinceEpoch}';
        lines.add(key);
        if (_knownLines != null && !_knownLines!.contains(key)) label = t.session.tableName;
      }
    }
    final first = _knownLines == null;
    _knownLines = lines;
    if (first || label.isEmpty || !_sound) return;
    HapticFeedback.heavyImpact();
    SystemSound.play(SystemSoundType.alert);
    unawaited(NotificationService.instance.show(
      id: NotificationService.idFor('kitchen_$label'),
      title: switch (_station) {
        SaleKind.bar => 'Новый заказ в бар',
        SaleKind.hookah => 'Новый заказ на кальяны',
        _ => 'Новый заказ на кухню',
      },
      body: label.isEmpty ? 'Новый билет' : label,
    ).catchError((Object _) {}));
  }

  Future<void> _toggleSound() async {
    setState(() => _sound = !_sound);
    try {
      (await SharedPreferences.getInstance()).setBool(_soundKey, _sound);
    } catch (_) {}
  }

  Future<void> _ready(SessionModel s, Set<String> ids) async {
    final key = '${s.id}:${ids.join(',')}';
    if (_busy.contains(key)) return;
    setState(() => _busy.add(key));
    try {
      await _fs.markItemsReady(s.id, ids);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось отметить: ${humanError(e, lower: true)}')));
      }
    } finally {
      if (mounted) setState(() => _busy.remove(key));
    }
  }

  @override
  Widget build(BuildContext context) {
    final hookahVenue = VenueService.instance.terms.isHookah;
    final stations = [SaleKind.kitchen, SaleKind.bar, if (hookahVenue || _station == SaleKind.hookah) SaleKind.hookah];
    return Scaffold(
      appBar: AppBar(
        title: const Text('Кухня и бар'),
        actions: [
          IconButton(
            tooltip: _sound ? 'Выключить сигнал новых заказов' : 'Включить сигнал новых заказов',
            icon: Icon(_sound ? Icons.notifications_active_outlined : Icons.notifications_off_outlined),
            onPressed: _toggleSound,
          ),
        ],
      ),
      body: StreamBuilder<List<SessionModel>>(
        stream: _fs.openChecksStream(),
        builder: (context, snap) {
          if (snap.hasError) {
            return Center(child: Text('Не удалось загрузить заказы: ${humanError(snap.error, lower: true)}'));
          }
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final checks = snap.data!;
          final tickets = KitchenScreen.ticketsFor(checks, _station);
          return Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      for (final st in stations)
                        Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: ChoiceChip(
                            label: Text(_stationTitle(st, KitchenScreen.ticketsFor(checks, st).length)),
                            selected: st == _station,
                            onSelected: (_) => setState(() {
                              _station = st;
                              _knownLines = null; // другой цех — без ложного сигнала
                            }),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              Expanded(
                child: tickets.isEmpty
                    ? _empty()
                    // Как в «Очереди заказов»: на телефоне одна колонка, на
                    // планшете две-три; высота растёт с системным шрифтом.
                    : GridView.builder(
                        padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
                        gridDelegate: SliverGridDelegateWithMaxCrossAxisExtent(
                          maxCrossAxisExtent: 420,
                          mainAxisSpacing: 12,
                          crossAxisSpacing: 12,
                          mainAxisExtent: context.scaledExtent(250, textPart: 120),
                        ),
                        itemCount: tickets.length,
                        itemBuilder: (context, i) => _ticket(tickets[i]),
                      ),
              ),
            ],
          );
        },
      ),
    );
  }

  String _stationTitle(String st, int n) {
    final name = switch (st) { SaleKind.bar => 'Бар', SaleKind.hookah => 'Кальяны', _ => 'Кухня' };
    return n > 0 ? '$name · $n' : name;
  }

  Widget _empty() => const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.check_circle_outline, size: 44, color: AppColors.success),
              SizedBox(height: 12),
              Text('Всё готово', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
              SizedBox(height: 6),
              Text('Новые позиции появятся здесь сами, как только их добавят в счёт.',
                  textAlign: TextAlign.center, style: TextStyle(color: AppColors.textMuted)),
            ],
          ),
        ),
      );

  Widget _ticket(KitchenTicket t) {
    final s = t.session;
    final allIds = t.lines.map((i) => i.lineId).toSet();
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.border),
      ),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(s.tableName, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                    Text(
                      [if (s.guestTag.isNotEmpty) s.guestTag, s.employeeName].join(' · '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 12.5),
                    ),
                  ],
                ),
              ),
              TickerBuilder(builder: (context, now) {
                final min = now.difference(t.since).inMinutes.clamp(0, 999);
                final color = min >= 25 ? AppColors.danger : (min >= 15 ? AppColors.warning : AppColors.textMuted);
                return Container(
                  padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text('$min мин', style: TextStyle(color: color, fontWeight: FontWeight.w700, fontSize: 13)),
                );
              }),
            ],
          ),
          const Divider(height: 18, color: AppColors.border),
          Expanded(
            child: ListView(
              padding: EdgeInsets.zero,
              children: [
                for (final i in t.lines)
                  InkWell(
                    borderRadius: BorderRadius.circular(8),
                    onTap: () => _ready(s, {i.lineId}),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 5),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SizedBox(
                            width: 34,
                            child: Text('${i.pending}×',
                                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.brass)),
                          ),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(i.name, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
                                if (i.mods.isNotEmpty)
                                  Text(i.mods.join(' · '),
                                      style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
                                if (i.note.isNotEmpty)
                                  Text(i.note,
                                      style: const TextStyle(
                                          fontSize: 13.5, color: AppColors.brass, fontStyle: FontStyle.italic)),
                              ],
                            ),
                          ),
                          const Icon(Icons.check_circle_outline, size: 22, color: AppColors.textMuted),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          FilledButton.icon(
            style: FilledButton.styleFrom(backgroundColor: AppColors.success),
            onPressed: () => _ready(s, allIds),
            icon: const Icon(Icons.done_all, size: 18),
            label: Text(t.lines.length == 1 ? 'Готово' : 'Всё готово'),
          ),
        ],
      ),
    );
  }
}
