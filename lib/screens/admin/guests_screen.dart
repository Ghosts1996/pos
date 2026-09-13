import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../services/guest_link_service.dart';
import '../../theme/app_colors.dart';

/// Справочник гостей «Колибри Лаундж» для администратора: уровень
/// лояльности, кешбэк, число визитов, сумма трат и бонусный баланс —
/// плюс смена номера телефона, если гость его поменял (не только с экрана
/// оплаты, но в любой момент, без открытого чека).
class GuestsScreen extends StatefulWidget {
  const GuestsScreen({super.key});

  @override
  State<GuestsScreen> createState() => _GuestsScreenState();
}

class _GuestsScreenState extends State<GuestsScreen> {
  final _link = GuestLinkService();
  final _search = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Color _tierColor(String tier) {
    switch (tier) {
      case 'Алмаз':
        return const Color(0xFFB388FF);
      case 'Платина':
        return const Color(0xFFAEEFE6);
      case 'Золото':
        return const Color(0xFFE0B354);
      case 'Серебро':
        return const Color(0xFFB4C4CC);
      default:
        return const Color(0xFFCD7F32); // Бронза
    }
  }

  Future<void> _changePhone(ClientProfile profile) async {
    final ctrl = TextEditingController(text: profile.phone);
    final newPhone = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Новый номер · ${profile.name.isEmpty ? 'Гость' : profile.name}'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          keyboardType: TextInputType.phone,
          decoration: const InputDecoration(labelText: 'Телефон'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: const Text('Сохранить'),
          ),
        ],
      ),
    );
    if (newPhone == null || newPhone.isEmpty || newPhone == profile.phone) return;
    await _link.updateProfile(profile.uid, {'phone': newPhone});
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Номер обновлён: $newPhone')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Гости')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: TextField(
              controller: _search,
              onChanged: (v) => setState(() => _query = v.trim().toLowerCase()),
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Поиск по имени или телефону',
                isDense: true,
              ),
            ),
          ),
          Expanded(
            child: StreamBuilder<List<ClientProfile>>(
              stream: _link.allClientsStream(),
              builder: (context, snap) {
                if (!snap.hasData) {
                  return const Center(child: CircularProgressIndicator());
                }
                var guests = snap.data!;
                if (_query.isNotEmpty) {
                  guests = guests
                      .where((g) =>
                          g.name.toLowerCase().contains(_query) ||
                          g.phone.toLowerCase().contains(_query))
                      .toList();
                }
                if (guests.isEmpty) {
                  return const Center(child: Text('Гостей не найдено'));
                }
                return ListView.separated(
                  itemCount: guests.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, i) {
                    final g = guests[i];
                    final tierColor = _tierColor(g.tier);
                    return ListTile(
                      leading: CircleAvatar(
                        backgroundColor: tierColor.withValues(alpha: 0.2),
                        child: Icon(Icons.person, color: tierColor),
                      ),
                      title: Text(g.name.isEmpty ? 'Гость' : g.name),
                      subtitle: Text(
                        '${g.phone.isEmpty ? 'без телефона' : g.phone} · '
                        'уровень «${g.tier}» (${g.cashbackPercent.toStringAsFixed(0)}% кешбэк)\n'
                        'Визитов: ${g.visits} · потрачено ${g.totalSpent.toStringAsFixed(0)} ₽ · '
                        'бонусов ${g.bonusBalance.toStringAsFixed(0)} ₽',
                      ),
                      isThreeLine: true,
                      trailing: IconButton(
                        icon: const Icon(Icons.edit_outlined),
                        tooltip: 'Сменить номер',
                        onPressed: () => _changePhone(g),
                      ),
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
      backgroundColor: AppColors.background,
    );
  }
}
