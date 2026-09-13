import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../models/reservation_model.dart';
import '../../models/session_model.dart';
import '../../services/guest_link_service.dart';
import '../../services/reservation_service.dart';
import '../services/kolibri_auth_service.dart';
import '../theme/kolibri_theme.dart';
import '../widgets/kolibri_ai_chat.dart';
import 'kolibri_qr_scan_screen.dart';
import 'kolibri_stories_screen.dart';

/// Главный экран гостя: бонусы, текущий визит, ближайшая бронь и быстрые
/// действия. Все блоки живые — данные те же, что видит кассир на POS.
class KolibriHomeScreen extends StatelessWidget {
  final ClientProfile? profile;
  final void Function(int tabIndex) onOpenTab;

  const KolibriHomeScreen({super.key, required this.profile, required this.onOpenTab});

  @override
  Widget build(BuildContext context) {
    final auth = KolibriAuthService();
    final link = GuestLinkService();
    final reservations = ReservationService();
    final name = (profile?.name ?? '').isEmpty ? 'Гость' : profile!.name;

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 100),
      children: [
        Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Колибри Лаундж',
                      style: TextStyle(
                          fontSize: 13,
                          letterSpacing: 2,
                          color: KolibriColors.primary,
                          fontWeight: FontWeight.w600)),
                  const SizedBox(height: 4),
                  Text(_greeting() + ', ' + name,
                      style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
                ],
              ),
            ),
            const Icon(Icons.local_fire_department, color: KolibriColors.gold, size: 32),
          ],
        ),
        const SizedBox(height: 20),

        // ---- Бонусы и уровень ----
        _bonusCard(context),

        const SizedBox(height: 16),

        // ---- Текущий визит ----
        if ((profile?.activeSessionId ?? '').isNotEmpty)
          StreamBuilder<SessionModel?>(
            stream: link.sessionStream(profile!.activeSessionId),
            builder: (context, snap) {
              final s = snap.data;
              if (s == null || s.status != 'active') return const SizedBox.shrink();
              final left = s.remaining.inMinutes;
              return Card(
                child: InkWell(
                  borderRadius: BorderRadius.circular(18),
                  onTap: () => onOpenTab(3),
                  child: Padding(
                    padding: const EdgeInsets.all(18),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Icon(Icons.local_fire_department,
                                color: KolibriColors.accent, size: 20),
                            const SizedBox(width: 8),
                            Text('Вы за столом ${s.tableName}',
                                style: const TextStyle(
                                    fontSize: 16, fontWeight: FontWeight.w600)),
                          ],
                        ),
                        const SizedBox(height: 10),
                        Text(
                          left > 0
                              ? 'До конца сеанса $left мин · счёт ${s.orderTotal.toStringAsFixed(0)} ₽'
                              : 'Время сеанса вышло · счёт ${s.orderTotal.toStringAsFixed(0)} ₽',
                          style: TextStyle(
                            color: left > 15 ? KolibriColors.textMuted : KolibriColors.warning,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),

        // ---- Ближайшая бронь ----
        StreamBuilder<List<ReservationModel>>(
          stream: reservations.clientStream(auth.uid),
          builder: (context, snap) {
            final list = (snap.data ?? const <ReservationModel>[])
                .where((r) => r.status.blocksTable && r.endTime.isAfter(DateTime.now()))
                .toList()
              ..sort((a, b) => a.startTime.compareTo(b.startTime));
            if (list.isEmpty) return const SizedBox.shrink();
            final r = list.first;
            return Padding(
              padding: const EdgeInsets.only(top: 16),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(18),
                  child: Row(
                    children: [
                      const Icon(Icons.event_available, color: KolibriColors.primary),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '${_fmtDate(r.startTime)} в ${_fmtTime(r.startTime)}',
                              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16),
                            ),
                            Text(
                              '${r.guestsCount} чел · '
                              '${r.tableName.isEmpty ? 'стол подберём' : r.tableName} · '
                              '${r.status.label}',
                              style: const TextStyle(
                                  color: KolibriColors.textMuted, fontSize: 13),
                            ),
                          ],
                        ),
                      ),
                      TextButton(
                        onPressed: () => onOpenTab(2),
                        child: const Text('Изменить'),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),

        // Лента заведения: новые миксы, ивенты, акции. Пустая лента
        // схлопывается в ноль и не оставляет дыру на экране.
        const SizedBox(height: 24),
        KolibriStoriesScreen(onOpenTab: onOpenTab),

        const SizedBox(height: 24),
        const Text('Быстрые действия',
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: _action(
                icon: Icons.event_seat,
                title: 'Забронировать',
                subtitle: 'Стол на вечер',
                onTap: () => onOpenTab(2),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _action(
                icon: Icons.restaurant_menu,
                title: 'Меню',
                subtitle: 'Что есть сегодня',
                onTap: () => onOpenTab(1),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: _action(
                icon: Icons.auto_awesome,
                title: 'Подбор кальяна',
                subtitle: 'ИИ-сомелье',
                color: KolibriColors.gold,
                onTap: () => KolibriAiChat.show(
                  context,
                  guestUid: auth.uid,
                  sommelierMode: true,
                  initialQuestion: 'Подбери мне кальян на сегодня.',
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _action(
                icon: Icons.qr_code_scanner,
                title: 'Я за столом',
                subtitle: 'Сканировать QR стола',
                color: KolibriColors.accent,
                onTap: () async {
                  // QR со стола сразу привязывает гостя к открытому чеку —
                  // быстрее, чем искать стол в списке.
                  final sessionId = await Navigator.of(context).push<String>(
                    MaterialPageRoute(builder: (_) => const KolibriQrScanScreen()),
                  );
                  if (sessionId != null) onOpenTab(3);
                },
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _bonusCard(BuildContext context) {
    final bonus = profile?.bonusBalance ?? 0;
    final tier = profile?.tier ?? 'Бронза';
    final cashback = profile?.cashbackPercent ?? 3;
    final tierColor = KolibriColors.tierColor(tier);

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(20),
        gradient: LinearGradient(
          colors: [KolibriColors.surfaceElevated, KolibriColors.surface],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        border: Border.all(color: tierColor.withValues(alpha: 0.45)),
      ),
      child: Row(
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Бонусный счёт',
                  style: TextStyle(color: KolibriColors.textMuted, fontSize: 13)),
              const SizedBox(height: 6),
              Text('${bonus.toStringAsFixed(0)} ₽',
                  style: TextStyle(
                      fontSize: 30, fontWeight: FontWeight.w700, color: tierColor)),
              const SizedBox(height: 4),
              Text('Уровень «$tier» · кешбэк ${cashback.toStringAsFixed(0)}%',
                  style: const TextStyle(color: KolibriColors.textMuted, fontSize: 12)),
            ],
          ),
          const Spacer(),
          Icon(Icons.card_giftcard, color: tierColor, size: 36),
        ],
      ),
    );
  }

  Widget _action({
    required IconData icon,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
    Color color = KolibriColors.primary,
  }) =>
      InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(18),
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: KolibriColors.surface,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: KolibriColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, color: color),
              const SizedBox(height: 12),
              Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
              Text(subtitle,
                  style: const TextStyle(color: KolibriColors.textMuted, fontSize: 12)),
            ],
          ),
        ),
      );

  String _greeting() {
    final h = DateTime.now().hour;
    if (h < 6) return 'Доброй ночи';
    if (h < 12) return 'Доброе утро';
    if (h < 18) return 'Добрый день';
    return 'Добрый вечер';
  }

  String _fmtDate(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}';

  String _fmtTime(DateTime d) =>
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}
