import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/employee.dart';
import '../services/app_scope.dart';
import '../services/people_directory.dart';
import '../theme/app_colors.dart';
import '../utils/phone_utils.dart';
import 'takeaway_sheet.dart';

/// Входящий звонок от АТС (SaaS, телефония для доставки). Сервер
/// (saas-gateway/telephony.js) пишет `incomingCalls`, номер — в справочнике
/// в РФ (вид «call»). Карточка висит 3 минуты или пока её не взяли/скрыли.
class IncomingCall {
  final String id;
  final DateTime at;
  final String phone;
  final String tail;
  final String guestUid;
  final int visits;
  final int bonus;
  final DateTime? lastVisitAt;
  final String tier;
  final bool test;

  const IncomingCall({
    required this.id,
    required this.at,
    this.phone = '',
    this.tail = '',
    this.guestUid = '',
    this.visits = 0,
    this.bonus = 0,
    this.lastVisitAt,
    this.tier = '',
    this.test = false,
  });

  factory IncomingCall.fromMap(String id, Map<String, dynamic> m) {
    final g = m['guest'] is Map ? Map<String, dynamic>.from(m['guest'] as Map) : const <String, dynamic>{};
    final at = m['at'];
    final last = g['lastVisitAt'];
    return IncomingCall(
      id: id,
      at: at is Timestamp ? at.toDate() : DateTime.fromMillisecondsSinceEpoch(0),
      phone: (m['phone'] ?? '').toString(),
      tail: (m['tail'] ?? '').toString(),
      guestUid: (g['uid'] ?? '').toString(),
      visits: (g['visits'] as num?)?.toInt() ?? 0,
      bonus: (g['bonus'] as num?)?.toInt() ?? 0,
      lastVisitAt: last is Timestamp ? last.toDate() : null,
      tier: (g['tier'] ?? '').toString(),
      test: m['test'] == true,
    );
  }

  /// Номер для показа: из справочника в РФ, иначе — из записи, иначе — хвост.
  String get shownPhone {
    final p = Pd.phone('call', id, phone);
    if (p.isNotEmpty) return formatPhone(p);
    return tail.isEmpty ? 'Номер скрыт' : '… $tail';
  }

  String get rawPhone => Pd.phone('call', id, phone);

  String get guestName => guestUid.isEmpty ? '' : Pd.guestName(guestUid);

  /// «Постоянный гость · 5 визитов · 320 бонусов · был 12.11» / «Новый номер».
  String get who {
    if (test) return 'Проверочный звонок из кабинета';
    if (guestUid.isEmpty) return 'Новый номер — гостя с ним ещё не было';
    final parts = <String>[
      if (guestName.isNotEmpty) guestName,
      if (tier.isNotEmpty) tier,
      visits > 0 ? _visits(visits) : 'гость без визитов',
      if (bonus > 0) '$bonus бонусов',
      if (lastVisitAt != null) 'был ${_dm(lastVisitAt!)}',
    ];
    return parts.join(' · ');
  }

  static String _visits(int n) {
    final m10 = n % 10, m100 = n % 100;
    final w = m10 == 1 && m100 != 11
        ? 'визит'
        : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14))
            ? 'визита'
            : 'визитов';
    return '$n $w';
  }

  static String _dm(DateTime d) => '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}';
}

/// Звонки, которые ещё «звонят»: не старше [fresh], статус ringing.
List<IncomingCall> ringingCalls(Iterable<IncomingCall> all, DateTime now, {Duration fresh = const Duration(minutes: 3)}) =>
    all.where((c) => now.difference(c.at) <= fresh && !c.at.isAfter(now.add(const Duration(minutes: 1)))).toList()
      ..sort((a, b) => b.at.compareTo(a.at));

class IncomingCallBanner extends StatefulWidget {
  final Employee employee;
  const IncomingCallBanner({super.key, required this.employee});

  @override
  State<IncomingCallBanner> createState() => _IncomingCallBannerState();
}

class _IncomingCallBannerState extends State<IncomingCallBanner> {
  StreamSubscription<QuerySnapshot<Map<String, dynamic>>>? _sub;
  Timer? _tick;
  List<IncomingCall> _all = const [];
  final Set<String> _seen = {};
  final Set<String> _hidden = {};

  @override
  void initState() {
    super.initState();
    _sub = AppScope.col('incomingCalls').where('status', isEqualTo: 'ringing').snapshots().listen((q) {
      final list = [for (final d in q.docs) IncomingCall.fromMap(d.id, d.data())];
      final fresh = ringingCalls(list, DateTime.now());
      // Новый звонок — звук и вибрация, номер — из справочника.
      final added = fresh.where((c) => _seen.add(c.id)).toList();
      if (added.isNotEmpty) {
        unawaited(People.instance.ensure([
          for (final c in added) ...[PdRef('call', c.id), if (c.guestUid.isNotEmpty) PdRef.guest(c.guestUid)],
        ]).then((_) {
          if (mounted) setState(() {});
        }));
        SystemSound.play(SystemSoundType.alert);
        HapticFeedback.heavyImpact();
      }
      if (mounted) setState(() => _all = list);
    }, onError: (_) {});
    _tick = Timer.periodic(const Duration(seconds: 15), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _mark(IncomingCall c, String status, {String sessionId = ''}) async {
    setState(() => _hidden.add(c.id));
    try {
      await AppScope.col('incomingCalls').doc(c.id).update({
        'status': status,
        'handledAt': Timestamp.now(),
        if (sessionId.isNotEmpty) 'sessionId': sessionId,
      });
    } catch (_) {
      // Нет связи — карточка всё равно скрыта на этой кассе.
    }
  }

  Future<void> _order(IncomingCall c, {required bool delivery}) async {
    final id = await TakeawaySheet.createOrder(
      context,
      widget.employee,
      delivery: delivery,
      phone: c.rawPhone.isEmpty ? '' : formatPhone(c.rawPhone),
      name: c.guestName,
    );
    if (id != null) await _mark(c, 'taken', sessionId: id);
  }

  @override
  Widget build(BuildContext context) {
    final calls = ringingCalls(_all, DateTime.now()).where((c) => !_hidden.contains(c.id)).toList();
    if (calls.isEmpty) return const SizedBox.shrink();
    final c = calls.first;
    return IncomingCallCard(
      call: c,
      more: calls.length - 1,
      onDelivery: () => _order(c, delivery: true),
      onTakeaway: () => _order(c, delivery: false),
      onDismiss: () => _mark(c, 'dismissed'),
    );
  }
}

/// Карточка звонка: номер крупно, кто это, «Доставка» / «С собой» / «×».
class IncomingCallCard extends StatelessWidget {
  final IncomingCall call;
  final int more;
  final VoidCallback onDelivery;
  final VoidCallback onTakeaway;
  final VoidCallback onDismiss;
  final bool animate;

  const IncomingCallCard({
    super.key,
    required this.call,
    this.more = 0,
    required this.onDelivery,
    required this.onTakeaway,
    required this.onDismiss,
    this.animate = true,
  });

  @override
  Widget build(BuildContext context) {
    final c = call;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      child: Material(
        color: AppColors.surface,
        elevation: 3,
        shadowColor: AppColors.primary.withValues(alpha: 0.25),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: AppColors.success.withValues(alpha: 0.7), width: 1.5),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _RingIcon(color: AppColors.success, animate: animate),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Входящий звонок', style: TextStyle(color: AppColors.textMuted, fontSize: 12.5, fontWeight: FontWeight.w600)),
                        FittedBox(
                          fit: BoxFit.scaleDown,
                          alignment: Alignment.centerLeft,
                          child: Text(c.shownPhone,
                              style: TextStyle(
                                  color: AppColors.textPrimary,
                                  fontSize: 21,
                                  fontWeight: FontWeight.w800,
                                  fontFeatures: const [FontFeature.tabularFigures()])),
                        ),
                        const SizedBox(height: 2),
                        Text(c.who,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: c.guestUid.isEmpty ? AppColors.textMuted : AppColors.textPrimary,
                              fontSize: 13.5,
                              fontWeight: c.guestUid.isEmpty ? FontWeight.w400 : FontWeight.w600,
                            )),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'Скрыть',
                    onPressed: onDismiss,
                    icon: Icon(Icons.close, color: AppColors.textMuted),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  FilledButton.icon(
                    onPressed: onDelivery,
                    icon: const Icon(Icons.delivery_dining_rounded, size: 20),
                    label: const Text('Доставка'),
                  ),
                  FilledButton.tonalIcon(
                    onPressed: onTakeaway,
                    icon: const Icon(Icons.shopping_bag_outlined, size: 20),
                    label: const Text('С собой'),
                  ),
                  if (more > 0)
                    Text('  ещё $more на линии',
                        style: TextStyle(color: AppColors.textMuted, fontSize: 13, fontWeight: FontWeight.w600)),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Значок трубки с мягкой «волной» звонка.
class _RingIcon extends StatefulWidget {
  final Color color;
  final bool animate;
  const _RingIcon({required this.color, this.animate = true});

  @override
  State<_RingIcon> createState() => _RingIconState();
}

class _RingIconState extends State<_RingIcon> with SingleTickerProviderStateMixin {
  late final AnimationController _a = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400));

  @override
  void initState() {
    super.initState();
    if (widget.animate) _a.repeat();
  }

  @override
  void dispose() {
    _a.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 44,
      height: 44,
      child: AnimatedBuilder(
        animation: _a,
        builder: (_, __) => Stack(
          alignment: Alignment.center,
          children: [
            Container(
              width: 30 + 14 * _a.value,
              height: 30 + 14 * _a.value,
              decoration: BoxDecoration(shape: BoxShape.circle, color: widget.color.withValues(alpha: 0.25 * (1 - _a.value))),
            ),
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(shape: BoxShape.circle, color: widget.color.withValues(alpha: 0.16)),
              child: Icon(Icons.phone_in_talk_rounded, color: widget.color, size: 20),
            ),
          ],
        ),
      ),
    );
  }
}
