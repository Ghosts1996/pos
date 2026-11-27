import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../services/guest_link_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/human_error.dart';
import '../../utils/money.dart';
import '../../utils/phone_utils.dart';
import '../../utils/adaptive.dart';
import '../../build_info.dart';

/// Справочник гостей приложения для администратора: уровень
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
  // Одна подписка на экран — поиск делает setState на каждую букву.
  late final Stream<List<ClientProfile>> _clients = _link.allClientsStream();
  String _query = '';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  /// Цвет уровня; в светлой теме — темнее, чтобы значок читался на бумаге.
  Color _tierColor(String tier) {
    final c = _tierTone(tier);
    return AppColors.isLight ? Color.lerp(c, Colors.black, 0.42)! : c;
  }

  Color _tierTone(String tier) {
    switch (tier) {
      case 'Алмаз':
        return const Color(0xFFA9C3DA);
      case 'Платина':
        return const Color(0xFFDAD4C8);
      case 'Золото':
        return const Color(0xFFCFA567);
      case 'Серебро':
        return const Color(0xFFB7B9BD);
      default:
        return const Color(0xFFC08552); // Бронза
    }
  }

  Future<void> _deleteGuest(ClientProfile profile) async {
    final name = profile.name.isEmpty ? 'Гость' : profile.name;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        scrollable: true,
        title: Text('Удалить «$name»?'),
        content: Text(
          'Профиль, номер телефона и история визитов гостя будут удалены '
          'безвозвратно.${profile.bonusBalance > 0 ? '\n\nНа счету ещё '
              '${rub(profile.bonusBalance)} бонусов — они '
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
            .showSnackBar(SnackBar(content: Text('Не удалось удалить: ${humanError(e, lower: true)}')));
      }
    }
  }

  /// Начислить или списать бонусы вручную (SaaS): за жалобу, акцию,
  /// ошибку кассира. Причина попадает в историю бонусов гостя.
  Future<void> _adjustBonuses(ClientProfile profile) async {
    final res = await showDialog<_BonusAdjust>(
      context: context,
      builder: (ctx) => _BonusAdjustDialog(profile: profile),
    );
    if (res == null || !mounted) return;
    void say(String text) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
    try {
      final applied = await _link.adjustBonuses(
        clientUid: profile.uid,
        delta: res.add ? res.amount : -res.amount,
        note: res.note,
      );
      if (!mounted) return;
      if (applied == 0) return say('Бонусы не изменились: на счёте гостя 0');
      say(applied > 0
          ? 'Начислено ${applied.round()} бонусов'
          : 'Списано ${(-applied).round()} бонусов${-applied < res.amount ? ' (больше на счёте не было)' : ''}');
    } catch (e) {
      if (mounted) say('Не удалось изменить бонусы: ${humanError(e, lower: true)}');
    }
  }

  Future<void> _changePhone(ClientProfile profile) async {
    final ctrl = TextEditingController(text: profile.phone);
    final newPhone = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        scrollable: true,
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
    if (newPhone == null || newPhone.isEmpty || !mounted) return;
    void say(String text) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
    final problem = phoneProblem(newPhone);
    if (problem != null) return say(problem);
    final normalized = normalizePhone(newPhone);
    if (normalized == normalizePhone(profile.phone)) return;
    try {
      if (await _link.isPhoneTakenByOther(normalized, profile.uid)) {
        if (mounted) {
          say('Этот номер уже у другого гостя. Если это тот же человек с нового телефона — '
              'нажмите «Объединить с новым устройством».');
        }
        return;
      }
      // Номер меняет персонал: справочник в РФ и профиль — от имени кассы.
      // registerGuestProfile — только для самого гостя (сервер сверяет uid).
      await _link.updateProfile(profile.uid, {'phone': normalized});
      if (mounted) say('Номер обновлён: +$normalized');
    } catch (e) {
      if (mounted) say('Не удалось сменить номер: ${humanError(e, lower: true)}');
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
        scrollable: true,
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
            .showSnackBar(SnackBar(content: Text('Не удалось объединить: ${humanError(e, lower: true)}')));
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
      body: CenteredBody(
        maxWidth: 760,
        child: Column(
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
                stream: _clients,
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
                          'Визитов: ${g.visits} · потрачено ${rub(g.totalSpent)} · '
                          'бонусов ${rub(g.bonusBalance)}',
                        ),
                        isThreeLine: true,
                        trailing: PopupMenuButton<String>(
                          icon: const Icon(Icons.more_vert),
                          onSelected: (v) {
                            if (v == 'phone') _changePhone(g);
                            if (v == 'bonus') _adjustBonuses(g);
                            if (v == 'delete') _deleteGuest(g);
                          },
                          itemBuilder: (_) => [
                            if (kSaasMode)
                              const PopupMenuItem(
                                value: 'bonus',
                                child: ListTile(
                                  leading: Icon(Icons.stars_outlined),
                                  title: Text('Начислить или списать бонусы'),
                                  contentPadding: EdgeInsets.zero,
                                ),
                              ),
                            const PopupMenuItem(
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
      ),
      backgroundColor: AppColors.background,
    );
  }
}

class _BonusAdjust {
  final bool add;
  final double amount;
  final String note;
  const _BonusAdjust(this.add, this.amount, this.note);
}

/// Окно «Бонусы гостя»: начислить / списать, сколько и за что.
class _BonusAdjustDialog extends StatefulWidget {
  final ClientProfile profile;
  const _BonusAdjustDialog({required this.profile});

  @override
  State<_BonusAdjustDialog> createState() => _BonusAdjustDialogState();
}

class _BonusAdjustDialogState extends State<_BonusAdjustDialog> {
  bool _add = true;
  final _amount = TextEditingController();
  final _note = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    _note.dispose();
    super.dispose();
  }

  void _submit() {
    final n = double.tryParse(_amount.text.trim().replaceAll(',', '.').replaceAll(' ', ''));
    if (n == null || n <= 0 || n != n.roundToDouble()) {
      setState(() => _error = 'Укажите целое число бонусов больше нуля');
      return;
    }
    if (n > 100000) {
      setState(() => _error = 'Не больше 100 000 за раз');
      return;
    }
    if (!_add && n > widget.profile.bonusBalance) {
      setState(() => _error = 'На счёте гостя ${widget.profile.bonusBalance.round()} бонусов');
      return;
    }
    Navigator.pop(context, _BonusAdjust(_add, n, _note.text));
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.profile;
    return AlertDialog(
      scrollable: true,
      title: Text('Бонусы · ${p.name.isEmpty ? 'Гость' : p.name}'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Сейчас на счёте: ${p.bonusBalance.round()} бонусов',
              style: TextStyle(color: AppColors.textMuted)),
          const SizedBox(height: 14),
          SegmentedButton<bool>(
            segments: const [
              ButtonSegment(value: true, label: Text('Начислить'), icon: Icon(Icons.add)),
              ButtonSegment(value: false, label: Text('Списать'), icon: Icon(Icons.remove)),
            ],
            selected: {_add},
            onSelectionChanged: (v) => setState(() {
              _add = v.first;
              _error = null;
            }),
          ),
          const SizedBox(height: 14),
          TextField(
            key: const Key('bonus-amount'),
            controller: _amount,
            autofocus: true,
            keyboardType: TextInputType.number,
            decoration: InputDecoration(labelText: 'Сколько бонусов', errorText: _error),
            onChanged: (_) {
              if (_error != null) setState(() => _error = null);
            },
          ),
          const SizedBox(height: 10),
          TextField(
            key: const Key('bonus-note'),
            controller: _note,
            maxLength: 120,
            decoration: const InputDecoration(
              labelText: 'За что (видно гостю в истории)',
              hintText: 'Например: извинение за ожидание',
            ),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
        FilledButton(onPressed: _submit, child: Text(_add ? 'Начислить' : 'Списать')),
      ],
    );
  }
}
