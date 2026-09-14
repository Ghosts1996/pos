import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../models/venue_models.dart';
import '../../services/gift_card_service.dart';
import '../../services/guest_link_service.dart';
import '../../services/referral_service.dart';
import '../../services/waitlist_service.dart';
import '../services/kolibri_auth_service.dart';
import '../theme/kolibri_theme.dart';

/// Дополнительные сервисы для гостя: чаевые кальянщику, сертификат,
/// очередь на стол и приглашение друга.
///
/// Все четыре вещи объединены на одном экране сознательно — это редкие
/// действия, и отдельные вкладки под каждое только запутывают.
class KolibriExtrasScreen extends StatefulWidget {
  final ClientProfile? profile;
  const KolibriExtrasScreen({super.key, required this.profile});

  @override
  State<KolibriExtrasScreen> createState() => _KolibriExtrasScreenState();
}

class _KolibriExtrasScreenState extends State<KolibriExtrasScreen> {
  final _auth = KolibriAuthService();
  final _link = GuestLinkService();
  final _cards = GiftCardService.instance;
  final _waitlist = WaitlistService.instance;
  final _referral = ReferralService.instance;

  final _cardCode = TextEditingController();
  final _referralCode = TextEditingController();

  GiftCard? _card;
  String? _cardMessage;
  String? _referralMessage;
  String _myCode = '';

  @override
  void initState() {
    super.initState();
    _referral.ensureCode(_auth.uid).then((c) {
      if (mounted) setState(() => _myCode = c);
    });
  }

  @override
  void dispose() {
    _cardCode.dispose();
    _referralCode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 120),
      children: [
        const Text('Ещё', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
        const SizedBox(height: 20),

        _section(
          icon: Icons.volunteer_activism,
          title: 'Чаевые кальянщику',
          child: _tipsBlock(),
        ),
        const SizedBox(height: 16),

        _section(
          icon: Icons.card_giftcard,
          title: 'Подарочный сертификат',
          child: _giftCardBlock(),
        ),
        const SizedBox(height: 16),

        _section(
          icon: Icons.hourglass_bottom,
          title: 'Занять очередь',
          child: _waitlistBlock(),
        ),
        const SizedBox(height: 16),

        _section(
          icon: Icons.group_add,
          title: 'Пригласить друга',
          child: _referralBlock(),
        ),
      ],
    );
  }

  Widget _section({required IconData icon, required String title, required Widget child}) =>
      Container(
        padding: const EdgeInsets.all(18),
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
                Icon(icon, color: KolibriColors.primary, size: 20),
                const SizedBox(width: 10),
                Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              ],
            ),
            const SizedBox(height: 12),
            child,
          ],
        ),
      );

  // ---------- ЧАЕВЫЕ ----------

  Widget _tipsBlock() {
    final sessionId = widget.profile?.activeSessionId ?? '';
    if (sessionId.isEmpty) {
      return const Text('Чаевые можно оставить во время визита — откройте свой стол.',
          style: TextStyle(color: KolibriColors.textMuted, fontSize: 13));
    }
    return StreamBuilder(
      stream: _link.sessionStream(sessionId),
      builder: (context, snap) {
        final employee = snap.data?.employeeName ?? '';
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              employee.isEmpty ? 'Ваш кальянщик' : 'Ваш кальянщик: $employee',
              style: const TextStyle(color: KolibriColors.textMuted, fontSize: 13),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              children: [200.0, 500.0, 1000.0]
                  .map((amount) => OutlinedButton(
                        onPressed: () => _leaveTip(amount, employee, sessionId),
                        child: Text('${amount.toStringAsFixed(0)} ₽'),
                      ))
                  .toList(),
            ),
          ],
        );
      },
    );
  }

  Future<void> _leaveTip(double amount, String employeeName, String sessionId) async {
    await TipsService.instance.leaveTip(
      amount: amount,
      employeeName: employeeName.isEmpty ? 'Смена' : employeeName,
      sessionId: sessionId,
      clientUid: _auth.uid,
    );
    if (!mounted) return;
    // Деньги списывает платёжный провайдер на следующем шаге; здесь мы
    // зафиксировали намерение и сообщили смене.
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Спасибо! ${amount.toStringAsFixed(0)} ₽ передадим кальянщику')),
    );
  }

  // ---------- СЕРТИФИКАТ ----------

  Widget _giftCardBlock() => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _cardCode,
                  textCapitalization: TextCapitalization.characters,
                  decoration: const InputDecoration(
                    hintText: 'KLB-XXXX-XXXX',
                    isDense: true,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              OutlinedButton(
                onPressed: () async {
                  final card = await _cards.find(_cardCode.text);
                  if (!mounted) return;
                  setState(() {
                    _card = card;
                    _cardMessage = card == null
                        ? 'Сертификат не найден'
                        : card.isUsable
                            ? 'Остаток ${card.balance.toStringAsFixed(0)} ₽'
                                '${card.usesLeft == null ? '' : ', ещё ${card.usesLeft} '
                                    '${card.usesLeft == 1 ? 'списание' : 'списаний'}'}'
                            : !card.hasUsesLeft
                                ? 'Сертификат уже использован полностью'
                                : 'Сертификат уже использован или истёк';
                  });
                },
                child: const Text('Проверить'),
              ),
            ],
          ),
          if (_cardMessage != null)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(
                _cardMessage!,
                style: TextStyle(
                  color: _card?.isUsable == true ? KolibriColors.success : KolibriColors.warning,
                ),
              ),
            ),
          const SizedBox(height: 8),
          const Text('Назовите код кальянщику при оплате — сумма спишется с сертификата.',
              style: TextStyle(color: KolibriColors.textMuted, fontSize: 12)),
        ],
      );

  // ---------- ОЧЕРЕДЬ ----------

  Widget _waitlistBlock() => StreamBuilder<List<WaitlistEntry>>(
        stream: _waitlist.clientStream(_auth.uid),
        builder: (context, snap) {
          final open = (snap.data ?? const <WaitlistEntry>[]).where((e) => e.isOpen).toList();
          if (open.isNotEmpty) {
            final e = open.first;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  e.status == 'invited'
                      ? 'Ваш стол готов — ждём вас!'
                      : 'Вы в очереди, ждать примерно ${e.promisedMinutes} мин',
                  style: TextStyle(
                    color: e.status == 'invited'
                        ? KolibriColors.success
                        : KolibriColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 10),
                TextButton(
                  onPressed: () => _waitlist.markLeft(e.id),
                  child: const Text('Выйти из очереди',
                      style: TextStyle(color: KolibriColors.danger)),
                ),
              ],
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Если все столы заняты — встаньте в очередь, мы напишем, '
                  'как только стол освободится.',
                  style: TextStyle(color: KolibriColors.textMuted, fontSize: 13)),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                children: [2, 4, 6]
                    .map((n) => OutlinedButton(
                          onPressed: () => _join(n),
                          child: Text('$n чел.'),
                        ))
                    .toList(),
              ),
            ],
          );
        },
      );

  Future<void> _join(int guests) async {
    final result = await _waitlist.join(
      guestName: widget.profile?.name ?? 'Гость',
      guestsCount: guests,
      phone: widget.profile?.phone ?? '',
      clientUid: _auth.uid,
    );
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(result.position > 0
          ? 'Вы ${result.position}-й в очереди, ждать ~${result.minutes} мин'
          : 'Вы в очереди, ждать ~${result.minutes} мин')),
    );
  }

  // ---------- РЕФЕРАЛЬНАЯ ПРОГРАММА ----------

  Widget _referralBlock() => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Ваш код: ${_myCode.isEmpty ? '…' : _myCode}',
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 6),
          Text(
            'Друг называет его в первый визит: ему '
            '${ReferralService.inviteeBonus.toStringAsFixed(0)} бонусов, вам — '
            '${ReferralService.inviterBonus.toStringAsFixed(0)}.',
            style: const TextStyle(color: KolibriColors.textMuted, fontSize: 13),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _referralCode,
                  textCapitalization: TextCapitalization.characters,
                  decoration: const InputDecoration(
                    hintText: 'Код друга',
                    isDense: true,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              OutlinedButton(
                onPressed: () async {
                  final msg = await _referral.applyCode(
                    uid: _auth.uid,
                    code: _referralCode.text,
                  );
                  if (mounted) setState(() => _referralMessage = msg);
                },
                child: const Text('Применить'),
              ),
            ],
          ),
          if (_referralMessage != null)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(_referralMessage!,
                  style: const TextStyle(color: KolibriColors.gold, fontSize: 13)),
            ),
        ],
      );
}
