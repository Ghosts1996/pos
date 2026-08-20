import 'package:flutter/material.dart';
import '../../models/discount_card.dart';
import '../../services/firestore_service.dart';

class DiscountCardsScreen extends StatelessWidget {
  const DiscountCardsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final fs = FirestoreService();
    return Scaffold(
      appBar: AppBar(title: const Text('Скидочные карты')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _editCard(context, fs, null),
        child: const Icon(Icons.add),
      ),
      body: StreamBuilder<List<DiscountCard>>(
        stream: fs.discountCardsStream(),
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final cards = snap.data!;
          if (cards.isEmpty) return const Center(child: Text('Карт пока нет'));
          return ListView(
            children: cards
                .map((c) => ListTile(
                      leading: Icon(Icons.card_giftcard, color: c.active ? null : Colors.grey),
                      title: Text('${c.guestName} · №${c.cardNumber}',
                          style: TextStyle(color: c.active ? null : Colors.grey)),
                      subtitle: Text(
                          'Скидка ${c.discountPercent.toStringAsFixed(0)}% ${c.notes}'
                          '${c.active ? '' : ' · отключена'}'),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Switch(
                            value: c.active,
                            onChanged: (v) => fs.setDiscountCardActive(c.id, v),
                          ),
                          IconButton(
                            icon: const Icon(Icons.delete_outline),
                            onPressed: () async {
                              final confirm = await showDialog<bool>(
                                context: context,
                                builder: (ctx) => AlertDialog(
                                  title: const Text('Удалить карту?'),
                                  content: Text('Карта «${c.guestName} · №${c.cardNumber}» будет удалена.'),
                                  actions: [
                                    TextButton(
                                        onPressed: () => Navigator.pop(ctx, false),
                                        child: const Text('Отмена')),
                                    FilledButton(
                                      style: FilledButton.styleFrom(backgroundColor: Colors.red),
                                      onPressed: () => Navigator.pop(ctx, true),
                                      child: const Text('Удалить'),
                                    ),
                                  ],
                                ),
                              );
                              if (confirm == true) await fs.deleteDiscountCard(c.id);
                            },
                          ),
                        ],
                      ),
                      onTap: () => _editCard(context, fs, c),
                    ))
                .toList(),
          );
        },
      ),
    );
  }

  Future<void> _editCard(BuildContext context, FirestoreService fs, DiscountCard? card) async {
    final numberCtrl = TextEditingController(text: card?.cardNumber ?? '');
    final nameCtrl = TextEditingController(text: card?.guestName ?? '');
    final percentCtrl = TextEditingController(text: card?.discountPercent.toStringAsFixed(0) ?? '');
    final notesCtrl = TextEditingController(text: card?.notes ?? '');

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(card == null ? 'Новая карта' : 'Редактировать карту'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: numberCtrl, decoration: const InputDecoration(labelText: 'Номер карты')),
            TextField(controller: nameCtrl, decoration: const InputDecoration(labelText: 'Имя гостя')),
            TextField(
              controller: percentCtrl,
              decoration: const InputDecoration(labelText: 'Скидка, %'),
              keyboardType: TextInputType.number,
            ),
            TextField(controller: notesCtrl, decoration: const InputDecoration(labelText: 'Заметка')),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Сохранить')),
        ],
      ),
    );
    if (ok != true || numberCtrl.text.trim().isEmpty) return;
    final newCard = DiscountCard(
      id: card?.id ?? '',
      cardNumber: numberCtrl.text.trim(),
      guestName: nameCtrl.text.trim(),
      discountPercent: double.tryParse(percentCtrl.text.replaceAll(',', '.')) ?? 0,
      notes: notesCtrl.text.trim(),
      active: card?.active ?? true,
    );
    if (card == null) {
      await fs.addDiscountCard(newCard);
    } else {
      await fs.updateDiscountCard(newCard);
    }
  }
}
