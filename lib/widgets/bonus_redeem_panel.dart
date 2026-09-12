import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../models/client_models.dart';
import '../services/guest_link_service.dart';
import '../theme/app_colors.dart';

/// Панель списания бонусов на экране оплаты.
///
/// Находит гостя по открытому чеку (clients.activeSessionId) или по телефону
/// и позволяет списать бонусы в счёт оплаты. Списанная сумма возвращается
/// наружу через [onApplied] — экран оплаты уменьшает на неё сумму к оплате
/// и проводит её как отдельный «бонусный» платёж.
///
/// Ограничение по умолчанию: бонусами закрывается не более 50% чека —
/// иначе программа лояльности начинает съедать выручку.
class BonusRedeemPanel extends StatefulWidget {
  final String sessionId;
  final double billTotal;
  final void Function(double applied, ClientProfile profile) onApplied;

  /// Максимальная доля чека, которую можно закрыть бонусами (0..1).
  final double maxShare;

  const BonusRedeemPanel({
    super.key,
    required this.sessionId,
    required this.billTotal,
    required this.onApplied,
    this.maxShare = 0.5,
  });

  @override
  State<BonusRedeemPanel> createState() => _BonusRedeemPanelState();
}

class _BonusRedeemPanelState extends State<BonusRedeemPanel> {
  final _link = GuestLinkService();
  final _phone = TextEditingController();

  ClientProfile? _profile;
  double _applied = 0;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _findBySession();
  }

  @override
  void dispose() {
    _phone.dispose();
    super.dispose();
  }

  double get _limit {
    final byShare = widget.billTotal * widget.maxShare;
    final balance = _profile?.bonusBalance ?? 0;
    return (byShare < balance ? byShare : balance).floorToDouble();
  }

  Future<void> _findBySession() async {
    final snap = await FirebaseFirestore.instance
        .collection('clients')
        .where('activeSessionId', isEqualTo: widget.sessionId)
        .limit(1)
        .get();
    if (snap.docs.isNotEmpty && mounted) {
      setState(() => _profile = ClientProfile.fromDoc(snap.docs.first));
    }
  }

  Future<void> _findByPhone() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final found = await _link.findByPhone(_phone.text.trim());
    if (mounted) {
      setState(() {
        _profile = found;
        _busy = false;
        if (found == null) _error = 'Гость с таким телефоном не найден';
      });
    }
  }

  Future<void> _redeem(double amount) async {
    if (_profile == null || amount <= 0) return;
    setState(() => _busy = true);
    try {
      final applied = await _link.redeemBonuses(
        clientUid: _profile!.uid,
        sessionId: widget.sessionId,
        requested: amount,
      );
      if (!mounted) return;
      setState(() {
        _applied = applied;
        _busy = false;
      });
      widget.onApplied(applied, _profile!);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = '$e';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.card_giftcard, color: AppColors.warning, size: 20),
              const SizedBox(width: 8),
              const Text('Бонусы гостя',
                  style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w600)),
              const Spacer(),
              if (_applied > 0)
                Text('Списано ${_applied.toStringAsFixed(0)} ₽',
                    style: const TextStyle(color: AppColors.success)),
            ],
          ),
          const SizedBox(height: 12),
          if (_profile == null) ...[
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _phone,
                    keyboardType: TextInputType.phone,
                    style: const TextStyle(color: AppColors.textPrimary),
                    decoration: const InputDecoration(
                      labelText: 'Телефон гостя',
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                OutlinedButton(
                  onPressed: _busy ? null : _findByPhone,
                  child: const Text('Найти'),
                ),
              ],
            ),
          ] else ...[
            Text(
              '${_profile!.name.isEmpty ? 'Гость' : _profile!.name} · уровень «${_profile!.tier}» · '
              'баланс ${_profile!.bonusBalance.toStringAsFixed(0)} ₽',
              style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
            ),
            const SizedBox(height: 10),
            if (_applied == 0) ...[
              Text(
                'Можно списать до ${_limit.toStringAsFixed(0)} ₽ '
                '(не более ${(widget.maxShare * 100).round()}% чека)',
                style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                children: [
                  if (_limit >= 100)
                    OutlinedButton(onPressed: _busy ? null : () => _redeem(100), child: const Text('100 ₽')),
                  if (_limit >= 500)
                    OutlinedButton(onPressed: _busy ? null : () => _redeem(500), child: const Text('500 ₽')),
                  FilledButton(
                    onPressed: _busy || _limit <= 0 ? null : () => _redeem(_limit),
                    child: Text('Списать ${_limit.toStringAsFixed(0)} ₽'),
                  ),
                ],
              ),
            ],
          ],
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(_error!, style: const TextStyle(color: AppColors.danger, fontSize: 13)),
            ),
        ],
      ),
    );
  }
}
