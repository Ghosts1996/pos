import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../models/client_models.dart';
import '../../services/guest_link_service.dart';
import '../../utils/phone_utils.dart';
import '../services/kolibri_auth_service.dart';
import '../theme/kolibri_theme.dart';
import 'kolibri_extras_screen.dart';

/// Профиль гостя: имя, телефон, бонусы, история операций.
///
/// Бесплатный вариант без SMS-подтверждения (Firebase Phone Auth требует
/// платный тариф Blaze). Поэтому: один номер — один профиль на уровне
/// приложения (нельзя сохранить номер, уже занятый другим устройством),
/// а перенос истории с одного устройства на другое делает кальянщик на
/// кассе в один клик — гость называет номер и показывает свой «ID
/// устройства» с этого экрана.
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
  final _phone = TextEditingController();

  String _shortDeviceId = '…';

  /// Номер уже привязан — редактировать его гость не может.
  bool get _phoneLocked => (widget.profile?.phone ?? '').isNotEmpty;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _name.text = widget.profile?.name ?? '';
    _phone.text = widget.profile?.phone ?? '';
    _initShortId();
  }

  Future<void> _initShortId() async {
    final id = await _auth.getShortDeviceId();
    if (mounted) setState(() => _shortDeviceId = id);
    // Записываем shortDeviceId в Firestore при каждом открытии профиля —
    // кассир сможет найти устройство по 6-значному коду сразу.
    if (_auth.uid.isNotEmpty) {
      await _link.updateProfile(_auth.uid, {'shortDeviceId': id});
    }
  }

  @override
  void didUpdateWidget(covariant KolibriProfileScreen old) {
    super.didUpdateWidget(old);
    if (_name.text.isEmpty && (widget.profile?.name ?? '').isNotEmpty) {
      _name.text = widget.profile!.name;
    }
    if (_phone.text.isEmpty && (widget.profile?.phone ?? '').isNotEmpty) {
      _phone.text = widget.profile!.phone;
    }
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _save() async {
    final rawPhone = _phone.text.trim();
    final phone = rawPhone.isNotEmpty ? normalizePhone(rawPhone) : '';
    setState(() => _saving = true);

    // Номер новый (ещё не был занят этим профилем) — проверяем, не занят
    // ли он уже ДРУГИМ устройством, прежде чем сохранять.
    if (!_phoneLocked && phone.isNotEmpty) {
      if (!isValidRuPhone(phone)) {
        setState(() => _saving = false);
        _snack('Введите корректный номер (например, 79995061580)');
        return;
      }

      final existing = await _link.findByPhone(phone);
      if (existing != null && existing.uid != _auth.uid) {
        setState(() => _saving = false);
        if (mounted) {
          await showDialog(
            context: context,
            builder: (_) => AlertDialog(
              title: const Text('Номер уже зарегистрирован'),
              content: Text(
                'На этот номер уже есть профиль с ${existing.bonusBalance.toStringAsFixed(0)} '
                'бонусами. Чтобы они появились на этом устройстве, покажите кальянщику '
                'этот номер и «ID устройства» ниже — он объединит профили на кассе за пару секунд.',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Понятно'),
                ),
              ],
            ),
          );
        }
        return;
      }
    }

    await _link.updateProfile(_auth.uid, {
      'name': _name.text.trim(),
      if (!_phoneLocked && phone.isNotEmpty) 'phone': phone,
    });

    if (mounted) {
      setState(() => _saving = false);
      _snack('Сохранено');
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.profile;
    final tier = p?.tier ?? 'Бронза';
    final tierColor = KolibriColors.tierColor(tier);

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
            border: Border.all(color: tierColor.withValues(alpha: 0.5)),
            gradient: LinearGradient(
              colors: [tierColor.withValues(alpha: 0.16), KolibriColors.surface],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Уровень «$tier»',
                  style: TextStyle(color: tierColor, fontWeight: FontWeight.w600)),
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
                      style: TextStyle(color: tierColor, fontSize: 13)),
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
        TextField(
          controller: _phone,
          keyboardType: TextInputType.phone,
          readOnly: _phoneLocked,
          decoration: InputDecoration(
            labelText: 'Телефон',
            helperText: _phoneLocked
                ? 'Сменить номер можно только через администратора'
                : 'Укажите номер в любом формате: +7, 8 или просто 9...',
            suffixIcon: _phoneLocked
                ? const Icon(Icons.lock_outline, size: 18, color: KolibriColors.textMuted)
                : null,
          ),
          onTap: _phoneLocked
              ? () => _snack('Номер уже привязан. Попросите администратора '
                  'изменить его на кассе.')
              : null,
        ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: Text(_saving ? 'Сохраняем…' : 'Сохранить'),
        ),

        const SizedBox(height: 20),
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: KolibriColors.surface,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: KolibriColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.info_outline, color: KolibriColors.gold, size: 20),
                  SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'Бонусы копятся на этом устройстве и находятся по вашему номеру '
                      'на кассе. Сменили телефон — назовите номер и покажите ID '
                      'устройства ниже кальянщику, и мы перенесём историю визитов.',
                      style: TextStyle(color: KolibriColors.textMuted, fontSize: 13),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              // Короткий ID устройства — 6 символов, легко продиктовать
              InkWell(
                borderRadius: BorderRadius.circular(10),
                onTap: () async {
                  await Clipboard.setData(ClipboardData(text: _shortDeviceId));
                  _snack('ID устройства скопирован');
                },
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(
                    color: Colors.black26,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.badge_outlined, size: 16, color: KolibriColors.textMuted),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'ID устройства: $_shortDeviceId',
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w700,
                            color: KolibriColors.textMuted,
                            letterSpacing: 2,
                          ),
                        ),
                      ),
                      const Icon(Icons.copy, size: 14, color: KolibriColors.textMuted),
                    ],
                  ),
                ),
              ),
            ],
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
              .limit(50)
              .snapshots(),
          builder: (context, snap) {
            if (snap.hasError) {
              return const Text('Не удалось загрузить историю',
                  style: TextStyle(color: KolibriColors.textMuted));
            }
            if (!snap.hasData) return const LinearProgressIndicator();

            final docs = snap.data!.docs.toList()
              ..sort((a, b) {
                final x = (a.data() as Map<String, dynamic>)['createdAt'];
                final y = (b.data() as Map<String, dynamic>)['createdAt'];
                if (x is! Timestamp || y is! Timestamp) return 0;
                return y.compareTo(x);
              });
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
}
