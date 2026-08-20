import 'package:flutter/material.dart';
import '../../models/session_model.dart';
import '../../models/menu_models.dart';
import '../../services/firestore_service.dart';
import '../../utils/constants.dart';

/// Выбор позиций меню для добавления в открытый счёт
class MenuSelectionScreen extends StatefulWidget {
  final SessionModel session;
  const MenuSelectionScreen({super.key, required this.session});

  @override
  State<MenuSelectionScreen> createState() => _MenuSelectionScreenState();
}

class _MenuSelectionScreenState extends State<MenuSelectionScreen> {
  final _fs = FirestoreService();
  String _query = '';

  Future<void> _add(MenuItem item) async {
    try {
      await _fs.addOrderItem(widget.session.id, item);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text('Добавлено: ${item.name}'), duration: const Duration(seconds: 1)));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Не удалось добавить — проверьте интернет')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Меню'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(56),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: TextField(
              decoration: const InputDecoration(
                hintText: 'Поиск по меню…',
                prefixIcon: Icon(Icons.search),
                filled: true,
                isDense: true,
                border: OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(10))),
              ),
              onChanged: (v) => setState(() => _query = v.trim().toLowerCase()),
            ),
          ),
        ),
      ),
      body: StreamBuilder<List<MenuCategory>>(
        stream: _fs.categoriesStream(),
        builder: (context, catSnap) {
          if (!catSnap.hasData) return const Center(child: CircularProgressIndicator());
          final categories = catSnap.data!;
          return StreamBuilder<List<MenuItem>>(
            stream: _fs.menuItemsStream(),
            builder: (context, itemSnap) {
              if (!itemSnap.hasData) return const Center(child: CircularProgressIndicator());
              var items = itemSnap.data!.where((i) => i.available).toList();
              if (_query.isNotEmpty) {
                items = items.where((i) => i.name.toLowerCase().contains(_query)).toList();
              }
              if (categories.isEmpty) {
                return const Center(child: Text('Меню пока пустое'));
              }
              if (items.isEmpty) {
                return const Center(child: Text('Ничего не найдено'));
              }
              return ListView(
                children: categories.map((cat) {
                  final catItems = items.where((i) => i.categoryId == cat.id).toList();
                  if (catItems.isEmpty) return const SizedBox.shrink();
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
                        child: Text(cat.name,
                            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                      ),
                      ...catItems.map((item) => ListTile(
                            title: Text(item.name),
                            subtitle: Text('${item.price.toStringAsFixed(0)} ${AppConstants.currencySymbol}'),
                            trailing: const Icon(Icons.add_circle_outline),
                            onTap: () => _add(item),
                          )),
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
}
