import '../../theme/app_colors.dart';
import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:image_picker/image_picker.dart';
import '../../models/inventory_models.dart';
import '../../models/menu_models.dart';
import '../../services/firestore_service.dart';
import '../../services/storage_service.dart';

/// Админ-редактор меню: категории, позиции и загрузка фото для них.
/// Фото загружается через системный выбор (галерея/камера) и хранится в
/// Firebase Storage — сразу видно на плитке категории и в списке позиций.
class MenuEditorScreen extends StatefulWidget {
  const MenuEditorScreen({super.key});

  @override
  State<MenuEditorScreen> createState() => _MenuEditorScreenState();
}

class _MenuEditorScreenState extends State<MenuEditorScreen> {
  final _fs = FirestoreService();
  final _storage = StorageService();

  // Пока идёт загрузка фото конкретной категории/позиции — блокируем именно
  // её строку, а не весь экран, чтобы админ мог продолжать редактировать
  // остальное меню без ожидания.
  final Set<String> _uploadingIds = {};

  // Список активных позиций склада для дропдауна привязки в диалоге позиции.
  List<InventoryItem> _inventoryItems = [];

  @override
  void initState() {
    super.initState();
    // Одноразовая загрузка — инвентарь меняется редко, для диалога достаточно
    // снимка на момент открытия экрана.
    _fs.inventoryItemsStream().first.then((items) {
      if (mounted) {
        setState(() {
          _inventoryItems = items.where((i) => i.active).toList()
            ..sort((a, b) => a.name.compareTo(b.name));
        });
      }
    });
  }

  @override
  Widget build(BuildContext context) {
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
                await _fs.addCategory(name);
              }
            },
          ),
        ],
      ),
      body: StreamBuilder<List<MenuCategory>>(
        stream: _fs.categoriesStream(),
        builder: (context, catSnap) {
          if (!catSnap.hasData) return const Center(child: CircularProgressIndicator());
          final categories = catSnap.data!;
          return StreamBuilder<List<MenuItem>>(
            stream: _fs.menuItemsStream(),
            builder: (context, itemSnap) {
              final items = itemSnap.data ?? [];
              if (categories.isEmpty) {
                return const Center(child: Text('Добавьте первую категорию (значок папки вверху)'));
              }
              return ListView(
                children: categories.map((cat) {
                  final catItems = items.where((i) => i.categoryId == cat.id).toList();
                  return ExpansionTile(
                    leading: _EditableThumb(
                      imageUrl: cat.imageUrl,
                      uploading: _uploadingIds.contains(cat.id),
                      icon: Icons.restaurant_menu,
                      onTap: () => _pickAndUploadCategoryImage(cat),
                    ),
                    title: Text(cat.name),
                    subtitle: Text('${catItems.length} позиций'),
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
                              await _fs.renameCategory(cat.id, name);
                            }
                          },
                        ),
                        const Icon(Icons.expand_more),
                      ],
                    ),
                    children: [
                      ...catItems.map((item) => ListTile(
                            leading: _EditableThumb(
                              imageUrl: item.imageUrl,
                              uploading: _uploadingIds.contains(item.id),
                              icon: Icons.fastfood_outlined,
                              onTap: () => _pickAndUploadItemImage(item),
                            ),
                            title: Text(item.name),
                            subtitle: Text(item.weight > 0
                                ? '${item.price.toStringAsFixed(0)} ₽ · ${item.weightUnit.formatWithLabel(item.weight)}'
                                    '${item.inventoryItemId.isNotEmpty ? ' · 📦' : ''}'
                                : '${item.price.toStringAsFixed(0)} ₽'),
                            trailing: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Switch(
                                  value: item.available,
                                  onChanged: (v) => _fs.updateMenuItem(item.copyWith(available: v)),
                                ),
                                IconButton(
                                  icon: const Icon(Icons.delete_outline),
                                  onPressed: () => _confirmDelete(
                                    context,
                                    title: 'Удалить позицию?',
                                    message: '«${item.name}» будет удалена без возможности отмены.',
                                    onConfirm: () => _fs.deleteMenuItem(item.id),
                                  ),
                                ),
                              ],
                            ),
                            onTap: () => _editItem(context, item, categoryId: cat.id),
                          )),
                      ListTile(
                        leading: const Icon(Icons.add),
                        title: const Text('Добавить позицию'),
                        onTap: () => _editItem(context, null, categoryId: cat.id),
                      ),
                      ListTile(
                        leading: const Icon(Icons.delete_forever, color: AppColors.danger),
                        title: const Text('Удалить категорию', style: TextStyle(color: AppColors.danger)),
                        onTap: () => _confirmDelete(
                          context,
                          title: 'Удалить категорию?',
                          message: catItems.isEmpty
                              ? 'Категория «${cat.name}» будет удалена.'
                              : 'Категория «${cat.name}» и все её позиции (${catItems.length} шт.) будут удалены без возможности отмены.',
                          onConfirm: () => _fs.deleteCategoryCascade(cat.id),
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

  Future<void> _pickAndUploadCategoryImage(MenuCategory cat) async {
    final source = await _pickSource(context);
    if (source == null) return;
    final file = await _storage.pickImage(source: source);
    if (file == null) return;
    setState(() => _uploadingIds.add(cat.id));
    try {
      final url = await _storage.uploadMenuImage(file: file, folder: 'categories', entityId: cat.id);
      await _fs.updateCategoryImage(cat.id, url);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось загрузить фото: $e')));
      }
    } finally {
      if (mounted) setState(() => _uploadingIds.remove(cat.id));
    }
  }

  Future<void> _pickAndUploadItemImage(MenuItem item) async {
    final source = await _pickSource(context);
    if (source == null) return;
    final file = await _storage.pickImage(source: source);
    if (file == null) return;
    setState(() => _uploadingIds.add(item.id));
    try {
      final url = await _storage.uploadMenuImage(file: file, folder: 'items', entityId: item.id);
      await _fs.updateMenuItemImage(item.id, url);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось загрузить фото: $e')));
      }
    } finally {
      if (mounted) setState(() => _uploadingIds.remove(item.id));
    }
  }

  Future<ImageSource?> _pickSource(BuildContext context) {
    return showModalBottomSheet<ImageSource>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Выбрать из галереи'),
              onTap: () => Navigator.pop(ctx, ImageSource.gallery),
            ),
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Сделать фото'),
              onTap: () => Navigator.pop(ctx, ImageSource.camera),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _editItem(BuildContext context, MenuItem? item, {String? categoryId}) async {
    final nameCtrl = TextEditingController(text: item?.name ?? '');
    final priceCtrl = TextEditingController(text: item?.price.toStringAsFixed(0) ?? '');
    final weightCtrl = TextEditingController(
        text: (item != null && item.weight > 0) ? item.weightUnit.format(item.weight) : '');
    var weightUnit = item?.weightUnit ?? InventoryUnit.g;
