import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../services/guest_link_service.dart';
import '../services/kolibri_auth_service.dart';
import '../theme/kolibri_theme.dart';
import 'kolibri_extras_screen.dart';

/// Профиль гостя: имя, телефон, бонусы, история операций, вход по SMS.
class KolibriProfileScreen extends StatefulWidget {
  final ClientProfile? profile;
  const KolibriProfileScreen({super.key, required this.profile});

  @override
  State<KolibriProfileScreen> createState() => _KolibriProfileScreenState();
}

class _KolibriProfileScreenState extends State<KolibriProfileScreen> {
  final _auth = KolibriAuthService();
  final _link = GuestLinkService();
  final _name = TextEditingController();
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _name.text = widget.profile?.name ?? '';
  }

  @override
  void didUpdateWidget(covariant KolibriProfileScreen old) {
    super.didUpdateWidget(old);
    if (_name.text.isEmpty && (widget.profile?.name ?? '').isNotEmpty) {
      _name.text = widget.profile!.name;
    }
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.profile;

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 120),
      children: [
        const Text('Профиль', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
        const SizedBox(height: 20),

        // ---- Карта лояльности ----
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: KolibriColors.gold.withValues(alpha: 0.4)),
            gradient: const LinearGradient(
              colors: [KolibriColors.surfaceElevated, KolibriColors.surface],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Уровень «${p?.tier ?? 'Гость'}»',
                  style: const TextStyle(color: KolibriColors.gold, fontWeight: FontWeight.w600)),
              const SizedBox(height: 10),
              Text('${(p?.bonusBalance ?? 0).toStringAsFixed(0)} бонусов',
                  style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w700)),
              const SizedBox(height: 6),
              Text(
                'Визитов: ${p?.visits ?? 0} · кешбэк ${(p?.cashbackPercent ?? 3).toStringAsFixed(0)}%',
                style: const TextStyle(color: KolibriColors.textMuted, fontSize: 13),
              ),
              if ((p?.discountPercent ?? 0) > 0)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text('Дисконтная карта: −${p!.discountPercent.toStringAsFixed(0)}%',
                      style: const TextStyle(color: KolibriColors.gold, fontSize: 13)),
                ),
            ],
          ),
        ),

        const SizedBox(height: 24),
        TextField(
          controller: _name,
          decoration: const InputDecoration(labelText: 'Как к вам обращаться'),
        ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: _saving
              ? null
              : () async {
                  setState(() => _saving = true);
                  await _link.updateProfile(_auth.uid, {'name': _name.text.trim()});
                  if (mounted) {
                    setState(() => _saving = false);
                    ScaffoldMessenger.of(context)
                        .showSnackBar(const SnackBar(content: Text('Сохранено')));
                  }
                },
          child: const Text('Сохранить'),
        ),

        const SizedBox(height: 24),
        if (_auth.isAnonymous)
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
                const Text('Войдите по номеру телефона',
                    style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                const Text(
                  'Бонусы и история визитов сохранятся на всех ваших устройствах.',
                  style: TextStyle(color: KolibriColors.textMuted, fontSize: 13),
                ),
                const SizedBox(height: 14),
                FilledButton.icon(
                  onPressed: () => _phoneLogin(context),
                  icon: const Icon(Icons.sms),
                  label: const Text('Войти по SMS'),
                ),
              ],
            ),
          )
        else
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.verified_user, color: KolibriColors.success),
            title: Text(p?.phone ?? ''),
            subtitle: const Text('Телефон подтверждён'),
            trailing: TextButton(
              onPressed: () async {
                await _auth.signOut();
                await _auth.ensureGuest();
                if (mounted) setState(() {});
              },
              child: const Text('Выйти'),
            ),
          ),

        const SizedBox(height: 24),
        OutlinedButton.icon(
          onPressed: () => Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => Scaffold(
                appBar: AppBar(title: const Text('Ещё')),
                body: KolibriExtrasScreen(profile: widget.profile),
              ),
            ),
          ),
          icon: const Icon(Icons.more_horiz),
          label: const Text('Чаевые, сертификат, очередь, пригласить друга'),
        ),

        const SizedBox(height: 28),
        const Text('История бонусов',
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        const SizedBox(height: 12),
        StreamBuilder<QuerySnapshot>(
          stream: FirebaseFirestore.instance
              .collection('bonusOperations')
              .where('clientUid', isEqualTo: _auth.uid)
              .orderBy('createdAt', descending: true)
              .limit(30)
              .snapshots(),
          builder: (context, snap) {
            if (!snap.hasData) return const LinearProgressIndicator();
            final docs = snap.data!.docs;
            if (docs.isEmpty) {
              return const Text('Операций пока нет',
                  style: TextStyle(color: KolibriColors.textMuted));
            }
            return Column(
              children: docs.map((d) {
                final data = d.data() as Map<String, dynamic>;
                final accrual = data['type'] == 'accrual';
                final amount = (data['amount'] ?? 0).toDouble();
                final ts = data['createdAt'];
                final date = ts is Timestamp ? ts.toDate() : DateTime.now();
                return ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(
                    accrual ? Icons.add_circle_outline : Icons.remove_circle_outline,
                    color: accrual ? KolibriColors.success : KolibriColors.warning,
                  ),
                  title: Text(accrual ? 'Начисление за визит' : 'Списание бонусов'),
                  subtitle: Text(
                    '${date.day.toString().padLeft(2, '0')}.'
                    '${date.month.toString().padLeft(2, '0')}.${date.year}',
                    style: const TextStyle(fontSize: 12),
                  ),
                  trailing: Text('${amount.toStringAsFixed(0)} ₽'),
                );
              }).toList(),
            );
          },
        ),

        const SizedBox(height: 32),
        const Text(
          'Колибри Лаундж · приложение гостя',
          textAlign: TextAlign.center,
          style: TextStyle(color: KolibriColors.textMuted, fontSize: 12),
        ),
      ],
    );
  }

  /// Вход по SMS: номер → код. Firebase Phone Auth должен быть включён
  /// в консоли Firebase (Authentication → Sign-in method → Phone).
  Future<void> _phoneLogin(BuildContext context) async {
    final phoneCtrl = TextEditingController(text: '+7');
    final codeCtrl = TextEditingController();
    String? verificationId;
    String? error;

    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: KolibriColors.surface,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => Padding(
          padding: EdgeInsets.only(
            left: 20,
            right: 20,
            top: 24,
            bottom: MediaQuery.of(ctx).viewInsets.bottom + 24,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(verificationId == null ? 'Ваш номер' : 'Код из SMS',
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
              const SizedBox(height: 16),
              if (verificationId == null)
                TextField(
                  controller: phoneCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'Телефон'),
                )
              else
                TextField(
                  controller: codeCtrl,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Код из SMS'),
                ),
              if (error != null) ...[
                const SizedBox(height: 10),
                Text(error!, style: const TextStyle(color: KolibriColors.danger, fontSize: 13)),
              ],
              const SizedBox(height: 20),
              FilledButton(
                onPressed: () async {
                  if (verificationId == null) {
                    await _auth.startPhoneSignIn(
                      phone: phoneCtrl.text.trim(),
                      onCodeSent: (id) => setLocal(() {
                        verificationId = id;
                        error = null;
                      }),
                      onError: (e) => setLocal(() => error = e),
                      onAutoVerified: () => Navigator.pop(ctx),
                    );
                  } else {
                    try {
                      await _auth.confirmPhoneCode(
                        verificationId: verificationId!,
                        smsCode: codeCtrl.text.trim(),
                        phone: phoneCtrl.text.trim(),
                        name: _name.text.trim(),
                      );
                      if (ctx.mounted) Navigator.pop(ctx);
                    } catch (e) {
                      setLocal(() => error = 'Неверный код');
                    }
                  }
                },
                child: Text(verificationId == null ? 'Получить код' : 'Подтвердить'),
              ),
            ],
          ),
        ),
      ),
    );
    if (mounted) setState(() {});
  }
}
