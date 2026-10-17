import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../models/employee.dart';
import '../../models/session_model.dart';
import '../../services/firestore_service.dart';
import '../../services/notification_service.dart';
import '../../services/signals/kitchen_alarm.dart';
import '../../services/signals/lan_signal_codec.dart';
import '../../services/signals/lan_signals.dart';
import '../../services/signals/signal_hub.dart';
import '../../services/signals/signal_settings.dart';
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

  // Новый билет своего цеха звенит, пока повар не нажмёт «Принял»
  // (KitchenAlarm). Первый снимок — без сигнала: это то, что уже было.
  StreamSubscription<List<SessionModel>>? _alertSub;
  StreamSubscription<LanMessage>? _lanSub;
  Set<String>? _knownLines;

  /// Строки, о которых уже сообщили по Wi‑Fi заведения: когда вернётся
  /// интернет и они придут из облака, второй раз не звеним.
  final _viaLan = <String>{};
  bool _sound = true;
  static const _soundKey = 'kitchen_sound_v1';
  static final _alarmId = NotificationService.idFor('kitchen_alarm');

  late final KitchenAlarm _alarm = KitchenAlarm(onRing: _ring, onEscalate: _escalate, onSilence: _silence);

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((p) {
      if (!mounted) return;
      setState(() => _sound = p.getBool(_soundKey) ?? true);
      _alarm.enabled = _sound;
    }).catchError((Object _) {});
    _alertSub = _fs.openChecksStream().listen(_checkNew, onError: (_) {});
    LanSignals.instance.deviceLabel = 'Кухня · ${widget.employee.name}';
    unawaited(LanSignals.instance.start());
    _lanSub = LanSignals.instance.messages.where((m) => m.kind == LanKind.kitchenOrder).listen(_onLan);
  }

  @override
  void dispose() {
    _alertSub?.cancel();
    _lanSub?.cancel();
    _alarm.dispose();
    unawaited(NotificationService.instance.cancel(_alarmId).catchError((Object _) {}));
    super.dispose();
  }

  void _checkNew(List<SessionModel> checks) {
    final lines = <String>{};
    final fresh = <String, (SessionModel, List<OrderItem>)>{};
    final open = <String>{};
    for (final t in KitchenScreen.ticketsFor(checks, _station)) {
      open.add(t.session.id);
      for (final l in t.lines) {
        final key = '${t.session.id}|${l.lineId}|${l.since?.millisecondsSinceEpoch}';
        lines.add(key);
        if (_knownLines == null || _knownLines!.contains(key)) continue;
        if (_viaLan.remove('${t.session.id}|${l.lineId}')) continue;
        fresh.putIfAbsent(t.session.id, () => (t.session, <OrderItem>[])).$2.add(l);
      }
    }
    _knownLines = lines;
    // Всё по чеку уже готово (отметили на другом планшете) — принимать нечего.
    for (final c in _alarm.pending) {
      if (!open.contains(c.sessionId)) _alarm.accept(c.sessionId);
    }
    for (final e in fresh.values) {
      _alarm.raise(e.$1.id, e.$1.tableName, e.$2.map((i) => i.pending > 1 ? '${i.displayName} ×${i.pending}' : i.displayName).join(', '));
    }
  }

  /// Заказ по Wi‑Fi заведения — приходит и без интернета.
  void _onLan(LanMessage m) {
    if (m.station != _station || m.sessionId.isEmpty) return;
    for (final id in m.lineIds) {
      _viaLan.add('${m.sessionId}|$id');
    }
    _alarm.raise(m.sessionId, m.tableName.isEmpty ? 'Стол' : m.tableName, m.summary);
  }

  String get _stationOrderTitle => switch (_station) {
        SaleKind.bar => 'Новый заказ в бар',
        SaleKind.hookah => 'Новый заказ на кальяны',
        _ => 'Новый заказ на кухню',
      };

  void _ring(KitchenCall call, {required bool first}) {
    HapticFeedback.heavyImpact();
    // На Windows это системный сигнал; на Android звук даёт уведомление с
    // громкостью будильника — оно само повторяется, пока его не снимут.
    SystemSound.play(SystemSoundType.alert);
    if (!first) return;
    unawaited(NotificationService.instance
        .showAlarm(id: _alarmId, title: _stationOrderTitle, body: '${call.tableName}: ${call.summary}')
        .catchError((Object _) {}));
  }

  /// Заказ не приняли за 45 секунд — ещё раз звоним на раздаче (реле).
  void _escalate(KitchenCall call) {
    unawaited(SignalHub.instance
        .ring(SignalEvent.orderFor(_station), table: call.tableName, text: call.summary)
        .catchError((Object _) {}));
  }

  void _silence() {
    unawaited(NotificationService.instance.cancel(_alarmId).catchError((Object _) {}));
  }

  Future<void> _toggleSound() async {
    setState(() => _sound = !_sound);
    _alarm.enabled = _sound;
    try {
      (await SharedPreferences.getInstance()).setBool(_soundKey, _sound);
    } catch (_) {}
  }

  Future<void> _ready(SessionModel s, Set<String> ids) async {
    final key = '${s.id}:${ids.join(',')}';
    if (_busy.contains(key)) return;
    // Взялся за заказ — значит, принял: звонок по этому столу снимаем.
    _alarm.accept(s.id);
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
              ListenableBuilder(listenable: _alarm, builder: (context, _) => _alarmBanner()),
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
                              _alarm.acceptAll();
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

  /// Красная плашка, пока есть непринятые заказы: что пришло и «Принял».
  Widget _alarmBanner() {
    final calls = _alarm.pending;
    if (calls.isEmpty) return const SizedBox.shrink();
    return TickerBuilder(builder: (context, now) {
      // Мигает раз в секунду — видно краем глаза от плиты.
      final bright = now.second.isEven;
      return AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        margin: const EdgeInsets.fromLTRB(12, 10, 12, 0),
        padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
        decoration: BoxDecoration(
          color: AppColors.danger.withValues(alpha: bright ? 0.32 : 0.18),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.danger, width: 2),
        ),
        child: Row(
          children: [
            const Icon(Icons.notifications_active, color: AppColors.danger, size: 30),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(calls.length == 1 ? _stationOrderTitle : '$_stationOrderTitle · ${calls.length}',
                      style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                  for (final c in calls.take(3))
                    Text('${c.tableName}: ${c.summary}',
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14.5)),
                  if (!_alarm.enabled)
                    const Text('Звук выключен', style: TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
                ],
              ),
            ),
            const SizedBox(width: 10),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.danger,
                minimumSize: const Size(132, 56),
                textStyle: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
              ),
              onPressed: _alarm.acceptAll,
              child: const Text('Принял'),
            ),
          ],
        ),
      );
    });
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
    final unaccepted = _alarm.pending.any((c) => c.sessionId == s.id);
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: unaccepted ? AppColors.danger : AppColors.border, width: unaccepted ? 2 : 1),
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
