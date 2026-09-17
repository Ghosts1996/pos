import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../services/guest_link_service.dart';
import '../../theme/app_colors.dart';

/// Справочник гостей «Colibri Lounge» для администратора: уровень
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

  Future<void> _deleteGuest(ClientProfile profile) async {
    final name = profile.name.isEmpty ? 'Гость' : profile.name;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Удалить «$name»?'),
        content: Text(
          'Профиль, номер телефона и история визитов гостя будут удалены '
          'безвозвратно.${profile.bonusBalance > 0 ? '\n\nНа счету ещё '
              '${profile.bonusBalance.toStringAsFixed(0)} ₽ бонусов — они '
              'сгорят вместе с профилем.' : ''}'
          '${profile.activeSessionId.isNotEmpty ? '\n\nВНИМАНИЕ: гость сейчас '
              'сидит за столом — удаление профиля не закроет его чек, но '
              'отвяжет гостя от него в приложении.' : ''}\n\n'
          'Брони, чеки и отзывы гостя останутся в отчётах заведения.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Удалить'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await _link.deleteClient(profile.uid);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Гость «$name» удалён')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось удалить: $e')));
      }
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

  /// Гость пришёл с нового устройства и назвал номер, на который уже
  /// заведён профиль (приложение само не даст ему сохранить занятый
  /// номер и покажет «ID устройства» — его и нужно ввести сюда). Переносит
  /// бонусы, визиты, сумму трат и историю операций со старого профиля на
  /// новое устройство и удаляет дубль.
  Future<void> _mergeDevices() async {
    final phoneCtrl = TextEditingController();
    final uidCtrl = TextEditingController();
    final result = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Объединить с новым устройством'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Гость называет свой номер телефона и показывает «ID устройства» '
              'из профиля на новом телефоне.',
              style: TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: phoneCtrl,
              autofocus: true,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(labelText: 'Номер телефона гостя'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: uidCtrl,
              decoration: const InputDecoration(labelText: 'ID устройства (с нового телефона)'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Объединить'),
          ),
        ],
      ),
    );
    if (result != true) return;
    final phone = phoneCtrl.text.trim();
    final uid = uidCtrl.text.trim();
    if (phone.isEmpty || uid.isEmpty) return;

    try {
      await _link.mergeGuestProfiles(phone: phone, newDeviceInput: uid);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Готово — бонусы и история перенесены')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось объединить: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Гости'),
        actions: [
          IconButton(
            icon: const Icon(Icons.merge_type),
            tooltip: 'Объединить с новым устройством',
            onPressed: _mergeDevices,
          ),
        ],
      ),
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
                      trailing: PopupMenuButton<String>(
                        icon: const Icon(Icons.more_vert),
                        onSelected: (v) {
                          if (v == 'phone') _changePhone(g);
                          if (v == 'delete') _deleteGuest(g);
                        },
                        itemBuilder: (_) => const [
                          PopupMenuItem(
                            value: 'phone',
                            child: ListTile(
                              leading: Icon(Icons.edit_outlined),
                              title: Text('Сменить номер'),
                              contentPadding: EdgeInsets.zero,
                            ),
                          ),
                          PopupMenuItem(
                            value: 'delete',
                            child: ListTile(
                              leading: Icon(Icons.delete_outline, color: AppColors.danger),
                              title: Text('Удалить гостя', style: TextStyle(color: AppColors.danger)),
                              contentPadding: EdgeInsets.zero,
                            ),
                          ),
                        ],
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
