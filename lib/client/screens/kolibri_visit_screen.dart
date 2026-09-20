import 'dart:async';
import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../models/session_model.dart';
import '../../models/venue_models.dart';
import '../../utils/constants.dart';
import '../../services/guest_link_service.dart';
import '../../services/venue_service.dart';
import '../../widgets/clock_ticker.dart';
import '../services/kolibri_auth_service.dart';
import 'kolibri_hall_map_screen.dart';
import 'kolibri_qr_scan_screen.dart';
import '../theme/kolibri_theme.dart';

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

  // Раз в секунду здесь перестраивался ВЕСЬ экран: список позиций счёта,
  // кнопки вызова, карточки — ради одной надписи с обратным отсчётом.
  // На слабых телефонах это давало заметные подтормаживания и грело
  // батарею впустую. Теперь тикает только сам счётчик (TickerBuilder), и
  // от общего таймера приложения, а не от собственного.

  @override
  Widget build(BuildContext context) {
    final sessionId = widget.profile?.activeSessionId ?? '';

    // Гость уже не за столом. Но если последний визит закрыт только что и
    // оценка за него не поставлена — показываем «Спасибо за визит».
    //
    // Раньше этот экран строился на activeSessionId, а касса обнуляет его
    // при оплате: предложение оценить визит появлялось и пропадало в тот
    // же миг. Теперь оно держится на записи визита, которая никуда не
    // денется, и живёт, пока гость не оценит или не закроет его.
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
        return _activeVisit(s);
      },
    );
  }

  // ---------- СОСТОЯНИЯ ----------

  Widget _notAtTable() => ListView(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 100),
        children: [
          const Text('Мой стол',
              style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          const Text(
            'Отсканируйте QR-код на своём столе — откроются счёт, таймер '
            'сеанса и кнопки вызова кальянщика.',
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
          const Text(
            'Стол открывается только по коду с самого стола — так вы '
            'наверняка попадёте на свой счёт, а не на соседний. Если код '
            'не сканируется, позовите кальянщика: он откроет стол сам.',
            style: TextStyle(
                color: KolibriColors.textMuted, fontSize: 12, height: 1.5),
          ),
          _venueRules(),
        ],
      );

  Widget _activeVisit(SessionModel s) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 120),
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('Стол ${s.tableName}',
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
        TickerBuilder(builder: (context, _) {
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
                  style: const TextStyle(color: KolibriColors.textMuted)),
              const SizedBox(height: 8),
              Text(
                '$minutes:$seconds',
                style: TextStyle(
                  fontSize: 44,
                  fontWeight: FontWeight.w700,
                  color: over
                      ? KolibriColors.danger
                      : (left.inMinutes <= 15 ? KolibriColors.warning : KolibriColors.primary),
                ),
              ),
              if (s.refillCount > 0)
                Text('Перезабивок: ${s.refillCount}',
                    style: const TextStyle(color: KolibriColors.textMuted, fontSize: 12)),
            ],
          ),
          );
        }),

        const SizedBox(height: 20),

        // ---- Кнопки обращений ----
        const Text('Позвать', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        const SizedBox(height: 12),
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
                                style: const TextStyle(
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
          const Text('Пока пусто — закажите в разделе «Меню»',
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
                          Text('${i.total.toStringAsFixed(0)} ₽',
                              style: const TextStyle(color: KolibriColors.textMuted)),
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
                        '−${(s.orderTotal - s.totalWithDiscount).toStringAsFixed(0)} ₽',
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
                    Text('${s.totalWithDiscount.toStringAsFixed(0)} ₽',
                        style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                  ],
                ),
                if ((widget.profile?.bonusBalance ?? 0) > 0) ...[
                  const SizedBox(height: 8),
                  Text(
                    'Доступно бонусов: ${widget.profile!.bonusBalance.toStringAsFixed(0)} ₽ — '
                    'скажите кальянщику, чтобы списать при оплате',
                    style: TextStyle(color: KolibriColors.gold, fontSize: 12),
                  ),
                ],
              ],
            ),
          ),

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
                      leading: Icon(
                        o.status == 'accepted'
                            ? Icons.check_circle
                            : o.status == 'rejected'
                                ? Icons.cancel
                                : Icons.schedule,
                        color: o.status == 'accepted'
                            ? KolibriColors.success
                            : o.status == 'rejected'
                                ? KolibriColors.danger
                                : KolibriColors.warning,
                      ),
                      title: Text(o.items.map((i) => '${i.name}×${i.qty}').join(', '),
                          style: const TextStyle(fontSize: 13)),
                      subtitle: Text(
                        o.status == 'accepted'
                            ? 'Принят'
                            : o.status == 'rejected'
                                ? 'Отклонён: ${o.rejectReason}'
                                : 'Ждёт подтверждения',
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
                    SizedBox(width: 8),
                    Text('Правила заведения',
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
                          padding: EdgeInsets.only(top: 7, right: 10),
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
                            style: const TextStyle(
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
          const Text('Спасибо за визит!',
              style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Text('Счёт за столом $tableName закрыт на '
              '${total.toStringAsFixed(0)} ₽.',
              style: const TextStyle(color: KolibriColors.textMuted)),
          if (bonusEarned > 0) ...[
            const SizedBox(height: 6),
            Text('Начислено ${bonusEarned.toStringAsFixed(0)} бонусов',
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

  /// Типы вызовов, которые уже переданы и ещё не закрыты кальянщиком.
  /// Повторное нажатие по такому типу ничего нового не создаёт.
  final _pendingCalls = <GuestCallType>{};

  Widget _callButton(SessionModel s, GuestCallType type, IconData icon) {
    final pending = _pendingCalls.contains(type);
    return OutlinedButton.icon(
      // Кнопка не ждёт сеть: запись уходит в Firestore, который применяет
      // её локально мгновенно и сам дошлёт на сервер. Раньше здесь стоял
      // await, и на слабой связи кнопка висела секундами — гость успевал
      // нажать её несколько раз, а кальянщик получал пачку одинаковых
      // вызовов (ровно это и видно на экране с восемью «крутилками»).
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
              // Кому именно передали — зависит от типа вызова (см.
              // GuestCallTypeX.targetPosition): раньше тут было зашито
              // "кальянщику" для всех типов, включая счёт и (после этой
              // правки) вызов официанта — что было бы просто неверно.
              final toWhom = type.targetPosition == AppConstants.positionWaiter
                  ? 'официанту'
                  : 'кальянщику';
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
      return const Text('Отзыв отправлен. До встречи!',
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
