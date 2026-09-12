import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../models/session_model.dart';
import '../../models/table_model.dart';
import '../../services/guest_link_service.dart';
import '../services/kolibri_auth_service.dart';
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
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    // Пересобираем экран раз в секунду — таймер сеанса должен «идти».
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final sessionId = widget.profile?.activeSessionId ?? '';
    if (sessionId.isEmpty) return _notAtTable();

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
            'Когда вы придёте, откройте свой стол — и увидите счёт, таймер '
            'и сможете звать кальянщика из приложения.',
            style: TextStyle(color: KolibriColors.textMuted),
          ),
          const SizedBox(height: 24),
          FilledButton.icon(
            onPressed: _pickTable,
            icon: const Icon(Icons.table_restaurant),
            label: const Text('Я за столом'),
          ),
          const SizedBox(height: 12),
          const Text(
            'Выберите свой стол из списка или отсканируйте QR-код на столе.',
            style: TextStyle(color: KolibriColors.textMuted, fontSize: 12),
          ),
        ],
      );

  Widget _activeVisit(SessionModel s) {
    final left = s.remaining;
    final over = left.isNegative;
    final minutes = left.inMinutes.abs();
    final seconds = (left.inSeconds.abs() % 60).toString().padLeft(2, '0');

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
        Container(
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
        ),

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

        // ---- Статус вызовов ----
        StreamBuilder<List<WaiterCall>>(
          stream: _link.tableCallsStream(s.tableId),
          builder: (context, snap) {
            final calls = snap.data ?? const <WaiterCall>[];
            if (calls.isEmpty) return const SizedBox.shrink();
            return Padding(
              padding: const EdgeInsets.only(top: 14),
              child: Column(
                children: calls
                    .map((c) => Row(
                          children: [
                            const SizedBox(
                              height: 14,
                              width: 14,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                            const SizedBox(width: 10),
                            Text('${c.type.label} — приняли, идём',
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
                            style: const TextStyle(color: KolibriColors.gold)),
                      ),
                      Text(
                        '−${(s.orderTotal - s.totalWithDiscount).toStringAsFixed(0)} ₽',
                        style: const TextStyle(color: KolibriColors.gold),
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
                    style: const TextStyle(color: KolibriColors.gold, fontSize: 12),
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

  Widget _visitFinished(SessionModel s) => ListView(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 100),
        children: [
          const Text('Спасибо за визит!',
              style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Text('Счёт за столом ${s.tableName} закрыт на '
              '${s.paymentTotal.toStringAsFixed(0)} ₽.',
              style: const TextStyle(color: KolibriColors.textMuted)),
          const SizedBox(height: 24),
          const Text('Как всё прошло?',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          const SizedBox(height: 12),
          _RatingBar(
            onRated: (rating, text) async {
              await _link.addReview(GuestReview(
                id: '',
                sessionId: s.id,
                clientUid: _auth.uid,
                guestName: widget.profile?.name ?? '',
                rating: rating,
                text: text,
                createdAt: DateTime.now(),
              ));
              await _link.unbind(_auth.uid);
              if (mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Спасибо! Ваш отзыв важен для нас')),
                );
              }
            },
          ),
        ],
      );

  Widget _callButton(SessionModel s, GuestCallType type, IconData icon) => OutlinedButton.icon(
        onPressed: () async {
          await _link.callStaff(
            tableId: s.tableId,
            tableName: s.tableName,
            sessionId: s.id,
            type: type,
            clientUid: _auth.uid,
            guestName: widget.profile?.name ?? '',
          );
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('${type.label} — передали кальянщику')),
            );
          }
        },
        icon: Icon(icon, size: 18, color: KolibriColors.accent),
        label: Text(type.label, style: const TextStyle(fontSize: 13)),
      );

  /// Выбор своего стола из списка занятых столов зала. Гость не может
  /// «сесть» за свободный стол — счёт открывает только кальянщик.
  Future<void> _pickTable() async {
    final snap = await FirebaseFirestore.instance.collection('tables').get();
    final busy = snap.docs
        .map(TableModel.fromDoc)
        .where((t) => t.activeSessionIds.isNotEmpty)
        .toList();

    if (!mounted) return;
    if (busy.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Сейчас нет открытых столов — попросите кальянщика начать сеанс')),
      );
      return;
    }

    final picked = await showModalBottomSheet<TableModel>(
      context: context,
      backgroundColor: KolibriColors.surface,
      builder: (_) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: busy
              .map((t) => ListTile(
                    leading: const Icon(Icons.table_restaurant, color: KolibriColors.primary),
                    title: Text(t.name),
                    subtitle: Text('${t.seats} мест'),
                    onTap: () => Navigator.pop(context, t),
                  ))
              .toList(),
        ),
      ),
    );

    if (picked == null) return;
    final sessionId = await _link.bindToTable(_auth.uid, picked.id);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(sessionId == null
            ? 'Стол уже свободен — обновите список'
            : 'Готово! Ваш счёт открыт'),
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
