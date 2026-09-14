import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../models/employee.dart';
import '../../models/venue_models.dart';
import '../../services/gift_card_service.dart';
import '../../theme/app_colors.dart';

/// Подарочные сертификаты — коды на бонусы.
///
/// Как это работает. Админ выпускает код на сумму и на число активаций,
/// постит его в Telegram-канале, а гости вводят код у себя в приложении.
/// Каждому успевшему на бонусный счёт падает вся указанная сумма: код
/// «1000 бонусов, 3 активации» — это тысяча троим, а не тысяча на всех.
/// Когда активации кончились, остальным приходит отказ.
///
/// Алфавит кода подобран так, чтобы «О» и «0» не путались: код диктуют
/// вслух и переписывают из поста руками.
class GiftCardsScreen extends StatefulWidget {
  final Employee employee;
  const GiftCardsScreen({super.key, required this.employee});

  @override
  State<GiftCardsScreen> createState() => _GiftCardsScreenState();
}

class _GiftCardsScreenState extends State<GiftCardsScreen> {
  final _service = GiftCardService.instance;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Сертификаты')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _issue,
        icon: const Icon(Icons.add_card),
        label: const Text('Выпустить'),
      ),
      body: Column(
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: Text(
              'Выпустите код, опубликуйте его в канале — и гости активируют '
              'его в приложении. Каждому успевшему начисляется вся сумма.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 13),
            ),
          ),
          Expanded(
            child: StreamBuilder<List<GiftCard>>(
              stream: _service.activeCardsStream(),
              builder: (context, snap) {
                if (!snap.hasData) return const Center(child: CircularProgressIndicator());
                final cards = snap.data!;
                if (cards.isEmpty) {
                  return const Center(
                    child: Text('Сертификатов нет',
                        style: TextStyle(color: AppColors.textMuted)),
                  );
                }
                return ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: cards.length,
                  itemBuilder: (_, i) => _cardTile(cards[i]),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _cardTile(GiftCard c) {
    final left = c.usesLeft;
    return ListTile(
      leading: Icon(Icons.card_giftcard,
          color: c.isUsable ? AppColors.success : AppColors.disabled),
      title: Text(c.code,
          style: const TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w600)),
      subtitle: Text(
        '${c.bonusAmount.toStringAsFixed(0)} бонусов каждому · '
        '${left == null
            ? 'активаций без ограничения, использовано ${c.usedCount}'
            : 'активировали ${c.usedCount} из ${c.maxUses}, осталось $left'}'
        '${c.problem == null ? '' : ' · ${c.problem}'}'
        '${c.comment.isEmpty ? '' : '\n${c.comment}'}',
        style: const TextStyle(fontSize: 12),
      ),
      isThreeLine: c.comment.isNotEmpty,
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            tooltip: 'Скопировать код',
            icon: const Icon(Icons.copy, size: 18),
            onPressed: () {
              Clipboard.setData(ClipboardData(text: c.code));
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Код скопирован — можно вставлять в пост')),
              );
            },
          ),
          IconButton(
            tooltip: 'Остановить',
            icon: const Icon(Icons.block, size: 18, color: AppColors.danger),
            onPressed: () => _confirmStop(c),
          ),
        ],
      ),
    );
  }

  Future<void> _confirmStop(GiftCard c) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Остановить сертификат?'),
        content: Text('Код ${c.code} перестанет активироваться. '
            'Уже начисленные бонусы у гостей останутся.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Остановить')),
        ],
      ),
    );
    if (ok == true) await _service.deactivate(c.code);
  }

  Future<void> _issue() async {
    final amount = TextEditingController(text: '500');
    final uses = TextEditingController(text: '3');
    final days = TextEditingController(text: '30');
    final comment = TextEditingController();

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Выпустить сертификат'),
        // Четыре поля с подсказками не помещаются в диалог на невысоком
        // экране — особенно когда снизу выезжает клавиатура.
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: amount,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'Бонусов каждому',
                  helperText: 'Столько получит на счёт каждый успевший гость',
                  helperMaxLines: 2,
                ),
              ),
              TextField(
                controller: uses,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'Сколько человек успеет',
                  helperText: '0 — без ограничения',
                ),
              ),
              TextField(
                controller: days,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'Действует дней',
                  helperText: '0 — без срока',
                ),
              ),
              TextField(
                controller: comment,
                decoration: const InputDecoration(
                  labelText: 'Заметка (необязательно)',
                  hintText: 'Пост в ТГ на выходные',
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Выпустить')),
        ],
      ),
    );
    if (ok != true) return;

    final value = double.tryParse(amount.text.replaceAll(',', '.')) ?? 0;
    if (value <= 0) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Укажите, сколько бонусов начислять')),
      );
      return;
    }

    final card = await _service.issue(
      bonusAmount: value,
      maxUses: int.tryParse(uses.text.trim()) ?? 0,
      validDays: int.tryParse(days.text.trim()) ?? 0,
      comment: comment.text.trim(),
      issuedBy: widget.employee.name,
    );
    if (!mounted) return;
    _showIssued(card);
  }

  void _showIssued(GiftCard card) {
    // Готовый текст для поста: чтобы не собирать его вручную каждый раз.
    final post = 'Промокод: ${card.code}\n'
        '${card.bonusAmount.toStringAsFixed(0)} бонусов на счёт'
        '${card.maxUses > 0 ? ' — первым ${card.maxUses}' : ''}.\n'
        'Введите код в приложении Colibri Lounge: Профиль → Ещё → Сертификат.';

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Сертификат выпущен'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SelectableText(card.code,
                  style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
              const SizedBox(height: 12),
              SelectableText(post,
                  style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () {
              Clipboard.setData(ClipboardData(text: post));
              Navigator.pop(ctx);
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Текст поста скопирован')),
              );
            },
            child: const Text('Скопировать пост'),
          ),
          FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Готово')),
        ],
      ),
    );
  }
}
