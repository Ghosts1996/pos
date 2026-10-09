import 'dart:async';
import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../models/session_model.dart';
import '../../models/venue_models.dart';
import '../../utils/constants.dart';
import '../../services/guest_link_service.dart';
import '../../services/venue_service.dart';
import '../../services/tips_service.dart';
import '../widgets/guest_sbp_pay_card.dart';
import '../widgets/kolibri_tips_panel.dart';
import '../../widgets/clock_ticker.dart';
import '../services/kolibri_auth_service.dart';
import 'kolibri_hall_map_screen.dart';
import 'kolibri_menu_screen.dart';
import 'kolibri_qr_scan_screen.dart';
import '../theme/kolibri_theme.dart';
import '../../utils/table_label.dart';
import '../../utils/money.dart';

/// «Мой стол»: живой счёт гостя.
///
/// Тот же документ sessions/{id}, что правит кассир: гость видит позиции и
/// сумму секунда в секунду, таймер сеанса и может позвать кальянщика.
/// Изменять счёт гость не может — только просить.
class KolibriVisitScreen extends StatefulWidget {
  final ClientProfile? profile;
  const KolibriVisitScreen({super.key, required this.profile});

  @override
  State<KolibriVisitScreen> createState() => _KolibriVisitScreenState();
}

class _KolibriVisitScreenState extends State<KolibriVisitScreen> {
  final _link = GuestLinkService();
  final _auth = KolibriAuthService();

  // Раз в секунду тикает только счётчик (TickerBuilder от общего таймера),
  // а не весь экран со счётом и кнопками.

  @override
  Widget build(BuildContext context) {
    final sessionId = widget.profile?.activeSessionId ?? '';

    // Гость уже не за столом, но последний визит закрыт только что и не
    // оценён — показываем «Спасибо за визит». Держится на записи визита, а
    // не на activeSessionId: его касса обнуляет при оплате.
    if (sessionId.isEmpty) {
      final last = widget.profile?.lastVisitId ?? '';
      final rated = widget.profile?.ratedVisitId ?? '';
      if (last.isNotEmpty && last != rated) return _finishedVisit(last);
      return _notAtTable();
    }

    return StreamBuilder<SessionModel?>(
      stream: _link.sessionStream(sessionId),
      builder: (context, snap) {
        final s = snap.data;
        if (s == null) return _notAtTable();
        if (s.status != 'active') {
          // Чек закрыли на кассе — предлагаем оценить визит.
          return _visitFinished(s);
        }
        // Тип заведения и чаевые приходят с профилем заведения — он может
        // приехать позже чека.
        return ValueListenableBuilder<VenueProfile>(
          valueListenable: VenueService.instance.notifier,
          builder: (context, _, __) => _activeVisit(s),
        );
      },
    );
  }

  // ---------- СОСТОЯНИЯ ----------

  Widget _notAtTable() => ListView(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 100),
        children: [
          Text('Мой стол', style: KolibriFonts.display(34)),
          const SizedBox(height: 8),
          Text(
            VenueService.instance.terms.isHookah
                ? 'Отсканируйте QR-код на своём столе — откроются счёт, таймер '
                    'сеанса и кнопки вызова кальянщика.'
                : 'Отсканируйте QR-код на своём столе — откроются счёт и '
                    'кнопки вызова ${VenueService.instance.terms.staffAcc}.',
            style: TextStyle(color: KolibriColors.textMuted, height: 1.4),
          ),
          const SizedBox(height: 24),
          FilledButton.icon(
            onPressed: () async {
              // QR со стола — самый быстрый путь: гость сразу попадает
              // на свой счёт без выбора из списка.
              await Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const KolibriQrScanScreen()),
              );
              if (mounted) setState(() {});
            },
            icon: const Icon(Icons.qr_code_scanner),
            label: const Text('Сканировать QR стола'),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: () async {
              await Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const KolibriHallMapScreen()),
              );
              if (mounted) setState(() {});
            },
            icon: const Icon(Icons.map_outlined),
            label: const Text('Карта зала'),
          ),
          const SizedBox(height: 14),
          Text(
            'Стол открывается только по коду с самого стола — так вы '
            'наверняка попадёте на свой счёт, а не на соседний. Если код '
            'не сканируется, позовите ${VenueService.instance.terms.staffAcc}: '
            'он откроет стол сам.',
            style: TextStyle(
                color: KolibriColors.textMuted, fontSize: 12, height: 1.5),
          ),
          _venueRules(),
        ],
      );

  Widget _activeVisit(SessionModel s) {
    final terms = VenueService.instance.terms;
    // Таймер сеанса нужен кальянной; в ресторане и кафе стол просто занят,
    // пока его не закроют. «Без ограничений» — тоже без таймера.
    final showTimer = terms.isHookah && !AppConstants.isUnlimitedRemaining(s.remaining);
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 120),
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(tableLabel(s.tableName),
                style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
            TextButton(
              onPressed: () => _link.unbind(_auth.uid),
              child: const Text('Это не мой стол'),
            ),
          ],
        ),
        const SizedBox(height: 16),

        // ---- Таймер сеанса ----
        // Единственное место экрана, которое обязано обновляться каждую
        // секунду, — поэтому только оно и перестраивается.
        if (showTimer) TickerBuilder(builder: (context, _) {
          final left = s.remaining;
          final over = left.isNegative;
          final minutes = left.inMinutes.abs();
          final seconds = (left.inSeconds.abs() % 60).toString().padLeft(2, '0');
          return Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: KolibriColors.surface,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: over
                  ? KolibriColors.danger
                  : (left.inMinutes <= 15 ? KolibriColors.warning : KolibriColors.border),
            ),
          ),
          child: Column(
            children: [
              Text(over ? 'Сеанс завершён' : 'До конца сеанса',
                  style: TextStyle(color: KolibriColors.textMuted)),
              const SizedBox(height: 8),
              Text(
                '$minutes:$seconds',
                style: KolibriFonts.display(
                  60,
                  color: over
                      ? KolibriColors.danger
                      : (left.inMinutes <= 15 ? KolibriColors.warning : KolibriColors.textPrimary),
                ).copyWith(fontFeatures: const [FontFeature.liningFigures(), FontFeature.tabularFigures()]),
              ),
              if (s.refillCount > 0)
                Text('Перезабивок: ${s.refillCount}',
                    style: TextStyle(color: KolibriColors.textMuted, fontSize: 12)),
            ],
          ),
          );
        }),

        const SizedBox(height: 20),

        // ---- Заказ со стола ----
        // Главное действие за столом — дозаказать самому, не дожидаясь
        // персонала: меню с корзиной, заказ уходит на кассу, персонал
        // подтверждает его, и позиции появляются в счёте ниже.
        SizedBox(
          width: double.infinity,
          height: 56,
          child: FilledButton.icon(
            onPressed: () => openTableOrder(context, tableName: s.tableName),
            icon: const Icon(Icons.restaurant_menu),
            label: const Text('Сделать заказ', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            style: FilledButton.styleFrom(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          // Заказ делится по адресатам (GuestLinkService.placeRoutedGuestOrder):
          // блюда и напитки — официанту, кальян — кальянщику.
          terms.isHookah
              ? 'Блюда и напитки примет ${_waiterWord(terms)}, кальян — кальянщик. '
                  'После подтверждения заказ появится в счёте.'
              : 'Блюда и напитки — прямо к столу: ${_waiterWord(terms)} подтвердит заказ, '
                  'и он появится в счёте.',
          style: TextStyle(color: KolibriColors.textMuted, fontSize: 12.5, height: 1.4),
        ),

        const SizedBox(height: 24),

        // ---- Кнопки обращений ----
        // Угли, перезабивка и кальянщик — только в кальянной. В ресторане,
        // кафе и баре гость зовёт официанта и просит счёт.
        const Text('Позвать', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        const SizedBox(height: 12),
        if (terms.isHookah) ...[
          Row(
            children: [
              Expanded(child: _callButton(s, GuestCallType.coal, Icons.local_fire_department)),
              const SizedBox(width: 10),
              Expanded(child: _callButton(s, GuestCallType.refill, Icons.refresh)),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(child: _callButton(s, GuestCallType.waiter, Icons.pan_tool_alt)),
              const SizedBox(width: 10),
              Expanded(child: _callButton(s, GuestCallType.bill, Icons.payments)),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(child: _callButton(s, GuestCallType.callWaiter, Icons.room_service)),
              const SizedBox(width: 10),
              const Expanded(child: SizedBox()),
            ],
          ),
        ] else
          Row(
            children: [
              Expanded(child: _callButton(s, GuestCallType.callWaiter, Icons.room_service)),
              const SizedBox(width: 10),
              Expanded(child: _callButton(s, GuestCallType.bill, Icons.payments)),
            ],
          ),

        // ---- Статус вызовов ----
        StreamBuilder<List<WaiterCall>>(
          stream: _link.myCallsStream(_auth.uid),
          builder: (context, snap) {
            final calls = snap.data ?? const <WaiterCall>[];
            if (calls.isEmpty) return const SizedBox.shrink();
            return Padding(
              padding: const EdgeInsets.only(top: 14),
              child: Column(
                children: calls
                    .map((c) => Row(
                          children: [
                            // Была бесконечная «крутилка» с подписью
                            // «приняли, идём» — она обещала то, чего ещё не
                            // произошло: вызов всего лишь передан и ждёт
                            // кальянщика. Галочка и время говорят правду и
                            // не создают ощущения зависшего экрана.
                            Icon(Icons.check_circle_outline,
                                size: 15, color: KolibriColors.primary),
                            const SizedBox(width: 10),
                            Text('${c.type.label} — передали в '
                                '${c.createdAt.hour.toString().padLeft(2, '0')}:'
                                '${c.createdAt.minute.toString().padLeft(2, '0')}',
                                style: TextStyle(
                                    color: KolibriColors.textMuted, fontSize: 13)),
                          ],
                        ))
                    .toList(),
              ),
            );
          },
        ),

        const SizedBox(height: 24),

        // ---- Счёт ----
        const Text('Ваш счёт', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        const SizedBox(height: 12),
        if (s.orderItems.isEmpty)
          Text('Пока пусто — нажмите «Сделать заказ»',
              style: TextStyle(color: KolibriColors.textMuted))
        else
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: KolibriColors.surface,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: KolibriColors.border),
            ),
            child: Column(
              children: [
                ...s.orderItems.map((i) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 5),
                      child: Row(
                        children: [
                          Expanded(child: Text('${i.name} ×${i.qty}')),
                          Text(rub(i.total),
                              style: TextStyle(color: KolibriColors.textMuted)),
                        ],
                      ),
                    )),
                const Divider(height: 24),
                if (s.discountPercent > 0)
                  Row(
                    children: [
                      Expanded(
                        child: Text('Скидка ${s.discountPercent.toStringAsFixed(0)}%',
                            style: TextStyle(color: KolibriColors.gold)),
                      ),
                      Text(
                        '−${rub((s.orderTotal - s.totalWithDiscount))}',
                        style: TextStyle(color: KolibriColors.gold),
                      ),
                    ],
                  ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    const Expanded(
                      child: Text('Итого',
                          style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                    ),
                    Text(rub(s.totalWithDiscount),
                        style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                  ],
                ),
                if ((widget.profile?.bonusBalance ?? 0) > 0) ...[
                  const SizedBox(height: 8),
                  Text(
                    'Доступно бонусов: ${rub(widget.profile!.bonusBalance)} — '
                    'скажите ${VenueService.instance.terms.staffDat}, чтобы списать при оплате',
                    style: TextStyle(color: KolibriColors.gold, fontSize: 12),
                  ),
                ],
              ],
            ),
          ),

        if (VenueService.instance.cached.guestSbpPay && s.orderItems.isNotEmpty) ...[
          const SizedBox(height: 12),
          GuestSbpPayCard(sessionId: s.id, paidAlready: s.guestPaidTotal),
        ],

        // ---- Чаевые ----
        // Рядом со счётом, а не только в «Ещё»: о чаевых думают именно
        // тогда, когда смотрят на счёт.
        if (VenueService.instance.cached.tipsEnabled) ...[
          const SizedBox(height: 12),
          _TipsTotalLine(sessionId: s.id, clientUid: _auth.uid),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () => _openTips(s.id),
              icon: const Icon(Icons.volunteer_activism, size: 18),
              label: const Text('Оставить чаевые'),
            ),
          ),
        ],

        // ---- Мои заказы из приложения ----
        const SizedBox(height: 24),
        StreamBuilder<List<GuestOrder>>(
          stream: _link.clientOrdersStream(_auth.uid),
          builder: (context, snap) {
            final orders = (snap.data ?? const <GuestOrder>[])
                .where((o) => o.sessionId == s.id)
                .toList();
            if (orders.isEmpty) return const SizedBox.shrink();
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Заказы из приложения',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                const SizedBox(height: 10),
                ...orders.map((o) => ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      // Касса ведёт заказ так: new → preparing (принят в
                      // чек) → ready (несём к столу); rejected — отклонён.
                      leading: Icon(
                        _orderAccepted(o.status)
                            ? Icons.check_circle
                            : o.status == 'rejected'
                                ? Icons.cancel
                                : Icons.schedule,
                        color: _orderAccepted(o.status)
                            ? KolibriColors.success
                            : o.status == 'rejected'
                                ? KolibriColors.danger
                                : KolibriColors.warning,
                      ),
                      title: Text(o.items.map((i) => '${i.displayName}×${i.qty}').join(', '),
                          style: const TextStyle(fontSize: 13)),
                      subtitle: Text(
                        switch (o.status) {
                          'preparing' || 'accepted' => 'Принят — готовим',
                          'ready' => 'Готов — несём к столу',
                          'rejected' => o.rejectReason.isEmpty ? 'Отклонён' : 'Отклонён: ${o.rejectReason}',
                          _ => o.targetPosition.isEmpty
                              ? 'Ждёт подтверждения'
                              : 'Передан ${AppConstants.orderTargetDat(o.targetPosition)} · ждёт подтверждения',
                        },
                        style: const TextStyle(fontSize: 12),
                      ),
                    )),
              ],
            );
          },
        ),
      ],
    );
  }

  /// Кто принимает блюда и напитки: в баре — бармен, иначе официант.
  static String _waiterWord(VenueTerms terms) => AppConstants.orderTargetWord(
      AppConstants.guestOrderTarget(hookahItem: false, hookahVenue: terms.isHookah, bar: terms.type == VenueTerms.bar));

  /// Правила заведения — те же, что администратор пишет в профиле
  /// заведения на кассе.
  ///
  /// Читаются подпиской, а не разовым запросом: исправил правила в
  /// админке — у гостей они поменялись сразу, без переустановки
  /// приложения и без ожидания следующего запуска.
  ///
  /// Каждая строка поля превращается в отдельный пункт списка: так их
  /// пишут («Один кальян до 3 гостей», «18+»), и так их проще читать,
  /// чем сплошным абзацем.
  Widget _venueRules() {
    return StreamBuilder<VenueProfile>(
      stream: VenueService.instance.stream(),
      initialData: VenueService.instance.cached,
      builder: (context, snap) {
        final rules = (snap.data?.rules ?? '')
            .split('\n')
            .map((l) => l.trim().replaceFirst(RegExp(r'^[-•*]\s*'), ''))
            .where((l) => l.isNotEmpty)
            .toList();
        if (rules.isEmpty) return const SizedBox.shrink();

        return Padding(
          padding: const EdgeInsets.only(top: 28),
          child: Container(
            padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
            decoration: BoxDecoration(
              color: KolibriColors.surface,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: KolibriColors.border),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(Icons.info_outline,
                        size: 18, color: KolibriColors.gold),
                    const SizedBox(width: 8),
                    const Text('Правила заведения',
                        style: TextStyle(
                            fontSize: 15, fontWeight: FontWeight.w600)),
                  ],
                ),
                const SizedBox(height: 12),
                for (final rule in rules)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Padding(
                          padding: const EdgeInsets.only(top: 7, right: 10),
                          child: SizedBox(
                            width: 5,
                            height: 5,
                            child: DecoratedBox(
                              decoration: BoxDecoration(
                                color: KolibriColors.gold,
                                shape: BoxShape.circle,
                              ),
                            ),
                          ),
                        ),
                        Expanded(
                          child: Text(
                            rule,
                            style: TextStyle(
                              color: KolibriColors.textMuted,
                              fontSize: 13,
                              height: 1.45,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  /// «Спасибо за визит» по записи визита (чек уже закрыт и гостю недоступен).
  Widget _finishedVisit(String visitId) {
    return StreamBuilder<GuestVisit?>(
      stream: _link.visitById(_auth.uid, visitId),
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        final v = snap.data;
        if (v == null) return _notAtTable();
        // Предложение оценить имеет смысл по свежим следам. Визит
        // недельной давности не должен встречать гостя вместо его стола.
        if (DateTime.now().difference(v.date) > const Duration(hours: 12)) {
          return _notAtTable();
        }
        return _thankYou(
          tableName: v.tableName,
          total: v.paid > 0 ? v.paid : v.total,
          bonusEarned: v.bonusEarned,
          sessionId: visitId,
        );
      },
    );
  }

  /// Тот же экран, пока чек ещё виден гостю (касса не успела начислить
  /// бонусы и обнулить привязку).
  Widget _visitFinished(SessionModel s) => _thankYou(
        tableName: s.tableName,
        total: s.paymentTotal,
        bonusEarned: 0,
        sessionId: s.id,
      );

  Widget _thankYou({
    required String tableName,
    required double total,
    required double bonusEarned,
    required String sessionId,
  }) =>
      ListView(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 100),
        children: [
          Text('Спасибо за визит!', style: KolibriFonts.display(34)),
          const SizedBox(height: 8),
          Text('Счёт (${tableLabel(tableName)}) закрыт на '
              '${rub(total)}.',
              style: TextStyle(color: KolibriColors.textMuted)),
          if (bonusEarned > 0) ...[
            const SizedBox(height: 6),
            Text('Начислено ${bonusesLabel(bonusEarned)}',
                style: TextStyle(color: KolibriColors.primary)),
          ],
          const SizedBox(height: 24),
          const Text('Как всё прошло?',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          const SizedBox(height: 12),
          _RatingBar(
            onRated: (rating, text) async {
              await _link.addReview(GuestReview(
                id: '',
                sessionId: sessionId,
                clientUid: _auth.uid,
                guestName: widget.profile?.name ?? '',
                rating: rating,
                text: text,
                createdAt: DateTime.now(),
              ));
              // Отмечаем визит оценённым — иначе предложение оценить
              // висело бы до следующего визита.
              await _link.markVisitRated(_auth.uid, sessionId);
              await _link.unbind(_auth.uid);
              if (mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Спасибо! Ваш отзыв важен для нас')),
                );
              }
            },
          ),
          const SizedBox(height: 8),
          Center(
            child: TextButton(
              onPressed: () async {
                await _link.markVisitRated(_auth.uid, sessionId);
                if (mounted) setState(() {});
              },
              child: const Text('Не сейчас'),
            ),
          ),
        ],
      );

  void _openTips(String sessionId) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: KolibriColors.surface,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Чаевые', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
              const SizedBox(height: 14),
              KolibriTipsPanel(sessionId: sessionId, clientUid: _auth.uid),
            ],
          ),
        ),
      ),
    );
  }

  /// Типы вызовов, которые уже переданы и ещё не закрыты кальянщиком.
  /// Повторное нажатие по такому типу ничего нового не создаёт.
  final _pendingCalls = <GuestCallType>{};

  Widget _callButton(SessionModel s, GuestCallType type, IconData icon) {
    final pending = _pendingCalls.contains(type);
    return OutlinedButton.icon(
      // Кнопка не ждёт сеть: Firestore применит запись локально и сам
      // дошлёт. С await на слабой связи кнопку жали по нескольку раз.
      onPressed: pending
          ? null
          : () {
              _link.callStaff(
                tableId: s.tableId,
                tableName: s.tableName,
                sessionId: s.id,
                type: type,
                clientUid: _auth.uid,
                guestName: widget.profile?.name ?? '',
              );
              setState(() => _pendingCalls.add(type));
              // Кому передали — по типу вызова (GuestCallTypeX.targetPosition).
              final toWhom = type.targetPosition == AppConstants.positionWaiter
                  ? 'официанту'
                  : VenueService.instance.terms.staffDat;
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: Text('${type.label} — передали $toWhom'),
                  duration: const Duration(seconds: 2),
                ),
              );
              // Через минуту разрешаем позвать снова: кальянщик мог не
              // услышать, и гость не должен оказаться запертым.
              Future.delayed(const Duration(minutes: 1), () {
                if (mounted) setState(() => _pendingCalls.remove(type));
              });
            },
      icon: Icon(icon,
          size: 18,
          color: pending ? KolibriColors.textMuted : KolibriColors.accent),
      label: Text(
        pending ? 'Передано' : type.label,
        style: const TextStyle(fontSize: 13),
      ),
    );
  }

}

/// «Чаевые к счёту: 300 ₽» — чтобы гость видел, сколько всего отдаст.
class _TipsTotalLine extends StatefulWidget {
  final String sessionId;
  final String clientUid;
  const _TipsTotalLine({required this.sessionId, required this.clientUid});

  @override
  State<_TipsTotalLine> createState() => _TipsTotalLineState();
}

class _TipsTotalLineState extends State<_TipsTotalLine> {
  late final Stream<List<TipModel>> _tips =
      TipsService.instance.sessionTipsStream(widget.sessionId, clientUid: widget.clientUid);

  @override
  Widget build(BuildContext context) => StreamBuilder<List<TipModel>>(
        stream: _tips,
        builder: (context, snap) {
          final onBill = (snap.data ?? const <TipModel>[]).where((t) => t.onBill);
          final sum = onBill.fold<double>(0, (a, t) => a + t.amount);
          if (sum <= 0) return const SizedBox.shrink();
          return Text('Чаевые к счёту: ${rub(sum)} — возьмём вместе с оплатой',
              style: TextStyle(color: KolibriColors.success, fontSize: 13));
        },
      );
}

/// Оценка визита: звёзды + необязательный комментарий.
class _RatingBar extends StatefulWidget {
  final Future<void> Function(int rating, String text) onRated;
  const _RatingBar({required this.onRated});

  @override
  State<_RatingBar> createState() => _RatingBarState();
}

class _RatingBarState extends State<_RatingBar> {
  int _rating = 0;
  final _text = TextEditingController();
  bool _sent = false;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_sent) {
      return Text('Отзыв отправлен. До встречи!',
          style: TextStyle(color: KolibriColors.success));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: List.generate(
            5,
            (i) => IconButton(
              onPressed: () => setState(() => _rating = i + 1),
              icon: Icon(
                i < _rating ? Icons.star : Icons.star_border,
                color: KolibriColors.gold,
                size: 34,
              ),
            ),
          ),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _text,
          maxLines: 3,
          maxLength: 2000,
          decoration: const InputDecoration(
            labelText: 'Что понравилось или что улучшить',
          ),
        ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: _rating == 0
              ? null
              : () async {
                  await widget.onRated(_rating, _text.text.trim());
                  if (mounted) setState(() => _sent = true);
                },
          child: const Text('Отправить отзыв'),
        ),
      ],
    );
  }
}

bool _orderAccepted(String status) =>
    status == 'preparing' || status == 'ready' || status == 'accepted';
