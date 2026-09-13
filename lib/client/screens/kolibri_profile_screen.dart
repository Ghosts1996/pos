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
  final _phone = TextEditingController();

  /// Номер уже привязан — редактировать его гость не может.
  bool get _phoneLocked => (widget.profile?.phone ?? '').isNotEmpty;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _name.text = widget.profile?.name ?? '';
    _phone.text = widget.profile?.phone ?? '';
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
        // Номер вводится один раз и дальше не редактируется: к нему
        // привязаны бонусы, и подмена номера означала бы доступ к чужому
        // счёту. Сменить его может только администратор на кассе.
        TextField(
          controller: _phone,
          keyboardType: TextInputType.phone,
          readOnly: _phoneLocked,
          decoration: InputDecoration(
            labelText: 'Телефон',
            helperText: _phoneLocked
                ? 'Сменить номер можно только через администратора'
                : 'Указывается один раз — по нему кальянщик найдёт ваши бонусы',
            suffixIcon: _phoneLocked
                ? const Icon(Icons.lock_outline, size: 18, color: KolibriColors.textMuted)
                : null,
          ),
          onTap: _phoneLocked
              ? () => ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text('Номер уже привязан. Попросите администратора '
                          'изменить его на кассе.'),
                    ),
                  )
              : null,
        ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: _saving
              ? null
              : () async {
                  final phone = _phone.text.trim();
                  setState(() => _saving = true);

                  // Телефон отправляем только пока он не зафиксирован —
                  // иначе правила базы всё равно отклонят изменение.
                  await _link.updateProfile(_auth.uid, {
                    'name': _name.text.trim(),
                    if (!_phoneLocked && phone.isNotEmpty) 'phone': phone,
                  });

                  if (mounted) {
                    setState(() => _saving = false);
                    ScaffoldMessenger.of(context)
                        .showSnackBar(const SnackBar(content: Text('Сохранено')));
                  }
                },
          child: const Text('Сохранить'),
        ),

        const SizedBox(height: 20),
        // Телефонный вход по SMS намеренно не используется: он требует
        // платного тарифа Firebase. Гость работает на анонимном входе, а
        // узнаётся по номеру, который называет кассиру при оплате.
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: KolibriColors.surface,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: KolibriColors.border),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.info_outline, color: KolibriColors.gold, size: 20),
              const SizedBox(width: 12),
              const Expanded(
                child: Text(
                  'Бонусы копятся на этом устройстве и находятся по вашему номеру '
                  'на кассе. Сменили телефон — назовите номер кальянщику, и мы '
                  'перенесём историю визитов.',
                  style: TextStyle(color: KolibriColors.textMuted, fontSize: 13),
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
          // orderBy вместе с where требует составного индекса Firestore —
          // без него запрос падал, и история «вечно грузилась». Сортируем
          // на устройстве: операций у одного гостя всегда немного.
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
