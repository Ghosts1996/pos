import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../models/employee.dart';
import '../../models/venue_models.dart';
import '../../services/gift_card_service.dart';
import '../../theme/app_colors.dart';

/// Подарочные сертификаты: выпуск, проверка баланса, деактивация.
///
/// Код печатается на карточке или диктуется по телефону — алфавит подобран
/// так, чтобы «О» и «0» не путались.
class GiftCardsScreen extends StatefulWidget {
  final Employee employee;
  const GiftCardsScreen({super.key, required this.employee});

  @override
  State<GiftCardsScreen> createState() => _GiftCardsScreenState();
}

class _GiftCardsScreenState extends State<GiftCardsScreen> {
  final _service = GiftCardService.instance;
  final _search = TextEditingController();
  GiftCard? _found;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

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
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _search,
                    textCapitalization: TextCapitalization.characters,
                    decoration: const InputDecoration(
                      labelText: 'Проверить код',
                      hintText: 'KLB-XXXX-XXXX',
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                OutlinedButton(
                  style: OutlinedButton.styleFrom(minimumSize: const Size(0, 44)),
                  onPressed: () async {
                    final messenger = ScaffoldMessenger.of(context);
                    final card = await _service.find(_search.text);
                    if (!mounted) return;
                    setState(() => _found = card);
                    if (card == null) {
                      messenger.showSnackBar(
                        const SnackBar(content: Text('Сертификат не найден')),
                      );
                    }
                  },
                  child: const Text('Найти'),
                ),
              ],
            ),
          ),
          if (_found != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: AppColors.selection,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  '${_found!.code}: остаток ${_found!.balance.toStringAsFixed(0)} ₽ '
                  'из ${_found!.faceValue.toStringAsFixed(0)} ₽'
                  '${_usesLabel(_found!)}'
                  '${_found!.isUsable ? '' : ' · неактивен'}',
                  style: const TextStyle(color: AppColors.textPrimary),
                ),
              ),
            ),
          const SizedBox(height: 8),
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
                  itemBuilder: (_, i) {
                    final c = cards[i];
                    return ListTile(
                      leading: Icon(Icons.card_giftcard,
                          color: c.isUsable ? AppColors.success : AppColors.disabled),
                      title: Text(c.code, style: const TextStyle(color: AppColors.textPrimary)),
                      subtitle: Text(
                        'Остаток ${c.balance.toStringAsFixed(0)} из ${c.faceValue.toStringAsFixed(0)} ₽'
                        '${_usesLabel(c)}'
                        '${c.issuedTo.isEmpty ? '' : ' · ${c.issuedTo}'}',
                        style: const TextStyle(fontSize: 12),
                      ),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          IconButton(
                            tooltip: 'Скопировать код',
                            icon: const Icon(Icons.copy, size: 18),
                            onPressed: () {
                              Clipboard.setData(ClipboardData(text: c.code));
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(content: Text('Код скопирован')),
                              );
                            },
                          ),
                          IconButton(
                            tooltip: 'Деактивировать',
                            icon: const Icon(Icons.block, size: 18, color: AppColors.danger),
                            onPressed: () => _service.deactivate(c.code),
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
    );
  }

  /// «· осталось 2 из 3 списаний» — или ничего, если лимита нет.
  String _usesLabel(GiftCard c) {
    final left = c.usesLeft;
    if (left == null) return '';
    return ' · осталось $left из ${c.maxUses} ${_uses(c.maxUses)}';
  }

  String _uses(int n) {
    final last = n % 10;
    final teen = n % 100 >= 11 && n % 100 <= 14;
    if (!teen && last == 1) return 'списания';
    return 'списаний';
  }

  Future<void> _issue() async {
    final amount = TextEditingController(text: '3000');
    final to = TextEditingController();
    final uses = TextEditingController(text: '1');

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Выпустить сертификат'),
        // Три поля с подсказками не помещаются в диалог на невысоком
        // экране — особенно когда снизу выезжает клавиатура.
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: amount,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Номинал, ₽'),
              ),
              TextField(
                controller: uses,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'Сколько раз можно расплатиться',
                  helperText: '0 — без ограничения, пока не кончится сумма',
                  helperMaxLines: 2,
                ),
              ),
              TextField(
                controller: to,
                decoration: const InputDecoration(labelText: 'Кому (необязательно)'),
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
    if (value <= 0) return;

    final card = await _service.issue(
      faceValue: value,
      issuedTo: to.text.trim(),
      issuedBy: widget.employee.name,
      maxUses: int.tryParse(uses.text.trim()) ?? 0,
    );
    if (!mounted) return;

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Сертификат выпущен'),
        content: SelectableText(
          '${card.code}\nНоминал ${card.faceValue.toStringAsFixed(0)} ₽\n'
          '${card.maxUses > 0 ? 'Расплатиться можно ${card.maxUses} ${_uses(card.maxUses)}\n' : 'Списаний сколько угодно, пока не кончится сумма\n'}'
          'Действует до ${card.expiresAt?.day}.${card.expiresAt?.month}.${card.expiresAt?.year}',
          style: const TextStyle(fontSize: 18),
        ),
        actions: [
          TextButton(
            onPressed: () {
              Clipboard.setData(ClipboardData(text: card.code));
              Navigator.pop(ctx);
            },
            child: const Text('Скопировать'),
          ),
          FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Готово')),
        ],
      ),
    );
  }
}
