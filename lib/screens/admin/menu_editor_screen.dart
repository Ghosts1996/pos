import 'package:flutter/material.dart';
import '../../models/menu_models.dart';
import '../../services/firestore_service.dart';

class MenuEditorScreen extends StatelessWidget {
  const MenuEditorScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final fs = FirestoreService();
    return Scaffold(
      appBar: AppBar(
        title: const Text('Меню'),
        actions: [
          IconButton(
            icon: const Icon(Icons.create_new_folder_outlined),
            tooltip: 'Новая категория',
            onPressed: () async {
              final name = await _promptText(context, 'Новая категория', 'Название');
              if (name != null && name.isNotEmpty) {
                await fs.addCategory(name);
              }
            },
          ),
        ],
      ),
      body: StreamBuilder<List<MenuCategory>>(
        stream: fs.categoriesStream(),
        builder: (context, catSnap) {
          if (!catSnap.hasData) return const Center(child: CircularProgressIndicator());
          final categories = catSnap.data!;
          return StreamBuilder<List<MenuItem>>(
            stream: fs.menuItemsStream(),
            builder: (context, itemSnap) {
              final items = itemSnap.data ?? [];
              if (categories.isEmpty) {
                return const Center(child: Text('Добавьте первую категорию (значок папки вверху)'));
              }
              return ListView(
                children: categories.map((cat) {
                  final catItems = items.where((i) => i.categoryId == cat.id).toList();
                  return ExpansionTile(
                    title: Text(cat.name),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          icon: const Icon(Icons.edit_outlined, size: 20),
                          tooltip: 'Переименовать',
                          onPressed: () async {
                            final name = await _promptText(
                                context, 'Переименовать категорию', 'Название',
                                initial: cat.name);
                            if (name != null && name.isNotEmpty) {
                              await fs.renameCategory(cat.id, name);
                            }
                          },
                        ),
                        const Icon(Icons.expand_more),
                      ],
                    ),
                    children: [
                      ...catItems.map((item) => ListTile(
                            title: Text(item.name),
                            subtitle: Text('${item.price.toStringAsFixed(0)} ₽'),
                            leading: Switch(
                              value: item.available,
                              onChanged: (v) => fs.updateMenuItem(MenuItem(
                                id: item.id,
                                categoryId: item.categoryId,
                                name: item.name,
                                price: item.price,
                                available: v,
                              )),
                            ),
                            trailing: IconButton(
                              icon: const Icon(Icons.delete_outline),
                              onPressed: () => _confirmDelete(
                                context,
                                title: 'Удалить позицию?',
                                message: '«${item.name}» будет удалена без возможности отмены.',
                                onConfirm: () => fs.deleteMenuItem(item.id),
                              ),
                            ),
                            onTap: () => _editItem(context, fs, item),
                          )),
                      ListTile(
                        leading: const Icon(Icons.add),
                        title: const Text('Добавить позицию'),
                        onTap: () => _editItem(context, fs, null, categoryId: cat.id),
                      ),
                      ListTile(
                        leading: const Icon(Icons.delete_forever, color: Colors.red),
                        title: const Text('Удалить категорию', style: TextStyle(color: Colors.red)),
                        onTap: () => _confirmDelete(
                          context,
                          title: 'Удалить категорию?',
                          message: catItems.isEmpty
                              ? 'Категория «${cat.name}» будет удалена.'
                              : 'Категория «${cat.name}» и все её позиции (${catItems.length} шт.) будут удалены без возможности отмены.',
                          onConfirm: () => fs.deleteCategoryCascade(cat.id),
                        ),
                      ),
                    ],
                  );
                }).toList(),
              );
            },
          );
        },
      ),
    );
  }

  Future<void> _editItem(BuildContext context, FirestoreService fs, MenuItem? item,
      {String? categoryId}) async {
    final nameCtrl = TextEditingController(text: item?.name ?? '');
    final priceCtrl = TextEditingController(text: item?.price.toStringAsFixed(0) ?? '');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(item == null ? 'Новая позиция' : 'Редактировать'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: nameCtrl, decoration: const InputDecoration(labelText: 'Название')),
            TextField(
              controller: priceCtrl,
              decoration: const InputDecoration(labelText: 'Цена, ₽'),
              keyboardType: TextInputType.number,
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Сохранить')),
        ],
      ),
    );
    if (ok != true || nameCtrl.text.trim().isEmpty) return;
    final price = double.tryParse(priceCtrl.text.replaceAll(',', '.')) ?? 0;
    if (item == null) {
      await fs.addMenuItem(MenuItem(id: '', categoryId: categoryId!, name: nameCtrl.text.trim(), price: price));
    } else {
      await fs.updateMenuItem(MenuItem(
          id: item.id, categoryId: item.categoryId, name: nameCtrl.text.trim(), price: price, available: item.available));
    }
  }

  Future<void> _confirmDelete(
    BuildContext context, {
    required String title,
    required String message,
    required VoidCallback onConfirm,
  }) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Удалить'),
          ),
        ],
      ),
    );
    if (confirm == true) onConfirm();
  }

  Future<String?> _promptText(BuildContext context, String title, String label, {String? initial}) {
    final ctrl = TextEditingController(text: initial ?? '');
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: TextField(controller: ctrl, decoration: InputDecoration(labelText: label), autofocus: true),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
              child: Text(initial == null ? 'Создать' : 'Сохранить')),
        ],
      ),
    );
  }
}
